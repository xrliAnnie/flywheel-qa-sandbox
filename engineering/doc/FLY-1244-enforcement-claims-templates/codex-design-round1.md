# Design Review — FLY-1244 plan.md (Round 1)
Date: 2026-07-14
Author: Codex
Status: CHANGES REQUESTED

## Summary

The plan is directionally strong: it targets the right bypass, preserves the legacy single-session path, reuses the FLY-1232 substrate instead of creating a second ledger, puts CommDB source events beside their authoritative writes, and treats template publication/snapshots as immutable data. The cited RED test, `evaluateQaShipGate` branch, capability APIs, direct approval writes, `grantTurn`, and better-sqlite3 transaction support all match the current tree.

However, the implementation is not safe or fully feasible as written. The inherited-fd capability cannot cross the current `tmux new-window` process boundary; the fallback helper has no caller-binding design; the read switch ignores the existing typed enrollment bit and makes the READ flag meaningless; the projector has no destination-side atomic deduplication; and the proposed template write route does not authenticate the founder against the plan's own same-user-runner threat model. There are also missing crash-recovery semantics between a committed claim and the existing QA/phase orchestration. These are design blockers, not implementation details.

## What's Good (Keep)

- Keep the RED test byte-for-byte. It accurately demonstrates the current `qa_required === 0 -> qa_not_required` bypass, and its explicit `env` object is a useful hermeticity constraint.
- Keep the durable three-stage identity check as the rule that stops honoring the old `qa_required=0` exemption. Do not infer cutover from the presence of tables or claims.
- Keep separate WRITE, READ, and FORCE_LEGACY controls, plus a typed per-run enrollment marker. The implementation needs a precise truth table, but these are the right controls.
- Keep the CommDB-source-outbox principle. `insertResponse`/`grantTurn` and their source records must commit together in CommDB, followed by idempotent projection into teamlead.db.
- Keep the flywheel-comm-side read implementation and cross-implementation contract tests. The package dependency direction is real, and a contract suite is necessary if the resolver remains duplicated.
- Keep server-derived subject, issuer family/model, and producer identity. The existing StateStore method accepts these as arguments, so the Bridge boundary must be the place that actually derives them.
- Keep immutable revisions, append-only publications, CAS publication, pinned run snapshots, full revalidation after overrides, and required override reasons.
- Keep QA as an explicit node in all three seed templates and keep review-family validation based on resolved backend/model rather than manifest or runner self-report.
- The OS findings are broadly plausible. On this machine, Node's Unix-socket connection exposed no peer PID, and an isolated tmux check confirmed that `show-environment` did not reveal a `new-window -e` child-only value.

## Issues & Recommendations

1. **[HIGH] The inherited fd cannot reach the current tmux-spawned runner.**

   **Issue:** `TmuxAdapter.execute()` invokes an already-running tmux server through `tmux new-window`; the tmux server, not the Bridge/adapter's tmux client process, forks the pane process. An fd opened by the Bridge or adapter is therefore not inherited by the pane. A local isolated spike reproduced this exact boundary: an fd opened after the tmux server started was unavailable in the new pane. The current `ExecFileFn` also has no custom-stdio surface. Even after solving that first boundary, whether Claude preserves an unknown fd into a later Bash-tool subprocess remains unproved.

   **Why it matters:** The plan's only pre-use secrecy property depends on this fd. If it never reaches `flywheel-comm qa-result`, enrolled QA cannot produce a claim. This is not a fallback-worthy runtime edge case; it invalidates the primary delivery architecture.

   **Suggested fix:** Add a Gate-0 real-machine spike before implementation and choose a mechanism that works with the actual process tree. Viable candidates require a concrete, reviewed design—for example, a native peer-credential broker (`LOCAL_PEERPID`) with process-ancestry/execution binding, or a redesigned direct-child/sidecar launch that can securely hand a capability to a resident per-execution helper. If the helper remains the fallback, specify how it is spawned, how the runner invokes it, how the helper proves the caller belongs to the bound execution, and how it survives/recoveries without putting a secret in env/argv/disk. Update the file list to include the necessary runner/Blueprint/adapter seams; `run-dispatcher.ts` alone cannot implement fd delivery.

2. **[HIGH] The stated same-user threat model omits active control available through the same tmux access.**

   **Issue:** The negative matrix grants runner A enough access to run `tmux show-environment -t B`, but a same-user client connected to that tmux server can also use `send-keys` and `capture-pane`. An isolated check confirmed that a child-only environment value not visible through `show-environment` was trivially exposed by `send-keys` plus `capture-pane`. If B can read a capability fd, an attacker that can drive B's pane can ask B to read/use it. Short TTL and one-time consumption do not prevent that pre-use injection.

   **Why it matters:** The plan currently claims a stronger integrity invariant than the mechanism proves. Passive non-disclosure through snapshots/tmux environment is not equivalent to isolation from a hostile same-user runner.

   **Suggested fix:** Either explicitly narrow the threat model to passive filesystem/env enumeration plus direct Bridge calls (and state that shared-tmux input injection is out of scope), or provide real isolation such as a separate OS principal/appropriately isolated control plane. Extend the negative matrix with `send-keys`/`capture-pane`, an unrelated inherited child attempting to drain the fd, concurrent first-use submissions, arbitrary pre-use Bridge calls, and process restart/replacement. Do not claim the broader same-user invariant until those cases are addressed.

3. **[HIGH] Capability replay and failure-recovery semantics contradict the substrate and cannot be recovered from an opaque marker alone.**

   **Issue:** Section 4.0 says the raw token never leaves Bridge, but the primary design sends that raw token to the runner and back. L1 says a leaked post-consumption copy is rejected, while E3 and `submitWorkflowDecisionClaim()` intentionally return the existing claim for an exact same-payload replay. More importantly, if `qa-result` drains the pipe and the Bridge is unavailable before receiving the request, the token is gone and an opaque request-id marker contains neither a replayable request nor a way to re-authenticate it. Bridge restart after mint also cannot reconstruct plaintext from the stored hash. The equivalent `codex-review-result` full-body marker is not covered at all.

   **Why it matters:** This loses the current fail-close/retry contract precisely in the outage window the marker is meant to cover. It also leaves tests with mutually exclusive expected outcomes.

   **Suggested fix:** Define one explicit submission state machine and vocabulary. Distinguish any bootstrap/helper handle from the StateStore decision-capability token. Preserve the substrate contract that an exact replay is idempotent and state-neutral (or deliberately change the substrate and all E3 assertions); reject only mismatched replay. Specify recovery for crash before delivery, after secret read/before Bridge receipt, after claim commit/before response, and after response loss. A replacement capability for the same attempt may be minted only through the authenticated execution channel and must revoke the orphaned one. Persist only non-secret request data needed for retry, with a server-verifiable reauthorization path. Cover both `qa-result` and `codex-review-result` markers.

4. **[HIGH] The read-switch design ignores `claims_read_enrolled` and gives the READ flag no coherent job.**

   **Issue:** The plan's ship-gate branch selects solely on durable QA identity and immediately reads claims. It never requires `workflow_run.claims_read_enrolled=1` or `FLYWHEEL_WORKFLOW_CLAIMS_READ=1`, despite both being hard requirements. Current `applyWorkflowShadowBatch()` always creates runs with `claims_read_enrolled=0`, and there is no trusted enrollment transition in the plan. Thus a test can become green by failing closed while the production typed-cutover contract remains unimplemented.

   **Why it matters:** This violates the authoritative umbrella spec and makes the default-off claim misleading. It also provides no way for a real current three-stage run to become a claims reader.

   **Suggested fix:** Specify and test a complete truth table: (a) `FLYWHEEL_QA_DONE_GATE=0` keeps its existing independent bypass; (b) FORCE_LEGACY uses the complete legacy QA path; (c) non-three-stage sessions use the legacy path; (d) durable three-stage QA identity with READ=1 **and** a uniquely mapped, explicitly enrolled workflow run resolves claims; (e) durable three-stage QA identity without READ/enrollment fails closed with re-QA recovery and never returns `qa_not_required`. This still makes the unchanged RED test green because it has neither READ nor enrollment. Add a trusted admission-time API that creates/enrolls the run before dispatch (or a separately audited enrollment CAS), and include WRITE=1 + READ=1 + enrollment in rollout option (a), not WRITE alone.

5. **[HIGH] FORCE_LEGACY is not operationally reliable if it is read only from inherited process env.**

   **Issue:** Existing ship eligibility deliberately live-reads `~/.flywheel/.env` because `verify-approval` runs inside long-lived runner descendants. Writing FORCE_LEGACY to `.env` and restarting only the Bridge does not update an already-running runner's inherited environment. The proposed process-env-only check can therefore fail to rescue the exact in-flight sessions the checklist is intended to protect.

   **Why it matters:** The advertised emergency rollback may not work during the deployment incident it is meant to contain.

   **Suggested fix:** Reuse/generalize the current live-`.env` resolver: an explicit `args.env` key wins for hermetic tests, the readable live `.env` is authoritative in production, and inherited process env is fallback only. Resolve FORCE before any claims-table query and add tests for force-on/off across durable QA, enrolled/non-enrolled, missing schema, and long-lived-runner `.env` flips.

6. **[HIGH] The plan does not define an authoritative, crash-safe producer path from dispatch through claim-driven orchestration.**

   **Issue:** Capability minting needs a durable `(run,node,execution,attempt)` before spawn, but the current workflow-shadow seam is best-effort, swallows errors, returns `void`, and may create only an unenrolled shadow run. `submitWorkflowDecisionClaim()` also trusts its caller to supply `subjectDigest`, issuer family/model, producer execution, producer family, and claim expiry. After the claim transaction commits, the plan does not say how QA PASS/FAIL or Codex approval drives the existing coordinator, loop, wakes, and projections without a crash window or double-drive. Routing through the old shared-bearer `/events` path would reintroduce the authority problem.

   **Why it matters:** A valid claim can be committed but never advance/kick back the workflow, or an insecure event can still be the effective authority. A shadow-write failure can launch a runner that can never obtain a valid ticket.

   **Suggested fix:** Introduce a fail-closed admission/mint seam that atomically or deterministically returns the authoritative run/node/attempt identity before adapter launch. At the dedicated submission endpoint, load the capability and derive the issuer session/backend/model, producer execution/backend, current server-owned head, and expiry; a client head may only be compared, never trusted. Make the committed `claim_written` event/outbox the idempotent trigger for coordinator/edge/loop work, with startup replay and exactly-once logical effects. Add crash tests at claim commit -> coordinator, coordinator -> wake/edge, and response loss. Include the actual endpoint mounting/composition files and `codex-review-result.ts` in the plan.

7. **[HIGH] The cross-DB projector is not idempotent at the destination and the approval payload is underspecified.**

   **Issue:** `(project, source_event_id)` is unique only in CommDB. `appendWorkflowSystemClaim()` has no idempotency key/unique authority constraint; it assigns a fresh `server_seq` and event UID each call. A crash after the StateStore claim commit but before projector bookkeeping will append a duplicate founder claim on restart. The plan also appears to call `appendWorkflowSystemClaim` directly from `actions.ts` while separately projecting the CommDB event, creating two potential writers. Finally, generic `insertResponse(parentId,fromAgent,content)` does not know the immutable workflow run, node/attempt, approved head, or trusted approval classification needed by the eventual claim.

   **Why it matters:** The proposed outbox removes one half-write window but introduces duplicate/incorrect claims in the next window. Looking up the head or active run at projection time can bind approval to a newer head or a later run.

   **Suggested fix:** Make the CommDB transaction write a versioned, canonical source payload containing the server-resolved run/issue/question/response/actor/head identity at approval time (and the old/new holder plus resulting epoch for TURN). Use approval-specific and TURN-specific CommDB methods rather than silently adding semantics to every generic response. Make the projector the **only** founder-claim writer. Add a StateStore `applyWorkflowSourceEvent` transaction that inserts a unique destination receipt `(project,source_event_id,payload_digest)` and the claim/run-event together; exact replay returns the prior result and digest mismatch fails closed. Specify startup plus recurring drain, malformed/poison-event handling, and crash tests after source commit, after destination commit/before acknowledgement, and during restart. Add append-only triggers/constraints for both new CommDB history tables.

8. **[HIGH] The founder approval guard is not placed at the actual shared write boundary.**

   **Issue:** The current tree already has `writeGateResponseAndRunPostWrite`, used by text/reaction/voice/deferred paths. The plan instead exports another predicate from `auto-qa-held.ts` and calls it in the two direct sites, without modifying or routing through the shared writer. That closes today's two lines but leaves multiple approval primitives and makes the stated “exactly one shared pre-write boundary” false. It also does not close the check-to-CommDB-write race or explain how `reviewHoldReason` maps to defer versus reject in the shared API.

   **Why it matters:** Future or replay paths can bypass one of the duplicated call-site guards, and mutation tests on comments/callers do not create a structural invariant.

   **Suggested fix:** Create one Bridge-owned `writeFounderApproval`/enhanced shared writer that re-reads session binding/status/head, evaluates `reviewHoldReason`, writes the approval plus source event atomically in CommDB, and returns typed outcomes (`defer`, `reject`, `already_applied`, `written`). Route actions, founder-consent, text, reaction, voice, and deferred replay through it. Retain caller-side checks only as defense in depth. Mutation-test the shared writer and each production routing edge. List `approval-signal/write-gate-response.ts` and its wiring in the file matrix.

9. **[HIGH] Loopback + same-origin + confirmToken is not founder authentication under this plan's threat model.**

   **Issue:** The fleet-console pattern is a CSRF/confirmation pattern, not an identity boundary. The current same-origin helper treats a request with no Origin/Referer as acceptable, and any local process can call stage, receive a confirmToken for its own canonical request, and immediately apply it. The security invariant explicitly gives a sibling runner the ability to connect to Bridge. Such a runner could therefore create/publish/rebind templates through the proposed “founder” endpoints.

   **Why it matters:** Template publication changes future authorization chains and models. Labeling this surface founder-only without authenticating the founder violates the repository's auth-boundary rule and has fleet-wide blast radius.

   **Suggested fix:** Require a genuine founder authorization channel in addition to stage/confirm—for example, a founder-authenticated browser session unavailable to runners, or a server-owned founder challenge confirmed through the existing founder channel. If that cannot be delivered in B, ship StateStore APIs/read-only routes only and defer mutation endpoints to FLY-1038. Add a same-user local process test proving it cannot stage/apply a template mutation.

10. **[HIGH] The canonical seed/review design is inconsistent with the cross-family claim producer.**

   **Issue:** All three proposed seeds use Codex for implementation, while the current `codex_review_result` path stamps `reviewerFamily="codex"`. The existing claim substrate correctly rejects a review where issuer/reviewer family equals the producer family. The manifests do not contain an explicit cross-family code-review node, yet section 4.3 promises to write `codex_approved` claims.

   **Why it matters:** The canonical templates can produce an unsatisfiable `codex_approved` path or silently rely on a hidden review step the admission validator cannot inspect.

   **Suggested fix:** Decide the contract explicitly: represent code review as a manifest node with a non-Codex reviewer for Codex-authored implementation; or state that these templates do not require `codex_approved` and that the producer is connected only for eligible cross-family legacy/enrolled runs. Add positive Claude-author -> Codex-review and negative Codex-author -> Codex-review tests, plus a seed-level test proving every required review predicate has a reachable cross-family issuer.

11. **[MED] The “normative schema/full DDL/exact seeds” section is not yet normative or complete.**

   **Issue:** Node and edge objects are only sketched; edge IDs/from/to/conditions, terminal gate fields, override grammar, `handoff_pointer` shape, and unknown-key boundaries are not fully specified. Light/trivial manifests still contain ellipses and implementation-time model choices. No repo YAML seed paths/import-export artifacts appear in the file list, despite the umbrella contract. The category-binding representation of a project default is ambiguous; using nullable `task_category` with an ordinary unique key would allow multiple defaults in SQLite. Publication CAS, draft creation, stale edit, and seed ownership/content-hash columns are also not given as executable DDL.

   **Why it matters:** Implementers and tests can choose incompatible schemas while all claiming conformance; the loader and later dispatcher will then drift at their shared boundary.

   **Suggested fix:** Include the complete versioned schema and three exact manifests in the plan, with concrete canonical model IDs from FLY-1224 and no ellipses. Define the project-default key/index unambiguously, full table columns/FKs/CHECKs/unique indexes/triggers, exact CAS predicates and 409 mapping, seed ownership/content-hash behavior, and canonical serialization/digest rules. Add the YAML seed/import paths and Bridge startup/route mounting files to the change list.

12. **[MED] `workflow_node_outputs` and materialize-kind are unsafe half-contracts as currently scoped.**

   **Issue:** The existing side-effect table already admits `kind='materialize'`, but every allocation/transition query is hard-coded to `dispatch`, and its `launch_ordinal`, `execution_id`, `launch_committed`, and `started` vocabulary is dispatch-shaped. The plan says “DDL + primitive” without defining materializer identity, transition/evidence mapping, or output authorization. The upstream spec requires outputs keyed and authorized by `(run,node,execution,attempt)`, current-attempt promotion, canonical digest/schema, and content-addressed/crash-safe materialization.

   **Why it matters:** A generic-looking but dispatch-specific primitive will be reused incorrectly later, while an unauthenticated output API recreates the same forgery class the claims work is closing.

   **Suggested fix:** Either deliver the bounded upstream primitive now—attempt-authorized structured output insertion/promotion plus a named materialize intent/commit/done/reconcile API and idempotency key—or remove the public primitive from B and defer it intact. Do not merely parameterize today's dispatch SQL without defining the materialize state/evidence contract and tests.

13. **[MED] The 1204 integration table is still commit-level, not a safe path/hunk absorption matrix.**

   **Issue:** `61593e8a` deletes much of `4975ee0d`; `40405388` touches sixteen production/test files; “整体吸收” does not identify the symbols/hunks to carry onto a substantially newer tree. `78e29299` is test/docs-only, and equivalent parked-sweep guard/throttle implementation and tests already exist in the current worktree. Blind cherry-picks or broad patch application can reintroduce reverted behavior or duplicate current fixes.

   **Why it matters:** This is a high-conflict main-path integration and the plan's matrix does not yet make the intended final tree reviewable.

   **Suggested fix:** Replace each row with destination files/symbols, included hunk purpose, explicit excluded/replaced hunks, and current-tree equivalent commits/tests. Use range-diff/patch-id or manual semantic comparison against the present branch, then run the RED test plus every named parked/retry/worktree/head-ownership suite on the synthesized tree. Treat `0a06fe3e` and already-landed equivalents as semantic references, not cherry-pick candidates.

14. **[MED] One PR removes the review/rollout checkpoints the authoritative sequence was designed to provide.**

   **Issue:** The umbrella §3.2 orders founder/source projection -> claim read cutover -> templates as separate PRs. This plan combines all three plus a new security broker and founder mutation surface while also changing the unconditional ship path.

   **Why it matters:** The blast radius is difficult to review and there is no merge boundary at which source projection and claim production can soak before the ship gate begins depending on them.

   **Suggested fix:** Prefer the upstream three-PR sequence. If the Linear sub-issue must remain one PR, make the three sections independently reviewable commits with explicit internal gates: source/projector and authenticated producer tests first; capability E2E and enrollment second; read-switch last; template storage/routes isolated after enforcement. Production READ must remain off until the fresh-spawn and crash/replay matrices pass, and the unconditional fail-closed branch must have a tested live FORCE rollback.

15. **[LOW] Preserve reproducible, sanitized OS evidence instead of relying on an exact transient-machine assertion.**

   **Issue:** The Node peer-PID and tmux child-env findings were reproducible. Current Codex shell snapshots contain many exported sensitive-key names, but the exact claim that the shared ingest-token name is presently in both Claude and Codex snapshot trees was not reproducible from the current top-level snapshot sets.

   **Why it matters:** The no-env conclusion remains prudent, but an unrepeatable exact claim can distract future reviewers from the load-bearing evidence.

   **Suggested fix:** Check in a sanitized QA script/report that records only booleans/key names (never values) for snapshot persistence, tmux visibility, peer credentials, argv/env exposure, and the selected capability path. Make the E2E fail if the platform/runner version changes and the proof no longer holds.

## Verdict

CHANGES REQUESTED.

Resolve the capability transport first; it determines whether the rest of section 4 is implementable. Then make the READ/enrollment/FORCE truth table explicit, turn CommDB projection into a destination-idempotent transaction, make claim-driven orchestration restart-safe, and replace loopback-only template mutation with genuine founder authorization. After those changes, the remaining schema, materialize, and hunk-matrix issues are bounded and reviewable.
