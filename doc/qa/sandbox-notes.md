# Flywheel QA Sandbox Notes

The `flywheel-qa-sandbox` repository is the QA test-slot framework's isolated target for exercising **real Runner** behavior end to end. Each slot clones the sandbox, starts a slot-local Bridge and Lead, and passes a real Linear issue through the PreHydrator—the component that turns issue data into Runner context—before spawning a genuine Runner. The framework deliberately has no synthetic fixture mode because failures such as worktree collisions, gate deadlocks, branch/PR wiring errors, and teardown leaks only appear on the real path.

That isolation gives the fixture a safe blast radius. A slot can create branches, commit, push, open pull requests, and block on gates inside the sandbox clone without touching production repositories or Discord channels. Alert queues and the claims database are isolated only when the slot is deployed with `--alerts`; without that mode, alert writers use the production-path stores documented by the framework. The slot-suffixed clone basename (`project-slot-<N>`) prevents WorktreeManager-derived branches from colliding when slots run the same issue, while `FLYWHEEL_RUNNER_START_POINT` lets only the slot Bridge start Runner worktrees from a selected sandbox branch.

The sandbox is disposable, repeatable integration-test infrastructure rather than a second source of truth. Every run should stay inside its clone and follow the `test-deploy.sh` → `inject-linear-issue.sh` → `test-teardown.sh` lifecycle so concurrent slots remain isolated and residual worktrees, branches, processes, and local databases are cleaned up. FLY-202 is a test-slot fixture only; production Leads and Runners must not pick it up.

## Top-level directories

| Directory | Description |
| --- | --- |
| `.claude/` | Claude Code project commands, `qa-config.yaml`, and orchestrator helpers. |
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
- The specialized suites cover the FLY-60 hard gates (one happy path plus six variants), shared-channel mirror mode (FLY-153), and FLY-529 roundtable and alert mirrors; the shared-channel modes intentionally reject Runner E2E unless their explicit escape flags are supplied, while alert overrides remain byte-compatible when disabled.
- The framework's guides document real-Runner operation and sandbox synchronization, while `contracts/PLAN_SOURCE_CONTRACT.md` defines plan discovery across worktrees and `skills/SKILL_INTERFACE.md` defines the contract for QA test skills.

## `doc/` listing

Command: `ls -R doc/ | head -50`
Locale: `LC_ALL=C`

```text
FLY-145-s6-retry-product-test
FLY-202-qa-sandbox-fixture
VERSION
architecture
engineer
plan
qa
reference
retro

doc//FLY-145-s6-retry-product-test:
design-review.md
design.html
exploration.md
flow.mmd
flow.svg
model.mmd
model.svg
plan.md
progress.md
research.md

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
```
