# QA Sandbox Notes — FLY-202

**Issue**: FLY-202 (QA sandbox fixture — slot harness real-Runner E2E task)
**Date**: 2026-07-19
**Purpose**: Fixture document produced by a real sandbox Runner during a slot-harness E2E run.

## What is `flywheel-qa-sandbox`?

`flywheel-qa-sandbox` is a dedicated fork of the `xrliAnnie/flywheel` repository that serves as the
target repo for Flywheel's slot-based real-Runner end-to-end testing (FLY-96 + FLY-115). When a QA
test slot is deployed, `scripts/test-deploy.sh` clones this sandbox into
`/tmp/flywheel-test-slot-<N>/project-slot-<N>`, starts an isolated test Bridge and test Lead, and
`scripts/inject-linear-issue.sh` spawns a **real** Claude Code Runner against it. Every branch,
commit, pull request, and merge that the Runner produces lands here — never in the production
Flywheel repository.

The sandbox exists because the slot framework supports no synthetic or fixture Runner mode: every
E2E scenario exercises the genuine pipeline (onboard → brainstorm → implement → PR → approve gate →
ship) with real git operations and real GitHub PRs. Isolating that traffic in a fork keeps
production history, CI, and branch protection clean while still letting QA observe the full
production wire — CommDB gates, `flywheel-comm` stage reporting, landing signals, and Codex review
hooks — end to end.

This document itself is a fixture deliverable: Linear issue FLY-202 gives the harness a real,
PreHydrator-visible issue to dispatch (FLY-197 found that the `FLY-SBX-1` issue referenced in older
docs never existed). The task is deliberately small, steady, and multi-step so QA gets a mid-work
observation window on a live Runner session.

## Top-level directories

| Directory | Description |
|-----------|-------------|
| `.claude/` | Claude Code project config — commands, skills, orchestrator assets, `qa-config.yaml` |
| `.flywheel/` | Flywheel per-project config (`config.yaml`) and agent role definitions |
| `.github/` | GitHub Actions workflows (CI) |
| `.lead/` | Per-Lead rule bundles and identities (cos / eng / product / infra-bot leads, etc.) |
| `.serena/` | Serena tooling project configuration |
| `agents/` | Shipped fallback agent prompts (`generic-executor.md`, `qa-executor.md`) |
| `doc/` | Main documentation tree — architecture, engineer pipeline docs, QA reports, retros |
| `docs/` | Contributor and operations docs (`CONTRIB.md`, `RUNBOOK.md`, `operations/`) |
| `engineering/` | Engineering department work area (dept docs + spikes) |
| `fleet/` | Fleet configuration README and examples |
| `packages/` | pnpm workspace packages (core, claude-runner, flywheel-comm, qa-framework, …) |
| `patches/` | pnpm dependency patches (e.g. `mem0ai@2.3.0.patch`) |
| `product/` | Product department doc area |
| `qa-fly294/` | QA artifacts for FLY-294 (fake-discord harness + layered test scripts) |
| `qa-fly310/` | QA artifacts for FLY-310 (Discord E2E setup/teardown scripts + report) |
| `scripts/` | Operational + QA scripts (test-deploy/teardown, suite drivers, `__tests__/`) |
| `supabase/` | Supabase migrations |

## `packages/qa-framework/README.md` — summary

- `flywheel-qa-framework` is a reusable, plan-aware QA agent framework extracted from GeoForge3D's QA Agent v2 (GEO-308).
- Two-layer architecture: the generic framework package (agents, skills, orchestrator, TS config loader) pairs with project-specific config (`.claude/qa-config.yaml` + per-project test-suite skill files, consumed via `config-bridge.sh`).
- Core is a 5-step QA protocol: Onboard → Analyze + Plan → Research → Write + Execute → Finalize.
- Adoption is config-driven: copy `templates/qa-config.yaml`, fill in domains/API/test skills, and the QA agent runs the protocol; TypeScript types are exported (`QaConfig`).
- The Test Slot Framework (FLY-96 + FLY-115) spawns parallel isolated test environments, each running a **real Runner** against `xrliAnnie/flywheel-qa-sandbox` — no synthetic mode exists.
- Slot lifecycle scripts: `test-deploy.sh` (clone sandbox + start test Bridge/Lead), `inject-linear-issue.sh` (POST `/api/runs/start` to spawn a Runner), `test-teardown.sh` (kill + clean up).
- Pre-requisites are enforced fail-fast at deploy preflight: `LINEAR_API_KEY`, authenticated `gh` with sandbox push access, the sandbox fork, and the branch under test pushed to it.
- `FLYWHEEL_RUNNER_START_POINT` lets the test Bridge pin Runner worktree start points; production launchers never set it, so prod behavior stays `origin/main`.
- The FLY-60 hard-gate E2E suite (happy path + 6 variants) validates spec-defined Hard Gates G1/G2/G3 with an orchestration driver, Apple-style HTML report renderer, and per-run evidence under `doc/qa/reports/`.
- Key wire facts are documented for evidence interpretation: approve flows through `flywheel-comm respond` + Runner-posted `:cool:` (not Bridge `approveExecution`), StateStore and CommDB are distinct databases, and alert evidence lives in the filesystem queue + `claims.db`.
- Mirror mode (FLY-153) opts slots 1–3 into one shared `#test-core-mirror` Discord channel for multi-Lead reply-discipline testing; it is out of scope for Runner E2E and needs a one-time manual Discord channel setup.

## `ls -R doc/ | head -50` output

```
VERSION
architecture
engineer
plan
qa
reference
retro

doc/architecture:
archive
capability-matrix.md
flywheel-agent-architecture-diagram.html
flywheel-agent-architecture-diagram.mmd
flywheel-agent-architecture-diagram.svg
infra-alerts-spec.md
product-experience-spec.md
v0.2-architecture.md
v2.0-product-vision.md

doc/architecture/archive:
v0.1.0-flywheel-orchestrator.md

doc/engineer:
deep-research
exploration
implementation
onboarding
plan
qa
research

doc/engineer/deep-research:
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

doc/engineer/exploration:
archive
backlog
new
```
