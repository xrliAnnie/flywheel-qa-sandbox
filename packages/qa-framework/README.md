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

## Contracts

- `contracts/PLAN_SOURCE_CONTRACT.md` — How QA agents obtain plan files across worktrees
- `skills/SKILL_INTERFACE.md` — Interface contract for all QA test skills
