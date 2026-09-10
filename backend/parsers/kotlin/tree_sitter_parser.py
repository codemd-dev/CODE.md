import logging
import os

from parsers.common import iter_supported_repo_files
from parsers.generic_tree_sitter import (
    _generic_tree_sitter_language,
    _resolve_generic_language_calls,
    _write_generic_tree_sitter_graph,
    run_generic_tree_sitter_callgraph_isolated,
)

logger = logging.getLogger(__name__)


def build_tree_sitter_kotlin_callgraph(repo_src, output_dir):
    """Kotlin's tree-sitter callgraph builder — verified against
    tree-sitter-kotlin 1.1.0 directly, and genuinely NOT a config swap on
    Java's builder despite both targeting the JVM: Kotlin's grammar uses
    entirely different node types throughout (function_declaration for both
    top-level and member functions -- no separate "method" node the way
    Java splits method_declaration from constructor_declaration;
    class_declaration's `name` field for owner tracking; companion_object
    nests as its own scope, tracked here as a synthetic ".Companion" owner
    segment; package_header's qualified_identifier for the package name).
    call_expression exposes no named "function" field in this grammar
    (confirmed directly, unlike Go/Rust) -- the callee is always the node's
    first child: either a bare `identifier` (direct call) or a
    `navigation_expression` (dotted call like `s.start()`/`Server.create()`),
    whose own text is already in the right "qualifier.name" shape, so no
    further field extraction is needed for that case."""
    parser = _generic_tree_sitter_language("tree_sitter_kotlin")
    user_funcs = set()
    func_files = {}
    raw_calls = []
    files_seen = 0
    parse_error_count = 0

    def package_name_of(source_bytes, root):
        for c in root.children:
            if c.type == "package_header":
                for gc in c.children:
                    if gc.type == "qualified_identifier":
                        return source_bytes[gc.start_byte:gc.end_byte].decode("utf-8", "ignore")
        return ""

    def resolve_call_name(source_bytes, call_node):
        if not call_node.children:
            return ""
        first = call_node.children[0]
        if first.type in ("identifier", "navigation_expression"):
            return source_bytes[first.start_byte:first.end_byte].decode("utf-8", "ignore")
        return ""

    def walk(source_bytes, node, package_name, class_stack, rel_path, current_func):
        next_class_stack = class_stack
        next_func = current_func
        if node.type == "class_declaration":
            name_node = node.child_by_field_name("name")
            if name_node is not None:
                next_class_stack = class_stack + [source_bytes[name_node.start_byte:name_node.end_byte].decode("utf-8", "ignore")]
        if node.type == "companion_object":
            next_class_stack = class_stack + ["Companion"]
        if node.type == "function_declaration":
            name_node = node.child_by_field_name("name")
            func_name = source_bytes[name_node.start_byte:name_node.end_byte].decode("utf-8", "ignore") if name_node else ""
            owner = ".".join(([package_name] if package_name else []) + class_stack)
            full_name = f"{owner}.{func_name}" if owner else func_name
            if func_name:
                user_funcs.add(full_name)
                func_files[full_name] = rel_path
                next_func = {"full_name": full_name}
        if current_func and node.type == "call_expression":
            callee = resolve_call_name(source_bytes, node)
            if callee:
                raw_calls.append({
                    "caller": current_func["full_name"],
                    "callee": callee,
                    "file": rel_path,
                    "line": node.start_point[0] + 1,
                    "call_text": source_bytes[node.start_byte:node.end_byte].decode("utf-8", "ignore")[:300],
                })
        for child in node.children:
            walk(source_bytes, child, package_name, next_class_stack, rel_path, next_func)

    for path in iter_supported_repo_files(repo_src, {".kt", ".kts"}):
        files_seen += 1
        with open(path, "rb") as fh:
            source_bytes = fh.read()
        rel_path = os.path.relpath(path, repo_src).replace("\\", "/")
        tree = parser.parse(source_bytes)
        if tree.root_node.has_error:
            parse_error_count += 1
        package_name = package_name_of(source_bytes, tree.root_node)
        walk(source_bytes, tree.root_node, package_name, [], rel_path, None)

    edges, ordered_calls = _resolve_generic_language_calls(raw_calls, user_funcs, ".")
    return _write_generic_tree_sitter_graph(output_dir, "tree_sitter_kotlin", "tree-sitter-kotlin", files_seen, parse_error_count, user_funcs, func_files, edges, ordered_calls)


def build_tree_sitter_kotlin_outputs(repo_src, output_repo_dir, results):
    tree_sitter_path = os.path.join(output_repo_dir, "tree_sitter_kotlin")
    os.makedirs(tree_sitter_path, exist_ok=True)
    worker_result = run_generic_tree_sitter_callgraph_isolated(build_tree_sitter_kotlin_callgraph, repo_src, tree_sitter_path, "tree_sitter_kotlin", "kotlin")
    tree_sitter_json_path = worker_result.get("graph_path", "")
    if not tree_sitter_json_path or not os.path.exists(tree_sitter_json_path):
        raise RuntimeError("tree-sitter Kotlin analysis completed without a callgraph JSON artifact")
    results["tree_sitter_kotlin_json_path"] = tree_sitter_json_path
    tree_sitter_ordered_path = worker_result.get("ordered_path") or os.path.join(tree_sitter_path, "tree_sitter_kotlin_ordered_call_sequence.json")
    if tree_sitter_ordered_path and os.path.exists(tree_sitter_ordered_path):
        results["tree_sitter_kotlin_ordered_call_sequence_path"] = tree_sitter_ordered_path
    logger.info("DONE build_tree_sitter_kotlin_callgraph %s", results["tree_sitter_kotlin_json_path"])
    return results
