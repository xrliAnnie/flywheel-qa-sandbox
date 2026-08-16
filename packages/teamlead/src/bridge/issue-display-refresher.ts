/**
 * FLY-907 Step 2/3/4: the unified issue-display refresher.
 *
 * ONE derive-from-real-state render path for the three founder-facing display
 * faces of a `[FLY-XX]` thread — A title badge, B pinned pipeline header,
 * C DAG workflow status line — triggered from EVERY lifecycle change source
 * (applyTransition hook, DirectEventSink, park/wake, stage_changed,
 * qa_result/finalize, recovered-merge finalization, GatePoller sweep) instead
 * of only `stage_changed` (the FLY-902 Finding #4 root cause: FLY-887's
 * park/wake lifecycle never fires stage_changed, so all three faces froze).
 *
 * Rendering reuses the existing writers (title coalescing writer, pin state
 * machine, status-line post-or-edit) via their FLY-907 result-returning
 * variants; per-issue coalesce-to-latest keeps Discord traffic flat under
 * trigger bursts. This file also hosts the moved-verbatim legacy
 * `stage_changed` renderers (`stampStageEmojiForSession` /
 * `pinRunnerAttachForSession`) as the fallback when the unified refresher is
 * unavailable (event-route
 * keeps thin forwards), now with the Step-3 attach cross-wire guard.
 */

import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import {
	isWorkflowPhaseRole,
	modelDisplayName,
	PHASE_ROLE_SEQUENCE,
	PHASE_THREAD_BADGE,
	phaseMessageTag,
	phaseThreadBadge,
	type WorkflowPhaseRole,
} from "flywheel-config";
import {
	type ProjectEntry,
	resolveAnnouncerBotToken,
	resolveLeadForIssue,
} from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";
import { parseWorkflowRunSnapshot } from "../workflow-run-snapshot.js";
import { isQaHeld } from "./auto-qa-held.js";
import {
	buildPipelineHeaderContent,
	type ChatThreadContext,
	type ChatThreadCreator,
	type PhaseHeaderRow,
} from "./ChatThreadCreator.js";
import { commDbPathForProject } from "./commdb-path.js";
import { deleteDiscordMessageInChannel } from "./discord-utils.js";
import {
	type DisplayWriteResult,
	deriveIssueTitleBadge,
	derivePhaseDisplayState,
	type ParkProbe,
	type PhaseDisplayState,
} from "./issue-display.js";
import { sessionModelDisplay } from "./runner-model-display.js";
import { BLOCKED_EMOJI, BLOCKED_WORD } from "./stage-utils.js";
import {
	type AttachTarget,
	buildAttachCommand,
	getTmuxTargetFromCommDb,
	resolveCmuxAttachTarget,
	type TmuxTarget,
} from "./tmux-lookup.js";
import type { BridgeConfig } from "./types.js";

/** The late-bound holder shape every trigger surface reads at fire time. */
export type IssueDisplayRefreshFn = (issueId: string) => void;

/** Minimal surface trigger sites depend on (enqueue = fire-and-forget;
 *  refresh = awaited drain, for finalization paths that must land BEFORE a
 *  thread archive). */
export type IssueDisplayRefreshHandle = {
	enqueue(issueId: string): void;
	refresh(issueId: string): Promise<void>;
	/** The GatePoller-tick reconcile sweep (present on the real refresher). */
	runSweep?(): Promise<void>;
};

/** Forward-reference holder (same pattern as phaseStatusLineRefreshHolder):
 *  populated post-listen; `current` undefined = triggers dormant. */
export type IssueDisplayRefreshHolder = {
	current?: IssueDisplayRefreshHandle;
};

/** Parse the JSON-encoded `issue_labels` column into a string[] (tolerant). */
export function parseIssueLabels(raw: string | undefined): string[] {
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

/** Read the Bridge-owned route visibility payload from session_params. */
export function parseWorkflowRouteSummary(
	raw: string | undefined,
): string | undefined {
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as {
			workflowRoute?: { summary?: unknown };
		};
		return typeof parsed.workflowRoute?.summary === "string" &&
			parsed.workflowRoute.summary.trim().length > 0
			? parsed.workflowRoute.summary
			: undefined;
	} catch {
		return undefined;
	}
}

function plannedPhaseModels(
	store: StateStore,
	issueId: string,
): Map<WorkflowPhaseRole, { model: string; display: string }> {
	const run = store.getActiveWorkflowRunForIssue(issueId);
	if (!run?.snapshot) return new Map();
	try {
		const snapshot = parseWorkflowRunSnapshot(run.snapshot);
		const planned = new Map<
			WorkflowPhaseRole,
			{ model: string; display: string }
		>();
		for (const node of snapshot.resolved.nodes) {
			if (!isWorkflowPhaseRole(node.type) || !node.dispatch?.model) continue;
			const display = modelDisplayName(node.dispatch.model);
			if (display) {
				planned.set(node.type, { model: node.dispatch.model, display });
			}
		}
		return planned;
	} catch {
		return new Map();
	}
}

/** FLY-560: issue status badges always include their short status word. */
export function issueStatusWordEnabled(): boolean {
	return true;
}

/**
 * FLY-907 (Step 3): does the resolved tmux window belong to this issue? The
 * window-name anchor is `buildWindowLabel` = `<identifier>-<runner>-<title>`
 * (core/tmux-naming.ts, FLY-272 identifier-first). Identifier or windowName
 * missing → no anchor to verify → treat as belonging (no new false kills).
 */
export function attachTargetMatchesIssue(
	issueIdentifier: string | undefined,
	windowName: string | undefined,
): boolean {
	if (!issueIdentifier || !windowName) return true;
	return windowName.startsWith(`${issueIdentifier}-`);
}

function warnAttachCrossWire(
	executionId: string,
	issueIdentifier: string | undefined,
	windowName: string | undefined,
): void {
	// Loud, structured — this is the FLY-923 registration-side evidence trail.
	console.warn(
		`[issue-display] attach cross-wire for exec ${executionId}: expected window prefix "${issueIdentifier}-", actual window_name "${windowName}" — withholding attach command (FLY-923 evidence)`,
	);
}

interface StampDeps {
	store: StateStore;
	projects: ProjectEntry[];
	config: BridgeConfig;
	chatThreadCreator: ChatThreadCreator;
}

/**
 * FLY-560 Feature A (moved verbatim from event-route.ts for FLY-907): the
 * legacy stage_changed title stamp — badge = the REPORTED stage (or the
 * reporting session's phase badge on a DAG workflow issue). This remains the
 * fallback when the unified refresher is unavailable. Fire-and-forget.
 */
export function stampStageEmojiForSession(
	deps: StampDeps,
	session: Session,
	stage: string,
): void {
	let chatChannel: string | undefined;
	let botToken: string | undefined;
	let leadId: string | undefined;
	try {
		const { lead } = resolveLeadForIssue(
			deps.projects,
			session.project_name,
			parseIssueLabels(session.issue_labels),
		);
		chatChannel = lead.chatChannel;
		botToken = lead.botToken ?? deps.config.discordBotToken;
		leadId = lead.agentId;
	} catch {
		return; // project/lead not resolvable — skip
	}
	if (!chatChannel || !botToken) return;

	const thread = deps.store.getChatThreadByIssue(session.issue_id, chatChannel);
	if (!thread) return; // thread not created yet — a later stage_changed catches it
	if (thread.archived_at) return; // archived issue threads stay silent

	// FLY-892 (Step 6): on a DAG workflow issue the title prefix is the STAGE-level
	// phase badge (🎨设计/🔨实现/🧪QA) of the reporting session's phase, which
	// REPLACES the FLY-560 fine-grained stage word. `""` for a non-phase (main)
	// session → falls back to the FLY-560 stage badge (byte-compat).
	const phaseBadge = phaseThreadBadge(session.chat_thread_role) || undefined;

	void deps.chatThreadCreator
		.stampStageEmoji(
			{
				chatChannelId: chatChannel,
				issueId: session.issue_id,
				issueIdentifier: session.issue_identifier,
				issueTitle: session.issue_title,
				botToken,
				leadId,
				// FLY-1255: derive the title marker from the actual runner model,
				// falling back to the planned phase dispatch when needed.
				modelMarker: sessionModelDisplay(session)?.threadMarker ?? null,
			},
			thread.thread_id,
			stage,
			issueStatusWordEnabled(),
			phaseBadge,
		)
		.catch((err: unknown) => {
			console.warn(
				`[issue-display] stage-emoji stamp failed for ${session.execution_id}:`,
				err instanceof Error ? err.message : err,
			);
		});
}

/**
 * FLY-560 Feature C + FLY-892 Step 4 (moved verbatim from event-route.ts for
 * FLY-907, + the Step-3 attach cross-wire guard): the legacy stage_changed pin
 * fallback when the unified refresher is unavailable.
 * Fire-and-forget; the whole chain (incl. sync CommDB reads) runs past a real
 * async boundary (CommDB busy_timeout must never stall the caller).
 */
export function pinRunnerAttachForSession(
	deps: StampDeps,
	session: Session,
): void {
	let chatChannel: string | undefined;
	let botToken: string | undefined;
	let leadId: string | undefined;
	try {
		const { lead } = resolveLeadForIssue(
			deps.projects,
			session.project_name,
			parseIssueLabels(session.issue_labels),
		);
		chatChannel = lead.chatChannel;
		botToken = lead.botToken ?? deps.config.discordBotToken;
		leadId = lead.agentId;
	} catch {
		return; // project/lead not resolvable — skip
	}
	if (!chatChannel || !botToken) return;

	const thread = deps.store.getChatThreadByIssue(session.issue_id, chatChannel);
	if (!thread) return; // thread not created yet — a later stage_changed catches it
	if (thread.archived_at) return; // archived issue threads stay silent

	const resolvedChannel = chatChannel;
	const resolvedToken = botToken;
	const threadId = thread.thread_id;
	const ctx = {
		chatChannelId: resolvedChannel,
		issueId: session.issue_id,
		issueIdentifier: session.issue_identifier,
		issueTitle: session.issue_title,
		botToken: resolvedToken,
		leadId,
		routeSummary: parseWorkflowRouteSummary(session.session_params),
	};
	const headerBotToken =
		resolveAnnouncerBotToken(deps.projects, session.project_name) ??
		resolvedToken;
	const headerCtx = { ...ctx, botToken: headerBotToken };
	// Codex code R1 MED-1 / R2 (FLY-892): the CommDB reads must NOT run on the
	// caller's stack — push the ENTIRE chain past a real async boundary.
	void Promise.resolve()
		.then(async () => {
			const phaseSessions = deps.store.getLatestPhaseSessionsForIssue(
				session.issue_id,
			);
			if (phaseSessions.length === 0) {
				const target = getTmuxTargetFromCommDb(
					session.execution_id,
					session.project_name,
				);
				if (!target) return; // tmux_window not registered yet — next stage reconciles
				const attach = await resolveCmuxAttachTarget(target.tmuxWindow);
				// FLY-907 (Step 3): never render a link into another issue's window.
				if (
					!attachTargetMatchesIssue(session.issue_identifier, attach.windowName)
				) {
					warnAttachCrossWire(
						session.execution_id,
						session.issue_identifier,
						attach.windowName,
					);
					await deps.chatThreadCreator.ensureRunnerAttachUnresolvedResult(
						ctx,
						threadId,
					);
					return;
				}
				await deps.chatThreadCreator.ensureRunnerAttachPin(
					ctx,
					threadId,
					buildAttachCommand(attach),
				);
				return;
			}

			const byRole = new Map(phaseSessions.map((s) => [s.chat_thread_role, s]));
			const plannedByRole = plannedPhaseModels(deps.store, session.issue_id);
			const rows: PhaseHeaderRow[] = [];
			for (const role of PHASE_ROLE_SEQUENCE) {
				const ps = byRole.get(role);
				if (!ps) {
					const planned = plannedByRole.get(role);
					rows.push({
						label: phaseMessageTag(role, planned?.model, undefined).trim(),
						status: "pending",
						...(planned ? { plannedModel: planned.display } : {}),
					});
					continue;
				}
				// Legacy path: the pre-FLY-907 HEADER_DONE_STATUSES semantics.
				const status: PhaseHeaderRow["status"] =
					LEGACY_HEADER_DONE_STATUSES.has(ps.status) ? "done" : "active";
				const row: PhaseHeaderRow = {
					label: phaseMessageTag(
						role,
						ps.runner_model,
						ps.design_backend,
					).trim(),
					status,
					execId: ps.execution_id.slice(0, 8),
				};
				const target = getTmuxTargetFromCommDb(
					ps.execution_id,
					ps.project_name,
				);
				if (target) {
					const attach = await resolveCmuxAttachTarget(target.tmuxWindow);
					// FLY-907 (Step 3): identifier-prefix guard on every header row.
					if (
						!attachTargetMatchesIssue(ps.issue_identifier, attach.windowName)
					) {
						warnAttachCrossWire(
							ps.execution_id,
							ps.issue_identifier,
							attach.windowName,
						);
						row.attachUnresolved = true;
					} else {
						row.attachCommand = buildAttachCommand(attach);
					}
				} else if (status === "done") {
					// pre-FLY-887: a finished phase's session is closed → no target.
					row.sessionEnded = true;
				}
				rows.push(row);
			}
			const content = buildPipelineHeaderContent(headerCtx, rows);
			await deps.chatThreadCreator.ensureRunnerPipelineHeaderPin(
				headerCtx,
				threadId,
				content,
			);
		})
		.catch((err: unknown) => {
			console.warn(
				`[issue-display] attach-pin failed for ${session.execution_id}:`,
				err instanceof Error ? err.message : err,
			);
		});
}

/**
 * FLY-892 (Step 4) — the legacy header-local done set for the fallback path
 * above. The unified
 * refresher derives through `derivePhaseDisplayState` instead.
 */
const LEGACY_HEADER_DONE_STATUSES: ReadonlySet<string> = new Set([
	"completed",
	"failed",
	"blocked",
	"merged",
	"design_done",
]);

type IssueConclusionStore = Pick<
	StateStore,
	"hasFinalizationCompletedForIssue" | "hasMergeConfirmedForIssue"
>;

/**
 * FLY-1709: `terminated` is concluded cleanup only when the issue has durable
 * ship evidence. A historical completed session is not sufficient: generalized
 * DAGs can leave several main-role rows on one issue, and a later abandoned node
 * must not inherit an earlier node's success.
 */
export function hasDurableIssueConclusion(
	store: IssueConclusionStore,
	issueId: string,
): boolean {
	return (
		store.hasFinalizationCompletedForIssue(issueId) ||
		store.hasMergeConfirmedForIssue(issueId)
	);
}

/**
 * FLY-907 sweep layer-1 fast hash input: the sessions-table component of the
 * display fingerprint — per-role latest {role, status, exec} + the issue's
 * latest session {status, session_stage, exec} + the DAG workflow issue's
 * post-ship finalization-claim bit. Cheap (StateStore only, zero CommDB), and
 * computed IDENTICALLY by the refresher's fingerprint writer so layer-1
 * comparison is exact.
 */
export function computeSessionsFingerprint(
	store: Pick<
		StateStore,
		| "hasFinalizationCompletedForIssue"
		| "hasMergeConfirmedForIssue"
		| "getLatestPhaseSessionsForIssue"
		| "getSessionByIssue"
	>,
	issueId: string,
): string {
	const phases = store.getLatestPhaseSessionsForIssue(issueId).map((s) => ({
		r: s.chat_thread_role ?? "",
		st: s.status,
		e: s.execution_id,
	}));
	const main = store.getSessionByIssue(issueId);
	const issueConcluded = hasDurableIssueConclusion(store, issueId);
	return JSON.stringify({
		p: phases,
		// `getLatestPhaseSessionsForIssue` only returns design/implement/qa rows,
		// so a non-empty result is the same DAG workflow guard used by derivation.
		// Single-session issues retain the pre-FLY-1225 zero-query path.
		fc: phases.length > 0 && store.hasFinalizationCompletedForIssue(issueId),
		cc: issueConcluded,
		m: main
			? { st: main.status, sg: main.session_stage ?? "", e: main.execution_id }
			: null,
	});
}

interface DisplayFingerprint {
	/** sessions component (layer-1 comparable). */
	s: string;
	/** CommDB-derived component (park probes + tmux resolution). */
	c: string;
}

function parseFingerprint(raw: string | null): DisplayFingerprint | undefined {
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as Partial<DisplayFingerprint>;
		if (typeof parsed.s === "string" && typeof parsed.c === "string") {
			return parsed as DisplayFingerprint;
		}
	} catch {
		/* malformed → treat as absent */
	}
	return undefined;
}

export interface IssueDisplayRefresherDeps {
	store: StateStore;
	projects: ProjectEntry[];
	config: BridgeConfig;
	chatThreadCreator: ChatThreadCreator;
	flags: {
		issueStatusEmojiEnabled: boolean;
		issueAttachPinEnabled: boolean;
	};
	/**
	 * FLY-887 keep-alive project switch. OFF → every park probe is "unknown"
	 * (status-table-only derivation, byte-safe degradation for non-keep-alive
	 * projects whose design_done rows have no park marker by design).
	 */
	keepAliveEnabled: () => boolean;
	/**
	 * FLY-623 interaction guard: while a session is detached-but-alive after a
	 * Bridge restart, HeartbeatService owns the "⚠️重连中" title — a derived
	 * stamp would clear it prematurely. Face A defers while the title episode is active.
	 */
	isReconnectTitleActive?: (execId: string) => boolean;
	// ── test seams (default to the real implementations) ──
	readParkProbe?: (projectName: string, execId: string) => ParkProbe;
	getTmuxTarget?: (
		execId: string,
		projectName: string,
	) => TmuxTarget | undefined;
	resolveAttach?: (tmuxWindow: string) => Promise<AttachTarget>;
	/**
	 * Lead directive 17ab4f53 cleanup seam: delete a legacy scattered
	 * status-line message (defaults to the real Discord DELETE).
	 */
	deleteMessage?: (
		threadId: string,
		messageId: string,
		botToken: string,
	) => Promise<{ ok: boolean; status?: number; error?: string }>;
	now?: () => number;
	sweepLimits?: { candidates?: number; active?: number };
}

interface RefreshQueueState {
	rerun: boolean;
	done: Promise<void>;
}

/**
 * The unified refresher. `enqueue` is what every trigger surface calls
 * (fire-and-forget, never throws into the trigger); `refresh` awaits the
 * coalesced drain (used by finalization paths that must complete BEFORE a
 * thread archive); `runSweep` is the GatePoller-tick reconcile backstop.
 */
export class IssueDisplayRefresher {
	private queue = new Map<string, RefreshQueueState>();
	/** Sweep layer-1 keyset cursor (restarts at top when a page comes up short). */
	private candidateCursor: { la: string; issueId: string } | null = null;
	/** Sweep layer-2 rotation cursor. */
	private activeCursor: string | null = null;

	constructor(private deps: IssueDisplayRefresherDeps) {}

	/** Fire-and-forget trigger entry — safe to call from any lifecycle hook. */
	enqueue(issueId: string): void {
		void this.refresh(issueId).catch((err: unknown) => {
			console.warn(
				`[issue-display] refresh failed for ${issueId}:`,
				err instanceof Error ? err.message : err,
			);
		});
	}

	/**
	 * Per-issue coalesce-to-latest (mirrors ChatThreadCreator.titleWriters): a
	 * refresh already in flight absorbs new triggers by re-running once more
	 * after it finishes — intermediate states collapse, the latest wins.
	 */
	refresh(issueId: string): Promise<void> {
		const existing = this.queue.get(issueId);
		if (existing) {
			existing.rerun = true;
			return existing.done;
		}
		const state: RefreshQueueState = { rerun: false, done: Promise.resolve() };
		state.done = (async () => {
			try {
				do {
					state.rerun = false;
					await this.refreshOnce(issueId);
				} while (state.rerun);
			} finally {
				this.queue.delete(issueId);
			}
		})();
		this.queue.set(issueId, state);
		return state.done;
	}

	/**
	 * FLY-907 (Step 4.5): the GatePoller-tick reconcile sweep — the self-heal
	 * backstop for missed triggers, Bridge restarts, and Bridge-invisible
	 * CommDB-only drift. Two layers (Codex R1 #3 + R2 #1); both keyset-cursored
	 * so LIMITs never create a permanent blind spot.
	 */
	async runSweep(): Promise<void> {
		const { store } = this.deps;
		const candLimit = this.deps.sweepLimits?.candidates ?? 50;
		const activeLimit = this.deps.sweepLimits?.active ?? 10;

		// Layer 1 — cheap sessions-only comparison against the stored
		// fingerprint's sessions component; includes TERMINAL issues so a stale
		// face on a crashed finalization is not invisible.
		const candidates = store.listDisplayReconcileCandidates(
			this.candidateCursor,
			candLimit,
		);
		this.candidateCursor =
			candidates.length < candLimit
				? null
				: {
						la: candidates[candidates.length - 1]!.la,
						issueId: candidates[candidates.length - 1]!.issue_id,
					};
		for (const cand of candidates) {
			const stored = parseFingerprint(cand.display_fingerprint);
			const current = computeSessionsFingerprint(store, cand.issue_id);
			if (!stored || stored.s !== current) this.enqueue(cand.issue_id);
		}

		// Layer 2 — unconditional rotating refresh of non-terminal issues (the
		// refresher re-reads CommDB; zero-churn writers make a no-drift pass free
		// of Discord requests). Terminal issues have no CommDB drift of display
		// significance, so they are out of this layer's domain.
		const active = store.listDisplaySweepActiveIssues(
			this.activeCursor,
			activeLimit,
		);
		this.activeCursor =
			active.length < activeLimit ? null : active[active.length - 1]!.issue_id;
		for (const row of active) this.enqueue(row.issue_id);
	}

	// ── derivation + render ──

	private readParkProbe(projectName: string, execId: string): ParkProbe {
		if (this.deps.readParkProbe) {
			return this.deps.readParkProbe(projectName, execId);
		}
		// Keep-alive OFF → park markers are not part of this project's lifecycle
		// → "unknown" (status-table-only derivation, plan 1a).
		if (!this.deps.keepAliveEnabled()) return "unknown";
		const dbPath = commDbPathForProject(projectName);
		if (!existsSync(dbPath)) return "unknown";
		let db: InstanceType<typeof Database> | undefined;
		try {
			db = new Database(dbPath, { readonly: true, fileMustExist: true });
			db.pragma("busy_timeout = 5000");
			const row = db
				.prepare(
					"SELECT kind, expires_at FROM runner_declared_states WHERE execution_id = ?",
				)
				.get(execId) as
				| { kind?: string; expires_at?: number | null }
				| undefined;
			if (!row || row.kind !== "parked") return "not_parked";
			const now = this.deps.now?.() ?? Date.now();
			if (row.expires_at != null && row.expires_at <= now) return "not_parked";
			return "parked";
		} catch {
			// missing table / locked / corrupt — could NOT probe. NEVER read this
			// as "was woken" (Codex R1 #2).
			return "unknown";
		} finally {
			db?.close();
		}
	}

	private async refreshOnce(issueId: string): Promise<void> {
		// The CommDB reads below are sync (busy_timeout=5s) — keep the entire
		// derivation past a real async boundary so no trigger's call stack can
		// stall on a locked comm.db (event-route.ts FLY-892 discipline).
		await Promise.resolve();

		const { store, projects, config, chatThreadCreator, flags } = this.deps;
		const anySession = store.getSessionByIssue(issueId);
		if (!anySession) return;

		let chatChannel: string | undefined;
		let botToken: string | undefined;
		let leadId: string | undefined;
		try {
			const { lead } = resolveLeadForIssue(
				projects,
				anySession.project_name,
				parseIssueLabels(anySession.issue_labels),
			);
			chatChannel = lead.chatChannel;
			botToken = lead.botToken ?? config.discordBotToken;
			leadId = lead.agentId;
		} catch {
			return; // project/lead not resolvable — skip
		}
		if (!chatChannel || !botToken) return;
		const thread = store.getChatThreadByIssue(issueId, chatChannel);
		if (!thread) return; // no thread → nothing to render (and no fingerprint home)
		const threadId = thread.thread_id;
		if (thread.archived_at) {
			const fingerprint: DisplayFingerprint = {
				s: computeSessionsFingerprint(store, issueId),
				c: JSON.stringify({ archived: true }),
			};
			store.setChatThreadDisplayFingerprint(
				issueId,
				chatChannel,
				JSON.stringify(fingerprint),
				new Date().toISOString(),
			);
			return;
		}

		const latestPhase = store.getLatestPhaseSessionsForIssue(issueId);
		const isWorkflowPhase = latestPhase.length > 0;
		const issueConcluded = hasDurableIssueConclusion(store, issueId);

		// Park probes — once per involved exec (the map dedupes).
		const parkByExec = new Map<string, ParkProbe>();
		const parkFor = (s: Session): ParkProbe => {
			const hit = parkByExec.get(s.execution_id);
			if (hit) return hit;
			const probe = this.readParkProbe(s.project_name, s.execution_id);
			parkByExec.set(s.execution_id, probe);
			return probe;
		};

		// Unified per-phase states (face A aggregation + face B rows).
		const phaseStates = new Map<WorkflowPhaseRole, PhaseDisplayState>();
		const phaseStatuses = new Map<WorkflowPhaseRole, string>();
		const phaseSessionByRole = new Map<WorkflowPhaseRole, Session>();
		for (const s of latestPhase) {
			const role = s.chat_thread_role as WorkflowPhaseRole;
			phaseSessionByRole.set(role, s);
			phaseStatuses.set(role, s.status);
			phaseStates.set(
				role,
				derivePhaseDisplayState({
					role,
					status: s.status,
					park: parkFor(s),
					issueConcluded,
				}),
			);
		}
		const shipFinalizationClaimed =
			isWorkflowPhase && store.hasFinalizationCompletedForIssue(issueId);

		// ── Face A: title badge ──
		let badge = deriveIssueTitleBadge({
			phaseStates,
			phaseStatuses,
			shipFinalizationClaimed,
			mainSessionStage: anySession.session_stage,
			mainSessionStatus: anySession.status,
			issueConcluded,
		});
		// FLY-579/827 interaction (feedback: founder status must be QA-gated): a
		// single-session issue whose independent auto-QA is in flight shows 🧪QA
		// — the QA runs on a SEPARATE QA·FLY-XX issue, so it is not derivable
		// from this issue's session rows.
		if (
			badge.kind === "stage" &&
			!isWorkflowPhase &&
			isQaHeld(store, anySession)
		) {
			badge = { kind: "stage", stage: "test" };
		}

		const withWord = issueStatusWordEnabled();
		const badgeSession =
			badge.kind === "phase"
				? (phaseSessionByRole.get(badge.phase) ?? anySession)
				: anySession;
		const titleCtx: ChatThreadContext = {
			chatChannelId: chatChannel,
			issueId,
			issueIdentifier: anySession.issue_identifier,
			issueTitle: anySession.issue_title,
			botToken,
			leadId,
			modelMarker: sessionModelDisplay(badgeSession)?.threadMarker ?? null,
			routeSummary: parseWorkflowRouteSummary(anySession.session_params),
		};

		let resultA: DisplayWriteResult = "noop";
		if (flags.issueStatusEmojiEnabled) {
			if (this.deps.isReconnectTitleActive?.(badgeSession.execution_id)) {
				// HeartbeatService owns the ⚠️重连中 title right now — defer (no
				// fingerprint) so a later refresh reconciles after reconnect ends.
				resultA = "deferred";
			} else if (badge.kind === "blocked") {
				resultA = await chatThreadCreator.stampStatusBadgeResult(
					titleCtx,
					threadId,
					withWord ? `${BLOCKED_EMOJI}${BLOCKED_WORD}` : BLOCKED_EMOJI,
				);
			} else if (badge.kind === "completed") {
				resultA = await chatThreadCreator.stampStageEmojiResult(
					titleCtx,
					threadId,
					"completed",
					withWord,
				);
			} else if (badge.kind === "phase") {
				resultA = await chatThreadCreator.stampStageEmojiResult(
					titleCtx,
					threadId,
					"",
					withWord,
					PHASE_THREAD_BADGE[badge.phase],
				);
			} else if (badge.stage) {
				resultA = await chatThreadCreator.stampStageEmojiResult(
					titleCtx,
					threadId,
					badge.stage,
					withWord,
				);
			}
		}

		// ── Face B: pinned pipeline header / single-runner attach pin ──
		const commComponent: Record<string, unknown> = {};
		let resultB: DisplayWriteResult = "noop";
		if (flags.issueAttachPinEnabled) {
			const headerBotToken =
				resolveAnnouncerBotToken(projects, anySession.project_name) ?? botToken;
			if (isWorkflowPhase) {
				const plannedByRole = plannedPhaseModels(store, issueId);
				const rows: PhaseHeaderRow[] = [];
				for (const role of PHASE_ROLE_SEQUENCE) {
					const ps = phaseSessionByRole.get(role);
					const state = phaseStates.get(role) ?? "pending";
					if (!ps || state === "pending") {
						const planned = plannedByRole.get(role);
						rows.push({
							label: phaseMessageTag(
								role,
								ps?.runner_model ?? planned?.model,
								ps?.design_backend,
							).trim(),
							status: "pending",
							...(planned ? { plannedModel: planned.display } : {}),
						});
						continue;
					}
					const row: PhaseHeaderRow = {
						label: phaseMessageTag(
							role,
							ps.runner_model,
							ps.design_backend,
						).trim(),
						status: state,
						execId: ps.execution_id.slice(0, 8),
					};
					const target = (this.deps.getTmuxTarget ?? getTmuxTargetFromCommDb)(
						ps.execution_id,
						ps.project_name,
					);
					if (target) {
						const attach = await (
							this.deps.resolveAttach ?? resolveCmuxAttachTarget
						)(target.tmuxWindow);
						const matches = attachTargetMatchesIssue(
							ps.issue_identifier,
							attach.windowName,
						);
						commComponent[ps.execution_id] = {
							w: target.tmuxWindow,
							n: attach.windowName ?? null,
							ok: matches,
						};
						if (!matches) {
							warnAttachCrossWire(
								ps.execution_id,
								ps.issue_identifier,
								attach.windowName,
							);
							row.attachUnresolved = true;
						} else {
							row.attachCommand = buildAttachCommand(attach);
						}
					} else {
						commComponent[ps.execution_id] = { w: null };
						if (state === "done") row.sessionEnded = true;
					}
					rows.push(row);
				}
				const headerCtx: ChatThreadContext = {
					...titleCtx,
					botToken: headerBotToken,
				};
				const content = buildPipelineHeaderContent(headerCtx, rows);
				resultB = await chatThreadCreator.ensureRunnerPipelineHeaderPinResult(
					headerCtx,
					threadId,
					content,
				);
			} else {
				// Non-DAG workflow: the byte-compat single-runner "Runner terminal"
				// pin (Lead bot, NEVER the announcer — FLY-892 Codex R1 Med).
				const target = (this.deps.getTmuxTarget ?? getTmuxTargetFromCommDb)(
					anySession.execution_id,
					anySession.project_name,
				);
				if (!target) {
					// tmux_window not registered yet — nothing to pin; stay a sweep
					// candidate so late registration converges (Codex R2 #1).
					commComponent[anySession.execution_id] = { w: null };
					resultB = "deferred";
				} else {
					const attach = await (
						this.deps.resolveAttach ?? resolveCmuxAttachTarget
					)(target.tmuxWindow);
					const matches = attachTargetMatchesIssue(
						anySession.issue_identifier,
						attach.windowName,
					);
					commComponent[anySession.execution_id] = {
						w: target.tmuxWindow,
						n: attach.windowName ?? null,
						ok: matches,
					};
					if (!matches) {
						warnAttachCrossWire(
							anySession.execution_id,
							anySession.issue_identifier,
							attach.windowName,
						);
						resultB =
							await chatThreadCreator.ensureRunnerAttachUnresolvedResult(
								titleCtx,
								threadId,
							);
					} else {
						resultB = await chatThreadCreator.ensureRunnerAttachPinResult(
							titleCtx,
							threadId,
							buildAttachCommand(attach),
						);
					}
				}
			}
		}

		// ── Face C: CONVERGED into the pinned pipeline header (Lead directive
		// 17ab4f53 / Annie: 一处置顶、原地更新、别散发). The unified refresher never
		// posts the standalone FLY-887 status-line message — the per-phase states
		// it carried are rendered by face B's pinned rows above. What remains
		// here is CLEANUP: an issue that still has a legacy scattered status-line
		// message gets it deleted (self-heal), so the thread converges to exactly
		// one pinned status block. The `phase_status_line` record is cleared only
		// after the Discord delete confirms (404 = already gone = ok).
		let resultC: DisplayWriteResult = "noop";
		const staleLine = store.getPhaseStatusLine(issueId, chatChannel);
		if (staleLine) {
			const del = await (
				this.deps.deleteMessage ?? deleteDiscordMessageInChannel
			)(threadId, staleLine.messageId, botToken);
			if (del.ok) {
				store.clearPhaseStatusLine(issueId, chatChannel);
				resultC = "changed";
				console.log(
					`[issue-display] removed legacy scattered status-line message for ${issueId} — status converged into the pinned block`,
				);
			} else {
				console.warn(
					`[issue-display] legacy status-line delete failed for ${issueId}: ${del.error ?? del.status} — retrying via sweep`,
				);
				resultC = "failed";
			}
		}

		// ── Fingerprint: persist ONLY when every enabled face confirmed
		// changed/noop (Codex R2 #2) — a failed/deferred face keeps this issue a
		// sweep candidate for the next tick. ──
		const parkComponent: Record<string, ParkProbe> = {};
		for (const [exec, probe] of parkByExec) parkComponent[exec] = probe;
		const faceResults: DisplayWriteResult[] = [resultC];
		if (flags.issueStatusEmojiEnabled) faceResults.push(resultA);
		if (flags.issueAttachPinEnabled) faceResults.push(resultB);
		const allLanded = faceResults.every((r) => r === "changed" || r === "noop");
		if (allLanded) {
			const fingerprint: DisplayFingerprint = {
				s: computeSessionsFingerprint(store, issueId),
				c: JSON.stringify({ park: parkComponent, tmux: commComponent }),
			};
			store.setChatThreadDisplayFingerprint(
				issueId,
				chatChannel,
				JSON.stringify(fingerprint),
				new Date().toISOString(),
			);
		}
	}
}
