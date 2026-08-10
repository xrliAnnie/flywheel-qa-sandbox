# Design Review — plan.md (FLY-1655) (Round 4)

Date: 2026-08-08
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 4 resolves the carrier-branch, founder-race ordering, permanent-lifetime, replay-compatibility, and acceptance-text problems from Round 3. The plan is now close to implementation-ready, but three remaining contracts still affect founder authority or deployment truth: R1's approval classification is narrower than production verification, R3's convergence receipt is not explicitly atomic, and built-mode stamp refresh can relabel an old artifact as a new build.

## What's Good (Keep)

- Keep the R0–R3 saga ordering. Using CommDB's guarded unanswered CAS before teamlead authority rotation gives the founder response and operator reissue a defensible linearization point.
- Keep the separate same-carrier and replacement-carrier SQL/CAS branches, the exactly-one-qid-owner assertion, refusal of approved gates, and same-transaction creation of the new ship-target binding.
- Keep same-holder transport rotation, immutable evidence preservation, no new workflow node attempt, canonical request conflict handling, and the corrected old-qid versus old-execution acceptance criteria.
- Keep A1/A1-boot as written; the request and boot proofs now remain fail-closed without weakening holder ownership.
- Keep C's failure lanes, durable visibility thresholds, and terminal-before-marker-move order.
- Keep D's conflict-free projection proof, external no-code observation plus in-transaction revalidation, and durable death receipts.
- Keep F2's persisted lifetime derivation, byte-compatible bounded digest, permanent derived claim, fresh internal capability, exact replay behavior, and migration fixture.
- Keep G's safe ancestry direction and explicit source/built/unknown modes; only the built-mode representation needs one final correction.

## Issues & Recommendations

1. **R1 must use the exact production approval policy, not “canonical founder id” alone.** `verifyApproval` accepts a structured `{approved:true}` response when its writer passes the shared `isTrustedApprovalAttribution` policy: the configured founder Discord id, `bridge`, or `bridge-founder-consent` (`verify-approval.ts:506-556`; the enforce path writes `bridge-founder-consent`). It also has established behavior when attribution gating is disabled or the founder id is unresolved. If gate-reissue treats only the Discord founder id as trusted, it can classify a valid card/action/enforce approval as non-founder and rotate the gate, violating the promise that reissue never invalidates a completed founder decision. Define R1 as reuse of the same structured-response parser, founder-attribution helper, founder-id resolution, and effective attribution-gate policy used by canonical verification—ideally one shared function, not a copy. A terminal/answered row whose authority cannot be conclusively classified must fail closed with a typed operator reason rather than proceed as “terminal invalid.” Add winning-response cases for founder id, `bridge`, `bridge-founder-consent`, untrusted Lead, malformed JSON, explicit rejection, and unresolved-policy behavior.

2. **R3 needs an atomic and repairable `completed + converged receipt` transition.** `advanceWorkflowGateHolderMaterialization` currently updates the holder and returns without a surrounding transaction (`StateStore.ts:32131-32188`). If implementation appends `gate_reissue_converged:<requestId>` afterward, a crash can commit `materialization_stage='completed'` but lose the receipt; the normal materialization query excludes completed holders, so no later tick repairs it. Wrap the completed-stage CAS and idempotent convergence-event append in the same teamlead.db transaction. Also handle the already-completed/idempotent branch by ensuring a missing convergence receipt is appended, so replay can repair fixtures created by an older build or an interrupted rollout. The event lookup must match the exact `(run, holder PK, new qid, requestId)` tuple before writing. Add two crash tests: before the transaction commits neither state nor receipt is visible; after commit both are visible, plus a seeded completed-without-receipt fixture that one replay repairs.

3. **A mutable built-mode stamp must not redefine which commit produced an unchanged artifact.** The plan first defines built identity as a build-time embedded SHA, then allows a metadata-only stamp refresh to say the old artifact “represents” a newer intended commit without recompilation. Those are different facts. The current change classifier is not a closed cryptographic description of all build inputs, so a missed build-relevant path could advance `/health.buildSha` and `deployed-sha` while old code is running—the same false deployment truth Fix G exists to prevent. The simplest structural rule is: in `mode=built`, disable `SKIP_BUILD` whenever intended SHA differs from the immutable artifact build SHA and produce a newly stamped artifact; source mode may retain doc-only skips. If avoiding a rebuild is essential, expose separate immutable `artifactBuildSha` and `checkout/intendedSha` fields plus an artifact hash, and permit no-build advancement only after a closed build-input manifest proves the diff cannot affect the artifact. Do not overwrite or reinterpret `artifactBuildSha`. Update the health schema and tests so a metadata write alone cannot turn stale executable bytes into an accepted new build; also assert F2's fresh internal capability has `issued_at < expires_at <= absolute_deadline_at`, not merely non-null timestamps.

## Verdict

CHANGES REQUESTED — address items above
