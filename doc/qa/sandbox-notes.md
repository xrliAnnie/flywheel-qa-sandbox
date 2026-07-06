# QA Sandbox Notes

## What this repo is for

`flywheel-qa-sandbox` is the disposable GitHub fork that Flywheel's test-slot
framework (FLY-96 / FLY-115) runs **real Runner end-to-end tests** against. Each
QA slot clones this repo into an isolated directory under
`/tmp/flywheel-test-slot-<N>/`, points a test Bridge and test Lead at it, and
spawns a real Claude Code Runner on a real Linear fixture issue (FLY-202). Every
branch, commit, and pull request a sandbox Runner produces lands here — never in
the production `flywheel` repository.

The repo's contents are an **orphan snapshot** of the main Flywheel monorepo:
one squashed commit with no history, refreshed per E2E run from whatever branch
is under test. That gives Runners a realistic codebase to read and edit (docs,
packages, scripts all present) while keeping the remote cheap to reset — stale
branches and PRs can be deleted wholesale without touching anything real.

Documents like this one are the deliverable of the FLY-202 fixture task itself:
a small, steady, multi-step writing job that gives QA observers a predictable
mid-work window to probe Runner behavior (progress ledger updates, gate stops,
restart recovery) while the Runner is genuinely working.

## Top-level directories

| Directory | Description |
|-----------|-------------|
| `agents/` | Runner agent prompt files (generic-executor.md, qa-executor.md) |
| `doc/` | Main documentation tree: architecture, engineer (exploration/research/plan), qa, reference, retro, VERSION |
| `docs/` | Operations-side docs: CONTRIB.md, RUNBOOK.md, operations/ |
| `engineering/` | Engineering department doc-flow area (engineering/doc/...) |
| `fleet/` | Fleet configuration example (README + example) |
| `packages/` | pnpm monorepo packages: core, claude-runner, teamlead, flywheel-comm, qa-framework, etc. |
| `patches/` | pnpm dependency patches (mem0ai@2.3.0.patch) |
| `qa-fly294/` | Historical QA evidence/scripts for FLY-294 (layer A/B/C tests, fake-discord) |
| `scripts/` | Ops & QA scripts (test-deploy / inject-linear-issue / test-teardown, alerts, cmux, ...) |
| `supabase/` | Supabase migrations |

## packages/qa-framework/README.md in ~10 bullets

- Reusable, plan-aware QA Agent framework, extracted from GeoForge3D's QA Agent v2 (GEO-308).
- Two-layer architecture: Layer 1 is the framework package (agents, skills, orchestrator, TypeScript config loader); Layer 2 is per-project config (`.claude/qa-config.yaml`, test-suite skill files).
- Quick start: copy the config template, fill in domains/API/test skills, and the QA agent runs the protocol from your config.
- Core flow is a 5-step protocol: Onboard → Analyze+Plan → Research → Write+Execute → Finalize.
- Test Slot framework (FLY-96/FLY-115): parallel isolated slots, each running a **real Runner** against `xrliAnnie/flywheel-qa-sandbox` — no synthetic fixture mode; driven by `test-deploy.sh`, `inject-linear-issue.sh`, `test-teardown.sh`.
- Slot prerequisites fail fast: `LINEAR_API_KEY`, authenticated `gh` with sandbox push access, the sandbox fork existing, and the branch under test pushed to the sandbox; `FLYWHEEL_RUNNER_START_POINT` is set only on test Bridges.
- FLY-60 hard-gate suite: 1 happy path + 6 variants validating G1/G2/G3 hard gates end-to-end, with a driver script, Apple-style HTML report, and per-run evidence directories.
- Mirror mode (FLY-153): slots 1-3 share one `#test-core-mirror` Discord channel to test multi-Lead reply discipline; Runner E2E is explicitly out of scope in mirror mode.
- Roundtable & Alert mirrors (FLY-529): `--mode roundtable` and `--alerts` give isolated `#test-leads-roundtable` / `#test-flywheel-alerts` channels for pre-ship E2E of restart-gated features, byte-compatible (off by default).
- Contracts: `PLAN_SOURCE_CONTRACT.md` (how QA agents obtain plan files across worktrees) and `SKILL_INTERFACE.md` (interface for all QA test skills).

## `ls -R doc/ | head -50`

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
