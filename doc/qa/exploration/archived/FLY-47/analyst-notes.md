# Analyst Notes: FLY-47 + FLY-62 Channel Contract + Lead Auto-Relay

**Agent**: qa-fly-47
**Date**: 2026-04-05
**Plan**: `doc/plan/inprogress/v1.21.0-FLY-47-channel-contract.md`

## Change Classification

| Domain | Package | Impact |
|--------|---------|--------|
| **comm** | `packages/flywheel-comm` | Gate command, DB schema (4 cols), content-ref, pending --json, cleanup, stage |
| **bridge** | `packages/teamlead` | Gate-poller, StateStore dedup, hook-payload, bootstrap, Discord runtime |
| **edge** | `packages/edge-worker` | Blueprint checkpoint config injection |
| **core** | `packages/config` | CheckpointConfig types, ConfigLoader validation |

**Change Type**: Feature — new gate mechanism + auto-relay infrastructure

## E2E Test Strategy

**QA = E2E integration only.** No unit tests, no code imports, no mocks.

### Observable Endpoints (what we can verify from outside)

| Observable | Tool | How |
|-----------|------|-----|
| CommDB state | `sqlite3` CLI direct query | Query messages table for checkpoint, content_ref, resolved_at |
| Gate command behavior | `flywheel-comm gate` CLI | Run as subprocess, check exit code + timing |
| Pending output | `flywheel-comm pending --json` CLI | Parse JSON, verify fields |
| Discord messages | Chrome MCP (`mcp__claude-in-chrome__*`) | Navigate to Discord, read messages |
| Content-ref files | `ls`, `cat` on filesystem | Check file existence + content |
| Bridge gate-poller | Start Bridge on port 9877 | Observe event delivery via Discord |

### E2E Flow Under Test

```
Runner calls `flywheel-comm gate brainstorm`
  → CommDB: question row with checkpoint='brainstorm'
  → Bridge gate-poller detects (every 3s)
  → Discord: Lead control channel receives gate_question message
  → Lead relays to Annie (simulated via `flywheel-comm respond`)
  → CommDB: response row inserted
  → Gate command unblocks, exit 0
  → CommDB: resolved_at set, messages marked read
```

### Risk Areas for E2E
- Bridge startup on port 9877 — may need config override
- Discord message verification — depends on Chrome extension connectivity
- Gate timeout (1s for test speed) — process lifecycle management
- Content-ref file paths — depend on CommDB comm directory config
