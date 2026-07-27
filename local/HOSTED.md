# Hosted JaldiAI

This directory is the first-class hosted JaldiAI implementation. It is built
around Hermes, typed MCP tools, a control plane, durable transaction state,
provider workers, and hosted web and voice entry points.

The implementation was brought into this repository as a source copy on
2026-07-26 so future work can continue with ordinary commits in one public
build history.

## Source provenance

- The source state came from the private JaldiAI working tree at commit
  `1b605ec`, including its additional modified and untracked source files.
- Files were copied into this repository; commits were not cherry-picked and
  old Git objects were not imported.
- Git metadata, credentials, dependency stores, worktrees, generated output,
  and APKs were excluded.
- A safe environment template is tracked as `.env.example`. The local `.env`
  remains ignored.

See [README.md](README.md) for the hosted architecture, tools, safety
invariants, setup, and deployment details.
