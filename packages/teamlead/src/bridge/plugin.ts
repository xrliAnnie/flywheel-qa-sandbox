import { execFile } from "node:child_process";
import {
	createHash,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import {
	existsSync as ffExistsSync,
	readFileSync as ffReadFileSync,
	realpathSync as voiceRealpathSync,
} from "node:fs";
import { homedir } from "node:os";
import {
	dirname,
	join,
	isAbsolute as pathIsAbsolute,
	relative as pathRelative,
	resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import express from "express";
import {
	type RunnerTuiWindowLostEvidence,
	sweepStaleSyncOpMarkers,
	syncOpMarkerPath,
} from "flywheel-claude-runner";
import { CommDB } from "flywheel-comm/db";
import {
	defaultGateMarkerDir,
	markGateMarkerAnsweredForExecution,
} from "flywheel-comm/gate-marker";
import {
	ensureLeaseEpisodeMaterialized,
	reconcileLeaseEpisodeQueue,
	recoverLeaseEpisode,
} from "flywheel-comm/lead-lease";
import { deliverDurableTurnWake } from "flywheel-comm/wake";
// FLY-286 PR-2: web-local review route (固化 default-on since FLY-1243).
import {
	createLocalAnalysisStore,
	createLocalFeedbackStore,
} from "flywheel-comm/xiaohongshu-analysis-store";
import { readLocator as readXhsLocator } from "flywheel-comm/xiaohongshu-review-locator";
import {
	defaultStateDir as xhsDefaultStateDir,
	withCollectionLock as xhsWithCollectionLock,
} from "flywheel-comm/xiaohongshu-state";
import {
	type CommBackend,
	FEATURE_FLAGS,
	readEnvFileSource,
	resolveAllFlags,
	resolveCommBackend as resolveCommBackendShared,
	resolveFounderTimezone,
} from "flywheel-config";
import {
	closeRunnerTerminalView,
	WORKFLOW_TRANSITIONS,
	WorkflowFSM,
} from "flywheel-core";
import type { CipherWriter, MemoryService } from "flywheel-edge-worker";
import { WorktreeManager } from "flywheel-edge-worker";
import { recordAuthHealth as ledgerRecordAuthHealth } from "../account-heal/account-ledger.js";
import type { AccountRotationNotice } from "../account-heal/account-rotation-notice.js";
import { accountPoolConfigured } from "../account-heal/account-store.js";
import { makeAccountSwitchRepair } from "../account-heal/account-switch-repair.js";
import {
	claudeProfileBinPath,
	makeClaudeProfileSwitchDeps,
} from "../account-heal/claude-profile-cli.js";
import {
	classifyDetection,
	makeSubscriptionDetectionClassifier,
} from "../account-heal/detection-classifier.js";
import { quarantinePendingSwitches } from "../account-heal/pending-store.js";
import {
	type ApplyTransitionOpts,
	applyTransition,
} from "../applyTransition.js";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
import {
	type HeartbeatNotifier,
	HeartbeatService,
	type ReconnectController,
	RegistryHeartbeatNotifier,
} from "../HeartbeatService.js";
import {
	type AlertPayload,
	type AlertResult,
	FLEET_ALERT_PROJECT,
	findUnreachableAlertLeads,
	LeadAlertNotifier,
} from "../LeadAlertNotifier.js";
import { CodexLeadOutboundHandler } from "../lead-backends/codex/CodexLeadOutboundHandler.js";
import { FileInboundCursorStore } from "../lead-backends/codex/InboundCursorStore.js";
import { buildLeadDiscordSend } from "../lead-backends/codex/leadDiscordSend.js";
import { SqliteOutboundDedupStore } from "../lead-backends/codex/SqliteOutboundDedupStore.js";
import {
	buildAuthorizeLeadChannel,
	buildLeadOutboundExpressHandler,
	buildResolveBotToken,
} from "../lead-backends/codexLeadBridgeWiring.js";
import { effectiveLeadBackend } from "../lead-backends/lead-backend.js";
import { MetaAlertNotifier } from "../MetaAlertNotifier.js";
import {
	type LeadConfig,
	loadProjects,
	type ProjectEntry,
	parseAndValidateProjects,
	resolveLeadForIssue,
} from "../ProjectConfig.js";
import { resolveSelfIdentity } from "../roundtable-allowbots.js";
import {
	type Session,
	StateStore,
	type WorkflowEngineAlertIdentity,
	type WorkflowRunCollectReceiptRow,
} from "../StateStore.js";
import {
	importWorkflowMenuSeeds,
	reconcileMenuCategoryBindings,
} from "../workflow-menu.js";
import { parseWorkflowRunSnapshot } from "../workflow-run-snapshot.js";
import {
	isWorkflowManifestLand,
	retireLegacyWorkflowTemplates,
} from "../workflow-template.js";
import {
	AlertChannelHub,
	correlationKeyFor,
	createDiscordOps,
} from "./AlertChannelHub.js";
import { AutoRepairBot } from "./AutoRepairBot.js";
import { createAccountSwitchRouter } from "./account-switch-route.js";
import { createActionRouter } from "./actions.js";
import { AdmissionCrossingBarrier } from "./admission-crossing-barrier.js";
// FLY-368: unified alert channel + per-error threading + conservative auto-repair.
import {
	buildRepairChain,
	resolveFirstAvailableBotToken,
} from "./alert-bot-chain.js";
import { createAlertDutyRouter, dutyAuth } from "./alert-duty-router.js";
// FLY-927 (T1): unified-channel root-message rate cap.
import {
	createAlertRateLimiter,
	rateLimitPerMinuteFromEnv,
} from "./alert-rate-limiter.js";
import { deriveCanonicalFounderId } from "./approval-signal/canonical-founder-id.js";
import { makeDeferralSupport } from "./approval-signal/deferred-approval.js";
import { reactToFounderMessage } from "./approval-signal/founder-ack.js";
import { makeFounderReactionApprovalCallback } from "./approval-signal/founder-reaction-approval-factory.js";
import { makeFounderShipApprovalCallback } from "./approval-signal/founder-ship-approval-factory.js";
import { makeGateAuthorityView } from "./approval-signal/gate-authority-view.js";
import { readCurrentGateMessageBinding } from "./approval-signal/gate-message-binding-store.js";
import type { GateResponseDb } from "./approval-signal/write-gate-response.js";
import { BridgeEventLoopGuard } from "./BridgeEventLoopGuard.js";
import { runBootShaCheck } from "./boot-sha-check.js";
import { makeShipRemoteBranchCleanup } from "./branch-cleanup.js";
// FLY-927 (W1): D1 responder-based routing — ticket queue vs issue thread.
import {
	abnormalExitTicketEventId,
	bridgeMarkerPath,
	buildAbnormalExitAlertContent,
	findLoopStallForExit,
	latchPreviousMarker,
	loopGuardLogPaths,
	writeCleanMarker,
	writeRunningMarker,
} from "./bridge-exit-marker.js";
import { resolveBridgeBuildIdentity } from "./build-identity.js";
import { ChatThreadCreator } from "./ChatThreadCreator.js";
import { makeCanceledPrDisposal } from "./canceled-pr-close.js";
import { killAllClaudeReviewChildren } from "./claude-review-runner.js";
import { buildCleanupPolicies } from "./cleanup-policy.js";
import {
	CLOSE_ELIGIBLE_STATES,
	closeRunner,
	registerLifecycleCloseGuard,
} from "./close-runner.js";
import { createHostCmuxWatcherPatrol } from "./cmux-watcher-patrol.js";
import { reapCodexDaemonForSession } from "./codex-daemon-teardown.js";
import { reportCodexGlobalHealth } from "./codex-global-health.js";
import { CodexReviewEffects } from "./codex-review-effects.js";
import { CodexReviewHoldCoordinator } from "./codex-review-hold.js";
import { CodexReviewIngest } from "./codex-review-ingest.js";
import { sweepCodexRunnerOrphans } from "./codex-runner-orphan-reaper.js";
import { reconcileCommDbRunningAgainstFsm } from "./commdb-fsm-reconcile.js";
import { commDbPathForProject, commDbRootDir } from "./commdb-path.js";
import {
	hasPendingGateFromCommDb,
	probeDeclaredStateFromCommDb,
} from "./commdb-probes.js";
import {
	finalizeCommDbSession,
	pruneDeadTerminalCommDbSessions,
	resolveCommDbPath,
} from "./commdb-session-prune.js";
import {
	buildLoopbackBaseUrl,
	defaultMarkerDir,
	reconcileCompleteFailedMarkers,
} from "./complete-marker-reconciler.js";
import type { CrashReaperInjectedDeps } from "./crash-reaper.js";
import { buildDashboardPayload } from "./dashboard-data.js";
import { getDashboardHtml } from "./dashboard-html.js";
import { FileDeliverySecretProvider } from "./delivery-secret.js";
import { createDeploymentsRouter } from "./deployments-route.js";
import { reconcileDesignReviewInstructions } from "./design-review-manifest.js";
import { validateDesignReviewProjection } from "./design-review-validation.js";
import { createDigestRouter } from "./digest-route.js";
import { DigestService } from "./digest-service.js";
import { createDispositionReceiptPass } from "./disposition-receipt.js";
import {
	createDoaBackoffAdmission,
	DOA_RELEASE_LEASE_MS,
	drainDoaBackoffAlerts,
	repairDoaBackoffReservations,
} from "./doa-backoff.js";
import {
	hasPendingCompleteMarker,
	parseSweepExcludeEnv,
	reconcileDoneButRunning,
} from "./done-running-reconciler.js";
import { archiveIssueThreadIfNoOtherActive } from "./done-thread-archiver.js";
import {
	reconcileDoneThreads,
	resolveDoneThreadReconcileConfig,
	startDoneThreadReconcileScheduler,
} from "./done-thread-reconcile.js";
import {
	attachDeliveredAlertLifecycles,
	shouldReportDeadLetteredDrain,
} from "./drained-alert-routing.js";
import { EventFilter } from "./EventFilter.js";
import {
	EventLoopAttribution,
	type EventLoopHealthSnapshot,
} from "./event-loop-attribution.js";
import { createEventRouter } from "./event-route.js";
import {
	checkPrMergeViaGh,
	createExternalMergeReconciler,
} from "./external-merge-reconcile.js";
import { ProjectConfigCache } from "./feature-flag-config-source.js";
import { renderFlagReport } from "./feature-flag-report-html.js";
import { buildFlagProvenance } from "./flag-provenance.js";
import {
	createProductionFlagScanEffects,
	deliverFlagScanMailboxAlert,
	reportFlagScanOwnerResolution,
	resolveFlagScanOwnerStatus,
} from "./flag-retirement-production.js";
import {
	createFlagRetirementScanner,
	type FlagRetirementScanner,
	type FlagScanSourceSnapshot,
} from "./flag-retirement-scan.js";
import {
	type AnyFlagCanonical,
	type FlagRouteDeps,
	handleFlagApply,
	handleFlagStage,
} from "./flag-routes.js";
import {
	enrichFlagViewsWithStore,
	type FlagStoreRuntime,
	initializeFlagStore,
	storeAlertSystemEnabled,
	storeFlagRetirementScanEnabled,
	storeLoopProfilerEnabled,
	storeShippedHuskForceEnabled,
	storeSkillFrameworkModeControl,
	storeSummaryAbsorptionCadenceMs,
	storeWorkflowReworkReentryEnabled,
	storeWorkflowTurnDivergenceAlertsEnabled,
	storeXiaohongshuLearningEnabled,
} from "./flag-store-runtime.js";
import { ConfirmTokenStore } from "./fleet-admin.js";
import {
	defaultFleetConsoleOptions,
	FleetConsole,
	onlineFromPresentation,
} from "./fleet-console.js";
import { getFleetConsoleHtml } from "./fleet-console-html.js";
import {
	buildDefaultFleetProbeDeps,
	ConfigSnapshotProvider,
	defaultLegacyBackendOf,
	FleetPoller,
	type FleetSnapshot,
} from "./fleet-data.js";
import { locateConfiguredLeadWindow } from "./fleet-lead-locator.js";
import {
	handleApply,
	handleStage,
	loopbackSelfOrigin,
} from "./fleet-routes.js";
import { FleetSensors } from "./fleet-sensors.js";
import { startWorkflowSourceProjector } from "./founder-approval-projector.js";
import {
	buildFounderConsentWiring,
	buildGateResponsePostWriteHook,
} from "./founder-consent/wiring.js";
import {
	classifyFounderDecisionQuestionResolution,
	recordFounderDecisionAck,
	runFounderDecisionConvergencePass,
} from "./founder-decision-convergence.js";
import { isDiscordSnowflake } from "./founder-notify-utils.js";
import { createFounderRoutingResponseRouter } from "./founder-routing-response-route.js";
import {
	emitFounderThreadNotification,
	emitIssueThreadInfraNotification,
	scanFounderThreadForGateCard,
} from "./founder-thread-notifier.js";
import { materializeWorkflowGateHolder } from "./gate-materializer.js";
import { GatePoller } from "./gate-poller.js";
import { hasHostProcessByExecutionId } from "./generalized-launch-recovery.js";
import {
	activateHolderForWake,
	type HolderWakeCause,
} from "./holder-wake-activation.js";
import { buildSessionKey } from "./hook-payload.js";
import { INFRA_ALERT_OWNER_LEAD_ID } from "./infra-alert-mailbox.js";
import { buildInfraAlertRouting } from "./infra-alert-wiring.js";
import {
	formatRotationDigest,
	infraSenderTokenOr,
	postInfraNotifyDigest,
} from "./infra-notify.js";
import {
	IssueDisplayRefresher,
	type IssueDisplayRefreshHolder,
} from "./issue-display-refresher.js";
import { sweepIssueGatesForProject } from "./issue-gate-supersede.js";
import { validateKindContracts } from "./kind-contract.js";
import { requestLandCleanupOpportunities } from "./land-cleanup-opportunity.js";
import {
	landCloseoutReason,
	landIssueCloseoutResultFromClosureReport,
	renderLandThreadNotification,
} from "./land-closeout-cause.js";
import {
	executeLandOperation,
	GhCliLandMergeDriver,
	landThreadNotificationPreflight,
	resumeHeldLandOperation,
} from "./land-executor.js";
import { GitLandHeadRefreshProver } from "./land-head-refresh-proof.js";
import { arbitrateFreshLinearState } from "./land-linear-arbitration.js";
import {
	buildAgedDeferredLinearDoneAlert,
	sweepDeferredLandLinearDone,
} from "./land-linear-done-sweep.js";
import { resolveLandSourceSession } from "./land-source-session.js";
import { probeLaunchdJobAlive } from "./launchctl.js";
import {
	createClaimsClaimer,
	createClaimsReader,
	defaultLeadPaneCapture,
	resolveAlertDirsFromEnv,
} from "./lead-alert-helpers.js";
import {
	LeadDualActiveMonitor,
	type LeadIdentityFinding,
	type LeadScanTarget,
	LeaseAuditOutbox,
} from "./lead-dual-active-scan.js";
import { LeadEventDeliveryCoordinator } from "./lead-event-delivery.js";
import { createLeadLeaseDiagnosticsRouter } from "./lead-lease-diagnostics.js";
import { createLeadLeaseSelfCheckRouter } from "./lead-lease-self-check.js";
import { runLeadReconcilePass } from "./lead-reconcile-pass.js";
import type { LeadRuntime } from "./lead-runtime.js";
import { matchesLead, parseSessionLabels } from "./lead-scope.js";
import { reconcileLegacyPhaseThreads } from "./legacy-phase-thread-sweep.js";
import { assertIssueNotLifecycleClosed } from "./lifecycle-admission.js";
import {
	closeoutIssue,
	closeoutIssueWithSnapshotGuard,
	createIssueMutex,
	parkIssue,
	unparkIssue,
} from "./lifecycle-closeout.js";
import { isUuidKey, resolveLifecycleRootKey } from "./lifecycle-root-key.js";
import {
	computeIssueSnapshot,
	createLifecycleApplyRouter,
	createLifecycleRouter,
} from "./lifecycle-routes.js";
import { sweepProjectLifecycle } from "./lifecycle-sweep.js";
import { makeLinearDoneFinalizer } from "./linear-issue-finalizer.js";
import {
	listLinearIssueComments,
	lookupLinearIssueByIdentifier,
	queryLinearIssues,
} from "./linear-query.js";
import {
	issueMatchesBinding,
	resolveLinearScope,
	resolveProjectNameParam,
} from "./linear-scope.js";
import {
	buildLivenessManifest,
	inboxLoopStallMs,
	LivenessCheckTracker,
	qaStallInboxLoopLead,
} from "./liveness-manifest.js";
import { isSameOrigin as ffIsSameOrigin } from "./loopback-origin.js";
import { ManagementChangeCoordinator } from "./management-change-coordinator.js";
import {
	createManagementCronProvider,
	scanManagementCrons,
} from "./management-cron-source.js";
import { ManagementCronWriter } from "./management-cron-writer.js";
import { createManagementDagProvider } from "./management-dag-source.js";
import {
	createExistingManagementWriters,
	createManagementCronWriterAdapter,
	createManagementDagWriter,
	createManagementFlagProvider,
	createManagementRunnerProvider,
	managementFlagRevision,
} from "./management-existing-writers.js";
import { ManagementProjectSource } from "./management-project-source.js";
import { ManagementSectionRegistry } from "./management-section-registry.js";
import { createManagementSsotProviders } from "./management-ssot-providers.js";
import { ManagementWriterRegistry } from "./management-writer.js";
import { receiptBackedMaterializedHeadAuthority } from "./materialized-head-authority.js";
import { reapMcpOrphans } from "./mcp-descendant-reaper.js";
import { createMemoryRouter } from "./memory-route.js";
import { createMergedGateGuard } from "./merged-gate-guard.js";
import { sweepOrphanFounderReviewGates } from "./orphan-founder-review-monitor.js";
import { isTransientThrottlePane } from "./pane-blocked-classifier.js";
import { fingerprintOutput } from "./pane-fingerprint.js";
import {
	isAutoMigratableClaudeTmux,
	type PaneLossNotificationClass,
	parsePaneLossGenerationParams,
	reconcilePaneLoss,
} from "./pane-loss-reconcile.js";
import {
	readPipelineEnrollment,
	reconcileDefaultDagCategoryBindings,
} from "./pipeline-config-source.js";
import { postMergeTmuxCleanup } from "./post-merge.js";
import {
	type LifecycleShipInfra,
	makeFinalizeWorkflowPhaseRoles,
	runResumablePostShipFinalization,
} from "./post-ship-finalization.js";
import {
	buildCronModelViews,
	buildProjectRunnerDefaults,
} from "./project-runner-model-source.js";
import { createPublishHtmlRouter } from "./publish-html-route.js";
import { resolveQuotaDaemonBridgeMode } from "./quota-daemon-cutover.js";
import { shouldWakeQuotaDaemon, wakeQuotaDaemon } from "./quota-daemon-wake.js";
import { settleReconnectTitlesAndRefresh } from "./reconnect-title-restore.js";
import { createRepoMutationLock } from "./repo-mutation-lock.js";
import { resolveProjectIssueThread } from "./report-issue-thread-resolver.js";
import {
	DEFAULT_RETENTION_MAX_AGE_MS,
	ReportRegistry,
} from "./report-registry.js";
import { createReportsRouter } from "./reports-route.js";
import { isSafeResumeMenuForEnter } from "./rescue.js";
import { createRescueRouter, type RescueRouteRuntime } from "./rescue-route.js";
import {
	buildRescueRuntime,
	buildRescueSuccessorDispatchFields,
	makeCloseAndDispatchSuccessor,
	makeKickstart,
	makeRunnerRevalidate,
	type RescueRuntime,
} from "./rescue-runtime.js";
import {
	createResidueHarvester,
	type ResidueHarvester,
	residueMaintenanceEveryNTicks,
	runResidueAwareBootSweep,
} from "./residue-harvest.js";
import type { IRetryDispatcher, IStartDispatcher } from "./retry-dispatcher.js";
import { ReviewAuthorizationAlerts } from "./review-authorization-alerts.js";
import {
	createReviewAlertEmitter,
	toReviewFindingRulingSnapshot,
} from "./review-governance-effects.js";
import { founderApprovalHoldGuard, reviewHoldReason } from "./review-hold.js";
import { ReviewRequestCoordinator } from "./review-request-coordinator.js";
import { createReviewRulingHandler } from "./review-ruling-route.js";
import { ReviewThreadEffect } from "./review-thread-effect.js";
import { EXECUTOR_TO_TRANSPORT } from "./role-adapter-resolver.js";
import { makeChannelArchiveDefaultProvider } from "./roundtable/channel-archive-default.js";
import { RoundtableThreadManager } from "./roundtable/RoundtableThreadManager.js";
import { loadRoundtableConfig } from "./roundtable/roundtable-config.js";
import { buildTopicTrigger } from "./roundtable/topic-trigger.js";
import { setupRunInfrastructure } from "./run-infra.js";
import {
	defaultResolveLeadId,
	makeRunnerAuthScan,
} from "./runner-auth-scan.js";
import {
	DEFAULT_RUNNER_QUOTA_SCAN_INTERVAL_MS,
	makeRunnerQuotaScan,
	makeRunnerQuotaScanPass,
} from "./runner-quota-scan.js";
import { attemptRunnerRecoveryNudge } from "./runner-recovery-nudge.js";
import {
	handleRunnerApply,
	handleRunnerStage,
	type RunnerCanonical,
	type RunnerRouteDeps,
} from "./runner-routes.js";
import { createStatusQuery } from "./runner-status.js";
import { reapRunnerMcp } from "./runner-teardown.js";
import { createRunsRouter } from "./runs-route.js";
import { RuntimeRegistry } from "./runtime-registry.js";
import {
	type ServerLossCheckResult,
	ServerLossCoordinator,
} from "./server-loss.js";
import {
	captureSession as defaultCaptureSession,
	defaultGetCommDbPath,
	isCaptureError,
} from "./session-capture.js";
import { createShipApprovalHandler } from "./ship-approval-route.js";
import { ShipRelevantDiffService } from "./ship-relevant-diff.js";
import { forceShippedHusks } from "./shipped-husk-escalation.js";
import {
	alertStaleBlockerToLead,
	createStaleBlockerGuard,
	finalizeStaleBlocker,
	type PrState,
} from "./stale-blocker-guard.js";
import { createStandupRouter } from "./standup-route.js";
import { StandupService } from "./standup-service.js";
import {
	reapStateStoreGhost,
	reconcileStateStoreGhosts,
	type StateStoreGhostDeps,
} from "./statestore-ghost-reconcile.js";
import {
	createLeadDetectionAckRouter,
	createStuckRemanageRouter,
} from "./stuck-remanage-routes.js";
import { createSummaryAbsorptionPass } from "./summary-absorption-rider.js";
import {
	createTerminalCommDbSync,
	type TerminalCommDbSync,
} from "./terminal-commdb-sync.js";
import { TerminalGateRetirement } from "./terminal-gate-retirement.js";
import {
	createTerminalArchiveEnqueueBuffer,
	isRetryableOutcome,
	runTargetedArchiveCheck,
} from "./terminal-thread-archive.js";
import { resolveTerminalViewIdentity } from "./terminal-view-identity.js";
import { scrubManagedTmuxEnvironments } from "./tmux-environment-scrub.js";
import {
	canonicalDefaultTmuxSocketPath,
	createTmuxHoldObservationRouter,
} from "./tmux-hold-route.js";
import {
	captureRunnerScrollback,
	cleanupExactWorkflowTmuxWindow,
	discoverTmuxTargetByExecutionId,
	getTmuxTargetFromCommDb,
	isTmuxWindowAlive,
	killCmuxLinkedSession,
	killTmuxWindow,
	lookupTmuxTarget,
	probeRunnerProcessLiveness,
	probeTmuxServer,
	probeTmuxServerStartTime,
	probeTmuxWindowLiveness,
	sendEnterToWindow,
	sendKeysToWindow,
} from "./tmux-lookup.js";
import { createTmuxRescueClient } from "./tmux-rescue-client.js";
import { type CaptureSessionFn, createQueryRouter } from "./tools.js";
import { createTriageDataRouter } from "./triage-data-route.js";
import { createTriageTemplateRouter } from "./triage-template-route.js";
import {
	TurnBeltReconciler,
	type WorktreeTurnRow,
} from "./turn-belt-reconcile.js";
import { drainTurnWakeOutbox } from "./turn-wake-patrol.js";
import { type BridgeConfig, sqliteDatetime } from "./types.js";
import { createVoiceRouter } from "./voice-routes.js";
import type { WorkflowActorSession } from "./workflow-actor-session.js";
import { createWorkflowCarrierRedriveRouter } from "./workflow-carrier-redrive-routes.js";
import { createWorkflowDecisionRouter } from "./workflow-decision-routes.js";
import { GitWorkflowDocsGit } from "./workflow-docs-git.js";
import { WorkflowDocsMaterializer } from "./workflow-docs-materializer.js";
import { WorkflowEngineDispatcher } from "./workflow-engine-dispatcher.js";
import { projectWorkflowEngineParkOutbox } from "./workflow-engine-park-projector.js";
import {
	voidSupersededWorkflowGateCards,
	watchVoidedWorkflowGateCards,
} from "./workflow-gate-card-lifecycle.js";
import { materializeWorkflowGateWithFailLoud } from "./workflow-gate-materialization-alert.js";
import { createWorkflowMenuRouter } from "./workflow-menu-routes.js";
import {
	GitWorkflowResumeCheckpointStore,
	reconcileWorkflowResumeCheckpoint,
} from "./workflow-resume-checkpoint.js";
import { runWorkflowResumeShadowTick } from "./workflow-resume-shadow.js";
import {
	grantWorkflowReworkTurn,
	WorkflowReworkCoordinator,
} from "./workflow-rework-coordinator.js";
import {
	collectWorkflowRunReceipt,
	reconcileWorkflowRunCollections,
} from "./workflow-run-collector.js";
import {
	grantWorkflowShipCarrierTurn,
	WorkflowShipCarrierDeliveryHandler,
} from "./workflow-ship-carrier-coordinator.js";
import {
	createWorkflowShipReadyArm,
	enrichPrHeadViaGh,
} from "./workflow-ship-ready-arm.js";
import { createWorkflowTemplateRouter } from "./workflow-template-routes.js";
import { reconcileWorkflowTurnLedgers } from "./workflow-turn-ledger-validator.js";
import { assertWorkflowWorktreeReady } from "./workflow-worktree-readiness.js";
import {
	createWorkKindCutoverRouter,
	type Fly1436ActivationEvidence,
	readFly1436ActivationEvidence,
} from "./workkind-cutover.js";
import {
	makeBridgeWorktreeCleanup,
	worktreeAutocleanEnabled,
} from "./worktree-cleanup.js";
import {
	createInMemoryTokenStore,
	handleGetReview,
	handlePostAction,
	type XhsReviewDeps,
} from "./xhs-review-routes.js";
import { scanZombies } from "./zombie-scan.js";

/**
 * FLY-142 PR 1.4: Backend selection — `mailbox` (default) or `commdb` (rollback).
 *
 * - `mailbox`: vendor-neutral MailboxLeadRuntime (writes to claude-code mailbox,
 *   read by stock useInboxPoller). Bypasses the buggy `inbox-check.sh` filter
 *   that drops `type='response'` (FLY-142 wake bug).
 * - `commdb`: legacy CommDBLeadRuntime (writes to CommDB instructions, read by
 *   the buggy hook). Preserved for rollback only — not recommended for prod.
 *
 * Hard-gate path (commdb-lead-runtime "instruction" channel for gate questions
 * and approve_to_ship responses) stays on CommDB regardless of this env per
 * plan §B-2 Codex r3 critical #1; Batch 2 PR 2.1 will swap it for
 * StructuredInboxRouter once await-mcp ships.
 */
// FLY-168: `resolveCommBackend` moved to `flywheel-config` so non-teamlead
// packages (flywheel-comm, claude-runner) share ONE parser. Re-exported here
// (with the legacy `CommBackend` type alias) so existing importers of
// `./plugin.js` — run-dispatcher.ts, run-infra.ts — keep working unchanged.
export type { CommBackend };
export const resolveCommBackend = resolveCommBackendShared;

export function resolveWorkflowRunAlertIdentity(input: {
	store: Pick<
		StateStore,
		"getWorkflowRun" | "getSessionByIssue" | "getSessionLabels"
	>;
	projects: ProjectEntry[];
	defaultLeadAgentId: string;
	projectName: string;
	issueId: string;
	runId: string;
	log?: (message: string) => void;
}): WorkflowEngineAlertIdentity {
	const project = input.projects.find(
		(candidate) => candidate.projectName === input.projectName,
	);
	const configuredLead = (leadId: string | null | undefined): boolean =>
		!!leadId &&
		leadId !== "unassigned" &&
		!!project?.leads.some((lead) => lead.agentId === leadId);
	const run = input.store.getWorkflowRun(input.runId);
	if (
		run?.project_name === input.projectName &&
		run.issue_id === input.issueId &&
		configuredLead(run.selected_by)
	) {
		return {
			leadId: run.selected_by!,
			projectName: input.projectName,
			leadResolution: "resolved",
		};
	}

	const session = input.store.getSessionByIssue(input.issueId);
	if (session?.project_name === input.projectName) {
		try {
			const labels = input.store.getSessionLabels(session.execution_id);
			const resolution = resolveLeadForIssue(
				input.projects,
				input.projectName,
				labels,
			);
			if (resolution.matchMethod === "label") {
				return {
					leadId: resolution.lead.agentId,
					projectName: input.projectName,
					leadResolution: "resolved",
				};
			}
		} catch {
			// Fall through to the explicit, loud fallback below.
		}
	}

	(input.log ?? console.warn)(
		`workflow engine alert routing fell back for ${input.runId}/${input.issueId}: no configured run owner or session-label owner`,
	);
	return {
		leadId: input.defaultLeadAgentId,
		projectName: input.projectName,
		leadResolution: "fallback",
	};
}

/**
 * FLY-182: resolve the per-write mailbox timeout from
 * `FLYWHEEL_MAILBOX_WRITE_TIMEOUT_MS`. Returns `undefined` (→ MailboxLeadRuntime
 * default of 3000ms) when unset, empty, or not a positive integer.
 */
export function resolveMailboxWriteTimeoutMs(): number | undefined {
	const raw = process.env.FLYWHEEL_MAILBOX_WRITE_TIMEOUT_MS;
	if (raw === undefined || raw.trim().length === 0) return undefined;
	const n = Number(raw);
	if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return undefined;
	return n;
}

/**
 * FLY-1254: optional liveness bound for one active Claude review subprocess.
 * Invalid values warn and leave the runner's 30-minute default in control.
 * The upper bound is Node's signed 32-bit timer range; larger values collapse
 * to an effectively immediate timeout.
 */
export function parseReviewerTimeoutMs(
	raw: string | undefined,
): number | undefined {
	if (raw === undefined || raw.trim().length === 0) return undefined;
	const value = Number(raw);
	if (
		!Number.isFinite(value) ||
		!Number.isSafeInteger(value) ||
		value < 60_000 ||
		value > 2_147_483_647
	) {
		console.warn(
			`[review-coordinator] invalid FLYWHEEL_CLAUDE_REVIEW_TIMEOUT_MS=${JSON.stringify(raw)}; using the 30-minute default`,
		);
		return undefined;
	}
	return value;
}

const execFileP = promisify(execFile);

/**
 * FLY-742: stale-blocker TTL. Only a parked blocker idle past this reaches the
 * `gh` PR-state check. `FLYWHEEL_CRON_STALE_TTL_MIN` (positive int minutes),
 * default 120.
 */
export function resolveCronStaleTtlMs(): number {
	const raw = Number.parseInt(
		process.env.FLYWHEEL_CRON_STALE_TTL_MIN ?? "",
		10,
	);
	const minutes = Number.isFinite(raw) && raw > 0 ? raw : 120;
	return minutes * 60_000;
}

/**
 * FLY-742: authoritative PR-state check for the auto-finalize gate. Runs
 * `gh pr view` in the project's git checkout (auto-detects the repo from the
 * remote). Bounded (10s); any error/timeout/no-repo → `unknown` (fail-safe:
 * the caller then alerts instead of auto-finalizing — never auto-clears a
 * session without proof the PR is done).
 */
export async function checkPrStateViaGh(
	projectRoot: string,
	prNumber: number,
): Promise<PrState> {
	// Codex code review R1 #1: self-contained defensive guard — a NaN / 0 /
	// negative / non-integer PR number can never trigger a meaningless `gh` call.
	if (!Number.isInteger(prNumber) || prNumber <= 0) return "unknown";
	try {
		const { stdout } = await execFileP(
			"gh",
			["pr", "view", String(prNumber), "--json", "state,mergedAt"],
			{ cwd: projectRoot, timeout: 10_000 },
		);
		const parsed = JSON.parse(stdout) as {
			state?: string;
			mergedAt?: string | null;
		};
		if (parsed.mergedAt || parsed.state === "MERGED") return "merged";
		if (parsed.state === "CLOSED") return "closed";
		if (parsed.state === "OPEN") return "open";
		return "unknown";
	} catch {
		return "unknown";
	}
}

/**
 * FLY-47 → FLY-142 PR 1.4: per-Lead runtime factory. Selects MailboxLeadRuntime
 * (default, fixes wake bug) or CommDBLeadRuntime (rollback) based on
 * FLYWHEEL_COMM_BACKEND env var. Throws on transport readiness failure.
 */
export async function createLeadRuntime(
	lead: LeadConfig,
	_config: BridgeConfig,
	projectName?: string,
): Promise<LeadRuntime> {
	const { join } = await import("node:path");
	const { homedir } = await import("node:os");
	const { existsSync, readFileSync } = await import("node:fs");

	// Use the source binding inside this module. Importing the full Bridge under
	// a transport mock can expose the legacy plugin <-> run-dispatcher cycle;
	// the re-exported const is then still in its TDZ even though the shared
	// config binding is already initialized.
	const backend = resolveCommBackendShared();

	if (backend === "mailbox") {
		// Mailbox path — no CommDB / inbox-mcp lease check needed. Lead's
		// stock useInboxPoller reads from <CLAUDE_CONFIG_DIR>/teams/<lead>/inboxes/
		// and injects directly into the conversation, bypassing the buggy hook.
		const { AgentTeamTransportFactory } = await import(
			"flywheel-agent-team-transport"
		);
		const { MailboxLeadRuntime } = await import("./mailbox-lead-runtime.js");
		const transport = AgentTeamTransportFactory.fromEnv();
		// Fail fast if transport itself isn't healthy — Lead can't deliver
		// anything if CLAUDE_CONFIG_DIR isn't writable / claude-code isn't
		// installed. Surfaces same bar as CommDB lease-check before.
		//
		// FLY-142 verify (2026-05-12, QA-found Bug #2): pass a real logger so
		// adapter diagnostic logs land in the Bridge console — useful when
		// preflight fails on a fresh machine. Adapter still tolerates an
		// omitted logger per `ITransportPreflight` contract (PR 1.1 fix), so
		// this is defense in depth, not a hard requirement.
		const preflight = await transport.preflight({
			logger: {
				debug: (msg, meta) =>
					console.debug(`[Bridge.preflight] ${msg}`, meta ?? ""),
				info: (msg, meta) =>
					console.log(`[Bridge.preflight] ${msg}`, meta ?? ""),
				warn: (msg, meta) =>
					console.warn(`[Bridge.preflight] ${msg}`, meta ?? ""),
				error: (msg, meta) =>
					console.error(`[Bridge.preflight] ${msg}`, meta ?? ""),
			},
		});
		if (!preflight.ok) {
			// FLY-142 verify (2026-05-12, QA-found Bug #3): old code read
			// `preflight.failures` which doesn't exist on `PreflightResult`
			// (the schema has `availabilitySignals` + `message`). So every
			// preflight failure surfaced as "unknown" instead of the real
			// signal, masking Bug #2 root cause. Read the right fields.
			const errorSignals = preflight.availabilitySignals
				.filter((s) => s.kind === "error")
				.map((s) => `${s.name}${s.detail ? `: ${s.detail}` : ""}`);
			const detail =
				preflight.message ??
				(errorSignals.length > 0 ? errorSignals.join("; ") : "unknown");
			throw new Error(
				`Lead "${lead.agentId}": mailbox transport preflight failed — ${detail}`,
			);
		}
		console.log(
			`[Bridge] Lead "${lead.agentId}" using mailbox runtime (FLY-142 PR 1.4 default)`,
		);
		// FLY-182: allow tuning the per-write timeout via env. Default stays
		// 3000ms (MailboxLeadRuntime default) for byte-compat. With prune
		// keeping inbox files small this is rarely the bottleneck, but the knob
		// gives an escape hatch under heavy concurrency.
		return new MailboxLeadRuntime({
			leadId: lead.agentId,
			transport,
			writeTimeoutMs: resolveMailboxWriteTimeoutMs(),
		});
	}

	// Rollback path — CommDB runtime. Requires inbox-mcp PID lease alive.
	if (!projectName) {
		throw new Error(
			`Lead "${lead.agentId}": projectName is required for CommDB runtime`,
		);
	}

	const commDbPath = join(
		homedir(),
		".flywheel",
		"comm",
		projectName,
		"comm.db",
	);
	const leasePath = join(
		homedir(),
		".flywheel",
		"comm",
		projectName,
		`.inbox-ready-${lead.agentId}`,
	);

	if (
		!existsSync(commDbPath) ||
		!isLeaseAlive(leasePath, existsSync, readFileSync)
	) {
		throw new Error(
			`Lead "${lead.agentId}": inbox-mcp not ready (DB: ${existsSync(commDbPath)}, lease alive: false at ${leasePath})`,
		);
	}

	const { CommDBLeadRuntime } = await import("./commdb-lead-runtime.js");
	return new CommDBLeadRuntime(commDbPath, lead.agentId);
}

/**
 * Check if inbox-mcp PID lease file is alive.
 * Lease contains { pid, startedAt }. Process must still be running.
 */
function isLeaseAlive(
	leasePath: string,
	existsFn: (p: string) => boolean,
	readFn: (p: string, enc: BufferEncoding) => string,
): boolean {
	if (!existsFn(leasePath)) return false;
	try {
		const lease = JSON.parse(readFn(leasePath, "utf-8"));
		if (typeof lease.pid !== "number" || lease.pid <= 0) return false;
		process.kill(lease.pid, 0); // signal 0 = existence check
		return true;
	} catch {
		return false;
	}
}

function safeCompare(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * FLY-1018 M4: the scoped gemini-agent token's reachable set — server-side
 * enforcement of the client-side whitelist (method + exact path). Everything
 * else answers 403 for the scoped token; the master token is unaffected.
 * The reserved /api/actions/* surface is OUTSIDE this set by construction.
 */
const GEMINI_SCOPED_REACHABLE: Array<{ method: string; pattern: RegExp }> = [
	{ method: "POST", pattern: /^\/api\/linear\/create-issue$/ },
	{ method: "POST", pattern: /^\/api\/runs\/start$/ },
	{ method: "GET", pattern: /^\/api\/sessions\/[^/]+\/status$/ },
	{ method: "POST", pattern: /^\/api\/memory\/search$/ },
	{ method: "POST", pattern: /^\/api\/memory\/add$/ },
	{ method: "POST", pattern: /^\/api\/ship-approval-request$/ },
];

export function isGeminiScopedReachable(
	method: string,
	fullPath: string,
): boolean {
	return GEMINI_SCOPED_REACHABLE.some(
		(r) => r.method === method && r.pattern.test(fullPath),
	);
}

/**
 * Bearer auth. Master token → full access (unchanged behavior). FLY-1018
 * M4: when a scoped token is configured (second arg — only /api mounts
 * pass it; the ingest mount does not), a Bearer of the scoped value
 * reaches ONLY the gemini-agent tool routes; anything else is 403 with a
 * Bridge log line (path + time, never the token). No token configured =
 * middleware no-ops (pre-existing posture, byte-compatible).
 */
export function tokenAuthMiddleware(
	token?: string,
	geminiScopedToken?: string,
): express.RequestHandler {
	return (req, res, next) => {
		if (!token) return next();
		const header = req.headers.authorization ?? "";
		if (safeCompare(header, `Bearer ${token}`)) {
			next();
			return;
		}
		if (
			geminiScopedToken &&
			safeCompare(header, `Bearer ${geminiScopedToken}`)
		) {
			// req.path is mount-relative under app.use("/api/...", ...) —
			// baseUrl + path is the full request path in both mount styles.
			const fullPath = `${req.baseUrl ?? ""}${req.path}`;
			if (isGeminiScopedReachable(req.method, fullPath)) {
				next();
				return;
			}
			console.error(
				`[scoped-token] 403 ${req.method} ${fullPath} at ${new Date().toISOString()} (gemini-agent scoped token outside its reachable set)`,
			);
			res.status(403).json({ error: "forbidden for scoped token" });
			return;
		}
		res.status(401).json({ error: "unauthorized" });
	};
}

export type ReportCredentialTier = "master" | "ingest";

/** FLY-1715: report auth owns route-specific master/ingest reachability. */
export function reportsAuthMiddleware(
	masterToken?: string,
	ingestToken?: string,
): express.RequestHandler {
	return (req, res, next) => {
		if (!masterToken) {
			res.status(503).json({
				error: "reports API requires TEAMLEAD_API_TOKEN",
			});
			return;
		}
		const header = req.headers.authorization ?? "";
		if (safeCompare(header, `Bearer ${masterToken}`)) {
			res.locals.reportCredentialTier = "master" satisfies ReportCredentialTier;
			next();
			return;
		}
		if (ingestToken && safeCompare(header, `Bearer ${ingestToken}`)) {
			if (req.method === "POST" && req.path === "/publish") {
				res.locals.reportCredentialTier =
					"ingest" satisfies ReportCredentialTier;
				next();
				return;
			}
			res.status(403).json({ error: "forbidden for ingest token" });
			return;
		}
		res.status(401).json({ error: "unauthorized" });
	};
}

/** FLY-1715: auth for non-authoritative latency hints only. */
export function masterOrIngestAuthMiddleware(
	masterToken?: string,
	ingestToken?: string,
): express.RequestHandler {
	return (req, res, next) => {
		// Preserve the Bridge's pre-existing tokenless posture. Production
		// preflight requires both credentials, but loadConfig keeps tokenless
		// startup legal for local tests and disabled sensitive surfaces.
		if (!masterToken) return next();
		const header = req.headers.authorization ?? "";
		if (
			safeCompare(header, `Bearer ${masterToken}`) ||
			(ingestToken && safeCompare(header, `Bearer ${ingestToken}`))
		) {
			next();
			return;
		}
		res.status(401).json({ error: "unauthorized" });
	};
}

/**
 * The broad /api guard delegates the two runner-tier surfaces to their exact
 * mount-level guards. No other /api path bypasses master/scoped auth.
 */
export function apiAuthWithRunnerTierDelegation(
	masterToken?: string,
	geminiScopedToken?: string,
): express.RequestHandler {
	const defaultAuth = tokenAuthMiddleware(masterToken, geminiScopedToken);
	return (req, res, next) => {
		if (
			req.path === "/lead-inbox/nudge" ||
			req.path === "/reports" ||
			req.path.startsWith("/reports/")
		) {
			next();
			return;
		}
		defaultAuth(req, res, next);
	};
}

export class SseBroadcaster {
	private clients = new Set<express.Response>();
	private poller: ReturnType<typeof setInterval> | null = null;
	private heartbeat: ReturnType<typeof setInterval> | null = null;

	constructor(
		private store: StateStore,
		private stuckThresholdMinutes: number,
		/**
		 * FLY-247: returns the latest fleet snapshot, or undefined when the
		 * default-off gate is closed (no lead configures fleet fields) — in
		 * which case the payload is byte-identical to pre-FLY-247.
		 */
		private fleetSupplier?: () => FleetSnapshot | undefined,
	) {}

	addClient(res: express.Response): void {
		try {
			const payload = buildDashboardPayload(
				this.store,
				this.stuckThresholdMinutes,
				this.fleetSupplier?.(),
			);
			res.write(`event: state\ndata: ${JSON.stringify(payload)}\n\n`);
		} catch (err) {
			console.error(
				"[SseBroadcaster] Failed to send initial state:",
				(err as Error).message,
			);
		}

		this.clients.add(res);
		if (this.clients.size === 1) this.startPolling();
	}

	removeClient(res: express.Response): void {
		this.clients.delete(res);
		if (this.clients.size === 0) this.stopPolling();
	}

	destroy(): void {
		this.stopPolling();
		for (const client of this.clients) {
			try {
				client.write(": server shutting down\n\n");
				client.end();
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (
					code !== "ERR_STREAM_WRITE_AFTER_END" &&
					code !== "ERR_STREAM_DESTROYED"
				) {
					console.warn(
						"[SseBroadcaster] Unexpected error during destroy:",
						(err as Error).message,
					);
				}
			}
		}
		this.clients.clear();
	}

	get clientCount(): number {
		return this.clients.size;
	}

	get isPolling(): boolean {
		return this.poller !== null;
	}

	private broadcastToClients(data: string): void {
		const dead: express.Response[] = [];
		for (const client of this.clients) {
			try {
				client.write(data);
			} catch {
				dead.push(client);
			}
		}
		for (const d of dead) this.clients.delete(d);
	}

	private startPolling(): void {
		this.poller = setInterval(() => {
			try {
				const payload = buildDashboardPayload(
					this.store,
					this.stuckThresholdMinutes,
					this.fleetSupplier?.(),
				);
				const message = `event: state\ndata: ${JSON.stringify(payload)}\n\n`;
				this.broadcastToClients(message);
			} catch (err) {
				console.error(
					"[SseBroadcaster] Failed to build/broadcast payload:",
					(err as Error).message,
				);
			}
		}, 2000);
		this.heartbeat = setInterval(() => {
			this.broadcastToClients(": heartbeat\n\n");
		}, 30000);
	}

	private stopPolling(): void {
		if (this.poller) {
			clearInterval(this.poller);
			this.poller = null;
		}
		if (this.heartbeat) {
			clearInterval(this.heartbeat);
			this.heartbeat = null;
		}
	}
}

/** GEO-294 + FLY-91 Round 3: Options object for new Bridge dependencies. */
export interface BridgeAppOptions {
	/** FLY-1995: additive health summary plus master-only profiler diagnostics. */
	eventLoopAttribution?: {
		healthSnapshot(): EventLoopHealthSnapshot;
		snapshot(): unknown;
	};
	vercelToken?: string;
	/** FLY-1778: boot-snapshotted authority for managed call-time readers. */
	flagStore?: FlagStoreRuntime;
	/** FLY-2100: hot projects.json roster used to authorize scoped flag writes. */
	flagProjectNames?: () => readonly string[];
	/** FLY-2103: hot project root lookup for doc_flow write invariants. */
	flagProjectConfigPath?: (projectName: string) => string | undefined;
	/**
	 * FLY-2104: late-bound weekly-scan runtime. The route mounts before the
	 * catch-all in createBridgeApp; startBridge fills this after scanner wiring.
	 */
	flagScanRoute?: {
		current?: Pick<FlagRetirementScanner, "runNow" | "dryRun">;
	};
	/** FLY-1436: isolated confirm tokens for the founder-gated binding cutover. */
	workKindCutoverTokens?: ConfirmTokenStore;
	/** FLY-1436: injectable deployment evidence reader for route-level tests. */
	workKindCutoverEvidence?: () => Fly1436ActivationEvidence;
	/** FLY-1185: ship-entry lifecycle bundle built in startBridge. */
	lifecycleInfra?: LifecycleShipInfra;
	/** FLY-1185 §2.11: the shared per-repo mutation lock (startBridge-owned). */
	withRepoLock?: <T>(mainRepoPath: string, fn: () => Promise<T>) => Promise<T>;
	/** FLY-1307 PR-7.5: receipt-backed authority for output-backed review/ship heads. */
	materializedHeadAuthority?: import("./materialized-head-authority.js").MaterializedHeadAuthority;
	/** FLY-1185 §2.12: park/unpark + approved-manifest apply routers. */
	lifecycleRoutes?: {
		parkRouter: import("express").Router;
		applyRouter: import("express").Router;
	};
	/** FLY-91 Round 3: Bridge-level shared ChatThreadCreator instance. */
	chatThreadCreator?: ChatThreadCreator;
	/**
	 * FLY-1282 Part C: targeted terminal-archive enqueue for the /events
	 * completion sites. Production always wires it in startBridge.
	 */
	terminalArchiveEnqueue?: (issueId: string) => void;
	/** FLY-1066: shared boot/maintenance/targeted residue single-flight. */
	residueHarvester?: ResidueHarvester;
	/** FLY-1066: shared non-blocking failed/blocked CommDB sync queue. */
	terminalCommDbSync?: Pick<TerminalCommDbSync, "enqueue">;
	/** FLY-91 Round 3: Global Discord bot token for thread creation fallback. */
	globalBotToken?: string;
	/**
	 * FLY-623 (Codex R2 MED-5): late-bound holder connecting the event router +
	 * idle accounting to the live HeartbeatService reconnecting set. Both are wired
	 * inside createBridgeApp (pre-listen) but HeartbeatService is constructed
	 * post-listen in startBridge — so they read this holder at call time. `current`
	 * stays null on the kill-switch / standalone path (no reconnecting suppression
	 * or clear), which is byte-compatible with pre-FLY-623 behavior.
	 */
	reconnectHolder?: { current: ReconnectController | null };
	codexReviewHold?: { current: CodexReviewHoldCoordinator | undefined };
	codexReviewIngest?: { current: CodexReviewIngest | undefined };
	reviewAuthorizationAlerts?: {
		current: ReviewAuthorizationAlerts | undefined;
	};
	/**
	 * FLY-1188 §7.1: late-bound holder for the codex-author review-request
	 * coordinator. The /review-requests route mounts inside createBridgeApp
	 * (pre-listen); the coordinator is built post-listen in startBridge. Absent
	 * / `.current` undefined ⇒ the route answers 503 (fail-close — a runner's
	 * request-review CLI retries and, on exhaustion, exits non-zero).
	 */
	reviewCoordinator?: { current: ReviewRequestCoordinator | undefined };
	turnBeltReconciler?: { current: TurnBeltReconciler | undefined };
	/**
	 * FLY-516: late-bound shutdown flag. The /health route mounts inside
	 * createBridgeApp (pre-listen) but close() lives in startBridge — so /health
	 * reads this holder at request time and close() flips it at teardown start.
	 * Absent (standalone createBridgeApp / tests) ⇒ /health reports
	 * shuttingDown:false (byte-compat).
	 */
	shutdownStateHolder?: { shuttingDown: boolean };
	/** FLY-1393: late-bound minimum-set liveness manifest. */
	livenessHealthProvider?: { current?: () => unknown };
	/**
	 * FLY-247 inc2a: the Fleet console (founder-admin surface). When present,
	 * `GET /` renders the console and the `/api/fleet/*` routes are mounted
	 * (loopback + same-origin + confirmToken; NO Bearer). Absent → byte-compat
	 * (old dashboard, no fleet routes).
	 */
	fleetConsole?: FleetConsole;
	/**
	 * FLY-696 M1/④: late-bound Alerts-post callback for `account_rotation` events.
	 * The /events router mounts inside createBridgeApp, but the unified-channel
	 * DiscordOps is built later in startBridge — so the router reads this holder at
	 * request time and startBridge sets `.current` once the channel + DiscordOps
	 * exist. Absent / `.current` undefined ⇒ the event is acknowledged but not
	 * posted (byte-compat: no unified channel = no self-heal Alerts surface).
	 */
	accountRotationPost?: {
		current?: (
			detail: string,
			rotation?: AccountRotationNotice,
		) => Promise<void>;
	};
	/**
	 * FLY-907: late-bound holder for the unified issue-display refresher. The
	 * /events router, the actions router, the stale-blocker guard, and the
	 * founder-consent gate-response hook all mount inside createBridgeApp
	 * (pre-listen), but the refresher is built post-listen in startBridge — so
	 * every surface reads `.current` at fire time.
	 * Absent / `.current` undefined ⇒ triggers dormant and the stage_changed
	 * path falls back to legacy stamp+pin when the refresher is unavailable.
	 */
	issueDisplayRefresh?: IssueDisplayRefreshHolder;
	/**
	 * FLY-871 R3/C9: the /api/rescue route (mounted in createBridgeApp) reads this
	 * holder at request time; startBridge sets `.current` only when the rescue
	 * runtime is built (account pool provisioned + unified Alerts channel; FLY-1243).
	 * Undefined ⇒ the route returns 409 needs_human (self-heal off = byte-compat).
	 */
	rescueRoute?: { current?: RescueRouteRuntime };
	/** FLY-1944: synchronous pre-claim dispatch visibility for host quiescence. */
	admissionCrossingBarrier?: AdmissionCrossingBarrier;
	/** FLY-2076: late-bound duty-seat identities owned by startBridge. */
	alertDuty?: {
		dispatcherBotUserId: { current: string | null };
		alertHub: { current?: AlertChannelHub };
	};
}

/** FLY-579: tolerant parse of a JSON-encoded string[] (session.issue_labels). */
function parseJsonStringArray(raw: string | undefined): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((x): x is string => typeof x === "string")
			: [];
	} catch {
		return [];
	}
}

function createWorkflowRunCollector(
	store: StateStore,
	transitionOpts: ApplyTransitionOpts,
): (receiptKey: string) => Promise<WorkflowRunCollectReceiptRow> {
	return (receiptKey) =>
		collectWorkflowRunReceipt({
			store,
			receiptKey,
			ownerId: `bridge:${process.pid}:${randomUUID()}`,
			closeExecution: async (executionId, authorityCheck) => {
				const session = store.getSession(executionId);
				if (!session) {
					return {
						closed: true,
						alreadyGone: true,
						commDbFinalized: true,
						retiredGateCount: 0,
					};
				}
				const closed = await closeRunner(
					{
						executionId,
						issueId: session.issue_id,
						projectName: session.project_name,
						reason: `workflow_force_cancel:${receiptKey}`,
						executorType: "workflow-collector",
						forcePreserved: true,
						issueTerminalOverride: true,
						authorityCheck,
					},
					store,
				);
				if (
					(!closed.closed && !closed.alreadyGone) ||
					!closed.commDbFinalized
				) {
					return closed;
				}
				const authority = await authorityCheck();
				if (!authority.ok) {
					return {
						...closed,
						closed: false,
						commDbFinalized: false,
						error: `authority_lost:post_close:${authority.reason ?? "collector_authority_lost"}`,
					};
				}
				const transitioned = applyTransition(
					transitionOpts,
					executionId,
					"terminated",
					{
						executionId,
						issueId: session.issue_id,
						projectName: session.project_name,
						trigger: "workflow_force_cancel",
					},
					{
						last_activity_at: sqliteDatetime(),
						last_error: `operator_terminate:${receiptKey}`,
					},
				);
				return transitioned.ok
					? closed
					: {
							...closed,
							closed: false,
							commDbFinalized: false,
							error: `session_terminate_failed:${transitioned.error ?? "fsm"}`,
						};
			},
		});
}

export function createBridgeApp(
	store: StateStore,
	projects: ProjectEntry[],
	config: BridgeConfig,
	broadcaster?: SseBroadcaster,
	transitionOpts?: ApplyTransitionOpts,
	retryDispatcher?: IRetryDispatcher,
	cipherWriter?: CipherWriter,
	eventFilter?: EventFilter,
	/** FLY-163: positional slot kept (was forumTagUpdater); now ignored. */
	_unusedForumTagUpdater?: unknown,
	registry?: RuntimeRegistry,
	/** FLY-163: positional slot kept (was forumPostCreator); now ignored. */
	_unusedForumPostCreator?: unknown,
	memoryService?: MemoryService,
	captureSessionFn?: CaptureSessionFn,
	startDispatcher?: IStartDispatcher,
	standupService?: StandupService,
	standupProjectName?: string,
	opts?: BridgeAppOptions,
): express.Application {
	const app = express();
	const flagStore = opts?.flagStore;
	const buildIdentity = resolveBridgeBuildIdentity();
	const actionGateAuthorityView = makeGateAuthorityView(store);
	app.disable("x-powered-by");

	// FLY-1018 (Codex code-review R1): the ship-approval-request tokenless
	// guard must answer 503 BEFORE the body is parsed. Mounted ahead of the
	// global JSON parser so a tokenless deployment 503s even for malformed
	// or oversized bodies (which would otherwise hit the parser's 400/413
	// first). The route handler keeps its own defensive 503 for direct
	// mounts/tests; this early guard is what makes the "before parse"
	// contract true in the real stack. Token configured = no-op (the guard
	// is not even mounted — byte-compatible).
	if (!config.apiToken) {
		app.post("/api/ship-approval-request", (_req, res) => {
			res
				.status(503)
				.json({ ok: false, error: "bridge api token not configured" });
		});
	}

	app.use(express.json({ limit: "512kb" }));

	// FLY-2076: capability-scoped duty mutations. This is intentionally outside
	// `/api`: the shared Bridge bearer must not grant Claw ticket write access.
	app.use(
		"/duty",
		dutyAuth(config.alertDutyToken),
		createAlertDutyRouter({
			store,
			projects,
			getAlertHub: () => opts?.alertDuty?.alertHub.current,
		}),
	);

	// FLY-1638: restart/operator admission brake. This is deliberately outside
	// /api/runs so scoped Gemini run tokens cannot mutate fleet-wide admission.
	// No master token means fail closed rather than inheriting tokenAuth's legacy
	// tokenless pass-through behavior.
	if (config.apiToken) {
		app.get(
			"/api/admission/pause",
			tokenAuthMiddleware(config.apiToken),
			(_req, res) => {
				const pause = store.getAdmissionPause();
				res.json({
					ok: true,
					admissionPause: {
						active: pause?.active === true,
						remainingSeconds: pause?.remainingSeconds ?? 0,
					},
				});
			},
		);
		app.post(
			"/api/admission/pause",
			tokenAuthMiddleware(config.apiToken),
			(req, res) => {
				const durationSeconds = Number(req.body?.durationSeconds);
				if (
					!Number.isSafeInteger(durationSeconds) ||
					durationSeconds < 1 ||
					durationSeconds > 3_600
				) {
					res.status(400).json({
						ok: false,
						error: "durationSeconds must be an integer between 1 and 3600",
					});
					return;
				}
				const reason =
					typeof req.body?.reason === "string" && req.body.reason.trim()
						? req.body.reason.trim().slice(0, 200)
						: "operator maintenance";
				const pause = store.setAdmissionPause({
					durationSeconds,
					setBy: "bridge-admission-api",
					reason,
				});
				res.json({
					ok: true,
					admissionPause: {
						active: pause.active,
						remainingSeconds: pause.remainingSeconds,
					},
				});
			},
		);
		app.post(
			"/api/admission/resume",
			tokenAuthMiddleware(config.apiToken),
			(_req, res) => {
				store.clearAdmissionPause();
				res.json({
					ok: true,
					admissionPause: { active: false, remainingSeconds: 0 },
				});
			},
		);
		app.get(
			"/api/admission/quiescence",
			tokenAuthMiddleware(config.apiToken),
			(_req, res) => {
				try {
					const pause = store.getAdmissionPause();
					if (!pause?.active) {
						res.status(409).json({
							ok: false,
							error:
								"admission pause must be active before quiescence can be proven",
						});
						return;
					}
					if (!startDispatcher || !opts?.admissionCrossingBarrier) {
						res.status(503).json({
							ok: false,
							error: "authoritative quiescence dependencies are unavailable",
						});
						return;
					}
					const crossing = opts.admissionCrossingBarrier.snapshot();
					const components = {
						readoptCandidateSessions:
							store.getReadoptCandidateSessions().length,
						dispatcherInflight: startDispatcher.getInflightCount(),
						durableLaunchClaims: store.countOpenLaunchClaims(),
						admissionCrossing: crossing,
					};
					const total =
						components.readoptCandidateSessions +
						components.dispatcherInflight +
						components.durableLaunchClaims +
						components.admissionCrossing.total;
					res.json({
						ok: true,
						admissionPause: {
							active: true,
							remainingSeconds: pause.remainingSeconds,
						},
						components,
						total,
						quiescent: total === 0,
					});
				} catch (error) {
					console.warn(
						`[host-terminal-quiescence] snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
					);
					res.status(503).json({
						ok: false,
						error: "authoritative quiescence snapshot failed",
					});
				}
			},
		);
	} else {
		app.use("/api/admission", (_req, res) => {
			res.status(503).json({
				ok: false,
				error: "admission API requires TEAMLEAD_API_TOKEN",
			});
		});
	}

	// FLY-1718 P4: privileged recovery for a fifth-strike lane. This endpoint
	// intentionally has no scoped-token or /actions alias; actor authority is
	// derived from the authenticated master-token mount, never from request JSON.
	if (config.apiToken) {
		app.post(
			"/api/doa-backoff/reset",
			tokenAuthMiddleware(config.apiToken),
			(req, res) => {
				const projectName =
					typeof req.body?.projectName === "string"
						? req.body.projectName.trim()
						: "";
				const issueId =
					typeof req.body?.issueId === "string" ? req.body.issueId.trim() : "";
				const role =
					typeof req.body?.role === "string" && req.body.role.trim()
						? req.body.role.trim()
						: "main";
				const reason =
					typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
				if (!projectName || !issueId || !reason || reason.length > 500) {
					res.status(400).json({
						ok: false,
						error:
							"projectName, issueId, and a reason of at most 500 characters are required",
					});
					return;
				}
				if (!projects.some((project) => project.projectName === projectName)) {
					res.status(404).json({ ok: false, error: "project not found" });
					return;
				}
				const resolved = resolveLifecycleRootKey(store, issueId, []);
				if (!resolved.ok) {
					res.status(409).json({
						ok: false,
						error: "lifecycle root is not unambiguous",
						reason: resolved.reason,
					});
					return;
				}
				try {
					const reset = store.resetDoaBackoff({
						projectName,
						lifecycleRootUuid: resolved.rootKey,
						role,
						actor: "master-api-token",
						reason,
					});
					res.json({
						ok: true,
						lifecycleRootUuid: resolved.rootKey,
						role,
						...reset,
					});
				} catch (error) {
					if ((error as Error).message === "doa_backoff_reset_bound_owner") {
						res.status(409).json({
							ok: false,
							error: "a bound successor still owns this DOA lane",
						});
						return;
					}
					console.warn(
						`[doa-backoff] authenticated reset failed: ${(error as Error).message}`,
					);
					res
						.status(500)
						.json({ ok: false, error: "DOA backoff reset failed" });
				}
			},
		);
	} else {
		app.post("/api/doa-backoff/reset", (_req, res) => {
			res.status(503).json({
				ok: false,
				error: "DOA backoff reset requires TEAMLEAD_API_TOKEN",
			});
		});
	}

	// FLY-1285: supervisor observations are bearer-authenticated inside this
	// dedicated router (including an explicit 503 when apiToken is absent) and
	// hydrate the durable hold before any heartbeat reaper can act.
	app.use(
		"/api/tmux-hold-observation",
		createTmuxHoldObservationRouter({
			store,
			projects,
			apiToken: config.apiToken,
		}),
	);

	// FLY-1244: scoped workflow decisions authenticate with a per-execution
	// credential, never the fleet ingest bearer. The head read route is a separate
	// loopback-only fail-closed seam used by verify-approval; it is not credential
	// authenticated and exposes only the execution's git SHA.
	app.use(
		"/api/workflow",
		createWorkflowDecisionRouter({
			store,
			materializedHeadAuthority: opts?.materializedHeadAuthority,
			gateCarrierRebind: {
				tokens: opts?.fleetConsole?.tokens ?? new ConfirmTokenStore(),
			},
			resolveAlertIdentity: (projectName, issueId, runId) =>
				resolveWorkflowRunAlertIdentity({
					store,
					projects,
					defaultLeadAgentId: config.defaultLeadAgentId,
					projectName,
					issueId,
					runId,
					log: (message) => console.warn(`[workflow-gate-carrier] ${message}`),
				}),
			...(opts?.fleetConsole
				? { loopReentry: { tokens: opts.fleetConsole.tokens } }
				: {}),
		}),
	);
	app.use(
		"/api/workflow",
		createWorkflowCarrierRedriveRouter({
			store,
			tokens: opts?.fleetConsole?.tokens ?? new ConfirmTokenStore(),
			apiToken: config.apiToken,
		}),
	);
	app.use("/api/workflow", createWorkflowTemplateRouter(store));
	app.use("/api/workflow", createWorkflowMenuRouter(projects));
	const flywheelProjectRoot = projects.find(
		(project) => project.projectName === "flywheel",
	)?.projectRoot;
	app.use(
		"/api/workflow/cutovers/FLY-1436",
		createWorkKindCutoverRouter({
			store,
			apiToken: config.apiToken,
			// The operator re-runs the bounded quiescence probe between stage and
			// apply. Five minutes preserves single-use semantics without making a
			// healthy 60–90 second probe burn the founder-approved window.
			tokens: opts?.workKindCutoverTokens ?? new ConfirmTokenStore(5 * 60_000),
			readActivationEvidence:
				opts?.workKindCutoverEvidence ??
				(() =>
					flywheelProjectRoot
						? readFly1436ActivationEvidence({
								projectRoot: flywheelProjectRoot,
								pipelineEnrollment: flagStore
									? () => readPipelineEnrollment(flagStore, "flywheel")
									: undefined,
							})
						: {
								templateDispatch: false,
								generalizedTemplates: false,
								workKind: false,
								prBAssetsReady: false,
								deployedSha: "",
								assetsDigest: "",
							}),
		}),
	);

	// FLY-175 Track 2: founder-consent hard gate. Returns null when
	// decisionMode=off (default) — `fcMw()` then yields a no-op handler so the
	// reserved-endpoint stacks are byte-compatible with pre-Track-2.
	// FLY-191 Phase 2: transitionOpts lets the gate-response endpoint flip
	// awaiting_review → approved_to_ship (parity with /api/actions/approve).
	const fcWiring = buildFounderConsentWiring(
		store,
		projects,
		config,
		undefined,
		transitionOpts,
		// FLY-907: recovered-merge finalization display refresh (late-bound).
		opts?.issueDisplayRefresh,
		opts?.materializedHeadAuthority,
	);
	const fcNoop: express.RequestHandler = (_q, _s, next) => next();
	const fcMw = (
		mount: "action_router" | "close_tmux" | "close_runner",
	): express.RequestHandler =>
		fcWiring ? fcWiring.middlewareFor(mount) : fcNoop;
	if (fcWiring) {
		const mode = config.founderConsent?.decisionMode ?? "off";
		if (mode === "off") {
			console.log(
				"[founder-consent] Track 2 present, decisionMode=off — Surface A no-op, gate route pass-through (no enforcement, no audit)",
			);
		} else {
			console.log(
				`[founder-consent] Track 2 ENABLED — decisionMode=${mode} (audit.db=${config.founderConsent?.auditDbPath})`,
			);
		}
	}

	// Health — no auth
	app.get("/health", (_req, res) => {
		const active = store.getActiveSessions();
		const admissionPause = store.getAdmissionPause();
		// FLY-516: startBridge's close() flips shutdownStateHolder.shuttingDown at
		// the top of teardown, so /health stops claiming "ready" the moment
		// shutdown begins. flywheel-bridge-wrapper.sh probes this to tell a healthy
		// serving Bridge apart from a zombie stuck mid-close() that still answers
		// /health 200 — the latter must yield its port, not be mistaken for a live
		// double-start. Read at request time via the late-bound holder; absent
		// (standalone createBridgeApp) ⇒ false.
		const shuttingDown = opts?.shutdownStateHolder?.shuttingDown === true;
		let liveness: unknown;
		let eventLoop: EventLoopHealthSnapshot | undefined;
		if (opts?.eventLoopAttribution) {
			try {
				eventLoop = opts.eventLoopAttribution.healthSnapshot();
			} catch (error) {
				console.warn(
					"[health] event-loop diagnostics unavailable:",
					error instanceof Error ? error.message : String(error),
				);
				eventLoop = { p99_ms: null, max_ms: null, episodes: 0 };
			}
		}
		if (opts?.livenessHealthProvider?.current) {
			try {
				liveness = opts.livenessHealthProvider.current();
			} catch (error) {
				console.warn(
					"[health] liveness manifest unavailable:",
					error instanceof Error ? error.message : String(error),
				);
				liveness = {
					degraded: true,
					reason: "manifest_provider_error",
				};
			}
		}
		res.json({
			// `ok` is byte-compatible (true in steady state); it flips false during
			// shutdown so the deploy health check + wrapper preflight treat a
			// draining Bridge as not-ready. `shuttingDown` is additive.
			ok: !shuttingDown,
			shuttingDown,
			uptime: process.uptime(),
			sessions_count: active.length,
			buildMode: buildIdentity.mode,
			buildSha: buildIdentity.buildSha,
			...(buildIdentity.mode === "built"
				? { artifactBuildSha: buildIdentity.artifactBuildSha }
				: {}),
			admissionPause: {
				active: admissionPause?.active === true,
				remainingSeconds: admissionPause?.remainingSeconds ?? 0,
			},
			...(liveness === undefined ? {} : { liveness }),
			...(eventLoop === undefined ? {} : { event_loop: eventLoop }),
		});
	});

	app.get(
		"/api/diagnostics/event-loop",
		((req, res, next) => {
			if (!config.apiToken) {
				res.status(503).json({ error: "TEAMLEAD_API_TOKEN is not configured" });
				return;
			}
			const bearer = req.headers.authorization ?? "";
			if (safeCompare(bearer, `Bearer ${config.apiToken}`)) {
				next();
				return;
			}
			if (
				config.geminiAgentToken &&
				safeCompare(bearer, `Bearer ${config.geminiAgentToken}`)
			) {
				res.status(403).json({ error: "forbidden for scoped token" });
				return;
			}
			res.status(401).json({ error: "unauthorized" });
		}) as express.RequestHandler,
		(_req, res) => {
			if (!opts?.eventLoopAttribution) {
				res.status(503).json({ error: "event-loop diagnostics unavailable" });
				return;
			}
			try {
				res.json(opts.eventLoopAttribution.snapshot());
			} catch {
				res.status(503).json({ error: "event-loop diagnostics unavailable" });
			}
		},
	);

	// Dashboard / Fleet console — no auth (loopback only). FLY-247 inc2a: when the
	// console is wired, `GET /` renders the Fleet console (run-status板块 cut per
	// Annie; the SSE payload fields are preserved, just not rendered). Otherwise
	// the legacy operations dashboard (byte-compat).
	app.get("/", (_req, res) => {
		res
			.type("html")
			.send(opts?.fleetConsole ? getFleetConsoleHtml() : getDashboardHtml());
	});

	// SSE — no auth (loopback only)
	app.get("/sse", (req, res) => {
		res.setHeader("Content-Type", "text/event-stream");
		res.setHeader("Cache-Control", "no-cache");
		res.setHeader("Connection", "keep-alive");
		if (broadcaster) {
			res.flushHeaders();
			broadcaster.addClient(res);
			req.on("close", () => broadcaster.removeClient(res));
		} else {
			// Snapshot mode — no broadcaster configured (tests or direct createBridgeApp usage)
			if (process.env.NODE_ENV !== "test") {
				console.warn(
					"[SSE] No broadcaster configured — serving one-shot snapshot",
				);
			}
			const payload = buildDashboardPayload(
				store,
				config.stuckThresholdMinutes,
			);
			res.write(`event: state\ndata: ${JSON.stringify(payload)}\n\n`);
			res.end();
		}
	});

	// GEO-280: Post-merge cleanup callback (fire-and-forget after approve)
	// Bridge only closes tmux session + audit. Other cleanup (worktree, docs) is Runner/Orchestrator responsibility.
	const onApproved = (
		executionId: string,
		session: { issue_id: string; project_name: string },
	) => {
		postMergeTmuxCleanup(
			{
				executionId,
				issueId: session.issue_id,
				projectName: session.project_name,
			},
			store,
		).catch((err) => {
			console.error(
				`[post-merge] Cleanup failed for ${executionId}:`,
				(err as Error).message,
			);
		});
	};

	// Dashboard actions — no auth (loopback only, same handlers as /api/actions)
	app.use(
		"/actions",
		fcMw("action_router"),
		createActionRouter(
			store,
			projects,
			transitionOpts,
			config,
			retryDispatcher,
			cipherWriter,
			eventFilter,
			undefined, // _unusedForumTagUpdater (FLY-163)
			registry,
			onApproved,
			opts?.issueDisplayRefresh, // FLY-907
			opts?.turnBeltReconciler,
			undefined, // cardAuthority
			opts?.materializedHeadAuthority,
			actionGateAuthorityView,
		),
	);

	// FLY-1185: the ship-entry lifecycle bundle + repo lock are BUILT in
	// startBridge (they need its transitionOpts + reach its HeartbeatService /
	// scheduler / setupRunInfrastructure) and arrive here via opts.
	const lifecycleInfra = opts?.lifecycleInfra;

	// FLY-603 Layer A: build the worktree-cleanup closure ONCE at the
	// composition root (hoisted high enough to reach both /events and the
	// DirectEventSink created later in setupRunInfrastructure).
	const removeCleanWorktree = makeBridgeWorktreeCleanup(
		store,
		projects,
		opts?.withRepoLock,
	);

	// /events — ingest auth
	//
	// FLY-560 Feature A: auto-stamp pipeline-stage emoji onto issue thread
	// titles. Permanently enabled; naturally a no-op when chat threads are off.
	const issueStatusEmojiEnabled = true;
	// FLY-560 Feature C: pin a `tmux attach` rescue command on each issue thread.
	// Permanently enabled alongside the status badge.
	const issueAttachPinEnabled = true;
	app.use(
		"/events",
		tokenAuthMiddleware(config.ingestToken),
		createEventRouter(
			store,
			projects,
			config,
			cipherWriter,
			transitionOpts,
			eventFilter,
			registry,
			issueStatusEmojiEnabled || issueAttachPinEnabled
				? opts?.chatThreadCreator
				: undefined,
			removeCleanWorktree,
			{ issueStatusEmojiEnabled, issueAttachPinEnabled },
			opts?.reconnectHolder,
			opts?.codexReviewHold,
			opts?.codexReviewIngest,
			opts?.reviewAuthorizationAlerts,
			opts?.turnBeltReconciler,
			opts?.accountRotationPost,
			opts?.issueDisplayRefresh, // FLY-907
			lifecycleInfra, // FLY-1185 entry A bundle
			opts?.terminalArchiveEnqueue, // FLY-1282 Part C
			opts?.materializedHeadAuthority, // FLY-1307 PR-7.5
		),
	);

	// FLY-1718 P3: a design result is not self-authorizing. The runner submits
	// only its result projection; StateStore + the persisted worktree remain the
	// authority. Missing server token is an explicit 503 rather than inheriting
	// tokenAuthMiddleware's legacy tokenless no-op behavior.
	if (!config.ingestToken) {
		app.post("/design-review-validation", (_req, res) => {
			res.status(503).json({
				allowed: false,
				reason: "bridge ingest token not configured",
			});
		});
	} else {
		app.post(
			"/design-review-validation",
			tokenAuthMiddleware(config.ingestToken),
			(req, res) => {
				const result = validateDesignReviewProjection(
					store,
					(req.body ?? {}) as Record<string, unknown>,
				);
				if (result.allowed) {
					res.json(result);
					return;
				}
				res.status(result.httpStatus).json({
					allowed: false,
					reason: result.reason,
				});
			},
		);
	}

	// FLY-1188 §7.1: codex-author review-request registration. Runner-facing
	// like /events → same ingest-token auth. A 200 is the DURABLE-ACCEPTED ack
	// (the job row is committed before accept() resolves); anything else means
	// the request is NOT registered and the CLI must keep its fail-close marker.
	app.post(
		"/review-requests",
		tokenAuthMiddleware(config.ingestToken),
		(req, res) => {
			const coordinator = opts?.reviewCoordinator?.current;
			if (!coordinator) {
				res.status(503).json({
					accepted: false,
					reason: "review coordinator not ready",
				});
				return;
			}
			coordinator
				.accept((req.body ?? {}) as Record<string, unknown>)
				.then((result) => {
					if (result.accepted) {
						res.json(result);
					} else {
						res.status(result.httpStatus).json(result);
					}
				})
				.catch((err) => {
					console.error(
						`[review-requests] accept crashed: ${err instanceof Error ? err.message : String(err)}`,
					);
					res.status(500).json({ accepted: false, reason: "internal error" });
				});
		},
	);

	// FLY-1278: supervised Lead governance for a delivered finding. This is a
	// distinct authority channel — gate/request prose never becomes a ruling.
	// It shares the ingest-token boundary and late-bound coordinator with review
	// requests; the handler preserves 4xx conflict/not-found semantics.
	app.post(
		"/review-rulings",
		tokenAuthMiddleware(config.ingestToken),
		createReviewRulingHandler(
			opts?.reviewCoordinator ?? { current: undefined },
		),
	);

	// FLY-247 inc2a: Fleet console founder-admin surface (§2.2). Mounted BEFORE
	// the `/api` Bearer middleware so `/api/fleet/*` never hits it — the console
	// authenticates via loopback + same-origin + single-use confirmToken + audit,
	// NOT via TEAMLEAD_API_TOKEN (the browser holds no token). Gated on the
	// console being wired (opts.fleetConsole); absent = byte-compat (no routes).
	const fleetConsole = opts?.fleetConsole;
	if (fleetConsole) {
		const fleetRouteDeps = fleetConsole.routeDeps();
		// Anti-DNS-rebinding + anti-CSRF (Codex R1 HIGH-1): the `Host` header is
		// attacker-controllable, so a rebinding domain (evil.com → 127.0.0.1) would
		// otherwise make Host AND Origin match. `loopbackSelfOrigin` rejects any
		// non-loopback Host before it is trusted as the same-origin baseline.
		const fleetHeaders = (
			req: express.Request,
		): Record<string, string | undefined> => ({
			origin:
				typeof req.headers.origin === "string" ? req.headers.origin : undefined,
			referer:
				typeof req.headers.referer === "string"
					? req.headers.referer
					: undefined,
		});

		// Secret-free read model (loopback only; allowlisted DTO, never LeadConfig).
		app.get("/api/fleet/snapshot", async (req, res) => {
			if (!loopbackSelfOrigin(req.headers.host)) {
				res.status(403).json({ error: "non-loopback host" });
				return;
			}
			try {
				// FLY-709 P4: mtime-refresh the per-project config cache so a
				// runner-config CLI write is visible on the NEXT snapshot without a
				// Bridge restart (unchanged files are stat-only, not re-parsed).
				await fleetConsole.refreshProjectConfigs?.();
				res.json(fleetConsole.buildManagementSnapshot());
			} catch (err) {
				res.status(500).json({ error: (err as Error).message });
			}
		});

		// FLY-709: the phone feature-flag report (loopback). The localhost console
		// renders the flag cards natively from its snapshot (no iframe), so this
		// endpoint is the phone artifact only:
		//   ?interactive=1 → the copy-paste page (delivered via `flywheel-comm
		//                    feature-flags report` → publish-report; report-registry
		//                    mints the CSP nonce at serve time).
		//   (absent/0)     → read-only cards (byte-compat).
		app.get("/api/fleet/flag-report.html", async (req, res) => {
			if (!loopbackSelfOrigin(req.headers.host)) {
				res.status(403).json({ error: "non-loopback host" });
				return;
			}
			try {
				await fleetConsole.refreshProjectConfigs?.();
				const snap = fleetConsole.buildSnapshot();
				const html = renderFlagReport(snap, {
					interactive: req.query.interactive === "1",
				});
				res.type("html").send(html);
			} catch (err) {
				res.status(500).json({ error: (err as Error).message });
			}
		});

		// Console-only SSE progress channel — SEPARATE from legacy /sse (which
		// stays byte-identical). Reads the durable batch journals; on a batch
		// reaching terminal it reconciles the apply-result audit row (R4 #5).
		app.get("/api/fleet/progress", (req, res) => {
			if (!loopbackSelfOrigin(req.headers.host)) {
				res.status(403).json({ error: "non-loopback host" });
				return;
			}
			// Refuse new SSE streams once the console is shutting down (Codex R5
			// MEDIUM): a late reconnect during async teardown must NOT start a timer
			// or reopen the audit DB.
			if (fleetConsole.isClosed()) {
				res.status(503).end();
				return;
			}
			res.setHeader("Content-Type", "text/event-stream");
			res.setHeader("Cache-Control", "no-cache");
			res.setHeader("Connection", "keep-alive");
			res.flushHeaders?.();
			const seenTerminal = new Set<string>();
			const push = (): void => {
				let batches: ReturnType<FleetConsole["listProgress"]>;
				try {
					batches = fleetConsole.listProgress();
				} catch {
					return;
				}
				for (const b of batches) {
					// Only mark a terminal batch "seen" once its apply-result audit row
					// is confirmed written (Codex R1 MEDIUM-5: marking before the write
					// permanently loses the row if the DB write fails); reconcile never
					// throws, so the timer can't crash.
					if (b.terminal && !seenTerminal.has(b.batchId)) {
						if (fleetConsole.reconcileTerminalAudit(b.batchId)) {
							seenTerminal.add(b.batchId);
						}
					}
				}
				const managementBatches =
					fleetConsole.getManagementCoordinator()?.listProgress() ?? [];
				res.write(
					`event: progress\ndata: ${JSON.stringify({ batches, managementBatches })}\n\n`,
				);
			};
			push();
			const timer = setInterval(push, 1000);
			timer.unref?.();
			// Track this SSE client so close() can end it (Codex R4 MEDIUM-1:
			// server.close() doesn't terminate active responses → shutdown hang;
			// an untracked timer could also reopen the audit DB after close()).
			const stop = (): void => {
				clearInterval(timer);
				try {
					res.end();
				} catch {
					// already closed
				}
			};
			const unregister = fleetConsole.registerProgress(stop);
			req.on("close", () => {
				unregister();
				clearInterval(timer);
			});
		});

		// Stage: loopback host + same-origin → canonical request → confirmToken.
		app.post("/api/fleet/stage", (req, res) => {
			const selfOrigin = loopbackSelfOrigin(req.headers.host);
			if (!selfOrigin) {
				res.status(403).json({ error: "non-loopback host" });
				return;
			}
			const r = handleStage(
				fleetRouteDeps,
				req.body,
				fleetHeaders(req),
				selfOrigin,
			);
			res.status(r.status).json(r.body);
		});

		// Apply: loopback host + same-origin + confirmToken → launching → spawn.
		app.post("/api/fleet/apply", (req, res) => {
			const selfOrigin = loopbackSelfOrigin(req.headers.host);
			if (!selfOrigin) {
				res.status(403).json({ error: "non-loopback host" });
				return;
			}
			const r = handleApply(
				fleetRouteDeps,
				req.body,
				fleetHeaders(req),
				selfOrigin,
			);
			res.status(r.status).json(r.body);
		});

		app.post("/api/fleet/changes/stage", async (req, res) => {
			const selfOrigin = loopbackSelfOrigin(req.headers.host);
			if (!selfOrigin) {
				res.status(403).json({ error: "non-loopback host" });
				return;
			}
			if (!ffIsSameOrigin(fleetHeaders(req), selfOrigin)) {
				res.status(403).json({ error: "cross-origin" });
				return;
			}
			const coordinator = fleetConsole.getManagementCoordinator();
			if (!coordinator) {
				res.status(503).json({ error: "management writes unavailable" });
				return;
			}
			const result = await coordinator.stage(req.body, selfOrigin);
			res.status(result.code).json(result.body);
		});

		app.post("/api/fleet/changes/apply", async (req, res) => {
			const selfOrigin = loopbackSelfOrigin(req.headers.host);
			if (!selfOrigin) {
				res.status(403).json({ error: "non-loopback host" });
				return;
			}
			if (!ffIsSameOrigin(fleetHeaders(req), selfOrigin)) {
				res.status(403).json({ error: "cross-origin" });
				return;
			}
			const coordinator = fleetConsole.getManagementCoordinator();
			if (!coordinator) {
				res.status(503).json({ error: "management writes unavailable" });
				return;
			}
			const result = await coordinator.apply(req.body, selfOrigin);
			res.status(result.code).json(result.body);
		});

		// FLY-709 P2: feature-flag toggle (copy-paste-apply). Same loopback +
		// same-origin + confirmToken auth as the fleet routes; reuses the console's
		// token store + audit. Only direct-toggle flags are accepted (server
		// allow-set is authority; governance/restart-type refused in handleFlagStage).
		const flagRouteDeps: FlagRouteDeps = {
			envPath: join(homedir(), ".flywheel", ".env"),
			readFile: (p) => ffReadFileSync(p, "utf-8"),
			tokens: fleetConsole.tokens,
			audit: fleetConsole.audit,
			flagStore,
			projectNames:
				opts?.flagProjectNames ??
				(() => projects.map((project) => project.projectName)),
			projectConfigPath:
				opts?.flagProjectConfigPath ??
				((projectName) => {
					const root = projects.find(
						(project) => project.projectName === projectName,
					)?.projectRoot;
					return root ? join(root, ".flywheel", "config.yaml") : undefined;
				}),
		};
		app.post("/api/fleet/flag/stage", (req, res) => {
			const selfOrigin = loopbackSelfOrigin(req.headers.host);
			if (!selfOrigin) {
				res.status(403).json({ error: "non-loopback host" });
				return;
			}
			if (!ffIsSameOrigin(fleetHeaders(req), selfOrigin)) {
				res.status(403).json({ error: "cross-origin" });
				return;
			}
			const r = handleFlagStage(flagRouteDeps, req.body, selfOrigin);
			res.status(r.code).json(r.body);
		});
		app.post("/api/fleet/flag/apply", (req, res) => {
			const selfOrigin = loopbackSelfOrigin(req.headers.host);
			if (!selfOrigin) {
				res.status(403).json({ error: "non-loopback host" });
				return;
			}
			if (!ffIsSameOrigin(fleetHeaders(req), selfOrigin)) {
				res.status(403).json({ error: "cross-origin" });
				return;
			}
			const { canonical, confirmToken } = (req.body ?? {}) as {
				canonical?: AnyFlagCanonical;
				confirmToken?: string;
			};
			if (!canonical || !confirmToken) {
				res.status(400).json({ error: "missing canonical/confirmToken" });
				return;
			}
			const r = handleFlagApply(
				flagRouteDeps,
				canonical,
				confirmToken,
				selfOrigin,
			);
			res.status(r.code).json(r.body);
		});

		// FLY-709 P5: runner-default stage/apply — same loopback + same-origin +
		// confirmToken auth as flag/fleet; reuses the console's tokens + audit +
		// the live project topology (projectRoot resolved server-side, never from
		// the client). Writes config.yaml (new-run scope; NO Lead restart).
		const runnerRouteDeps: RunnerRouteDeps = {
			liveProjects: () => projects,
			readFile: (p) => ffReadFileSync(p, "utf-8"),
			tokens: fleetConsole.tokens,
			audit: fleetConsole.audit,
		};
		app.post("/api/fleet/runner/stage", (req, res) => {
			const selfOrigin = loopbackSelfOrigin(req.headers.host);
			if (!selfOrigin) {
				res.status(403).json({ error: "non-loopback host" });
				return;
			}
			if (!ffIsSameOrigin(fleetHeaders(req), selfOrigin)) {
				res.status(403).json({ error: "cross-origin" });
				return;
			}
			const r = handleRunnerStage(runnerRouteDeps, req.body, selfOrigin);
			res.status(r.code).json(r.body);
		});
		app.post("/api/fleet/runner/apply", async (req, res) => {
			const selfOrigin = loopbackSelfOrigin(req.headers.host);
			if (!selfOrigin) {
				res.status(403).json({ error: "non-loopback host" });
				return;
			}
			if (!ffIsSameOrigin(fleetHeaders(req), selfOrigin)) {
				res.status(403).json({ error: "cross-origin" });
				return;
			}
			const { canonical, confirmToken } = (req.body ?? {}) as {
				canonical?: RunnerCanonical;
				confirmToken?: string;
			};
			if (!canonical || !confirmToken) {
				res.status(400).json({ error: "missing canonical/confirmToken" });
				return;
			}
			const r = await handleRunnerApply(
				runnerRouteDeps,
				canonical,
				confirmToken,
				selfOrigin,
			);
			res.status(r.code).json(r.body);
		});
	}

	// FLY-286 PR-2: web-local review surface. Mounted BEFORE the /api Bearer
	// middleware (it lives OUTSIDE /api and authenticates via loopback Host +
	// same-origin + a run-scoped session token — the browser holds no apiToken,
	// mirroring the Fleet console). FLY-1243: FLYWHEEL_XHS_REVIEW retired (固化
	// default-on) — the loopback review routes are always mounted (loopback +
	// session-token gated, so mounting them fleet-wide is harmless).
	{
		const xhsStateDir = xhsDefaultStateDir();
		const xhsDeps: XhsReviewDeps = {
			analysis: createLocalAnalysisStore(xhsStateDir),
			feedback: createLocalFeedbackStore(xhsStateDir),
			readLocator: (t) => readXhsLocator(xhsStateDir, t),
			runExclusive: (p, c, fn) => xhsWithCollectionLock(xhsStateDir, p, c, fn),
			tokens: createInMemoryTokenStore(),
			nonce: () => randomBytes(16).toString("hex"),
			now: () => new Date().toISOString(),
		};
		const xhsHeaders = (
			req: express.Request,
		): Record<string, string | undefined> => ({
			host: typeof req.headers.host === "string" ? req.headers.host : undefined,
			origin:
				typeof req.headers.origin === "string" ? req.headers.origin : undefined,
			referer:
				typeof req.headers.referer === "string"
					? req.headers.referer
					: undefined,
		});
		app.get("/xhs-review/:reportToken", async (req, res) => {
			const r = await handleGetReview(
				xhsDeps,
				req.params.reportToken,
				xhsHeaders(req),
			);
			if (r.headers) {
				for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
			}
			if (typeof r.body === "string") {
				res
					.status(r.status)
					.type(r.contentType ?? "text/plain")
					.send(r.body);
			} else {
				res.status(r.status).json(r.body);
			}
		});
		app.post(
			"/xhs-review/:reportToken/action",
			express.urlencoded({ extended: false, limit: "64kb" }),
			async (req, res) => {
				const r = await handlePostAction(
					xhsDeps,
					req.params.reportToken,
					(req.body ?? {}) as Record<string, unknown>,
					xhsHeaders(req),
				);
				res
					.status(r.status)
					.json(typeof r.body === "string" ? { message: r.body } : r.body);
			},
		);
	}

	// FLY-1185 §2.12: issue-lifecycle reserved endpoints (park / unpark) + the
	// approved-manifest apply committer. api-token guarded like every /api
	// surface AND fail-closed on their own when no apiToken is configured.
	if (opts?.lifecycleRoutes) {
		app.use(
			"/api/lifecycle",
			tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
			opts.lifecycleRoutes.parkRouter,
		);
		app.use(
			"/api/lifecycle-apply",
			tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
			opts.lifecycleRoutes.applyRouter,
		);
	}

	// /api/* — api auth
	app.use(
		"/api",
		apiAuthWithRunnerTierDelegation(config.apiToken, config.geminiAgentToken),
		createQueryRouter(store, projects, {
			retryDispatcher,
			captureSessionFn,
			statusQueryFn: captureSessionFn
				? createStatusQuery(captureSessionFn).query
				: undefined,
			chatThreadsEnabled: config.chatThreadsEnabled,
			chatThreadCreator: opts?.chatThreadCreator,
			globalBotToken: opts?.globalBotToken,
			discordOwnerUserId: config.discordOwnerUserId,
			// FLY-162: gate /api/chat-threads/send + /by-thread routes on
			// BridgeConfig.replyByIssueEnabled. Validated at startup that
			// apiToken is set when this is true (see config.ts).
			replyByIssueEnabled: config.replyByIssueEnabled,
			// FLY-162 Layer 2: gate /api/discord/reply-guard + configured issue
			// prefixes. Validated at startup that apiToken is set when enabled.
			replyGuardEnabled: config.replyGuardEnabled,
			issuePrefixes: config.issuePrefixes,
			// FLY-369: gate the privileged /chat-threads/archive route. The /api
			// tokenAuthMiddleware no-ops when apiToken is unset, and chatThreads
			// does not fail-start with one, so the route must fail closed itself.
			apiTokenConfigured: Boolean(config.apiToken),
			dispatcherBotUserId: () =>
				opts?.alertDuty?.dispatcherBotUserId.current ?? null,
		}),
	);
	app.use(
		"/api/actions",
		tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
		fcMw("action_router"),
		createActionRouter(
			store,
			projects,
			transitionOpts,
			config,
			retryDispatcher,
			cipherWriter,
			eventFilter,
			undefined, // _unusedForumTagUpdater (FLY-163)
			registry,
			onApproved,
			opts?.issueDisplayRefresh, // FLY-907
			opts?.turnBeltReconciler,
			undefined, // cardAuthority
			opts?.materializedHeadAuthority,
			actionGateAuthorityView,
		),
	);

	// FLY-1309: privileged, loopback-only carrier attestation. The route is
	// always present so missing master-token configuration fails closed instead
	// of making carrier readiness ambiguous.
	app.use(
		"/api/lead-lease/self-check",
		config.apiToken
			? tokenAuthMiddleware(config.apiToken, config.geminiAgentToken)
			: (((_req, res) => {
					res.status(503).json({
						ok: false,
						reason: "api_token_not_configured",
					});
				}) as express.RequestHandler),
		createLeadLeaseSelfCheckRouter(),
	);
	app.use(
		"/api/lead-lease/diagnostics",
		config.apiToken
			? tokenAuthMiddleware(config.apiToken, config.geminiAgentToken)
			: (((_req, res) => {
					res.status(503).json({
						schemaVersion: 1,
						healthy: false,
						reason: "api_token_not_configured",
					});
				}) as express.RequestHandler),
		createLeadLeaseDiagnosticsRouter(),
	);

	// FLY-175 Track 2 Surface B + debug endpoint (auth-required). The gate
	// router is mounted whenever Track 2 is compiled in — INCLUDING when
	// decisionMode=off, where it pass-through-writes the response. This is
	// required because the patched `flywheel-comm respond` CLI always routes
	// approve_to_ship through this endpoint; a 404 here would block every ship
	// during the default-off rollout (Codex R1 HIGH). The audit debug endpoint
	// only exists when the evaluator/audit store are constructed (mode != off).
	if (fcWiring) {
		app.use(
			"/api/founder-consent/runner-gate-response",
			// FLY-191 Phase 2 (Codex PR R1 HIGH-4): this endpoint WRITES the
			// approve_to_ship gate response — the ship authority's trusted
			// source. tokenAuthMiddleware no-ops when apiToken is unset (fine
			// for read-ish action routes, NOT for this one): refuse outright on
			// tokenless deployments instead of exposing an unauthenticated
			// approval write. The CLI side already requires TEAMLEAD_API_TOKEN
			// (respond.ts routeThroughBridge), so this aligns Bridge with CLI.
			config.apiToken
				? tokenAuthMiddleware(config.apiToken, config.geminiAgentToken)
				: (((_req, res) => {
						res.status(503).json({
							error:
								"founder-consent gate-response endpoint disabled: TEAMLEAD_API_TOKEN is not configured (refusing unauthenticated approval writes)",
						});
					}) as express.RequestHandler),
			fcWiring.gateRouter,
		);
		if (fcWiring.debugRouter) {
			app.use(
				"/api/founder-consent/audit",
				tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
				fcWiring.debugRouter,
			);
		}
	}

	app.use(
		"/api/founder-routing/runner-response",
		config.apiToken
			? tokenAuthMiddleware(config.apiToken)
			: (((_req, res) => {
					res.status(503).json({
						error:
							"founder routing response endpoint requires TEAMLEAD_API_TOKEN",
					});
				}) as express.RequestHandler),
		createFounderRoutingResponseRouter({
			getThreadById: (threadId) => store.getChatThreadByThreadId(threadId),
			getSessionsByIssue: (issueId) => store.getSessionsByIssue(issueId),
			commDbPathForProject,
			logger: {
				warn: (message) => console.warn(message),
			},
		}),
	);

	// GEO-270: Close stale tmux session (resource cleanup, no status change)
	// FLY-1373 doorbell: a best-effort latency hint only. comm.db remains the
	// authority, so a lost/duplicate nudge cannot lose or duplicate delivery.
	app.post(
		"/api/lead-inbox/nudge",
		masterOrIngestAuthMiddleware(config.apiToken, config.ingestToken),
		(req, res) => {
			const { leadId, project } = (req.body ?? {}) as {
				leadId?: unknown;
				project?: unknown;
			};
			if (typeof leadId !== "string" || !leadId.trim()) {
				res.status(400).json({ error: "leadId is required" });
				return;
			}
			const projectName = typeof project === "string" ? project : undefined;
			if (!registry?.nudgeLeadInbox(leadId, projectName)) {
				res.status(404).json({ error: "Lead inbox loop not found" });
				return;
			}
			res.status(202).json({ ok: true });
		},
	);

	// FLY-224: Codex Lead outbound — apiToken-guarded reserved endpoint the Codex
	// Lead runtime POSTs its replies to (durable idempotencyKey dedup → exactly-once
	// Discord delivery via the per-Lead bot token). Additive; registered only when
	// apiToken is configured (reserved endpoints require it) → no-op otherwise.
	if (config.apiToken) {
		const codexLeadOutbound = buildLeadOutboundExpressHandler(
			new CodexLeadOutboundHandler({
				store: new SqliteOutboundDedupStore(
					join(homedir(), ".flywheel", "codex-lead-outbound-dedup.db"),
				),
				send: buildLeadDiscordSend({
					resolveBotToken: buildResolveBotToken(projects, process.env),
				}),
				expectedApiToken: config.apiToken,
				// Anti-impersonation: a Lead may only post to its own channels (FLY-246).
				authorizeLeadChannel: buildAuthorizeLeadChannel(projects),
			}),
		);
		app.post(
			"/api/lead-outbound/send",
			tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
			(req, res) => {
				void codexLeadOutbound(req, res);
			},
		);
	}

	app.post(
		"/api/sessions/:executionId/close-tmux",
		tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
		fcMw("close_tmux"),
		async (req, res) => {
			const executionId = req.params.executionId as string;
			const { leadId } = (req.body ?? {}) as { leadId?: string };

			const session = store.getSession(executionId);
			if (!session) {
				res.status(404).json({ error: "Session not found" });
				return;
			}

			// FLY-44: Only block close-tmux when Runner still needs tmux
			const tmuxProtectedStates = new Set([
				"running",
				"ship_parked",
				"awaiting_review",
				"approved_to_ship",
			]);
			if (tmuxProtectedStates.has(session.status)) {
				res.status(409).json({
					error: `Cannot close tmux for session in "${session.status}" state — Runner still needs tmux`,
				});
				return;
			}

			if (leadId && projects) {
				try {
					if (!matchesLead(session, leadId, projects)) {
						res.status(403).json({
							success: false,
							message: `Session ${executionId} is outside lead "${leadId}" scope`,
						});
						return;
					}
				} catch (err) {
					console.warn(
						`[close-tmux] matchesLead error for ${executionId}: ${(err as Error).message}`,
					);
					res.status(403).json({
						success: false,
						message: `Lead scope check failed: ${(err as Error).message}`,
					});
					return;
				}
			}

			await reapCodexDaemonForSession(store, session, "bridge.close-tmux");
			const target = getTmuxTargetFromCommDb(executionId, session.project_name);
			if (!target) {
				res.json({ closed: false, reason: "No tmux target found" });
				return;
			}

			// FLY-1185 §2.5: reap MCP-family descendants BEFORE any kill (pane pid
			// only resolvable while the window lives). Reap-only, best-effort.
			await reapRunnerMcp(target.tmuxWindow).catch(() => undefined);

			// FLY-638 (Codex R1 MED): this founder-gated teardown surface must also
			// drop the per-runner cmux LINKED session, or it re-introduces the same
			// cmux leak the close_runner / terminate paths fixed. Resolve + kill it
			// BEFORE killTmuxWindow (display-message needs the window alive).
			// Best-effort — never blocks the window kill.
			await killCmuxLinkedSession(target.tmuxWindow).catch((e: Error) =>
				console.warn(`[close-tmux] cmux session close warn: ${e.message}`),
			);

			const result = await killTmuxWindow(target.tmuxWindow);

			store.insertEvent({
				event_id: `close-tmux-${executionId}-${Date.now()}`,
				execution_id: executionId,
				issue_id: session.issue_id,
				project_name: session.project_name,
				event_type: result.killed ? "tmux_closed" : "tmux_close_failed",
				source: "bridge.close-tmux",
				payload: {
					leadId: leadId ?? "unknown",
					tmuxWindow: target.tmuxWindow,
					error: result.error,
				},
			});

			res.json({ closed: result.killed, error: result.error });
		},
	);

	// FLY-102: Lead-driven Runner lifecycle — strict close with status guard +
	// audit event. Eligible states: CLOSE_ELIGIBLE_STATES (7 non-running
	// outcomes). Distinct from close-tmux (resource janitor, FLY-44 guard).
	app.post(
		"/api/sessions/:executionId/close-runner",
		tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
		fcMw("close_runner"),
		async (req, res) => {
			const executionId = req.params.executionId as string;
			const { leadId, reason, executorType, done } = (req.body ?? {}) as {
				leadId?: string;
				reason?: string;
				executorType?: string;
				// FLY-638: done-mode — finalize a done-but-stuck runner
				// (running/awaiting_review/approved_to_ship → completed) then close.
				done?: boolean;
			};

			// FLY-102 Codex Round 1+2: leadId MUST be present — scope check is
			// mandatory, not optional. Token alone is insufficient authority.
			// Round 2: reject whitespace-only values (not just empty strings).
			const leadIdTrimmed =
				typeof leadId === "string" ? leadId.trim() : undefined;
			if (!leadIdTrimmed) {
				res.status(400).json({
					success: false,
					message: "leadId is required in request body",
				});
				return;
			}

			const session = store.getSession(executionId);
			if (!session) {
				res.status(404).json({ error: "Session not found" });
				return;
			}

			if (!projects) {
				res.status(500).json({
					success: false,
					message: "Lead scope check unavailable: projects not configured",
				});
				return;
			}

			try {
				if (!matchesLead(session, leadIdTrimmed, projects)) {
					res.status(403).json({
						success: false,
						message: `Session ${executionId} is outside lead "${leadIdTrimmed}" scope`,
					});
					return;
				}
			} catch (err) {
				console.warn(
					`[close-runner] matchesLead error for ${executionId}: ${(err as Error).message}`,
				);
				res.status(403).json({
					success: false,
					message: `Lead scope check failed: ${(err as Error).message}`,
				});
				return;
			}

			const result = await closeRunner(
				{
					executionId,
					issueId: session.issue_id,
					projectName: session.project_name,
					reason,
					leadId: leadIdTrimmed,
					executorType,
					// FLY-638: done-mode finalize. When `done`, a done-but-stuck
					// runner (running/awaiting_review/approved_to_ship) is moved to
					// `completed` via the FSM before close so the archive cascade
					// fires. transitionOpts is initialized later in this setup fn but
					// is captured by this request-time closure (always defined here).
					finalizeDone: !!done,
					runCloseAuthority: {
						mode: done || session.status === "completed" ? "done" : "abandon",
						principal: leadIdTrimmed,
					},
					transitionOpts,
					// FLY-369: central close→archive cascade (done-cleanup + no
					// other active runner). Archives via the Bridge-local sink.
					archive: {
						projects,
						globalBotToken: opts?.globalBotToken,
						discordOwnerUserId: config.discordOwnerUserId,
					},
				},
				store,
			);

			if (!result.closed && result.error?.startsWith("status_not_eligible:")) {
				res.status(409).json({
					success: false,
					message: `Cannot close runner: ${result.error}. Eligible states: ${Array.from(CLOSE_ELIGIBLE_STATES).join(", ")}. If the runner is DONE (ship succeeded / QA passed) but stuck in a parked/running state, retry with done=true to finalize it to completed first.`,
				});
				return;
			}

			// FLY-638: done-mode finalize failures (no FSM opts / FSM rejected the
			// running|awaiting_review|approved_to_ship → completed edge).
			if (!result.closed && result.error?.startsWith("finalize_done_")) {
				res.status(409).json({
					success: false,
					message: `Cannot finalize+close runner: ${result.error}.`,
				});
				return;
			}

			// FLY-116: surface preserve outcome so callers (Lead, Terminal MCP)
			// can distinguish intentional preserve (failed/blocked → tab kept
			// for inspection) from a hard close failure.
			res.json({
				success: result.closed || !!result.preserved,
				closed: result.closed,
				alreadyGone: result.alreadyGone ?? false,
				preserved: result.preserved ?? false,
				reason: result.reason,
				error: result.error,
			});
		},
	);

	// FLY-195: Lead remanage endpoints for stuck-runner episodes —
	// explicit disposition receipts (plan §3.4) + the restricted recovery
	// nudge (plan §3.5, allowlist + all-gates + audit). Deliberately NOT in
	// the FLY-175 reserved set (light actions); restart/kill/ship stay
	// founder-gated. Auth is applied per-route INSIDE the router so this
	// mount cannot leak tokenAuth onto unrelated /api/sessions/* layers.
	app.use(
		"/api/sessions",
		createStuckRemanageRouter({
			store,
			projects: projects ?? [],
			captureSessionFn: defaultCaptureSession,
			auth: tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
		}),
	);
	app.use(
		"/api/leads",
		createLeadDetectionAckRouter({
			store,
			projects: projects ?? [],
			auth: tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
		}),
	);

	// GEO-270: Scan for stale sessions (manual/cron trigger)
	// With notify=true, groups stale sessions by Lead and sends Discord summary
	app.post(
		"/api/patrol/scan-stale",
		tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
		async (req, res) => {
			const { thresholdHours, notify } = (req.body ?? {}) as {
				thresholdHours?: number;
				notify?: boolean;
			};
			const threshold = thresholdHours ?? 24;

			const stale = store.getStaleCompletedSessions(threshold);

			interface StaleEntry {
				execution_id: string;
				issue_id: string;
				issue_identifier?: string;
				issue_title?: string;
				project_name: string;
				status: string;
				last_activity_at?: string;
				hours_since_activity: number;
				tmux_alive: boolean;
				tmux_target?: string;
				session_role?: string;
			}

			const results: StaleEntry[] = [];

			for (const session of stale) {
				if (!session.project_name) continue;

				const hoursSince = session.last_activity_at
					? Math.round(
							(Date.now() -
								new Date(
									`${session.last_activity_at.replace(" ", "T")}Z`,
								).getTime()) /
								3_600_000,
						)
					: 0;

				const target = getTmuxTargetFromCommDb(
					session.execution_id,
					session.project_name,
				);

				let tmuxAlive = false;
				if (target) {
					tmuxAlive = await isTmuxWindowAlive(target.tmuxWindow);
				}

				results.push({
					execution_id: session.execution_id,
					issue_id: session.issue_id,
					issue_identifier: session.issue_identifier,
					issue_title: session.issue_title,
					project_name: session.project_name,
					status: session.status,
					last_activity_at: session.last_activity_at,
					hours_since_activity: hoursSince,
					tmux_alive: tmuxAlive,
					tmux_target: target?.tmuxWindow,
					session_role: session.session_role,
				});
			}

			const alive = results.filter((r) => r.tmux_alive);

			// ── Discord notification (notify=true) ──
			const notifications: Array<{
				leadId: string;
				chatChannel: string;
				sessionCount: number;
				sent: boolean;
				error?: string;
			}> = [];

			if (notify && alive.length > 0 && projects.length > 0) {
				// Group alive sessions by Lead
				const byLead = new Map<
					string,
					{
						lead: import("../ProjectConfig.js").LeadConfig;
						sessions: StaleEntry[];
					}
				>();

				for (const entry of alive) {
					try {
						const fullSession = store.getSession(entry.execution_id);
						if (!fullSession) continue;
						const labels = parseSessionLabels(fullSession);
						const { lead } = resolveLeadForIssue(
							projects,
							entry.project_name,
							labels,
						);
						const existing = byLead.get(lead.agentId);
						if (existing) {
							existing.sessions.push(entry);
						} else {
							byLead.set(lead.agentId, {
								lead,
								sessions: [entry],
							});
						}
					} catch {
						// Can't resolve Lead — skip notification for this session
					}
				}

				// FLY-47: Deliver stale notification via control channel — Lead relays to Annie
				for (const [leadId, group] of byLead) {
					const { lead, sessions: leadSessions } = group;

					// Build summary for Lead to relay to Annie
					const sessionList = leadSessions
						.map((s, i) => {
							const id = s.issue_identifier ?? s.execution_id;
							const title = s.issue_title ? ` — ${s.issue_title}` : "";
							// FLY-59: Show role label for non-main sessions
							const role =
								s.session_role && s.session_role !== "main"
									? ` [${s.session_role.toUpperCase()}]`
									: "";
							return `${i + 1}. **${id}**${title}${role} (${s.status}, ${s.hours_since_activity}h ago)`;
						})
						.join("\n");

					const eventId = `stale_patrol_${Date.now()}_${leadId}`;
					const payload: import("./hook-payload.js").HookPayload = {
						event_type: "stale_session_summary",
						execution_id: leadSessions[0]?.execution_id ?? "patrol",
						issue_id: "stale-patrol",
						project_name: leadSessions[0]?.project_name ?? "unknown",
						status: "stale_completed",
						summary: `${leadSessions.length} stale sessions with tmux still alive:\n${sessionList}`,
						notification_context:
							"Tell Annie about these stale sessions and ask her to check them.",
						session_role: leadSessions[0]?.session_role ?? "main",
					};

					const seq = store.appendLeadEvent(
						leadId,
						eventId,
						"stale_session_summary",
						JSON.stringify(payload),
					);

					const runtime = registry?.getForLead(leadId);
					if (registry && runtime) {
						const envelope: import("./lead-runtime.js").LeadEventEnvelope = {
							eventId,
							seq,
							event: payload,
							sessionKey: "stale-patrol",
							leadId,
							timestamp: new Date().toISOString(),
						};
						const result = await registry.dispatchLeadEvent(envelope);
						if (result.delivered) {
							store.markLeadEventDelivered(seq);
							notifications.push({
								leadId,
								chatChannel: lead.chatChannel,
								sessionCount: leadSessions.length,
								sent: true,
							});
						} else if (result.queued) {
							notifications.push({
								leadId,
								chatChannel: lead.chatChannel,
								sessionCount: leadSessions.length,
								sent: true,
							});
						} else {
							store.recordDeliveryFailure(
								seq,
								result.error ?? "deliver returned false",
							);
							notifications.push({
								leadId,
								chatChannel: lead.chatChannel,
								sessionCount: leadSessions.length,
								sent: false,
								error: result.error ?? "control channel delivery failed",
							});
						}
					} else {
						notifications.push({
							leadId,
							chatChannel: lead.chatChannel ?? "(none)",
							sessionCount: leadSessions.length,
							sent: false,
							error: "No runtime registered",
						});
					}
				}
			}

			res.json({
				threshold_hours: threshold,
				total: results.length,
				tmux_alive: alive.length,
				tmux_dead: results.length - alive.length,
				sessions: results,
				...(notify ? { notifications } : {}),
			});
		},
	);

	// FLY-163: /api/forum-tag route removed — Discord Forum concept gone.

	// CIPHER principle confirmation route
	if (cipherWriter) {
		app.post(
			"/api/cipher-principle",
			tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
			async (req, res) => {
				const { principleId, action } = req.body as {
					principleId?: string;
					action?: string;
				};
				if (
					!principleId ||
					!action ||
					!["activate", "retire"].includes(action)
				) {
					res
						.status(400)
						.json({ error: "missing principleId or invalid action" });
					return;
				}
				if (
					!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
						principleId,
					)
				) {
					res.status(400).json({ error: "invalid principleId format" });
					return;
				}
				try {
					const updated =
						action === "activate"
							? await cipherWriter.activatePrinciple(principleId)
							: await cipherWriter.retirePrinciple(principleId, "CEO retired");
					if (!updated) {
						res
							.status(404)
							.json({ error: "principle not found or not in expected state" });
						return;
					}
					// Principles are loaded into DecisionLayer HardRules once at process start
					// (setup.ts). A running worker reuses the same DecisionLayer for its entire
					// DAG batch. This change takes effect on the next process/DAG start.
					res.json({ ok: true, effective: "next_process_start" });
				} catch {
					res.status(500).json({ error: "principle action failed" });
				}
			},
		);
	}

	// FLY-1060 QA F1: discriminates caller-supplied label ids (pre-F1 contract,
	// forwarded verbatim) from label NAMES (the tool-schema contract, resolved
	// team-scoped). A real label name is never UUID-shaped.
	const UUID_SHAPED_LABEL_RE =
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

	// Linear API proxy — agent doesn't hold LINEAR_API_KEY directly (GEO-187)
	app.post(
		"/api/linear/create-issue",
		tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
		async (req, res) => {
			if (!config.linearApiKey) {
				res.status(501).json({ error: "LINEAR_API_KEY not configured" });
				return;
			}
			const { title, description, priority, labels, team, project } =
				req.body ?? {};
			// FLY-371: optional Flywheel projectName → resolve a Linear binding
			// (team / project / scope-label). Raw value validated inside the helper.
			const projectNameRaw = req.body?.projectName;
			if (!title || typeof title !== "string") {
				res.status(400).json({ error: "title is required" });
				return;
			}
			if (title.length > 500) {
				res.status(400).json({ error: "title must be 500 chars or less" });
				return;
			}
			if (description !== undefined && typeof description !== "string") {
				res.status(400).json({ error: "description must be a string" });
				return;
			}
			if (
				priority !== undefined &&
				(typeof priority !== "number" || priority < 0 || priority > 4)
			) {
				res.status(400).json({ error: "priority must be 0-4" });
				return;
			}
			if (
				labels !== undefined &&
				(!Array.isArray(labels) ||
					!labels.every((l: unknown) => typeof l === "string"))
			) {
				res.status(400).json({ error: "labels must be a string array" });
				return;
			}
			// GEO-298: team parameter — required for multi-team workspaces
			if (team !== undefined && typeof team !== "string") {
				res.status(400).json({
					error: 'team must be a string (team key, e.g. "FLY")',
				});
				return;
			}
			// GEO-298: project parameter — optional, associates issue with a project
			if (project !== undefined && typeof project !== "string") {
				res
					.status(400)
					.json({ error: "project must be a string (project name)" });
				return;
			}
			try {
				const { LinearClient } = await import("@linear/sdk");
				const client = new LinearClient({ apiKey: config.linearApiKey });

				// FLY-371: resolve the Flywheel projectName → Linear binding (team /
				// project / scope-label). Fail-loud (400/404) on a bad/unknown projectName;
				// absent ⇒ binding undefined = byte-compatible (explicit params as before).
				const binding = resolveProjectNameParam(projects, projectNameRaw);
				if (!binding.ok) {
					res.status(binding.status).json({ error: binding.error });
					return;
				}
				// team / project default from the binding; explicit body params win.
				const effectiveTeam = team ?? binding.binding?.team;
				const effectiveProject = project ?? binding.binding?.project;
				// binding-derived project must be team-scoped (Codex R2 HIGH-1);
				// explicit project= keeps the legacy name-only path.
				const projectFromBinding = !project && !!binding.binding?.project;

				// GEO-298: Team resolution — by key if specified, require if >1 team
				const allTeams = await client.teams();
				let targetTeam: (typeof allTeams.nodes)[number] | undefined;
				if (effectiveTeam) {
					targetTeam = allTeams.nodes.find(
						(t: { key: string }) => t.key === effectiveTeam,
					);
					if (!targetTeam) {
						res.status(404).json({
							error: `Linear team with key "${effectiveTeam}" not found. Available: ${allTeams.nodes.map((t: { key: string }) => t.key).join(", ")}`,
						});
						return;
					}
				} else if (allTeams.nodes.length === 1) {
					targetTeam = allTeams.nodes[0];
				} else {
					res.status(400).json({
						error: `Multiple teams found (${allTeams.nodes.map((t: { key: string }) => t.key).join(", ")}). "team" parameter is required.`,
					});
					return;
				}

				if (!targetTeam) {
					res.status(500).json({ error: "No Linear team found" });
					return;
				}

				// GEO-298 / FLY-371: Project resolution — optional, by name.
				let projectId: string | undefined;
				if (effectiveProject) {
					if (projectFromBinding) {
						// Team-scoped: a binding's (team, project) pair is authoritative, so
						// resolve the project WITHIN the effective team — a same-named project
						// on another team must not be picked (write-path safety).
						const matchedProjects = await client.projects({
							first: 2,
							filter: {
								name: { eq: effectiveProject },
								accessibleTeams: { some: { id: { eq: targetTeam.id } } },
							},
						});
						if (matchedProjects.nodes.length === 0) {
							res.status(404).json({
								error: `Linear project "${effectiveProject}" not found in team "${targetTeam.key}"`,
							});
							return;
						}
						if (matchedProjects.nodes.length > 1) {
							res.status(400).json({
								error: `Linear project "${effectiveProject}" is ambiguous in team "${targetTeam.key}" (multiple matches)`,
							});
							return;
						}
						projectId = matchedProjects.nodes[0]!.id;
					} else {
						// Explicit project= — legacy name-only resolution (unchanged).
						const matchedProjects = await client.projects({
							filter: { name: { eq: effectiveProject } },
						});
						const matched = matchedProjects.nodes[0];
						if (!matched) {
							res.status(404).json({
								error: `Linear project "${effectiveProject}" not found`,
							});
							return;
						}
						projectId = matched.id;
					}
				}

				// Label resolution (name → id), TEAM-SCOPED (FLY-371 Codex R1 HIGH-2).
				// FLY-1060 QA F1: caller `labels` are NAMES per the tool contract —
				// pre-F1 they were forwarded verbatim as Linear labelIds, so every
				// label-bearing create 502'd ("labelIds must be a UUID"). Each name
				// now resolves exactly like the scope label; UUID-shaped entries pass
				// through untouched (pre-F1 id-passing callers stay byte-compatible).
				const resolveTeamScopedLabel = async (
					name: string,
					kind: "Label" | "Scope label",
				): Promise<
					| { ok: true; id: string }
					| { ok: false; status: number; error: string }
				> => {
					const matches = await client.issueLabels({
						first: 2,
						filter: {
							name: { eq: name },
							team: { id: { eq: targetTeam.id } },
						},
					});
					if (matches.nodes.length === 0) {
						return {
							ok: false,
							status: 404,
							error: `${kind} "${name}" not found in team "${targetTeam.key}"`,
						};
					}
					if (matches.nodes.length > 1) {
						return {
							ok: false,
							status: 400,
							error: `${kind} "${name}" is ambiguous in team "${targetTeam.key}" (multiple matches)`,
						};
					}
					return { ok: true, id: matches.nodes[0]!.id };
				};

				let labelIds: string[] | undefined;
				if (Array.isArray(labels)) {
					labelIds = [];
					for (const label of labels as string[]) {
						if (UUID_SHAPED_LABEL_RE.test(label)) {
							if (!labelIds.includes(label)) labelIds.push(label);
							continue;
						}
						const resolved = await resolveTeamScopedLabel(label, "Label");
						if (!resolved.ok) {
							res.status(resolved.status).json({ error: resolved.error });
							return;
						}
						if (!labelIds.includes(resolved.id)) labelIds.push(resolved.id);
					}
				}
				const scopeLabelName = binding.binding?.label;
				if (scopeLabelName) {
					const resolved = await resolveTeamScopedLabel(
						scopeLabelName,
						"Scope label",
					);
					if (!resolved.ok) {
						res.status(resolved.status).json({ error: resolved.error });
						return;
					}
					const merged = labelIds ? [...labelIds] : [];
					if (!merged.includes(resolved.id)) merged.push(resolved.id);
					labelIds = merged;
				}

				const issue = await client.createIssue({
					teamId: targetTeam.id,
					title,
					description: description ?? "",
					priority: priority ?? 0,
					labelIds,
					...(projectId && { projectId }),
				});

				const created = await issue.issue;
				res.json({
					ok: true,
					issue: {
						id: created?.id,
						identifier: created?.identifier,
						url: created?.url,
					},
				});
			} catch (err) {
				console.error(
					"[linear-proxy] create-issue failed:",
					(err as Error).message,
				);
				res.status(502).json({ error: "Linear API error" });
			}
		},
	);

	app.patch(
		"/api/linear/update-issue",
		tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
		async (req, res) => {
			if (!config.linearApiKey) {
				res.status(501).json({ error: "LINEAR_API_KEY not configured" });
				return;
			}
			const { issueId, title, description, priority, status } = req.body ?? {};
			if (!issueId || typeof issueId !== "string") {
				res.status(400).json({ error: "issueId is required" });
				return;
			}
			if (title !== undefined && typeof title !== "string") {
				res.status(400).json({ error: "title must be a string" });
				return;
			}
			if (description !== undefined && typeof description !== "string") {
				res.status(400).json({ error: "description must be a string" });
				return;
			}
			if (
				priority !== undefined &&
				(typeof priority !== "number" || priority < 0 || priority > 4)
			) {
				res.status(400).json({ error: "priority must be 0-4" });
				return;
			}
			try {
				const { LinearClient } = await import("@linear/sdk");
				const client = new LinearClient({ apiKey: config.linearApiKey });
				const update: Record<string, unknown> = {};
				if (title !== undefined) update.title = title;
				if (description !== undefined) update.description = description;
				if (priority !== undefined) update.priority = priority;
				if (status !== undefined) {
					// Resolve status name to workflow state ID
					const issue = await client.issue(issueId);
					const team = await issue.team;
					if (team) {
						const states = await team.states();
						const state = states.nodes.find(
							(s) => s.name.toLowerCase() === String(status).toLowerCase(),
						);
						if (state) {
							update.stateId = state.id;
						} else {
							const available = states.nodes.map((s) => s.name).join(", ");
							res.status(400).json({
								error: `Unknown status "${status}". Available: ${available}`,
							});
							return;
						}
					}
				}
				await client.updateIssue(issueId, update);
				res.json({ ok: true });
			} catch (err) {
				console.error(
					"[linear-proxy] update-issue failed:",
					(err as Error).message,
				);
				res.status(502).json({ error: "Linear API error" });
			}
		},
	);

	// Linear query proxy — list issues with filters (GEO-276, refactored GEO-294)
	app.get(
		"/api/linear/issues",
		tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
		async (req, res) => {
			if (!config.linearApiKey) {
				res.status(501).json({ error: "LINEAR_API_KEY not configured" });
				return;
			}

			// Normalize query params — Express may pass arrays for repeated keys
			const project = Array.isArray(req.query.project)
				? String(req.query.project[0])
				: (req.query.project as string | undefined);
			const stateParam = Array.isArray(req.query.state)
				? (req.query.state as string[]).join(",")
				: (req.query.state as string | undefined);
			const labelsParam = Array.isArray(req.query.labels)
				? (req.query.labels as string[]).join(",")
				: (req.query.labels as string | undefined);
			const limitRaw =
				req.query.limit !== undefined
					? parseInt(String(req.query.limit), 10)
					: 50;
			const limit = Number.isNaN(limitRaw)
				? 50
				: Math.min(Math.max(1, limitRaw), 250);

			const slim = req.query.slim === "true" || req.query.slim === "1";

			// FLY-371: resolve the Flywheel projectName → Linear binding and apply
			// project / label defaults (explicit query params win). Fail-loud on a
			// bad/unknown projectName; absent ⇒ byte-compatible.
			const bound = resolveProjectNameParam(projects, req.query.projectName);
			if (!bound.ok) {
				res.status(bound.status).json({ error: bound.error });
				return;
			}
			// Codex R2 LOW-3: drop blank label tokens (e.g. `?labels=` → [""]) BEFORE
			// merging, so an empty value does not suppress the binding's label default.
			const explicitLabels = labelsParam
				? labelsParam
						.split(",")
						.map((l) => l.trim())
						.filter(Boolean)
				: undefined;
			const scope = resolveLinearScope(bound.binding, {
				project: project ?? undefined,
				labels: explicitLabels,
			});

			try {
				const result = await queryLinearIssues(config.linearApiKey, {
					project: scope.project,
					states: stateParam
						? stateParam.split(",").map((s) => s.trim())
						: undefined,
					labels: scope.labels,
					limit,
					slim,
				});

				res.json({
					issues: result.issues,
					count: result.issues.length,
					truncated: result.truncated,
				});
			} catch (err) {
				console.error(
					"[linear-proxy] list-issues failed:",
					(err as Error).message,
				);
				res.status(502).json({ error: "Linear API error" });
			}
		},
	);

	// FLY-967 (contract: FLY-545 plan §5.3/P12, first-to-land builds): comment
	// proxy — the voice-bridge landing writes the meeting summary onto the
	// kickoff issue. issueId accepts a UUID or an identifier ("FLY-123"): it is
	// resolved first so an unknown issue is an explicit 404, never an opaque
	// GraphQL error.
	app.post(
		"/api/linear/comment",
		tokenAuthMiddleware(config.apiToken),
		async (req, res) => {
			if (!config.linearApiKey) {
				res.status(501).json({ error: "LINEAR_API_KEY not configured" });
				return;
			}
			const { issueId, body } = req.body ?? {};
			if (!issueId || typeof issueId !== "string") {
				res.status(400).json({ error: "issueId is required" });
				return;
			}
			if (!body || typeof body !== "string" || body.trim().length === 0) {
				res.status(400).json({ error: "body is required" });
				return;
			}
			// FLY-967 Codex R1: this is a WRITE path — when the caller names a
			// project, the target issue must fall inside its binding (voice-bridge
			// clients always pass projectName; absent keeps the update-issue-style
			// unscoped behavior for existing internal callers).
			const boundComment = resolveProjectNameParam(
				projects,
				req.body?.projectName,
			);
			if (!boundComment.ok) {
				res.status(boundComment.status).json({ error: boundComment.error });
				return;
			}
			try {
				const { LinearClient } = await import("@linear/sdk");
				const client = new LinearClient({ apiKey: config.linearApiKey });
				// issue(id:) accepts UUID or identifier; the mapped lookup also
				// carries labels/project for the scope check.
				const issue = await lookupLinearIssueByIdentifier(
					config.linearApiKey,
					issueId,
				);
				if (!issue) {
					res.status(404).json({ error: `issue "${issueId}" not found` });
					return;
				}
				if (
					boundComment.binding &&
					!issueMatchesBinding(issue, boundComment.binding)
				) {
					res.status(403).json({
						error: `issue "${issue.identifier}" is outside the "${String(
							Array.isArray(req.body?.projectName)
								? req.body?.projectName[0]
								: req.body?.projectName,
						)}" project scope`,
					});
					return;
				}
				const payload = await client.createComment({
					issueId: issue.id,
					body,
				});
				const comment = await payload.comment;
				res.json({
					ok: true,
					comment: { id: comment?.id, url: comment?.url },
				});
			} catch (err) {
				console.error("[linear-proxy] comment failed:", (err as Error).message);
				res.status(502).json({ error: "Linear API error" });
			}
		},
	);

	// FLY-967 (contract: FLY-545 plan §5.3/P12): precise read-only issue lookup
	// for the voice assistant's lookup_issue tool. Identifier exact match is its
	// own FIRST branch (deterministic — 545 Codex R2 guardrail ②) and returns
	// regardless of scope: an explicit identifier is an explicit ask and this
	// path is read-only. Keyword falls back to a small best-match list with
	// stable updatedAt ordering, scoped by the projectName binding (FLY-371).
	app.get(
		"/api/linear/issue",
		tokenAuthMiddleware(config.apiToken),
		async (req, res) => {
			if (!config.linearApiKey) {
				res.status(501).json({ error: "LINEAR_API_KEY not configured" });
				return;
			}
			const queryRaw = Array.isArray(req.query.query)
				? String(req.query.query[0])
				: (req.query.query as string | undefined);
			if (
				!queryRaw ||
				typeof queryRaw !== "string" ||
				queryRaw.trim().length === 0
			) {
				res.status(400).json({ error: "query is required" });
				return;
			}
			const q = queryRaw.trim();
			const limitRaw =
				req.query.limit !== undefined
					? parseInt(String(req.query.limit), 10)
					: 5;
			const limit = Number.isNaN(limitRaw)
				? 5
				: Math.min(Math.max(1, limitRaw), 20);
			const bound = resolveProjectNameParam(projects, req.query.projectName);
			if (!bound.ok) {
				res.status(bound.status).json({ error: bound.error });
				return;
			}
			const scope = resolveLinearScope(bound.binding, {});
			try {
				if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(q)) {
					const exact = await lookupLinearIssueByIdentifier(
						config.linearApiKey,
						q,
					);
					// FLY-967 Codex R1: an exact hit OUTSIDE the caller's project
					// binding is treated as a miss (falls through to the scoped
					// keyword search) — an explicit identifier must not cross the
					// project boundary when a scope was named.
					if (
						exact &&
						(!bound.binding || issueMatchesBinding(exact, bound.binding))
					) {
						res.json({ matchType: "identifier", issue: exact });
						return;
					}
					// identifier-shaped but unknown/out-of-scope — fall through to the
					// keyword search; a full miss is a 404 below.
				}
				const result = await queryLinearIssues(config.linearApiKey, {
					titleContains: q,
					project: scope.project,
					labels: scope.labels,
					limit,
				});
				if (result.issues.length === 0) {
					res.status(404).json({ error: `no issue matched "${q}"` });
					return;
				}
				res.json({
					matchType: "keyword",
					issues: result.issues,
					count: result.issues.length,
					truncated: result.truncated,
				});
			} catch (err) {
				console.error(
					"[linear-proxy] issue-lookup failed:",
					(err as Error).message,
				);
				res.status(502).json({ error: "Linear API error" });
			}
		},
	);

	// FLY-1160 (plan §3.3 读口): read-only PAGED comments of one issue — the
	// voice landing reconciliation confirms which stage markers already landed
	// (assistant-summary <sessionId> / transcript chunk markers) after a
	// shutdown deadline or crash cut a landing mid-flight, instead of blind
	// re-posting. Scoped like the comment WRITE path: a named project binding
	// must contain the issue.
	app.get(
		"/api/linear/comments",
		tokenAuthMiddleware(config.apiToken),
		async (req, res) => {
			if (!config.linearApiKey) {
				res.status(501).json({ error: "LINEAR_API_KEY not configured" });
				return;
			}
			const issueIdRaw = Array.isArray(req.query.issueId)
				? String(req.query.issueId[0])
				: (req.query.issueId as string | undefined);
			if (!issueIdRaw || issueIdRaw.trim().length === 0) {
				res.status(400).json({ error: "issueId is required" });
				return;
			}
			const afterRaw = Array.isArray(req.query.after)
				? String(req.query.after[0])
				: (req.query.after as string | undefined);
			const limitRaw =
				req.query.limit !== undefined
					? parseInt(String(req.query.limit), 10)
					: 50;
			const limit = Number.isNaN(limitRaw)
				? 50
				: Math.min(Math.max(1, limitRaw), 100);
			const bound = resolveProjectNameParam(projects, req.query.projectName);
			if (!bound.ok) {
				res.status(bound.status).json({ error: bound.error });
				return;
			}
			try {
				const issue = await lookupLinearIssueByIdentifier(
					config.linearApiKey,
					issueIdRaw.trim(),
				);
				if (!issue) {
					res.status(404).json({ error: `issue "${issueIdRaw}" not found` });
					return;
				}
				if (bound.binding && !issueMatchesBinding(issue, bound.binding)) {
					res.status(403).json({
						error: `issue "${issue.identifier}" is outside the "${String(
							Array.isArray(req.query.projectName)
								? req.query.projectName[0]
								: req.query.projectName,
						)}" project scope`,
					});
					return;
				}
				const page = await listLinearIssueComments(
					config.linearApiKey,
					issue.id,
					{ after: afterRaw?.trim() || undefined, limit },
				);
				if (!page) {
					res.status(404).json({ error: `issue "${issueIdRaw}" not found` });
					return;
				}
				res.json({
					issueId: issue.identifier,
					state: issue.state,
					stateType: issue.stateType,
					comments: page.comments,
					hasNextPage: page.hasNextPage,
					endCursor: page.endCursor,
				});
			} catch (err) {
				console.error(
					"[linear-proxy] comments-list failed:",
					(err as Error).message,
				);
				res.status(502).json({ error: "Linear API error" });
			}
		},
	);

	// FLY-21: Combined triage data endpoint — issues + sessions + capacity in one call
	app.use(
		"/api/triage/data",
		tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
		createTriageDataRouter(
			store,
			projects,
			config.linearApiKey,
			startDispatcher,
		),
	);

	// FLY-27: Triage HTML template endpoint — serves static template for Simba
	const __dirname = dirname(fileURLToPath(import.meta.url));
	const templatePath = resolve(__dirname, "../../static/triage-template.html");
	app.use(
		"/api/triage/template",
		tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
		createTriageTemplateRouter(templatePath),
	);

	// Memory API (GEO-198/GEO-204) — conditional, only if memoryService initialized
	if (memoryService) {
		app.use(
			"/api/memory",
			tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
			createMemoryRouter(memoryService, projects),
		);
	}

	// FLY-1018: gemini-agent's request-shaped ship surface. Files a
	// ship_approval_request lead event (transactional outbox in StateStore);
	// creates NO approve_to_ship gate, writes NO CommDB, and carries no ship
	// authority — the verified approve_to_ship + verify-approval chain is
	// untouched. Tokenless deployments answer 503 inside the handler.
	app.post(
		"/api/ship-approval-request",
		tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
		createShipApprovalHandler({
			store,
			projects,
			registry: {
				getForLead: (agentId) => registry?.getForLead(agentId),
			},
			apiTokenConfigured: Boolean(config.apiToken),
		}),
	);

	// Discord guild ID endpoint (GEO-187) — agent can query to build Discord channel/thread links
	app.get(
		"/api/config/discord-guild-id",
		tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
		(_req, res) => {
			if (!config.discordGuildId) {
				res.status(404).json({ error: "DISCORD_GUILD_ID not configured" });
				return;
			}
			res.json({ guild_id: config.discordGuildId });
		},
	);

	// GEO-195: Bootstrap endpoint — crash recovery for Claude Lead sessions
	app.post(
		"/api/bootstrap/:leadId",
		tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
		async (req, res) => {
			const { leadId } = req.params;
			if (!leadId || typeof leadId !== "string") {
				res.status(400).json({ error: "leadId is required" });
				return;
			}
			if (!registry) {
				res.status(503).json({ error: "RuntimeRegistry not available" });
				return;
			}
			const runtime = registry.getForLead(leadId);
			if (!runtime) {
				res
					.status(404)
					.json({ error: `No runtime registered for lead "${leadId}"` });
				return;
			}
			try {
				const { generateBootstrap } = await import("./bootstrap-generator.js");
				const snapshot = await generateBootstrap(
					leadId,
					store,
					projects,
					memoryService,
					{ chatThreadsEnabled: config.chatThreadsEnabled },
				);
				await runtime.sendBootstrap(snapshot);
				res.json({
					delivered: true,
					summary: {
						activeSessions: snapshot.activeSessions.length,
						pendingDecisions: snapshot.pendingDecisions.length,
						recentFailures: snapshot.recentFailures.length,
						recentEvents: snapshot.recentEvents.length,
					},
				});
			} catch (err) {
				console.error(
					`[bootstrap] Failed for ${leadId}:`,
					(err as Error).message,
				);
				res.status(500).json({ error: "Bootstrap generation failed" });
			}
		},
	);

	const workflowRunCollector = transitionOpts
		? createWorkflowRunCollector(store, transitionOpts)
		: undefined;
	// GEO-267: /api/runs — start new Runner executions
	if (startDispatcher) {
		// FLY-742: stale-blocker guard for the run-start 409 path. Own fsm/executor
		// (stateless config) since the shared transitionOpts is built later in
		// setup; teardown primitives are the same module-level fns crash-reaper
		// uses (equivalent to close_runner done=true).
		const staleGuardTransitionOpts: ApplyTransitionOpts = {
			store,
			fsm: new WorkflowFSM(WORKFLOW_TRANSITIONS),
			executor: new DirectiveExecutor(store),
			// FLY-907 (Codex R1 #1): this INDEPENDENT opts instance bypasses the
			// shared transitionOpts object — hook it too, or a stale-blocker
			// finalization (stale blocker → completed) never refreshes the display.
			onTransition: (executionId, targetStatus, ctx) => {
				const issueId = ctx.issueId ?? store.getSession(executionId)?.issue_id;
				if (issueId) opts?.issueDisplayRefresh?.current?.enqueue(issueId);
				opts?.terminalCommDbSync?.enqueue(
					executionId,
					targetStatus,
					ctx.projectName,
				);
			},
		};
		const staleBlockerGuard = createStaleBlockerGuard({
			reconcileGhost: opts?.residueHarvester
				? (blocker) => opts.residueHarvester!.reapTarget(blocker)
				: undefined,
			enabled: true,
			staleTtlMs: resolveCronStaleTtlMs(),
			now: () => Date.now(),
			projectRootFor: (name) =>
				projects.find((p) => p.projectName === name)?.projectRoot,
			checkPrState: (projectRoot, prNumber) =>
				checkPrStateViaGh(projectRoot, prNumber),
			finalizeBlocker: (blocker, prState) =>
				finalizeStaleBlocker(blocker, prState, {
					store,
					lookupTmuxTarget,
					// FLY-1185 §2.5: MCP reap piggybacks the injected cmux kill —
					// runs BEFORE it while the pane pid is still resolvable; the
					// guard's own kill sequence stays byte-unchanged.
					killCmuxLinkedSession: async (w) => {
						await reapRunnerMcp(w).catch(() => undefined);
						return killCmuxLinkedSession(w);
					},
					killTmuxWindow: (w) => killTmuxWindow(w),
					closeTerminalView: async (session, tmuxWindow) => {
						const identity = resolveTerminalViewIdentity(session, {
							tmuxWindow,
							sessionName: tmuxWindow.split(":")[0] ?? tmuxWindow,
						});
						if (!identity) return;
						await closeRunnerTerminalView({
							baseSessionName: identity.sessionName,
							projectName: identity.projectName,
							executionId: identity.executionId,
							windowId: identity.windowId,
							sessionRole: identity.sessionRole,
						});
					},
					finalizeCommDbSession: (execId, projectName) =>
						finalizeCommDbSession(execId, projectName),
					applyTransition: (execId, target, ctx, fields) => {
						const tr = applyTransition(
							staleGuardTransitionOpts,
							execId,
							target,
							ctx,
							fields,
						);
						return {
							ok: tr.ok,
							error: (tr as { error?: string }).error,
						};
					},
					archiveThread: (session) =>
						archiveIssueThreadIfNoOtherActive(
							store,
							session,
							{
								projects,
								globalBotToken: config.discordBotToken,
								discordOwnerUserId: config.discordOwnerUserId,
							},
							{ allowStatuses: ["completed"] },
						),
					sqliteNow: () => sqliteDatetime(),
					log: (m) => console.log(m),
				}),
			alertLead: (blocker, prState, idleHours) =>
				alertStaleBlockerToLead(blocker, prState, idleHours, {
					store,
					resolveLeadId: (b) => {
						if (!b.project_name) return undefined;
						try {
							const labels = parseSessionLabels(b);
							const { lead } = resolveLeadForIssue(
								projects,
								b.project_name,
								labels,
							);
							return lead.agentId;
						} catch {
							return undefined;
						}
					},
					deliver: async (leadId, envelope) => {
						const runtime = registry?.getForLead(leadId);
						if (!registry || !runtime)
							return { delivered: false, error: "no lead runtime" };
						return registry.dispatchLeadEvent(envelope);
					},
					isoNow: () => new Date().toISOString(),
					log: (m) => console.log(m),
				}),
			log: (m) => console.log(m),
		});
		const runsRouter = createRunsRouter(
			startDispatcher,
			store,
			projects,
			config.runnerAdmission,
			config.discordGuildId,
			config.chatThreadsEnabled,
			staleBlockerGuard,
			{
				masterToken: config.apiToken,
				scopedToken: config.geminiAgentToken,
				authorizeRework: fcWiring?.authorizeWorkflowRework,
				collectWorkflowRun: workflowRunCollector,
			},
			flagStore ? () => storeSkillFrameworkModeControl(flagStore) : undefined,
		);
		if (config.apiToken) {
			app.use(
				"/api/runs",
				tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
				runsRouter,
			);
		} else {
			app.use("/api/runs", runsRouter);
		}
	}

	// GEO-288: /api/standup — daily standup trigger
	if (standupService && standupProjectName) {
		const standupRouter = createStandupRouter(
			standupService,
			standupProjectName,
		);
		if (config.apiToken) {
			app.use(
				"/api/standup",
				tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
				standupRouter,
			);
		} else {
			app.use("/api/standup", standupRouter);
		}
	}

	// GEO-294: /api/publish-html — generic HTML publishing (Vercel deploy)
	const publishHtmlRouter = createPublishHtmlRouter(opts?.vercelToken);
	if (config.apiToken) {
		app.use(
			"/api/publish-html",
			tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
			publishHtmlRouter,
		);
	} else {
		app.use("/api/publish-html", publishHtmlRouter);
	}

	// FLY-203: /api/reports — remote report pipeline (publish + deliver).
	// Auth ownership (Codex R2#4): the plugin layer owns auth. Unlike
	// publish-html, this surface posts as a bot and reads local files, so it
	// NEVER runs unauthenticated — no apiToken → always 503.
	const reportsBaseDir =
		process.env.FLYWHEEL_REPORTS_DIR ??
		resolve(homedir(), ".flywheel", "reports");
	const reportsRouter = createReportsRouter({
		vercelToken: opts?.vercelToken,
		// FLY-929 W3b ① + FLY-2104: resolve the sender for every delivery so a
		// founder-approved Infra identity change takes effect without a Bridge
		// restart. Incomplete P-identity still falls back to the legacy global bot.
		discordBotToken: undefined,
		resolveDiscordBotToken: () => infraSenderTokenOr(opts?.globalBotToken),
		projects,
		resolveIssueThread: (issueIdentifier, projectName) =>
			resolveProjectIssueThread(store, projects, issueIdentifier, projectName),
		registry: new ReportRegistry(reportsBaseDir, {
			// FLY-203 follow-up (founder): report links expire after 7 days.
			retentionMaxAgeMs: DEFAULT_RETENTION_MAX_AGE_MS,
		}),
	});
	app.use(
		"/api/reports",
		reportsAuthMiddleware(config.apiToken, config.ingestToken),
		reportsRouter,
	);

	// FLY-727: /api/digest — daily completion digest render endpoint.
	// EXPLICIT default-off (R3 #1): mounted ONLY when FLYWHEEL_DIGEST_CHANNEL is
	// set. There is NO silent fallback to FLYWHEEL_TOKEN_USAGE_CHANNEL — a prod
	// deployment that already has the cost channel must NOT auto-enable the digest
	// (byte-compat). The operator points FLYWHEEL_DIGEST_CHANNEL at the reused cost
	// channel (renamed "Flywheel Notification") id explicitly. Delivery is done by
	// scripts/daily-digest.sh via `flywheel-comm publish-report` — this route only
	// renders HTML (Bridge has no browser).
	if (process.env.FLYWHEEL_DIGEST_CHANNEL) {
		const digestSlug = process.env.LINEAR_WORKSPACE_SLUG;
		const digestService = new DigestService(store, {
			tz: process.env.FLYWHEEL_DIGEST_TZ ?? resolveFounderTimezone,
			linearBaseUrl: digestSlug
				? `https://linear.app/${digestSlug}/issue`
				: undefined,
		});
		const digestRouter = createDigestRouter(digestService);
		if (config.apiToken) {
			app.use(
				"/api/digest",
				tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
				digestRouter,
			);
		} else {
			app.use("/api/digest", digestRouter);
		}
		console.log(
			`[Bridge] Daily digest configured — channel=${process.env.FLYWHEEL_DIGEST_CHANNEL}`,
		);
	}

	// FLY-727: /api/deployments/report — the deployment_events ingestion surface
	// (each project's deploy hook reports a live deployment here → the digest's
	// primary source of truth). AUTH-REQUIRED (Codex R2#2): it forges the digest's
	// "shipped today" data and accepts remote (Vercel) webhooks, so it must NEVER
	// run unauthenticated — no apiToken → 503, mirroring /api/reports (NOT the
	// tokenless /api/runs fallback).
	if (config.apiToken) {
		app.use(
			"/api/deployments",
			tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
			createDeploymentsRouter(store),
		);
	} else {
		app.use("/api/deployments", (_req, res) => {
			res.status(503).json({
				error: "deployments API requires TEAMLEAD_API_TOKEN",
			});
		});
	}

	// FLY-1456: the retired /api/account-switch surface stays AUTH-REQUIRED.
	// Without TEAMLEAD_API_TOKEN it returns 503; authenticated callers receive
	// a stable 410 from the static retirement router.
	if (config.apiToken) {
		app.use(
			"/api/account-switch",
			tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
			createAccountSwitchRouter(),
		);
	} else {
		app.use("/api/account-switch", (_req, res) => {
			res.status(503).json({
				error: "account-switch API requires TEAMLEAD_API_TOKEN",
			});
		});
	}

	const flagScanRunHandler: express.RequestHandler = async (req, res, next) => {
		try {
			if (!loopbackSelfOrigin(req.headers.host)) {
				res.status(403).json({ error: "loopback host required" });
				return;
			}
			const runtime = opts?.flagScanRoute?.current;
			if (!runtime) {
				res.status(503).json({ error: "flag scan is not ready" });
				return;
			}
			const body = (req.body ?? {}) as Record<string, unknown>;
			if (
				Object.keys(body).some((key) => key !== "dryRun") ||
				(body.dryRun !== undefined && typeof body.dryRun !== "boolean")
			) {
				res.status(400).json({ error: "body must be {dryRun?: boolean}" });
				return;
			}
			const outcome = body.dryRun
				? await runtime.dryRun()
				: await runtime.runNow();
			res.status(outcome.status === "lost_race" ? 409 : 200).json(outcome);
		} catch (error) {
			next(error);
		}
	};
	if (config.apiToken) {
		app.post(
			"/api/flag-scan/run",
			tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
			flagScanRunHandler,
		);
	} else {
		app.post("/api/flag-scan/run", (_req, res) => {
			res.status(503).json({
				error: "flag scan API requires TEAMLEAD_API_TOKEN",
			});
		});
	}

	// FLY-871 R3/C9: POST /api/rescue — the Codex Infra Bot's entry to trigger an
	// infra self-heal rescue (lead kickstart OR runner close+resumed-successor).
	// AUTH-REQUIRED (503 without TEAMLEAD_API_TOKEN, this triggers destructive ops),
	// deliberately NOT under /actions. Reads the late-bound runtime holder (bound in
	// startBridge only when self-heal is on) → off ⇒ 409 needs_human (byte-compat).
	if (config.apiToken) {
		app.use(
			"/api/rescue",
			tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
			createRescueRouter({
				getRuntime: () => opts?.rescueRoute?.current,
			}),
		);
	} else {
		app.use("/api/rescue", (_req, res) => {
			res.status(503).json({
				error: "rescue API requires TEAMLEAD_API_TOKEN",
			});
		});
	}

	// Catch-all 404 (must be after all routes)
	app.use((_req, res) => {
		res.status(404).json({ error: "not found" });
	});

	// JSON error handler — returns JSON instead of Express default HTML with stack trace
	app.use(((
		err: Error & { status?: number; type?: string },
		_req,
		res,
		_next,
	) => {
		if (err.type === "entity.parse.failed") {
			res.status(400).json({ error: "invalid JSON" });
			return;
		}
		console.error("[bridge] Unhandled error:", err.message);
		res.status(err.status ?? 500).json({ error: "internal error" });
	}) as express.ErrorRequestHandler);

	return app;
}

export async function startBridge(
	config: BridgeConfig,
	projects: ProjectEntry[],
	opts?: {
		store?: StateStore;
		retryDispatcher?: IRetryDispatcher;
		startDispatcher?: IStartDispatcher;
		cipherWriter?: CipherWriter;
		memoryService?: MemoryService;
		registry?: RuntimeRegistry;
	},
): Promise<{
	app: express.Application;
	store: StateStore;
	close: () => Promise<void>;
	registry: RuntimeRegistry;
}> {
	// FLY-2102: the retired broker credentials must never leak into any child
	// process. Scrub them before validation or any other boot work so even a
	// failed Bridge start cannot leave them available to later process spawns.
	delete process.env.FW_CUSTOMER_RELEASE_TOKEN;
	delete process.env.FW_NPM_GAT_TOKEN;

	if (projects.length === 0) {
		throw new Error(
			"No projects configured — check FLYWHEEL_PROJECTS or project config",
		);
	}
	scrubManagedTmuxEnvironments(projects, {
		log: (line) => console.warn(line),
	});
	const bridgeBootTs = Date.now();
	let turnPointerAuditSeq = 0;
	const livenessTrackers = {
		liveness: new LivenessCheckTracker({
			cadenceMs: config.stuckCheckIntervalMs,
		}),
	};
	// Live registration truth for /health. These bits flip only after the
	// corresponding tracker has actually been handed to its runtime component.
	const livenessWiring = {
		liveness: false,
		externalDrift: true,
	};

	// FLY-1082 (Task 1.1): fail-loud kind-contract validation — every alert
	// kind must have an owner + an explicit ARC posture, or the Bridge REFUSES
	// to start (before any listen/timer). Deliberately no kill-switch: this is
	// a code-integrity check, not a behavior.
	validateKindContracts();

	// FLY-1082 (Task 2.4): dirty-exit marker — LATCH the previous generation's
	// marker BEFORE overwriting it (evidence before overwrite). A latched
	// `running` marker = the previous Bridge died without a clean shutdown;
	// the boot self-check ticket for it is emitted after the alert sink exists.
	const bridgeMarker = bridgeMarkerPath(process.env);
	const prevExitMarker = latchPreviousMarker(bridgeMarker);
	sweepStaleSyncOpMarkers({ env: process.env });
	try {
		writeRunningMarker(bridgeMarker, process.pid, bridgeBootTs);
	} catch (err) {
		console.warn(
			`[bridge-exit-marker] running-marker write failed (non-fatal): ${(err as Error).message}`,
		);
	}

	// FLY-1082: late-bound fleet holders — the sensors need the routed alert
	// sink (built late) while HeartbeatService/AutoRepairBot (built earlier)
	// need callbacks into them. Holders break the ordering cycle.
	const fleetSensorsHolder: { current: FleetSensors | null } = {
		current: null,
	};
	const leadReconcilePassHolder: {
		current: (() => Promise<void>) | null;
	} = { current: null };
	const runnerQuotaScanPassHolder: {
		current: (() => Promise<void>) | null;
	} = { current: null };
	const serverLossHolder: { current: ServerLossCoordinator | null } = {
		current: null,
	};
	const serverLossCheckState: {
		active: Promise<ServerLossCheckResult> | null;
		firstSuccessful: boolean;
	} = { active: null, firstSuccessful: false };
	const coordinatedServerLossCheck = (): Promise<ServerLossCheckResult> => {
		if (serverLossCheckState.active) return serverLossCheckState.active;
		const coordinator = serverLossHolder.current;
		if (!coordinator) {
			const values = new Set<string>();
			const empty = Object.assign(values, {
				claimed: values as ReadonlySet<string>,
				heldExecutionIds: values as ReadonlySet<string>,
			});
			return Promise.resolve(empty);
		}
		const active = coordinator
			.check()
			.then((result) => {
				serverLossCheckState.firstSuccessful = true;
				return result;
			})
			.finally(() => {
				if (serverLossCheckState.active === active) {
					serverLossCheckState.active = null;
				}
			});
		serverLossCheckState.active = active;
		return active;
	};
	const paneLossNotifyHolder: {
		current:
			| ((
					session: Session,
					classification: PaneLossNotificationClass,
					terminalStatus?: string,
			  ) => Promise<boolean>)
			| null;
	} = { current: null };
	const tuiWindowAlertHolder: {
		lost?: (evidence: RunnerTuiWindowLostEvidence) => void | Promise<void>;
		restored?: (executionId: string) => void | Promise<void>;
	} = {};
	const admissionCrossingBarrier = new AdmissionCrossingBarrier();

	const store = opts?.store ?? (await StateStore.create(config.dbPath));
	const flagStore = initializeFlagStore(store, process.env);
	// FLY-182/2103: construct the existing Discord-independent founder alert
	// path before project runtime setup, so ConfigLoader rejection cannot remain
	// a console-only boot failure.
	const metaAlertNotifier = new MetaAlertNotifier();
	void metaAlertNotifier.probeDesktopCapability().then((ok) => {
		console.log(
			`[Bridge] MetaAlertNotifier desktop notifications ${ok ? "available" : "UNAVAILABLE (file channel only — Bridge not in an Aqua GUI session?)"}`,
		);
	});
	const eventLoopAttribution = new EventLoopAttribution({
		diagnosticsDir: resolve(
			process.env.FLYWHEEL_LOOP_DIAGNOSTICS_DIR?.trim() ||
				join(
					process.env.FLYWHEEL_STATE_DIR?.trim() ||
						process.env.FLYWHEEL_HOME?.trim() ||
						join(homedir(), ".flywheel"),
					"diagnostics",
				),
		),
		profilerEnabled: () => storeLoopProfilerEnabled(flagStore),
	});
	await eventLoopAttribution.start();
	// FLY-1066 Layer 1: migrate each existing project CommDB at boot, then mirror
	// only StateStore-authoritative failed/blocked outcomes asynchronously. All
	// SQLite work lives behind the queue; transition hooks remain enqueue-only.
	const terminalCommDbSync = createTerminalCommDbSync({
		enabled: true,
		getAuthoritativeStatus: (executionId) =>
			store.getSession(executionId)?.status,
		resolveDbPath: resolveCommDbPath,
		openDb: (dbPath) => new CommDB(dbPath, false),
		warmProject: (projectName) => {
			const dbPath = resolveCommDbPath(projectName);
			if (!dbPath) return;
			const db = new CommDB(dbPath, false);
			db.close();
		},
		log: (message) => console.warn(message),
	});
	await terminalCommDbSync.warmProjects(
		projects.map((project) => project.projectName),
	);
	importWorkflowMenuSeeds(store);
	const retirement = retireLegacyWorkflowTemplates(store);
	console.warn(
		`[workflow-template] FLY-1693 retirement reconcile: unbound=${retirement.unbound} retired=${retirement.retired} blocked=${JSON.stringify(retirement.blocked)} errors=${JSON.stringify(retirement.errors)}`,
	);
	const menuBindings = reconcileMenuCategoryBindings(store, projects);
	console.warn(
		`[workflow-menu] binding reconcile: bound=${menuBindings.bound} existing=${menuBindings.existing} errors=${JSON.stringify(menuBindings.errors)}`,
	);
	const defaultDagBindings = reconcileDefaultDagCategoryBindings(
		store,
		projects,
	);
	console.warn(
		`[workflow-menu] FLY-1981 DAG-default reconcile: bound=${defaultDagBindings.bound} existing=${defaultDagBindings.existing} disabled=${defaultDagBindings.disabled} menuManaged=${defaultDagBindings.menuManaged} errors=${JSON.stringify(defaultDagBindings.errors)}`,
	);
	const strandedGeneralized = store.holdStrandedGeneralizedExecutions();
	if (strandedGeneralized.length > 0) {
		console.warn(
			`[workflow-template] generalized stranded executions held (no successor dispatch): ${strandedGeneralized.join(", ")}`,
		);
	}
	const workflowSourceAlertFallback: {
		current?: (payload: AlertPayload) => Promise<{ accepted: boolean }>;
	} = {};
	const workflowSourceProjector = startWorkflowSourceProjector({
		projects: () => loadProjects().map((project) => project.projectName),
		openCommDb: (project) => new CommDB(commDbPathForProject(project)),
		store,
		resolveAlertIdentity: ({ project, issueId, runId }) =>
			resolveWorkflowRunAlertIdentity({
				store,
				projects,
				defaultLeadAgentId: config.defaultLeadAgentId,
				projectName: project,
				issueId,
				runId,
				log: (message) =>
					console.warn(`[workflow-source-projector] ${message}`),
			}),
		alertFallback: async (payload) => {
			const fallback = workflowSourceAlertFallback.current;
			return fallback ? fallback(payload) : { accepted: false };
		},
		log: (message) => console.warn(message),
	});

	const shipRelevantDiffService = new ShipRelevantDiffService(store);
	const ensureShipRelevantDiff = async (session: Session): Promise<void> => {
		const head = session.pr_head_sha?.toLowerCase();
		if (!head || !/^[0-9a-f]{40}$/.test(head)) return;
		const project = projects.find(
			(candidate) => candidate.projectName === session.project_name,
		);
		if (
			!project ||
			!project.projectRepo ||
			!/^[^/]+\/[^/]+$/.test(project.projectRepo) ||
			!Number.isSafeInteger(session.pr_number) ||
			(session.pr_number ?? 0) <= 0
		) {
			store.deleteShipRelevantDiffSnapshot(session.execution_id, head);
			return;
		}
		await shipRelevantDiffService.ensure({
			executionId: session.execution_id,
			repo: project.projectRepo,
			prNumber: session.pr_number!,
			prHeadSha: head,
			api: async (path) => {
				const { stdout } = await execFileP("gh", ["api", path], {
					cwd: project.projectRoot,
					timeout: 15_000,
					maxBuffer: 5 * 1024 * 1024,
				});
				return JSON.parse(stdout) as unknown;
			},
		});
	};

	// FLY-1082 (Task 2.2): the fleet pressure-hold gates runner admission —
	// late-bind the probe now that the store exists. Fail-open inside tryAdmit.
	// runnerAdmission is optional on the config (scaffold/test bridges omit it).
	config.runnerAdmission?.setPressureHoldProbe(() => {
		const hold = store.getFleetPressureHold();
		return hold
			? `fleet pressure-hold active since ${hold.set_at} (by ${hold.set_by}, memory ${hold.watermark ?? "?"}) — lifts automatically once real memory pressure is proven healthy (free% recovered + swapout quiet)`
			: null;
	});
	config.runnerAdmission?.setAdmissionPauseProbe(() => {
		const pause = store.getAdmissionPause();
		return pause?.active
			? {
					detail: "operator deployment pause is active",
					retryAfterSeconds: pause.remainingSeconds,
				}
			: null;
	});

	// FLY-142 PR #186 amend (QA hybrid-swap, 2026-05-13): auto-deploy runtime
	// hooks from `scripts/hooks/` to `~/.flywheel/hooks/` on Bridge boot.
	// Without this, hot-redeploys of the FLY-142 sentinel short-circuit
	// landed in the source file but the runtime hook (read by Claude Code's
	// PostToolUse) stayed at the pre-FLY-142 version → CommDB-rollback
	// Runners still hit the wake bug. Synchronous (not fire-and-forget) so
	// the FIRST Runner spawn after this Bridge restart already sees the
	// fresh hook. Idempotent on checksum match; errors are logged but
	// non-fatal (Bridge still boots — the legacy hook continues to function
	// for everything except the FLY-142 sentinel check, which is the
	// degraded but safe state pre-PR-#186).
	try {
		const { syncFlywheelRuntime } = await import("./sync-flywheel-hooks.js");
		// FLY-142 PR #186 Bug #5 amend: also deploy CLI bin symlinks (e.g.,
		// `agent-team-transport` → `~/.flywheel/bin/agent-team-transport`)
		// so `claude-lead.sh` finds the CLI on PATH (the FATAL check added
		// in Round 1 was firing in prod because the CLI was only built into
		// the monorepo dist, never installed system-wide).
		const { hooks, bins } = await syncFlywheelRuntime();
		console.log(
			`[sync-hooks] synced=${hooks.synced.length} matched=${hooks.matched.length} missingSource=${hooks.missingSource.length} errors=${hooks.errors.length}`,
		);
		console.log(
			`[sync-bin] synced=${bins.synced.length} matched=${bins.matched.length} missingSource=${bins.missingSource.length} errors=${bins.errors.length}`,
		);
	} catch (err) {
		// Soft failure: log but don't abort Bridge startup. Operator can
		// rerun `/setup-flywheel-hooks` manually + manually symlink the CLI
		// as the legacy escape hatch.
		console.warn(
			`[sync-runtime] failed (Bridge will continue, legacy hook + manually-installed CLI still in place): ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// FLY-116: one-shot startup reaper for stale Terminal.app tabs left over
	// from prior runs (macOS Terminal session-restore, crashed Phase 2 watcher, etc).
	// Status-dominant — failed/blocked tabs preserved. Fire-and-forget.
	import("./terminal-tab-reaper.js")
		.then(({ reapTerminalTabs }) =>
			reapTerminalTabs(store).then((r) =>
				console.log(
					`[terminal-reaper] scanned=${r.scanned} closed=${r.closed} preserved=${r.preserved} errors=${r.errors.length}`,
				),
			),
		)
		.catch((e: Error) =>
			console.warn(`[terminal-reaper] failed: ${e.message}`),
		);

	let retryDispatcher = opts?.retryDispatcher;
	// FLY-907: unified issue-display refresh. The holder is threaded into every
	// trigger surface NOW (they read `.current` at fire time); the refresher
	// itself is built post-listen.
	const issueDisplayRefreshHolder: IssueDisplayRefreshHolder = {};
	const pendingIssueDisplayRefreshes = new Set<string>();
	const enqueueIssueDisplayRefresh = (issueId: string): void => {
		const refresher = issueDisplayRefreshHolder.current;
		if (refresher) {
			refresher.enqueue(issueId);
		} else if (chatThreadCreator) {
			// Startup status writes can precede the late-bound refresher. Preserve
			// the exact write trigger and drain it as soon as the renderer exists.
			pendingIssueDisplayRefreshes.add(issueId);
		}
	};
	// GEO-158: FSM instance + DirectiveExecutor for validated transitions
	const fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);
	const executor = new DirectiveExecutor(store);
	const transitionOpts: ApplyTransitionOpts = {
		store,
		fsm,
		executor,
		// FLY-907 (Step 4.1): every applyTransition status write (kill /
		// terminate / retry / reject / close-runner / crash-reaper / heartbeat
		// reconcile / marker reconcilers / completion routes / founder consent)
		// triggers ONE coalesced derive-from-state display refresh.
		onTransition: (executionId, targetStatus, ctx) => {
			const issueId = ctx.issueId ?? store.getSession(executionId)?.issue_id;
			if (issueId) enqueueIssueDisplayRefresh(issueId);
			terminalCommDbSync.enqueue(executionId, targetStatus, ctx.projectName);
		},
	};
	const workflowRunCollector = createWorkflowRunCollector(
		store,
		transitionOpts,
	);
	// FLY-247: fleet config snapshot provider (hot fleet-field overlay onto
	// the boot topology; structural change → restart-required, R3#4) + the
	// 30s evidence poller (single probe owner for Dashboard + fleet sensors, R6#5).
	const fleetConfigProvider = new ConfigSnapshotProvider(projects, {
		loadProjects: () => loadProjects(),
		envPinned: Boolean(process.env.FLYWHEEL_PROJECTS),
		logger: (msg) => console.log(msg),
	});
	const fleetLegacyBackendOf = (p: ProjectEntry) => defaultLegacyBackendOf(p);
	const fleetPoller = new FleetPoller({
		provider: fleetConfigProvider,
		legacyBackendOf: fleetLegacyBackendOf,
		deps: buildDefaultFleetProbeDeps(),
		logger: (msg) => console.log(msg),
		carrierEnv: process.env,
	});
	fleetPoller.start();
	console.log("[Bridge] FleetPoller started (30s evidence collection)");
	const leadRuntimeStateDir =
		process.env.FLYWHEEL_STATE_DIR?.trim() || join(homedir(), ".flywheel");
	const locateFleetLeadWindow = (projectName: string, leadId: string) =>
		locateConfiguredLeadWindow(projectName, leadId, {
			homeDir: homedir(),
			stateDir: leadRuntimeStateDir,
			readFile: (path) => ffReadFileSync(path, "utf8"),
		});
	// Default-off gate (R1#6): zero-config deployments keep a byte-identical
	// SSE payload — the fleet key only appears when ≥1 lead opts in. The gate
	// reads the CURRENT snapshot, so hot-adding config appears without a
	// Bridge restart (requirement ⑤).
	const fleetSupplier = (): FleetSnapshot | undefined => {
		if (!fleetConfigProvider.hasExplicitFleetConfig()) return undefined;
		return fleetPoller.snapshot() ?? undefined;
	};
	const broadcaster = new SseBroadcaster(
		store,
		config.stuckThresholdMinutes,
		fleetSupplier,
	);

	// FLY-247 inc2a: Fleet console (founder-admin surface). The console reads the
	// live hot-overlay topology + computes everything server-side (secret-free DTO). Env-pinned
	// (FLYWHEEL_PROJECTS) deployments can't run the engine (split-brain guard), so
	// the console is disabled there too.
	let fleetConsole: FleetConsole | undefined;
	let flagProjectNames = () => projects.map((project) => project.projectName);
	let flagProjectConfigPath = (projectName: string) => {
		const root = projects.find(
			(project) => project.projectName === projectName,
		)?.projectRoot;
		return root ? join(root, ".flywheel", "config.yaml") : undefined;
	};
	// Hoisted so close() can clear it (Codex R3 MEDIUM-1: a block-local timer +
	// an un-closed console keep recovering batches / hold the audit handle after
	// shutdown).
	let fleetReconcileTimer: ReturnType<typeof setInterval> | undefined;
	let flagScanSourceLoader: (() => Promise<FlagScanSourceSnapshot>) | undefined;
	let flagScanRepoRoot: string | undefined;
	if (!process.env.FLYWHEEL_PROJECTS) {
		try {
			const here = dirname(fileURLToPath(import.meta.url));
			const repoRoot =
				process.env.FLYWHEEL_REPO_ROOT?.trim() ||
				resolve(here, "..", "..", "..", "..");
			const managementProjectsPath = join(
				homedir(),
				".flywheel",
				"projects.json",
			);
			const fleetScriptPath = join(repoRoot, "scripts", "flywheel-fleet.sh");
			const commCliPath = join(
				repoRoot,
				"packages",
				"flywheel-comm",
				"dist",
				"index.js",
			);
			// FLY-709 P4: mtime-cached per-project configs (Codex R1 #6) — env
			// flags are always fresh from process.env; project-config flags/rows
			// refresh whenever the file stamp changes (runner-config CLI writes are
			// visible on the next snapshot, no Bridge restart).
			const ffConfigCache = new ProjectConfigCache();
			const managementProjectSource = new ManagementProjectSource({
				path: managementProjectsPath,
				readFile: (path) => ffReadFileSync(path, "utf-8"),
				parse: parseAndValidateProjects,
				warm: async () => undefined,
			});
			await managementProjectSource.initialize();
			let managementProjects = managementProjectSource.projects();
			try {
				await ffConfigCache.get(managementProjects);
			} catch (error) {
				console.warn(
					`[management] project config cache unavailable: ${(error as Error).message}`,
				);
			}
			flagProjectNames = () =>
				managementProjects.map((project) => project.projectName);
			flagProjectConfigPath = (projectName) => {
				const root = managementProjects.find(
					(project) => project.projectName === projectName,
				)?.projectRoot;
				return root ? join(root, ".flywheel", "config.yaml") : undefined;
			};
			let managementProjectsRevision = managementProjectSource.revision();
			const managementEnvPath = join(homedir(), ".flywheel", ".env");
			const managementEnvSource = () =>
				readEnvFileSource(managementEnvPath, (path) =>
					ffReadFileSync(path, "utf-8"),
				);
			const currentFlagViews = () => {
				const views = resolveAllFlags({
					env: process.env,
					envFile: managementEnvSource(),
				});
				return flagStore
					? enrichFlagViewsWithStore(
							views,
							flagStore,
							managementProjects.map((project) => project.projectName),
						)
					: views;
			};
			const managementLaunchAgentsDir = join(
				homedir(),
				"Library",
				"LaunchAgents",
			);
			const managementSections = new ManagementSectionRegistry();
			const refreshManagementSources = async () => {
				const projectsReadable = await managementProjectSource.refresh();
				managementProjects = managementProjectSource.projects();
				managementProjectsRevision = managementProjectSource.revision();
				try {
					await ffConfigCache.get(managementProjects);
				} catch (error) {
					console.warn(
						`[management] project config cache unavailable: ${(error as Error).message}`,
					);
				}
				return projectsReadable;
			};
			flagScanRepoRoot = repoRoot;
			flagScanSourceLoader = async () => {
				const projectSourcesReadable = await refreshManagementSources();
				if (!projectSourcesReadable) {
					console.warn(
						"[flag-scan] project roster refresh unavailable; project-scoped flags have no clock this round",
					);
				}
				const resolvedViews = currentFlagViews();
				const views = projectSourcesReadable
					? resolvedViews
					: resolvedViews.map((view) =>
							view.scope === "project"
								? { ...view, effectiveByProject: undefined }
								: view,
						);
				const viewByName = new Map(views.map((view) => [view.name, view]));
				if (
					viewByName.size !== FEATURE_FLAGS.length ||
					FEATURE_FLAGS.some((spec) => !viewByName.has(spec.name))
				) {
					throw new Error(
						"resolved feature-flag roster did not match registry",
					);
				}
				return {
					rows: FEATURE_FLAGS.map((spec) => ({
						spec,
						view: viewByName.get(spec.name)!,
					})),
					expectedProjectNames: managementProjects.map(
						(project) => project.projectName,
					),
				};
			};
			fleetConsole = new FleetConsole(
				defaultFleetConsoleOptions({
					fleetScriptPath,
					commCliPath,
					liveProjects: () => fleetConfigProvider.snapshot().projects,
					legacyBackendOf: (p) => fleetLegacyBackendOf(p),
					// Online dot from the live evidence poller (null/stale → unknown).
					fleetEvidence: () => fleetPoller.snapshot(),
					// FLY-709 P4: stat-and-reload-on-change before a snapshot build.
					refreshProjectConfigs: async () => {
						await refreshManagementSources();
					},
					managementSnapshotProviders: () => [
						managementProjectSource.healthProvider(),
						...createManagementSsotProviders({
							projects: () => managementProjects,
							projectsRevision: () => managementProjectsRevision,
							projectConfigs: () => ffConfigCache.current(),
							onlineByLead: () => {
								const online = new Map<
									string,
									"online" | "offline" | "degraded" | "unknown"
								>();
								for (const lead of fleetPoller.snapshot()?.leads ?? []) {
									online.set(
										lead.key,
										onlineFromPresentation(lead.presentation),
									);
								}
								return online;
							},
						}),
						createManagementDagProvider({
							reader: store,
							projectNames: () =>
								managementProjects.map((project) => project.projectName),
						}),
						createManagementRunnerProvider({
							projects: () => managementProjects,
							projectConfigs: () => ffConfigCache.current(),
						}),
						createManagementFlagProvider({
							views: currentFlagViews,
							revision: () => {
								const source = managementEnvSource();
								return source.status === "readable"
									? managementFlagRevision(source.content, process.env)
									: `env-unavailable:${managementFlagRevision("", process.env)}`;
							},
							projectNames: () =>
								managementProjects.map((project) => project.projectName),
						}),
						managementSections.snapshotProvider(),
						createManagementCronProvider({
							launchAgentsDir: managementLaunchAgentsDir,
							projects: () => managementProjects,
						}),
					],
					// FLY-709: resolved feature-flag views (env fresh + cached configs).
					featureFlags: currentFlagViews,
					// FLY-709 ② (b): per-project runner default model, derived from the
					// SAME cached configs (no extra config.yaml IO).
					projectRunnerDefaults: () =>
						buildProjectRunnerDefaults(
							fleetConfigProvider.snapshot().projects,
							ffConfigCache.current(),
						),
					// FLY-709 P4.4: cron (recurring-issue) model rows from the same map.
					cronModels: () =>
						buildCronModelViews(
							fleetConfigProvider.snapshot().projects,
							ffConfigCache.current(),
							(projectName) =>
								storeXiaohongshuLearningEnabled(flagStore, projectName),
							(error) =>
								console.error(
									`[management] cron model scoped flag read failed: ${error.message}`,
								),
						),
					logger: (msg) => console.log(msg),
				}),
			);
			const managementConsole = fleetConsole;
			const scanCurrentCrons = () =>
				scanManagementCrons({
					launchAgentsDir: managementLaunchAgentsDir,
					projects: managementProjects,
				});
			const cronAuthority = new ManagementCronWriter({
				launchAgentsDir: managementLaunchAgentsDir,
				uid: process.getuid?.() ?? 0,
				targets: () => scanCurrentCrons().targets,
			});
			const existingWriters = createExistingManagementWriters({
				projects: () => managementProjects,
				projectsRevision: () => managementProjectsRevision,
				projectConfigs: () => ffConfigCache.current(),
				readProjectConfig: (path) => ffReadFileSync(path, "utf-8"),
				applyLeadCanonical: (request) => {
					if (!managementConsole.createLaunching(request.batchId, request)) {
						return {
							status: "rejected",
							reason: "could not create Fleet engine journal",
						};
					}
					if (!managementConsole.spawnEngine(request.batchId, request)) {
						return {
							status: "rejected",
							reason: "Fleet engine spawn failed",
						};
					}
					return {
						status: "accepted",
						details: { batchId: request.batchId },
					};
				},
				envPath: managementEnvPath,
				readEnvFile: (path) => ffReadFileSync(path, "utf-8"),
				env: process.env,
				flagViews: currentFlagViews,
			});
			const managementCoordinator = new ManagementChangeCoordinator({
				registry: new ManagementWriterRegistry([
					existingWriters.lead,
					existingWriters.runner,
					existingWriters.flag,
					createManagementDagWriter({
						store,
						projectNames: () =>
							managementProjects.map((project) => project.projectName),
						actor: "founder-management-console",
					}),
					createManagementCronWriterAdapter({
						writer: cronAuthority,
						targets: () => scanCurrentCrons().targets,
					}),
					managementSections.writer(),
				]),
				tokens: managementConsole.tokens,
				audit: managementConsole.audit,
				journalDir: join(homedir(), ".flywheel", "fleet-txns"),
				snapshotRevision: () =>
					managementConsole.buildManagementSnapshot().snapshotRevision,
				reconcileAccepted: (writerId, details) => {
					if (writerId !== "existing-fleet-lead-v1") return null;
					const batchId =
						typeof details === "object" &&
						details !== null &&
						typeof (details as { batchId?: unknown }).batchId === "string"
							? ((details as { batchId: string }).batchId as string)
							: null;
					if (!batchId) {
						return {
							status: "partial",
							reason: "missing Fleet child batch id",
						};
					}
					const progress = managementConsole.progressFor(batchId);
					if (!progress || !progress.terminal) return null;
					if (progress.batchStatus === "applied") {
						return { status: "applied", details: { batchId } };
					}
					if (progress.batchStatus === "partially-applied") {
						return {
							status: "partial",
							reason: "Fleet child batch partially applied",
							details: { batchId },
						};
					}
					return {
						status: "rejected",
						reason: `Fleet child batch ended ${progress.batchStatus}`,
						details: { batchId },
					};
				},
			});
			managementConsole.setManagementCoordinator(managementCoordinator);
			void managementCoordinator.reconcileProgress();
			// R8 #2: on boot, reconcile any interrupted batch by engine liveness
			// (live → observe; dead → engine's own recover) + apply-result audit.
			fleetConsole.reconcileOnStartup();
			// Codex R2 MEDIUM-1/MEDIUM-2: reconciliation must NOT depend on an open
			// SSE client. A periodic tick (idempotent: live→observe, terminal→audit
			// no-op-if-present, dead→recover-once) recovers a stranded launching
			// (early child exit) and reconciles apply-result audit within ~30s,
			// without waiting for a Bridge restart or a console connection.
			const fc = fleetConsole;
			fleetReconcileTimer = setInterval(() => {
				try {
					fc.reconcileOnStartup();
				} catch (e) {
					console.warn(
						`[Bridge] fleet reconcile tick failed: ${(e as Error).message}`,
					);
				}
				void managementCoordinator.reconcileProgress().catch((error) => {
					console.warn(
						`[Bridge] management reconcile tick failed: ${error.message}`,
					);
				});
			}, 30_000);
			fleetReconcileTimer.unref?.();
			console.log(`[Bridge] Fleet console enabled (engine=${fleetScriptPath})`);
		} catch (err) {
			console.warn(
				`[Bridge] Fleet console init failed — falling back to dashboard: ${(err as Error).message}`,
			);
			fleetConsole = undefined;
		}
	}

	// GEO-195: Initialize RuntimeRegistry — per-lead runtime selection
	// GEO-267: Accept pre-created registry (from run-bridge.ts for DirectEventSink injection)
	const registry = opts?.registry ?? new RuntimeRegistry();
	for (const project of projects) {
		for (const lead of project.leads) {
			try {
				const runtime = await createLeadRuntime(
					lead,
					config,
					project.projectName,
				);
				registry.register(lead, runtime);
			} catch (err) {
				// No Discord fallback — if CommDB isn't ready, skip this lead
				console.warn(
					`[Bridge] Skipping runtime for "${lead.agentId}":`,
					(err as Error).message,
				);
			}
		}
	}
	if (registry.size > 0) {
		console.log(
			`[Bridge] RuntimeRegistry: ${registry.size} lead runtime(s) registered`,
		);
	}
	const testDeliverySecret = process.env.VITEST
		? { secretId: "vitest-delivery-secret", key: randomBytes(32) }
		: null;
	const deliverySecretProvider = testDeliverySecret
		? { getActive: () => testDeliverySecret }
		: new FileDeliverySecretProvider({ store });

	// FLY-1373: comm.db is now the one durable Lead-delivery authority. Start
	// every per-Lead consumer before mounting the app so the nudge route and all
	// producer seams are live together; mount-time start performs the first pull.
	// Keep the cutover assembly lazy: createLeadRuntime is also imported by
	// lightweight preflight callers, which must not load the entire inbox stack
	// (or its transport adapter) just to select a legacy runtime.
	const { LeadInboxRuntime } = await import("./lead-inbox-runtime.js");
	const qaStallLeadId = qaStallInboxLoopLead(process.env);
	if (process.env.FLYWHEEL_QA_STALL_INBOX_LOOP_LEAD && !qaStallLeadId) {
		console.warn(
			"[FLY-1393 QA] refusing inbox-loop stall injection unless the effective FLYWHEEL_COMM_ROOT/FLYWHEEL_COMM_DIR is inside the process temp root and outside ~/.flywheel",
		);
	}
	// FLY-1586 R2 HIGH-5 — the notifier is built much later in startBridge, so the
	// sink is late-bound the same way the event router already does it. Until it
	// is set the callback THROWS rather than silently succeeding: a no-op would
	// mark the alert accepted and lose it, which is the precise failure this alert
	// exists to prevent.
	const quarantineAlertSink: {
		current?: (input: {
			seq: number;
			leadId: string;
			projectName: string;
			reason: string;
		}) => Promise<void>;
	} = {};
	type ModelTransportStall = {
		projectName: string;
		leadId: string;
		error: string;
		at: string;
	};
	type ModelTransportRecovery = Omit<ModelTransportStall, "error">;
	type ModelTransportExhausted = ModelTransportStall & {
		deliveryIds: string[];
		attempt: number;
	};
	const pendingModelTransportStalls = new Map<string, ModelTransportStall>();
	const modelTransportAlertSink: {
		current?: {
			stall: (input: ModelTransportStall) => Promise<void>;
			recovered: (input: ModelTransportRecovery) => Promise<void>;
			exhausted: (input: ModelTransportExhausted) => Promise<void>;
		};
	} = {};
	type DiscordMailboxAlert = {
		projectName: string;
		leadId: string;
		deliveryIds: string[];
		at: string;
	};
	type DiscordMailboxUndeliverable = DiscordMailboxAlert & {
		reason: string;
		attempt: number;
	};
	type DiscordMailboxStall = DiscordMailboxAlert & {
		batchId: string;
		error: string;
	};
	const pendingDiscordMailboxStalls = new Map<string, DiscordMailboxStall>();
	const discordMailboxAlertSink: {
		current?: {
			undeliverable: (input: DiscordMailboxUndeliverable) => Promise<void>;
			stall: (input: DiscordMailboxStall) => Promise<void>;
		};
	} = {};
	const deadLetterAlertSink: {
		current?: (input: {
			eventId: string;
			leadId: string;
			projectName: string;
			recipient: string;
			sourceKind: "lead_unacked" | "runner_unroutable";
			deadCount: number;
			summary: string;
			replayAfterAmbiguousAttempt: boolean;
		}) => Promise<void>;
	} = {};
	const leadInboxRuntime = new LeadInboxRuntime({
		leadLeaseDbPath:
			process.env.FLYWHEEL_LEAD_LEASE_DB ??
			join(homedir(), ".flywheel", "lead-lease.db"),
		currentLeadRecipientsForProject: (projectName) =>
			loadProjects()
				.find((project) => project.projectName === projectName)
				?.leads.map(({ agentId }) => agentId) ?? [],
		onQuarantineAlert: async (input) => {
			const send = quarantineAlertSink.current;
			if (!send) throw new Error("quarantine alert sink not ready");
			await send(input);
		},
		onModelTransportStall: async (input) => {
			const key = `${input.projectName}\u001f${input.leadId}`;
			const send = modelTransportAlertSink.current?.stall;
			if (!send) {
				pendingModelTransportStalls.set(key, input);
				return;
			}
			await send(input);
		},
		onModelTransportRecovered: async (input) => {
			pendingModelTransportStalls.delete(
				`${input.projectName}\u001f${input.leadId}`,
			);
			await modelTransportAlertSink.current?.recovered(input);
		},
		onModelTransportExhausted: async (input) => {
			const send = modelTransportAlertSink.current?.exhausted;
			if (!send)
				throw new Error("terminal model transport alert sink not ready");
			await send(input);
		},
		onDiscordUndeliverable: async (input) => {
			const send = discordMailboxAlertSink.current?.undeliverable;
			if (!send) throw new Error("Discord mailbox alert sink not ready");
			await send(input);
		},
		onDiscordDeliveryStall: async (input) => {
			const key = `${input.projectName}\u001f${input.leadId}`;
			const send = discordMailboxAlertSink.current?.stall;
			if (!send) {
				pendingDiscordMailboxStalls.set(key, input);
				return;
			}
			await send(input);
		},
		onDeadLetterAlert: async (input) => {
			const send = deadLetterAlertSink.current;
			if (!send) throw new Error("dead-letter alert sink not ready");
			await send(input);
		},
		projects,
		store,
		registry,
		commDbPathForProject,
		chatThreadsEnabled: config.chatThreadsEnabled,
		secretProvider: deliverySecretProvider,
		...(qaStallLeadId
			? {
					afterTickStartedForLead: async (
						_projectName: string,
						leadId: string,
					) => {
						if (leadId !== qaStallLeadId) return;
						await new Promise<never>(() => undefined);
					},
				}
			: {}),
	});
	registry.setLeadEventEnqueuer((envelope, content) =>
		leadInboxRuntime.enqueueLeadEvent(envelope, content),
	);
	registry.setLeadInboxNudge((leadId, projectName) =>
		leadInboxRuntime.nudge(leadId, projectName),
	);
	leadInboxRuntime.start();
	workflowSourceAlertFallback.current = async (payload) => {
		const receipt = leadInboxRuntime.enqueueInfraAlert(payload.leadId, payload);
		return { accepted: receipt.queued };
	};
	const deliveryLoopWired = true;
	const heartbeatServiceRef: { current?: HeartbeatService } = {};
	const livenessHealthProvider: { current?: () => unknown } = {
		current: () =>
			buildLivenessManifest({
				bridgeStartedAtMs: bridgeBootTs,
				wiring: livenessWiring,
				trackers: livenessTrackers,
				deliveryLoopWired,
				loopStallMs: inboxLoopStallMs(process.env),
				loopTargets: leadInboxRuntime.healthTargets(),
				...(heartbeatServiceRef.current
					? {
							probeForensics:
								heartbeatServiceRef.current.probeForensicsSnapshot(),
						}
					: {}),
			}),
	};

	const leadEventDelivery = new LeadEventDeliveryCoordinator({
		store,
		runtimeForLead: (leadId) => registry.getRawForLead(leadId),
		secretProvider: deliverySecretProvider,
	});
	registry.setDeliveryInterceptor((runtime, envelope) =>
		leadEventDelivery.deliver(envelope, runtime),
	);

	// FLY-80: Periodic retry for leads not ready at startup (e.g., Lead starts after Bridge).
	// Checks every 30s until all leads are registered, then stops.
	const unregisteredLeads: Array<{ lead: LeadConfig; projectName: string }> =
		[];
	for (const project of projects) {
		for (const lead of project.leads) {
			if (!registry.getForLead(lead.agentId)) {
				unregisteredLeads.push({ lead, projectName: project.projectName });
			}
		}
	}
	let runtimeRetryTimer: ReturnType<typeof setInterval> | undefined;
	if (unregisteredLeads.length > 0) {
		console.log(
			`[Bridge] ${unregisteredLeads.length} lead(s) not ready at startup — will retry registration every 30s`,
		);
		runtimeRetryTimer = setInterval(async () => {
			for (let i = unregisteredLeads.length - 1; i >= 0; i--) {
				const entry = unregisteredLeads[i]!;
				const { lead, projectName } = entry;
				try {
					const runtime = await createLeadRuntime(lead, config, projectName);
					registry.register(lead, runtime);
					unregisteredLeads.splice(i, 1);
					console.log(
						`[Bridge] Late-registered runtime for "${lead.agentId}" (project: ${projectName})`,
					);
				} catch {
					// Still not ready — will retry next interval
				}
			}
			if (unregisteredLeads.length === 0) {
				console.log(
					"[Bridge] All lead runtimes registered — stopping retry timer",
				);
				clearInterval(runtimeRetryTimer!);
				runtimeRetryTimer = undefined;
			}
		}, 30_000);
	}

	// GEO-187 / FLY-163: EventFilter only — Forum tag updater + post creator removed.
	const eventFilter = new EventFilter();

	// GEO-288: Standup service (v2 — no scheduler, triggered by external cron)
	const standupChannel = process.env.STANDUP_CHANNEL;
	const standupSimbaMention =
		process.env.STANDUP_SIMBA_MENTION ?? "<@1487339075563290745>";

	// Resolve standup project name — single-project defaults, multi-project requires config
	const standupProjectName: string | undefined = (() => {
		const envName = process.env.STANDUP_PROJECT_NAME;
		if (envName) {
			const match = projects.find((p) => p.projectName === envName);
			if (!match) {
				console.warn(
					`[Bridge] STANDUP_PROJECT_NAME="${envName}" does not match any configured project. Standup disabled.`,
				);
				return undefined;
			}
			return match.projectName;
		}
		if (projects.length === 1) {
			return projects[0]!.projectName;
		}
		if (projects.length > 1) {
			console.warn(
				"[Bridge] Multi-project setup requires STANDUP_PROJECT_NAME. Standup disabled.",
			);
		}
		return undefined;
	})();

	// Resolve standup lead — scoped to standup project
	const standupProject = standupProjectName
		? projects.find((p) => p.projectName === standupProjectName)
		: undefined;
	const standupLeadId =
		process.env.STANDUP_LEAD_ID ??
		(() => {
			const leads = standupProject?.leads ?? projects.flatMap((p) => p.leads);
			// FLY-71: Standup is CoS responsibility. Ambiguity is not identity.
			const cos = leads.filter((l) => l.agentId.includes("cos"));
			if (cos.length === 1) return cos[0]!.agentId;
			console.error(
				`[Bridge] identity_standup_lead_ambiguous: expected exactly one CoS Lead, found ${cos.length}; standup disabled`,
			);
			return undefined;
		})();
	const standupLead = (standupProject?.leads ?? []).find(
		(l) => l.agentId === standupLeadId,
	);
	if (standupProjectName && standupLeadId && !standupLead) {
		console.error(
			`[Bridge] STANDUP_LEAD_ID="${standupLeadId}" not found in project "${standupProjectName}" leads. Standup will fail closed on delivery.`,
		);
	}
	// FLY-71: The sending bot must NOT be the standup lead (CoS/Simba), because
	// Discord bots don't receive their own MESSAGE_CREATE events — Simba needs
	// to see the standup message to trigger triage. Use a different lead's token.
	// FLY-929 W3b ③: when P-identity holds the sender becomes the Claude Infra
	// Bot — which is not a CoS lead, so the FLY-71 non-CoS constraint holds by
	// construction (Simba still receives the standup MESSAGE_CREATE). P-identity
	// dormant ⇒ the legacy fallback chain byte-for-byte.
	const standupSenderLead = (standupProject?.leads ?? []).find(
		(l) => l.agentId !== standupLeadId && l.botToken,
	);
	const standupBotToken = infraSenderTokenOr(
		standupSenderLead?.botToken ?? standupLead?.botToken,
	);

	// Parse stale threshold for standup (same env var as GEO-270 patrol)
	const standupStaleThresholdHours = (() => {
		const v = parseInt(process.env.TEAMLEAD_STALE_THRESHOLD_HOURS ?? "24", 10);
		return Number.isFinite(v) && v >= 1 ? v : 24;
	})();

	// LINEAR_WORKSPACE_SLUG: e.g. "geoforge3d" → constructs https://linear.app/geoforge3d/issue
	const linearWorkspaceSlug = process.env.LINEAR_WORKSPACE_SLUG;
	if (!linearWorkspaceSlug) {
		console.warn(
			"[Bridge] LINEAR_WORKSPACE_SLUG not set — standup issue links will be plain text",
		);
	}
	const linearIssueBaseUrl = linearWorkspaceSlug
		? `https://linear.app/${linearWorkspaceSlug}/issue`
		: undefined;

	let standupService: StandupService | undefined;
	if (standupProjectName && standupLead) {
		standupService = new StandupService(
			store,
			projects,
			standupBotToken,
			config.stuckThresholdMinutes,
			standupStaleThresholdHours,
			standupChannel,
			standupSimbaMention,
			linearIssueBaseUrl,
		);
		console.log(
			`[Bridge] Standup configured — project="${standupProjectName}", channel=${standupChannel ?? "(none)"}, lead=${standupLeadId}`,
		);
	}

	// GEO-294: Vercel token for HTML publishing
	const vercelToken = process.env.VERCEL_TOKEN;
	if (vercelToken) {
		console.log("[Bridge] HTML publishing configured (Vercel)");
	}

	// FLY-91 Round 3: Create shared ChatThreadCreator at Bridge level (before run infra).
	// Single instance shared by both DirectEventSink (via run-infra) and query router.
	const chatThreadCreator = config.chatThreadsEnabled
		? new ChatThreadCreator(store)
		: undefined;
	if (config.chatThreadsEnabled && !chatThreadCreator) {
		throw new Error(
			"[Bridge] chatThreadsEnabled=true but ChatThreadCreator failed to initialize",
		);
	}
	if (chatThreadCreator) {
		console.log("[Bridge] Shared ChatThreadCreator created");
	}

	// FLY-22/FLY-50: Create RunDispatcher internally when not injected via opts.
	// RunDispatcher implements both IStartDispatcher and IRetryDispatcher,
	// so a single instance serves both roles.
	// Track the internal dispatcher separately for cleanup — if a caller injects
	// retryDispatcher but not startDispatcher, they are different instances.
	const codexReviewHoldHolder: {
		current: CodexReviewHoldCoordinator | undefined;
	} = { current: undefined };
	const codexReviewIngestHolder: {
		current: CodexReviewIngest | undefined;
	} = {
		current: new CodexReviewIngest({
			store,
			logger: console,
		}),
	};
	const reviewAuthorizationAlertsHolder: {
		current: ReviewAuthorizationAlerts | undefined;
	} = { current: undefined };

	// FLY-1188 §7.1: late-bound review-request coordinator holder — read by the
	// /review-requests route (createBridgeApp). Built post-listen; until then
	// the route answers 503 (the runner CLI retries, fail-close on exhaustion).
	const reviewCoordinatorHolder: {
		current: ReviewRequestCoordinator | undefined;
	} = { current: undefined };

	const turnBeltReconcilerHolder: {
		current: TurnBeltReconciler | undefined;
	} = { current: undefined };
	const workflowReworkCoordinatorHolder: {
		current: WorkflowReworkCoordinator | undefined;
	} = { current: undefined };
	const workflowShipCarrierDeliveryHolder: {
		current: WorkflowShipCarrierDeliveryHandler | undefined;
	} = { current: undefined };

	// FLY-887 + FLY-1204: single shared ship-time finalizer for parked workflow
	// actors. Both the in-process run-infra path and external-merge reconciler
	// drive the same reclaim logic so a shipped workflow cannot leak actors.
	const finalizeWorkflowPhaseRoles = makeFinalizeWorkflowPhaseRoles(
		store,
		transitionOpts,
		(issueId) =>
			issueDisplayRefreshHolder.current?.refresh(issueId) ?? Promise.resolve(),
	);

	// ── FLY-1185: unified lifecycle-closeout infrastructure, built ONCE ──
	// repo mutation lock (§2.11) + issue mutex (R10#2) + per-project cleanup
	// policies (§2.10, built BEFORE any boot deleter runs) + the ship-entry
	// bundle threaded to all three finalization call sites (event-route ×2 via
	// createBridgeApp opts + the DirectEventSink below). Merge-enable by
	// contract (Annie 直令): zero new flags — every NEW deleter hangs off the
	// existing autoclean integration seam inside its module.
	const repoMutationLock = createRepoMutationLock();
	const materializedHeadAuthority =
		receiptBackedMaterializedHeadAuthority(store);
	const workflowDocsMaterializer = new WorkflowDocsMaterializer({
		store,
		git: new GitWorkflowDocsGit(),
		projects,
		withRepoLock: repoMutationLock.withRepoLock,
		log: (message) => console.warn(`[workflow-materializer] ${message}`),
	});
	workflowDocsMaterializer.start();
	const issueMutex = createIssueMutex();
	// Codex R2#3: EVERY closeRunner call (explicit close endpoint, reject/
	// defer/shelve actions, legacy reconcile finalize) serializes through the
	// same per-issue mutex as the unified executor — entry B folds in.
	registerLifecycleCloseGuard({
		withIssueMutex: issueMutex,
		resolveLockKeys: (guardStore, issueId) => {
			// R3#3: NEVER split-lock — even on ok:false the resolver returns the
			// FULL related key set (that is exactly the uuid-conflict scenario
			// where an alias could otherwise slip in under a different key).
			const res = resolveLifecycleRootKey(guardStore, issueId, []);
			return res.lockKeys.length > 0 ? res.lockKeys : [issueId];
		},
	});
	const cleanupPolicies = buildCleanupPolicies(projects);
	const resolveProjectRootByName = (name: string) =>
		projects.find((p) => p.projectName === name)?.projectRoot;
	const lifecycleWorktreeManager = new WorktreeManager({
		withRepoLock: repoMutationLock.withRepoLock,
	});
	const runProjectSweep = (projectName: string): void => {
		const project = projects.find((p) => p.projectName === projectName);
		if (!project) return;
		void sweepProjectLifecycle({
			store,
			worktreeManager: lifecycleWorktreeManager,
			project,
			policies: cleanupPolicies,
			withRepoLock: repoMutationLock.withRepoLock,
		}).catch((err) =>
			console.warn(
				`[lifecycle-sweep] ${projectName}: pass failed: ${(err as Error).message}`,
			),
		);
	};
	const lifecycleExecutorDeps = {
		store,
		transitionOpts,
		withIssueMutex: issueMutex,
		withRepoLock: repoMutationLock.withRepoLock,
		openPrDisposal: makeCanceledPrDisposal({
			store,
			resolveProjectRoot: resolveProjectRootByName,
			// Codex R1#12: fresh admin-marker read (same §2.1 seam as deletes).
			readGeneration: (_mainRepoPath: string, worktreePath: string) =>
				lifecycleWorktreeManager.readWorktreeGeneration(worktreePath),
		}),
	};
	const lifecycleCloseoutFn = async (
		input: {
			issueKey: string;
			projectName: string;
			disposition: "shipped" | "canceled" | "founder_parked";
			authority: "ship_complete" | "linear_reconcile" | "founder_park";
			extraAliases?: string[];
			budget?: { tryConsume: () => boolean; shouldStop?: () => boolean };
			freshAuthority?: () => Promise<"authorized" | "reopened" | "unknown">;
		},
		closeoutOpts?: { alreadyLocked?: boolean },
	) =>
		closeoutIssue(
			{
				...lifecycleExecutorDeps,
				extraAliases: input.extraAliases,
				budget: input.budget,
				freshAuthority: input.freshAuthority,
			},
			{
				issueKey: input.issueKey,
				projectName: input.projectName,
				disposition: input.disposition,
				authority: input.authority,
			},
			closeoutOpts,
		);
	const lifecycleInfra: LifecycleShipInfra = {
		forceShippedHusks: (input, stateStore, deps = {}) =>
			forceShippedHusks(input, stateStore, {
				...deps,
				forceEnabled: () => storeShippedHuskForceEnabled(flagStore),
			}),
		// Codex R2#8: ship pre-arbitration — an active park tombstone or a
		// canceled disposition (fresh Linear when available, persisted
		// observation as the durable floor) refuses the ENTIRE ship DAG
		// before its first mutation. Short mutex hold for a consistent read;
		// the closeout's in-mutex arbitration remains the second line.
		preArbitrate: async (
			issueId: string,
			projectName: string,
			alreadyLocked?: boolean,
		) => {
			const res = resolveLifecycleRootKey(store, issueId, []);
			// R3#9: uuid_conflict is fail-closed (ambiguous identity must never
			// authorize a destructive DAG); no_uuid_mapping = zero lifecycle
			// history → nothing to arbitrate, the closeout's in-mutex
			// arbitration remains the second line.
			if (!res.ok && res.reason === "uuid_conflict") {
				return { ok: false, reason: "root_uuid_conflict" } as const;
			}
			const rootKey = res.ok ? res.rootKey : issueId;
			const lockKeys = res.lockKeys.length > 0 ? res.lockKeys : [issueId];
			const checks = async () => {
				if (
					isUuidKey(rootKey) &&
					store.getActiveIssueDispositionIntent(rootKey)
				) {
					return { ok: false, reason: "founder_parked" } as const;
				}
				const obs = store.getLinearStateObservation(projectName, rootKey);
				if (obs?.lastStateType === "canceled") {
					return { ok: false, reason: "canceled_observation" } as const;
				}
				if (config.linearApiKey) {
					return arbitrateFreshLinearState({
						persistedStateType: obs?.lastStateType,
						readFreshStateType: async () => {
							const { LinearClient } = await import("@linear/sdk");
							const client = new LinearClient({
								apiKey: config.linearApiKey as string,
							});
							const issue = await client.issue(issueId);
							const state = await issue.state;
							return state?.type;
						},
					});
				}
				return { ok: true } as const;
			};
			// R4#3: the ship DAG may already hold the canonical mutex (the
			// keyed lock is not re-entrant).
			return alreadyLocked ? checks() : issueMutex(lockKeys, checks);
		},
		remoteBranchCleanup: makeShipRemoteBranchCleanup({
			store,
			resolveProjectRoot: resolveProjectRootByName,
			policies: cleanupPolicies,
		}),
		issueCloseout: async (input) => {
			// exact ship-complete proof = a trusted LOCAL terminal claim (§2.12
			// allowlist) — grants the durable closeout authority through the same
			// observation seam the D entry consults.
			try {
				const res = resolveLifecycleRootKey(
					store,
					input.issueId,
					input.issueIdentifier ? [input.issueIdentifier] : [],
				);
				if (res.ok) {
					store.claimLocalTerminalAuthority({
						project: input.projectName,
						issueUuid: res.rootKey,
						source: "ship_complete",
					});
				}
			} catch {
				/* authority claim is best-effort; the closeout below self-guards */
			}
			// Codex R1#3: return the report — post-ship consumes the outcome and
			// defers thread archive + Linear Done when the closeout is blocked.
			const report = await lifecycleCloseoutFn(
				{
					issueKey: input.issueId,
					projectName: input.projectName,
					disposition: "shipped",
					authority: "ship_complete",
				},
				// R4#3: the ship DAG already holds the canonical issue mutex.
				input.alreadyLocked ? { alreadyLocked: true } : undefined,
			);
			return landIssueCloseoutResultFromClosureReport(report);
		},
		postShipSweep: runProjectSweep,
		// R4#3 (plan.md:145): ONE canonical issue-mutex hold for the ENTIRE
		// ship DAG — arbitration, dedupe claim, teardown, closeout, archive,
		// Linear Done. A founder park serializes strictly before or after.
		withIssueLifecycleMutex: async <T>(
			issueId: string,
			fn: () => Promise<T>,
		): Promise<T> => {
			const res = resolveLifecycleRootKey(store, issueId, []);
			const lockKeys = res.lockKeys.length > 0 ? res.lockKeys : [issueId];
			return issueMutex(lockKeys, fn);
		},
	};

	// FLY-1066: one shared single-flight instance for boot, maintenance, and the
	// scope-free scheduled-run fast path. CommDB↔FSM reconciliation is permanently
	// enabled for face ①/② and never suppresses the other residue faces.
	const commDbFsmReconcileEnabled = true;
	const openResidueCommDb = <T>(
		projectName: string,
		read: (db: CommDB) => T,
	): T | undefined => {
		if (/[/\\]|\.\./.test(projectName)) {
			throw new Error(`unsafe configured project name: ${projectName}`);
		}
		const dbPath = resolveCommDbPath(projectName);
		if (!dbPath) return undefined;
		const db = CommDB.openReadonly(dbPath);
		try {
			return read(db);
		} finally {
			db.close();
		}
	};
	const residueGhostDeps: StateStoreGhostDeps = {
		store,
		transitionOpts,
		ghostMinAgeMs: 30 * 60_000,
		nowMs: () => Date.now(),
		lookupCommDbSession: (executionId, projectName) =>
			openResidueCommDb(projectName, (db) => db.getSession(executionId)),
		// Full passes override this with the immediately preceding prune's
		// short-lived evidence. Targeted/historical rows have no safe fallback.
		getProvenDeadTmuxTarget: () => undefined,
		probe: (tmuxSession) => probeTmuxWindowLiveness(tmuxSession),
		finalizeCommDbSession: (executionId, projectName) =>
			finalizeCommDbSession(executionId, projectName),
		lifecycleMutex: {
			withIssueMutex: (keys, fn) => issueMutex(keys, fn),
			resolveLockKeys: (issueId) => {
				const resolved = resolveLifecycleRootKey(store, issueId, []);
				return resolved.lockKeys.length > 0 ? resolved.lockKeys : [issueId];
			},
		},
		archiveThread: (session) =>
			archiveIssueThreadIfNoOtherActive(
				store,
				session,
				{
					projects,
					globalBotToken: config.discordBotToken,
					discordOwnerUserId: config.discordOwnerUserId,
				},
				{ allowStatuses: ["terminated"] },
			),
		log: (message) => console.warn(message),
	};
	const recordResidueFinalizeOutcome = (
		executionId: string,
		projectName: string,
		result: ReturnType<typeof finalizeCommDbSession>,
	) => {
		const session = store.getSession(executionId);
		store.recordCommDbFinalizeOutcome({
			executionId,
			issueId: session?.issue_id ?? executionId,
			projectName,
			ok: result.ok,
			error: result.error,
			audit: {
				retiredGateCount: result.retiredGateCount,
				retiredAskCount: result.retiredAskCount,
				source: "bridge.commdb-terminal-prune",
			},
		});
	};
	const pruneResidueCommDb = async (projectName: string) => {
		try {
			const pruned = await pruneDeadTerminalCommDbSessions(projectName, {
				includeCrashPreserve: true,
				onFinalizeOutcome: recordResidueFinalizeOutcome,
			});
			if (pruned.pruned > 0) {
				console.log(
					`[Bridge] CommDB terminal prune (${projectName}): scanned=${pruned.scanned} pruned=${pruned.pruned} kept=${pruned.kept}`,
				);
			}
			return pruned.provenDeadTargets;
		} catch (err) {
			console.error(
				`[Bridge] CommDB terminal prune (${projectName}) failed (non-fatal): ${(err as Error).message}`,
			);
			return [];
		}
	};
	const parkedGenerationEvidence = async (
		executionId: string,
	): Promise<"superseded" | "same_generation" | "unavailable"> => {
		const session = store.getSession(executionId);
		if (!session || !isAutoMigratableClaudeTmux(session.adapter_type)) {
			return "unavailable";
		}
		const generation = parsePaneLossGenerationParams(session.session_params);
		if (!generation) return "unavailable";
		const current = await probeTmuxServerStartTime(generation.socket_path);
		if (current.kind !== "found") return "unavailable";
		return current.startTime === generation.server_start_time
			? "same_generation"
			: "superseded";
	};
	const paneLossFence =
		(): import("./pane-loss-reconcile.js").PaneLossFaceOutcome => {
			if (!serverLossCheckState.firstSuccessful) return "skipped_first_check";
			if (serverLossCheckState.active) return "skipped_coordinator_in_flight";
			if (store.getServerLossEpisode()) return "skipped_episode";
			if (store.listActiveTmuxHolds().length > 0) return "skipped_hold";
			return "ran";
		};
	const residueHarvester = createResidueHarvester({
		projectNames: projects.map((project) => project.projectName),
		commDbFsmEnabled: commDbFsmReconcileEnabled,
		harvestCommDb: async (projectName) => {
			const result = await reconcileCommDbRunningAgainstFsm(
				projectName,
				(executionId) => store.getSession(executionId)?.status,
				{
					harvest: {
						orphanMinAgeMs: 24 * 3_600_000,
						nowMs: () => Date.now(),
					},
					onFinalizeOutcome: (executionId, project, outcome) => {
						const session = store.getSession(executionId);
						store.recordCommDbFinalizeOutcome({
							executionId,
							issueId: session?.issue_id ?? executionId,
							projectName: project,
							ok: outcome.ok,
							error: outcome.error,
							audit: {
								retiredGateCount: outcome.retiredGateCount,
								retiredAskCount: outcome.retiredAskCount,
								source: "bridge.commdb-fsm-reconcile",
							},
						});
					},
					finalizePaneLossResidue: (db, executionId, expectedTmuxWindow) =>
						db.finalizePaneLossResidue(executionId, expectedTmuxWindow),
					parkedGenerationEvidence,
				},
			);
			if (result.reconciled > 0) {
				console.log(
					`[Bridge] FLY-1066 CommDB residue (${projectName}): scanned=${result.scanned} reconciled=${result.reconciled} orphan=${result.harvest?.orphanHarvested ?? 0} preserve=${result.harvest?.preserveHarvested ?? 0}`,
				);
			}
		},
		pruneTerminalCommDb: pruneResidueCommDb,
		harvestStateStoreGhosts: async (projectName, provenDeadTargets) => {
			const targetsByExecution = new Map(
				provenDeadTargets.map((item) => [item.executionId, item.tmuxWindow]),
			);
			const result = await reconcileStateStoreGhosts(projectName, {
				...residueGhostDeps,
				getProvenDeadTmuxTarget: (executionId) =>
					targetsByExecution.get(executionId),
			});
			if (result.reaped > 0) {
				console.log(
					`[Bridge] FLY-1066 StateStore ghosts (${projectName}): scanned=${result.scanned} reaped=${result.reaped}`,
				);
			}
		},
		harvestPaneLoss: async (projectName) => {
			const result = await reconcilePaneLoss(projectName, {
				store,
				transitionOpts,
				mutate: true,
				nowMs: () => Date.now(),
				preflight: async () => {
					const fenced = paneLossFence();
					if (fenced !== "ran") return fenced;
					return (await probeTmuxServer()) === "up" ? "ran" : "skipped_server";
				},
				fence: paneLossFence,
				lookupTarget: lookupTmuxTarget,
				probeRunner: probeRunnerProcessLiveness,
				discoverTarget: discoverTmuxTargetByExecutionId,
				probeServerGeneration: probeTmuxServerStartTime,
				isCompleteMarkerPending: (executionId) =>
					hasPendingCompleteMarker(executionId, defaultMarkerDir()),
				notify: (session, classification, terminalStatus) =>
					paneLossNotifyHolder.current?.(
						session,
						classification,
						terminalStatus,
					) ?? Promise.resolve(false),
				lifecycleMutex: residueGhostDeps.lifecycleMutex,
			});
			if (result.failed > 0 || result.advisories > 0) {
				console.warn(
					`[Bridge] FLY-1628 pane loss (${projectName}): scanned=${result.scanned} failed=${result.failed} advisories=${result.advisories}`,
				);
			}
			return result.face;
		},
		reapStateStoreGhost: async (session) =>
			(await reapStateStoreGhost(session, residueGhostDeps)) === "reaped",
		log: (message) => console.warn(message),
	});
	// FLY-1282 Part C: targeted terminal-archive enqueue buffer. It retains
	// pre-binding enqueues (bounded 64)
	// until the FLY-1165 scheduler binds as consumer further down.
	const terminalArchiveBuffer = createTerminalArchiveEnqueueBuffer();
	const terminalArchiveEnqueue = (issueId: string) =>
		terminalArchiveBuffer.enqueue(issueId);

	let startDispatcher = opts?.startDispatcher;
	let internalDispatcher: IRetryDispatcher | undefined;
	if (!startDispatcher) {
		try {
			const dispatcher = await setupRunInfrastructure(
				store,
				config,
				projects,
				registry,
				{
					flagStore,
					chatThreadCreator,
					onProjectConfigInvalid: async ({
						projectName,
						configPath,
						error,
					}) => {
						await metaAlertNotifier.notify({
							reason: "project_config_invalid",
							title: `Project config rejected (${projectName})`,
							body: `${configPath} was rejected: ${error.message}. The ${projectName} runtime was not initialized.`,
						});
					},
					withRepoLock: repoMutationLock.withRepoLock,
					// FLY-603: stateless cleanup closure (own instance here — the
					// /events one at the createEventRouter call site is a different
					// function scope; both wrap the same factory).
					removeCleanWorktree: makeBridgeWorktreeCleanup(
						store,
						projects,
						repoMutationLock.withRepoLock,
					),
					// FLY-1185 entry A bundle for the in-process (DES) ship path.
					lifecycleInfra,
					// FLY-1282 Part C: targeted terminal-archive enqueue for the
					// DirectEventSink completion path (undefined when switch OFF).
					terminalArchiveEnqueue,
					materializedHeadAuthority,
					// FLY-1185 (R11#1): park admission at the dispatcher chokepoint.
					lifecycleAdmission: (input) =>
						assertIssueNotLifecycleClosed(
							{ store, withIssueMutex: issueMutex },
							input,
						),
					// FLY-1718 P4: predecessor accounting runs before branch continuity.
					doaBackoffAdmission: createDoaBackoffAdmission({
						store,
						withIssueMutex: issueMutex,
					}),
					// FLY-1185 (Codex R1#5): dispatcher-side park-vs-start arbitration.
					lifecycleLaunchGuard: {
						// R4#1 (plan.md:145): commitLaunch is VERIFY-only — the claim
						// stays `starting` until the session row is durable; the
						// starting→active CAS moved to activateLaunch (emitStarted).
						// cancelled → abort; still starting or already active
						// (re-entrant retry / replay) → proceed; no claim (admission
						// not wired for this project) → proceed.
						// R3#6: both hooks run under the SAME per-issue mutex as the
						// executor and the apply snapshot guard — a launch step can
						// never slide between an apply's compare and its execution.
						commitLaunch: async (executionId: string) => {
							const claim = store.getLaunchClaim(executionId);
							if (!claim) return { ok: true }; // admission not wired
							const res = resolveLifecycleRootKey(store, claim.rootUuid, []);
							const keys =
								res.lockKeys.length > 0 ? res.lockKeys : [claim.rootUuid];
							return issueMutex(keys, async () => {
								const fresh = store.getLaunchClaim(executionId);
								const doaOwner = store.verifyAndRenewDoaReleaseOwner(
									executionId,
									Date.now(),
									DOA_RELEASE_LEASE_MS,
								);
								if (!doaOwner.ok) return doaOwner;
								if (
									!fresh ||
									fresh.state === "starting" ||
									fresh.state === "active"
								) {
									return { ok: true };
								}
								return { ok: false, reason: `claim_${fresh.state}` };
							});
						},
						// R4#1: ONE atomic CAS starting→active, executed by
						// DirectEventSink.emitStarted AFTER the session row is durable.
						// A park that cancelled the claim mid-spawn wins here — the
						// caller audits the refusal and the park-intent replay tears
						// the newborn runner down next maintenance tick.
						activateLaunch: async (executionId: string) => {
							const claim = store.getLaunchClaim(executionId);
							if (!claim) return { ok: true }; // admission not wired
							const res = resolveLifecycleRootKey(store, claim.rootUuid, []);
							const keys =
								res.lockKeys.length > 0 ? res.lockKeys : [claim.rootUuid];
							return issueMutex(keys, async () =>
								store.activateLaunchAndSettleDoa(executionId),
							);
						},
						onSpawnFailed: (executionId: string) => {
							store.closeLaunchAndReleaseDoa(executionId);
						},
					},
					codexReviewHold: codexReviewHoldHolder,
					reviewAuthorizationAlerts: reviewAuthorizationAlertsHolder,
					// FLY-793: the in-process completion path drives DAG workflow
					// Design→Implement→QA phase handoffs via this same holder.
					turnBeltReconciler: turnBeltReconcilerHolder,
					// FLY-887: ship-time finalizer for keep-alive parked phases
					// (FLY-1204: shared with the external-merge reconciler below).
					finalizeWorkflowPhaseRoles,
					// FLY-907: the in-process sink's display-refresh holder (its
					// upsertSession writes bypass the applyTransition hook).
					issueDisplayRefresh: issueDisplayRefreshHolder,
					terminalCommDbSync,
					admissionCrossingBarrier,
					onTuiWindowLost: (evidence) => tuiWindowAlertHolder.lost?.(evidence),
					onTuiWindowRestored: (executionId) =>
						tuiWindowAlertHolder.restored?.(executionId),
				},
			);
			startDispatcher = dispatcher;
			internalDispatcher = dispatcher;
			// FLY-50: Also wire as retryDispatcher when not externally provided
			if (!retryDispatcher) {
				retryDispatcher = dispatcher;
			}
			console.log("[Bridge] RunDispatcher created internally");
		} catch (err) {
			console.warn(
				"[Bridge] Failed to create RunDispatcher — /api/runs will be unavailable:",
				(err as Error).message,
			);
		}
	}
	// FLY-1385: constructed before the routed notifier, populated at the notifier
	// wiring point below. The workflow outbox stays pending during this short boot
	// window and is explicitly drained once the holder is live.
	const workflowEngineAlertHolder: {
		current?: { alert: (payload: AlertPayload) => Promise<AlertResult> };
	} = {};
	const landProjectRootFor = (projectName: string) =>
		projects.find((project) => project.projectName === projectName)
			?.projectRoot;
	const landMergeDriver = new GhCliLandMergeDriver(landProjectRootFor);
	const landHeadRefreshProver = new GitLandHeadRefreshProver(
		landProjectRootFor,
	);
	const recordCarryoverDepartureCutoff = (input: {
		operation: import("../StateStore.js").LandOperationRow;
		receiptId: string;
		ordinal: number;
		at: string;
	}) => {
		const operation = input.operation;
		if (!operation.run_id) {
			throw new Error("carryover departure requires an engine run");
		}
		const db = new CommDB(commDbPathForProject(operation.project_name));
		try {
			db.appendLandDepartureCutoff({
				project: operation.project_name,
				carryoverReceiptId: input.receiptId,
				operationId: operation.operation_id,
				ordinal: input.ordinal,
				runId: operation.run_id,
				approvedHead: operation.approved_head,
				operationGeneration: operation.generation,
				at: input.at,
			});
		} finally {
			db.close();
		}
	};
	const landLinearDoneFinalizer = makeLinearDoneFinalizer(config);
	const landWorktreeCleanup = makeBridgeWorktreeCleanup(
		store,
		projects,
		repoMutationLock.withRepoLock,
	);
	const landExecutor = async (operationId: string) =>
		executeLandOperation(operationId, {
			store,
			mergeDriver: landMergeDriver,
			headRefreshProver: landHeadRefreshProver,
			recordCarryoverDepartureCutoff,
			requestCleanup: (operation) =>
				requestLandCleanupOpportunities(operation, {
					store,
					commDbPathForProject,
					graceMs: (() => {
						const raw = Number.parseInt(
							process.env.FLYWHEEL_LAND_CLEANUP_GRACE_MS ?? "",
							10,
						);
						return Number.isFinite(raw) && raw >= 0 ? raw : 30_000;
					})(),
				}),
			finalize: async (operation) => {
				const session = resolveLandSourceSession(store, {
					runId: operation.run_id,
					issueId: operation.issue_id,
					projectName: operation.project_name,
					prNumber: operation.pr_number,
					approvedHead: operation.approved_head,
				});
				if (!session) {
					return {
						complete: false,
						outcome: "partial" as const,
						reason: landCloseoutReason("source_session_unavailable"),
					};
				}
				return runResumablePostShipFinalization(
					{
						executionId: session.execution_id,
						runId: operation.run_id ?? undefined,
						mergedPr: {
							prNumber: operation.pr_number,
							headSha: operation.approved_head,
						},
						issueId: operation.issue_id,
						issueIdentifier: session.issue_identifier,
						projectName: operation.project_name,
						sessionStatus: session.status,
						discordOwnerUserId: config.discordOwnerUserId,
						fallbackBotToken: config.discordBotToken,
						...(operation.owner_id
							? {
									landOperation: {
										operationId: operation.operation_id,
										ownerId: operation.owner_id,
										generation: operation.generation,
									},
								}
							: {}),
					},
					{
						store,
						projects,
						removeCleanWorktree: landWorktreeCleanup,
						markIssueDone: landLinearDoneFinalizer,
						recordLinearDoneDisposition: (disposition) => {
							if (!operation.owner_id) {
								return { ok: false, reason: "stale_land_generation" };
							}
							const alertIdentity = operation.run_id
								? resolveWorkflowRunAlertIdentity({
										store,
										projects,
										defaultLeadAgentId: config.defaultLeadAgentId,
										projectName: operation.project_name,
										issueId: operation.issue_id,
										runId: operation.run_id,
									})
								: undefined;
							return store.recordLandLinearDoneDisposition({
								operationId: operation.operation_id,
								ownerId: operation.owner_id,
								generation: operation.generation,
								disposition: disposition.disposition,
								reason: disposition.reason,
								executionId: session.execution_id,
								now: new Date().toISOString(),
								...(alertIdentity ? { alertIdentity } : {}),
							});
						},
						finalizeWorkflowPhaseRoles,
						refreshIssueDisplay: (issueId) =>
							issueDisplayRefreshHolder.current?.refresh(issueId) ??
							Promise.resolve(),
						...lifecycleInfra,
					},
				);
			},
			notify: async (operation, stage, detail) => {
				const terminalDisposition = landThreadNotificationPreflight(
					stage,
					null,
				);
				if (terminalDisposition) {
					return { disposition: terminalDisposition };
				}
				const session = store.getSessionByIssue(operation.issue_id);
				let lead: LeadConfig | undefined;
				try {
					lead = resolveLeadForIssue(
						projects,
						operation.project_name,
						session ? store.getSessionLabels(session.execution_id) : [],
					).lead;
				} catch (error) {
					throw new Error(
						`land_lead_resolution_failed:${error instanceof Error ? error.message : String(error)}`,
					);
				}
				if (
					operation.run_id &&
					[
						"conflict_rework_started",
						"external_outage_fyi",
						"external_outage_horizon_exceeded",
						"cool_fence_horizon_exceeded",
					].includes(stage)
				) {
					const identity = resolveWorkflowRunAlertIdentity({
						store,
						projects,
						defaultLeadAgentId: config.defaultLeadAgentId,
						projectName: operation.project_name,
						issueId: operation.issue_id,
						runId: operation.run_id,
					});
					const run = store.getWorkflowRun(operation.run_id);
					const severe = stage.endsWith("horizon_exceeded");
					const detailIdentity =
						typeof detail.escalationUid === "string"
							? detail.escalationUid
							: typeof detail.requestId === "string"
								? detail.requestId
								: operation.operation_id;
					const escalationUid = `land-transition:${stage}:${detailIdentity}`;
					store.enqueueWorkflowEngineAlert({
						escalationUid,
						runId: operation.run_id,
						payload: {
							leadId: identity.leadId,
							projectName: identity.projectName,
							eventId: escalationUid,
							eventType: severe
								? "workflow_engine_escalation"
								: "workflow_engine_issue_alert",
							severity: severe ? "severe" : "warning",
							sessionKey: `wf:${operation.run_id}`,
							title: `Land ${stage.replaceAll("_", " ")} for ${operation.issue_id}`,
							body: `PR #${operation.pr_number} entered ${stage}. ${JSON.stringify(detail)}`,
							metadata: {
								workflowEngine: {
									runId: operation.run_id,
									issueId: operation.issue_id,
									nodeId: run?.current_node_id ?? "land",
									executionId: `workflow-engine:land:${operation.operation_id}`,
									disposition: severe ? "held" : "partial",
									operationId: operation.operation_id,
									reason: stage,
									leadResolution: identity.leadResolution,
								},
							},
						},
					});
				}
				const thread = store.getChatThreadByIssue(
					operation.issue_id,
					lead.chatChannel,
				);
				const archivedDisposition = landThreadNotificationPreflight(
					stage,
					thread?.archived_at,
				);
				if (archivedDisposition) {
					return { disposition: archivedDisposition };
				}
				const result = await emitIssueThreadInfraNotification(
					{
						executionId: session?.execution_id ?? `land:${operation.issue_id}`,
						issueId: operation.issue_id,
						issueIdentifier: session?.issue_identifier,
						projectName: operation.project_name,
						kind: `land_${stage}`,
						content: renderLandThreadNotification(
							stage,
							operation.pr_number,
							detail,
						),
						thread,
						botToken: lead.botToken ?? config.discordBotToken,
						onUndeliverable: (reason) =>
							console.warn(
								`[land] thread notification ${stage} undeliverable: ${reason}`,
							),
					},
					{ store },
				);
				if (result.kind !== "posted") {
					throw new Error(
						`land_notification_${result.kind}${result.skipReason ? `_${result.skipReason}` : ""}`,
					);
				}
				return { disposition: "posted" as const };
			},
		});
	const workflowShipReadyArm = createWorkflowShipReadyArm({
		store,
		resolveLead: (notice) => {
			const source = store.getSession(notice.sourceExecutionId);
			const labels = source
				? store.getSessionLabels(notice.sourceExecutionId)
				: [];
			const { lead } = resolveLeadForIssue(
				projects,
				notice.projectName,
				labels,
			);
			return {
				leadId: lead.agentId,
				chatChannel: lead.chatChannel,
				botToken: lead.botToken ?? config.discordBotToken,
			};
		},
		enqueueLeadEvent: (envelope) => registry.enqueueLeadEvent(envelope),
		emitFounderThreadNotification: (options) =>
			emitFounderThreadNotification(options, { store }),
		ownerUserId: config.discordOwnerUserId,
		projectRootFor: (projectName) =>
			projects.find((project) => project.projectName === projectName)
				?.projectRoot,
		checkPrMerge: checkPrMergeViaGh,
		enrichPrHead: enrichPrHeadViaGh,
		log: (message) => console.warn(`[workflow-ship-ready] ${message}`),
	});
	const probeUnlaunchedExternalEvidence = async (
		executionId: string,
		projectName: string,
	): Promise<"absent" | "present" | "unknown"> => {
		let db: CommDB | undefined;
		try {
			const dbPath = defaultGetCommDbPath(projectName);
			if (!ffExistsSync(dbPath)) return "absent";
			db = CommDB.openReadonly(dbPath);
			const session = db.getSession(executionId) as
				| { tmux_window?: string }
				| undefined;
			const target = String(session?.tmux_window ?? "");
			return session && target && !target.endsWith(":pending")
				? "present"
				: "absent";
		} catch (error) {
			console.warn(
				`[workflow-engine] unlaunched evidence lookup failed for ${executionId}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return "unknown";
		} finally {
			db?.close();
		}
	};
	const workflowEngineDispatcher = startDispatcher
		? new WorkflowEngineDispatcher({
				store,
				startDispatcher,
				alertsEnabled: () => storeAlertSystemEnabled(flagStore),
				workflowReworkReentryEnabled: () =>
					storeWorkflowReworkReentryEnabled(flagStore),
				admissionProbe: () => config.runnerAdmission.tryAdmit(),
				env: process.env,
				resolveLeadId: (executionId) => {
					const session = store.getSession(executionId);
					if (!session?.project_name) return undefined;
					try {
						const labels = store.getSessionLabels(executionId);
						return resolveLeadForIssue(projects, session.project_name, labels)
							.lead.agentId;
					} catch (error) {
						console.warn(
							`[workflow-engine] resolveLeadId failed for ${executionId}: ${error instanceof Error ? error.message : String(error)}`,
						);
						return undefined;
					}
				},
				alertSink: workflowEngineAlertHolder,
				resolveRunAlertIdentity: (projectName, issueId, runId) =>
					resolveWorkflowRunAlertIdentity({
						store,
						projects,
						defaultLeadAgentId: config.defaultLeadAgentId,
						projectName,
						issueId,
						runId,
						log: (message) => console.warn(`[workflow-engine] ${message}`),
					}),
				log: (message) => console.warn(`[workflow-engine] ${message}`),
				materializedHeadAuthority,
				landExecutor,
				shipReadyArm: workflowShipReadyArm,
				reconcileWorkflowRework: (requestId) =>
					workflowReworkCoordinatorHolder.current?.reconcile(requestId) ??
					Promise.resolve({
						kind: "retryable" as const,
						reason: "rework_coordinator_unavailable",
					}),
				reconcileWorkflowCarrier: (questionId) =>
					workflowShipCarrierDeliveryHolder.current?.reconcile(questionId) ??
					Promise.resolve({
						kind: "retryable" as const,
						reason: "carrier_handler_unavailable",
					}),
				probeUnlaunchedExternalEvidence,
				cleanupUnlaunchedWorkflowWindow: (identity) =>
					cleanupExactWorkflowTmuxWindow(identity),
			})
		: undefined;
	workflowEngineDispatcher?.start();

	// FLY-516: shared shutdown flag — /health (in createBridgeApp) reads it,
	// close() (below) flips it at teardown start.
	const shutdownStateHolder: { shuttingDown: boolean } = {
		shuttingDown: false,
	};

	// FLY-623: shared reconnecting-set holder — the event router
	// (wired in createBridgeApp) read it, HeartbeatService (created post-listen)
	// fills it. Null until then / on the kill-switch path = no reconnect handling.
	const reconnectHolder: { current: ReconnectController | null } = {
		current: null,
	};

	// FLY-696 M1/④: late-bound Alerts-post for account_rotation events. The event
	// router (inside createBridgeApp) reads `.current` at request time; it is set
	// below once the unified-channel DiscordOps exists. Null until then / when no
	// unified channel = the event is acked but not posted (byte-compat).
	const accountRotationPostHolder: {
		current?: (
			detail: string,
			rotation?: AccountRotationNotice,
		) => Promise<void>;
	} = {};

	// FLY-871 R3/C9: the /api/rescue route reads this holder at request time; set
	// below only when the rescue runtime is built (self-heal on + unified Alerts
	// channel). Undefined ⇒ route returns 409 needs_human (byte-compat).
	const rescueRouteHolder: { current?: RescueRouteRuntime } = {};
	const alertDutyDispatcherBotUserId = { current: null as string | null };
	const alertDutyHubHolder: { current?: AlertChannelHub } = {};
	const flagScanRouteHolder: BridgeAppOptions["flagScanRoute"] = {};

	// FLY-1456: the external daemon is permanently authoritative. Keep the mode
	// object as one explicit truth table for every retired Bridge execution face.
	const claudeAccountPoolConfigured = accountPoolConfigured();
	const quotaBridgeMode = resolveQuotaDaemonBridgeMode();
	if (quotaBridgeMode.quarantinePending) {
		const quarantined = await quarantinePendingSwitches();
		if (quarantined) {
			console.warn(
				`[Bridge] FLY-1256 quarantined legacy account-switch pending store: ${quarantined}`,
			);
		}
	}

	const app = createBridgeApp(
		store,
		projects,
		config,
		broadcaster,
		transitionOpts,
		retryDispatcher,
		opts?.cipherWriter,
		eventFilter,
		undefined, // _unusedForumTagUpdater (FLY-163)
		registry,
		undefined, // _unusedForumPostCreator (FLY-163)
		opts?.memoryService,
		defaultCaptureSession,
		startDispatcher,
		standupService,
		standupProjectName,
		{
			vercelToken,
			flagStore,
			flagProjectNames,
			flagProjectConfigPath,
			eventLoopAttribution,
			admissionCrossingBarrier,
			residueHarvester,
			terminalCommDbSync,
			// FLY-1185: ship-entry bundle + shared repo lock for createBridgeApp's
			// /events router + Layer A closure.
			lifecycleInfra,
			// FLY-1282 Part C: targeted terminal-archive enqueue for the /events
			// completion sites (undefined when switch OFF).
			terminalArchiveEnqueue,
			withRepoLock: repoMutationLock.withRepoLock,
			materializedHeadAuthority,
			// FLY-1185 §2.12: park/unpark + approved-manifest apply endpoints.
			lifecycleRoutes: (() => {
				const routeDeps = {
					store,
					projects,
					policies: cleanupPolicies,
					worktreeManager: lifecycleWorktreeManager,
					withRepoLock: repoMutationLock.withRepoLock,
					// Codex R1#5: park executes tombstone + authority + closeout
					// under ONE issue-mutex hold; unpark supersedes mutex-held.
					parkFn: (input: {
						issueUuid: string;
						projectName: string;
						founderDecisionId: string;
					}) => parkIssue(lifecycleExecutorDeps, input),
					unparkFn: (input: { issueUuid: string; supersededBy: string }) =>
						unparkIssue({ store, withIssueMutex: issueMutex }, input),
					// Codex R2#6: recompute + compare + fresh-Linear + closeout under
					// ONE mutex hold. No Linear api key → issues[] are rejected
					// fail-closed (the git-object path is unaffected).
					applySnapshotCloseoutFn: (
						approved: import("./lifecycle-routes.js").IssueSnapshot,
						approvedJson: string,
						approvedHash: string,
						budget?: { tryConsume: () => boolean; shouldStop: () => boolean },
					) =>
						closeoutIssueWithSnapshotGuard(
							// R4#8: the route's per-request budget bounds every issue of
							// the apply batch (shared pool + deadline).
							{ ...lifecycleExecutorDeps, budget },
							{
								issueKey: approved.issueUuid,
								projectName: approved.project,
								disposition: approved.disposition,
								authority: "linear_reconcile",
							},
							{
								approvedHash,
								approvedJson,
								recompute: () => {
									const fresh = computeIssueSnapshot(store, {
										project: approved.project,
										issueUuid: approved.issueUuid,
									});
									return fresh ? JSON.stringify(fresh) : undefined;
								},
								freshLinear: config.linearApiKey
									? async () => {
											const { LinearClient } = await import("@linear/sdk");
											const client = new LinearClient({
												apiKey: config.linearApiKey as string,
											});
											const issue = await client.issue(approved.issueUuid);
											const state = await issue.state;
											return {
												stateType: state?.type ?? "",
												updatedAt:
													issue.updatedAt instanceof Date
														? issue.updatedAt.toISOString()
														: String(issue.updatedAt ?? ""),
											};
										}
									: undefined,
								approvedLinear: approved.linear,
							},
						),
					land: {
						enabled: () => true,
						createIntent: (input: {
							projectName: string;
							issueId: string;
							prNumber?: number;
							approvedHead?: string;
						}) => {
							const canonicalIssueId =
								store.getSessionByIdentifier(input.issueId)?.issue_id ??
								input.issueId;
							const existing = store.getLatestLandOperationForIssue(
								input.projectName,
								canonicalIssueId,
							);
							if (existing) {
								if (
									(input.prNumber !== undefined &&
										input.prNumber !== existing.pr_number) ||
									(input.approvedHead !== undefined &&
										input.approvedHead !== existing.approved_head)
								) {
									throw new Error("land_intent_assertion_mismatch");
								}
								return existing;
							}
							const run = store.getActiveWorkflowRun(
								input.projectName,
								canonicalIssueId,
							);
							if (run?.snapshot && run.engine_owned === 1) {
								const snapshot = parseWorkflowRunSnapshot(run.snapshot);
								if (!isWorkflowManifestLand(snapshot.manifest)) {
									throw new Error("land_manifest_not_enabled_for_run");
								}
								const holder = store.getCurrentWorkflowGateHolder(
									run.run_id,
									snapshot.manifest.approval_gate.node,
								);
								const exactHeadAuthority = holder
									? store.resolveWorkflowExactHeadAuthority({
											runId: run.run_id,
											headSha: holder.head_sha,
										})
									: undefined;
								const prBinding = exactHeadAuthority?.valid
									? exactHeadAuthority.binding
									: undefined;
								const prNumber = prBinding?.pr_number;
								if (!holder || holder.state !== "approved" || !prNumber) {
									throw new Error("land_founder_authority_not_ready");
								}
								if (prBinding.target_repo_identity !== "__main__") {
									throw new Error("nested_land_unsupported");
								}
								if (
									(input.prNumber !== undefined &&
										input.prNumber !== prNumber) ||
									(input.approvedHead !== undefined &&
										input.approvedHead.toLowerCase() !== holder.head_sha)
								) {
									throw new Error("land_intent_assertion_mismatch");
								}
								return store.ensureLandOperation({
									runId: run.run_id,
									issueId: canonicalIssueId,
									projectName: input.projectName,
									prNumber,
									approvedHead: holder.head_sha,
									now: new Date().toISOString(),
								});
							}

							const legacyEvidence = new Map<
								string,
								{ prNumber: number; approvedHead: string }
							>();
							for (const session of store.getSessionsByIssue(
								canonicalIssueId,
							)) {
								const head = session.pr_head_sha?.toLowerCase();
								if (
									session.project_name !== input.projectName ||
									!session.review_question_id ||
									!session.pr_number ||
									!/^[0-9a-f]{40}$/.test(head ?? "") ||
									(input.prNumber !== undefined &&
										input.prNumber !== session.pr_number) ||
									(input.approvedHead !== undefined &&
										input.approvedHead.toLowerCase() !== head)
								) {
									continue;
								}
								legacyEvidence.set(`${session.pr_number}:${head}`, {
									prNumber: session.pr_number,
									approvedHead: head!,
								});
							}
							if (legacyEvidence.size !== 1) {
								throw new Error(
									legacyEvidence.size === 0
										? "land_legacy_authority_not_ready"
										: "land_legacy_authority_ambiguous",
								);
							}
							const legacy = [...legacyEvidence.values()][0]!;
							return store.ensureLandOperation({
								issueId: canonicalIssueId,
								projectName: input.projectName,
								prNumber: legacy.prNumber,
								approvedHead: legacy.approvedHead,
								now: new Date().toISOString(),
							});
						},
						resume: (input: {
							operationId: string;
							actor: string;
							reason: string;
						}) =>
							resumeHeldLandOperation(input, {
								store,
								mergeDriver: landMergeDriver,
							}),
						kick: (operationId: string) => {
							void landExecutor(operationId).catch((error) =>
								console.warn(
									`[land] explicit intent ${operationId} failed to start: ${error instanceof Error ? error.message : String(error)}`,
								),
							);
						},
					},
					apiTokenConfigured: Boolean(config.apiToken),
				};
				return {
					parkRouter: createLifecycleRouter(routeDeps),
					applyRouter: createLifecycleApplyRouter(routeDeps),
				};
			})(),
			chatThreadCreator,
			globalBotToken: config.discordBotToken,
			fleetConsole,
			// FLY-516: /health reads this; close() flips it at teardown start.
			shutdownStateHolder,
			livenessHealthProvider,
			// FLY-623: event router reads this to clear reconnecting on a real event.
			reconnectHolder,
			codexReviewHold: codexReviewHoldHolder,
			codexReviewIngest: codexReviewIngestHolder,
			reviewAuthorizationAlerts: reviewAuthorizationAlertsHolder,
			// FLY-1188 §7.1: /review-requests route reads this holder.
			reviewCoordinator: reviewCoordinatorHolder,
			// FLY-793: event router reads this to drive DAG workflow handoffs.
			turnBeltReconciler: turnBeltReconcilerHolder,
			// FLY-696 M1/④: event router reads this to post account_rotation notices.
			accountRotationPost: accountRotationPostHolder,
			rescueRoute: rescueRouteHolder,
			alertDuty: {
				dispatcherBotUserId: alertDutyDispatcherBotUserId,
				alertHub: alertDutyHubHolder,
			},
			flagScanRoute: flagScanRouteHolder,
			// FLY-907: unified issue-display refresher (populated post-listen).
			issueDisplayRefresh: issueDisplayRefreshHolder,
		},
	);
	const reconcileDesignReviewManifestOutbox = (): void => {
		reconcileDesignReviewInstructions(store);
	};
	reconcileDesignReviewManifestOutbox();

	const server = app.listen(config.port, config.host);

	await new Promise<void>((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
	});

	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : config.port;
	console.log(`[Bridge] Listening on ${config.host}:${port}`);
	const alertSenderTokenEnv =
		process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV?.trim();
	const alertSenderToken = alertSenderTokenEnv
		? process.env[alertSenderTokenEnv]?.trim()
		: undefined;
	if (alertSenderToken) {
		try {
			alertDutyDispatcherBotUserId.current = (
				await resolveSelfIdentity(alertSenderToken)
			).id;
		} catch (error) {
			console.warn(
				`[alert-duty] dispatcher identity unresolved: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	} else if (config.alertDutyToken) {
		console.warn(
			"[alert-duty] dispatcher identity unresolved: alert sender token selector is unset or empty",
		);
	}
	const designReviewManifestTimer = setInterval(
		reconcileDesignReviewManifestOutbox,
		30_000,
	);
	designReviewManifestTimer.unref?.();

	// GEO-195: Use RegistryHeartbeatNotifier when registry has entries, else no-op
	const notifier: HeartbeatNotifier =
		registry.size > 0
			? new RegistryHeartbeatNotifier(
					registry,
					projects,
					store,
					eventFilter,
					config.chatThreadsEnabled,
					// FLY-623 Display-A: stamp/clear the "⚠️重连中" title only when the
					// issue-status-emoji feature is ON (same gate as the event-route
					// stamper); absent → re-adopt still works, just no title marker.
					chatThreadCreator,
					issueDisplayRefreshHolder,
				)
			: {
					onSessionOrphaned: async () => {},
					onSessionStale: async () => {},
					onSessionMonitoringLost: async () => {},
					onSessionMonitoringReestablished: async () => {},
					// FLY-1282: no registry → no Lead to route a zombie alert to.
					prepareSessionZombieDetected: () => null,
					persistPreparedZombieDetected: async () => false,
				};

	// GEO-270: Stale session patrol config (local variables, not in BridgeConfig)
	const staleThresholdHours = (() => {
		const v = parseInt(process.env.TEAMLEAD_STALE_THRESHOLD_HOURS ?? "24", 10);
		return Number.isFinite(v) && v >= 1 ? v : 24;
	})();
	const staleCheckIntervalMs = (() => {
		const v = parseInt(
			process.env.TEAMLEAD_STALE_CHECK_INTERVAL ?? "21600000",
			10,
		);
		return Number.isFinite(v) && v >= 1 ? v : 6 * 3_600_000;
	})();
	// FLY-1204: parked-phase reclaim TIME backstop (decision ② — the terminal
	// guard is the primary trigger; time is a conservative safety net). Single
	// env, separate from the generic 24h stale threshold. Default 24h.
	const parkedPhaseStaleHours = (() => {
		const v = parseInt(
			process.env.FLYWHEEL_PARKED_PHASE_STALE_HOURS ?? "24",
			10,
		);
		return Number.isFinite(v) && v >= 1 ? v : 24;
	})();
	// FLY-1204: late-bound orphan-parked alert sink (the routed alert sink +
	// leadAlertNotifier are constructed AFTER HeartbeatService — Implement Note 4).
	const orphanParkedAlertHolder: {
		current?: (issueId: string, sessions: Session[]) => Promise<void>;
	} = {};

	// FLY-172: loopback base URL for marker replay — must match the actual
	// listener (config.host may be 127.0.0.1 / localhost / ::1), so derive it
	// from config.host + the real listening port (IPv6 bracketed).
	const loopbackBaseUrl = buildLoopbackBaseUrl(config.host, port);

	// FLY-720: crash-reaper injected deps, permanently enabled. Grace defaults
	// to the orphan threshold (clean handoff with reapOrphans); a larger
	// `FLYWHEEL_CRASH_REAP_GRACE_MIN` is clamped to ≥ orphan threshold. Teardown +
	// archive reuse the same primitives as close_runner (killCmux/window, terminal
	// close, finalizeCommDbSession, the shared archive predicate w/ allowStatuses).
	const crashReaperGraceMinutes = (() => {
		const raw = Number.parseInt(
			process.env.FLYWHEEL_CRASH_REAP_GRACE_MIN ?? "",
			10,
		);
		const v =
			Number.isFinite(raw) && raw > 0 ? raw : config.orphanThresholdMinutes;
		return Math.max(v, config.orphanThresholdMinutes);
	})();
	const crashReaperConfig: CrashReaperInjectedDeps = {
		enabled: true,
		crashGraceMinutes: crashReaperGraceMinutes,
		// Codex R2#3 (entry C): each crash reap serializes with the unified
		// executor's per-issue mutex — never interleaved with a closeout.
		lifecycleMutex: {
			withIssueMutex: issueMutex,
			resolveLockKeys: (issueId: string) => {
				// R3#3: full related key set even on ok:false — never split-lock.
				const res = resolveLifecycleRootKey(store, issueId, []);
				return res.lockKeys.length > 0 ? res.lockKeys : [issueId];
			},
		},
		lookupTmuxTarget,
		probeLiveness: (w) => probeRunnerProcessLiveness(w),
		captureScrollback: (w) => captureRunnerScrollback(w),
		// FLY-1185 §2.5: MCP reap piggybacks the injected cmux kill (entry C —
		// crash reap). Reap-only, before the kill; the reaper's own teardown-
		// first sequencing (Codex code R1 HIGH) is byte-unchanged.
		killCmuxLinkedSession: async (w) => {
			await reapRunnerMcp(w).catch(() => undefined);
			return killCmuxLinkedSession(w);
		},
		killTmuxWindow: (w) => killTmuxWindow(w),
		closeTerminalView: async (session, tmuxWindow) => {
			const identity = resolveTerminalViewIdentity(session, {
				tmuxWindow,
				sessionName: tmuxWindow.split(":")[0] ?? tmuxWindow,
			});
			if (!identity) return;
			await closeRunnerTerminalView({
				baseSessionName: identity.sessionName,
				projectName: identity.projectName,
				executionId: identity.executionId,
				windowId: identity.windowId,
				sessionRole: identity.sessionRole,
			});
		},
		finalizeCommDbSession: (execId, projectName) =>
			finalizeCommDbSession(execId, projectName),
		archiveThread: (session) =>
			archiveIssueThreadIfNoOtherActive(
				store,
				session,
				{
					projects,
					globalBotToken: config.discordBotToken,
					discordOwnerUserId: config.discordOwnerUserId,
				},
				{ allowStatuses: ["terminated"] },
			),
	};

	// FLY-1374: complete-marker fail-close can persist via forceStatus when the
	// FSM rejects an un-replayable terminal marker. That bypasses the shared
	// applyTransition hook, so run both exact write-after effects here: converge
	// CommDB and enqueue the existing derive-from-state Discord render.
	const onMarkerTerminalStatusPersisted = (
		executionId: string,
		status: "failed" | "blocked",
		projectName: string,
	): void => {
		terminalCommDbSync.enqueue(executionId, status, projectName);
		const issueId = store.getSession(executionId)?.issue_id;
		if (issueId) enqueueIssueDisplayRefresh(issueId);
	};

	let paneLossInitialDebt = true;
	const heartbeatService = new HeartbeatService(
		store,
		notifier,
		config.stuckThresholdMinutes,
		config.stuckCheckIntervalMs,
		config.orphanThresholdMinutes,
		transitionOpts,
		staleThresholdHours,
		staleCheckIntervalMs,
		{
			bridgeBaseUrl: loopbackBaseUrl,
			ingestToken: config.ingestToken,
			materializedHeadAuthority,
			commDbPathForProject,
			onTerminalStatusPersisted: onMarkerTerminalStatusPersisted,
			alertMergeWithoutApproval: (session, reason) => {
				void reviewAuthorizationAlertsHolder.current?.alertMergeWithoutApproval(
					session,
					reason,
				);
			},
			alertShipAttemptFailed: (session, reason) => {
				const alerts = reviewAuthorizationAlertsHolder.current;
				return alerts
					? alerts.alertShipAttemptFailed(session, reason)
					: Promise.reject(new Error("ship-attempt alert sink unavailable"));
			},
			alertCompleteMarkerHeld: (args) => {
				const alerts = reviewAuthorizationAlertsHolder.current;
				return alerts
					? alerts.alertCompleteMarkerHeld(args)
					: Promise.reject(new Error("complete-marker alert sink unavailable"));
			},
		},
		48, // reviewTimeoutHours (constructor default; FLY-159/191 48h)
		undefined,
		crashReaperConfig,
		// FLY-867: stale-terminal close — checkStaleCompleted upgrades from
		// notify-only to notify+close for terminal-status sessions whose tmux is
		// still alive past staleThresholdHours (nothing else closes them: the
		// crash reaper only takes running, the auto-QA reconcile treats terminal
		// as already-clean). All teardown goes through the closeRunner chokepoint.
		// forcePreserved: this backstop has already passed the retest-protection
		// predicate and the 24h stale gate — a failed/blocked session whose tmux
		// lingers past that is a leak, not a crash-forensics scene, so the
		// CRASH_PRESERVE gate is deliberately bypassed here (Codex design R1 #1).
		// If this chokepoint is not wired, HeartbeatService stays notify-only.
		{
			closeStale: async (session) => {
				const result = await closeRunner(
					{
						executionId: session.execution_id,
						issueId: session.issue_id,
						projectName: session.project_name ?? "",
						reason: "fly867_stale_terminal",
						forcePreserved: true,
						archive: {
							projects,
							globalBotToken: config.discordBotToken,
							discordOwnerUserId: config.discordOwnerUserId,
						},
					},
					store,
				);
				return {
					closed: result.closed,
					alreadyGone: result.alreadyGone,
				};
			},
		},
		// FLY-1082 (Task 2.3): the server-loss coordinator pre-reaper phase —
		// holder-backed (the coordinator is built later, alongside the alert sink).
		{
			check: coordinatedServerLossCheck,
		},
		// FLY-1204: parked-phase reclaim chokepoint — the safety net that reclaims
		// leaked DAG workflow keep-alive phase sessions (design_done holders never
		// closed after handoff; completed QA processes never torn down → OOM).
		// closeParked goes through the SAME closeRunner teardown (finalizeDone, NO
		// thread archive — the shared parent thread is owned by post-ship
		// finalization). alertOrphan is late-bound (routed sink built later).
		{
			parkedStaleHours: parkedPhaseStaleHours,
			commDbPathForProject,
			closeParked: async (session, { noClaim }) => {
				const result = await closeRunner(
					{
						executionId: session.execution_id,
						issueId: session.issue_id,
						projectName: session.project_name ?? "",
						reason: noClaim
							? "fly1204_orphan_completed_reclaim"
							: "fly1204_shipped_parked_reclaim",
						executorType: "phase",
						finalizeDone: true,
						transitionOpts,
						// NO archive (Codex R1 BLOCKER-3): orphan reclaim only frees the
						// process; a shipped issue's thread teardown is post-ship's job.
					},
					store,
				);
				return { closed: result.closed, alreadyGone: result.alreadyGone };
			},
			alertOrphan: async (issueId, sessions) => {
				// Throw (do NOT silently no-op) when the late-bound sink is not yet
				// wired — otherwise alertOrphanParkedOnce would record its durable
				// dedupe for an alert that never went out and permanently silence it
				// (Codex R1 MEDIUM). In practice the sink is bound synchronously below
				// long before the first (6h-throttled) parked sweep; this guards the
				// window regardless.
				const sink = orphanParkedAlertHolder.current;
				if (!sink) {
					throw new Error(
						"fly1204 orphan-parked alert sink not yet bound (deferred to next sweep)",
					);
				}
				await sink(issueId, sessions);
			},
		},
		// FLY-1185 §2.5: detached maintenance tick — per-tick MCP orphan reap +
		// every-~6h-equivalent full-project sweep. Zero new timers (rides the
		// heartbeat interval); single-flight + detached inside HeartbeatService.
		// Tick 0 = the boot pass (orphan reap + first sweep).
		async (tick) => {
			// FLY-1066: ~hourly residue convergence rides this existing tick and is
			// deliberately independent of the worktree-autoclean kill-switch.
			if (residueHarvester) {
				const residueEveryNTicks = residueMaintenanceEveryNTicks(
					config.stuckCheckIntervalMs,
				);
				const scheduled = tick % residueEveryNTicks === 0;
				if (
					scheduled ||
					(paneLossInitialDebt && serverLossCheckState.firstSuccessful)
				) {
					const outcome = await (scheduled
						? residueHarvester.runFullPass()
						: residueHarvester.runPaneLossPass());
					if (
						outcome === "completed" &&
						residueHarvester.lastPaneLossOutcome() === "ran"
					) {
						paneLossInitialDebt = false;
					}
				}
			}
			// R3#1: TERM/KILL of orphan MCP processes is a NEW deletion — it
			// hangs off the same master switch as every other new mutator.
			if (!worktreeAutocleanEnabled()) return;
			// FLY-2169: socket-hosted Codex daemons have no parent tmux pane. If
			// Bridge or the adapter shell is killed, app-server is reparented to
			// launchd and can otherwise live forever. Ride this existing detached,
			// single-flight maintenance tick: no second scheduler. The reaper itself
			// requires a fresh argv + socket + CODEX_HOME proof before every signal.
			try {
				const activeExecutionIds = new Set(
					store
						.getReadoptCandidateSessions()
						.map((session) => session.execution_id),
				);
				await sweepCodexRunnerOrphans(
					{
						activeExecutionIds,
						isExecutionActive: (executionId) =>
							store
								.getReadoptCandidateSessions()
								.some((session) => session.execution_id === executionId),
					},
					{
						audit: (event, detail) => {
							console.warn(`[codex-orphan-reaper] ${event}`, detail);
							try {
								store.insertEvent({
									event_id: `codex-orphan-${event}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
									execution_id: String(
										detail.executionId ?? "codex-orphan-reaper",
									),
									issue_id: "maintenance",
									project_name: "bridge",
									event_type: event,
									source: "bridge.codex-runner-orphan-reaper",
									payload: detail,
								});
							} catch {
								/* audit only */
							}
						},
					},
				);
			} catch (error) {
				console.warn(
					`[codex-orphan-reaper] sweep failed (maintenance continues): ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			await reapMcpOrphans({
				audit: (event, detail) => {
					try {
						store.insertEvent({
							event_id: `mcp-orphan-${event}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
							execution_id: "mcp-orphan-reaper",
							issue_id: "maintenance",
							project_name: "bridge",
							event_type: event,
							source: "bridge.mcp-descendant-reaper",
							payload: detail,
						});
					} catch {
						/* audit only */
					}
				},
			});
			// FLY-1185 (Codex R1#2, E entry): replay PARTIAL park closeouts — a
			// founder-park whose closeout ended partial/needs_operator (crash,
			// blocked node) is re-driven from its durable intent until complete.
			// The tombstone itself only ever ends via explicit unpark.
			if (worktreeAutocleanEnabled()) {
				try {
					for (const intent of store.listReplayableDispositionIntents()) {
						await lifecycleCloseoutFn({
							issueKey: intent.issueUuid,
							projectName: intent.project,
							disposition: "founder_parked",
							authority: "founder_park",
						}).catch((err) =>
							console.warn(
								`[lifecycle] park replay failed for ${intent.issueUuid}: ${(err as Error).message}`,
							),
						);
					}
				} catch (err) {
					console.warn(
						`[lifecycle] park replay pass failed: ${(err as Error).message}`,
					);
				}
				// Stale `starting` launch claims (crashed dispatcher between
				// admission and launch, >60min old, no session row) → closed.
				try {
					for (const claim of store.listStaleStartingClaims(60)) {
						if (!store.getSession(claim.executionId)) {
							store.setLaunchClaimState(claim.executionId, "closed");
						}
					}
				} catch {
					/* best-effort */
				}
			}
			const sweepEveryNTicks = Math.max(
				1,
				Math.round((6 * 3_600_000) / Math.max(config.stuckCheckIntervalMs, 1)),
			);
			if (tick % sweepEveryNTicks === 0) {
				for (const project of projects) {
					runProjectSweep(project.projectName);
				}
			}
		},
		livenessTrackers.liveness,
		(name, startMs, endMs) =>
			eventLoopAttribution.recordSpan(name, startMs, endMs),
	);
	heartbeatServiceRef.current = heartbeatService;
	livenessWiring.liveness = true;

	// FLY-623 (Codex R2 MED-5): publish the live reconnecting set to the event
	// router via the late-bound holder, now that HeartbeatService
	// exists. Stays null on the kill-switch / no-registry path (byte-compat).
	reconnectHolder.current = heartbeatService;

	// FLY-892 (Step 5): one-shot boot sweep — reconcile the legacy FLY-793 per-phase
	// side-table threads (design/implement/qa) into the single converged issue
	// thread. Points each at the main thread + archives it (FAIL-CLOSED: never
	// archives an issue's only visible thread — see legacy-phase-thread-sweep.ts).
	// Event-driven (boot), no new periodic timer; best-effort — must not block boot.
	try {
		await reconcileLegacyPhaseThreads({
			store,
			projects,
			globalBotToken: config.discordBotToken,
		});
	} catch (err) {
		console.error(
			`[Bridge] FLY-892 legacy phase-thread sweep failed (non-fatal): ${(err as Error).message}`,
		);
	}

	// FLY-324: boot sweep — clear "done-but-running" zombies. A no-PR / no-code
	// / QA Runner that finished via `flywheel-comm stage set completed` only ever
	// emitted a stage_changed event, which never transitioned the FSM off
	// `running` (that flows through `session_completed`). Those sessions are
	// stuck: close_runner rejects them while tmux + worktree linger. The event-route
	// handler fixes this going
	// forward; this one-shot sweep unsticks the EXISTING backlog whose
	// stage_changed already fired before the fix shipped. This sweep runs before
	// the late-bound FLY-172 durable-alert drain; its pending-marker guard leaves
	// those sessions untouched so their real `complete --route` remains
	// authoritative. Status-only; no tmux/worktree
	// touch — teardown stays with exec-id-scoped close_runner / boot tab-reaper.
	// `FLYWHEEL_FLY324_SWEEP_EXCLUDE` (comma/space-separated execIds or issue
	// identifiers) lets the Lead skip *parked* Runners — ones that reported
	// stage=completed but are intentionally kept alive (e.g. a QA Runner holding
	// a live browser tab, waiting to re-engage) — before the cutover restart.
	// Best-effort: must not block Bridge startup.
	try {
		const sweepExclude = parseSweepExcludeEnv(
			process.env.FLYWHEEL_FLY324_SWEEP_EXCLUDE,
		);
		const sweep = reconcileDoneButRunning(store, transitionOpts, {
			exclude: sweepExclude,
			// FLY-1329 (A5): a runner that DECLARED itself parked is asserting it is
			// alive and waiting — the sweep must not force-complete it. This is the
			// signal the hand-maintained exclude list above was standing in for, and
			// it is why a park-alive runner surviving a restart no longer depends on
			// a human having remembered to name it. Reuses the existing readonly
			// declared-state probe (never a second reader of the same table).
			isParked: (execId, projectName) =>
				probeDeclaredStateFromCommDb(execId, projectName, Date.now()) ===
				"parked",
		});
		if (sweep.scanned > 0) {
			console.log(
				`[Bridge] FLY-324 boot sweep: scanned=${sweep.scanned} reconciled=${sweep.reconciled} rejected=${sweep.rejected} skipped=${sweep.skipped} excluded=${sweep.excluded} parkedVetoed=${sweep.parkedVetoed} done-but-running → completed`,
			);
		}
	} catch (err) {
		console.error(
			`[Bridge] FLY-324 boot sweep failed (non-fatal): ${(err as Error).message}`,
		);
	}

	// FLY-1448: populated once gate-retirement infrastructure is assembled below. The
	// done-thread scheduler starts with a delay, and a defensive absent holder
	// simply defers gate retirement to its next fresh-Linear pass.
	const terminalGateRetirementHolder: {
		current?: TerminalGateRetirement;
	} = {};

	// FLY-1165: done-thread reconcile — boot pass + periodic tick. The
	// structural backstop behind the FLY-369 close cascade: threads whose issue
	// is Done/Canceled in a FRESH per-issue Linear lookup AND provably owns no
	// live runner get archived through the shared sink. The boot chain never
	// awaits the sweep (async scheduler, 15s boot delay); config env vars are
	// re-read every tick, so FLYWHEEL_DONE_THREAD_RECONCILE toggles without a
	// restart. Teardown drains via doneThreadReconcile.stop() BEFORE
	// store.close() (an in-flight pass exits cooperatively between candidates).
	const doneThreadReconcile = startDoneThreadReconcileScheduler({
		runOnce: (shouldAbort) => {
			const reconcileCfg = resolveDoneThreadReconcileConfig();
			return reconcileDoneThreads({
				store,
				projects: projects ?? [],
				linearApiKey: config.linearApiKey,
				globalBotToken: config.discordBotToken,
				discordOwnerUserId: config.discordOwnerUserId,
				transitionOpts,
				dryRun: reconcileCfg.dryRun,
				maxArchivesPerRun: reconcileCfg.maxArchivesPerRun,
				maxCandidatesPerRun: reconcileCfg.maxCandidatesPerRun,
				runDeadlineMs: reconcileCfg.runDeadlineMs,
				shouldAbort,
				lookupTarget: lookupTmuxTarget,
				probeLiveness: (w) => probeRunnerProcessLiveness(w),
				// FLY-1185 entry D: authorized issue closeout (episode-gated inside
				// the reconcile) + the dual-switch contract — the NEW mutators hang
				// disable autoclean through the integration seam; the original FLY-1165 behavior
				// stays under FLYWHEEL_DONE_THREAD_RECONCILE.
				lifecycleCloseout: (input) =>
					lifecycleCloseoutFn({
						issueKey: input.issueKey,
						projectName: input.projectName,
						disposition: input.disposition,
						authority: "linear_reconcile",
						extraAliases: input.extraAliases,
						// Codex R1#14: D's per-run mutator budget, enforced per node.
						budget: input.budget,
						// Codex R2#5: D's fresh-Linear authority (reopen wins).
						freshAuthority: input.freshAuthority,
					}),
				retireIssueGates: (input) =>
					terminalGateRetirementHolder.current?.retireIssueDone({
						projectName: input.projectName,
						canonicalIssueId: input.canonicalIssueId,
						issueAliases: input.issueAliases,
						authorityCredential: input.authorityCredential,
						revalidate: input.revalidate,
					}) ?? Promise.resolve(),
				newMutatorsEnabled: worktreeAutocleanEnabled(),
			});
		},
		// FLY-1282 Part C: archive-only targeted consumption — same scheduler,
		// shared single-flight with the global pass. dryRun is re-read per
		// invocation so a dry-run flip takes effect without restart.
		runTargeted: async (issueId) => {
			const targetedCfg = resolveDoneThreadReconcileConfig();
			const outcome = await runTargetedArchiveCheck(issueId, {
				store,
				projects: projects ?? [],
				linearApiKey: config.linearApiKey,
				globalBotToken: config.discordBotToken,
				discordOwnerUserId: config.discordOwnerUserId,
				dryRun: targetedCfg.dryRun,
				// Canonical per-issue lock — the SAME keys the lifecycle
				// close guard / admission serialize on (never split-lock).
				withIssueLock: (lockIssueId, fn) => {
					const res = resolveLifecycleRootKey(store, lockIssueId, []);
					const keys = res.lockKeys.length > 0 ? res.lockKeys : [lockIssueId];
					return issueMutex(keys, fn);
				},
				lookupTarget: lookupTmuxTarget,
				probeLiveness: (w) => probeRunnerProcessLiveness(w),
			});
			return { done: !isRetryableOutcome(outcome), note: outcome.kind };
		},
	});
	// FLY-1282 Part C: bind the pre-created enqueue buffer to the scheduler's
	// targeted queue — completion enqueues that arrived before this point
	// (bounded 64) flush now.
	terminalArchiveBuffer.bind((issueId) => doneThreadReconcile.enqueue(issueId));

	// FLY-754: boot sweep — kill leaked `viewer-<execId>` tmux sessions (the
	// FLY-116 Terminal.app viewer's linked sessions that were never destroyed).
	// The generation source is fixed in openTmuxViewer (cmux no longer opens
	// viewers); this migrates the existing backlog + backstops the terminal-app
	// path. Runs after the FLY-324 sweep; the late-bound FLY-172 alert-aware drain
	// runs later in boot and owns completion settlement. One-shot,
	// fire-and-forget, best-effort.
	import("./viewer-session-reaper.js")
		.then(({ deriveOwnedBaseSessions, reapViewerSessions }) =>
			reapViewerSessions(
				store,
				deriveOwnedBaseSessions((projects ?? []).map((p) => p.projectName)),
			).then((r) =>
				console.log(
					`[viewer-session-reaper] scanned=${r.scanned} killed=${r.killed} skippedAttached=${r.skippedAttached} skippedActive=${r.skippedActive} skippedForeign=${r.skippedForeign} errors=${r.errors.length}`,
				),
			),
		)
		.catch((e: Error) =>
			console.warn(`[viewer-session-reaper] failed: ${e.message}`),
		);

	// FLY-766: Chrome-session reaper — kill leaked `agent-browser` Chrome-for-Testing
	// instances (the real root of the fleet memory spikes: any session using
	// claude-in-chrome / ProofShot leaves an ephemeral headless Chrome resident).
	// Attributed cleanup (use-done-must-close + owner-marker-proven no-row orphan)
	// is always on; unattributed cleanup is default log-only (opt-in one-time
	// FLYWHEEL_CHROME_REAPER_MIGRATE_UNATTRIBUTED=1). Skips entirely for a
	// `:memory:` store (unit-test Bridges) so tests never enumerate real processes
	// or start a timer. Boot + periodic share one single-flight guard.
	let chromeReaperTimer: ReturnType<typeof setInterval> | undefined;
	if (store.getDbPath() !== ":memory:") {
		const chromeGraceMin = (() => {
			const n = Number(process.env.FLYWHEEL_CHROME_REAPER_ORPHAN_GRACE_MIN);
			return Number.isFinite(n) && n > 0 ? n : 30;
		})();
		const chromeIntervalMs = (() => {
			const n = Number(process.env.FLYWHEEL_CHROME_REAPER_INTERVAL_MS);
			return Number.isFinite(n) && n >= 1000 ? n : 60_000;
		})();
		const chromeMigrateUnattributed =
			process.env.FLYWHEEL_CHROME_REAPER_MIGRATE_UNATTRIBUTED === "1";
		let chromeReaperRunning = false;
		let playwrightCensusRecorder:
			| {
					run(input: {
						sample: import("./chrome-session-reaper.js").ChromeSweepSample;
						mode: "boot" | "periodic";
						orphanGraceMinutes: number;
					}): Promise<string>;
			  }
			| undefined;
		const runChromeReap = async (mode: "boot" | "periodic"): Promise<void> => {
			if (chromeReaperRunning) return; // single-flight (shared boot + periodic)
			chromeReaperRunning = true;
			try {
				const [
					{ collectChromeSweepSample, reapChromeSessions },
					{ createPlaywrightOrphanCensusRecorder },
				] = await Promise.all([
					import("./chrome-session-reaper.js"),
					import("./playwright-orphan-census.js"),
				]);
				const chromeSweepSample = await collectChromeSweepSample();
				playwrightCensusRecorder ??= createPlaywrightOrphanCensusRecorder();
				try {
					const summary = await playwrightCensusRecorder.run({
						sample: chromeSweepSample,
						mode,
						orphanGraceMinutes: chromeGraceMin,
					});
					if (!summary.endsWith("recorded=no")) console.log(summary);
				} catch (error) {
					console.warn(
						`[playwright-orphan-census] ledger failed: ${(error as Error).message}`,
					);
				}
				const r = await reapChromeSessions({
					store,
					ownStateDbPath: store.getDbPath(),
					mode,
					migrateUnattributed: chromeMigrateUnattributed,
					unattributedIdleGraceMinutes: chromeGraceMin,
					nowMs: Date.now(),
					sweepSample: chromeSweepSample,
				});
				if (
					r.scanned > 0 ||
					r.killedAttributedTerminal > 0 ||
					r.killedAttributedOrphan > 0 ||
					r.killedUnattributedIdle > 0 ||
					r.killedHeadlessShot > 0 ||
					r.killedRodBrowser > 0 ||
					r.wouldKillUnattributed > 0 ||
					r.errors.length > 0
				) {
					console.log(
						`[chrome-reaper:${mode}] scanned=${r.scanned} killTerminal=${r.killedAttributedTerminal} killOrphan=${r.killedAttributedOrphan} killUnattr=${r.killedUnattributedIdle} killHeadlessShot=${r.killedHeadlessShot} killRodBrowser=${r.killedRodBrowser} wouldKillUnattr=${r.wouldKillUnattributed} skippedActive=${r.skippedActive} skippedForeign=${r.skippedForeign} skippedHeadlessShotFresh=${r.skippedHeadlessShotFresh} skippedRodFresh=${r.skippedRodFresh} raced=${r.racedSkipped} errors=${r.errors.length}`,
					);
				}
			} catch (e) {
				console.warn(`[chrome-reaper:${mode}] failed: ${(e as Error).message}`);
			} finally {
				chromeReaperRunning = false;
			}
		};
		void runChromeReap("boot"); // migrate backlog + backstop
		chromeReaperTimer = setInterval(
			() => void runChromeReap("periodic"),
			chromeIntervalMs,
		);
		chromeReaperTimer.unref?.();
	}

	// FLY-638: boot prune sweep — clear the backlog of stale CommDB session rows
	// (terminal status + tmux window provably gone). These accumulate (~65 observed
	// in production) and pollute runner_terminal_list / Lead bootstrap with
	// class=dead entries. One pass per distinct project; the live counterpart is
	// finalizeCommDbSession on the close_runner / terminate / post-merge teardown
	// paths (mirrors the FLY-324 live + boot shape).
	//
	// FIRE-AND-FORGET (Codex R1 MED): unlike the FLY-324 sweep (status-only, fast),
	// this sweep does a per-row tmux probe (up to ~5s each, serial). With a backlog
	// of dead rows behind a wedged tmux server, awaiting it here would stall the
	// rest of Bridge boot for minutes. It is pure best-effort cleanup with no
	// ordering dependency on later boot steps, so detach it and let it drain in the
	// background; per-project failures are swallowed.
	//
	// FLY-817: the CommDB↔FSM reconcile (sibling of the FLY-638 sweep, folded into
	// the same per-project loop) runs FIRST each project — it clears CommDB
	// `running` rows whose Bridge FSM is a non-preserve terminal outcome AND whose
	// tmux target is provably dead (the FLY-638 blind spot). Both sweeps probe tmux
	// per row and share the fire-and-forget + dedup shape; their candidate sets are
	// disjoint (running vs completed/timeout). The generic seam stays injectable
	// for tests, while production always enables reconciliation.
	{
		const runLegacyCommDbFsm = async (projectName: string) => {
			try {
				const result = await reconcileCommDbRunningAgainstFsm(
					projectName,
					(executionId) => store.getSession(executionId)?.status,
					{
						onFinalizeOutcome: recordResidueFinalizeOutcome,
						finalizePaneLossResidue: (db, executionId, expectedTmuxWindow) =>
							db.finalizePaneLossResidue(executionId, expectedTmuxWindow),
						parkedGenerationEvidence,
					},
				);
				if (result.reconciled > 0) {
					console.log(
						`[Bridge] FLY-817 CommDB↔FSM reconcile (${projectName}): scanned=${result.scanned} reconciled=${result.reconciled} keptNonTerminal=${result.keptNonTerminal} keptPreserve=${result.keptPreserve} keptAliveTarget=${result.keptAliveTarget}`,
					);
				}
			} catch (err) {
				console.error(
					`[Bridge] FLY-817 CommDB↔FSM reconcile (${projectName}) failed (non-fatal): ${(err as Error).message}`,
				);
			}
		};
		void runResidueAwareBootSweep({
			projectNames: projects.map((project) => project.projectName),
			residueHarvester,
			commDbFsmEnabled: commDbFsmReconcileEnabled,
			runLegacyCommDbFsm,
			pruneCommDb: pruneResidueCommDb,
		}).catch((err) =>
			console.error(
				`[Bridge] CommDB boot sweep failed (non-fatal): ${(err as Error).message}`,
			),
		);
	}

	// FLY-369: archive-on-close. Archiving is driven by the Lead's close action
	// via POST /api/chat-threads/archive (wired through createQueryRouter above) —
	// NOT a standalone auto-poll on Linear "Done" (which the founder ruled out as
	// premature). The ship path still archives on ship. No boot sweep / heartbeat
	// piggyback here by design.

	// FLY-623 (Codex R2 HIGH-2 / R3 LOW-1): boot-seed reconnecting state for
	// pre-existing `running` sessions whose in-process poll loop died with the
	// previous Bridge process. Runs after the FLY-324 done-but-running sweep (so a
	// stage=completed zombie is terminalized first and never briefly enters
	// reconnecting / gets a ⚠️重连中 title), before the late-bound FLY-172
	// alert-aware boot drain, and BEFORE
	// heartbeatService.start() — closing the on-boot
	// false-stuck/idle window and making the in-memory set restart-safe (re-seeded
	// every boot → survives repeated restarts). No-op on the kill-switch path.
	// Best-effort: must not block Bridge startup.
	let bootReconnectExecutionIds: string[] = [];
	try {
		bootReconnectExecutionIds = await heartbeatService.seedReconnecting();
	} catch (err) {
		console.error(
			`[Bridge] FLY-623 reconnect boot-seed failed (non-fatal): ${(err as Error).message}`,
		);
	}

	heartbeatService.start();

	// FLY-163: CleanupService removed (forum thread cleanup gone).

	// FLY-62: Gate question poller
	// FLY-605: persistent founder-reply thread cursor path (state dir is only
	// reachable through the dynamically-imported getStateDir below). Unset →
	// GatePoller falls back to an in-memory cursor.
	let founderReplyCursorPath: string | undefined;
	if (resolveCommBackend() === "mailbox") {
		try {
			const { getStateDir } = await import("flywheel-agent-team-transport");
			founderReplyCursorPath = join(getStateDir(), "founder-reply-cursor.json");
		} catch {}
	}
	// FLY-513: the global-codex drift probe does real PATH/realpath I/O against the
	// host's actual `codex`. Disabled under VITEST (same boundary as
	// BridgeEventLoopGuard below) so general Bridge integration suites never fire
	// a meta-alert off the test machine's real (possibly contaminated) global codex.
	const codexHealthEnabled = !process.env.VITEST;
	// Late-bound shared alert sink for convergence lanes.
	const leadPendingAlertHolder: {
		current?: { alert: (p: AlertPayload) => Promise<AlertResult> };
	} = {};
	// FLY-927 (Task 1.1): late-bound ROUTED alert sink — the single funnel every
	// emission source calls, so the D1 Router sees every infra event. Populated
	// right after the raw alertSink below; emitters constructed earlier read
	// `.current` at fire time and fall back to the raw notifier during the
	// synchronous boot window; production routing is welded on after assembly.
	const routedAlertSinkHolder: {
		current?: { alert: (p: AlertPayload) => Promise<AlertResult> };
	} = {};

	const flagScanOwnerStatus = resolveFlagScanOwnerStatus(projects);
	const flagScanOwner =
		flagScanOwnerStatus.kind === "ready"
			? flagScanOwnerStatus.owner
			: undefined;
	if (flagScanOwnerStatus.kind === "invalid") {
		console.warn(
			`[flag-scan] owner resolution unavailable: ${flagScanOwnerStatus.message}`,
		);
	}
	const flagScanFailureMessages = new Map<string, string>();
	const recoverFlagScanFailureAlerts = (): void => {
		if (!flagScanOwner) return;
		const now = Date.now();
		const leaseOwner = `bridge:${process.pid}`;
		for (const intent of store.listFlagScanFailureAlertIntents()) {
			if (intent.state === "done") continue;
			if (
				!store.claimFlagScanFailureAlertIntent({
					intentId: intent.intentId,
					leaseOwner,
					now,
					leaseMs: 2 * 60_000,
				})
			) {
				continue;
			}
			try {
				const message =
					flagScanFailureMessages.get(intent.eventId) ??
					`Weekly flag scan ${intent.failureClass} failure at baseline run ${intent.baselineRunId}; inspect the scanner before retrying.`;
				const delivered = deliverFlagScanMailboxAlert({
					primaryLeadId: flagScanOwner.leadId,
					fallbackLeadId: flagScanOwner.senderLeadId,
					projectName: flagScanOwner.project.projectName,
					payloadFor: (recipient) => ({
						leadId: recipient,
						projectName: flagScanOwner.project.projectName,
						eventId: intent.eventId,
						eventType: "flag_scan_failed",
						title: `Weekly flag scan failed closed (${intent.milestone})`,
						body: `${message}\nThe scan remains fail-closed; inspect the referenced run before retrying.`,
						severity: "warning",
					}),
					enqueueLeadInbox: (leadId, payload) =>
						leadInboxRuntime.enqueueInfraAlert(leadId, payload),
					inspectLeadInbox: (projectName, deliveryId) =>
						leadInboxRuntime.getLeadEventSettlement(projectName, deliveryId),
					leadRecipientState: (leadId) =>
						leadInboxRuntime.getLeadRecipientState(leadId),
				});
				if (
					delivered.done &&
					store.settleFlagScanFailureMailboxIntent({
						intentId: intent.intentId,
						leaseOwner,
					})
				) {
					continue;
				}
				store.markFlagScanFailureAlertIntentAmbiguous({
					intentId: intent.intentId,
					leaseOwner,
					error: "Lead mailbox ACK pending",
				});
			} catch (error) {
				store.markFlagScanFailureAlertIntentAmbiguous({
					intentId: intent.intentId,
					leaseOwner,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	};
	const flagRetirementScanner =
		flagScanSourceLoader && flagScanRepoRoot && flagScanOwner
			? createFlagRetirementScanner({
					store,
					loadSources: flagScanSourceLoader,
					loadProvenance: (currentFlagNames) =>
						buildFlagProvenance({
							currentFlagNames,
							execGit: async (args) => {
								try {
									const result = await execFileP("git", args, {
										cwd: flagScanRepoRoot,
										timeout: 20_000,
										maxBuffer: 16 * 1024 * 1024,
									});
									return {
										exitCode: 0,
										stdout: result.stdout,
										stderr: result.stderr,
									};
								} catch (error) {
									const failed = error as {
										code?: number | string;
										stdout?: string;
										stderr?: string;
										message?: string;
									};
									return {
										exitCode:
											typeof failed.code === "number" ? failed.code : 124,
										stdout: failed.stdout ?? "",
										stderr: failed.stderr ?? failed.message ?? "git failed",
									};
								}
							},
						}),
					effects: createProductionFlagScanEffects({
						projects,
						reportBaseUrl: loopbackBaseUrl,
						reportToken: config.apiToken,
						commCliPath: join(
							flagScanRepoRoot,
							"packages/flywheel-comm/dist/index.js",
						),
						store,
						enqueueLeadInbox: (leadId, payload) =>
							leadInboxRuntime.enqueueInfraAlert(leadId, payload),
						inspectLeadInbox: (projectName, deliveryId) =>
							leadInboxRuntime.getLeadEventSettlement(projectName, deliveryId),
						leadRecipientState: (leadId) =>
							leadInboxRuntime.getLeadRecipientState(leadId),
					}),
					alertFailure: async (message) => {
						const baselineRunId = store.getLatestFlagScanRun()?.runId ?? 0;
						const failureClass = /provenance|git|registry/i.test(message)
							? "provenance"
							: /source|config|resolve/i.test(message)
								? "source"
								: "orchestration";
						const now = Date.now();
						const initial = store.ensureFlagScanFailureAlertIntent({
							baselineRunId,
							failureClass,
							milestone: "initial",
							eventId: `flag-scan-failed:${baselineRunId}:${failureClass}:initial`,
							now,
						});
						flagScanFailureMessages.set(initial.eventId, message);
						if (now - initial.createdAt >= 24 * 60 * 60_000) {
							const reminder = store.ensureFlagScanFailureAlertIntent({
								baselineRunId,
								failureClass,
								milestone: "24h",
								eventId: `flag-scan-failed:${baselineRunId}:${failureClass}:24h`,
								now,
							});
							flagScanFailureMessages.set(reminder.eventId, message);
						}
						recoverFlagScanFailureAlerts();
					},
					recoverFailureAlerts: recoverFlagScanFailureAlerts,
					now: () => Date.now(),
					newRunToken: () =>
						`${new Date().toISOString().slice(0, 10)}-${randomBytes(8).toString("hex")}`,
					leaseOwner: `bridge:${process.pid}:${randomUUID()}`,
					enabled: () => storeFlagRetirementScanEnabled(flagStore),
				})
			: undefined;
	flagScanRouteHolder.current = flagRetirementScanner;
	// FLY-799: founder-in-thread ship approval. When the founder replies "ship
	// it" / ✅ in a `[FLY-XX]` thread, this callback attributes the approval to
	// HER (canonical founder id), writes {"approved":true} to the approve_to_ship
	// gate, and runs the SAME flip+wake as Surface B (buildGateResponsePostWriteHook
	// — the one source of truth) so the runner self-ships. The gate-poller's
	// founder-reply pass invokes it. Its internal gates (default-ON kill-switch,
	// per-project denylist, resolvable canonical founder id — all read per-call)
	// return null when off → the deliverer falls back to WAKE-only.
	const founderShipPostWriteHook = buildGateResponsePostWriteHook({
		store,
		transitionOpts,
		// FLY-869 B-3 (Codex R1 #1): drive an un-parked already-merged session to
		// completed + Done on the founder-reply ship-approval path.
		config,
		projects,
	});
	const founderAutoApproveDenylist = new Set(
		(process.env.FLYWHEEL_FOUNDER_AUTO_APPROVE_DENYLIST ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
	// FLY-1041 Chunk 5: ONE hold guard closure injected into every founder
	// approval source (text / ✅ reaction / voice) so they cannot drift.
	const founderApprovalIsHeld = (executionId: string): boolean =>
		founderApprovalHoldGuard(store, store.getSession(executionId));
	const founderHoldReasonFor = (executionId: string) =>
		reviewHoldReason(store, store.getSession(executionId));

	// FLY-1099: current canonical founder id (same derivation the factory uses).
	const founderCanonicalId = (): string | undefined =>
		deriveCanonicalFounderId(
			config.discordOwnerUserId,
			config.founderConsent?.founderUserId,
		) ?? undefined;
	const projectRootFor = (projectName: string): string | undefined =>
		projects.find((project) => project.projectName === projectName)
			?.projectRoot;
	const gateAuthorityView = makeGateAuthorityView(store);
	// FLY-1238: ONE composition-root instance owns cache, single-flight,
	// backoff, and per-project network budget for all six recovery surfaces.
	const mergedGateGuard = createMergedGateGuard({
		store,
		retireQuestion: (questionId, _executionId, projectName) => {
			const db = new CommDB(commDbPathForProject(projectName), false);
			try {
				db.retireShipGate(questionId);
			} finally {
				db.close();
			}
		},
		env: process.env,
		log: (message) => console.warn(message),
	});

	const founderShipApprovalCallback = makeFounderShipApprovalCallback({
		discordOwnerUserId: config.discordOwnerUserId,
		founderConsentUserId: config.founderConsent?.founderUserId,
		store,
		gateAuthorityView,
		denylistProjects: founderAutoApproveDenylist,
		auditStore: store,
		isHeld: founderApprovalIsHeld,
		mergedGateGuard,
		projectRootFor,
		deferralSupport: (ctx) =>
			makeDeferralSupport({
				store,
				holdReasonFor: founderHoldReasonFor,
				ctx,
			}),
		onResponseWritten: (info) =>
			founderShipPostWriteHook({
				executionId: info.executionId,
				questionId: info.questionId,
				leadId: info.actor,
				answer: info.answer,
				db: info.db as unknown as Parameters<
					typeof founderShipPostWriteHook
				>[0]["db"],
			}),
	});

	// FLY-799: the founder ✅-reaction ship-approval callback (same gating; the
	// gate-poller reaction pass injects the per-lead reactions fetcher per-call).
	// readBindingImpl resolves the durable (questionId,prHeadSha)->gateMessageId
	// binding written when the ship ping was posted.
	const founderReactionApprovalCallback = makeFounderReactionApprovalCallback({
		discordOwnerUserId: config.discordOwnerUserId,
		founderConsentUserId: config.founderConsent?.founderUserId,
		store,
		gateAuthorityView,
		denylistProjects: founderAutoApproveDenylist,
		// FLY-1041 Chunk 4/5: same audit target + hold guard as the text source.
		auditStore: store,
		isHeld: founderApprovalIsHeld,
		mergedGateGuard,
		projectRootFor,
		readBindingImpl: (executionId, questionId, prHeadSha) =>
			readCurrentGateMessageBinding(store, executionId, questionId, prHeadSha),
		onResponseWritten: (info) =>
			founderShipPostWriteHook({
				executionId: info.executionId,
				questionId: info.questionId,
				leadId: info.actor,
				answer: info.answer,
				db: info.db as unknown as Parameters<
					typeof founderShipPostWriteHook
				>[0]["db"],
			}),
	});

	// FLY-546: /api/voice/* — the headphone daemon's Bridge face (scope /
	// context / gate-binding / voice ship-approval). ALWAYS registered — the
	// approval kill-switch answers 403 inside, never 404 (FLY-175 R1 lesson);
	// the ship-approval write itself refuses tokenless deployments (503) and
	// runs the SAME flip+wake post-write hook as the text/reaction sources.
	app.use(
		"/api/voice",
		tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
		createVoiceRouter({
			store,
			gateAuthorityView,
			projects,
			apiTokenConfigured: Boolean(config.apiToken),
			discordOwnerUserId: config.discordOwnerUserId,
			founderConsentUserId: config.founderConsent?.founderUserId,
			// FLY-1041 Chunk 5: voice approvals honor the SAME hold guard.
			isHeld: founderApprovalIsHeld,
			roundtableChannelIds: (
				process.env.FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS ?? ""
			)
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
			globalBotToken: config.discordBotToken,
			// server-derived CommDB via the SHARED path convention (Codex R1
			// MEDIUM-5: commDbPathForProject honors FLYWHEEL_COMM_DIR so the
			// voice write can never land on a different db than the rest of the
			// Bridge). Containment = realpath + path.relative, never a string
			// prefix (which would let `commX` pass a `comm` check).
			openCommDb: (projectName) => {
				try {
					const canonical = voiceRealpathSync(
						commDbPathForProject(projectName),
					);
					const rel = pathRelative(
						voiceRealpathSync(commDbRootDir()),
						canonical,
					);
					if (rel.startsWith("..") || pathIsAbsolute(rel)) return null;
					return new CommDB(canonical, false) as unknown as GateResponseDb;
				} catch {
					return null;
				}
			},
			onResponseWritten: (info) =>
				founderShipPostWriteHook({
					executionId: info.executionId,
					questionId: info.questionId,
					leadId: info.actor,
					answer: info.answer,
					db: info.db as unknown as Parameters<
						typeof founderShipPostWriteHook
					>[0]["db"],
				}),
		}),
	);

	// FLY-945 Fix D: external-merge convergence sweeper (backstop — Fix F
	// simultaneously retires executor-merge; this is NOT permission for it).
	const externalMergeReconciler = createExternalMergeReconciler({
		store,
		withIssueLifecycleMutex: lifecycleInfra.withIssueLifecycleMutex,
		materializedHeadAuthority,
		config,
		projects,
		removeCleanWorktree: makeBridgeWorktreeCleanup(store, projects),
		probeTurnHolderLiveness: async (session) => {
			if (!session.tmux_session) return "indeterminate";
			return probeRunnerProcessLiveness(session.tmux_session);
		},
		// FLY-1204: external merge is a real ship path — reclaim the parked
		// DAG workflow sessions here too (shared finalizer, same as run-infra).
		finalizeWorkflowPhaseRoles,
		retireMergedGates: (input) =>
			terminalGateRetirementHolder.current?.retirePrMerged({
				projectName: input.projectName,
				canonicalIssueId: input.canonicalIssueId,
				issueAliases: input.issueAliases,
				prNumber: input.prNumber,
				authorityCredential: input.authorityCredential,
				revalidate: input.revalidate,
			}) ?? Promise.resolve(),
		alertLead: async (session, title, body) => {
			try {
				const { lead } = resolveLeadForIssue(
					projects,
					session.project_name,
					parseJsonStringArray(session.issue_labels) ?? [],
				);
				// FLY-927 (merge integration): route through the shared infra funnel
				// so the merged-in external_merge_suspect kind gets owner enrichment +
				// AlertChannelHub ticket/thread lifecycle like every other infra
				// emitter (routing OFF ⇒ passthrough to the raw notifier = byte-compat).
				await (routedAlertSinkHolder.current ?? leadAlertNotifier).alert({
					leadId: lead.agentId,
					projectName: session.project_name,
					eventId: `external-merge:${session.execution_id}:${title}`,
					eventType: "external_merge_suspect",
					title,
					body,
					severity: "warning",
					sessionKey: buildSessionKey(session),
				});
			} catch (err) {
				console.warn(
					`[external-merge] Lead alert failed for ${session.execution_id}: ${(err as Error).message}`,
				);
			}
		},
	});

	const issueGateSupersedeTick = (): void => {
		for (const project of projects) {
			let db: CommDB | undefined;
			try {
				db = new CommDB(commDbPathForProject(project.projectName));
				sweepIssueGatesForProject({
					projectName: project.projectName,
					db,
					store,
					env: process.env,
					log: (message) => console.warn(message),
				});
			} catch (error) {
				console.warn(
					`[gate-supersede] project sweep failed for ${project.projectName}: ${error instanceof Error ? error.message : String(error)}`,
				);
			} finally {
				db?.close();
			}
		}
	};
	const orphanFounderReviewMonitorTick = (): void => {
		for (const project of projects) {
			let db: CommDB | undefined;
			try {
				db = new CommDB(commDbPathForProject(project.projectName));
				sweepOrphanFounderReviewGates({
					projectName: project.projectName,
					db,
					store,
					resolveAlertIdentity: (run) =>
						resolveWorkflowRunAlertIdentity({
							store,
							projects,
							defaultLeadAgentId: config.defaultLeadAgentId,
							projectName: run.project_name,
							issueId: run.issue_id,
							runId: run.run_id,
							log: (message) =>
								console.warn(`[founder-review-orphan] ${message}`),
						}),
					env: process.env,
					log: (message) => console.warn(message),
				});
			} catch (error) {
				console.warn(
					`[founder-review-orphan] project sweep failed for ${project.projectName}: ${error instanceof Error ? error.message : String(error)}`,
				);
			} finally {
				db?.close();
			}
		}
	};
	const { createWorkflowGateOriginPreflight } = await import(
		"./gate-origin-preflight.js"
	);
	const workflowGateOriginPreflight = createWorkflowGateOriginPreflight({
		store,
		alertIdentity: ({ runId, projectName, issueId }) =>
			resolveWorkflowRunAlertIdentity({
				store,
				projects,
				defaultLeadAgentId: config.defaultLeadAgentId,
				projectName,
				issueId,
				runId,
				log: (message) => console.warn(`[workflow-gate] ${message}`),
			}),
	});
	let workflowGateMaterializationRunning = false;
	const workflowGateMaterializeTick = async (): Promise<void> => {
		if (workflowGateMaterializationRunning) return;
		workflowGateMaterializationRunning = true;
		try {
			await voidSupersededWorkflowGateCards({
				store,
				resolveAlertIdentity: ({ run }) =>
					resolveWorkflowRunAlertIdentity({
						store,
						projects,
						defaultLeadAgentId: config.defaultLeadAgentId,
						projectName: run.project_name,
						issueId: run.issue_id,
						runId: run.run_id,
						log: (message) => console.warn(`[workflow-gate-card] ${message}`),
					}),
				resolveDelivery: ({ holder, run }) => {
					const source = store.getSession(holder.source_execution_id);
					const { lead } = resolveLeadForIssue(
						projects,
						run.project_name,
						source ? store.getSessionLabels(holder.source_execution_id) : [],
					);
					const botToken = lead.botToken ?? config.discordBotToken;
					if (!botToken) return undefined;
					return {
						botToken,
						alertIdentity: resolveWorkflowRunAlertIdentity({
							store,
							projects,
							defaultLeadAgentId: config.defaultLeadAgentId,
							projectName: run.project_name,
							issueId: run.issue_id,
							runId: run.run_id,
							log: (message) => console.warn(`[workflow-gate-card] ${message}`),
						}),
					};
				},
				log: (message: string) => console.warn(message),
			});
			const materializeQuestion = async (
				questionId: string,
			): Promise<boolean> => {
				const holder =
					store.getCurrentWorkflowGateHolderByQuestionId(questionId);
				if (!holder) return false;
				const run = store.getWorkflowRun(holder.run_id);
				if (!run) {
					console.warn(
						`[workflow-gate] materialization failed for ${holder.question_id}: workflow_gate_run_not_found`,
					);
					return false;
				}
				let materialized = false;
				try {
					await materializeWorkflowGateWithFailLoud({
						store,
						holder,
						alertIdentity: resolveWorkflowRunAlertIdentity({
							store,
							projects,
							defaultLeadAgentId: config.defaultLeadAgentId,
							projectName: run.project_name,
							issueId: run.issue_id,
							runId: run.run_id,
							log: (message) => console.warn(`[workflow-gate] ${message}`),
						}),
						materialize: async () => {
							const source = store.getSession(holder.source_execution_id);
							const { lead } = resolveLeadForIssue(
								projects,
								run.project_name,
								source
									? store.getSessionLabels(holder.source_execution_id)
									: [],
							);
							const thread = store.getChatThreadByIssue(
								run.issue_id,
								lead.chatChannel,
							);
							if (!thread?.thread_id) {
								throw new Error("workflow_gate_thread_not_found");
							}
							const gateBotToken = lead.botToken ?? config.discordBotToken;
							const result = await materializeWorkflowGateHolder(
								{
									store,
									commDbPath: commDbPathForProject(run.project_name),
									leadId: lead.agentId,
									threadId: thread.thread_id,
									preflight: workflowGateOriginPreflight,
									postCard: async (input) => {
										const result = await emitFounderThreadNotification(
											{
												questionId: input.questionId,
												checkpoint: "approve_to_ship",
												executionId: input.sourceExecutionId,
												issueId: input.issueId,
												issueIdentifier: source?.issue_identifier,
												projectName: input.projectName,
												summary: input.content,
												ageMinutes: 0,
												thread,
												botToken: gateBotToken,
												ownerUserId: config.discordOwnerUserId,
												correlationMarker: input.correlationMarker,
												deferSuccessAudit: true,
											},
											{ store },
										);
										if (result.kind === "posted" && result.gateMessageId) {
											return {
												kind: "posted" as const,
												messageId: result.gateMessageId,
											};
										}
										if (
											result.kind === "posted_ambiguous" ||
											(result.kind === "transient_failed" &&
												!result.deliveryRejected)
										) {
											return { kind: "posted_ambiguous" as const };
										}
										return {
											kind: "no_effect" as const,
											reason: result.skipReason ?? result.kind,
										};
									},
									scanCard: async (input) => {
										if (!gateBotToken) {
											return {
												kind: "ambiguous" as const,
												frontier: null,
												reason: "no_bot_token",
											};
										}
										return scanFounderThreadForGateCard({
											threadId: thread.thread_id,
											botToken: gateBotToken,
											postedAt: input.postedAt,
											correlationMarker: input.correlationMarker,
											legacyTerms: input.legacyTerms,
										});
									},
								},
								holder.question_id,
							);
							materialized = result.ok;
							return result;
						},
						log: (message) => console.warn(message),
					});
				} catch (error) {
					console.warn(
						`[workflow-gate] materialization failed for ${holder.question_id}: ${error instanceof Error ? error.message : String(error)}`,
					);
					return false;
				}
				return materialized;
			};
			await Promise.all(
				store
					.listWorkflowGateHoldersForMaterialization(20)
					.map((holder) => materializeQuestion(holder.question_id)),
			);
			for (const admission of store.listWorkflowResumeRedriveWork(20)) {
				const holder = store.getCurrentWorkflowGateHolder(
					admission.run_id,
					admission.target_node_id,
				);
				if (!holder || !(await materializeQuestion(holder.question_id))) {
					continue;
				}
				store.ackWorkflowResumeRedrive({
					admissionKey: admission.admission_key,
					questionId: holder.question_id,
					now: new Date().toISOString(),
				});
			}
			await watchVoidedWorkflowGateCards({
				store,
				founderId: config.discordOwnerUserId ?? "",
				resolveDelivery: ({ holder, run }) => {
					const source = store.getSession(holder.source_execution_id);
					const { lead } = resolveLeadForIssue(
						projects,
						run.project_name,
						source ? store.getSessionLabels(holder.source_execution_id) : [],
					);
					const botToken = lead.botToken ?? config.discordBotToken;
					if (!botToken) return undefined;
					return {
						botToken,
						alertIdentity: resolveWorkflowRunAlertIdentity({
							store,
							projects,
							defaultLeadAgentId: config.defaultLeadAgentId,
							projectName: run.project_name,
							issueId: run.issue_id,
							runId: run.run_id,
							log: (message) => console.warn(`[workflow-gate-card] ${message}`),
						}),
					};
				},
				log: (message) => console.warn(message),
			});
		} finally {
			workflowGateMaterializationRunning = false;
		}
	};
	let landOperationSweepRunning = false;
	let landOperationLastSweepAt = 0;
	const landOperationSweepIntervalMs = 30_000;
	let linearDoneSweepRunning = false;
	let linearDoneLastSweepAt = 0;
	const linearDoneSweepIntervalMs = 15 * 60_000;
	const landOperationTick = async (): Promise<void> => {
		const now = Date.now();
		const work: Promise<void>[] = [];
		if (
			!landOperationSweepRunning &&
			now - landOperationLastSweepAt >= landOperationSweepIntervalMs
		) {
			landOperationLastSweepAt = now;
			landOperationSweepRunning = true;
			work.push(
				(async () => {
					try {
						for (const pending of store.listPendingWorkflowCarryoverDepartures(
							20,
						)) {
							try {
								const sweepNow = new Date().toISOString();
								if (
									Date.parse(sweepNow) - Date.parse(pending.firstObservedAt) >=
									60 * 60_000
								) {
									if (!pending.operation.run_id) continue;
									const identity = resolveWorkflowRunAlertIdentity({
										store,
										projects,
										defaultLeadAgentId: config.defaultLeadAgentId,
										projectName: pending.operation.project_name,
										issueId: pending.operation.issue_id,
										runId: pending.operation.run_id,
									});
									const expired = store.expireWorkflowCarryoverDeparture({
										carryoverReceiptId: pending.carryoverReceiptId,
										operationId: pending.operation.operation_id,
										now: sweepNow,
										alertIdentity: identity,
									});
									if (!expired.ok) {
										console.warn(
											`[land] carryover cutoff horizon failed for ${pending.operation.operation_id}: ${expired.reason}`,
										);
									}
									continue;
								}
								recordCarryoverDepartureCutoff({
									operation: pending.operation,
									receiptId: pending.carryoverReceiptId,
									ordinal: pending.ordinal,
									at: pending.firstObservedAt,
								});
							} catch (error) {
								console.warn(
									`[land] carryover cutoff recovery failed for ${pending.operation.operation_id}: ${error instanceof Error ? error.message : String(error)}`,
								);
							}
						}
						const operations = store.listRunnableLandOperations(
							new Date().toISOString(),
							20,
						);
						await Promise.all(
							operations.map((operation) =>
								landExecutor(operation.operation_id).catch((error) =>
									console.warn(
										`[land] sweep failed for ${operation.operation_id}: ${error instanceof Error ? error.message : String(error)}`,
									),
								),
							),
						);
					} finally {
						landOperationSweepRunning = false;
					}
				})(),
			);
		}
		if (
			!linearDoneSweepRunning &&
			now - linearDoneLastSweepAt >= linearDoneSweepIntervalMs
		) {
			linearDoneLastSweepAt = now;
			linearDoneSweepRunning = true;
			work.push(
				(async () => {
					try {
						await sweepDeferredLandLinearDone({
							store,
							preArbitrate: lifecycleInfra.preArbitrate!,
							withIssueMutex: lifecycleInfra.withIssueLifecycleMutex!,
							markIssueDone: landLinearDoneFinalizer,
							onAgedDeferred: (operation, detail) => {
								if (!operation.run_id) {
									console.warn(
										`[land] deferred Linear Done remains stale for ${operation.operation_id} (${detail.ageHours}h)`,
									);
									return;
								}
								const identity = resolveWorkflowRunAlertIdentity({
									store,
									projects,
									defaultLeadAgentId: config.defaultLeadAgentId,
									projectName: operation.project_name,
									issueId: operation.issue_id,
									runId: operation.run_id,
								});
								const alert = buildAgedDeferredLinearDoneAlert({
									operation,
									leadId: identity.leadId,
									leadResolution: identity.leadResolution,
									dayBucket: detail.dayBucket,
								});
								store.enqueueWorkflowEngineAlert({
									escalationUid: alert.escalationUid,
									runId: operation.run_id,
									payload: {
										leadId: identity.leadId,
										projectName: identity.projectName,
										eventId: alert.escalationUid,
										eventType: "workflow_engine_issue_alert",
										severity: "warning",
										sessionKey: `wf:${operation.run_id}`,
										title: alert.title,
										body: alert.body,
										metadata: {
											workflowEngine: {
												runId: operation.run_id,
												issueId: operation.issue_id,
												...alert.workflowMetadata,
											},
										},
									},
								});
							},
						});
					} catch (error) {
						console.warn(
							`[land] deferred Linear Done sweep failed: ${error instanceof Error ? error.message : String(error)}`,
						);
					} finally {
						linearDoneSweepRunning = false;
					}
				})(),
			);
		}
		await Promise.all(work);
	};
	const terminalGateRetirement = new TerminalGateRetirement({
		store,
		projectNames: projects.map((project) => project.projectName),
		commDbPathForProject,
	});
	terminalGateRetirementHolder.current = terminalGateRetirement;
	const founderDecisionConvergenceTick = () =>
		runFounderDecisionConvergencePass({
			store,
			resolve: (row) => {
				const db = new CommDB(commDbPathForProject(row.project_name), false);
				try {
					if (db.getResponse(row.question_id)) {
						return classifyFounderDecisionQuestionResolution({
							hasResponse: true,
						});
					}
					const question = db.getMessageById(row.question_id);
					const questionResolution = classifyFounderDecisionQuestionResolution({
						hasResponse: false,
						question,
					});
					if (questionResolution) return questionResolution;
				} finally {
					db.close();
				}
				const holder = store.getCurrentWorkflowGateHolderByQuestionId(
					row.question_id,
				);
				if (holder?.state === "approved") return "holder_approved";
				if (store.getDeferredApproval(row.question_id, row.msg_id)) {
					return "deferred";
				}
				return null;
			},
			notifyDropped: async (row) => {
				const session = store.getSession(row.execution_id);
				const sink = leadPendingAlertHolder.current;
				if (!session || !sink) return false;
				const alert = await sink.alert({
					leadId: row.lead_id,
					projectName: row.project_name,
					eventId: `founder-decision-dropped:${row.msg_id}:${row.question_id}`,
					eventType: "founder_notify_dead_letter",
					title: "Founder decision did not converge",
					body: `founder 明确 ${row.classification} 决定已被读取,但未绑定到 gate ${row.question_id};请立即检查 gate writer / wake 投递链并人工收敛。`,
					severity: "warning",
					sessionKey: row.execution_id,
				});
				if (alert.skipped || alert.deadLettered) return false;
				const lead = projects
					.find((project) => project.projectName === row.project_name)
					?.leads.find((candidate) => candidate.agentId === row.lead_id);
				const botToken = lead?.botToken ?? config.discordBotToken;
				if (botToken) {
					await recordFounderDecisionAck({
						react: () =>
							reactToFounderMessage({
								botToken,
								channelId: row.thread_id,
								messageId: row.msg_id,
								emoji: "❓",
							}),
						recordAudit: (eventType, payload) => {
							store.insertEvent({
								event_id: `founder-decision-ack:${row.thread_id}:${row.msg_id}:${row.question_id}`,
								execution_id: row.execution_id,
								issue_id: session.issue_id,
								project_name: row.project_name,
								event_type: eventType,
								source: "bridge.founder-decision-convergence",
								payload,
							});
						},
					});
				}
				return true;
			},
			logger: (message) =>
				console.warn(`[founder-decision-convergence] ${message}`),
		});

	// Keep this rider out of lightweight plugin consumers such as
	// createLeadRuntime(); only a full Bridge boot needs its config/queue graph.
	const { createLeadPatrolTickPass, patrolSessionKey } = await import(
		"./patrol-tick.js"
	);
	const { probePatrolProcessLiveness } = await import(
		"./patrol-process-liveness.js"
	);
	const leadPatrolTickPass = createLeadPatrolTickPass({
		projects,
		store,
		openCommReadonly: (projectName) => {
			try {
				return CommDB.openReadonly(commDbPathForProject(projectName));
			} catch {
				return null;
			}
		},
		probeProcessLiveness: probePatrolProcessLiveness,
		inspectDeliveryState: (projectName, deliveryId) =>
			leadInboxRuntime.getLeadEventSettlement(projectName, deliveryId),
		enqueueLeadEvent: (envelope) => registry.enqueueLeadEvent(envelope),
		alertFailure: async (failure) => {
			const sink = leadPendingAlertHolder.current;
			if (!sink) {
				console.warn(
					`[patrol_tick] alert sink unavailable: ${failure.episodeId} ${failure.detail}`,
				);
				return;
			}
			const fleetScoped = failure.leadId === null;
			const alertLeadId =
				failure.leadId ?? `patrol-roster:${failure.projectName}`;
			await sink.alert({
				leadId: alertLeadId,
				projectName: fleetScoped ? FLEET_ALERT_PROJECT : failure.projectName,
				eventId: `patrol_tick_stalled:${failure.episodeId}`,
				eventType: "inbox_loop_stalled",
				title:
					failure.kind === "unowned_roster"
						? "Lead patrol roster has no patrol-capable owner"
						: "Lead patrol tick delivery is stalled",
				body: `project=${failure.projectName}: ${failure.detail}`,
				severity: "severe",
				...(failure.leadId
					? {
							sessionKey: patrolSessionKey(failure.projectName, failure.leadId),
						}
					: {}),
			});
		},
		log: (message) => console.warn(message),
	});
	const summaryAbsorptionPass = createSummaryAbsorptionPass({
		projects,
		store,
		enqueueLeadEvent: (envelope) => registry.enqueueLeadEvent(envelope),
		cadenceMs: () => storeSummaryAbsorptionCadenceMs(flagStore),
	});
	const { activePatrolTargets, createPatrolOrphanSweeperPass } = await import(
		"./patrol-orphan-sweeper.js"
	);
	const patrolOrphanSweepPass = createPatrolOrphanSweeperPass({
		projects,
		store,
		readActiveTargets: async (projectName) => {
			const db = CommDB.openReadonly(commDbPathForProject(projectName));
			try {
				return activePatrolTargets(
					db.listSessions(projectName, ["running", "blocked"]),
				);
			} finally {
				db.close();
			}
		},
		alertFailure: async (failure) => {
			const sink = leadPendingAlertHolder.current;
			if (!sink) {
				throw new Error("patrol orphan alert sink unavailable");
			}
			await sink.alert({
				leadId: "patrol-orphan-sweeper",
				projectName: FLEET_ALERT_PROJECT,
				eventId: `orphan_pane:${failure.episodeId}`,
				eventType: "orphan_pane",
				title:
					failure.condition === "unclaimed"
						? "Runner pane has no owner"
						: "Runner owner index is incomplete",
				body: failure.target
					? `project=${failure.projectName} target=${failure.target}: ${failure.detail}`
					: failure.detail,
				severity: "severe",
			});
		},
		log: (message) => console.warn(message),
	});
	const workflowResumeCheckpointStore = new GitWorkflowResumeCheckpointStore({
		storeRoot: join(homedir(), ".flywheel", "checkpoint-store"),
	});
	const cmuxWatcherAlertRoute = (() => {
		const project = projects.find(
			(candidate) => candidate.projectName === "flywheel",
		);
		const lead = project?.leads[0];
		return project && lead
			? { projectName: project.projectName, leadId: lead.agentId }
			: null;
	})();
	const cmuxWatcherProjectRoot = projects.find(
		(candidate) => candidate.projectName === "flywheel",
	)?.projectRoot;
	const cmuxWatcherPatrol =
		cmuxWatcherProjectRoot && cmuxWatcherAlertRoute
			? createHostCmuxWatcherPatrol({
					homeDir: homedir(),
					projectRoot: cmuxWatcherProjectRoot,
					execFile: async (file, args, options) => {
						const result = await execFileP(file, [...args], {
							...options,
							encoding: "utf8",
						});
						return {
							stdout: String(result.stdout),
						};
					},
					alert: async (verdict, recovery) => {
						const sink = leadPendingAlertHolder.current;
						if (!sink) {
							throw new Error("cmux watcher alert sink is not ready");
						}
						const episode = createHash("sha256")
							.update(verdict.episodeKey ?? verdict.branch)
							.digest("hex")
							.slice(0, 24);
						await sink.alert({
							...cmuxWatcherAlertRoute,
							eventId: `cmux_watcher_stalled:${verdict.branch}:${episode}`,
							eventType: "cmux_watcher_stalled",
							title: `cmux watcher unhealthy (${verdict.branch})`,
							body: `${verdict.detail}; recovery=${
								recovery
									? `${recovery.ok ? "healthy" : "failed"}: ${recovery.detail}`
									: "not attempted (safety matrix)"
							}`,
							severity: "severe",
						});
					},
				})
			: null;

	const gatePoller = new GatePoller({
		pollIntervalMs: 3_000,
		recordSpan: (name, startMs, endMs) =>
			eventLoopAttribution.recordSpan(name, startMs, endMs),
		projects,
		store,
		runtimeRegistry: registry,
		ensureShipRelevantDiff,
		onIssueGateSupersedeTick: issueGateSupersedeTick,
		onWorkflowGateMaterializeTick: workflowGateMaterializeTick,
		onLandOperationTick: landOperationTick,
		onLeadPatrolTick: leadPatrolTickPass,
		onSummaryAbsorptionTick: summaryAbsorptionPass,
		onPatrolOrphanSweepTick: patrolOrphanSweepPass,
		...(cmuxWatcherPatrol
			? { onCmuxWatcherPatrolTick: () => cmuxWatcherPatrol.tick() }
			: {}),
		onReconcilePatrolTick: async () => {
			// First rollout window: inventory historical terminal-run residue but do
			// not create a collection receipt or tear anything down. Explicit
			// force-cancel receipts above are safe to resume immediately.
			await reconcileWorkflowRunCollections({
				store,
				collect: workflowRunCollector,
				log: (message) => console.warn(message),
			});
			for (const candidate of store.listWorkflowResumeCheckpointPruneWork({
				now: new Date().toISOString(),
				limit: 3,
			})) {
				const project = projects.find(
					(entry) => entry.projectName === candidate.projectName,
				);
				if (!project) continue;
				const now = new Date().toISOString();
				if (
					!store.isWorkflowResumeCheckpointRefPrunable({
						...candidate,
						now,
					})
				) {
					continue;
				}
				try {
					workflowResumeCheckpointStore.pruneRef({
						project: candidate.projectName,
						projectRoot: project.projectRoot,
						ref: candidate.ref,
						anchor: candidate.anchor,
					});
				} catch (error) {
					console.warn(
						`[workflow-resume] checkpoint prune failed for ${candidate.ref}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			for (const attachment of store.listWorkflowResumeEnvelopeStampWork(3)) {
				try {
					store.stampWorkflowResumeAttachmentEnvelope({
						attachmentId: attachment.attachment_id,
						now: new Date().toISOString(),
					});
				} catch (error) {
					console.warn(
						`[workflow-resume] envelope stamp failed for ${attachment.attachment_id}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			for (const work of store.listWorkflowResumeCheckpointWork({
				now: new Date().toISOString(),
				limit: 3,
			})) {
				const project = projects.find(
					(candidate) => candidate.projectName === work.project_name,
				);
				if (!project) continue;
				try {
					reconcileWorkflowResumeCheckpoint({
						stateStore: store,
						checkpointStore: workflowResumeCheckpointStore,
						attachment: work.attachment,
						project: work.project_name,
						projectRoot: project.projectRoot,
						now: new Date().toISOString(),
					});
				} catch (error) {
					console.warn(
						`[workflow-resume] checkpoint reconcile failed for ${work.attachment.attachment_id}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			await runWorkflowResumeShadowTick({
				store,
				observeEnvelope: async (opportunity) => {
					if (!config.linearApiKey) {
						return { source: "issue_body", unavailable: true };
					}
					try {
						const { LinearClient } = await import("@linear/sdk");
						const issue = await new LinearClient({
							apiKey: config.linearApiKey,
						}).issue(opportunity.issueId);
						return {
							source: "issue_body",
							digest: createHash("sha256")
								.update(issue.description ?? "")
								.digest("hex"),
						};
					} catch {
						return { source: "issue_body", unavailable: true };
					}
				},
				verifyAnchor: ({ attachment, effectiveAnchor }) => {
					const run = store.getWorkflowRun(attachment.run_id);
					const project = projects.find(
						(candidate) => candidate.projectName === run?.project_name,
					);
					const repoIdentity = attachment.repo_identity;
					if (
						!project ||
						!repoIdentity ||
						(repoIdentity !== project.projectName &&
							(!pathIsAbsolute(repoIdentity) ||
								resolve(repoIdentity) !== resolve(project.projectRoot)))
					) {
						return false;
					}
					workflowResumeCheckpointStore.recover({
						project: project.projectName,
						projectRoot: project.projectRoot,
						ref: attachment.anchor_ref!,
						anchor: effectiveAnchor,
					});
					return true;
				},
				env: process.env,
				now: new Date().toISOString(),
				log: (message) => console.warn(message),
			});
			await drainTurnWakeOutbox({
				projectNames: projects.map((project) => project.projectName),
				commDbPathForProject,
				onSecondPushUnacked: async (wake, projectName) => {
					// Codex mailbox delivery alone cannot revive a goal-achieved TUI.
					// After the one verified retry, type a bounded pointer whose only
					// authority is the exact durable TURN tuple re-checked at send time.
					if (wake.backend !== "codex") return { ok: true };
					const session = store.getSession(wake.execution_id);
					if (!session || session.project_name !== projectName) {
						return { ok: false, error: "turn_pointer_session_missing" };
					}
					let leadId: string;
					try {
						leadId = resolveLeadForIssue(
							projects,
							session.project_name,
							parseJsonStringArray(session.issue_labels),
						).lead.agentId;
					} catch (error) {
						return {
							ok: false,
							error: `turn_pointer_lead_unresolved:${(error as Error).message}`,
						};
					}
					const capture = await defaultCaptureSession(
						wake.execution_id,
						session.project_name,
						100,
					);
					if (isCaptureError(capture)) {
						return {
							ok: false,
							error: `turn_pointer_capture_failed:${capture.error}`,
						};
					}
					const outcome = await attemptRunnerRecoveryNudge(
						{
							mode: "turn_pointer",
							actor: "turn-wake-patrol",
							executionId: wake.execution_id,
							leadId,
							fingerprint: fingerprintOutput(capture.output),
							turnWakeId: wake.wake_id,
						},
						{
							store,
							projects,
							captureSessionFn: defaultCaptureSession,
							hasPendingGate: hasPendingGateFromCommDb,
							isTurnWakeBindingLive: (executionId, projectName, wakeId) => {
								if (
									executionId !== wake.execution_id ||
									projectName !== session.project_name ||
									wakeId !== wake.wake_id
								) {
									return false;
								}
								const db = new CommDB(commDbPathForProject(projectName));
								try {
									if (db.getTurnWake(wakeId)?.state === "acked") return false;
								} finally {
									db.close();
								}
								return (
									store.inspectWorkflowTurnWakeRetry({
										wakeId,
										executionId,
										...(wake.activation_id
											? { activationId: wake.activation_id }
											: {}),
										epoch: wake.epoch,
									}).disposition === "deliver"
								);
							},
							sendKeys: sendKeysToWindow,
							getTmuxTarget: getTmuxTargetFromCommDb,
							now: () => Date.now(),
							nextAuditSeq: () => ++turnPointerAuditSeq,
						},
					);
					return outcome.body.nudged
						? { ok: true }
						: {
								ok: false,
								error: outcome.body.error ?? "turn_pointer_refused",
							};
				},
				canDeliver: async (wake) =>
					store.inspectWorkflowTurnWakeRetry({
						wakeId: wake.wake_id,
						executionId: wake.execution_id,
						...(wake.activation_id ? { activationId: wake.activation_id } : {}),
						epoch: wake.epoch,
					}),
				onReceipt: async (receipt) => {
					if (!receipt.activation_id || receipt.acked_at === null) {
						return "not_applicable";
					}
					if (receipt.purpose === "workflow_rework") {
						const activation = store.getWorkflowActivation(
							receipt.activation_id,
						);
						const run = activation
							? store.getWorkflowRun(activation.run_id)
							: undefined;
						if (!activation || !run) return "retry";
						const projected = store.recordWorkflowReworkWakeReceipt({
							activationId: receipt.activation_id,
							executionId: receipt.execution_id,
							epoch: receipt.epoch,
							ackedAt: new Date(receipt.acked_at).toISOString(),
							alertIdentity: resolveWorkflowRunAlertIdentity({
								store,
								projects,
								defaultLeadAgentId: config.defaultLeadAgentId,
								projectName: run.project_name,
								issueId: run.issue_id,
								runId: run.run_id,
								log: (message) => console.warn(`[turn-wake] ${message}`),
							}),
						});
						if (projected.ok) return "projected";
						console.warn(
							`[turn-wake] rework receipt projection held for ${receipt.wake_id}: ${projected.reason}`,
						);
						return "retry";
					}
					if (receipt.purpose !== "workflow_ship_carrier") {
						return "not_applicable";
					}
					const projected = store.recordWorkflowCarrierWakeReceipt({
						activationId: receipt.activation_id,
						executionId: receipt.execution_id,
						epoch: receipt.epoch,
						ackedAt: new Date(receipt.acked_at).toISOString(),
					});
					if (projected.ok) return "projected";
					console.warn(
						`[turn-wake] carrier receipt projection held for ${receipt.wake_id}: ${projected.reason}`,
					);
					return "retry";
				},
			});
			await reconcileWorkflowTurnLedgers({
				store,
				commDbPathForProject,
				alertEnabled: storeWorkflowTurnDivergenceAlertsEnabled(flagStore),
				resolveAlertIdentity: (expectation) =>
					resolveWorkflowRunAlertIdentity({
						store,
						projects,
						defaultLeadAgentId: config.defaultLeadAgentId,
						projectName: expectation.projectName,
						issueId: expectation.issueId,
						runId: expectation.runId,
						log: (message) => console.warn(`[workflow-turn-ledger] ${message}`),
					}),
				onError: (message) => console.warn(`[workflow-turn-ledger] ${message}`),
			});
			await projectWorkflowEngineParkOutbox({
				store,
				projectNames: projects.map((project) => project.projectName),
				commDbPathForProject,
			});
			await terminalGateRetirement.pass();
			orphanFounderReviewMonitorTick();
			// Destructive mailbox hygiene is last and isolated: a config/SQLite
			// failure must not skip the ship-critical reconcile work above.
			try {
				leadInboxRuntime.reconcileRetiredLeadMailboxes();
			} catch (error) {
				console.warn(
					`[lead-inbox] retired-recipient reconcile failed closed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
		// FLY-1560: both holders are populated ~1.5k lines below, well after
		// gatePoller.start(). The readiness probes stop an unarmed boot tick from
		// burning the cadence anchor (which would defer the boot reconcile by a
		// full ~10min cadence while looking like it had already run).
		onLeadReconcileTick: () => leadReconcilePassHolder.current?.(),
		onLeadReconcileReady: () => leadReconcilePassHolder.current !== null,
		onRunnerQuotaScanTick: () => runnerQuotaScanPassHolder.current?.(),
		onRunnerQuotaScanReady: () => runnerQuotaScanPassHolder.current !== null,
		onFlagScanTick: async () => {
			await flagRetirementScanner?.scanIfDue();
		},
		onFlagScanReady: () => flagRetirementScanner !== undefined,
		onFounderDecisionConvergenceTick: async () => {
			await founderDecisionConvergenceTick();
		},
		// FLY-1282 Part D: disposition-receipt delivery has its own stage and
		// single-flight. Receipt delivery is permanently enabled.
		onDispositionReceiptTick: createDispositionReceiptPass({
			store,
			projects: projects ?? [],
			globalBotToken: config.discordBotToken,
		}),
		// FLY-945 Fix D: run the sweeper on the patrol cadence (zero new timer).
		externalMergeReconcile: () => externalMergeReconciler.pass(),
		alertsEnabled: () => storeAlertSystemEnabled(flagStore),
		leadAlertSink: {
			alert: (p) =>
				leadPendingAlertHolder.current
					? leadPendingAlertHolder.current.alert(p)
					: Promise.resolve({ skipped: "unknown-lead" } as AlertResult),
		},
		chatThreadsEnabled: config.chatThreadsEnabled,
		// FLY-907 (Step 4.5): issue-display reconcile sweep — piggybacked on this
		// existing 60-tick poll cadence (zero new timer). The holder is populated
		// post-listen; an empty holder makes the tick a no-op.
		onDisplayReconcileTick: () =>
			issueDisplayRefreshHolder.current?.runSweep?.(),
		// FLY-605: bidirectional in-thread founder relay fallback. owner/token
		// from config; the founder-reply cursor persists across restarts.
		discordBotToken: config.discordBotToken,
		discordOwnerUserId: config.discordOwnerUserId,
		tryFounderShipApproval: founderShipApprovalCallback,
		readCurrentBinding: (executionId, questionId, prHeadSha) =>
			readCurrentGateMessageBinding(store, executionId, questionId, prHeadSha),
		// FLY-1099 §4.3: the deferred-approval rebind pass — the SAME production
		// post-write hook + canonical founder id the live text path uses (no
		// second authorization chain).
		deferredRebind: {
			canonicalFounderId: founderCanonicalId,
			gateAuthorityView,
			onResponseWritten: (info) =>
				founderShipPostWriteHook({
					executionId: info.executionId,
					questionId: info.questionId,
					leadId: info.actor,
					answer: info.answer,
					db: info.db as unknown as Parameters<
						typeof founderShipPostWriteHook
					>[0]["db"],
				}),
		},
		mergedGateGuard,
		// FLY-799: founder ✅-reaction ship approval (per-gate reaction poll).
		tryFounderReactionApproval: founderReactionApprovalCallback,
		cursorStore: founderReplyCursorPath
			? new FileInboundCursorStore(founderReplyCursorPath)
			: undefined,
		// FLY-513: periodic global-codex drift detection (path-only, zero new timer).
		// Default-on; `FLYWHEEL_CODEX_HEALTH_GUARD=0` short-circuits inside the probe.
		onHealthTick: codexHealthEnabled
			? () => {
					void reportCodexGlobalHealth(metaAlertNotifier);
				}
			: undefined,
	});
	// FLY-513: one-shot boot check — surfaces an already-contaminated global codex
	// immediately at startup (the periodic probe then covers the running window).
	// Non-fatal: reportCodexGlobalHealth never throws.
	if (codexHealthEnabled) {
		void reportCodexGlobalHealth(metaAlertNotifier);
	}

	// FLY-314: roundtable per-topic auto-thread (Phase 1). Default OFF —
	// loadRoundtableConfig returns undefined unless the roundtable channel is set (FLY-1243),
	// so the byte-compat path constructs no poller and changes no behavior. When
	// enabled, this is the central Bridge listener that auto-creates a thread off a
	// roundtable topic message + pulls configured leads in as members. Reply-in-
	// thread routing is Phase 2 (not here).
	let roundtableThreadManager: RoundtableThreadManager | undefined;
	const roundtableConfig = loadRoundtableConfig(process.env);
	if (roundtableConfig) {
		roundtableThreadManager = new RoundtableThreadManager({
			store,
			channelId: roundtableConfig.channelId,
			botToken: roundtableConfig.botToken,
			botUserId: roundtableConfig.botUserId,
			trigger: buildTopicTrigger(roundtableConfig.trigger),
			memberUserIds: roundtableConfig.memberUserIds,
			founderUserId: roundtableConfig.founderUserId,
			triggerMode: roundtableConfig.triggerMode,
			threadOwnBotMessages: roundtableConfig.threadOwnBotMessages,
			cursorStore: new FileInboundCursorStore(roundtableConfig.cursorPath),
			archiveDefaultProvider: makeChannelArchiveDefaultProvider({
				channelId: roundtableConfig.channelId,
				botToken: roundtableConfig.botToken,
				logger: { warn: (message) => console.warn(message) },
			}),
			logger: {
				warn: (message, context) => console.warn(message, context ?? ""),
				log: (message) => console.log(message),
			},
			onArchiveDefaultUnresolved: async ({ channelId, reason, detail }) => {
				await metaAlertNotifier.notify({
					reason: "roundtable_archive_default_unresolved",
					title: "Roundtable thread creation is waiting for channel policy",
					body:
						`Bridge held roundtable thread creation in channel ${channelId}; ` +
						`parent archive policy is unresolved (${reason}${detail ? `: ${detail}` : ""}). ` +
						"Set/read default_auto_archive_duration before retrying; no 4320-minute fallback thread was created.",
				});
			},
			onPermanentPatchFailure: async ({ threadId, status, fields }) => {
				await metaAlertNotifier.notify({
					reason: "roundtable_patch_permanent_failure",
					title: "Roundtable thread repair permanently failed",
					body:
						`Bridge could not converge thread ${threadId} in channel ${roundtableConfig.channelId}: ` +
						`Discord HTTP ${status}; fields=${Object.keys(fields).join(",") || "none"}. ` +
						"Check the poller bot's MANAGE_THREADS permission.",
				});
			},
			pollIntervalMs: roundtableConfig.pollIntervalMs,
		});
		await roundtableThreadManager.start();
		// FLY-314 fix (Codex R1 MEDIUM#6): loud startup line so a Bridge restart PROVES
		// the intended trigger mode + tuning loaded (over-spawn was a mis-set mode).
		console.log(
			`[Bridge] RoundtableThreadManager started — channel=${roundtableConfig.channelId}, ` +
				`trigger=${roundtableConfig.triggerMode}, minMentions=${roundtableConfig.trigger.minMentions ?? "-"}, ` +
				`leadIds=${roundtableConfig.trigger.leadUserIds?.length ?? 0}, members=${roundtableConfig.memberUserIds.length}, ` +
				`founder=${roundtableConfig.founderUserId ? "set" : "unset"}, threadOwnBot=${roundtableConfig.threadOwnBotMessages}`,
		);
	}

	// FLY-307 C: Bridge event-loop self-guard — converts a main-loop hang
	// (e.g. a spinning sql.js/WASM trap) into a launchd-restartable crash, the
	// gap launchd KeepAlive can't cover. Permanently enabled in production and
	// auto-disabled under VITEST at this wiring boundary
	// so general Bridge integration suites are never SIGKILLed by the worker
	// (the dedicated loop-guard tests exercise the real worker directly).
	const bridgeLoopGuard = new BridgeEventLoopGuard({
		enabled: !process.env.VITEST,
		bootTs: bridgeBootTs,
		pid: process.pid,
		syncOpMarkerPath: syncOpMarkerPath(process.pid, process.env),
	});
	bridgeLoopGuard.start();
	if (bridgeLoopGuard.isEnabled()) {
		console.log(
			"[Bridge] EventLoopGuard started (worker-thread heartbeat; SIGKILL self on a confirmed main-loop stall → KeepAlive restart)",
		);
	}

	// FLY-83 (retired in FLY-1560): external pane-hash observation for
	// Claude Code TUI. Pairs with scripts/lead-alert.sh (shell-owned alert
	// path) via cross-process claims.db dedup.
	//
	// Fix 2: claimsClaimer runs the SAME atomic INSERT-OR-IGNORE that
	// scripts/lead-alert.sh runs, so Bridge and shell genuinely race for
	// the same row instead of writing to two unrelated dedup stores.
	const claimsReader = createClaimsReader();
	const claimsClaimer = createClaimsClaimer();
	const leadPaneCaptureFn = defaultLeadPaneCapture();
	// FLY-182 Track B / FLY-513: Discord-independent meta-alert sink
	// (`metaAlertNotifier`). Now constructed earlier (just before GatePoller) so
	// FLY-513's global-codex drift probe reuses the same instance; the desktop-
	// capability probe ran there. LeadAlert must never fail silently — when the
	// Discord path is broken (config gap, permanent failure, drain stuck, Lead not
	// consuming), it surfaces via osascript + local file through this same notifier.
	// FLY-368 (rework): unified alert channel + owner-attributed send + per-error
	// threading + Cass-driven conservative auto-repair. ALL env-gated, default-off
	// → unset = byte-identical to today. Aggregation/routing lives HERE in the
	// always-up Bridge so the channel survives Lead restarts. The root alert posts
	// via the STUCK agent's OWN bot (Bridge holds the token; works even if the
	// agent is dead) → fallback Cass → alphabetical fleet.
	const unifiedAlertChannelId = process.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID;
	const repairBotTokenEnvName =
		process.env.FLYWHEEL_ALERT_REPAIR_BOT_TOKEN_ENV ?? "CASS_BOT_TOKEN";
	// FLY-1243: FLYWHEEL_ALERT_THREADS + FLYWHEEL_AUTO_REPAIR retired (固化
	// default-on). Both are now gated purely by their companion config — the
	// unified alert channel + a resolvable repair chain — so an unconfigured
	// Bridge (no channel) stays byte-compat (no hub, no auto-repair).
	const unifiedAlert = unifiedAlertChannelId
		? {
				channelId: unifiedAlertChannelId,
				repairBotTokenEnv: repairBotTokenEnvName,
			}
		: undefined;

	// FLY-927 (T1): unified-channel root-message rate cap (production: 20/min).
	// Env unset ⇒ no limiter ⇒ byte-compat unlimited sends.
	const alertRatePerMin = rateLimitPerMinuteFromEnv(process.env);
	const leadAlertNotifier = new LeadAlertNotifier({
		store,
		projects,
		deliveryEnabled: () => storeAlertSystemEnabled(flagStore),
		claimsReader,
		claimsClaimer,
		metaAlert: metaAlertNotifier,
		unifiedAlert,
		...(alertRatePerMin
			? { rateLimiter: createAlertRateLimiter(alertRatePerMin) }
			: {}),
		replayFreshnessProbe: (input) =>
			fleetSensorsHolder.current?.replayFreshness(input) ?? null,
		// FLY-529: QA Testing Room alert isolation. Unset env → both fields
		// undefined → notifier keeps its shared production defaults (byte-compat).
		// The test Bridge sets FLYWHEEL_ALERT_QUEUE_DIR / _DEADLETTER_DIR to slot-
		// local paths so test alerts never land in the production queue/dead-letter
		// dirs the live Bridge drainer reads.
		...resolveAlertDirsFromEnv(process.env),
	});
	tuiWindowAlertHolder.lost = async (evidence) => {
		const reason = evidence.lastFailure
			? `${evidence.lastFailure.category}/${evidence.lastFailure.reason}`
			: "unknown";
		await (routedAlertSinkHolder.current ?? leadAlertNotifier).alert({
			leadId: evidence.leadId,
			projectName: evidence.projectName,
			eventId: `tui-window-lost:${evidence.executionId}:${evidence.episodeStartedAt}`,
			eventType: "tui_window_lost",
			title: `Codex runner TUI not visible (${evidence.issueId})`,
			body: `The founder-facing Codex pane never acquired an immutable tmux window id. trigger=${evidence.trigger}; attempts=${evidence.attempts}; last=${reason}. The resident run continued; inspect execution ${evidence.executionId}.`,
			severity: "warning",
			sessionKey: evidence.executionId,
			episodeId: `tui-window-lost:${evidence.executionId}:${evidence.episodeStartedAt}`,
		});
	};
	tuiWindowAlertHolder.restored = (executionId) => {
		console.log(`[runner-tui-window] restored execution=${executionId}`);
	};
	// FLY-1718 P4: startup + periodic crash convergence. A durable binding can
	// re-drive activation/settlement; pending fifth-strike alerts retain their
	// StateStore row until the notifier has durably sent/queued/dead-lettered it.
	let doaBackoffMaintenanceBusy = false;
	const runDoaBackoffMaintenance = async (): Promise<void> => {
		if (doaBackoffMaintenanceBusy) {
			return;
		}
		doaBackoffMaintenanceBusy = true;
		try {
			await repairDoaBackoffReservations({
				store,
				withIssueMutex: issueMutex,
			});
			await drainDoaBackoffAlerts({
				store,
				alert: (payload) => leadAlertNotifier.alert(payload),
			});
		} catch (error) {
			console.warn(
				`[doa-backoff] maintenance pass failed: ${(error as Error).message}`,
			);
		} finally {
			doaBackoffMaintenanceBusy = false;
		}
	};
	void runDoaBackoffMaintenance();
	const doaBackoffMaintenanceTimer = setInterval(
		() => void runDoaBackoffMaintenance(),
		30_000,
	);
	modelTransportAlertSink.current = {
		stall: async (input) => {
			await leadAlertNotifier.alert({
				leadId: input.leadId,
				projectName: input.projectName,
				eventId:
					`codex_model_transport_unavailable:${input.leadId}:` +
					Math.floor(Date.parse(input.at) / (30 * 60_000)),
				eventType: "inbox_loop_stalled",
				title: "Codex Lead mailbox transport unavailable",
				body:
					`Mailbox delivery to ${input.leadId} cannot reach the Codex inbox ` +
					`transport and is retrying until the configured terminal cap. Error: ${input.error}`,
				severity: "severe",
			});
		},
		recovered: async (input) => {
			console.info("codex_model_transport_recovered", input);
		},
		exhausted: async (input) => {
			const result = await leadAlertNotifier.alert({
				leadId: input.leadId,
				projectName: input.projectName,
				eventId:
					`codex_model_transport_exhausted:${input.leadId}:` +
					createHash("sha256")
						.update(input.deliveryIds.join("\n"))
						.digest("hex")
						.slice(0, 16),
				eventType: "delivery_dead_letter",
				title: "Codex Lead mailbox transport retries exhausted",
				body:
					`Mailbox delivery to ${input.leadId} exhausted its transport retry ` +
					`budget on attempt ${input.attempt} and will move to DEAD. Delivery IDs: ` +
					`${input.deliveryIds.join(", ")}. Error: ${input.error}`,
				severity: "severe",
			});
			if (result.skipped === "duplicate") return;
			if (result.deadLettered || result.skipped) {
				throw new Error(
					`Terminal model transport alert not delivered: ${result.skipped ?? "dead_lettered"}`,
				);
			}
		},
	};
	for (const input of pendingModelTransportStalls.values()) {
		void modelTransportAlertSink.current.stall(input).catch((error) => {
			console.warn("codex_model_transport_alert_flush_failed", {
				leadId: input.leadId,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}
	pendingModelTransportStalls.clear();
	discordMailboxAlertSink.current = {
		undeliverable: async (input) => {
			const result = await leadAlertNotifier.alert({
				leadId: input.leadId,
				projectName: input.projectName,
				eventId:
					`discord_mailbox_undeliverable:${input.leadId}:` +
					createHash("sha256")
						.update(input.deliveryIds.join("\n"))
						.digest("hex")
						.slice(0, 16) +
					`:${input.attempt}`,
				eventType: "delivery_dead_letter",
				title: "Discord mailbox message quarantined",
				body:
					`Discord mailbox delivery to ${input.leadId} was quarantined before ` +
					`reaching the Lead. Delivery IDs: ${input.deliveryIds.join(", ")}. ` +
					`Reason: ${input.reason}`,
				severity: "severe",
			});
			if (result.skipped === "duplicate") return;
			if (result.deadLettered || result.skipped) {
				throw new Error(
					`Discord mailbox quarantine alert not delivered: ${result.skipped ?? "dead_lettered"}`,
				);
			}
		},
		stall: async (input) => {
			await leadAlertNotifier.alert({
				leadId: input.leadId,
				projectName: input.projectName,
				eventId:
					`discord_mailbox_delivery_stalled:${input.leadId}:` +
					Math.floor(Date.parse(input.at) / (30 * 60_000)),
				eventType: "inbox_loop_stalled",
				title: "Discord mailbox delivery stalled",
				body:
					`Mailbox delivery to ${input.leadId} cannot reach the Discord route ` +
					`and is retrying until the configured terminal cap. Error: ${input.error}`,
				severity: "severe",
			});
		},
	};
	for (const input of pendingDiscordMailboxStalls.values()) {
		void discordMailboxAlertSink.current.stall(input).catch((error) => {
			console.warn("discord_mailbox_stall_alert_flush_failed", {
				leadId: input.leadId,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}
	pendingDiscordMailboxStalls.clear();
	// FLY-1586 R2 HIGH-5 — bind the quarantine alert sink now that the notifier
	// exists. Direct Discord path on purpose: an alert about the inbox being
	// wedged must not travel through the inbox.
	quarantineAlertSink.current = async (input) => {
		const result = await leadAlertNotifier.alert({
			leadId: input.leadId,
			projectName: input.projectName,
			eventId: `legacy_row_quarantined:${input.leadId}:${input.seq}`,
			eventType: "legacy_row_quarantined",
			title: "Legacy inbox row quarantined during cutover",
			body:
				`lead_events seq=${input.seq} was refused by the boot cutover ` +
				`(${input.reason}) and skipped so the rest of the fleet could ` +
				"recover. It was NOT delivered. Inspect legacy_cutover_quarantine " +
				"and decide replay or discard.",
			severity: "warning",
		});
		// R3 HIGH — `alert()` RESOLVES for permanent failures (`deadLettered`,
		// `skipped`). Ignoring the result and marking the quarantine row
		// `alert_accepted` would record "an operator was told" about an alert the
		// notifier had just given up on — the same lie this alert exists to
		// prevent. Throw so the drain records an honest failure instead.
		if (result.deadLettered || result.skipped) {
			throw new Error(
				`quarantine alert not delivered: ${result.skipped ?? "dead_lettered"}`,
			);
		}
	};
	deadLetterAlertSink.current = async (input) => {
		await leadAlertNotifier.alert(
			{
				leadId: input.leadId,
				projectName: input.projectName,
				eventId: input.eventId,
				eventType: "mailbox_dead_letter",
				title:
					input.sourceKind === "lead_unacked"
						? `${input.recipient} mailbox messages were not acknowledged`
						: `Mailbox dead letters have no owning Lead: ${input.recipient}`,
				body: input.summary,
				severity: "warning",
			},
			{
				replayAfterAmbiguousAttempt: input.replayAfterAmbiguousAttempt,
			},
		);
	};
	// R3 HIGH — the loop starts long before this binding exists, so cutover may
	// already have burned a retry attempt against an unbound sink. Drain once now
	// that a real notifier is available, otherwise a same-boot quarantine waits
	// for the NEXT restart to even be attempted.
	void leadInboxRuntime.drainQuarantineAlertsNow();
	void leadInboxRuntime.drainDeadLetterAlertsNow();
	// FLY-907: build the unified issue-display refresher. The holder is read
	// late-bound by EVERY trigger surface (applyTransition hook,
	// DirectEventSink, event router, actions router, park/wake effects, sweep,
	// founder-consent gate hook), so filling it here (post-listen) is correct;
	// the GatePoller sweep reconciles anything that changed before this point.
	// Chat threads off → holder stays empty and every trigger remains dormant.
	if (chatThreadCreator) {
		const issueDisplayRefresher = new IssueDisplayRefresher({
			store,
			projects,
			config,
			chatThreadCreator,
			flags: {
				issueStatusEmojiEnabled: true,
				issueAttachPinEnabled: true,
			},
			keepAliveEnabled: () => true,
			// FLY-623 interaction: while HeartbeatService owns the ⚠️重连中 title,
			// face A defers instead of overwriting it with a derived badge.
			isReconnectTitleActive: (execId) =>
				reconnectHolder.current?.isReconnectTitleActive(execId) ?? false,
		});
		issueDisplayRefreshHolder.current = issueDisplayRefresher;
		for (const issueId of pendingIssueDisplayRefreshes) {
			issueDisplayRefresher.enqueue(issueId);
		}
		pendingIssueDisplayRefreshes.clear();
		const restoreReconnectTitles = (executionIds?: readonly string[]) => {
			const restoredIssues = settleReconnectTitlesAndRefresh(
				heartbeatService,
				issueDisplayRefresher,
				executionIds,
			);
			if (restoredIssues.length > 0) {
				console.log(
					`[issue-display] queued reconnect-title restore for ${restoredIssues.length} issue(s)`,
				);
			}
		};
		// Runtime re-entries after this point keep the canonical title and cost zero
		// Discord renames. Then drain every title episode that became active before
		// this late-bound refresher existed (boot seed or an early heartbeat tick).
		heartbeatService.markReconnectTitleRefresherReady();
		// Preserve the early-accepted-event race guarantee: an explicit boot id
		// still gets a canonical enqueue even if the event already cleared both
		// reconnect sets before the refresher bound.
		restoreReconnectTitles(bootReconnectExecutionIds);
		restoreReconnectTitles();
		console.log(
			"[issue-display] FLY-907 unified refresher wired (derive-from-state, all lifecycle triggers)",
		);
	}

	// FLY-1188 §7.1 / FLY-1278 / FLY-2037: build the codex-author review
	// coordinator and redrive jobs plus unsent governance audit posts. Jobs stay
	// serial per execution, without a coordinator-wide concurrency ceiling. Both
	// runner routes read the holder at request time (503 until filled). Review
	// governance events use the late-bound routed sink, so the eventual
	// AlertChannelHub owns dedup/tickets.
	{
		const commRoot =
			process.env.FLYWHEEL_COMM_ROOT?.trim() ||
			join(homedir(), ".flywheel", "comm");
		const reviewThreadEffects = new ReviewThreadEffect({
			store,
			projects,
			config,
		});
		const emitReviewAlert = createReviewAlertEmitter({
			store,
			projects,
			alert: (payload) =>
				(routedAlertSinkHolder.current ?? leadAlertNotifier).alert(payload),
		});
		reviewCoordinatorHolder.current = new ReviewRequestCoordinator({
			store,
			commDbPathFor: (projectName) => join(commRoot, projectName, "comm.db"),
			openCommDb: (path) => new CommDB(path, false),
			reviewerTimeoutMs: parseReviewerTimeoutMs(
				process.env.FLYWHEEL_CLAUDE_REVIEW_TIMEOUT_MS,
			),
			listActiveReviewFindingRulings: ({ projectName, issueId }) =>
				store
					.listActiveReviewFindingRulings(projectName, issueId)
					.map(toReviewFindingRulingSnapshot),
			emitReviewAlert,
			postReviewRulingThread: (input) =>
				reviewThreadEffects.postThreadResult(input),
			// FLY-1257 HIGH-1: flip the answered review gate's marker so a resident
			// codex `/goal` resumes at once (its isWaiting() reads answeredAt),
			// instead of waiting for the deadline watcher. Execution-guarded no-op
			// for a foreign/missing/already-answered marker.
			markGateAnswered: (questionId, executionId) => {
				markGateMarkerAnsweredForExecution(
					defaultGateMarkerDir(process.env),
					questionId,
					executionId,
				);
			},
		});
		const redriven = reviewCoordinatorHolder.current.redriveOnBoot();
		if (redriven > 0) {
			console.log(
				`[review-coordinator] boot redrive: ${redriven} review job(s) re-enqueued`,
			);
		}
	}

	const codexReviewEffects = new CodexReviewEffects({
		projects,
		leadAlertNotifier: {
			alert: (payload) =>
				(routedAlertSinkHolder.current ?? leadAlertNotifier).alert(payload),
		},
	});
	const reviewAuthorizationAlerts = new ReviewAuthorizationAlerts({
		projects,
		leadAlertNotifier: {
			alert: (payload) =>
				(routedAlertSinkHolder.current ?? leadAlertNotifier).alert(payload),
		},
		logger: console,
	});
	reviewAuthorizationAlertsHolder.current = reviewAuthorizationAlerts;
	codexReviewHoldHolder.current = new CodexReviewHoldCoordinator({
		store,
		queueCodexInstruction: ({ session }) =>
			codexReviewEffects.queueCodexInstruction({ session }),
		alertMissingHead: ({ session }) =>
			codexReviewEffects.alertCodexGateBlocked({ session }),
		logger: console,
	});
	// Neutral review recovery is independent of dispatcher availability.
	void codexReviewHoldHolder.current
		.reconcileCodexHolds()
		.catch((err) =>
			console.warn(
				`[codex-review-hold] reconcileCodexHolds failed: ${(err as Error).message}`,
			),
		);

	// FLY-172/FLY-1505: drain complete-failed markers only AFTER the durable
	// LeadAlertNotifier-backed effects exist. Settling a ship-attempt marker can
	// suppress automatic re-wake, so deleting it before the alert sink is ready
	// would strand a dead Runner silently.
	try {
		await reconcileCompleteFailedMarkers({
			store,
			bridgeBaseUrl: loopbackBaseUrl,
			ingestToken: config.ingestToken,
			materializedHeadAuthority,
			transitionOpts,
			getTmuxTarget: getTmuxTargetFromCommDb,
			isTmuxWindowAlive,
			onTerminalStatusPersisted: onMarkerTerminalStatusPersisted,
			alertMergeWithoutApproval: (session, reason) => {
				void reviewAuthorizationAlerts.alertMergeWithoutApproval(
					session,
					reason,
				);
			},
			alertShipAttemptFailed: (session, reason) => {
				return reviewAuthorizationAlerts.alertShipAttemptFailed(
					session,
					reason,
				);
			},
			alertCompleteMarkerHeld: (args) => {
				return reviewAuthorizationAlerts.alertCompleteMarkerHeld(args);
			},
		});
	} catch (err) {
		console.error(
			`[Bridge] FLY-172 boot marker drain failed (non-fatal): ${(err as Error).message}`,
		);
	}
	// FLY-1505 M1: the first GatePoller tick may re-wake an approved ship
	// runner. Start it only after durable failed-attempt markers have restored
	// their suppression state (or the drain has failed loudly and retained them).
	gatePoller.start();

	try {
		const activateWakeHolder = (
			session: WorkflowActorSession,
			cause: HolderWakeCause,
		) =>
			activateHolderForWake(
				{
					transitionOpts,
					openCommDb: (projectName) =>
						new CommDB(commDbPathForProject(projectName)),
					resolveLeadId: (target) => {
						const fresh = store.getSession(target.execution_id);
						if (!fresh) return undefined;
						try {
							return resolveLeadForIssue(
								projects,
								fresh.project_name,
								parseJsonStringArray(fresh.issue_labels),
							).lead.agentId;
						} catch {
							return undefined;
						}
					},
					resolveVendor: (target) => {
						const adapter = store.getSession(target.execution_id)?.adapter_type;
						const transport =
							adapter && Object.hasOwn(EXECUTOR_TO_TRANSPORT, adapter)
								? EXECUTOR_TO_TRANSPORT[
										adapter as keyof typeof EXECUTOR_TO_TRANSPORT
									]
								: "claude-code";
						return transport === "none" ? undefined : transport;
					},
					discoverTmuxTarget: discoverTmuxTargetByExecutionId,
					probeDiscoveredTarget: probeRunnerProcessLiveness,
				},
				{ session, cause },
			);

		turnBeltReconcilerHolder.current = new TurnBeltReconciler({
			turnBelt: {
				listTurns: () => {
					const rows: { projectName: string; turn: WorktreeTurnRow }[] = [];
					for (const project of projects) {
						const dbPath = commDbPathForProject(project.projectName);
						if (!ffExistsSync(dbPath)) continue;
						const db = new CommDB(dbPath);
						try {
							for (const turn of db.listTurns()) {
								rows.push({ projectName: project.projectName, turn });
							}
						} finally {
							db.close();
						}
					}
					return rows;
				},
				getTurn: (issueId, projectName) => {
					const dbPath = commDbPathForProject(projectName);
					if (!ffExistsSync(dbPath)) return null;
					const db = new CommDB(dbPath);
					try {
						return db.getTurn(issueId);
					} finally {
						db.close();
					}
				},
				deleteTurn: (issueId, projectName) => {
					const dbPath = commDbPathForProject(projectName);
					if (!ffExistsSync(dbPath)) return;
					const db = new CommDB(dbPath);
					try {
						db.deleteTurn(issueId);
					} finally {
						db.close();
					}
				},
				getSessionForTurnHolder: (executionId) =>
					store.getSession(executionId) as WorkflowActorSession | undefined,
				getActorSessionsForIssue: (issueId) =>
					store.getPhaseSessionsForIssue(issueId) as WorkflowActorSession[],
			},
			isEngineOwnedExecution: (executionId) =>
				store.isWorkflowEngineOwnedExecution(executionId),
			alertWorktreeTakeoverFailure: async ({ session, reason }) => {
				const projectName = session.project_name ?? "";
				let leadId: string | undefined;
				try {
					leadId = resolveLeadForIssue(
						projects,
						projectName,
						parseJsonStringArray(
							store.getSession(session.execution_id)?.issue_labels,
						),
					).lead.agentId;
				} catch {
					console.error(
						`[workflow] worktree takeover failure has no Lead: ${reason}`,
					);
					return;
				}
				await (routedAlertSinkHolder.current ?? leadAlertNotifier).alert({
					leadId,
					projectName,
					eventId: `workflow-worktree-takeover:${session.execution_id}`,
					eventType: "three_stage_takeover_failed",
					title: `Workflow worktree takeover failed — ${session.issue_identifier ?? session.issue_id}`,
					body: reason,
					severity: "warning",
					sessionKey: session.execution_id,
				});
			},
			probeActorAlive: async (session) => {
				const target = getTmuxTargetFromCommDb(
					session.execution_id,
					session.project_name ?? "",
				);
				if (target) return probeRunnerProcessLiveness(target.tmuxWindow);
				if (session.tmux_session) {
					return probeRunnerProcessLiveness(session.tmux_session);
				}
				return "absent";
			},
			grantTurn: ({ issueId, execId, phase, projectName, sourceEventId }) => {
				const db = new CommDB(commDbPathForProject(projectName));
				try {
					db.grantTurn(issueId, execId, phase, Date.now(), {
						project: projectName,
						sourceEventId,
					});
				} finally {
					db.close();
				}
			},
			wakeRecoveredTurn: async ({
				session,
				epoch,
				previousHolderExecId,
				reason,
			}) => {
				const adapter = store.getSession(session.execution_id)?.adapter_type;
				const transport =
					adapter && Object.hasOwn(EXECUTOR_TO_TRANSPORT, adapter)
						? EXECUTOR_TO_TRANSPORT[
								adapter as keyof typeof EXECUTOR_TO_TRANSPORT
							]
						: "claude-code";
				if (transport === "none") {
					return { ok: false, error: `wake_transport_missing:${adapter}` };
				}
				const wakeId = `turn-recovery:${session.issue_id}:${previousHolderExecId}:${epoch - 1}:${session.execution_id}`;
				const db = new CommDB(commDbPathForProject(session.project_name ?? ""));
				try {
					db.clearDeclaredState(session.execution_id);
					return await deliverDurableTurnWake({
						db,
						wakeId,
						execId: session.execution_id,
						issueId: session.issue_id,
						epoch,
						purpose: "turn_recovery",
						fromAgent: "bridge",
						content: `[phase-wake ${wakeId}] TURN recovery granted epoch ${epoch} after ${previousHolderExecId} became stale. FIRST run flywheel-comm turn --exec-id ${session.execution_id}; proceed only if it answers yours. Recovery reason: ${reason}`,
						metadata: {
							kind: "turn_recovery",
							wakeId,
							epoch,
							previousHolderExecId,
						},
						backend: transport,
					});
				} catch (error) {
					return { ok: false, error: (error as Error).message };
				} finally {
					db.close();
					issueDisplayRefreshHolder.current?.enqueue(session.issue_id);
				}
			},
			alertLead: async ({ session, reason }) => {
				const projectName = session.project_name ?? "";
				let leadId: string | undefined;
				try {
					leadId = resolveLeadForIssue(
						projects,
						projectName,
						parseJsonStringArray(
							store.getSession(session.execution_id)?.issue_labels,
						),
					).lead.agentId;
				} catch {
					console.error(`[turn-belt] recovery alert has no Lead: ${reason}`);
					return;
				}
				await (routedAlertSinkHolder.current ?? leadAlertNotifier).alert({
					leadId,
					projectName,
					eventId: `turn-belt-stuck:${session.execution_id}:${Date.now()}`,
					eventType: "three_stage_stuck",
					title: `Workflow TURN recovery — ${session.issue_identifier ?? session.issue_id}`,
					body: reason,
					severity: "warning",
					sessionKey: session.execution_id,
				});
			},
			logger: { warn: (message) => console.warn(`[turn-belt] ${message}`) },
		});

		const assertWorkflowActorWorktreeReady = async (
			session: WorkflowActorSession,
			expectedHeadSha: string,
		) => {
			const worktree = store.getSession(session.execution_id)?.worktree_path;
			if (!worktree)
				return { ok: false as const, reason: "worktree_path_missing" };
			return assertWorkflowWorktreeReady(worktree, expectedHeadSha);
		};

		workflowReworkCoordinatorHolder.current = new WorkflowReworkCoordinator({
			store,
			ownerId: `bridge:${process.pid}`,
			env: process.env,
			reentryEnabled: () => storeWorkflowReworkReentryEnabled(flagStore),
			resolveAlertIdentity: (run) =>
				resolveWorkflowRunAlertIdentity({
					store,
					projects,
					defaultLeadAgentId: config.defaultLeadAgentId,
					projectName: run.project_name,
					issueId: run.issue_id,
					runId: run.run_id,
					log: (message) => console.warn(`[workflow-rework] ${message}`),
				}),
			effects: {
				getActorSession: (executionId) =>
					store.getSession(executionId) as WorkflowActorSession | undefined,
				probeRegistered: async (session) => {
					const target = getTmuxTargetFromCommDb(
						session.execution_id,
						session.project_name ?? "",
					);
					if (!target) return "absent";
					return probeRunnerProcessLiveness(target.tmuxWindow);
				},
				probePersisted: async (session) => {
					if (!session.tmux_session) return "absent";
					return probeRunnerProcessLiveness(session.tmux_session);
				},
				hasHostProcess: hasHostProcessByExecutionId,
				assertWorktreeReady: assertWorkflowActorWorktreeReady,
				activateActorForWake: (session) =>
					activateWakeHolder(session, "workflow_rework"),
				closeActorForReworkSupersession: async ({
					session,
					requestId,
					ownerId,
					generation,
					routeRevision,
					executionId,
				}) => {
					const authorityCheck = async () =>
						store.checkWorkflowReworkSupersessionAuthority({
							requestId,
							ownerId,
							generation,
							routeRevision,
							executionId,
						});
					const result = await closeRunner(
						{
							executionId,
							issueId: session.issue_id,
							projectName: session.project_name ?? "",
							executorType: "phase",
							reason: `rework_supersession:${requestId}`,
							authorityCheck,
						},
						store,
					);
					return {
						ok: result.closed || result.alreadyGone === true,
						...(result.error ? { error: result.error } : {}),
					};
				},
				grantTurn: async (input) => {
					const grantedAtMs = Date.now();
					const db = new CommDB(commDbPathForProject(input.projectName));
					try {
						return grantWorkflowReworkTurn(db, input, grantedAtMs);
					} finally {
						db.close();
					}
				},
				wakeActor: async ({
					session,
					wakeId,
					activationId,
					epoch,
					context,
				}) => {
					const adapter = store.getSession(session.execution_id)?.adapter_type;
					const transport =
						adapter && Object.hasOwn(EXECUTOR_TO_TRANSPORT, adapter)
							? EXECUTOR_TO_TRANSPORT[
									adapter as keyof typeof EXECUTOR_TO_TRANSPORT
								]
							: "claude-code";
					if (transport === "none") {
						return { ok: false, error: `wake_transport_missing:${adapter}` };
					}
					const db = new CommDB(
						commDbPathForProject(session.project_name ?? ""),
					);
					try {
						db.clearDeclaredState(session.execution_id);
						const res = await deliverDurableTurnWake({
							db,
							wakeId,
							execId: session.execution_id,
							issueId: session.issue_id,
							epoch,
							activationId,
							purpose: "workflow_rework",
							fromAgent: "bridge",
							content: `[phase-wake ${wakeId}] Workflow rework activation ${activationId} is ready at TURN epoch ${epoch}. FIRST run flywheel-comm turn --exec-id ${session.execution_id}; proceed only if it answers yours. Rework context: ${JSON.stringify(context)}`,
							metadata: {
								kind: "workflow_rework",
								wakeId,
								activationId,
								epoch,
							},
							backend: transport,
						});
						return res.ok
							? { ok: true }
							: {
									ok: false,
									error: res.error ?? res.skippedReason ?? "wake_failed",
								};
					} catch (error) {
						return { ok: false, error: (error as Error).message };
					} finally {
						db.close();
						issueDisplayRefreshHolder.current?.enqueue(session.issue_id);
					}
				},
			},
		});
		workflowShipCarrierDeliveryHolder.current =
			new WorkflowShipCarrierDeliveryHandler({
				store,
				ownerId: `bridge:${process.pid}:ship-carrier`,
				resolveAlertIdentity: (run) =>
					resolveWorkflowRunAlertIdentity({
						store,
						projects,
						defaultLeadAgentId: config.defaultLeadAgentId,
						projectName: run.project_name,
						issueId: run.issue_id,
						runId: run.run_id,
						log: (message) =>
							console.warn(`[workflow-ship-carrier] ${message}`),
					}),
				effects: {
					getActorSession: (executionId) =>
						store.getSession(executionId) as WorkflowActorSession | undefined,
					assertWorktreeReady: assertWorkflowActorWorktreeReady,
					activateActorForWake: (session) =>
						activateWakeHolder(session, "workflow_rework"),
					grantTurn: async (input) => {
						const db = new CommDB(commDbPathForProject(input.projectName));
						try {
							return grantWorkflowShipCarrierTurn(db, input, Date.now());
						} finally {
							db.close();
						}
					},
					wakeActor: async ({
						session,
						wakeId,
						activationId,
						epoch,
						context,
					}) => {
						const adapter = store.getSession(
							session.execution_id,
						)?.adapter_type;
						const transport =
							adapter && Object.hasOwn(EXECUTOR_TO_TRANSPORT, adapter)
								? EXECUTOR_TO_TRANSPORT[
										adapter as keyof typeof EXECUTOR_TO_TRANSPORT
									]
								: "claude-code";
						if (transport === "none") {
							return {
								ok: false,
								error: `wake_transport_missing:${adapter}`,
							};
						}
						const db = new CommDB(
							commDbPathForProject(session.project_name ?? ""),
						);
						try {
							db.clearDeclaredState(session.execution_id);
							const res = await deliverDurableTurnWake({
								db,
								wakeId,
								execId: session.execution_id,
								issueId: session.issue_id,
								epoch,
								activationId,
								purpose: "workflow_ship_carrier",
								fromAgent: "bridge",
								content: `[phase-wake ${wakeId}] Founder approval is recorded. Ship carrier activation ${activationId} owns TURN epoch ${epoch}. FIRST run flywheel-comm turn --exec-id ${session.execution_id}; ship only if it answers yours. Context: ${JSON.stringify(context)}`,
								metadata: {
									kind: "workflow_ship_carrier",
									wakeId,
									activationId,
									epoch,
								},
								backend: transport,
							});
							return res.ok
								? { ok: true }
								: {
										ok: false,
										error: res.error ?? res.skippedReason ?? "wake_failed",
									};
						} catch (error) {
							return { ok: false, error: (error as Error).message };
						} finally {
							db.close();
							issueDisplayRefreshHolder.current?.enqueue(session.issue_id);
						}
					},
				},
			});
		void turnBeltReconcilerHolder.current
			.reconcileTurnBelt()
			.catch((error) =>
				console.warn(
					`[turn-belt] startup reconcile failed: ${(error as Error).message}`,
				),
			);
		console.log(
			"[workflow-coordinators] rework, ship carrier, and TURN recovery wired",
		);
	} catch (error) {
		console.warn(
			`[workflow-coordinators] wiring failed: ${(error as Error).message}`,
		);
	}

	// FLY-939 (G-D): boot-time checkout-SHA visibility. Fire-and-forget (never on
	// the critical path) — logs the running HEAD every restart and WARNs + records
	// a durable event + alerts the Lead if this checkout is STALE (behind
	// origin/main = merged work not live, the FLY-887 silent-non-deploy shape).
	{
		const here = dirname(fileURLToPath(import.meta.url));
		const bridgeRepoRoot =
			process.env.FLYWHEEL_REPO_ROOT?.trim() ||
			resolve(here, "..", "..", "..", "..");
		void runBootShaCheck({
			projectRoot: bridgeRepoRoot,
			git: async (args) => {
				const { stdout } = await execFileP(
					"git",
					["-C", bridgeRepoRoot, ...args],
					{
						timeout: 8_000,
					},
				);
				return stdout;
			},
			logger: { log: (m) => console.log(m), warn: (m) => console.warn(m) },
			recordStaleEvent: ({ headSha, originMainSha, aheadBy }) => {
				store.insertEvent({
					event_id: `bridge-boot-stale-${headSha}-${originMainSha}`,
					execution_id: "bridge-boot",
					issue_id: "bridge-boot",
					project_name: "",
					event_type: "bridge_boot_stale_checkout",
					source: "bridge.boot-sha-check",
					payload: { headSha, originMainSha, ...(aheadBy ? { aheadBy } : {}) },
				});
			},
			alertStale: async ({ headSha, originMainSha, message }) => {
				// Best-effort: alert the first project's resolved Lead. No issue/lead
				// context for a Bridge-global event, so any resolution failure just
				// leaves the durable event + console.warn as the signal.
				const first = projects[0];
				if (!first) return;
				let leadId: string | undefined;
				try {
					leadId = resolveLeadForIssue(projects, first.projectName, []).lead
						.agentId;
				} catch {
					/* no lead → event + console.warn suffice */
				}
				if (!leadId) return;
				// FLY-927 (W1): through the routed sink (ticket kind → same funnel
				// discipline; falls back to the raw notifier during the boot window).
				await (routedAlertSinkHolder.current ?? leadAlertNotifier).alert({
					leadId,
					projectName: first.projectName,
					eventId: `bridge-boot-stale:${headSha}:${originMainSha}`,
					eventType: "bridge_boot_stale_checkout",
					title: "Bridge running a STALE checkout — merged work is NOT live",
					body: `${message}\n\n(pull + restart the Bridge on ${bridgeRepoRoot} to deploy the merged code)`,
					severity: "warning",
				});
			},
		}).catch((err) =>
			console.warn(
				`[bridge-boot] runBootShaCheck threw (non-fatal): ${(err as Error).message}`,
			),
		);
	}

	// FLY-368 rework: the repair chain (Cass → alphabetical fleet) drives thread
	// creation + ack/repair/resolve. Resolve it at boot for the enable gate; the
	// Hub re-resolves per call (env may change). Tokens never logged.
	const repairChainEnvs = buildRepairChain(projects, repairBotTokenEnvName);
	// FLY-927 (Codex R1 MEDIUM): with the D2 single sender identity configured,
	// IT is the authoritative send chain — Hub enablement keys on the SENDER
	// token resolving (an empty repair chain must not disable the Hub, and a
	// misspelled sender env must fail loud at boot, not at the first dead-letter).
	// The Cass degraded-attribution warning is repair-chain-specific — skipped
	// under the override (there is no chain to degrade to).
	const alertSenderEnvName =
		process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV?.trim();
	const repairChainResolves = alertSenderEnvName
		? !!process.env[alertSenderEnvName]
		: !!resolveFirstAvailableBotToken(repairChainEnvs);
	const firstRepairBot = alertSenderEnvName
		? null
		: resolveFirstAvailableBotToken(repairChainEnvs);
	if (
		unifiedAlertChannelId &&
		firstRepairBot &&
		firstRepairBot.tokenEnv !== repairBotTokenEnvName
	) {
		// Cass isn't the first usable repair bot (degraded attribution) — run on the
		// alpha fallback but surface it LOUDLY: log + meta-alert (Codex code R1 LOW —
		// an operator must know repair messages no longer come from Cass). Token-free.
		console.warn(
			`[Bridge] FLY-368: repair bot "${repairBotTokenEnvName}" not resolvable — repair thread messages will use fallback "${firstRepairBot.tokenEnv}".`,
		);
		void metaAlertNotifier.notify({
			reason: "alert_unreachable_config",
			title: "FLY-368 repair bot degraded",
			body: `Configured repair bot env "${repairBotTokenEnvName}" did not resolve — auto-repair thread messages will be attributed to fallback "${firstRepairBot.tokenEnv}" instead of Aunt Cass.`,
		});
	}

	// FLY-696: shared Discord operations remain for Alerts, rotation notices,
	// and login rescue. The account-switch construction seam remains below for
	// compatibility, but FLY-1456's fixed mode never attaches it to Bridge.
	const getAlertDiscordTokens = (): string[] => {
		// FLY-927 (D2): single sender identity — when set, Hub thread operations
		// use the SAME one identity as the root alert (no repair-chain fan-out).
		// Unresolvable token ⇒ empty chain ⇒ the op fails loudly via the Hub's
		// safe wrapper (never a silent other-bot fallback). Unset ⇒ legacy chain.
		const senderEnv = process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV?.trim();
		if (senderEnv) {
			const t = process.env[senderEnv];
			return t ? [t] : [];
		}
		return buildRepairChain(projects, repairBotTokenEnvName)
			.map((env) => process.env[env])
			.filter((t): t is string => !!t);
	};
	const alertDiscordOps = createDiscordOps(getAlertDiscordTokens);
	const alertArchiveDefaultProvider = unifiedAlertChannelId
		? makeChannelArchiveDefaultProvider({
				channelId: unifiedAlertChannelId,
				botToken: getAlertDiscordTokens,
				logger: { warn: (message) => console.warn(message) },
			})
		: undefined;
	// FLY-1456: preserve the existing construction boundary while the fixed mode
	// keeps it dormant. The external daemon is the only account-switch executor.
	const accountSwitchRepair = quotaBridgeMode.attachAccountSwitch
		? makeAccountSwitchRepair({
				switchDeps: makeClaudeProfileSwitchDeps({
					binPath: claudeProfileBinPath(),
				}),
			})
		: undefined;

	// FLY-696 M1/④: now that the unified-channel DiscordOps exists, late-bind the
	// account_rotation Alerts-post the event router reads. Manual/profile rotation
	// notices and login rescue remain wired after permanent cutover;
	// only the three automatic account-switch execution faces are retired.
	// FLY-871 R3/C9: the infra self-heal rescue runtime (built inside the same
	// self-heal gate below).
	let rescueRuntime: RescueRuntime | undefined;
	if (claudeAccountPoolConfigured && unifiedAlertChannelId) {
		accountRotationPostHolder.current = async (detail, rotation) => {
			await alertDiscordOps.postToThread(unifiedAlertChannelId, detail);
			// FLY-929 A4: rotation digest from the STRUCTURED payload (never
			// re-parsed from the Alerts line). P-identity dormant ⇒ no-op.
			if (rotation) {
				await postInfraNotifyDigest(formatRotationDigest(rotation));
			}
		};
		// FLY-871 R3/C9: build the infra self-heal rescue runtime — binds the pure
		// rescue orchestration (rescue.ts) to the real Bridge primitives. Consumed
		// by the /api/rescue route (W3) and the post-switch sweep (W5). Same
		// Pool + unified-channel gate remains independent of permanent quota
		// cutover: login rescue is not an account-switch execution face.
		const resolveRescueLeadId = defaultResolveLeadId(projects);
		// The founder's Discord id for a REAL @-ping on a rescue escalation (snowflake
		// only; unset/malformed ⇒ undefined = degrade to no-mention, like the Hub).
		const rescueFounderDiscordId = (): string | undefined => {
			const id = process.env.FLYWHEEL_FOUNDER_DISCORD_USER_ID?.trim();
			return id && /^\d{17,20}$/.test(id) ? id : undefined;
		};
		const rescueDetectionAiClassify = makeSubscriptionDetectionClassifier({});
		rescueRuntime = buildRescueRuntime({
			listPendingAlerts: () => store.listActiveAlertThreads(),
			kickstart: makeKickstart({ log: (m) => console.warn(m) }),
			captureLeadPane: async (projectName, leadId) => {
				const w = await locateFleetLeadWindow(projectName, leadId);
				if (!w) return null;
				return leadPaneCaptureFn(w, 200);
			},
			sendEnterToLead: async (projectName, leadId) => {
				const w = await locateFleetLeadWindow(projectName, leadId);
				if (w) await sendEnterToWindow(w);
			},
			isResumeMenu: isSafeResumeMenuForEnter,
			// FLY-871 Lead ②: revalidate the runner's LIVE pane before closing it.
			revalidateRunner: makeRunnerRevalidate({
				captureRunnerPane: async (executionId) => {
					const s = store.getSession(executionId);
					if (!s) return null;
					const c = await defaultCaptureSession(
						executionId,
						s.project_name,
						100,
					);
					return isCaptureError(c) ? null : c.output;
				},
				classify: async (region) => {
					const r = await classifyDetection(region, {
						aiClassify: rescueDetectionAiClassify,
					});
					return { category: r.category };
				},
			}),
			// FLY-871 W4: close the dead running session (FSM terminate → close) +
			// dispatch a resumed successor (start() runs the FLY-795 resume-computer).
			closeAndDispatchSuccessor: makeCloseAndDispatchSuccessor({
				getSession: (id) => store.getSession(id),
				// FLY-1372 (Codex code R1 #4): engine-owned workflow executions are
				// never legacy rescue targets.
				isEngineOwnedExecution: (id) =>
					store.isWorkflowEngineOwnedExecution(id),
				terminateForRescue: (s) => {
					const tr = applyTransition(
						transitionOpts,
						s.execution_id,
						"terminated",
						{
							executionId: s.execution_id,
							issueId: s.issue_id,
							projectName: s.project_name,
							trigger: "login_expired_rescue",
						},
						{
							last_activity_at: sqliteDatetime(),
							last_error: "login expired — rescued (FLY-871)",
						},
					);
					return { ok: tr.ok, error: tr.error };
				},
				closeRunner: async (s) => {
					const r = await closeRunner(
						{
							executionId: s.execution_id,
							issueId: s.issue_id,
							projectName: s.project_name,
							leadId: resolveRescueLeadId(s) ?? undefined,
							reason: "login_expired_rescue",
							forcePreserved: true,
						},
						store,
					);
					return { closed: r.closed, error: r.error };
				},
				startSuccessor: async (s) => {
					if (!startDispatcher) {
						throw new Error("no start dispatcher (rescue successor)");
					}
					const docTier =
						s.doc_tier === "full" ||
						s.doc_tier === "plan_only" ||
						s.doc_tier === "none"
							? s.doc_tier
							: undefined;
					// FLY-1224 (R1 #1, the 6th dispatch lane): a PHASE-row rescue
					// successor re-derives {model, vendor, effort} from the phase table
					// and keeps its shared-branch identity + phase sessionRole; a
					// non-phase row passes its persisted fields verbatim. The pure
					// derivation lives in rescue-runtime (unit-tested, T4b).
					const res = await startDispatcher.start({
						issueId: s.issue_id,
						projectName: s.project_name,
						leadId: resolveRescueLeadId(s) ?? undefined,
						issueTitle: s.issue_title ?? undefined,
						issueIdentifier: s.issue_identifier ?? undefined,
						issueLabels: parseSessionLabels(s),
						docTier,
						issueUrl: s.issue_url ?? undefined,
						...buildRescueSuccessorDispatchFields(s),
					});
					return res.executionId;
				},
				log: (m) => console.warn(m),
			}),
			// Evidence lands in THAT incident's Alerts thread (threadKey =
			// correlationKey); falls back to the root channel only if the thread
			// can't be resolved. An escalation @-pings the founder FOR REAL via
			// allowed_mentions (a literal "@Annie" in text never pings).
			postEvidence: async (detail, evOpts) => {
				const threadId = evOpts?.threadKey
					? store.getActiveAlertThread(evOpts.threadKey)?.thread_id
					: undefined;
				const mentionUserId = evOpts?.mention
					? rescueFounderDiscordId()
					: undefined;
				await alertDiscordOps.postToThread(
					threadId ?? unifiedAlertChannelId,
					detail,
					mentionUserId ? { mentionUserId } : undefined,
				);
			},
			// A healed session ⇒ post ✅ into its thread + resolve it, so the sweep
			// and the reconcile pass stop tracking it. Idempotent.
			resolveAlert: async (correlationKey) => {
				const row = store.getActiveAlertThread(correlationKey);
				if (!row) return;
				try {
					await alertDiscordOps.postToThread(
						row.thread_id,
						"✅ 已恢复(rescue)。",
					);
				} catch (err) {
					console.warn(
						`[rescue] resolve post failed for ${correlationKey}: ${(err as Error).message}`,
					);
				}
				store.resolveAlertThread(correlationKey);
			},
			audit: (e) =>
				store.appendLeadEvent(
					"codex-infra-bot-lead",
					`rescue:${e.phase}:${e.target}`,
					`rescue_${e.phase}`,
					JSON.stringify(e),
				),
			waitMs: (ms) => new Promise((r) => setTimeout(r, ms)),
			log: (m) => console.warn(m),
		});
		rescueRouteHolder.current = {
			rescueLead: rescueRuntime.rescueLead,
			rescueRunner: rescueRuntime.rescueRunner,
		};
	}

	// FLY-368 rework: Hub on when unified channel + threading + a resolvable repair
	// chain; else producers route straight to the notifier (legacy / root-only).
	const alertHub =
		unifiedAlert && repairChainResolves
			? new AlertChannelHub({
					store,
					notifier: leadAlertNotifier,
					// Repair-chain DiscordOps: Cass → alphabetical, resolved per call.
					discord: alertDiscordOps,
					archiveDefaultProvider: alertArchiveDefaultProvider,
					// FLY-1243: conservative auto-repair, 固化 default-on (always wired
					// inside the hub, which itself needs a channel + repair chain). Only
					// retained safe auto-repair actions.
					autoRepairBot: new AutoRepairBot({
						// FLY-696: usage_limit → Claude account switch (enqueues a
						// pending record; the deadline sweep below fires it). Hoisted +
						// gated on the account-pool presence (FLY-1243; absent →
						// undefined = byte-compat, usage_limit stays needs_human).
						accountSwitch: accountSwitchRepair,
						// FLY-1082: fleet repairs — holder-backed (sensors built after
						// the sink below). Unwired ⇒ needs_human, honest degradation.
						fleetRepair: {
							swapPressure: (p) =>
								fleetSensorsHolder.current
									? fleetSensorsHolder.current.swapPressureRepair(p)
									: Promise.resolve({
											outcome: "needs_human" as const,
											action: "none",
											detail: "fleet sensors 未接线 — 需要人工降载。",
										}),
							infraBotKickstart: (p) =>
								fleetSensorsHolder.current
									? fleetSensorsHolder.current.infraBotKickstartRepair(p)
									: Promise.resolve({
											outcome: "needs_human" as const,
											action: "none",
											detail:
												"fleet sensors 未接线 — 需要人工重启 launchd job。",
										}),
						},
					}),
					// Reconcile capture: locate the Lead window + grab its pane (null when
					// no window) — the restart-safe recovery truth source.
					capturePane: async (projectName, leadId) => {
						const w = await locateFleetLeadWindow(projectName, leadId);
						if (!w) return null;
						return leadPaneCaptureFn(w, 200);
					},
					// FLY-368 (Codex code R1 HIGH-1): runner reconcile capture — resolve a
					// runner alert thread once the runner's terminal advanced past the
					// stuck episode, even while status stays "running". null on capture
					// error → leave the thread active (fail-closed).
					captureRunner: async (executionId, projectName) => {
						const c = await defaultCaptureSession(
							executionId,
							projectName,
							100,
						);
						return isCaptureError(c) ? null : c.output;
					},
					// FLY-1082: fleet-kind recovery probe (watermark cleared / bot back
					// alive / boot reconcile done) — holder-backed; null = cannot tell.
					fleetRecovery: async (row) =>
						(await fleetSensorsHolder.current?.recoveryProbe(row)) ?? null,
				})
			: undefined;
	const founderEscalationConfigured = isDiscordSnowflake(
		config.discordOwnerUserId,
	);
	if (alertHub && !founderEscalationConfigured) {
		console.error(
			"[Bridge] founder escalation route unreachable: DISCORD_OWNER_USER_ID is missing or invalid; workflow escalations will remain in Claw mailbox",
		);
		void metaAlertNotifier.notify({
			reason: "alert_unreachable_config",
			title: "Founder escalation route unreachable",
			body: "DISCORD_OWNER_USER_ID is missing or invalid; workflow escalations will remain in Claw mailbox instead of entering Discord.",
		});
	}
	if (alertHub) {
		alertDutyHubHolder.current = alertHub;
		console.log(
			`[Bridge] FLY-368 AlertChannelHub ON (unified channel=${unifiedAlertChannelId}, ordinary-route=claw-mailbox, escalation-route=channel, founder-auto-mention=workflow_engine_escalation-only, founder-id=${founderEscalationConfigured ? "resolved" : "UNRESOLVED"})`,
		);
	}
	console.log(
		`[Bridge] FLY-2076 alert duty token=${config.alertDutyToken ? "set" : "unset"} dispatcher=${alertDutyDispatcherBotUserId.current ?? "unresolved"} hub=${alertHub ? "set" : "unset"}`,
	);

	// FLY-368: a single alert sink shared by every Lead alert producer. When the Hub is on it
	// adds threading + auto-repair; otherwise it's the raw notifier (byte-compat).
	const alertSink: { alert: (p: AlertPayload) => Promise<AlertResult> } =
		alertHub ? { alert: (p) => alertHub.handle(p) } : leadAlertNotifier;

	// FLY-927 (W1): wrap the raw sink with the welded-on D1 Router. An
	// issue-progress alert with a bound [FLY-XX] thread is delivered THERE via
	// the issue-thread infra leg; any resolution/delivery failure fail-safes back
	// to the raw channel sink — never silent, never recursive.
	const routedAlertSinkCore = buildInfraAlertRouting({
		store,
		projects,
		alertsEnabled: () => storeAlertSystemEnabled(flagStore),
		globalBotToken: config.discordBotToken,
		rawSink: alertSink,
		ticketSink: {
			alert: async (payload) => {
				const receipt = leadInboxRuntime.enqueueInfraAlert(
					INFRA_ALERT_OWNER_LEAD_ID,
					payload,
				);
				return { queued: receipt.queued };
			},
		},
		founderUserId: config.discordOwnerUserId,
	});
	const routedAlertSink: {
		alert: (p: AlertPayload) => Promise<AlertResult>;
	} = {
		alert: async (payload) => {
			const delivered = await routedAlertSinkCore.alert(payload);
			if (shouldWakeQuotaDaemon(payload)) wakeQuotaDaemon();
			return delivered;
		},
	};
	routedAlertSinkHolder.current = routedAlertSink;
	await reportFlagScanOwnerResolution(flagScanOwnerStatus, routedAlertSink);
	workflowEngineAlertHolder.current = routedAlertSink;
	paneLossNotifyHolder.current = async (
		session,
		classification,
		terminalLifecycleId,
	) => {
		let lead: LeadConfig | undefined;
		try {
			lead = resolveLeadForIssue(
				projects,
				session.project_name,
				store.getSessionLabels(session.execution_id),
			).lead;
		} catch {
			// The raw alert fallback below still makes an unresolvable route visible.
		}
		const detail =
			classification === "settlement"
				? "tmux server 已换代且 runner body 已确认不存在；账面已转为 failed。"
				: classification === "advisory_generation_superseded"
					? "tmux server 已换代且 runner body 已确认不存在；parked 状态保持不变。"
					: classification === "advisory_codex"
						? "CommDB 的 tmux target 不存在，但 Codex daemon/body 仍可能存活；状态保持不变。"
						: "tmux target 不存在不足以证明 runner body 已灭；状态保持不变。";
		const content = [
			`⚠️ **${session.issue_identifier ?? session.issue_id} — runner pane 失联**`,
			detail,
			`execution_id=${session.execution_id} adapter=${session.adapter_type ?? "legacy-claude-tmux"}`,
			"未自动重派。",
			`恢复提案（未执行）：close_runner {"execution_id":"${session.execution_id}","abandon":true,"reason":"pane_loss_recovery"}`,
		].join("\n");
		const thread = lead
			? store.getChatThreadByIssue(session.issue_id, lead.chatChannel)
			: undefined;
		const direct = await emitIssueThreadInfraNotification(
			{
				executionId: session.execution_id,
				issueId: session.issue_id,
				issueIdentifier: session.issue_identifier,
				projectName: session.project_name,
				kind: "runner_pane_loss",
				content,
				thread,
				botToken: lead?.botToken ?? config.discordBotToken,
				onUndeliverable: (reason) =>
					console.warn(
						`[pane-loss] issue-thread notification failed for ${session.execution_id}: ${reason}`,
					),
			},
			{ store },
		);
		if (direct.kind === "posted") return true;
		const fallback = await (
			routedAlertSinkHolder.current ?? leadAlertNotifier
		).alert({
			leadId: lead?.agentId ?? config.defaultLeadAgentId,
			projectName: session.project_name,
			eventId: `pane-loss:${session.execution_id}:${classification}:${terminalLifecycleId ?? "active"}:${randomUUID()}`,
			eventType: "runner_pane_loss",
			title: `Runner pane 失联 — ${session.issue_identifier ?? session.issue_id}`,
			body: content,
			severity: classification === "settlement" ? "severe" : "warning",
			sessionKey: session.execution_id,
		});
		return !!(fallback.sent || fallback.queued);
	};
	void workflowEngineDispatcher
		?.reconcileWorkflowEngineAlerts()
		.catch((error) =>
			console.warn(
				`[workflow-engine] boot alert reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
			),
		);
	// FLY-1204: now that the routed alert sink exists, back the late-bound
	// orphan-parked alert closure the HeartbeatService reclaim patrol calls. It
	// reuses the `three_stage_stuck` infra kind (owner-enriched, bound to the
	// issue's [FLY-XX] thread when routing is on; raw notifier otherwise) and is
	// issue-level (the HeartbeatService already dedupes to once per orphan set).
	orphanParkedAlertHolder.current = async (issueId, sessions) => {
		const first = sessions[0];
		if (!first?.project_name) return;
		let leadId = config.defaultLeadAgentId;
		try {
			const { lead } = resolveLeadForIssue(
				projects,
				first.project_name,
				parseJsonStringArray(first.issue_labels) ?? [],
			);
			leadId = lead.agentId;
		} catch {
			// unresolvable lead → fall back to the default agent id
		}
		const roles = sessions
			.map((s) => `${s.chat_thread_role}/${s.execution_id}`)
			.join(", ");
		const fingerprint = sessions
			.map((s) => s.execution_id)
			.sort()
			.join(",");
		await (routedAlertSinkHolder.current ?? leadAlertNotifier).alert({
			leadId,
			projectName: first.project_name,
			eventId: `fly1204-orphan-parked:${issueId}:${fingerprint}`,
			eventType: "three_stage_stuck",
			title: `孤立 parked phase 段 — ${first.issue_identifier ?? issueId}`,
			body:
				`issue ${issueId} 有 ${sessions.length} 个孤立 parked phase 段(无 ship claim,pipeline 疑似崩溃/未 ship):${roles}` +
				` —— 未自动回收(诚实安全边界:非终态 parked 无法证明 TOCTOU 安全)。请人工 close_runner --done 或确认 pipeline。`,
			severity: "warning",
			sessionKey: first.execution_id,
		});
	};

	// ── FLY-1082: fleet sensors + server-loss coordinator wiring ─────────────
	// Bridge → Lead instruction over the per-project CommDB inbox (the same
	// transport CommDBLeadRuntime uses) — targeted server-loss casualty lists
	// ride it. Fleet pressure alerts use the unified alert owner path instead.
	const leadProjectByAgentId = new Map<string, string>();
	for (const p of projects) {
		for (const l of p.leads) leadProjectByAgentId.set(l.agentId, p.projectName);
	}
	const notifyLeadInstruction = async (
		leadId: string,
		content: string,
		dedupeId?: string,
	): Promise<boolean> => {
		const projectName = leadProjectByAgentId.get(leadId);
		if (!projectName) return false;
		try {
			new CommDB(commDbPathForProject(projectName)).insertInstruction(
				"bridge",
				leadId,
				content,
				dedupeId ? { dedupeId } : undefined,
			);
			return true;
		} catch (err) {
			console.warn(
				`[fleet-sensors] notifyLead(${leadId}) failed: ${(err as Error).message}`,
			);
			return false;
		}
	};
	// Infra-bot probes: launchd job labels from env (FLY-927 convention —
	// unset ⇒ that provider is simply not probed; graceful degradation until
	// FLY-1071 arms the bots).
	const probeInfraBots = async () => {
		const out: import("./fleet-sensors.js").InfraBotProbe[] = [];
		for (const [provider, envName] of [
			["claude", "FLYWHEEL_CLAUDE_INFRA_BOT_JOB"],
			["codex", "FLYWHEEL_CODEX_INFRA_BOT_JOB"],
		] as const) {
			const jobLabel = process.env[envName]?.trim();
			if (!jobLabel) continue;
			const alive = await probeLaunchdJobAlive(jobLabel);
			if (alive === null) continue; // indeterminate — never a false bot-down
			out.push({ provider, alive, jobLabel, probeSource: "launchctl print" });
		}
		return out;
	};
	// Zombie scan (Task 2.6): CommDB running rows across projects vs StateStore.
	const scanZombiesWired = async () => {
		const findings: import("./zombie-scan.js").ZombieFinding[] = [];
		for (const p of projects) {
			try {
				const rows = new CommDB(
					commDbPathForProject(p.projectName),
				).listSessions(p.projectName, ["running"]);
				findings.push(
					...(await scanZombies({
						commRunning: rows.map((r) => ({
							execution_id: r.execution_id,
							project_name: p.projectName,
							tmux_window: r.tmux_window,
						})),
						storeSession: (id) => {
							const s = store.getSession(id);
							return s
								? { status: s.status, heartbeat_at: s.heartbeat_at }
								: undefined;
						},
						targetAlive: async (w) => {
							const liveness = await probeRunnerProcessLiveness(w);
							if (liveness === "alive") return true;
							if (liveness === "absent" || liveness === "dead_pin")
								return false;
							return null;
						},
						nowMs: Date.now(),
					})),
				);
			} catch (err) {
				console.warn(
					`[fleet-sensors] zombie scan for ${p.projectName} failed: ${(err as Error).message}`,
				);
			}
		}
		return findings;
	};
	fleetSensorsHolder.current = new FleetSensors({
		store,
		alert: (p) => routedAlertSink.alert(p),
		resolveTicket: alertHub ? (ck) => alertHub.resolve(ck) : undefined,
		probeBots: probeInfraBots,
		scanZombies: scanZombiesWired,
		// Codex R2 HIGH: a server-loss episode with unmigrated casualties must
		// never read as recovered — the probe consults the live coordinator.
		serverLossPending: () =>
			serverLossHolder.current?.hasPendingMigrations() ?? false,
	});
	const canonicalTmuxSocketPath = canonicalDefaultTmuxSocketPath();
	const tmuxRescueClient = createTmuxRescueClient({
		cliPath: join(homedir(), ".flywheel", "bin", "tmux-server-rescue"),
		socketPath: canonicalTmuxSocketPath,
	});
	serverLossHolder.current = new ServerLossCoordinator({
		store,
		probeServer: () => probeTmuxServer(),
		inspectSocket: () => tmuxRescueClient.inspect(),
		recoverSocket: () => tmuxRescueClient.recover(),
		normalizedSocketPath: canonicalTmuxSocketPath,
		targetGone: async (session) => {
			const lookup = lookupTmuxTarget(
				session.execution_id,
				session.project_name,
			);
			if (lookup.kind === "error") return null;
			if (lookup.kind === "gone") return true;
			const liveness = await probeRunnerProcessLiveness(
				lookup.target.tmuxWindow,
			);
			if (liveness === "alive") return false;
			if (liveness === "absent" || liveness === "dead_pin") return true;
			return null;
		},
		migrate: async (session, episodeSignature) => {
			const now = new Date()
				.toISOString()
				.replace("T", " ")
				.replace(/\.\d+Z$/, "");
			if (transitionOpts) {
				applyTransition(
					transitionOpts,
					session.execution_id,
					"failed",
					{
						executionId: session.execution_id,
						issueId: session.issue_id,
						projectName: session.project_name,
						trigger: "server_loss",
					},
					{
						last_activity_at: now,
						last_error: `tmux server lost (${episodeSignature})`,
					},
				);
			} else {
				store.forceStatus(
					session.execution_id,
					"failed",
					now,
					`tmux server lost (${episodeSignature})`,
				);
			}
			return true;
		},
		resolveLeadId: (session) => {
			try {
				const labels = store.getSessionLabels(session.execution_id);
				return resolveLeadForIssue(projects, session.project_name, labels).lead
					.agentId;
			} catch {
				return null;
			}
		},
		notifyLead: notifyLeadInstruction,
		alert: (p) => routedAlertSink.alert(p),
		resolveHoldAlert: alertHub
			? async (incidentId) => {
					for (const eventType of ["tmux_hold", "tmux_split_brain"] as const) {
						await alertHub.resolve(
							correlationKeyFor({
								projectName: FLEET_ALERT_PROJECT,
								leadId: "tmux-server",
								eventType,
								sessionKey: incidentId,
							}),
						);
					}
				}
			: undefined,
		currentWatermark: () => fleetSensorsHolder.current?.lastWatermark ?? null,
	});
	console.log(
		"[Bridge] FLY-1082 fleet sensors wired (swap/bot/zombie on lead-reconcile tick; tmux server-loss as heartbeat pre-reaper phase)",
	);

	// FLY-1082 (Task 2.4): boot self-check leg — a latched `running` marker
	// means the previous Bridge died dirty; open the lifecycle ticket (the
	// wrapper page already fired Bridge-independently with its OWN dedup id;
	// both legs share the episode signature for correlation).
	if (prevExitMarker?.state === "running") {
		const loopStall =
			loopGuardLogPaths(process.env)
				.map((path) => findLoopStallForExit(path, prevExitMarker, bridgeBootTs))
				.find((record) => record !== null) ?? null;
		const alertContent = buildAbnormalExitAlertContent(
			prevExitMarker,
			loopStall,
		);
		void routedAlertSink
			.alert({
				leadId: "bridge",
				projectName: FLEET_ALERT_PROJECT,
				eventId: abnormalExitTicketEventId(prevExitMarker),
				eventType: "bridge_abnormal_exit",
				title: alertContent.title,
				body: alertContent.body,
				severity: "severe",
			})
			.catch((err: Error) =>
				console.warn(
					`[bridge-exit-marker] boot ticket emission failed: ${err.message}`,
				),
			);
	}

	// FLY-637-ext: now that the shared alert sink exists, point the GatePoller's
	// late-bound lead-pending page-Annie holder at it (same routing as FLY-195 Q7).
	// FLY-927: via the Router — runner_lead_pending_unhandled is an issue-progress
	// kind, so with routing ON it lands in the issue's own thread.
	leadPendingAlertHolder.current = routedAlertSink;

	// FLY-182 §4.1: surface any Lead whose alert channel/token cannot resolve
	// from config — the silent gap that broke alerting for 25 days. LOUD log +
	// one meta-alert (debounced) so it never goes unnoticed again.
	// FLY-368 rework: in unified mode a lead is unreachable only if the whole
	// fleet send-chain resolves nothing (per-lead noise removed).
	const unreachableAlertLeads = findUnreachableAlertLeads(projects, {
		channelId: unifiedAlertChannelId,
		repairBotTokenEnv: repairBotTokenEnvName,
		// FLY-927 (Codex R1 MEDIUM): D2 sender identity is the authoritative
		// chain — a misspelled/unset sender env fails LOUD at boot.
		senderTokenEnv: alertSenderEnvName,
	});
	if (unreachableAlertLeads.length > 0) {
		for (const u of unreachableAlertLeads) {
			console.error(
				`[Bridge] ALERT-UNREACHABLE lead="${u.leadId}" project="${u.projectName}": ${u.reason}`,
			);
		}
		void metaAlertNotifier.notify({
			reason: "alert_unreachable_config",
			title: "Lead alert channel(s) not configured",
			body: `${unreachableAlertLeads.length} Lead(s) cannot deliver alerts: ${unreachableAlertLeads
				.map((u) => u.leadId)
				.join(
					", ",
				)}. Alerts for them will dead-letter, not reach Annie. Fix projects.json (alertChannel or alertFallbackToCore + generalChannel).`,
		});
	}

	if (quotaBridgeMode.runRunnerQuotaScan) {
		const quotaScan = makeRunnerQuotaScan({
			projects,
			alert: (payload) => routedAlertSink.alert(payload),
			isTransient: isTransientThrottlePane,
			now: () => Date.now(),
		});
		const authScan = makeRunnerAuthScan({
			alert: (payload) => routedAlertSink.alert(payload),
			resolveLeadId: defaultResolveLeadId(projects),
			recordAuthHealth: (name) =>
				ledgerRecordAuthHealth(name, {
					lastFreshness: "stale",
					lastVerifiedAt: new Date().toISOString(),
					reason: "runner login_expired",
				}),
			aiClassify: makeSubscriptionDetectionClassifier({}),
		});
		runnerQuotaScanPassHolder.current = makeRunnerQuotaScanPass({
			store,
			captureSession: defaultCaptureSession,
			intervalMs: DEFAULT_RUNNER_QUOTA_SCAN_INTERVAL_MS,
			scan: async (session, pane) => {
				await quotaScan(session, pane);
				await authScan(session, pane);
			},
			log: (message) => console.warn(message),
		});
	}

	const leadIdentityFindingPayload = (
		finding: LeadIdentityFinding,
	): AlertPayload => {
		const processEvidence = finding.processes.map((row) => ({
			pid: row.pid,
			lstart: row.lstart,
		}));
		const episode = createHash("sha256")
			.update(
				JSON.stringify({
					kind: finding.kind,
					projectName: finding.projectName,
					leadId: finding.leadId,
					processEvidence,
				}),
			)
			.digest("hex")
			.slice(0, 20);
		const order = finding.ambiguousOrder
			? "process order is ambiguous"
			: finding.laterPid
				? `later process PID ${finding.laterPid}`
				: "no later process identified";
		return {
			leadId: finding.leadId,
			projectName: finding.projectName,
			eventId: `lead-identity:${episode}`,
			eventType: finding.kind,
			title:
				finding.kind === "lead_dual_active_sensor_degraded"
					? "Lead identity process sensor degraded"
					: finding.kind === "lead_backend_drift"
						? "Claude intruder under Codex Lead identity"
						: "Two live processes share one Lead identity",
			body: `${finding.projectName}/${finding.leadId}: ${order}; observed PIDs [${finding.processes.map((row) => row.pid).join(", ") || "none"}]${finding.carrierDisposition ? `; carrier=${finding.carrierDisposition}` : ""}.`,
			severity: "severe",
		};
	};
	const leadIdentityMonitor = new LeadDualActiveMonitor({
		enabled: true,
		notify: async (finding) => {
			const payload = leadIdentityFindingPayload(finding);
			const leadKey = `${finding.projectName}-${finding.leadId}`;
			const sourceFingerprint =
				finding.kind === "lead_backend_drift"
					? `lead_backend_drift:claude_intruder:${leadKey}`
					: finding.kind === "lead_dual_active_sensor_degraded"
						? "lead_dual_active_sensor_degraded:bridge:ps"
						: `lead_dual_active:${leadKey}`;
			try {
				ensureLeaseEpisodeMaterialized({
					sourceFingerprint,
					kind: finding.kind,
					payload: { ...payload },
				});
			} catch (error) {
				console.warn(
					`[Bridge] lead identity episode store degraded: ${(error as Error).message}`,
				);
				await routedAlertSink.alert(payload);
			}
		},
		onRecovery: async (finding) => {
			const leadKey = `${finding.projectName}-${finding.leadId}`;
			const sourceFingerprint =
				finding.kind === "lead_backend_drift"
					? `lead_backend_drift:claude_intruder:${leadKey}`
					: finding.kind === "lead_dual_active_sensor_degraded"
						? "lead_dual_active_sensor_degraded:bridge:ps"
						: `lead_dual_active:${leadKey}`;
			try {
				recoverLeaseEpisode({ sourceFingerprint });
			} catch (error) {
				console.warn(
					`[Bridge] lead identity episode recovery degraded: ${(error as Error).message}`,
				);
			}
		},
	});
	const leaseAuditOutbox = new LeaseAuditOutbox({
		dbPath:
			process.env.FLYWHEEL_LEAD_LEASE_DB ??
			join(homedir(), ".flywheel", "lead-lease.db"),
		queueDir:
			process.env.FLYWHEEL_ALERT_QUEUE_DIR ??
			join(homedir(), ".flywheel", "alert-queue"),
		episodeDbPath:
			process.env.FLYWHEEL_LEAD_EPISODE_DB ??
			join(homedir(), ".flywheel", "state", "lease-episodes.db"),
	});
	const leadIdentityTargets = (): LeadScanTarget[] => {
		const fleet = new Map(
			(fleetPoller.snapshot()?.leads ?? []).map((lead) => [lead.key, lead]),
		);
		return fleetConfigProvider.snapshot().projects.flatMap((project) =>
			project.leads.map((lead) => {
				const desiredBackend = effectiveLeadBackend(
					lead.backend,
					fleetLegacyBackendOf(project),
				).backend;
				const evidence = fleet.get(`${project.projectName}-${lead.agentId}`);
				return {
					projectName: project.projectName,
					leadId: lead.agentId,
					desiredBackend,
					...(evidence ? { carrierDisposition: evidence.presentation } : {}),
				};
			}),
		);
	};
	leadReconcilePassHolder.current = () =>
		runLeadReconcilePass({
			reconcileLeaseEpisodes: () => reconcileLeaseEpisodeQueue(),
			scanLeadIdentities: () => leadIdentityMonitor.tick(leadIdentityTargets()),
			materializeLeaseAudit: () => leaseAuditOutbox.materialize(),
			tickFleetSensors: () => fleetSensorsHolder.current?.tick(),
			reconcileAlerts: () => alertHub?.reconcile(),
		});

	// FLY-83: drain alert queue every 60s so spills from shell path (lead-alert.sh)
	// or prior Bridge runs do not rot. Queue files only appear when Discord POST
	// fails or env is missing, so this is usually a no-op.
	//
	// In-flight guard (leadAlertDraining) is load-bearing: drainQueue() bypasses
	// the claim check and only unlinks a queue file AFTER a successful POST. If
	// a drain stalls past the 60s interval (slow Discord), an overlapping drain
	// would re-POST the same still-present queue file → duplicate alert, which
	// breaks the "one alert per 10-min bucket" invariant. Skip when busy.
	// FLY-182 §4.5: self-monitoring thresholds (env-tunable). The loop guard must
	// not go silent — meta-alerts ride the EXISTING 60s drain timer (no new
	// periodic load, FLY-129). MetaAlertNotifier debounces per reason (10min),
	// so repeated cycles collapse to one alert.
	const metaAlertStuckCycles = (() => {
		const raw = process.env.FLYWHEEL_ALERT_DRAIN_STUCK_CYCLES;
		const n = raw ? Number(raw) : Number.NaN;
		return Number.isInteger(n) && n > 0 ? n : 5; // ~5min at 60s cadence
	})();
	const alertQueueOverflow = (() => {
		const raw = process.env.FLYWHEEL_ALERT_QUEUE_MAX;
		const n = raw ? Number(raw) : Number.NaN;
		return Number.isInteger(n) && n > 0 ? n : 500;
	})();
	let drainStuckCycles = 0;
	let leadAlertDraining = false;
	const leadAlertDrainTimer = setInterval(() => {
		if (leadAlertDraining) return;
		leadAlertDraining = true;
		leadAlertNotifier
			.drainQueue()
			.then(async (drainResult) => {
				const { sent, remaining, deadLettered, staleSuppressed, delivered } =
					drainResult;
				if (
					sent > 0 ||
					remaining > 0 ||
					deadLettered > 0 ||
					staleSuppressed > 0
				) {
					console.log(
						`[Bridge] LeadAlert drain sent=${sent} remaining=${remaining} deadLettered=${deadLettered} staleSuppressed=${staleSuppressed}`,
					);
				}
				// FLY-927 (Codex R1 HIGH): a drained root must still get its per-error
				// thread + ticket lifecycle — otherwise every over-cap (rate-limited /
				// transient-retry) alert silently bypasses the Hub. Best-effort each.
				if (alertHub) {
					await attachDeliveredAlertLifecycles(delivered, alertHub, (message) =>
						console.warn(`[Bridge] ${message}`),
					);
				}
				// Dead-letters happened → surface (Discord-independent).
				if (
					shouldReportDeadLetteredDrain({
						deadLettered,
						staleSuppressed,
					})
				) {
					await metaAlertNotifier.notify({
						reason: "alert_dead_lettered",
						title: "LeadAlert dead-lettered alerts",
						body: `${deadLettered} alert(s) were dead-lettered during drain (remaining=${remaining}). Check ~/.flywheel/alert-deadletter and the Discord alert config.`,
					});
				}
				// OFF is an intentional pause, not evidence that the Discord path is
				// stuck or overflowing. The queue remains durable while delivery is paused.
				if (!storeAlertSystemEnabled(flagStore)) {
					drainStuckCycles = 0;
				} else {
					if (sent === 0 && remaining > 0) {
						drainStuckCycles++;
						if (drainStuckCycles >= metaAlertStuckCycles) {
							await metaAlertNotifier.notify({
								reason: "drain_stuck",
								title: "LeadAlert drainQueue stuck",
								body: `drainQueue has made no progress for ${drainStuckCycles} cycles (remaining=${remaining}). The Discord alert path is likely down or misconfigured.`,
							});
						}
					} else {
						drainStuckCycles = 0;
					}
					// Queue over cap.
					if (remaining > alertQueueOverflow) {
						await metaAlertNotifier.notify({
							reason: "queue_overflow",
							title: "LeadAlert queue overflow",
							body: `The alert queue holds ${remaining} entries (> ${alertQueueOverflow}).`,
						});
					}
				}
			})
			.catch((err: Error) => {
				console.warn(`[Bridge] LeadAlert drain failed: ${err.message}`);
			})
			.finally(() => {
				leadAlertDraining = false;
			});
	}, 60_000);
	leadAlertDrainTimer.unref?.();

	const close = async () => {
		// FLY-516: signal /health immediately so a respawn-racing wrapper sees
		// `shuttingDown:true` and reclaims the port instead of yielding to this
		// (about-to-die) instance. run-bridge.ts wraps this close() in a bounded
		// timeout so the process — and thus the port — is released even if any
		// await below hangs.
		shutdownStateHolder.shuttingDown = true;
		// FLY-1082 (Task 2.4): the clean-shutdown marker rides the SAME close
		// path as /health shuttingDown (no extra signal handlers) — a boot that
		// finds this marker still `running` knows the previous Bridge died dirty.
		writeCleanMarker(bridgeMarker);
		workflowSourceProjector.stop();
		workflowEngineDispatcher?.stop();
		workflowDocsMaterializer.stop();
		heartbeatService?.stop();
		gatePoller.stop();
		await eventLoopAttribution.stop();
		// FLY-1188 §7.2 (R12 HIGH): stop accepting new review jobs and reap
		// every detached Claude reviewer child — a clean restart must not leave
		// orphaned reviewers racing the new Bridge's boot redrive.
		reviewCoordinatorHolder.current?.stop();
		const reapedReviewers = killAllClaudeReviewChildren();
		if (reapedReviewers > 0) {
			console.log(
				`[review-coordinator] shutdown: killed ${reapedReviewers} live reviewer child(ren)`,
			);
		}
		await roundtableThreadManager?.stop();
		bridgeLoopGuard.stop();
		clearInterval(leadAlertDrainTimer);
		clearInterval(doaBackoffMaintenanceTimer);
		clearInterval(designReviewManifestTimer);
		if (chromeReaperTimer) clearInterval(chromeReaperTimer); // FLY-766
		// FLY-50: Clean up dispatchers. If retryDispatcher and internalDispatcher
		// are the same instance, only tear down once. If they differ (caller
		// injected retryDispatcher but not startDispatcher), tear down both.
		if (retryDispatcher) {
			retryDispatcher.stopAccepting();
			await retryDispatcher.drain();
			await retryDispatcher.teardownRuntimes();
		}
		if (internalDispatcher && internalDispatcher !== retryDispatcher) {
			internalDispatcher.stopAccepting();
			await internalDispatcher.drain();
			await internalDispatcher.teardownRuntimes();
		}
		if (runtimeRetryTimer) clearInterval(runtimeRetryTimer);
		// FLY-247 (Codex R3 MEDIUM-1): stop the fleet reconcile tick + close the
		// console's audit handle on shutdown.
		if (fleetReconcileTimer) clearInterval(fleetReconcileTimer);
		fleetConsole?.close();
		// FLY-1165: drain the done-thread reconcile (cooperative abort + await
		// the in-flight pass) BEFORE store.close() below — a pass writing
		// archived_at into a closed store would throw.
		await doneThreadReconcile.stop();
		leadInboxRuntime.close();
		await registry.shutdownAll();
		broadcaster.destroy();
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		await terminalCommDbSync.close(1_000);
		store.close();
	};

	// FLY-1082 (Task 2.4): startup wiring complete = the boot reconcile the
	// bridge_abnormal_exit ticket waits on is done — the next Hub reconcile
	// tick resolves it quietly.
	if (fleetSensorsHolder.current) {
		fleetSensorsHolder.current.bootReconcileDone = true;
	}

	return { app, store, close, registry };
}
