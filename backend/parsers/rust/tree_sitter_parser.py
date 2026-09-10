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


def build_tree_sitter_rust_callgraph(repo_src, output_dir):
    """Rust's tree-sitter callgraph builder — verified against
    tree-sitter-rust 0.24.2 directly: function_item's `name` field gives the
    function name regardless of whether it's free or inside an impl_item
    (Rust has no separate "method" node type the way Go does); impl_item's
    `type` field gives the struct/enum name for owner-tracking, mod_item's
    `name` field nests module paths the same way. call_expression's
    `function` field is one of: scoped_identifier ("Type::method" —
    resolves its own `path`/`name` fields), field_expression ("value.field"
    — e.g. self.init(), resolves its own `value`/`field` fields), or a bare
    identifier for a same-scope free-function call. Unlike Go/Kotlin, Rust
    genuinely mixes '.' and '::' separators in callee text even within one
    file, which is why the resolution pass below always splits on whichever
    separator actually produced the callee string (_generic_callee_tail_name)
    rather than assuming one fixed separator per language."""
    parser = _generic_tree_sitter_language("tree_sitter_rust")
    user_funcs = set()
    func_files = {}
    raw_calls = []
    files_seen = 0
    parse_error_count = 0

    def resolve_call_name(source_bytes, call_node):
        fn = call_node.child_by_field_name("function")
        if fn is None:
            return ""
        if fn.type == "scoped_identifier":
            path = fn.child_by_field_name("path")
            name = fn.child_by_field_name("name")
            path_text = source_bytes[path.start_byte:path.end_byte].decode("utf-8", "ignore") if path else ""
            name_text = source_bytes[name.start_byte:name.end_byte].decode("utf-8", "ignore") if name else ""
            return f"{path_text}::{name_text}" if path_text and name_text else name_text
        if fn.type == "field_expression":
            value = fn.child_by_field_name("value")
            field = fn.child_by_field_name("field")
            value_text = source_bytes[value.start_byte:value.end_byte].decode("utf-8", "ignore") if value else ""
            field_text = source_bytes[field.start_byte:field.end_byte].decode("utf-8", "ignore") if field else ""
            return f"{value_text}.{field_text}" if value_text and field_text else field_text
        return source_bytes[fn.start_byte:fn.end_byte].decode("utf-8", "ignore")

    def walk(source_bytes, node, mod_stack, rel_path, current_func):
        next_mod_stack = mod_stack
        next_func = current_func
        if node.type == "mod_item":
            name_node = node.child_by_field_name("name")
            if name_node is not None:
                next_mod_stack = mod_stack + [source_bytes[name_node.start_byte:name_node.end_byte].decode("utf-8", "ignore")]
        if node.type == "impl_item":
            type_node = node.child_by_field_name("type")
            if type_node is not None:
                next_mod_stack = mod_stack + [source_bytes[type_node.start_byte:type_node.end_byte].decode("utf-8", "ignore")]
        if node.type == "function_item":
            name_node = node.child_by_field_name("name")
            func_name = source_bytes[name_node.start_byte:name_node.end_byte].decode("utf-8", "ignore") if name_node else ""
            owner = "::".join(mod_stack)
            full_name = f"{owner}::{func_name}" if owner else func_name
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
            walk(source_bytes, child, next_mod_stack, rel_path, next_func)

    for path in iter_supported_repo_files(repo_src, {".rs"}):
        files_seen += 1
        with open(path, "rb") as fh:
            source_bytes = fh.read()
        rel_path = os.path.relpath(path, repo_src).replace("\\", "/")
        tree = parser.parse(source_bytes)
        if tree.root_node.has_error:
            parse_error_count += 1
        walk(source_bytes, tree.root_node, [], rel_path, None)

    edges, ordered_calls = _resolve_generic_language_calls(raw_calls, user_funcs, "::")
    return _write_generic_tree_sitter_graph(output_dir, "tree_sitter_rust", "tree-sitter-rust", files_seen, parse_error_count, user_funcs, func_files, edges, ordered_calls)


def build_tree_sitter_rust_outputs(repo_src, output_repo_dir, results):
    tree_sitter_path = os.path.join(output_repo_dir, "tree_sitter_rust")
    os.makedirs(tree_sitter_path, exist_ok=True)
    worker_result = run_generic_tree_sitter_callgraph_isolated(build_tree_sitter_rust_callgraph, repo_src, tree_sitter_path, "tree_sitter_rust", "rust")
    tree_sitter_json_path = worker_result.get("graph_path", "")
    if not tree_sitter_json_path or not os.path.exists(tree_sitter_json_path):
        raise RuntimeError("tree-sitter Rust analysis completed without a callgraph JSON artifact")
    results["tree_sitter_rust_json_path"] = tree_sitter_json_path
    tree_sitter_ordered_path = worker_result.get("ordered_path") or os.path.join(tree_sitter_path, "tree_sitter_rust_ordered_call_sequence.json")
    if tree_sitter_ordered_path and os.path.exists(tree_sitter_ordered_path):
        results["tree_sitter_rust_ordered_call_sequence_path"] = tree_sitter_ordered_path
    logger.info("DONE build_tree_sitter_rust_callgraph %s", results["tree_sitter_rust_json_path"])
    return results
