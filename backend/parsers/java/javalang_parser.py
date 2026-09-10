import logging
import os

from parsers.common import write_ordered_sequence_from_edges

logger = logging.getLogger(__name__)

skipped_files = []

# -------------------------------
# Helper: safe parse wrapper
# -------------------------------
def safe_parse(text, path, repo_src=None, parse_errors=None):
    import javalang

    try:
        return javalang.parse.parse(text)
    except javalang.tokenizer.LexerError as e:
        print(f"[SKIP] LexerError in {path}: {format_java_parse_error(e, text)}")
        if parse_errors is not None:
            parse_errors.append(java_parse_error_diagnostic(e, text, path, repo_src, "lexer_error"))
    except javalang.parser.JavaSyntaxError as e:
        print(f"[SKIP] SyntaxError in {path}: {format_java_parse_error(e, text)}")
        if parse_errors is not None:
            parse_errors.append(java_parse_error_diagnostic(e, text, path, repo_src, "syntax_error"))
    except Exception as e:
        print(f"[SKIP] Unknown parse error in {path}: {e}")
        if parse_errors is not None:
            parse_errors.append({
                "file": repo_relative_path(path, repo_src),
                "error_type": "parse_error",
                "language": "java",
                "parser": "javalang",
                "line": None,
                "column": None,
                "message": str(e) or e.__class__.__name__,
            })
    skipped_files.append(path)
    return None


def repo_relative_path(path, repo_src=None):
    if repo_src:
        try:
            return os.path.relpath(path, repo_src).replace("\\", "/")
        except ValueError:
            pass
    return str(path).replace("\\", "/")


def java_parse_error_diagnostic(error, source, path, repo_src=None, error_type="syntax_error"):
    location = getattr(error, "at", None) or getattr(error, "position", None)
    token = location
    if location is not None and hasattr(location, "position"):
        location = location.position
    line_no = getattr(location, "line", None)
    col_no = getattr(location, "column", None)
    if location and not line_no and isinstance(location, tuple) and len(location) >= 2:
        line_no, col_no = location[:2]

    message = str(error) or error.__class__.__name__
    lines = source.splitlines()
    snippet = lines[line_no - 1].strip() if line_no and 0 < line_no <= len(lines) else ""
    token_value = getattr(token, "value", "") or getattr(token, "string", "")
    if token_value and token_value not in message:
        message = f"{message} near {token_value!r}"
    if snippet:
        message = f"{message}: {snippet[:220]}"
    return {
        "file": repo_relative_path(path, repo_src),
        "error_type": error_type,
        "language": "java",
        "parser": "javalang",
        "line": line_no,
        "column": col_no,
        "message": message,
    }


def format_java_parse_error(error, source):
    location = getattr(error, "at", None) or getattr(error, "position", None)
    token = location
    if location is not None and hasattr(location, "position"):
        location = location.position
    line_no = getattr(location, "line", None)
    col_no = getattr(location, "column", None)
    if location and not line_no and isinstance(location, tuple) and len(location) >= 2:
        line_no, col_no = location[:2]

    detail = str(error) or error.__class__.__name__
    if not line_no:
        return detail

    lines = source.splitlines()
    snippet = lines[line_no - 1].strip() if 0 < line_no <= len(lines) else ""
    token_value = getattr(token, "value", "") or getattr(token, "string", "")
    token_text = f" token={token_value!r}" if token_value else ""
    return f"{detail} at line {line_no}, column {col_no or '?'}{token_text}: {snippet[:220]}"


def build_javalang_callgraph(repo_src, output_dir, progress_callback=None):
    import os, json
    import javalang

    INCLUDE_ISOLATED_FUNCTIONS_LIMIT = 150
    edges = set()
    user_methods = set()
    parse_errors = []
    parse_error_keys = set()
    java_files = []
    for root, _, files in os.walk(repo_src):
        for f in files:
            if f.endswith(".java"):
                java_files.append(os.path.join(root, f))
    java_files.sort()
    total_files = len(java_files)

    def progress(message, current_file=None):
        if progress_callback:
            try:
                progress_callback(message, current_file=current_file)
            except TypeError:
                progress_callback(message)

    def append_parse_errors(items):
        for item in items:
            key = (
                item.get("file"),
                item.get("error_type"),
                item.get("line"),
                item.get("column"),
                item.get("message"),
            )
            if key in parse_error_keys:
                continue
            parse_error_keys.add(key)
            parse_errors.append(item)

    def parse_java_file(text, path):
        errors = []
        tree = safe_parse(text, path, repo_src=repo_src, parse_errors=errors)
        append_parse_errors(errors)
        return tree

    # Local-variable type tracking (scoped, not full type inference): the
    # qualifier-based resolution below can only match `Foo.bar()` when `Foo`
    # is literally a known class name — it has no idea `foo.bar()` means the
    # same thing when `foo` was declared as `Foo foo = new Foo();` earlier in
    # the SAME method. That's the single most common shape real code (and
    # nearly all test code: "construct an instance, call a method on it")
    # takes, so before resolving calls in a method/constructor body, build a
    # local `variable name -> declared type` map from that body's own
    # LocalVariableDeclaration nodes and consult it first. Deliberately does
    # NOT track fields, method/constructor parameters, interface-to-impl
    # resolution, generics, or anything crossing more than one local
    # declaration — this is a bounded, low-risk approximation, not real type
    # inference.
    def local_variable_types(body_node):
        local_types = {}
        for _, decl in body_node.filter(javalang.tree.LocalVariableDeclaration):
            type_name = getattr(decl.type, "name", None)
            if not type_name:
                continue
            for declarator in decl.declarators:
                if declarator.name:
                    local_types[declarator.name] = type_name
        return local_types

    progress(f"Collecting Java methods from {total_files} files...")
    # -----------------------------------------
    # PASS 1 — Collect all user-defined methods
    # -----------------------------------------
    for index, path in enumerate(java_files, start=1):
        rel_path = os.path.relpath(path, repo_src)
        progress(f"Collecting Java methods from file {index}/{total_files}.", current_file=rel_path)
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            text = fh.read()

        tree = parse_java_file(text, path)
        if tree is None:
            continue

        def class_prefix(path_nodes, class_name):
            names = [
                p.name for p in path_nodes
                if isinstance(p, javalang.tree.ClassDeclaration)
            ]
            names.append(class_name)
            return ".".join(names)

        # Class methods
        for _, node in tree.filter(javalang.tree.ClassDeclaration):
            class_name = class_prefix(_, node.name)
            for method in node.methods:
                if method.name:  # only add valid names
                    user_methods.add(f"{class_name}.{method.name}")
            for constructor in node.constructors:
                user_methods.add(f"{class_name}.<init>")

        # Top-level methods (rare)
        for path2, method in tree.filter(javalang.tree.MethodDeclaration):
            if not isinstance(path2[-2], javalang.tree.ClassDeclaration) and method.name:
                user_methods.add(method.name)

    # Maps a class's simple (unqualified) name to every known class prefix
    # ending in that name — lets a local variable's declared type (always
    # just the simple name as written, e.g. "Foo" in "Foo foo = ...", never
    # the nested-class-qualified "Outer.Foo") resolve to the right user_methods
    # key even for a nested class. Ambiguous when 2+ classes share a simple
    # name (e.g. two different "Builder" inner classes) — resolved only when
    # exactly one candidate exists, same "don't guess" discipline as the
    # qualifier heuristic this is layered on top of.
    simple_class_index = {}
    for full_method in user_methods:
        class_part = full_method.rsplit(".", 1)[0]
        simple_class_index.setdefault(class_part.rsplit(".", 1)[-1], set()).add(class_part)

    def resolve_local_var_call(class_name, callee, local_types, qualifier):
        declared_type = local_types.get(qualifier)
        if not declared_type:
            return None
        candidates = simple_class_index.get(declared_type)
        if not candidates:
            return None
        owner = declared_type if declared_type in candidates else (next(iter(candidates)) if len(candidates) == 1 else None)
        if not owner:
            return None
        candidate = f"{owner}.{callee}"
        return candidate if candidate in user_methods else None

    progress(f"Resolving Java call relationships across {len(user_methods)} methods...")
    # -----------------------------------------
    # PASS 2 — Collect edges between user methods
    # -----------------------------------------
    for index, path in enumerate(java_files, start=1):
        rel_path = os.path.relpath(path, repo_src)
        progress(f"Resolving Java calls from file {index}/{total_files}.", current_file=rel_path)
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            text = fh.read()

        tree = parse_java_file(text, path)
        if tree is None:
            continue

        # CLASS METHODS
        for _, node in tree.filter(javalang.tree.ClassDeclaration):
            class_name = ".".join(
                [
                    p.name for p in _
                    if isinstance(p, javalang.tree.ClassDeclaration)
                ] + [node.name]
            )

            for constructor in node.constructors:
                caller = f"{class_name}.<init>"
                constructor_local_types = local_variable_types(constructor)
                for _, call in constructor.filter(javalang.tree.MethodInvocation):
                    callee = call.member
                    if not callee:
                        continue
                    target = None
                    same_class = f"{class_name}.{callee}"
                    if same_class in user_methods:
                        target = same_class
                    elif call.qualifier:
                        target = resolve_local_var_call(class_name, callee, constructor_local_types, call.qualifier)
                    if target and caller != target:
                        edges.add((caller, target))

            for method in node.methods:
                if not method.name:
                    continue
                caller = f"{class_name}.{method.name}"
                method_local_types = local_variable_types(method)

                # Walk the AST inside the method
                for _, call in method.filter(javalang.tree.MethodInvocation):
                    callee = call.member
                    if not callee:
                        continue
                    target = None

                    # Skip trivial self-recursion
                    if callee == method.name:
                        continue

                    # 1. Same-class call
                    same_class = f"{class_name}.{callee}"
                    if same_class in user_methods:
                        target = same_class

                    # 2. Qualifier-based resolution.
                    elif call.qualifier:
                        q = call.qualifier

                        # 2a. Local variable declared earlier in this SAME
                        # method (e.g. `Foo foo = new Foo(); foo.bar();`) —
                        # the dominant shape of real test code. Approximate
                        # by design (single-method scope only), see
                        # local_variable_types's docstring above.
                        target = resolve_local_var_call(class_name, callee, method_local_types, q)

                        # 2b. Fall back to the original heuristic: only
                        # resolve when the qualifier IS a known class/type
                        # name outright. Do not guess from a repo-wide
                        # simple method name.
                        if not target:
                            guesses = [
                                f"{q}.{callee}",
                                f"{class_name.rsplit('.', 1)[0]}.{q}.{callee}" if "." in class_name else "",
                            ]
                            for g in guesses:
                                if g in user_methods:
                                    target = g
                                    break

                    # Add edge if valid
                    if target and caller != target:
                        edges.add((caller, target))

        # TOP-LEVEL METHODS
        for path2, method in tree.filter(javalang.tree.MethodDeclaration):
            if len(path2) < 2 or not isinstance(path2[-2], javalang.tree.ClassDeclaration):
                if not method.name:
                    continue
                caller = method.name

                for _, call in method.filter(javalang.tree.MethodInvocation):
                    callee = call.member
                    if not callee:
                        continue

                    same_scope = f"{caller.rsplit('.', 1)[0]}.{callee}" if "." in caller else callee
                    if same_scope in user_methods and same_scope != caller:
                        edges.add((caller, same_scope))

    # -----------------------------------------
    # Write compact JSON
    # -----------------------------------------
    os.makedirs(output_dir, exist_ok=True)
    out = os.path.join(output_dir, "javalang_callgraph.json")

    # Convert to list of lists of strings, skip None
    clean_edges = [[str(s), str(t)] for s, t in edges if s and t]
    connected_nodes = {node for edge in clean_edges for node in edge[:2]}
    include_isolated = len(user_methods) <= INCLUDE_ISOLATED_FUNCTIONS_LIMIT
    graph = {
        "mode": "all_user_functions" if include_isolated else "connected_user_functions",
        "node_count_total": len(user_methods),
        "node_limit_for_isolated": INCLUDE_ISOLATED_FUNCTIONS_LIMIT,
        "nodes": sorted(user_methods if include_isolated else connected_nodes),
        "edges": clean_edges,
        "parse_errors": parse_errors[:50],
        "parse_error_count": len(parse_errors),
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(graph, f, separators=(",", ":"))

    ordered_out = os.path.join(output_dir, "javalang_ordered_call_sequence.json")
    write_ordered_sequence_from_edges(
        edges,
        ordered_out,
        parser="javalang",
        source_callgraph=os.path.basename(out),
    )

    logger.info(
        "Minimal user-only callgraph written: %s methods=%s edges=%s mode=%s parse_errors=%s",
        out,
        len(user_methods),
        len(clean_edges),
        graph["mode"],
        len(parse_errors),
    )

    return out


def build_javalang_outputs(repo_src, output_repo_dir, results, progress_callback=None):
    javalang_path = os.path.join(output_repo_dir, "javalang")
    os.makedirs(javalang_path, exist_ok=True)
    callgraph_javalang_json_path = build_javalang_callgraph(repo_src, javalang_path, progress_callback=progress_callback)
    results["callgraph_javalang_json_path"] = callgraph_javalang_json_path
    javalang_ordered_path = os.path.join(javalang_path, "javalang_ordered_call_sequence.json")
    if os.path.exists(javalang_ordered_path):
        results["javalang_ordered_call_sequence_path"] = javalang_ordered_path
    logger.info("DONE build_javalang_callgraph %s", results["callgraph_javalang_json_path"])

    return results
