"""On-demand "what did this change delete/affect" report.

Compares the working tree against a git ref (default HEAD), or, when --target
is given, compares two refs directly (base..target) without touching the
working tree at all — used to run this same report against a past commit
(base=<commit>^, target=<commit>). For every changed Python,
JavaScript/TypeScript, or Java file, diffs the function symbol set (old vs
new), scores each deleted symbol by how connected it was in the
last-generated callgraph (.codemd/combined_callgraph/combined_callgraph.json),
and computes the blast radius of every confirmed-modified symbol.

No hooks, no persistent snapshot cache, no Claude/Codex coupling: this is a
plain CLI invoked on demand (the VS Code extension runs it when the user
clicks "Check Changes"), using git itself as the "before" snapshot. Prints a
single JSON object to stdout; diagnostics go to stderr.
"""
import argparse
import ast
import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.dont_write_bytecode = True


def _run_git(repo_root, args):
    result = subprocess.run(
        ["git", "-C", repo_root] + args,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="ignore",
    )
    return result


def git_prefix(repo_root):
    """Path from the Git toplevel to repo_root, with a trailing slash."""
    result = _run_git(repo_root, ["rev-parse", "--show-prefix"])
    return result.stdout.strip().replace("\\", "/") if result.returncode == 0 else ""


def strip_git_prefix(git_rel_path, prefix):
    git_rel_path = git_rel_path.replace("\\", "/")
    if prefix and git_rel_path.startswith(prefix):
        return git_rel_path[len(prefix):]
    return git_rel_path


def changed_files(repo_root, base, target=None):
    """[(status, old_rel_path, new_rel_path, old_git_path, new_git_path)].

    old/new_rel_path are relative to repo_root for filesystem reads and
    report output; old/new_git_path are relative to the Git toplevel for
    git show/diff pathspecs.

    status is one of A(dded)/M(odified)/D(eleted)/R(enamed). Uses -M so a
    detected rename carries its old path through (so a renamed file's
    symbols get diffed old-content vs new-content, not reported as a full
    delete-then-add).

    When target is given, diffs base..target directly instead of base vs the
    working tree. For live working-tree reports, also includes untracked files
    so "uncommitted edits" matches the files Git would ask the user to add."""
    prefix = git_prefix(repo_root)
    pathspec = prefix.rstrip("/") if prefix else "."
    diff_args = ["diff", "--name-status", "-M", base]
    if target:
        diff_args.append(target)
    diff_args += ["--", pathspec, *git_noise_pathspecs()]
    result = _run_git(repo_root, diff_args)
    if result.returncode != 0:
        raise RuntimeError(f"git diff failed: {result.stderr.strip() or result.returncode}")
    entries = []
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t")
        status = parts[0][0]
        if status == "R" and len(parts) >= 3:
            old_git_path = parts[1].replace("\\", "/")
            new_git_path = parts[2].replace("\\", "/")
            entries.append((
                status,
                strip_git_prefix(old_git_path, prefix),
                strip_git_prefix(new_git_path, prefix),
                old_git_path,
                new_git_path,
            ))
        elif len(parts) >= 2:
            git_path = parts[1].replace("\\", "/")
            rel_path = strip_git_prefix(git_path, prefix)
            entries.append((status, rel_path, rel_path, git_path, git_path))
    if not target:
        untracked = _run_git(repo_root, ["ls-files", "--others", "--exclude-standard", "-z", "--", pathspec, *git_noise_pathspecs()])
        if untracked.returncode != 0:
            raise RuntimeError(f"git ls-files failed: {untracked.stderr.strip() or untracked.returncode}")
        for raw_path in untracked.stdout.split("\0"):
            if not raw_path:
                continue
            git_path = raw_path.replace("\\", "/")
            rel_path = strip_git_prefix(git_path, prefix)
            entries.append(("A", rel_path, rel_path, git_path, git_path))
    return entries


def status_label(status):
    return {
        "A": "added",
        "M": "modified",
        "D": "deleted",
        "R": "renamed",
    }.get(str(status or "")[:1], "changed")


def report_file_entries(entries):
    seen = set()
    files = []
    for status, old_rel_path, new_rel_path, _old_git_path, _new_git_path in entries:
        path = new_rel_path or old_rel_path
        if not path:
            continue
        key = (status, path)
        if key in seen:
            continue
        seen.add(key)
        item = {
            "status": status_label(status),
            "path": path,
        }
        if status == "R" and old_rel_path and old_rel_path != new_rel_path:
            item["old_path"] = old_rel_path
        files.append(item)
    return files


_LOCKFILE_NAMES = {"package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "Cargo.lock"}
_GIT_NOISE_PATHSPECS = [
    ":(exclude).codemd/**",
    ":(exclude)out/**",
    ":(exclude)dist/**",
    ":(exclude)build/**",
    ":(exclude)output*/**",
    ":(exclude)*.vsix",
    ":(exclude)*.pyc",
    ":(exclude)*.pyo",
]


def git_noise_pathspecs():
    return list(_GIT_NOISE_PATHSPECS)


def progress(message):
    print(f"[codemd-progress] {message}", file=sys.stderr, flush=True)


def should_skip_report_path(rel_path):
    """True for paths that are noise in a "what changed" report: generated
    artifacts, dependency caches/lockfiles, and packaged build output. None
    of these are hand-edited, so a diff against them is never something a
    reviewer needs to look at."""
    rel_path = str(rel_path or "").replace("\\", "/")
    parts = rel_path.split("/")
    if not rel_path:
        return True
    if "__pycache__" in parts or "node_modules" in parts or ".codemd" in parts:
        return True
    if parts[0] in {"out", "dist", "build"}:
        return True
    if parts[0] == "output" or parts[0].startswith(("output_", "output-", "output%")):
        return True
    if Path(rel_path).name in _LOCKFILE_NAMES:
        return True
    suffix = Path(rel_path).suffix.lower()
    return suffix in {".pyc", ".pyo", ".vsix", ".map"}


def git_show(repo_root, base, git_rel_path):
    """Content of rel_path at `base`, or None if it didn't exist there."""
    posix_path = git_rel_path.replace("\\", "/")
    result = _run_git(repo_root, ["show", f"{base}:{posix_path}"])
    if result.returncode != 0:
        return None
    return result.stdout


def changed_old_line_ranges(repo_root, base, git_rel_path, target=None):
    """[(start, end)] line ranges in the OLD (base) version of rel_path that
    this diff touches — parsed from unified=0 hunk headers, used to confirm a
    symbol whose name survived the edit was actually touched, not just
    re-emitted identically."""
    posix_path = git_rel_path.replace("\\", "/")
    diff_args = ["diff", "--unified=0", base]
    if target:
        diff_args.append(target)
    diff_args += ["--", posix_path]
    result = _run_git(repo_root, diff_args)
    if result.returncode != 0:
        return []
    ranges = []
    for line in result.stdout.splitlines():
        if not line.startswith("@@"):
            continue
        m = re.match(r"^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@", line)
        if not m:
            continue
        old_start = int(m.group(1))
        old_len = int(m.group(2) or "1")
        if old_len == 0:
            # Pure insertion: nothing removed, but the insertion point can
            # still fall inside a symbol's old span (e.g. a line added in
            # the middle of a function body).
            ranges.append((old_start, old_start))
        else:
            ranges.append((old_start, old_start + old_len - 1))
    return ranges


def ranges_overlap(a_start, a_end, b_start, b_end):
    return a_start <= b_end and b_start <= a_end


def python_signature_from_node(node):
    args = node.args
    posonly = [p.arg for p in getattr(args, "posonlyargs", [])]
    positional = posonly + [p.arg for p in args.args]
    defaults_count = len(args.defaults)
    split = max(len(positional) - defaults_count, 0)
    required_positional = positional[:split]
    optional_positional = positional[split:]
    if required_positional and required_positional[0] in ("self", "cls"):
        required_positional = required_positional[1:]
    return {
        "required_positional": required_positional,
        "optional_positional": optional_positional,
        "kwonly_required": [p.arg for p, d in zip(args.kwonlyargs, args.kw_defaults) if d is None],
        "kwonly_optional": [p.arg for p, d in zip(args.kwonlyargs, args.kw_defaults) if d is not None],
        "has_star_args": args.vararg is not None,
        "has_star_kwargs": args.kwarg is not None,
    }


def python_signature_diff_from_nodes(core_helpers, symbol, old_node, new_node):
    old_sig = python_signature_from_node(old_node)
    new_sig = python_signature_from_node(new_node)
    old_all = set(
        old_sig["required_positional"] + old_sig["optional_positional"]
        + old_sig["kwonly_required"] + old_sig["kwonly_optional"]
    )
    new_all = set(
        new_sig["required_positional"] + new_sig["optional_positional"]
        + new_sig["kwonly_required"] + new_sig["kwonly_optional"]
    )
    added_required = [p for p in (new_sig["required_positional"] + new_sig["kwonly_required"]) if p not in old_all]
    added_optional = [p for p in (new_sig["optional_positional"] + new_sig["kwonly_optional"]) if p not in old_all]
    removed = [p for p in old_all if p not in new_all]
    star_args_changed = old_sig["has_star_args"] != new_sig["has_star_args"]
    star_kwargs_changed = old_sig["has_star_kwargs"] != new_sig["has_star_kwargs"]
    return {
        "changed": bool(added_required or added_optional or removed or star_args_changed or star_kwargs_changed),
        "added_required": added_required,
        "added_optional": added_optional,
        "removed": removed,
        "star_args_changed": star_args_changed,
        "star_kwargs_changed": star_kwargs_changed,
        "old_signature_text": core_helpers.render_python_signature(symbol, old_sig),
        "new_signature_text": core_helpers.render_python_signature(symbol, new_sig),
        "new_signature": new_sig,
    }


def diff_file_symbols(core_helpers, repo_root, base, status, old_rel_path, new_rel_path, old_git_path, new_git_path, target=None):
    """Returns (deleted, added, confirmed_modified, pre_spans_by_symbol,
    post_spans_by_symbol, cosmetic_only, signature_diffs) for one changed file.
    pre/post span maps carry start/end lines so callers can report file+line for
    deleted and modified
    symbols; cosmetic_only/signature_diffs are keyed by symbol (Python
    confirmed_modified only — see python_function_ast_unchanged /
    python_function_signature_diff in helpers.py for what None means).

    When target is given, the "new" side is read via `git show target:file`
    instead of the working-tree file on disk — used when reporting on a past
    commit rather than uncommitted edits."""
    old_source = None if status == "A" else git_show(repo_root, base, old_git_path)
    new_abs_path = os.path.join(repo_root, new_rel_path)
    new_source = None
    if status != "D":
        if target:
            new_source = git_show(repo_root, target, new_git_path)
        elif os.path.isfile(new_abs_path):
            try:
                with open(new_abs_path, "r", encoding="utf-8", errors="ignore") as f:
                    new_source = f.read()
            except OSError:
                new_source = None

    # get_function_spans derives the dotted module name via
    # os.path.relpath(file_path, repo_root), so file_path must be an absolute
    # (or at least repo_root-anchored) path here — passing the already
    # repo-relative path together with an absolute repo_root would make
    # relpath resolve against cwd instead and produce garbage symbol names.
    old_abs_path = os.path.join(repo_root, old_rel_path)
    pre_spans = core_helpers.get_function_spans(old_abs_path, repo_root, source=old_source) if old_source is not None else []
    post_spans = core_helpers.get_function_spans(new_abs_path, repo_root, source=new_source) if new_source is not None else []
    if pre_spans is None or post_spans is None:
        return None  # unsupported language for this file

    pre_by_symbol = {s["symbol"]: s for s in pre_spans}
    post_by_symbol = {s["symbol"]: s for s in post_spans}
    before = set(pre_by_symbol)
    after = set(post_by_symbol)

    deleted = before - after
    added = after - before
    possibly_modified = before & after

    confirmed_modified = set()
    if possibly_modified:
        touched_ranges = changed_old_line_ranges(repo_root, base, old_git_path, target)
        for symbol in possibly_modified:
            span = pre_by_symbol[symbol]
            if any(ranges_overlap(r[0], r[1], span["start_line"], span["end_line"]) for r in touched_ranges):
                confirmed_modified.add(symbol)

    # A line range overlapping a function's span only means the *text*
    # changed there — it doesn't mean the function's behavior did. For
    # Python we can tell the two apart for free: if the parsed body is
    # identical, the "modification" was whitespace/comments/formatting.
    # Signature diffing needs the same old/new source + symbol inputs as the
    # cosmetic check, so compute both here rather than re-reading sources
    # again in main().
    cosmetic_only = {}
    signature_diffs = {}
    new_ext = os.path.splitext(new_rel_path)[1].lower()
    if new_ext == ".py" and confirmed_modified and old_source is not None and new_source is not None:
        try:
            old_tree = ast.parse(old_source)
            new_tree = ast.parse(new_source)
            module_name = core_helpers._python_module_name_for(new_rel_path)
        except (AttributeError, SyntaxError):
            old_tree = None
            new_tree = None
            module_name = ""
        for symbol in confirmed_modified:
            old_node = core_helpers._find_function_node(old_tree, module_name, symbol) if old_tree is not None else None
            new_node = core_helpers._find_function_node(new_tree, module_name, symbol) if new_tree is not None else None
            if old_node is None or new_node is None:
                cosmetic_only[symbol] = None
                signature_diffs[symbol] = None
                continue
            cosmetic_only[symbol] = ast.dump(old_node, annotate_fields=True, include_attributes=False) == \
                ast.dump(new_node, annotate_fields=True, include_attributes=False)
            signature_diffs[symbol] = python_signature_diff_from_nodes(core_helpers, symbol, old_node, new_node)

    return deleted, added, confirmed_modified, pre_by_symbol, post_by_symbol, cosmetic_only, signature_diffs


def score_deleted_symbol(core_helpers, symbol, callgraph, deleted_set):
    direct_callers = core_helpers.traverse_backward([symbol], callgraph, max_depth=1, max_nodes=500)["nodes"]
    direct_callees = core_helpers.traverse_forward([symbol], callgraph, max_depth=1, max_nodes=500)["nodes"]
    # "Still referenced" must only look at DIRECT callers: those are the ones
    # with an actual call edge to this now-deleted symbol, i.e. a real
    # dangling reference. A caller two hops away calls some other, still
    # -existing function — it never called `symbol` directly — so checking
    # it here would be meaningless and (as caught by testing against this
    # repo's real callgraph) wrongly reports CRITICAL even when every real
    # caller was deleted in the same batch.
    still_referenced = any(caller not in deleted_set for caller in direct_callers)

    if still_referenced:
        severity = "CRITICAL"
    elif len(direct_callers) + len(direct_callees) >= 3:
        severity = "HIGH"
    else:
        severity = "LOW"

    return {
        "direct_callers": len(direct_callers),
        "direct_callees": len(direct_callees),
        "still_referenced": still_referenced,
        "severity": severity,
    }


def check_call_sites(core_helpers, repo_root, symbol, new_signature, direct_callers, node_files, deleted_set):
    """For each direct caller of `symbol` (already known to call it, per the
    callgraph), reads the caller's CURRENT file off disk, finds the actual
    call expression(s), and checks them against `symbol`'s new signature.
    Only callers with a provably incompatible call site are returned — a
    call site not found (different overload path, aliased import, etc.) or
    an unverifiable one (*args/**kwargs spread) says nothing about whether
    it's broken, so it's left for a human rather than reported as fine or
    broken."""
    issues = []
    tail = symbol.rsplit(".", 1)[-1]
    for caller in direct_callers:
        if caller in deleted_set:
            continue  # the caller itself no longer exists; nothing to check
        caller_file = node_files.get(caller)
        if not caller_file or not caller_file.endswith(".py"):
            continue
        abs_path = os.path.join(repo_root, caller_file)
        try:
            with open(abs_path, "r", encoding="utf-8", errors="ignore") as f:
                caller_source = f.read()
        except OSError:
            continue
        calls = core_helpers.python_find_calls_in_function(caller_source, caller_file, caller, tail)
        for call in calls or []:
            result = core_helpers.python_check_call_compatibility(new_signature, call)
            if result["status"] == "incompatible":
                issues.append({
                    "caller": caller,
                    "file": caller_file,
                    "line": call.get("line"),
                    "reason": result["reason"],
                })
    return issues


def public_signature_diff(sig_diff):
    """Strips `new_signature` — internal plumbing check_call_sites needs,
    not something the report's consumers should have to parse — before a
    signature diff goes into the JSON report."""
    if sig_diff is None:
        return None
    return {k: v for k, v in sig_diff.items() if k != "new_signature"}


def load_callgraph(core_helpers, repo_root):
    graph_path = Path(repo_root) / ".codemd" / "combined_callgraph" / "combined_callgraph.json"
    if not graph_path.exists():
        return None
    try:
        graph = json.loads(graph_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return core_helpers.edge_graph_to_callgraph(graph)


def load_function_files(repo_root, core_helpers=None):
    """Best-effort symbol -> source file map from generated language graphs."""
    result = {}
    graph_paths = [
        Path(repo_root) / ".codemd" / "python" / "python_callgraph.json",
        Path(repo_root) / ".codemd" / "javascript" / "javascript_callgraph.json",
        Path(repo_root) / ".codemd" / "csharp" / "csharp_callgraph.json",
        Path(repo_root) / ".codemd" / "javalang" / "javalang_callgraph.json",
        Path(repo_root) / ".codemd" / "java_merged" / "java_merged_callgraph.json",
    ]
    for graph_path in graph_paths:
        if not graph_path.exists():
            continue
        try:
            graph = json.loads(graph_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        function_files = graph.get("function_files") if isinstance(graph, dict) else {}
        if isinstance(function_files, dict):
            for symbol, file_path in function_files.items():
                if symbol and file_path:
                    result[str(symbol)] = str(file_path).replace("\\", "/")
    if core_helpers is not None:
        supported_exts = getattr(core_helpers, "SUPPORTED_SPAN_EXTENSIONS", set()) or set()
        for root, dirs, files in os.walk(repo_root):
            dirs[:] = [
                name for name in dirs
                if not should_skip_report_path(os.path.relpath(os.path.join(root, name), repo_root))
            ]
            for name in files:
                abs_path = os.path.join(root, name)
                rel_path = os.path.relpath(abs_path, repo_root).replace("\\", "/")
                if should_skip_report_path(rel_path) or Path(rel_path).suffix.lower() not in supported_exts:
                    continue
                spans = core_helpers.get_function_spans(abs_path, repo_root)
                if not spans:
                    continue
                for span in spans:
                    symbol = span.get("symbol") if isinstance(span, dict) else ""
                    if symbol and symbol not in result:
                        result[str(symbol)] = rel_path
    return result


def format_summary_lines(report):
    lines = []
    severity_rank = {"CRITICAL": 0, "HIGH": 1, "LOW": 2, "UNKNOWN": 3}
    deletions = sorted(report["deleted"], key=lambda d: severity_rank.get(d["severity"], 9))
    for item in deletions:
        location = f"{item['file']}" if item["file"] else "unknown file"
        if item["severity"] == "CRITICAL":
            lines.append(
                f"Removed: {item['symbol']} ({location}) — still called by "
                f"{item['direct_callers']} function(s) — CRITICAL, likely breaking."
            )
        elif item["severity"] == "HIGH":
            lines.append(
                f"Removed: {item['symbol']} ({location}) — was connected "
                f"({item['direct_callers']} callers, {item['direct_callees']} callees) "
                f"— HIGH, review before assuming this was dead code."
            )
        elif item["severity"] == "UNKNOWN":
            lines.append(f"Removed: {item['symbol']} ({location}) — no callgraph available, severity unknown.")
        else:
            lines.append(f"Removed: {item['symbol']} ({location}) — LOW, looked like an isolated/leaf function.")

    if report["modified"]:
        symbols = ", ".join(m["symbol"] for m in report["modified"][:6])
        more = len(report["modified"]) - 6
        if more > 0:
            symbols += f", +{more} more"
        files_touched = sorted({f for m in report["modified"] for f in m.get("impact_files", [])})
        low_conf_edges = sum(m["confidence"].get("low", 0) for m in report["modified"])
        lines.append(
            f"Modified: {symbols} — impact radius touches {len(files_touched)} file(s), "
            f"{low_conf_edges} low-confidence edge(s)."
        )

    if not lines:
        lines.append("No deletions or confirmed modifications detected in tracked Python/JavaScript/TypeScript/Java files.")
    return lines


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", required=True, help="Workspace folder to diff (must be a git repo).")
    parser.add_argument("--base", default="HEAD", help="Git ref to compare the working tree against.")
    parser.add_argument(
        "--target", default=None,
        help="Git ref to use as the 'new' side instead of the working tree — diffs base..target directly "
             "(e.g. to report on a past commit rather than uncommitted edits).",
    )
    parser.add_argument("--backend-dir", required=True, help="Folder containing features/core/helpers.py.")
    parser.add_argument(
        "--only", action="append", default=None,
        help="Restrict the report to this repo-root-relative changed file (repeatable). "
             "Used for a fast single-file preview before the full multi-file run.",
    )
    parser.add_argument(
        "--max-impact-symbols", type=int, default=0,
        help="Limit expensive impact-radius expansion for modified symbols. 0 means no limit.",
    )
    args = parser.parse_args()

    sys.path.insert(0, args.backend_dir)
    from features.core import helpers as core_helpers  # noqa: E402  (path must be set first)
    supported_exts = getattr(core_helpers, "SUPPORTED_SPAN_EXTENSIONS", {".py"})

    repo_root = os.path.abspath(args.repo_root)
    report = {
        "deleted": [],
        "modified": [],
        "uncommitted_files": [],
        "unsupported_files": [],
        "callgraph_available": False,
        "summary": [],
        "error": "",
    }

    try:
        progress("Scanning Git diff...")
        entries = changed_files(repo_root, args.base, args.target)
    except RuntimeError as e:
        report["error"] = str(e)
        print(json.dumps(report))
        return

    if args.only:
        only_set = {p.replace("\\", "/") for p in args.only}
        entries = [e for e in entries if e[1].replace("\\", "/") in only_set or e[2].replace("\\", "/") in only_set]
    entries = [
        e for e in entries
        if not should_skip_report_path(e[1]) and not should_skip_report_path(e[2])
    ]
    report["uncommitted_files"] = report_file_entries(entries)
    progress(f"Analyzing {len(entries)} changed file(s)...")

    progress("Loading callgraph...")
    callgraph = load_callgraph(core_helpers, repo_root)
    node_files = load_function_files(repo_root, core_helpers)
    report["callgraph_available"] = callgraph is not None
    deleted_symbols = {}  # symbol -> {file, start_line, end_line}
    confirmed_modified_symbols = {}  # symbol -> {file, start_line, end_line}
    cosmetic_only_symbols = {}  # symbol -> True/False/None (None = undeterminable)
    signature_diff_symbols = {}  # symbol -> dict|None (see python_function_signature_diff)

    for index, (status, old_rel_path, new_rel_path, old_git_path, new_git_path) in enumerate(entries, start=1):
        if index == 1 or index % 10 == 0 or index == len(entries):
            progress(f"Diffing symbols {index}/{len(entries)}...")
        if should_skip_report_path(old_rel_path) or should_skip_report_path(new_rel_path):
            continue
        old_ext = os.path.splitext(old_rel_path)[1].lower()
        new_ext = os.path.splitext(new_rel_path)[1].lower()
        if old_ext not in supported_exts and new_ext not in supported_exts:
            report["unsupported_files"].append(new_rel_path)
            continue
        diffed = diff_file_symbols(
            core_helpers,
            repo_root,
            args.base,
            status,
            old_rel_path,
            new_rel_path,
            old_git_path,
            new_git_path,
            args.target,
        )
        if diffed is None:
            report["unsupported_files"].append(new_rel_path)
            continue
        deleted, _added, confirmed_modified, pre_by_symbol, post_by_symbol, cosmetic_only, signature_diffs = diffed
        for symbol in deleted:
            deleted_symbols[symbol] = {
                "file": old_rel_path,
                "start_line": pre_by_symbol[symbol]["start_line"],
                "end_line": pre_by_symbol[symbol]["end_line"],
            }
        for symbol in confirmed_modified:
            span = post_by_symbol.get(symbol) or pre_by_symbol.get(symbol) or {}
            confirmed_modified_symbols[symbol] = {
                "file": new_rel_path,
                "start_line": span.get("start_line", 1),
                "end_line": span.get("end_line", span.get("start_line", 1)),
            }
            cosmetic_only_symbols[symbol] = cosmetic_only.get(symbol)
            signature_diff_symbols[symbol] = signature_diffs.get(symbol)

    deleted_set = set(deleted_symbols)
    for symbol, meta in sorted(deleted_symbols.items()):
        entry = {"symbol": symbol, "file": meta["file"], "line": meta["start_line"]}
        if callgraph is not None:
            entry.update(score_deleted_symbol(core_helpers, symbol, callgraph, deleted_set))
        else:
            entry.update({"direct_callers": 0, "direct_callees": 0, "still_referenced": False, "severity": "UNKNOWN"})
        report["deleted"].append(entry)

    if callgraph is not None:
        modified_items = sorted(confirmed_modified_symbols.items())
        max_impact_symbols = max(0, int(args.max_impact_symbols or 0))
        impact_items = modified_items[:max_impact_symbols] if max_impact_symbols else modified_items
        limited_count = max(0, len(modified_items) - len(impact_items))
        for index, (symbol, meta) in enumerate(impact_items, start=1):
            if index == 1 or index % 10 == 0 or index == len(impact_items):
                suffix = f" (limited from {len(modified_items)})" if limited_count else ""
                progress(f"Computing impact radius {index}/{len(impact_items)}{suffix}...")
            file_path = meta["file"]
            radius = core_helpers.get_impact_radius(symbol, callgraph, max_nodes=200)
            impact_files = sorted({
                node_files.get(n) or deleted_symbols.get(n, {}).get("file", "") for n in radius["impacted"]
            } - {""})
            sig_diff = signature_diff_symbols.get(symbol)
            call_site_issues = []
            # Only worth the extra file reads/parses when the signature
            # itself changed — a body-only edit can't desync a caller's
            # argument list.
            if sig_diff and sig_diff.get("changed"):
                direct_callers = [n for n, lvl in radius.get("levels", {}).items() if int(lvl) == 1]
                call_site_issues = check_call_sites(
                    core_helpers, repo_root, symbol, sig_diff["new_signature"], direct_callers, node_files, deleted_set,
                )
            report["modified"].append({
                "symbol": symbol,
                "file": file_path,
                "line": meta.get("start_line") or 1,
                "impact_radius": radius["impacted"],
                "impact_files": impact_files,
                "levels": radius.get("levels", {}),
                "confidence": radius["confidence"],
                "node_confidence": radius.get("node_confidence", {}),
                "truncated": radius["truncated"],
                "cosmetic_only": cosmetic_only_symbols.get(symbol),
                "signature_diff": public_signature_diff(sig_diff),
                "call_site_issues": call_site_issues,
            })
        for symbol, meta in modified_items[len(impact_items):]:
            report["modified"].append({
                "symbol": symbol,
                "file": meta["file"],
                "line": meta.get("start_line") or 1,
                "impact_radius": [],
                "impact_files": [],
                "levels": {},
                "confidence": {"high": 0, "low": 0},
                "node_confidence": {},
                "truncated": True,
                "analysis_limited": True,
                "cosmetic_only": cosmetic_only_symbols.get(symbol),
                "signature_diff": public_signature_diff(signature_diff_symbols.get(symbol)),
                "call_site_issues": [],
            })
    else:
        for symbol, meta in sorted(confirmed_modified_symbols.items()):
            report["modified"].append({
                "symbol": symbol, "file": meta["file"], "line": meta.get("start_line") or 1, "impact_radius": [], "impact_files": [],
                "confidence": {"high": 0, "low": 0}, "node_confidence": {}, "truncated": False,
                "cosmetic_only": cosmetic_only_symbols.get(symbol),
                "signature_diff": public_signature_diff(signature_diff_symbols.get(symbol)),
                "call_site_issues": [],
            })

    report["summary"] = format_summary_lines(report)
    print(json.dumps(report))


if __name__ == "__main__":
    main()
