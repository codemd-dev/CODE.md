import argparse
import json
import os
import shutil
import sys
from pathlib import Path


SKIPPED_ARTIFACT_KEY_RE = ("vector_db", "embedding", "train_pairs", "download_zip")
MIRRORED_HTML_ARTIFACTS = {"combined_callgraph/combined_navigatable_callgraph.html"}
WEBVIEW_SUPPORT_ARTIFACTS = ("lib/cytoscape/cytoscape.min.js",)


def collect_artifact_urls(value, prefix, out):
    if isinstance(value, dict):
        for key, child in value.items():
            if isinstance(child, str) and child.startswith(prefix):
                out.append((str(key), child))
            else:
                collect_artifact_urls(child, prefix, out)
    elif isinstance(value, list):
        for child in value:
            collect_artifact_urls(child, prefix, out)


def should_mirror(key, rel_path):
    lower_key = key.lower()
    if any(token in lower_key for token in SKIPPED_ARTIFACT_KEY_RE):
        return False
    if Path(rel_path).suffix.lower() != ".html":
        return True
    return rel_path.replace("\\", "/") in MIRRORED_HTML_ARTIFACTS


def html_relative_prefix(rel_path):
    depth = len(Path(rel_path).parts) - 1
    return "../" * depth if depth > 0 else "./"


def rewrite_html_artifact_for_webview(target, rel_path):
    if not target.exists():
        return
    text = target.read_text(encoding="utf-8", errors="ignore")
    prefix = html_relative_prefix(rel_path)
    rewritten = text.replace('"/lib/cytoscape/cytoscape.min.js"', f'"{prefix}lib/cytoscape/cytoscape.min.js"')
    rewritten = rewritten.replace("'/lib/cytoscape/cytoscape.min.js'", f"'{prefix}lib/cytoscape/cytoscape.min.js'")
    rewritten = rewritten.replace(
        "const initialElements = explicitElements.length ? explicitElements : [nodeElement(firstRoot)];",
        "const initialElements = explicitElements.length ? explicitElements : flowElementsFor(firstRoot, 1, 16);",
    )
    if rewritten != text:
        target.write_text(rewritten, encoding="utf-8")


def artifact_prefix(result):
    repo_id = str(result.get("repo_id") or result.get("repo") or "").strip()
    code_md_url = str(result.get("code_md_url") or "")
    if repo_id:
        marker = f"/{repo_id}/"
        index = code_md_url.find(marker)
        if index >= 0:
            return code_md_url[: index + len(marker)]
    return code_md_url.rsplit("/", 1)[0] + "/" if "/" in code_md_url else ""


def mirror_artifacts(result, output_dir):
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    prefix = artifact_prefix(result)
    source_root = Path(str(result.get("output_folder") or ""))
    if not prefix or not source_root.exists():
        return

    seen = set()
    entries = []
    collect_artifact_urls(result, prefix, entries)
    for key, url in entries:
        if url in seen:
            continue
        seen.add(url)
        rel_path = "CODE.md" if url == result.get("code_md_url") else url[len(prefix) :]
        if not rel_path or not should_mirror(key, rel_path):
            continue
        source = source_root / rel_path.replace("/", os.sep)
        target = output_dir / rel_path.replace("/", os.sep)
        if not source.exists():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)

    for rel_path in WEBVIEW_SUPPORT_ARTIFACTS:
        source = Path.cwd() / rel_path.replace("/", os.sep)
        target = output_dir / rel_path.replace("/", os.sep)
        if source.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)

    for rel_path in MIRRORED_HTML_ARTIFACTS:
        rewrite_html_artifact_for_webview(output_dir / rel_path.replace("/", os.sep), rel_path)


def main():
    parser = argparse.ArgumentParser(description="Run CODE.md local analysis without starting FastAPI.")
    parser.add_argument("--path", required=True, help="Workspace folder to analyze.")
    parser.add_argument("--name", default="", help="Display name for the workspace.")
    parser.add_argument("--mirror-out", required=True, help="Directory where VS Code should read mirrored artifacts.")
    parser.add_argument("--result-json", required=True, help="Path to write the API-compatible analysis result JSON.")
    args = parser.parse_args()

    backend_dir = Path.cwd()
    sys.path.insert(0, str(backend_dir))

    import main as backend_main

    src_dir = os.path.abspath(args.path)
    if not os.path.isdir(src_dir):
        raise SystemExit(f"Path does not exist or is not a folder: {src_dir}")

    safe_name = backend_main.safe_upload_name(args.name or os.path.basename(src_dir))
    if hasattr(backend_main, "local_path_repo_identity") and hasattr(backend_main, "run_local_path_analysis"):
        owner, repo, repo_id, output_repo_dir, repo_info = backend_main.local_path_repo_identity(src_dir, safe_name)
        result = backend_main.run_local_path_analysis(owner, repo, repo_id, output_repo_dir, src_dir, repo_info)
    else:
        path_hash = backend_main.hashlib.sha1(src_dir.encode("utf-8")).hexdigest()[:8]
        owner = "local-path"
        repo = f"{safe_name}-{path_hash}"
        repo_id = backend_main.short_id(owner, repo)
        output_repo_dir = os.path.join(backend_main.BASE_OUTPUT, repo_id)
        result = backend_main.analyze_local_source(
            owner,
            repo,
            repo_id,
            output_repo_dir,
            src_dir,
            repo_info={"full_name": f"{owner}/{repo}", "html_url": "", "default_branch": "local"},
            default_branch="local",
            build_download_zip=False,
        )

    mirror_artifacts(result, args.mirror_out)

    result_path = Path(args.result_json)
    result_path.parent.mkdir(parents=True, exist_ok=True)
    result_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({"status": "completed", "result_json": str(result_path)}), flush=True)


if __name__ == "__main__":
    main()
