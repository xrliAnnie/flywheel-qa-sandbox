# Flywheel QA Sandbox Notes

The `flywheel-qa-sandbox` repository is an isolated GitHub fork of Flywheel used by the QA test-slot framework to exercise **real Runner** behavior end to end. Each slot clones this repository into its own temporary workspace under `/tmp/flywheel-test-slot-<N>/`, starts a slot-local Bridge and Lead, and spawns a genuine Runner from a Linear issue. Nothing about the workflow is stubbed — the framework deliberately offers no synthetic fixture mode, because the failures it is built to catch (worktree collisions, gate deadlocks, branch/PR wiring, teardown leaks) only appear on the real path.

That isolation is what makes the fork a safe blast radius. A test can create branches, commit, push, open pull requests, block on gates, and be torn down without touching production repositories, production Discord channels, or the production alert queue. The slot-suffixed clone basename (`project-slot-<N>`) keeps WorktreeManager-derived Runner branches from colliding on the sandbox remote when two slots run the same issue, and `FLYWHEEL_RUNNER_START_POINT` lets a slot Bridge start Runner worktrees from a selected sandbox branch so framework changes travel the same Git and GitHub operations a live run would.

The sandbox is disposable integration-test infrastructure, not a second source of truth. Its contents mirror Flywheel closely enough to be realistic, but any state here may be reset or rewritten by the next QA run. Work should stay inside the slot clone and go through the framework's `test-deploy.sh` / `inject-linear-issue.sh` / `test-teardown.sh` scripts so concurrent slots do not collide and residual worktrees, branches, and local databases get cleaned up. Production Leads and Runners must not pick up sandbox fixture issues.

## Top-level directories

| Directory | Description |
| --- | --- |
| `.claude/` | Claude Code project commands, skills, `qa-config.yaml`, and orchestrator helpers. |
| `.flywheel/` | Project-local Flywheel configuration (`config.yaml`) and executor role definitions. |
| `.github/` | GitHub Actions workflows for repository CI and automation. |
| `.lead/` | Per-Lead identity folders (cos / eng / product / infra-bot / interviewer) plus the shared Lead rule bundle. |
| `.serena/` | Serena project configuration and local metadata. |
| `agents/` | Runner executor role prompts — `generic-executor.md` and `qa-executor.md`. |
| `doc/` | Primary documentation tree: architecture, engineer pipeline, QA, plans, reference, retros. |
| `docs/` | Contributor guidance (`CONTRIB.md`), operational runbooks, and operations notes. |
| `engineering/` | Department-scoped engineering documents and spikes under the doc-flow layout. |
| `fleet/` | Fleet manifest examples and environment configuration for managed Flywheel fleets. |
| `packages/` | pnpm workspace packages — Runner, Bridge/teamlead, transports, edge-worker, config, DAG resolver, QA framework. |
| `patches/` | Version-controlled dependency patches applied at install time (e.g. `mem0ai@2.3.0.patch`). |
| `product/` | Issue-scoped product research, specifications, and prototypes. |
| `qa-fly294/` | Checked-in harness scripts, fixtures, and the report from the FLY-294 QA effort. |
| `qa-fly310/` | Checked-in E2E scripts, environment helpers, evidence, and reports from the FLY-310 QA effort. |
| `scripts/` | Development, deployment, maintenance, and QA automation scripts (plus their `__tests__`). |
| `supabase/` | Supabase CLI metadata and database migrations. |

## `packages/qa-framework/README.md` summary

- `flywheel-qa-framework` is a reusable, plan-aware QA pipeline extracted from GeoForge3D's QA Agent v2 (GEO-308).
- It uses a two-layer architecture: the framework ships agents, skills, orchestrator state/track/lock helpers, and a TypeScript config loader; each project supplies `.claude/qa-config.yaml` and its own test-suite file.
- The QA agent runs a five-step protocol: **Onboard** (load config, obtain plan, verify env) → **Analyze + Plan** → **Research** → **Write + Execute** → **Finalize** (regression + report).
- Adoption is copy-and-fill: start from `templates/qa-config.yaml`, declare your domains / API config / test skills, add a test-suite config, and import `QaConfig` for typed access.
- The test-slot framework (FLY-96 + FLY-115) spawns parallel isolated slots, each running a **real Runner** against `xrliAnnie/flywheel-qa-sandbox` — no synthetic or fixture mode exists.
- Three scripts drive a slot: `test-deploy.sh` (clone + slot Bridge + slot Lead), `inject-linear-issue.sh` (POST `/api/runs/start` to spawn the Runner), and `test-teardown.sh` (kill processes, clean worktrees, branches, `SLOT_DIR`, and CommDB).
- Real-Runner runs require `LINEAR_API_KEY`, an authenticated `gh` with push access to the fork, the fork itself, and the branch under test pushed to it; `test-deploy.sh` fails fast (exit 2) at pre-flight otherwise.
- `FLYWHEEL_RUNNER_START_POINT` is read by `WorktreeManager.create()` as a fallback start point and is set on the slot Bridge only — production launchers keep the default `origin/main` behavior.
- The FLY-60 hard-gate suite (1 happy path + 6 variants) regression-tests gates G1/G2/G3 and documents the wire facts that make evidence readable: the production approve path is `flywheel-comm respond` plus the Runner self-posting `:cool:` (calling Bridge `approveExecution` while the Runner is gate-blocked deadlocks), and StateStore (`${SLOT_DIR}/teamlead.db`) is a different database from CommDB (`~/.flywheel/comm/test-slot-N/comm.db`).
- Mirror mode (FLY-153) puts slots 1–3 on one shared `#test-core-mirror` channel to reproduce prod `#geoforge3d-core` reply-discipline scenarios; Runner E2E is intentionally out of scope there and refused unless `--allow-mirror` is passed.
- Roundtable mirror and alert mirror (FLY-529) add isolated `#test-leads-roundtable` (with exactly one auto-thread host so no duplicate threads) and `#test-flywheel-alerts` (both the Bridge `LeadAlertNotifier` and shell `lead-alert.sh` writer paths isolated, byte-compatible when the flags are off).
- Two contracts anchor extensions: `contracts/PLAN_SOURCE_CONTRACT.md` for how QA agents obtain plan files across worktrees, and `skills/SKILL_INTERFACE.md` for implementing QA test skills.

## `doc/` listing

Command: `ls -R doc/ | head -50`

```text
FLY-202-generalized-e2e
FLY-202-qa-sandbox-fixture
VERSION
architecture
engineer
plan
qa
reference
retro

doc//FLY-202-generalized-e2e:
design.html

doc//FLY-202-qa-sandbox-fixture:
FLY-202-d1-e2e-chain.mmd
FLY-202-d1-e2e-chain.svg
FLY-202-d2-five-steps.mmd
FLY-202-d2-five-steps.svg
FLY-202-d3-doc-model.mmd
FLY-202-d3-doc-model.svg
FLY-202-d4-branch-hygiene.mmd
FLY-202-d4-branch-hygiene.svg
FLY-202-design.html
design.md
plan.md
progress.md
workflow-output.json

doc//architecture:
archive
capability-matrix.md
flywheel-agent-architecture-diagram.html
flywheel-agent-architecture-diagram.mmd
flywheel-agent-architecture-diagram.svg
infra-alerts-spec.md
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
qa
research
```
