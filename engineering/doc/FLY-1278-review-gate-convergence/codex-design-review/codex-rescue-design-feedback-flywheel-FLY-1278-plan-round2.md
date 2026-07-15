# Design Review — FLY-1278 plan.md (Round 2)

Date: 2026-07-15
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 materially addresses all eight Round 1 findings, and the overall design remains feasible without weakening the settled FLY-827/FLY-1188 protections. The production fixture is valid and matches the live R6-R9 database rows, but the revised plan still has two correctness contradictions around ruling snapshots and APPROVED-with-advisories, plus several smaller authority/delivery details that should be made mechanical before implementation. These changes refine the approved design rather than reopening its governance decisions.

## What's Good (Keep)

- The full-lane `FLYWHEEL_REVIEW_SEVERITY_POLICY=0` boundary is now coherent across effective verdict, prompt bytes, payload bytes, and new alerts. The proposed end-to-end sentinel is substantially stronger than the earlier mocked policy-only check.

- The post-verdict head path now branches on the effective verdict and preserves the exact-head echo requirement for every code approval, including downgraded approvals. Gate revalidation, head re-derivation, deliver-before-authority, and fail-close parsing remain intact.

- `response_json` plus `payload_version`, with one canonical builder and verbatim live/redrive delivery, is a sound simplification of the byte-ownership problem. Restricting legacy-shape acceptance to migrated NULL-version rows closes the reverse-compat hole identified in Round 1.

- The revised ruling record captures server-derived source provenance, exact review type, revocation attribution, notification state, and alias-aware issue scope. The request-id/index locator and server-rendered `findingKey` make the no-id fallback operable.

- The production alert/thread wiring is now explicitly in scope, including kind-contract exhaustiveness, failure visibility, and boot redrive. Keeping the ruling active independently of Discord availability is the correct authority boundary.

- The prompt budget, input bounds, shared fingerprint helper, automatic HIGH-dispute alert, and policy-off prompt rollback are good fail-closed details.

- The fixture is genuine: its recorded SHA-256 is `ccc985af7072d392aac34178ad544b2120ae43b6abc5207d8e903065a138447f`, it parses as four MEDIUM-only R6-R9 rows, and its selected fields match the current production DB export exactly. Splitting policy replay, R6 convergence, and policy-off sequential reproduction is the right test model.

## Issues & Recommendations

1. **The ruling snapshot cannot be loaded only after the reviewer returns and also feed that reviewer's GOVERNANCE prompt.** Section 3.1 lines 52-55 says the single, job-lifetime snapshot is read after the verdict, while the current `buildPrompt()` runs before `reviewRound` (`review-request-coordinator.ts:610-623`) and §3.7 requires active rulings in that prompt. The test “revoke while job is running does not affect this round” also contradicts a post-verdict read: a revoke during the subprocess would be visible when the snapshot is finally loaded. Load the alias-resolved active-ruling snapshot once before `buildPrompt`, pass that exact immutable snapshot into the prompt, and reuse it after the outcome for `computeEffectiveVerdict`; do not re-read at verdict time. Then the post-outcome sequence remains gate revalidate → compute from frozen snapshot → head/echo → persist/deliver/authority. Test both create and revoke while `reviewRound` is blocked: neither changes the current round, both affect the next round.

2. **The normal reviewer behavior introduced by the new prompt can still drop advisories from the advisory channel.** Section 3.7 tells the reviewer to vote APPROVED and list MEDIUM/LOW findings, but the effect flow only classifies findings on the CHANGES_REQUESTED branch, and the tests only cover “MEDIUM-only CHANGES → advisories.” Always decorate/classify findings independently of the gate decision. Reviewer APPROVED must remain APPROVED, but its unsettled MEDIUM/LOW findings must populate `advisories`, carry `findingKey`, appear in the frozen response, and trigger `review_advisory_pass`; otherwise the expected post-fix path bypasses the runner contract's `APPROVED-with-advisories` handling and Lead notification. Add APPROVED+MEDIUM, APPROVED+mixed MEDIUM/LOW, and APPROVED+HIGH/unknown tests; the latter must preserve the settled non-tightening rule while keeping the original findings visible.

3. **The authority identity and single-active invariant should be enforced deterministically at the database boundary.** The schema currently creates only a non-unique issue index, while §3.5 relies on an in-process check-then-insert. Add a partial unique index on `(project_name, issue_id_canonical, finding_key, review_type) WHERE revoked_at IS NULL`, using the existing StateStore partial-index precedent (`idx_deferred_active`, `StateStore.ts:1978`). Keep the transaction for idempotent read-after-conflict behavior. Also define a stable canonical-cluster representative (prefer the Linear UUID when known, with a deterministic fallback), and define finding-source selection: request-id/index is exact; a repeated stable id should select the latest delivered match only when all candidates resolve to one review type/identity, otherwise return 409. A duplicate create should return the prior row only when the requested disposition/follow-up/rationale semantics agree; conflicting intent must require revoke/recreate rather than silently reporting success.

4. **The production alert and Discord redrive contracts need their exact async/idempotency semantics stated.** Today `ReviewCoordinatorDeps.alertLead` is synchronous string-in (`review-request-coordinator.ts:94-95`), whereas `LeadAlertNotifier.alert` is structured and asynchronous (`LeadAlertNotifier.ts:353-374,619`). Specify the new structured async dependency, deterministic event ids (for example request id for advisory, ruling id for recorded/notify-failed, request+ruling for dispute), the late-bound routed-sink wrapper in `plugin.ts`, and awaited/caught failure behavior. Separately, `notified_at` gives at-least-once Discord delivery, not strict idempotence: a crash after POST success but before stamping can duplicate the ruling message. Either document/test that bounded duplicate as acceptable and include `ruling_id` in the post for correlation, or add a sink-side dedup/reconciliation mechanism; do not claim exact idempotent redrive from the timestamp alone.

5. **`plan.md` currently contains literal control bytes.** Line 115 embeds raw `0x00`, `0x1f`, and `0x7f` inside the validation regex, causing `rg` to classify the Markdown as binary and risking broken diffs/rendering. Replace them with the printable escaped form `[\u0000-\u001f\u007f]` and add a lightweight no-control-byte check for the design docs/fixture metadata. The fixture JSON itself is valid and does not have this problem.

## Verdict

CHANGES REQUESTED — address items above
