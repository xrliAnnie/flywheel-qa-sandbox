# FLY-529 — Roundtable Mirror suite

**Purpose**: validate the QA Testing Room can host ≥2 test leads in an isolated
`#test-leads-roundtable` channel and that the Bridge-side auto-thread manager
(`RoundtableThreadManager`) fires, with the runs table + inbound cursor isolated
from production. This is the **pre-ship E2E capability** for FLY-314 (roundtable
reply-in-thread / auto-threading); the multi-lead reply-in-thread run itself is
FLY-314's own downstream QA.

## Topology

```
#test-leads-roundtable (QA guild)
        ▲ poll                         ┌─ host slot Bridge: RoundtableThreadManager ON
  member bot posts topic ──────────────┤    (FLYWHEEL_ROUNDTABLE_ENABLED=1, isolated cursor,
        │                              │     runs table in ${SLOT_DIR}/teamlead.db)
        ▼ auto-create thread + add member
  topic thread (host = creator, member bot = added)
```

- **Exactly one** Bridge runs the manager (`roundtableChannel.hostSlot`) — each
  slot has its own StateStore, so two managers on the same channel would create
  duplicate threads.
- The topic MUST be posted by a **non-host** bot — the manager skips its own
  bot's top-level messages (echo immunity, `RoundtableThreadManager.processMessage`).

## Pre-reqs

1. `scripts/setup-roundtable-channel.sh` (Annie creates the channel; the helper
   probes the **host bot's Create Public Threads + Send Messages in Threads**
   with a real round-trip and patches `roundtableChannel` into test-slots.json).
2. `TEST_BOT_TOKEN_*` in `~/.flywheel/.env`, `LINEAR_API_KEY` exported.

## Run

```bash
scripts/qa-fly-529-roundtable-smoke.sh
```

Deploys host(1) + member(2) `--mode roundtable`, posts a topic as the member
bot, then asserts and tears down.

## Acceptance

| AC | Assertion | Evidence |
|----|-----------|----------|
| AC1 | auto-thread fires + runs-table row | `roundtable_topic_threads` row keyed by `(channel_id, source_message_id)` in the host slot's `teamlead.db`; Discord thread reachable. |
| AC3 | room usable by ≥2 leads | member bot is a `thread-members` entry of the created thread (manager added it via `FLYWHEEL_ROUNDTABLE_MEMBER_USER_IDS`). |
| AC2 | isolation | inbound cursor at `${SLOT_DIR}/roundtable-inbound-cursor.json`; production `~/.flywheel/roundtable-inbound-cursor.json` mtime unchanged. |

## Out of scope (FLY-314 downstream)

- Multi-lead **reply-in-thread** (Codex-lead) — needs ≥2 Codex test leads; the
  room hosts them but the conversation E2E is FLY-314's QA.
- Runner E2E in roundtable topology — `inject-linear-issue.sh` / `qa-fly-60-driver.sh`
  refuse roundtable mode (shared-channel multi-Bridge dedupe is undefined), same
  boundary as mirror mode. Escape: `--allow-roundtable`.
