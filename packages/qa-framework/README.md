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

## Mirror Mode (FLY-153) — multi-Lead shared-channel testing

The default 4-slot framework gives every test slot its own dedicated Discord
channel. Some scenarios — most notably FLY-152 reply discipline — only show
up when **multiple Leads share one channel** (mirroring prod
`#geoforge3d-core`). Mirror mode opts the first three slots
(cos / product / ops) into one shared `#test-core-mirror` channel while
keeping the legacy 4-slot per-channel mode untouched.

### Quick reference

```bash
# Legacy per-slot mode (default — 0 regression for existing suites)
scripts/test-deploy.sh 1
scripts/test-deploy.sh 4

# Mirror mode — slots 1-3 only
scripts/test-deploy.sh --mode mirror 1   # cos      → Simba identity
scripts/test-deploy.sh --mode mirror 2   # product  → Peter identity
scripts/test-deploy.sh --mode mirror 3   # ops      → Oliver identity

# Smoke test (validates the mirror wiring deterministically + bot-origin LLM)
scripts/qa-fly-153-mirror-smoke.sh

# Teardown is mode-agnostic
scripts/test-teardown.sh 1
```

Mirror mode is **out of scope for Runner E2E**. `inject-linear-issue.sh`
refuses a mirror slot unless you pass `--allow-mirror`, and
`scripts/qa-fly-60-driver.sh` aborts if any selected slot is in mirror mode.
This is intentional — Runner E2E in shared-channel topology needs separate
design (chat-thread dedupe across Bridges, etc.).

### One-time Annie setup — Discord guild

You only need to do this once per dev machine. **Why this step is manual**:
the four test bots in this guild only have View Channel + Send Messages +
Read Message History permissions (perms `68608`). Discord requires
`MANAGE_CHANNELS` to create a channel or grant channel-level overwrites,
and none of the bots have that. Only you do.

The framework expects:

| Field | Value |
|-------|-------|
| Test guild ID | `1485787271192907816` |
| Category ID | `1493080958889496760` (QA Testing) |
| New channel name | `test-core-mirror` |
| Channel type | Text channel |
| Members | You + bots `flywheel-test-1`, `product-lead-test`, `ops-lead-test` |
| Per-bot permissions | View Channel · Send Messages · Read Message History |

**Steps**:

```bash
# Step 0 — print current Annie steps (also embeds your guild + category IDs)
scripts/setup-mirror-channel.sh
```

Then in Discord:

1. Switch to the test guild → QA Testing category
2. Right-click the category → **Create Channel** → Text channel → name
   `test-core-mirror` → Create
3. For each bot (`flywheel-test-1`, `product-lead-test`, `ops-lead-test`):
   - Channel settings → **Permissions** → **+ Add member or role**
   - Search the bot user → add → grant **View Channel**, **Send Messages**,
     **Read Message History**
   - You do **not** need to grant Mention Everyone — the smoke uses
     `<@bot-user-id>` direct mentions, not `@everyone` / `@here` / role pings.
4. Right-click the channel → **Copy Channel ID** (Developer Mode must be on)
5. Run the helper to validate + install in one shot:
   ```bash
   scripts/setup-mirror-channel.sh <pasted-channel-id>
   ```
   It probes each of the three bots (`GET /channels/<id>` for View Channel
   then a tiny POST + DELETE round-trip for Send Messages), then patches
   `~/.flywheel/test-slots.json` with `mirrorChannel.channelId`. Idempotent —
   safe to re-run if you redo the Discord side.

After that, `scripts/test-deploy.sh --mode mirror 1` should succeed. Each
deploy also runs the per-bot probe again and fails fast with a pointer back
to this section if View Channel access is missing.

### Bot user ID terminology

Plugin gating compares `access.allowBots` entries against `msg.author.id`,
which equals each bot user's Discord ID. For these single-bot apps that
ID is the same as the Application ID (`botAppId` in `test-slots.json`).
Smoke Phase A echoes the three bot user IDs it places in `allowBots` so you
can sanity-check them against Discord's developer portal.

### What mirror mode does (under the hood)

- All three Bridges subscribe to the **same** Discord channel (`mirrorChannel.channelId`) instead of their per-slot channels
- Each slot's `access.json` adds the other two mirror slots' bot user IDs to `allowBots`, so bot-to-bot delivery (e.g. Simba's triage report → Peter / Oliver) survives the Discord plugin's pre-gate bot filter (`server.ts:856-858`)
- The TEST OVERRIDE banner replaces the legacy "ignore all production channel IDs" instruction with explicit substitution: production `#geoforge3d-core` references map to the mirror channel; all other production channel IDs remain prod-only and must not be used
- Slot identity selection now reads `identitySource` from `test-slots.json` (with backward-compat fallback to the legacy role mapping). This was a pre-existing FLY-96 bug where slot 3 would always load Peter's identity instead of Oliver — the fix is in scope for FLY-153 because mirror cascade testing depends on it

### Manual user-origin sanity (optional, not gated)

The automated smoke is bot-origin only because bash can't directly drive
Discord MCP tools. If you want a quick eyeball check that user-originated
messages also route correctly:

1. After mirror slots 1-3 are deployed, post `"Peter, 看下 FLY-1"` (you, not
   a bot) in `#test-core-mirror`
2. Wait ~60s and look at the channel: only Peter (`flywheel-test-2`) should
   reply; Simba and Oliver should stay silent

This is informal — framework verdict is anchored on Phase A + B2/B3 of the
automated smoke.

### Caveats

- **Chat threads (FLY-91)**: each Bridge owns its own StateStore, so if
  multiple Leads run against the same `(chatChannel, issueId)` pair they
  create independent threads. Mirror mode is intended for reply-discipline
  smoke fixtures only — don't run Runner E2E in mirror mode.
- **Slot 4 (finance)** has no prod analog and is rejected in mirror mode.
  Use legacy mode for finance regression coverage.
- **Mode sidecar**: the slot lock dir gains a `mode` file (`slot` or
  `mirror`). Do not hand-edit it. `inject-linear-issue.sh --allow-mirror`
  is the documented escape hatch if you really want to run Runners in a
  mirror slot.

## Roundtable Mirror (FLY-529) — pre-ship E2E for #leads-roundtable features

The default slots have no roundtable channel, so restart-gated roundtable
features (FLY-314 auto-threading / reply-in-thread) could only be tested after
ship. `--mode roundtable` adds an isolated `#test-leads-roundtable` mirror with
its own runs table (`roundtable_topic_threads` in the per-slot `teamlead.db`)
and a single auto-thread host.

```bash
# One-time (Annie): create #test-leads-roundtable, grant the HOST bot
# Create Public Threads + Send Messages in Threads, then:
scripts/setup-roundtable-channel.sh <channel-id>   # probes thread perms + installs

# Deploy a 2-lead room (host runs the single auto-thread manager):
scripts/test-deploy.sh --mode roundtable 1   # hostSlot
scripts/test-deploy.sh --mode roundtable 2   # member
scripts/qa-fly-529-roundtable-smoke.sh       # AC1 auto-thread + AC2/AC3 isolation/membership
```

- `roundtableChannel` in `test-slots.json`: `{ channelId, hostSlot, memberSlots, triggerMode }`.
  `hostSlot`'s Bridge is the only one with `FLYWHEEL_ROUNDTABLE_ENABLED=1`
  (exactly one manager → no duplicate threads); `memberSlots` (non-host) are the
  bots the manager adds to each topic thread.
- Runner E2E in roundtable mode is **out of scope** (same shared-channel multi-
  Bridge boundary as mirror mode) — `inject-linear-issue.sh` refuses it unless
  `--allow-roundtable`. Full multi-lead reply-in-thread is FLY-314's downstream QA.
- Suite: `suites/fly-529-roundtable-mirror.md`.

## Alert Mirror (FLY-529) — pre-ship E2E for #flywheel-alerts features

`--alerts` routes the test Bridge's alerts to an isolated `#test-flywheel-alerts`
and isolates **both** alert writer paths (Bridge `LeadAlertNotifier` + shell
`scripts/lead-alert.sh`) so a test alert never lands in the production queue the
live Bridge drains.

```bash
# One-time (Annie): create #test-flywheel-alerts, invite the repair/slot bots:
scripts/setup-alert-channel.sh <channel-id>

scripts/test-deploy.sh --alerts 1            # composable: --mode roundtable --alerts
scripts/qa-fly-529-alert-smoke.sh 1          # AC4 channel + AC5 two-path isolation
```

- `alertChannel` in `test-slots.json`: `{ channelId, repairBotTokenEnv }`.
- Isolation env (slot-local, set on Bridge AND Lead): `FLYWHEEL_ALERT_QUEUE_DIR`,
  `FLYWHEEL_ALERT_DEADLETTER_DIR`, `FLYWHEEL_CLAIMS_DB`; `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`
  (Bridge) + per-lead `alertChannel` in the slot-local projects file (shell).
- **Byte-compat**: with no `--alerts`, every override is unset → production paths
  → identical to today. The override seam is byte-compat-tested
  (`packages/teamlead/src/bridge/__tests__/alert-dirs.test.ts`,
  `scripts/__tests__/lead-alert-dirs.test.sh`).
- Suite: `suites/fly-529-alert-mirror.md`.

## Contracts

- `contracts/PLAN_SOURCE_CONTRACT.md` — How QA agents obtain plan files across worktrees
- `skills/SKILL_INTERFACE.md` — Interface contract for all QA test skills
