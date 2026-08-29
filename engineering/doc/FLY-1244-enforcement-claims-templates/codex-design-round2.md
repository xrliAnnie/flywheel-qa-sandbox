# Design Review — FLY-1244 plan.md (Round 2)
Date: 2026-07-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 is a substantial improvement. The plan now uses the existing shared approval writer, gives the cross-DB projector a destination receipt and a single founder-claim writer, defines a coherent READ/enrollment/FORCE truth table, keeps the legacy coordinator as the orchestration driver, defers unauthenticated template mutations and materialize/node outputs, and replaces broad 1204 cherry-picks with semantic integration. Those changes resolve most of the Round 1 architecture findings.

The remaining blocker is concentrated in the capability design. A server-captured head prevents a caller from choosing a false subject, but it does **not** authenticate the verdict. If sibling A reads B's proposed env submission credential, A can submit `qa_passed`; Bridge will faithfully stamp B's identity and the real current head H, and the ship gate will accept the forged PASS for H. A never needs to forge or control the head. Consequently the preferred Gate-0 candidate cannot pass L1 as written, does not satisfy the RED test's “server-verifiable evidence” requirement, and conflicts with the still-authoritative umbrella §2.2.

The new submission credential also lacks a durable schema and a single transaction joining credential replay state to the existing decision-capability/claim transaction. Exact replay after `claim commit -> response loss` is therefore not implementable from the described opaque marker. The ship gate likewise still lacks the exact, unique `execId -> (run,node)` lookup required by the existing resolver. These need to be settled in the design before the read switch is safe to implement.

## What's Good (Keep)

- Keep the explicit threat-model statement. It correctly records that shared-user tmux input injection and filesystem isolation cannot be solved by TypeScript process conventions.
- Keep the fd path deleted. The current `tmux new-window` process tree cannot carry a Bridge-opened fd into the pane.
- Keep decision-capability and transport credential as distinct concepts. That is the right vocabulary, provided their transaction and recovery relationship is made concrete.
- Keep the complete QA gate ordering: QA_DONE bypass, live FORCE rollback, durable-role classification, READ plus typed run enrollment, and fail-closed unenrolled three-stage recovery.
- Keep the live-`.env` FORCE resolver and resolve it before opening or querying claims tables.
- Keep the fail-closed admission seam before runner launch. The current shadow writer is intentionally best-effort and cannot be promoted into an authorization boundary.
- Keep claims additive to the existing `AutoQaCoordinator` drive in this sub-issue. Deferring claim-driven orchestration to D avoids adding an unnecessary second crash-sensitive driver here.
- Keep the projector as the sole founder-claim writer, with a destination receipt committed in the same StateStore transaction as the claim/run event.
- Keep routing all approval surfaces through one enhanced `writeGateResponseAndRunPostWrite`-based primitive and mutation-testing both the primitive and every production edge.
- Keep template mutation endpoints out of B. Read-only routes plus internal StateStore APIs do not pretend that loopback/Origin checks authenticate the founder.
- Keep materialize/node outputs deferred intact, the more precise 1204 semantic matrix, the three reviewable commits, and sanitized OS proof output.

## Issues & Recommendations

1. **[HIGH] Head binding does not stop a stolen credential from forging the verdict.**

   **Issue:** Sections 4.1/L1 assert that sibling A may obtain B's env credential but cannot make a fake PASS affect shipping because Bridge captures the real head. The actual flow proves the opposite: A submits `qa_passed` with B's bearer credential; Bridge derives B's issuer/execution and current head H; `qa_verdict` permits `qa_passed`; the resulting claim is valid for H. No head forgery is necessary. One-time consumption only turns this into a first-writer race and can let A both forge PASS and deny B's real verdict.

   **Why it matters:** This is the load-bearing security claim of §4. The preferred env path recreates cross-run impersonation for the only field that matters—the verdict—even though it fixes caller-selected `--pr-head`. It also makes the proposed L1 E2E impossible to pass honestly.

   **Suggested fix:** Do not admit the env credential path under the current acceptance contract. Select a transport that binds the call to B's execution without exporting a bearer to sibling A (a concretely designed resident helper with an enforceable caller boundary, native peer credentials/process ancestry, or a separate OS principal). If governance intentionally accepts bearer theft, remove the false L1 assertion and explicitly state that a same-user sibling can forge B's PASS; however, that is a material weakening of the RED-test/umbrella security contract and should not be presented as server-verifiable issuer evidence. Also name the trusted head resolver—preferably the existing `capturePhaseHeadSha`/worktree `git rev-parse` seam or an equally authoritative PR-head source—and prove the ship-time head uses the same authority.

2. **[HIGH] Gate-0 is still an unresolved architecture decision and conflicts with the declared authoritative umbrella spec.**

   **Issue:** The plan says the FLY-1135 plan remains authoritative, but umbrella §2.2 explicitly forbids secrets in shared env/filesystem and requires a sibling that knows B's execution/head and can enumerate `~/.flywheel` to remain unable to produce or replay B's decision. Round 2 permits precisely that credential disclosure. The alternative helper has its spawn, invocation, caller proof, and recovery left to the spike, while native peer credentials are deferred. Section 12 nevertheless says there are no open items.

   **Why it matters:** Implementation can choose among mechanisms with different security properties, storage, native-code needs, and adapter changes without another design review. That is not a closed implementation plan, and C/D will otherwise continue building against a contradictory upstream contract.

   **Suggested fix:** Make Gate-0 a separate blocking design checkpoint: record the selected transport, process/IPC boundary, caller-binding proof, supported backend/platform matrix, secret surfaces, restart behavior, exact files, and negative-test results; then update §4.1 before commit B begins. Amend the umbrella spec in the same governed change if Tadashi's narrower threat model truly supersedes §2.2, or conform this plan to the current umbrella. `开放项` must list the transport until that checkpoint is approved.

3. **[HIGH] The persisted submission-credential replay state is missing, so the promised crash recovery is not atomic.**

   **Issue:** The plan introduces a server-persisted submission credential hash but gives it no table, constraints, StateStore API, or file-list entry. It then calls `issueWorkflowDecisionCapability()` followed by `submitWorkflowDecisionClaim()`. Those are separate transactions. If claim submission commits and Bridge crashes before recording the submission credential's result, a retry cannot reconstruct the plaintext decision token; issuing another capability for the same attempt is refused because a sibling capability for that attempt was consumed. The marker's request id/digest cannot authenticate or locate an authoritative replay by itself. “Retry with a still-valid submission credential” also diverges from the substrate, which returns an exact consumed replay before checking expiry.

   **Why it matters:** The most important existing recovery window—claim committed, response/marker acknowledgement lost—can strand the runner or cause a conflicting re-mint. Bridge restart is explicitly part of the acceptance matrix.

   **Suggested fix:** Specify one durable state machine and one StateStore transaction. For example, add a `workflow_submission_credential` row keyed by a token hash and bound to `(run,node,execution,attempt,family)` with expiry/deadline, consumed request id/digest, and claim id; expose a single `submitWorkflowDecisionByCredential` transaction that authenticates it, derives/validates the internal capability, writes or returns the claim, and records the replay result atomically. Exact replay must work after response loss and Bridge restart; mismatched replay must fail. Add DDL, append/update constraints, credential replacement/revocation rules, and fault injection at every state transition. Do not rely on a Bridge-memory decision token after restart.

4. **[HIGH] The ship gate has no exact `execId -> run -> QA node` resolution contract.**

   **Issue:** `evaluateQaShipGate` receives only `execId` and `prHead`. `workflow_run.claims_read_enrolled` is run-scoped, while `workflow_run_node.execution_id` currently has no unique constraint. The existing `resolveWorkflowDecisionClaim` also requires the QA `nodeId`; omitting it deliberately queries `node_id IS NULL`, which cannot resolve a runner-node QA claim. The plan's phrase “该 run” and its SQL-reimplementation requirement do not define this mapping or its ambiguity behavior.

   **Why it matters:** The gate can read enrollment or claims from the wrong active run/attempt, or fail to find a valid QA claim despite successful production. The unchanged RED fixture avoids the lookup by taking branch (e), so it cannot catch this production defect.

   **Suggested fix:** Have the fail-closed admission transaction create an immutable, unique execution binding to `(run_id,node_id,attempt)`—either a dedicated table or a suitable unique constraint/index on `workflow_run_node.execution_id`. Define the exact readonly join used by `flywheel-comm`, including active/completed status semantics. Missing or multiple bindings must fail closed; only the uniquely bound run's enrollment may select branch (d), and its bound QA node id must be passed to both resolvers. Add contract cases for two runs on one issue, repeated attempts, stale executions, missing binding, and deliberately duplicated/corrupt bindings.

5. **[HIGH] The shared writer does not yet define which responses are allowed to mint `founder_approved`, and its cross-DB race claim is too strong.**

   **Issue:** The shared writer handles both approval and feedback, plus founder-consent off/audit/enforce and `/actions/approve`. Current `verifyApproval` accepts only structured `approved:true` with trusted attribution (canonical founder, `bridge`, or enforce-mode `bridge-founder-consent` when attribution is available); Lead-attributed pass-through/audit responses are intentionally refused. The plan freezes `actor/classification` but never gives the projector's exact allowlist. A broad “founder_approval” source event would let a Lead-attributed or feedback response become a founder system claim. Separately, session binding/head/hold live in teamlead.db, so reading them while a CommDB transaction is open cannot eliminate their cross-database check-to-write race.

   **Why it matters:** `founder_approved` is system authority. Projecting the wrong response class silently bypasses the attribution protection that the legacy reader already enforces.

   **Suggested fix:** Define the source-event predicate exactly: only a successfully inserted structured `approved:true` response whose actor/classification is equivalent to `isTrustedApprovalAttribution` may project `founder_approved`; feedback and off/audit Lead writes must not. State how the founder-id-unavailable and attribution-kill-switch cases behave during dual write. Implement response plus source with a CommDB conditional insert equivalent to `insertResponseIfGateOpen`, freeze the last StateStore binding/head read, and acknowledge the unavoidable cross-DB race; safety comes from the old-head-bound claim failing at use time, not from a nonexistent joint lock. Add races for head/binding/hold changes between StateStore read and CommDB commit.

6. **[MED] The source/projector contract still needs exact destination and TURN identity schemas.**

   **Issue:** `applyWorkflowSourceEvent` names a receipt tuple but no receipt table/DDL, result schema, or canonical digest algorithm. TURN payload freezes holders/epoch but not the target workflow `run_id`/node, even though `workflow_run_event.run_id` is mandatory and execution ids are not uniquely mapped today. `turn_source_history.source_event_id` is neither unique nor related to the composite source key, and no stable source-event id/retry rule prevents a retried grant from incrementing epoch twice.

   **Why it matters:** Founder projection can be made idempotent while TURN projection remains ambiguous or duplicate. Poison-event isolation also needs a durable disposition or it will be retried forever without an auditable terminal state.

   **Suggested fix:** Add executable DDL for the destination receipt/dead-letter state, canonical JSON/digest rules (reuse the repository's sorted-key canonicalization where possible), and exact replay return values. Freeze the run/node identity needed by a TURN run event, or explicitly define a project/issue-level destination that does not pretend to be a run event. Make the source event id caller-stable for retries, constrain one TURN history row per source event, and test retry-before/after current-state update without double epoch advancement.

7. **[MED] The template section is still not the claimed executable DDL or exact normative manifest.**

   **Issue:** Section 5.1 is a prose column outline, not executable SQL; it omits FKs, CHECKs, indexes, the exact publication key/trigger, audit storage, and seed ownership needed to detect “founder modified.” Section 5.3 leaves `condition: enum`, required/optional keys, override grammar, loop-edge linkage, supported schema version, and nested unknown-key boundaries undefined. Section 5.6 is an inventory table, not three exact manifests with node/edge ids, conditions, handoff pointers, terminal gate, and ship policy. The publication CAS SQL also does not say that pointer CAS plus publication insert are one transaction or verify that the target revision belongs to the template.

   **Why it matters:** The loader, seed importer, publication API, and later D dispatcher can implement different contracts while all appearing to follow the plan. This was the remaining bounded part of R1#11 and is still mislabeled “无省略、可执行.”

   **Suggested fix:** Put the actual SQL and three canonical JSON/YAML manifests in the plan or directly referenced design artifacts, with concrete repo paths. Enumerate edge conditions and override keys, define canonical serialization/digest behavior, and specify the single publication transaction and seed ownership/update algorithm. Reuse `adapterTypeToFamily`/the shared family vocabulary, but introduce an admission-specific author-vs-reviewer comparator; `crossFamilyReviewSatisfied` is a legacy review-record verdict function with `status/skipped` semantics, not itself a template admission API.

8. **[MED] `codex-review-result` is still ambiguously inside the capability migration.**

   **Issue:** The file list moves both `qa-result` and `codex-review-result` to the new submission surface, but the canonical B templates do not require `codex_approved`, existing FLY-827 remains the authoritative legacy code-review gate, and the plan defines fail-closed admission only for the three-stage QA node. It does not identify the run/node/attempt or enrollment seam that would authorize today's code-review execution.

   **Why it matters:** Implementers may either invent a review-node mapping or accidentally change the main FLY-827 path despite the stated “本单不改.” Marker sanitation and claim production are separate changes.

   **Suggested fix:** State one of two contracts explicitly: keep `codex-review-result` on its existing authority path in B and only sanitize its marker; or define the enrolled review execution binding, capability family, claim producer, and consumer now. If the latter is intended only for future template review nodes, move its production wiring to D and retain substrate-level E6 tests here.

9. **[MED] In-flight rollout recovery remains named but not executable.**

   **Issue:** Branch (e) intentionally changes behavior even with READ off: every durable three-stage QA row without a unique enrolled run fails closed. The checklist says target runs must be enrolled or FORCE enabled, but it does not define the operator/reconciler action that turns an existing design, implement, or QA session into a fresh admitted re-QA attempt. The umbrella explicitly requires those three in-flight classifications.

   **Why it matters:** A correct fail-closed gate can still create an avoidable deployment outage if the only practical recovery is an undocumented manual database edit.

   **Suggested fix:** Specify the re-QA command/API and idempotent state transition for each in-flight phase, prohibit retroactive enrollment of an already-running uncredentialed attempt, and test design/implement/qa deployment cases. Reword “default-off + byte compatible” to exclude this deliberate durable-three-stage fail-closed behavior everywhere it appears, not only in §0.

## Verdict

CHANGES REQUESTED.

Most Round 1 structure is now sound. Approval requires one more design closure around commit B: select a transport that actually authenticates the verdict issuer, define the durable submission-credential transaction/replay contract, and specify the unique run/node lookup used by the ship gate. The founder classification and template/schema items are then bounded follow-up edits within this plan rather than architectural rewrites.
