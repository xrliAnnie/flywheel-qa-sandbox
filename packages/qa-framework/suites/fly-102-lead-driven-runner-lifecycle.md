# Integration Test Suite — FLY-102 Lead-Driven Runner Lifecycle

**Feature**: Lead-driven Runner lifecycle primitives — close_runner endpoint + MCP tool, B3 🏁 ready-to-close notifier, CLOSE_ELIGIBLE_STATES guard
**PR**: #147 (Flywheel)
**Tool**: Chrome Discord observation (Claude-in-Chrome MCP) + direct DB / tmux inspection
**Environment**: claude's server (Discord), local `runner-geoforge3d` tmux, `~/.flywheel/teamlead.db`

## Prerequisites

- Bridge + product-lead deployed with PR #147 build (`close-runner.ts`, `runner-ready-to-close-notifier.ts`)
- `runner-geoforge3d` tmux session live with at least one active Runner window
- Peter (Product Lead) online in `#geoforge3d-product-chat`
- Simba (Chief of Staff) online in `#geoforge3d-core` for multi-Lead coordination flows
- Annie account logged into Discord for Chrome-driven interaction
- Shell access to read `~/.flywheel/teamlead.db` and `/tmp/flywheel-*.log`

## Channel & Execution Map

| Entity | Location |
|--------|----------|
| Peter - Product Lead | `#geoforge3d-product-chat` (1485787822894878955) |
| Simba - Chief of Staff | `#geoforge3d-core` (1487340532610109520) |
| Per-issue chat thread | child thread under product-chat, title `[GEO-XXX] Title` |
| StateStore DB | `~/.flywheel/teamlead.db` |
| Runner tmux session | `runner-geoforge3d` |
| Bridge log | `/tmp/flywheel-bridge.log` |
| cmux watcher log | `/tmp/flywheel-cmux-watcher.log` |

## Audit Event Vocabulary (from StateStore `session_events`)

| Event Type | Source | Meaning |
|------------|--------|---------|
| `lead_close_runner` | `bridge.close-runner` | Successful close (or idempotent `alreadyGone`) |
| `lead_close_runner_blocked` | `bridge.close-runner` | 409 — status not in CLOSE_ELIGIBLE_STATES |
| `lead_close_runner_failed` | `bridge.close-runner` | tmux kill returned error |
| `runner_ready_to_close_claim` | `bridge.ready-to-close-notifier` | Atomic claim row written |
| `runner_ready_to_close_notified` | `bridge.ready-to-close-notifier` | 🏁 message posted to chat thread |
| `runner_ready_to_close_skipped` | `bridge.ready-to-close-notifier` | Missing chat thread or bot token |
| `runner_ready_to_close_notify_failed` | `bridge.ready-to-close-notifier` | Discord POST failed |

**Event ID format** (Finding #1 fix — PR #147 current build): `close-runner-{executionId}-{leadId}` and `close-runner-blocked-{executionId}-{leadId}`. Old `{Date.now()}` suffix is gone.

**CLOSE_ELIGIBLE_STATES**: `completed`, `failed`, `blocked`, `rejected`, `deferred`, `shelved`, `terminated`.
Any other status (notably `running`, `awaiting_review`, `approved`, `approved_to_ship`) → 409 + `_blocked` audit row.

---

## TC-01 — Flow 1: Post-Merge 🏁 Ready-to-Close Notifier

**Precondition**: Runner active on an issue, session at `awaiting_review`, chat thread already created for the issue. Bridge has `postMergeTmuxCleanup` wired into `runPostShipFinalization`.

**Steps**:
1. Annie sends `Peter, ship GEO-XXX` in the issue's chat thread.
2. Peter processes approve → ship → CI gate → merges PR via `gh pr merge`.
3. Bridge detects merge → `postMergeTmuxCleanup` kills the Runner tmux window.
4. `runPostShipFinalization` calls `emitRunnerReadyToCloseNotification`.
5. B3 notifier claims `event_id=runner-ready-to-close-{executionId}`, posts 🏁 message into the chat thread, writes `_notified` audit row.

**Expected**:
- PR merged on GitHub.
- `sessions.status` transitions `awaiting_review → completed`.
- `runner_ready_to_close_claim` + `runner_ready_to_close_notified` events exist for the executionId.
- Chat thread receives a 🏁 message containing `Execution`, `Session status`, `Tmux` lines.
- Runner tmux window for the issue is gone from `tmux list-windows -t runner-geoforge3d`.

**How to verify**:
1. `gh pr view <PR> --json state,mergedAt` → `"state":"MERGED"`.
2. `sqlite3 ~/.flywheel/teamlead.db "SELECT status, session_stage FROM sessions WHERE execution_id='<exec>';"` → `completed|completed`.
3. `sqlite3 ~/.flywheel/teamlead.db "SELECT event_type FROM session_events WHERE execution_id='<exec>' AND event_type LIKE 'runner_ready_to_close%';"` → claim + notified rows.
4. Chrome screenshot chat thread — confirm 🏁 message from Peter.
5. `tmux list-windows -t runner-geoforge3d` — GEO-XXX window absent.

**Current result (2026-04-14)**: **BLOCKED by FLY-108**. See _Known Limitations_ below.

---

## TC-02 — Flow 2: Multi-Runner Concurrent Lifecycle (Sibling Isolation)

**Precondition**: Three Linear issues tagged `Product` available to Peter. Tmux session has zero or one existing Runner windows (baseline for comparison). cmux watcher running in event-signaled polling mode.

**Steps**:
1. Create 2 new dummy Linear issues (e.g., GEO-364, GEO-365) under Peter's project.
2. In `#geoforge3d-core`, `@Simba` triage — Simba dispatches both to Peter.
3. Peter spawns Runner A (GEO-364) and Runner B (GEO-365) in quick succession (expect ≤5s apart).
4. Answer each brainstorm gate independently in the per-issue chat thread.
5. Let both Runners progress through `brainstorm → implement` concurrently.
6. Throughout, monitor:
   - `tmux list-windows -t runner-geoforge3d` for any unexpected window disappearance
   - `/tmp/flywheel-cmux-watcher.log` for cleanup events on the wrong Runner
   - DB `sessions.status` / `session_stage` transitions

**Expected**:
- Both Runners own distinct tmux windows with `GEO-XXX-claude-Issue-GEO-XXX` names.
- Both Runners own distinct worktrees under `/Users/xiaorongli/Dev/geoforge3d-GEO-XXX`.
- Bridge dispatches `session_started`, `stage_changed`, `session_completed` events keyed by executionId — no cross-mixing.
- cmux watcher creates one workspace per window, never cleans the wrong one.
- Neither Runner blocks the other's progress.

**How to verify**:
1. `tmux list-windows -t runner-geoforge3d` — both `GEO-XXX-claude-Issue-GEO-XXX` windows present simultaneously.
2. `sqlite3 ... "SELECT issue_identifier, status, session_stage FROM sessions WHERE issue_identifier IN ('GEO-XXX','GEO-YYY');"` — both rows progress in parallel.
3. `grep "Creating workspace for" /tmp/flywheel-cmux-watcher.log | tail` — one row per Runner window, no cross cleanup.
4. Screenshot both chat threads — each has its own brainstorm gate, no cross-posting.

**Current result (2026-04-14)**: **PASS** for concurrency + sibling isolation. Ship-chain post-merge finalization is blocked by FLY-108 (same root cause as TC-01).

---

## TC-03 — Flow 3: close_runner Bridge Endpoint + MCP Tool

**Precondition**: A Runner session exists with status in CLOSE_ELIGIBLE_STATES (e.g., `terminated`). The executionId is known.

**Steps**:
1. **B1 Guard** — in a thread for an `awaiting_review` session, Annie asks: `Peter, close_runner GEO-XXX`. Peter calls the MCP tool.
2. **B2 Happy Path** — Annie asks: `Peter, terminate GEO-XXX then close_runner`. Peter issues `terminate` action first, then `close_runner`.
3. **B3 Scope Denial** (static test) — HTTP E2E suite `close-runner-http-e2e.qa-fly-102.test.ts` fires Ops lead POST against Product session.
4. **B4 Auth** — HTTP E2E suite fires POST without / wrong Bearer token.

**Expected**:
- B1: Bridge returns `409` with `status_not_eligible:awaiting_review` and eligible-state list. A `lead_close_runner_blocked` event with event_id `close-runner-blocked-{exec}-{leadId}` exists. Tmux untouched.
- B2: Bridge returns `200` with `success: true`. `lead_close_runner` event exists with event_id `close-runner-{exec}-{leadId}`. Tmux window for the issue absent (killed or already gone). `alreadyGone: true` flag set if tmux was pre-absent.
- B3: Bridge returns `403`, body contains `outside lead`. No audit row.
- B4: Bridge returns `401`.

**How to verify**:
1. Screenshot Peter's chat thread reply with status + audit row.
2. `sqlite3 ... "SELECT event_type, event_id FROM session_events WHERE execution_id='<exec>' AND event_type LIKE 'lead_close_runner%' ORDER BY ts DESC LIMIT 3;"` — event_id format per scenario.
3. `tmux list-windows -t runner-geoforge3d` — GEO-XXX absent post-B2.
4. `pnpm --filter teamlead test close-runner-http-e2e.qa-fly-102` for B3/B4 assertions (14 HTTP E2E cases pass locally).

**Current result (2026-04-14)**: **PASS** — all four sub-scenarios verified live (B2 on GEO-361 + GEO-364, B1 on GEO-361 `awaiting_review`, B3/B4 via HTTP E2E suite).

---

## TC-04 — C3: Pane-Exited Sibling-Safe Cleanup

**Precondition**: At least two Runner tmux windows live in `runner-geoforge3d` (A and B). Both own cmux-managed workspaces.

**Steps**:
1. Annie asks Peter: `对 GEO-A terminate + close_runner — 验证 sibling-safe`.
2. Peter issues `terminate(GEO-A)` → state_transition to `terminated`.
3. Peter issues `close_runner(GEO-A)` → Bridge calls `killTmuxSession` → tmux window for GEO-A exits → `pane-exited` hook fires.
4. cmux watcher detects window A gone → cleans workspace A.
5. Sibling Runner B's tmux window and workspace **must remain untouched**.

**Expected**:
- `tmux list-windows -t runner-geoforge3d` — GEO-A gone, GEO-B present.
- `grep "GEO-A" /tmp/flywheel-cmux-watcher.log | tail` — contains a Cleaning stale / workspace cleanup entry for GEO-A only.
- `grep "GEO-B" /tmp/flywheel-cmux-watcher.log | tail` — no cleanup entry for GEO-B (only the original `Creating workspace for` line).
- DB: `lead_close_runner` row for GEO-A's exec, nothing new for GEO-B.
- Runner B continues its current stage without interruption.

**How to verify**:
1. Snapshot tmux + DB + cmux log before issuing B2.
2. Issue B2 via Peter.
3. Immediately re-snapshot. Diff — only GEO-A disappears from tmux; DB gains one `lead_close_runner` row for GEO-A; cmux log gains exactly one cleanup line mentioning GEO-A.
4. Confirm Runner B's session row `stage_updated_at` advances normally.

**Current result (2026-04-14)**: **PASS** — ran on GEO-364 (closed) + GEO-365 (sibling). Window @985 GONE, @986 survived, no cross-cleanup in cmux log.

---

## Test Results Summary — QA Round (2026-04-14)

| TC | Description | Result | Evidence |
|----|-------------|--------|----------|
| TC-01 | Post-merge 🏁 notifier | **BLOCKED** (FLY-108) | GEO-363 ship → merged → `sessions.status` stuck `running`, zero `runner_ready_to_close_*` events |
| TC-02 | Multi-Runner concurrent lifecycle | **PASS (pre-ship)** | GEO-364 + GEO-365 ran in parallel through brainstorm→implement→approve gate; no sibling interference; cmux watcher created 2 distinct workspaces |
| TC-03 | close_runner endpoint + MCP | **PASS** | B1 on GEO-361 (409 blocked), B2 on GEO-361 + GEO-364 (200 + alreadyGone/kill), B3/B4 via HTTP E2E suite (14 cases green) |
| TC-04 | Pane-exited sibling-safe | **PASS** | GEO-364 close_runner killed @985; @986 (GEO-365) + @979 (GEO-363) intact; cmux cleanup scoped to GEO-364 only |

**Overall**: 3 PASS, 1 BLOCKED on upstream bug (FLY-108).

**Live-verified Findings from this QA round**:
- **Finding #1 fix confirmed in production build** — `event_id` for both `lead_close_runner` and `lead_close_runner_blocked` uses `{exec}-{leadId}` suffix, not the old `Date.now()` format. Two sequential close_runner calls on the same executionId now return a stable dedup key.
- **CLOSE_ELIGIBLE_STATES guard works** — 409 with informative `status_not_eligible:<status>` message and full eligible list, no tmux side effects on rejection.
- **Atomic claim dedupe on 🏁 notifier** (from static HTTP E2E) — concurrent callers collapse to one via stable `runner-ready-to-close-{exec}` event_id + UNIQUE constraint.

---

## Known Limitations

### FLY-108 — Bridge stage→status sweep missing post-merge

After `gh pr merge` completes and `session_stage` advances to `completed`, the Bridge never updates `sessions.status` from `awaiting_review`/`running` → `completed`. Because `runPostShipFinalization` is gated on the status transition, `postMergeTmuxCleanup` never runs and `emitRunnerReadyToCloseNotification` never fires. Runner tmux stays alive, B3 🏁 message never posts.

**Reproduced twice in this QA round**: GEO-363 (Flow 1) and GEO-364 (Flow 2). Identical signature: PR MERGED on GitHub, stage=completed, status frozen, zero `runner_ready_to_close_*` events, tmux window persists.

**Workaround used for C3**: bypass the merge path entirely — `terminate` + `close_runner` manually forces `status → terminated` and triggers pane-exited via the close endpoint.

### FLY-109 — Lead Claude `--resume` silently consumes flywheel-inbox events

When Lead's Claude CLI is restarted with `--resume <session-id>`, CommDB events delivered through `inbox-mcp` (e.g. `session_started`, `instruction`) are silently consumed — MCP marks them `read_at` but Claude never surfaces or acts on them. Observed in this QA round as Peter ignoring GEO-363 coordination messages after a resume; restart with a fresh session (delete session-id file + kickstart) restored behavior.

**Impact on FLY-102 scenarios**: TC-01 Flow 1 initial run was affected — Peter did not react to the GEO-363 dispatch until a forced fresh session. Workaround: avoid `--resume` after inbox event delivery, or always kickstart when expecting new Lead-bound events.

**Issue**: https://linear.app/geoforge3d/issue/FLY-109 (Backlog, Medium)

### FLY-111 — close_runner by `issue_identifier` silently filters awaiting_review

When the MCP `close_runner` tool is invoked with `issue_identifier` (e.g. `GEO-XXX`), the Bridge lookup `/api/sessions?mode=by_identifier` filters out sessions whose status is `awaiting_review`, returning `no closable session for GEO-XXX`. This misleads the caller into thinking no session exists, when in reality the 409 guard path (`status_not_eligible:awaiting_review`) would apply. Calling with `execution_id` bypasses the filter and surfaces the correct 409. Pure UX bug — functional behavior is preserved when using `execution_id`.

**Impact on FLY-102 scenarios**: TC-03 B1 guard must be exercised by executionId to observe the correct 409 + `lead_close_runner_blocked` audit row. Issue-identifier callsite produces a misleading "not found" message instead.

**Issue**: https://linear.app/geoforge3d/issue/FLY-111

### FLY-110 — cmux-sync pane-exited cleanup not firing

Under tmux `remain-on-exit` + session-grouping configuration, the `pane-exited` hook does not fire when a Runner window closes, so cmux-sync's event-signaled cleanup path is not triggered. Workspaces are only reaped by the fallback 5-minute conservative cleanup sweep, delaying resource release.

**Impact on FLY-102 scenarios**: TC-04 C3 sibling-safe still passes on the sibling-isolation assertion — the closed window's workspace eventually cleans up via conservative sweep — but cleanup latency is higher than the plan documented. If an observer measures cleanup timing against the pane-exited path, results will look "delayed" rather than "broken".

**Issue**: https://linear.app/geoforge3d/issue/FLY-110

### Orphan reaper side effect

During this round, `sessions.status` for GEO-363 transitioned `running → failed` with `trigger=orphan_reap` while the tmux window was still alive. This is a separate Bridge reaper pathway from the ship sweep, and suggests the ship-time stage→status gap could be closed by extending the orphan reaper's trigger conditions to include `session_stage='completed'`.

### TC-01 remains NOT VERIFIED end-to-end

Until FLY-108 is fixed, the 🏁 notifier's production path cannot be exercised through a real merge. The static HTTP E2E suite (14 cases) covers the primitive in isolation, and TC-03 B2 covers `close_runner` + pane-exited in isolation, but the full post-merge chain is unverified.

---

## Reference Files

- Implementation: `packages/teamlead/src/bridge/close-runner.ts`, `packages/teamlead/src/bridge/runner-ready-to-close-notifier.ts`
- Static HTTP E2E: `packages/teamlead/src/__tests__/close-runner-http-e2e.qa-fly-102.test.ts`
- MCP tool: `packages/teamlead/src/mcp/` (terminal server exposes `close_runner`)
- Plan: `doc/engineer/plan/inprogress/v1.22.0-FLY-102-round3-lead-driven-runner-lifecycle.md`
