# CODEMD

**AI writes the code. CODEMD proves the change is safe before you commit.**

Claude, Copilot, Cursor, and Codex write code fast — but they don't always test what they changed. CODEMD closes that gap automatically, right inside VS Code, before you commit.

**How it works:**

1. **Claude (or any AI) changes your code.**
2. **CODEMD traces the change** through your codebase to see everything it affects.
3. **It checks for a real test** — and writes one, grounded in how the code is actually used, if none exists.
4. **It runs the test** and confirms the changed lines actually ran — a real pass/fail, not an AI's opinion.
5. **If it fails,** one click has Claude fix the test or the code, then re-verify.
6. **You get a clear report** — safe to commit, or not — before you check in.

![The CODEMD loop: agent writes code, CODEMD finds the risk, writes and runs a real test, fixes real failures, safe to commit](https://github.com/codemd-dev/CODE.md/blob/main/media/test-loop-marketing.png?raw=true)

```
$ git commit -m "add checkout retry flow"
CODEMD — tracing impact of 3 changed files...
  -> process_refund(): called by 4 functions, 0% covered
CODEMD — writing missing test...
  OK  test_process_refund_partial.py generated
  OK  4/4 tests passed
OK  safe to commit
```

> **Pre-release preview:** CODEMD is currently in early testing. Please report install issues, confusing flows, or inaccurate results.
>
> **Install note:** If the CODEMD icon or panel does not appear right after installing or updating the extension, run **Developer: Reload Window** from the VS Code Command Palette.

![CODEMD impact graph and change report inside VS Code](https://github.com/codemd-dev/CODE.md/blob/main/uncommitted-edits.jpg?raw=true)

## The 5 kinds of tests CODEMD writes — and only these 5

CODEMD doesn't generate tests freely. Every run picks exactly one of the 5 kinds below, based on what it finds in your callgraph — never open-ended, never invented:

1. **Regression Test** — free, no AI involved. A real caller's actual arguments are replayed exactly as they're passed in your code. Instant and fully deterministic.
2. **Call-Path Test** — when a real caller's arguments aren't plain literals (a variable, a computed value), or when two changed functions call each other directly, Claude reads the real call and writes the test by hand around it — still grounded in an actual call site, just not mechanically replayable.
3. **New-Function Test** — for a function you just added. CODEMD finds its first real caller in the callgraph and asks Claude to write a test around that actual usage.
4. **Contract Test** — when a signature change breaks existing callers, CODEMD writes one test per broken call site, each showing the corrected call against the new signature.
5. **Broader-Coverage Test** — for a function with several real callers, one test per genuinely different way it's called, not just the first one found.

Whichever kind it picks, CODEMD only writes it when you click **Check tests** — nothing runs in the background — and it then runs the test and reports a real pass/fail.

## What else shows up in your impact report

These aren't actions CODEMD takes — they're risks it flags *in the report*, for you to review before you commit:

- **Deleted or renamed functions** that something else still calls.
- **Changed function signatures** that break existing call sites.
- **Blast radius** — every function, file, or route your edit touches indirectly, ranked by risk.
- **Risky changes** — edits to CI/deploy config, migrations, schemas, or heavily-depended-on files.

## Other ways to use CODEMD

- **Check Latest Commits** — the same impact check, for changes that are already committed.
- **Search** — jump straight to any function, file, or route and see what connects to it.
- **Read-only access for your AI agent** — CODEMD can expose its local repo index to Claude Code, Codex, and Cursor over MCP: impact radius, callers/callees, and test coverage lookups only — no write tools, so your agent can look before it leaps without CODEMD taking any action on its own. Opt-in via **Set Up MCP** in the CODEMD panel.
- **Read-only mode** — set `codemdGraphs.readOnlyMode` to `true` to stop CODEMD from ever invoking Claude to write a test or fix a failure. It still traces impact and runs the free, mechanical Regression Test and any tests that already exist — you just won't get AI-generated tests or the Fix button until you turn it back off.
- **A usage cap on every AI action** — `codemdGraphs.maxCostPerActionUsd` (default `$1`) caps how much API-equivalent usage any single Claude action (writing a test, fixing a failure, or finding a run command) is allowed to use. On a Claude Pro/Max subscription this isn't a real charge — nothing is billed per call — but the cap still protects your rate-limited 5-hour/7-day quota from one action eating an outsized chunk of it. Claude enforces this itself and stops the moment it's crossed — raise it in Settings if you want to allow heavier actions.
- **An activity report of everything CODEMD did** — every test run, every test it generated, and every fix it attempted is logged to `.codemd/reports/activity.md`, with how long each took and how much usage it took. CODEMD tells you the first time it writes to this file, with a button to open it.

## Under the hood

Everything runs locally: a bundled Python analyzer builds and maintains the callgraph, your own test runners (`pytest`, `go test`, `cargo test`, ...) produce every pass/fail, and the local Claude Code CLI is invoked only for test generation and the Fix button — never automatically.

![CODEMD architecture: the webview panel and extension host in VS Code, the local Python analyzer, test runners, and Claude Code CLI they spawn, what gets persisted in .codemd/ and VS Code's global storage, and the optional MCP server exposing the same index to Claude Code, Codex, and Cursor](https://github.com/codemd-dev/CODE.md/blob/main/media/test-architecture.png?raw=true)

## Getting Started

1. Install CODEMD.
2. Click the CODEMD icon in the Activity Bar.
3. Run **Generate CODEMD** to analyze the current workspace.
4. Click **Check Uncommitted Edits**, then **Check tests** on any flagged function — before your next commit.

## Requirements

- Python 3. CODEMD manages an isolated virtual environment automatically. You can also set `codemdGraphs.pythonPath` to use your own interpreter.
- Running Python tests directly needs `pytest` (and, for coverage confirmation, `coverage`) installed in your project's own environment — CODEMD detects and uses it automatically if present.
- Running Go tests directly needs the Go toolchain on `PATH`. Running Rust tests directly needs `cargo`, plus `cargo-llvm-cov` for coverage confirmation (falls back to plain pass/fail without it).
- The Claude-assisted paths (test generation, non-direct-language test runs, and the Fix button) need the Claude Code CLI installed and signed in.

## Learn More

Visit [codemd.dev](https://www.codemd.dev).
