# QA Sandbox Notes — flywheel-qa-sandbox

**Issue**: FLY-202 (QA sandbox fixture — slot harness real-Runner E2E task)
**Date**: 2026-07-19

## Overview

`flywheel-qa-sandbox` is the isolated target repository for Flywheel's test-slot end-to-end harness (FLY-96 and FLY-115). Each slot clones this repository into a temporary workspace and starts a test Bridge, test Lead, and real Runner so the full development pipeline can be exercised without creating branches, commits, or pull requests in the production Flywheel repository.

The sandbox mirrors the production repository's structure—including its `packages/`, `doc/`, and automation trees—so Runner behavior is tested against a realistic codebase. It remains a standalone GitHub repository that can be reset or synchronized independently, keeping test artifacts and destructive QA setup away from production resources.

FLY-202 is the stable fixture used to give those real Runners a small, observable, multi-step task. It replaces the nonexistent `FLY-SBX-1` reference with a PreHydrator-visible Linear issue and produces this file during each harness run; production Leads and Runners must not pick it up.

## Top-Level Directories

| Directory | Description |
|---|---|
| `.claude/` | Claude Code commands, skills, orchestration guidance, and project-side QA configuration. |
| `.flywheel/` | Flywheel project configuration, agent roles, and label-based routing rules. |
| `.github/` | GitHub Actions workflows for CI, payload releases, and comment-triggered shipping. |
| `.lead/` | Identity definitions for the repository's Flywheel Lead roles. |
| `.serena/` | Serena project indexing and configuration files. |
| `agents/` | Generic executor and QA Runner prompts distributed with the repository. |
| `doc/` | Primary architecture, engineering, QA, reference, retrospective, and version documentation. |
| `docs/` | Contributor and operations runbooks. |
| `engineering/` | Issue-scoped engineering designs, evidence, and experimental artifacts. |
| `fleet/` | Fleet deployment documentation, example environments, and manifests. |
| `packages/` | pnpm workspace packages for Runners, the Bridge, communication, QA, and supporting services. |
| `patches/` | Third-party dependency patches managed by pnpm. |
| `product/` | Issue-scoped product exploration, research, planning, and review artifacts. |
| `qa-fly294/` | FLY-294 QA harness, layered tests, and report artifacts. |
| `qa-fly310/` | FLY-310 Discord E2E harness, scripts, and reports. |
| `scripts/` | Development, operations, release, and QA/E2E automation. |
| `supabase/` | Supabase metadata and database migrations. |

## `packages/qa-framework/README.md` Summary

- `flywheel-qa-framework` is a reusable, plan-aware QA Agent framework extracted from GeoForge3D's QA Agent v2.
- Its two-layer architecture pairs framework-owned agents, skills, orchestration utilities, and a TypeScript config loader with project-owned QA configuration and test suites.
- The quick start copies and fills in `templates/qa-config.yaml`, adds a project test-suite configuration, and lets the QA Agent consume both through the framework.
- The five-step protocol is Onboard, Analyze + Plan, Research, Write + Execute, and Finalize, ending with regression coverage and a report.
- The annotated config schema lives in `templates/qa-config.yaml`, the package exports the `QaConfig` type, and `examples/geoforge3d/` supplies a complete example.
- The FLY-96/FLY-115 test-slot framework runs parallel, isolated real Runners against `xrliAnnie/flywheel-qa-sandbox`; it has no synthetic or fixture execution mode.
- `test-deploy.sh`, `inject-linear-issue.sh`, and `test-teardown.sh` respectively create the slot, start a real Runner through `/api/runs/start`, and clean up slot-local processes and worktrees.
- Slot runs require a Linear API key, authenticated sandbox push access, the standalone sandbox repository, and the tested branch on the remote; `FLYWHEEL_RUNNER_START_POINT` pins only the test Bridge's Runner base.
- The README documents the FLY-60 manual hard-gate suite and its production-faithful approval wire, separate StateStore and CommDB evidence, and required browser-driven Discord interactions.
- Mirror, roundtable, and alert modes add isolated coverage for shared channels, Lead collaboration, and both alert-writing paths while explicitly limiting unsupported real-Runner topologies; separate contracts define plan discovery and QA skill interfaces.

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
