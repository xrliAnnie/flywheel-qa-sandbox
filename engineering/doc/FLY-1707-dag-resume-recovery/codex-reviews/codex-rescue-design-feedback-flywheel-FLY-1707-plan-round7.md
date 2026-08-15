# Design Review — plan.md (FLY-1707 E5) (Round 7)

Date: 2026-08-15
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 7 correctly closes the five Round 6 findings: the T7/T7b schema now enforces same-run aliases and complete claims, false-to-true replay has an explicit payload projection, `closeRunner` fencing covers early paths, and quarantine parsing is substantially more complete. The design remains feasible, but the new single-baseline protocol can still certify a node that actually launched from fallback input, and the quarantine rules still contain two representational errors that can lose copy/submodule state; those are correctness blockers for the locked V2 and half-done-work semantics.

## What's Good (Keep)

- Keep the composite T7 parent key and T7b foreign key. I reran the normative SQL with `PRAGMA foreign_keys=ON`: a cross-run alias is rejected, as is an ownerless `collecting` receipt.
- Keep the discriminated T7 claim CHECK and the one-open partial index; together they give the code-level owner/generation CAS a sound stored shape.
- Keep the normative operator-event change for `collectExecutions:true`, including comparison via `(payload.collectExecutions ?? false)` and omission on the false path. This accurately reconciles the design with `StateStore.ts:24843-24861` while preserving legacy event bytes.
- Keep one immutable run-level issue baseline rather than a run-wide “latest observation” scan. It is simpler and avoids cross-node observation selection.
- Keep moving the sticky collector authority check before all `closeRunner` early paths and explicitly fencing CommDB/gate finalization, detector clearing, archive, and every post-await continuation.
- Keep the explicit unmerged-index fail-closed path before `removeIfExists()`, per-stage blob preservation, executable-bit fidelity, and the expanded negative test matrix.
- Keep the established W1-W10 attachment inventory, mutation-time authority predicates, durable checkpoint store, reference liveness, two action kinds, one registered rollout flag, and post-FLY-1772 sequencing unchanged.

## Issues & Recommendations

1. **BLOCKER — A run-level baseline does not prove that the target writer actually received authoritative input.** Consider: node 1 establishes baseline `A`; W2 creates node 2's attachment and the rider stamps it from `A`; node 2's current `createFetchIssue()` call fails Linear and delivers `session.summary = S` (`run-infra.ts:223-270`); node 2 crashes; Linear later returns unchanged `A`. The resolver compares current `A` with baseline `A` and passes V2 even though the crashed writer actually ran with `S`. The same hole applies to a W10 child marked atomically ready. “Fallback produces no V2 evidence” is not sufficient because an older run-level baseline already exists and T1/T2 has no per-writer negative evidence. Preserve the single baseline, but add an exact launch-delivery contract: before an engine target can be recoverable, its `(run,node,attempt,execution,activation)` must either have an authoritative delivery receipt matching the baseline or be explicitly marked resume-ineligible on fallback/different input. A fallback must synchronously invalidate/fence that target attachment before the prompt proceeds; if fallback occurs before any baseline, write a terminal run-level unavailable sentinel so a later node cannot establish a late baseline over earlier fallback-produced work. For W10, either require the replacement's delivery receipt before its child attachment is ready or dispatch the admission-frozen S3 body explicitly. Add the exact five-step sequence above, first-launch-fallback-then-later-success, and consecutive-resume-fallback tests.

2. **HIGH — The first-writer-wins baseline append semantics need to name the correct StateStore primitive.** The plan says `event_uid UNIQUE` “naturally dedupes,” but the codebase has two materially different APIs: `appendWorkflowRunEvent()` keeps the first UID without comparing payload, while `appendWorkflowRunEventChecked()` throws `workflow_event_uid_conflict` when a later authoritative fetch has a different `updatedAt/bodyDigest` (`StateStore.ts:31151-31231`). Most new authority receipts correctly use the checked form, so leaving this implicit is risky at this seam. Specify a dedicated transaction-local `ensureWorkflowIssueBaselineTx`: first committed authoritative observation wins; an existing well-formed baseline is adopted without comparing the new candidate body; malformed/wrong-run/wrong-kind rows fail closed. It must receive the run ID explicitly from `Blueprint.generalizedExecutionContext` rather than derive an active run from issue ID. Test two authoritative fetches with different bodies and concurrent ordering: neither ordinary launch may fail, exactly one immutable baseline remains, and the newer body makes V2 report `envelope_changed`.

3. **HIGH — Porcelain type `2` cannot apply the same source deletion rule to both rename and copy.** The v2 record includes `<X><score>` specifically to distinguish `R100` from `C75`. A rename removes the original path; a copy must retain it. The current normative sentence says rename/copy both perform “source deletion + destination entry,” so a detected copy would be archived without its source file. Branch on `R` versus `C`, reject unknown scores fail-closed, and add a copy test that proves both paths exist in the quarantine commit; the existing rename test proves only the deletion case.

4. **HIGH — Mode `160000` does not by itself preserve a dirty submodule.** Porcelain-v2 exposes a separate `<sub>` field (`S<c><m><u>`). A superproject tree can preserve a gitlink commit, but it cannot encode modified or untracked files inside that submodule; recursively deleting the worktree after writing only mode `160000` would lose those half-done bytes. Narrow “supported 160000” to clean/staged gitlink pointer changes whose object is verified, and fail closed before rebuild whenever the submodule `m` or `u` bit is present (or define a separate bounded recursive archive, which is likely unnecessary scope). Add clean-gitlink and dirty-submodule tests; the dirty case must leave the original worktree untouched.

5. **MEDIUM — “Zero event effects” on stale collector takeover conflicts with the existing authority-loss audit.** `abortAuthorityLost()` currently appends `lead_close_runner_authority_lost` (`close-runner.ts:592-610`), which is useful diagnostic evidence and consistent with D5. Rewrite the three takeover assertions as zero close-success/session mutation/finalization/archive effects while allowing (preferably requiring) the single idempotent authority-loss diagnostic. Otherwise an implementation could satisfy the literal test by deleting observability rather than only fencing destructive work.

## Verdict

CHANGES REQUESTED — address items above
