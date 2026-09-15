# FLY-2563 CommDB ownership audit
Issue: FLY-2563 (https://linear.app/geoforge3d/issue/FLY-2563)
日期: 2026-09-15
基于: plan.md

The 102-site discovery snapshot precedes the voice-factory repair; locations are discovery anchors, not stable current line numbers. The voice raw open was replaced by openVoiceCommDb and its operation-scoped writer. This table separates lexical disposal, transferred ownership, and async lifetimes. A finally block proves release after settlement, not a deadline or production fd acceptance.

## Findings and verification

Fixed and fault-tested: fleet notify/zombie helper; founder reply scoped operations and actual GatePoller cached lease; QuestionAdmission idle per-Lead cache; LeadInboxRuntime partial constructor; MailboxQueue/openCommDbWritable setup failures; voice route factory. Real numeric fd tests require return to baseline without GC, including pending/rejected external callbacks. Default two-project idle <=6P and legacy repeated delivery/shutdown are isolated evidence only.

Retained async owners: GatePoller passes are serialized by polling latch/finally; source projector is single-flight; delivery-contract pages and resident-expiry run within their maintenance ownership. Wake transport/activation and cleanup callers keep their existing lifecycle contracts and finally release; cleanup defaults to a 30-second grace. These are not described as zero-held-fd network scopes. Source-level ownership does not replace the required same-PID 2-hour QA measurement.

## Opening sites

| Discovery site | Owner / disposal classification |
|---|---|
| session-capture.ts:95 captureSession | Local finally/explicit close at 106; async function inspected separately for lease overlap (see retained owners above) |
| proofshot-trigger.ts:355 handleProofShotAutoTrigger | Local finally/explicit close at 361; async function inspected separately for lease overlap (see retained owners above) |
| founder-review-authority.ts:62 evaluateFounderReviewAuthority | Synchronous operation; local release at 78 |
| codex-instruction.ts:146 queueCodexCodeReviewInstructionResult | Synchronous operation; local release at 167 |
| gate-poller.ts:1476 ensureCommDbMigrated | Synchronous operation; local release at 1477 |
| gate-poller.ts:1572 evictTerminalGateQuestion | Synchronous operation; local release at 1576 |
| gate-poller.ts:1635 getPendingQuestions | Synchronous operation; local release at 1646 |
| gate-poller.ts:1751 relayToLead | Local finally/explicit close at 1759; async function inspected separately for lease overlap (see retained owners above) |
| gate-poller.ts:1853 maybeSweepSupersededShipGate | Synchronous operation; local release at 1857,1872 |
| gate-poller.ts:1865 maybeSweepSupersededShipGate | Synchronous operation; local release at 1857,1872 |
| gate-poller.ts:2356 founderReplyDeliverPass | Local finally/explicit close at 2360,2384,2386; async function inspected separately for lease overlap (see retained owners above) |
| gate-poller.ts:2358 founderReplyDeliverPass | Local finally/explicit close at 2360,2384,2386; async function inspected separately for lease overlap (see retained owners above) |
| gate-poller.ts:2873 <callback> | deferred-approval.ts owns writer, closes in finally; GatePoller polling latch |
| gate-poller.ts:2916 <callback> | Local finally/explicit close at 2935; async function inspected separately for lease overlap (see retained owners above) |
| gate-poller.ts:2952 zombieGateHygienePass | Local finally/explicit close at 3003; async function inspected separately for lease overlap (see retained owners above) |
| gate-poller.ts:3046 founderReactionApprovalPass | Local finally/explicit close at 3056,3163; async function inspected separately for lease overlap (see retained owners above) |
| gate-poller.ts:3085 founderReactionApprovalPass | Local finally/explicit close at 3056,3163; async function inspected separately for lease overlap (see retained owners above) |
| gate-poller.ts:3232 <callback> | Local finally/explicit close at 3250; async function inspected separately for lease overlap (see retained owners above) |
| question-admission.ts:54 readQuestionSnapshot | Synchronous operation; local release at 65 |
| founder-reply-deliverer.ts:316 <callback> | Synchronous operation; local release at 317 is returned lease release callback, invoked by per-operation scope |
| event-route.ts:144 isRunnerDeclaredParked | Synchronous operation; local release at 154 |
| event-route.ts:374 handleCodexAutoTrigger | Synchronous operation; local release at 387,441,578 |
| event-route.ts:428 <callback> | Synchronous operation; local release at 441 |
| event-route.ts:563 handleCodexAutoTrigger | Synchronous operation; local release at 387,441,578 |
| event-route.ts:1690 <callback> | Local finally/explicit close at 1775,2812; async function inspected separately for lease overlap (see retained owners above) |
| event-route.ts:2802 <callback> | Synchronous operation; local release at 2812 |
| turn-wake-patrol.ts:44 drainTurnWakeOutbox | Local finally/explicit close at 144; async function inspected separately for lease overlap (see retained owners above) |
| dead-exec-activity.ts:58 defaultCountCommDbMessages | Synchronous operation; local release at 63 |
| founder-consent/gate-response-router.ts:242 <callback> | Local finally/explicit close at 457; async function inspected separately for lease overlap (see retained owners above) |
| actions.ts:274 approveExecution | Local finally/explicit close at 355,511; async function inspected separately for lease overlap (see retained owners above) |
| actions.ts:507 approveExecution | Local finally/explicit close at 355,511; async function inspected separately for lease overlap (see retained owners above) |
| run-dispatcher.ts:997 dispatchInsideBarrier | Local finally/explicit close at 1009; async function inspected separately for lease overlap (see retained owners above) |
| run-dispatcher.ts:1242 preRegisterCommDb | Synchronous operation; local release at 1253 |
| run-dispatcher.ts:1270 cleanupPreRegistration | Synchronous operation; local release at 1274 |
| run-dispatcher.ts:1725 startInsideBarrier | Local finally/explicit close at 1737; async function inspected separately for lease overlap (see retained owners above) |
| commdb-session-prune.ts:92 hasEndedCommDbSession | Synchronous operation; local release at 103 |
| commdb-session-prune.ts:149 finalizeCommDbSession | Synchronous operation; local release at 171 |
| commdb-session-prune.ts:199 finalizeCommDbSessionCommunications | Synchronous operation; local release at 236 |
| commdb-session-prune.ts:258 finalizeCommDbPaneLossResidue | Synchronous operation; local release at 293 |
| commdb-session-prune.ts:544 <callback> | point prune open factory; inspect/finalize caller finally closes both handles |
| commdb-session-prune.ts:627 pruneDeadTerminalCommDbSessions | Local finally/explicit close at 677; async function inspected separately for lease overlap (see retained owners above) |
| post-ship-finalization.ts:592 <callback> | Local finally/explicit close at 596; async function inspected separately for lease overlap (see retained owners above) |
| external-merge-reconcile.ts:252 hasTrustedFounderApproval | Synchronous operation; local release at 272 |
| external-merge-reconcile.ts:380 collectTurnBeltCandidates | Local finally/explicit close at 385; async function inspected separately for lease overlap (see retained owners above) |
| external-merge-reconcile.ts:425 reclaimTurnBelt | Synchronous operation; local release at 432 |
| commdb-fsm-reconcile.ts:182 reconcileCommDbRunningAgainstFsm | Local finally/explicit close at 410; async function inspected separately for lease overlap (see retained owners above) |
| lead-inbox-runtime.ts:255 <callback> | Local finally/explicit close at 256,571; async function inspected separately for lease overlap (see retained owners above) |
| design-review-manifest.ts:229 deliverDesignReviewManifest | Synchronous operation; local release at 250 |
| sessionless-founder-gate-reconciler.ts:130 <callback> | reconciler project finally closes |
| commdb-lead-runtime.ts:48 <callback> | one legacy runtime per Lead; close via LeadInboxRuntime.shutdown; real fd repeated-send test |
| plugin.ts:5468 <callback> | terminal-commdb-sync per-item finally before yield |
| plugin.ts:5472 <callback> | Synchronous operation; local release at 5473 |
| plugin.ts:5522 <callback> | founder-approval-projector per-project finally; projector single-flight; fallback alert await retains one handle |
| plugin.ts:6917 <callback> | Synchronous operation; local release at 6921 |
| plugin.ts:7351 <callback> | Synchronous operation; local release at 7364 |
| plugin.ts:7625 <callback> | Synchronous operation; local release at 7639 |
| plugin.ts:7698 <callback> | Synchronous operation; local release at 7703 |
| plugin.ts:7710 <callback> | Synchronous operation; local release at 7717 |
| plugin.ts:8020 <callback> | Local finally/explicit close at 8029; async function inspected separately for lease overlap (see retained owners above) |
| plugin.ts:8666 <callback> | Synchronous operation; local release at 8674 |
| plugin.ts:8828 <callback> | Local finally/explicit close at 8836,8839; async function inspected separately for lease overlap (see retained owners above) |
| plugin.ts:8849 <callback> | Synchronous operation; local release at 8852 |
| plugin.ts:9192 <callback> | Local finally/explicit close at 9305; async function inspected separately for lease overlap (see retained owners above) |
| plugin.ts:10161 <callback> | Synchronous operation; local release at 10165 |
| plugin.ts:10268 <callback> | FIXED: raw voice factory replaced by openVoiceCommDb; eager validation closes, every method acquires/closes existing writer; real pending post-write fd regression |
| plugin.ts:10345 <callback> | Synchronous operation; local release at 10358 |
| plugin.ts:10366 <callback> | Synchronous operation; local release at 10390 |
| plugin.ts:10852 <callback> | Synchronous operation; local release at 10866 |
| plugin.ts:10967 <callback> | patrol-tick caller finally closes readonly snapshot |
| plugin.ts:11045 <callback> | Synchronous operation; local release at 11051 |
| plugin.ts:11255 <callback> | auto-narrow-gate synchronous finally |
| plugin.ts:11577 <callback> | Synchronous operation; local release at 11581 |
| plugin.ts:12302 <callback> | review-request-coordinator eager inspect/respond finally before post-write marker hook |
| plugin.ts:12440 <callback> | holder-wake-activation finally; handle spans tmux discovery/liveness probe |
| plugin.ts:12477 <callback> | Synchronous operation; local release at 12483 |
| plugin.ts:12491 <callback> | Synchronous operation; local release at 12495 |
| plugin.ts:12501 <callback> | Synchronous operation; local release at 12505 |
| plugin.ts:12555 <callback> | Synchronous operation; local release at 12569 |
| plugin.ts:12589 <callback> | Local finally/explicit close at 12612; async function inspected separately for lease overlap (see retained owners above) |
| plugin.ts:12722 <callback> | Synchronous operation; local release at 12728 |
| plugin.ts:12733 <callback> | Synchronous operation; local release at 12759 |
| plugin.ts:12782 <callback> | Local finally/explicit close at 12821; async function inspected separately for lease overlap (see retained owners above) |
| plugin.ts:12851 <callback> | Synchronous operation; local release at 12898 |
| plugin.ts:12927 <callback> | Local finally/explicit close at 12960; async function inspected separately for lease overlap (see retained owners above) |
| commdb-probes.ts:35 openCommDb | each exported synchronous probe closes returned reader in finally |
| codex-phase-shutdown.ts:195 <callback> | shutdown operation finally closes optional owned handle |
| founder-routing-response-route.ts:185 <callback> | Synchronous operation; local release at 233 |
| account-switch-consumer.ts:141 <callback> | per-project synchronous wake finally closes |
| runner-mailbox-lane.ts:55 <callback> | one adapter per project; adapter close and LeadInboxRuntime partial-constructor cleanup |
| gate-materializer.ts:225 materializeWorkflowGateHolder | Local finally/explicit close at 232; async function inspected separately for lease overlap (see retained owners above) |
| workflow-engine-park-projector.ts:15 <callback> | projector synchronous finally |
| shipped-husk-escalation.ts:208 <callback> | per-item finally |
| terminal-gate-retirement.ts:46 <callback> | retirement per-project finally; guarded snapshot fallback finally |
| tmux-lookup.ts:384 lookupTmuxTarget | Synchronous operation; local release at 401 |
| land-cleanup-opportunity.ts:36 requestLandCleanupOpportunities | Local finally/explicit close at 84; async function inspected separately for lease overlap (see retained owners above) |
| legacy-ack-drain.ts:39 run | Synchronous operation; local release at 76 |
| legacy-ack-drain.ts:119 autoAckFromMachineEvidence | Synchronous operation; local release at 126 |
| bootstrap-generator.ts:229 generateBootstrap | Local finally/explicit close at 326; async function inspected separately for lease overlap (see retained owners above) |
| workflow-turn-ledger-validator.ts:113 reconcileWorkflowTurnLedgers | Synchronous operation; local release at 148 |
| unanswerable-workflow-gate-reconciler.ts:153 <callback> | reconciler finally |
| fleet-comm-operations.ts:11 insertLeadInstruction | Synchronous operation; local release at 20 |
| fleet-comm-operations.ts:32 readZombieCandidates | Synchronous operation; local release at 36 |

## Limits

Production fd.used/fd.limit and 2-hour comm.db/wal/shm count are pending independent authorized QA. Constructor fault regressions do not prove absence of every native-library leak. No global pool, driver change, per-message migration, or approval-state rewrite was introduced.
