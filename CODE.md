# CODE.md

Machine-generated structural truth for this repository.

Used by AI coding assistants to understand architecture, code flow, dependencies, UI behavior, TODOs, known gaps, and validation rules.

Generated from direct repository evidence only.

---

## Overview

This repository contains the source code for `<project_name>`.

Its primary purpose is:

```text
<brief_description>
```

Key capabilities include:

* `<capability_1>`
* `<capability_2>`
* `<capability_3>`

### Why this helps LLMs

LLMs perform better when they start with a high-level mental model of the project. This reduces misinterpretation and prevents the model from wasting tokens trying to infer the repository’s purpose from scattered source files.

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

Instead of parsing thousands of lines of code, the model gets a pre-computed flow of how functions interact. This dramatically reduces token usage and improves reasoning accuracy.

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

## Behavior & Constraints

Known invariants:

* `<invariant_1>`
* `<invariant_2>`

Constraints:

* `<constraint_1>`
* `<constraint_2>`

Error rules:

* `<error_rule_1>`
* `<error_rule_2>`

Security or safety rules:

* `<rule_1>`
* `<rule_2>`

### Why this helps LLMs

This prevents incorrect assumptions about how the system behaves and what must remain true after code changes.

---

## Drift Analysis

* Structure drift: `<unknown/low/medium/high>`
* Semantic drift: `<unknown/low/medium/high>`
* Documentation drift: `<unknown/low/medium/high>`

Timeline:

| Date     | Change     |
| -------- | ---------- |
| `<date>` | `<change>` |

Notes:

```text
<drift_notes>
```

### Why this helps LLMs

This helps the model understand whether older documentation, comments, or assumptions may be outdated.

---

## Validation

Critical flows:

* `<flow_1>`
* `<flow_2>`

Invariants to preserve:

* `<invariant_1>`
* `<invariant_2>`

Browser tests:

* `<test_1>`
* `<test_2>`

Backend tests:

* `<test_1>`
* `<test_2>`

Manual validation steps:

* `<step_1>`
* `<step_2>`

### Why this helps LLMs

Validation notes improve reasoning about correctness and help agents avoid making changes without checking important flows.

---

## Autoheal / Self-Healing

Fix patterns:

* `<fix_pattern_1>`
* `<fix_pattern_2>`

Safe rules:

* `<safe_rule_1>`
* `<safe_rule_2>`

Risky areas:

* `<risky_area_1>`
* `<risky_area_2>`

Validation steps after auto-fix:

* `<step_1>`
* `<step_2>`

### Why this helps LLMs

This helps the model understand how the system repairs itself, which fixes are safe, and which areas require human review.

---

## Why This Helps LLMs

CODE.md gives AI coding assistants a structured map of the repository before they begin working.

It helps by:

* Giving the LLM a source map of the repository
* Reducing the need to scan thousands of lines of code
* Preventing hallucinations by clarifying what is known and unknown
* Cutting token usage through pre-computed metadata
* Improving accuracy when answering codebase questions
* Helping agents follow real callgraphs and file dependencies
* Making UI, API, and backend flows easier to trace
* Saving developer time by avoiding repeated repo exploration

In simple terms:

```text
Fewer tokens.
Fewer hallucinations.
Less repeated exploration.
Better AI coding assistance.
```
