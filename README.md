# CODEMD

**Using AI to code? Check what your changes might break — before you commit.**

Claude, Cursor, Codex, and Copilot are fast at writing code. They're not always fast at knowing what else in your codebase depends on the function they just touched. CODEMD looks at your uncommitted changes and shows you, right inside VS Code, what you changed, what calls it, and what's likely to break.

> **Pre-release preview:** CODEMD is currently in early testing. Please report install issues, confusing flows, or inaccurate impact results.
>
> **Install note:** If the CODEMD icon or panel does not appear right after installing or updating the extension, run **Developer: Reload Window** from the VS Code Command Palette.

![CODEMD impact graph and change report inside VS Code](https://github.com/codemd-dev/CODE.md/blob/main/uncommitted-edits.jpg?raw=true)

## How it works

1. Edit code — yourself, or let Claude, Codex, or Cursor do it.
2. Click **Check Uncommitted Edits** in the CODEMD panel.
3. See exactly what changed and what it affects, before you run `git commit`.

## What it catches

- **Deleted or renamed functions** that something else still calls.
- **Changed function signatures** that break existing call sites.
- **Blast radius** — every function, file, or route your edit touches indirectly, ranked by risk.
- **Risky changes** — edits to CI/deploy config, migrations, schemas, or heavily-depended-on files.

## Also useful

- **Check Latest Commits** — the same impact check, for changes that are already committed.
- **Search** — jump straight to any function, file, or route and see what connects to it.
- **Works with your AI agent directly** — CODEMD can expose its local repo index to Claude Code, Codex, and Cursor over MCP, so your agent checks what it's about to break instead of guessing. Opt-in via **Set Up MCP** in the CODEMD panel — nothing is configured automatically.

## Getting Started

1. Install CODEMD.
2. Click the CODEMD icon in the Activity Bar.
3. Run **Generate CODEMD** to analyze the current workspace.
4. Click **Check Uncommitted Edits** before your next commit.

## Requirements

- Python 3. CODEMD manages an isolated virtual environment automatically. You can also set `codemdGraphs.pythonPath` to use your own interpreter.

## Learn More

Visit [codemd.dev](https://www.codemd.dev).
