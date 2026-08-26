# CODEMD

**AI writes the code. CODEMD proves the change is safe before you commit.**

Claude, Cursor, Codex, and Copilot write code fast — but they routinely skip the test, or write one that never actually exercises the line they changed. CODEMD closes that loop inside VS Code: it traces your uncommitted change through the repo's callgraph, checks whether anything actually tests the function you touched, writes a real test grounded in how that function is genuinely called when one's missing, and runs it for a genuine pass/fail — automatically, before you commit.

**The loop:** agent changes code → CODEMD maps the impact via the callgraph → finds the tests that already cover it → generates the ones that don't exist → runs only what's required (not the whole suite, not nothing) → surfaces real failures → helps fix the code. Pass/fail is always a real test-runner result — never an LLM's self-report.

```
$ git commit -m "add checkout retry flow"
CODEMD — tracing impact of 3 changed files...
  -> process_refund(): called by 4 functions, 0% covered
CODEMD — writing missing test...
  OK  test_process_refund_partial.py generated
  OK  4/4 tests passed
OK  safe to commit
```

1. **Analyze** — every uncommitted change is traced through the repo's callgraph: what it calls, what calls it, how far the blast radius reaches.
2. **Identify** — CODEMD checks each changed function against existing tests and flags the ones nothing currently covers.
3. **Write & run** — it writes a real test grounded in how the function is actually called, then runs it and reports a genuine pass/fail — before you commit.

Coding agents can search your repo, but they have to reconstruct how it fits together every time. CODEMD builds that structure once — callers, callees, blast radius — and keeps it current, so the test-gap check above is instant instead of a fresh investigation.

> **Pre-release preview:** CODEMD is currently in early testing. Please report install issues, confusing flows, or inaccurate results.
>
> **Install note:** If the CODEMD icon or panel does not appear right after installing or updating the extension, run **Developer: Reload Window** from the VS Code Command Palette.

![CODEMD impact graph and change report inside VS Code](https://github.com/codemd-dev/CODE.md/blob/main/uncommitted-edits.jpg?raw=true)

## The test loop, in detail

1. **Find the gap.** CODEMD checks your uncommitted changes against the repo's callgraph and flags every modified or new function — then checks whether any existing test actually references it, not just whether a test file happens to exist nearby.
2. **Generate a real test.** For a function with no coverage, click **Generate regression test** — a free, no-AI replay of a confirmed real caller's actual arguments — or **Ask Claude for a Call Path Test**, which reads how the function is genuinely invoked and writes a test around that, not a placeholder.
3. **Run it and get a real answer.** Click **Run**. For Python, Go, and Rust this executes directly in your own environment and reports a hard pass/fail, with coverage confirmation showing whether the changed lines actually ran. Other languages ask your local Claude Code CLI to find the right command (read-only — it can't run or fix anything at that step); CODEMD then runs that command itself and reads the real exit code, so pass/fail is never just an LLM's opinion of its own output. JS/TS additionally gets measured coverage via `c8`.
4. **Fix on your terms.** A failing test shows a **🔧 Fix with Claude** button — never automatic. One click has Claude re-run the test itself, decide whether the test's assumptions or the code under test is actually wrong, fix the smaller correct thing, and verify by rerunning before reporting back what changed.

## Also catches, before you commit

- **Deleted or renamed functions** that something else still calls.
- **Changed function signatures** that break existing call sites.
- **Blast radius** — every function, file, or route your edit touches indirectly, ranked by risk. This is the same analysis that powers the test-gap detection above.
- **Risky changes** — edits to CI/deploy config, migrations, schemas, or heavily-depended-on files.

## Also useful

- **Check Latest Commits** — the same impact check, for changes that are already committed.
- **Search** — jump straight to any function, file, or route and see what connects to it.
- **Works with your AI agent directly** — CODEMD can expose its local repo index to Claude Code, Codex, and Cursor over MCP, so your agent checks what it's about to break (and what needs a test) instead of guessing. Opt-in via **Set Up MCP** in the CODEMD panel — nothing is configured automatically.

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
