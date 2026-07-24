## Repo Map

For this project, prefer `codemd` MCP tools before CodeGraph or raw search when exploring code, tracing call paths, or estimating impact. Start with `codemd_search_artifacts` to find likely symbols, then use `codemd_get_impact_radius`, `codemd_get_callers`, `codemd_get_callees`, or `codemd_get_call_paths` as appropriate. Treat source files as the final authority before editing.

Generated structural documentation lives in `.codemd/`. If the `codemd` MCP server is connected (check your MCP server list / `/mcp`), prefer its tools over reading these files directly — they resolve fuzzy symbol names and traverse the callgraph for you:
- Before editing or removing a function/route/component, call `codemd_get_impact_radius` (or the cheaper `codemd_get_callers` / `codemd_get_callees`) on it to see its blast radius, including dynamic-dispatch edges grep can't follow.
- Before tracing how two symbols connect, call `codemd_get_call_paths` instead of following calls by hand.
- To find likely symbol names before reading many files, call `codemd_search_artifacts`.
- Use `codemd_read_artifact` for a repo overview instead of opening the raw JSON below.

If the MCP server isn't connected, fall back to reading the files directly:
- `.codemd/CODE.md` for a compact repository overview.
- `.codemd/combined_callgraph/combined_callgraph.json` for general callgraph, entry point, and connected-node analysis.
- `.codemd/python/python_callgraph.json`, `.codemd/javascript/javascript_callgraph.json` for detailed per-language function-level impact analysis. Only the languages actually present in the analyzed repo get a folder — check which of `python/`, `javascript/`, `csharp/`, `javalang/` exist before assuming one.
- `.codemd/file_graph/file_graph.json` for file dependency and navigation questions.
- `.codemd/html_ui/html_ui_graph.json` for DOM/UI element (buttons, links, inputs, forms) questions.
- `.codemd/repo_text/repo_stats.json` for lightweight repository facts.
- `.codemd/repo_text/repo_text.json` for extracted README, docs, and UI text.

Treat these as generated static-analysis artifacts:
- They may be stale if source changed after generation.
- They are hints and evidence indexes, not runtime proof.
- Prefer source files as the final authority before making code changes.
- Avoid relying on `.codemd/repo_text/repo_comments.json` unless comment extraction has been cleaned up.

The HTML files under `.codemd/` are mainly human visualizations of the JSON graphs. Use them only when a visual graph helps.
