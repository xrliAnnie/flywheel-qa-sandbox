import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
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
import { CommDB } from "flywheel-comm/db";
import { wakeRunnerMailbox } from "flywheel-comm/wake";
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
	phaseMessageTag,
	resolveAllFlags,
	resolveCommBackend as resolveCommBackendShared,
	THREE_STAGE_PHASE_SEQUENCE,
	type ThreeStagePhase,
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
import {
	makeAccountSwitchRepair,
	type RepairDisposition,
} from "../account-heal/account-switch-repair.js";
import { accountSwitchWatchdogTick } from "../account-heal/account-switch-watchdog.js";
import {
	claudeProfileBinPath,
	makeClaudeProfileSwitchDeps,
} from "../account-heal/claude-profile-cli.js";
import {
	classifyDetection,
	makeSubscriptionDetectionClassifier,
} from "../account-heal/detection-classifier.js";
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
import {
	isSafeResumeMenuForEnter,
	isTransientThrottlePane,
	LeadWatchdog,
} from "../LeadWatchdog.js";
import { locateLeadWindow } from "../LeadWindowLocator.js";
import { CodexLeadOutboundHandler } from "../lead-backends/codex/CodexLeadOutboundHandler.js";
import { FileInboundCursorStore } from "../lead-backends/codex/InboundCursorStore.js";
import { buildLeadDiscordSend } from "../lead-backends/codex/leadDiscordSend.js";
import { SqliteOutboundDedupStore } from "../lead-backends/codex/SqliteOutboundDedupStore.js";
import {
	buildAuthorizeLeadChannel,
	buildLeadOutboundExpressHandler,
	buildResolveBotToken,
	loadProjectLeadRoles,
	paneWatchdogProjects,
} from "../lead-backends/codexLeadBridgeWiring.js";
import { MetaAlertNotifier } from "../MetaAlertNotifier.js";
import {
	type LeadConfig,
	loadProjects,
	type ProjectEntry,
	resolveLeadForIssue,
} from "../ProjectConfig.js";
import {
	type IdleWatchdogHealth,
	type IdleWatchdogHealthProvider,
	RunnerIdleWatchdog,
} from "../RunnerIdleWatchdog.js";
import {
	OUTCOME_STATUSES,
	REVIEW_BINDING_UNBOUND,
	type Session,
	StateStore,
} from "../StateStore.js";
import { importBundledWorkflowSeeds } from "../workflow-template.js";
import { AlertChannelHub, createDiscordOps } from "./AlertChannelHub.js";
import { AutoRepairBot } from "./AutoRepairBot.js";
import {
	type AccountSwitchRuntime,
	createAccountSwitchRouter,
} from "./account-switch-route.js";
import { createActionRouter } from "./actions.js";
// FLY-368: unified alert channel + per-error threading + conservative auto-repair.
import {
	buildRepairChain,
	resolveFirstAvailableBotToken,
} from "./alert-bot-chain.js";
// FLY-927 (T1): unified-channel root-message rate cap.
import {
	createAlertRateLimiter,
	rateLimitPerMinuteFromEnv,
} from "./alert-rate-limiter.js";
import { deriveCanonicalFounderId } from "./approval-signal/canonical-founder-id.js";
import { makeDeferralSupport } from "./approval-signal/deferred-approval.js";
import { makeFounderReactionApprovalCallback } from "./approval-signal/founder-reaction-approval-factory.js";
import { makeFounderShipApprovalCallback } from "./approval-signal/founder-ship-approval-factory.js";
import { readCurrentGateMessageBinding } from "./approval-signal/gate-message-binding-store.js";
import type { GateResponseDb } from "./approval-signal/write-gate-response.js";
import { loadQaConfigByProject } from "./auto-qa-config-source.js";
import { AutoQaCoordinator } from "./auto-qa-coordinator.js";
import { AutoQaEffects } from "./auto-qa-effects.js";
import { founderApprovalHoldGuard, reviewHoldReason } from "./auto-qa-held.js";
import { resolveAutoQaPolicy } from "./auto-qa-policy.js";
import { AutoContinueArmer } from "./autocontinue-armer.js";
import { BridgeEventLoopWatchdog } from "./BridgeEventLoopWatchdog.js";
import { runBootShaCheck } from "./boot-sha-check.js";
import { makeShipRemoteBranchCleanup } from "./branch-cleanup.js";
// FLY-927 (W1): D1 responder-based routing — ticket queue vs issue thread.
import {
	abnormalExitEpisodeSignature,
	abnormalExitTicketEventId,
	bridgeMarkerPath,
	latchPreviousMarker,
	writeCleanMarker,
	writeRunningMarker,
} from "./bridge-exit-marker.js";
import { ChatThreadCreator } from "./ChatThreadCreator.js";
import { makeCanceledPrDisposal } from "./canceled-pr-close.js";
// FLY-927 (Task 3.3): truthful stage wording for the three-stage stuck alert.
import { resolveChatThreadId } from "./chat-thread-utils.js";
import { deriveParkTuple, formatParkAlert } from "./checkpoint-park.js";
import { killAllClaudeReviewChildren } from "./claude-review-runner.js";
import { buildCleanupPolicies } from "./cleanup-policy.js";
import {
	CLOSE_ELIGIBLE_STATES,
	closeRunner,
	registerLifecycleCloseGuard,
} from "./close-runner.js";
import { reportCodexGlobalHealth } from "./codex-global-health.js";
import { reconcileCommDbRunningAgainstFsm } from "./commdb-fsm-reconcile.js";
import { commDbPathForProject, commDbRootDir } from "./commdb-path.js";
import {
	finalizeCommDbSession,
	pruneDeadTerminalCommDbSessions,
} from "./commdb-session-prune.js";
import {
	buildLoopbackBaseUrl,
	reconcileCompleteFailedMarkers,
} from "./complete-marker-reconciler.js";
import type { CrashReaperInjectedDeps } from "./crash-reaper.js";
import { buildDashboardPayload } from "./dashboard-data.js";
import { getDashboardHtml } from "./dashboard-html.js";
import { createDeploymentsRouter } from "./deployments-route.js";
import { loadDetectionGraceByProject } from "./detection-config-source.js";
import {
	buildCaseCEscalationInput,
	buildGapEscalationInput,
	CASE_C_ESCALATION_KIND,
	fallbackCaseCFingerprint,
	GAP_ESCALATION_KINDS,
} from "./detection-detector-wiring.js";
import {
	type DetectionEscalationInput,
	type EscalationOwner,
	formatEscalationLeadNote,
	notifyLeadFirst,
} from "./detection-escalation.js";
import {
	createFleetSink,
	createFounderPager,
	createSessionTargetResolver,
} from "./detection-escalation-sinks.js";
import {
	createSuspicionRegistry,
	defaultGapThresholds,
	evaluatedGapConditions,
	evaluateGapSuspicion,
	openGapReader,
	type SuspicionRecord,
} from "./detection-gap-scan.js";
import {
	notifyUnlessClearing,
	resolveClearedGapEpisodes,
	runDetectionReconcileTick,
} from "./detection-reconcile-tick.js";
import {
	buildPaneTail,
	deliverSuspiciousReport,
	formatSuspiciousThreadNote,
	type SuspiciousOwner,
	type SuspiciousReport,
} from "./detection-suspicious.js";
import { createDigestRouter } from "./digest-route.js";
import { DigestService } from "./digest-service.js";
import {
	parseSweepExcludeEnv,
	reconcileDoneButRunning,
} from "./done-running-reconciler.js";
import { archiveIssueThreadIfNoOtherActive } from "./done-thread-archiver.js";
import {
	reconcileDoneThreads,
	resolveDoneThreadReconcileConfig,
	startDoneThreadReconcileScheduler,
} from "./done-thread-reconcile.js";
import { EventFilter } from "./EventFilter.js";
import { createEventRouter } from "./event-route.js";
import { createExternalMergeReconciler } from "./external-merge-reconcile.js";
import { ProjectConfigCache } from "./feature-flag-config-source.js";
import { renderFlagReport } from "./feature-flag-report-html.js";
import {
	type FlagCanonical,
	type FlagRouteDeps,
	handleFlagApply,
	handleFlagStage,
} from "./flag-routes.js";
import { defaultFleetConsoleOptions, FleetConsole } from "./fleet-console.js";
import { getFleetConsoleHtml } from "./fleet-console-html.js";
import {
	buildDefaultFleetProbeDeps,
	ConfigSnapshotProvider,
	defaultLegacyBackendOf,
	FleetPoller,
	type FleetSnapshot,
	filterPaneWatchedLeads,
} from "./fleet-data.js";
import {
	handleApply,
	handleStage,
	loopbackSelfOrigin,
} from "./fleet-routes.js";
import { FleetSensors } from "./fleet-sensors.js";
import { createFocusedFrameScheduler } from "./focused-frame-scheduler.js";
import { startWorkflowSourceProjector } from "./founder-approval-projector.js";
import {
	buildFounderConsentWiring,
	buildGateResponsePostWriteHook,
} from "./founder-consent/wiring.js";
import { loadFounderMilestoneReportConfigByProject } from "./founder-milestone-config-source.js";
import { parseSqliteUtcMs } from "./founder-notify-utils.js";
// FLY-927 (Task 2.4): T2 escalation page reuses the FLY-818 stuck notification.
import { emitFounderStuckNotification } from "./founder-thread-notifier.js";
import { mountFounderUxRoutes } from "./founder-ux/routes.js";
import { GatePoller } from "./gate-poller.js";
import { buildSessionKey } from "./hook-payload.js";
import { buildInfraAlertRouting } from "./infra-alert-wiring.js";
import {
	formatAccountCapOwnerAssignment,
	formatRotationDigest,
	formatSwitchSuccessDigest,
	infraSenderTokenOr,
	postInfraNotifyDigest,
	resolveAccountCapOwnerId,
} from "./infra-notify.js";
import {
	derivePhaseDisplayState,
	type PhaseDisplayState,
	renderPhaseStatusLine,
} from "./issue-display.js";
import {
	IssueDisplayRefresher,
	type IssueDisplayRefreshHolder,
} from "./issue-display-refresher.js";
import { validateKindContracts } from "./kind-contract.js";
import { probeLaunchdJobAlive } from "./launchctl.js";
import {
	createBlockedMarkerReader,
	createClaimsClaimer,
	createClaimsReader,
	defaultLeadPaneCapture,
	resolveAlertDirsFromEnv,
} from "./lead-alert-helpers.js";
import { attemptLeadResumeEnter } from "./lead-resume-enter.js";
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
import {
	lookupLinearIssueByIdentifier,
	queryLinearIssues,
} from "./linear-query.js";
import {
	issueMatchesBinding,
	resolveLinearScope,
	resolveProjectNameParam,
} from "./linear-scope.js";
import { isSameOrigin as ffIsSameOrigin } from "./loopback-origin.js";
import { reapMcpOrphans } from "./mcp-descendant-reaper.js";
import { createMemoryRouter } from "./memory-route.js";
import { createMergedGateGuard } from "./merged-gate-guard.js";
import { notifyDigestExpectTick } from "./notify-digest-expect.js";
import { defaultReceiptsPath } from "./notify-receipts.js";
import { hashPane, liveRegion } from "./pane-live-region.js";
import {
	PhaseOrchestrator,
	type PhaseSession,
	type ThreeStageVerdictIntent,
	type TurnBeltRow,
} from "./phase-orchestrator.js";
import { postMergeTmuxCleanup } from "./post-merge.js";
import {
	type LifecycleShipInfra,
	makeFinalizeThreeStagePhases,
	setWorkflowShadowFinalizationHook,
} from "./post-ship-finalization.js";
import {
	buildCronModelViews,
	buildProjectRunnerDefaults,
} from "./project-runner-model-source.js";
import { patchSessionParams } from "./proofshot-session.js";
import { wirePublishBroker } from "./publish-broker/wire.js";
import { createPublishHtmlRouter } from "./publish-html-route.js";
import { settleReconnectTitlesAndRefresh } from "./reconnect-title-restore.js";
import { createRepoMutationLock } from "./repo-mutation-lock.js";
import {
	DEFAULT_RETENTION_MAX_AGE_MS,
	ReportRegistry,
} from "./report-registry.js";
import { createReportsRouter } from "./reports-route.js";
import { createRescueRouter, type RescueRouteRuntime } from "./rescue-route.js";
import {
	buildRescueRuntime,
	buildRescueSuccessorDispatchFields,
	makeCloseAndDispatchSuccessor,
	makeKickstart,
	makeRunnerRevalidate,
	type RescueRuntime,
} from "./rescue-runtime.js";
import type { IRetryDispatcher, IStartDispatcher } from "./retry-dispatcher.js";
import { ReviewRequestCoordinator } from "./review-request-coordinator.js";
import { EXECUTOR_TO_TRANSPORT } from "./role-adapter-resolver.js";
import { RoundtableThreadManager } from "./roundtable/RoundtableThreadManager.js";
import { loadRoundtableConfig } from "./roundtable/roundtable-config.js";
import { buildTopicTrigger } from "./roundtable/topic-trigger.js";
import { launchCommitPath } from "./run-dispatcher.js";
import { setupRunInfrastructure } from "./run-infra.js";
import { noteTicketEscalated } from "./runbook-gap.js";
import {
	defaultResolveLeadId,
	makeRunnerAuthScan,
} from "./runner-auth-scan.js";
import { makeRunnerQuotaScan } from "./runner-quota-scan.js";
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
import { ServerLossCoordinator } from "./server-loss.js";
import {
	captureSession as defaultCaptureSession,
	defaultGetCommDbPath,
	isCaptureError,
} from "./session-capture.js";
import { createShipApprovalHandler } from "./ship-approval-route.js";
import {
	defaultHasGateResponse,
	defaultIsAncestor,
} from "./ship-gate-rebind.js";
import {
	alertStaleBlockerToLead,
	createStaleBlockerGuard,
	finalizeStaleBlocker,
	type PrState,
} from "./stale-blocker-guard.js";
import { createStandupRouter } from "./standup-route.js";
import { StandupService } from "./standup-service.js";
import {
	buildStuckRunnerDetector,
	hasPendingBlockingGateFromCommDb,
	hasPendingGateFromCommDb,
	idleWatchdogPollMs,
	probeQuietSignals,
	stuckCommActivityMs,
	stuckLatchTtlMs,
} from "./stuck-escalation.js";
import {
	parseStuckConfirmKnobs,
	type StuckConfirmResult,
} from "./stuck-pane-confirm.js";
import { createStuckRemanageRouter } from "./stuck-remanage-routes.js";
import type { StuckRunnerDetector } from "./stuck-runner-detector.js";
import { resolveTerminalViewIdentity } from "./terminal-view-identity.js";
import { loadPipelineConfigByProject } from "./three-stage-config-source.js";
import {
	resolveHandoffDispatchChannelId,
	resolveThreeStagePolicy,
	threeStageKeepAliveEnabled,
} from "./three-stage-policy.js";
import {
	captureRunnerScrollback,
	getTmuxTargetFromCommDb,
	isTmuxWindowAlive,
	killCmuxLinkedSession,
	killTmuxWindow,
	lookupTmuxTarget,
	probeRunnerProcessLiveness,
	probeTmuxServer,
	sendEnterToWindow,
	sendKeysToWindow,
} from "./tmux-lookup.js";
import { type CaptureSessionFn, createQueryRouter } from "./tools.js";
import { createTriageDataRouter } from "./triage-data-route.js";
import { createTriageTemplateRouter } from "./triage-template-route.js";
import { type BridgeConfig, sqliteDatetime } from "./types.js";
import { createVoiceRouter } from "./voice-routes.js";
import {
	createWatchdogJudge,
	routeSuspiciousReport,
} from "./watchdog-judge.js";
import {
	createJudgeRoutingDepsFactory,
	createStuckConfirmRunner,
} from "./watchdog-judge-assembly.js";
import { createWorkflowDecisionRouter } from "./workflow-decision-routes.js";
import { createWorkflowShadowWriterFromEnv } from "./workflow-shadow-writer.js";
import { createWorkflowTemplateRouter } from "./workflow-template-routes.js";
import {
	gitWorktreeClean,
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

	const backend = resolveCommBackend();

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

/** FLY-203: parse FLYWHEEL_REPORTS_TTL_DAYS (days) → ms. Invalid/absent →
 * default 7 days; "0" disables age-based expiry. */
function resolveReportsTtlMs(raw: string | undefined): number {
	if (raw !== undefined && /^\d+$/.test(raw.trim())) {
		return Number(raw.trim()) * 24 * 60 * 60 * 1000;
	}
	return DEFAULT_RETENTION_MAX_AGE_MS;
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
	vercelToken?: string;
	/** FLY-1185: ship-entry lifecycle bundle built in startBridge. */
	lifecycleInfra?: LifecycleShipInfra;
	/** FLY-1185 §2.11: the shared per-repo mutation lock (startBridge-owned). */
	withRepoLock?: <T>(mainRepoPath: string, fn: () => Promise<T>) => Promise<T>;
	/** FLY-1185 §2.12: park/unpark + approved-manifest apply routers. */
	lifecycleRoutes?: {
		parkRouter: import("express").Router;
		applyRouter: import("express").Router;
	};
	/** FLY-91 Round 3: Bridge-level shared ChatThreadCreator instance. */
	chatThreadCreator?: ChatThreadCreator;
	/** FLY-91 Round 3: Global Discord bot token for thread creation fallback. */
	globalBotToken?: string;
	/**
	 * FLY-253 (Codex R2 #4): late-bound holder connecting the stuck-remanage
	 * router's `re_arm` to the live StuckRunnerDetector. The router mounts
	 * inside createBridgeApp (pre-listen) but the detector is only created
	 * post-listen in startBridge — so the router gets a STABLE callback that
	 * reads this holder at call time. `current` stays null when detection is
	 * disabled (FLYWHEEL_STUCK_DETECT=0): re_arm still deletes the DB latch.
	 */
	stuckDetectorHolder?: { current: StuckRunnerDetector | null };
	/**
	 * FLY-204: late-bound holder connecting the unauthenticated /health route to
	 * RunnerIdleWatchdog, which is constructed post-listen in startBridge.
	 * Absent / null (standalone createBridgeApp or boot window) reports an
	 * explicit unavailable snapshot instead of implying a dead poll loop.
	 */
	idleWatchdogHealthHolder?: {
		current: IdleWatchdogHealthProvider | null;
	};
	/**
	 * FLY-623 (Codex R2 MED-5): late-bound holder connecting the event router +
	 * idle watchdog to the live HeartbeatService reconnecting set. Both are wired
	 * inside createBridgeApp (pre-listen) but HeartbeatService is constructed
	 * post-listen in startBridge — so they read this holder at call time. `current`
	 * stays null on the kill-switch / standalone path (no reconnecting suppression
	 * or clear), which is byte-compatible with pre-FLY-623 behavior.
	 */
	reconnectHolder?: { current: ReconnectController | null };
	/**
	 * FLY-579: late-bound holder for the auto-QA coordinator. The /events route
	 * mounts inside createBridgeApp (pre-listen), but the coordinator is built
	 * later in startBridge (it needs the LeadAlertNotifier) — so the event router
	 * reads `.current` at request time. Absent / `.current` undefined ⇒ auto-QA
	 * fully dormant (no held records, byte-compatible).
	 */
	autoQaCoordinator?: { current: AutoQaCoordinator | undefined };
	/**
	 * FLY-1188 §7.1: late-bound holder for the codex-author review-request
	 * coordinator. The /review-requests route mounts inside createBridgeApp
	 * (pre-listen); the coordinator is built post-listen in startBridge. Absent
	 * / `.current` undefined ⇒ the route answers 503 (fail-close — a runner's
	 * request-review CLI retries and, on exhaustion, exits non-zero).
	 */
	reviewCoordinator?: { current: ReviewRequestCoordinator | undefined };
	/**
	 * FLY-793: late-bound holder for the three-stage PhaseOrchestrator. The
	 * /events route mounts inside createBridgeApp (pre-listen), but the
	 * orchestrator is built later in startBridge (it needs startDispatcher +
	 * LeadAlertNotifier), so the event router reads `.current` at request time.
	 * Absent / `.current` undefined ⇒ three-stage dormant (byte-compatible).
	 */
	phaseOrchestrator?: { current: PhaseOrchestrator | undefined };
	/**
	 * FLY-516: late-bound shutdown flag. The /health route mounts inside
	 * createBridgeApp (pre-listen) but close() lives in startBridge — so /health
	 * reads this holder at request time and close() flips it at teardown start.
	 * Absent (standalone createBridgeApp / tests) ⇒ /health reports
	 * shuttingDown:false (byte-compat). Mirrors stuckDetectorHolder.
	 */
	shutdownStateHolder?: { shuttingDown: boolean };
	/**
	 * FLY-253 L2: TTL for execution-scoped latches, parsed ONCE from
	 * `FLYWHEEL_STUCK_LATCH_TTL_MS` at startup (Codex R2 #5) and injected
	 * into the remanage router. Undefined ⇒ router default (72h).
	 */
	stuckLatchTtlMs?: number;
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
	 * (pre-listen), but the refresher is built post-listen in startBridge (it
	 * needs AutoQaEffects) — so every surface reads `.current` at fire time.
	 * Absent / `.current` undefined ⇒ triggers dormant and the stage_changed
	 * path falls back to the legacy stamp+pin (byte-compat / the
	 * FLYWHEEL_ISSUE_DISPLAY_REFRESH=0 escape hatch).
	 */
	issueDisplayRefresh?: IssueDisplayRefreshHolder;
	/**
	 * FLY-871 R2/C5: the /api/account-switch route (mounted in createBridgeApp)
	 * reads this holder at request time; startBridge sets `.current` only when
	 * accountSwitchRepair + the unified Alerts channel exist
	 * (the account pool is provisioned; FLY-1243). Undefined ⇒ the route returns 409 needs_human
	 * (self-heal off = byte-compat).
	 */
	accountSwitchRoute?: { current?: AccountSwitchRuntime };
	/**
	 * FLY-871 R3/C9: the /api/rescue route (mounted in createBridgeApp) reads this
	 * holder at request time; startBridge sets `.current` only when the rescue
	 * runtime is built (account pool provisioned + unified Alerts channel; FLY-1243).
	 * Undefined ⇒ the route returns 409 needs_human (self-heal off = byte-compat).
	 */
	rescueRoute?: { current?: RescueRouteRuntime };
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

function unavailableIdleWatchdogHealth(): IdleWatchdogHealth {
	return {
		timerRunning: false,
		pollIntervalMs: null,
		pollInProgress: false,
		lastPollAt: null,
		lastPollResult: null,
		activeRunningSessions: null,
	};
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

	// FLY-1244: scoped workflow decisions authenticate with a per-execution
	// credential, never the fleet ingest bearer. The head read route is a separate
	// loopback-only fail-closed seam used by verify-approval; it is not credential
	// authenticated and exposes only the execution's git SHA.
	app.use(
		"/api/workflow",
		createWorkflowDecisionRouter({
			store,
			phaseOrchestrator: opts?.phaseOrchestrator,
			...(process.env.FLYWHEEL_WORKFLOW_CLAIMS_WRITE === "1" &&
			opts?.fleetConsole &&
			opts.phaseOrchestrator
				? {
						reQa: {
							tokens: opts.fleetConsole.tokens,
							respawn: async (canonical, prHeadSha) => {
								const orchestrator = opts.phaseOrchestrator?.current;
								if (!orchestrator) {
									throw new Error("phase_orchestrator_not_ready");
								}
								const source = store.getSession(canonical.sourceExecutionId);
								if (!source) throw new Error("source_session_not_found");
								return orchestrator.respawnUnenrolledQa(
									source,
									prHeadSha,
									canonical.targetAttempt,
								);
							},
						},
					}
				: {}),
		}),
	);
	app.use("/api/workflow", createWorkflowTemplateRouter(store));

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
		// FLY-516: startBridge's close() flips shutdownStateHolder.shuttingDown at
		// the top of teardown, so /health stops claiming "ready" the moment
		// shutdown begins. flywheel-bridge-wrapper.sh probes this to tell a healthy
		// serving Bridge apart from a zombie stuck mid-close() that still answers
		// /health 200 — the latter must yield its port, not be mistaken for a live
		// double-start. Read at request time via the late-bound holder (mirrors
		// stuckDetectorHolder); absent (standalone createBridgeApp) ⇒ false.
		const shuttingDown = opts?.shutdownStateHolder?.shuttingDown === true;
		const watchdog =
			opts?.idleWatchdogHealthHolder?.current?.health() ??
			unavailableIdleWatchdogHealth();
		res.json({
			// `ok` is byte-compatible (true in steady state); it flips false during
			// shutdown so the deploy health check + wrapper preflight treat a
			// draining Bridge as not-ready. `shuttingDown` is additive.
			ok: !shuttingDown,
			shuttingDown,
			uptime: process.uptime(),
			sessions_count: active.length,
			watchdog,
		});
	});

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
			opts?.phaseOrchestrator, // FLY-1050: terminate → QA-loss re-drive
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
	// titles. Default ON; set FLYWHEEL_ISSUE_STATUS_EMOJI=0 to disable. Passing
	// the creator only when enabled keeps byte-compat (createEventRouter without
	// it = no stamping). Naturally a no-op when chat threads are off
	// (opts.chatThreadCreator is only set when chatThreadsEnabled).
	const issueStatusEmojiEnabled =
		process.env.FLYWHEEL_ISSUE_STATUS_EMOJI !== "0";
	// FLY-560 Feature C: pin a `tmux attach` rescue command on each issue thread.
	// Default ON; set FLYWHEEL_ISSUE_ATTACH_PIN=0 to disable. Independent from the
	// emoji flag — the creator is passed when EITHER feature is on, and each
	// behaviour is gated separately inside createEventRouter (all 4 combos clean).
	const issueAttachPinEnabled = process.env.FLYWHEEL_ISSUE_ATTACH_PIN !== "0";
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
			opts?.autoQaCoordinator,
			opts?.phaseOrchestrator,
			opts?.accountRotationPost,
			opts?.issueDisplayRefresh, // FLY-907
			lifecycleInfra, // FLY-1185 entry A bundle
		),
	);

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

	// FLY-598: founder-facing UX gate routes. Mounted BEFORE the broad `/api`
	// token middleware so the ingest-token status READ is not shadowed by the
	// api-token middleware (Codex R3-#1). Always mounted (per-request, operates
	// on session state) — byte-compatible at the prompt/stage layer; the
	// per-project mode gates the runner injection + the stage guard, not these
	// routes. Signoff WRITE fail-closes unless apiToken is set AND distinct from
	// the ingest token (Codex R2-#1 / R3-#2).
	mountFounderUxRoutes(app, {
		store,
		projects,
		founderUserId: config.founderConsent?.founderUserId ?? "",
		ingestToken: config.ingestToken,
		apiToken: config.apiToken,
		discordBotToken: config.discordBotToken,
	});

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
				res.json(fleetConsole.buildSnapshot());
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
				res.write(`event: progress\ndata: ${JSON.stringify({ batches })}\n\n`);
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

		// FLY-709 P2: feature-flag toggle (copy-paste-apply). Same loopback +
		// same-origin + confirmToken auth as the fleet routes; reuses the console's
		// token store + audit. Only direct-toggle flags are accepted (server
		// allow-set is authority; governance/restart-type refused in handleFlagStage).
		const flagRouteDeps: FlagRouteDeps = {
			envPath: join(homedir(), ".flywheel", ".env"),
			readFile: (p) => ffReadFileSync(p, "utf-8"),
			tokens: fleetConsole.tokens,
			audit: fleetConsole.audit,
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
				canonical?: FlagCanonical;
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
		tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
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
			opts?.phaseOrchestrator, // FLY-1050: terminate → QA-loss re-drive
		),
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

	// GEO-270: Close stale tmux session (resource cleanup, no status change)
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
			const tmuxProtectedStates = new Set(["running", "approved_to_ship"]);
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
			// FLY-253: stable callback over the late-bound holder (Codex R2 #4);
			// null holder / null detector ⇒ no-op, DB latch still deleted.
			onRearm: (executionId) =>
				opts?.stuckDetectorHolder?.current?.rearmExecution(executionId),
			...(opts?.stuckLatchTtlMs !== undefined
				? { latchTtlMs: opts.stuckLatchTtlMs }
				: {}),
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
					if (runtime) {
						const envelope: import("./lead-runtime.js").LeadEventEnvelope = {
							seq,
							event: payload,
							sessionKey: "stale-patrol",
							leadId,
							timestamp: new Date().toISOString(),
						};
						const result = await runtime.deliver(envelope);
						if (result.delivered) {
							store.markLeadEventDelivered(seq);
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

	// GEO-267: /api/runs — start new Runner executions
	if (startDispatcher) {
		// FLY-742: stale-blocker guard for the run-start 409 path. Own fsm/executor
		// (stateless config) since the shared transitionOpts is built later in
		// setup; teardown primitives are the same module-level fns crash-reaper
		// uses (equivalent to close_runner done=true). Default-on;
		// FLYWHEEL_CRON_STALE_GUARD=0 → unchanged 409 (byte-compat).
		const staleGuardTransitionOpts: ApplyTransitionOpts = {
			store,
			fsm: new WorkflowFSM(WORKFLOW_TRANSITIONS),
			executor: new DirectiveExecutor(store),
			// FLY-907 (Codex R1 #1): this INDEPENDENT opts instance bypasses the
			// shared transitionOpts object — hook it too, or a stale-blocker
			// finalization (stale blocker → completed) never refreshes the display.
			onTransition: (executionId, _targetStatus, ctx) => {
				const issueId = ctx.issueId ?? store.getSession(executionId)?.issue_id;
				if (issueId) opts?.issueDisplayRefresh?.current?.enqueue(issueId);
			},
		};
		const staleBlockerGuard = createStaleBlockerGuard({
			enabled: process.env.FLYWHEEL_CRON_STALE_GUARD !== "0",
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
						if (!runtime) return { delivered: false, error: "no lead runtime" };
						return runtime.deliver(envelope);
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
	const reportsEnabled = process.env.FLYWHEEL_REMOTE_REPORTS !== "0";
	const reportsRouter = createReportsRouter({
		enabled: reportsEnabled,
		vercelToken: opts?.vercelToken,
		// FLY-929 W3b ①: sender = Claude Infra Bot when P-identity holds (BOTH
		// CLAUDE_INFRA_BOT_TOKEN + FLYWHEEL_NOTIFY_CHANNEL), else the legacy
		// global bot token byte-for-byte. Once live there is NO Simba fallback on
		// delivery failure — the P-expect receipt check owns fail-loud.
		discordBotToken: infraSenderTokenOr(opts?.globalBotToken),
		projects,
		registry: new ReportRegistry(reportsBaseDir, {
			// FLY-203 follow-up (founder): report links expire after 7 days.
			// FLYWHEEL_REPORTS_TTL_DAYS overrides (positive integer; 0 disables).
			retentionMaxAgeMs: resolveReportsTtlMs(
				process.env.FLYWHEEL_REPORTS_TTL_DAYS,
			),
		}),
	});
	if (config.apiToken) {
		app.use(
			"/api/reports",
			tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
			reportsRouter,
		);
	} else {
		app.use("/api/reports", (_req, res) => {
			res.status(503).json({
				error: "reports API requires TEAMLEAD_API_TOKEN",
			});
		});
	}

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
			tz: process.env.FLYWHEEL_DIGEST_TZ ?? "America/Los_Angeles",
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

	// FLY-871 R2/C5: POST /api/account-switch — the Codex Infra Bot's claim+execute
	// entry for a Claude account switch. AUTH-REQUIRED (503 without TEAMLEAD_API_TOKEN),
	// deliberately NOT under /actions. Reads the late-bound runtime holder (bound in
	// startBridge only when self-heal is on) → off ⇒ 409 needs_human (byte-compat).
	if (config.apiToken) {
		app.use(
			"/api/account-switch",
			tokenAuthMiddleware(config.apiToken, config.geminiAgentToken),
			createAccountSwitchRouter({
				getRuntime: () => opts?.accountSwitchRoute?.current,
			}),
		);
	} else {
		app.use("/api/account-switch", (_req, res) => {
			res.status(503).json({
				error: "account-switch API requires TEAMLEAD_API_TOKEN",
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
	if (projects.length === 0) {
		throw new Error(
			"No projects configured — check FLYWHEEL_PROJECTS or project config",
		);
	}

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
	try {
		writeRunningMarker(bridgeMarker, process.pid, Date.now());
	} catch (err) {
		console.warn(
			`[bridge-exit-marker] running-marker write failed (non-fatal): ${(err as Error).message}`,
		);
	}

	// FLY-1062 (plan §3): the publish broker. Its two outward-publish tokens are
	// read AND SCRUBBED from process.env here — before any child spawn path can
	// inherit them — whether or not the feature is enabled. Default OFF
	// (FLYWHEEL_PUBLISH_BROKER=1 enables; reverse-compat sentinel): enabled, it
	// owns the unix-socket request surface + the founder ✅-reaction approval
	// observation. A wiring failure is fail-closed for PUBLISHING only — the
	// Bridge still boots.
	const publishBrokerHandle = await wirePublishBroker({
		env: process.env,
		stateDir: join(homedir(), ".flywheel"),
		discordBotToken: config.discordBotToken,
		discordOwnerUserId: config.discordOwnerUserId,
		founderConsentUserId: config.founderConsent?.founderUserId,
		log: (line) => console.log(line),
	}).catch((err) => {
		console.warn(
			`[publish-broker] wiring failed (publishes unavailable): ${(err as Error).message}`,
		);
		return null;
	});

	// FLY-1082: late-bound fleet holders — the sensors need the routed alert
	// sink (built late) while HeartbeatService/AutoRepairBot (built earlier)
	// need callbacks into them. Holders break the ordering cycle.
	const fleetSensorsHolder: { current: FleetSensors | null } = {
		current: null,
	};
	const serverLossHolder: { current: ServerLossCoordinator | null } = {
		current: null,
	};

	const store = opts?.store ?? (await StateStore.create(config.dbPath));
	// FLY-1244: deterministic boot import. Content hashes make restarts no-ops;
	// a founder-owned seed mismatch is audited and refused by StateStore.
	importBundledWorkflowSeeds(store);
	const workflowSourceProjector = startWorkflowSourceProjector({
		projects: () => loadProjects().map((project) => project.projectName),
		openCommDb: (project) => new CommDB(commDbPathForProject(project)),
		store,
		log: (message) => console.warn(message),
	});

	// FLY-1082 (Task 2.2): the fleet pressure-hold gates runner admission —
	// late-bind the probe now that the store exists. Fail-open inside tryAdmit.
	// runnerAdmission is optional on the config (scaffold/test bridges omit it).
	config.runnerAdmission?.setPressureHoldProbe(() => {
		const hold = store.getFleetPressureHold();
		return hold
			? `fleet pressure-hold active since ${hold.set_at} (by ${hold.set_by}, memory ${hold.watermark ?? "?"}) — lifts automatically once real memory pressure is proven healthy (free% recovered + swapout quiet)`
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
	// itself is built post-listen (it needs AutoQaEffects). Master escape hatch:
	// FLYWHEEL_ISSUE_DISPLAY_REFRESH=0 leaves `.current` unset forever → all
	// NEW trigger surfaces stay dormant and stage_changed uses the legacy
	// stamp+pin path (pre-FLY-907 behavior).
	const issueDisplayRefreshEnabled =
		process.env.FLYWHEEL_ISSUE_DISPLAY_REFRESH !== "0";
	const issueDisplayRefreshHolder: IssueDisplayRefreshHolder = {};
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
		onTransition: (executionId, _targetStatus, ctx) => {
			const issueId = ctx.issueId ?? store.getSession(executionId)?.issue_id;
			if (issueId) issueDisplayRefreshHolder.current?.enqueue(issueId);
		},
	};
	// FLY-247: fleet config snapshot provider (hot fleet-field overlay onto
	// the boot topology; structural change → restart-required, R3#4) + the
	// 30s evidence poller (single probe owner for Dashboard + watchdog, R6#5).
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
	});
	fleetPoller.start();
	console.log("[Bridge] FleetPoller started (30s evidence collection)");
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

	// FLY-247 inc2a: Fleet console (founder-admin surface). Local-first; default
	// ON, `FLYWHEEL_FLEET_CONSOLE=0` falls back to the old dashboard + no fleet
	// routes (byte-compat escape hatch). The console reads the live hot-overlay
	// topology + computes everything server-side (secret-free DTO). Env-pinned
	// (FLYWHEEL_PROJECTS) deployments can't run the engine (split-brain guard), so
	// the console is disabled there too.
	let fleetConsole: FleetConsole | undefined;
	// Hoisted so close() can clear it (Codex R3 MEDIUM-1: a block-local timer +
	// an un-closed console keep recovering batches / hold the audit handle after
	// shutdown).
	let fleetReconcileTimer: ReturnType<typeof setInterval> | undefined;
	if (
		process.env.FLYWHEEL_FLEET_CONSOLE !== "0" &&
		!process.env.FLYWHEEL_PROJECTS
	) {
		try {
			const here = dirname(fileURLToPath(import.meta.url));
			const repoRoot =
				process.env.FLYWHEEL_REPO_ROOT?.trim() ||
				resolve(here, "..", "..", "..", "..");
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
			void ffConfigCache
				.get(fleetConfigProvider.snapshot().projects)
				.catch(() => {});
			fleetConsole = new FleetConsole(
				defaultFleetConsoleOptions({
					fleetScriptPath,
					commCliPath,
					liveProjects: () => fleetConfigProvider.snapshot().projects,
					legacyBackendOf: (p) => fleetLegacyBackendOf(p),
					// Online dot from the live evidence poller (null/stale → unknown).
					fleetEvidence: () => fleetPoller.snapshot(),
					// FLY-709 P4: stat-and-reload-on-change before a snapshot build.
					refreshProjectConfigs: () =>
						ffConfigCache
							.get(fleetConfigProvider.snapshot().projects)
							.then(() => undefined)
							.catch(() => undefined),
					// FLY-709: resolved feature-flag views (env fresh + cached configs).
					featureFlags: () =>
						resolveAllFlags({
							env: process.env,
							projectConfigs: ffConfigCache.current(),
						}),
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
						),
					logger: (msg) => console.log(msg),
				}),
			);
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
			// FLY-71: Standup is CoS (Simba) responsibility per product spec §2.1
			const cos = leads.find((l) => l.agentId.includes("cos"));
			return cos?.agentId ?? leads[0]?.agentId ?? "unknown";
		})();
	const standupLead = (standupProject?.leads ?? []).find(
		(l) => l.agentId === standupLeadId,
	);
	if (standupProjectName && !standupLead) {
		console.warn(
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
	if (standupProjectName) {
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
	// FLY-579: late-bound auto-QA coordinator holder — read by the event router
	// (createBridgeApp) AND the in-process DirectEventSink (via
	// setupRunInfrastructure below). The coordinator is built post-listen (it
	// needs the LeadAlertNotifier), so .current stays undefined until then =
	// auto-QA dormant (byte-compatible).
	const autoQaCoordinatorHolder: { current: AutoQaCoordinator | undefined } = {
		current: undefined,
	};

	// FLY-1188 §7.1: late-bound review-request coordinator holder — read by the
	// /review-requests route (createBridgeApp). Built post-listen; until then
	// the route answers 503 (the runner CLI retries, fail-close on exhaustion).
	const reviewCoordinatorHolder: {
		current: ReviewRequestCoordinator | undefined;
	} = { current: undefined };

	// FLY-793: late-bound three-stage PhaseOrchestrator holder — read by BOTH the
	// /events router (createBridgeApp) and the in-process DirectEventSink (via
	// setupRunInfrastructure). Built post-listen (it needs startDispatcher +
	// LeadAlertNotifier), so `.current` stays undefined until then = three-stage
	// dormant (byte-compatible).
	const phaseOrchestratorHolder: {
		current: PhaseOrchestrator | undefined;
	} = { current: undefined };

	// FLY-887 (founder-visibility status line, Finding B): the refresh function
	// is only ready once phaseQaEffects is built (post-listen), but
	// finalizeThreeStagePhases is wired here at construction time — mirrors the
	// same forward-reference pattern as the two holders above. Populated where
	// the PhaseOrchestratorDeps.refreshPhaseStatusLine dep is built, so ship-time
	// finalization refreshes the line to its final done/done/done state instead
	// of going stale at whatever it last showed pre-merge.
	const phaseStatusLineRefreshHolder: {
		current: ((issueId: string) => Promise<void>) | undefined;
	} = { current: undefined };

	// FLY-887 + FLY-1204: single shared ship-time finalizer for the three-stage
	// keep-alive parked phases (design/implement/qa). Constructed once so BOTH
	// the in-process run-infra path AND the external-merge reconciler drive the
	// same reclaim logic — an external merge is a real ship path and must not
	// leak the parked phase sessions.
	const finalizeThreeStagePhases = makeFinalizeThreeStagePhases(
		store,
		transitionOpts,
		(issueId) =>
			phaseStatusLineRefreshHolder.current?.(issueId) ?? Promise.resolve(),
	);

	// ── FLY-1185: unified lifecycle-closeout infrastructure, built ONCE ──
	// repo mutation lock (§2.11) + issue mutex (R10#2) + per-project cleanup
	// policies (§2.10, built BEFORE any boot deleter runs) + the ship-entry
	// bundle threaded to all three finalization call sites (event-route ×2 via
	// createBridgeApp opts + the DirectEventSink below). Merge-enable by
	// contract (Annie 直令): zero new flags — every NEW deleter hangs off the
	// existing FLYWHEEL_WORKTREE_AUTOCLEAN escape hatch inside its module.
	const repoMutationLock = createRepoMutationLock();
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
				return { ok: false, reason: "root_uuid_conflict" };
			}
			const rootKey = res.ok ? res.rootKey : issueId;
			const lockKeys = res.lockKeys.length > 0 ? res.lockKeys : [issueId];
			const checks = async () => {
				if (
					isUuidKey(rootKey) &&
					store.getActiveIssueDispositionIntent(rootKey)
				) {
					return { ok: false, reason: "founder_parked" };
				}
				const obs = store.getLinearStateObservation(projectName, rootKey);
				if (obs?.lastStateType === "canceled") {
					return { ok: false, reason: "canceled_observation" };
				}
				if (config.linearApiKey) {
					try {
						const { LinearClient } = await import("@linear/sdk");
						const client = new LinearClient({
							apiKey: config.linearApiKey as string,
						});
						const issue = await client.issue(issueId);
						const state = await issue.state;
						if (state?.type === "canceled") {
							return { ok: false, reason: "canceled_fresh_linear" };
						}
					} catch {
						// R3#9: a failed FRESH read is fail-closed BUT retryable —
						// the refusal happens before the dedupe claim, so the next
						// finalization attempt re-arbitrates from scratch.
						return { ok: false, reason: "linear_lookup_failed_retryable" };
					}
				}
				return { ok: true };
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
			return { outcome: report.outcome };
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
	// FLY-1232 module ②: THE single default-off switch point for the lifecycle
	// shadow writer. FLYWHEEL_WORKFLOW_CLAIMS_WRITE≠1 → undefined → every seam
	// (dispatcher pre-launch, orchestrator hooks, post-ship T9) stays undefined
	// = byte-compatible. Evidence probes are the DURABLE facts of the ②b truth
	// table: the adapter's commit-marker file + a non-:pending CommDB row.
	// NOTE (plan §0 red line): an externally injected opts.startDispatcher
	// below bypasses setupRunInfrastructure and is deliberately NOT wrapped.
	const workflowShadowWriter = createWorkflowShadowWriterFromEnv(
		process.env,
		store,
		{
			hasCommitMarker: (executionId) =>
				ffExistsSync(launchCommitPath(executionId)),
			hasNonPendingCommDbRow: (projectName, executionId) => {
				// Tri-state (research §F.3 lookup_error, Codex code R1 #1): a
				// missing CommDB file PROVES absence (no session was ever
				// registered for the project) → false; a failed lookup proves
				// nothing → "unknown" (never authorizes an abandon, never
				// completes the started dual evidence).
				try {
					const dbPath = defaultGetCommDbPath(projectName);
					if (!ffExistsSync(dbPath)) return false;
					const db = new CommDB(dbPath);
					try {
						const s = db.getSession(executionId) as
							| { tmux_window?: string }
							| undefined;
						return !!s && !String(s.tmux_window ?? "").endsWith(":pending");
					} finally {
						db.close();
					}
				} catch {
					return "unknown";
				}
			},
		},
	);
	if (workflowShadowWriter) {
		console.log(
			"[Bridge] FLY-1232: workflow shadow writer ENABLED (FLYWHEEL_WORKFLOW_CLAIMS_WRITE=1) — observation-only dual write",
		);
		// Codex code R1 #5: the T9 hook is resolved centrally inside
		// runPostShipFinalization so EVERY in-process claim contender
		// (DirectEventSink / event-route / merge-ship-gate) fires it.
		setWorkflowShadowFinalizationHook(workflowShadowWriter);
	}

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
					chatThreadCreator,
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
					// FLY-1185 (R11#1): park admission at the dispatcher chokepoint.
					lifecycleAdmission: (input) =>
						assertIssueNotLifecycleClosed(
							{ store, withIssueMutex: issueMutex },
							input,
						),
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
							return issueMutex(keys, async () => {
								if (
									store.casLaunchClaimState(executionId, "starting", "active")
								) {
									return { ok: true };
								}
								const fresh = store.getLaunchClaim(executionId);
								if (!fresh || fresh.state === "active") return { ok: true };
								return { ok: false, reason: `claim_${fresh.state}` };
							});
						},
						onSpawnFailed: (executionId: string) => {
							store.setLaunchClaimState(executionId, "closed");
						},
					},
					// FLY-579: the in-process completed path drives auto-QA + holds
					// the founder via this same holder.
					autoQaCoordinator: autoQaCoordinatorHolder,
					// FLY-793: the in-process completion path drives three-stage
					// Design→Implement→QA phase handoffs via this same holder.
					phaseOrchestrator: phaseOrchestratorHolder,
					// FLY-887: ship-time finalizer for keep-alive parked phases
					// (FLY-1204: shared with the external-merge reconciler below).
					finalizeThreeStagePhases,
					// FLY-907: the in-process sink's display-refresh holder (its
					// upsertSession writes bypass the applyTransition hook).
					issueDisplayRefresh: issueDisplayRefreshHolder,
					// FLY-1232: dispatcher pre-launch seam + DirectEventSink T9 hook
					// (undefined when the flag is OFF — byte-compatible).
					workflowShadow: workflowShadowWriter,
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

	// FLY-253 (Codex R2 #4): the remanage router mounts inside createBridgeApp,
	// but the StuckRunnerDetector is only created post-listen — give the router
	// a stable holder it reads at re_arm time.
	const stuckDetectorHolder: { current: StuckRunnerDetector | null } = {
		current: null,
	};
	const idleWatchdogHealthHolder: {
		current: IdleWatchdogHealthProvider | null;
	} = {
		current: null,
	};

	// FLY-516: shared shutdown flag — /health (in createBridgeApp) reads it,
	// close() (below) flips it at teardown start.
	const shutdownStateHolder: { shuttingDown: boolean } = {
		shuttingDown: false,
	};

	// FLY-623: shared reconnecting-set holder — the event router + idle watchdog
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

	// FLY-871 R2/C5: the /api/account-switch route reads this holder at request
	// time; set below (with accountRotationPostHolder) only when accountSwitchRepair
	// + the unified Alerts channel exist. Undefined ⇒ route returns 409 needs_human.
	const accountSwitchRouteHolder: { current?: AccountSwitchRuntime } = {};

	// FLY-871 R3/C9: the /api/rescue route reads this holder at request time; set
	// below only when the rescue runtime is built (self-heal on + unified Alerts
	// channel). Undefined ⇒ route returns 409 needs_human (byte-compat).
	const rescueRouteHolder: { current?: RescueRouteRuntime } = {};

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
			// FLY-1185: ship-entry bundle + shared repo lock for createBridgeApp's
			// /events router + Layer A closure.
			lifecycleInfra,
			withRepoLock: repoMutationLock.withRepoLock,
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
					apiTokenConfigured: Boolean(config.apiToken),
				};
				return {
					parkRouter: createLifecycleRouter(routeDeps),
					applyRouter: createLifecycleApplyRouter(routeDeps),
				};
			})(),
			chatThreadCreator,
			globalBotToken: config.discordBotToken,
			// FLY-253: holder filled after the detector is created post-listen.
			stuckDetectorHolder,
			// FLY-204: /health reads this after RunnerIdleWatchdog is constructed.
			idleWatchdogHealthHolder,
			stuckLatchTtlMs: stuckLatchTtlMs(),
			fleetConsole,
			// FLY-516: /health reads this; close() flips it at teardown start.
			shutdownStateHolder,
			// FLY-623: event router reads this to clear reconnecting on a real event.
			reconnectHolder,
			// FLY-579: event router reads this to drive the auto-QA pipeline.
			autoQaCoordinator: autoQaCoordinatorHolder,
			// FLY-1188 §7.1: /review-requests route reads this holder.
			reviewCoordinator: reviewCoordinatorHolder,
			// FLY-793: event router reads this to drive three-stage phase handoffs.
			phaseOrchestrator: phaseOrchestratorHolder,
			// FLY-696 M1/④: event router reads this to post account_rotation notices.
			accountRotationPost: accountRotationPostHolder,
			// FLY-871 R2/C5: /api/account-switch route reads this holder.
			accountSwitchRoute: accountSwitchRouteHolder,
			rescueRoute: rescueRouteHolder,
			// FLY-907: unified issue-display refresher (populated post-listen).
			issueDisplayRefresh: issueDisplayRefreshHolder,
		},
	);

	// FLY-725 (Codex R2 #1): capture the milestone-report baseline cutoff BEFORE
	// the Bridge starts accepting events. On the first patrol after this project
	// first enables the feature, terminal sessions with `last_activity_at <= cutoff`
	// are treated as pre-boot history (marker-seeded, not pinged); a Runner that
	// completes AFTER we start listening (but before the first patrol) is > cutoff
	// and still pings, so the startup window cannot swallow a real milestone.
	const founderMilestoneBaselineCutoffMs = Date.now();

	const server = app.listen(config.port, config.host);

	await new Promise<void>((resolve, reject) => {
		server.once("listening", resolve);
		server.once("error", reject);
	});

	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : config.port;
	console.log(`[Bridge] Listening on ${config.host}:${port}`);

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
					process.env.FLYWHEEL_ISSUE_STATUS_EMOJI !== "0"
						? chatThreadCreator
						: undefined,
					issueDisplayRefreshHolder,
				)
			: {
					// FLY-637 R1 #2: no-op notifier never persists an event → false, so
					// checkStuck does not durably dedup a wake that never happened.
					onSessionStuck: async () => false,
					onSessionOrphaned: async () => {},
					onSessionStale: async () => {},
					onSessionMonitoringLost: async () => {},
					onSessionMonitoringReestablished: async () => {},
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

	// FLY-626: shared cheap quiet-signal probe for the stall watchdogs
	// (HeartbeatService session_stuck + RunnerIdleWatchdog runner_idle_detected).
	// Suppresses the (token-expensive) Lead wake for a legitimately-quiet runner
	// (self-declared park/busy, parked at a gate, recently active).
	// `FLYWHEEL_QUIET_CLASSIFIER=0` disables it → pre-FLY-626 all-wake behavior.
	const quietClassifierEnabled = process.env.FLYWHEEL_QUIET_CLASSIFIER !== "0";
	const quietSignalsProbe = quietClassifierEnabled
		? (session: {
				execution_id: string;
				project_name: string;
				status: string;
				// FLY-637 #1: the watchdogs pass the full Session row, so these reach
				// probeQuietSignals for the explicit FLY-324 done-but-running skip.
				session_stage?: string | null;
				decision_route?: string | null;
				pr_number?: number | null;
			}) =>
				probeQuietSignals(session, {
					activityWindowMs: stuckCommActivityMs(),
					nowMs: Date.now(),
				})
		: undefined;

	// FLY-720: crash-reaper injected deps. Default ON; `FLYWHEEL_CRASH_REAPER=0`
	// disables the whole reaper (falls back to reapOrphans→failed). Grace defaults
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
		enabled: process.env.FLYWHEEL_CRASH_REAPER !== "0",
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
		// FLY-1050: a reaped three-stage QA row may have stranded its implement
		// at awaiting_review — fire the scoped QA-loss re-drive (fire-and-forget;
		// the holder is late-bound, undefined pre-wiring = no-op; boot reconcile
		// is the backstop either way).
		onQaPhaseTerminated: (executionId, issueId) => {
			void phaseOrchestratorHolder.current
				?.reconcileQaLoss({ issueId, terminalExecId: executionId })
				.catch((err) =>
					console.warn(
						`[crash-reaper] FLY-1050 qa-loss reconcile failed for ${executionId}: ${(err as Error).message}`,
					),
				);
		},
	};

	// FLY-1234: late-bound stuck-confirm holder — declared BEFORE the
	// HeartbeatService construction, bound after the watchdog judge is wired
	// (further down this boot sequence). `heartbeatService.start()` is
	// deliberately deferred until AFTER the binding (R2 #4): several awaits sit
	// between construction and the judge wiring, so starting earlier would open
	// a window where a tick observes `current === null` and fail-open-emits
	// with a spurious confirm_unbound annotation.
	const stuckConfirmHolder: {
		current: ((session: Session) => Promise<StuckConfirmResult>) | null;
	} = { current: null };

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
		},
		48, // reviewTimeoutHours (constructor default; FLY-159/191 48h)
		quietSignalsProbe,
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
		// Kill-switch FLYWHEEL_STALE_TERMINAL_CLOSE=0 → notify-only (in
		// HeartbeatService.staleCloseEnabled).
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
		// holder-backed (the coordinator is built later, alongside the alert
		// sink). FLYWHEEL_FLEET_SENSOR_TMUX=0 kills the phase entirely.
		process.env.FLYWHEEL_FLEET_SENSOR_TMUX !== "0"
			? {
					check: async () =>
						(await serverLossHolder.current?.check()) ?? new Set<string>(),
				}
			: undefined,
		// FLY-1204: parked-phase reclaim chokepoint — the safety net that reclaims
		// leaked three-stage keep-alive phase sessions (design_done holders never
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
			// R3#1: TERM/KILL of orphan MCP processes is a NEW deletion — it
			// hangs off the same master switch as every other new mutator.
			if (!worktreeAutocleanEnabled()) return;
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
		// FLY-1234: heartbeat session_stuck confirm layer (late-bound above).
		stuckConfirmHolder,
	);

	// FLY-623 (Codex R2 MED-5): publish the live reconnecting set to the event
	// router + idle watchdog via the late-bound holder, now that HeartbeatService
	// exists. Stays null on the kill-switch / no-registry path (byte-compat).
	reconnectHolder.current = heartbeatService;

	// FLY-172: boot drain — reconcile complete-failed markers left by Runners
	// that finished during a restart window (their `flywheel-comm complete` POST
	// hit a down Bridge). Event-driven (boot), no new timer. Best-effort: a
	// failure here must not block Bridge startup.
	try {
		await reconcileCompleteFailedMarkers({
			store,
			bridgeBaseUrl: loopbackBaseUrl,
			ingestToken: config.ingestToken,
			transitionOpts,
			getTmuxTarget: getTmuxTargetFromCommDb,
			isTmuxWindowAlive,
		});
	} catch (err) {
		console.error(
			`[Bridge] FLY-172 boot marker drain failed (non-fatal): ${(err as Error).message}`,
		);
	}

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
	// stuck: close_runner rejects them, tmux + worktree linger, the idle watchdog
	// false-positives session_stuck. The event-route handler fixes this going
	// forward; this one-shot sweep unsticks the EXISTING backlog whose
	// stage_changed already fired before the fix shipped. Runs AFTER the FLY-172
	// marker drain so any session with a pending complete marker is routed by its
	// real `complete --route` first, leaving only true stage-set-completed
	// zombies (no decision_route, no pr_number). Status-only; no tmux/worktree
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
		});
		if (sweep.scanned > 0) {
			console.log(
				`[Bridge] FLY-324 boot sweep: scanned=${sweep.scanned} reconciled=${sweep.reconciled} rejected=${sweep.rejected} skipped=${sweep.skipped} excluded=${sweep.excluded} done-but-running → completed`,
			);
		}
	} catch (err) {
		console.error(
			`[Bridge] FLY-324 boot sweep failed (non-fatal): ${(err as Error).message}`,
		);
	}

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
				// off FLYWHEEL_WORKTREE_AUTOCLEAN, the original FLY-1165 behavior
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
				newMutatorsEnabled: worktreeAutocleanEnabled(),
			});
		},
	});

	// FLY-754: boot sweep — kill leaked `viewer-<execId>` tmux sessions (the
	// FLY-116 Terminal.app viewer's linked sessions that were never destroyed).
	// The generation source is fixed in openTmuxViewer (cmux no longer opens
	// viewers); this migrates the existing backlog + backstops the terminal-app
	// path. MUST run after the FLY-172 marker drain and FLY-324 sweep above so
	// it sees post-reconciliation statuses (Codex design review R1). One-shot,
	// fire-and-forget, best-effort. `FLYWHEEL_VIEWER_SESSION_REAPER=0` disables
	// (same escape-hatch shape as FLYWHEEL_CRASH_REAPER).
	if (process.env.FLYWHEEL_VIEWER_SESSION_REAPER !== "0") {
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
	}

	// FLY-766: Chrome-session reaper — kill leaked `agent-browser` Chrome-for-Testing
	// instances (the real root of the fleet memory spikes: any session using
	// claude-in-chrome / ProofShot leaves an ephemeral headless Chrome resident).
	// Attributed cleanup (use-done-must-close + owner-marker-proven no-row orphan)
	// is always on; unattributed cleanup is default log-only (opt-in one-time
	// FLYWHEEL_CHROME_REAPER_MIGRATE_UNATTRIBUTED=1). Skips entirely for a
	// `:memory:` store (unit-test Bridges) so tests never enumerate real processes
	// or start a timer. Boot + periodic share one single-flight guard.
	// `FLYWHEEL_CHROME_REAPER=0` disables both.
	let chromeReaperTimer: ReturnType<typeof setInterval> | undefined;
	if (
		process.env.FLYWHEEL_CHROME_REAPER !== "0" &&
		store.getDbPath() !== ":memory:"
	) {
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
		const runChromeReap = async (mode: "boot" | "periodic"): Promise<void> => {
			if (chromeReaperRunning) return; // single-flight (shared boot + periodic)
			chromeReaperRunning = true;
			try {
				const { reapChromeSessions } = await import(
					"./chrome-session-reaper.js"
				);
				const r = await reapChromeSessions({
					store,
					ownStateDbPath: store.getDbPath(),
					mode,
					migrateUnattributed: chromeMigrateUnattributed,
					unattributedIdleGraceMinutes: chromeGraceMin,
					nowMs: Date.now(),
				});
				if (
					r.scanned > 0 ||
					r.killedAttributedTerminal > 0 ||
					r.killedAttributedOrphan > 0 ||
					r.killedUnattributedIdle > 0 ||
					r.wouldKillUnattributed > 0 ||
					r.errors.length > 0
				) {
					console.log(
						`[chrome-reaper:${mode}] scanned=${r.scanned} killTerminal=${r.killedAttributedTerminal} killOrphan=${r.killedAttributedOrphan} killUnattr=${r.killedUnattributedIdle} wouldKillUnattr=${r.wouldKillUnattributed} skippedActive=${r.skippedActive} skippedForeign=${r.skippedForeign} raced=${r.racedSkipped} errors=${r.errors.length}`,
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
	// disjoint (running vs completed/timeout). `FLYWHEEL_COMMDB_FSM_RECONCILE=0`
	// disables the reconcile (kill-switch, mirrors FLYWHEEL_CRASH_REAPER).
	{
		const prunedProjects = new Set<string>();
		const reconcileOn = process.env.FLYWHEEL_COMMDB_FSM_RECONCILE !== "0";
		const recordFinalizeOutcome = (
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
			});
		};
		void (async () => {
			for (const p of projects ?? []) {
				if (prunedProjects.has(p.projectName)) continue;
				prunedProjects.add(p.projectName);
				if (reconcileOn) {
					try {
						const r = await reconcileCommDbRunningAgainstFsm(
							p.projectName,
							(id) => store.getSession(id)?.status,
							{ onFinalizeOutcome: recordFinalizeOutcome },
						);
						if (r.reconciled > 0) {
							console.log(
								`[Bridge] FLY-817 CommDB↔FSM reconcile (${p.projectName}): scanned=${r.scanned} reconciled=${r.reconciled} keptNonTerminal=${r.keptNonTerminal} keptPreserve=${r.keptPreserve} keptAliveTarget=${r.keptAliveTarget}`,
							);
						}
					} catch (err) {
						console.error(
							`[Bridge] FLY-817 CommDB↔FSM reconcile (${p.projectName}) failed (non-fatal): ${(err as Error).message}`,
						);
					}
				}
				try {
					const pruned = await pruneDeadTerminalCommDbSessions(p.projectName, {
						onFinalizeOutcome: recordFinalizeOutcome,
					});
					if (pruned.pruned > 0) {
						console.log(
							`[Bridge] FLY-638 CommDB prune (${p.projectName}): scanned=${pruned.scanned} pruned=${pruned.pruned} kept=${pruned.kept} stale terminal rows removed`,
						);
					}
				} catch (err) {
					console.error(
						`[Bridge] FLY-638 CommDB prune (${p.projectName}) failed (non-fatal): ${(err as Error).message}`,
					);
				}
			}
		})();
	}

	// FLY-369: archive-on-close. Archiving is driven by the Lead's close action
	// via POST /api/chat-threads/archive (wired through createQueryRouter above) —
	// NOT a standalone auto-poll on Linear "Done" (which the founder ruled out as
	// premature). The ship path still archives on ship. No boot sweep / heartbeat
	// piggyback here by design.

	// FLY-623 (Codex R2 HIGH-2 / R3 LOW-1): boot-seed reconnecting state for
	// pre-existing `running` sessions whose in-process poll loop died with the
	// previous Bridge process. Runs AFTER the FLY-172 marker drain AND the FLY-324
	// done-but-running sweep (so a stage=completed zombie is terminalized first and
	// never briefly enters reconnecting / gets a ⚠️重连中 title), and BEFORE
	// heartbeatService.start() / RunnerIdleWatchdog.start() — closing the on-boot
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

	// FLY-1234 (R2 #4): `heartbeatService.start()` used to live HERE — it moved
	// below the watchdog-judge wiring + stuckConfirmHolder binding. Multiple
	// awaits sit between this point and that wiring (transport dynamic import,
	// milestone-config load), so starting here would open a real window where a
	// tick observes an unbound confirm holder. seedReconnecting (above) keeps
	// its existing before-start ordering.

	// FLY-163: CleanupService removed (forum thread cleanup gone).

	// FLY-62: Gate question poller
	// FLY-208 A2: wire the black-hole inbox patrol transport. Mailbox mode
	// only — commdb/rollback mode leaves transport undefined and the patrol is
	// a complete no-op. There is no reusable transport instance in scope here
	// (createLeadRuntime builds its own per-runtime instance), so build one;
	// wiring failure is non-fatal (patrol off, question relay unaffected).
	let misroutePatrolTransport:
		| import("./gate-poller.js").MisroutePatrolTransport
		| undefined;
	let misrouteArchiveDir: string | undefined;
	// FLY-605: persistent founder-reply thread cursor path (state dir is only
	// reachable through the dynamically-imported getStateDir below). Unset →
	// GatePoller falls back to an in-memory cursor.
	let founderReplyCursorPath: string | undefined;
	if (resolveCommBackend() === "mailbox") {
		try {
			const { AgentTeamTransportFactory, getStateDir } = await import(
				"flywheel-agent-team-transport"
			);
			misroutePatrolTransport = AgentTeamTransportFactory.fromEnv();
			misrouteArchiveDir = join(getStateDir(), "misroute-archive");
			founderReplyCursorPath = join(getStateDir(), "founder-reply-cursor.json");
		} catch (err) {
			console.warn(
				`[Bridge] FLY-208 misroute patrol wiring failed (patrol off, non-fatal): ${(err as Error).message}`,
			);
		}
	}
	// FLY-182 Track B / FLY-513: Discord-independent meta-alert sink. Constructed
	// HERE (before GatePoller) so the FLY-513 global-codex drift probe can reuse
	// this ONE notifier instance (shared per-reason debounce) on the poll tick —
	// rather than a second notifier with split debounce/file state (Codex R2 LOW-1).
	const metaAlertNotifier = new MetaAlertNotifier();
	void metaAlertNotifier.probeDesktopCapability().then((ok) => {
		console.log(
			`[Bridge] MetaAlertNotifier desktop notifications ${ok ? "available" : "UNAVAILABLE (file channel only — Bridge not in an Aqua GUI session?)"}`,
		);
	});

	// FLY-513: the global-codex drift probe does real PATH/realpath I/O against the
	// host's actual `codex`. Disabled under VITEST (same boundary as
	// BridgeEventLoopWatchdog below) so general Bridge integration suites never fire
	// a meta-alert off the test machine's real (possibly contaminated) global codex.
	const codexHealthEnabled = !process.env.VITEST;
	// FLY-637-ext: late-bound page-Annie sink for the lead-pending escalation. The
	// GatePoller starts before the shared `alertSink` exists below; boot is
	// synchronous so the holder is populated before the first ~3s poll tick. The
	// page step is rare (only after the Lead ignores a runner's question for several
	// backoff rounds), so an unset holder during boot can never reach it.
	const leadPendingAlertHolder: {
		current?: { alert: (p: AlertPayload) => Promise<AlertResult> };
	} = {};
	// FLY-927 (Task 1.1): late-bound ROUTED alert sink — the single funnel every
	// emission source calls, so the D1 Router sees every infra event. Populated
	// right after the raw alertSink below; emitters constructed earlier read
	// `.current` at fire time and fall back to the raw notifier during the
	// synchronous boot window (identical behavior — routing only matters at
	// runtime, and FLYWHEEL_ALERT_ROUTING unset keeps it a pure passthrough).
	const routedAlertSinkHolder: {
		current?: { alert: (p: AlertPayload) => Promise<AlertResult> };
	} = {};
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
	// approval source (text / ✅ reaction / voice) so they cannot drift —
	// kill-switch FLYWHEEL_ATTRIBUTION_HOLD_ALIGN=0 (read per call) restores
	// the pre-FLY-1041 held-writes-anyway behavior for all three at once.
	const founderApprovalIsHeld = (executionId: string): boolean =>
		founderApprovalHoldGuard(store, store.getSession(executionId));

	// FLY-1099 §4.1: the reason-classified hold face (same predicate order as
	// isReviewHeld — shared implementation, cannot drift). The kill-switch
	// FLYWHEEL_ATTRIBUTION_HOLD_ALIGN=0 keeps its FLY-1041 semantics: holds are
	// ignored entirely (the deferral face then reports "not held" too).
	const founderHoldReasonFor = (executionId: string) =>
		process.env.FLYWHEEL_ATTRIBUTION_HOLD_ALIGN === "0"
			? null
			: reviewHoldReason(store, store.getSession(executionId));
	// FLY-1099: current canonical founder id (same derivation the factory uses).
	const founderCanonicalId = (): string | undefined =>
		deriveCanonicalFounderId(
			config.discordOwnerUserId,
			config.founderConsent?.founderUserId,
		) ?? undefined;
	const projectRootFor = (projectName: string): string | undefined =>
		projects.find((project) => project.projectName === projectName)
			?.projectRoot;
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
		denylistProjects: founderAutoApproveDenylist,
		// FLY-1041 Chunk 4: attribution forensics; Chunk 5: hold alignment.
		auditStore: store,
		isHeld: founderApprovalIsHeld,
		mergedGateGuard,
		projectRootFor,
		// FLY-1099 §4.2: held approvals are durably deferred (codex_pending /
		// qa_not_green) instead of silently declined; merge_block gets the
		// recovery pointer. Kill-switches read per call inside.
		deferralSupport: (ctx) =>
			makeDeferralSupport({
				store,
				holdReasonFor: founderHoldReasonFor,
				ctx,
			}),
		// The db flowing through the deliverer IS a real CommDB (GateResponseDb is
		// its structural subset), so widening it for the wake is sound at runtime.
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

	// FLY-725: per-project founder milestone-report config, read from each
	// project's CANONICAL root (never a runner's PR worktree).
	const founderMilestoneReportByProject =
		await loadFounderMilestoneReportConfigByProject(projects);
	// FLY-945 Fix D: external-merge convergence sweeper (backstop — Fix F
	// simultaneously retires executor-merge; this is NOT permission for it).
	// Kill-switch FLYWHEEL_EXTERNAL_MERGE_RECONCILE=0 lives inside pass().
	const externalMergeReconciler = createExternalMergeReconciler({
		store,
		config,
		projects,
		removeCleanWorktree: makeBridgeWorktreeCleanup(store, projects),
		// FLY-1204: external merge is a real ship path — reclaim the parked
		// three-stage phase sessions here too (shared finalizer, same as run-infra).
		finalizeThreeStagePhases,
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

	// FLY-1048 (A5): shared owner-Lead resolution for suspicious reports —
	// used by BOTH the LeadWatchdog multi-frame veto and the focused-frame
	// unclear path (one resolver, no drift).
	const resolveSuspiciousOwner = (
		r: SuspiciousReport,
	): SuspiciousOwner | null => {
		if (r.targetKind === "lead") {
			// State key is `<project>:<leadId>` (LeadWatchdog stateKey).
			const idx = r.targetKey.indexOf(":");
			if (idx <= 0 || idx === r.targetKey.length - 1) return null;
			return {
				projectName: r.targetKey.slice(0, idx),
				leadId: r.targetKey.slice(idx + 1),
			};
		}
		// Runner target: execId → session → label-derived owner Lead.
		const session = store.getSession(r.targetKey);
		if (!session?.project_name) return null;
		const project = projects.find(
			(p) => p.projectName === session.project_name,
		);
		if (!project) return null;
		for (const lead of project.leads) {
			try {
				if (matchesLead(session, lead.agentId, projects)) {
					return {
						leadId: lead.agentId,
						projectName: project.projectName,
						executionId: session.execution_id,
						issueId: session.issue_id,
					};
				}
			} catch {
				/* try the next lead */
			}
		}
		return null;
	};
	// FLY-1048 (A5, Codex code R1 #1): the quiet issue-thread leg. Late-bound
	// holder — alertDiscordOps is constructed further down the boot sequence;
	// until it is wired the leg silently skips (the guardrail lead_event leg is
	// the reliable channel; the thread note is best-effort by contract).
	const suspiciousThreadPoster: {
		current: ((threadId: string, content: string) => Promise<void>) | null;
	} = { current: null };
	const deliverSuspiciousDirect = (report: SuspiciousReport): void => {
		void deliverSuspiciousReport(
			{
				store,
				runtimeRegistry: registry,
				resolveOwner: resolveSuspiciousOwner,
				// Pre-call guard (plan A5 / Codex design R1 #3): only post when an
				// issue thread is actually bound AND the poster is wired — never
				// call the thread leg with an undefined thread. Reason only, no
				// mention, never the pane (formatSuspiciousThreadNote).
				emitThreadNote: async (r, owner) => {
					const poster = suspiciousThreadPoster.current;
					if (!poster || !owner.issueId) return;
					const lead = projects
						.find((p) => p.projectName === owner.projectName)
						?.leads.find((l) => l.agentId === owner.leadId);
					const threadId = resolveChatThreadId(
						store,
						owner.issueId,
						lead?.chatChannel,
					);
					if (!threadId) return;
					await poster(threadId, formatSuspiciousThreadNote(r));
				},
			},
			report,
		).catch((err) =>
			console.warn(
				`[detection-suspicious] delivery failed: ${(err as Error).message}`,
			),
		);
	};

	// FLY-1048 PR-B (B3): the LLM judge sits in FRONT of the fail-suspicious
	// deliverer. Env checked per call (live flip); OFF or <2 frames = PR-A
	// behavior byte-for-byte. Accepted a/b verdicts suppress the report with a
	// durable session_events audit; c_stuck/suspicious/null still deliver
	// (never silent). Judge runs codex (subscription — zero Claude quota).
	// FLY-1048 PR-C (C4): the unified-flow notify leg — every detection source
	// (gap records / focused-frame case-c / judge-confirmed c / FN4) funnels
	// through here. CLEARING targets are muted (C5), and notifyLeadFirst dedups
	// once-per-episode on the durable detection_escalations row. FLY-1243: the
	// FLYWHEEL_DETECTION_ESCALATION gate is retired (固化 default-on) — the unified
	// flow always runs.
	const resolveDetectionOwner = (
		input: DetectionEscalationInput,
	): EscalationOwner | null => {
		const session = store.getSession(input.targetKey);
		if (!session?.project_name) return null;
		const project = projects.find(
			(p) => p.projectName === session.project_name,
		);
		if (!project) return null;
		for (const lead of project.leads) {
			try {
				if (matchesLead(session, lead.agentId, projects)) {
					return {
						leadId: lead.agentId,
						projectName: project.projectName,
						executionId: session.execution_id,
						issueId: session.issue_id,
					};
				}
			} catch {
				/* try the next lead */
			}
		}
		return null;
	};
	const notifyDetectionEpisode = (
		input: DetectionEscalationInput,
	): Promise<void> =>
		notifyUnlessClearing(
			{
				store,
				notify: async (guarded) => {
					await notifyLeadFirst(
						{
							store,
							runtimeRegistry: registry,
							resolveOwner: resolveDetectionOwner,
							// Quiet issue-thread leg with the A5 pre-call guard (Codex
							// design R1 #3): no bound thread → skip this leg silently,
							// never call the poster with an unbound thread. The
							// guardrail lead_event leg is the reliable channel.
							emitThreadNote: async (r, owner) => {
								const poster = suspiciousThreadPoster.current;
								if (!poster) return;
								const lead = projects
									.find((pr) => pr.projectName === owner.projectName)
									?.leads.find((l) => l.agentId === owner.leadId);
								const threadId = resolveChatThreadId(
									store,
									r.issueId,
									lead?.chatChannel,
								);
								if (!threadId) return;
								await poster(threadId, formatEscalationLeadNote(r));
							},
						},
						guarded,
					);
				},
			},
			input,
		);

	const watchdogJudge = createWatchdogJudge({
		repoRoot: projects[0]?.projectRoot ?? process.cwd(),
	});
	// FLY-1234 (R1 #6 / R2 #2): shared judge-routing assembly — extracted to
	// watchdog-judge-assembly.ts so the production composition is testable
	// (Codex code R1 #3). deliver / onConfirmedStuck / onDecision /
	// judgeCacheKey / errorSignatureKinds are the per-caller seams; the
	// unified-escalation side effect (notifyDetectionEpisode) is ONLY ever the
	// suspicious pipeline's injected onConfirmedStuck — the heartbeat confirm
	// layer never notifies (single emission right, INV-4).
	const buildJudgeRoutingDeps = createJudgeRoutingDepsFactory({
		store,
		judge: watchdogJudge,
		judgeEnabled: () => process.env.FLYWHEEL_WATCHDOG_JUDGE === "1",
		resolveOwner: resolveSuspiciousOwner,
	});

	const deliverSuspicious = (report: SuspiciousReport): void => {
		void routeSuspiciousReport(
			buildJudgeRoutingDeps({
				deliver: deliverSuspiciousDirect,
				// FLY-1048 PR-C (C4): a judge-confirmed case-c enters the UNIFIED
				// escalation flow (Lead-first + ~30min founder page). Runner targets
				// only — lead-keyed targets have no session/issue to escalate into
				// (the A5 delivery still reaches the owner Lead either way).
				// Keyed by the OLD detector's live episode fingerprint when it is
				// tracking this target, so the C4a mutual exclusion matches; an
				// already-escalated old episode owns the flow and is not double-fed.
				// FLY-1234 (INV-4): this side effect belongs ONLY to the suspicious
				// pipeline — the heartbeat confirm layer's routing never notifies.
				onConfirmedStuck: (r, verdict) => {
					if (r.targetKind === "runner") {
						const oldEpisode = stuckDetectorHolder.current?.episodeFor(
							r.targetKey,
						);
						const session = store.getSession(r.targetKey);
						if (session && !oldEpisode?.escalated) {
							void notifyDetectionEpisode(
								buildCaseCEscalationInput(
									session,
									oldEpisode?.fingerprint ?? r.episodeFingerprint,
									{
										// Codex code R1 #7: the unified reason travels to the
										// (founder-visible) issue thread — free-text rationale is
										// derived from RAW pane frames and may quote them. Closed
										// enum only; the rationale stays on the Lead-face A5
										// delivery + the durable judge audit event.
										reason: `LLM judge 确认 case-c(attribution=${verdict.attribution})`,
										firstDetectedAtMs:
											oldEpisode?.firstStagnantAt ?? Date.now(),
									},
								),
							).catch((err) =>
								console.warn(
									`[detection-escalation] judge-confirmed notify failed: ${(err as Error).message}`,
								),
							);
						}
					}
				},
			}),
			report,
		).catch((err) =>
			console.warn(
				`[watchdog-judge] routing failed: ${(err as Error).message}`,
			),
		);
	};

	// FLY-1234 (T3): bind the heartbeat stuck-confirm layer, now that the judge
	// exists. One boot-time knob parse WITH the warn sink (a cross-field
	// contradiction logs once here); the per-call parses inside stay quiet.
	parseStuckConfirmKnobs(process.env, {
		warn: (m) => console.warn(`[stuck-confirm] ${m}`),
	});
	stuckConfirmHolder.current = createStuckConfirmRunner({
		buildRoutingDeps: buildJudgeRoutingDeps,
		// R1 #7 mapping: lookup gone → "gone" (target unresolvable — the
		// annotation never claims process death), lookup error →
		// "indeterminate"; found → the #576 four-state process probe.
		probeLiveness: async (s) => {
			if (!s.project_name) return "gone";
			const lookup = lookupTmuxTarget(s.execution_id, s.project_name);
			if (lookup.kind === "gone") return "gone";
			if (lookup.kind === "error") return "indeterminate";
			return probeRunnerProcessLiveness(lookup.target.tmuxWindow);
		},
		captureFrame: async (s) => {
			if (!s.project_name) return null;
			const res = await defaultCaptureSession(
				s.execution_id,
				s.project_name,
				200,
			);
			return "output" in res
				? { text: res.output, capturedAtMs: Date.now() }
				: null;
		},
		commCorroborationMs: () => stuckCommActivityMs(process.env),
		logger: (m) => console.log(`[stuck-confirm] ${m}`),
	});

	// FLY-1234 (R2 #4): start the heartbeat AFTER the confirm holder is bound —
	// no tick can ever observe the unbound-holder transient. Moved from right
	// after seedReconnecting() (see the marker comment there).
	heartbeatService.start();

	// FLY-1048 (A6): cheap gap/state scan — OBSERVE ONLY in PR-A (in-process
	// registry + debug log; the notification leg arrives with PR-C). Zero pane
	// capture, zero tokens: StateStore sessions + readonly per-project CommDB.
	// FLY-1243: the gap scan is固化 default-on (the FLYWHEEL_DETECTION_GAP_SCAN flip
	// applies without a restart; unset = the tick returns immediately.
	const gapSuspicionRegistry = createSuspicionRegistry();

	// FLY-1048 (A7): focused frames for gap-scan suspects. Every successful
	// capture ALSO feeds the existing stuck-runner detector (checkSession with
	// a precaptured outcome) — its hard gates + dispositions stay the single
	// escalation authority, it just accumulates episode time at the focused
	// cadence (~4min) instead of the 1h fleet sweep. Unclear windows go
	// fail-suspicious (A5); the ~1h sweep default is deliberately untouched.
	const focusedFrames = createFocusedFrameScheduler({
		capture: async (t) => {
			const res = await defaultCaptureSession(t.targetKey, t.projectName, 200);
			return "output" in res ? res.output : null;
		},
		onFrame: async (t, frameText) => {
			const session = store.getSession(t.targetKey);
			if (!session) return;
			await stuckDetectorHolder.current?.checkSession(session, {
				ok: true,
				output: frameText,
			});
		},
		onVerdict: (v) => {
			if (v.verdict === "unclear") {
				deliverSuspicious({
					targetKind: "runner",
					targetKey: v.target.targetKey,
					reason:
						"focused_frames_unclear: multi-frame window is neither flowing nor a clean silence/error loop — mechanical layer cannot conclude",
					paneTail: buildPaneTail(v.latestFrame),
					episodeFingerprint: hashPane(liveRegion(v.latestFrame)),
					frames: v.window,
				});
				return;
			}
			// FLY-1048 PR-C (C4): a mechanical c_candidate enters the unified flow
			// when the escalation env is ON (unset = observe-only log, PR-A
			// behavior). Keyed by the OLD detector's live episode fingerprint when
			// available (A7's onFrame feeds it the SAME frame just before this
			// verdict) so the C4a mutual exclusion matches; if the old flow
			// already escalated this episode it owns the notification.
			if (v.verdict === "c_candidate") {
				const oldEpisode = stuckDetectorHolder.current?.episodeFor(
					v.target.targetKey,
				);
				const session = store.getSession(v.target.targetKey);
				if (session && !oldEpisode?.escalated) {
					const reason = v.deltas.repeatedErrorSig
						? `多帧观察窗确认 case-c:同一错误签名(${v.deltas.repeatedErrorSig.kind})跨帧重现`
						: "多帧观察窗确认 case-c:pane 静默且无 token 流";
					void notifyDetectionEpisode(
						buildCaseCEscalationInput(
							session,
							oldEpisode?.fingerprint ??
								fallbackCaseCFingerprint(v.deltas, v.latestFrame),
							{
								reason,
								firstDetectedAtMs: oldEpisode?.firstStagnantAt ?? Date.now(),
							},
						),
					).catch((err) =>
						console.warn(
							`[detection-escalation] case-c notify failed: ${(err as Error).message}`,
						),
					);
				}
			}
			console.log(
				`[focused-frames] ${v.target.targetKey.slice(0, 8)} verdict=${v.verdict} (span=${Math.round(v.deltas.spanMs / 1000)}s)`,
			);
		},
		intervalMs: (() => {
			const n = Number.parseInt(
				process.env.FLYWHEEL_FRAME_INTERVAL_MS ?? "",
				10,
			);
			return Number.isFinite(n) && n > 0 ? n : undefined; // default 4min
		})(),
		capturesPerTick: (() => {
			const n = Number.parseInt(
				process.env.FLYWHEEL_FRAME_CAPTURES_PER_TICK ?? "",
				10,
			);
			return Number.isFinite(n) && n > 0 ? n : undefined; // default 2
		})(),
	});
	const gapScanTick = async (): Promise<void> => {
		// FLY-1243: FLYWHEEL_DETECTION_GAP_SCAN retired (固化 default-on) — the
		// zero-token gap/state scan always runs.
		const nowMs = Date.now();
		const thresholds = defaultGapThresholds(process.env);
		const records: SuspicionRecord[] = [];
		const byProject = new Map<string, Session[]>();
		for (const s of store.getActiveSessions()) {
			const list = byProject.get(s.project_name) ?? [];
			list.push(s);
			byProject.set(s.project_name, list);
		}
		// Codex R4 #1/#2 (supersedes the R3 project-level set): the keys whose
		// judgement COMPLETELY ran this sweep — the only keys whose absence from
		// activeConditionKeys is durable "condition cleared" evidence. Skipped
		// projects, degraded signals, and non-active keep-alive sessions
		// contribute nothing here, so their episodes are conservatively held.
		const evaluatedConditionKeys = new Set<string>();
		for (const [projectName, projectSessions] of byProject) {
			const reader = openGapReader(defaultGetCommDbPath(projectName));
			// Fail-closed: unreadable/missing comm.db → skip this project's
			// comm-derived judgements this round.
			if (!reader) continue;
			try {
				for (const session of projectSessions) {
					const comm = reader.evidenceFor(session.execution_id, null, nowMs);
					let founderNotified: boolean | null = null;
					try {
						founderNotified = store
							.getEventsByExecution(session.execution_id)
							.some(
								(e) =>
									e.event_type === "founder_thread_notified" ||
									e.event_id?.startsWith("founder-thread-notify-"),
							);
					} catch {
						founderNotified = null; // unreadable → gap1 degrades (fail-closed)
					}
					const rawActivity = session.last_activity_at;
					const parsedActivity = rawActivity ? Date.parse(rawActivity) : NaN;
					const lastActivityAtMs = Number.isFinite(parsedActivity)
						? parsedActivity
						: rawActivity
							? parseSqliteUtcMs(rawActivity)
							: null;
					const gapInput = {
						session: {
							executionId: session.execution_id,
							projectName,
							status: session.status,
							lastActivityAtMs,
						},
						comm,
						founderNotified,
						nowMs,
						thresholds,
					};
					records.push(...evaluateGapSuspicion(gapInput));
					for (const kind of evaluatedGapConditions(gapInput)) {
						evaluatedConditionKeys.add(
							`${GAP_ESCALATION_KINDS[kind]}|${session.execution_id}`,
						);
					}
				}
			} finally {
				reader.close();
			}
		}
		gapSuspicionRegistry.sweep(records, nowMs);
		if (records.length > 0) {
			console.log(
				`[gap-scan] ${records.length} suspicion(s): ${records
					.map((r) => `${r.kind}:${r.targetKey.slice(0, 8)}`)
					.join(", ")}`,
			);
		}
		// FLY-1048 PR-C (C4): the gap notify leg — 漏①/漏②/consumed-ack enter the
		// unified flow when the escalation env is ON (unset = observe-only, the
		// PR-A contract). The registry preserves firstSeenMs while a condition
		// persists, so the derived episode fingerprint is stable and
		// notifyLeadFirst dedups to once per episode. FLY-1243: unconditional now
		// (FLYWHEEL_DETECTION_ESCALATION retired, 固化 default-on).
		{
			const activeConditionKeys = new Set<string>();
			for (const record of gapSuspicionRegistry.snapshot()) {
				if (record.kind !== "pane_progress_suspect") {
					activeConditionKeys.add(
						`${GAP_ESCALATION_KINDS[record.kind]}|${record.targetKey}`,
					);
				}
				const session = store.getSession(record.targetKey);
				if (!session) continue;
				const input = buildGapEscalationInput(record, session);
				if (!input) continue; // pane_progress_suspect only feeds A7
				try {
					await notifyDetectionEpisode(input);
				} catch (err) {
					console.warn(
						`[detection-escalation] gap notify failed for ${record.kind}:${record.targetKey.slice(0, 8)}: ${(err as Error).message}`,
					);
				}
			}
			// A gap condition ABSENT from this sweep has provably cleared — close
			// its episode so the ~30min grace can never page the founder about an
			// already-resolved matter (and a genuine recurrence can revive).
			try {
				resolveClearedGapEpisodes(
					{ store },
					activeConditionKeys,
					evaluatedConditionKeys,
					nowMs,
				);
			} catch (err) {
				console.warn(
					`[detection-escalation] gap clear pass failed: ${(err as Error).message}`,
				);
			}
		}
		// FLY-1048 (A7): focused frames for the progress suspects surfaced above.
		await focusedFrames.tick(
			gapSuspicionRegistry
				.snapshot()
				.filter((r) => r.kind === "pane_progress_suspect")
				.map((r) => ({ targetKey: r.targetKey, projectName: r.projectName })),
		);
	};

	// FLY-1048 (PR-C, C3-w): unified detection-escalation reconcile — the
	// ~30min Lead-grace sweep + fleet guard (PRD §4.3). Env checked INSIDE the
	// FLY-1243: the reconcile is固化 default-on (no FLYWHEEL_DETECTION_ESCALATION flip; runs every
	// restart; unset = the tick returns immediately (byte-compat). All timing
	// and dedup state lives in the durable detection_escalations rows, so a
	// missed tick can only delay an escalation, never reset it.
	//
	// Done/gone outcomes for the recovery auto-RESOLVE. approved_to_ship is
	// excluded (the Runner is still alive to ship) and awaiting_review is
	// deliberately NOT terminal — a parked runner still needs its pane, so
	// M1-style episodes on it stay live.
	const detectionTerminalStatuses = new Set<string>(
		OUTCOME_STATUSES.filter((s) => s !== "approved_to_ship"),
	);
	const detectionGraceByProject = await loadDetectionGraceByProject(projects);
	const detectionPageFounder = createFounderPager({
		store,
		resolveTarget: createSessionTargetResolver({ store, projects }),
		discordOwnerUserId: config.discordOwnerUserId,
		discordBotToken: config.discordBotToken,
		// NEVER silent (plan C3): an unaddressable/undeliverable founder page
		// rides the FLY-915 ticket lane. The per-episode deterministic eventId
		// claims-dedups across reconcile retries (no per-tick ticket spam); the
		// row itself stays LEAD_NOTIFIED so the page keeps retrying.
		onUndeliverable: async (row, reason) => {
			const sink = leadPendingAlertHolder.current;
			if (!sink) return;
			const session = store.getSession(row.target_key);
			await sink.alert({
				leadId: row.owner_lead_id ?? "unassigned",
				projectName: session?.project_name ?? "unknown",
				eventId: `detection-page-undeliverable:${row.target_key}:${row.kind}:${row.episode_fingerprint}`,
				eventType: "detection_page_undeliverable",
				title: "Detection founder-page undeliverable",
				body:
					`无法把 detection 升级页投递进 issue thread(kind=${row.kind}, ` +
					`target=${row.target_key}, reason=${reason})。行保持 LEAD_NOTIFIED,` +
					`reconcile 会继续重试;请排查 thread 绑定 / bot token / 路由。`,
				severity: "warning",
			});
		},
	});
	const detectionFleetSink = createFleetSink({
		// Codex code R1 #3: issue_id is a Linear UUID — the project must come
		// from the target's session row or the aggregate routes to unknown-lead.
		resolveProject: (row) =>
			store.getSession(row.target_key)?.project_name ?? null,
		alertSink: {
			// Throwing (not swallowing) keeps the C3 contract: an unsurfaced
			// fleet aggregate leaves every row LEAD_NOTIFIED for the next pass.
			// `skipped: "duplicate"` counts as SUCCESS — the claims table says the
			// aggregate already surfaced, and treating it as failure would hold
			// the group LEAD_NOTIFIED forever.
			alert: async (p) => {
				const sink = leadPendingAlertHolder.current;
				if (!sink) throw new Error("alert sink not wired yet (holder empty)");
				const result = await sink.alert(p);
				if (result.skipped && result.skipped !== "duplicate") {
					throw new Error(`fleet aggregate skipped: ${result.skipped}`);
				}
				if (result.deadLettered) {
					throw new Error("fleet aggregate dead-lettered");
				}
				return result;
			},
		},
	});
	const detectionReconcileTick = async (): Promise<void> => {
		// FLY-1243: FLYWHEEL_DETECTION_ESCALATION retired (固化 default-on) — the
		// ~30min Lead-grace reconcile + fleet guard always runs.
		const graceEnv = Number.parseInt(
			process.env.FLYWHEEL_DETECTION_LEAD_GRACE_MS ?? "",
			10,
		);
		const thresholdEnv = Number.parseInt(
			process.env.FLYWHEEL_DETECTION_FLEET_THRESHOLD ?? "",
			10,
		);
		const clearingTtlEnv = Number.parseInt(
			process.env.FLYWHEEL_CLEARING_TTL_MS ?? "",
			10,
		);
		// One assembled pass (detection-reconcile-tick.ts, C4+C5): clearing-TTL
		// rebound → recovery auto-RESOLVE → FN4 fire+clear → the ~30min grace
		// escalation (founder page / fleet lane).
		await runDetectionReconcileTick({
			store,
			pageFounder: detectionPageFounder,
			fleetSink: detectionFleetSink,
			notify: notifyDetectionEpisode,
			recoveryProbe: (targetKey) => {
				const session = store.getSession(targetKey);
				if (!session) return null; // lead-keyed / unknown — never auto-resolve
				const rawActivity = session.last_activity_at;
				const parsed = rawActivity ? Date.parse(rawActivity) : NaN;
				return {
					terminal: detectionTerminalStatuses.has(session.status),
					lastActivityAtMs: Number.isFinite(parsed)
						? parsed
						: rawActivity
							? parseSqliteUtcMs(rawActivity)
							: null,
				};
			},
			// Progress refutes "stuck" only — an unanswered ask / unconsumed
			// delivery / unreported park stays live on a working runner (漏②'s
			// typical shape). Terminal still resolves every kind.
			progressResolvableKinds: new Set([CASE_C_ESCALATION_KIND]),
			graceMs: Number.isFinite(graceEnv) && graceEnv > 0 ? graceEnv : undefined,
			// Per-project override (detection.lead_grace_ms in the project's
			// CANONICAL .flywheel/config.yaml — loaded once at boot).
			graceMsFor: (row) => {
				const session = store.getSession(row.target_key);
				return session
					? detectionGraceByProject.get(session.project_name)
					: undefined;
			},
			fleetThreshold:
				Number.isFinite(thresholdEnv) && thresholdEnv > 0
					? thresholdEnv
					: undefined,
			clearingTtlMs:
				Number.isFinite(clearingTtlEnv) && clearingTtlEnv > 0
					? clearingTtlEnv
					: undefined,
			// FN4 undelivered-age rides the same knob family as consumed-ack
			// (FLYWHEEL_GAP_UNCONSUMED_MS, default 30min) — one semantic, one knob.
			fn4OverdueMs: defaultGapThresholds(process.env).unconsumedMs,
		});
	};

	const gatePoller = new GatePoller({
		pollIntervalMs: 3_000,
		projects,
		store,
		runtimeRegistry: registry,
		// FLY-1048 (A6): gap-scan piggyback (zero new timer; env-gated inside).
		onGapScanTick: gapScanTick,
		gapScanEveryNTicks: (() => {
			const n = Number.parseInt(
				process.env.FLYWHEEL_GAP_SCAN_EVERY_N_TICKS ?? "",
				10,
			);
			return Number.isFinite(n) && n > 0 ? n : undefined; // default 100
		})(),
		// FLY-1048 (PR-C): detection-escalation reconcile piggyback (zero new
		// timer; env-gated inside the tick — unset flag = complete no-op).
		onDetectionReconcileTick: detectionReconcileTick,
		detectionReconcileEveryNTicks: (() => {
			const n = Number.parseInt(
				process.env.FLYWHEEL_DETECTION_RECONCILE_EVERY_N_TICKS ?? "",
				10,
			);
			return Number.isFinite(n) && n >= 0 ? n : undefined; // default 20
		})(),
		// FLY-945 Fix D: run the sweeper on the patrol cadence (zero new timer).
		externalMergeReconcile: () => externalMergeReconciler.pass(),
		leadAlertSink: {
			alert: (p) =>
				leadPendingAlertHolder.current
					? leadPendingAlertHolder.current.alert(p)
					: Promise.resolve({ skipped: "unknown-lead" } as AlertResult),
		},
		chatThreadsEnabled: config.chatThreadsEnabled,
		transport: misroutePatrolTransport,
		misrouteArchiveDir,
		// FLY-907 (Step 4.5): issue-display reconcile sweep — piggybacked on this
		// existing poll tick (zero new timer). The holder is populated post-listen;
		// an empty holder / flag=0 makes the tick a no-op.
		// FLYWHEEL_ISSUE_DISPLAY_SWEEP_TICKS: cadence override (0 = disabled).
		onDisplayReconcileTick: () =>
			issueDisplayRefreshHolder.current?.runSweep?.(),
		displayReconcileEveryNTicks: (() => {
			const raw = process.env.FLYWHEEL_ISSUE_DISPLAY_SWEEP_TICKS;
			if (raw === undefined) return undefined; // GatePoller default (60)
			const n = Number.parseInt(raw, 10);
			return Number.isFinite(n) && n >= 0 ? n : undefined;
		})(),
		// FLY-605: bidirectional in-thread founder relay fallback. owner/token
		// from config; the founder-reply cursor persists across restarts.
		discordBotToken: config.discordBotToken,
		discordOwnerUserId: config.discordOwnerUserId,
		// FLY-799: founder-in-thread ship approval (default-ON kill-switch inside
		// the factory). Absent (fcWiring null) → deliverer stays WAKE-only.
		tryFounderShipApproval: founderShipApprovalCallback,
		// FLY-1099 §4.3: the deferred-approval rebind pass — the SAME production
		// post-write hook + canonical founder id the live text path uses (no
		// second authorization chain).
		deferredRebind: {
			canonicalFounderId: founderCanonicalId,
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
		// FLY-1041 Chunk 7: the SAME durable binding reader the reaction path
		// uses — reply-to-card narrows a founder REPLY to its bound ship gate.
		readCurrentBinding: (executionId, questionId, prHeadSha) =>
			readCurrentGateMessageBinding(store, executionId, questionId, prHeadSha),
		cursorStore: founderReplyCursorPath
			? new FileInboundCursorStore(founderReplyCursorPath)
			: undefined,
		// FLY-725: founder milestone-report patrol (Bridge-primary @founder push).
		founderMilestoneReportByProject,
		founderMilestoneBaselineCutoffMs,
		// FLY-513: periodic global-codex drift detection (path-only, zero new timer).
		// Default-on; `FLYWHEEL_CODEX_HEALTH_GUARD=0` short-circuits inside the probe.
		onHealthTick: codexHealthEnabled
			? () => {
					void reportCodexGlobalHealth(metaAlertNotifier);
				}
			: undefined,
	});
	gatePoller.start();

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

	// FLY-307 C: Bridge event-loop self-watchdog — converts a main-loop hang
	// (e.g. a spinning sql.js/WASM trap) into a launchd-restartable crash, the
	// gap launchd KeepAlive can't cover. Default ON; `FLYWHEEL_BRIDGE_WATCHDOG=0`
	// is the ops kill-switch. Auto-disabled under VITEST at this wiring boundary
	// so general Bridge integration suites are never SIGKILLed by the worker
	// (the dedicated watchdog tests exercise the real worker directly).
	const bridgeWatchdog = new BridgeEventLoopWatchdog({
		enabled: !process.env.VITEST,
	});
	bridgeWatchdog.start();
	if (bridgeWatchdog.isEnabled()) {
		console.log(
			"[Bridge] EventLoopWatchdog started (worker-thread heartbeat; SIGKILL self on a confirmed main-loop stall → KeepAlive restart)",
		);
	}

	// FLY-83: Lead liveness watchdog — external pane-hash observation for
	// Claude Code TUI. Pairs with scripts/lead-alert.sh (shell-owned alert
	// path) via cross-process claims.db dedup.
	//
	// Fix 2: claimsClaimer runs the SAME atomic INSERT-OR-IGNORE that
	// scripts/lead-alert.sh runs, so Bridge and shell genuinely race for
	// the same row instead of writing to two unrelated dedup stores.
	const claimsReader = createClaimsReader();
	const claimsClaimer = createClaimsClaimer();
	const blockedMarkerReader = createBlockedMarkerReader();
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
		claimsReader,
		claimsClaimer,
		metaAlert: metaAlertNotifier,
		unifiedAlert,
		...(alertRatePerMin
			? { rateLimiter: createAlertRateLimiter(alertRatePerMin) }
			: {}),
		// FLY-529: QA Testing Room alert isolation. Unset env → both fields
		// undefined → notifier keeps its shared production defaults (byte-compat).
		// The test Bridge sets FLYWHEEL_ALERT_QUEUE_DIR / _DEADLETTER_DIR to slot-
		// local paths so test alerts never land in the production queue/dead-letter
		// dirs the live Bridge drainer reads.
		...resolveAlertDirsFromEnv(process.env),
	});

	// FLY-907: build the unified issue-display refresher. The holder is read
	// late-bound by EVERY trigger surface (applyTransition hook,
	// DirectEventSink, event router, actions router, park/wake effects, sweep,
	// founder-consent gate hook), so filling it here (post-listen) is correct;
	// the GatePoller sweep reconciles anything that changed before this point.
	// FLYWHEEL_ISSUE_DISPLAY_REFRESH=0 / chat-threads off → holder stays empty →
	// every new trigger dormant + stage_changed keeps the legacy stamp+pin path.
	if (issueDisplayRefreshEnabled && chatThreadCreator) {
		const issueDisplayRefresher = new IssueDisplayRefresher({
			store,
			projects,
			config,
			chatThreadCreator,
			flags: {
				issueStatusEmojiEnabled:
					process.env.FLYWHEEL_ISSUE_STATUS_EMOJI !== "0",
				issueAttachPinEnabled: process.env.FLYWHEEL_ISSUE_ATTACH_PIN !== "0",
			},
			keepAliveEnabled: () => threeStageKeepAliveEnabled(),
			// FLY-623 interaction: while HeartbeatService owns the ⚠️重连中 title,
			// face A defers instead of overwriting it with a derived badge.
			isReconnectTitleActive: (execId) =>
				reconnectHolder.current?.isReconnectTitleActive(execId) ?? false,
		});
		issueDisplayRefreshHolder.current = issueDisplayRefresher;
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

	// FLY-1188 §7.1: build the codex-author review-request coordinator and
	// redrive any jobs a dead Bridge left pending/running. The /review-requests
	// route reads the holder at request time (503 until filled). Lead-facing
	// failure alerts currently log via console + the durable failed job row;
	// routing them through the FLY-927 alert funnel needs its own alert kind
	// (follow-up — MetaAlertReason is a closed infra union).
	{
		const commRoot =
			process.env.FLYWHEEL_COMM_ROOT?.trim() ||
			join(homedir(), ".flywheel", "comm");
		reviewCoordinatorHolder.current = new ReviewRequestCoordinator({
			store,
			commDbPathFor: (projectName) => join(commRoot, projectName, "comm.db"),
			openCommDb: (path) => new CommDB(path, false),
			reviewerTimeoutMs: parseReviewerTimeoutMs(
				process.env.FLYWHEEL_CLAUDE_REVIEW_TIMEOUT_MS,
			),
			wakeRunner: async (executionId, sessionInfo, questionId, summary) => {
				const db = new CommDB(
					join(commRoot, sessionInfo.project_name, "comm.db"),
					false,
				);
				try {
					const vendor = db.getSession(executionId)?.vendor;
					if (vendor === "none") return; // no-transport backend (FLY-493)
					await wakeRunnerMailbox({
						db,
						execId: executionId,
						fromAgent: "bridge",
						content:
							`Your ${summary === "SKIPPED" ? "review request was sanctioned as SKIPPED" : `review request has been answered: ${summary}`} ` +
							`(question ${questionId}). Read the durable answer with: ` +
							`node <flywheel-comm> check ${questionId} --project ${sessionInfo.project_name}. ` +
							`This wake carries NO authority.`,
						...(vendor ? { backend: vendor } : {}),
					});
				} finally {
					db.close();
				}
			},
		});
		const redriven = reviewCoordinatorHolder.current.redriveOnBoot();
		if (redriven > 0) {
			console.log(
				`[review-coordinator] boot redrive: ${redriven} review job(s) re-enqueued`,
			);
		}
	}

	// FLY-579: build the auto-QA coordinator now that the LeadAlertNotifier exists
	// (the effects need it for Lead-only pipeline-error alerts). Per-project qa
	// config is loaded from the CANONICAL project roots (never a PR worktree). The
	// holder is read lazily by the event router, so filling it here (post-listen)
	// is correct; the durable `auto_qa_record` table — NOT the reconcile timing —
	// guarantees GatePoller/Heartbeat suppression survives a restart, so the
	// startup reconcile (re-spawn / re-notify / mark-stuck) safely runs after the
	// timers. No startDispatcher (can't spawn QA) ⇒ coordinator stays dormant.
	if (startDispatcher) {
		try {
			const qaConfigByProject = await loadQaConfigByProject(projects);
			// FLY-752: auto-QA is opt-OUT now — count projects NOT opted out
			// (absent config / no explicit `auto: false` / not malformed).
			const optedOutCount = projects.filter((p) => {
				const cfg = qaConfigByProject.get(p.projectName);
				return (
					cfg?.kind === "malformed" ||
					(cfg?.kind === "config" && cfg.auto === false)
				);
			}).length;
			const enabledCount = projects.length - optedOutCount;
			const autoQaEffects = new AutoQaEffects({
				store,
				projects,
				config,
				// FLY-927 (W1): route auto-QA alerts through the routed sink (both its
				// kinds are ticket-class, so behavior is unchanged — this closes the
				// bypass so EVERY emission source shares the one funnel).
				leadAlertNotifier: {
					alert: (p) =>
						(routedAlertSinkHolder.current ?? leadAlertNotifier).alert(p),
				},
				// FLY-630 ②: drive the PARENT issue thread's stage badge across the QA
				// phase (🧪QA while running → ⏳待批 on pass → 🔨实现中 on fail). Only
				// set when the chat-thread feature is on; otherwise stampIssueStage
				// no-ops.
				chatThreadCreator,
				// FLY-752: closeQaRunner needs the FSM transition opts (to finalize a
				// still-running QA before close) + the global bot token (archive
				// cascade). Same values the archive cascade uses in this boot scope.
				transitionOpts,
				globalBotToken: config.discordBotToken,
				mergedGateGuard,
			});
			autoQaCoordinatorHolder.current = new AutoQaCoordinator({
				store,
				startDispatcher,
				resolveQaPolicy: (session) =>
					resolveAutoQaPolicy({
						qaConfig: qaConfigByProject.get(session.project_name),
						issueLabels: parseJsonStringArray(session.issue_labels),
					}),
				effects: autoQaEffects,
				// FLY-827: the codex hard-gate kill-switch is read live from
				// process.env (the direct feature-flag toggle mutates it in place).
				env: process.env,
				// FLY-945 Fix B: environment probes for the ship-gate head rebind
				// (gate-unanswered check via CommDB + real-git ancestry proof).
				shipGateRebind: {
					hasGateResponse: defaultHasGateResponse,
					isAncestor: defaultIsAncestor,
				},
				logger: {
					log: (m) => console.log(m),
					warn: (m) => console.warn(m),
				},
			});
			void autoQaCoordinatorHolder.current
				.reconcileOnStartup()
				.catch((err) =>
					console.warn(
						`[auto-qa] reconcileOnStartup failed: ${(err as Error).message}`,
					),
				);
			// FLY-827 (R1 HIGH-4): re-fire codex-hold side effects (re-queue
			// instruction) for awaiting_review sessions still lacking a Codex approval
			// after this restart / default-ON flip. The founder HOLD is already
			// guaranteed by the durable table + isReviewHeld, so running this after the
			// timers start is safe (side-effects only).
			void autoQaCoordinatorHolder.current
				.reconcileCodexHolds()
				.catch((err) =>
					console.warn(
						`[auto-qa] reconcileCodexHolds failed: ${(err as Error).message}`,
					),
				);
			// FLY-863: catch up on any head that crossed the stuck-duration
			// threshold WHILE the Bridge was down — don't wait for the first 30s
			// poll tick to notice a genuinely stuck hold on restart.
			void autoQaCoordinatorHolder.current
				.reconcileStuckCodexHolds()
				.catch((err) =>
					console.warn(
						`[auto-qa] reconcileStuckCodexHolds failed: ${(err as Error).message}`,
					),
				);
			// FLY-1099 §6: the 30min ledger-backed nudge layer (queue+wake
			// intents; execution + bounded retry live in the founder-action drain).
			void autoQaCoordinatorHolder.current
				.reconcileCodexHoldNudges()
				.catch((err) =>
					console.warn(
						`[auto-qa] reconcileCodexHoldNudges failed: ${(err as Error).message}`,
					),
				);
			console.log(
				`[auto-qa] coordinator wired (opt-out default: ${enabledCount}/${projects.length} projects auto-QA ON)`,
			);
		} catch (err) {
			console.warn(
				`[auto-qa] coordinator wiring failed: ${(err as Error).message} — auto-QA disabled this boot`,
			);
		}
	}

	// FLY-793: build the three-stage PhaseOrchestrator now that startDispatcher +
	// LeadAlertNotifier exist. Per-project `pipeline` config is loaded from the
	// CANONICAL roots (never a PR worktree), so a runner cannot flip its own
	// three-stage enablement. The holder is read lazily by both sinks, so filling
	// it here (post-listen) is correct. Its OWN try/catch — a three-stage config
	// problem must never disable auto-QA and vice versa. No startDispatcher ⇒
	// never built (three-stage dormant; can't dispatch phase-sessions anyway).
	if (startDispatcher) {
		const phaseStartDispatcher = startDispatcher;
		try {
			const pipelineConfigByProject =
				await loadPipelineConfigByProject(projects);
			const enabledProjects = projects.filter(
				(p) => pipelineConfigByProject.get(p.projectName)?.three_stage === true,
			).length;
			// FLY-793 (Codex full-PR R1 #1): dirty-safe worktree cleanup the handoff
			// OWNS — so the branch-B worktree is torn down in the AWAITED
			// closePhaseRunner (fail-closed on dirty), not left to the next phase's
			// async, non-dirty-checked Blueprint.removeIfExists.
			const phaseWorktreeCleanup = makeBridgeWorktreeCleanup(store, projects);
			// FLY-859: issue-thread notes for the QA fix-loop reuse the auto-QA
			// effects' postThread machinery (stateless; a second instance is safe).
			const phaseQaEffects = new AutoQaEffects({
				store,
				projects,
				config,
				leadAlertNotifier,
				chatThreadCreator,
				transitionOpts,
				globalBotToken: config.discordBotToken,
				mergedGateGuard,
			});
			// FLY-859: fix-round cap knob. Invalid/absent → orchestrator default (3).
			const maxFixRoundsEnv = process.env.FLYWHEEL_THREE_STAGE_MAX_FIX_ROUNDS;
			const maxFixRounds =
				maxFixRoundsEnv !== undefined
					? Number.parseInt(maxFixRoundsEnv, 10)
					: undefined;
			// FLY-887 (founder-visibility status line): shared by the orchestrator's
			// per-transition refresh AND ship-time finalization's final refresh (via
			// phaseStatusLineRefreshHolder, declared near the other forward-reference
			// holders — finalizeThreeStagePhases is wired before phaseQaEffects exists).
			const refreshPhaseStatusLineEffect = async (
				issueId: string,
			): Promise<void> => {
				try {
					// FLY-907: when the unified refresher is wired, every orchestrator
					// refresh drives ALL THREE display faces (title + header + line)
					// from real state — a qa_result / finalize is no longer a
					// face-C-only update.
					const unified = issueDisplayRefreshHolder.current;
					if (unified) {
						await unified.refresh(issueId);
						return;
					}
					// Escape-hatch path (FLYWHEEL_ISSUE_DISPLAY_REFRESH=0): face C
					// only, derived through the unified state machine with an
					// "unknown" park probe (status-table-only — the pre-907 shape,
					// rendered in the new FLY-907 vocabulary).
					const sessions = store.getPhaseSessionsForIssue(issueId);
					if (sessions.length === 0) return;
					const anySession = store.getSession(sessions[0]!.execution_id);
					if (!anySession) return;
					const statusByRole = new Map<string, string>();
					for (const s of sessions) {
						const role = s.chat_thread_role;
						if (role && !statusByRole.has(role)) {
							statusByRole.set(role, s.status);
						}
					}
					const states = {} as Record<ThreeStagePhase, PhaseDisplayState>;
					for (const role of THREE_STAGE_PHASE_SEQUENCE) {
						states[role] = derivePhaseDisplayState({
							role,
							status: statusByRole.get(role),
							park: "unknown",
						});
					}
					const text = renderPhaseStatusLine(states);
					await phaseQaEffects.refreshPhaseStatusLine({
						session: anySession,
						text,
					});
				} catch (err) {
					console.warn(
						`[phase-status-line] refresh failed for ${issueId}: ${(err as Error).message}`,
					);
				}
			};
			phaseStatusLineRefreshHolder.current = refreshPhaseStatusLineEffect;
			phaseOrchestratorHolder.current = new PhaseOrchestrator({
				startDispatcher: phaseStartDispatcher,
				// FLY-1232: lifecycle shadow hooks (T3/T3b/T4/T5/T6) — undefined
				// when FLYWHEEL_WORKFLOW_CLAIMS_WRITE is off (byte-compatible).
				workflowShadow: workflowShadowWriter,
				// FLY-859: the three-stage QA verdict machinery — thin store closures;
				// the durable intent lives in session_params.three_stage_verdict via
				// merge-style patchSessionParams (unrelated params survive).
				qaVerdicts: {
					getSession: (executionId) => store.getSession(executionId),
					readIntent: (executionId) =>
						store.getSessionParams(executionId)?.three_stage_verdict as
							| ThreeStageVerdictIntent
							| undefined,
					patchIntent: (executionId, patch) => {
						patchSessionParams(store, executionId, (cur) => ({
							...cur,
							three_stage_verdict: {
								...((cur.three_stage_verdict as
									| Record<string, unknown>
									| undefined) ?? {}),
								...patch,
							},
						}));
					},
					countImplementPhases: (issueId) =>
						store.countSessionsByIssueAndChatThreadRole(issueId, "implement"),
					// FLY-887: durable, crash-safe fix-round ledger (insert-or-read on the
					// QA verdict's event id). A fix round no longer spawns a new session,
					// so the count model can't grow — this idempotent event does.
					recordFixRound: (session, verdictEventId) => {
						const eventId = `three-stage-fix-round-${verdictEventId}`;
						const prior = store.getEventPayloadById(eventId);
						if (prior && typeof prior.round === "number") {
							return prior.round;
						}
						const round =
							store.countEventsByIssueAndType(
								session.issue_id,
								"three_stage_fix_round",
							) + 1;
						const inserted = store.insertEvent({
							event_id: eventId,
							execution_id: session.execution_id,
							issue_id: session.issue_id,
							project_name: session.project_name ?? "",
							event_type: "three_stage_fix_round",
							source: "bridge.phase-orchestrator",
							payload: { round, verdictEventId },
						});
						if (!inserted) {
							// Lost the UNIQUE(event_id) race → read back the winner's round.
							const won = store.getEventPayloadById(eventId);
							if (won && typeof won.round === "number") return won.round;
						}
						return round;
					},
					getActiveImplementSession: (issueId) => {
						const s = store.getActivePhaseSessionForIssue(issueId);
						return s && s.session_role === "implement" ? s : undefined;
					},
					listVerdictEventCandidates: () =>
						store.getThreeStageQaSessionsWithVerdictEvents(),
					getLatestQaResultEvent: (executionId) =>
						store.getLatestQaResultEventForExecution(executionId),
					listStrandedPassCandidates: () =>
						store.getStrandedThreeStageQaPassSessions(),
					postIssueThread: async (session, text) => {
						await phaseQaEffects.postThread({
							session: session as Session,
							text,
						});
					},
					// FLY-939 (G-B): does the QA session's bound review question already
					// have a response in the project CommDB? A "changes requested" answer
					// on the approve_to_ship gate IS that response — the signal that a QA
					// FAIL now is a founder-feedback kickback, not a stray FAIL. Fail-
					// closed: unbound sentinel / missing binding / any lookup error →
					// false (refuse the kickback rather than yank a genuinely-pending gate).
					hasGateResponse: (session) => {
						const qid = session.review_question_id;
						if (!qid || qid === REVIEW_BINDING_UNBOUND) return false;
						const dbPath = commDbPathForProject(session.project_name ?? "");
						if (!ffExistsSync(dbPath)) return false;
						const db = new CommDB(dbPath);
						try {
							return db.getResponse(qid) !== undefined;
						} catch (err) {
							console.warn(
								`[three-stage] hasGateResponse lookup failed for ${session.execution_id}: ${(err as Error).message}`,
							);
							return false;
						} finally {
							db.close();
						}
					},
					maxFixRounds,
				},
				resolveThreeStage: (session) => {
					const issueLabels = parseJsonStringArray(
						store.getSession(session.execution_id)?.issue_labels,
					);
					return resolveThreeStagePolicy({
						pipelineConfig: pipelineConfigByProject.get(
							session.project_name ?? "",
						),
						issueLabels,
						// FLY-902: the handoff-side check must see the dispatching
						// Lead's chatChannel too — omitting it made a configured
						// three_stage_channels allowlist fail closed on EVERY handoff
						// (same trust chain as the entry gate in runs-route: server-side
						// project config, never the request body).
						dispatchChannelId: resolveHandoffDispatchChannelId(
							projects,
							session.project_name,
							issueLabels,
						),
						env: process.env,
					});
				},
				// FLY-793 (combined-QA FLY-855): resolve the REAL leadId at handoff.
				// The sessions table has NO lead_id column, so the orchestrator's old
				// `prev.lead_id` read was always undefined → Blueprint's commDbPath
				// had no leadId → TmuxAdapter's CommDB registration silently skipped
				// → postMergeTmuxCleanup found no tmux target → the Implement/QA
				// phase windows never auto-closed after ship (and the leaked QA
				// runner un-archived the issue thread). Mirror the finalization
				// paths: project config + the issue's labels.
				resolveLeadId: (session) => {
					if (!session.project_name) return undefined;
					try {
						const labels = store.getSessionLabels(session.execution_id);
						const { lead } = resolveLeadForIssue(
							projects,
							session.project_name,
							labels,
						);
						return lead.agentId;
					} catch (err) {
						console.warn(
							`[three-stage] resolveLeadId failed for ${session.execution_id}: ${(err as Error).message}`,
						);
						return undefined;
					}
				},
				effects: {
					// Capture the phase's exact head SHA (git rev-parse HEAD in its
					// worktree) BEFORE any cleanup — the durable handoff point on the
					// shared branch B. Null on any failure → orchestrator fail-closes.
					capturePhaseHeadSha: async (session) => {
						const worktree = store.getSession(
							session.execution_id,
						)?.worktree_path;
						if (!worktree) return null;
						try {
							const { stdout } = await execFileP("git", [
								"-C",
								worktree,
								"rev-parse",
								"HEAD",
							]);
							const sha = stdout.trim();
							return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
						} catch {
							return null;
						}
					},
					// Dirty-safe close of the completed phase runner. `finalizeDone`
					// FSM-transitions the design_done / awaiting_review phase-session to
					// completed first (edges are legal), then frees its tmux + worktree
					// for the next phase. NO `archive` — the phases share the parent
					// issue's thread, which must NOT be archived mid-pipeline.
					closePhaseRunner: async (session) => {
						// FLY-793 (Codex full-PR R1 #1): capture the worktree path BEFORE
						// close (closeRunner may clear tmux/CommDB but leaves the worktree).
						const worktree = store.getSession(
							session.execution_id,
						)?.worktree_path;
						const result = await closeRunner(
							{
								executionId: session.execution_id,
								issueId: session.issue_id,
								projectName: session.project_name ?? "",
								reason: `three-stage ${session.session_role ?? "phase"} handoff`,
								executorType: "phase",
								finalizeDone: true,
								transitionOpts,
							},
							store,
						);
						if (!result.closed) {
							throw new Error(result.error ?? "closeRunner did not close");
						}
						// FLY-793 (Codex full-PR R1 #1): the handoff OWNS the branch-B
						// worktree teardown here (awaited, before the next phase). If the
						// phase left uncommitted work (dirty) — or the clean-probe can't
						// confirm — FAIL-CLOSED: throw so the PhaseOrchestrator aborts the
						// handoff + alerts the Lead, and never lets the next phase's async
						// Blueprint.removeIfExists silently discard those files. The head
						// SHA was already captured from the COMMITTED tree upstream, so the
						// next phase always starts from committed state.
						// FLY-859 (Codex code R1 HIGH-2): the QA FAIL fix-loop closes
						// TERMINAL sessions through this path too. An absent worktree path
						// means branch B is already free (removal already proven) — skip
						// the probes instead of failing "unverifiable" forever.
						if (worktree && ffExistsSync(worktree)) {
							const clean = await gitWorktreeClean(worktree);
							if (clean !== true) {
								throw new Error(
									`${session.session_role ?? "phase"} worktree ${worktree} is ${
										clean === false
											? "DIRTY (uncommitted changes)"
											: "unverifiable"
									} — refusing handoff to avoid discarding work`,
								);
							}
							// Clean → dirty-safe removal (git worktree remove, no --force) so
							// branch B is free for the next phase's create.
							await phaseWorktreeCleanup({
								executionId: session.execution_id,
								issueId: session.issue_id,
								issueIdentifier: session.issue_identifier,
								projectName: session.project_name ?? "",
								tmuxClosed: result.closed,
							});
							// FLY-793 (Codex full-PR R2 #2): PROVE removal in the awaited
							// path. makeBridgeWorktreeCleanup is never-throw (silently skips
							// on FLYWHEEL_WORKTREE_AUTOCLEAN=0 / not-registered / path- or
							// branch-mismatch, and only audits a removal failure), so a
							// return does NOT guarantee the worktree is gone. If the path
							// still exists, FAIL-CLOSED — for a phase handoff the autoclean
							// escape hatch is FATAL, not skip-and-continue: the next phase
							// must never run its async, non-dirty-safe removeIfExists on a
							// worktree the orchestrator could not free. (remove() renames the
							// path away synchronously, so a successful removal leaves it gone.)
							if (ffExistsSync(worktree)) {
								throw new Error(
									`${session.session_role ?? "phase"} worktree ${worktree} still present after cleanup (autoclean off or removal failed) — refusing handoff`,
								);
							}
						}
					},
					// Fail-closed Lead-only alert (never the founder). Resolve the
					// owning Lead + page it via the SAME notifier auto-QA uses.
					alertLeadPipelineError: async ({ session, reason }) => {
						const projectName = session.project_name ?? "";
						let leadId: string | undefined;
						try {
							const { lead } = resolveLeadForIssue(
								projects,
								projectName,
								parseJsonStringArray(
									store.getSession(session.execution_id)?.issue_labels,
								),
							);
							leadId = lead.agentId;
						} catch {
							/* leadId stays undefined */
						}
						if (!leadId) {
							console.error(
								`[three-stage] pipeline error (no lead): ${reason}`,
							);
							return;
						}
						// FLY-927 (Task 3.3, FLY-912 wording collapse): the body leads with
						// the TRUTHFUL park line derived from the session's REPORTED stage
						// (never guessed); underivable → an explicit stage未上报 prefix.
						const fullSession = store.getSession(session.execution_id);
						const parkTuple = fullSession
							? deriveParkTuple({
									session: fullSession,
									pendingGates: [],
									autoQaActive: false,
									notifiedEvidence: false,
									ownerLeadId: leadId,
									nowMs: Date.now(),
								})
							: null;
						const truthfulBody = parkTuple
							? `${formatParkAlert(parkTuple, Date.now())}\n${reason}`
							: `[stage未上报] ${reason}`;
						// FLY-927 (W1): through the ROUTED sink — an issue-progress kind
						// with a bound [FLY-XX] thread lands there (D1); unset routing env
						// / boot window = the raw notifier exactly as before. sessionKey
						// carries the execution id the Router's thread resolution keys on.
						await (routedAlertSinkHolder.current ?? leadAlertNotifier).alert({
							leadId,
							projectName,
							eventId: `three-stage-stuck:${session.execution_id}:${Date.now()}`,
							eventType: "three_stage_stuck",
							title: `Three-stage pipeline stuck — ${
								session.issue_identifier ?? session.issue_id
							}`,
							body: truthfulBody,
							severity: "warning",
							sessionKey: session.execution_id,
						});
					},
					// FLY-887: 4-state PROCESS liveness (not window existence). No tmux
					// target = the process is gone → absent.
					probePhaseAlive: async (session) => {
						const target = getTmuxTargetFromCommDb(
							session.execution_id,
							session.project_name ?? "",
						);
						if (!target) return "absent";
						return probeRunnerProcessLiveness(target.tmuxWindow);
					},
					// FLY-939 (G-C): probe a phase row's PERSISTED tmux target DIRECTLY,
					// bypassing the CommDB registration lookup (which returns absent for a
					// terminal-status row and would mask a still-live window — the exact
					// pollution the ghost guard must catch, Codex design R1 #2). No
					// persisted tmux_session → nothing to probe → absent.
					probeGhostTmux: async (row) => {
						if (!row.tmux_session) return "absent";
						return probeRunnerProcessLiveness(row.tmux_session);
					},
					// FLY-887: park a completed-but-alive phase (CommDB declared-state;
					// NOT closeRunner, NOT worktree removal). The shared worktree stays.
					parkPhaseRunner: async (session) => {
						const db = new CommDB(
							commDbPathForProject(session.project_name ?? ""),
						);
						try {
							db.upsertDeclaredState(
								session.execution_id,
								"parked",
								`three-stage ${session.session_role ?? "phase"} parked awaiting pipeline`,
								Date.now(),
								null,
							);
						} finally {
							db.close();
						}
						// FLY-907 (Step 4.2): a park changes the derived display state
						// (boundary status + parked → ✅) with NO stage_changed — the
						// FLY-902 Finding #4 stale-display root cause. Refresh.
						issueDisplayRefreshHolder.current?.enqueue(session.issue_id);
					},
					// FLY-887: fail-closed pre-wake worktree check (mirrors the close
					// path's dirty guard, on the wake path).
					assertPhaseWorktreeReady: async (session, expectedHeadSha) => {
						const worktree = store.getSession(
							session.execution_id,
						)?.worktree_path;
						if (!worktree) {
							return { ok: false, reason: "no persisted worktree_path" };
						}
						if (!ffExistsSync(worktree)) {
							return { ok: false, reason: `worktree path ${worktree} missing` };
						}
						const clean = await gitWorktreeClean(worktree);
						if (clean !== true) {
							return {
								ok: false,
								reason: clean === false ? "dirty" : "clean-unverifiable",
							};
						}
						try {
							const { stdout } = await execFileP("git", [
								"-C",
								worktree,
								"rev-parse",
								"HEAD",
							]);
							const head = stdout.trim();
							if (head !== expectedHeadSha) {
								return {
									ok: false,
									reason: `HEAD ${head} != expected ${expectedHeadSha}`,
								};
							}
						} catch (err) {
							return {
								ok: false,
								reason: `rev-parse failed: ${(err as Error).message}`,
							};
						}
						return { ok: true };
					},
					// FLY-887: clear the park marker, then mailbox-wake the parked phase
					// with the role-specific instruction + new head (mirrors auto-QA
					// retestWakeQa). `{ ok:false }` = nothing delivered → held for reconcile.
					wakePhaseRunner: async ({
						session,
						kind,
						headSha,
						round,
						qaSummary,
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
								error: `no-transport backend (${adapter}) cannot receive a wake`,
							};
						}
						const db = new CommDB(
							commDbPathForProject(session.project_name ?? ""),
						);
						try {
							try {
								db.clearDeclaredState(session.execution_id);
							} catch (err) {
								console.warn(
									`[three-stage] clearDeclaredState warn for ${session.execution_id}: ${(err as Error).message}`,
								);
							}
							const content =
								kind === "fix"
									? `Three-stage QA FIX round ${round ?? "?"}: the QA phase FAILED this branch. Its findings / failing tests / report are ALREADY COMMITTED on this branch at ${headSha}. FIRST run \`flywheel-comm turn --exec-id ${session.execution_id}\` and proceed ONLY on a \`yours\` answer (this wake text is context, not authority). Then fix exactly what they name in THIS worktree, push, re-run Codex review, re-request review (gate approve_to_ship --no-block + complete --route needs_review), then park again and WAIT. QA summary: ${qaSummary ?? "(none)"}`
									: `Three-stage RE-TEST: the implement phase pushed a fix and your worktree is ALREADY at the new head ${headSha} (same directory — zero fetch/checkout). FIRST run \`flywheel-comm turn --exec-id ${session.execution_id}\` and proceed ONLY on a \`yours\` answer. Then re-run your QA scenarios and emit \`flywheel-comm qa-result\` again. Same session — do NOT complete; on FAIL park again and wait for the next RE-TEST.`;
							const res = await wakeRunnerMailbox({
								db,
								execId: session.execution_id,
								fromAgent: "bridge",
								content,
								metadata: {
									kind:
										kind === "fix" ? "three_stage_fix" : "three_stage_retest",
									headSha,
									...(round !== undefined ? { round } : {}),
								},
								backend: transport,
							});
							if (res.ok) return { ok: true };
							return {
								ok: false,
								error: res.error ?? res.skippedReason ?? "wake failed",
							};
						} catch (err) {
							return { ok: false, error: (err as Error).message };
						} finally {
							db.close();
							// FLY-907 (Step 4.2): the park marker was just cleared — the
							// woken phase must flip back to ▶ (FLY-543 rework display).
							// This is also the normal TURN re-grant path. Fire-and-forget.
							issueDisplayRefreshHolder.current?.enqueue(session.issue_id);
						}
					},
				},
				// FLY-887: keep-alive kill-switch + wake-target lookup + TURN grant.
				keepAliveEnabled: () => threeStageKeepAliveEnabled(),
				getAlivePhaseSession: (issueId, phase) => {
					const ALIVE = new Set([
						"running",
						"awaiting_review",
						"approved_to_ship",
						"design_done",
					]);
					return store
						.getPhaseSessionsForIssue(issueId)
						.find((s) => s.chat_thread_role === phase && ALIVE.has(s.status)) as
						| PhaseSession
						| undefined;
				},
				// FLY-887 QA round 2: durable "this issue already shipped" signal —
				// runPostShipFinalization's atomic per-issue claim event, keyed to
				// issue_id regardless of which execution triggered it.
				hasShipFinalizationClaim: (issueId) =>
					store.countEventsByIssueAndType(
						issueId,
						"post_ship_finalization_claim",
					) > 0,
				// FLY-887 (founder-visibility status line): re-render + post-or-edit
				// the single "🎨design(...)·🔨implement(...)·🧪qa(...)" line. Best-effort
				// — never lets a Discord hiccup break a real handoff/verdict. Also
				// populates phaseStatusLineRefreshHolder (declared near the other
				// forward-reference holders) so ship-time finalization can reach the
				// SAME function to refresh the line to its final done/done/done state
				// (Finding B from the founder-visibility real-machine QA round — the
				// line otherwise goes stale at whatever it showed pre-merge).
				refreshPhaseStatusLine: refreshPhaseStatusLineEffect,
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
				// FLY-921 Fix C: turn-belt reconcile reads/writes. Rows live in
				// per-project CommDBs (no project column) — this seam owns the
				// attribution so the orchestrator never sees an unattributed row.
				turnBelt: {
					listTurns: () => {
						const rows: { projectName: string; turn: TurnBeltRow }[] = [];
						for (const p of projects) {
							const dbPath = commDbPathForProject(p.projectName);
							if (!ffExistsSync(dbPath)) continue;
							const db = new CommDB(dbPath);
							try {
								for (const turn of db.listTurns()) {
									rows.push({ projectName: p.projectName, turn });
								}
							} catch (err) {
								console.warn(
									`[three-stage] turnBelt.listTurns failed for ${p.projectName}: ${(err as Error).message}`,
								);
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
					getSessionForTurnHolder: (execId) => store.getSession(execId),
					getPhaseSessionsForIssue: (issueId) =>
						store.getPhaseSessionsForIssue(issueId) as PhaseSession[],
				},
				// FLY-793 (Codex full-PR R2 #1): source stranded design_done sessions
				// for the startup reconcile (boot marker drain lands them before this
				// orchestrator is wired).
				listStrandedDesignPhases: () => store.getStrandedDesignPhaseSessions(),
				// FLY-939 (G-A2): implement rows stranded at awaiting_review — the
				// startup reconcile re-drives their lost implement→QA handoff.
				listStrandedImplementPhases: () =>
					store.getStrandedImplementPhaseSessions() as PhaseSession[],
				// FLY-939 (G-C): all rows for an issue+phase (any status, newest first
				// with rowid tiebreak) — the ghost guard's probe pool.
				listPhaseSessionRows: (issueId, phase) =>
					store
						.getPhaseSessionsForIssue(issueId)
						.filter((s) => s.chat_thread_role === phase) as PhaseSession[],
				logger: {
					log: (m) => console.log(m),
					warn: (m) => console.warn(m),
				},
			});
			// FLY-793 (Codex full-PR R2 #1): re-drive any Design phase stranded at
			// design_done by the boot marker drain (which ran before this orchestrator
			// existed). Mirrors autoQaCoordinator.reconcileOnStartup — best-effort,
			// never blocks boot.
			void phaseOrchestratorHolder.current
				.reconcileOnStartup()
				.then(() =>
					// FLY-921 Fix C startup position: full-table turn-belt scan AFTER
					// the stranded-handoff replay (so it sees the replayed final state).
					// Guard 2 (grant grace) protects any TURN a replayed handoff just
					// granted to a still-in-flight spawn.
					phaseOrchestratorHolder.current?.reconcileTurnBelt(),
				)
				.then(() => {
					// FLY-1232 T8: the DEDICATED shadow replay — runs AFTER the
					// orchestrator reconcile so the durable sources it reads (fix
					// rounds, verdict intents, finalization claims) reflect the
					// replayed state. Never piggybacks the orchestrator's skip-heavy
					// logic, never triggers production actions. no-op when flag OFF.
					workflowShadowWriter?.reconcileOnStartup();
				})
				.catch((err) =>
					console.warn(
						`[three-stage] reconcileOnStartup failed: ${(err as Error).message}`,
					),
				);
			console.log(
				`[three-stage] PhaseOrchestrator wired (opt-in default OFF: ${enabledProjects}/${projects.length} projects three_stage ON)`,
			);
		} catch (err) {
			console.warn(
				`[three-stage] PhaseOrchestrator wiring failed: ${(err as Error).message} — three-stage disabled this boot`,
			);
		}
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
			env: process.env,
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

	// FLY-368 rework (Codex R1 HIGH-1): threading needs a RESOLVABLE repair CHAIN
	// (any fleet bot), NOT one fixed token. Fail LOUD + disable threading ONLY when
	// the entire repair chain is empty.
	// FLY-1243: threading is固化 default-on, so a unified channel WITHOUT a
	// resolvable repair chain is a genuine misconfig (fail loud). A Bridge with no
	// unified channel at all simply doesn't use unified alerts — not an error.
	if (unifiedAlertChannelId && !repairChainResolves) {
		console.error(
			"[Bridge] FLY-368: unified alert channel set but no resolvable repair chain " +
				"(need at least one resolvable fleet bot token) — threading DISABLED.",
		);
		void metaAlertNotifier.notify({
			reason: "alert_unreachable_config",
			title: "FLY-368 alert threading misconfigured",
			body: "Unified alert channel set but no resolvable repair-chain bot — per-error threads will NOT be created.",
		});
	}

	// FLY-696: hoisted so both the Hub's repair path AND the account-switch
	// watchdog (piggybacked on onPollComplete below, no new timer) share one
	// DiscordOps + one accountSwitch instance. accountSwitch is gated on
	// the account-pool presence (FLY-1243; absent = byte-compat → undefined).
	const alertDiscordOps = createDiscordOps(() => {
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
	});
	// FLY-1048 (A5): wire the suspicious-report quiet thread leg now that the
	// Discord ops exist (the deliverer skipped the leg while this was null).
	suspiciousThreadPoster.current = async (threadId, content) => {
		await alertDiscordOps.postToThread(threadId, content);
	};
	// FLY-1243: FLYWHEEL_ACCOUNT_SELF_HEAL retired (固化 default-on). The Claude
	// account pool file is now the de-facto switch — present ⇒ self-heal wires
	// (production); absent ⇒ undefined = byte-compat for deployments that never
	// provisioned a pool (QA slots / sub / joycon), no quota scan, no switch.
	const accountSwitchRepair = accountPoolConfigured()
		? makeAccountSwitchRepair({
				switchDeps: makeClaudeProfileSwitchDeps({
					binPath: claudeProfileBinPath(),
				}),
			})
		: undefined;

	// FLY-696 M1/④: now that the unified-channel DiscordOps exists, late-bind the
	// account_rotation Alerts-post the event router reads. Reuses the SAME
	// post-to-thread path the account-switch watchdog uses. Gated on the SAME
	// self-heal switch as the rest of FLY-696 (Codex R1 MED-2: flag off = the
	// default MUST be byte-compatible, no new Alerts behavior); no unified
	// channel likewise leaves the holder undefined → the event is acked, not
	// posted.
	// FLY-871 R3/C9: the infra self-heal rescue runtime (built inside the same
	// self-heal gate below). Declared here so the account-switch watchdog tick
	// (onPollComplete, later in this closure) can trigger the post-switch sweep.
	let rescueRuntime: RescueRuntime | undefined;
	// FLY-929 A4+A5: the SHARED switch-result post used by both executor paths
	// (watchdog tick + /api/account-switch route) — hoisted so the onPollComplete
	// watchdog tick (a later closure) reuses the exact same routing. Set inside
	// the self-heal gate below; undefined ⇒ self-heal off (neither path runs).
	let postSwitchResult:
		| ((detail: string, disposition?: RepairDisposition) => Promise<void>)
		| undefined;
	if (accountSwitchRepair && unifiedAlertChannelId) {
		// The Alerts post is authoritative and unchanged in the dormant states;
		// on top of it:
		//  - needs_human (no_account / failed / not-attemptable) +
		//    resolveAccountCapOwnerId ⇒ the post becomes the owner-bot ASSIGNMENT
		//    (mention) instead of a plain line — the FLY-871 bot playbook carries
		//    the eventual founder escalation until FLY-927's ticket state machine
		//    lands. Any env missing ⇒ plain detail post byte-for-byte.
		//  - notifySuccess (a REAL switched outcome only) + P-identity ⇒ ONE
		//    best-effort digest to #flywheel-notify (never blocks the Alerts
		//    record; postInfraNotifyDigest logs and swallows failures).
		postSwitchResult = async (
			detail: string,
			disposition?: RepairDisposition,
		): Promise<void> => {
			const capOwnerId =
				disposition?.outcome === "needs_human"
					? resolveAccountCapOwnerId()
					: undefined;
			if (capOwnerId) {
				await alertDiscordOps.postToThread(
					unifiedAlertChannelId,
					formatAccountCapOwnerAssignment(capOwnerId, detail),
					{ mentionUserId: capOwnerId },
				);
			} else {
				await alertDiscordOps.postToThread(unifiedAlertChannelId, detail);
			}
			if (disposition?.notifySuccess) {
				await postInfraNotifyDigest(
					formatSwitchSuccessDigest(disposition.notifySuccess),
				);
			}
		};
		accountRotationPostHolder.current = async (detail, rotation) => {
			await alertDiscordOps.postToThread(unifiedAlertChannelId, detail);
			// FLY-929 A4: rotation digest from the STRUCTURED payload (never
			// re-parsed from the Alerts line). P-identity dormant ⇒ no-op.
			if (rotation) {
				await postInfraNotifyDigest(formatRotationDigest(rotation));
			}
		};
		// FLY-871 R2/C5: bind the /api/account-switch runtime (same self-heal gate).
		// The route claims a pending record + reuses accountSwitchRepair.executeSwitch,
		// posts the result to the Alerts channel, and audits before/after to lead_events.
		accountSwitchRouteHolder.current = {
			repair: accountSwitchRepair,
			postResult: postSwitchResult,
			audit: (e) =>
				store.appendLeadEvent(
					e.actorBotId,
					`account-switch:${e.phase}:${e.key}`,
					`account_switch_${e.phase}`,
					JSON.stringify(e),
				),
			// FLY-927 (Task 2.3): the atomic pending-switch claim ACKs the matching
			// ACTIVE ticket — exact event-id correlation, so a stale episode can
			// never be acked; legacy rows (NULL ticket_status) untouched.
			ackTicket: (sourceAlertId) => {
				const row = store.getActiveAlertThreadByEventId(sourceAlertId);
				if (row?.ticket_status) {
					store.setTicketStatus(row.correlation_key, "ACK");
				}
			},
		};

		// FLY-871 R3/C9: build the infra self-heal rescue runtime — binds the pure
		// rescue orchestration (rescue.ts) to the real Bridge primitives. Consumed
		// by the /api/rescue route (W3) and the post-switch sweep (W5). Same
		// self-heal gate ⇒ dormant + byte-compat when the flag is off.
		const resolveRescueLeadId = defaultResolveLeadId(projects);
		// The founder's Discord id for a REAL @-ping on a rescue escalation (snowflake
		// only; unset/malformed ⇒ undefined = degrade to no-mention, like the Hub).
		const rescueFounderDiscordId = (): string | undefined => {
			const id = process.env.FLYWHEEL_FOUNDER_DISCORD_USER_ID?.trim();
			return id && /^\d{17,20}$/.test(id) ? id : undefined;
		};
		const rescueDetectionAiClassify =
			process.env.FLYWHEEL_DETECTION_AI_CLASSIFY === "0"
				? undefined
				: makeSubscriptionDetectionClassifier({});
		rescueRuntime = buildRescueRuntime({
			listPendingAlerts: () => store.listActiveAlertThreads(),
			kickstart: makeKickstart({ log: (m) => console.warn(m) }),
			captureLeadPane: async (projectName, leadId) => {
				const w = await locateLeadWindow(projectName, leadId);
				if (!w) return null;
				return leadPaneCaptureFn(w.windowId, 200);
			},
			sendEnterToLead: async (projectName, leadId) => {
				const w = await locateLeadWindow(projectName, leadId);
				if (w) await sendEnterToWindow(w.windowId);
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
			// FLY-927 (Task 2.3): a rescue call is the owner bot's claim — ACK the
			// matching ACTIVE ticket. Lead rescues correlate by (leadId,
			// login_expired); runner rescues by (session_key=executionId,
			// runner_login_expired). Unresolved / legacy row = no-op (never ack the
			// wrong episode).
			ackTicket: ({ route, leadId, executionId }) => {
				const row =
					route === "lead"
						? leadId
							? store.getActiveAlertThreadByLeadAndType(leadId, "login_expired")
							: undefined
						: store
								.listActiveAlertThreads()
								.find(
									(r) =>
										r.session_key === executionId &&
										r.event_type === "runner_login_expired",
								);
				if (row?.ticket_status) {
					store.setTicketStatus(row.correlation_key, "ACK");
				}
			},
		};
		// FLY-871 R3/W5: on a successful bot-claimed switch (the /api/account-switch
		// route), sweep the incident-window login-stuck sessions. The watchdog-fired
		// switch wires the same sweep below (onPollComplete).
		accountSwitchRouteHolder.current.onSwitchSuccess = async () => {
			await rescueRuntime?.postSwitchRescueSweep();
		};
	}

	// FLY-1082 (Task 3.2): runbook-gap Linear wiring — FLY team / Flywheel
	// project / Flywheel label, resolved lazily per call (the auto-filed issue
	// is rare; no caching complexity). No LINEAR_API_KEY ⇒ creation degrades to
	// null and the escalation itself is untouched.
	const runbookCreateIssue = async (input: {
		title: string;
		description: string;
	}): Promise<{ id: string; identifier?: string } | null> => {
		const apiKey = config.linearApiKey;
		if (!apiKey) return null;
		try {
			const { LinearClient } = await import("@linear/sdk");
			const client = new LinearClient({ apiKey });
			const teams = await client.teams({ filter: { key: { eq: "FLY" } } });
			const team = teams.nodes[0];
			if (!team) return null;
			const projects = await client.projects({
				filter: { name: { eq: "Flywheel" } },
			});
			const labels = await team.labels({
				filter: { name: { eq: "Flywheel" } },
			});
			const payload = await client.createIssue({
				teamId: team.id,
				title: input.title,
				description: input.description,
				...(projects.nodes[0]?.id && { projectId: projects.nodes[0].id }),
				...(labels.nodes[0]?.id && { labelIds: [labels.nodes[0].id] }),
			});
			const created = await payload.issue;
			return created?.id
				? { id: created.id, identifier: created.identifier }
				: null;
		} catch (err) {
			console.warn(
				`[runbook-gap] Linear issue creation failed: ${(err as Error).message}`,
			);
			return null;
		}
	};
	const runbookIsIssueOpen = async (
		issueId: string,
	): Promise<boolean | null> => {
		const apiKey = config.linearApiKey;
		if (!apiKey) return null;
		try {
			const { LinearClient } = await import("@linear/sdk");
			const issue = await new LinearClient({ apiKey }).issue(issueId);
			const state = await issue.state;
			return state ? !["completed", "canceled"].includes(state.type) : null;
		} catch {
			return null; // cannot tell — keep the dedup (never double-file)
		}
	};

	// FLY-368 rework: Hub on when unified channel + threading + a resolvable repair
	// chain; else watchdogs route straight to the notifier (legacy / root-only).
	const alertHub =
		unifiedAlert && repairChainResolves
			? new AlertChannelHub({
					store,
					notifier: leadAlertNotifier,
					// Repair-chain DiscordOps: Cass → alphabetical, resolved per call.
					discord: alertDiscordOps,
					// FLY-1243: conservative auto-repair, 固化 default-on (always wired
					// inside the hub, which itself needs a channel + repair chain). Only
					// the two safe actions; reuses the audited runner-nudge +
					// lead-resume-enter ops.
					autoRepairBot: new AutoRepairBot({
						runnerNudge: (input) =>
							attemptRunnerRecoveryNudge(input, {
								store,
								projects,
								captureSessionFn: defaultCaptureSession,
								hasPendingGate: hasPendingGateFromCommDb,
								sendKeys: sendKeysToWindow,
								getTmuxTarget: getTmuxTargetFromCommDb,
								now: () => Date.now(),
								nextAuditSeq: (() => {
									let n = 0;
									return () => ++n;
								})(),
							}),
						leadResumeEnter: (input) =>
							attemptLeadResumeEnter(input, {
								store,
								locateWindowFn: locateLeadWindow,
								captureFn: leadPaneCaptureFn,
								sendEnter: sendEnterToWindow,
							}),
						// FLY-696: usage_limit → Claude account switch (enqueues a
						// pending record; the watchdog below fires it). Hoisted +
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
						const w = await locateLeadWindow(projectName, leadId);
						if (!w) return null;
						return leadPaneCaptureFn(w.windowId, 200);
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
					// FLY-927 (Task 2.4): T2 escalation for an ISSUE-BOUND ticket pages
					// the founder in the issue's own [FLY-XX] thread — the FLY-818 page
					// + founder_page_ledger dedup (never re-pages the same event id).
					escalateToIssueThread: async (row) => {
						if (!row.session_key || !config.discordOwnerUserId) return false;
						if (store.getFounderPaged(row.event_id) === true) return true;
						const session = store.getSession(row.session_key);
						if (!session) return false;
						const { lead } = resolveLeadForIssue(
							projects,
							session.project_name,
							parseJsonStringArray(session.issue_labels),
						);
						const thread = store.getChatThreadByIssue(
							session.issue_id,
							lead.chatChannel,
						);
						const firstSeenMs = row.first_seen_at
							? Date.parse(`${row.first_seen_at.replace(" ", "T")}Z`)
							: Number.NaN;
						const outcome = await emitFounderStuckNotification(
							{
								executionId: row.session_key,
								issueId: session.issue_id,
								issueIdentifier: session.issue_identifier ?? undefined,
								projectName: session.project_name,
								leadAgentId: lead.agentId,
								stuckMinutes: Number.isNaN(firstSeenMs)
									? 0
									: Math.max(
											0,
											Math.round((Date.now() - firstSeenMs) / 60_000),
										),
								thread,
								botToken: lead.botToken ?? config.discordBotToken,
								ownerUserId: config.discordOwnerUserId,
								phasePrefix: phaseMessageTag(
									session.chat_thread_role,
									session.runner_model,
								),
							},
							{ store },
						);
						const paged = outcome.kind === "posted";
						store.recordFounderPaged(row.event_id, paged);
						return paged;
					},
					// FLY-1082: fleet-kind recovery probe (watermark cleared / bot back
					// alive / boot reconcile done) — holder-backed; null = cannot tell.
					fleetRecovery: async (row) =>
						(await fleetSensorsHolder.current?.recoveryProbe(row)) ?? null,
					// FLY-1082 (Task 3.2): repeated-escalation runbook-gap counter —
					// same kind ESCALATED ≥3 times in 7 days auto-files the eng issue.
					onTicketEscalated: async (row) => {
						await noteTicketEscalated(row.event_type, {
							store,
							createIssue: runbookCreateIssue,
							isIssueOpen: runbookIsIssueOpen,
						});
					},
				})
			: undefined;
	if (alertHub) {
		console.log(
			`[Bridge] FLY-368 AlertChannelHub ON (unified channel=${unifiedAlertChannelId}, auto-repair=ON)`,
		);
	}

	// FLY-368: a single alert sink used by BOTH watchdogs. When the Hub is on it
	// adds threading + auto-repair; otherwise it's the raw notifier (byte-compat).
	const alertSink: { alert: (p: AlertPayload) => Promise<AlertResult> } =
		alertHub ? { alert: (p) => alertHub.handle(p) } : leadAlertNotifier;

	// FLY-927 (W1): wrap the raw sink with the D1 Router. FLYWHEEL_ALERT_ROUTING
	// unset ⇒ pure passthrough (the resolver is never even consulted). An
	// issue-progress alert with a bound [FLY-XX] thread is delivered THERE via
	// the issue-thread infra leg; any resolution/delivery failure fail-safes back
	// to the raw sink (ticket queue) — never silent, never recursive.
	const routedAlertSink = buildInfraAlertRouting({
		store,
		projects,
		globalBotToken: config.discordBotToken,
		rawSink: alertSink,
	});
	routedAlertSinkHolder.current = routedAlertSink;

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
	// transport CommDBLeadRuntime uses) — the fleet notifications (load-shed /
	// casualty lists) ride it. Leads are unique per agentId across projects.
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
		notifyLead: notifyLeadInstruction,
		listLeadIds: () => [...leadProjectByAgentId.keys()],
		probeBots: probeInfraBots,
		scanZombies: scanZombiesWired,
		// Codex R2 HIGH: a server-loss episode with unmigrated casualties must
		// never read as recovered — the probe consults the live coordinator.
		serverLossPending: () =>
			serverLossHolder.current?.hasPendingMigrations() ?? false,
	});
	serverLossHolder.current = new ServerLossCoordinator({
		store,
		probeServer: () => probeTmuxServer(),
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
		currentWatermark: () => fleetSensorsHolder.current?.lastWatermark ?? null,
	});
	console.log(
		"[Bridge] FLY-1082 fleet sensors wired (swap/bot/zombie on watchdog tick; tmux server-loss as heartbeat pre-reaper phase)",
	);

	// FLY-1082 (Task 2.4): boot self-check leg — a latched `running` marker
	// means the previous Bridge died dirty; open the lifecycle ticket (the
	// wrapper page already fired Bridge-independently with its OWN dedup id;
	// both legs share the episode signature for correlation).
	if (prevExitMarker?.state === "running") {
		const episode = abnormalExitEpisodeSignature(prevExitMarker);
		void routedAlertSink
			.alert({
				leadId: "bridge",
				projectName: FLEET_ALERT_PROJECT,
				eventId: abnormalExitTicketEventId(prevExitMarker),
				eventType: "bridge_abnormal_exit",
				title: "Bridge 非正常退出 — 复活对账中",
				body: `上一代 Bridge (PID ${prevExitMarker.pid}, boot ${prevExitMarker.bootTs}) 没有 clean shutdown 就退出了（episode ${episode}；wrapper 直发 page 同一 episode）。launchd 已复活本进程；boot 对账完成后本工单安静 resolve。`,
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

	// FLY-92: Runner idle watchdog — detects stuck Runners via tmux capture-pane.
	// FLY-195: also drives the stuck-runner detector from the SAME 30s poll
	// (no new periodic timer, FLY-169) using the SAME per-session capture.
	// Created after leadAlertNotifier because the detector's Q7 fallback
	// (runner_stuck_unhandled) pages Annie through it.
	const stuckDetector = buildStuckRunnerDetector({
		store,
		projects,
		runtimeRegistry: registry,
		chatThreadsEnabled: config.chatThreadsEnabled,
		// FLY-368: route the Q7 runner_stuck_unhandled alert through the same sink
		// as Lead alerts so it lands in the unified channel + gets a thread + the
		// conservative auto-repair attempt (when enabled). Falls back to the raw
		// notifier when the Hub is off (byte-compat).
		notifier: routedAlertSink,
		// FLY-818 M3 (default-ON, kill-switch FLYWHEEL_STUCK_FOUNDER_PAGE=0): the
		// founder page for a genuinely-stuck runner posts an @founder message into
		// that runner's OWN [FLY-XX] issue thread (Annie's design), using the owning
		// Lead's bot
		// (lead.botToken) with this as the fallback. No owner id ⇒ page disabled.
		discordBotToken: config.discordBotToken,
		discordOwnerUserId: config.discordOwnerUserId,
	});
	// FLY-253 (Codex R2 #4): late-bind the detector into the holder the
	// remanage router already captured — re_arm can now reach the in-memory
	// episode map. Stays null when detection is disabled.
	stuckDetectorHolder.current = stuckDetector;
	// FLY-628 band-aid: stretch the poll cadence (was a 30s hardcode) to ~1h so
	// parked / long-running Runners stop tripping false idle alerts that wake the
	// Lead and burn tokens. Env-tunable; the same poll still drives the FLY-195
	// stuck detector, so genuine-stuck detection survives (FLY-369), just at ~1h.
	// waitingThresholdCycles stays 2 (Annie's call): a "waiting" Runner is only
	// alerted after two consecutive ~1h polls (~2h), which is the accepted trade
	// — quieter alerts beat faster waiting-state detection. A smarter recognizer
	// (parked-aware / cheap probe / backoff) is the FLY-626 follow-up.
	const idlePollMs = idleWatchdogPollMs();
	const idleWatchdog = new RunnerIdleWatchdog({
		pollIntervalMs: idlePollMs,
		waitingThresholdCycles: 2,
		projects,
		store,
		runtimeRegistry: registry,
		captureSessionFn: defaultCaptureSession,
		chatThreadsEnabled: config.chatThreadsEnabled,
		stuckDetector,
		// FLY-626: shared quiet-signal probe (defined above with HeartbeatService).
		quietSignalsProbe,
		// FLY-623 (Codex R2 HIGH-3): suppress idle/stuck signals for a Runner that
		// was re-adopted after a Bridge restart (alive-but-detached) — its idle/stuck
		// appearance is an artifact of monitoring loss, not a real stall. Reads the
		// live HeartbeatService set via the holder; null/kill-switch → no suppression.
		isReconnecting: (execId) =>
			reconnectHolder.current?.isReconnecting(execId) ?? false,
		// FLY-696 M1/③: runner-side quota scan, piggybacked on this poll's capture
		// (no new timer). Gated on the SAME switch (accountSwitchRepair exists iff
		// account pool provisioned; FLY-1243) — absent ⇒ undefined ⇒ byte-compat.
		// Routes a real runner cap through the shared alert sink (Hub threading +
		// AutoRepairBot enqueue), with the §3.3 transient-529 short-circuit inside.
		runnerQuotaScan: accountSwitchRepair
			? (() => {
					const quotaScan = makeRunnerQuotaScan({
						projects,
						alert: (p) => routedAlertSink.alert(p),
						isTransient: isTransientThrottlePane,
						now: () => Date.now(),
					});
					// FLY-871 R2/C8: compose the runner AUTH scan into the SAME seam
					// (same per-session capture, no new timer). Layer-2 AI fallback is
					// default-ON with kill-switch FLYWHEEL_DETECTION_AI_CLASSIFY=0; it
					// only fires for unrecognized-anomalous panes (healthy/pattern panes
					// never spend a model call).
					const authScan = makeRunnerAuthScan({
						alert: (p) => routedAlertSink.alert(p),
						resolveLeadId: defaultResolveLeadId(projects),
						// FLY-871 R2/C7: populate the account-state ledger — a confirmed
						// runner logout marks the active account's live auth as stale.
						recordAuthHealth: (name) =>
							ledgerRecordAuthHealth(name, {
								lastFreshness: "stale",
								lastVerifiedAt: new Date().toISOString(),
								reason: "runner login_expired",
							}),
						aiClassify:
							process.env.FLYWHEEL_DETECTION_AI_CLASSIFY === "0"
								? undefined
								: makeSubscriptionDetectionClassifier({}),
					});
					return async (session: Session, pane: string) => {
						await quotaScan(session, pane);
						await authScan(session, pane);
					};
				})()
			: undefined,
	});
	idleWatchdogHealthHolder.current = idleWatchdog;
	idleWatchdog.start();
	console.log(
		`[Bridge] RunnerIdleWatchdog started (${Math.round(idlePollMs / 1000)}s poll${stuckDetector ? ", FLY-195 stuck detection ON" : ", FLY-195 stuck detection OFF (FLYWHEEL_STUCK_DETECT=0)"})`,
	);

	// FLY-818: opt-in auto-continue arming worker (default OFF —
	// FLYWHEEL_RUNNER_AUTOCONTINUE=1). A SEPARATE poller from RunnerIdleWatchdog: it
	// only observes a spawned claude-tmux runner until its idle input box appears,
	// then sends `/loop <goal>` ONCE so the runner self-continues toward its phase
	// goal instead of idling after a turn (the FLY-818 root cause). It never touches
	// the stuck-detector / idle-notification path. Reuses the audited nudge helpers
	// (capture / tmux target / pending-gate probe / literal send-keys).
	if (process.env.FLYWHEEL_RUNNER_AUTOCONTINUE === "1") {
		const armWindowEnv = Number(
			process.env.FLYWHEEL_AUTOCONTINUE_ARM_WINDOW_MS,
		);
		const autoContinueArmer = new AutoContinueArmer({
			pollIntervalMs: 20_000,
			projects,
			store,
			captureSessionFn: defaultCaptureSession,
			getTmuxTarget: getTmuxTargetFromCommDb,
			sendKeys: sendKeysToWindow,
			// FLY-818 (Codex code review R1 #2): BLOCKING-only gate probe — a
			// non-blocking `flywheel-comm ask` must NOT stop the runner from being
			// armed to self-continue (only a checkpointed gate parks it).
			hasPendingGate: hasPendingBlockingGateFromCommDb,
			...(Number.isFinite(armWindowEnv) && armWindowEnv > 0
				? { armWindowMs: armWindowEnv }
				: {}),
		});
		autoContinueArmer.start();
		console.log(
			"[Bridge] AutoContinueArmer started (FLY-818 /loop self-continue arming, opt-in)",
		);
	}

	const leadWatchdog = new LeadWatchdog({
		pollIntervalMs: 30_000,
		paneHashStuckCycles: 2,
		paneHashAlertCycles: 3,
		cooldownMs: 30 * 60_000,
		// FLY-224 Phase 6b legacy baseline: exclude Codex-backed projects (no
		// tmux pane) from the pane-text watchdog. BYTE-COMPAT: a project with
		// no roles.lead config → claude-code → identical list (no-op).
		projects: paneWatchdogProjects(
			projects,
			(p) => loadProjectLeadRoles(p.projectRoot),
			process.env,
		),
		// FLY-247: per-lead dynamic membership, re-resolved EVERY tick from the
		// current config snapshot + the poller's evidence map (one decision
		// function shared with the Dashboard, R8#4). No/stale evidence for a
		// codex-desired lead → desired-config exclusion (FLY-224 semantics);
		// claude leads always watched; CONFLICT (live Claude under codex
		// desire) keeps watching (漏报>误报). Legacy config.yaml stays as the
		// fallback desired source for the dual-source window.
		// NOTE (code-review H9): no project-level pre-filter here — the legacy
		// config.yaml/env desired source feeds the PER-LEAD effectiveBackend
		// inside filterPaneWatchedLeads. A project-level filter would remove an
		// explicit-Claude lead living in a legacy-codex project before the
		// shared decision function ever saw it.
		projectsProvider: () =>
			filterPaneWatchedLeads(
				fleetConfigProvider.snapshot().projects,
				fleetLegacyBackendOf,
				fleetPoller.snapshot(),
			),
		store,
		// FLY-368: route through the unified sink (Hub adds threading + auto-repair
		// when enabled; otherwise this is the raw notifier — byte-compat).
		notifier: (payload) => routedAlertSink.alert(payload),
		locateWindowFn: (projectName, leadId) =>
			locateLeadWindow(projectName, leadId),
		captureFn: leadPaneCaptureFn,
		claimsReader,
		blockedMarkerReader,
		// FLY-368: real-time recovery → resolve the matching alert thread (an
		// optimization; the reconcile pass below is the restart-safe truth source).
		onRecovery: alertHub
			? (projectName, leadId, recoveredKind) => {
					void alertHub.onLeadRecovery(projectName, leadId, recoveredKind);
				}
			: undefined,
		// FLY-368: piggyback the 30s poll to run the alert-thread reconcile pass
		// (no new timer). FLY-863: the SAME tick also re-scans for codex-holds that
		// crossed the stuck-duration threshold since the last pass. FLY-696: the
		// SAME tick also drives the account-switch watchdog (due pending switches
		// M1-only / bot fallback M2), posting results to the unified Alerts
		// channel. Every sub-task is independently try/caught so one failing piece
		// never wedges the others or the poll loop — no new timer for any of them.
		onPollComplete: async () => {
			// FLY-1082: fleet sensors ride the SAME piggybacked tick (zero new
			// timers) — memory pressure, infra-bot probes, throttled zombie scan.
			// Runs BEFORE the Hub reconcile so a fresh sensor verdict (e.g. the
			// watermark clearing) is visible to the same tick's recovery pass.
			try {
				await fleetSensorsHolder.current?.tick();
			} catch (err) {
				console.warn(
					`[Bridge] fleet-sensors tick failed: ${(err as Error).message}`,
				);
			}
			if (alertHub) {
				try {
					await alertHub.reconcile();
				} catch (err) {
					console.warn(
						`[Bridge] alertHub.reconcile failed: ${(err as Error).message}`,
					);
				}
			}
			try {
				await autoQaCoordinatorHolder.current?.reconcileStuckCodexHolds();
			} catch (err) {
				console.warn(
					`[auto-qa] reconcileStuckCodexHolds (poll) failed: ${(err as Error).message}`,
				);
			}
			// FLY-1099 §6: the 30min ledger-backed nudge layer, same cadence.
			try {
				await autoQaCoordinatorHolder.current?.reconcileCodexHoldNudges();
			} catch (err) {
				console.warn(
					`[auto-qa] reconcileCodexHoldNudges (poll) failed: ${(err as Error).message}`,
				);
			}
			if (accountSwitchRepair && unifiedAlertChannelId) {
				try {
					await accountSwitchWatchdogTick({
						now: () => Date.now(),
						executeSwitch: (pending) =>
							accountSwitchRepair.executeSwitch(pending),
						// FLY-929 A4+A5: shared switch-result routing (owner-bot
						// assignment on needs_human + notify digest on real success);
						// falls back to the legacy plain post if the shared helper was
						// somehow not built (defensive — same gate builds both).
						post:
							postSwitchResult ??
							((detail) =>
								alertDiscordOps.postToThread(unifiedAlertChannelId, detail)),
						// FLY-871 R3/W5: a deadline-fired switch → sweep incident-window
						// login-stuck sessions (same sweep the /api/account-switch route
						// triggers). Undefined rescueRuntime ⇒ no sweep (byte-compat).
						onSwitchSuccess: rescueRuntime
							? async () => {
									await rescueRuntime?.postSwitchRescueSweep();
								}
							: undefined,
					});
				} catch (err) {
					console.error(
						`[Bridge] FLY-696 account-switch watchdog tick failed: ${
							err instanceof Error ? err.message : String(err)
						}`,
					);
				}
			}
			// FLY-929 B2: notify-digest expectation check — the daily token
			// report must leave a delivery receipt by 01:00 (report tz) or ONE
			// deduped notify_digest_failed alert fires per expected day. The tick
			// itself is固化 default-on (FLY-1243; the check runs every tick;
			// "inactive", zero side effects). Same piggybacked poll — no timer.
			try {
				await notifyDigestExpectTick({
					now: new Date(),
					tz: process.env.TOKEN_USAGE_TIMEZONE ?? "America/Los_Angeles",
					receiptsPath: defaultReceiptsPath(),
					alert: (p) => leadAlertNotifier.alert(p),
				});
			} catch (err) {
				console.warn(
					`[Bridge] FLY-929 notify-digest expect tick failed: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			}
		},
		// FLY-193: default ON now that the idle-pane recognizer is validated
		// against committed real Lead pane fixtures (see
		// LeadWatchdog `__tests__/fixtures/lead-panes/`). The recognizer is
		// fail-open (only suppresses a high-confidence alive-idle pane; every
		// real freeze — resume/compact menu, frozen-mid-work — still alerts).
		// Escape hatch: set FLYWHEEL_PANE_IDLE_SUPPRESS=0 to force suppression OFF
		// and restore the legacy always-alert-on-stuck-pane behavior.
		suppressIdleHealthy: process.env.FLYWHEEL_PANE_IDLE_SUPPRESS !== "0",
		// FLY-1048 (A4): multi-frame overlay. FLY-1243: FLYWHEEL_PANE_MULTIFRAME
		// retired (固化 default-on) — the overlay is always on in production.
		multiFrame: true,
		// FLY-1048 (A5): fail-suspicious → quiet owner-Lead report (guardrail
		// lead_event; never an alert, never founder-facing). Shared deliverer +
		// owner resolver with the focused-frame unclear path.
		onSuspicious: deliverSuspicious,
	});
	leadWatchdog.start();
	console.log(
		"[Bridge] LeadWatchdog started (30s poll, pattern-first alert + 3-cycle pane-hash)",
	);

	// FLY-83: drain alert queue every 60s so spills from shell path (lead-alert.sh)
	// or prior Bridge runs do not rot. Queue files only appear when Discord POST
	// fails or env is missing, so this is usually a no-op.
	//
	// In-flight guard (leadAlertDraining) is load-bearing: drainQueue() bypasses
	// the claim check and only unlinks a queue file AFTER a successful POST. If
	// a drain stalls past the 60s interval (slow Discord), an overlapping drain
	// would re-POST the same still-present queue file → duplicate alert, which
	// breaks the "one alert per 10-min bucket" invariant. Skip when busy.
	// FLY-182 §4.5 / §3.1.4: connect Track A's mailbox-overflow markers to
	// alerting. A marker means a Lead's unread inbox crossed the threshold
	// (not consuming) — surface it via the Discord-independent channel.
	const checkMailboxOverflowMarkers = async (
		meta: MetaAlertNotifier,
	): Promise<void> => {
		try {
			const { getStateDir } = await import("flywheel-agent-team-transport");
			const { readdir, readFile } = await import("node:fs/promises");
			const { join: pjoin } = await import("node:path");
			const dir = pjoin(getStateDir(), "mailbox-overflow");
			let files: string[];
			try {
				files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
			} catch {
				return; // dir absent → nothing to report
			}
			if (files.length === 0) return;
			const leads: string[] = [];
			for (const f of files) {
				try {
					const m = JSON.parse(await readFile(pjoin(dir, f), "utf-8"));
					leads.push(`${m.team}/${m.recipient}(unread=${m.unread})`);
				} catch {
					/* skip unreadable marker */
				}
			}
			await meta.notify({
				reason: "mailbox_overflow",
				title: "Lead not consuming mailbox",
				body: `Unread mailbox overflow: ${leads.join(", ") || files.join(", ")}. A Lead may be stuck or not consuming its inbox.`,
			});
		} catch (err) {
			console.warn(
				`[Bridge] mailbox-overflow check failed: ${(err as Error).message}`,
			);
		}
	};

	// FLY-182 §4.5: self-monitoring thresholds (env-tunable). The watchdog must
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
			.then(async ({ sent, remaining, deadLettered, delivered }) => {
				if (sent > 0 || remaining > 0 || deadLettered > 0) {
					console.log(
						`[Bridge] LeadAlert drain sent=${sent} remaining=${remaining} deadLettered=${deadLettered}`,
					);
				}
				// FLY-927 (Codex R1 HIGH): a drained root must still get its per-error
				// thread + ticket lifecycle — otherwise every over-cap (rate-limited /
				// transient-retry) alert silently bypasses the Hub. Best-effort each.
				if (alertHub) {
					for (const d of delivered) {
						try {
							await alertHub.attachThreadForDelivered(
								d.payload,
								d.channelId,
								d.messageId,
							);
						} catch (err) {
							console.warn(
								`[Bridge] drained-thread attach failed: ${(err as Error).message}`,
							);
						}
					}
				}
				// Dead-letters happened → surface (Discord-independent).
				if (deadLettered > 0) {
					await metaAlertNotifier.notify({
						reason: "alert_dead_lettered",
						title: "LeadAlert dead-lettered alerts",
						body: `${deadLettered} alert(s) were dead-lettered during drain (remaining=${remaining}). Check ~/.flywheel/alert-deadletter and the Discord alert config.`,
					});
				}
				// No progress while items remain → drain is stuck.
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
				// Track A mailbox-overflow markers → a Lead is not consuming its inbox.
				await checkMailboxOverflowMarkers(metaAlertNotifier);
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
		heartbeatService?.stop();
		await publishBrokerHandle?.close(); // FLY-1062: socket + observe timer
		gatePoller.stop();
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
		bridgeWatchdog.stop();
		idleWatchdog.stop();
		leadWatchdog.stop();
		clearInterval(leadAlertDrainTimer);
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
		await registry.shutdownAll();
		broadcaster.destroy();
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
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
