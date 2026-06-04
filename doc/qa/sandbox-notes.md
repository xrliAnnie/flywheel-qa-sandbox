# Sandbox Notes — flywheel-qa-sandbox

**Issue**: FLY-202 (QA sandbox fixture — slot harness real-Runner E2E task)
**Date**: 2026-06-03

## What this repo is for

`flywheel-qa-sandbox` is a fork of `xrliAnnie/flywheel` that exists purely as a safe target
for QA end-to-end testing. The slot-based E2E framework (FLY-96 + FLY-115) spawns parallel
isolated test environments, each running a **real Runner** — a genuine Claude Code session
driven by a test Bridge and a test Lead — and every one of those Runners needs a git remote
it can clone, branch on, push to, and open PRs against without ever touching production
resources. This repo is that remote: branches and PRs created here are disposable test
artifacts, not product work.

The sandbox is kept structurally identical to the real Flywheel repo (same `packages/`
monorepo, same `doc/` pipeline layout, same scripts) so that Runner behavior observed here —
worktree creation, branch naming, CI interaction, PR flow — is representative of what would
happen in production. `scripts/test-deploy.sh` clones this repo into
`/tmp/flywheel-test-slot-<N>/project-slot-<N>`, `scripts/inject-linear-issue.sh` POSTs to the
slot Bridge's `/api/runs/start` to spawn a Runner against a real Linear issue, and
`scripts/test-teardown.sh` cleans everything up afterwards.

This file itself is a QA fixture: FLY-202 defines a small, steady, multi-step documentation
task (write these notes, inventory the repo, summarize the QA framework README, capture a
directory listing, then commit and open a PR) so that test harnesses have a predictable
mid-work window to observe a Runner in — for stuck-detection checks, wake/resume drills, and
approve-gate exercises. If you are a production Lead or Runner reading this: do not pick up
FLY-202; it is test-slot-only by design.

## Top-level directories

| Directory | Description |
|-----------|-------------|
| `agents/` | Flywheel-shipped fallback agent prompts (e.g. `generic-executor.md`) used when a project declares no matching agent. |
| `doc/` | Primary documentation tree — architecture specs, engineer pipeline docs (exploration/research/plan), QA docs, reference material, retros, and `VERSION`. |
| `docs/` | Operational docs — `CONTRIB.md`, `RUNBOOK.md`, and an `operations/` subdirectory. |
| `packages/` | pnpm monorepo packages: core orchestrator, edge-worker, claude-runner, flywheel-comm, teamlead, qa-framework, transports, MCP servers, and more. |
| `patches/` | pnpm dependency patches (currently `mem0ai@2.3.0.patch`). |
| `scripts/` | Operational and QA tooling — slot deploy/inject/teardown scripts, daemon wrappers, launchd templates, hooks, E2E drivers. |
| `supabase/` | Supabase project assets (memory-system storage backend). |

## packages/qa-framework/README.md — summary

- `flywheel-qa-framework` is a reusable, plan-aware QA agent framework extracted from GeoForge3D's QA Agent v2 (GEO-308); projects adopt it by supplying their own `.claude/qa-config.yaml`.
- Its core is a generic 5-step protocol: Onboard → Analyze + Plan → Research → Write + Execute → Finalize, driven by `agents/qa-parallel-executor.md` plus project-specific test-suite skills.
- The Test Slot Framework (FLY-96 + FLY-115) spawns parallel isolated environments, each running a **real Runner** against `xrliAnnie/flywheel-qa-sandbox` — no synthetic/fixture mode exists.
- Three scripts drive a slot's lifecycle: `test-deploy.sh` (clone sandbox + start test Bridge/Lead), `inject-linear-issue.sh` (POST `/api/runs/start` to spawn a Runner), `test-teardown.sh` (kill everything + clean worktrees/branches/CommDB).
- Pre-requisites are enforced fail-fast: `LINEAR_API_KEY` in env, `gh` authenticated with sandbox push access, the sandbox fork existing, and the branch-under-test pushed to the sandbox.
- Runner worktrees start from `FLYWHEEL_RUNNER_START_POINT` (set by `test-deploy.sh` on the Bridge process only), so production launchers keep the default `origin/main` behavior.
- The FLY-60 hard-gate suite (1 happy path + 6 variants) validates G1/G2/G3 gates end-to-end on top of the slot framework, with an orchestration driver, HTML report renderer, and per-run evidence directories.
- Key wire facts for evidence interpretation: the production approve path is `flywheel-comm respond` + Runner-posted `:cool:` (not Bridge `approveExecution`); StateStore (`teamlead.db`) and CommDB (`~/.flywheel/comm/...`) are distinct databases.
- Some FLY-60 steps require manual Discord interaction via Claude-in-Chrome MCP; the driver emits `MANUAL_PENDING` gates and re-attaches evidence with `--evidence-only`.
- Mirror Mode (FLY-153) lets slots 1–3 share one Discord channel (`#test-core-mirror`) to test multi-Lead reply discipline; it is explicitly out of scope for Runner E2E and rejected by `inject-linear-issue.sh` unless `--allow-mirror` is passed.
- Contracts live in `contracts/PLAN_SOURCE_CONTRACT.md` (how QA agents obtain plan files across worktrees) and `skills/SKILL_INTERFACE.md` (interface for all QA test skills).

## `ls -R doc/ | head -50`

```
VERSION
architecture
engineer
plan
qa
reference
retro

doc//architecture:
archive
capability-matrix.md
flywheel-agent-architecture-diagram.html
flywheel-agent-architecture-diagram.mmd
flywheel-agent-architecture-diagram.svg
product-experience-spec.md
v0.2-architecture.md
v2.0-product-vision.md

doc//architecture/archive:
v0.1.0-flywheel-orchestrator.md

doc//engineer:
deep-research
exploration
implementation
onboarding
plan
research

doc//engineer/deep-research:
001-decision-layer-gemini.md
002-decision-layer-chatgpt.md
003-stripe-minions-part1.md
004-stripe-minions-part2.md
005-cloudflare-code-mode.md
006-boris-cherny-claude-code-future.md
007-parallel-ai-agents-pkarnal.md
008-agent-orchestrator-ao.md
009-ramp-inspect-background-agent.md
010-ai-agent-frameworks-2026.md
010-gastown-steve-yegge.md
claude-code-terminal-pane-management.md
multi-agent-architecture-best-practices.md

doc//engineer/exploration:
archive
backlog
new

doc//engineer/exploration/archive:
```
