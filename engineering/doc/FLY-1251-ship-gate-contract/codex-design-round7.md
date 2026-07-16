# Design Review — FLY-1251 plan.md (Round 7)
Date: 2026-07-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

All three Round-6 changes are present: quarantine episodes are versioned, channel failure state is durable, and E13 is substantially expanded. The design still has two safety-critical convergence/scoping holes: a lost quarantine re-arm CAS may be abandoned before the row is blocked, and `project_name` is not a safe health-latch key in the repository's multi-Lead routing model. Health-state write failures also need an explicit fail-closed contract.

## What's Good (Keep)

- `episode_version` is the right model: state is monotonic within an episode while the same physical card can be re-armed for later rejected inputs.
- Every in-episode transition includes the expected version, and authorization is tied to a present observation that cleared that same version plus the shared writer's live hold recheck.
- The quarantine-first crash ordering remains correct and the new adversarial cases cover re-add while held, repeated late holds, and clear-before-write failure.
- `approval_channel_health` makes the failure episode survive Bridge restart, and all three safety consumers are explicitly routed through one health predicate.
- Recovery is based on a verified successful read/probe rather than elapsed time, while environment/config suppressors remain live-read.
- E13 now covers the major carry-forward and health-flip families instead of relying solely on prose outside the acceptance matrix.
- The single activation primitive, ambiguous-POST reconciliation, stale-card observation duty, and honest FLY-1244 seam prerequisite remain coherent. The sibling branch still has no authority seam, so keeping §4.3 blocked is accurate.

## Issues & Recommendations

1. **[HIGH] A lost quarantine re-arm CAS is still allowed to “give up” without proving the row is blocked.** §4.3b globally defines a zero-row episode CAS as `竞态放弃`. That is safe only if the winner already established an equal-or-stronger blocked state; it is unsafe if a concurrent handler moved `absent_seen → cleared`. For example, a fresh-present handler clears version `v`, a new hold makes the writer reject, and the blocked handler's stale `absent_seen/v → blocked/v+1` CAS loses. If it abandons and the hold clears before another scan, the row remains `cleared` with the reaction present and the denied input can authorize. The crash-order paragraph also still says `INSERT or no-op if exists`; an existing `absent_seen` or `cleared` row is not durably quarantined until re-arm succeeds. **Suggested fix:** define one convergent `ensureReactionBlocked` operation: read; insert if absent; return success if already blocked; CAS `absent_seen|cleared → blocked` with `version+1`; on conflict re-read and retry. It may proceed to removal/response only after observing the current row as blocked. Bound exhaustion, store error, or an unclassifiable winner must remain non-authorizing and retire/block the card with an alert—never continue as success. Apply the same re-read discipline to absent/clear CAS results. Add races for clear-vs-re-arm and two concurrent re-armers, plus the clear-before-write/new-hold case to E13 itself.

2. **[HIGH] `project_name` conflates independent approval channels and permits cross-channel false recovery.** The DDL says the implementation's stable `channel_key` is `project_name`, but current `GatePoller` iterates multiple Leads within one project and each Lead can have a distinct `chatChannel` and `botToken`. A successful read through healthy Lead/channel B would therefore reset an unhealthy latch created by Lead/channel A, after which `assertActiveCardAuthority` could authorize against A before A has recovered. **Suggested fix:** key health by the exact server-resolved authorization lane, at minimum project + Lead identity + Discord approval channel/thread identity; include a non-secret bot identity if credentials can differ. Freeze/store that key on the card at creation so activation, authority, observation, and recovery cannot derive different keys after config drift. Never store or hash the token itself. Add a two-Lead/same-project test proving B success cannot reset A, plus channel/Lead reconfiguration tests.

3. **[MED] Health mutation failures and response classification remain underspecified.** Only health-store read failure is declared fail-closed. If the atomic failure increment or unhealthy CAS throws/returns zero, the durable row can remain healthy and non-reaction routes can authorize despite an unrecorded failure episode. Row-absence/startup semantics are also unstated. In addition, §4.4 says transient network failures do not change state while §4.5 says network failures increment health; an implementer cannot tell whether “state” means card state only, nor how 5xx/malformed responses and nonce-scan failures feed the latch. **Suggested fix:** define missing/unknown health and any mutation failure as non-authorizing until a successful same-lane probe is both observed and durably persisted. CAS conflicts must re-read and converge. Publish one closed outcome table for 200, 401/403, 404, 429, 5xx, malformed body, network error, and nonce-scan fetch error, separately naming card-state and health-state effects. Test missing row, increment/reset write failure, CAS conflict, restart, and every outcome class.

## Verdict

CHANGES REQUESTED — address items above
