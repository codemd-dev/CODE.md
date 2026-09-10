import json
import logging
import multiprocessing
import os
import queue
import re
from collections import defaultdict

from parsers.common import write_ordered_call_sequence

logger = logging.getLogger(__name__)

TREE_SITTER_GENERIC_TIMEOUT_SECONDS = int(os.getenv("CODEVAL_TREE_SITTER_GENERIC_TIMEOUT_SECONDS", "90") or 90)


def _generic_tree_sitter_language(pip_module_name):
    """Same load pattern as _tree_sitter_java_language, parameterized by
    which grammar package to import — tree-sitter-go/-rust/-kotlin all
    expose the identical `language()` factory function convention."""
    from tree_sitter import Language, Parser
    import importlib

    mod = importlib.import_module(pip_module_name)
    language_fn = getattr(mod, "language", None)
    if not language_fn:
        raise RuntimeError(f"{pip_module_name}.language() is unavailable")
    language = Language(language_fn())
    parser = Parser()
    if hasattr(parser, "set_language"):
        parser.set_language(language)
    else:
        parser.language = language
    return parser


def _generic_callee_tail_name(callee):
    """The bare function/method name off the end of a callee string,
    whichever separator produced it. Rust mixes separators even within one
    file (`self.init()` via field access -> '.', `Type::new()` via path ->
    '::'), unlike Go/Kotlin's single '.' convention throughout, so this
    always splits on the last occurrence of either rather than assuming one
    fixed separator per language."""
    parts = re.split(r"::|\.", callee)
    return parts[-1]


def _resolve_generic_language_calls(raw_calls, user_funcs, sep):
    """Shared call-resolution pass for the Go/Rust/Kotlin tree-sitter
    builders below — verified against real sample source for all three
    before being wired in here. Mirrors build_tree_sitter_java_callgraph's
    own strategy (same-owner match first, then a global unique-name match,
    dropping anything ambiguous or unresolved) rather than trusting raw
    callee text directly, which would otherwise include stdlib/third-party
    calls with no corresponding user-defined function. `raw_calls` entries
    are {caller, callee, file, line, call_text}; `user_funcs` is the set of
    known full names, each shaped like 'owner<sep>name'.
    """
    name_index = defaultdict(set)
    owner_of = {}
    for full in user_funcs:
        if sep in full:
            owner, _, name = full.rpartition(sep)
        else:
            owner, name = "", full
        name_index[name].add(full)
        owner_of[full] = owner

    def unique_match(matches):
        return next(iter(matches)) if len(matches) == 1 else None

    edges = set()
    ordered_calls = []
    for call in raw_calls:
        callee = call["callee"]
        caller = call["caller"]
        caller_owner = owner_of.get(caller, "")
        name = _generic_callee_tail_name(callee)
        target = None
        # 1) exact same-owner call (self.x() / bare x() inside the same type)
        same_owner_candidate = f"{caller_owner}{sep}{name}" if caller_owner else name
        if same_owner_candidate in user_funcs:
            target = same_owner_candidate
        # 2) the raw callee string already IS a full, known name verbatim
        elif callee in user_funcs:
            target = callee
        # 3) unique global match by bare method/function name
        else:
            target = unique_match(name_index.get(name, set()))
        if target and target != caller:
            edge = (caller, target)
            if edge not in edges:
                edges.add(edge)
                ordered_calls.append({
                    "caller": caller,
                    "callee": target,
                    "file": call.get("file", ""),
                    "line": call.get("line"),
                    "order": len(ordered_calls) + 1,
                    "call_text": call.get("call_text", ""),
                })
    return edges, ordered_calls


def _write_generic_tree_sitter_graph(output_dir, filename_stem, parser_label, files_seen, parse_error_count, user_funcs, func_files, edges, ordered_calls, include_isolated_limit=150):
    """Shared final-output step for the Go/Rust/Kotlin builders — same
    shape/fields as build_tree_sitter_java_callgraph's own graph dict and
    write_ordered_call_sequence call, just parameterized by filename stem
    and parser label instead of hardcoding "java" throughout."""
    clean_edges = [[str(src), str(dst)] for src, dst in sorted(edges)]
    connected_nodes = {node for edge in clean_edges for node in edge[:2]}
    include_isolated = len(user_funcs) <= include_isolated_limit
    graph = {
        "mode": "tree_sitter_all_user_functions" if include_isolated else "tree_sitter_connected_user_functions",
        "parser": parser_label,
        "files_seen": files_seen,
        "parse_error_count": parse_error_count,
        "node_count_total": len(user_funcs),
        "node_limit_for_isolated": include_isolated_limit,
        "function_files": func_files,
        "nodes": sorted(user_funcs if include_isolated else connected_nodes),
        "edges": clean_edges,
    }
    os.makedirs(output_dir, exist_ok=True)
    out = os.path.join(output_dir, f"{filename_stem}_callgraph.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(graph, f, separators=(",", ":"))
    ordered_out = os.path.join(output_dir, f"{filename_stem}_ordered_call_sequence.json")
    write_ordered_call_sequence(ordered_calls, ordered_out, parser=parser_label, source_callgraph=os.path.basename(out))
    logger.info(
        "Tree-sitter %s graph written: %s files=%s functions=%s edges=%s",
        parser_label, out, files_seen, len(user_funcs), len(clean_edges),
    )
    return out


def _generic_tree_sitter_worker(builder_fn, repo_src, output_dir, filename_stem, result_queue):
    try:
        graph_path = builder_fn(repo_src, output_dir)
        ordered_path = os.path.join(output_dir, f"{filename_stem}_ordered_call_sequence.json")
        result_queue.put({
            "ok": True,
            "graph_path": graph_path,
            "ordered_path": ordered_path if os.path.exists(ordered_path) else "",
        })
    except BaseException as exc:
        result_queue.put({"ok": False, "error": f"{type(exc).__name__}: {exc}"})


def run_generic_tree_sitter_callgraph_isolated(builder_fn, repo_src, output_dir, filename_stem, language_label, timeout_seconds=None):
    """Same isolation strategy as run_tree_sitter_java_callgraph_isolated
    (a subprocess with a hard timeout, so one pathological file can't hang
    the whole analysis run) — shared here across Go/Rust/Kotlin instead of
    three near-identical copies of the multiprocessing boilerplate, since
    only the builder function and output filenames differ between them."""
    timeout_seconds = timeout_seconds or TREE_SITTER_GENERIC_TIMEOUT_SECONDS
    result_queue = multiprocessing.Queue(maxsize=1)
    process = multiprocessing.Process(
        target=_generic_tree_sitter_worker,
        args=(builder_fn, repo_src, output_dir, filename_stem, result_queue),
        name=f"codeval-tree-sitter-{language_label}",
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
        raise TimeoutError(f"tree-sitter {language_label} analysis timed out after {timeout_seconds}s")

    try:
        result = result_queue.get(timeout=2)
    except queue.Empty:
        exit_code = process.exitcode
        raise RuntimeError(f"tree-sitter {language_label} analysis worker exited without a result (exit code {exit_code})")
    finally:
        result_queue.close()
        result_queue.join_thread()

    if process.exitcode not in (0, None):
        raise RuntimeError(f"tree-sitter {language_label} analysis worker exited with code {process.exitcode}")
    if not result.get("ok"):
        raise RuntimeError(result.get("error") or f"tree-sitter {language_label} analysis failed")
    return result
