# CODEMD Privacy Policy

This extension analyzes and generates artifacts entirely on your machine. This
page describes what it does and does not send anywhere, and how the optional
codemd.dev link fits in.

## What stays local

- Callgraph generation, impact analysis, and search all run against a local
  Python virtual environment CODEMD manages for you, and write their output
  only under `.codemd/` inside your own workspace. Your source code is not
  uploaded anywhere by these features.
- The extension bundles a copy of CODEMD's backend service code (also used to
  run the separate codemd.dev web dashboard). When that code runs locally as
  part of this extension, CODEMD explicitly disables its Sentry, Google
  Analytics, Mixpanel, and Supabase/OpenAI integrations by clearing their
  credentials before the local process starts — none of that telemetry is
  active in the extension.

## What involves a third party, and when

- **Claude Code / Codex CLI actions** (writing a test, fixing a failing test,
  or finding a run command) are one-click, never automatic. They shell out to
  the Claude Code or Codex CLI already installed and signed in on your
  machine. That usage is subject to Anthropic's or OpenAI's own privacy
  policy and terms, not this extension's — CODEMD does not see or store your
  API credentials.
- **The "Login to GitHub" and "Open Codemd.dev" buttons** in the panel simply
  open `https://www.codemd.dev` in your default browser — the same as
  clicking any other link. Nothing about your workspace, code, or CODEMD
  analysis is sent as part of opening that link. If you choose to sign in to
  GitHub from that site, that sign-in and any repository access you grant
  happens on codemd.dev, under its own account and privacy handling, entirely
  separate from this VS Code extension.

## Questions or issues

Report privacy questions or concerns the same way as any other issue:
[github.com/codemd-dev/CODE.md/issues](https://github.com/codemd-dev/CODE.md/issues).
