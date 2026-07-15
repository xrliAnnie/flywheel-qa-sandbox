/**
 * FLY-175 Track 2 — wiring helper.
 *
 * Assembles the evaluator + shared context resolver + Surface B router + debug
 * router from the Bridge's existing pieces (StateStore, projects, config). Kept
 * out of plugin.ts so the integration is small and unit-testable.
 *
 * Returns `null` only when `config.founderConsent` is entirely absent. When
 * present-but-off (`decisionMode === "off"`) it returns a wiring with NO
 * evaluator/audit/debug, but STILL a (pass-through) gate router. This is
 * required for byte-compat: the patched `flywheel-comm respond` CLI always
 * routes `approve_to_ship` through the Bridge gate endpoint, so the route must
 * exist (and write the response) even while off — otherwise every production
 * ship would 404 during the default-off Phase 0 rollout (Codex R1 HIGH).
 */

import { type Request, type Response, Router } from "express";
import { AnthropicLLMClient } from "flywheel-claude-runner";
import {
	type ApplyTransitionOpts,
	applyTransition,
} from "../../applyTransition.js";
import type { ProjectEntry } from "../../ProjectConfig.js";
import type { StateStore } from "../../StateStore.js";
import { deriveCanonicalFounderId } from "../approval-signal/canonical-founder-id.js";
import { reviewHoldReason } from "../auto-qa-held.js";
import { finalizeRecoveredMerge } from "../merge-ship-gate.js";
import { makeFinalizeThreeStagePhases } from "../post-ship-finalization.js";
import { sendRunnerWake } from "../runner-wake.js";
import { type BridgeConfig, sqliteDatetime } from "../types.js";
import {
	type FounderConsentAuditStore,
	openAuditStore,
	redactAuditRow,
} from "./audit.js";
import { ConsentCache } from "./cache.js";
import { FounderConsentEvaluator } from "./evaluator.js";
import {
	createGateResponseRouter,
	type GateResponseRouterDeps,
} from "./gate-response-router.js";
import {
	type ConsentContextResolver,
	founderConsentMiddleware,
	type ResolvedConsentContext,
} from "./middleware.js";
import type { MountKind } from "./reserved-endpoints.js";

const logger = {
	info: (m: string) => console.log(`[founder-consent] ${m}`),
	warn: (m: string) => console.warn(`[founder-consent] ${m}`),
};

export interface FounderConsentWiring {
	/** Undefined when decisionMode=off (evaluator never constructed). */
	evaluator?: FounderConsentEvaluator;
	/** Undefined when decisionMode=off. */
	auditStore?: FounderConsentAuditStore;
	resolveContext: ConsentContextResolver;
	/** Surface A middleware factory (no-op handler when off). */
	middlewareFor: (
		mount: MountKind,
	) => ReturnType<typeof founderConsentMiddleware>;
	/** Surface B router — ALWAYS present (pass-through write when off). */
	gateRouter: Router;
	/** Read-only debug router — undefined when off. */
	debugRouter?: Router;
	/**
	 * FLY-799: the post-write hook (flip awaiting_review→approved_to_ship + wake).
	 * Exposed so the founder-reply approval path (via the ship-approval factory)
	 * runs the SAME status-flip + wake as Surface B. ALWAYS present.
	 */
	onResponseWritten: (info: {
		executionId: string;
		questionId: string;
		leadId: string;
		answer: string;
		db: Parameters<typeof sendRunnerWake>[1];
	}) => Promise<void>;
}

/**
 * FLY-799: the shared `approve_to_ship` post-write hook — flip
 * awaiting_review → approved_to_ship (Codex R2 MEDIUM-1, parity with
 * approveExecution) then wake the runner. Extracted so BOTH Surface B
 * (buildFounderConsentWiring's gate router) and the founder-reply approval path
 * (startBridge's ship-approval factory) run the IDENTICAL flip+wake and can
 * never drift into subtly-different ship semantics.
 *
 * An approval answer (structured `{"approved": true}` — the only shape
 * verify-approval honors) flips the FSM + sends an approval wake; any other
 * answer is changes_requested feedback → wake only, NOT terminal. Best-effort
 * throughout: never throws (sendRunnerWake never throws; an FSM/store failure
 * logs and converges on the caller's idempotent retry).
 */
export function buildGateResponsePostWriteHook(deps: {
	store: StateStore;
	transitionOpts?: ApplyTransitionOpts;
	logger?: { warn: (msg: string) => void };
	// FLY-869 B-3 (Codex R1 #1): threaded so the recovery can drive an un-parked,
	// already-merged, now-eligible session to completed + Linear Done (else it strands
	// at approved_to_ship). Absent → recovery only clears the marker (byte-compat).
	config?: BridgeConfig;
	projects?: ProjectEntry[];
	// FLY-907 (Step 4.1c): late-bound unified issue-display refresh, threaded
	// into the recovered-merge finalization so the display reaches its terminal
	// state on this path too. Absent / `.current` undefined → no refresh.
	issueDisplayRefresh?: {
		current?: { refresh(issueId: string): Promise<void> };
	};
}): (info: {
	executionId: string;
	questionId: string;
	leadId: string;
	answer: string;
	db: Parameters<typeof sendRunnerWake>[1];
}) => Promise<void> {
	const { store, transitionOpts } = deps;
	const log = deps.logger ?? logger;
	return async (info): Promise<void> => {
		let approved = false;
		try {
			approved = JSON.parse(info.answer)?.approved === true;
		} catch {
			// non-JSON answer → feedback
		}

		const session = store.getSession(info.executionId);
		if (!session) {
			log.warn(
				`gate-response post-write: no StateStore session for ${info.executionId}; skipping transition + wake`,
			);
			return;
		}

		if (approved && transitionOpts) {
			// Parity with approveExecution: only flip from awaiting_review (a
			// post-approve re-write or odd state must not regress/disturb FSM).
			if (session.status === "awaiting_review") {
				const result = applyTransition(
					transitionOpts,
					info.executionId,
					"approved_to_ship",
					{
						executionId: info.executionId,
						issueId: session.issue_id,
						projectName: session.project_name,
						trigger: "runner_gate_response",
					},
					{ last_activity_at: sqliteDatetime() },
				);
				if (!result.ok) {
					// Recoverable (Codex R2 HIGH-2): the caller's idempotent-retry
					// path re-runs this hook on a repeat respond, so a transient
					// FSM/store failure here converges on retry.
					log.warn(
						`gate-response approval written but FSM rejected approved_to_ship for ${info.executionId}: ${result.error} — retry the respond to re-run the transition`,
					);
				}
			} else if (session.status === "approved_to_ship") {
				// Idempotent retry after a previously-completed transition —
				// nothing to do but re-deliver the wake below.
			} else {
				log.warn(
					`gate-response approval written for ${info.executionId} but status is "${session.status}" (expected awaiting_review) — transition skipped`,
				);
			}
			// FLY-869 B-3 recovery (Codex R1 #1 / R2 #2): a founder gate-response approval on a
			// parked merge_block session (same PR head) drives it to completed + Done — but ONLY
			// when now fully ship-eligible; an unmet QA/Codex gate leaves the durable marker in
			// place (still held). Sister call: actions.approveExecution.
			if (deps.config && deps.projects) {
				const refreshIssueDisplay = deps.issueDisplayRefresh?.current
					? (issueId: string) =>
							deps.issueDisplayRefresh?.current?.refresh(issueId) ??
							Promise.resolve()
					: undefined;
				const completed = await finalizeRecoveredMerge(
					store,
					deps.config,
					deps.projects,
					info.executionId,
					undefined,
					undefined,
					// FLY-907: terminal-state display refresh on the recovered path.
					refreshIssueDisplay,
					// FLY-907 Codex R1 MED-2: the recovered-merge path must finalize a
					// three-stage issue's parked phases like every other completion sink.
					transitionOpts
						? makeFinalizeThreeStagePhases(
								store,
								transitionOpts,
								refreshIssueDisplay,
							)
						: undefined,
				);
				if (completed) {
					log.warn(
						`FLY-869 B-3 recovered merge finalized → completed for ${info.executionId}`,
					);
				}
			}
		}

		await sendRunnerWake(
			store,
			info.db,
			info.executionId,
			session,
			approved ? "approval_wake" : "feedback_wake",
			// Codex PR R1 MEDIUM-5: carry the questionId + (for feedback) the
			// actual feedback text so the idle runner can act on the wake
			// without hunting for context. Non-authoritative either way.
			{
				questionId: info.questionId,
				feedbackText: approved ? undefined : info.answer,
			},
		);
	};
}

export function buildFounderConsentWiring(
	store: StateStore,
	projects: ProjectEntry[],
	config: BridgeConfig,
	overrides?: {
		llm?: ConstructorParameters<typeof FounderConsentEvaluator>[0]["llm"];
		auditStore?: FounderConsentAuditStore;
		fetchImpl?: ConstructorParameters<
			typeof FounderConsentEvaluator
		>[0]["fetchImpl"];
		now?: () => number;
		nowIso?: () => string;
		/** FLY-191: gate-router comm root override (tests). */
		gateCommRoot?: string;
	},
	/**
	 * FLY-191 Phase 2: when provided, gate-response writes flip
	 * awaiting_review → approved_to_ship via the FSM (Codex R2 MEDIUM-1 —
	 * parity with /api/actions/approve) before the wake. Without it the wake
	 * still fires but the status flip is skipped (legacy/test wiring).
	 */
	transitionOpts?: ApplyTransitionOpts,
	// FLY-907: late-bound unified issue-display refresh holder (see
	// buildGateResponsePostWriteHook).
	issueDisplayRefresh?: {
		current?: { refresh(issueId: string): Promise<void> };
	},
): FounderConsentWiring | null {
	const fc = config.founderConsent;
	if (!fc) return null; // Track 2 not compiled into this config at all.

	const enabled = fc.decisionMode !== "off";
	const configuredProjects = new Set(projects.map((p) => p.projectName));
	const founderId =
		deriveCanonicalFounderId(config.discordOwnerUserId, fc.founderUserId) ??
		undefined;

	// Shared context resolver — needed only when evaluating, but cheap to build.
	const resolveContext: ConsentContextResolver = async (executionId) => {
		if (!executionId) return null;
		const s = store.getSessionForConsentLookup(executionId);
		if (!s) return null;

		const project = projects.find((p) => p.projectName === s.project_name);
		let threadId: string | undefined;
		let channelId: string | undefined;
		let botToken: string | undefined = config.discordBotToken;

		if (project) {
			for (const lead of project.leads) {
				// FLY-793 (Codex full-PR R1 #5) — DOCUMENTED EXCEPTION: this
				// founder-consent audit path operates on a NARROW session projection
				// with no chat_thread_role, and it fires only for reserved actions
				// (merge/ship/runner-lifecycle) that a three-stage PHASE runner never
				// self-invokes. So it intentionally stays on the main thread mapping.
				const t = store.getChatThreadByIssue(s.issue_id, lead.chatChannel);
				if (t) {
					threadId = t.thread_id;
					channelId = t.channel_id;
					botToken = lead.botToken ?? config.discordBotToken;
					break;
				}
			}
		}

		const ctx: ResolvedConsentContext = {
			issueId: s.issue_id,
			issueIdentifier: s.issue_identifier,
			projectName: s.project_name,
			executionId,
			sessionRole: s.session_role,
			sessionStatusAtCall: s.session_status,
			issueLabels: s.issue_labels,
			prNumber: s.pr_number,
			prHeadSha: s.pr_head_sha ?? null,
			threadId,
			discordChannelId: channelId,
			botToken,
			// MVP: Bridge does not enumerate per-lead Discord bot user ids, so
			// lead/runner role hints are best-effort. The security property is
			// preserved regardless: only `founder`-role messages (author ==
			// FOUNDER_USER_ID) can ever serve as authorization evidence.
			leadBotIds: new Set<string>(),
			runnerBotIds: new Set<string>(),
		};
		return ctx;
	};

	const getSessionProject = (executionId: string) => {
		const sess = store.getSession(executionId);
		return sess ? { project_name: sess.project_name } : undefined;
	};

	// FLY-191 Phase 2 / FLY-799: post-write hook for the gate-response endpoint
	// (the production `flywheel-comm respond --bridge-url` ship path). Shared with
	// the founder-reply approval path (startBridge's ship-approval factory) via
	// buildGateResponsePostWriteHook so the two can never drift.
	const onResponseWritten = buildGateResponsePostWriteHook({
		store,
		transitionOpts,
		logger,
		// FLY-869 B-3: drive recovered-merge completion on this ship-approval path too.
		config,
		projects,
		// FLY-907: terminal-state display refresh on the recovered-merge path.
		issueDisplayRefresh,
	});

	// FLY-191 Phase 2 (Codex PR R1 CRITICAL): the gate router rejects answers
	// to anything but the session's CURRENT review question (when bound).
	const getCurrentReviewQuestionId = (
		executionId: string,
	): string | undefined =>
		store.getSession(executionId)?.review_question_id ?? undefined;

	// ── Off: pass-through gate router only, no evaluator/audit/debug ──
	if (!enabled) {
		const gateDeps: GateResponseRouterDeps = {
			evaluator: undefined,
			resolveContext,
			getSessionProject,
			getCurrentReviewQuestionId,
			writerStore: store,
			holdReasonFor: (executionId) =>
				reviewHoldReason(store, store.getSession(executionId)),
			founderId,
			configuredProjects,
			logger,
			onResponseWritten,
			commRoot: overrides?.gateCommRoot,
		};
		return {
			resolveContext,
			middlewareFor: () => (_q, _s, next) => next(),
			gateRouter: createGateResponseRouter(gateDeps),
			onResponseWritten,
		};
	}

	// ── Enabled (audit_only | enforce) ──
	const auditStore = overrides?.auditStore ?? openAuditStore(fc.auditDbPath);
	const llm = overrides?.llm ?? new AnthropicLLMClient();
	const cache = new ConsentCache(fc.cacheTtlSecs);

	const evaluator = new FounderConsentEvaluator({
		config: fc,
		llm,
		audit: auditStore,
		cache,
		fetchImpl: overrides?.fetchImpl,
		now: overrides?.now,
		nowIso: overrides?.nowIso,
		logger,
	});

	const debugRouter = Router();
	debugRouter.get("/", (req: Request, res: Response) => {
		const issue =
			typeof req.query.issue === "string" ? req.query.issue : undefined;
		const reqLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
		const limit = Math.min(
			Number.isNaN(reqLimit) ? fc.debugEndpointMaxLimit : reqLimit,
			fc.debugEndpointMaxLimit,
		);
		const rows = issue
			? auditStore.queryByIssue(issue, limit)
			: auditStore.queryRecent(limit);
		res.json({
			rows: rows.map(redactAuditRow),
			limit,
			decisionMode: fc.decisionMode,
		});
	});

	const gateDeps: GateResponseRouterDeps = {
		evaluator,
		resolveContext,
		getSessionProject,
		getCurrentReviewQuestionId,
		writerStore: store,
		holdReasonFor: (executionId) =>
			reviewHoldReason(store, store.getSession(executionId)),
		founderId,
		configuredProjects,
		logger,
		onResponseWritten,
		commRoot: overrides?.gateCommRoot,
	};

	return {
		evaluator,
		auditStore,
		resolveContext,
		middlewareFor: (mount) =>
			founderConsentMiddleware(mount, { evaluator, resolveContext, logger }),
		gateRouter: createGateResponseRouter(gateDeps),
		debugRouter,
		onResponseWritten,
	};
}
