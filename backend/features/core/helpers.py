import ast
import json
import os
import sqlite3
from pathlib import Path
from collections import Counter, defaultdict
from datetime import datetime
from typing import Optional

import logging
import re

logger = logging.getLogger(__name__)

SCIM_ARTIFACT_EVIDENCE_EXTENSIONS = {".json", ".jsonl", ".txt", ".md", ".csv"}
SCIM_ARTIFACT_EVIDENCE_MAX_CHARS = 12000
SCIM_ARTIFACT_EVIDENCE_CHUNK_CHARS = 6000
SCIM_ARTIFACT_EVIDENCE_MAX_RECORDS = 300

def find_cached_source_dir(output_repo_dir):
    extracted_src_dir = os.path.join(output_repo_dir, "src")
    if not os.path.isdir(extracted_src_dir):
        return ""
    entries = [
        os.path.join(extracted_src_dir, entry)
        for entry in os.listdir(extracted_src_dir)
        if os.path.isdir(os.path.join(extracted_src_dir, entry))
    ]
    if len(entries) == 1:
        return entries[0]
    return extracted_src_dir



def artifact_root_for_output(output_repo_dir):
    output_repo_path = Path(output_repo_dir)
    nested = output_repo_path / output_repo_path.name
    if nested.exists() and (nested / "src").exists():
        return nested
    return output_repo_path


def architecture_dir_for_output(output_repo_dir):
    artifact_root = artifact_root_for_output(output_repo_dir)
    path = artifact_root / "architecture"
    path.mkdir(parents=True, exist_ok=True)
    return path


def architecture_artifact_path(output_repo_dir, *parts):
    return architecture_dir_for_output(output_repo_dir).joinpath(*parts)


def first_existing_path(*paths):
    for path in paths:
        candidate = Path(path)
        if candidate.exists():
            return candidate
    return Path(paths[0]) if paths else Path()


def first_valid_json_path(*paths):
    for path in paths:
        candidate = Path(path)
        if not candidate.exists() or not candidate.is_file():
            continue
        try:
            if candidate.stat().st_size <= 0:
                logger.warning("Skipping empty JSON artifact: %s", candidate)
                continue
            json.loads(candidate.read_text(encoding="utf-8-sig"))
        except Exception as e:
            logger.warning("Skipping invalid JSON artifact %s: %s", candidate, e)
            continue
        return candidate
    return Path(paths[0]) if paths else Path()


def feature_catalog_path_for_output(output_repo_dir):
    artifact_root = artifact_root_for_output(output_repo_dir)
    return first_valid_json_path(
        artifact_root / "architecture" / "feature_catalog.json",
        artifact_root / "scim" / "feature_catalog.json",
    )


def feature_summaries_path_for_output(output_repo_dir):
    artifact_root = artifact_root_for_output(output_repo_dir)
    return first_existing_path(
        artifact_root / "architecture" / "feature_summaries.json",
        artifact_root / "scim" / "feature_summaries.json",
    )


def features_text_path_for_output(output_repo_dir):
    artifact_root = artifact_root_for_output(output_repo_dir)
    return first_existing_path(
        artifact_root / "architecture" / "features.txt",
        artifact_root / "scim" / "features.txt",
    )


def typed_evidence_paths_for_output(output_repo_dir):
    architecture_dir = architecture_dir_for_output(output_repo_dir)
    return architecture_dir / "typed_evidence.jsonl", architecture_dir / "typed_evidence_edges.jsonl"


def github_metadata_summary(repo_info, default_branch):
    if not repo_info:
        return {}
    return {
        "full_name": repo_info.get("full_name"),
        "owner_login": (repo_info.get("owner") or {}).get("login"),
        "default_branch": default_branch or repo_info.get("default_branch"),
        "html_url": repo_info.get("html_url"),
        "created_at": repo_info.get("created_at"),
        "updated_at": repo_info.get("updated_at"),
        "pushed_at": repo_info.get("pushed_at"),
        "size_kb": repo_info.get("size"),
        "stargazers_count": repo_info.get("stargazers_count"),
        "forks_count": repo_info.get("forks_count"),
        "open_issues_count": repo_info.get("open_issues_count"),
        "watchers_count": repo_info.get("watchers_count"),
        "subscribers_count": repo_info.get("subscribers_count"),
        "network_count": repo_info.get("network_count"),
        "primary_language": repo_info.get("language"),
        "visibility": repo_info.get("visibility"),
        "archived": repo_info.get("archived"),
        "disabled": repo_info.get("disabled"),
        "license": (repo_info.get("license") or {}).get("spdx_id"),
        "description": repo_info.get("description"),
        "topics": repo_info.get("topics") or [],
    }

def build_repo_context(owner="", repo="", repo_info=None, default_branch="", repo_text=None):
    repo_text = repo_text if isinstance(repo_text, dict) else {}
    github = github_metadata_summary(repo_info, default_branch) if repo_info else {}
    readme_items = repo_text.get("readme_items", []) if isinstance(repo_text, dict) else []
    document_items = repo_text.get("document_items", []) if isinstance(repo_text, dict) else []
    text_items = repo_text.get("text_items", []) if isinstance(repo_text, dict) else []
    ui_text_items = repo_text.get("ui_text_items", []) if isinstance(repo_text, dict) else []
    all_document_items = document_items + text_items + ui_text_items
    return {
        "github_owner": owner or github.get("owner_login", ""),
        "github_repo": repo or "",
        "github_full_name": f"{owner}/{repo}" if owner and repo else github.get("full_name", ""),
        "github_description": github.get("description", ""),
        "github_topics": github.get("topics", []),
        "default_branch": default_branch or github.get("default_branch", ""),
        "readme_items": readme_items[:20],
        "document_items": all_document_items[:100],
        "readme_text": "\n\n".join(str(item.get("text", "")) for item in readme_items[:5]),
        "document_text": "\n\n".join(str(item.get("text", "")) for item in all_document_items[:30]),
    }


def safe_filename(name: str) -> str:
    # Replace invalid Windows filename characters with underscore
    return re.sub(r'[<>:"/\\|?*]', '_', name)

def stable_text_id(value: str):
    import hashlib
    return hashlib.blake2b(str(value or "").encode("utf-8", errors="ignore"), digest_size=8).hexdigest()


def ga_value_is_useful(value):
    value = str(value or "").strip()
    return bool(value and value.lower() not in {"(not set)", "not set", "none", "null", "undefined", "#"})


def is_ga_collection_endpoint(value):
    text = str(value or "").lower()
    return (
        "analytics.google.com/g/collect" in text
        or "google-analytics.com/g/collect" in text
        or "google-analytics.com/collect" in text
        or "googletagmanager.com/gtag/js" in text
    )


def is_autotrack_analytics_beacon_row(row: dict):
    if not isinstance(row, dict):
        return False
    label = str(row.get("customEvent:button_name") or row.get("button_name") or "").lower()
    values = [
        row.get("customEvent:callgraph_node") or row.get("callgraph_node") or "",
        row.get("customEvent:function_name") or row.get("function_name") or "",
        row.get("customEvent:endpoint") or row.get("endpoint") or "",
    ]
    return "backend error" in label and any(is_ga_collection_endpoint(value) for value in values)


def ga_row_label(row: dict):
    for key in (
        "customEvent:button_name", "button_name",
        "customEvent:click_text", "click_text",
        "customEvent:function_name", "function_name",
        "customEvent:callgraph_node", "callgraph_node",
        "pagePath", "pageTitle",
    ):
        value = str(row.get(key, "") or "").strip()
        if ga_value_is_useful(value):
            return value[:80]
    return "GA interaction"


def scim_evidence_record(symbol: str, source_type: str, title: str, path: str, text: str, metadata: Optional[dict] = None):
    text = "\n".join(str(text or "").splitlines()).strip()
    return {
        "repo_id": "typed_evidence",
        "chunk_id": f"evidence:{stable_text_id(symbol + path + source_type)}",
        "symbol": symbol,
        "class_name": source_type,
        "method_name": title,
        "path": path,
        "start_line": 1,
        "end_line": max(1, len(text.splitlines())),
        "source_type": source_type,
        "title": title,
        "evidence_text": text[:12000],
        "metadata": metadata or {},
    }

def load_json_file(path: Path, default=None):
    try:
        if Path(path).exists():
            return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except Exception as e:
        logger.warning("Unable to load JSON file %s: %s", path, e)
    return {} if default is None else default


def load_search_callgraph(output_repo_dir):
    ordered_sequence_candidates = [
        ("combined-ordered", os.path.join(output_repo_dir, "combined_callgraph", "combined_ordered_call_sequence.json")),
        ("joern-normalized", os.path.join(output_repo_dir, "joern", "joern_ordered_call_sequence.json")),
        ("java-merged-ordered", os.path.join(output_repo_dir, "java_merged", "java_merged_ordered_call_sequence.json")),
        ("tree-sitter-java-ordered", os.path.join(output_repo_dir, "tree_sitter_java", "tree_sitter_java_ordered_call_sequence.json")),
        ("javalang-ordered", os.path.join(output_repo_dir, "javalang", "javalang_ordered_call_sequence.json")),
        ("python-ast-ordered", os.path.join(output_repo_dir, "python", "python_ordered_call_sequence.json")),
        ("javascript-ordered", os.path.join(output_repo_dir, "javascript", "javascript_ordered_call_sequence.json")),
        ("csharp-regex-ordered", os.path.join(output_repo_dir, "csharp", "csharp_ordered_call_sequence.json")),
    ]
    for source, ordered_path in ordered_sequence_candidates:
        if not os.path.exists(ordered_path):
            continue
        logger.info("ORDERED_CALL_SEQUENCE_PATH: %s", ordered_path)
        with open(ordered_path, "r", encoding="utf-8") as f:
            payload = json.load(f)
        by_method = {}
        for call in payload.get("calls", []) or []:
            if not isinstance(call, dict):
                continue
            caller = call.get("caller")
            callee = call.get("callee")
            if not caller or not callee:
                continue
            by_method.setdefault(caller, {"method": caller, "calls": []})["calls"].append({
                "callee_fullName": callee,
                "line": call.get("line"),
                "order": call.get("order"),
                "call_code": call.get("call_text", ""),
                "call_name": str(callee).split(".")[-1],
            })
            by_method.setdefault(callee, {"method": callee, "calls": []})
        return list(by_method.values()), source

    joern_path = os.path.join(output_repo_dir, "joern", "joern_callgraph_ordered.json")
    if os.path.exists(joern_path):
        logger.info("CALLGRAPH_PATH: %s", joern_path)
        with open(joern_path, "r", encoding="utf-8") as f:
            callgraph = json.load(f)
        return callgraph, "joern"

    edge_graph_candidates = [
        ("combined", os.path.join(output_repo_dir, "combined_callgraph", "combined_callgraph.json")),
        ("combined-navigatable", os.path.join(output_repo_dir, "combined_callgraph", "combined_navigatable_callgraph.json")),
        ("html-ui", os.path.join(output_repo_dir, "html_ui", "html_ui_graph.json")),
        ("java-merged", os.path.join(output_repo_dir, "java_merged", "java_merged_callgraph.json")),
        ("tree-sitter-java", os.path.join(output_repo_dir, "tree_sitter_java", "tree_sitter_java_callgraph.json")),
        ("javalang", os.path.join(output_repo_dir, "javalang", "javalang_callgraph.json")),
        ("python-ast", os.path.join(output_repo_dir, "python", "python_callgraph.json")),
        ("javascript", os.path.join(output_repo_dir, "javascript", "javascript_callgraph.json")),
        ("csharp-regex", os.path.join(output_repo_dir, "csharp", "csharp_callgraph.json")),
    ]
    for source, graph_path in edge_graph_candidates:
        if not os.path.exists(graph_path):
            continue
        logger.info("CALLGRAPH_PATH: %s", graph_path)
        with open(graph_path, "r", encoding="utf-8") as f:
            graph = json.load(f)
        raw_edges = graph.get("edges", graph) if isinstance(graph, dict) else graph
        raw_edges = raw_edges if isinstance(raw_edges, list) else []
        raw_nodes = graph.get("nodes", []) if isinstance(graph, dict) else []
        methods = set()
        for node in raw_nodes or []:
            if isinstance(node, str):
                methods.add(node)
            elif isinstance(node, dict):
                data = node.get("data") if isinstance(node.get("data"), dict) else node
                node_id = data.get("id") or data.get("name") or data.get("label")
                if node_id:
                    methods.add(str(node_id))
        edges = []
        for edge in raw_edges:
            caller = callee = None
            if isinstance(edge, list) and len(edge) >= 2:
                caller, callee = edge[0], edge[1]
            elif isinstance(edge, dict):
                data = edge.get("data") if isinstance(edge.get("data"), dict) else edge
                caller = data.get("source") or data.get("from") or data.get("caller")
                callee = data.get("target") or data.get("to") or data.get("callee")
            if caller and callee:
                edges.append((str(caller), str(callee)))
                methods.add(str(caller))
                methods.add(str(callee))
        for edge in edges:
            methods.add(edge[0])
            methods.add(edge[1])
        callgraph = [{"method": method, "calls": []} for method in sorted(methods)]
        by_method = {item["method"]: item for item in callgraph}
        for caller, callee in edges:
            by_method.setdefault(caller, {"method": caller, "calls": []})["calls"].append({
                "callee_fullName": callee,
                "line": None,
                "order": None,
                "call_code": "",
                "call_name": str(callee).split(".")[-1],
            })
        return list(by_method.values()), source

    raise FileNotFoundError(
        f"No callgraph found. Expected combined, HTML UI, Joern, tree-sitter/javalang, Python, JavaScript, or C# graph JSON. Run Analyze first."
    )


def scim_artifact_source_type(path: Path) -> str:
    name = path.name.lower()
    rel = str(path).replace("\\", "/").lower()
    if name == "static_quality_signals.json":
        return "quality_signal"
    if name in {"daily_change_cache.json", "daily_commit_graph.json"} or "daily_change_graph" in name:
        return "commit_history"
    if name in {"feature_summaries.json", "features.txt"}:
        return "generated_feature_summary"
    if name == "answers.jsonl" or "/derived_memory/" in rel:
        return "derived_summary"
    if name == "ga_interactions.json" or name.startswith("ga_"):
        return "ga_summary"
    if "callgraph" in name or "graph" in name:
        return "graph_artifact"
    if name in {"repo_text.json", "repo_comments.json"}:
        return "source_text"
    if name == "repo_stats.json":
        return "repo_overview"
    return "artifact_text"


def scim_artifact_title(path: Path, artifact_root: Path) -> str:
    rel = str(path.relative_to(artifact_root)).replace("\\", "/") if artifact_root in path.parents or path == artifact_root else path.name
    return f"Artifact: {rel}"


def chunk_scim_artifact_text(text: str, chunk_chars: int = SCIM_ARTIFACT_EVIDENCE_CHUNK_CHARS) -> list[str]:
    text = "\n".join(str(text or "").splitlines()).strip()
    if not text:
        return []
    chunks = []
    start = 0
    while start < len(text):
        end = min(len(text), start + chunk_chars)
        if end < len(text):
            newline = text.rfind("\n", start, end)
            if newline > start + int(chunk_chars * 0.6):
                end = newline
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        start = max(end, start + 1)
    return chunks

def build_feature_summary_evidence(output_repo_dir: Path):
    artifact_root = artifact_root_for_output(output_repo_dir)
    feature_data = load_json_file(feature_catalog_path_for_output(artifact_root), {})
    generated_data = load_json_file(feature_summaries_path_for_output(artifact_root), {})
    features = feature_data.get("features", []) if isinstance(feature_data, dict) else []
    generated_features = generated_data.get("feature_summaries", []) if isinstance(generated_data, dict) else []
    if not features and not generated_features:
        return []
    lines = [
        "Repository feature summary from SCIM feature catalog.",
        f"Product name: {feature_data.get('product_name', '')}.",
        f"Product type: {feature_data.get('product_type', '')}.",
        "Generated feature explanations are derived summaries, not original repository truth.",
        "Detected feature candidates:",
    ]
    for feature in features[:50]:
        lines.append(f"- {feature.get('feature', '')}: matches {feature.get('match_count', 0)}; status {feature.get('status', '')}; visibility {feature.get('visibility', '')}.")
    if generated_features:
        lines.append("Generated feature summaries:")
        for feature in generated_features[:50]:
            description = " ".join(str(feature.get("description") or "").split())
            lines.append(f"- {feature.get('feature', '')}: {description}")
    records = [
        scim_evidence_record(
            "evidence.features.summary",
            "feature_summary",
            "Repository Feature Summary",
            "architecture/feature_catalog.json",
            "\n".join(lines),
            {"feature_count": len(features), "generated_feature_summary_count": len(generated_features)},
        )
    ]
    for index, feature in enumerate(generated_features[:80], start=1):
        name = str(feature.get("feature") or f"Feature {index}").strip()
        description = " ".join(str(feature.get("description") or "").split())
        if not description:
            continue
        references = feature.get("references") or []
        reference_text = "; ".join(
            f"{ref.get('short_symbol') or ref.get('symbol') or ''} {ref.get('file') or ref.get('path') or ''}:{ref.get('start_line') or ''}".strip()
            for ref in references[:5]
            if isinstance(ref, dict)
        )
        records.append(scim_evidence_record(
            f"evidence.features.generated.{index:03d}.{safe_filename(name).lower()}",
            "generated_feature_summary",
            name,
            "architecture/feature_summaries.json",
            (
                "Generated feature summary derived from SCIM evidence and LLM review.\n"
                "Truth status: derived_not_original_truth.\n"
                f"Feature: {name}\n"
                f"Description: {description}\n"
                f"References: {reference_text}"
            ),
            {
                "feature": name,
                "references": references[:10],
                "truth_status": "derived_not_original_truth",
            },
        ))
    return records





def discover_scim_artifact_text_files(artifact_root: Path) -> list[Path]:
    selected = []
    for path in artifact_root.rglob("*"):
        if not path.is_file():
            continue
        rel_parts = set(path.relative_to(artifact_root).parts)
        if {"src", "upload", "__pycache__", "scim", "architecture", "feature_graph", "file_graph", "combined_callgraph"} & rel_parts:
            continue
        if path.suffix.lower() not in SCIM_ARTIFACT_EVIDENCE_EXTENSIONS:
            continue
        if path.name.lower() in {
            "vectors.sqlite",
            "embedding_model.json",
            "typed_evidence.jsonl",
            "typed_evidence_edges.jsonl",
            "vectors.faiss.jsonl",
            "model_layers.json",
        }:
            continue
        selected.append(path)
    return sorted(selected, key=lambda item: str(item).lower())




def text_from_json_artifact(path: Path) -> str:
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="ignore"))
    except Exception:
        return path.read_text(encoding="utf-8", errors="ignore")[:SCIM_ARTIFACT_EVIDENCE_MAX_CHARS]
    if isinstance(data, dict):
        interesting = {}
        for key in (
            "summary", "message", "property", "event_name", "diagnostic", "owner", "repo",
            "count", "author_count", "changed_files", "changed_functions",
            "feature_summaries", "features", "rows", "commits", "todos", "text_items",
            "readme_items", "document_items", "graphs", "nodes", "edges",
        ):
            if key in data:
                interesting[key] = data[key]
        if interesting:
            return json.dumps(interesting, ensure_ascii=False, indent=2)[:SCIM_ARTIFACT_EVIDENCE_MAX_CHARS]
    return json.dumps(data, ensure_ascii=False, indent=2)[:SCIM_ARTIFACT_EVIDENCE_MAX_CHARS]



def build_artifact_text_evidence(output_repo_dir: Path):
    artifact_root = artifact_root_for_output(output_repo_dir)
    records = []
    for path in discover_scim_artifact_text_files(artifact_root):
        if len(records) >= SCIM_ARTIFACT_EVIDENCE_MAX_RECORDS:
            break
        try:
            text = text_from_json_artifact(path) if path.suffix.lower() in {".json", ".jsonl"} else path.read_text(encoding="utf-8", errors="ignore")[:SCIM_ARTIFACT_EVIDENCE_MAX_CHARS]
        except Exception as e:
            logger.debug("Unable to build SCIM artifact evidence for %s: %s", path, e)
            continue
        rel = str(path.relative_to(artifact_root)).replace("\\", "/")
        source_type = scim_artifact_source_type(path)
        try:
            artifact_modified_at = datetime.fromtimestamp(path.stat().st_mtime).isoformat()
        except Exception:
            artifact_modified_at = ""
        chunks = chunk_scim_artifact_text(text)
        for index, chunk in enumerate(chunks[:6], start=1):
            if len(records) >= SCIM_ARTIFACT_EVIDENCE_MAX_RECORDS:
                break
            records.append(scim_evidence_record(
                f"evidence.artifact.{safe_filename(rel).lower()}.{index:03d}",
                source_type,
                scim_artifact_title(path, artifact_root),
                rel,
                (
                    f"SCIM artifact evidence chunk {index} from {rel}.\n"
                    f"Source type: {source_type}.\n"
                    f"Artifact time: {artifact_modified_at or 'unknown'}.\n"
                    f"{chunk}"
                ),
                {
                    "relative_path": rel,
                    "artifact_source_type": source_type,
                    "artifact_modified_at": artifact_modified_at,
                    "chunk_index": index,
                    "truth_status": "original_artifact" if source_type not in {"derived_summary", "generated_feature_summary"} else "derived_not_original_truth",
                },
            ))
    return records


def build_callgraph_summary_evidence(output_repo_dir: Path):
    artifact_root = artifact_root_for_output(output_repo_dir)
    try:
        callgraph, source = load_search_callgraph(artifact_root)
    except Exception:
        return []
    methods = len(callgraph)
    edge_count = sum(len(item.get("calls", []) or []) for item in callgraph if isinstance(item, dict))
    high_out = sorted(((item.get("method", ""), len(item.get("calls", []) or [])) for item in callgraph if isinstance(item, dict)), key=lambda item: item[1], reverse=True)[:30]
    lines = ["Repository callgraph summary.", f"Callgraph source: {source}.", f"Methods/functions: {methods}.", f"Extracted call edges: {edge_count}.", "High fan-out functions:"]
    lines.extend(f"- {method}: {count} callees." for method, count in high_out if method)
    return [scim_evidence_record("evidence.callgraph.summary", "callgraph_summary", "Callgraph Summary", "scim/generated_callgraph_summary.md", "\n".join(lines), {"callgraph_source": source, "node_count": methods, "edge_count": edge_count})]



def build_repo_overview_evidence(output_repo_dir: Path):
    artifact_root = artifact_root_for_output(output_repo_dir)
    stats = load_json_file(artifact_root / "repo_stats.json", {})
    text_payload = load_json_file(artifact_root / "repo_text.json", {})
    if not stats and not text_payload:
        return []
    readme_text = "\n\n".join(str(item.get("text", "")) for item in (text_payload.get("readme_items") or [])[:3] if isinstance(item, dict))
    lines = ["Repository overview evidence.", f"Files seen: {stats.get('total_files_seen', '')}.", f"Extensions: {json.dumps(stats.get('extensions', stats.get('extension_counts', {})))[:1000]}.", "README/docs excerpt:", readme_text[:5000]]
    return [scim_evidence_record("evidence.repo.overview", "repo_overview", "Repository Overview", "repo_stats.json", "\n".join(lines), {"files_seen": stats.get("total_files_seen", "")})]


def build_typed_scim_evidence_records(output_repo_dir: Path):
    records = []
    edges = []
    records.extend(build_repo_overview_evidence(output_repo_dir))
    records.extend(build_feature_summary_evidence(output_repo_dir))
    ga_records, ga_edges = build_ga_summary_evidence(output_repo_dir)
    records.extend(ga_records)
    edges.extend(ga_edges)
    return records, edges


def build_ga_summary_evidence(output_repo_dir: Path):
    artifact_root = artifact_root_for_output(output_repo_dir)
    payload = load_json_file(artifact_root / "ga_interactions.json", {})
    ordered_rows = [
        row for row in (payload.get("ordered_rows") or payload.get("rows") or [])
        if isinstance(row, dict) and not is_autotrack_analytics_beacon_row(row)
    ]
    if not ordered_rows:
        return [], []

    action_counts = Counter()
    action_functions = defaultdict(set)
    action_nodes = defaultdict(set)
    action_errors = defaultdict(list)
    evidence_edges = []
    for row in ordered_rows:
        label = ga_row_label(row)
        try:
            count = int(row.get("eventCount") or 0)
        except (TypeError, ValueError):
            count = 0
        action_counts[label] += count
        function_name = row.get("customEvent:function_name") or row.get("function_name") or ""
        callgraph_node = row.get("customEvent:callgraph_node") or row.get("callgraph_node") or ""
        error_message = row.get("customEvent:error_message") or row.get("error_message") or row.get("customEvent:ui_message") or row.get("ui_message") or ""
        if ga_value_is_useful(function_name):
            action_functions[label].add(str(function_name))
        if ga_value_is_useful(callgraph_node):
            action_nodes[label].add(str(callgraph_node))
        if ga_value_is_useful(error_message):
            action_errors[label].append(str(error_message))
        evidence_edges.append({
            "source": f"evidence.ga.action.{stable_text_id(label)}",
            "target": str(callgraph_node or function_name or ""),
            "relationship": "observed_action_maps_to",
            "label": label,
            "event_count": count,
        })

    trace_by_label = {
        str(graph.get("label")): graph
        for graph in (payload.get("graphs") or {}).get("ga_event_trace_graphs") or []
        if isinstance(graph, dict) and graph.get("label")
    }
    summary_lines = [
        "Google Analytics user actions summary.",
        f"Total ordered GA rows: {len(ordered_rows)}.",
        f"Unique actions: {len(action_counts)}.",
        "Actions by event count:",
    ]
    for label, count in action_counts.most_common(80):
        trace = trace_by_label.get(label, {})
        summary_lines.append(
            f"- {label}: {count} events. Functions: {', '.join(sorted(action_functions[label])) or 'none'}. "
            f"Callgraph nodes: {', '.join(sorted(action_nodes[label])) or 'none'}. "
            f"GA steps: {', '.join(trace.get('ga_steps') or []) or 'none'}. "
            f"Trace graph: {trace.get('graph_url', '') or 'none'}. "
            f"Errors: {' | '.join(action_errors[label][:3]) if action_errors[label] else 'none'}."
        )
    records = [
        scim_evidence_record(
            "evidence.ga.user_actions.summary",
            "ga_summary",
            "Google Analytics User Actions Summary",
            "src/codeval_generated/ga_user_actions_summary.md",
            "\n".join(summary_lines),
            {"row_count": len(ordered_rows), "unique_action_count": len(action_counts), "event_name": payload.get("event_name", "")},
        )
    ]
    for index, row in enumerate(ordered_rows[:200], start=1):
        label = ga_row_label(row)
        function_name = row.get("customEvent:function_name") or row.get("function_name") or ""
        callgraph_node = row.get("customEvent:callgraph_node") or row.get("callgraph_node") or ""
        error_message = row.get("customEvent:error_message") or row.get("error_message") or row.get("customEvent:ui_message") or row.get("ui_message") or ""
        count = row.get("eventCount") or 0
        records.append(scim_evidence_record(
            f"evidence.ga.step_{index:03d}.{re.sub(r'[^A-Za-z0-9_]+', '_', label).strip('_') or 'interaction'}",
            "ga_event",
            f"GA action {index}: {label}",
            "ga_interactions.json",
            f"GA action step_{index:03d}: {label}. Event count: {count}. Function: {function_name}. Callgraph node: {callgraph_node}. Error message: {error_message}.",
            {"label": label, "event_count": count, "function_name": function_name, "callgraph_node": callgraph_node},
        ))
    for index, graph in enumerate((payload.get("graphs") or {}).get("ga_event_trace_graphs") or [], start=1):
        if not isinstance(graph, dict):
            continue
        label = str(graph.get("label") or f"trace {index}")
        records.append(scim_evidence_record(
            f"evidence.ga.trace_{index:03d}.{re.sub(r'[^A-Za-z0-9_]+', '_', label).strip('_') or 'trace'}",
            "ga_trace",
            f"GA trace graph {index}: {label}",
            graph.get("graph_url", "") or "ga_event_trace_graphs",
            f"GA event trace graph for {label}. Event count: {graph.get('event_count', 0)}. GA node: {graph.get('ga_node', '')}. GA steps: {', '.join(graph.get('ga_steps') or [])}. Root code/UI nodes: {', '.join(graph.get('root_nodes') or [])}. Graph URL: {graph.get('graph_url', '')}.",
            graph,
        ))
    return records, evidence_edges

def index_typed_scim_evidence(output_repo_dir):
    artifact_root = artifact_root_for_output(Path(output_repo_dir))
    scim_dir = artifact_root / "scim"
    vector_db_path = scim_dir / "vectors.sqlite"
    if not vector_db_path.exists():
        return {"indexed": 0, "reason": "SCIM vector index is not available yet"}
    records, edges = build_typed_scim_evidence_records(artifact_root)
    evidence_path, edge_path = typed_evidence_paths_for_output(artifact_root)
    evidence_path.write_text("\n".join(json.dumps(record, ensure_ascii=False) for record in records) + ("\n" if records else ""), encoding="utf-8")
    edge_path.write_text("\n".join(json.dumps(edge, ensure_ascii=False) for edge in edges if edge.get("target")) + ("\n" if edges else ""), encoding="utf-8")
    with sqlite3.connect(vector_db_path) as connection:
        connection.execute("DELETE FROM vectors WHERE json_extract(metadata, '$.is_typed_evidence') = 1")
        connection.commit()
    return {
        "indexed": 0,
        "typed_evidence_records": len(records),
        "evidence_path": str(evidence_path),
        "edge_path": str(edge_path),
        "note": "Typed/generated evidence is written as architecture artifacts only; it is not embedded into scim/vectors.sqlite.",
    }


def write_scim_layer_manifest(output_repo_dir: Path, evidence_result: dict | None = None, **_ignored):
    artifact_root = artifact_root_for_output(output_repo_dir)
    architecture_dir = architecture_dir_for_output(artifact_root)
    manifest_path = architecture_dir / "model_layers.json"
    layer_manifest = {
        "generated_at": datetime.now().isoformat(),
        "model": "SCIM",
        "description": "Source Code Intelligence Model layers for this repository.",
        "layers": {
            "raw_text": {
                "status": "implemented",
                "artifacts": ["code-unit chunks: functions, methods, classes, docstrings, inline comments"],
                "note": "The SCIM vector index is restricted to code units only. Whole-file text, README/docs/config files, generated artifacts, and graph outputs are not embedded.",
            },
            "structural": {
                "status": "implemented_partial_by_language",
                "artifacts": ["language callgraphs", "combined_callgraph", "file_graph", "html_ui_graph", "graph JSON artifacts"],
                "note": "Control-flow graphs are included when extractor artifacts exist; otherwise callgraph/dependency graph evidence is used.",
            },
            "semantic": {
                "status": "implemented",
                "artifacts": ["feature_summaries.json", "derived_memory/answers.jsonl", "product summaries", "daily summaries"],
                "truth_policy": "Generated summaries are derived evidence, not original source truth.",
            },
            "embedding": {
                "status": "implemented",
                "artifacts": ["scim/vectors.sqlite", "scim/embedding_model.json", "scim/functions.jsonl"],
                "indexed_typed_evidence": 0,
                "typed_evidence_path": (evidence_result or {}).get("evidence_path", ""),
            },
            "retrieval": {
                "status": "implemented",
                "artifacts": ["retrieval planner", "source-type boosts", "callgraph-aware search", "text/code/evidence retrieval"],
            },
            "synthesis": {
                "status": "implemented_via_external_llm",
                "artifacts": ["search-answer", "summary", "feature-summary", "daily-summary prompts"],
            },
        },
    }
    manifest_path.write_text(json.dumps(layer_manifest, indent=2), encoding="utf-8")


# ---------------------------------------------------------------------------
# Callgraph traversal primitives.
#
# Deliberately kept in this lightweight module (not backend/main.py, which
# also pulls in FastAPI/Joern/ML deps and takes ~2.5s just to import) so
# short-lived, frequent callers — like the on-demand deletion/blast-radius
# report the VS Code extension runs from a sidebar button — can use them
# without that cost. main.py re-exports these names for its own call sites.
# ---------------------------------------------------------------------------

def edge_graph_to_callgraph(graph: dict):
    """Convert a cytoscape-style {"nodes": [...], "edges": [[src, dst, order, line], ...]}
    graph (e.g. combined_callgraph.json) into the {"method", "calls": [...]} list
    shape callgraph_adjacency/traverse_forward/traverse_backward expect."""
    edges = graph.get("edges", []) if isinstance(graph, dict) else []
    edges = edges if isinstance(edges, list) else []
    methods = set(graph.get("nodes", []) or []) if isinstance(graph, dict) else set()
    for edge in edges:
        if isinstance(edge, list) and len(edge) >= 2:
            methods.add(edge[0])
            methods.add(edge[1])
    callgraph = [{"method": method, "calls": []} for method in sorted(methods)]
    by_method = {item["method"]: item for item in callgraph}
    for edge in edges:
        if not isinstance(edge, list) or len(edge) < 2:
            continue
        caller, callee = edge[0], edge[1]
        by_method.setdefault(caller, {"method": caller, "calls": []})["calls"].append({
            "callee_fullName": callee,
            "line": edge[3] if len(edge) > 3 else None,
            "order": edge[2] if len(edge) > 2 else None,
            "call_code": "",
            "call_name": str(callee).split(".")[-1],
        })
    return list(by_method.values())


def callgraph_adjacency(callgraph):
    """Build forward (caller -> callees) and backward (callee -> callers)
    adjacency dicts from either load_search_callgraph() shape: a legacy
    {caller: [callees]} dict, or the modern list of {"method", "calls": [...]}."""
    forward = defaultdict(set)
    backward = defaultdict(set)
    if isinstance(callgraph, dict):
        for caller, callees in callgraph.items():
            for callee in callees or []:
                callee_name = str(callee or "")
                if not caller or not callee_name:
                    continue
                forward[caller].add(callee_name)
                backward[callee_name].add(caller)
        return forward, backward

    for entry in callgraph or []:
        if not isinstance(entry, dict):
            continue
        caller = entry.get("method")
        if not caller:
            continue
        for call in entry.get("calls", []) or []:
            callee_name = call.get("callee_fullName") if isinstance(call, dict) else None
            if not callee_name:
                continue
            forward[caller].add(callee_name)
            backward[callee_name].add(caller)
    return forward, backward


def _traverse_callgraph_bfs(start_nodes, adjacency, max_depth: int, max_nodes: int = 200):
    start_nodes = [node for node in dict.fromkeys(start_nodes) if node]
    visited = set(start_nodes)
    levels = {node: 0 for node in start_nodes}
    edges = []
    frontier = list(start_nodes)
    depth = 0
    while frontier and depth < max_depth and len(visited) < max_nodes:
        depth += 1
        next_frontier = []
        for node in frontier:
            for neighbor in sorted(adjacency.get(node) or ()):
                edges.append((node, neighbor))
                if neighbor not in visited:
                    visited.add(neighbor)
                    levels[neighbor] = depth
                    next_frontier.append(neighbor)
                if len(visited) >= max_nodes:
                    break
            if len(visited) >= max_nodes:
                break
        frontier = next_frontier
    return {
        "nodes": sorted(visited - set(start_nodes)),
        "edges": edges,
        "levels": levels,
        "max_depth_reached": depth,
    }


def traverse_forward(start_nodes, callgraph, max_depth: int = 5, max_nodes: int = 200):
    """Walk what `start_nodes` call, up to max_depth levels deep."""
    forward, _backward = callgraph_adjacency(callgraph)
    return _traverse_callgraph_bfs(start_nodes, forward, max_depth, max_nodes)


def traverse_backward(start_nodes, callgraph, max_depth: int = 3, max_nodes: int = 200):
    """Walk what calls `start_nodes`, up to max_depth levels deep."""
    _forward, backward = callgraph_adjacency(callgraph)
    return _traverse_callgraph_bfs(start_nodes, backward, max_depth, max_nodes)


def get_impact_radius(node, callgraph, max_nodes: int = 200):
    """Blast radius for a modified function: everything that transitively
    depends on it (direct callers, their callers, ...), unbounded depth but
    capped at max_nodes. Each reached node is annotated with a confidence
    bucket: "high" if it's reached via at least one directly-parsed call edge
    (has order/line metadata), "low" if every edge on its shortest path here
    is a heuristic, name-matched edge (e.g. the UI alias edges
    add_ui_alias_edges() adds by string-matching a handler name — those carry
    no order/line, since they aren't from an actual traced call site)."""
    result = _traverse_callgraph_bfs([node], callgraph_adjacency(callgraph)[1], max_depth=10**6, max_nodes=max_nodes)

    edge_meta = {}
    for entry in callgraph or []:
        if not isinstance(entry, dict):
            continue
        caller = entry.get("method")
        for call in entry.get("calls", []) or []:
            if not isinstance(call, dict):
                continue
            callee = call.get("callee_fullName")
            if caller and callee:
                edge_meta[(caller, callee)] = call

    confidence_counts = {"high": 0, "low": 0}
    node_confidence = {}
    # result["edges"] comes from a BACKWARD traversal, so each pair here is
    # (callee, caller) — the reverse of edge_meta's (caller, callee) keys.
    for callee, caller in result["edges"]:
        meta = edge_meta.get((caller, callee)) or {}
        bucket = "high" if meta.get("order") is not None else "low"
        confidence_counts[bucket] += 1
        if node_confidence.get(caller) != "low":
            node_confidence[caller] = bucket

    return {
        "node": node,
        "impacted": result["nodes"],
        "edges": result["edges"],
        "levels": result["levels"],
        "node_confidence": node_confidence,
        "confidence": confidence_counts,
        "truncated": len(result["nodes"]) >= max_nodes,
    }


# ---------------------------------------------------------------------------
# Function span map — used to diff which functions a file's edit added,
# deleted, or touched (see scripts/deletion-report.py). Python only for now;
# get_function_spans returns None (not []) for unsupported languages so
# callers can tell "nothing to compare" apart from "this file has no
# functions," which matters because an empty list would otherwise look
# exactly like "every function in this file got deleted."
# ---------------------------------------------------------------------------

SUPPORTED_SPAN_EXTENSIONS = {".py", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"}

def _python_module_name_for(rel_path: str) -> str:
    """Mirrors module_name_for() in build_python_callgraph (main.py): turn a
    repo-relative .py path into the dotted module name used in callgraph
    node ids, so get_function_spans() symbols line up with real graph nodes."""
    rel = rel_path.replace("\\", "/")
    if rel.endswith(".py"):
        rel = rel[:-3]
    parts = rel.split("/")
    if parts and parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts) if parts else "__init__"


def _script_module_name_for(rel_path: str) -> str:
    rel = rel_path.replace("\\", "/")
    suffix = Path(rel).suffix
    if suffix:
        rel = rel[: -len(suffix)]
    return ".".join(part for part in rel.split("/") if part)


def _line_number_at(source: str, index: int) -> int:
    return source.count("\n", 0, index) + 1


def _brace_span_end_line(source: str, start_index: int, fallback_line: int) -> int:
    brace_index = source.find("{", start_index)
    if brace_index < 0:
        return fallback_line
    depth = 0
    in_string = ""
    escaped = False
    in_line_comment = False
    in_block_comment = False
    for index in range(brace_index, len(source)):
        ch = source[index]
        nxt = source[index + 1] if index + 1 < len(source) else ""
        if in_line_comment:
            if ch == "\n":
                in_line_comment = False
            continue
        if in_block_comment:
            if ch == "*" and nxt == "/":
                in_block_comment = False
            continue
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == in_string:
                in_string = ""
            continue
        if ch in {"'", '"', "`"}:
            in_string = ch
            continue
        if ch == "/" and nxt == "/":
            in_line_comment = True
            continue
        if ch == "/" and nxt == "*":
            in_block_comment = True
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth <= 0:
                return _line_number_at(source, index)
    return source.count("\n") + 1


def _javascript_function_spans(file_path: str, repo_root: str, source: str):
    rel_path = os.path.relpath(file_path, repo_root).replace("\\", "/") if repo_root else file_path.replace("\\", "/")
    module_name = _script_module_name_for(rel_path)
    patterns = [
        re.compile(r"\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(", re.MULTILINE),
        re.compile(r"\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)", re.MULTILINE),
    ]
    spans = []
    seen = set()
    for pattern in patterns:
        for match in pattern.finditer(source):
            name = match.group(1)
            symbol = ".".join(part for part in (module_name, name) if part)
            if symbol in seen:
                continue
            seen.add(symbol)
            start_line = _line_number_at(source, match.start())
            spans.append({
                "symbol": symbol,
                "start_line": start_line,
                "end_line": _brace_span_end_line(source, match.end(), start_line),
            })
    return sorted(spans, key=lambda item: (item["start_line"], item["symbol"]))


def get_function_spans(file_path: str, repo_root: str = "", source: Optional[str] = None):
    """Return [{"symbol", "start_line", "end_line"}] for every function/method
    defined in file_path, using the same dotted module.Class.func naming
    convention as build_python_callgraph()'s PythonCallVisitor in main.py.

    Pass `source` to parse in-memory content (e.g. from `git show
    <rev>:<path>`) instead of reading file_path off disk — that's how the
    deletion report gets the "before" side of a diff without needing any
    snapshot cache. Returns None when the file's language isn't supported
    yet (only .py today), and [] when it's a supported language with zero
    functions or a parse error — callers must not conflate the two."""
    file_path = str(file_path)
    ext = Path(file_path).suffix.lower()
    if ext not in SUPPORTED_SPAN_EXTENSIONS:
        return None

    if source is None:
        try:
            with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                source = f.read()
        except OSError:
            return []

    if ext in {".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"}:
        return _javascript_function_spans(file_path, repo_root, source)

    try:
        tree = ast.parse(source, filename=file_path)
    except SyntaxError:
        return []

    rel_path = os.path.relpath(file_path, repo_root).replace("\\", "/") if repo_root else file_path.replace("\\", "/")
    module_name = _python_module_name_for(rel_path)

    spans = []
    class_stack = []
    function_stack = []

    def visit(node):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.ClassDef):
                class_stack.append(child.name)
                visit(child)
                class_stack.pop()
            elif isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef)):
                parts = [module_name] + class_stack + function_stack + [child.name]
                symbol = ".".join(part for part in parts if part)
                spans.append({
                    "symbol": symbol,
                    "start_line": child.lineno,
                    "end_line": getattr(child, "end_lineno", None) or child.lineno,
                })
                function_stack.append(child.name)
                visit(child)
                function_stack.pop()
            else:
                visit(child)

    visit(tree)
    return spans
    return str(manifest_path)
