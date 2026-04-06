# E2E Test Results: FLY-47 + FLY-62

**Agent**: qa-fly-47
**Tested SHA**: c3f2d0f
**Date**: 2026-04-05
**Result**: PASS (all tests)

## Phase 1: CLI + CommDB (13/13 PASS)

| Test | Description | Result |
|------|-------------|--------|
| E02-checkpoint | CommDB checkpoint column, type='question' | PASS |
| E02-schema | 4 new columns (checkpoint, content_ref, content_type, resolved_at) | PASS |
| E04 | pending --json includes checkpoint, content_type | PASS |
| E04b | Short message (≤2KB) — no content_ref | PASS |
| E03 | Long message (>2KB) creates content_ref file | PASS |
| E08-ask | Traditional ask still works (backward compat) | PASS |
| E08-respond | Traditional respond still works | PASS |
| E09 | Stage approve accepted by flywheel-comm | PASS |
| E16 | Invalid DB path → non-zero exit | PASS |
| E05 | Brainstorm timeout → exit 1 (fail-close, ~5s) | PASS |
| E06 | Question timeout → exit 0 (fail-open, ~5s) | PASS |
| E01 | Full gate lifecycle (gate + respond = exit 0) | PASS |
| E07 | Gate resolve — resolved_at set, read_at set | PASS |

## Phase 2: Bridge + GatePoller + Discord E2E (PASS)

**Setup**: Bridge on port 9877 with real Discord bot (Peter), GatePoller at 3s interval.

| Step | Verification | Result |
|------|-------------|--------|
| Session created via `/events` API | StateStore shows running session | PASS |
| `flywheel-comm gate brainstorm` writes to CommDB | sqlite3 query: checkpoint=brainstorm, to_agent=product-lead | PASS |
| GatePoller detects within 3s | Bridge log: `Relaying gate question {id} to product-lead` | PASS |
| Discord delivery | Bridge log: `delivered=true` | PASS |
| Chrome MCP verification | Discord #product-lead-control: gate_question event with [BRAINSTORM], FLY-73, correct content | PASS |
| `flywheel-comm respond` unblocks gate | Gate exits with code 0 | PASS |
| CommDB final state | resolved_at and read_at both set | PASS |

## Product Bugs Found

| Bug | Description | Fix SHA | Status |
|-----|-------------|---------|--------|
| Timeout unit mismatch | `--timeout` multiplied by 1000 (ms treated as seconds). `--timeout 5000` became 5M ms = 83 min | c3f2d0f | Fixed by worker |
| Poll overshoot | Poll loop slept full interval even when timeout was shorter | c3f2d0f | Fixed (sleep min(interval, remaining)) |

## Infra Notes

- Bridge E2E requires session in StateStore with matching `execution_id` — use `/events` API with `session_started` event (not `/api/runs/start` which dispatches real Runner)
- GatePoller matches `question.from_agent` to `session.execution_id` — must match exactly
- GatePoller dedup via `isLeadEventDelivered` — only marks delivered on successful Discord delivery
- Production CommDB at `~/.flywheel/comm/{project}/comm.db` may have WAL files; better-sqlite3 readonly mode handles this correctly
