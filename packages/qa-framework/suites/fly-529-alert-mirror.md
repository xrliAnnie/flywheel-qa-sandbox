# FLY-529 — Alert Mirror suite

**Purpose**: validate the QA Testing Room routes alerts to an isolated
`#test-flywheel-alerts` channel and isolates **both** alert writer paths from
production filesystem queues. This is the **pre-ship E2E capability** for
FLY-368 (unified alert channel + Cass auto-repair); the full auto-repair run is
FLY-368's own downstream QA.

## Why two writer paths

Alerts can be emitted from two places — both must be isolated, or a test alert
leaks into the production queue the live Bridge drains:

| Writer | Channel resolution | Dirs |
|--------|--------------------|------|
| Bridge `LeadAlertNotifier` | `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID` (env) | `queueDir` / `deadLetterDir` ctor fields + `FLYWHEEL_CLAIMS_DB` |
| Shell `scripts/lead-alert.sh` (invoked by `claude-lead.sh` on Lead crash) | per-lead `alertChannel` in `FLYWHEEL_PROJECTS_FILE` | `FLYWHEEL_ALERT_QUEUE_DIR` / `_DEADLETTER_DIR` / `FLYWHEEL_CLAIMS_DB` |

`test-deploy.sh --alerts` wires both to slot-local paths + the test channel.
Default (no `--alerts`): every override is unset → production paths → byte-compat.

## Pre-reqs

1. `scripts/setup-alert-channel.sh` (Annie creates the channel; helper probes
   View+Send for the repair bot, patches `alertChannel` into test-slots.json).
2. `TEST_BOT_TOKEN_*`, `LINEAR_API_KEY`.

## Run

```bash
scripts/qa-fly-529-alert-smoke.sh [slot]   # default slot 1
```

## Acceptance

| AC | Assertion | Evidence |
|----|-----------|----------|
| AC4 | a Bridge-path alert reaches the isolated test channel | the Bridge writer harness (`scripts/lib/qa-fly-529-fire-bridge-alert.mjs`, the exact `plugin.ts` `resolveAlertDirsFromEnv` + `LeadAlertNotifier.alert` composition) posts a marker message to `#test-flywheel-alerts`. |
| AC5 (Bridge wiring) | deploy put the alert env on the Bridge | `bridge.log` contains `FLY-368 AlertChannelHub ON (unified channel=<test-channel>)` — `--alerts` sets `FLYWHEEL_ALERT_THREADS=1` so the Bridge logs this on startup (auto-repair stays OFF). NOTE: `ps eww` can't be used — macOS SIP blocks reading another process's environment. |
| AC5 (both writers) | Bridge **and** shell writers isolate files | both claim into `${SLOT_DIR}/alerts/claims.db`; **production `~/.flywheel/alert-queue|alert-deadletter` get ZERO new files (portable file-set snapshot, not GNU `find -newermt`) and `alerts/claims.db` mtime is unchanged**. |

## Manual extension (full LeadWatchdog trigger + Cass auto-repair — FLY-368 downstream)

The smoke triggers the Bridge writer *path* deterministically via the harness +
the shell writer directly. The full **LeadWatchdog → notifier** trigger (frozen
Lead pane) plus **Cass auto-repair / per-error threading** (`FLYWHEEL_ALERT_THREADS=1`
+ `FLYWHEEL_AUTO_REPAIR=1`) belongs to FLY-368's downstream QA: reuse FLY-60 V3's
frozen-pane pattern-injection against the test Lead pane, then assert the thread +
repair ack land in the test channel and nothing touches production.

## Note on meta-alert

Meta-alert state (`FLYWHEEL_STATE_DIR`, local osascript notification + debounce
marker) is intentionally **out of AC5**: it is a local desktop notification, not
a queue the production Bridge drains, so it carries no cross-pickup hazard. The
`FLYWHEEL_STATE_DIR` knob exists for a future fuller isolation.
