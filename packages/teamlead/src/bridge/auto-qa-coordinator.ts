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

import type { AutoQaRecord, Session, StateStore } from "../StateStore.js";
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
}

export interface AutoQaCoordinatorDeps {
	store: StateStore;
	/** Reaches RunDispatcher.start() — the same primitive runs-route uses. */
	startDispatcher: {
		start(req: StartRequest): Promise<{
			executionId: string;
			issueId: string;
		}>;
	};
	/** Per-(project, issue) policy: should auto-QA run for this awaiting_review main session? */
	resolveQaPolicy(session: Session): QaPolicyDecision;
	effects: AutoQaSideEffects;
	/** Reserved QA agent name (AgentDispatcher resolves project-override → shipped). Default "qa". */
	qaAgentName?: string;
	logger?: { log(m: string): void; warn(m: string): void };
}

export class AutoQaCoordinator {
	private readonly qaAgentName: string;

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
	 * (a) A main session just entered awaiting_review. Decide + (if applicable)
	 * spawn independent QA and HOLD the founder. Idempotent + race-safe.
	 */
	async onMainAwaitingReview(session: Session): Promise<void> {
		if ((session.session_role ?? "main") !== "main") return;

		const policy = this.deps.resolveQaPolicy(session);
		if (!policy.enabled) {
			this.log(
				`skip ${session.execution_id} (${session.issue_id}) — auto-QA not enabled: ${policy.reason ?? "policy off"}`,
			);
			return;
		}

		// FAIL-CLOSED: QA MUST be pinned to the exact reviewed commit. A missing /
		// malformed pr_head_sha must NEVER let QA fall back to origin/main — that
		// would verify the wrong code. Pipeline error → Lead only (never founder),
		// and the parent stays in its normal review path (no held record written).
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

		// A new reviewed head supersedes any older still-running record for this
		// parent (a prior QA against a stale head is moot once a new head arrives).
		this.deps.store.supersedeOtherAutoQaRecords(session.execution_id, sha);

		// Held-first, atomic: claim BEFORE spawning so no relayer can observe the
		// parent as an ordinary review gate, and concurrent awaiting_review events
		// spawn QA exactly once.
		const claimed = this.deps.store.claimAutoQaRecord({
			parentExecutionId: session.execution_id,
			targetPrHeadSha: sha,
			issueId: session.issue_id,
			projectName: session.project_name,
		});
		if (!claimed) {
			this.log(
				`dedup ${session.execution_id} @ ${sha.slice(0, 8)} — QA already claimed for this head`,
			);
			return;
		}

		await this.spawnQa(session, sha);
	}

	/**
	 * Spawn (or re-spawn) the QA Runner for an already-claimed record.
	 *
	 * FLY-643: QA now runs on a SEPARATE `QA·FLY-XX` Linear issue (its own issue +
	 * thread + runner), not the parent's. The QA issue is created lazily here and
	 * persisted on the record BEFORE the runner spawns, so a crash mid-spawn lets
	 * reconcile re-use it (no duplicate issue) on the next pass.
	 */
	private async spawnQa(session: Session, sha: string): Promise<void> {
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
				this.deps.store.setAutoQaStatus(session.execution_id, sha, "stuck", {});
				await this.deps.effects.alertLeadPipelineError({
					session,
					issueId: session.issue_id,
					projectName: session.project_name,
					reason: `auto-QA could not create the QA issue for ${session.issue_id}. Held — founder NOT surfaced.`,
				});
				return;
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
				startPoint: sha,
				qaContext,
			});
			this.deps.store.setAutoQaQaExecutionId(
				session.execution_id,
				sha,
				result.executionId,
			);
			this.log(
				`spawned QA ${result.executionId} on ${qaIssue.issueIdentifier ?? qaIssue.issueId} for ${session.issue_id} @ ${sha.slice(0, 8)} (parent ${session.execution_id})`,
			);
			const qaRef = qaIssue.issueIdentifier ?? qaIssue.issueId;
			await this.deps.effects.postThread({
				session,
				text: `🧪 自动 QA 开始 — 独立 Runner 在单独的 QA issue ${qaRef} 上验证此 PR（reviewed commit \`${sha.slice(0, 8)}\`）。QA 全绿前不会打扰 founder。`,
			});
		} catch (err) {
			// NEVER leave a held parent with no QA runner. Mark stuck + Lead-only
			// alert; the founder is not surfaced (held), the Lead investigates. The
			// QA issue stays recorded so a manual re-drive can re-use it.
			const msg = err instanceof Error ? err.message : String(err);
			this.warn(
				`spawn FAILED for ${session.issue_id} @ ${sha.slice(0, 8)}: ${msg} — marking stuck`,
			);
			this.deps.store.setAutoQaStatus(session.execution_id, sha, "stuck", {});
			await this.deps.effects.alertLeadPipelineError({
				session,
				issueId: session.issue_id,
				projectName: session.project_name,
				reason: `auto-QA spawn failed for ${session.issue_id} (QA issue ${qaIssue.issueIdentifier ?? qaIssue.issueId}): ${msg}. Held — founder NOT surfaced.`,
			});
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
		// could otherwise omit it and release the gate). A new head after QA
		// started ⇒ stale ⇒ drop (a fresh record/QA covers the new head).
		const parentSha = parent.pr_head_sha?.toLowerCase();
		if (
			!parentSha ||
			!reportedSha ||
			!FULL_SHA.test(reportedSha) ||
			reportedSha !== parentSha
		) {
			this.log(
				`dropping stale/unbound qa_result for ${targetExec}: verdict head ${reportedSha ?? "(missing)"} != parent head ${parentSha ?? "?"}`,
			);
			return;
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
				`QA PASS for ${parent.issue_id} (${targetExec}) — releasing founder ship-ready notification`,
			);
			await this.deps.effects.notifyShipReady({ session: parent, record });
			// Mark notified only AFTER the notification fired, so a crash in between
			// leaves it passed-but-unnotified for reconcile to re-notify.
			this.deps.store.setAutoQaStatus(targetExec, parentSha, "passed", {
				notifiedAt: true,
			});
		} else {
			this.deps.store.setAutoQaStatus(targetExec, parentSha, "failed", {
				verdictEventId: event.event_id,
			});
			this.log(
				`QA FAIL for ${parent.issue_id} (${targetExec}) — waking implementer, founder NOT notified`,
			);
			await this.deps.effects.feedbackWakeMain({ session: parent, summary });
			// FLY-643: a QA FAIL is Lead-facing — post to the QA issue's OWN thread,
			// NOT the parent thread (the founder watches the parent thread; surfacing
			// a non-green QA there would violate "don't bother the founder before QA
			// is green"). The implementer is woken above; the Lead drives the
			// dev-fix → QA-retest loop and only escalates on a real deadlock.
			await this.deps.effects.postThread({
				session: qaSession,
				text: `🔴 自动 QA 未通过 → 已把报告交回实现 Runner 修复（founder 不打扰）。\n${truncate(summary, 600)}`,
			});
		}
	}

	/**
	 * (c) Restart reconcile — re-drive in-flight QA. MUST run before the
	 * GatePoller / Heartbeat timers (so a restart never relays a held gate).
	 */
	async reconcileOnStartup(): Promise<void> {
		// passed-but-unnotified → re-notify (crash between status=passed + notify).
		for (const rec of this.deps.store.listPassedUnnotifiedAutoQaRecords()) {
			const parent = this.deps.store.getSession(rec.parent_execution_id);
			if (!parent || parent.status !== "awaiting_review") continue;
			if (parent.pr_head_sha?.toLowerCase() !== rec.target_pr_head_sha)
				continue;
			this.log(
				`reconcile re-notify ship-ready for ${parent.issue_id} (${rec.parent_execution_id})`,
			);
			await this.deps.effects.notifyShipReady({ session: parent, record: rec });
			this.deps.store.setAutoQaStatus(
				rec.parent_execution_id,
				rec.target_pr_head_sha,
				"passed",
				{ notifiedAt: true },
			);
		}

		// running records → spawn if never spawned; stuck if QA died without verdict.
		for (const rec of this.deps.store.listRunningAutoQaRecords()) {
			const parent = this.deps.store.getSession(rec.parent_execution_id);
			// Parent moved on (merged / new head / gone) → record is moot.
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
				// Claimed but the spawn never completed (crash mid-spawn) → spawn now.
				this.log(
					`reconcile spawn (claimed-unspawned) for ${parent.issue_id} (${rec.parent_execution_id})`,
				);
				await this.spawnQa(parent, rec.target_pr_head_sha);
				continue;
			}

			const qaSession = this.deps.store.getSession(rec.qa_execution_id);
			if (!qaSession || TERMINAL_STATUSES.has(qaSession.status ?? "")) {
				// QA session ended but the record is still running → the verdict was
				// lost (or QA died). NEVER auto-release; mark stuck + alert the Lead.
				this.warn(
					`reconcile stuck: QA ${rec.qa_execution_id} for ${parent.issue_id} is ${qaSession?.status ?? "gone"} but no verdict landed`,
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
					reason: `auto-QA stuck for ${parent.issue_id}: QA session ${rec.qa_execution_id} ended without a verdict. Founder NOT surfaced.`,
				});
			}
			// else QA still running → leave it; verdict pending.
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

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}
