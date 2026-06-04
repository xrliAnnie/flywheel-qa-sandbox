# Sandbox Notes — flywheel-qa-sandbox

**Issue**: FLY-202 (QA sandbox fixture — slot harness real-Runner E2E task)
**Date**: 2026-06-03

## What this repo is for

`flywheel-qa-sandbox` is a disposable fork of the main Flywheel repository used exclusively as the target repo for QA end-to-end testing. The slot-based E2E framework (FLY-96 + FLY-115) spawns parallel isolated test environments — each slot clones this sandbox into `/tmp/flywheel-test-slot-<N>/`, starts a test Bridge and test Lead, and runs a **real Runner** against it. Every PR, branch, and commit produced during a QA run lands here instead of the production repo, so test traffic never pollutes real development history.

The sandbox exists because Flywheel's QA philosophy is "no synthetic mode": instead of mocking Runner behavior, QA spawns actual Claude Code Runner sessions end-to-end — PreHydrator pulls a real Linear issue, WorktreeManager creates a real branch, the Runner makes real commits and opens a real GitHub PR. That realism requires a safe place for the side effects, which is exactly what this fork provides. Teardown scripts (`scripts/test-teardown.sh`) clean up slot-local branches and worktrees after each run, and the fork itself can be periodically re-synced from upstream (see `doc/qa/framework/sandbox-sync-guide.md`).

Because the sandbox is a fork of the real repo, Runner tasks executed here exercise realistic conditions: a pnpm monorepo layout, an established `doc/` pipeline, CI workflows, and existing CLAUDE.md conventions. Fixture issues like FLY-202 give the harness a stable, PreHydrator-visible Linear issue to inject via `scripts/inject-linear-issue.sh` — small multi-step doc tasks that keep a Runner busy long enough for QA to observe mid-work states (stage transitions, inbox messages, gates) without touching any production resource.

## Top-level directories

| Directory | Description |
|-----------|-------------|
| `doc/` | Primary documentation tree — architecture specs, engineer pipeline (exploration/research/plan), QA docs, reference material, retros, and `VERSION`. |
| `docs/` | Lightweight operational docs: `CONTRIB.md` (contribution guide) and `RUNBOOK.md` (ops runbook). |
| `packages/` | pnpm monorepo packages — core orchestrator, claude-runner, edge-worker, flywheel-comm, qa-framework, teamlead, transports (linear/github/slack), MCP tools, and more. |
| `patches/` | pnpm patched dependencies (currently `mem0ai@2.3.0.patch`). |
| `scripts/` | Operational and E2E scripts — slot test deploy/teardown, issue injection, daily standup, cmux helpers, session cleanup. |
| `supabase/` | Supabase project files — database `migrations/` for the memory system (pgvector). |
