# CODEMD

CODEMD from [codemd.dev](https://www.codemd.dev) helps developers and coding agents understand code changes before they are committed. It combines local callgraphs, pre-commit risk analysis, blast-radius checks, signature-change detection, and navigable change maps inside VS Code.

Give Claude, Codex, Cursor, and other coding agents compact local code intelligence through CODEMD artifacts and MCP, so they can use callgraphs and repository structure instead of repeatedly scanning the whole workspace.

## Graphs

CODEMD generates and displays local repository graphs:

- **Callgraph**: who calls what across supported languages.
- **File graph**: file-to-file dependencies.
- **HTML UI graph**: buttons, links, inputs, forms, and frontend UI structure.
- **Focused change graphs**: impact maps for specific search results, commits, and uncommitted edits.

![CODEMD impact graph and change report inside VS Code](https://github.com/codemd-dev/CODE.md/blob/main/uncommitted-edits.jpg?raw=true)

![CODEMD search graphs](https://github.com/codemd-dev/CODE.md/blob/main/search-graph.jpg?raw=true)

## What CODEMD Does

1. **Reviews changes before commit**
   Summarizes uncommitted edits, changed functions, deleted files, added files, removed folders, and other risky file changes before they land.

2. **Highlights risk and blast radius**
   Scores changes by caller impact, sensitive paths, dependencies, CI/deploy files, migrations, schemas, and broad upstream usage.

3. **Catches function-level breakage**
   Detects deleted functions, Python signature changes, and provably incompatible direct call sites.

4. **Turns diffs into navigable context**
   Lets developers jump from reports to source, diffs, changed functions, focused impact graphs, and recent commit analysis.

5. **Gives coding agents local repo intelligence**
   Generates `.codemd/` artifacts so Claude, Codex, Cursor, and other agents can use callgraphs and structure instead of repeatedly scanning files.

6. **Runs local-first with MCP support**
   Keeps core analysis in the workspace and exposes search, callers, callees, impact radius, status, and call paths through MCP.

## Key Workflows

- Click **Check Uncommitted Edits** to review local changes before committing.
- Click **Blast Radius Report** to focus on changed functions whose caller footprint is risky.
- Click **Check Latest Commits** to inspect committed changes and their impact.
- Use the search box to find code through local CODEMD analysis.
- Use **Set Up MCP** to connect Claude Code, Codex, and other MCP clients to CODEMD's local code intelligence.

## Getting Started

1. Install CODEMD.
2. Click the CODEMD icon in the Activity Bar.
3. Run **Generate CODEMD** to analyze the current workspace.
4. Use **Check Uncommitted Edits**, **Blast Radius Report**, search, or graph navigation.
5. Use **Set Up MCP** so Claude, Codex, and other coding agents can use CODEMD callgraphs and local repo intelligence.

## Requirements

- Python 3. CODEMD manages an isolated virtual environment automatically. You can also set `codemdGraphs.pythonPath` to use your own interpreter.

## MCP Setup

MCP configuration is opt-in. CODEMD writes workspace/client MCP configuration only when you run **CODEMD: Set Up MCP** or click **Set Up MCP** in the CODEMD panel.

## Learn More

Visit [codemd.dev](https://www.codemd.dev).
