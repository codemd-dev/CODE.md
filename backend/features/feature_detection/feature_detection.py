# =============================================================================
# CodeVal.AI — UI-First Feature Detection Update
# Drop these into main.py, replacing the existing versions of these functions.
#
# Flow:
#   1. extract_ui_feature_seeds()        — pulls real feature names from UI/HTML
#   2. build_scim_artifacts()            — drives the pipeline, now UI-seed-first
#   3. generate_feature_descriptions()   — LLM anchors to UI names, not fn names
# =============================================================================

import re
import json
import logging
import os
import math
from pathlib import Path
from typing import Optional


#from main import (
#    find_cached_source_dir,
#    artifact_root_for_output,
#    build_repo_context,
#    load_repo_text_artifact,
#    write_dataset,
#    feature_catalog_payload,
#    generate_feature_descriptions as _generate_feature_descriptions_scim,
#    index_typed_scim_evidence,
#    write_scim_layer_manifest,
#    PROJECT_ROOT,
#)

from features.core.constants import PROJECT_ROOT

from features.core.helpers import (
    architecture_dir_for_output,
    artifact_root_for_output,
    build_repo_context,
    find_cached_source_dir,
    index_typed_scim_evidence,
    write_scim_layer_manifest,
)

logger = logging.getLogger(__name__)

MAX_VISIBLE_FEATURE_CANDIDATES = int(os.getenv("FEATURE_CANDIDATE_LIMIT", "25") or "25")
FEATURE_REPO_TEXT_UI_LIMIT = int(os.getenv("FEATURE_REPO_TEXT_UI_LIMIT", "120") or "120")
FEATURE_REPO_TEXT_README_LIMIT = int(os.getenv("FEATURE_REPO_TEXT_README_LIMIT", "6") or "6")
FEATURE_REPO_TEXT_DOC_LIMIT = int(os.getenv("FEATURE_REPO_TEXT_DOC_LIMIT", "12") or "12")
FEATURE_REPO_TEXT_ITEM_CHARS = int(os.getenv("FEATURE_REPO_TEXT_ITEM_CHARS", "1200") or "1200")


def compact_repo_text_for_feature_catalog(repo_text: dict) -> dict:
    if not isinstance(repo_text, dict):
        return {}

    def compact_items(key: str, limit: int) -> list[dict]:
        rows = []
        for item in (repo_text.get(key) or [])[:limit]:
            if not isinstance(item, dict):
                continue
            rows.append({
                "kind": item.get("kind", key),
                "file": item.get("file", ""),
                "line": item.get("line", 1),
                "text": str(item.get("text", ""))[:FEATURE_REPO_TEXT_ITEM_CHARS],
            })
        return rows

    return {
        "generated_at": repo_text.get("generated_at", ""),
        "source": repo_text.get("source", ""),
        "item_count": repo_text.get("item_count", 0),
        "readme_count": repo_text.get("readme_count", 0),
        "document_count": repo_text.get("document_count", 0),
        "text_file_count": repo_text.get("text_file_count", 0),
        "ui_text_count": repo_text.get("ui_text_count", 0),
        "total_chars_seen": repo_text.get("total_chars_seen", 0),
        "total_chars_indexed": repo_text.get("total_chars_indexed", 0),
        "skipped_large_files": repo_text.get("skipped_large_files", 0),
        "readme_items": compact_items("readme_items", FEATURE_REPO_TEXT_README_LIMIT),
        "document_items": compact_items("document_items", FEATURE_REPO_TEXT_DOC_LIMIT),
        "text_items": [],
        "ui_text_items": compact_items("ui_text_items", FEATURE_REPO_TEXT_UI_LIMIT),
    }


def _feature_confidence_weight(feature: dict) -> float:
    anchors = feature.get("anchors") if isinstance(feature.get("anchors"), dict) else {}
    ui_anchor_count = sum(
        len(rows)
        for anchor_type, rows in anchors.items()
        if anchor_type in {"html_ui", "android_ui_xml", "frontend_ui_component", "ui_logic", "api_route"}
        and isinstance(rows, list)
    )
    ui_evidence_count = len(feature.get("ui_evidence") or [])
    evidence_count = len(feature.get("evidence") or [])
    comment_count = len(feature.get("comment_evidence") or [])
    subfeature_count = len(feature.get("subfeatures") or [])
    match_count = int(feature.get("match_count") or 0)
    static_counts = feature.get("static_counts") if isinstance(feature.get("static_counts"), dict) else {}
    function_count = int(static_counts.get("functions") or match_count or 0)
    isolated = int(static_counts.get("isolated_in_extracted_graph") or 0)
    connected_ratio = 0.0 if function_count <= 0 else max(0.0, 1.0 - (isolated / max(1, function_count)))

    score = 0.0
    if feature.get("source") == "ui_feature_seed":
        score += 0.55
    if ui_anchor_count or ui_evidence_count:
        score += 0.22
    if evidence_count:
        score += min(0.18, evidence_count * 0.04)
    if comment_count:
        score += min(0.08, comment_count * 0.03)
    if subfeature_count:
        score += min(0.08, subfeature_count * 0.02)
    if match_count:
        score += min(0.18, math.log1p(match_count) / 16)
    if connected_ratio:
        score += min(0.14, connected_ratio * 0.14)
    if feature.get("reachability") in {"entrypoint", "reachable", "ui_reachable"}:
        score += 0.10
    if feature.get("incomplete_signals"):
        score -= 0.08
    return round(max(0.05, min(score, 0.98)), 3)


def _feature_priority(confidence: float) -> tuple[int, str]:
    if confidence >= 0.80:
        return 0, "high"
    if confidence >= 0.55:
        return 1, "medium"
    if confidence >= 0.35:
        return 2, "low"
    return 3, "candidate"


def rank_feature_candidates(features: list[dict], limit: int | None = MAX_VISIBLE_FEATURE_CANDIDATES) -> list[dict]:
    ranked = []
    for index, feature in enumerate(features or []):
        if not isinstance(feature, dict):
            continue
        row = dict(feature)
        confidence = float(row.get("confidence_weight") or row.get("confidence") or _feature_confidence_weight(row))
        priority, label = _feature_priority(confidence)
        row["confidence_weight"] = round(confidence, 3)
        row["confidence"] = label
        row["priority"] = priority
        row["candidate_status"] = label
        row["_rank_index"] = index
        ranked.append(row)
    ranked.sort(key=lambda row: (
        int(row.get("priority", 3)),
        -float(row.get("confidence_weight") or 0),
        -int(row.get("match_count") or 0),
        str(row.get("feature") or row.get("name") or "").lower(),
        int(row.get("_rank_index") or 0),
    ))
    if limit is not None and limit > 0:
        ranked = ranked[:limit]
    for row in ranked:
        row.pop("_rank_index", None)
    return ranked


def compact_feature_catalog_payload(feature_data: dict, limit: int = MAX_VISIBLE_FEATURE_CANDIDATES) -> dict:
    if not isinstance(feature_data, dict):
        return {}
    compact = dict(feature_data)
    features = compact.get("features")
    if isinstance(features, list):
        compact_features = rank_feature_candidates(features, limit)
        for feature in compact_features:
            if not isinstance(feature, dict):
                continue
            feature["evidence"] = list(feature.get("evidence") or [])[:5]
            feature["ui_evidence"] = list(feature.get("ui_evidence") or [])[:5]
            feature["comment_evidence"] = list(feature.get("comment_evidence") or [])[:3]
            feature["incomplete_signals"] = list(feature.get("incomplete_signals") or [])[:5]
            feature["subfeatures"] = list(feature.get("subfeatures") or [])[:6]
            feature["feature_entrypoints"] = list(feature.get("feature_entrypoints") or [])[:5]
            boundary = feature.get("implementation_boundary")
            if isinstance(boundary, dict):
                feature["implementation_boundary"] = {
                    **boundary,
                    "entrypoints": list(boundary.get("entrypoints") or [])[:5],
                    "nodes": list(boundary.get("nodes") or [])[:12],
                }
            feature["callgraph_clusters"] = list(feature.get("callgraph_clusters") or [])[:5]
            anchors = feature.get("anchors")
            if isinstance(anchors, dict):
                feature["anchors"] = {
                    key: list(value or [])[:5]
                    for key, value in anchors.items()
                }
        compact["features_total_before_ranking"] = len(features)
        compact["feature_candidate_limit"] = limit
        compact["features"] = compact_features
    compact["readme_evidence"] = list(compact.get("readme_evidence") or [])[:5]
    compact["document_evidence"] = list(compact.get("document_evidence") or [])[:5]
    compact["ui_feature_seeds"] = list(compact.get("ui_feature_seeds") or [])[:limit]
    return compact

# ---------------------------------------------------------------------------
# STEP 1 — Extract real feature names from UI/HTML text
# ---------------------------------------------------------------------------

def _legacy_extract_ui_feature_seeds(repo_text: dict, repo_context: dict) -> list[str]:
    """
    Extract candidate feature names from the UI text already pulled from the
    analyzed repo's HTML / dashboard / docs.

    Priority order:
      1. ui_text_items  — nav labels, headings, button text from HTML files
      2. readme_items   — markdown headings (## Feature Name)
      3. document_items — first lines of doc/spec files

    Returns up to 40 de-duplicated candidate feature names, short enough to be
    real nav/heading labels (3-60 chars), with junk lines filtered out.
    """
    seeds: list[str] = []
    seen: set[str] = set()

    # --- Patterns that disqualify a line as a feature name ---
    JUNK_RE = re.compile(
        r"""
        ^(https?://|www\.)           # bare URLs
        | <[^>]+>                    # HTML tags
        | ^\s*[{}\[\]();,]           # code punctuation lines
        | ^\d+(\.\d+)*\s*$          # version numbers only
        | ^(the|a|an|and|or|but|of|in|to|for|with|from|by|on|at|is|are|was|were|it|this|that)\s*$
        """,
        re.VERBOSE | re.IGNORECASE,
    )

    def _add(line: str):
        line = line.strip().strip("*_`#").strip()
        if len(line) < 3 or len(line) > 60:
            return
        if JUNK_RE.search(line):
            return
        key = line.lower()
        if key not in seen:
            seen.add(key)
            seeds.append(line)

    # 1. UI text items — highest priority: these ARE the feature names
    #    Typical shape: [{"text": "Graph Overview\nSearch Model\n..."}, ...]
    for item in (repo_text.get("ui_text_items") or [])[:60]:
        raw = str(item.get("text") or "").strip()
        for line in raw.splitlines():
            _add(line)
        if len(seeds) >= 40:
            break

    # 2. README headings (## Feature Name)
    for item in (repo_text.get("readme_items") or [])[:8]:
        raw = str(item.get("text") or "")
        for line in raw.splitlines():
            line = line.strip()
            if line.startswith("#"):
                _add(line.lstrip("#").strip())

    # 3. Document / spec items — first few lines of each
    for item in (repo_text.get("document_items") or [])[:20]:
        raw = str(item.get("text") or "")
        for line in raw.splitlines()[:8]:
            _add(line.strip())

    # 4. Fallback: repo_context product_features list if populated upstream
    for feat in (repo_context.get("product_features") or []):
        _add(str(feat))

    logger.info("extract_ui_feature_seeds: %d seeds extracted", len(seeds[:40]))
    for s in seeds[:40]:
        logger.debug("  seed: %r", s)

    return seeds[:40]


def extract_ui_feature_seeds(repo_text: dict, repo_context: dict) -> list[str]:
    """
    Extract product feature names from user-facing HTML/UI text only.

    README/docs/comments are supporting evidence, not feature-name sources.
    They are only allowed through an explicit product_features fallback when
    no UI labels exist.
    """
    seeds: list[str] = []
    seen: set[str] = set()
    junk_re = re.compile(
        r"""
        ^(https?://|www\.)
        | <[^>]+>
        | ^\s*[{}\[\]();,]
        | ^\d+(\.\d+)*\s*$
        | ^(the|a|an|and|or|but|of|in|to|for|with|from|by|on|at|is|are|was|were|it|this|that)\s*$
        """,
        re.VERBOSE | re.IGNORECASE,
    )
    code_or_doc_note_re = re.compile(
        r"^\s*(from\s+\S+\s+import|import\s+\S+|todo\s*[-:]|fixme\b|added\s+new\s+import|"
        r"pythonanalyzer\b|pathlib\b|pip\s+install|def\s+|class\s+)",
        re.IGNORECASE,
    )
    evidence_or_code_label_re = re.compile(
        r"^\s*(role|symbol|code|text|file|kind|matched\s+terms|match\s+source|callers?|callees?|"
        r"called\s+by|instructions?|schema|body|response|request|results?\[\]|orderedexecution|"
        r"source\s+text\s+matches|relevant\s+code\s+snippets|callgraph\s*/\s*structural\s+context)\s*:?\s*",
        re.IGNORECASE,
    )
    code_shape_re = re.compile(
        r"(\b(assert|return|await|fetch|console\.|json\.|jsonstringify|requests\.|resp\.|curl\b|"
        r"for\s*\(|if\s*\(|while\s*\(|void\s+\w+\s*\(|new\s+\w+|class\s+\w+|def\s+\w+)\b)"
        r"|[{};=<>\\]"
        r"|\b(GET|POST|PUT|PATCH|DELETE)\s+/"
        r"|/\w+/\w+"
        r"|\w+\.\w+\s*\(",
        re.IGNORECASE,
    )
    identifier_shape_re = re.compile(
        r"^([a-z]+[A-Z][A-Za-z0-9]*|[A-Za-z_][A-Za-z0-9_]*\[\]|[a-z_]+_[a-z0-9_]+|"
        r"[a-z0-9]+(?:-[a-z0-9]+){1,}|[A-Za-z0-9_]+\.[A-Za-z0-9_.]+)$"
    )
    prompt_shape_re = re.compile(
        r"\b(user\s+question|base your answer|strictly on the provided code|hit send|awaiting|"
        r"content-type|application/json|required|string|null|number|boolean|score\s+\d|line\s+\d)\b",
        re.IGNORECASE,
    )
    search_prompt_re = re.compile(
        r"^\s*(find|show|trace|where|who|what|which|detect)\b.*\b(function|caller|callee|callers|callees|"
        r"dependency|dependencies|module|modules|api|request|execution|code|dead|unused|unreachable|"
        r"database|filesystem|authentication|component|components)\b|\?\s*$",
        re.IGNORECASE,
    )
    instructional_sentence_re = re.compile(
        r"^\s*(open|choose|describe|use|press|load|analyze|connect|reconnect|register|fetch|send|helper|"
        r"generated|available|no\s+|sample|run|hit|copy|paste|upload|download|from\s+|extracted\s+from)\b"
        r"|.*(\.|…|:)$|"
        r"\b(will|should|must|can|cannot|before|after|below|above|ready|loaded|returned|available)\b",
        re.IGNORECASE,
    )

    def _add(line: str):
        line = re.sub(r"\s+", " ", str(line or "")).strip().strip("*_`#").strip()
        if len(line) < 3 or len(line) > 80:
            return
        if junk_re.search(line) or code_or_doc_note_re.search(line):
            return
        if evidence_or_code_label_re.search(line) or code_shape_re.search(line) or prompt_shape_re.search(line):
            return
        if search_prompt_re.search(line):
            return
        if instructional_sentence_re.search(line):
            return
        if line.startswith(("//", "/*", "* ", "- ")):
            return
        if re.search(r"\d", line) and re.search(r"\b(score|items?|files?|days?|levels?|vertices|edges?|risks?|confidence|percent|%|\+)\b", line, re.IGNORECASE):
            return
        word_count = len(re.findall(r"[A-Za-z]+", line))
        if word_count > 5 and re.search(r"\bto\b", line, re.IGNORECASE):
            return
        if word_count > 7:
            return
        if identifier_shape_re.match(line):
            return
        if re.search(r"\b(src|lib|test|main)/[\w./-]+|[\w./-]+\.(java|py|js|ts|tsx|jsx|html|json|xml|md):\d+\b", line, re.IGNORECASE):
            return
        if re.search(r"\{[^}]*\}|\[[^\]]*\]|\([^\)]{0,40}\)", line) and not re.search(r"\b(before|after)\b", line, re.IGNORECASE):
            return
        key = line.lower()
        if key not in seen:
            seen.add(key)
            seeds.append(line)

    for item in (repo_text.get("ui_text_items") or []):
        if item.get("kind") and item.get("kind") != "ui_text":
            continue
        for line in str(item.get("text") or "").splitlines():
            _add(line)

    if not seeds:
        for feat in (repo_context.get("product_features") or []):
            _add(str(feat))

    logger.info("extract_ui_feature_seeds: %d seeds extracted", len(seeds))
    for seed in seeds[:100]:
        logger.debug("  seed: %r", seed)

    return seeds


# ---------------------------------------------------------------------------
# STEP 2 — build_scim_artifacts: drive the full pipeline, UI-seed-first
# ---------------------------------------------------------------------------

def build_scim_artifacts(
    output_repo_dir: str,
    owner: str,
    repo: str,
    repo_info: dict,
    default_branch: str,
    repo_text: dict,
    source_dir: Optional[str] = None,
    ui_feature_seeds=None,
    progress_callback=None,
    build_feature_catalog: bool = True,
) -> dict:
    """
    Build the SCIM search index and (optionally) the feature catalog for an analyzed repo.

    Key changes vs old version:
      - Safety guard: refuses to index PROJECT_ROOT or any parent of it.
      - Extracts UI feature seeds BEFORE calling feature_catalog_payload.
      - Passes seeds via repo_context so the catalog uses UI names as anchors.

    build_feature_catalog=False skips UI-seed extraction and the feature
    catalog/evidence/manifest steps entirely, building only the SCIM vector
    search index (vectors.sqlite). Callers that don't want feature-detection
    output (e.g. the local plugin analysis path) pass this to get search
    without the heuristic, often-approximate feature catalog.
    """
    output_repo_dir = Path(output_repo_dir)
    output_dir = output_repo_dir / "scim"

    def progress(message, current_file=""):
        if not callable(progress_callback):
            return
        try:
            progress_callback(message, current_file=current_file or "")
        except TypeError:
            progress_callback(message)

    # ------------------------------------------------------------------
    # 1. Resolve source root — where the repo's source code was cached
    # ------------------------------------------------------------------
    source_root = Path(source_dir) if source_dir else None

    if source_root is None:
        cached = find_cached_source_dir(output_repo_dir)   # existing helper
        source_root = Path(cached) if cached else None

    if source_root is None:
        # Last resort: look inside artifact root for a src/ directory
        art_root = artifact_root_for_output(output_repo_dir)  # existing helper
        candidate = Path(art_root) / "src"
        if candidate.is_dir():
            source_root = candidate

    if source_root is None or not source_root.exists() or not source_root.is_dir():
        logger.warning(
            "build_scim_artifacts: no valid source root for %s/%s — skipping",
            owner, repo,
        )
        return {"scim_error": "No valid source directory found."}

    # ------------------------------------------------------------------
    # 2. Safety guard — never index the server's own files
    # ------------------------------------------------------------------
    resolved_source = source_root.resolve()
    resolved_project = PROJECT_ROOT.resolve()  # existing global constant

    if str(resolved_source).startswith(str(resolved_project)):
        logger.error(
            "build_scim_artifacts: source_root %s resolves inside PROJECT_ROOT %s "
            "— aborting to prevent self-indexing. owner=%s repo=%s",
            resolved_source, resolved_project, owner, repo,
        )
        return {"scim_error": "Source root safety check failed — would index server files."}

    logger.info(
        "build_scim_artifacts: source_root=%s owner=%s repo=%s",
        source_root, owner, repo,
    )

    # ------------------------------------------------------------------
    # 3. Build compact repo_context, then extract UI seeds (feature catalog only)
    # ------------------------------------------------------------------
    repo_context = {}
    if build_feature_catalog:
        feature_repo_text = compact_repo_text_for_feature_catalog(repo_text)
        repo_context = build_repo_context(      # existing helper
            owner, repo, repo_info, default_branch, feature_repo_text
        )

        # Pull real feature names from the analyzed repo's UI/HTML. If the caller
        # already extracted them, reuse that list so this stage does not repeat work.
        ui_feature_seeds = list(ui_feature_seeds or [])
        if not ui_feature_seeds:
            progress("Extracting UI feature labels.", current_file="")
            ui_feature_seeds = extract_ui_feature_seeds(feature_repo_text, repo_context)

        # Inject seeds into repo_context so feature_catalog_payload can use them
        repo_context["ui_feature_seeds"] = ui_feature_seeds

        logger.info(
            "build_scim_artifacts: %d UI feature seeds for %s/%s: %s",
            len(ui_feature_seeds), owner, repo,
            ui_feature_seeds[:10],
        )

    # ------------------------------------------------------------------
    # 4. Index source files into SCIM vector store
    # ------------------------------------------------------------------
    try:
        from scim import feature_catalog_payload, write_dataset
    except Exception as e:
        logger.warning("SCIM import failed; skipping embedding artifacts: %s", e)
        return {"scim_error": str(e)}
    
    try:
        progress("Building search index and embeddings from source files.", current_file="")
        write_dataset(                  # existing SCIM function
            input_root=source_root,
            output_dir=output_dir,
            include_code=True,
            backend="tfidf",
            make_vector_db=True,
            make_faiss=False,
            sbert_model=None,
            batch_size=32,
            generic_graphs=True,
            max_chunks_per_repo=int(os.getenv("SCIM_MAX_CHUNKS_PER_REPO", "3000")),
            max_file_bytes=int(os.getenv("SCIM_MAX_FILE_BYTES", "5000000")),
            max_record_code_chars=int(os.getenv("SCIM_MAX_RECORD_CODE_CHARS", "1500")),
            progress_callback=progress,
        )
    except Exception as exc:
        logger.exception("build_scim_artifacts: write_dataset failed: %s", exc)
        return {"scim_error": f"write_dataset failed: {exc}"}

    # ------------------------------------------------------------------
    # 5. Build feature catalog — now seeded from UI, not fn-name heuristics
    # ------------------------------------------------------------------
    feature_data: dict = {}
    if build_feature_catalog:
        try:
            progress("Building feature catalog from repo evidence.", current_file="")
            feature_data = feature_catalog_payload(     # existing SCIM function
                output_dir,
                None,
                examples=int(os.getenv("FEATURE_CATALOG_EXAMPLES", "3") or "3"),
                repo_context=repo_context,              # carries ui_feature_seeds
            )
        except Exception as exc:
            logger.exception("build_scim_artifacts: feature_catalog_payload failed: %s", exc)
            feature_data = {}

        feature_data = compact_feature_catalog_payload(feature_data, MAX_VISIBLE_FEATURE_CANDIDATES)

        try:
            architecture_dir = architecture_dir_for_output(output_repo_dir)
            (architecture_dir / "feature_catalog.json").write_text(
                json.dumps(feature_data, indent=2),
                encoding="utf-8",
            )
        except Exception as exc:
            logger.warning("build_scim_artifacts: unable to write feature_catalog.json: %s", exc)

        # --------------------------------------------------------------
        # 6. Do not generate LLM feature descriptions during analysis.
        # --------------------------------------------------------------
        # Generated Feature Summaries are paid/user-triggered output. They are
        # created only by the /feature-summary endpoint after the user presses the
        # dashboard button, not during the base analysis run.
        if isinstance(feature_data, dict):
            feature_data.pop("feature_summaries", None)

    # ------------------------------------------------------------------
    # 7. Write architecture evidence files, but do not add them to vectors.sqlite.
    # ------------------------------------------------------------------
    evidence_result = {}
    try:
        progress("Writing generated evidence as architecture artifacts.", current_file="")
        evidence_result = index_typed_scim_evidence(output_repo_dir)   # existing helper
    except Exception as exc:
        logger.warning("build_scim_artifacts: index_typed_scim_evidence failed: %s", exc)

    try:
        progress("Writing analysis manifest.", current_file="")
        write_scim_layer_manifest(                   # existing helper
            output_repo_dir=output_repo_dir,
            evidence_result=evidence_result,
        )
    except Exception as exc:
        logger.warning("build_scim_artifacts: write_scim_layer_manifest failed: %s", exc)

    return {
        "scim_dir": str(output_dir),
        "scim_vector_db_path": str(output_dir / "vectors.sqlite"),
        "scim_embedding_model_path": str(output_dir / "embedding_model.json"),
        "scim_train_pairs_path": str(architecture_dir_for_output(output_repo_dir) / "train_pairs.jsonl"),
        "feature_catalog_path": str(architecture_dir_for_output(output_repo_dir) / "feature_catalog.json"),
        "feature_catalog": feature_data,
        "feature_count": len(feature_data.get("features") or []) if isinstance(feature_data, dict) else 0,
        "typed_evidence_indexed": evidence_result.get("indexed", 0) if isinstance(evidence_result, dict) else 0,
    }


# ---------------------------------------------------------------------------
# STEP 3 — generate_feature_descriptions: LLM uses UI names as anchors
# ---------------------------------------------------------------------------

def _generate_feature_descriptions_legacy(
    features: list[dict],
    product_name: str,
    product_type: str,
    user_guidance: str = "",
    ui_feature_seeds: Optional[list[str]] = None,
    return_prompt: bool = False,
) -> list[dict] | tuple[list[dict], str]:
    """
    Call the LLM to generate user-facing descriptions for each feature.

    Key change: when ui_feature_seeds are supplied the LLM is told those names
    ARE the feature taxonomy — it explains each feature using callgraph evidence
    rather than discovering/renaming features from function name patterns.

    Each feature dict is expected to have at least:
      {
        "name": str,           # detected feature name (may be fn-name based)
        "summary": str,        # brief auto-summary
        "functions": [...],    # matching callgraph functions
        "evidence": str,       # comment/doc evidence text
      }

    Returns the same list with a "description" key added to each item.
    """
    if not features:
        return ([], "") if return_prompt else []

    compact_features = [
        compact_feature_for_llm(feature, f"feature_{index + 1}")
        for index, feature in enumerate(features)
    ]

    ui_guidance_block = ""
    if ui_feature_seeds:
        ui_names_str = "\n".join(f"  - {s}" for s in ui_feature_seeds)
        ui_guidance_block = f"""
## Known Features (from the product's UI, dashboard, and README)

The following feature names were extracted directly from the analyzed product's
user-facing HTML, navigation menus, and documentation. These are the GROUND TRUTH
feature names. Use them as the primary taxonomy when writing descriptions.

{ui_names_str}

When a detected feature clearly corresponds to one of the known UI features above,
use the UI feature name in your output — not the internal function name.
Do NOT invent new feature names, and do NOT rename features from internal
function names, import statements, TODO comments, file paths, or docs.
"""

    # Build per-feature evidence blocks
    feature_blocks = []
    for i, feat in enumerate(compact_features):
        fn_list = feat.get("evidence") or []
        fn_summary = "\n    ".join(
            f"{f.get('path','')}:{f.get('start_line','')} {f.get('symbol','')}"
            for f in fn_list[:8]
        )
        block = f"""
### Feature {i+1}: {feat.get('feature', '(unnamed)')}
Feature ID: {feat.get('feature_id', f'feature_{i + 1}')}
Status: {feat.get('status', '')}
Visibility: {feat.get('visibility', '')}
Subfeatures: {', '.join(item.get('name', '') for item in (feat.get('subfeatures') or [])[:6])}
Callgraph functions:
    {fn_summary or '(none)'}
Comments/UI evidence:
    {json.dumps({"comments": feat.get("comment_evidence", [])[:3], "ui": feat.get("ui_evidence", [])[:4]}, ensure_ascii=False)[:800]}
"""
        feature_blocks.append(block)

    feature_str = "\n".join(feature_blocks)

    prompt = f"""You are a technical writer producing user-facing feature documentation for
a software product called "{product_name}" (type: {product_type}).

{ui_guidance_block}

## Task

Below you will find features detected by static analysis of the codebase, along
with callgraph evidence (which functions implement each feature) and any comment
or documentation text found near those functions.

For EACH feature, write:
  1. A concise user-facing name (prefer the UI name from the known list above if applicable)
  2. A 1–2 sentence plain-English description of what the feature does for the user
  3. A brief implementation note: which key functions/files implement it
     (use real file paths and function names from the callgraph evidence)

{f'Additional guidance: {user_guidance}' if user_guidance else ''}

## Detected Features + Callgraph Evidence

{feature_str}

## Output Format

Respond ONLY with a JSON array. Each element must have exactly these keys:
  "name"        — user-facing feature name (string)
  "description" — 1–2 sentence user-facing description (string)
  "impl_note"   — key implementing functions/files (string, ≤120 chars)

Example:
[
  {{
    "name": "Graph Overview",
    "description": "Renders an interactive call graph for the analyzed repository, showing how functions call each other across the codebase.",
    "impl_note": "build_call_graph() in graph.py; rendered via cytoscape_template.html"
  }}
]

    Do not include markdown fences, preamble, or any text outside the JSON array.
"""

    if not os.getenv("OPENAI_API_KEY"):
        descriptions = [
            {
                "feature_id": feature.get("feature_id", f"feature_{index + 1}"),
                "feature": feature.get("feature", ""),
                "description": "",
                "status": feature.get("status", "implemented"),
                "visibility": feature.get("visibility", ""),
                "references": feature_evidence_references(features[index] if index < len(features) else {}),
            }
            for index, feature in enumerate(compact_features)
        ]
        return (descriptions, prompt) if return_prompt else descriptions

    # --- Call OpenAI (or your LLM wrapper) ---
    try:
        import openai  # already imported in main.py

        response = openai.chat.completions.create(
            model=os.getenv("OPENAI_SUMMARY_MODEL", "gpt-4o-mini"),
            messages=[{"role": "user", "content": prompt}],
            temperature=0.2,
            max_tokens=2000,
        )
        raw = response.choices[0].message.content or ""
        raw = raw.strip()

        # Strip markdown fences if present
        if raw.startswith("```"):
            raw = re.sub(r"^```[a-z]*\n?", "", raw)
            raw = re.sub(r"\n?```$", "", raw)

        parsed = json.loads(raw)
        described = parsed.get("features", []) if isinstance(parsed, dict) else parsed
        described = described if isinstance(described, list) else []

        descriptions = merge_described_features(compact_features, described)

    except Exception as exc:
        logger.exception("generate_feature_descriptions: LLM call failed: %s", exc)
        # Graceful fallback — keep existing name/summary, mark description missing
        descriptions = [
            {
                "feature_id": feature.get("feature_id", f"feature_{index + 1}"),
                "feature": feature.get("feature", ""),
                "description": "",
                "status": feature.get("status", "implemented"),
                "visibility": feature.get("visibility", ""),
                "references": feature_evidence_references(features[index] if index < len(features) else {}),
            }
            for index, feature in enumerate(compact_features)
        ]

    return (descriptions, prompt) if return_prompt else descriptions


def generate_feature_descriptions(
    features: list[dict],
    product_name: str,
    product_type: str,
    user_guidance: str = "",
    ui_feature_seeds: Optional[list[str]] = None,
    return_prompt: bool = False,
) -> list[dict] | tuple[list[dict], str]:
    """
    Generate user-facing descriptions in small paid LLM batches.

    The full extracted feature list can be large. This function intentionally
    sends only feature names plus tiny implementation hints to avoid TPM errors.
    """
    if not features:
        return ([], "") if return_prompt else []

    compact_features = [
        compact_feature_for_llm(feature, f"feature_{index + 1}")
        for index, feature in enumerate(features)
    ]

    if not os.getenv("OPENAI_API_KEY"):
        descriptions = feature_description_fallbacks(compact_features, features)
        return (descriptions, "") if return_prompt else descriptions

    batch_size = max(1, min(5, int(os.getenv("FEATURE_SUMMARY_BATCH_SIZE", "5") or "5")))
    descriptions = []
    prompt_preview = ""

    for start in range(0, len(compact_features), batch_size):
        batch = compact_features[start:start + batch_size]
        prompt = build_feature_description_prompt(batch, product_name, product_type, user_guidance, start)
        if not prompt_preview:
            prompt_preview = prompt
        try:
            import openai  # already imported in main.py

            response = openai.chat.completions.create(
                model=os.getenv("OPENAI_SUMMARY_MODEL", "gpt-4o-mini"),
                messages=[{"role": "user", "content": prompt}],
                temperature=0.2,
                max_tokens=max(800, min(4000, 160 * len(batch))),
            )
            raw = (response.choices[0].message.content or "").strip()
            if raw.startswith("```"):
                raw = re.sub(r"^```[a-z]*\n?", "", raw)
                raw = re.sub(r"\n?```$", "", raw)
            parsed = json.loads(raw)
            described = parsed.get("features", []) if isinstance(parsed, dict) else parsed
            described = described if isinstance(described, list) else []
            descriptions.extend(merge_described_features(batch, described))
        except Exception as exc:
            logger.exception("generate_feature_descriptions: LLM batch failed at feature %s: %s", start + 1, exc)
            descriptions.extend(feature_description_fallbacks(batch, features[start:start + len(batch)], start))

    return (descriptions, prompt_preview) if return_prompt else descriptions


def build_feature_description_prompt(
    compact_features: list[dict],
    product_name: str,
    product_type: str,
    user_guidance: str = "",
    start_index: int = 0,
) -> str:
    feature_rows = []
    for offset, feat in enumerate(compact_features):
        refs = "; ".join(
            f"{ref.get('path','')}:{ref.get('start_line','')} {ref.get('symbol','')}"
            for ref in (feat.get("evidence") or [])[:2]
        )
        feature_rows.append({
            "index": start_index + offset + 1,
            "feature_id": feat.get("feature_id", f"feature_{start_index + offset + 1}"),
            "name": feat.get("feature", ""),
            "status": feat.get("status", ""),
            "visibility": feat.get("visibility", ""),
            "match_count": feat.get("match_count", 0),
            "user_description": feat.get("user_description", ""),
            "current_code_description": (feat.get("evidence_context") or {}).get("current_code_description", ""),
            "discovered_functions": (feat.get("evidence_context") or {}).get("discovered_functions", [])[:12],
            "compact_implementation_evidence": (feat.get("evidence_context") or {}).get("compact_implementation_evidence", ""),
            "scim_result_count": (feat.get("evidence_context") or {}).get("scim_result_count", ""),
            "scim_search_query": (feat.get("evidence_context") or {}).get("scim_search_query", ""),
            "feature_entrypoints": feat.get("feature_entrypoints", [])[:5],
            "implementation_boundary": feat.get("implementation_boundary", {}),
            "callgraph_clusters": feat.get("callgraph_clusters", [])[:5],
            "implementation_hints": refs[:320],
            "ui_evidence": (feat.get("ui_evidence") or [])[:3],
            "comment_evidence": (feat.get("comment_evidence") or [])[:2],
            "subfeatures": [
                {
                    "name": item.get("name", ""),
                    "match_count": item.get("match_count", 0),
                }
                for item in (feat.get("subfeatures") or [])[:4]
            ],
        })

    return f"""You are writing saved, user-facing current implementation descriptions for "{product_name}" (type: {product_type}).

Use the feature names exactly as provided. They came from UI/navigation/section labels.
Your job is to explain in plain English what is already implemented in the current codebase.
Use only the provided code, UI, text, SCIM, comment, and callgraph evidence. Do not use customer expectations or user-written descriptions.
Use user_description only to understand what the user cares about; never treat it as proof that code exists.
When current_code_description, discovered_functions, or compact_implementation_evidence are present, treat them as the strongest evidence and mention the concrete implemented behavior they show.
Do not invent missing capabilities, future work, benefits, integrations, or features that are not supported by the evidence.
Do not say a feature has "no visible functionality", "no match results", or is "not implemented" just because only UI evidence is provided.
UI labels prove the feature is exposed in the interface; code/callgraph evidence proves backend behavior. If backend evidence is missing, say only that the provided evidence is UI-only.
Do not rename features from internal functions.
If the evidence is thin, say what is visible from the code/UI evidence and avoid over-claiming.
Write one concise current-state description per feature. Prefer concrete implemented behavior over marketing language.
{f'Additional guidance: {user_guidance}' if user_guidance else ''}

Features:
{json.dumps(feature_rows, ensure_ascii=False, separators=(",", ":"))}

Return ONLY a JSON array with one object per input feature, in the same order:
[{{"name":"same feature name","description":"1-2 sentences describing what is implemented now","impl_note":"optional short evidence note"}}]
"""


def feature_description_fallbacks(compact_features: list[dict], original_features: list[dict], start_index: int = 0) -> list[dict]:
    return [
        {
            "feature_id": feature.get("feature_id", f"feature_{start_index + index + 1}"),
            "feature": feature.get("feature", ""),
            "description": "",
            "status": feature.get("status", "implemented"),
            "visibility": feature.get("visibility", ""),
            "references": feature_evidence_references(original_features[index] if index < len(original_features) else feature),
        }
        for index, feature in enumerate(compact_features)
    ]


def compact_feature_for_llm(feature: dict, feature_id: str = "") -> dict:
    evidence = []
    for item in (feature.get("evidence") or [])[:5]:
        evidence.append({
            "symbol": item.get("symbol", ""),
            "path": item.get("path", ""),
            "start_line": item.get("start_line", ""),
            "matched_terms": (item.get("matched_terms") or [])[:6],
        })
    return {
        "feature_id": feature_id,
        "feature": feature.get("feature") or feature.get("name") or "",
        "status": feature.get("status", "implemented"),
        "visibility": feature.get("visibility", ""),
        "match_count": feature.get("match_count", 0),
        "user_description": feature.get("user_description", ""),
        "evidence_context": feature.get("evidence_context") or {},
        "feature_entrypoints": feature.get("feature_entrypoints", [])[:5],
        "implementation_boundary": feature.get("implementation_boundary", {}),
        "callgraph_clusters": feature.get("callgraph_clusters", [])[:5],
        "subfeatures": (feature.get("subfeatures") or [])[:8],
        "evidence": evidence,
        "comment_evidence": (feature.get("comment_evidence") or [])[:3],
        "ui_evidence": (feature.get("ui_evidence") or [])[:4],
    }


def short_feature_symbol(symbol: str) -> str:
    parts = [part for part in str(symbol or "").split(".") if part]
    if len(parts) >= 2:
        return ".".join(parts[-2:])
    return str(symbol or "")


def feature_evidence_references(feature: dict, limit: int = 3) -> list[dict]:
    references = []
    for item in (feature.get("evidence") or [])[:limit]:
        symbol = item.get("symbol", "")
        path = item.get("path", "")
        references.append({
            "symbol": symbol,
            "short_symbol": short_feature_symbol(symbol),
            "path": path,
            "file": Path(str(path)).name,
            "start_line": item.get("start_line", ""),
        })
    return references


def merge_described_features(compact_features: list[dict], described: list[dict]) -> list[dict]:
    descriptions = []
    for index, feature in enumerate(compact_features):
        row = described[index] if index < len(described) and isinstance(described[index], dict) else {}
        descriptions.append({
            "feature_id": row.get("feature_id") or feature.get("feature_id", f"feature_{index + 1}"),
            "feature": feature.get("feature", ""),
            "description": " ".join(str(row.get("description", "")).split()),
            "impl_note": row.get("impl_note", ""),
            "status": feature.get("status", "implemented"),
            "visibility": feature.get("visibility", ""),
            "current_code_description": feature.get("evidence_context", {}).get("current_code_description", ""),
            "discovered_functions": feature.get("evidence_context", {}).get("discovered_functions", [])[:12],
            "references": feature_evidence_references(feature),
        })
    return descriptions


# ---------------------------------------------------------------------------
# HOW THE THREE PIECES FIT TOGETHER (reference, not executable)
# ---------------------------------------------------------------------------
#
# build_scim_artifacts()
#   │
#   ├── find_cached_source_dir()          [existing — locates repo source dir]
#   ├── artifact_root_for_output()        [existing — resolves artifact root]
#   │
#   ├── [SAFETY GUARD]                    [NEW — refuses to index PROJECT_ROOT]
#   │
#   ├── build_repo_context()              [existing — builds context dict]
#   │
#   ├── extract_ui_feature_seeds()        [NEW — pulls real names from HTML/README]
#   │       │
#   │       ├── repo_text["ui_text_items"]    ← nav labels, headings, button text
#   │       ├── repo_text["readme_items"]     ← ## Markdown headings
#   │       └── repo_text["document_items"]   ← first lines of doc files
#   │
#   ├── write_dataset()                   [existing — indexes source into SCIM]
#   │
#   ├── feature_catalog_payload()         [existing — detects features from index]
#   │       repo_context["ui_feature_seeds"] → used as primary anchors
#   │
#   ├── generate_feature_descriptions()   [UPDATED — LLM uses UI names as GT]
#   │
#   ├── index_typed_scim_evidence()       [existing — callgraph + artifact evidence]
#   └── write_scim_layer_manifest()       [existing — writes manifest]
#
# ---------------------------------------------------------------------------
