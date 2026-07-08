# Design Review — FLY-546 plan.md (Round 3)

Date: 2026-07-07
Author: Codex
Status: CHANGES REQUESTED

## Summary
The Round 3 kill-switch change is architecturally feasible and still fail-closed: tokenless deployments 503, bad Bearer 401, `FLYWHEEL_VOICE_APPROVAL=0` disables, and the existing founder approval write path remains idempotent/fail-closed. The remaining blockers are in the new VC-exit semantics: the FSM table does not fully define precedence for mid-approval disconnects, and the true VC E2E plan still validates the old optional verbal exit instead of the new main exit path.

## What's Good (Keep)
- The voice approval flag is now correctly modeled as a kill-switch, not an opt-in gate: default enabled after ship QA, `=0` emergency rollback only.
- The guard chain is materially fail-closed and consistent with existing source patterns: `tokenAuthMiddleware` no-ops when unset, so the explicit 503 token guard is required; the existing founder approval factories already use default-ON kill-switch semantics.
- Round 2 wording fixes are closed: Bridge now has four `/api/voice/*` endpoints, response precedence calls out 503-before-403, and the body wording is now "before route body use" rather than "before JSON parsing."
- The outbound idempotency gap is addressed with deterministic `〔hp:{itemId}〕` markers plus restart scan before retry; approval retries can rely on `writeGateResponseAndRunPostWrite` returning `already_answered`.
- A4.3 correctly separates product choice from engineering mechanics: all Leads get differentiated defaults at ship time, and later voice changes are a one-line config edit.

## Issues & Recommendations
1. `disconnect_grace` still has an approval-precedence ambiguity.
   Why it matters: plan.md says any non-`sending` `presence(false)` stops playback, defers the current item to the queue front, and starts `disconnect_grace`; it also says `presence(true) <=60s` silently resumes the original progression. Separately, the founder ruling says leaving mid-approval never writes approval, and plan.md only spells that out for `disconnect_grace` exit/timeout. As written, a short disconnect during `awaiting_approval_confirm` can be interpreted as resuming the old approval-confirm state, after which a later "确认" writes approval from a pre-leave readback. That is not a safe founder-authority contract.
   Suggested fix: make the precedence explicit in the FSM table and tests. Recommended fail-closed rule: `presence(false)` while `state=awaiting_approval_confirm` invalidates that approval attempt immediately; no approval can be written from that readback after reconnect, and the gate remains for text/reaction or a fresh full voice approval flow. If product wants short reconnect to preserve approval, the table must say exactly what prompt is replayed and why it is still considered an explicit post-reconnect confirmation.

2. The new main exit path is not covered by the true VC product验收.
   Why it matters: the top-level goal and FSM now say leaving the VC for more than 60s is the main exit path with a core-channel text recap and preserved queue snapshot. But B4-2.1 still ends the real Discord + real VC E2E with "芝麻关门+确认退出带 recap," which is now only the optional verbal exit path. Unit tests can validate the pure FSM, but the risky part here is the FLY-545 presence bridge and real Discord behavior: no double-announce on 59s reconnect, mode-off + recap at 61s, and no approval write on mid-approval leave.
   Suggested fix: update B4-2.1 to require real VC evidence for all three presence cases: 59s reconnect silently resumes without re-announcing; 61s leave exits mode, posts the text recap to the core channel, and keeps the queue snapshot for the next "芝麻开门"; mid-approval leave produces no approval write. Keep the optional "芝麻关门" exit as an extra check, not the primary acceptance path.

3. The suspend/resume state model needs one implementation-level contract.
   Why it matters: "defer current item to queue front" and "silently resume original progression / no re-announce" are not the same state model. A queue-only restore can easily re-run the announce path, while a suspended-state restore needs to remember the prior FSM state, current item, prompt already spoken, timers, and whether the item is still allowed to receive a reply or approval.
   Suggested fix: add a small `disconnect_grace` state shape to B1-3 or B2-2, for example `{ previousState, currentItemId, itemPhase, promptSpoken, enteredAtMs }`, and define which fields are persisted. The tests should assert both no duplicate headline and no lost approval/reply state across reconnect.

4. Clean up residual wording while editing.
   Why it matters: B3-2.5 still says "flag/token 不设时" for route tests, which is easy to misread under the new default-ON semantics; absence of `FLYWHEEL_VOICE_APPROVAL` must mean enabled, while only `=0` means 403. The plan intro also still says the plan was approved by exploration §8, while §9 now overrides part of §8.
   Suggested fix: reword B3-2.5 to test "flag absent -> not disabled; flag =0 -> 403" and update the intro to reference exploration §8 plus §9 overrides.

## Verdict
CHANGES REQUESTED — address items above
