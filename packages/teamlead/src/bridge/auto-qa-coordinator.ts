/**
 * FLY-579 P1: AutoQaCoordinator — the deterministic Bridge orchestration that
 * turns "code review passed" into "independent QA, then (only if green) surface
 * the founder". It is the heart of the auto-QA pipeline and the reason the flow
 * no longer depends on a Lead remembering to spawn QA.
 *
 * Three entry points, all called from event-route / plugin.ts:
 *
 *   (a) onMainAwaitingReview(session) — a main session just entered
 *       awaiting_review (code review passed, approve gate opened). Guard on
 *       policy, FAIL-CLOSED on a missing pr_head_sha (QA must NEVER fall back to
 *       origin/main), atomically CLAIM a held record (held-first, before any
 *       relayer can observe the parent as an ordinary review gate), spawn an
 *       independent QA Runner pinned to the reviewed commit, post "🧪 QA started".
 *
 *   (b) onQaResult(event) — the QA Runner reported a verdict. Validate linkage +
 *       freshness + idempotency, then: PASS → release the in-thread founder
 *       ship-ready notification (founder surfaced ONLY now); FAIL → wake the
 *       implementer with the report and post "🔴 QA FAIL → fixing" (founder NOT
 *       notified). A lost verdict is never silently treated as a pass.
 *
 *   (c) reconcileOnStartup() — after a Bridge restart, re-drive in-flight QA
 *       (claimed-but-unspawned → spawn; QA died without a verdict → stuck +
 *       Lead alert; passed-but-unnotified → re-notify). MUST run before the
 *       GatePoller / Heartbeat timers so a restart can't relay a held gate.
 *
 * The founder ship gate (verify-approval / approveExecution / the FSM) is NOT
 * touched — this coordinator only decides WHEN the founder is surfaced.
 */

import { randomUUID } from "node:crypto";
import { adapterTypeToFamily } from "flywheel-config";
import {
	type AutoQaRecord,
	REVIEW_BINDING_UNBOUND,
	type Session,
	type StateStore,
} from "../StateStore.js";
import {
	readCurrentGateMessageBinding,
	writeGateMessageBinding,
} from "./approval-signal/gate-message-binding-store.js";
import {
	codexHardGateEnabled,
	isCodexGateSatisfied,
	isReviewableRole,
} from "./codex-gate.js";
import type { CompleteMarkerHeldAlert } from "./complete-marker-reconciler.js";
import type { QaContext, StartRequest } from "./retry-dispatcher.js";

/**
 * Minimal structural view of the `qa_result` ingest event the coordinator
 * consumes (event-route's local IngestEvent satisfies it). Keeping this local
 * avoids importing event-route's private interface.
 */
export interface QaResultEvent {
	event_id: string;
	execution_id: string;
	issue_id: string;
	project_name: string;
	event_type: string;
	payload?: Record<string, unknown>;
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const TERMINAL_STATUSES = new Set([
	"completed",
	"blocked",
	"failed",
	"terminated",
	"rejected",
	"shelved",
	"deferred",
]);

/** Decision returned by the per-issue QA policy (P3 supplies the concrete impl). */
export interface QaPolicyDecision {
	enabled: boolean;
	/** Human-readable reason when disabled — logged, not founder-facing. */
	reason?: string;
}

/**
 * FLY-643: the separate `QA·FLY-XX` Linear issue an auto-QA run is tracked on.
 * Returned by `createQaIssue`; persisted on the AutoQaRecord so a crash mid-spawn
 * re-uses it (no duplicate issue) and the 🧪 thread post can reference it.
 */
export interface QaIssueRef {
	issueId: string;
	issueIdentifier?: string;
	issueTitle?: string;
	issueUrl?: string;
}

/**
 * Side-effects the coordinator drives. Injected so the orchestration is
 * unit-testable with fakes; the concrete Discord-thread / wake / Lead-alert /
 * Linear-issue implementations are wired in plugin.ts (P2).
 */
export interface AutoQaSideEffects {
	/** Post a deterministic key-state line to the issue's chat thread. */
	postThread(args: { session: Session; text: string }): Promise<void> | void;
	/**
	 * FLY-643: create the SEPARATE `QA·FLY-XX` Linear issue (mirroring the parent
	 * issue's team / project / labels) the auto-QA runner will run on. Returns the
	 * created issue ref, or `undefined` on any failure (missing Linear key, API
	 * error) — the coordinator then marks the record `stuck` + Lead-alerts
	 * (fail-closed; the founder is NOT surfaced).
	 */
	createQaIssue(args: {
		parent: Session;
		prHeadSha: string;
	}): Promise<QaIssueRef | undefined> | QaIssueRef | undefined;
	/**
	 * PASS: surface the in-thread founder ship-ready notification. This is the
	 * ONLY founder-facing emission in the whole flow, and it fires only after QA
	 * is green. (P2 concrete impl posts to the issue thread, never alert channel.)
	 */
	notifyShipReady(args: {
		session: Session;
		record: AutoQaRecord;
	}): Promise<void> | void;
	/** FAIL: wake the implementer main runner with the QA report (changes-requested loop). */
	feedbackWakeMain(args: {
		session: Session;
		summary: string;
	}): Promise<void> | void;
	/** A pipeline error only the Lead should see — NEVER the founder, NEVER an alert masquerading as a notification. */
	alertLeadPipelineError(args: {
		session?: Session;
		issueId: string;
		projectName: string;
		reason: string;
	}): Promise<void> | void;
	/** FLY-1505: severe, accurately-labelled ship-attempt alert. */
	alertShipAttemptFailed?(args: {
		session: Session;
		reason: string;
	}): Promise<void> | void;
	/** FLY-1912: durable marker circuit-breaker alert; failures must propagate. */
	alertCompleteMarkerHeld?(args: CompleteMarkerHeldAlert): Promise<void> | void;
	/**
	 * FLY-630 ②: stamp the PARENT issue's `[FLY-XX]` chat-thread title badge to
	 * reflect the issue's CURRENT pipeline stage during the independent-QA phase.
	 * Because QA runs on a SEPARATE `QA·FLY-XX` issue/thread (FLY-643), the parent
	 * thread would otherwise stay frozen on the implementer's last stage (approve →
	 * ⏳待批) while QA runs. The coordinator drives it: QA spawned → "test" (🧪QA);
	 * QA passed → "approve" (⏳待批, now genuinely awaiting the founder); QA failed →
	 * "implement" (🔨实现中, the implementer is being woken to fix). Fire-and-forget
	 * + best-effort (gated by the same status-emoji feature flag); never throws into
	 * the QA lifecycle.
	 */
	stampIssueStage(args: {
		session: Session;
		stage: string;
	}): Promise<void> | void;
	/**
	 * FLY-752: RE-TEST wake — wake the ALIVE, parked QA runner to verify the
	 * implementer's NEW head (fix-loop reuse; never a fresh QA2). Unlike the
	 * void/best-effort `sendRunnerWake`, this is a FAIL-LOUD primitive: it resolves
	 * the transport from the QA session's `adapter_type`, clears the QA's
	 * `declare-state park` marker so idle accounting resumes, and RETURNS whether
	 * the wake landed. A no-transport QA (should be impossible — spawn forces a
	 * mailbox-capable lane) returns `{ ok: false }` so the coordinator holds the
	 * founder + keeps the durable retest marker for reconcile, never silently
	 * releasing the gate on a wake that went nowhere.
	 */
	retestWakeQa(args: {
		qaSession: Session;
		parentSession: Session;
		newSha: string;
	}):
		| Promise<{ ok: boolean; error?: string }>
		| { ok: boolean; error?: string };
	/**
	 * FLY-752: TERMINAL QA cleanup — the founder-visible half of the issue's ask.
	 * On QA PASS (and on supersede while a QA runner is still alive) close the QA
	 * runner: kill its cmux workspace + tmux window + Terminal tab, ARCHIVE its
	 * Discord thread (FLY-369), drop its CommDB row. Concrete impl uses
	 * `closeRunner({ finalizeDone: true, transitionOpts, archive })` so a
	 * still-`running` (idle/parked) QA is FSM-transitioned to `completed` first
	 * (archive is completed-gated). Best-effort — a close failure never throws into
	 * the QA lifecycle (reconcile re-drives it).
	 */
	closeQaRunner(args: {
		qaSession: Session;
		reason?: string;
	}): Promise<void> | void;
	/**
	 * FLY-827: re-queue the `/codex-code-review` instruction to a runner whose
	 * session is Codex-held (the runner never ran / never reported Codex). Closes
	 * the loop (Lead D3): don't just block — tell the runner to go run Codex.
	 * Best-effort (writes the runner's CommDB inbox); never throws into the gate.
	 * FLY-1099 §3.3: may return a `{queued, error?}` result (the production
	 * effects do); void-returning fakes stay valid.
	 */
	queueCodexInstruction(args: {
		session: Session;
	}):
		| Promise<{ queued: boolean; error?: string } | undefined>
		| { queued: boolean; error?: string }
		| undefined;
	/**
	 * FLY-827: a Lead-facing Flywheel Alert that a session is blocked on the Codex
	 * code-review hard gate (founder NOT surfaced). Rate-limited per (exec, head)
	 * so a re-drive / restart doesn't spam. `sha` omitted → the missing-PR-head
	 * variant (R3-LOW-3): deduped per exec, asks for a re-`complete` with a valid
	 * head binding rather than a head-specific review. Never throws into the gate.
	 */
	alertCodexGateBlocked(args: {
		session: Session;
		sha?: string;
	}): Promise<void> | void;
	/**
	 * FLY-945 Fix B: post the ship-gate REBIND follow-up to the issue thread —
	 * "gate 更新:PR head <old8> → <new8>,你的批准将绑定新 head" — and return the
	 * created Discord message id + thread id so the coordinator can anchor the
	 * new `(question, head)` binding revision on it (the founder's ✅-reaction
	 * target). The ORIGINAL gate message is never edited (the founder may have
	 * already read it; the follow-up preserves her informed consent). Absent /
	 * `{ok:false}` → the binding row is NOT written (reaction path fail-closed
	 * for the new head until a retry anchors it); the text-approval path is
	 * already closed-loop via the session head update.
	 */
	notifyShipGateRebound?(args: {
		session: Session;
		oldSha: string;
		newSha: string;
	}): Promise<{ ok: boolean; messageId?: string; threadId?: string }>;
}

export interface AutoQaCoordinatorDeps {
	store: StateStore;
	/** Reaches RunDispatcher.start() — the same primitive runs-route uses. */
	startDispatcher: {
		start(req: StartRequest): Promise<{
			executionId: string;
			issueId: string;
		}>;
		hasInflightForRole?(issueId: string, role: string): boolean;
	};
	/** Per-(project, issue) policy: should auto-QA run for this awaiting_review main session? */
	resolveQaPolicy(session: Session): QaPolicyDecision;
	effects: AutoQaSideEffects;
	/** Reserved QA agent name (AgentDispatcher resolves project-override → shipped). Default "qa". */
	qaAgentName?: string;
	/** FLY-827: env for the codex hard-gate kill-switch. Defaults to process.env. */
	env?: Record<string, string | undefined>;
	/** Deterministic clock seam. Defaults to Date.now. */
	now?: () => number;
	/**
	 * FLY-1251: materialize the server-owned docs-only/code-bearing decision for
	 * this exact reviewed head. Failure is fail-closed in the hold predicate, so
	 * this producer must never disable the ordinary QA path.
	 */
	ensureShipRelevantDiff?: (session: Session) => Promise<void> | void;
	logger?: { log(m: string): void; warn(m: string): void };
	/**
	 * FLY-945 Fix B: environment probes for the ship-gate head rebind. Wired in
	 * plugin.ts to `defaultHasGateResponse` / `defaultIsAncestor`
	 * (ship-gate-rebind.ts). ABSENT → the rebind branch is inert and a
	 * drifted-head qa_result is dropped exactly as before FLY-945.
	 */
	shipGateRebind?: {
		/** True when the gate question already has a response (fail-closed on error). */
		hasGateResponse(args: { projectName: string; questionId: string }): boolean;
		/** True iff oldSha is an ancestor of newSha in the worktree (fail-closed). */
		isAncestor(args: {
			worktreePath: string;
			oldSha: string;
			newSha: string;
		}): boolean;
	};
}

export type ManualQaSpawnResult =
	| { status: "spawned"; qaExecutionId: string }
	| { status: "existing"; recordStatus: AutoQaRecord["status"] }
	| {
			status: "rejected";
			reason:
				| "invalid_parent"
				| "not_awaiting_review"
				| "missing_pr"
				| "head_mismatch"
				| "not_admitted"
				| "spawn_failed";
	  };

export class AutoQaCoordinator {
	private readonly qaAgentName: string;
	private qaRecoverySweep: Promise<void> | undefined;

	constructor(private readonly deps: AutoQaCoordinatorDeps) {
		this.qaAgentName = deps.qaAgentName ?? "qa";
	}

	private log(m: string): void {
		this.deps.logger?.log?.(`[auto-qa] ${m}`);
	}

	private warn(m: string): void {
		(this.deps.logger?.warn ?? this.deps.logger?.log)?.(`[auto-qa] ${m}`);
	}

	/**
	 * FLY-1251: server-owned manual QA enrollment. The caller supplies only the
	 * parent and exact current head; reviewer identity and qa_execution_id are
	 * created by the coordinator through the ordinary spawn chain.
	 */
	async manualSpawnQa(
		parentExecutionId: string,
		prHeadSha: string,
	): Promise<ManualQaSpawnResult> {
		const requestedHead = prHeadSha.toLowerCase();
		const parent = this.deps.store.getSession(parentExecutionId);
		if (!parent || (parent.session_role ?? "main") !== "main") {
			return { status: "rejected", reason: "invalid_parent" };
		}
		if (parent.status !== "awaiting_review") {
			return { status: "rejected", reason: "not_awaiting_review" };
		}
		if (parent.pr_number == null) {
			return { status: "rejected", reason: "missing_pr" };
		}
		if (
			!FULL_SHA.test(requestedHead) ||
			parent.pr_head_sha?.toLowerCase() !== requestedHead
		) {
			return { status: "rejected", reason: "head_mismatch" };
		}

		const existing = this.deps.store.getAutoQaRecord(
			parentExecutionId,
			requestedHead,
		);
		if (existing) {
			if (existing.status !== "stuck" && existing.status !== "failed") {
				return { status: "existing", recordStatus: existing.status };
			}
			const qaSession = existing.qa_execution_id
				? this.deps.store.getSession(existing.qa_execution_id)
				: undefined;
			if (qaSession && !TERMINAL_STATUSES.has(qaSession.status)) {
				return { status: "existing", recordStatus: existing.status };
			}
		}

		await this.onMainAwaitingReview(parent, {
			freshTransition: true,
			manualEnrollment: true,
		});
		const enrolled = this.deps.store.getAutoQaRecord(
			parentExecutionId,
			requestedHead,
		);
		if (
			enrolled?.status === "running" &&
			enrolled.qa_execution_id &&
			enrolled.enrollment_source === "manual"
		) {
			this.deps.store.insertEvent({
				event_id: `manual-qa-enrolled-${parentExecutionId}-${requestedHead}-${enrolled.qa_execution_id}`,
				execution_id: parentExecutionId,
				issue_id: parent.issue_id,
				project_name: parent.project_name,
				event_type: "manual_qa_enrolled",
				source: "bridge.auto-qa-coordinator",
				payload: {
					prHeadSha: requestedHead,
					qaExecutionId: enrolled.qa_execution_id,
				},
			});
			return {
				status: "spawned",
				qaExecutionId: enrolled.qa_execution_id,
			};
		}
		if (enrolled?.status === "stuck") {
			return { status: "rejected", reason: "spawn_failed" };
		}
		if (enrolled) {
			return { status: "existing", recordStatus: enrolled.status };
		}
		return { status: "rejected", reason: "not_admitted" };
	}

	/**
	 * FLY-630 ②: stamp the parent thread badge, best-effort. A cosmetic
	 * thread-title failure must NEVER throw into the QA lifecycle (e.g. mark a
	 * record stuck or block a founder release) — so any error from the side-effect
	 * is swallowed here, independent of how a concrete impl behaves.
	 */
	private async safeStampIssueStage(
		session: Session,
		stage: string,
	): Promise<void> {
		try {
			await this.deps.effects.stampIssueStage({ session, stage });
		} catch (err) {
			this.warn(
				`stampIssueStage(${stage}) failed for ${session.issue_id}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	/**
	 * (a) A main session just entered awaiting_review. FLY-752 fix-loop reuse:
	 *   - No owner record + a GENUINE fresh review-pass → first spawn.
	 *   - No owner record + NOT a fresh transition (parked-waiting-for-founder /
	 *     re-emission) → SKIP (never QA a parked session).
	 *   - Owner record, SAME head → dedup / no-op (running dedup; passed founder
	 *     already surfaced; stuck/failed held; awaiting_retest held).
	 *   - Owner record, NEW head → RETARGET the same record + REUSE the QA runner:
	 *     alive → `retest_wake`; dead/closed → re-spawn into the SAME QA issue.
	 * Idempotent + race-safe. `opts.freshTransition` = the parent transitioned INTO
	 * awaiting_review (its prior status was not awaiting_review); defaults true for
	 * back-compat when a caller omits it (real callers always compute + pass it).
	 */
	async onMainAwaitingReview(
		sessionInput: Session,
		opts?: {
			freshTransition?: boolean;
			codexReleased?: boolean;
			manualEnrollment?: boolean;
		},
	): Promise<void> {
		if ((sessionInput.session_role ?? "main") !== "main") return;
		const freshTransition = opts?.freshTransition ?? true;
		// FLY-827 (Codex R2 HIGH-3): a Codex-release re-drive (from
		// onCodexReviewResult) forces the FIRST QA spawn even though it is not a
		// fresh awaiting_review transition — the session was codex-held (returned
		// before claiming any auto_qa_record), so without this override the "no
		// owner + !freshTransition" guard below would skip QA forever.
		const codexReleased = opts?.codexReleased ?? false;
		const manualEnrollment = opts?.manualEnrollment ?? false;
		const env = this.deps.env ?? process.env;

		// FLY-846 gate ⓪: the coordinator RE-READS the row itself instead of
		// trusting any caller's snapshot (Codex R1 LOW-2). DirectEventSink's
		// FLY-191 R5 evidence-only branch keeps an approved_to_ship row untouched
		// while its LOCAL status variable still says awaiting_review — without
		// this guard that straggler reaches the claim path (and its old qid
		// defeats gate ②). All later gates read this fresh row.
		const session = this.deps.store.getSession(sessionInput.execution_id);
		if (!session || (session.session_role ?? "main") !== "main") {
			this.log(
				`skip ${sessionInput.execution_id} — row ${session ? `role is ${session.session_role}` : "not found"}`,
			);
			return;
		}
		if (session.status !== "awaiting_review") {
			this.log(
				`skip ${session.execution_id} (${session.issue_id}) — row status is ${session.status}, not awaiting_review`,
			);
			return;
		}
		// FLY-869 B (Codex R1 #3): a parked merged-without-approval session is HELD —
		// never QA it back toward ship. The live entry must consume the merge_block
		// suppressor too (not just the A-3 orphan sweep), else a Codex-release re-drive
		// (onCodexReviewResult → codexReleased:true) would spawn QA on a parked merge.
		if (session.merge_block_reason) {
			this.log(
				`skip ${session.execution_id} (${session.issue_id}) — merge_block parked (merged without approval); held, not QA'd`,
			);
			return;
		}

		// FLY-846 gate ①: NEVER QA a QA. A `QA·FLY-XX` issue can carry a main-role
		// session (Lead dispatched a runner on it — FLY-828/845 incidents); when it
		// reaches awaiting_review it must not get a QA-of-a-QA. Detected by the
		// generated title prefix (also covers hand-created QA issues) OR by the
		// durable qa_issue_* columns (local equivalent of a qa_of link; survives a
		// retitle). Log-only skip — the parent proceeds through the ordinary
		// review path, which the Lead sees.
		if (this.isQaIssueSession(session)) {
			this.log(
				`skip ${session.execution_id} (${session.issue_id}) — issue is itself a QA issue; never QA a QA`,
			);
			return;
		}

		// FAIL-CLOSED: QA + the codex gate MUST be pinned to the exact reviewed
		// commit. A missing / malformed pr_head_sha must NEVER let QA fall back to
		// origin/main — that would verify the wrong code. Checked BEFORE policy +
		// codex (FLY-827) since both need the sha. Pipeline error → Lead only (never
		// founder); the founder is held on missing-sha by isReviewHeld (R2-MED-3).
		const sha = session.pr_head_sha?.toLowerCase();
		if (!sha || !FULL_SHA.test(sha)) {
			this.warn(
				`FAIL-CLOSED no spawn for ${session.execution_id} (${session.issue_id}) — missing/invalid pr_head_sha (${session.pr_head_sha ?? "none"})`,
			);
			await this.deps.effects.alertLeadPipelineError({
				session,
				issueId: session.issue_id,
				projectName: session.project_name,
				reason: `auto-QA could not spawn: ${session.issue_id} reached awaiting_review without a valid pr_head_sha. Founder NOT surfaced; please investigate.`,
			});
			return;
		}

		// FLY-827: the Codex code-review HARD GATE — BEFORE QA policy (codex is
		// fleet-universal, independent of per-project QA). Not satisfied → codex-hold
		// (post thread + re-queue the review instruction + rate-limited alert) and
		// return WITHOUT spawning QA. The founder stays held via isReviewHeld's codex
		// branch. When the runner runs Codex + reports, onCodexReviewResult re-drives
		// here with codexReleased:true.
		if (!isCodexGateSatisfied(this.deps.store, session, sha, env)) {
			await this.codexHold(session, sha);
			return;
		}

		// FLY-1251 R2/R3: produce the synchronous hold predicate's exact-head
		// classification before policy can exempt auto-QA. Unknown/errors keep the
		// founder held; they do not prevent a required QA from being admitted.
		try {
			await this.deps.ensureShipRelevantDiff?.(session);
		} catch (err) {
			this.warn(
				`ship-diff classification failed for ${session.execution_id} @ ${sha.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		if (
			this.deps.store.isWorkflowEngineOwnedExecution(session.execution_id) &&
			!this.deps.store.getLatestAutoQaRecordByParent(session.execution_id)
		) {
			if (session.qa_required === 1) {
				await this.deps.effects.alertLeadPipelineError({
					session,
					issueId: session.issue_id,
					projectName: session.project_name,
					reason: `engine-owned workflow carrier ${session.issue_id} has immutable qa_required=1 but no auto-QA record; separate auto-QA is disabled for engine workflows, so this session needs one-time recovery.`,
				});
			} else {
				this.deps.store.setQaRequiredSnapshot({
					executionId: session.execution_id,
					required: 0,
					reason: "engine_owned_workflow_run",
				});
			}
			this.log(
				`skip ${session.execution_id} (${session.issue_id}) — engine-owned workflow run owns its QA topology`,
			);
			return;
		}

		const policy = this.deps.resolveQaPolicy(session);
		if (!policy.enabled && !manualEnrollment) {
			// FLY-869 A-1: auto-QA is not applicable for this session (no-qa label /
			// qa.auto:false / kill-switch). Persist the IMMUTABLE qa_required=0 snapshot
			// so the ship gate (evaluateQaShipGate) exempts it rather than fail-closing.
			this.deps.store.setQaRequiredSnapshot({
				executionId: session.execution_id,
				required: 0,
				reason: `policy_off:${policy.reason ?? "disabled"}`,
			});
			this.log(
				`skip ${session.execution_id} (${session.issue_id}) — auto-QA not enabled: ${policy.reason ?? "policy off"}`,
			);
			return;
		}

		// FLY-846 gate ②: only a GENUINE review-pass may spawn (or retest). A
		// genuine completion carries review evidence: a real approve-gate binding
		// (review_question_id, not the UNBOUND sentinel) and/or a PR number. A
		// body-kill / transient completion carries neither (only a cwd-HEAD sha) —
		// FLY-842's parent died mid-implement exactly like that. Back-tested
		// against all 30 production records: 0/28 false positives, 2/2 caught.
		// Skip = no claim → the parent follows the ordinary (pre-FLY-579) review
		// path; never wedged, never held.
		const qid = session.review_question_id;
		const hasReviewEvidence =
			(!!qid && qid !== REVIEW_BINDING_UNBOUND) || session.pr_number != null;
		if (!hasReviewEvidence) {
			this.log(
				`skip ${session.execution_id} (${session.issue_id}) @ ${sha.slice(0, 8)} — no review evidence (qid=${qid ?? "none"}, pr=none); not a genuine review-pass`,
			);
			return;
		}

		// FLY-869 A-1: from here auto-QA APPLIES (policy enabled + genuine review
		// evidence). Persist the IMMUTABLE qa_required=1 snapshot so the ship gate
		// requires a passing auto_qa_record for the head before Done. Immutable
		// (IS NULL guard) → a later config/label change never rewrites the verdict.
		this.deps.store.setQaRequiredSnapshot({
			executionId: session.execution_id,
			required: 1,
			reason: "auto_qa_applies",
		});

		const owner = this.deps.store.getLatestAutoQaRecordByParent(
			session.execution_id,
		);

		if (owner) {
			if (owner.target_pr_head_sha === sha) {
				if (
					manualEnrollment &&
					(owner.status === "stuck" || owner.status === "failed")
				) {
					const qaSession = owner.qa_execution_id
						? this.deps.store.getSession(owner.qa_execution_id)
						: undefined;
					if (
						(!qaSession || TERMINAL_STATUSES.has(qaSession.status)) &&
						this.deps.store.reviveAutoQaRecordForManualSpawn(
							session.execution_id,
							sha,
						)
					) {
						await this.spawnQa(session, sha);
					}
					return;
				}
				// Same head — parked / duplicate re-emission. No new QA, no re-test.
				// passed → founder already surfaced; running/awaiting_retest/stuck/
				// failed → held, Lead-driven. All no-op.
				this.log(
					`dedup ${session.execution_id} @ ${sha.slice(0, 8)} — owner record is ${owner.status} for this head`,
				);
				return;
			}
			// NEW head = a genuine fix round (freshTransition not required — the head
			// change is the authoritative signal). REUSE the same QA runner/issue.
			await this.driveRetest(session, owner, sha);
			return;
		}

		// No owner record. Only a GENUINE fresh review-pass gets a first QA — a
		// parked-waiting-for-founder / re-emitted awaiting_review must NOT spawn.
		// FLY-827 (R2 HIGH-3): a codex-release re-drive ALSO gets the first spawn
		// (the session was codex-held before it could claim a record; codex just
		// released it, so this is a legitimate first review-pass).
		if (!freshTransition && !codexReleased) {
			this.log(
				`skip ${session.execution_id} (${session.issue_id}) @ ${sha.slice(0, 8)} — no owner record and not a fresh review-pass (parked-for-founder)`,
			);
			return;
		}

		// FLY-846 gate ③: ONE issue, ONE active QA. Another parent execution on
		// the SAME issue may hold an active record (running/awaiting_retest/stuck)
		// — the FLY-696 incident: a terminated predecessor's record stayed
		// "running" until the next Bridge restart, so a second QA (FLY-852) piled
		// on top of the first (FLY-842). Contract (Lead-approved):
		//   - the other parent STILL OWNS its record (awaiting_review + same head,
		//     the reconcile predicate) → genuine anomaly: skip + Lead alert;
		//   - otherwise (terminal / missing / moved on / head drift) → the record
		//     is stale: supersede (synchronously, here) + proceed; its QA runner is
		//     closed AFTER the claim below (best-effort, attempted once) — the
		//     event-driven twin of reconcileOnStartup's supersede sweep.
		// Codex R1 HIGH-1: supersede→claim must not be split by an await, or a
		// concurrent same-issue parent could observe "no active record" and
		// double-spawn. collectForeignActiveQa is synchronous; the only awaits
		// (Lead alert on the skip path, stale-QA closes) happen after the outcome
		// is already durable.
		const foreign = this.collectForeignActiveQa(session);
		if (foreign.owned) {
			const rec = foreign.owned;
			this.warn(
				`gate③ skip ${session.execution_id} (${session.issue_id}) @ ${sha.slice(0, 8)} — issue already has an active QA (record ${rec.parent_execution_id} @ ${rec.target_pr_head_sha.slice(0, 8)}, status ${rec.status})`,
			);
			await this.deps.effects.alertLeadPipelineError({
				session,
				issueId: session.issue_id,
				projectName: session.project_name,
				reason: `auto-QA NOT spawned for ${session.issue_id}: another live session (${rec.parent_execution_id}) already has an active QA (${rec.qa_issue_identifier ?? rec.qa_issue_id ?? "no QA issue yet"}, status ${rec.status}). Two concurrent review-gated sessions on one issue — please resolve.`,
			});
			return;
		}

		// Held-first, atomic: claim BEFORE spawning so no relayer can observe the
		// parent as an ordinary review gate, and concurrent awaiting_review events
		// spawn QA exactly once.
		const claimed = this.deps.store.claimAutoQaRecord({
			parentExecutionId: session.execution_id,
			targetPrHeadSha: sha,
			issueId: session.issue_id,
			projectName: session.project_name,
			enrollmentSource: manualEnrollment ? "manual" : "auto",
		});
		if (!claimed) {
			// A superseded/terminal row for this exact head already exists (rare:
			// reconcile superseded it, parent re-entered on the same head). Reopen it
			// for a fresh QA rather than silently skipping (which would leak the gate).
			const reopened = this.deps.store.reopenAutoQaRecordForRespawn(
				session.execution_id,
				sha,
			);
			this.log(
				`reopen ${session.execution_id} @ ${sha.slice(0, 8)} for re-spawn (reopened=${reopened})`,
			);
			if (!reopened) return;
		}

		// Gate ③ stale-QA cleanup — only AFTER the claim above is durable (Codex
		// R1 HIGH-1: a concurrent same-issue parent must always observe either the
		// stale record or this fresh claim, never a gap), and DETACHED (Codex R2
		// HIGH-1: closeRunner's Terminal path can hang with no exec timeout; a
		// best-effort cleanup must never sit on the fresh parent's spawn critical
		// path — with the claim already written, a hung close would otherwise
		// wedge a legitimate flow with no QA runner). Attempted once; failures are
		// logged, never propagated.
		for (const qa of foreign.staleQaToClose) {
			void Promise.resolve(
				this.deps.effects.closeQaRunner({
					qaSession: qa,
					reason: `auto-QA superseded for ${session.issue_id} — a new session (${session.execution_id}) reached review`,
				}),
			).catch((err) => {
				this.warn(
					`gate③ stale QA close failed for ${qa.execution_id}: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		}

		await this.spawnQa(session, sha);
	}

	/**
	 * FLY-827: the Codex code-review hard-gate hold. A main session reached
	 * awaiting_review but Codex has NOT approved the current head → re-queue the
	 * `/codex-code-review` instruction to the runner (D3 loop closure). QA is NOT
	 * spawned and the founder stays held via isReviewHeld.
	 *
	 * FLY-863 (Annie 2026-07-04): this hold is the normal, self-recovering FIRST
	 * step of nearly every PR (Codex simply hasn't run/reported yet) — it must
	 * stay SILENT (no thread post, no Lead alert). Verified against the code: a
	 * Bridge-visible re-hold on a NEW head is the only multi-round signal that
	 * ever reaches here (a runner's own internal `/codex-code-review` retries are
	 * invisible to Bridge — only the final APPROVED is reported), so a "round
	 * count" cannot distinguish a normal in-progress loop from a real stall.
	 * Best-effort: a failure here must never surface the founder (the durable
	 * table + isReviewHeld hold independently).
	 */
	private async codexHold(session: Session, sha: string): Promise<void> {
		// FLY-827 (Codex code-review R1 MED-1): re-queue the instruction ONCE per
		// (exec, head). The LIVE onMainAwaitingReview path claims + queues the
		// first time; a restart / repeated reconcileCodexHolds replays the hold as
		// a no-op (the founder HOLD itself is enforced by the durable record +
		// isReviewHeld, independent of this). A NEW head is a fresh claim → it
		// re-queues for that head.
		const firstNotify = this.deps.store.claimCodexHoldNotify({
			executionId: session.execution_id,
			targetPrHeadSha: sha,
			issueId: session.issue_id,
			projectName: session.project_name,
		});
		if (!firstNotify) {
			this.log(
				`codex-hold ${session.execution_id} (${session.issue_id}) @ ${sha.slice(0, 8)} — already notified for this head; skipping duplicate re-queue`,
			);
			return;
		}
		this.log(
			`codex-hold ${session.execution_id} (${session.issue_id}) @ ${sha.slice(0, 8)} — code review not APPROVED; QA not spawned, founder held`,
		);
		try {
			await this.deps.effects.queueCodexInstruction({ session });
		} catch (err) {
			this.warn(
				`codexHold queueCodexInstruction failed for ${session.issue_id}: ${asErr(err)}`,
			);
		}
	}

	/**
	 * FLY-869 B (决定③): fire the ONE loud "a runner self-merged WITHOUT approval"
	 * Lead alert (→ Discord). The completion sinks call this on the FIRST merge_block
	 * claim (parkMergeBlock returned true → once per head), so it is never re-sent on a
	 * replay / restart. Reuses the pipeline-error alert channel. Best-effort — a failed
	 * alert must never throw into the sink (the durable merge_block marker + isReviewHeld
	 * suppression already hold the session; the alert is the human-visibility layer).
	 */
	async alertMergeWithoutApproval(
		session: Session,
		reason: string,
	): Promise<void> {
		try {
			await this.deps.effects.alertLeadPipelineError({
				session,
				issueId: session.issue_id,
				projectName: session.project_name,
				reason,
			});
		} catch (err) {
			this.warn(
				`alertMergeWithoutApproval failed for ${session.issue_id}: ${asErr(err)}`,
			);
		}
	}

	/**
	 * FLY-1505: surface a failed/stalled ship attempt whose blocked completion
	 * was deflected so the live founder approval remains usable. The durable
	 * recovery fact lives in session_params; this notification is best-effort.
	 */
	async alertShipAttemptFailed(
		session: Session,
		reason: string,
	): Promise<void> {
		if (!this.deps.effects.alertShipAttemptFailed) {
			this.warn(`alertShipAttemptFailed has no sink for ${session.issue_id}`);
			return;
		}
		try {
			await this.deps.effects.alertShipAttemptFailed({
				session,
				reason,
			});
		} catch (err) {
			this.warn(
				`alertShipAttemptFailed failed for ${session.issue_id}: ${asErr(err)}`,
			);
		}
	}

	async alertCompleteMarkerHeld(args: CompleteMarkerHeldAlert): Promise<void> {
		if (!this.deps.effects.alertCompleteMarkerHeld) {
			throw new Error("complete-marker alert sink unavailable");
		}
		await this.deps.effects.alertCompleteMarkerHeld(args);
	}

	/**
	 * FLY-827: a Codex CODE review verdict arrived (from `await-codex-gate code` →
	 * `codex_review_result` event). Validate + record the durable approval, then —
	 * to close the complete-before-report race — if the parent is already
	 * awaiting_review on this exact head, re-drive onMainAwaitingReview with
	 * codexReleased:true so QA spawns now (it was codex-held). Only the `code`
	 * review gates; a design verdict is ignored here.
	 */
	async onCodexReviewResult(event: QaResultEvent): Promise<void> {
		const payload = (event.payload ?? {}) as Record<string, unknown>;
		const reviewType = asString(payload.reviewType);
		const status = asString(payload.status);
		const sha = asString(payload.prHeadSha)?.toLowerCase();
		const targetExec =
			asString(payload.targetExecutionId) ?? event.execution_id;

		if (reviewType !== "code") {
			this.log(`codex_review_result ignored — reviewType=${reviewType ?? "?"}`);
			return;
		}
		if (status !== "APPROVED") {
			this.log(
				`codex_review_result ignored — status=${status ?? "?"} (not APPROVED)`,
			);
			return;
		}
		if (!sha || !FULL_SHA.test(sha)) {
			this.warn(
				`codex_review_result ignored — missing/invalid prHeadSha (${sha ?? "none"})`,
			);
			return;
		}
		const session = this.deps.store.getSession(targetExec);
		// FLY-827 + FLY-793: accept the PR-owning reviewable roles (main + the
		// DAG workflow `implement` phase). A `qa` verdict is not gated here.
		if (!session || !isReviewableRole(session.session_role)) {
			this.warn(
				`codex_review_result ignored — ${targetExec} is unknown or not a reviewable (main/implement) session`,
			);
			return;
		}

		this.deps.store.recordCodexReviewApproved({
			executionId: targetExec,
			targetPrHeadSha: sha,
			issueId: session.issue_id,
			projectName: session.project_name,
			verdictEventId: event.event_id,
			reviewedTarget: asString(payload.reviewedTarget),
			codexThreadId: asString(payload.codexThreadId),
			rounds:
				typeof payload.rounds === "number"
					? (payload.rounds as number)
					: undefined,
			// FLY-1188 §7.3: this event path IS the claude-author→codex-reviewer
			// lane (`await-codex-gate code` → codex_review_result). Stamp the
			// author family from the persisted adapter_type — payloads are
			// runner-writable and never trusted for identity.
			authorFamily: adapterTypeToFamily(session.adapter_type),
			reviewerFamily: "codex",
		});
		this.log(
			`codex code review APPROVED recorded for ${session.issue_id} (${targetExec}) @ ${sha.slice(0, 8)}`,
		);

		// Race closure (plan §3.2 #1): `complete --route needs_review` may have
		// landed BEFORE this verdict (the session is already awaiting_review and was
		// codex-held). Re-drive so QA spawns now — codexReleased forces the first spawn.
		if (
			session.status === "awaiting_review" &&
			session.pr_head_sha?.toLowerCase() === sha
		) {
			await this.onMainAwaitingReview(session, { codexReleased: true });
		}
	}

	/**
	 * FLY-846 gate ①: is this session's ISSUE itself a QA issue? Detected by the
	 * generated title prefix (`QA · <ident>` — auto-qa-effects; the same prefix
	 * convention is used for hand-created QA issues) or by the durable
	 * qa_issue_id / qa_issue_identifier columns (survives a retitle; issue keys
	 * are UUID/identifier mixed-form in production, so both session keys are
	 * checked).
	 */
	private isQaIssueSession(session: Session): boolean {
		if (/^\s*QA\s*·/.test(session.issue_title ?? "")) return true;
		const keys = [session.issue_id, session.issue_identifier].filter(
			(k): k is string => !!k,
		);
		return this.deps.store.isAutoQaIssue(keys);
	}

	/**
	 * FLY-846 gate ③ resolution — SYNCHRONOUS on purpose (Codex R1 HIGH-1): the
	 * caller must go from this check to its own claim with no await in between,
	 * or a concurrent same-issue parent could observe "no active record" and
	 * double-spawn.
	 *
	 * Returns `owned` when another parent execution still owns an active QA for
	 * this issue (reconcile-verbatim predicate: awaiting_review AND still on the
	 * record's reviewed head) — the caller skips + Lead-alerts. Stale foreign
	 * records (owner moved on / terminal / missing / head drift) are superseded
	 * HERE (synchronous DB write); their still-live QA sessions are returned in
	 * `staleQaToClose` for the caller to close AFTER its claim is durable.
	 */
	private collectForeignActiveQa(session: Session): {
		owned?: AutoQaRecord;
		staleQaToClose: Session[];
	} {
		const issueKeys = [session.issue_id, session.issue_identifier].filter(
			(k): k is string => !!k,
		);
		const foreign = this.deps.store.listActiveAutoQaRecordsForIssue({
			issueKeys,
			excludeParentExecutionId: session.execution_id,
		});
		const staleQaToClose: Session[] = [];
		for (const rec of foreign) {
			const otherParent = this.deps.store.getSession(rec.parent_execution_id);
			const parentStillOwnsRecord =
				otherParent?.status === "awaiting_review" &&
				otherParent.pr_head_sha?.toLowerCase() === rec.target_pr_head_sha;
			if (parentStillOwnsRecord) {
				return { owned: rec, staleQaToClose };
			}
			// Stale — the other parent moved on / ended. Supersede now (sync);
			// close later (caller, post-claim).
			this.log(
				`gate③ supersede stale record ${rec.parent_execution_id} @ ${rec.target_pr_head_sha.slice(0, 8)} for ${session.issue_id} (owner is ${otherParent?.status ?? "gone"})`,
			);
			this.deps.store.setAutoQaStatus(
				rec.parent_execution_id,
				rec.target_pr_head_sha,
				"superseded",
				{},
			);
			const oldQa = rec.qa_execution_id
				? this.deps.store.getSession(rec.qa_execution_id)
				: undefined;
			if (oldQa && !TERMINAL_STATUSES.has(oldQa.status ?? "")) {
				staleQaToClose.push(oldQa);
			}
		}
		return { staleQaToClose };
	}

	/**
	 * FLY-752: drive a RE-TEST on a new head, reusing the same QA runner/issue.
	 * RETARGET the owner record (running + durable retest marker), then either wake
	 * the alive QA runner (`retest_wake`) or — if it already ended (a prior PASS
	 * closed it, or it died) — re-spawn a fresh QA into the SAME QA issue. On a wake
	 * that does NOT land, the founder stays HELD and the durable marker is kept so
	 * reconcile re-drives it — the gate is never silently released.
	 */
	private async driveRetest(
		session: Session,
		owner: AutoQaRecord,
		newSha: string,
	): Promise<void> {
		const retargeted = this.deps.store.retargetAutoQaRecord({
			parentExecutionId: session.execution_id,
			oldSha: owner.target_pr_head_sha,
			newSha,
			expectStatuses: [
				"running",
				"awaiting_retest",
				"passed",
				"stuck",
				"failed",
			],
		});
		if (!retargeted) {
			this.log(
				`retest skipped for ${session.issue_id} @ ${newSha.slice(0, 8)} — retarget CAS miss (status drift / concurrent)`,
			);
			return;
		}

		const qa = owner.qa_execution_id
			? this.deps.store.getSession(owner.qa_execution_id)
			: undefined;
		if (qa && !TERMINAL_STATUSES.has(qa.status ?? "")) {
			const wake = await this.deps.effects.retestWakeQa({
				qaSession: qa,
				parentSession: session,
				newSha,
			});
			if (wake.ok) {
				this.deps.store.clearRetestWakePending(session.execution_id, newSha);
				this.log(
					`retest wake OK for ${session.issue_id} @ ${newSha.slice(0, 8)} (QA ${qa.execution_id})`,
				);
				await this.deps.effects.postThread({
					session,
					text: `🧪 自动 QA 复测新 head \`${newSha.slice(0, 8)}\` — 同一个 QA Runner(不重开)。QA 全绿前不打扰 founder。`,
				});
				await this.safeStampIssueStage(session, "test");
			} else {
				// Wake did NOT land — hold the founder, keep the durable marker for
				// reconcile to retry, and tell the Lead. NEVER release the gate.
				this.warn(
					`retest wake FAILED for ${session.issue_id} @ ${newSha.slice(0, 8)}: ${wake.error ?? "unknown"} — held for reconcile retry`,
				);
				await this.deps.effects.alertLeadPipelineError({
					session,
					issueId: session.issue_id,
					projectName: session.project_name,
					reason: `auto-QA retest wake failed for ${session.issue_id} (QA ${qa.execution_id}): ${wake.error ?? "unknown"}. Founder held; reconcile will retry.`,
				});
			}
			return;
		}

		// QA runner already ended (prior PASS closed it, or it died). Claim the SAME
		// bounded recovery state as the event/sweep path; never launch inline while a
		// dying dispatcher may still own issue:qa.
		this.log(
			`retest recovery queued for ${session.issue_id} @ ${newSha.slice(0, 8)} — prior QA runner ended`,
		);
		if (owner.qa_execution_id) {
			await this.onQaSessionFailed(owner.qa_execution_id);
		} else {
			await this.spawnQa(session, newSha);
		}
	}

	/**
	 * Spawn (or re-spawn) the QA Runner for an already-claimed record.
	 *
	 * FLY-643: QA now runs on a SEPARATE `QA·FLY-XX` Linear issue (its own issue +
	 * thread + runner), not the parent's. The QA issue is created lazily here and
	 * persisted on the record BEFORE the runner spawns, so a crash mid-spawn lets
	 * reconcile re-use it (no duplicate issue) on the next pass.
	 */
	private async spawnQa(
		session: Session,
		sha: string,
		opts?: { retryAttemptId?: string },
	): Promise<"launched" | "failed"> {
		// Resolve (or create) the separate QA Linear issue. A record that already
		// carries a qa_issue_id is a reconcile re-spawn → re-use it, never create a
		// second issue.
		const record = this.deps.store.getAutoQaRecord(session.execution_id, sha);
		let qaIssue: QaIssueRef | undefined = record?.qa_issue_id
			? {
					issueId: record.qa_issue_id,
					issueIdentifier: record.qa_issue_identifier,
					issueTitle: record.qa_issue_title,
					issueUrl: record.qa_issue_url,
				}
			: undefined;

		if (!qaIssue) {
			try {
				qaIssue =
					(await this.deps.effects.createQaIssue({
						parent: session,
						prHeadSha: sha,
					})) ?? undefined;
			} catch (err) {
				qaIssue = undefined;
				this.warn(
					`createQaIssue threw for ${session.issue_id} @ ${sha.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
			if (!qaIssue?.issueId) {
				// FAIL-CLOSED: no QA issue ⇒ no QA runner. Held parent → Lead-only
				// alert, founder not surfaced.
				this.warn(
					`createQaIssue FAILED for ${session.issue_id} @ ${sha.slice(0, 8)} — marking stuck`,
				);
				if (opts?.retryAttemptId) {
					this.deps.store.failAutoQaRetryLaunch(
						session.execution_id,
						sha,
						opts.retryAttemptId,
					);
				} else {
					this.deps.store.setAutoQaStatus(
						session.execution_id,
						sha,
						"stuck",
						{},
					);
				}
				await this.deps.effects.alertLeadPipelineError({
					session,
					issueId: session.issue_id,
					projectName: session.project_name,
					reason: `auto-QA could not create the QA issue for ${session.issue_id}. Held — founder NOT surfaced.`,
				});
				return "failed";
			}
			// Persist BEFORE spawning so a crash mid-spawn re-uses this QA issue.
			this.deps.store.setAutoQaIssue(session.execution_id, sha, qaIssue);
		}

		const qaContext: QaContext = {
			parentExecutionId: session.execution_id,
			prHeadSha: sha,
			prNumber: session.pr_number,
			branch: session.branch,
			parentIssueIdentifier: session.issue_identifier,
			parentIssueUrl: session.issue_url,
		};
		try {
			const result = await this.deps.startDispatcher.start({
				// FLY-643: spawn on the SEPARATE QA issue, not the parent.
				issueId: qaIssue.issueId,
				issueIdentifier: qaIssue.issueIdentifier,
				issueTitle: qaIssue.issueTitle,
				issueUrl: qaIssue.issueUrl,
				projectName: session.project_name,
				sessionRole: "qa",
				agentName: this.qaAgentName,
				// Parent labels flow for Lead/thread routing; the backend is pinned
				// to the transported Claude lane via ignoreRunnerLabelSelection so a
				// vendor label (agy/kimi/codex) can't pick the QA backend (FLY-643).
				issueLabels: parseIssueLabels(session.issue_labels),
				ignoreRunnerLabelSelection: true,
				// FLY-752: the QA runner MUST be mailbox-capable so `retest_wake` can
				// reach it across the fix loop. A project whose runner role / env
				// default is no-transport (antigravity/kimi) would otherwise spawn a QA
				// that can never be re-woken → wedge the founder gate after the first
				// FAIL. buildRunnerSpawnFields forces a Claude lane when this is set.
				requireMailboxTransport: true,
				// Auto-QA always gets a clean, role-scoped worktree. Explicit false plus
				// RunDispatcher's qaContext resume bypass prevents phase takeover.
				shareParentBranch: false,
				successorExecutionId: opts?.retryAttemptId,
				startPoint: sha,
				// FLY-1356 (R1#3): the QA runner inherits the implement session's arm
				// — one issue, one arm end to end; the separate QA·issue must never
				// hash itself into a different bucket.
				...(session.skill_framework_mode && {
					skillFrameworkModeParent: session.skill_framework_mode,
				}),
				qaContext,
			});
			if (opts?.retryAttemptId && result.executionId !== opts.retryAttemptId) {
				throw new Error(
					`dispatcher returned ${result.executionId}, expected durable successor ${opts.retryAttemptId}`,
				);
			}
			if (opts?.retryAttemptId) {
				const bound = this.deps.store.completeAutoQaRetryLaunch(
					session.execution_id,
					sha,
					opts.retryAttemptId,
					result.executionId,
				);
				if (!bound) {
					// The physical launch succeeded. Do not misclassify it as a definite
					// spawn failure: the next sweep adopts this exact pre-bound id.
					this.warn(
						`retry launch ${opts.retryAttemptId} started but record binding changed; reconcile will adopt it`,
					);
				}
			} else {
				this.deps.store.setAutoQaQaExecutionId(
					session.execution_id,
					sha,
					result.executionId,
				);
			}
			// FLY-752: this spawn covers the record's current head → the retest wake
			// (if this was a re-spawn after retarget) is satisfied. Clear the marker.
			this.deps.store.clearRetestWakePending(session.execution_id, sha);
			this.log(
				`spawned QA ${result.executionId} on ${qaIssue.issueIdentifier ?? qaIssue.issueId} for ${session.issue_id} @ ${sha.slice(0, 8)} (parent ${session.execution_id})`,
			);
			const qaRef = qaIssue.issueIdentifier ?? qaIssue.issueId;
			await this.deps.effects.postThread({
				session,
				text: `🧪 自动 QA 开始 — 独立 Runner 在单独的 QA issue ${qaRef} 上验证此 PR（reviewed commit \`${sha.slice(0, 8)}\`）。QA 全绿前不会打扰 founder。`,
			});
			// FLY-630 ②: reflect the issue's real pipeline stage on the PARENT thread —
			// QA is now running, so the badge becomes 🧪QA (not the frozen ⏳待批 from
			// the implementer's approve stage). Best-effort — never fails the spawn.
			await this.safeStampIssueStage(session, "test");
			return "launched";
		} catch (err) {
			// NEVER leave a held parent with no QA runner. Mark stuck + Lead-only
			// alert; the founder is not surfaced (held), the Lead investigates. The
			// QA issue stays recorded so a manual re-drive can re-use it.
			const msg = err instanceof Error ? err.message : String(err);
			this.warn(
				`spawn FAILED for ${session.issue_id} @ ${sha.slice(0, 8)}: ${msg} — claiming bounded recovery`,
			);
			let queuedInitialRetry = false;
			if (opts?.retryAttemptId) {
				this.deps.store.failAutoQaRetryLaunch(
					session.execution_id,
					sha,
					opts.retryAttemptId,
				);
			} else {
				queuedInitialRetry = this.deps.store.claimAutoQaRetryAfterSpawnFailure(
					session.execution_id,
					sha,
				);
				if (!queuedInitialRetry) {
					this.deps.store.setAutoQaStatus(
						session.execution_id,
						sha,
						"stuck",
						{},
					);
				}
			}
			await this.deps.effects.alertLeadPipelineError({
				session,
				issueId: session.issue_id,
				projectName: session.project_name,
				reason: queuedInitialRetry
					? `auto-QA spawn failed for ${session.issue_id} (QA issue ${qaIssue.issueIdentifier ?? qaIssue.issueId}): ${msg}; automatic retry queued (1/1). Founder remains held.`
					: `auto-QA spawn failed for ${session.issue_id} (QA issue ${qaIssue.issueIdentifier ?? qaIssue.issueId}): ${msg}. Held — founder NOT surfaced.`,
			});
			return "failed";
		}
	}

	/**
	 * (b) A QA verdict arrived. Validate, then release (PASS) or loop back (FAIL).
	 */
	async onQaResult(event: QaResultEvent): Promise<void> {
		const payload = (event.payload ?? {}) as Record<string, unknown>;
		const status = asString(payload.status);
		const targetExec = asString(payload.targetExecutionId);
		const reportedQaExec =
			asString(payload.qaExecutionId) ?? event.execution_id;
		const reportedSha = asString(payload.prHeadSha)?.toLowerCase();
		const summary = asString(payload.summary) ?? "(no summary provided)";

		if (status !== "pass" && status !== "fail") {
			this.warn(`qa_result with invalid status="${status}" — ignoring`);
			return;
		}
		if (!targetExec) {
			this.warn("qa_result without targetExecutionId — ignoring");
			return;
		}

		const parent = this.deps.store.getSession(targetExec);
		if (!parent) {
			this.warn(`qa_result for unknown parent ${targetExec} — ignoring`);
			return;
		}

		// Parent-state guard (plan §3.3 / Codex R2): only an awaiting_review parent
		// can be gated. If it moved on (approved / merged / completed / blocked, or
		// a re-review happened elsewhere), the verdict is moot — ignore it without
		// notifying the founder or waking anyone.
		if (parent.status !== "awaiting_review") {
			this.log(
				`qa_result for ${targetExec} ignored — parent is ${parent.status}, not awaiting_review`,
			);
			return;
		}

		// Linkage: the reporting session must be a QA session. FLY-643: it runs on
		// its OWN separate `QA·FLY-XX` issue now, so we no longer require
		// `qaSession.issue_id === parent.issue_id` — the AUTHORITATIVE binding is
		// `record.qa_execution_id === reportedQaExec` (checked below), which ties
		// the verdict to the EXACT QA runner this record spawned (strictly stronger
		// than an issue-equality check). Here we only reject a non-QA session.
		const qaSession = this.deps.store.getSession(reportedQaExec);
		if (!qaSession || (qaSession.session_role ?? "main") !== "qa") {
			await this.deps.effects.alertLeadPipelineError({
				session: parent,
				issueId: parent.issue_id,
				projectName: parent.project_name,
				reason: `auto-QA: rejected a qa_result from ${reportedQaExec} (not a QA session). Ignored.`,
			});
			return;
		}

		// Freshness (Codex R1 HIGH-2): the verdict MUST carry a valid 40-hex
		// prHeadSha that equals the parent's CURRENT reviewed head. A MISSING sha
		// no longer slips through — it is rejected, not silently accepted (the
		// qa-result CLI makes prHeadSha optional, so a foreign/stale QA session
		// could otherwise omit it and release the gate).
		let parentSha = parent.pr_head_sha?.toLowerCase();
		if (!parentSha || !reportedSha || !FULL_SHA.test(reportedSha)) {
			this.log(
				`dropping stale/unbound qa_result for ${targetExec}: verdict head ${reportedSha ?? "(missing)"} != parent head ${parentSha ?? "?"}`,
			);
			return;
		}
		if (reportedSha !== parentSha) {
			// FLY-945 Fix B: a PASS verdict whose head moved FORWARD on the same
			// branch (QA-evidence commit) re-aims the ship gate instead of dying
			// (FLY-921: the Bridge held the proof and dropped it). Every rebind
			// condition is fail-closed; any miss → the exact pre-FLY-945 drop.
			const rebound = await this.tryShipGateRebind({
				parent,
				oldSha: parentSha,
				newSha: reportedSha,
				reportedQaExec,
				verdictStatus: status,
			});
			if (!rebound) {
				this.log(
					`dropping stale/unbound qa_result for ${targetExec}: verdict head ${reportedSha} != parent head ${parentSha}`,
				);
				return;
			}
			// Session + record now follow the reported head; this SAME verdict
			// releases below (no second qa_result needed).
			parentSha = reportedSha;
		} else if (status === "pass") {
			// FLY-945 Fix B retry hook: a prior rebind updated the session head but
			// the thread follow-up failed → the ✅-reaction anchor is missing. Redo
			// notify+binding only (idempotent; no-op unless the durable
			// notify-failed marker exists and the current head is still unanchored).
			await this.maybeRedoRebindAnchor(parent, parentSha);
		}

		const record = this.deps.store.getAutoQaRecord(targetExec, parentSha);
		if (!record) {
			this.warn(
				`qa_result for ${targetExec} @ ${parentSha.slice(0, 8)} has no AutoQaRecord — ignoring`,
			);
			return;
		}

		// Bind the verdict to the EXACT QA Runner this record spawned (Codex R1
		// HIGH-2) — not merely "some QA session for the issue". A foreign or stale
		// QA session (even same-issue) must never release THIS parent's gate. The
		// backfill of qa_execution_id is synchronous right after spawn, long before
		// any QA run could finish, so a null here is a real anomaly → reject.
		if (record.qa_execution_id !== reportedQaExec) {
			await this.deps.effects.alertLeadPipelineError({
				session: parent,
				issueId: parent.issue_id,
				projectName: parent.project_name,
				reason: `auto-QA: rejected qa_result from ${reportedQaExec} — record for ${parent.issue_id} @ ${parentSha.slice(0, 8)} expects QA ${record.qa_execution_id ?? "(none)"}. Ignored.`,
			});
			return;
		}

		// Idempotency + fail-closed (Codex R2 HIGH): `running` is the ONLY state
		// that accepts a verdict. passed/failed are duplicates; `stuck` (a
		// lost-verdict episode that reconcile already flagged to the Lead) and
		// `superseded` (an older head) MUST NOT be auto-released by a late or
		// replayed verdict — a stuck record is Lead-only, never silently passed.
		if (record.status !== "running") {
			this.log(
				`qa_result for ${targetExec} ignored — record is ${record.status} (only a running record accepts a verdict)`,
			);
			return;
		}

		if (status === "pass") {
			this.deps.store.setAutoQaStatus(targetExec, parentSha, "passed", {
				verdictEventId: event.event_id,
			});
			this.log(
				`QA PASS for ${parent.issue_id} (${targetExec}) — releasing founder ship-ready notification + closing QA`,
			);
			await this.deps.effects.notifyShipReady({ session: parent, record });
			// FLY-630 ②: QA is green — the issue is now genuinely awaiting the founder.
			// Re-stamp the parent thread back to the approve badge (⏳待批).
			await this.safeStampIssueStage(parent, "approve");
			// FLY-752: QA passed → the fix loop is done. Auto-cleanup the QA runner
			// (cmux workspace + tmux + Terminal tab + FLY-369 archive + CommDB row)
			// so it never lingers/accumulates. Best-effort; a close failure is picked
			// up by reconcile (listPassedAutoQaRecords + live QA → close).
			await this.deps.effects.closeQaRunner({
				qaSession,
				reason: `auto-QA passed for ${parent.issue_id}`,
			});
			// Mark notified only AFTER the notification fired, so a crash in between
			// leaves it passed-but-unnotified for reconcile to re-notify.
			this.deps.store.setAutoQaStatus(targetExec, parentSha, "passed", {
				notifiedAt: true,
			});
		} else {
			// FLY-752: FAIL no longer TERMINATES the QA. The record goes to the
			// non-terminal `awaiting_retest` hold state and the QA runner is kept
			// ALIVE (it self-`declare-state park`s + releases heavy resources). When
			// the implementer pushes a new head, onMainAwaitingReview retargets this
			// record + `retest_wake`s the SAME QA runner (fix-loop reuse; never a
			// fresh QA2). The founder stays held (status != passed).
			this.deps.store.setAutoQaStatus(
				targetExec,
				parentSha,
				"awaiting_retest",
				{
					verdictEventId: event.event_id,
				},
			);
			this.log(
				`QA FAIL for ${parent.issue_id} (${targetExec}) — waking implementer, QA parked for retest, founder NOT notified`,
			);
			await this.deps.effects.feedbackWakeMain({ session: parent, summary });
			// FLY-630 ②: QA failed → the implementer is being woken to fix. Reflect
			// that on the parent thread (🔨实现中), not a stale 🧪QA.
			await this.safeStampIssueStage(parent, "implement");
			// FLY-643: a QA FAIL is Lead-facing — post to the QA issue's OWN thread,
			// NOT the parent thread (the founder watches the parent thread; surfacing
			// a non-green QA there would violate "don't bother the founder before QA
			// is green"). The implementer is woken above; the Lead drives the
			// dev-fix → QA-retest loop and only escalates on a real deadlock.
			await this.deps.effects.postThread({
				session: qaSession,
				text: `🔴 自动 QA 未通过 → 已把报告交回实现 Runner 修复,QA Runner 保活等复测(同一个,不重开;founder 不打扰)。\n${truncate(summary, 600)}`,
			});
		}
	}

	/**
	 * FLY-1279 B2 event quick path. Ownership is intentionally checked before
	 * the state CAS: a duplicate/historical auto-QA failure is still consumed and
	 * must never fall through into the DAG workflow QA-loss reconciler. Dispatch is
	 * deferred to the sweep because the dying RunDispatcher entry is still inflight
	 * while session_failed is emitted.
	 */
	async onQaSessionFailed(deadExecutionId: string): Promise<{
		owned: boolean;
		transition: "retry_pending" | "exhausted" | "noop";
	}> {
		const owner = this.deps.store.findAutoQaOwnershipByQaExec(deadExecutionId);
		if (!owner) return { owned: false, transition: "noop" };

		const transition = this.deps.store.markDeadAutoQaExecution(
			owner.parent_execution_id,
			owner.target_pr_head_sha,
			deadExecutionId,
		);
		if (transition === "noop") return { owned: true, transition };

		const parent = this.deps.store.getSession(owner.parent_execution_id);
		const reason =
			transition === "retry_pending"
				? `auto-QA ${deadExecutionId} died without a verdict for ${owner.issue_id}; automatic retry queued (1/1). Founder remains held.`
				: `auto-QA ${deadExecutionId} died without a verdict for ${owner.issue_id}; automatic retry exhausted. Founder remains held.`;
		try {
			await this.deps.effects.alertLeadPipelineError({
				session: parent,
				issueId: owner.issue_id,
				projectName: owner.project_name,
				reason,
			});
		} catch (err) {
			this.warn(
				`dead-QA Lead alert failed for ${deadExecutionId}: ${asErr(err)}`,
			);
		}
		return { owned: true, transition };
	}

	/**
	 * Event-independent dead-QA maintenance sweep. Boot and GatePoller share this
	 * single-flight entry so overlapping ticks cannot double-launch a successor.
	 */
	async sweepOrphanedQaRecords(): Promise<void> {
		if (this.qaRecoverySweep) return this.qaRecoverySweep;
		const sweep = this.runOrphanedQaSweep();
		this.qaRecoverySweep = sweep;
		try {
			await sweep;
		} finally {
			if (this.qaRecoverySweep === sweep) this.qaRecoverySweep = undefined;
		}
	}

	private async runOrphanedQaSweep(): Promise<void> {
		// Detect missing/terminal QA sessions. The CAS and alert are shared with the
		// event quick path, so whichever path wins makes the other a quiet no-op.
		for (const rec of this.deps.store.listRunningAutoQaRecords()) {
			if (rec.retest_wake_pending_at) continue;
			const parent = this.deps.store.getSession(rec.parent_execution_id);
			if (
				!parent ||
				parent.status !== "awaiting_review" ||
				parent.pr_head_sha?.toLowerCase() !== rec.target_pr_head_sha
			) {
				this.deps.store.setAutoQaStatus(
					rec.parent_execution_id,
					rec.target_pr_head_sha,
					"superseded",
					{},
				);
				continue;
			}
			if (!rec.qa_execution_id) {
				this.log(
					`reconcile spawn (claimed-unspawned) for ${parent.issue_id} (${rec.parent_execution_id})`,
				);
				await this.spawnQa(parent, rec.target_pr_head_sha);
				continue;
			}
			const qa = this.deps.store.getSession(rec.qa_execution_id);
			if (!qa || TERMINAL_STATUSES.has(qa.status ?? "")) {
				await this.onQaSessionFailed(rec.qa_execution_id);
			}
		}

		// A retry_pending row waits until the dying dispatcher releases issue:qa.
		for (const rec of this.deps.store.listAutoQaRecordsByStatus(
			"retry_pending",
		)) {
			const parent = this.recoveryParent(rec);
			if (!parent) continue;
			if (!this.canLaunchRecovery(rec)) continue;
			const attemptId = randomUUID();
			if (
				!this.deps.store.claimAutoQaRetryLaunch(
					rec.parent_execution_id,
					rec.target_pr_head_sha,
					attemptId,
				)
			) {
				continue;
			}
			await this.spawnQa(parent, rec.target_pr_head_sha, {
				retryAttemptId: attemptId,
			});
		}

		// Crash window: retry_starting was durable before dispatch. Adopt an active
		// successor, or re-drive the exact same id (never allocate QA3).
		for (const rec of this.deps.store.listAutoQaRecordsByStatus(
			"retry_starting",
		)) {
			const parent = this.recoveryParent(rec);
			if (!parent) continue;
			const attemptId = rec.retry_attempt_id;
			if (!attemptId) {
				this.deps.store.setAutoQaStatus(
					rec.parent_execution_id,
					rec.target_pr_head_sha,
					"stuck",
					{},
				);
				continue;
			}
			const successor = this.deps.store.getSession(attemptId);
			if (successor && !TERMINAL_STATUSES.has(successor.status ?? "")) {
				this.deps.store.completeAutoQaRetryLaunch(
					rec.parent_execution_id,
					rec.target_pr_head_sha,
					attemptId,
					attemptId,
				);
				continue;
			}
			if (successor && TERMINAL_STATUSES.has(successor.status ?? "")) {
				this.deps.store.failAutoQaRetryLaunch(
					rec.parent_execution_id,
					rec.target_pr_head_sha,
					attemptId,
				);
				await this.alertRecoveryLaunchFailure(
					parent,
					`durable successor ${attemptId} is already ${successor.status}`,
				);
				continue;
			}
			if (!this.canLaunchRecovery(rec)) continue;
			await this.spawnQa(parent, rec.target_pr_head_sha, {
				retryAttemptId: attemptId,
			});
		}
	}

	private recoveryParent(rec: AutoQaRecord): Session | undefined {
		const parent = this.deps.store.getSession(rec.parent_execution_id);
		if (
			parent &&
			parent.status === "awaiting_review" &&
			parent.pr_head_sha?.toLowerCase() === rec.target_pr_head_sha
		) {
			return parent;
		}
		this.deps.store.setAutoQaStatus(
			rec.parent_execution_id,
			rec.target_pr_head_sha,
			"superseded",
			{},
		);
		return undefined;
	}

	private canLaunchRecovery(rec: AutoQaRecord): boolean {
		const qaIssueId = rec.qa_issue_id;
		const hasInflight = this.deps.startDispatcher.hasInflightForRole;
		if (!qaIssueId || !hasInflight) {
			this.warn(
				`recovery held for ${rec.issue_id}: ${!qaIssueId ? "missing QA issue" : "dispatcher has no inflight probe"}`,
			);
			return false;
		}
		return !hasInflight.call(this.deps.startDispatcher, qaIssueId, "qa");
	}

	private async alertRecoveryLaunchFailure(
		parent: Session,
		detail: string,
	): Promise<void> {
		try {
			await this.deps.effects.alertLeadPipelineError({
				session: parent,
				issueId: parent.issue_id,
				projectName: parent.project_name,
				reason: `auto-QA recovery launch failed for ${parent.issue_id}: ${detail}. Founder remains held.`,
			});
		} catch (err) {
			this.warn(`recovery launch alert failed: ${asErr(err)}`);
		}
	}

	// ── FLY-945 Fix B: ship-gate head rebind ────────────────────────────────

	/** Write-once durable marker that a rebind's thread follow-up failed. */
	private rebindNotifyFailedEventId(
		questionId: string,
		newSha: string,
	): string {
		return `ship-gate-rebind-notify-failed-${questionId}-${newSha}`;
	}

	/**
	 * Attempt the FLY-945 head rebind. ALL conditions must hold (each one
	 * fail-closed; a miss returns false and the caller drops the verdict exactly
	 * as before FLY-945):
	 *  1. seams wired + verdict is a PASS (only a QA-proven head
	 *     deserves the gate);
	 *  2. the parent is awaiting_review (caller-checked) with a REAL bound
	 *     review question (not null / 'unbound');
	 *  3. the reporter passes the SAME record validation the normal path runs —
	 *     the running record for the OLD head must name this exact QA runner
	 *     (no door for a stranger sha);
	 *  4. the gate question has NO response yet (an answered gate's approval is
	 *     frozen on the sha the founder saw; recovery is Fix C's re-review);
	 *  5. `git merge-base --is-ancestor old new` proves same-branch-forward in
	 *     the session worktree (missing worktree → refuse).
	 *
	 * Actions, in order (plan §2.1): update the session head (the text-approval
	 * path is closed-loop from HERE — tryFounderShipApproval computes its
	 * binding from the live session); retarget the auto-QA record so THIS
	 * verdict releases; post the thread follow-up and — only on a confirmed
	 * post — anchor the new `(question, head)` binding revision for the
	 * ✅-reaction path; audit `ship_gate_rebound`.
	 */
	private async tryShipGateRebind(args: {
		parent: Session;
		oldSha: string;
		newSha: string;
		reportedQaExec: string;
		verdictStatus: "pass" | "fail";
	}): Promise<boolean> {
		const { parent, oldSha, newSha, reportedQaExec } = args;
		if (args.verdictStatus !== "pass") return false;
		const seams = this.deps.shipGateRebind;
		if (!seams) return false; // not wired → byte-compatible drop

		const qid = parent.review_question_id;
		if (!qid || qid === REVIEW_BINDING_UNBOUND) return false;

		const record = this.deps.store.getAutoQaRecord(parent.execution_id, oldSha);
		if (
			!record ||
			record.status !== "running" ||
			record.qa_execution_id !== reportedQaExec
		) {
			return false;
		}

		try {
			if (
				seams.hasGateResponse({
					projectName: parent.project_name,
					questionId: qid,
				})
			) {
				return false; // approval already frozen on the old sha → Fix C path
			}
		} catch {
			return false;
		}

		const worktree = parent.worktree_path;
		if (!worktree) return false; // cannot prove ancestry → fail-closed
		try {
			if (!seams.isAncestor({ worktreePath: worktree, oldSha, newSha })) {
				return false;
			}
		} catch {
			return false;
		}

		// ── all conditions hold → act ──
		if (
			!this.deps.store.setSessionPrHeadShaForRebind(parent.execution_id, newSha)
		) {
			// Concurrent status flip (e.g. an approval landed this instant) — the
			// WHERE-status guard made this a no-op. Treat as not rebound.
			return false;
		}
		// Record follows the head so the CURRENT verdict releases normally. A CAS
		// miss here leaves the approval path fixed but the verdict unconsumable
		// this round — log it (the runner's re-sent qa_result covers it).
		const retargeted = this.deps.store.retargetAutoQaRecord({
			parentExecutionId: parent.execution_id,
			oldSha,
			newSha,
			expectStatuses: ["running"],
		});
		if (retargeted) {
			// We consume the verdict synchronously — no retest wake is wanted.
			this.deps.store.clearRetestWakePending(parent.execution_id, newSha);
		} else {
			this.warn(
				`ship-gate rebind for ${parent.issue_id}: record retarget ${oldSha.slice(0, 8)}→${newSha.slice(0, 8)} CAS-missed (approval path is re-aimed; verdict release waits for a re-sent qa_result)`,
			);
		}

		const messageId = await this.ensureRebindAnchor(
			parent,
			qid,
			oldSha,
			newSha,
		);

		this.deps.store.insertEvent({
			event_id: `ship-gate-rebound-${qid}-${newSha}`,
			execution_id: parent.execution_id,
			issue_id: parent.issue_id,
			project_name: parent.project_name,
			event_type: "ship_gate_rebound",
			source: "bridge.auto-qa-coordinator",
			payload: {
				questionId: qid,
				oldSha,
				newSha,
				gateMessageId: messageId ?? undefined,
			},
		});
		this.log(
			`ship-gate REBOUND for ${parent.issue_id} (${parent.execution_id}): ${oldSha.slice(0, 8)} → ${newSha.slice(0, 8)} (QA PASS evidence commit)${messageId ? "" : " — thread anchor pending retry"}`,
		);
		return true;
	}

	/**
	 * Post the rebind follow-up + anchor the new `(question, head)` binding
	 * revision. Product semantics: after a rebind, a founder ✅ on the OLD gate
	 * message is a mismatch no-op (that message names the old sha — fail-closed
	 * correct); THIS follow-up message is the new reactable object. Returns the
	 * anchored message id, or null when the anchor is still missing (a durable
	 * write-once `ship_gate_rebind_notify_failed` marker then arms
	 * `maybeRedoRebindAnchor` for the next PASS qa_result).
	 */
	private async ensureRebindAnchor(
		parent: Session,
		questionId: string,
		oldSha: string,
		newSha: string,
	): Promise<string | null> {
		const markFailed = (reason: string) => {
			this.deps.store.insertEvent({
				event_id: this.rebindNotifyFailedEventId(questionId, newSha),
				execution_id: parent.execution_id,
				issue_id: parent.issue_id,
				project_name: parent.project_name,
				event_type: "ship_gate_rebind_notify_failed",
				source: "bridge.auto-qa-coordinator",
				payload: { questionId, oldSha, newSha, reason },
			});
			this.warn(
				`ship-gate rebind follow-up NOT anchored for ${parent.issue_id} (${reason}) — reaction path fail-closed on ${newSha.slice(0, 8)} until retried; text approval unaffected`,
			);
		};

		const notify = this.deps.effects.notifyShipGateRebound;
		if (!notify) {
			markFailed("no_notifier");
			return null;
		}
		try {
			const res = await notify({ session: parent, oldSha, newSha });
			if (!res.ok || !res.messageId || !res.threadId) {
				markFailed("post_failed");
				return null;
			}
			// Anchor only AFTER the post is confirmed (Codex R2 #3: the binding row
			// must carry a REAL gateMessageId — never write-then-send).
			writeGateMessageBinding(
				this.deps.store,
				{
					questionId,
					executionId: parent.execution_id,
					issueId: parent.issue_id,
					prHeadSha: newSha,
					threadId: res.threadId,
					gateMessageId: res.messageId,
					checkpoint: "approve_to_ship",
					postedAt: new Date(this.deps.now?.() ?? Date.now()).toISOString(),
				},
				parent.project_name,
			);
			return res.messageId;
		} catch (err) {
			markFailed(err instanceof Error ? err.message : String(err));
			return null;
		}
	}

	/**
	 * Retry hook (plan §2.1 #3): the session head already equals the reported
	 * head, but a PRIOR rebind failed to anchor the follow-up message. Redo
	 * notify+binding only. Guarded so it can never fire for a normal session:
	 * requires the durable notify-failed marker for THIS (question, head), no
	 * existing binding for the current head, and a still-unanswered gate.
	 */
	private async maybeRedoRebindAnchor(
		parent: Session,
		sha: string,
	): Promise<void> {
		const seams = this.deps.shipGateRebind;
		if (!seams) return;
		const qid = parent.review_question_id;
		if (!qid || qid === REVIEW_BINDING_UNBOUND) return;

		const failedMarker = this.deps.store
			.getEventsByExecution(parent.execution_id)
			.find((e) => e.event_id === this.rebindNotifyFailedEventId(qid, sha));
		if (!failedMarker) return;
		if (
			readCurrentGateMessageBinding(
				this.deps.store,
				parent.execution_id,
				qid,
				sha,
			)
		) {
			return; // already anchored
		}
		try {
			if (
				seams.hasGateResponse({
					projectName: parent.project_name,
					questionId: qid,
				})
			) {
				return; // approval already landed — no anchor needed
			}
		} catch {
			return;
		}
		const oldSha =
			typeof (failedMarker.payload as Record<string, unknown> | undefined)
				?.oldSha === "string"
				? ((failedMarker.payload as Record<string, unknown>).oldSha as string)
				: "(unknown)";
		await this.ensureRebindAnchor(parent, qid, oldSha, sha);
	}

	/**
	 * FLY-827 (Codex R1 HIGH-4): re-drive codex-hold SIDE-EFFECTS after a Bridge
	 * restart / a default-ON flip. The founder HOLD itself does NOT depend on this
	 * running (it's guaranteed by the durable codex_review_record + isReviewHeld,
	 * timing-independent — same rationale as the auto-QA reconcile, plugin.ts). This
	 * only re-fires the alert + re-queues the /codex-code-review instruction so a
	 * held session isn't silently suppressed with no actionable signal. Idempotent:
	 * the alert eventId is per-(exec, head) so a re-run won't spam.
	 *
	 * Safe to run after the GatePoller/Heartbeat timers start (the hold is already
	 * in effect via the durable predicate).
	 */
	async reconcileCodexHolds(): Promise<void> {
		const env = this.deps.env ?? process.env;
		if (!codexHardGateEnabled(env)) return; // gate off → nothing held
		for (const session of this.deps.store.getActiveSessions()) {
			if ((session.session_role ?? "main") !== "main") continue;
			if (session.status !== "awaiting_review") continue;
			if (session.codex_skip) continue;
			const sha = session.pr_head_sha?.toLowerCase();
			if (!sha || !FULL_SHA.test(sha)) {
				// Missing-head hold (R3-LOW-3): alert (deduped per exec), but do NOT
				// queue a head-specific review — ask for a re-complete with a valid head.
				this.warn(
					`reconcile codex missing-head hold for ${session.issue_id} (${session.execution_id})`,
				);
				try {
					await this.deps.effects.alertCodexGateBlocked({ session });
				} catch (err) {
					this.warn(`reconcile missing-head alert failed: ${asErr(err)}`);
				}
				continue;
			}
			if (isCodexGateSatisfied(this.deps.store, session, sha, env)) continue;
			// A running QA record means codex already passed for this head (QA only
			// spawns past the gate) — leave it to the QA reconcile.
			const rec = this.deps.store.getAutoQaRecord(session.execution_id, sha);
			if (rec?.status === "running") continue;
			this.log(
				`reconcile codex-hold re-fire for ${session.issue_id} (${session.execution_id}) @ ${sha.slice(0, 8)}`,
			);
			await this.codexHold(session, sha);
		}
	}

	/**
	 * (c) Restart reconcile — re-drive in-flight QA. MUST run before the
	 * GatePoller / Heartbeat timers (so a restart never relays a held gate).
	 */
	async reconcileOnStartup(): Promise<void> {
		// (0) FLY-869 A-1b — qa_required BACKFILL (deployment safety). A session
		// dispatched BEFORE this gate shipped ran the pre-gate onMainAwaitingReview,
		// which never wrote the immutable qa_required snapshot. WITHOUT a backfill it
		// reaches the QA ship gate (evaluateQaShipGate) with qa_required=NULL and,
		// for a code PR, fail-closes → stranded. Reconstruct the verdict the forward
		// path would have written, and grandfather already-approved in-flight work so
		// the retroactive gate never strands a session the founder already cleared.
		//
		// Idempotent: setQaRequiredSnapshot's `WHERE qa_required IS NULL` guard means
		// a second restart (or a race with the forward path) is a no-op. Independent
		// of sweeps (1)-(4) below — it touches only qa_required, never auto_qa_records
		// — but runs FIRST so the A-3 orphan sweep sees the backfilled requirement.
		for (const session of this.deps.store.getActiveSessions()) {
			if (
				session.status !== "awaiting_review" &&
				session.status !== "approved_to_ship"
			) {
				continue; // a `running` session snapshots when it reaches onMainAwaitingReview.
			}
			if (session.qa_required != null) continue; // already snapshotted (immutable).

			const rec = this.deps.store.getLatestAutoQaRecordByParent(
				session.execution_id,
			);
			if (rec) {
				// QA genuinely applied (a record exists). Require it: the ship gate
				// checks for a PASSED record for the head (passed→ships, otherwise→held).
				this.deps.store.setQaRequiredSnapshot({
					executionId: session.execution_id,
					required: 1,
					reason: `backfill:record_${rec.status}`,
				});
				continue;
			}

			if (
				this.deps.store.isWorkflowEngineOwnedExecution(session.execution_id)
			) {
				this.deps.store.setQaRequiredSnapshot({
					executionId: session.execution_id,
					required: 0,
					reason: "backfill:exempt:engine_owned",
				});
				continue;
			}

			const policy = this.deps.resolveQaPolicy(session);
			const qid = session.review_question_id;
			const hasReviewEvidence =
				(!!qid && qid !== REVIEW_BINDING_UNBOUND) || session.pr_number != null;
			if (!policy.enabled || !hasReviewEvidence) {
				// Exempt: auto-QA off for this session (no-qa label / qa.auto:false /
				// kill-switch) OR no code PR to QA. Mirrors the forward path's policy-off
				// and no-review-evidence branches; also grandfathers no-PR in-flight work.
				this.deps.store.setQaRequiredSnapshot({
					executionId: session.execution_id,
					required: 0,
					reason: `backfill:exempt:${
						!policy.enabled
							? (policy.reason ?? "policy_off")
							: "no_review_evidence"
					}`,
				});
				continue;
			}

			// Code PR, auto-QA applies, but NO record was ever created (pre-FLY-579
			// dispatch, or codex-held before QA). An `awaiting_review` session self-heals
			// — the A-3 orphan sweep spawns the missing QA — so require it (fail-closed).
			// An `approved_to_ship` session already cleared the founder gate under the
			// pre-gate flow AND is not covered by the awaiting_review orphan sweep, so a
			// retroactive requirement would strand it: grandfather it exempt.
			if (session.status === "approved_to_ship") {
				this.deps.store.setQaRequiredSnapshot({
					executionId: session.execution_id,
					required: 0,
					reason: "backfill:grandfather_approved_pre_gate",
				});
				this.log(
					`A-1b backfill grandfather ${session.execution_id} (${session.issue_id}) — approved_to_ship pre-gate, no QA record; exempt to avoid stranding`,
				);
			} else {
				this.deps.store.setQaRequiredSnapshot({
					executionId: session.execution_id,
					required: 1,
					reason: "backfill:code_pr_no_record",
				});
				this.log(
					`A-1b backfill required ${session.execution_id} (${session.issue_id}) — code PR, no QA record; A-3 orphan sweep will spawn QA`,
				);
			}
		}

		// (1) PASSED records — re-notify if unnotified AND close a QA runner left
		// alive by a crash between notifyShipReady and closeQaRunner (FLY-752). The
		// passed-unnotified sweep alone misses the notified-but-not-closed case, so
		// scan ALL passed records for a still-live QA.
		for (const rec of this.deps.store.listPassedAutoQaRecords()) {
			const parent = this.deps.store.getSession(rec.parent_execution_id);
			const parentOk =
				parent &&
				parent.status === "awaiting_review" &&
				parent.pr_head_sha?.toLowerCase() === rec.target_pr_head_sha;

			if (parentOk && !rec.notified_at) {
				this.log(
					`reconcile re-notify ship-ready for ${parent.issue_id} (${rec.parent_execution_id})`,
				);
				await this.deps.effects.notifyShipReady({
					session: parent,
					record: rec,
				});
				this.deps.store.setAutoQaStatus(
					rec.parent_execution_id,
					rec.target_pr_head_sha,
					"passed",
					{ notifiedAt: true },
				);
			}

			// Close a QA runner the PASS never cleaned up (crash between notify+close).
			if (rec.qa_execution_id) {
				const qa = this.deps.store.getSession(rec.qa_execution_id);
				if (qa && !TERMINAL_STATUSES.has(qa.status ?? "")) {
					this.log(
						`reconcile close passed-but-live QA ${rec.qa_execution_id} for ${rec.issue_id}`,
					);
					await this.deps.effects.closeQaRunner({
						qaSession: qa,
						reason: `auto-QA passed (reconcile cleanup) for ${rec.issue_id}`,
					});
				}
			}
		}

		// (2) Records with a durable retest-wake marker (crash after retarget, before
		// the wake was confirmed) → re-drive: wake the alive QA, or re-spawn a dead
		// one. This is what makes the retest wake durable across a restart (FLY-752).
		for (const rec of this.deps.store.listAutoQaRecordsAwaitingRetestWake()) {
			const parent = this.deps.store.getSession(rec.parent_execution_id);
			if (
				!parent ||
				parent.status !== "awaiting_review" ||
				parent.pr_head_sha?.toLowerCase() !== rec.target_pr_head_sha
			) {
				continue; // handled by the running sweep below (superseded / moot).
			}
			const qa = rec.qa_execution_id
				? this.deps.store.getSession(rec.qa_execution_id)
				: undefined;
			if (qa && !TERMINAL_STATUSES.has(qa.status ?? "")) {
				const wake = await this.deps.effects.retestWakeQa({
					qaSession: qa,
					parentSession: parent,
					newSha: rec.target_pr_head_sha,
				});
				if (wake.ok) {
					this.deps.store.clearRetestWakePending(
						rec.parent_execution_id,
						rec.target_pr_head_sha,
					);
					this.log(
						`reconcile retest-wake redelivered for ${parent.issue_id} (QA ${rec.qa_execution_id})`,
					);
				} else {
					this.warn(
						`reconcile retest-wake still failing for ${parent.issue_id}: ${wake.error ?? "unknown"} — kept pending`,
					);
				}
			} else {
				this.log(
					`reconcile recovery claim (retest, QA dead) for ${parent.issue_id}`,
				);
				if (rec.qa_execution_id) {
					await this.onQaSessionFailed(rec.qa_execution_id);
				} else {
					await this.spawnQa(parent, rec.target_pr_head_sha);
				}
			}
		}

		// (3) Dead/missing QA detection + bounded clean recovery. This is the same
		// single-flight entry GatePoller uses periodically, so boot and maintenance
		// cannot double-launch a successor.
		await this.sweepOrphanedQaRecords();

		// (4) AWAITING_RETEST records (QA reported FAIL, parked for the next head).
		// Parent moved on / gone → superseded (+ close a still-live QA); QA session
		// died while parked → stuck + alert (founder held; a dead parked runner is
		// also reaped by the orphan/crash reaper). QA alive → leave (awaiting head).
		for (const rec of this.deps.store.listAutoQaRecordsByStatus(
			"awaiting_retest",
		)) {
			const parent = this.deps.store.getSession(rec.parent_execution_id);
			const qa = rec.qa_execution_id
				? this.deps.store.getSession(rec.qa_execution_id)
				: undefined;
			const parentGone =
				!parent ||
				parent.status !== "awaiting_review" ||
				parent.pr_head_sha?.toLowerCase() !== rec.target_pr_head_sha;
			if (parentGone) {
				this.deps.store.setAutoQaStatus(
					rec.parent_execution_id,
					rec.target_pr_head_sha,
					"superseded",
					{},
				);
				if (qa && !TERMINAL_STATUSES.has(qa.status ?? "")) {
					await this.deps.effects.closeQaRunner({
						qaSession: qa,
						reason: `auto-QA superseded (reconcile) for ${rec.issue_id}`,
					});
				}
				continue;
			}
			if (!qa || TERMINAL_STATUSES.has(qa.status ?? "")) {
				this.warn(
					`reconcile stuck: parked QA ${rec.qa_execution_id} for ${parent.issue_id} is ${qa?.status ?? "gone"} — cannot retest`,
				);
				this.deps.store.setAutoQaStatus(
					rec.parent_execution_id,
					rec.target_pr_head_sha,
					"stuck",
					{},
				);
				await this.deps.effects.alertLeadPipelineError({
					session: parent,
					issueId: parent.issue_id,
					projectName: parent.project_name,
					reason: `auto-QA stuck for ${parent.issue_id}: parked QA ${rec.qa_execution_id} died before retest. Founder NOT surfaced.`,
				});
			}
			// else QA alive + parked → leave it; awaiting the next head.
		}

		// (5) FLY-869 A-3 — "该起没起 QA" orphan sweep. An awaiting_review main session
		// that reached review WITHOUT ever getting an auto_qa_record is invisible to the
		// record-based sweeps (1)-(4) above — a should-have-QA'd session that nothing is
		// driving. Re-drive the LIVE path so QA spawns (or the session is correctly
		// codex-held / policy-skipped inside onMainAwaitingReview — all its gates still
		// apply). Runs before founder surfacing (reconcileOnStartup precedes the
		// GatePoller / Heartbeat timers), and EXCLUDES a parked merge_block session
		// (决定③ — a merged-but-unapproved session must never be QA'd back into ship).
		for (const session of this.deps.store.getActiveSessions()) {
			if (session.status !== "awaiting_review") continue;
			if ((session.session_role ?? "main") !== "main") continue;
			// A parked merged-but-unapproved session is held, not shippable → never QA it.
			if (session.merge_block_reason) continue;
			// Has ANY auto_qa_record → owned by sweeps (1)-(4); not an orphan.
			if (this.deps.store.getLatestAutoQaRecordByParent(session.execution_id)) {
				continue;
			}
			this.log(
				`A-3 orphan re-drive ${session.execution_id} (${session.issue_id}) — awaiting_review, no auto_qa_record`,
			);
			try {
				// freshTransition:true — an orphan with genuine review evidence IS a
				// legitimate first review-pass; the inner policy / review-evidence /
				// codex gates in onMainAwaitingReview still decide spawn-vs-hold-vs-skip.
				await this.onMainAwaitingReview(session, { freshTransition: true });
			} catch (err) {
				this.warn(
					`A-3 orphan re-drive failed for ${session.issue_id}: ${asErr(err)}`,
				);
			}
		}
	}
}

function parseIssueLabels(raw: string | undefined): string[] {
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

function asString(v: unknown): string | undefined {
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asErr(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}
