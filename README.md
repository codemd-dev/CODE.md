# CODEMD

> This is the repo's own README (GitHub-facing, includes the architecture
> diagram). The VS Code Marketplace listing is built from
> [MARKETPLACE.md](MARKETPLACE.md) instead (`npm run package`/`npm run publish`
> pass `--readme-path MARKETPLACE.md`) — same content, minus "Under the
> hood"'s architecture diagram (too technical for that audience), plus a
> "How to use CODEMD" section with the user-flow diagram. Keep both in sync
> when editing product-facing content; the architecture section only needs
> updating here.

**AI writes the code. CODEMD is the test harness that proves the change is safe before you commit — running automatically, generating only when it has to.**

Claude, Copilot, Cursor, and Codex write code fast — but they don't always test what they changed, and it's easy to forget. CODEMD closes that gap: it traces your callgraph and code index to find exactly which functions a change touches, instantly runs the subset of your existing tests that actually target them, and only asks Claude to write a new one when nothing covers that code yet. Detection and running your own tests are free and automatic; writing new tests is the one part that costs anything, and it never happens without your say-so.

**How it works:**

1. **Claude (or any AI) changes your code.**
2. **CODEMD traces the change** through your callgraph to see everything it affects — no guessing, no re-running your whole suite.
3. **It runs the subset of your existing tests that target that change** — automatically, for free, the moment the change is checked.
4. **If nothing covers it,** one click has Claude write a test grounded in how the code is actually used, then run it and confirm the changed lines actually executed — a real pass/fail, not an AI's opinion.
5. **If it fails,** one click has Claude fix the test or the code, then re-verify.
6. **You get a clear report** — safe to commit, or not — before you check in. Nothing generates or runs Claude in the background; every AI action is one click, and you're always in control.

![The CODEMD loop: agent writes code, CODEMD finds the risk, writes and runs a real test, fixes real failures, safe to commit](https://github.com/codemd-dev/CODE.md/blob/main/media/test-loop-marketing.png?raw=true)

**What you're about to see:** a real example. A developer commits a code change. CODEMD notices the change touches a function that's used in 4 other places but has no test covering it, so it automatically writes and runs a test for it — right before the commit goes through:

```
$ git commit -m "add checkout retry flow"
CODEMD — tracing impact of 3 changed files...
  -> process_refund(): called by 4 functions, 0% covered
CODEMD — writing missing test...
  OK  test_process_refund_partial.py generated
  OK  4/4 tests passed
OK  safe to commit
```

> **Pre-release preview:** CODEMD is currently in early testing, provided as-is with no warranty — see [Disclaimer](#disclaimer). Please report install issues, confusing flows, or inaccurate results.
>
> **Install note:** If the CODEMD icon or panel does not appear right after installing or updating the extension, run **Developer: Reload Window** from the VS Code Command Palette.

![CODEMD impact graph and change report inside VS Code](https://github.com/codemd-dev/CODE.md/blob/main/uncommitted-edits.jpg?raw=true)

## How to use CODEMD

The full loop, from an AI agent's change to a verified commit:

![CODEMD verifies your AI-generated code before you commit: it analyzes the change to find real callers and impacted code, finds which existing tests already cover it, finds the test gaps, uses your AI coding agent to create the missing tests grounded in real callers and impact, then runs everything automatically — safe to commit if all tests pass, or AI-powered fix suggestions and a re-run loop if any fail](https://github.com/codemd-dev/CODE.md/blob/main/media/TestingPlatform.png?raw=true)

## Two different things CODEMD does — and only one of them costs anything

**Running tests that already exist is free and automatic.** CODEMD looks for a test already covering the function your diff touched and actually executes it — a real pass/fail, not an AI's opinion — for close to zero cost:

| Language | Runs with no click, the moment a change is checked | Manual "Check tests" → Run | How it actually runs |
| --- | --- | --- | --- |
| **Python** | ✅ | ✅ | Directly — your own `pytest` + `coverage.py` |
| **Go** | — | ✅ | Directly — `go test` + its coverage profile |
| **Rust** | — | ✅ | Directly — `cargo test` + `cargo-llvm-cov` |
| **Java** | — | ✅ | Directly — Maven, via the JUnit Platform Console Launcher |
| **Kotlin** | — | ✅ | Directly — Maven, same JUnit Platform Console Launcher as Java |
| **C#** | — | ✅ | Directly — a throwaway xUnit project referencing your own `.csproj` |
| **JS/TS, and others** | — | ✅ | Claude reads your project files to find the right command (`npm test`, ...), then CODEMD runs that command itself |

Only that last row spends any AI usage at all, and only to *find the command* — never to grade the result. The pass/fail always comes from actually executing the test.

**Writing a brand-new test is optional, and the one place Claude actually writes code.** This is the gap most AI-assisted workflows have today: an agent changes a function, nothing covers it, and the change ships on faith. CODEMD can instead ground a real test in how that function is *actually called* elsewhere in your codebase — from your callgraph, not a guess — so a commit gets at least one real regression check instead of "commit and hope":

| Test | What CODEMD does | Bugs it targets | Python | JS/TS, Java, C#, Go, Rust, Kotlin |
| --- | --- | --- | --- | --- |
| **Regression Test** | Free, no AI involved. Replays a real caller's actual arguments exactly as they're passed in your code — instant and fully deterministic. | Exact regressions on a path that's already live in your app. | ✅ | — |
| **Call-Path Test** | Claude reads a real call site and writes the test by hand around it — grounded in an actual call, just not mechanically replayable. | Integration bugs a real caller would hit — not just isolated unit bugs. | ✅ | ✅ |
| **Call-Chain Test** | For two functions that changed *together* in the same diff and call each other directly — one test exercising both as a real chain. | Breaks in how two changed functions interact, that neither one's own test would catch. | ✅ | ✅ |
| **New-Function Test** | For a function you just added. CODEMD finds its first real caller in the callgraph and asks Claude to write a test around that actual usage. | Missing coverage on brand-new code, before it ships. | ✅ | ✅ |
| **Multi-Caller Test** | For a function with several real callers, one test per genuinely different way it's called, not just the first one found. | Edge cases that work for the common caller but break the others. | ✅ | ✅ |
| **Contract Test** | When a signature change breaks existing callers, CODEMD writes one test per broken call site, each showing the corrected call against the new signature. | Breaking API changes — renamed, reordered, or removed parameters. | ✅ | — |

Whichever kind it picks, CODEMD only writes it when you click **Check tests** — nothing generates in the background — and it then runs the test itself and reports a real pass/fail.

### How effective is this, honestly?

We'd rather tell you what's actually known than make up a number.

**LLM-written tests are a real, actively-researched technique — with genuinely mixed results industry-wide.** Independent academic evaluations of LLM-generated unit tests report a wide range of real-bug-detection outcomes depending on the approach and benchmark — from studies where most generated tests found zero or one bug, to others reporting 68–81% detection when combining methods ([arXiv:2404.10304](https://arxiv.org/pdf/2404.10304), [arXiv:2502.09801](https://arxiv.org/abs/2502.09801)). One large-scale study also found that a majority of LLM-generated tests across several models never even compiled, which is itself the dominant cause of missed bugs ([arXiv:2508.00408](https://arxiv.org/pdf/2508.00408)) — a large part of why CODEMD only ever counts a test as "safe to commit" after it *actually runs*, not after Claude claims it wrote something reasonable.

**Grounding generation in a real call site — CODEMD's core idea — has real prior art.** [TestPilot](https://githubnext.com/projects/testpilot/) (GitHub Next / Microsoft Research) generates tests from real usage examples mined from a codebase rather than an isolated function signature, and reports 60–80% statement coverage on popular npm packages — the closest published relative of CODEMD's Call-Path approach, though that's a coverage number, not an audited bug-catch rate. Separately, using call graphs to target *which* code a change actually puts at risk is an established, well-studied technique in regression-test-selection research ([arXiv:1812.06286](https://arxiv.org/pdf/1812.06286)), which is what CODEMD's impact tracing is built on.

**Commercial tools in this space self-report meaningfully higher numbers** — e.g. Qodo has publicly claimed detecting 42–48% of real-world runtime bugs across languages — but those are vendor-reported figures, not independently audited, and CODEMD makes no equivalent claim about itself.

**CODEMD's own numbers, honestly: we don't have enough data yet to publish one, so we're not going to invent one.** As of this release, every genuine test failure CODEMD's generators produce — a test that actually ran against your real code and a real assertion failed, excluding environment/setup issues that say nothing about your code — gets logged to `.codemd/defects/` in your own repo. That's deliberate: instead of asking you to trust a marketing number, you can watch this fill up (or not) in your own codebase and judge for yourself.

Sources: [LLM-Powered Test Case Generation for Detecting Bugs in Plausible Programs](https://arxiv.org/pdf/2404.10304) · [Unit Testing Past vs. Present: Examining LLMs' Impact on Defect Detection](https://arxiv.org/abs/2502.09801) · [Benchmarking LLMs for Unit Test Generation from Real-World Functions](https://arxiv.org/pdf/2508.00408) · [TestPilot (GitHub Next)](https://githubnext.com/projects/testpilot/) · [A Large-Scale Study of Call Graph-based Impact Prediction using Mutation Testing](https://arxiv.org/pdf/1812.06286)

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
- **A defects log you can actually audit** — whenever a CODEMD-generated test genuinely runs against your real code and a real assertion fails (not an environment/setup issue), it's recorded to `.codemd/defects/` as its own file. This is how you see, in your own repo, whether this is finding anything real — not a claim we're asking you to take on faith.

## Getting Started

1. Install CODEMD.
2. Click the CODEMD icon in the Activity Bar.
3. Run **Generate CODEMD** to analyze the current workspace.
4. Click **Check Uncommitted Changes**, then **Check tests** on any flagged function — before your next commit.

## Requirements

- Python 3. CODEMD manages an isolated virtual environment automatically. You can also set `codemdGraphs.pythonPath` to use your own interpreter.
- Running Python tests directly needs `pytest` (and, for coverage confirmation, `coverage`) installed in your project's own environment — CODEMD detects and uses it automatically if present.
- Running Go tests directly needs the Go toolchain on `PATH`. Running Rust tests directly needs `cargo`, plus `cargo-llvm-cov` for coverage confirmation (falls back to plain pass/fail without it).
- Running Java or Kotlin tests directly needs Maven and a JDK on `PATH` (Gradle projects aren't supported for direct runs yet — open the file and run it from your IDE/Gradle instead). Kotlin also needs the Kotlin compiler (`kotlinc`) on `PATH`, separate from the JDK.
- Running C# tests directly needs the .NET SDK (`dotnet`) on `PATH`.
- Running JS/TS tests needs Node.js and your project's own package manager on `PATH` — Claude reads your `package.json` to find the exact command (Jest, Vitest, Mocha, ...) rather than assuming one.
- The Claude-assisted paths (test generation, non-direct-language test runs, and the Fix button) need the Claude Code CLI installed and signed in.

## Disclaimer

CODEMD is beta / pre-release software, provided **"as is," with no warranty of any kind** — express or implied, including merchantability, fitness for a particular purpose, or accuracy. Use it at your own risk, and don't treat it as your only safety check before shipping.

- **AI-generated content can be wrong.** Tests, fixes, and impact analysis that CODEMD or Claude produce may be incomplete, inaccurate, or based on a misreading of your code. Review generated tests and fixes before trusting or committing them — CODEMD's "safe to commit" report is a signal, not a guarantee.
- **CODEMD executes real code on your machine** — your own test suite, and any test it generates — via `pytest`, `go test`, `cargo test`, `mvn`/`kotlinc`, `dotnet`, or your project's own JS/TS test command. If you have any doubt what a generated test file contains, read it before running it.
- **Claude Code CLI usage may incur real cost.** Test generation and the Fix button invoke your local Claude Code CLI, which consumes your Anthropic API usage or subscription quota. CODEMD is not responsible for usage charges or rate-limit consumption resulting from its use.
- **No liability.** To the maximum extent permitted by law, CodeVal and CODEMD's contributors accept no liability for damages — direct, indirect, incidental, or consequential — arising from use of this extension, including but not limited to data loss, incorrect test results, missed bugs, or third-party AI usage costs.

Full legal terms: [LICENSE.txt](LICENSE.txt).

## Privacy

CODEMD's analysis runs locally and doesn't upload your code. See
[PRIVACY.md](PRIVACY.md) for what data, if any, is involved — including the
optional codemd.dev link in the panel.

## Learn More

Visit [codemd.dev](https://www.codemd.dev).
