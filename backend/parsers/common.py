import json
import logging
import os
import re
from pathlib import Path

logger = logging.getLogger(__name__)

# ============================================================
#   CONSTANTS
# ============================================================

SKIP_DIRS = {
    "venv", ".venv", "env",
    "build", "dist", "out", ".gradle", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", "coverage", "__pycache__",
    "migrations", ".github", ".idea", ".vscode",
    "node_modules", "output",
    "third-party", "third_party", "thirdparty",
    "extern", "external", "deps", "dependencies",
    "vendor", "vendors",
    "sample", "samples",
    ".git", ".codemd",
}

ALLOWED_CODE_EXTENSIONS = {
    ".py", ".java", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
    ".go", ".cpp", ".cc", ".cxx", ".c", ".h", ".hpp", ".hh",
    ".cs", ".rb", ".php", ".rs", ".kt", ".kts",
}

HTML_UI_EXTENSIONS_FOR_ANALYSIS = {".html", ".htm", ".xhtml"}

# Directory names that unambiguously mean "this holds tests," across every
# language convention this tool analyzes — never excluded from source
# discovery, no matter what. This overrides SKIP_DIRS entirely for a path
# containing one of these segments, INCLUDING when it sits under an
# otherwise-fully-skipped ancestor like ".codemd" (e.g.
# ".codemd/generated_tests/" — CODEMD's own home for Claude/Codex-generated
# tests) — the whole point of most callers of should_skip_path is to find
# real, testable code, and a rule that hides the actual tests defeats that.
#   - bare/common names: test, tests, __tests__, __test__, spec, specs
#   - a whole extra word: unittest(s), unit_test(s), integration_test(s),
#     generated_tests (CODEMD's own convention)
#   - a delimited suffix on a compound/project name — .NET's convention is a
#     whole SIBLING PROJECT directory named "<Project>.Tests" or
#     "<Project>.IntegrationTests", not a bare "tests" folder at all. Only
#     matched when "test(s)"/"spec(s)" is preceded by a real delimiter
#     (., _, -) or is the entire segment, so "latest", "contest", "digest",
#     and "protest" are correctly left alone (verified: none of those
#     contain "test"/"tests" immediately after a ^, ., _, or - boundary).
_TEST_DIR_EXACT_NAMES = {
    "test", "tests", "__tests__", "__test__", "spec", "specs",
    "unittest", "unittests", "unit_test", "unit_tests",
    "integrationtest", "integrationtests", "integration_test", "integration_tests",
    "generated_tests",
}
_TEST_DIR_SUFFIX_RE = re.compile(r"(?:^|[._-])(tests?|specs?)$", re.IGNORECASE)


def is_generated_output_dir_name(name: str):
    lower = str(name or "").lower()
    return lower == "output" or lower.startswith(("output_", "output-", "output%"))


def is_test_directory_name(name: str) -> bool:
    lowered = str(name or "").lower()
    return lowered in _TEST_DIR_EXACT_NAMES or bool(_TEST_DIR_SUFFIX_RE.search(lowered))


def should_skip_path(path: str, repo_root: str = ""):
    path_for_match = str(path)
    if repo_root:
        try:
            path_for_match = os.path.relpath(path_for_match, repo_root)
        except ValueError:
            path_for_match = str(path)
    parts = [part.lower() for part in path_for_match.replace("\\", "/").split("/")]
    filename = parts[-1] if parts else ""
    if any(is_test_directory_name(part) for part in parts):
        return False
    # The bare ".codemd" directory itself must never be pruned outright, even
    # though it's in SKIP_DIRS below — os.walk's topdown dirs[:] filtering
    # (every caller's `dirs[:] = [d for d in dirs if not should_skip_path(...)]`
    # pattern) never revisits a pruned directory to see what's inside it, so
    # pruning ".codemd" here would make the is_test_directory_name override
    # above unreachable for ".codemd/generated_tests" one level down — it
    # would never even get walked into to be checked. Every other child of
    # ".codemd" (scim/, backend-output/, ...) is still excluded normally,
    # because ".codemd" remains an ancestor SKIP_DIRS segment for those
    # deeper paths.
    if filename == ".codemd":
        return False
    return (
        any(part in SKIP_DIRS or is_generated_output_dir_name(part) for part in parts)
        or filename.endswith(".min.js")
        or filename.endswith(".bundle.js")
        or filename.endswith(".map")
    )


def looks_like_browser_metadata_file(path: str):
    try:
        sample = Path(path).read_text(encoding="utf-8", errors="ignore")[:12000]
    except OSError:
        return False
    lowered = sample.lower()
    browser_keys = ("pagetitle", "pageurl", "faviconurl", "lastaccesstime")
    if "edge_all_open_tabs" in lowered:
        return True
    return sum(1 for key in browser_keys if key in lowered) >= 2 and ("pageurl" in lowered or "url" in lowered)


def is_supported_repo_source_file(path: str, repo_root: str, allowed_extensions=None, sniff_browser_metadata=True):
    ext = os.path.splitext(str(path))[1].lower()
    if allowed_extensions is None:
        allowed_extensions = ALLOWED_CODE_EXTENSIONS
    if ext not in allowed_extensions:
        return False
    if should_skip_path(path, repo_root):
        return False
    if sniff_browser_metadata and ext in {".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"} and looks_like_browser_metadata_file(path):
        logger.info("Skipping browser metadata file during source analysis: %s", path)
        return False
    return True


def iter_supported_repo_files(repo_src: str, allowed_extensions=None, sniff_browser_metadata=True):
    for root, dirs, files in os.walk(repo_src):
        dirs[:] = [d for d in dirs if not should_skip_path(os.path.join(root, d), repo_src)]
        for filename in sorted(files):
            path = os.path.join(root, filename)
            if is_supported_repo_source_file(path, repo_src, allowed_extensions, sniff_browser_metadata=sniff_browser_metadata):
                yield path


def atomic_write_text(path, content, encoding="utf-8"):
    """Write `content` to `path` without ever leaving a reader (a webview
    loading the mirrored graph HTML/JSON, or the local static file server
    handing it out) able to observe a half-written file. A plain
    `Path.write_text()` opens the destination and streams into it in place,
    so a background regenerate that rewrites a graph the webview is
    concurrently loading can hand back a truncated read — surfacing as a
    JSON.parse failure / "Graph render error" in the graph panel. Writing to
    a same-directory temp file first and swapping it in with os.replace
    (atomic on POSIX and Windows alike) means any concurrent reader sees
    either the complete old file or the complete new one, never a partial
    one.
    """
    path = Path(path)
    tmp_path = path.with_name(f".{path.name}.tmp{os.getpid()}")
    tmp_path.write_text(content, encoding=encoding)
    os.replace(tmp_path, path)


def write_ordered_call_sequence(calls, output_path, parser="", source_callgraph=""):
    normalized = []
    for index, call in enumerate(calls or [], start=1):
        caller = call.get("caller") or call.get("source") or call.get("method") or ""
        callee = call.get("callee") or call.get("target") or call.get("callee_fullName") or ""
        if not caller or not callee:
            continue
        order = call.get("order")
        try:
            order = int(order) if order is not None and order != "" else index
        except (TypeError, ValueError):
            order = index
        line = call.get("line")
        try:
            line = int(line) if line is not None and line != "" else None
        except (TypeError, ValueError):
            line = None
        column = call.get("column")
        try:
            column = int(column) if column is not None and column != "" else None
        except (TypeError, ValueError):
            column = None
        normalized.append({
            "caller": str(caller),
            "callee": str(callee),
            "file": call.get("file") or call.get("caller_file") or "",
            "line": line,
            "column": column,
            "order": order,
            "call_text": call.get("call_text") or call.get("call_code") or call.get("call_name") or "",
        })

    normalized.sort(key=lambda item: (
        item.get("file") or "",
        item.get("caller") or "",
        item.get("line") if item.get("line") is not None else 0,
        item.get("column") if item.get("column") is not None else 0,
        item.get("order") if item.get("order") is not None else 0,
        item.get("callee") or "",
    ))
    payload = {
        "mode": "ordered_call_sequence",
        "parser": parser,
        "source_callgraph": source_callgraph,
        "calls": normalized,
        "call_count": len(normalized),
    }
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    return output_path


def write_ordered_sequence_from_edges(edges, output_path, parser="", source_callgraph=""):
    calls = [
        {
            "caller": src,
            "callee": dst,
            "order": index,
        }
        for index, (src, dst) in enumerate(sorted(edges or []), start=1)
    ]
    return write_ordered_call_sequence(calls, output_path, parser, source_callgraph)


def ordered_sequence_candidates_for_graph(path):
    if not path:
        return []
    graph_path = Path(path)
    parent = graph_path.parent
    name = graph_path.name
    candidates = []
    explicit = {
        "python_callgraph.json": "python_ordered_call_sequence.json",
        "javascript_callgraph.json": "javascript_ordered_call_sequence.json",
        "java_merged_callgraph.json": "java_merged_ordered_call_sequence.json",
        "tree_sitter_java_callgraph.json": "tree_sitter_java_ordered_call_sequence.json",
        "javalang_callgraph.json": "javalang_ordered_call_sequence.json",
        "combined_callgraph.json": "combined_ordered_call_sequence.json",
        "joern_callgraph.json": "joern_ordered_call_sequence.json",
        "reduced_joern_callgraph.json": "joern_ordered_call_sequence.json",
    }
    if name in explicit:
        candidates.append(parent / explicit[name])
    stem = graph_path.stem
    for candidate_name in (
        f"{stem}_ordered_call_sequence.json",
        f"{stem}_ordered.json",
        "ordered_call_sequence.json",
    ):
        candidates.append(parent / candidate_name)
    seen = set()
    unique = []
    for candidate in candidates:
        key = str(candidate)
        if key not in seen:
            seen.add(key)
            unique.append(candidate)
    return unique


def load_ordered_edge_meta_for_graph(path):
    edge_meta = {}
    for ordered_path in ordered_sequence_candidates_for_graph(path):
        if not ordered_path.exists():
            continue
        try:
            with open(ordered_path, "r", encoding="utf-8") as f:
                payload = json.load(f)
        except Exception:
            continue
        calls = payload.get("calls", []) if isinstance(payload, dict) else payload
        for index, call in enumerate(calls or [], start=1):
            if not isinstance(call, dict):
                continue
            src = call.get("caller") or call.get("source") or call.get("method") or ""
            dst = call.get("callee") or call.get("target") or call.get("callee_fullName") or ""
            if not src or not dst:
                continue
            try:
                order = int(call.get("order")) if call.get("order") not in (None, "") else index
            except (TypeError, ValueError):
                order = index
            try:
                line = int(call.get("line")) if call.get("line") not in (None, "") else None
            except (TypeError, ValueError):
                line = None
            key = (str(src), str(dst))
            previous = edge_meta.get(key)
            if previous is None or order < (previous.get("order") or order):
                edge_meta[key] = {"order": order, "line": line}
    return edge_meta


def _load_edge_graph_with_meta(path):
    if not path or not os.path.exists(path):
        return set(), set(), {}
    with open(path, "r", encoding="utf-8") as f:
        graph = json.load(f)
    raw_edges = graph.get("edges", graph) if isinstance(graph, dict) else graph
    raw_edges = raw_edges if isinstance(raw_edges, list) else []
    nodes = set()
    if isinstance(graph, dict):
        for node in graph.get("nodes", []) or []:
            if isinstance(node, str):
                nodes.add(node)
            elif isinstance(node, dict):
                node_data = node.get("data") if isinstance(node.get("data"), dict) else node
                node_id = node_data.get("id") or node_data.get("name") or node_data.get("label")
                if node_id:
                    nodes.add(str(node_id))
    edges = set()
    edge_meta = load_ordered_edge_meta_for_graph(path)
    for edge in raw_edges:
        src = ""
        dst = ""
        order = None
        line = None
        if isinstance(edge, list) and len(edge) >= 2:
            src, dst = str(edge[0]), str(edge[1])
            if len(edge) >= 3:
                order = edge[2]
            if len(edge) >= 4:
                line = edge[3]
        elif isinstance(edge, dict):
            edge_data = edge.get("data") if isinstance(edge.get("data"), dict) else edge
            src = edge_data.get("caller") or edge_data.get("source")
            dst = edge_data.get("callee") or edge_data.get("target")
            order = edge_data.get("order")
            line = edge_data.get("line")
            if src is not None:
                src = str(src)
            if dst is not None:
                dst = str(dst)
        else:
            continue
        if src and dst:
            nodes.add(src)
            nodes.add(dst)
            edges.add((src, dst))
            if order is not None or line is not None:
                try:
                    order = int(order) if order not in (None, "") else None
                except (TypeError, ValueError):
                    order = None
                try:
                    line = int(line) if line not in (None, "") else None
                except (TypeError, ValueError):
                    line = None
                previous = edge_meta.get((src, dst))
                if previous is None or (order is not None and order < (previous.get("order") or order)):
                    edge_meta[(src, dst)] = {"order": order, "line": line}
    return nodes, edges, edge_meta
