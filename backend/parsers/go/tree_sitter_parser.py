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


def build_tree_sitter_go_callgraph(repo_src, output_dir):
    """Go's tree-sitter callgraph builder — same shape as
    build_tree_sitter_java_callgraph, adapted for Go's grammar (verified
    against tree-sitter-go 0.25.0 directly: method_declaration's receiver
    type is read via its `receiver` field -> parameter_declaration's `type`
    field -> either a bare type_identifier or a pointer_type wrapping one;
    call_expression's `function` field is either a bare identifier for a
    same-package free-function call, or a selector_expression whose
    `operand`/`field` fields give "x.y" for both real method calls and
    package-qualified calls like fmt.Println, which the resolution pass
    below naturally drops since "fmt" is never a user-defined owner)."""
    parser = _generic_tree_sitter_language("tree_sitter_go")
    user_funcs = set()
    func_files = {}
    raw_calls = []
    files_seen = 0
    parse_error_count = 0

    def package_name_of(source_bytes, root):
        for c in root.children:
            if c.type == "package_clause":
                for gc in c.children:
                    if gc.type == "package_identifier":
                        return source_bytes[gc.start_byte:gc.end_byte].decode("utf-8", "ignore")
        return ""

    def receiver_type_of(source_bytes, method_decl_node):
        recv = method_decl_node.child_by_field_name("receiver")
        if recv is None:
            return ""
        for pd in recv.children:
            if pd.type != "parameter_declaration":
                continue
            type_node = pd.child_by_field_name("type")
            if type_node is None:
                continue
            if type_node.type == "pointer_type":
                inner = next((c for c in type_node.children if c.type == "type_identifier"), None)
                if inner is not None:
                    return source_bytes[inner.start_byte:inner.end_byte].decode("utf-8", "ignore")
            elif type_node.type == "type_identifier":
                return source_bytes[type_node.start_byte:type_node.end_byte].decode("utf-8", "ignore")
        return ""

    def resolve_call_name(source_bytes, call_node):
        fn = call_node.child_by_field_name("function")
        if fn is None:
            return ""
        if fn.type == "selector_expression":
            operand = fn.child_by_field_name("operand")
            field = fn.child_by_field_name("field")
            operand_text = source_bytes[operand.start_byte:operand.end_byte].decode("utf-8", "ignore") if operand else ""
            field_text = source_bytes[field.start_byte:field.end_byte].decode("utf-8", "ignore") if field else ""
            return f"{operand_text}.{field_text}" if operand_text and field_text else field_text
        return source_bytes[fn.start_byte:fn.end_byte].decode("utf-8", "ignore")

    def walk(source_bytes, node, package_name, rel_path, current_func):
        next_func = current_func
        if node.type in ("function_declaration", "method_declaration"):
            receiver_type = receiver_type_of(source_bytes, node) if node.type == "method_declaration" else ""
            name_node = node.child_by_field_name("name")
            func_name = source_bytes[name_node.start_byte:name_node.end_byte].decode("utf-8", "ignore") if name_node else ""
            owner = f"{package_name}.{receiver_type}" if receiver_type else package_name
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
            walk(source_bytes, child, package_name, rel_path, next_func)

    for path in iter_supported_repo_files(repo_src, {".go"}):
        files_seen += 1
        with open(path, "rb") as fh:
            source_bytes = fh.read()
        rel_path = os.path.relpath(path, repo_src).replace("\\", "/")
        tree = parser.parse(source_bytes)
        if tree.root_node.has_error:
            parse_error_count += 1
        package_name = package_name_of(source_bytes, tree.root_node)
        walk(source_bytes, tree.root_node, package_name, rel_path, None)

    edges, ordered_calls = _resolve_generic_language_calls(raw_calls, user_funcs, ".")
    return _write_generic_tree_sitter_graph(output_dir, "tree_sitter_go", "tree-sitter-go", files_seen, parse_error_count, user_funcs, func_files, edges, ordered_calls)


def build_tree_sitter_go_outputs(repo_src, output_repo_dir, results):
    tree_sitter_path = os.path.join(output_repo_dir, "tree_sitter_go")
    os.makedirs(tree_sitter_path, exist_ok=True)
    worker_result = run_generic_tree_sitter_callgraph_isolated(build_tree_sitter_go_callgraph, repo_src, tree_sitter_path, "tree_sitter_go", "go")
    tree_sitter_json_path = worker_result.get("graph_path", "")
    if not tree_sitter_json_path or not os.path.exists(tree_sitter_json_path):
        raise RuntimeError("tree-sitter Go analysis completed without a callgraph JSON artifact")
    results["tree_sitter_go_json_path"] = tree_sitter_json_path
    tree_sitter_ordered_path = worker_result.get("ordered_path") or os.path.join(tree_sitter_path, "tree_sitter_go_ordered_call_sequence.json")
    if tree_sitter_ordered_path and os.path.exists(tree_sitter_ordered_path):
        results["tree_sitter_go_ordered_call_sequence_path"] = tree_sitter_ordered_path
    logger.info("DONE build_tree_sitter_go_callgraph %s", results["tree_sitter_go_json_path"])
    return results
