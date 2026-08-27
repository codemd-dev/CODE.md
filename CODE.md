# CODE.md

An end-to-end automated testing framework, built on real code callgraphs, for AI coding agents.

CODE.md's callgraph tells an agent exactly which tests a change requires — so it can run only those, generate the ones that don't exist yet, and fix the code when a test fails for real. Everything else in this file (structure, modules, routes, entry points) is the evidence layer that makes that loop trustworthy, not the point of the file.

Generated from direct repository evidence only.

---

## Overview

This repository contains the source code for `<project_name>`.

Its primary purpose is:

```text
<brief_description>
```

CODE.md's core loop for this repository:

* Run only the tests a change's callgraph impact actually requires — not the whole suite.
* Generate a test when a function has none, from a real caller when possible.
* Fix the underlying code when a test fails for real, then re-run to confirm the fix holds.

### Why this helps LLMs

An agent that has to guess which tests to run either runs everything (slow, expensive) or runs too little (misses regressions). A callgraph turns "which tests matter here?" into a direct lookup, so the agent can act on a real answer instead of a guess.

---

## Callgraph Test Generation

The callgraph is a test map: every function node resolves to the tests that actually exercise it — not just tests whose name happens to match.

* Functions with a discovered test: `<count>`
* Functions with no discovered test: `<count>`
* Tests confirmed via coverage (not just "ran"): `<count>`

Function → test mapping:

| Function     | Test file     | Test name     | Coverage-confirmed |
| ------------ | ------------- | ------------- | ------------------ |
| `<function>` | `<test_file>` | `<test_name>` | `<true/false>`      |

Execution model:

* Tests run for real, in the repository's own environment — pass/fail is the test runner's actual exit code, never an LLM's self-report.
* "Coverage-confirmed" means the changed lines were provably hit during that run, not just that the test process exited 0.
* Environment/dependency failures (missing interpreter, missing plugin, bad config) are reported as environment issues, distinct from a real test failure — a missing package is not a code bug.

Generation and repair — always an explicit action, never automatic:

* A function with no discovered test can get one generated from a real caller: mechanically, by replaying a confirmed caller's literal arguments, or, when no literal call site exists, by asking an AI coding agent to write one.
* A genuine test failure (not an environment issue) can be handed to an AI coding agent to diagnose and fix, then re-verified by running the test again for a real pass/fail.

### Why this helps LLMs

Without a callgraph, an agent has to guess which test file covers a function by name-matching, which misses tests that exercise it indirectly through a caller. With the callgraph, "what tests cover this?", "did my change break anything?", and "is there a test for this at all?" become direct graph lookups plus a real test run, not a guess — and a failure is a hard fact the LLM can act on instead of a self-reported claim it has to trust.

---

## Evidence Policy

* Scope of analysis: `<folder_or_repo_scope>`
* Artifact root: `<artifact_path>`
* Only direct extraction artifacts used: `<true/false>`
* LLM-generated content included: `<true/false>`
* Excluded artifacts:

  * `<excluded_artifact_1>`
  * `<excluded_artifact_2>`
  * `<excluded_artifact_3>`

Notes:

```text
<clarifications_about_missing_semantics_or_intent>
```

### Why this helps LLMs

LLMs hallucinate when they assume missing context. This section tells the model what was extracted, what was excluded, and what should not be inferred.

---

## System Summary

* Primary languages:

  * `<language_1>`: `<percentage_or_count>`
  * `<language_2>`: `<percentage_or_count>`
  * `<language_3>`: `<percentage_or_count>`

* Total source files: `<count>`

* Total lines of code: `<count>`

* Description: `<short_system_description>`

### Why this helps LLMs

Knowing the languages, file counts, and scale helps the model reason faster and avoid incorrect assumptions about the architecture.

---

## Repository Structure

Folders:

* `/src` — `<description>`
* `/features` — `<description>`
* `/static` — `<description>`
* `/tests` — `<description>`

Sample files:

* `/src/main.py` — `<description>`
* `/features/detector.py` — `<description>`
* `/static/dashboard.html` — `<description>`

### Why this helps LLMs

LLMs waste tokens scanning file trees. A structured summary lets them jump directly to the relevant parts of the repository.

---

## Modules & Responsibilities

### Module: `<module_name>`

* Responsibility: `<description>`
* Allowed imports:

  * `<allowed_import_1>`
  * `<allowed_import_2>`
* Forbidden imports:

  * `<forbidden_import_1>`
  * `<forbidden_import_2>`

### Module: `<module_name>`

* Responsibility: `<description>`
* Allowed imports:

  * `<allowed_import_1>`
* Forbidden imports:

  * `<forbidden_import_1>`

### Why this helps LLMs

LLMs often struggle with modular boundaries. This section prevents confusion and improves reasoning about dependencies.

---

## API Routes

Routes detected from direct source evidence:

| Method           | Route     | Handler     | Source   |
| ---------------- | --------- | ----------- | -------- |
| `<GET/POST/etc>` | `<route>` | `<handler>` | `<file>` |

If no routes were detected:

```text
No API routes found from available direct evidence.
```

### Why this helps LLMs

API routes help agents understand how external requests enter the system and which functions handle them.

---

## Entry Points

Detected entry points:

| Entry Point     | File     | Description     |
| --------------- | -------- | --------------- |
| `<entry_point>` | `<file>` | `<description>` |

Examples:

* `main.search`
* `main.analyze_repo`
* `api.search`

### Why this helps LLMs

Entry points tell the model where execution begins, so it does not have to guess which functions matter most.

---

## Callgraph Summary

* Node count: `<count>`
* Edge count: `<count>`

Entry points:

* `<entry_point_1>`
* `<entry_point_2>`
* `<entry_point_3>`

Top connected nodes:

| Function     |     Degree |
| ------------ | ---------: |
| `<function>` | `<degree>` |
| `<function>` | `<degree>` |

Example call edges:

* `<caller>` → `<callee>`
* `<caller>` → `<callee>`

### Why this helps LLMs

Instead of parsing thousands of lines of code, the model gets a pre-computed flow of how functions interact. This dramatically reduces token usage and improves reasoning accuracy. This is the graph "Callgraph Test Generation" above is built on.

---

## Filegraph Summary

Core files:

* `<file>` — `<description>`
* `<file>` — `<description>`

Example file edges:

* `<file_a>` → `<file_b>`
* `<file_c>` → `<file_d>`

Hotspots:

* `<file>` — `<reason>`
* `<file>` — `<reason>`

### Why this helps LLMs

The filegraph shows architectural hotspots and dependency clusters without requiring the model to scan every file.

---

## UI Graph

* Node count: `<count>`
* Edge count: `<count>`

Example interactions:

* `<page>.<element>` → `<javascript_handler>`
* `<page>.<button>` → `<api_route>`
* `<form>` → `<submit_handler>`

Example:

* `dashboard.html.analyzeRepoButton` → `js.analyzeRepo`
* `dashboard.html.exportPdfButton` → `js.exportDashboardPdf`

### Why this helps LLMs

The UI graph lets agents trace UI → JavaScript → API behavior without manually parsing HTML, JavaScript, and backend routes.

---

## Source Inventory

* Function count: `<count>`
* Class count: `<count>`
* Comment count: `<count>`
* TODO count: `<count>`

TODOs:

| File     |     Line | Text          |
| -------- | -------: | ------------- |
| `<file>` | `<line>` | `<todo_text>` |

Known gaps:

* `<gap_1>`
* `<gap_2>`

### Why this helps LLMs

The source inventory helps agents quickly locate TODOs, missing logic, weak spots, and areas needing improvement.

---

## Why This Helps LLMs

CODE.md gives AI coding agents a callgraph-driven testing loop, backed by a structured map of the repository, before they begin working.

It helps by:

* Running only the tests a change's callgraph impact actually requires — never the whole suite, never nothing
* Generating a test for a function that has none, instead of leaving the gap
* Fixing code from a real, hard-fact test failure, then re-verifying — never trusting a self-report
* Giving the LLM a source map of the repository, so it knows what covers what before it acts
* Reducing the need to scan thousands of lines of code
* Preventing hallucinations by clarifying what is known and unknown
* Cutting token usage through pre-computed metadata
* Helping agents follow real callgraphs and file dependencies
* Making UI, API, and backend flows easier to trace
* Saving developer time by avoiding repeated repo exploration and unnecessary test runs

In simple terms:

```text
Run what's required.
Generate what's missing.
Fix what fails.
Prove it, don't guess.
```
