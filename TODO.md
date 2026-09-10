# CODEMD test-verification roadmap

## Research: three RTS/test-gen papers cross-checked against CODEMD (flagged 2026-09-06, not started — for later analysis)

Read three papers on regression-test-selection and AI-agent test generation and
cross-checked their techniques against the actual current code (not guessed):
TDAD (arXiv:2603.17973v2 — graph-based pre-change impact analysis delivered as
an agent skill, 70% regression reduction on SWE-bench Verified), Frechette et
al. (ISRN Software Engineering 2013 — Control Call Graph based regression test
selection/generation for Java), and Pacheco et al. (Randoop — feedback-directed
random test generation, found 210 real bugs in 780KLOC of already-tested
Java/.NET libraries via universal object-contract checking).

**Languages CODEMD runs tests for free today (confirmed against code, not
assumed)**: direct run, no Claude ever — Python, Go, Rust, Java, C#, Kotlin
(`DIRECT_RUN_EXTS`, [src/extension.ts:14195](src/extension.ts#L14195)). JS/TS
is free too, Claude only as a rare fallback (`detectJsTestRunner`,
[src/extension.ts:3039](src/extension.ts#L3039)). But "runs for free" ≠ "gets
callgraph-driven generation" — per the language-tier table further down this
file, only Python/JS-TS/Java/C# have a real callgraph wired to the four
generators; Go/Rust/Kotlin can run an *existing* test file for free but have
no callgraph to drive Call-Path Opportunities or new-test generation.

### Findings (highest-value first)

1. **Multi-hop transitive impact, with confidence-weighted scoring (TDAD).**
   TDAD's core technique is exactly item #4/#5 below (numeric risk score,
   entry-point-to-change tracing), just with a proven formula: merge
   Direct/Transitive/Coverage/Imports strategies via
   `score = (1-cw)·w_strategy + cw·confidence`, confidence decaying by hop
   distance. CODEMD's "Call-Path Opportunities" today only fires when **both**
   functions changed in the same commit — it doesn't trace 2-3 hops out
   through unmodified intermediate callers the way TDAD's Transitive strategy
   does. Real detection gap: a regression in a caller-of-a-caller of a changed
   function could go unflagged.

2. **Control-flow-path-level test selection (Frechette et al.).** CODEMD's
   generators reason at the function/caller level. The CCG paper
   selects/generates tests per distinct control-call-path through a caller —
   distinguishing "caller X invokes the changed function on the if-branch"
   from "...on the else-branch." A caller that only breaks on one branch could
   pass CODEMD's current per-caller test and still ship a regression on the
   untested branch.

3. **Contract/property-based fuzzing (Randoop) — a genuinely missing
   category.** The biggest finding. Randoop doesn't use a callgraph at all —
   it randomly builds method sequences and checks universal object contracts
   (equals reflexivity, hashCode/toString never throwing, no unexpected
   NullPointerException/AssertionError). Found 210 real bugs in 780KLOC of
   already heavily-tested Java/.NET libraries this way — bugs that existed
   despite good test suites, because nobody thought to test that specific
   contract. None of CODEMD's four generators check this class of bug;
   they're all example-based, driven by "which callers exist," which
   structurally can't catch "does this object obey its own contract
   regardless of caller." Randoop itself is a real, mature CLI — could be
   invoked scoped to just the changed classes, no Claude call needed, same
   spirit as how coverage confirmation got bolted onto existing run paths.

4. **Regression oracles across before/after state (Randoop §3.3).**
   Auto-generate observer assertions (`toString()`, `size()`, getters) on a
   sequence, snapshot behavior *before* Claude's patch, rerun the same
   sequence *after*, diff. Caught 12 real JDK-implementation inconsistencies
   in Randoop's own case study. CODEMD has nothing like this today — a
   different signal from "does the test pass," closer to "did observable
   behavior silently change."

**Not new, already known and declined**: mutation testing (the one signal
that proves a test would actually catch a regression) — already scoped below
and explicitly declined over file-safety concerns, per
[[project_codemd_test_verification_roadmap]] (auto-memory).

**Minor prompting note from TDAD, not actionable**: the "TDD Prompting
Paradox" (verbose procedural instructions increased regressions on a small
*local* model) is a caveat, not a proven risk here — TDAD's own limitations
section says frontier models may not exhibit it, and CODEMD uses Claude, not
a quantized 30B local model.

### Implementation scoping for #1 and #3 (2026-09-06) — per user's "small incremental only, no big fixes" constraint

**#1, tuning-only first step (small, hours not days).** `findTestsViaCallgraph`
in `scripts/codemd-mcp-server.js`
([codemd-mcp-server.js:1159](scripts/codemd-mcp-server.js#L1159)) *already*
does hop-counted backward BFS and *already* computes an ad hoc score
(`minDepth === 1 ? 100 : Math.max(10, 90 - minDepth*15)`). Adopting TDAD's
principled decay curve/confidence tiers (high ≥0.8 / medium 0.5-0.8 / low
<0.5) there is a pure scoring-formula edit inside a function that already
exists — no new traversal, no new data. Rough size: ~20-line diff in one
function, verifiable the same way the `text_response_server` fix was (a
standalone `node -e` sanity check against known call chains before touching
the UI). Estimate: **1-2 hours**.
The *fuller* version of #1 — actually wiring Call-Path Opportunities to fire
on unmodified-intermediate-caller chains (original item #5 below,
entry-point tracing) — is NOT small: needs a `call_paths` CLI arm, a
set-intersection between `entry_points` and `get_impact_radius`, and new UI
rendering. That's the "big fix" version; not recommended under the
small-only constraint right now.

**#3, Randoop-for-Java (bounded but not tiny — a new feature, not a tweak).**
Nothing exists for this today. Realistic smallest useful slice:
- Step 1 (spike, ~1-2 hrs, no extension code touched): fetch Randoop's jar
  once, hand-run it against one real changed Java class from a real repo, by
  hand, to confirm classpath/output-format assumptions before committing to
  an integration design.
- Step 2 (one new manual button, reusing existing Java run plumbing rather
  than inventing new infrastructure — same Maven/JUnit invocation pattern
  `runJavaTestFileForResult` already uses): "🎲 Check contracts (Randoop)" on
  a Modified Java function card, scoped to just that class, parses JUnit-style
  output, shows pass/fail. Stays behind an explicit click (design rule
  already in this file: automatic firing is fine for pure-local checks, but
  a multi-second fuzz run per commit would surprise a user the way an
  uncapped auto-fire already nearly did — see the parallel-test-run note
  below).
Comparable in size to the already-shipped C#/Java/Kotlin coverage
confirmation ("Mode A") work — that was estimated "small-medium per
language, each independently bounded." Estimate: **1-2 focused days** for a
Java-only, manual-button version. Kotlin/C# would each be separate follow-on
work, not included in this estimate. This is bigger than #1 — flagging
explicitly since the ask was for small-only work; #1 is a same-session-sized
tweak, #3 is a small *feature*, not a tweak.

### #3 follow-up research: callgraph is NOT the targeting mechanism — class membership already is (2026-09-07)

Checked against the actual existing plumbing (not guessed) whether callgraph
tools (`codemd_get_impact_radius`/`get_callees`) are needed to scope a
Randoop run, and confirmed the smallest real path:

**Java confirmed as the right first language, concretely (not just "already
free-run" as stated above)** — the exact plumbing Randoop needs already
exists: `findJavaBuildRootDir` ([extension.ts:4238](src/extension.ts#L4238))
resolves the Maven/Gradle root; the `mvn dependency:get` → `~/.m2` cache
pattern already used for `junit-platform-console-standalone`
([extension.ts:9888](src/extension.ts#L9888),
[extension.ts:10022-10025](src/extension.ts#L10022-L10025)) is the same
recipe a Randoop jar fetch would need; `mvn dependency:build-classpath`
([extension.ts:10007](src/extension.ts#L10007)) already produces the real
project classpath to load the target class against. Randoop doesn't run
tests itself — it generates JUnit source files — so the existing javac +
JUnit Console Launcher execution step that already runs generated `.java`
files is reusable unchanged for the back half of the pipeline.

**Callgraph is not required for MVP.** Randoop's unit of work is a *class*
(`--testclass=<FQCN>` or a `--classlist` file), not a function or a call
edge. CODEMD already knows which class a changed function belongs to as
ordinary AST metadata (same info `testLanguageFor`/`callgraphArtifactFor`
already carry) — no graph traversal needed to answer "what class do I point
Randoop at." The core value (equals/hashCode/toString contract checks,
unexpected NPE/AssertionError) fires off a single class with zero callgraph
queries.

**Where callgraph *would* genuinely help — phase 2, not phase 1:** Randoop
builds richer test sequences when its class pool includes a changed class's
collaborator/dependency types (e.g. if `Foo.bar()` takes a `Baz`, Randoop
can only construct interesting `Baz` objects if `Baz` is also in
`--classlist`). That's a legitimate use for `codemd_get_callees`/
`codemd_get_impact_radius` (1-hop collaborators) — but it's a quality
upgrade on top of a working MVP, not something the MVP needs.

**One new concrete unknown for the Phase 0 spike** (sharper than the
existing "confirm classpath/output-format assumptions" note above): Randoop
is not reliably a clean Maven Central artifact the way
`junit-platform-console-standalone` is — historically distributed as a
shaded `randoop-all-<version>.jar` off Randoop's own GitHub Releases page.
The `mvn dependency:get` pattern likely does NOT transfer as-is; the fetch
step probably needs a one-time direct-URL download into a `.codemd`-owned
cache dir instead. Confirm this in the spike before assuming the Maven
pattern transfers.

**Concrete MVP command shape** (to verify in the spike, not yet run for
real): `java -cp "<projectClasspath>:<compiledClasses>:randoop-all.jar"
randoop.main.Main gentests --testclass=<FQCN> --time-limit=30
--junit-output-dir=<tmp>`. Randoop writes `RegressionTest0.java` +
`ErrorTest0.java` — only the latter matters for "found a bug," since Randoop
only emits an error test when it hit an unexpected exception/contract
violation; its presence with nonzero content *is* the signal. Then compile +
run both via the exact same javac + JUnit Console Launcher steps
`runJavaTestFileForResult` already does today, and parse pass/fail the same
way.

Net effect on the existing estimate above: unchanged (~1-2 focused days,
Java-only, manual button) — the new information is that callgraph is off
the critical path entirely for the MVP, and the Randoop-jar-distribution
unknown is now a specifically named risk for Phase 0's spike to resolve
before writing any extension code.

### Aside: "Run all N tests" has no concurrency cap (noted 2026-09-06, not changed — informational only)

User asked whether running all matched tests via the "▶ Run all N tests"
button (`runAllBtn` click handler,
[src/extension.ts:16420-16428](src/extension.ts#L16420-L16428)) is safe on a
laptop. Confirmed by reading the code: `runners.forEach((r) => r.runTest())`
fires every matched test's run **simultaneously**, no throttle — unlike the
*automatic* per-symbol existing-tests check, which IS capped (3 matched
files in parallel per symbol, `maxAutoWritesPerBatch` symbols per batch,
[src/extension.ts:13984-13995](src/extension.ts#L13984-L13995), explicitly
reasoned about there as "floods the OS with coverage-run/pytest processes").
Clicking "Run all 14 tests" therefore does launch up to 14 concurrent
Python-interpreter + coverage.py subprocess pipelines at once. Not likely to
crash a laptop, but a real, noticeable CPU/fan spike for the run's duration,
especially for tests importing heavy dependencies. Explicitly not fixed this
session per the user's "don't make any changes, just asking" — a bounded
concurrency queue for `runAllBtn` (e.g. reusing the same 3-at-a-time pattern
already proven for the automatic flow) would be a small, well-precedented
fix if it's ever worth picking up.

### Aside: competition/moat note (flagged 2026-09-06, for later analysis, not actionable now)

No one bundles this full loop today — that's less "no competition" and more
that the category is brand new. Code-graph-for-agents tooling (e.g.
open-source projects like CodeGraph, call-graph impact tools like
codemap-impact) and AI test-generation tools (Qodo, Diffblue Cover) are both
emerging fast in 2026, but each covers one piece — graph context, or test
generation — not the closed loop of blast radius → find/generate → run for
real → fix. The real risk is future, not present: any of those players, or
Anthropic/GitHub/OpenAI building it natively into their own agents, is the
natural next move once this category (which only exists because agentic
coding itself is new) gets more attention.

## NEXT: local LLM mode (flagged 2026-09-04, not started)

**Motivation**: with the Claude API's promised $20 free SDK quota not
materializing, Claude usage is now a genuinely scarce resource for CODEMD's
own development and for users on a Pro/Max plan (session/weekly limits, not
metered API billing) — every Claude call CODEMD makes needs to earn its
cost, and users need a path that doesn't touch Claude's quota at all for
the mechanical parts of testing. "Use Coding Agent (Prompt-Only)" (added
this session — see `ClaudeAgentMode`, [extension.ts:1298](src/extension.ts#L1298),
and the Modes popup) covers the "don't spend MY Claude quota automatically"
need by handing control to the user's own terminal session. It does not
cover "I don't want to depend on Claude/any hosted model at all" — that
needs an actual local model.

**Scope, not yet designed**: a fourth `ClaudeAgentMode`-shaped option (or a
separate `codemdGraphs.llmProvider` setting orthogonal to it) that runs test
generation/diagnosis prompts against a locally-hosted model (e.g. via
Ollama or LM Studio's OpenAI-compatible local HTTP endpoint) instead of the
`claude` CLI. Real open questions to resolve before implementing, not just
plumbing:
- Structured-output reliability: the existing generators depend on
  `--json-schema` (Claude CLI) to reliably get back `{testSource, notes,
  plainSummary}` — most local models are much weaker at strict JSON-schema
  adherence than Claude, so this may need a more forgiving parse (e.g.
  extract a fenced code block instead of requiring valid top-level JSON) or
  a retry-on-malformed-output loop.
- Quality bar: a small local model's generated test quality is likely to be
  materially worse than Claude's, especially for the call-path/contract/
  broad-coverage generators, which lean on real reasoning about caller
  behavior, not just syntax. Worth setting expectations (or scoping local
  mode to the mechanical/diagnosis side only, keeping generation on a hosted
  model) rather than assuming parity.
- No code for this exists anywhere in the repo today — this is a scoping
  note, not a partial implementation.

## Prompt-Only Mode — DONE (2026-09-04): CODEMD types the prompt into the user's own Claude terminal instead of running Claude itself

Added a third `codemdGraphs.claudeAgentMode` value, `'promptOnly'`, sitting
between Manual and Use Coding Agent in the Modes popup. In this mode, every
one of CODEMD's 4 real Claude-invocation call sites (`generateCallPathTestForResult`,
the shared `runClaudeTestGeneration` used by the other 4 test generators,
`runTestViaClaudeForResult`'s discovery fallback, and `fixTestFailureForResult`)
skips spawning a `claude` subprocess entirely and instead calls
`sendPromptToUsersClaudeTerminal` ([extension.ts:1298](src/extension.ts#L1298)),
which types the already-built prompt into an interactive `claude` CLI
session running in a VS Code terminal via `Terminal.sendText(prompt, false)`
— the `false` meaning "type this, do not press Enter" — so the user reads
it, can edit it, and only runs it themselves. CODEMD spends zero of its own
Claude budget doing this: no `--max-turns`/`--max-budget-usd`, no captured
stdout, no parsing.

**Confirmed NOT possible, despite an initial pasted claim that it was**:
injecting text into the separate Claude Code VS Code extension's own GUI
chat panel. That panel is a webview owned by a different extension, and VS
Code has no API for one extension to write into another extension's webview
DOM — `editor.insertSnippet` (the pasted suggestion) operates on a text
*editor* tab, unrelated to a chat panel. The terminal mechanism is the only
real path, and only works with the `claude` CLI running in an actual
terminal, not that GUI panel.

**Design consequence**: since nothing comes back to CODEMD to parse or
write to disk, test-generation prompts are rewritten inline (dropping the
"respond in a JSON schema" instruction, adding "write the file directly to
`<path>` yourself") with the SAME deterministic path `writeGeneratedTest`
would have used (`expectedGeneratedTestPath`, [extension.ts:3508](src/extension.ts#L3508))
so a test the user runs through Claude in this mode still lands where
CODEMD's Run/Fix buttons and test-status cache expect to find it. Auto Mode
explicitly refuses to run in this mode (it's an unattended serial pipeline
that can't pause for a human to review each prompt) rather than silently
firing untended prompts into the terminal.

**Not yet done**: no way for CODEMD to detect that the user actually ran
the prompt and pick the result back up automatically — the UI says "click
Regenerate/Check afterward." Could eventually poll for the expected file
appearing, but that's a separate, smaller follow-up if it turns out to
matter in practice.

## NEEDS REAL-TOOLCHAIN VERIFICATION: C#/Java/Kotlin coverage confirmation (built 2026-09-02, unverified)

Implemented Mode A coverage confirmation for C# (coverlet) and Java/Kotlin
(JaCoCo), and wired all three (plus Go) into the automatic "Existing
test(s) found for this change" check
(`runExistingTestsForResult`, [extension.ts:8323](src/extension.ts#L8323)),
not just the manual "Run" button — see the entries below for full detail on
what changed and why.

**None of this could be run against a real .NET SDK, JDK, or Maven
installation in this session** — no such toolchain was available in this
dev environment. Everything was checked by (a) `tsc --noEmit` compiling
clean, and (b) careful reading against each tool's documented behavior
(Cobertura XML schema, JaCoCo's report CLI, coverlet's `--collect` flag,
`mvn dependency:get` classifier conventions) — not by an actual coverlet or
JaCoCo run producing a real report and confirming CODEMD parses it
correctly. Same caveat the pre-existing C#/Java/Kotlin/Rust run paths
already carry from before this session, now extended to the new coverage
piece specifically.

**Before relying on this in production, verify against real projects**:
- **C#**: a real .csproj with a method to cover; confirm `coverlet.collector`
  actually resolves via NuGet in the throwaway project, confirm
  `--collect:"XPlat Code Coverage"` produces `coverage.cobertura.xml` under
  the expected `--results-directory`, and confirm `parseCoberturaCoverage`'s
  `filename` matching (coverlet writes absolute paths) correctly maps back
  to the workspace-relative `targetPath`.
- **Java**: a real Maven project; confirm `mvn dependency:get` successfully
  resolves `org.jacoco:org.jacoco.agent:0.8.13:jar:runtime` and
  `org.jacoco:org.jacoco.cli:0.8.13:jar:nodeps` (version pinned from
  JaCoCo's GitHub releases page, not Maven Central directly — worth
  double-checking the exact coordinate resolves), confirm the
  `-javaagent:...=destfile=...` flag placement works alongside `-jar` in one
  `java` invocation, and confirm the CLI's `report` command output actually
  matches `parseJacocoXmlReport`'s assumed `<package><sourcefile><line
  nr=... ci=.../></sourcefile></package>` shape.
- **Kotlin**: same JaCoCo pipeline as Java (shared via
  `runJvmCoverageConfirmedLauncher`), plus its own pre-existing unverified
  caveat (no Kotlin compiler available in this session either) — compounds
  with the new coverage piece.

## Correction + fix: Go's coverage-confirmation "Mode A" was already built — the real gap was elsewhere (2026-09-02)

**Correction to the scoping/ranking below**: when ranking Mode A
implementation cost per language, Go was ranked "easiest to build" as if it
needed building. That was wrong — checking the actual code (not assumed)
showed `runGoTestFileForResult`, `parseGoCoverageProfile`, and
`estimateGoBlockEndLine` ([extension.ts:8881](src/extension.ts#L8881),
[extension.ts:3684](src/extension.ts#L3684),
[extension.ts:3716](src/extension.ts#L3716)) already fully implement Go
coverage confirmation — `go test -coverprofile`, parsing the real
`go tool cover` profile format, computing `coverageConfirmed`/
`executedInRange`/`trackedInRange` in the exact same shape Python's
`computePythonTestRunPayload` uses. This was pre-existing, shipped code, not
something this session wrote.

**The actual gap**: `runExistingTestsForResult`
([extension.ts:8217](src/extension.ts#L8217)) — the function powering the
automatic "Existing test(s) found for this change" card (the one this whole
session's UI/badge-hierarchy fixes were about) — was hard-gated to `.py`
files only, unconditionally refusing Go even though the run-and-confirm
logic for Go already existed and worked. Go functions never got the
auto-check at all; the manual "Run" button path (`runGoTestFileForResult`)
worked, but nothing wired it into the automatic discovery-and-confirm flow.

**Fixed**: split `runGoTestFileForResult` into a thin wrapper plus a new
`computeGoTestRunPayload` (returns the payload instead of posting directly),
mirroring the existing `computePythonTestRunPayload` split — exactly the
refactor Python already needed for the same reason. `runExistingTestsForResult`
now accepts `.go` alongside `.py`, and branches per MATCHED test file's own
extension (not the target's) when choosing which run-and-confirm function to
call, since `find_tests` could in principle return a match in a different
language than the target. Also updated the webview-side auto-fire gate
(`fireExistingTestsCheck`, [extension.ts:14023](src/extension.ts#L14023)) and
its tooltip text, both previously hardcoded to Python only. Type-checked
clean (`tsc --noEmit`) after the refactor.

**Still Python+Go only** — Rust/Java/Kotlin/C# still hit the "only supports
Python and Go" error from this same function; extending each of those is
the real remaining Mode A work (per-language coverage tool integration, per
the table below), now that the wiring bug that would have silently affected
them too (a working run-and-confirm function existing but never being
called by the automatic discovery flow) is fixed for the one language where
it already existed.

## Dynamic-coverage test discovery, scoped per language (researched 2026-09-02)

Prompted by researching how real Test Impact Analysis products actually work
(Datadog TIA, Codecov, Launchable — see the market-research findings above/
below this entry once both are in the file) — the industry's proven approach
is dynamic coverage (instrument real test runs, observe what each test
touches), not static call-graph inference. CODEMD already has a working
implementation of the CONFIRMATION half of this, for Python only
(`computePythonTestRunPayloadImpl`, [extension.ts:8671](src/extension.ts#L8671)):
run one already-identified candidate test with `coverage run --branch`,
export `coverage json --include=<targetPath>`, and check the target
function's own `functions.<name>.executed_lines` entry — ground truth from
the tool itself, not a guessed line range. This is Mode A below. Scoping
what extending this to other languages actually takes split into two
genuinely different-sized projects once researched:

### Mode A — per-candidate coverage confirmation (bounded, extends existing pattern)
Run ONE test a static/keyword search already proposed, with coverage
instrumentation, to confirm it actually executed the target's lines —
exactly what Python already does, just per-language. Reuses each language's
EXISTING run-path infrastructure (already built per language, see the
"Language priority" table further down this file) rather than requiring new
architecture:
- **Go** — `go test -run ^TestName$ -coverprofile=X.out` then
  `go tool cover -func=X.out` (or parse the profile directly). Built into
  the stdlib, no extra dependency to install — lowest-friction of the group.
- **C#** — `coverlet` as an added NuGet `PackageReference` inside the SAME
  throwaway test project `runCsharpTestFileForResult`
  ([main.py — see C# run path notes above](TODO.md)) already builds per run
  alongside xUnit — a very natural fit, no new project-creation logic needed.
- **Java/Kotlin** — JaCoCo via a `-javaagent:jacocoagent.jar=...` flag
  wrapped around the SAME direct `javac` + JUnit Console Launcher invocation
  `runJavaTestFileForResult` already does — fits existing infrastructure;
  needs the jacocoagent jar fetched once (same `mvn dependency:get` pattern
  already used for the JUnit launcher jar).
- **Rust** — needs `cargo-llvm-cov` or `cargo-tarpaulin` installed
  (NOT stdlib, unlike Go) — an extra tool the user's environment may not
  have; needs the same graceful "not installed" degradation Python's own
  flow already handles for missing pytest/coverage.py.
- **JS/TS** — blocked on a real gap noted elsewhere in this file: **no
  direct run path exists yet at all** (always the slower Claude-discovery
  route today) — coverage here is two bundled pieces of work, not one:
  build the direct run path first, then add Istanbul/c8/nyc (often built
  into Jest/Vitest's own `--coverage` flag) on top.

**Estimated effort**: small-medium per language, each independently
bounded — no new architecture, just a language-specific coverage tool
wired into a run path that (Go/Java/C#) already exists.

### Mode B — full-suite discovery (the actual "Datadog-style" architecture)
Run the WHOLE test suite once (or incrementally) with PER-TEST attribution,
building a persistent test→covered-function map so "which tests cover X" is
answered directly, without prior static/keyword narrowing at all. This is
the bigger, more ambitious piece — and, confirmed by research, NOT
uniformly available off-the-shelf:
- **Python** — already has the tool support to do this cheaply:
  `coverage.py`'s `dynamic_context = test_function` setting tags every
  covered line with the specific test that caused it, in ONE full-suite
  run. CODEMD isn't using this today (it runs one candidate test at a
  time) — "just" needs a batch-mode implementation on top of a feature
  that already exists.
- **Go, Java/Kotlin, C#, Rust, JS/TS** — confirmed via direct research
  (not assumed): none of the standard tools (Go's stdlib coverage, JaCoCo)
  natively attribute a covered line to the specific test that covered it.
  Getting Mode B here requires either (a) accepting O(n) cost — running the
  full suite once per existing test, i.e. Mode A applied to every test,
  which could be slow for a large suite — or (b) building a custom
  per-test-boundary coverage correlator (e.g. a JUnit `TestExecutionListener`
  that resets/dumps JaCoCo's buffer at each test boundary) — real,
  non-trivial engineering roughly equivalent to what a company like Datadog
  built into its own per-language client libraries.

**Recommendation**: Mode A is the practical near-term target — bounded,
reuses already-built run-path infrastructure, no new architecture per
language. Mode B is a materially bigger, per-language investment with no
off-the-shelf tooling to lean on outside Python; treat as a separate,
later initiative, not bundled with Mode A. Neither started this session —
scope only, per the same "check before building" discipline as the
call-graph-tools research above.

Sources: [Code coverage for Go integration tests](https://go.dev/blog/integration-test-coverage),
[Coverage profiling support for integration tests](https://go.dev/doc/build-cover),
[JaCoCo Coverage Counter docs](https://www.eclemma.org/jacoco/trunk/doc/counters.html),
[How Test Impact Analysis Works in Datadog](https://docs.datadoghq.com/tests/test_impact_analysis/how_it_works/),
[Datadog Test Impact Analysis overview](https://docs.datadoghq.com/tests/test_impact_analysis/).

## Real call-graph tools per language (researched 2026-09-02) — revisit before building more local-var-tracking patches

Prompted by the local-variable-type-tracking partial fix (below): rather than
keep hand-patching the naive qualifier-matchers here, research turned up
real, type-aware call-graph tools for most of these languages — most with a
real engine (often official/vendor-maintained) but no turnkey CLI, meaning
each still needs a small driver program written against it. All of them
require that language's own toolchain/runtime present at analysis time — a
real dependency this repo's current tree-sitter/regex approach doesn't have.

| Language | Best engine | Needs a build? | Turnkey tool available? |
|---|---|---|---|
| Python | pyan3/PyCG (already in use) | No | Yes |
| Go | `golang.org/x/tools/go/callgraph` (official Go team package; CHA/RTA/VTA algorithms, real `go/types` type-checking) | No (Go toolchain only) | Yes, official CLI (`golang.org/x/tools/cmd/callgraph`) |
| Rust | `cargo-callgraph` (built on rust-analyzer internals; ships its own MCP server exposing the callgraph to AI assistants — directly relevant to how CODEMD's own MCP layer works) | No | Yes, actively maintained as of 2026 |
| Java (source-only) | JavaSymbolSolver (merged into JavaParser) — real declared-type resolution from source alone, no build needed | No | Yes (library, needs a driver) — **recommended pick for CODEMD**, matches the current "just read source" model |
| Java (higher precision) | WALA — points-to/context-sensitive analysis, better Java 8 + reflection handling per a 2019 tool comparison | Yes (wants compiled bytecode) | No — the `javacg-wala` CLI wrapper is archived/unmaintained, superseded by an OPAL-based tool |
| Kotlin | Kotlin compiler's own Analysis API (K2/FIR), `analysis-api-standalone` mode — JetBrains explicitly recommends building static-analysis tooling on this; same resolved semantic data IntelliJ itself uses | No | No — needs a custom Kotlin driver program, no off-the-shelf CLI found |
| C# | Roslyn `SemanticModel.GetSymbolInfo()` (`Microsoft.CodeAnalysis`) — the same engine Visual Studio/Rider use for Find-All-References | No | No — small wrappers exist (`RoslynCallGraph`, `Call-Graph-Builder-DotNet`, `Roslyn-Analysis-Tool`) but none showed clear signs of active maintenance/production use; better to build a thin driver directly on Roslyn than depend on one of these |

**Not started, not scoped beyond this table** — a real architecture decision
(trading today's zero-external-dependency tree-sitter/regex approach for
per-language toolchain requirements), not a quick patch. Go is the strongest
candidate to pilot first if this gets prioritized: official tooling,
lowest integration friction, no build-step requirement.

Sources checked: [golang.org/x/tools/go/callgraph](https://pkg.go.dev/golang.org/x/tools/go/callgraph),
[cargo-callgraph](https://crates.io/crates/cargo-callgraph),
[JavaSymbolSolver usage](https://tomassetti.me/resolve-method-calls-using-java-symbol-solver/),
[javacg-wala (archived)](https://github.com/fasten-project/javacg-wala),
[Systematic Comparison of Six Open-Source Java Call Graph Construction Tools (2019)](https://publicatio.bibl.u-szeged.hu/18406/1/JSP19-SystematicComparisonofSixOpen-SourceJavaCallGraphConstructionTools.pdf),
[Kotlin Analysis API docs](https://kotlin.github.io/analysis-api/migrating-from-k1.html),
[RoslynCallGraph](https://github.com/ianphil/RoslynCallGraph),
[Call-Graph-Builder-DotNet](https://github.com/too4words/Call-Graph-Builder-DotNet).

## Java/C#/Go call resolution can't see `instance.method()` calls at all (found 2026-09-02)

**Not a pruning bug** (that was the separate Python fix, done and verified
the same session — see below). This is a structural gap in the call
resolvers themselves for Java (`build_javalang_callgraph`,
`build_tree_sitter_java_callgraph` — [main.py:28239](backend/main.py#L28239),
[main.py:28518](backend/main.py#L28518)), C# (`build_csharp_callgraph`,
[main.py:30337](backend/main.py#L30337)), and very likely Go
(`build_tree_sitter_go_callgraph`, [main.py:28902](backend/main.py#L28902) —
same operand-as-literal-text pattern spotted at the call site, not
independently proven with a synthetic repro the way Java was), Rust, and
Kotlin (not checked).

**Proven, not guessed**: built a synthetic Java project (`Calculator.add`
called from `CalculatorTest.addition_isCorrect` via
`Calculator calculator = new Calculator(); calculator.add(2, 2);` — the
single most common Java pattern there is) and ran the real
`build_javalang_callgraph` against it. Result: **zero edges.** Root cause —
these resolvers treat a call's qualifier (`calculator`) as if it were
already a class name, with no tracking of what type a local variable
actually is:
- javalang path: only resolves same-class calls or `qualifier.method()`
  when `qualifier` is a literal, exact key in `user_methods`
  ([main.py:28376-28385](backend/main.py#L28376-L28385)).
- tree-sitter Java path: same idea, plus an explicit
  `qualifier[:1].isupper()` gate ([main.py:28663](backend/main.py#L28663)) —
  a deliberate "only guess when it looks like a class name" heuristic, which
  by construction skips every lowercase-named variable.
- C#: `by_class_method.get((qualifier, call_name))`
  ([main.py:30430-30431](backend/main.py#L30430-L30431)) — qualifier is the
  raw regex-captured text, same literal-match-only limitation.

Python doesn't have this problem — it uses `pyan3`/PyCG, a real
call-resolution library with actual data-flow analysis, not a hand-rolled
qualifier matcher. That's the whole reason the Python test-node fix (below)
was a pruning fix, not a resolution fix: the edges already existed correctly
and were being deleted; here, most edges of this shape never get created in
the first place. This affects test-finding specifically hard, since almost
every JUnit/xUnit/testify test does `Type var = new Type(...); var.method();`
— but it's not test-specific: ordinary production code calling instance
methods on local variables is equally invisible to these callgraphs today.

**Full fix = real per-language type inference** (multi-day, higher risk of
false-positive edges if rushed) — explicitly declined for now, scope judged
too large for a same-session follow-up.

**Cheaper partial fix — DONE for Java (2026-09-02), same recipe available for
C#/Go/Rust/Kotlin when prioritized.** Implemented in both Java resolvers
([main.py:28239](backend/main.py#L28239) `build_javalang_callgraph`,
[main.py:28586](backend/main.py#L28586) `build_tree_sitter_java_callgraph`):
scan each method/constructor body for simple `Type name = new Type(...)` /
`Type name = ...;` local-variable declarations, build a small `name -> Type`
map scoped to that ONE method (reset fresh per method, no cross-method or
cross-scope leakage), and consult it — falling back to nested-class
disambiguation via a `simple_class_index` (unique-match only, stays silent
on ambiguity) — before the original literal-qualifier heuristics. Explicitly
does NOT track fields (`this.service.doThing()`), constructor/method
parameters used as the qualifier, interface-typed variables resolved to an
implementation, builder chains, or flow across more than one local
declaration — a bounded approximation, not real type inference.

Verified, not assumed:
- Built a synthetic repo (`Calculator.add` + `CalculatorTest` calling it via
  `Calculator calculator = new Calculator(); calculator.add(2,2);`) — before
  the fix, zero edges; after, the edge resolves correctly in both the
  javalang path AND (once the separate SKIP_DIRS bug below is also
  accounted for) the tree-sitter path.
- Real repo (OmTabletApp, Java Android app): javalang edge count rose
  275 → 326 (+51, ~19%) on the exact same source, no new parse errors, no
  regressions.
- Confirmed the edge survives `build_merged_java_outputs`'s union merge
  ([main.py:32510](backend/main.py#L32510)) into `java_merged_callgraph.json`
  — which is what feeds `combined_callgraph.json`, which is what
  `find_tests`'s graph traversal actually reads — so this isn't just an
  isolated-function fix, it reaches the real end-to-end pipeline.

**Separate, more fundamental bug found along the way — FIXED (2026-09-02)**:
`SKIP_DIRS` ([main.py:348](backend/main.py#L348)) used to contain `"tests"`,
`"test"`, `"__tests__"` — and `iter_supported_repo_files`
([main.py:413](backend/main.py#L413)), which every tree-sitter-based
callgraph builder shares (Java at
[main.py:28710](backend/main.py#L28710), Go
[main.py:29095](backend/main.py#L29095), Rust
[main.py:29183](backend/main.py#L29183), Kotlin
[main.py:29267](backend/main.py#L29267)), skipped entire directories
matching that set during file discovery — meaning any project using the
standard `src/test/java/...`-style layout (i.e. nearly every real
Java/Maven/Gradle project) never had its test files even READ by these
builders, independent of call-resolution quality. Compounding this: `.codemd`
is also in `SKIP_DIRS` (for a legitimate reason — most of `.codemd/` really
is internal tool artifacts, not application source), which meant
`.codemd/generated_tests/` — CODEMD's own home for Claude/Codex-generated
tests — was doubly invisible even after removing "tests" alone from the set.

Checked every other caller of `should_skip_path` before changing shared
behavior (API-route detection, text search, feature-catalog reference
linking) — none of them rely on tests being hidden for a real reason.

**Fix**: added `is_test_directory_name()` ([main.py:363-388](backend/main.py#L363-L388))
— a dedicated, always-wins check (evaluated before `SKIP_DIRS` membership,
so it overrides even an otherwise-skipped ancestor like `.codemd`) covering:
- exact names: `test`, `tests`, `__tests__`, `__test__`, `spec`, `specs`,
  `unittest(s)`, `unit_test(s)`, `integration_test(s)`,
  `generated_tests` (CODEMD's own convention)
- a delimited suffix on a compound/project name — .NET's convention is a
  whole sibling project directory named `<Project>.Tests` or
  `<Project>.IntegrationTests`, not a bare `tests` folder — matched only
  when `test(s)`/`spec(s)` follows a real delimiter (`.`/`_`/`-`) or is the
  entire segment, so `latest`, `contest`, `digest`, `protest` are correctly
  left alone.

Verified, not assumed: a 13-case table covering every convention above
(including the .NET suffix cases and the false-positive-risk words) all
matched correctly; re-ran the tree-sitter Java synthetic repro from the fix
above — `files_seen` went from 1 (test file silently skipped) to 2, with the
correct `CalculatorTest.addition_isCorrect → Calculator.add` edge now
resolving independently via the tree-sitter path too (previously only
reachable via javalang's separate unfiltered walk); spot-checked Go
(`tests/main_test.go`) and TS (`__tests__/foo.test.ts`) directly against
`iter_supported_repo_files` to confirm the fix isn't Java-specific — both now
included where they were silently dropped before.

## Python: test functions were being deleted from the callgraph entirely (fixed 2026-09-02)

`root_graph_at_entrypoint` ([backend/parsers/python/python_analyzer.py](backend/parsers/python/python_analyzer.py))
pruned the callgraph to only nodes reachable *forward* from app entrypoints
(`main`/`app`/`run`/etc.) — test functions are graph roots (they call into
the app; nothing calls them back), so every test node was being silently
deleted as "unreachable," even though `pyan3` had already resolved real
`test → target` call edges correctly. Fixed: test-file functions (detected
by path segment, matching `tests`/`test_*`/`*_test`/`.codemd/generated_tests`
conventions — pyan3 joins path segments with `__`, so this needed matching
the node's OWN path segments, not exact-key lookup against the separately-
built dotted-name `symbol_index`) are now added as additional graph roots
alongside the app entrypoints. Verified directly against a real repo
(CodeVal): 197 real `tests/` nodes and 28 `.codemd/generated_tests/` nodes
now survive that previously vanished entirely, with confirmed
`test → target` edges (e.g.
`tests__test_daily_commit_snapshot_persistence__...__test_compact_daily_change_payload_for_snapshot_keeps_drift_metadata → main`).
`codemd-mcp-server.js`'s `findTests` ([scripts/codemd-mcp-server.js](scripts/codemd-mcp-server.js))
now does a real backward-BFS over this graph first (`method: 'callgraph'`,
confirmed), falling back to the old keyword-text scan only when no graph
node resolves (`method: 'keyword'`, explicitly flagged unconfirmed in its
`note`). UI: `renderExistingTestsCard` in `src/extension.ts` no longer shows
a green ✓ for a test CODEMD has already proven (via coverage tracing) does
NOT exercise the change — that case now shows a neutral "○ Not relevant to
this change" badge, collapsed into a "N other test(s) checked" toggle
instead of sitting as a top-level row.


## "Set up test runner" installs at the workspace root, not the target monorepo package (flagged 2026-08-31)

Found while fixing a related, more urgent bug: `detectJsTestRunner`
([extension.ts:2756](src/extension.ts#L2756)) only checked
`folder.uri.fsPath/package.json` (the VS Code workspace root), so in a
monorepo where only one sub-package has a test runner (confirmed live
against `dtc-starter`, a pnpm/Turborepo workspace: only `apps/backend` has
Jest; `apps/storefront` has none, but the *root* `package.json` has
`"test": "turbo test"`, which reads as "found" for the whole repo), a
storefront file's Run/generate-test flow wrongly concluded a runner already
existed and skipped straight to a slow Claude-driven discovery/fix cycle
instead of offering the free "⚙ Set up test runner" button. **That part is
fixed** — detection now walks up from the actual target file's directory to
the workspace root, nearest package.json wins, and a root-only "test"
script that just delegates to `turbo`/`pnpm -r` no longer counts as a real
answer for a specific package.

**Not fixed, left as a gap**: `setUpJsTestRunnerForResult`
([extension.ts:7941](src/extension.ts#L7941)) and `selectJsTestRunner`
([extension.ts:2869](src/extension.ts#L2869)) still always run
`npm install --save-dev ...` and write the config file at
`folder.uri.fsPath` (the workspace root), never at the sub-package the
target file actually belongs to. In a single-package repo this is a
non-issue (root *is* the right place). In a pnpm/yarn/npm-workspaces
monorepo it's a real correctness gap:
- Plain `npm install` in a pnpm-managed repo can create a stray
  `package-lock.json` alongside `pnpm-lock.yaml` — confusing if committed.
- The installed runner/config sits at the wrong level and isn't guaranteed
  to be visible to or used by the actual target package's own tooling.
- Separately (found while assessing this, not part of the same fix):
  `selectJsTestRunner`'s Jest plan hardcodes `testEnvironment: 'node'` and
  installs only `['jest', 'ts-jest', '@types/jest']` — no `jsdom` and no
  `@testing-library/react` — so even a correctly-scoped install wouldn't by
  itself make a React/DOM component test (e.g. dtc-starter's
  `OptionsPicker`) runnable. That's a second, distinct gap from the
  install-location one.

**Severity: medium, not urgent.** Opt-in (only fires on an explicit button
click, never automatically), and today's fix already prevents the actively
bad outcome (a 220s Claude flail ending in a misleading "not logged in"
error). Revisit when monorepo support for JS/TS test generation is actually
prioritized — needs its own design pass (detect the package manager,
install scoped to the right sub-package, decide whether/how to add
jsdom + testing-library when the target looks like a React/DOM component)
rather than a quick patch on top of this fix.

## Go, Rust, Kotlin — DONE (2026-08-31): backend parsers built + verified, full pipeline wired

Implemented the scope below in priority order (Go → Rust → Kotlin), and —
unlike the Java/C#/JS-harness work, which had no JDK/.NET/npm available to
truly test against — **actually built and verified working tree-sitter
parsers for real**, since `tree-sitter-go`/`tree-sitter-rust`/`tree-sitter-kotlin`
are all real, installable PyPI packages (confirmed via `pip index versions`
before starting) and this sandbox has internet + a Python environment.

**Real finding along the way**: `backend/main.py` already *attempts* Go/Kotlin
coverage via Joern (`should_try_joern` already lists them) — but the code
treats "Joern executable was not found" as a routine, info-level outcome,
not a warning, meaning Joern is an optional, often-absent bonus path, not
reliable baseline coverage. Confirmed with the user directly: Joern is a
known-hard-to-install heavyweight parser, deliberately not wired up now —
**its own proper setup is a separate TODO for another date**, not something
to depend on. Built the same always-available, pip-only tree-sitter approach
Java/JS/Python already use instead, which needs no external binary.

**Backend (`backend/main.py`)** — for each language: read real node types
directly (built a throwaway venv, installed the grammars, dumped parse
trees against real sample source — not guessed), wrote `build_tree_sitter_go_callgraph`/
`_rust_callgraph`/`_kotlin_callgraph` following `build_tree_sitter_java_callgraph`'s
exact shape, and **verified each one for real** by extracting the actual
inserted source from `main.py` and executing it against sample repos (not a
hand-copied reimplementation — the literal transplanted code), catching and
fixing one real bug along the way (Go's method receiver type wasn't being
read correctly — parameter_declaration's `type` field, not a direct child of
the receiver's parameter_list). All three now produce correct, resolved
call edges (stdlib/third-party calls correctly excluded, only real
user-to-user function calls kept), confirmed against real output:
- Go: `main.Server.Start -> main.Server.init`, `main.main -> main.NewServer`, etc.
- Rust: `Server::start -> Server::init`, `Server::init -> utils::helper`, etc.
- Kotlin: `Server.start -> Server.init`, `main -> Server.Companion.create`, etc.

Shared three new helpers across all three builders instead of tripling the
logic: `_generic_tree_sitter_language` (grammar loader), `_resolve_generic_language_calls`
(the same-owner-first-then-unique-global-name-match resolution strategy,
mirroring Java's own approach — found and fixed a real bug here too: Rust
mixes `.` and `::` separators in callee text even within one file, so the
resolver splits on whichever produced the callee rather than assuming one
fixed separator per language), and `run_generic_tree_sitter_callgraph_isolated`
(the same subprocess-with-timeout isolation Java's own worker uses, shared
instead of three near-identical copies). Wired into the main pipeline
(`if lang_map["go"]:` etc., mirroring the C# integration point exactly),
the combined-callgraph merge (`combined_callgraph_source_paths`), and
`backend/requirements.txt`.

**Extension host (`src/extension.ts`)** — same recipe as Java/C#, now proven
four times: `TestLanguage` includes `'go' | 'rust' | 'kotlin'`; `testLanguageFor`,
`callgraphArtifactFor`, `testFrameworkNounFor`, `generatedTestExtFor`, and the
5 language-list error messages all updated. New `goImportHint` (reads
go.mod's `module` directive + the file's own `package` declaration — needed
since a generated test lives outside the module's normal tree) and
`rustImportHint` (crate name from Cargo.toml + a best-effort module path
from the file's location under `src/`, honestly caveated the same way this
extension's existing Rust run-path already is, since Rust's real module
tree isn't always file-structure-mirrored). Kotlin reuses `javaImportHint`
verbatim — its `package` syntax is identical to Java's. Confirmed Kotlin
does NOT need Java's filename-must-match-class-name handling (a real Java
compiler rule Kotlin doesn't share) — `generatedTestFileNameFor` needed no
Kotlin branch. Go does need special naming (`_test.go` suffix, Go tooling's
own discovery convention) — handled for free by `generatedTestExtFor`
returning the full `_test.go` suffix rather than needing a new branch in
`generatedTestFileNameFor`, since the existing `test_<prefix><ext>` pattern
already produces a valid `test_chain_foo_test.go`-shaped name.

**Run path**: Go/Rust reuse their pre-existing `runGoTestFileForResult`/
`runRustTestFileForResult` unchanged (already built, already in
`DIRECT_RUN_EXTS`, before this session started) — the callgraph was their
only real gap, confirmed. Kotlin got a new `runKotlinTestFileForResult`,
a template copy of Java's Maven-only run path with `kotlinc` swapped in for
the compile step (everything else — classpath resolution, JUnit Platform
Console Launcher execution — is identical, since JVM bytecode is JVM
bytecode regardless of which compiler produced it).

**Harness install**: Go/Rust need none (confirmed, no framework choice
exists). Kotlin needed none *newly built* either — `setUpTestRunner`'s
dispatch now routes `'kotlin'` straight to the existing
`setUpJavaTestRunnerForResult` unchanged, since a Kotlin/Maven or
Kotlin/Gradle project uses the identical pom.xml/build.gradle files and
JUnit 5 coordinate as a Java one.

**Honest caveats carried forward**: Go/Rust/Kotlin's run paths (like Rust's
original one, and Java's/C#'s from earlier) could not be empirically
verified against a **real project with a real toolchain** in this sandbox —
only the backend parsers themselves were fully verified for real (this
sandbox does have Python + internet, unlike JDK/.NET/Go/Rust/Kotlin
compilers). Should be checked against real projects before relying on any
of the three run paths in production.

## Kotlin, Rust, Go — full scope across every piece (2026-08-31)

Requested cross-check against every piece of the pipeline, not just
callgraph/run — checked each before writing anything below.

### Callgraph
- **Go, Rust**: nothing exists (confirmed earlier: zero `go_ordered_call_sequence`/
  `rust_ordered_call_sequence`-style matches in `backend/main.py`). Needs a new
  `build_tree_sitter_go_callgraph`/`build_tree_sitter_rust_callgraph`, following
  `build_tree_sitter_java_callgraph`'s exact shape (`backend/main.py:28512`) —
  mature, well-documented grammars for both (`tree-sitter-go`, `tree-sitter-rust`).
- **Kotlin**: nothing exists either, but (per the earlier deep-dive) it's "a new
  function, same shape" — `write_ordered_call_sequence`, artifact conventions,
  and the combined-callgraph merge are 100% reusable; only the
  `class_types`/`method_types`/`call_types` node-type sets and
  `resolve_call_name` need a `tree-sitter-kotlin`-specific rewrite (not yet
  inspected against that grammar's actual node names).

### SCIM (semantic search / feature-catalog index) — checked `backend/scim.py` directly
**Better off than callgraph**: `.go`, `.rs`, `.kt`/`.kts` are **already** in
`CODE_SOURCE_EXTENSIONS` (`backend/scim.py:76-95`) and already get indexed —
`codemd_semantic_search` and the feature catalog already see code in all
three languages today, independent of whether a callgraph exists. The
caveat: only `.java` and `.py` (and JS/TS, via `extract_js_ts_class_method_chunks`)
get a **dedicated** per-language extractor; Go/Rust/Kotlin fall through to
`generic_declaration_chunks` (`backend/scim.py:1021`) — a regex
(`GENERIC_DECLARATION_RE`) matching `name { ... }`-shaped declarations via
brace-counting. Works reasonably for brace-delimited languages (all three
qualify) but won't handle language-specific declaration shapes as precisely
as a dedicated extractor would (e.g. Go's `func (r *Receiver) Method()`
receiver syntax, Rust's `impl` blocks) — a real but secondary gap, not a
blocker. **No action needed to get baseline SCIM coverage — it's already
there.** A dedicated extractor per language would be a quality upgrade, not
a from-scratch build, and is lower priority than the callgraph gap since
callgraph is what generation/call-path features actually depend on.

### Test execution (run path)
- **Go, Rust**: already built (`runGoTestFileForResult`/`runRustTestFileForResult`)
  — reused as-is once a callgraph exists to point generated tests at. Rust's
  own implementation still carries its original "not empirically verified,
  no rustc/cargo available" caveat from before this session.
- **Kotlin**: not built, but heavily template-reusable from
  `runJavaTestFileForResult` — identical Maven/Gradle detection
  (`findJavaBuildRootDir` already generic, not Java-named-but-Java-only), same
  javac→**kotlinc** swap for the compile step, same JUnit Platform Console
  Launcher execution (JUnit runs compiled Kotlin test classes unchanged —
  bytecode is bytecode). Genuinely new code, but following an exact template
  rather than solving a new problem.

### Test creation (generation)
All three need the same plumbing pass Java/C# already got:
`TestLanguage` union member, `testLanguageFor` (`.go`/`.rs`/`.kt`+`.kts`
detection), `callgraphArtifactFor` (relPath/key once each backend parser
exists and its output path is known), `importHintFor` (Go: package path from
directory + `package` clause; Rust: module path from `mod`/crate structure;
Kotlin: reuses `javaImportHint`'s exact logic, Kotlin's `package` declaration
syntax is identical to Java's), `testFrameworkNounFor` (Go: `"go test" with
table-driven subtests, this project's own convention` — Go has no framework
choice at all, unlike every other language, since testing is stdlib;
Rust: `"cargo test" with #[test] functions`, same built-in-only situation;
Kotlin: reuses Java's JUnit 5 noun verbatim), `generatedTestExtFor`
(`_test.go` — Go's compiler-enforced suffix convention, closer to Java's
constraint than C#'s freedom; `.rs`; `.kt`), and the 4 generators' error
messages. `generatedTestFileNameFor` needs a Go-specific branch (Go requires
files named `*_test.go`, similar constraint class to Java's
filename-must-match-class-name, though the rule itself is simpler — suffix
only, no identifier-matching needed).

### Test harness install button
- **Go, Rust**: **never needed** — confirmed, no framework choice exists to
  make (`go test`/`cargo test` are the toolchain, not a package to add). No
  `detectXTestRunner`/`setUpXTestRunnerForResult` pair to build, ever.
- **Kotlin**: **reuses Java's entirely, unmodified** — same pom.xml/build.gradle
  files (a Kotlin Maven/Gradle project still uses `pom.xml`/`build.gradle`,
  just with `kotlin-maven-plugin`/the Kotlin Gradle plugin applied), same
  JUnit 5 coordinate, same `detectJavaTestRunner`/`insertMavenJUnitDependency`/
  `insertGradleJUnitDependency` functions work as-is for a Kotlin repo. At
  most needs `detectJavaTestRunner`'s file-existence check widened to accept
  a Kotlin-flavored build file if one somehow differs (unconfirmed either
  way — likely a non-issue, Kotlin/JVM projects use identical Maven/Gradle
  file formats).

### "Fix with Claude" button
**Already fully ready for all three, zero new work — checked, not assumed.**
`fixTestFailureForResult` has no language gate at all (confirmed: absent from
every `testLanguageFor` call site) — it works by asking Claude to discover
the run command dynamically via Read/Grep/Glob/Bash, and its `--allowedTools`
list (`backend`… no, `extension.ts:8784`) **already explicitly includes**
`Bash(go test*)`, `Bash(go get*)`, `Bash(cargo test*)`, `Bash(gradle *)`,
`Bash(gradlew*)`, `Bash(./gradlew*)` — Go, Rust, and Gradle-based Kotlin are
all already covered by the existing tool allowlist. Nothing to build here.

### What's actually left, per language, in priority order
1. **Go** — backend callgraph parser (the only real gap: run path, harness
   [n/a], and Fix are all already done or unneeded) → plumbing pass →
   `generatedTestFileNameFor`'s `*_test.go` branch.
2. **Rust** — same shape as Go: backend callgraph parser → plumbing pass. Run
   path exists but should get its "unverified" caveat resolved against a
   real crate at some point.
3. **Kotlin** — backend callgraph parser (new function, Java's shape, new
   grammar) → plumbing pass → run path (new code, but an exact template
   copy of Java's with `kotlinc` swapped in) → harness install (near-zero,
   reuses Java's functions directly). The most total work of the three, but
   most of it is "copy an already-proven pattern," not new design.

None of the three need SCIM work (already covered) or Fix-with-Claude work
(already covered) — the checklist that matters is callgraph → plumbing → run
→ (Kotlin only) harness reuse.

## NEXT SESSION (flagged 2026-08-31): telemetry — are generated tests catching real bugs?

User wants to instrument the extension (VS Code's telemetry conventions —
`@vscode/extension-telemetry`, which wraps Azure Application Insights) to
measure whether CODEMD-generated tests actually catch bugs in the projects
users install it on, across the install base, not just this repo.
**Before wiring any real event points, this needs a privacy-design decision
from the user**: what's safe to send — aggregate counts only (e.g. "a
generated test initially failed against current code") vs. anything more
granular — and a hard guarantee of never transmitting actual code, diffs, or
file contents, since this is telemetry about other people's private repos.
Scaffolding (dependency, a reporter wrapper that respects VS Code's global
`vscode.env.isTelemetryEnabled` opt-out per Marketplace policy) can be added
without a real key first — the actual connection string comes from an Azure
Application Insights resource (Azure Portal), not from the VS Code
Marketplace publisher account, which is worth clarifying if that was the
mental model. Not started; flag this at the start of the next session rather
than deciding the data-scope question unilaterally.

Source: analysis of "impact-driven verification" pipeline (classify change →
determine failure modes → build impact graph → find highest-risk call paths →
select existing tests + generate missing → run → verify execution →
mutation-check → PASS). Cross-checked against the actual codebase on
2026-08-28 — most early/late pipeline stages already exist; the gap is
narrower than a green-field build. Items below note what's already shipped
(kept for reference, not to redo) vs genuinely missing.

## Already shipped (don't rebuild — extend)

- Change classification: `ChangeCard.kind` (added/modified/removed/files/blastRadius),
  `signatureChanged`/`breaking`/`cosmeticOnly` flags.
  [src/extension.ts:3385](src/extension.ts#L3385)
- Impact graph + statically-proven broken call sites (`check_call_sites` in
  `deletion-report.py`), not guessed.
- Call-path test generator for two functions changed together on the same
  call chain (`generateCallChainTestForResult`) — this is the exact
  checkout→build_order→calculate_price scenario from the analysis.
  [src/extension.ts:6353](src/extension.ts#L6353)
- Contract test generator, one test per statically-proven broken caller
  (`generateContractTestForResult`). [src/extension.ts:6424](src/extension.ts#L6424)
- New-function test generator (`generateNewFunctionTestForResult`).
  [src/extension.ts:6288](src/extension.ts#L6288)
- Broad-coverage test generator, one test per distinct calling pattern across
  fan-in (`generateBroadCoverageTestForResult`). [src/extension.ts:6495](src/extension.ts#L6495)
- Test execution via pytest. [src/extension.ts:6626](src/extension.ts#L6626)
- Execution-coverage verification via `coverage.py --branch` — confirms
  changed lines actually ran, not just that the test passed.
  [src/extension.ts:6771](src/extension.ts#L6771)
- Static test discovery ("what test file covers X") via `codemd_find_tests`
  MCP tool. [scripts/codemd-mcp-server.js:2046](scripts/codemd-mcp-server.js#L2046)

## Design rule: automatic vs manual

Anything that shells out to the Claude CLI (all four existing test
generators, and any future one) **must stay behind an explicit user click** —
never auto-triggered — because each call costs real money. Anything that's
pure static analysis or local test execution with no Claude call (test
discovery, running an already-existing test file, the verdict card, item 5's
entry-point set-intersection) has no such constraint and can run
automatically. Applies to items #2, #3, and #5 below, and to any future item.

## Not started

**Status (2026-08-28): deferred.** Current priority is shipping/stabilization
and fixes only — none of items 1-5 are being implemented right now. Items 2-5
below carry a concrete design (file:line references into the current code) so
a future session can start straight from implementation instead of
re-deriving the approach. Full design detail also sits in the plan-mode
artifact from that session (`floating-wiggling-milner.md`) if more context is
needed than what's summarized here.

### 1. Mutation testing on changed lines (deferred — needs its own safety design)
Mutate only the diff hunk (not the whole file/repo, to stay fast) — flip
comparisons, negate booleans, drop return values — then run existing +
generated tests against the mutant and report a mutation score. This is the
only signal that proves a test would actually catch a regression rather than
just executing the line. No code for this exists anywhere in the repo today.
**Explicitly declined** in the 2026-08-28 session: it requires transiently
editing the real source file to inject each mutant, and the user chose not to
accept any of the file-safety tradeoffs discussed (backup+crash-recovery
restore, a confirmation dialog, or a fully isolated temp-copy approach that
avoids touching the real file at all). Needs its own scoping conversation
before starting, specifically about which safety posture to use.

### 2. Run existing tests found by `codemd_find_tests`, not just discover them — DONE (2026-08-28)
Implemented: `runExistingTestsForResult` in `src/extension.ts` (near
`runFindTestsForResult`) does the `find_tests` CLI lookup, then runs
`computePythonTestRunPayload` per matched file (top 3, in parallel). No
Claude call, so per the automation rule it fires automatically the first
time a modified/added function's card renders (`existingTestsRequestedSymbols`
guards against re-firing on every auto-refresh) rather than behind a button.
Results render as pill rows and feed `generatedTestsBySymbol` under a
`#existing` suffix key, which item 3's verdict card reads.

### 3. Unified verdict/summary card — DONE (2026-08-28)
Implemented, generation + run + existing-tests slice (all of item 3's
original scope): `computeVerdictForSymbol`/`renderVerdictCardContent`/
`updateVerdictCard` in `src/extension.ts`, reading `generatedTestsBySymbol`
(all four generator keys plus the new `#existing` key) and the new
`testRunsBySymbol` store (populated from `testRunResult`). Renders a
`.verdictCard` per changed function in `appendResultItem` with a
LOW/MEDIUM/HIGH label, auto-updating whenever a relevant result arrives — no
button. Along the way, fixed a real gap: the call-chain test generator
wasn't threading a `symbolKey` through at all, so its tests were never
recorded in `generatedTestsBySymbol` — the verdict card would have silently
undercounted them. Not done: mutation score input (item 1 is still
deferred), so HIGH confidence currently means "ran, passed, coverage
confirmed" without a mutation-score component.

### 4. Numeric risk score to replace arbitrary caps
`generateBroadCoverageTestForResult` currently caps callers at
`callers.slice(0, 8)` ([src/extension.ts:6508](src/extension.ts#L6508)) with
no ranking (same arbitrary cap also at [src/extension.ts:6047-6048](src/extension.ts#L6047-L6048)).
Replace with a score so the highest-risk callers/paths get a generated test
first when there are more opportunities than budget allows. Design: new
`computeRiskScore(change, index)` near the existing `impactScoreForModifiedChange`
([src/extension.ts:3599](src/extension.ts#L3599)) — reuse its formula
(`directCallers*20 + impactedNodes*8 + impactedFiles*12 + lowConfidenceEdges*2`),
×2 if `callSiteIssuesFromChange` is non-empty, plus a new `fanOut` map built
the same way the existing `fanIn`/`degree` maps already are in
`loadLocalCallgraphIndex` ([src/extension.ts:2059-2102](src/extension.ts#L2059-L2102)).
Wire into `findSameCommitCallChains`'s pre-sort
([src/extension.ts:2804](src/extension.ts#L2804)) and both `.slice(0, 8)` caps.
**Explicitly out of scope even when this is picked up**: git-history churn —
no existing precedent in the codebase, meaningful new scope on its own.

### 5. Entry-point-to-change tracing
`findSameCommitCallChains` ([src/extension.ts:2764](src/extension.ts#L2764))
only finds call-path opportunities where **both** functions changed in the
same diff. It doesn't trace from a true entry point (HTTP route, CLI command,
scheduled job) through unmodified intermediate functions down to the changed
one. Turns out `combined_callgraph.json` already has an `entry_points` array
(built by `collect_combined_entry_points`, `backend/main.py:8199` — Flask/
FastAPI routes, JAX-RS/Spring annotations, JS route registrations) and
`get_impact_radius` (`backend/features/core/helpers.py:1007`) already does an
unbounded backward BFS per changed symbol — so this is a set-intersection of
data already computed, not a new traversal. Also needs a `call_paths` arm
added to `codemd-mcp-server.js`'s one-shot `--cli` dispatcher
([scripts/codemd-mcp-server.js:2259-2266](scripts/codemd-mcp-server.js#L2259-L2266)),
mirroring the existing `find_tests` arm, so `extension.ts` can fetch the real
path the same way `runFindTestsForResult` already fetches test matches. No
CLI/cron entry-point detection exists yet (only HTTP routes + `main`/`handler`
functions) — worth noting if CLI-triggered changes matter for this repo.

### 6. Test-family gaps not yet distinct generators — PARTIALLY DONE (2026-08-28)
Return-value-propagation and exception-propagation coverage folded into the
existing `generateContractTestForResult` and `generateCallChainTestForResult`
prompts (one added sentence each, asking Claude to consider a changed return
shape, a newly raised exception, or boundary/null inputs where relevant) —
no new generator functions, per the original plan to avoid duplicating
`runClaudeTestGeneration`'s subprocess/parsing boilerplate. Downstream
side-effect coverage was not added (harder to fold into a one-sentence
prompt addition without more context on what "side effect" means per
function) — still open if it turns out to matter in practice.

## Language expansion: Java, Ruby (scoped 2026-08-31)

Prompted by building the JS/TS "Set up test runner" opt-in action (deterministic
Vitest/Jest selection + install, no Claude call to choose the framework —
[extension.ts:2767](src/extension.ts#L2767)) and live-verifying it actually
runs a real generated test. Before doing the same for another language, checked
whether the callgraph it would depend on actually exists — same question the
user raised about JS/TS before trusting any of this. Answer differs sharply
per language, so they're scoped separately below rather than as one item.

### Java — DONE (2026-08-31): plumbing + run path + harness install all implemented
Implemented all three pieces scoped below in the same session. Honest caveat
carried over from the existing Rust runner's own precedent: the Maven/JDK
pipeline (`runJavaTestFileForResult`, `setUpJavaTestRunnerForResult`) could
**not** be empirically verified against a real Maven project — no JDK/Maven
available in this dev environment. The text-insertion logic
(`insertMavenJUnitDependency`/`insertGradleJUnitDependency`,
`javaTestClassNameFor`) was verified standalone via plain Node against
realistic sample pom.xml/build.gradle text and all produced correct,
well-formed output — but the actual `mvn`/`javac`/`java` subprocess chain in
`runJavaTestFileForResult` follows documented conventions, unverified live.
Should be checked against a real Maven project before relying on it in
production, same as the Rust runner.
- **Plumbing** (all in [extension.ts](src/extension.ts)): `TestLanguage` now
  includes `'java'`; `testLanguageFor`, `callgraphArtifactFor`,
  `importHintFor` (reads the file's own `package` declaration),
  `testFrameworkNounFor`, `generatedTestExtFor` all have a Java arm.
  `topLevelModuleFor` and `findCallersOf`/`resolveCallSites` needed no
  changes, confirmed already generic. `findSameCommitCallChains`'s
  `languagesPresent` set picks Java up automatically, no change needed
  either — confirmed by reading it, not assumed. New
  `generatedTestFileNameFor`/`javaTestClassNameFor` centralize Java's
  compiler-mandated "filename must equal public class name" naming (e.g.
  `chain_findCallersOf_callgraphArtifactFor` → `ChainFindCallersOfCallgraphArtifactForTest.java`),
  replacing the four generators' + `existingCallChainTestFile`'s previously-duplicated
  `test_<prefix>.<ext>` naming; `generatorKindFromTestFileName` recognizes
  both conventions. New `javaClassNameInstruction` tells Claude the exact
  required class name in each of the four generation prompts (call-path,
  call-chain, new-function, broad-coverage — contract stays Python-only,
  unaffected, confirmed by reading its own hardcoded `.py` gate).
- **Run path**: `runJavaTestFileForResult` — Maven only (Gradle detected and
  reported as "not yet supported" rather than guessed at). Since a generated
  test lives in `.codemd/generated_tests/`, not `src/test/java` where Maven's
  own test phase looks, this compiles the one file directly with `javac`
  against the real dependency classpath (`mvn dependency:build-classpath`)
  plus the project's own compiled classes, then executes it with the JUnit
  Platform Console Launcher (fetched once via `mvn dependency:get` into the
  normal `~/.m2` cache) — the standard, documented way to run one ad-hoc
  JUnit 5 class outside a full build, sidestepping needing to rewrite
  pom.xml's test-source roots at all.
- **Harness install**: `setUpJavaTestRunnerForResult` — one fixed coordinate
  (`org.junit.jupiter:junit-jupiter:5.10.2`, JUnit 5 has no Jest-vs-Vitest
  ambiguity to resolve), a real text edit to pom.xml/build.gradle (not a
  silent side effect), verified via `mvn dependency:resolve` (or `gradle
  dependencies`) afterward — reverts the edit if that fails, same as npm
  install actually downloading something being the real verification step
  for JS/TS. Gradle also gets `test { useJUnitPlatform() }` added, since
  Gradle (unlike Maven Surefire) doesn't auto-detect JUnit 5 from the
  dependency alone.
- **Not done**: Gradle direct-run (classpath extraction isn't a one-liner
  the way Maven's `dependency:build-classpath` is — would need its own
  design pass); Java code coverage (would need JaCoCo + a javaagent flag,
  same "best effort, no coverage tool wired up yet" tier Go/Rust already
  honestly report when their own coverage tool is missing).

<details>
<summary>Original scoping notes (2026-08-31), kept for reference</summary>

**Already shipped, nothing to build:** `build_tree_sitter_java_callgraph`
(`backend/main.py:28512`) produces `tree_sitter_java/tree_sitter_java_callgraph.json`
via a real tree-sitter grammar, same per-call shape as JS
(`{caller, callee, file, line, call_text}`) through the shared
`write_ordered_call_sequence` (`backend/main.py:16528`), also emitting
`tree_sitter_java_ordered_call_sequence.json`, and merged into the combined
callgraph pipeline alongside python/javascript (`backend/main.py:34401`).

**Missing — extension-host generation/run pipeline.** Everything currently
branches on `TestLanguage = 'python' | 'javascript'` at exactly these points,
each needing a third arm:
- `testLanguageFor` ([extension.ts:2703](src/extension.ts#L2703)) — detect `.java`.
- `callgraphArtifactFor` ([extension.ts:2843](src/extension.ts#L2843)) — point at
  `tree_sitter_java/tree_sitter_java_ordered_call_sequence.json`, key `'calls'`
  (JS's convention, not Python's `'ordered_calls'` — confirmed via the shared
  `write_ordered_call_sequence`).
- `topLevelModuleFor` ([extension.ts:2853](src/extension.ts#L2853)) — Java's
  dotted package name, the cleanest of the three to derive.
- `importHintFor` ([extension.ts:2881](src/extension.ts#L2881)) — `import foo.bar.ClassName;` phrasing.
- `testFrameworkNounFor` ([extension.ts:2905](src/extension.ts#L2905)) — `'JUnit 5'`.
- `generatedTestExtFor` ([extension.ts:2956](src/extension.ts#L2956)) — Java's own
  `FooTest.java` naming convention, not `test_foo.java`.
- `findSameCommitCallChains`'s `languagesPresent` set ([extension.ts:3116](src/extension.ts#L3116))
  needs Java added to whatever gates which languages it scans.
- `findCallersOf`/`resolveCallSites` ([extension.ts:3013](src/extension.ts#L3013),
  [extension.ts:3055](src/extension.ts#L3055)) — confirmed these need **zero**
  changes, already generic over `TestLanguage`/`callgraphArtifactFor`.

**Run path — a chance to do better than JS/TS got.** JS/TS has no direct run
path at all (always the slower/costlier Claude-discovery route in
`runTestViaClaudeForResult`). Java's build tooling is far more standardized:
`pom.xml` present → Maven (`mvn test -Dtest=ClassName#methodName`);
`build.gradle`/`build.gradle.kts`/`gradlew` present → Gradle
(`./gradlew test --tests "ClassName.methodName"`). Deterministic enough to add
a real `runJavaTestFileForResult`, alongside the existing
`runPythonTestFileForResult`/`runGoTestFileForResult`/`runRustTestFileForResult`,
instead of reusing the Claude-discovery path.

**Harness selection ("Set up test runner" for Java):** JUnit 5 (Jupiter) is
the uncontested default — no Jest-vs-Vitest-style ambiguity (TestNG exists but
is rare enough to only need detect-and-use-if-present). The real new problem
is the *install mechanism*: there's no single `npm install` equivalent —
adding JUnit means inserting a `<dependency>` block into `pom.xml`'s
`<dependencies>` (creating that element if absent) or a `testImplementation`
line into `build.gradle`. XML/Groovy/Kotlin-DSL text isn't as uniformly
editable as `JSON.parse`/`JSON.stringify`. Recommend a conservative
string-insertion function scoped to the common case (a `<dependencies>` block
already exists, true for most real Maven projects) that reports "couldn't
automatically edit pom.xml, here's the snippet to add yourself" rather than
guessing at a malformed edit — never a Claude call to do the insertion.
Footprint risk is naturally lower than npm here too: Maven/Gradle dependency
resolution doesn't explode into an npm-style multi-hundred-package tree the
way `node_modules` does (concretely measured this session: Vitest added 37
packages, Jest+ts-jest+@types/jest added 254 — a JUnit addition is typically a
handful of jars, not hundreds).

**Effort: medium.** Pipeline plumbing is mechanical and low-risk (the pattern
is proven twice already, Python and JS/TS); the genuinely new work is the
pom.xml/build.gradle editing logic and the Maven/Gradle-aware run path.

</details>

### Ruby — nothing exists at any layer; this is the one that actually needs a callgraph built from scratch
Checked `backend/main.py` for any mention of "ruby" (case-insensitive): zero
matches, not even a stub. Unlike Java, this isn't a fill-in-the-blank against
existing infrastructure — the callgraph parser itself doesn't exist, which is
exactly the prerequisite the user flagged (build the harness action for JS/TS
only after confirming its callgraph was real, not aspirational).

**What would need building, in dependency order:**
1. A `build_ruby_callgraph` equivalent — likely tree-sitter-based (a
   `tree-sitter-ruby` grammar exists and could follow the exact same pattern
   as `build_tree_sitter_java_callgraph`), emitting its own
   `ruby_ordered_call_sequence.json` via the same shared
   `write_ordered_call_sequence`, plus a combined-callgraph merge entry.
2. The same extension-host touch-point list as Java above — blocked on (1).
3. Harness selection for "Set up test runner": Minitest ships in Ruby's
   stdlib — genuinely nothing to install, `ruby -Itest test/foo_test.rb`
   just works, directly analogous to Go/Rust's built-in test support (no
   install action ever needed). RSpec is the far more common convention in
   real-world/Rails Ruby but is a Bundler-managed gem
   (`bundle add rspec --group test` + `rspec --init`), and Rails projects
   often expect `rails_helper.rb`/`spec_helper.rb` scaffolding beyond one
   config file. Recommended default mirrors the Vitest-over-Jest call:
   Minitest unless the repo already shows RSpec/Rails signals (`Gemfile`
   listing `rspec`/`rails`, or an existing `spec/` directory).

**Effort: large**, and gated entirely on (1). Recommend treating as its own
separate initiative — not bundled with Java, and not started until
tree-sitter-ruby feasibility is actually checked (not assumed).

### Recommended sequencing
1. Java pipeline plumbing (testLanguageFor et al.) — mechanical, low-risk.
2. Java direct run path (Maven/Gradle detection) — new but bounded.
3. Java "Set up test runner" (pom.xml/build.gradle editing) — new, needs the
   conservative-edit-with-fallback design above.
4. Ruby — only after checking tree-sitter-ruby feasibility; a from-scratch
   callgraph parser is a materially bigger commitment than 1-3 combined.

### C# — DONE (2026-08-31): plumbing + run path implemented; harness install deliberately skipped
Same session as Java, following the exact same proven pattern. Confirmed
`build_csharp_callgraph` (`backend/main.py:29840`, regex-based rather than
tree-sitter, but writes through the same shared `write_ordered_call_sequence`
— same `calls` key convention as Java/JS) is real and fully wired before
starting, same discipline as every language above.
- **Plumbing**: `TestLanguage` includes `'csharp'`; `testLanguageFor` (`.cs`),
  `callgraphArtifactFor` (→ `csharp/csharp_ordered_call_sequence.json`, key
  `'calls'`), `testFrameworkNounFor` (asks Claude to detect xUnit/NUnit/
  MSTest from the .csproj, defaulting to xUnit `[Fact]` if none is
  apparent), `generatedTestExtFor` (`.cs`) all updated. New `csharpImportHint`
  reads the file's own `namespace` declaration (both the classic block form
  and C# 10+'s file-scoped form) for the `using` hint in generation prompts.
  Unlike Java, **no filename-must-match-classname handling needed** — C#
  does not enforce that, so `generatedTestFileNameFor` needed no C# branch;
  the loose Python/JS-style `test_<prefix>.cs` naming applies as-is.
- **Run path**: `runCsharpTestFileForResult` — a genuinely different, simpler
  strategy than Java's, not the same trick ported over. Rather than resolving
  the target project's own classpath (Java's approach, which is why Java
  needed harness-install as a prerequisite), this builds one throwaway
  SDK-style project per run in a temp directory: a fresh `<PackageReference>`
  on xUnit (always added, regardless of what the target project has) plus a
  `<ProjectReference>` to the target project (found by `findCsprojFor`
  walking upward from the target file) plus a copy of the one generated test
  file — the only `.cs` file in that directory, so `dotnet test` runs
  unambiguously just it, no `--filter`/class-name guessing needed.
- **Harness install: deliberately not built.** The run path's throwaway
  project always brings its own xUnit reference, so — unlike Java — nothing
  needs to already be declared in the user's real project for Run to work.
  A *permanent*, visible test project added to the user's own solution (the
  real equivalent of Java's harness-install philosophy: IDE test-explorer
  visibility, CI pickup, teammate discoverability) remains a worthwhile but
  separate follow-up, intentionally deferred to keep this session's scope
  proportional — flag if that visibility gap turns out to matter in practice.
- **NOTE**: like the Rust and Java runners, this could not be empirically
  verified against a real .NET project — no .NET SDK available in this dev
  environment. Verified only the pure-logic pieces standalone (namespace
  extraction regex, TargetFramework regex) against realistic sample text.
  Should be checked against a real project before relying on it in
  production.

## Go, Rust — cheaper to finish than they look, once a callgraph exists

Both already have a working direct-run path in `extension.ts`
(`runGoTestFileForResult`/`runRustTestFileForResult`) — they can execute an
*existing* test file right now. What neither has, at any layer, is a
callgraph (`grep` for `go_ordered_call_sequence`/`rust_ordered_call_sequence`
style artifacts in `backend/main.py`: zero matches, same as Ruby/Kotlin/C++/
PHP), so zero call-path/call-chain/new-function generation opportunities can
ever surface for them — CODEMD's actual differentiator is fully absent
regardless of how easy running already is.

**The real insight: once a callgraph exists, Go/Rust need LESS follow-up work
than Java or C# did**, for two structural reasons specific to these two
languages:
1. **Run path already exists.** No `runGoTestFileForResult`/`runRustTestFileForResult`-equivalent needs building — reuse as-is (Go/Rust generated
   tests would save flatly under `.codemd/generated_tests/` same as every
   other language; `go test ./...`/`cargo test` from the repo root already
   discovers a test file anywhere via package/crate scanning, no Java-style
   "wrong directory" problem to route around at all).
2. **No harness-install ever needed.** `go test` and `cargo test` are part of
   the standard toolchain — nothing to detect or install, the same
   "genuinely nothing to add" case Ruby's Minitest is. No
   `detectXTestRunner`/`setUpXTestRunnerForResult` pair to build at all.

So the **entire remaining gap for both is the backend callgraph parser** —
plumbing (`testLanguageFor` et al.) is the same small, mechanical, proven
pattern as every language above. Tree-sitter has mature, well-maintained
grammars for both (`tree-sitter-go`, `tree-sitter-rust` — arguably more
mature than `tree-sitter-ruby`, given Go/Rust's much larger install base),
so following `build_tree_sitter_java_callgraph`'s exact pattern
(`backend/main.py:28512`) is the concrete next step for either, not a
from-scratch design problem the way Ruby's callgraph is.

**Recommended order**: Go before Rust (bigger install base, likely more
CODEMD users hit it first) — but check actual usage in whatever install-base
data exists before committing to that guess. Neither is started; this is
scope only, per the same "check before building" discipline as everything
above.

## Kotlin — checked (2026-08-31): a "new function, same shape," not a grammar swap or a from-scratch build

Read `build_tree_sitter_java_callgraph`'s full body (`backend/main.py:28512`)
end-to-end to answer this properly rather than guess.

**Finding**: the function's *architecture* — recursive tree-walk tracking a
class/method stack, appending raw call records, handing them to the shared
`write_ordered_call_sequence` — is genuinely generic and directly reusable as
a template. But the actual extraction logic is tightly coupled to Java's
specific tree-sitter grammar node-type strings, hardcoded throughout:
`class_types = {"class_declaration", "interface_declaration",
"enum_declaration", "record_declaration", "annotation_type_declaration"}`,
`method_types = {"method_declaration", "constructor_declaration"}`,
`call_types = {"method_invocation", "object_creation_expression",
"explicit_constructor_invocation"}`, plus `resolve_call_name`'s field-name
navigation (`object`/`type`/`qualifier` children) specific to how Java's
grammar shapes a method-invocation node. Kotlin's tree-sitter grammar uses
materially different node types for the equivalent constructs (`fun` instead
of `method_declaration`; Kotlin's `object`/`companion object` concept doesn't
exist in Java at all; `Foo()` construction without Java's `new` keyword is a
different node type) — none of these Java-specific sets/lookups transfer.

**So the honest tier**: not "Java-tier" (swap one grammar config value, reuse
the function) — every node-type set and the call-resolution logic needs a
Kotlin-specific rewrite, informed by actually inspecting `tree-sitter-kotlin`'s
grammar node names (not done — no Kotlin grammar available to inspect in this
session). But not "Ruby-tier" either — `write_ordered_call_sequence`, the
output artifact conventions, `iter_supported_repo_files`, and the
combined-callgraph merge wiring are all 100% reusable as-is, and the overall
shape of `walk()` is a proven template to copy rather than design from a
blank page. Concretely: a new `build_tree_sitter_kotlin_callgraph` function,
similarly sized (~150 lines) to Java's, not a from-scratch parser design.
Also relevant regardless of how this resolves: Kotlin shares JVM tooling with
Java (JUnit works unchanged on Kotlin test classes), so once a callgraph
exists, the *harness* piece is close to free — reuse
`detectJavaTestRunner`/the JUnit-coordinate approach directly, no separate
design needed there.

**Next step, concretely**: inspect `tree-sitter-kotlin`'s actual grammar node
types (via its own grammar.js/node-types.json, or a quick parse of a sample
.kt file) to fill in Kotlin-specific `class_types`/`method_types`/
`call_types` sets and `resolve_call_name` logic — not done in this session,
no Kotlin grammar available to inspect against.

## Language priority — corrected against actual backend readiness (2026-08-31)

User proposed a 10-language priority list (Python, JS, TS, Java, C#, Go,
Kotlin, C++, Rust, PHP) ranked by external popularity/usage. Checked
`backend/main.py` for every one of them (`grep -n "def build_\w*callgraph"`,
plus targeted checks for Go/Rust/Kotlin/C++/PHP/Ruby ordered-call-sequence
artifacts) before accepting the ranking, same as the Java/Ruby check above —
readiness for CODEMD's actual differentiator (callgraph-driven generation)
doesn't track general-purpose popularity, so the two rankings diverge in a
couple of real spots below.

| Tier | Language | Backend callgraph | Extension pipeline | Notes |
|---|---|---|---|---|
| 1 | Python | Yes (`build_python_callgraph`) | Full (generation+run+contract tests) | Top tier, pre-existing. |
| 1 | JavaScript/TypeScript | Yes (tree-sitter + regex fallback) | Full (generation+run-via-discovery+harness-install) | Built this session. |
| 2 | **Java** | Yes (`build_tree_sitter_java_callgraph`) | Full (generation+Maven run+harness-install) | **Built this session** — was "not started" this morning. |
| 2 | **C#** | Yes (`build_csharp_callgraph`, regex-based, fully wired — `csharp_ordered_call_sequence.json`, in the "no callgraph found" fallback error message alongside Python/JS/Java) | **None** | Same backend tier as Java, not below it — the user's list ranked it under Java on "enterprise-heaviness" grounds, but by CODEMD-readiness it's tied. Next language to plumb, same pattern as Java (xUnit or NUnit — needs its own default-choice check, not assumed). |
| 3 | Go | **None** | Direct run only (`runGoTestFileForResult`) | Can run an *existing* test file, but zero callgraph-driven generation — no call-path/call-chain/new-function opportunities will ever surface for Go until a callgraph exists. "Easy to automate running" isn't the same as "CODEMD adds value here." |
| 3 | Rust | **None** | Direct run only (`runRustTestFileForResult`, itself flagged unverified) | Same gap as Go. |
| 4 | Kotlin | None | None | Nothing at any layer. Note: shares JVM tooling with Java (JUnit works fine for Kotlin too) and `.kt`/`.kts` already appear in several generic "supported extension" lists in `backend/main.py` (e.g. line 13219, 30164) — worth checking whether `build_tree_sitter_java_callgraph`'s tree-sitter approach extends to Kotlin's grammar before assuming a from-scratch build like Ruby needs. Not checked yet. |
| 4 | C++ | None | None | Nothing at any layer. |
| 4 | Rust (see above) | | | |
| 5 | PHP | None | None | Nothing at any layer. |
| 5 | Ruby | None | None | Scoped above — needs a callgraph parser built from scratch, same tier as Kotlin/C++/PHP, not a special case. |

**What actually changed vs. the proposed list:** C# moves up to tie Java (both
already have real, wired backend callgraphs — C# was ranked #5, under Go #6,
on general enterprise/.NET usage grounds, but has *more* CODEMD-readiness
than Go does). Go and Rust move down in CODEMD-specific priority despite
being easier to automate running for — a callgraph is the actual gate for
this product's differentiator, and neither has one, putting them functionally
in the same "nothing to build on" bucket as Kotlin/C++/PHP for generation
purposes, just with a bonus existing run-only capability neither Kotlin,
C++, nor PHP has. Recommended next language, by this readiness measure:
**C#**, following the exact same plumbing pattern just proven twice (Python,
then Java) — a third repetition of a now well-understood pattern rather than
a new kind of problem.

## Explicitly not doing (per analysis's own caution)

- Publishing a bug-catch-rate percentage ("CODEMD catches N% of AI bugs")
  without first running a real benchmark (500-1000 historical commits or a
  mutation benchmark comparing existing/Claude/CODEMD test suites). No basis
  for a number until measured.
