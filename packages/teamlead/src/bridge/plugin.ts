import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
	existsSync as ffExistsSync,
	readFileSync as ffReadFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import express from "express";
// FLY-286 PR-2: web-local review route (gated on FLYWHEEL_XHS_REVIEW).
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
	resolveAllFlags,
	resolveCommBackend as resolveCommBackendShared,
} from "flywheel-config";
import {
	closeRunnerTerminalView,
	WORKFLOW_TRANSITIONS,
	WorkflowFSM,
} from "flywheel-core";
import type { CipherWriter, MemoryService } from "flywheel-edge-worker";
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
	findUnreachableAlertLeads,
	LeadAlertNotifier,
} from "../LeadAlertNotifier.js";
import { LeadWatchdog } from "../LeadWatchdog.js";
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
import { RunnerIdleWatchdog } from "../RunnerIdleWatchdog.js";
import { StateStore } from "../StateStore.js";
import { AlertChannelHub, createDiscordOps } from "./AlertChannelHub.js";
import { AutoRepairBot } from "./AutoRepairBot.js";
import { createActionRouter } from "./actions.js";
// FLY-368: unified alert channel + per-error threading + conservative auto-repair.
import {
	buildRepairChain,
	resolveFirstAvailableBotToken,
} from "./alert-bot-chain.js";
import { makeFounderReactionApprovalCallback } from "./approval-signal/founder-reaction-approval-factory.js";
import { makeFounderShipApprovalCallback } from "./approval-signal/founder-ship-approval-factory.js";
import { readCurrentGateMessageBinding } from "./approval-signal/gate-message-binding-store.js";
import { loadQaConfigByProject } from "./auto-qa-config-source.js";
import { AutoQaCoordinator } from "./auto-qa-coordinator.js";
import { AutoQaEffects } from "./auto-qa-effects.js";
import { resolveAutoQaPolicy } from "./auto-qa-policy.js";
import { BridgeEventLoopWatchdog } from "./BridgeEventLoopWatchdog.js";
import { ChatThreadCreator } from "./ChatThreadCreator.js";
import { CLOSE_ELIGIBLE_STATES, closeRunner } from "./close-runner.js";
import { reportCodexGlobalHealth } from "./codex-global-health.js";
import { reconcileCommDbRunningAgainstFsm } from "./commdb-fsm-reconcile.js";
import {
	deleteCommDbSession,
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
import { createDigestRouter } from "./digest-route.js";
import { DigestService } from "./digest-service.js";
import {
	parseSweepExcludeEnv,
	reconcileDoneButRunning,
} from "./done-running-reconciler.js";
import { archiveIssueThreadIfNoOtherActive } from "./done-thread-archiver.js";
import { EventFilter } from "./EventFilter.js";
import { createEventRouter } from "./event-route.js";
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
import {
	buildFounderConsentWiring,
	buildGateResponsePostWriteHook,
} from "./founder-consent/wiring.js";
import { loadFounderMilestoneReportConfigByProject } from "./founder-milestone-config-source.js";
import { mountFounderUxRoutes } from "./founder-ux/routes.js";
import { GatePoller } from "./gate-poller.js";
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
import { queryLinearIssues } from "./linear-query.js";
import { resolveLinearScope, resolveProjectNameParam } from "./linear-scope.js";
import { isSameOrigin as ffIsSameOrigin } from "./loopback-origin.js";
import { createMemoryRouter } from "./memory-route.js";
import { waitForPaneMarker } from "./pane-readiness.js";
import { PhaseOrchestrator } from "./phase-orchestrator.js";
import { postMergeTmuxCleanup } from "./post-merge.js";
import {
	buildCronModelViews,
	buildProjectRunnerDefaults,
} from "./project-runner-model-source.js";
import { createPublishHtmlRouter } from "./publish-html-route.js";
import {
	DEFAULT_RETENTION_MAX_AGE_MS,
	ReportRegistry,
} from "./report-registry.js";
import { createReportsRouter } from "./reports-route.js";
import type { IRetryDispatcher, IStartDispatcher } from "./retry-dispatcher.js";
import { RoundtableThreadManager } from "./roundtable/RoundtableThreadManager.js";
import { loadRoundtableConfig } from "./roundtable/roundtable-config.js";
import { buildTopicTrigger } from "./roundtable/topic-trigger.js";
import { setupRunInfrastructure } from "./run-infra.js";
import { attemptRunnerRecoveryNudge } from "./runner-recovery-nudge.js";
import {
	handleRunnerApply,
	handleRunnerStage,
	type RunnerCanonical,
	type RunnerRouteDeps,
} from "./runner-routes.js";
import { createStatusQuery } from "./runner-status.js";
import { createRunsRouter } from "./runs-route.js";
import { RuntimeRegistry } from "./runtime-registry.js";
import {
	captureSession as defaultCaptureSession,
	isCaptureError,
} from "./session-capture.js";
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
	hasPendingGateFromCommDb,
	idleWatchdogPollMs,
	probeQuietSignals,
	stuckCommActivityMs,
	stuckLatchTtlMs,
} from "./stuck-escalation.js";
import { createStuckRemanageRouter } from "./stuck-remanage-routes.js";
import type { StuckRunnerDetector } from "./stuck-runner-detector.js";
import { resolveTerminalViewIdentity } from "./terminal-view-identity.js";
import { loadPipelineConfigByProject } from "./three-stage-config-source.js";
import { resolveThreeStagePolicy } from "./three-stage-policy.js";
import {
	captureRunnerScrollback,
	getTmuxTargetFromCommDb,
	isTmuxWindowAlive,
	killCmuxLinkedSession,
	killTmuxWindow,
	lookupTmuxTarget,
	probeRunnerProcessLiveness,
	sendEnterToWindow,
	sendKeysToWindow,
} from "./tmux-lookup.js";
import { type CaptureSessionFn, createQueryRouter } from "./tools.js";
import { createTriageDataRouter } from "./triage-data-route.js";
import { createTriageTemplateRouter } from "./triage-template-route.js";
import { type BridgeConfig, sqliteDatetime } from "./types.js";
import {
	gitWorktreeClean,
	makeBridgeWorktreeCleanup,
} from "./worktree-cleanup.js";
import {
	createInMemoryTokenStore,
	handleGetReview,
	handlePostAction,
	type XhsReviewDeps,
} from "./xhs-review-routes.js";

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

	// FLY-109 cold-start hardening (Direction R): soft-wait for the Lead tmux pane
	// to print the MCP channel-handler marker before we declare readiness. Correctness
	// does NOT depend on this — the ack/retry state machine in inbox-mcp recovers any
	// push that fires before the handler is installed. We keep this as defense-in-
	// depth against a cold-start thundering herd where every queued push would hit
	// the retry window at once. Disabled by default; enable with
	// FLYWHEEL_LEAD_PANE_READINESS=1 once ops have validated the marker text.
	if (process.env.FLYWHEEL_LEAD_PANE_READINESS === "1") {
		const windowId = await lookupLeadWindowId(projectName, lead.agentId);
		if (windowId) {
			const timeoutMs = Number.parseInt(
				process.env.FLYWHEEL_LEAD_PANE_READINESS_TIMEOUT_MS ?? "20000",
				10,
			);
			const result = await waitForPaneMarker(
				windowId,
				"Listening for channel messages from:",
				Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20000,
			);
			if (result.seen) {
				console.log(
					`[Bridge] Lead "${lead.agentId}" pane ready after ${result.elapsedMs}ms`,
				);
			} else {
				console.warn(
					`[Bridge] Lead "${lead.agentId}" pane marker not seen within ${result.elapsedMs}ms — downgrading to lease-only readiness (ack/retry still covers correctness)`,
				);
			}
		}
	}

	const { CommDBLeadRuntime } = await import("./commdb-lead-runtime.js");
	return new CommDBLeadRuntime(commDbPath, lead.agentId);
}

/**
 * Resolve the tmux window ID for a Lead's Claude session.
 * Lead windows live in the shared `flywheel` session and are named `<project>-<lead>`.
 * Returns undefined if the session or window doesn't exist yet (cold start).
 */
async function lookupLeadWindowId(
	projectName: string,
	agentId: string,
): Promise<string | undefined> {
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const execFileAsync = promisify(execFile);
	const targetName = `${projectName}-${agentId}`;
	try {
		const { stdout } = await execFileAsync(
			"tmux",
			["list-windows", "-t", "flywheel", "-F", "#{window_name}:#{window_id}"],
			{ timeout: 5000 },
		);
		for (const line of stdout.split("\n")) {
			const sep = line.indexOf(":");
			if (sep <= 0) continue;
			const name = line.slice(0, sep);
			const id = line.slice(sep + 1);
			if (name === targetName && id.startsWith("@")) return id;
		}
	} catch {
		// tmux may be absent or the flywheel session may not exist yet — callers
		// treat undefined as "skip pane check, proceed with lease-only readiness".
	}
	return undefined;
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

function tokenAuthMiddleware(token?: string): express.RequestHandler {
	return (req, res, next) => {
		if (!token) return next();
		const header = req.headers.authorization ?? "";
		if (!safeCompare(header, `Bearer ${token}`)) {
			res.status(401).json({ error: "unauthorized" });
			return;
		}
		next();
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

	app.use(express.json({ limit: "512kb" }));

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
		res.json({
			// `ok` is byte-compatible (true in steady state); it flips false during
			// shutdown so the deploy health check + wrapper preflight treat a
			// draining Bridge as not-ready. `shuttingDown` is additive.
			ok: !shuttingDown,
			shuttingDown,
			uptime: process.uptime(),
			sessions_count: active.length,
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
		),
	);

	// FLY-603 Layer A: build the worktree-cleanup closure ONCE at the
	// composition root (hoisted high enough to reach both /events and the
	// DirectEventSink created later in setupRunInfrastructure).
	const removeCleanWorktree = makeBridgeWorktreeCleanup(store, projects);

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
		),
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
	// mirroring the Fleet console). Gated on FLYWHEEL_XHS_REVIEW=1; absent/0 →
	// routes are NOT registered at all (clean 404, byte-compat, no Bearer challenge).
	if (process.env.FLYWHEEL_XHS_REVIEW === "1") {
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

	// /api/* — api auth
	app.use(
		"/api",
		tokenAuthMiddleware(config.apiToken),
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
		tokenAuthMiddleware(config.apiToken),
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
				? tokenAuthMiddleware(config.apiToken)
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
				tokenAuthMiddleware(config.apiToken),
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
			tokenAuthMiddleware(config.apiToken),
			(req, res) => {
				void codexLeadOutbound(req, res);
			},
		);
	}

	app.post(
		"/api/sessions/:executionId/close-tmux",
		tokenAuthMiddleware(config.apiToken),
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
		tokenAuthMiddleware(config.apiToken),
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
			auth: tokenAuthMiddleware(config.apiToken),
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
		tokenAuthMiddleware(config.apiToken),
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
			tokenAuthMiddleware(config.apiToken),
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

	// Linear API proxy — agent doesn't hold LINEAR_API_KEY directly (GEO-187)
	app.post(
		"/api/linear/create-issue",
		tokenAuthMiddleware(config.apiToken),
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

				// FLY-371: scope label resolution (name → id), TEAM-SCOPED (Codex R1
				// HIGH-2). This is the only safety boundary between a label NAME and the
				// id that create forwards straight to Linear as labelIds.
				let labelIds: string[] | undefined = labels;
				const scopeLabelName = binding.binding?.label;
				if (scopeLabelName) {
					const matches = await client.issueLabels({
						first: 2,
						filter: {
							name: { eq: scopeLabelName },
							team: { id: { eq: targetTeam.id } },
						},
					});
					if (matches.nodes.length === 0) {
						res.status(404).json({
							error: `Scope label "${scopeLabelName}" not found in team "${targetTeam.key}"`,
						});
						return;
					}
					if (matches.nodes.length > 1) {
						res.status(400).json({
							error: `Scope label "${scopeLabelName}" is ambiguous in team "${targetTeam.key}" (multiple matches)`,
						});
						return;
					}
					const scopeLabelId = matches.nodes[0]!.id;
					const merged = Array.isArray(labels) ? [...labels] : [];
					if (!merged.includes(scopeLabelId)) merged.push(scopeLabelId);
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
		tokenAuthMiddleware(config.apiToken),
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
		tokenAuthMiddleware(config.apiToken),
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

	// FLY-21: Combined triage data endpoint — issues + sessions + capacity in one call
	app.use(
		"/api/triage/data",
		tokenAuthMiddleware(config.apiToken),
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
		tokenAuthMiddleware(config.apiToken),
		createTriageTemplateRouter(templatePath),
	);

	// Memory API (GEO-198/GEO-204) — conditional, only if memoryService initialized
	if (memoryService) {
		app.use(
			"/api/memory",
			tokenAuthMiddleware(config.apiToken),
			createMemoryRouter(memoryService, projects),
		);
	}

	// Discord guild ID endpoint (GEO-187) — agent can query to build Discord channel/thread links
	app.get(
		"/api/config/discord-guild-id",
		tokenAuthMiddleware(config.apiToken),
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
		tokenAuthMiddleware(config.apiToken),
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
					killCmuxLinkedSession: (w) => killCmuxLinkedSession(w),
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
					deleteCommDbSession: (execId, projectName) =>
						deleteCommDbSession(execId, projectName),
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
			app.use("/api/runs", tokenAuthMiddleware(config.apiToken), runsRouter);
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
				tokenAuthMiddleware(config.apiToken),
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
			tokenAuthMiddleware(config.apiToken),
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
		discordBotToken: opts?.globalBotToken,
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
			tokenAuthMiddleware(config.apiToken),
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
				tokenAuthMiddleware(config.apiToken),
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
			tokenAuthMiddleware(config.apiToken),
			createDeploymentsRouter(store),
		);
	} else {
		app.use("/api/deployments", (_req, res) => {
			res.status(503).json({
				error: "deployments API requires TEAMLEAD_API_TOKEN",
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

	const store = opts?.store ?? (await StateStore.create(config.dbPath));

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
	// GEO-158: FSM instance + DirectiveExecutor for validated transitions
	const fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);
	const executor = new DirectiveExecutor(store);
	const transitionOpts: ApplyTransitionOpts = { store, fsm, executor };
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
	const standupSenderLead = (standupProject?.leads ?? []).find(
		(l) => l.agentId !== standupLeadId && l.botToken,
	);
	const standupBotToken = standupSenderLead?.botToken ?? standupLead?.botToken;

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

	// FLY-793: late-bound three-stage PhaseOrchestrator holder — read by BOTH the
	// /events router (createBridgeApp) and the in-process DirectEventSink (via
	// setupRunInfrastructure). Built post-listen (it needs startDispatcher +
	// LeadAlertNotifier), so `.current` stays undefined until then = three-stage
	// dormant (byte-compatible).
	const phaseOrchestratorHolder: {
		current: PhaseOrchestrator | undefined;
	} = { current: undefined };

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
					removeCleanWorktree: makeBridgeWorktreeCleanup(store, projects),
					// FLY-579: the in-process completed path drives auto-QA + holds
					// the founder via this same holder.
					autoQaCoordinator: autoQaCoordinatorHolder,
					// FLY-793: the in-process completion path drives three-stage
					// Design→Implement→QA phase handoffs via this same holder.
					phaseOrchestrator: phaseOrchestratorHolder,
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
			chatThreadCreator,
			globalBotToken: config.discordBotToken,
			// FLY-253: holder filled after the detector is created post-listen.
			stuckDetectorHolder,
			stuckLatchTtlMs: stuckLatchTtlMs(),
			fleetConsole,
			// FLY-516: /health reads this; close() flips it at teardown start.
			shutdownStateHolder,
			// FLY-623: event router reads this to clear reconnecting on a real event.
			reconnectHolder,
			// FLY-579: event router reads this to drive the auto-QA pipeline.
			autoQaCoordinator: autoQaCoordinatorHolder,
			// FLY-793: event router reads this to drive three-stage phase handoffs.
			phaseOrchestrator: phaseOrchestratorHolder,
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
	// close, deleteCommDbSession, the shared archive predicate w/ allowStatuses).
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
		lookupTmuxTarget,
		probeLiveness: (w) => probeRunnerProcessLiveness(w),
		captureScrollback: (w) => captureRunnerScrollback(w),
		killCmuxLinkedSession: (w) => killCmuxLinkedSession(w),
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
		deleteCommDbSession: (execId, projectName) =>
			deleteCommDbSession(execId, projectName),
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
	// deleteCommDbSession on the close_runner / terminate / post-merge teardown
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
		void (async () => {
			for (const p of projects ?? []) {
				if (prunedProjects.has(p.projectName)) continue;
				prunedProjects.add(p.projectName);
				if (reconcileOn) {
					try {
						const r = await reconcileCommDbRunningAgainstFsm(
							p.projectName,
							(id) => store.getSession(id)?.status,
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
					const pruned = await pruneDeadTerminalCommDbSessions(p.projectName);
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
	try {
		await heartbeatService.seedReconnecting();
	} catch (err) {
		console.error(
			`[Bridge] FLY-623 reconnect boot-seed failed (non-fatal): ${(err as Error).message}`,
		);
	}

	heartbeatService.start();

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
	});
	const founderAutoApproveDenylist = new Set(
		(process.env.FLYWHEEL_FOUNDER_AUTO_APPROVE_DENYLIST ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
	const founderShipApprovalCallback = makeFounderShipApprovalCallback({
		discordOwnerUserId: config.discordOwnerUserId,
		founderConsentUserId: config.founderConsent?.founderUserId,
		store,
		denylistProjects: founderAutoApproveDenylist,
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

	// FLY-725: per-project founder milestone-report config, read from each
	// project's CANONICAL root (never a runner's PR worktree).
	const founderMilestoneReportByProject =
		await loadFounderMilestoneReportConfigByProject(projects);
	const gatePoller = new GatePoller({
		pollIntervalMs: 3_000,
		projects,
		store,
		runtimeRegistry: registry,
		leadAlertSink: {
			alert: (p) =>
				leadPendingAlertHolder.current
					? leadPendingAlertHolder.current.alert(p)
					: Promise.resolve({ skipped: "unknown-lead" } as AlertResult),
		},
		chatThreadsEnabled: config.chatThreadsEnabled,
		transport: misroutePatrolTransport,
		misrouteArchiveDir,
		// FLY-605: bidirectional in-thread founder relay fallback. owner/token
		// from config; the founder-reply cursor persists across restarts.
		discordBotToken: config.discordBotToken,
		discordOwnerUserId: config.discordOwnerUserId,
		// FLY-799: founder-in-thread ship approval (default-ON kill-switch inside
		// the factory). Absent (fcWiring null) → deliverer stays WAKE-only.
		tryFounderShipApproval: founderShipApprovalCallback,
		// FLY-799: founder ✅-reaction ship approval (per-gate reaction poll).
		tryFounderReactionApproval: founderReactionApprovalCallback,
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
	// loadRoundtableConfig returns undefined unless FLYWHEEL_ROUNDTABLE_ENABLED=1,
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
	const alertThreadsEnabled = process.env.FLYWHEEL_ALERT_THREADS === "1";
	const autoRepairEnabled = process.env.FLYWHEEL_AUTO_REPAIR === "1";
	const unifiedAlert = unifiedAlertChannelId
		? {
				channelId: unifiedAlertChannelId,
				repairBotTokenEnv: repairBotTokenEnvName,
			}
		: undefined;

	const leadAlertNotifier = new LeadAlertNotifier({
		store,
		projects,
		claimsReader,
		claimsClaimer,
		metaAlert: metaAlertNotifier,
		unifiedAlert,
		// FLY-529: QA Testing Room alert isolation. Unset env → both fields
		// undefined → notifier keeps its shared production defaults (byte-compat).
		// The test Bridge sets FLYWHEEL_ALERT_QUEUE_DIR / _DEADLETTER_DIR to slot-
		// local paths so test alerts never land in the production queue/dead-letter
		// dirs the live Bridge drainer reads.
		...resolveAlertDirsFromEnv(process.env),
	});

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
				leadAlertNotifier,
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
			phaseOrchestratorHolder.current = new PhaseOrchestrator({
				startDispatcher: phaseStartDispatcher,
				resolveThreeStage: (session) =>
					resolveThreeStagePolicy({
						pipelineConfig: pipelineConfigByProject.get(
							session.project_name ?? "",
						),
						issueLabels: parseJsonStringArray(
							store.getSession(session.execution_id)?.issue_labels,
						),
						env: process.env,
					}),
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
						if (worktree) {
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
						await leadAlertNotifier.alert({
							leadId,
							projectName,
							eventId: `three-stage-stuck:${session.execution_id}:${Date.now()}`,
							eventType: "three_stage_stuck",
							title: `Three-stage pipeline stuck — ${
								session.issue_identifier ?? session.issue_id
							}`,
							body: reason,
							severity: "warning",
						});
					},
				},
				// FLY-793 (Codex full-PR R2 #1): source stranded design_done sessions
				// for the startup reconcile (boot marker drain lands them before this
				// orchestrator is wired).
				listStrandedDesignPhases: () => store.getStrandedDesignPhaseSessions(),
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

	// FLY-368 rework: the repair chain (Cass → alphabetical fleet) drives thread
	// creation + ack/repair/resolve. Resolve it at boot for the enable gate; the
	// Hub re-resolves per call (env may change). Tokens never logged.
	const repairChainEnvs = buildRepairChain(projects, repairBotTokenEnvName);
	const repairChainResolves = !!resolveFirstAvailableBotToken(repairChainEnvs);
	const firstRepairBot = resolveFirstAvailableBotToken(repairChainEnvs);
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
	if (alertThreadsEnabled && !(unifiedAlertChannelId && repairChainResolves)) {
		console.error(
			"[Bridge] FLY-368: FLYWHEEL_ALERT_THREADS=1 but no usable unified channel + repair chain " +
				"(need FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID + at least one resolvable fleet bot token) — threading DISABLED.",
		);
		void metaAlertNotifier.notify({
			reason: "alert_unreachable_config",
			title: "FLY-368 alert threading misconfigured",
			body: "FLYWHEEL_ALERT_THREADS=1 but no unified channel / no resolvable repair-chain bot — per-error threads will NOT be created.",
		});
	}

	// FLY-368 rework: Hub on when unified channel + threading + a resolvable repair
	// chain; else watchdogs route straight to the notifier (legacy / root-only).
	const alertHub =
		unifiedAlert && alertThreadsEnabled && repairChainResolves
			? new AlertChannelHub({
					store,
					notifier: leadAlertNotifier,
					// Repair-chain DiscordOps: Cass → alphabetical, resolved per call.
					discord: createDiscordOps(() =>
						buildRepairChain(projects, repairBotTokenEnvName)
							.map((env) => process.env[env])
							.filter((t): t is string => !!t),
					),
					// FLY-368: conservative auto-repair, default OFF. Only the two safe
					// actions; reuses the audited runner-nudge + lead-resume-enter ops.
					autoRepairBot: autoRepairEnabled
						? new AutoRepairBot({
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
							})
						: undefined,
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
				})
			: undefined;
	if (alertHub) {
		console.log(
			`[Bridge] FLY-368 AlertChannelHub ON (unified channel=${unifiedAlertChannelId}, auto-repair=${autoRepairEnabled ? "ON" : "OFF"})`,
		);
	}

	// FLY-368: a single alert sink used by BOTH watchdogs. When the Hub is on it
	// adds threading + auto-repair; otherwise it's the raw notifier (byte-compat).
	const alertSink: { alert: (p: AlertPayload) => Promise<AlertResult> } =
		alertHub ? { alert: (p) => alertHub.handle(p) } : leadAlertNotifier;
	// FLY-637-ext: now that the shared alert sink exists, point the GatePoller's
	// late-bound lead-pending page-Annie holder at it (same routing as FLY-195 Q7).
	leadPendingAlertHolder.current = alertSink;

	// FLY-182 §4.1: surface any Lead whose alert channel/token cannot resolve
	// from config — the silent gap that broke alerting for 25 days. LOUD log +
	// one meta-alert (debounced) so it never goes unnoticed again.
	// FLY-368 rework: in unified mode a lead is unreachable only if the whole
	// fleet send-chain resolves nothing (per-lead noise removed).
	const unreachableAlertLeads = findUnreachableAlertLeads(projects, {
		channelId: unifiedAlertChannelId,
		repairBotTokenEnv: repairBotTokenEnvName,
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
		notifier: alertSink,
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
	});
	idleWatchdog.start();
	console.log(
		`[Bridge] RunnerIdleWatchdog started (${Math.round(idlePollMs / 1000)}s poll${stuckDetector ? ", FLY-195 stuck detection ON" : ", FLY-195 stuck detection OFF (FLYWHEEL_STUCK_DETECT=0)"})`,
	);

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
		notifier: (payload) => alertSink.alert(payload),
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
		// FLY-368: piggyback the 30s poll to run the reconcile pass (no new timer).
		onPollComplete: alertHub ? () => alertHub.reconcile() : undefined,
		// FLY-193: default ON now that the idle-pane recognizer is validated
		// against committed real Lead pane fixtures (see
		// LeadWatchdog `__tests__/fixtures/lead-panes/`). The recognizer is
		// fail-open (only suppresses a high-confidence alive-idle pane; every
		// real freeze — resume/compact menu, frozen-mid-work — still alerts).
		// Escape hatch: set FLYWHEEL_PANE_IDLE_SUPPRESS=0 to force suppression OFF
		// and restore the legacy always-alert-on-stuck-pane behavior.
		suppressIdleHealthy: process.env.FLYWHEEL_PANE_IDLE_SUPPRESS !== "0",
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
			.then(async ({ sent, remaining, deadLettered }) => {
				if (sent > 0 || remaining > 0 || deadLettered > 0) {
					console.log(
						`[Bridge] LeadAlert drain sent=${sent} remaining=${remaining} deadLettered=${deadLettered}`,
					);
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
		heartbeatService?.stop();
		gatePoller.stop();
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
		await registry.shutdownAll();
		broadcaster.destroy();
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
	};

	return { app, store, close, registry };
}
