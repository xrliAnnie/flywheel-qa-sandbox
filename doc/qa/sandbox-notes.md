# Flywheel QA Sandbox Notes

## Purpose

`flywheel-qa-sandbox` is a standalone copy of the Flywheel repository used as the safe Git remote for real-Runner end-to-end tests. Test Runners can create branches, push commits, and open pull requests here without adding fixture traffic or disposable history to the production Flywheel repository. The slot framework intentionally runs real Runners rather than a synthetic fixture mode, so the sandbox remains close enough to Flywheel for worktree, build, review, and shipping behavior to be representative.

The test-slot harness clones this repository into an isolated `/tmp/flywheel-test-slot-<N>/project-slot-<N>` host, starts a slot-local Bridge and Lead, and injects a real Linear issue through `/api/runs/start`. The Runner works in a sibling issue worktree, while logs, SQLite state, CommDB data, and process lifecycles stay scoped to the slot. Teardown removes those local resources but deliberately leaves any pushed sandbox branch or pull request available for inspection or explicit cleanup.

Because GitHub does not allow a same-account fork of the source repository, this sandbox is an independent repository seeded from Flywheel rather than a true GitHub fork. Its `main` branch is manually synchronized with Flywheel before ship-blocking QA or after substantial changes; tests of a feature branch can instead push and pin that branch directly. The sandbox is therefore a disposable QA target, not an independent source of record and never a place to use production resources.

## Top-Level Directories

| Directory | Description |
|---|---|
| `.claude` | Stores Claude Code commands, skills, QA configuration, and orchestrator support files. |
| `.flywheel` | Defines this project's Flywheel agents, pipeline configuration, menus, and templates. |
| `.github` | Contains GitHub Actions for CI, payload releases, and comment-driven shipping. |
| `.lead` | Holds the repository-managed configuration and identity material for Flywheel Leads. |
| `.serena` | Contains Serena code-intelligence project settings. |
| `agents` | Provides generic, QA, designer, and prototype executor prompt definitions. |
| `doc` | Collects architecture, engineering, QA, reference, planning, and retrospective documentation. |
| `docs` | Contains contributor guidance, operational runbooks, and supporting operations documentation. |
| `engineering` | Stores issue-scoped engineering designs, implementation records, fixtures, and spikes. |
| `fleet` | Documents fleet management and provides example host manifests and environment configuration. |
| `menus` | Defines reusable task-shape menus for code, design, PRD, prototype, and generic work. |
| `packages` | Contains the TypeScript packages that make up the Flywheel pnpm monorepo. |
| `patches` | Holds package-manager patches applied to third-party dependencies. |
| `product` | Stores issue-scoped product documents and prototype artifacts. |
| `qa-fly294` | Preserves the FLY-294 QA report, fixtures, and layered test scripts. |
| `qa-fly310` | Preserves FLY-310 adversarial and end-to-end QA scripts, reports, and evidence. |
| `scripts` | Provides setup, deployment, QA, release, maintenance, and operational automation. |
| `supabase` | Contains Supabase project metadata and database migrations. |
| `vendor` | Holds vendored external skill packages and their provenance metadata. |

The top-level `=` entry is an empty file, not a directory, so it is intentionally not included as a directory-table row.

## QA Framework Summary

- `flywheel-qa-framework` is a reusable, plan-aware QA Agent framework extracted from GeoForge3D's QA Agent v2 for adoption by configured projects.
- Its two-layer architecture pairs shared agents, skills, orchestration helpers, and a TypeScript config loader with each project's QA configuration and test suites.
- Projects start by copying the annotated config template, defining domains, API details, and test skills, then adding a suite configuration for the QA agent to consume.
- The core protocol moves through onboarding, acceptance-criteria analysis and planning, research, iterative test writing and execution, and final regression/reporting.
- The slot framework runs parallel isolated environments with real Runners against `xrliAnnie/flywheel-qa-sandbox`; it has no synthetic or fixture-only Runner mode.
- `test-deploy.sh`, `inject-linear-issue.sh`, and `test-teardown.sh` respectively create the slot environment, start a real issue run, and remove slot-local processes and state.
- Real-Runner E2E requires a visible Linear issue, authenticated sandbox push access, a sandbox branch under test, and a Bridge-only `FLYWHEEL_RUNNER_START_POINT` override that leaves production defaults unchanged.
- The FLY-60 suite exercises hard-gate behavior through the production approval wire, records evidence from the correct state stores, and uses manual Chrome-driven steps where Discord interaction is required.
- Mirror, roundtable, and alert modes provide specialized shared-channel or alert isolation, with explicit boundaries that keep ordinary Runner E2E in the standard slot topology.
- Operational safeguards include cold-Lead and Bridge-only deploy controls, sandbox-specific token accounting, disabled-by-default auto-QA in test rooms, and explicit plan-source and skill-interface contracts.

## doc/ Listing

Command:

```bash
ls -R doc/ | head -50
```

Output:

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
