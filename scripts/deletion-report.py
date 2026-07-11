"""On-demand "what did this change delete/affect" report.

Compares the working tree against a git ref (default HEAD): for every
changed Python, JavaScript/TypeScript, or Java file, diffs the function
symbol set (old vs new), scores each deleted symbol by how connected it was
in the last-generated callgraph (codemd.dev/combined_callgraph/combined_callgraph.json),
and computes the blast radius of every confirmed-modified symbol.

No hooks, no persistent snapshot cache, no Claude/Codex coupling: this is a
plain CLI invoked on demand (the VS Code extension runs it when the user
clicks "Check Changes"), using git itself as the "before" snapshot. Prints a
single JSON object to stdout; diagnostics go to stderr.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path


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


def changed_files(repo_root, base):
    """[(status, old_rel_path, new_rel_path, old_git_path, new_git_path)].

    old/new_rel_path are relative to repo_root for filesystem reads and
    report output; old/new_git_path are relative to the Git toplevel for
    git show/diff pathspecs.

    status is one of A(dded)/M(odified)/D(eleted)/R(enamed). Uses -M so a
    detected rename carries its old path through (so a renamed file's
    symbols get diffed old-content vs new-content, not reported as a full
    delete-then-add)."""
    prefix = git_prefix(repo_root)
    pathspec = prefix.rstrip("/") if prefix else "."
    result = _run_git(repo_root, ["diff", "--name-status", "-M", base, "--", pathspec])
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
    return entries


def git_show(repo_root, base, git_rel_path):
    """Content of rel_path at `base`, or None if it didn't exist there."""
    posix_path = git_rel_path.replace("\\", "/")
    result = _run_git(repo_root, ["show", f"{base}:{posix_path}"])
    if result.returncode != 0:
        return None
    return result.stdout


def changed_old_line_ranges(repo_root, base, git_rel_path):
    """[(start, end)] line ranges in the OLD (base) version of rel_path that
    this diff touches — parsed from unified=0 hunk headers, used to confirm a
    symbol whose name survived the edit was actually touched, not just
    re-emitted identically."""
    posix_path = git_rel_path.replace("\\", "/")
    result = _run_git(repo_root, ["diff", "--unified=0", base, "--", posix_path])
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


def diff_file_symbols(core_helpers, repo_root, base, status, old_rel_path, new_rel_path, old_git_path, new_git_path):
    """Returns (deleted, added, confirmed_modified, pre_spans_by_symbol) for
    one changed file. pre_spans_by_symbol carries start/end lines so callers
    can report file+line for deleted symbols."""
    old_source = None if status == "A" else git_show(repo_root, base, old_git_path)
    new_abs_path = os.path.join(repo_root, new_rel_path)
    new_source = None
    if status != "D" and os.path.isfile(new_abs_path):
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
        touched_ranges = changed_old_line_ranges(repo_root, base, old_git_path)
        for symbol in possibly_modified:
            span = pre_by_symbol[symbol]
            if any(ranges_overlap(r[0], r[1], span["start_line"], span["end_line"]) for r in touched_ranges):
                confirmed_modified.add(symbol)

    return deleted, added, confirmed_modified, pre_by_symbol


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


def load_callgraph(core_helpers, repo_root):
    graph_path = Path(repo_root) / "codemd.dev" / "combined_callgraph" / "combined_callgraph.json"
    if not graph_path.exists():
        return None
    try:
        graph = json.loads(graph_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return core_helpers.edge_graph_to_callgraph(graph)


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
    parser.add_argument("--backend-dir", required=True, help="Folder containing features/core/helpers.py.")
    args = parser.parse_args()

    sys.path.insert(0, args.backend_dir)
    from features.core import helpers as core_helpers  # noqa: E402  (path must be set first)
    supported_exts = getattr(core_helpers, "SUPPORTED_SPAN_EXTENSIONS", {".py"})

    repo_root = os.path.abspath(args.repo_root)
    report = {
        "deleted": [],
        "modified": [],
        "unsupported_files": [],
        "callgraph_available": False,
        "summary": [],
        "error": "",
    }

    try:
        entries = changed_files(repo_root, args.base)
    except RuntimeError as e:
        report["error"] = str(e)
        print(json.dumps(report))
        return

    callgraph = load_callgraph(core_helpers, repo_root)
    report["callgraph_available"] = callgraph is not None
    deleted_symbols = {}  # symbol -> {file, start_line, end_line}
    confirmed_modified_symbols = {}  # symbol -> file

    for status, old_rel_path, new_rel_path, old_git_path, new_git_path in entries:
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
        )
        if diffed is None:
            report["unsupported_files"].append(new_rel_path)
            continue
        deleted, _added, confirmed_modified, pre_by_symbol = diffed
        for symbol in deleted:
            deleted_symbols[symbol] = {
                "file": old_rel_path,
                "start_line": pre_by_symbol[symbol]["start_line"],
                "end_line": pre_by_symbol[symbol]["end_line"],
            }
        for symbol in confirmed_modified:
            confirmed_modified_symbols[symbol] = new_rel_path

    deleted_set = set(deleted_symbols)
    for symbol, meta in sorted(deleted_symbols.items()):
        entry = {"symbol": symbol, "file": meta["file"], "line": meta["start_line"]}
        if callgraph is not None:
            entry.update(score_deleted_symbol(core_helpers, symbol, callgraph, deleted_set))
        else:
            entry.update({"direct_callers": 0, "direct_callees": 0, "still_referenced": False, "severity": "UNKNOWN"})
        report["deleted"].append(entry)

    if callgraph is not None:
        for symbol, file_path in sorted(confirmed_modified_symbols.items()):
            radius = core_helpers.get_impact_radius(symbol, callgraph, max_nodes=200)
            impact_files = sorted({
                deleted_symbols.get(n, {}).get("file", "") for n in radius["impacted"]
            } - {""})
            report["modified"].append({
                "symbol": symbol,
                "file": file_path,
                "impact_radius": radius["impacted"],
                "impact_files": impact_files,
                "confidence": radius["confidence"],
                "truncated": radius["truncated"],
            })
    else:
        for symbol, file_path in sorted(confirmed_modified_symbols.items()):
            report["modified"].append({
                "symbol": symbol, "file": file_path, "impact_radius": [], "impact_files": [],
                "confidence": {"high": 0, "low": 0}, "truncated": False,
            })

    report["summary"] = format_summary_lines(report)
    print(json.dumps(report))


if __name__ == "__main__":
    main()
