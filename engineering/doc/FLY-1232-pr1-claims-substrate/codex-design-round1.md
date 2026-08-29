# Design Review — FLY-1232 plan.md (Round 1)
Date: 2026-07-13
Author: Codex
Status: CHANGES REQUESTED

## Summary

The claims substrate and cherry-pick strategy are feasible, and the default-off optional seam is the right blast-radius control. Segment 2 is not yet safe to implement from this plan: its dispatch-evidence assumptions do not match the current runtime, its event/projection/outbox writes are not specified as atomic, and its attempt/reconcile model does not cover the production wake, respawn, and restart paths.

## What's Good (Keep)

- Keep the Lead-ruled scope exactly as written: A includes segments 1+2, while local claim producers and cross-DB source-event projection remain in B.
- The reference substrate fits the current `StateStore` migration pattern: native `better-sqlite3` behind the existing compatibility surface, constructor-time idempotent DDL, and explicit multi-statement transactions.
- The substrate's core shape is strong: token hashes only, append-only triggers on the three history tables, one-shot capability submission, same-payload replay, fail-closed claim resolution, no fallback to an older attempt, and a separate system-claim allowlist.
- The E6 follow-up is appropriately a caller contract at this layer. Requiring canonical server-derived family values aligned with `adapterTypeToFamily` avoids trusting runner/manifest self-report while leaving production resolution to the later producer wiring.
- Keep the single WRITE-flag composition decision and an optional narrow seam. `undefined` when OFF is a sound byte-compat structure, provided the new normal-launch machinery is also absent when OFF.
- Keep the observation-period failure posture: shadow failures should roll back the shadow transaction, warn loudly with identifiers, and never block the legacy production flow.
- Keep the rule that reconciliation observes evidence and advances shadow state only; it must never spawn, wake, or otherwise drive a production side effect in A.

## Issues & Recommendations

1. **The dispatch evidence model is factually wrong for the fresh production path.**

   `RunDispatcher.start()` generates a fresh execution ID, pre-registers a `:pending` CommDB row, and starts `Blueprint.run()` without calling `LaunchClaimStore.claim()` or setting `launchCommitPath`. Those mechanisms exist only in `RetryDispatcher.dispatch()` when `successorExecutionId` is supplied. `LaunchClaimStore.recordWindow()` has no production caller. In addition, `DirectEventSink.emitStarted()` writes the StateStore `session_started` row before adapter spawn; the existing `started-evidence.ts` explicitly says that row is not started evidence. Finally, `start()` returns immediately after scheduling `Blueprint.run()`, before the adapter has committed or self-registered, so “after `start()` returns” cannot mean `launch_committed`.

   **Suggested fix:** replace research §F.1/F.3 and plan Step 5 with an explicit evidence truth table for fresh start and retry. At minimum: `intent_recorded` is the pre-side-effect StateStore transaction; `launch_committed` requires the adapter's durable commit point (commit marker or a new post-commit callback), not a launch claim; `started` requires a non-pending CommDB self-registration plus tri-state live-window proof, reusing `checkStartedEvidence`. An indeterminate lookup/probe must remain pending, never become `started` or `abandoned`. Define abandonment from positive evidence rather than mere absence, add the missing reason/timestamp columns, and make `started` terminal unless a contrary transition has a precise semantic justification; at most an unstarted/committed-but-not-started effect should become abandoned. Wire the evidence path for normal `RunDispatcher.start()` under the WRITE flag and add crash tests for before commit, after commit/before self-registration, live start, dead window, pending-only row, explicit launch failure, and indeterminate probe. Do not describe LaunchClaimStore window evidence as “existing” unless the implementation first gives `recordWindow()` a real production caller.

2. **The planned thin writer would violate the umbrella's transaction boundary.**

   The cherry-picked primitives separately save `workflow_run`, `workflow_run_node`, and `workflow_run_event`. If `WorkflowShadowWriter` simply calls them in sequence, a crash or injected failure can leave a node projection without its event, an event without the projection update, or a side-effect state without its matching event. That contradicts umbrella §2.4b, which requires sequence allocation, event append, and projection update in one StateStore transaction. B4's “run reconcile twice” test checks deduplication but not torn writes.

   **Suggested fix:** add transaction-level StateStore APIs for lifecycle transitions and side-effect transitions. A lifecycle transaction should atomically get/create the run, dedupe/allocate `event_uid` and per-run `seq`, update the run/node projection, and append the event. A side-effect transaction should atomically advance the state and append its deterministic run event. Same-state replay should be an idempotent no-op; illegal transitions should fail. Add fault injection at every statement boundary and assert total rollback, followed by successful replay. Shadow-call containment then catches only the rolled-back transaction error and logs it without affecting production.

3. **`attempt = 1 + loop round` is insufficient and conflicts with the side-effect uniqueness key.**

   Current production has both keep-alive wakes and fresh respawns. A keep-alive fix round reuses the same implement/QA execution across a new logical attempt, while `reconcileQaLoss()` can spawn a new QA execution after a previously started QA dies without incrementing the belt/fix round. With the proposed unique key `(run_id, node_id, attempt, kind)`, that respawn collides with the already-started dispatch row if attempt is derived only from loop count; rebinding the row's execution ID would erase history. Pre-commit re-drive, post-start replacement, and loop re-entry are three different cases and cannot share one unstated rule.

   **Suggested fix:** define attempt semantics before implementation. State whether a post-start replacement is a new node attempt or whether the side-effect schema needs a separate immutable launch-attempt/ordinal identity. Preserve the same execution ID only for pre-commit replay; never overwrite a committed dispatch row's execution ID. Add acceptance cases for keep-alive wake, legacy close-and-respawn, pre-commit same-ID re-drive, post-start QA replacement, and founder-feedback kickback. Adjust B3 so it proves the kickback-to-attempt mapping without falsely claiming that every attempt number is only the belt round.

4. **The lifecycle hook and reconciliation inventory is not complete enough to guarantee the promised ledger.**

   `handoff()` has distinct wake and spawn branches; keep-alive kickback wakes implement without entering `RunDispatcher`; QA PASS returns from `onQaResult()` after persisting intent; QA FAIL is split across `onQaResult()`, `runFailFlow()`, and `runFailFlowKeepAlive()`. A single dispatcher `onDispatch` hook therefore misses wakes, while placing `loop_iteration` in both verdict and kickback hooks risks duplicates. Existing startup reconciliation also deliberately skips a completed handoff once a downstream phase is alive, so a soft shadow failure after the real handoff can remain missing forever. There is no planned terminal hook to move the shadow run out of `status=active`, so `getOrCreate(project, issue, active)` can reuse an old run indefinitely after ship.

   **Suggested fix:** add a normative transition table covering initial design, handoff spawn, handoff wake, node completion, QA PASS, QA FAIL, founder-feedback kickback, QA respawn, startup replay, and confirmed post-ship finalization. For each row specify the sole owner, durable source identity, event UID formula, node/run projection mutation, attempt rule, and reconcile evidence. Add a dedicated `workflowShadow.reconcileOnStartup()` that backfills missing shadow facts from durable evidence without invoking production actions; do not rely on the orchestrator's existing skip-heavy reconcile paths. Give exactly one hook ownership of `loop_iteration`. Add an optional post-ship terminal seam (or another explicit durable run-boundary design), plus an atomic/unique active-run get-or-create rule, so a later workflow on the same issue cannot attach to a shipped run.

5. **The composition plan and strict file list do not match the codebase.**

   `plugin.ts` does not construct `RunDispatcher`; it calls `setupRunInfrastructure()`, and `run-infra.ts` constructs both `LaunchClaimStore` and `RunDispatcher`. Passing a plugin-created shadow writer into the dispatcher therefore requires at least `RunInfraOptions` and `run-infra.ts` changes. If the chosen evidence design needs an adapter post-commit callback, the Blueprint/adapter context files and their tests also enter scope. The current “any file beyond this list requires Lead approval” rule would force an immediate exception or encourage a worse late-bound setter.

   **Suggested fix:** choose the evidence seam first, then update the file inventory to include every real composition and callback surface. At minimum include `packages/teamlead/src/bridge/run-infra.ts` and its wiring tests. Preserve the existing normal-path sentinel that `launchCommitPath` is undefined when the WRITE flag is OFF. Also state what happens when `startBridge` receives an externally injected `startDispatcher`; either wrap it in the optional observer or explicitly limit/test the production composition path.

6. **The starter substrate needs a small fail-closed hardening step; “cherry-pick unchanged except JSDoc” overstates its acceptance coverage.**

   The reference implementation compares timestamps with `Date.parse()` but does not reject invalid ISO strings. `Date.parse(invalid)` is `NaN`, making the expiry comparison false and potentially treating malformed capability/claim expiry as unexpired. Initial capability issuance also does not enforce `expires_at <= absolute_deadline_at`. A9 promises tests for consumed and revoked renewal, but the starter suite only tests the deadline cap and already-expired renewal. `appendWorkflowSystemClaim()` also accepts a caller-supplied `issueId` instead of deriving it from (or checking it against) the run.

   **Suggested fix:** add an explicit post-cherry-pick substrate-hardening substep and tests: reject malformed/non-finite timestamps; ensure issued and renewed capability expiry cannot exceed the absolute deadline; cover consumed/revoked renewal; and derive the system claim's issue identity from the run or reject mismatches. Keep this within module 1—no producer wiring or scope movement is required.

7. **The commit sequence and companion documents should be made self-consistent.**

   Cherry-picking the sentinel-bearing code before its required filesystem documents creates an intentionally red intermediate commit. The checkout command names a mutable branch even though the plan claims to pin `9ed7ea69e`. The companion research §F.1 also contains the incorrect fresh-launch evidence claim above, and exploration §4 still says the local-claim boundary is “待 Lead 裁定” despite the final ruling recorded in §3.5.

   **Suggested fix:** carry the pinned docs first (`git checkout 9ed7ea69e -- ...`), then cherry-pick the code so each commit is buildable, or combine the two into one buildable commit if repository history policy prefers. Correct the stale companion statements in the same plan revision. Cherry-pick-first remains mechanically low-risk—the file-overlap audit is sound—but the proposed commit order is not bisect-clean.

## Verdict

CHANGES REQUESTED — address items above
