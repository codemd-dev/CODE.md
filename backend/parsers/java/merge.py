import json
import logging
import os

from parsers.common import _load_edge_graph_with_meta, write_ordered_call_sequence

logger = logging.getLogger(__name__)


def build_merged_java_outputs(output_repo_dir, results):
    source_paths = [
        ("tree-sitter-java", results.get("tree_sitter_java_json_path", "")),
        ("javalang", results.get("callgraph_javalang_json_path", "")),
    ]
    merged_nodes = set()
    merged_edges = set()
    merged_edge_meta = {}
    merged_ordered_calls = []
    sources = []

    for source, path in source_paths:
        nodes, edges, edge_meta = _load_edge_graph_with_meta(path)
        if nodes or edges:
            sources.append(source)
            merged_nodes.update(nodes)
            merged_edges.update(edges)
            for edge, meta in edge_meta.items():
                previous = merged_edge_meta.get(edge)
                order = meta.get("order")
                if previous is None or (order is not None and order < (previous.get("order") or order)):
                    merged_edge_meta[edge] = meta

        ordered_path = ""
        if source == "tree-sitter-java":
            ordered_path = results.get("tree_sitter_java_ordered_call_sequence_path", "")
        elif source == "javalang":
            ordered_path = results.get("javalang_ordered_call_sequence_path", "")
        if ordered_path and os.path.exists(ordered_path):
            try:
                with open(ordered_path, "r", encoding="utf-8") as f:
                    ordered_data = json.load(f)
                for call in ordered_data.get("calls", []):
                    merged_ordered_calls.append({**call, "parser": source})
            except Exception as e:
                logger.warning("Unable to merge ordered Java sequence %s: %s", ordered_path, e)

    if not merged_nodes and not merged_edges:
        return results

    merged_path = os.path.join(output_repo_dir, "java_merged")
    os.makedirs(merged_path, exist_ok=True)
    merged_json_path = os.path.join(merged_path, "java_merged_callgraph.json")
    graph = {
        "mode": "merged_java_graph",
        "parser": "+".join(sources),
        "nodes": sorted(merged_nodes),
        "edges": [
            [src, dst, merged_edge_meta.get((src, dst), {}).get("order"), merged_edge_meta.get((src, dst), {}).get("line")]
            if (src, dst) in merged_edge_meta else [src, dst]
            for src, dst in sorted(merged_edges)
        ],
        "source_count": len(sources),
    }
    with open(merged_json_path, "w", encoding="utf-8") as f:
        json.dump(graph, f, separators=(",", ":"))

    merged_ordered_path = os.path.join(merged_path, "java_merged_ordered_call_sequence.json")
    if merged_ordered_calls:
        write_ordered_call_sequence(
            merged_ordered_calls,
            merged_ordered_path,
            parser="+".join(sources),
            source_callgraph=os.path.basename(merged_json_path),
        )
        results["java_merged_ordered_call_sequence_path"] = merged_ordered_path

    logger.info(
        "Merged Java graph written: %s sources=%s nodes=%s edges=%s",
        merged_json_path,
        ",".join(sources),
        len(merged_nodes),
        len(merged_edges),
    )
    results["java_merged_json_path"] = merged_json_path
    return results
