import json
import logging
import multiprocessing
import os
import queue
from collections import defaultdict

from parsers.common import iter_supported_repo_files, write_ordered_call_sequence

logger = logging.getLogger(__name__)

TREE_SITTER_JAVA_TIMEOUT_SECONDS = int(os.getenv("CODEVAL_TREE_SITTER_JAVA_TIMEOUT_SECONDS", "90") or 90)


def _node_text(source_bytes, node):
    if not node:
        return ""
    return source_bytes[node.start_byte:node.end_byte].decode("utf-8", errors="ignore")


def _node_name(source_bytes, node):
    if not node:
        return ""
    name_node = node.child_by_field_name("name")
    if name_node:
        return _node_text(source_bytes, name_node)
    for child in node.children:
        if child.type in {"identifier", "type_identifier"}:
            return _node_text(source_bytes, child)
    return ""


def _node_start_line(node):
    point = node.start_point
    row = getattr(point, "row", None)
    if row is None:
        row = point[0]
    return row + 1


def _first_descendant(node, node_types):
    stack = list(node.children)
    while stack:
        current = stack.pop()
        if current.type in node_types:
            return current
        stack.extend(reversed(current.children))
    return None


def _java_package_name(source_bytes, root):
    package_node = _first_descendant(root, {"package_declaration"})
    if not package_node:
        return ""
    scoped = _first_descendant(package_node, {"scoped_identifier", "identifier"})
    return _node_text(source_bytes, scoped)


def _java_type_name(source_bytes, node):
    type_node = node.child_by_field_name("type")
    if type_node:
        scoped = _first_descendant(type_node, {"scoped_type_identifier", "type_identifier", "identifier"})
        return _node_text(source_bytes, scoped or type_node).split("<", 1)[0].strip()
    return ""


def _tree_sitter_java_language():
    from tree_sitter import Language, Parser
    import tree_sitter_java

    language_fn = getattr(tree_sitter_java, "language", None)
    if not language_fn:
        raise RuntimeError("tree_sitter_java.language() is unavailable")

    language = Language(language_fn())
    parser = Parser()
    if hasattr(parser, "set_language"):
        parser.set_language(language)
    else:
        parser.language = language
    return parser


def build_tree_sitter_java_callgraph(repo_src, output_dir):
    parser = _tree_sitter_java_language()
    class_types = {
        "class_declaration",
        "interface_declaration",
        "enum_declaration",
        "record_declaration",
        "annotation_type_declaration",
    }
    method_types = {"method_declaration", "constructor_declaration"}
    call_types = {
        "method_invocation",
        "object_creation_expression",
        "explicit_constructor_invocation",
    }
    include_isolated_limit = 150
    user_methods = set()
    method_files = {}
    raw_calls = []
    parse_error_count = 0
    parse_errors = []
    recovered_error_samples = []
    files_seen = 0

    def class_full_name(package_name, class_stack):
        pieces = ([package_name] if package_name else []) + class_stack
        return ".".join(part for part in pieces if part)

    def resolve_call_name(source_bytes, call_node):
        if call_node.type == "method_invocation":
            name = _node_name(source_bytes, call_node)
            qualifier_node = (
                call_node.child_by_field_name("object")
                or call_node.child_by_field_name("type")
                or call_node.child_by_field_name("qualifier")
            )
            qualifier = _node_text(source_bytes, qualifier_node).strip() if qualifier_node else ""
            return f"{qualifier}.{name}" if qualifier and name else name
        if call_node.type == "object_creation_expression":
            type_name = _java_type_name(source_bytes, call_node)
            return f"{type_name}.<init>" if type_name else ""
        if call_node.type == "explicit_constructor_invocation":
            return "<init>"
        return ""

    # Same scoped, non-full-type-inference approximation as
    # local_variable_types() in build_javalang_callgraph above: a call like
    # `foo.bar()` can only be resolved later if `foo`'s declared type is
    # known. Reads a "local_variable_declaration" node's own type + declarator
    # fields directly (see field shapes confirmed against tree-sitter-java
    # 0.25's actual parse tree) and records name -> simple declared type name
    # into the CURRENT method's local_types dict (reset fresh whenever `walk`
    # enters a new method_types node below, so scope never leaks across
    # methods). Non-reference types (e.g. `int a = 1;`) get recorded too but
    # harmlessly no-op later, since a primitive type name never matches a
    # real class in simple_class_index.
    def record_local_var_types(source_bytes, node, local_types):
        if node.type != "local_variable_declaration" or local_types is None:
            return
        type_node = node.child_by_field_name("type")
        if not type_node:
            return
        type_name = _node_text(source_bytes, type_node).split("<", 1)[0].strip()
        if not type_name:
            return
        for declarator in node.children_by_field_name("declarator"):
            name_node = declarator.child_by_field_name("name")
            if name_node:
                local_types[_node_text(source_bytes, name_node)] = type_name

    def walk(source_bytes, node, package_name, class_stack, rel_path, current_method=None, local_types=None):
        next_class_stack = class_stack
        next_method = current_method
        next_local_types = local_types

        if node.type in class_types:
            name = _node_name(source_bytes, node)
            if name:
                next_class_stack = class_stack + [name]

        if node.type in method_types:
            method_name = _node_name(source_bytes, node)
            if node.type == "constructor_declaration":
                method_name = "<init>"
            owner = class_full_name(package_name, next_class_stack)
            full_name = f"{owner}.{method_name}" if owner else method_name
            if method_name:
                user_methods.add(full_name)
                method_files[full_name] = rel_path
                next_method = {
                    "full_name": full_name,
                    "method_name": method_name,
                    "class_name": owner,
                    "file": rel_path,
                }
                next_local_types = {}

        record_local_var_types(source_bytes, node, next_local_types)

        if current_method and node.type in call_types:
            callee = resolve_call_name(source_bytes, node)
            if callee:
                qualifier_node = (
                    node.child_by_field_name("object")
                    or node.child_by_field_name("type")
                    or node.child_by_field_name("qualifier")
                ) if node.type == "method_invocation" else None
                qualifier_text = _node_text(source_bytes, qualifier_node).strip() if qualifier_node else ""
                local_var_type = (next_local_types or {}).get(qualifier_text) if qualifier_text else None
                raw_calls.append({
                    "caller": current_method["full_name"],
                    "caller_method": current_method["method_name"],
                    "caller_class": current_method["class_name"],
                    "caller_file": current_method["file"],
                    "callee": callee,
                    "local_var_type": local_var_type,
                    "line": _node_start_line(node),
                    "column": getattr(node, "start_point", [None, None])[1] if getattr(node, "start_point", None) else None,
                    "call_text": _node_text(source_bytes, node)[:300],
                })

        for child in node.children:
            walk(source_bytes, child, package_name, next_class_stack, rel_path, next_method, next_local_types)

    for path in iter_supported_repo_files(repo_src, {".java"}):
            files_seen += 1
            with open(path, "rb") as fh:
                source_bytes = fh.read()
            rel_path = os.path.relpath(path, repo_src).replace("\\", "/")
            tree = parser.parse(source_bytes)
            if tree.root_node.has_error:
                parse_error_count += 1
                if len(parse_errors) < 50:
                    parse_errors.append({
                        "file": rel_path,
                        "error_type": "syntax_error",
                        "language": "java",
                        "parser": "tree-sitter-java",
                        "line": None,
                        "column": None,
                        "message": "tree-sitter recovered syntax error while parsing file",
                    })
                if len(recovered_error_samples) < 5:
                    recovered_error_samples.append(rel_path)
            package_name = _java_package_name(source_bytes, tree.root_node)
            walk(source_bytes, tree.root_node, package_name, [], rel_path)

    edges = set()
    ordered_calls = []
    class_method_index = defaultdict(set)
    simple_class_index = defaultdict(set)
    for method in user_methods:
        owner, _, method_name = method.rpartition(".")
        if owner:
            class_method_index[(owner, method_name)].add(method)
            simple_class_index[owner.rsplit(".", 1)[-1]].add(owner)

    def unique_match(matches):
        return next(iter(matches)) if len(matches) == 1 else None

    for call in raw_calls:
        callee = call["callee"]
        if callee == call["caller_method"]:
            continue

        target = None
        if callee == "<init>":
            same_class_init = f"{call['caller_class']}.<init>"
            if same_class_init in user_methods:
                target = same_class_init
        elif callee.endswith(".<init>"):
            type_name = callee.rsplit(".", 1)[0]
            owner = unique_match(simple_class_index.get(type_name, set())) or type_name
            target = unique_match(class_method_index.get((owner, "<init>"), set()))
        else:
            qualifier = ""
            method_name = callee
            if "." in callee:
                qualifier, method_name = callee.rsplit(".", 1)
            same_class = f"{call['caller_class']}.{method_name}"
            if same_class in user_methods:
                target = same_class
            elif call.get("local_var_type"):
                # `foo.bar()` where `foo` was declared earlier in this same
                # method as `Foo foo = ...` — resolve via the tracked
                # declared type instead of requiring the qualifier text
                # itself to look like a class name.
                owner = unique_match(simple_class_index.get(call["local_var_type"], set())) or call["local_var_type"]
                target = unique_match(class_method_index.get((owner, method_name), set()))
            if not target and qualifier and qualifier[:1].isupper():
                owner = unique_match(simple_class_index.get(qualifier, set())) or qualifier
                target = unique_match(class_method_index.get((owner, method_name), set()))

        if target and target != call["caller"]:
            edges.add((call["caller"], target))
            ordered_calls.append({
                "caller": call["caller"],
                "callee": target,
                "file": call.get("caller_file", ""),
                "line": call.get("line"),
                "column": call.get("column"),
                "order": len(ordered_calls) + 1,
                "call_text": call.get("call_text", ""),
            })

    clean_edges = [[str(src), str(dst)] for src, dst in sorted(edges)]
    connected_nodes = {node for edge in clean_edges for node in edge[:2]}
    include_isolated = len(user_methods) <= include_isolated_limit
    graph = {
        "mode": "tree_sitter_all_user_functions" if include_isolated else "tree_sitter_connected_user_functions",
        "parser": "tree-sitter-java",
        "files_seen": files_seen,
        "parse_error_count": parse_error_count,
        "parse_errors": parse_errors,
        "node_count_total": len(user_methods),
        "node_limit_for_isolated": include_isolated_limit,
        "function_files": method_files,
        "nodes": sorted(user_methods if include_isolated else connected_nodes),
        "edges": clean_edges,
    }

    os.makedirs(output_dir, exist_ok=True)
    out = os.path.join(output_dir, "tree_sitter_java_callgraph.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(graph, f, separators=(",", ":"))

    ordered_out = os.path.join(output_dir, "tree_sitter_java_ordered_call_sequence.json")
    write_ordered_call_sequence(
        ordered_calls,
        ordered_out,
        parser="tree-sitter-java",
        source_callgraph=os.path.basename(out),
    )

    logger.info(
        "Tree-sitter Java graph written: %s files=%s methods=%s edges=%s recovered_errors=%s",
        out,
        files_seen,
        len(user_methods),
        len(clean_edges),
        parse_error_count,
    )
    if parse_error_count:
        logger.info(
            "Tree-sitter Java recovered syntax errors in %s/%s files; graph generation continued. Sample files: %s",
            parse_error_count,
            files_seen,
            ", ".join(recovered_error_samples),
        )
    return out


def _tree_sitter_java_worker(repo_src, output_dir, result_queue):
    try:
        graph_path = build_tree_sitter_java_callgraph(repo_src, output_dir)
        ordered_path = os.path.join(output_dir, "tree_sitter_java_ordered_call_sequence.json")
        result_queue.put({
            "ok": True,
            "graph_path": graph_path,
            "ordered_path": ordered_path if os.path.exists(ordered_path) else "",
        })
    except BaseException as exc:
        result_queue.put({
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
        })


def run_tree_sitter_java_callgraph_isolated(repo_src, output_dir, timeout_seconds=None):
    timeout_seconds = timeout_seconds or TREE_SITTER_JAVA_TIMEOUT_SECONDS
    result_queue = multiprocessing.Queue(maxsize=1)
    process = multiprocessing.Process(
        target=_tree_sitter_java_worker,
        args=(repo_src, output_dir, result_queue),
        name="codeval-tree-sitter-java",
    )
    process.start()
    process.join(timeout_seconds)

    if process.is_alive():
        process.terminate()
        process.join(5)
        if process.is_alive():
            process.kill()
            process.join(5)
        result_queue.close()
        result_queue.join_thread()
        raise TimeoutError(f"tree-sitter Java analysis timed out after {timeout_seconds}s")

    try:
        result = result_queue.get(timeout=2)
    except queue.Empty:
        exit_code = process.exitcode
        raise RuntimeError(f"tree-sitter Java analysis worker exited without a result (exit code {exit_code})")
    finally:
        result_queue.close()
        result_queue.join_thread()

    if process.exitcode not in (0, None):
        raise RuntimeError(f"tree-sitter Java analysis worker exited with code {process.exitcode}")
    if not result.get("ok"):
        raise RuntimeError(result.get("error") or "tree-sitter Java analysis failed")
    return result


def build_tree_sitter_java_outputs(repo_src, output_repo_dir, results):
    tree_sitter_path = os.path.join(output_repo_dir, "tree_sitter_java")
    os.makedirs(tree_sitter_path, exist_ok=True)
    worker_result = run_tree_sitter_java_callgraph_isolated(repo_src, tree_sitter_path)
    tree_sitter_json_path = worker_result.get("graph_path", "")
    if not tree_sitter_json_path or not os.path.exists(tree_sitter_json_path):
        raise RuntimeError("tree-sitter Java analysis completed without a callgraph JSON artifact")
    results["tree_sitter_java_json_path"] = tree_sitter_json_path
    tree_sitter_ordered_path = worker_result.get("ordered_path") or os.path.join(tree_sitter_path, "tree_sitter_java_ordered_call_sequence.json")
    if tree_sitter_ordered_path and os.path.exists(tree_sitter_ordered_path):
        results["tree_sitter_java_ordered_call_sequence_path"] = tree_sitter_ordered_path
    logger.info("DONE build_tree_sitter_java_callgraph %s", results["tree_sitter_java_json_path"])

    return results
