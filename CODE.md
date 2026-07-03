# CODE.md

**A parser-generated source map for AI coding assistants.**

CODE.md is a single, structured Markdown file that gives AI coding assistants a reliable map of your repository: languages, structure, entry points, API routes, callgraphs, filegraphs, UI flows, TODOs, behavior constraints, validation notes, and known gaps.

It is extracted from the actual codebase instead of guessed.

**README.md is for humans.**
**AGENTS.md is for agent behavior.**
**CLAUDE.md is for Claude-specific context.**
**CODE.md is for the codebase itself.**

---

## Why CODE.md?

AI coding assistants often waste tokens exploring the same repository over and over. Worse, they can hallucinate architecture, routes, dependencies, or code flow when they do not have enough context.

CODE.md gives them a structured starting point.

It helps AI agents:

* Understand the repository faster
* Follow real code flow
* Find entry points and important files
* Use parser-generated callgraphs and filegraphs
* Trace UI-to-code behavior
* Reduce hallucinations
* Avoid repeated repo exploration
* Save developer time and token cost

---

## What is CODE.md?

CODE.md is a structured Markdown file placed in the root of a repository.

It gives AI coding assistants a parser-generated understanding of the codebase, including:

* Repository structure
* Primary languages
* Entry points
* API routes
* Modules and responsibilities
* Callgraph summary
* Filegraph summary
* UI graph
* TODOs and known gaps
* Behavior constraints
* Drift analysis
* Validation notes
* Autoheal or self-healing rules

A CODE.md file can be written manually, but it is most useful when it is auto-generated from real repository evidence.

---

## Where CODE.md fits

CODE.md is one of the core files for AI-assisted development:

| File        | Purpose                                          |
| ----------- | ------------------------------------------------ |
| `README.md` | Explains the project to humans                   |
| `AGENTS.md` | Tells AI agents how to behave                    |
| `CLAUDE.md` | Gives Claude-specific project context            |
| `CODE.md`   | Explains the codebase structure to AI assistants |

Simple version:

```text
AGENTS.md = the rules
CLAUDE.md = the briefing
CODE.md   = the source map
```

Reference `CODE.md` from your `AGENTS.md` or `CLAUDE.md` file so every AI coding session starts with the repository map instead of rediscovering the project from scratch.

---

## CODE.md format guide

A CODE.md file uses plain Markdown sections. Each section answers a question an AI coding assistant would otherwise have to infer by scanning the repository manually.

The standard sections are:

1. Overview
2. Evidence Policy
3. System Summary
4. Repository Structure
5. Modules & Responsibilities
6. API Routes
7. Entry Points
8. Callgraph Summary
9. Filegraph Summary
10. UI Graph
11. Source Inventory
12. Behavior & Constraints
13. Drift Analysis
14. Validation
15. Autoheal / Self-Healing
16. Why This Helps LLMs

---

## Generate CODE.md

CodeMD.dev generates CODE.md from real repository evidence, including source files, parser output, callgraphs, filegraphs, UI graphs, TODOs, and structural metadata.

The goal is simple:

```text
Fewer tokens.
Fewer hallucinations.
Less repeated repo exploration.
More accurate AI coding assistance.
```

CODE.md gives AI assistants a source map before they start coding.
