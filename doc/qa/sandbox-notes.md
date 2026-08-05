# Flywheel QA Sandbox Notes

The `flywheel-qa-sandbox` repository is an isolated GitHub fork used by Flywheel's QA test-slot framework to exercise real Runner behavior end to end. Each slot clones this repository into a separate temporary workspace, starts its own Bridge and Lead processes, and launches a real Runner from a Linear issue rather than substituting synthetic fixtures.

That isolation makes the repository a safe target for validating Runner branch creation, worktree setup, documentation or code changes, commits, pushes, pull requests, gates, and teardown without touching production repositories or resources. Branches under test can also be pushed here and selected as the Runner start point, so framework changes are tested against the same Git and GitHub operations used in a live run.

The sandbox is therefore disposable infrastructure for integration testing, not a second production source of truth. Test runs should remain inside their slot clone and use the framework's deploy, injection, and teardown scripts so concurrent slots do not collide and residual worktrees or branches are cleaned up.

## Top-level directories

| Directory | Description |
| --- | --- |
| `.claude/` | Claude configuration, commands, skills, hooks, and QA project settings. |
| `.flywheel/` | Project-local Flywheel configuration and workflow metadata. |
| `.github/` | GitHub workflows, templates, and repository automation. |
| `.lead/` | Lead-agent configuration and supporting project context. |
| `.serena/` | Serena project configuration and cached project metadata. |
| `agents/` | Prompt definitions for Runner, Lead, QA, and other agent roles. |
| `doc/` | Primary architecture, engineering, QA, planning, and reference documentation. |
| `docs/` | Contributor and operational runbooks for the repository. |
| `engineering/` | Issue-scoped engineering documents, investigations, evidence, and spikes. |
| `fleet/` | Fleet configuration and tooling for managed Flywheel installations. |
| `menus/` | Menu definitions used by interactive workflows and operator tooling. |
| `packages/` | TypeScript workspace packages, including the core Runner, Bridge, and QA framework. |
| `patches/` | Version-controlled patches applied to external or generated dependencies. |
| `product/` | Product research, specifications, prototypes, and issue-scoped documentation. |
| `qa-fly294/` | Checked-in artifacts and fixtures for the FLY-294 QA effort. |
| `qa-fly310/` | Checked-in artifacts and fixtures for the FLY-310 QA effort. |
| `scripts/` | Repository development, deployment, QA, and maintenance scripts. |
| `supabase/` | Supabase database migrations and related backend configuration. |
| `vendor/` | Vendored third-party code and locally maintained external assets. |

## QA framework README summary

- `flywheel-qa-framework` is a reusable, plan-aware QA pipeline extracted from GeoForge3D's QA Agent v2.
- It separates generic framework behavior from project-specific configuration supplied through `.claude/qa-config.yaml` and test-suite files.
- Its five-step protocol covers onboarding, change analysis and planning, research, iterative test execution, and final regression reporting.
- Projects adopt it by copying the provided QA configuration template, defining domains and APIs, and adding a test-suite configuration.
- The test-slot framework runs real Runners against `xrliAnnie/flywheel-qa-sandbox`; it does not support a synthetic fixture mode.
- `scripts/test-deploy.sh` creates an isolated slot clone and starts slot-specific Bridge and Lead processes from a selected branch.
- `scripts/inject-linear-issue.sh` starts a Runner through the slot Bridge, while `scripts/test-teardown.sh` removes slot processes, worktrees, branches, and local state.
- Real-Runner tests require a Linear API key, authenticated GitHub CLI access, the sandbox fork, and the branch under test pushed to that fork.
- `FLYWHEEL_RUNNER_START_POINT` lets the test Bridge select a sandbox branch without changing production's default `origin/main` behavior.
- The README also documents specialized suites and topologies, including hard-gate E2E testing and mirror mode, with explicit evidence, isolation, and manual-interaction constraints.

## `doc/` listing

Command: `ls -R doc/ | head -50`

```text
VERSION
architecture
engineer
messaging-rework
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
```
