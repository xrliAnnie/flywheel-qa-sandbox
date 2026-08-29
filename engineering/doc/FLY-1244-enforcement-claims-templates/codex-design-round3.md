# Design Review — FLY-1244 plan.md (Round 3)
Date: 2026-07-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 3 corrects the central security overclaim from Round 2. The plan now says plainly that head binding prevents a caller-selected-head attack but does not authenticate the verdict, rejects the env credential as compliant with the authoritative umbrella, and escalates the resulting transport/spec choice to the people who can make it. The durable replay transaction, explicit execution binding, founder-event allowlist, projector receipt/dead-letter, Codex-review boundary, and operational recovery path are all meaningful advances.

Leaving the transport choice open is an acceptable **design-phase stopping point** if the work is recorded as blocked on governance. It is not an acceptable terminal state for an `APPROVED` implementation plan. Option A intentionally requires a separate native-broker design review; option B intentionally requires a governed amendment to the authoritative umbrella. Until one happens, commit B has no approved authentication boundary. Production `READ=0` limits rollout risk but does not complete that design contract, and the unconditional branch (e) means merging the read-switch is not behavior-neutral.

The transport decision is also not the only remaining closure. The plan still overclaims founder-race safety, does not actually wire one authoritative head resolver across submission and all ship surfaces, retains the disproved E2E assertion in §7, leaves execution binding as two alternatives, and has several executable-contract contradictions in the source projector, re-QA recovery, and template section. These are bounded fixes rather than another architecture reset, but they need to be incorporated before implementation authorization.

## What's Good (Keep)

- Keep the explicit rejection of an env bearer under the current umbrella §2.2. This is the correct conclusion from the same-user/shell-snapshot evidence.
- Keep the honest split between subject integrity and verdict authentication. `server-captured head` and `authenticated submitter` are separate invariants and must remain separately tested.
- Keep the governance fork explicit. Option A preserves the current security contract; option B requires an explicit spec amendment and acceptance of a named residual rather than silently weakening the contract in this sub-issue.
- Keep the RED test independent of capability transport. Branch (e) closes the unconditional durable-three-stage `qa_required=0` hole without pretending that it proves the production producer path.
- Keep the single durable `submitWorkflowDecisionByCredential` state machine for the bearer-based branch. Atomic claim creation/replay recording and exact replay after response loss plus Bridge restart resolve the core Round 2 crash-recovery objection conceptually.
- Keep admission-created run/node/attempt identity and explicit enrollment before launch. The ship gate needs a server-owned lookup rather than issue-level inference.
- Keep the exact founder response allowlist and the projector as the sole `founder_approved` writer.
- Keep the destination receipt, canonical payload digest, durable dead-letter, and caller-stable TURN source id. These give the cross-DB projector a recoverable shape.
- Keep `codex-review-result` on FLY-827 and limit this sub-issue to marker sanitation; keep materialize/node outputs and founder mutation routes deferred intact.
- Keep the live-`.env` FORCE resolver, semantic 1204 absorption matrix, three reviewable commits, and sanitized OS proof.

## Issues & Recommendations

1. **[HIGH] The open transport decision is a valid escalation, but not an approvable commit-B design.**

   **Issue:** Section 12 correctly identifies a human-owned governance decision, but §0 still presents one implementation PR and §12 says read-switch/gate/enrollment can proceed while commit B's authentication boundary is unset. Option A is not yet fully designed: socket ownership, native boundary, `LOCAL_PEERPID` availability, PID ancestry/PID-reuse handling, tmux-process binding, supported platforms, restart behavior, and failure modes are all delegated to another issue/design review. Option B has no selected delivery contract after rejecting env credentials; it only becomes coherent if governance explicitly permits the env/bearer residual while amending §2.2.

   **Why it matters:** An implementer cannot finish or verify the transport-dependent admission/submission state machine from this plan. `READ=0` prevents production claims reads, but branch (e) is unconditional for durable three-stage rows, so merge/restart is not a neutral staging action unless FORCE is deployed.

   **Suggested fix:** Mark commit B **blocked before implementation/merge** on a Gate-0 artifact containing the signed governance decision, the umbrella amendment or reviewed native-broker design, exact supported-platform contract, selected DDL/API, and branch-specific negative tests. If A/C should proceed independently, split their mergeability from B or state that the single PR remains draft until Gate-0 closes. Add the governance decision and selected transport test result to §6's deployment checklist. With the requested binary review status, an explicit blocked item maps to `CHANGES REQUESTED`, not conditional approval.

2. **[HIGH] Founder-approval use-time safety covers head drift but not same-head challenge/hold drift.**

   **Issue:** Section 3.2 says the unavoidable cross-DB race is safe because an old-head claim fails at use time. That only handles a head change. If `review_question_id` is rebound to a new challenge on the same head between the StateStore read and CommDB commit, the frozen old response can still project a `founder_approved` claim for the current head. A hold can likewise appear without changing the head. The current claims resolver filters run/node/decision/subject and does not require `authority_id` to match the current founder challenge. Section 3.1 also still says the check-to-write race is eliminated by re-reading inside the write transaction, contradicting §3.2.

   **Why it matters:** The claims path can accept an approval that the legacy `verify-approval` path would reject because it is no longer bound to the current `review_question_id`. This is a founder-authority bypass on the same head, not merely stale harmless history.

   **Suggested fix:** Bind the projected claim's `authority_id` to the frozen server-owned question/challenge generation and enforce at **USE time** that it is still the current challenge, or append a revocation whenever the binding/hold generation changes and make that revocation atomic with the change. Projection-time checking alone is insufficient because the binding can change after projection. Remove the §3.1 race-elimination sentence and add same-head question rebind and hold-transition races to AUTH/T1.

3. **[HIGH] `capturePhaseHeadSha` is not presently the shared submit/ship authority the plan claims.**

   **Issue:** `capturePhaseHeadSha` is an injected `PhaseOrchestrator` effect assembled in `plugin.ts`; it is not a shared resolver exposed to the new broker. Current ship decisions accept a caller-supplied `prHead`: event and completion paths commonly pass `sessions.pr_head_sha` or completion evidence, and the CLI explicitly accepts `--pr-head $(git rev-parse HEAD)`. The commit-B file list does not include the plugin composition, `merge-ship-gate`, event/completion sinks, or a new shared resolver.

   **Why it matters:** Capturing the head server-side at submission does not establish `claim.subject == authoritative ship head` if shipping compares it with a different, externally populated value. The H1→H2 test can pass in a narrow fixture while a real finalization surface still supplies stale or self-reported H1.

   **Suggested fix:** Define one exported head-authority interface and wire it at both submission and every ship/finalization entry point. Specify whether authority is persisted-worktree `git rev-parse` or an authoritative remote PR-head lookup, how missing/cleaned worktrees fail closed, and how session/evidence values are only compared or cached. Add integration tests for event-route, `DirectEventSink`, complete-marker reconciliation, external-merge reconciliation, and recovered-merge finalization. Update the file list accordingly.

4. **[HIGH] Section 7 still contains the verdict-authentication claim that §4.1 correctly removed.**

   **Issue:** E2E step 4 still requires that a sibling holding the env credential cannot make fake PASS affect shipping because the server captures the head. That is exactly the disproved Round 2 claim and directly contradicts §4.1 and the L1 matrix. Sections 2.1, 2 decision #2, and risk #2 also continue to call head binding the load-bearing/main fix in language that can be read as independent of verdict authentication.

   **Why it matters:** No honest Option-B test can meet §7 step 4; a stolen credential can submit PASS for the real head. The plan would either fail its own E2E or tempt implementation to weaken the test.

   **Suggested fix:** Make §7 branch-specific: Option A must prove the sibling cannot produce or replay B's decision; Option B must record the accepted ability to forge PASS during the credential lifetime and test only the remaining honest guarantees (server-selected head, exact replay, mismatched/no-credential rejection). Scrub every claim that head binding alone closes verdict forgery. Also correct §9: `codex-review-result` gets marker sanitation only, not the new submission surface.

5. **[MED] The submission-credential DDL/API is not neutral across the two governance options.**

   **Issue:** `credential_hash TEXT NOT NULL UNIQUE` is annotated as optional for Option A, which is impossible under the shown DDL. A peer-authenticated connection also cannot call a function whose contract is `submitWorkflowDecisionByCredential` without a defined durable peer/execution authority record. The table has no authority-kind discriminator, foreign keys, family/revocation CHECKs, or exact relationship to the existing `workflow_decision_capability.authority_id` and its single-transaction semantics.

   **Why it matters:** Round 2's crash window is resolved only for a bearer branch. Selecting Option A would require a materially different schema/API during implementation, while selecting Option B still leaves constraint and replacement semantics open.

   **Suggested fix:** Finalize this after Gate-0 as a selected, executable schema. For A, define a peer-bound submission authority/replay row and `submitWorkflowDecisionByPeer`; for B, keep the credential-hash path. In either case add FKs/CHECKs, a one-live-authority-per-attempt rule, exact capability linkage, replacement authorization, and fault-injection tests around the single transaction.

6. **[MED] Execution binding remains an alternative, not an immutable/current-attempt contract.**

   **Issue:** Section 4.2b says either add `UNIQUE(execution_id)` to `workflow_run_node` **or** introduce a dedicated table. The current `upsertWorkflowRunNode` can update `execution_id`; a unique index alone does not make the binding immutable. The plan also says stale executions fail closed but does not define the query that establishes the bound attempt is the authorized/current QA attempt. The resolver selects the maximum claim attempt, so merely passing the old binding's node id can resolve a newer attempt.

   **Why it matters:** A stale or reassigned execution can select the wrong enrollment/claim even though lookup is unique. Existing duplicate/null data can also make index migration fail without an explicit preflight.

   **Suggested fix:** Choose one schema now—prefer an append-only execution-binding table or an immutability trigger plus unique index—define migration/preflight behavior, and specify the exact status/current-attempt predicate used by both producer and reader. Test reassignment, an old execution after a new attempt, duplicate pre-migration rows, and a binding whose run/node no longer matches the admitted attempt.

7. **[MED] The proposed re-QA command violates phase ordering for in-flight design/implement work.**

   **Issue:** Section 4.5c says design-, implement-, and QA-in-flight cases all converge immediately to a new QA attempt. Design or implementation may not be complete, so starting QA can test an incomplete worktree, contend for TURN, and bypass the three-stage handoff. The command is also left as `flywheel-comm re-qa --issue` **or** a Bridge API, with issue-level idempotency rather than an exact run/node/attempt authority.

   **Why it matters:** The rollout recovery itself can violate the orchestrator state machine. This is especially risky because branch (e) is unconditional after restart.

   **Suggested fix:** For in-flight design/implement, continue the existing phase and ensure its later handoff creates a newly admitted/credentialed QA attempt; use FORCE during the transition if current ship surfaces would otherwise evaluate it. Only an already-running uncredentialed QA should be superseded/revoked and respawned. Pick the authenticated Bridge command/API, bind idempotency to run plus QA attempt, and add the actual command/registration files to §9.

8. **[MED] The source/projector contract still has internal schema and dependency gaps.**

   **Issue:** The shown `turn_source_history` DDL lacks the later-required `UNIQUE(source_event_id)`, and the `grantTurn` implementation bullet is duplicated. The project/issue-level TURN destination is named but has no table or API. Commit A is ordered before commit B's execution binding, yet §3.3 says TURN run identity is resolved through §4.2b. Finally, `canonicalSubmissionDigest` currently lives in the higher-level teamlead package, while CommDB source events are created in flywheel-comm; “reuse” does not state a legal dependency direction.

   **Why it matters:** TURN retry can still double-advance or become unprojectable, and A cannot be independently implemented from its stated inputs. Two packages may silently canonicalize payloads differently and turn exact replay into poison.

   **Suggested fix:** Put the unique constraint in the actual DDL, define the project/issue history destination and its receipt result, specify stable-id lookup before epoch mutation in the same CommDB transaction, and remove the dependency on a B-only binding or reorder the prerequisite. Move canonical JSON/digest to a lower shared package, or deliberately duplicate it with a cross-package contract test.

9. **[MED] The template section is closer, but still not the claimed executable/normative contract.**

   **Issue:** Section 5.1 labels the SQL executable but supplies trigger comments instead of `CREATE TRIGGER` statements and expresses `project_scope`, `seed_owner`, and action domains only in comments, without CHECKs; the audit table has no append-only trigger. Section 5.3 allows node types `design|implement|qa|gate` while saying `agent_file` is allowed only for nonexistent `generic`. The exact YAML manifests are future commit-C deliverables rather than design artifacts available for review, and the per-run override grammar remains undefined. `manifestReviewFamilyOk(authorNodeVendor, reviewerNodeVendor)` also accepts manifest-declared vendors, while the authoritative rule requires resolved backend/model identity. Decision table #3 still says to reuse `crossFamilyReviewSatisfied`, contradicting §5.5.

   **Why it matters:** Loader, publisher, admission, and later dispatcher can implement mutually incompatible contracts while passing prose-level acceptance. The family check can trust the very manifest self-report the umbrella says is not authoritative.

   **Suggested fix:** Include the real triggers/CHECKs/indexes, resolve or remove `generic`, define the exact override schema and allowed mutation paths, and add the three canonical YAML files as reviewed design inputs before implementation begins. Make the admission comparator consume resolved adapter families/models (using `adapterTypeToFamily` only for vocabulary) and correct decision #3. Keep the exact model ids and ship-claim set already specified.

10. **[LOW] The file/defer/deployment matrices need one final consistency pass.**

   **Issue:** Commit B omits `StateStore.ts` for its new table, transaction, enrollment, and binding; omits the re-QA command/CLI registration and shared head resolver wiring; and assigns `codex-review-result` to the submission surface despite §4.5b. Section 10 calls peer credentials an unconditional follow-up although Option A makes it a hard prerequisite. Section 6 does not require the governance/spec artifact.

   **Why it matters:** Review boundaries and implementation ownership will drift even after the architecture decision is made.

   **Suggested fix:** Regenerate §9/§10/§6 after Gate-0, with branch-specific files, explicit prerequisites, and a checklist item proving the selected contract and authoritative-spec state.

## Verdict

CHANGES REQUESTED.

The transport decision may legitimately remain escalated at the end of this design round, but the document should then be treated as **blocked on governance**, not implementation-approved. Once Gate-0 is resolved, the remaining fixes are bounded: close founder authority at use time, wire one real head authority across all ship paths, remove the stale E2E claim, choose the execution/replay schemas, correct phase-safe recovery, and make the projector/template contracts internally executable. No further wholesale redesign is indicated.
