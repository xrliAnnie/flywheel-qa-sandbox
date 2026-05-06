# flywheel-qa-framework

Reusable QA Agent Framework — plan-aware testing pipeline.

Extracted from GeoForge3D's QA Agent v2 (GEO-308). Provides a generic 5-step QA protocol that any project can adopt by providing project-specific configuration.

## Architecture

```
Layer 1: qa-framework (this package)     Layer 2: your project
├── agents/qa-parallel-executor.md  ←→   .claude/qa-config.yaml
├── skills/backend-test/SKILL.md    ←→   .claude/skills/backend-test/{project}-test-suite.md
├── orchestrator/{state,track,lock} ←→   (consumed via config-bridge.sh)
└── src/config/ (TypeScript loader)
```

## Quick Start

1. Copy `templates/qa-config.yaml` to your project's `.claude/qa-config.yaml`
2. Fill in your project's domains, API config, and test skills
3. Create a test suite config (see `templates/backend-test-suite.md`)
4. The QA agent reads your config and runs the 5-step protocol

## 5-Step Protocol

1. **Onboard** — Load config, obtain plan file, verify environment
2. **Analyze + Plan** — Extract acceptance criteria, classify changes, generate test spec
3. **Research** — Read OpenAPI spec, domain docs, existing tests
4. **Write + Execute** — Create ad hoc tests, run iteratively until all pass
5. **Finalize** — Update skill files, run regression, generate report

## Config Schema

See `templates/qa-config.yaml` for the full annotated schema.
TypeScript types: `import { QaConfig } from 'flywheel-qa-framework'`

## Examples

- `examples/geoforge3d/` — Full GeoForge3D configuration

## Test Slot Framework — Real Runner E2E (FLY-115)

The slot-based E2E framework (FLY-96 + FLY-115) spawns parallel isolated test environments, each running a **real Runner** against `xrliAnnie/flywheel-qa-sandbox`. No synthetic / fixture mode is supported — every slot is a real Runner end-to-end.

### Scripts

| Script | Purpose |
|--------|---------|
| `scripts/test-deploy.sh [--from-branch <br>] <N>` | Clone sandbox at `<br>` into `/tmp/flywheel-test-slot-<N>/project-slot-<N>` (slot-suffixed basename so WorktreeManager-derived Runner branches don't collide on the sandbox remote when two slots run the same issue), start test Bridge with `FLYWHEEL_RUNNER_START_POINT=refs/remotes/origin/<br>`, start test Lead. Default branch is sandbox `main`. |
| `scripts/inject-linear-issue.sh <N> <FLY-XXX>` | POST `/api/runs/start` directly to the slot's Bridge to spawn a real Runner. |
| `scripts/test-teardown.sh <N>` | Kill Runner tmux, Lead, Bridge; clean FLY-95 worktrees + slot-local branches; remove `SLOT_DIR` + CommDB. |

### Pre-requisites

- `LINEAR_API_KEY` exported in shell env (required for `/api/runs/start` PreHydrator).
- `gh` CLI authenticated with push access to the sandbox fork.
- `xrliAnnie/flywheel-qa-sandbox` fork exists (one-time: `gh repo fork xrliAnnie/flywheel --fork-name flywheel-qa-sandbox --clone=false`).
- Branch under test pushed to sandbox (`git push git@github.com:xrliAnnie/flywheel-qa-sandbox.git <br>:<br>`).

`test-deploy.sh` fails fast (exit 2) at pre-flight if any of these are missing.

### Runner worktree start point

FLY-95's `WorktreeManager.create()` now reads `FLYWHEEL_RUNNER_START_POINT` as a fallback when `opts.startPoint` is not supplied. `test-deploy.sh` sets this env var on the Bridge process only; production launchers do not set it, so the default `origin/main` behavior is unchanged in prod.

### Guides

- `doc/qa/framework/real-runner-e2e-guide.md` — end-to-end walkthrough + troubleshooting.
- `doc/qa/framework/sandbox-sync-guide.md` — sandbox fork lifecycle.

## FLY-60 — Hard Gate Enforcement E2E (Manual-Trigger Suite)

A specialized 1 happy path + 6 variants suite that validates the spec-defined Hard Gates (G1/G2/G3) end-to-end and provides regression coverage for sprint v26 trust gates (FLY-108/109/99/83). Reuses the test-slot framework above; adds zero framework changes.

### Files

- `packages/qa-framework/suites/fly-60-hard-gate.md` — full scenario spec (read first)
- `scripts/qa-fly-60-driver.sh` — orchestration driver (deploy → run scenarios → collect evidence → render report → teardown)
- `scripts/qa-fly-60-report-html.sh` — Apple-style HTML renderer (per `~/.claude/rules/html-report-style.md`)
- `doc/qa/reports/v1.25.0-FLY-60-hard-gate-e2e-report.md` — stable baseline (refreshed by every run)
- `doc/qa/reports/v1.25.0-FLY-60-evidence/<RUN_ID>/` — timestamped per-run evidence + HTML

### Key wire facts (matters for evidence interpretation)

- **HP follows the production approve wire**: `flywheel-comm respond` (CommDB write) + Runner self-posts `:cool:`. Bridge `approveExecution` is *not* on the production path — calling it while Runner is gate-blocked deadlocks (`scripts/test-auto-approve.sh:18-40` documents this).
- **DB paths are distinct**: StateStore = `${SLOT_DIR}/teamlead.db` (= `/tmp/flywheel-test-slot-N/teamlead.db`, taken from deploy JSON `dbPath`). CommDB = `~/.flywheel/comm/test-slot-N/comm.db`. They are not the same database.
- **CommDB schema is one `messages` table**. `delivered_at` set after MCP notification succeeds (inbox-mcp); `read_at` set after Lead's `flywheel_inbox_ack`. Don't conflate them. See `packages/flywheel-comm/src/db.ts:8-37,84-104,176-241,329-363`.
- **V3 alert evidence** comes from `~/.flywheel/alerts/claims.db` + `~/.flywheel/alert-queue/*.json` (filesystem queue). Discord channel push is **not** validated in this suite because test-slot config does not wire `alertChannel`.
- **Slot host repo path** is `/tmp/flywheel-test-slot-N/project-slot-N` (deploy JSON `hostRepo`). Runner worktrees are derived as `${HOST_REPO}-<ISSUE_ID>` and branches as `$(basename "$HOST_REPO")-<ISSUE_ID>`. V2 (residual worktree) plants stale resources at exactly these paths.

### How to run

```bash
# Full suite (HP + V1-V5 + V6 N=10 trials, ~3-4 hours total):
scripts/qa-fly-60-driver.sh --slot 1

# Single scenario:
scripts/qa-fly-60-driver.sh --slot 1 --scenario hp
scripts/qa-fly-60-driver.sh --slot 1 --scenario v1

# Reduce V6 trials:
scripts/qa-fly-60-driver.sh --slot 1 --scenario v6 --g3-trials 3

# Attach evidence after Chrome MCP completes a manual step:
scripts/qa-fly-60-driver.sh --slot 1 --scenario hp --evidence-only --run-id <existing>
```

The driver fails fast on preflight if `LINEAR_API_KEY` is missing or `FLY-SBX-1` is not a valid sandbox issue.

### Manual interaction (Chrome MCP required)

The driver emits `MANUAL_PENDING` gates whenever Chrome MCP-driven Discord interaction is required:

- **HP-3**: Annie posts task to chat-test-{N}
- **HP-7**: Annie posts ship approval
- **V4-b**: confirm Runner is in Claude REPL before injecting bypass instruction
- **V6**: per-trial shutdown phrase posting + Lead-reply classification

The QA agent (`agents/qa-parallel-executor.md`) handles these via Claude-in-Chrome MCP and re-invokes the driver with `--evidence-only` to attach screenshots.

### Spawn from a Claude Code session

Annie says: "spawn a QA agent to run fly-60 hard-gate suite". The main agent invokes `Agent` tool with `subagent_type: qa-parallel-executor`, passing:

```
PROJECT_ROOT  = /Users/xiaorongli/Dev/flywheel
PLAN_RELPATH  = doc/engineer/plan/new/v1.25.0-FLY-60-hard-gate-e2e.md
SUITE_PATH    = packages/qa-framework/suites/fly-60-hard-gate.md
DRIVER_PATH   = scripts/qa-fly-60-driver.sh
AGENT_ID      = qa-fly-60
```

## Contracts

- `contracts/PLAN_SOURCE_CONTRACT.md` — How QA agents obtain plan files across worktrees
- `skills/SKILL_INTERFACE.md` — Interface contract for all QA test skills
