# Flywheel QA Sandbox Notes

The `flywheel-qa-sandbox` repository is an isolated GitHub fork used by Flywheel's QA test-slot framework to exercise real Runner behavior end to end. Each slot clones the repository into a separate temporary workspace (`/tmp/flywheel-test-slot-<N>/project-slot-<N>`), starts its own Bridge and Lead processes, and launches a real Runner from a Linear issue instead of replacing the workflow with synthetic fixtures.

That isolation makes the repository a safe target for validating Runner branch and worktree creation, documentation or code changes, commits, pushes, pull requests, gates, and teardown without touching production repositories or resources. A test can also select a sandbox branch as the Runner start point (`FLYWHEEL_RUNNER_START_POINT`), so framework changes travel through the same Git and GitHub operations a live run would use.

The sandbox is disposable integration-test infrastructure, not a second production source of truth. Its `doc/`, `packages/`, and `scripts/` trees are a point-in-time copy of the upstream repo and will drift from it; read them as fixture material, not as authoritative Flywheel documentation. Test runs should stay inside their slot clone and use the framework's deploy, issue-injection, and teardown scripts so concurrent slots do not collide and residual worktrees or branches are cleaned up.

## Top-level directories

Every top-level directory in the repository (`.git/` excluded). Verified against the working tree on the run recorded below — 17 directories.

| Directory | Description |
| --- | --- |
| `.claude/` | Claude project commands, skills, `qa-config.yaml`, and orchestrator state helpers. |
| `.flywheel/` | Project-local Flywheel config (`config.yaml`) and the executor role definitions it routes to. |
| `.github/` | GitHub Actions workflows and repository automation. |
| `.lead/` | Per-Lead identities (cos / eng / product / infra-bot / interviewer) plus the `shared/` rule bundle. |
| `.serena/` | Serena project configuration and its local metadata exclusions. |
| `agents/` | Runner prompt definitions — `generic-executor.md` and `qa-executor.md`. |
| `doc/` | Primary architecture, engineer, QA, planning, retro, and reference documentation. |
| `docs/` | Contributor guidance (`CONTRIB.md`), the operational `RUNBOOK.md`, and operations notes. |
| `engineering/` | Issue-scoped engineering documents (`doc/`) and experimental spikes (`spike/`). |
| `fleet/` | Example manifests and environment configuration for managed Flywheel fleets. |
| `packages/` | pnpm workspace packages — Runner, Bridge/teamlead, transports, `qa-framework`, and supporting services. |
| `patches/` | Version-controlled dependency patches applied at install time. |
| `product/` | Issue-scoped product research, specifications, and prototypes. |
| `qa-fly294/` | Checked-in fixtures, layered harnesses, and the report from the FLY-294 QA effort. |
| `qa-fly310/` | Checked-in scripts, E2E evidence, and reports from the FLY-310 QA effort. |
| `scripts/` | Repository development, deployment, maintenance, and QA automation (including the slot scripts). |
| `supabase/` | Supabase CLI metadata and database migrations. |

## QA framework README summary

Summary of `packages/qa-framework/README.md`:

- `flywheel-qa-framework` is a reusable, plan-aware QA pipeline extracted from GeoForge3D's QA Agent v2 (GEO-308).
- Its two-layer architecture pairs framework-generic agents, skills, orchestrator state, and a TypeScript config loader with project-specific `.claude/qa-config.yaml` and test-suite files.
- Adoption is four steps: copy `templates/qa-config.yaml`, fill in domains and API config, add a test-suite config, then let the QA agent run the protocol; `examples/geoforge3d/` is the worked example.
- The 5-step protocol is Onboard → Analyze + Plan → Research → Write + Execute → Finalize, ending in a regression run and report.
- The FLY-96 + FLY-115 test-slot framework spawns parallel isolated slots, each running a **real** Runner against `xrliAnnie/flywheel-qa-sandbox` — no synthetic or fixture mode exists.
- `scripts/test-deploy.sh` clones the sandbox into a slot-suffixed workspace and starts the slot Bridge and Lead; `scripts/inject-linear-issue.sh` POSTs `/api/runs/start` to spawn the Runner; `scripts/test-teardown.sh` kills processes and cleans worktrees, branches, and slot state.
- Pre-requisites are `LINEAR_API_KEY`, an authenticated `gh` with push access, the sandbox fork, and the branch under test pushed to it — `test-deploy.sh` exits 2 at pre-flight otherwise.
- `FLYWHEEL_RUNNER_START_POINT` is read by FLY-95's `WorktreeManager.create()` as a fallback start point and is set on the test Bridge only, so production keeps its `origin/main` default.
- The FLY-60 suite covers Hard Gates G1/G2/G3 via `scripts/qa-fly-60-driver.sh`, and documents wire facts that matter when reading evidence — the production approve path is `flywheel-comm respond`, and StateStore (`teamlead.db`) and CommDB (`comm.db`) are distinct databases.
- Three extra topologies layer on the same slots: mirror mode (FLY-153, shared `#test-core-mirror`), roundtable mirror, and alert mirror (both FLY-529, with byte-compat overrides so production queues stay untouched); mirror and roundtable modes explicitly refuse Runner E2E without an override flag.
- The README closes with pointers to the real-Runner and sandbox-lifecycle guides plus two contracts — `contracts/PLAN_SOURCE_CONTRACT.md` and `skills/SKILL_INTERFACE.md`.

## `doc/` listing

Command: `ls -R doc/ | head -50`

```text
FLY-202-qa-sandbox-fixture
VERSION
architecture
engineer
plan
qa
reference
retro

doc/FLY-202-qa-sandbox-fixture:
FLY-202-d1-e2e-chain.mmd
FLY-202-d1-e2e-chain.svg
FLY-202-d2-five-steps.mmd
FLY-202-d2-five-steps.svg
FLY-202-d3-doc-model.mmd
FLY-202-d3-doc-model.svg
FLY-202-design.html
design.md
progress.md

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
```

## Fixture run log

FLY-202 is a QA harness fixture issue: it exists so `scripts/inject-linear-issue.sh` /
`POST /api/runs/start` has a real, PreHydrator-visible Linear issue to spawn a sandbox
Runner against. Production Leads and Runners must not pick it up. Each run re-derives the
sections above from the working tree rather than trusting the previous pass.

| Run | Slot | Sandbox `doc/VERSION` | Notes |
| --- | --- | --- | --- |
| Initial | — | — | Fixture doc created (PR #29). |
| Refresh | — | — | Slot-harness E2E re-run (PR #30); doc later re-added by PR #84. |
| This run | 4 | `v1.55.0` | All four sections re-verified: 17 top-level directories unchanged, README summary re-derived (now covers roundtable + alert mirror modes and the two contracts), `ls -R doc/ \| head -50` re-captured unchanged. |
