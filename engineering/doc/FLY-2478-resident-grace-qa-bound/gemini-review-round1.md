# Design Review — plan.md (Round 1)

Date: 2026-09-11
Author: Gemini
Status: APPROVED

## Summary
The implementation plan for FLY-2478 is exceptionally high-quality, comprehensive, and architecturally sound. By leveraging the existing `ship_parked` -> `completed` transition and reusing the到期 (expiry) saga mechanism rather than introducing a new FSM status, the plan maintains high simplicity, prevents status-vocabulary bloat, and solves the three-way status inconsistency elegantly. The proposed changes align perfectly with existing codebase conventions, and the technical assumptions are fully verified against the source code.

## What's Good (Keep)
* **Status Vocabulary Discipline:** Choosing not to introduce a new `sessions.status` word (like `resident_released`) dramatically minimizes the blast radius of this change, avoiding updates to ~20 consumers in the codebase.
* **Dead-Evidence ACK Solution (S4/C3):** Introducing a "dead by registry" check and tmux-target process probe in the expiry saga solves the chronic 53-row applied-state hang safely and robustly. It allows the existing stale database rows to cleanly self-converge upon deployment without requiring separate, high-risk migration scripts.
* **FSM & Park Ledger Coherency (S5/C4):** Transitioning `sessions.status` from `ship_parked` to `completed` and settling the engine park ledger under the exact same database transaction as the hold closure is extremely clean and prevents subsequent reconciliation divergence.
* **Fast-Path Dispatcher Loop (S6/C5):** The `countDueResidentHolds` fast-path index query is computationally inexpensive and keeps dispatcher overhead minimal while satisfying the "release within 1 minute" requirement.
* **FLY-2477 Boundary Sequencer Renewal & Adopt (S9/C8):** The boundary sequel-renewal CAS on the Bridge and the "adopt" approach in the runner phase-lifecycle controller effectively prevent runner crash loops during Bridge restarts.

## Issues & Recommendations

1. **Error Handling on TMUX Probe in Saga Expiry**
   * **Severity:** MEDIUM
   * **Why it matters:** If the tmux CLI/adapter experiences transient timeouts or issues, `probeTarget` might throw an error. If allowed to propagate, the catch-block in `runResidentExpiryPass` will call `fail()`, which permanently marks the resident expiry operation as failed. Since failed operations are no longer considered pending, this transient failure would lock the hold from ever expiring.
   * **Suggested Fix:** In `delivery-operations.ts` under the Codex branch, wrap the `probeTarget` call in a local `try-catch` block. If it throws, log a warning and treat liveness as `indeterminate` (which safely retries on the next tick) rather than letting the entire expiry operation fail permanently.
   * **File evidence:** `packages/teamlead/src/bridge/delivery-operations.ts:165`

2. **Check for `null` `nowMs` in `enterResidentHold`**
   * **Severity:** LOW
   * **Why it matters:** In `StateStore.ts` inside `enterResidentHold`, the plan proposes setting `grace_expires_at` using `RESIDENT_GRACE_MS` directly, and we need to ensure that the newly-extended 3-hour constant is correctly applied and that `now` is strictly in line-item formatting.
   * **Suggested Fix:** Ensure `now` is properly validated as an ISO timestamp inside the transaction. S9/C8a should verify that the update `release_cause=NULL, release_source=NULL` uses capitalized `NULL` parameters in the `db.run` bind parameters to avoid binding the literal string `"NULL"`.
   * **File evidence:** `packages/teamlead/src/StateStore.ts:37903`

3. **Validation of `completed` Sessions in Divergence Candidates**
   * **Severity:** LOW
   * **Why it matters:** When the expiry saga transitions the session to `completed`, we must ensure the engine divergence checks (`listWorkflowDivergenceCandidates`) do not flag it as a divergence.
   * **Suggested Fix:** Confirm and document in the final verification that `listWorkflowDivergenceCandidates` does not produce divergence candidates for `completed` sessions. Based on `StateStore.ts:48714`, divergence is checked only for active/held runs where the session status is terminal. Since the run status is still `active` or `held` during this time, `listWorkflowDivergenceCandidates` will select it, but the observer `commitWorkflowDivergenceObservation` will correctly evaluate `divergence: false` because `completed` status is irreversible terminal for a zombie. No code changes are required, but verification must explicitly cover this.
   * **File evidence:** `packages/teamlead/src/StateStore.ts:48714-48742`

## Verdict
APPROVED — ready to implement
