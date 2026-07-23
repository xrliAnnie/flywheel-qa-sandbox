# QA Sandbox Notes — `flywheel-qa-sandbox`

**Issue**: FLY-202  
**Date**: 2026-07-23

## Overview

`flywheel-qa-sandbox` is a standalone repository seeded from Flywheel’s production `main` branch. It gives the QA test-slot framework a safe GitHub target where real Runners can create branches, push commits, open pull requests, and exercise the landing workflow without adding fixture history to the production Flywheel repository.

Each isolated test slot clones this repository, starts its own test Bridge and Lead, and injects a real Linear issue through `POST /api/runs/start`. The resulting Runner follows the normal repository workflow inside the sandbox clone, while slot-specific processes, worktrees, communication data, and cleanup remain separated from production resources.

FLY-202 exists as a stable, PreHydrator-visible issue for that end-to-end path. Its small documentation task creates enough intermediate activity for the QA harness to observe a Runner in flight and then verify branch creation, commit, pull request, review, approval, and landing behavior.

## Top-Level Directories

The table is derived from the directories tracked at the repository root so it is reproducible from a clean clone.

| Directory | Description |
| --- | --- |
| `.claude/` | Claude project commands, orchestration assets, and QA configuration. |
| `.flywheel/` | Sandbox-specific Flywheel agent and runner configuration. |
| `.github/` | GitHub Actions workflows for repository CI and automation. |
| `.lead/` | Lead role definitions and shared Lead instructions. |
| `.serena/` | Serena project indexing and configuration metadata. |
| `agents/` | Generic Runner and QA executor prompt definitions. |
| `doc/` | Primary architecture, engineering, QA, reference, and retrospective documentation. |
| `docs/` | Contributor, runbook, and operational documentation. |
| `engineering/` | Issue-scoped engineering documents and technical spikes. |
| `fleet/` | Fleet configuration examples and related deployment documentation. |
| `packages/` | TypeScript monorepo packages for Runners, orchestration, communication, QA, and supporting services. |
| `patches/` | Versioned pnpm dependency patches applied by the workspace. |
| `product/` | Product-focused issue documentation and artifacts. |
| `qa-fly294/` | FLY-294 QA harness files, checks, and report artifacts. |
| `qa-fly310/` | FLY-310 QA scripts, evidence, and reports. |
| `scripts/` | Development, operations, deployment, maintenance, and QA/E2E scripts. |
| `supabase/` | Supabase project state and database migrations. |

## `packages/qa-framework/README.md` Summary

- `flywheel-qa-framework` is a reusable, plan-aware QA Agent framework extracted from GeoForge3D’s QA Agent v2.
- Its two-layer architecture pairs shared agents, skills, orchestration helpers, and TypeScript configuration code with each project’s `.claude/qa-config.yaml` and test suites.
- The quick-start flow copies the annotated configuration template, fills in project domains and APIs, adds suite definitions, and lets the QA Agent execute the protocol.
- The five-step protocol is Onboard, Analyze + Plan, Research, Write + Execute, and Finalize.
- The package exposes an annotated configuration schema plus the `QaConfig` TypeScript type and includes a complete GeoForge3D example.
- The Test Slot Framework runs parallel, isolated, real-Runner E2E sessions against `xrliAnnie/flywheel-qa-sandbox`; it does not use a synthetic Runner mode.
- `test-deploy.sh` prepares a slot, `inject-linear-issue.sh` starts a Runner through the slot Bridge, and `test-teardown.sh` removes the slot’s processes, worktrees, branches, and communication data.
- Test-slot preflight requires a Linear API key, authenticated GitHub push access, the sandbox repository, and any branch under test to be available on the sandbox remote.
- `FLYWHEEL_RUNNER_START_POINT` lets a test Bridge select the Runner’s starting ref while leaving production’s default `origin/main` behavior unchanged.
- The README also documents hard-gate E2E, mirror/roundtable/alert test modes, their isolation boundaries, and the framework’s plan-source and skill-interface contracts.

## `ls -R doc/ | head -50` Output

```text
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
