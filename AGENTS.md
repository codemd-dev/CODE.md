## Repo Map

Generated structural documentation lives in `codemd.dev/`.

Start with:
- `codemd.dev/CODE.md` for a compact repository overview.
- `codemd.dev/combined_callgraph/combined_callgraph.json` for general callgraph, entry point, and connected-node analysis.
- `codemd.dev/python/python_callgraph.json`, `codemd.dev/javascript/javascript_callgraph.json` for detailed per-language function-level impact analysis. Only the languages actually present in the analyzed repo get a folder — check which of `python/`, `javascript/`, `csharp/`, `javalang/` exist before assuming one.
- `codemd.dev/file_graph/file_graph.json` for file dependency and navigation questions.
- `codemd.dev/html_ui/html_ui_graph.json` for DOM/UI element (buttons, links, inputs, forms) questions.
- `codemd.dev/repo_stats.json` for lightweight repository facts.
- `codemd.dev/repo_text.json` for extracted README, docs, and UI text.

Treat these as generated static-analysis artifacts:
- They may be stale if source changed after generation.
- They are hints and evidence indexes, not runtime proof.
- Prefer source files as the final authority before making code changes.
- Avoid relying on `codemd.dev/repo_comments.json` unless comment extraction has been cleaned up.

The HTML files under `codemd.dev/` are mainly human visualizations of the JSON graphs. Use them only when a visual graph helps.
