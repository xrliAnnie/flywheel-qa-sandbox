/**
 * FLY-1188 §7.1 — request↔gate explicit binding protocol (Bridge side).
 *
 * The codex-author review lane: a runner opens a `review_design|review_code`
 * gate (--no-block, gets a questionId), then registers a review REQUEST with
 * the Bridge. The Bridge validates against TRUSTED state (session must exist;
 * author family from sessions.adapter_type; code-review head frozen via
 * rev-parse in the persisted worktree — the payload is validated input, never
 * authority), persists the job idempotently by requestId, and runs the
 * cross-family Claude reviewer (§7.2). On completion it answers ONLY the
 * bound questionId (existing CommDB response + mailbox-wake chain).
 *
 * Fail-close everywhere: missing gate / questionId mismatch / answered
 * question / underivable head / reviewer failure → the job fails and the gate
 * STAYS closed (Lead alert; recovery = same-requestId retry or the sanctioned
 * codex-skip governance path). There is no "send a summary and call it done"
 * degradation.
 *
 * Scheduling: serial per execution, global concurrency 2 (§7.1). Boot
 * redrive: pending/running jobs re-enqueue (`redriveOnBoot`).
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { adapterTypeToFamily, type RoleEffort } from "flywheel-config";
import type { CodexReviewJob, Session, StateStore } from "../StateStore.js";
import {
	type ClaudeReviewOutcome,
	runClaudeReviewRound,
} from "./claude-review-runner.js";

const execFileAsync = promisify(execFile);

/** Minimal CommDB surface the coordinator needs (test seam). */
export interface ReviewCommDb {
	getMessageById(id: string):
		| {
				id: string;
				from_agent?: string;
				type?: string;
				checkpoint?: string | null;
				resolved_at?: string | null;
				expires_at?: string;
				content?: string;
		  }
		| undefined;
	getResponse(
		questionId: string,
	): { content: string; from_agent?: string } | undefined;
	/** R16: atomic answer-iff-still-open (see CommDB.insertResponseIfGateOpen). */
	insertResponseIfGateOpen(input: {
		questionId: string;
		fromAgent: string;
		content: string;
		expectedOwner: string;
		expectedCheckpoint: string;
	}): boolean;
	close(): void;
}

export interface ReviewRequestPayload {
	executionId?: unknown;
	requestId?: unknown;
	reviewType?: unknown;
	questionId?: unknown;
	planPath?: unknown;
}

export type AcceptReviewResult =
	| {
			accepted: true;
			requestId: string;
			skipped: boolean;
			duplicate: boolean;
	  }
	| { accepted: false; httpStatus: number; reason: string };

export interface ReviewCoordinatorDeps {
	store: StateStore;
	commDbPathFor: (projectName: string) => string;
	openCommDb: (path: string) => ReviewCommDb;
	/** §7.2 round runner (test seam; default = real claude subprocess). */
	reviewRound?: typeof runClaudeReviewRound;
	/** Trusted head derivation (test seam; default = rev-parse, no shell). */
	deriveHead?: (worktreePath: string) => Promise<string>;
	/** Best-effort mailbox wake after a gate response (test seam). */
	wakeRunner?: (
		executionId: string,
		session: { issue_id: string; project_name: string },
		questionId: string,
		summary: string,
	) => Promise<void>;
	/** Lead-facing alert for fail-close job failures (wired by plugin). */
	alertLead?: (message: string) => void;
	logger?: (msg: string) => void;
	maxConcurrent?: number;
	reviewerBinary?: string;
	reviewerModel?: string;
	/**
	 * FLY-1224: reviewer reasoning-effort OVERRIDE seam. The default ("xhigh",
	 * Annie's directive) lives in claude-review-runner (`DEFAULT_REVIEW_EFFORT`)
	 * — this dep only forwards an explicit override to every round's invocation.
	 */
	reviewerEffort?: RoleEffort;
	reviewerTimeoutMs?: number;
}

const REQUEST_ID_MAX = 128;
const PLAN_PATH_MAX = 512;
const SHA40 = /^[0-9a-f]{40}$/;
const SESSION_NOT_FOUND = /no conversation found with session id/i;
const FAILURE_RAW_MAX = 4000;
const ALERT_SUMMARY_MAX = 300;

type FailedClaudeReviewOutcome = Extract<
	ClaudeReviewOutcome,
	{ kind: "failed" }
>;

interface FailedReviewAttempt {
	label: string;
	outcome: FailedClaudeReviewOutcome;
}

function composeAttemptEvidence(
	attempt: FailedReviewAttempt,
	budget: number,
	includeAttemptLabel: boolean,
): string {
	const header = includeAttemptLabel ? `${attempt.label}\n` : "";
	const sections = [
		...(attempt.outcome.raw
			? [{ label: "STDOUT", value: attempt.outcome.raw }]
			: []),
		...(attempt.outcome.stderrTail
			? [{ label: "STDERR", value: attempt.outcome.stderrTail }]
			: []),
	];
	if (sections.length === 0) return "";
	const sectionOverhead = sections.reduce(
		(total, section) => total + section.label.length + 2,
		0,
	);
	const separators = Math.max(0, sections.length - 1);
	const valueBudget = Math.max(
		0,
		Math.floor(
			(budget - header.length - sectionOverhead - separators) / sections.length,
		),
	);
	return (
		header +
		sections
			.map(
				(section) => `${section.label}:\n${section.value.slice(-valueBudget)}`,
			)
			.join("\n")
	);
}

function composeFailureRaw(
	attempts: FailedReviewAttempt[],
): string | undefined {
	const withEvidence = attempts.filter(
		(attempt) => attempt.outcome.raw || attempt.outcome.stderrTail,
	);
	if (withEvidence.length === 0) return undefined;
	const separatorBudget = Math.max(0, withEvidence.length - 1) * 2;
	const attemptBudget = Math.floor(
		(FAILURE_RAW_MAX - separatorBudget) / withEvidence.length,
	);
	return withEvidence
		.map((attempt) =>
			composeAttemptEvidence(attempt, attemptBudget, withEvidence.length > 1),
		)
		.join("\n\n")
		.slice(0, FAILURE_RAW_MAX);
}

function sanitizeFailureSummary(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const withoutControls = [...raw]
		.map((character) => {
			const code = character.charCodeAt(0);
			return code <= 31 || code === 127 ? " " : character;
		})
		.join("");
	const sanitized = withoutControls
		// Reviewer output is untrusted Lead-facing text: flatten control chars,
		// prevent markdown/code shaping, and neutralize mentions.
		.replace(/[`@]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, ALERT_SUMMARY_MAX);
	return sanitized || undefined;
}

/**
 * Codex full-PR review MED-6: a design review's `planPath` is persisted and
 * inserted verbatim into the reviewer prompt AND used as a worktree-relative
 * read target. A runner (holding the ingest token) must not be able to point
 * the reviewer OUT of the worktree (absolute / `~` / `..`) or inject reviewer
 * instructions (newline / control char). Returns true when the path is a safe
 * worktree-relative path.
 */
function isSafePlanPath(p: string): boolean {
	if (p.length === 0 || p.length > PLAN_PATH_MAX) return false;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: reject control chars + newlines (prompt injection)
	if (/[\u0000-\u001f\u007f]/.test(p)) return false;
	if (p.startsWith("/") || p.startsWith("~")) return false; // no absolute / home
	return !p.split("/").includes(".."); // no parent traversal
}

/** FLY-245 precedent: rev-parse ONLY, execFile (no shell), in the worktree. */
export async function deriveWorktreeHead(
	worktreePath: string,
): Promise<string> {
	const { stdout } = await execFileAsync(
		"git",
		["-C", worktreePath, "rev-parse", "HEAD"],
		{ timeout: 15_000 },
	);
	const head = stdout.trim().toLowerCase();
	if (!SHA40.test(head)) throw new Error(`rev-parse returned non-sha: ${head}`);
	return head;
}

export class ReviewRequestCoordinator {
	private readonly store: StateStore;
	private readonly deps: ReviewCoordinatorDeps;
	private readonly log: (msg: string) => void;
	private readonly maxConcurrent: number;
	/** Per-execution serialization chains. */
	private readonly execChains = new Map<string, Promise<void>>();
	/** Global slots in use. */
	private active = 0;
	private readonly waiters: Array<() => void> = [];
	private stopped = false;

	constructor(deps: ReviewCoordinatorDeps) {
		this.store = deps.store;
		this.deps = deps;
		this.log =
			deps.logger ?? ((m: string) => console.log(`[review-coordinator] ${m}`));
		this.maxConcurrent = deps.maxConcurrent ?? 2;
	}

	stop(): void {
		this.stopped = true;
		// R13 HIGH-3: drain queued slot waiters — each wakes, hits the
		// post-acquire stopped check, and releases without starting a reviewer.
		while (this.waiters.length > 0) {
			const next = this.waiters.shift();
			next?.();
		}
	}

	/**
	 * Validate + durably persist + enqueue a review request. Returns only
	 * after the job row is committed (the HTTP 200 = durable-accepted ack).
	 */
	async accept(payload: ReviewRequestPayload): Promise<AcceptReviewResult> {
		const executionId = str(payload.executionId);
		const requestId = str(payload.requestId);
		const reviewType = str(payload.reviewType);
		const questionId = str(payload.questionId);
		const planPath = str(payload.planPath);
		if (!executionId || !requestId || !questionId) {
			return reject(400, "executionId, requestId and questionId are required");
		}
		if (requestId.length > REQUEST_ID_MAX) {
			return reject(400, "requestId too long");
		}
		if (reviewType !== "design" && reviewType !== "code") {
			return reject(400, "reviewType must be 'design' or 'code'");
		}
		// MED-6: a design planPath (when supplied) becomes a worktree-relative
		// read target + is inlined into the reviewer prompt — reject anything that
		// escapes the worktree or injects instructions. Empty → prompt fallback.
		if (reviewType === "design" && planPath && !isSafePlanPath(planPath)) {
			return reject(
				400,
				"planPath must be a worktree-relative path (no absolute, '~', '..' or control characters)",
			);
		}

		const session = this.store.getSession(executionId);
		if (!session) return reject(404, `unknown execution ${executionId}`);
		const projectName = session.project_name;

		// R12 HIGH-3: this lane enforces the reviewer-inversion invariant for
		// NON-claude authors. A claude-family author must stay on the legacy
		// claude-author→codex-reviewer lane — running the Claude reviewer for
		// a claude author would BE a same-family review.
		const authorFamily = adapterTypeToFamily(session.adapter_type);
		if (authorFamily === "claude") {
			return reject(
				409,
				`execution ${executionId} is a claude-family author — request-review is the non-claude lane (legacy codex review applies)`,
			);
		}

		// Idempotent replay: same requestId → the SAME durable job. Identity is
		// the WHOLE binding (R12 MEDIUM): execution + type + question match.
		const existing = this.store.getCodexReviewJob(requestId);
		if (existing) {
			if (
				existing.question_id !== questionId ||
				existing.execution_id !== executionId ||
				existing.review_type !== reviewType
			) {
				return reject(
					409,
					`requestId ${requestId} is already bound to a different request (execution ${existing.execution_id}, question ${existing.question_id}, type ${existing.review_type})`,
				);
			}
			if (existing.status === "pending") {
				this.enqueue(existing.request_id, existing.execution_id);
			} else if (existing.status === "failed") {
				// R12 HIGH-1: NEVER resurrect a failed job without re-proving the
				// binding — a registration-rejected audit row (gate_*) must not
				// become an accepted job just because the requestId was re-POSTed.
				const retryGate = this.checkGate(
					projectName,
					questionId,
					executionId,
					reviewType,
				);
				if (retryGate !== "open") {
					return reject(
						409,
						`retry refused for ${requestId}: gate ${retryGate} (question ${questionId})`,
					);
				}
				this.enqueue(existing.request_id, existing.execution_id);
			} else if (
				(existing.status === "done" || existing.status === "skipped") &&
				!existing.responded_at
			) {
				// R12 HIGH-4 outbox: terminal verdict whose response never landed
				await this.deliverStoredResponse(existing);
			}
			return {
				accepted: true,
				requestId,
				skipped: existing.status === "skipped",
				duplicate: true,
			};
		}

		// Gate binding must be THIS execution's own OPEN review gate of the
		// right checkpoint (R12 HIGH-2) — fail-close otherwise.
		const gate = this.checkGate(
			projectName,
			questionId,
			executionId,
			reviewType,
		);
		if (gate !== "open") {
			const reason =
				gate === "missing"
					? `gate question ${questionId} not found in CommDB`
					: gate === "mismatch"
						? `gate question ${questionId} is not this execution's review_${reviewType} gate`
						: `gate question ${questionId} is ${gate}`;
			// durable failed job for audit + Lead alert (§7.1 fail-close)
			this.store.insertCodexReviewJob({
				requestId,
				executionId,
				issueId: session.issue_id,
				projectName,
				reviewType,
				questionId,
				authorFamily,
			});
			this.store.failCodexReviewJob(requestId, `gate_${gate}`);
			this.alert(
				`review request ${requestId} (${session.issue_id}) rejected: ${reason}`,
			);
			return reject(409, reason);
		}

		// code review: freeze the TRUSTED head server-side (R3 #2) — BEFORE the
		// skip lane (R12 MEDIUM: a code skip must be head-bound; an underivable
		// head refuses registration rather than skipping headlessly).
		let frozenHeadSha: string | undefined;
		if (reviewType === "code") {
			const head = await this.tryDeriveHead(session);
			if (!head) {
				return reject(
					422,
					`cannot derive a trusted head for ${executionId} (worktree ${session.worktree_path ?? "<missing>"})`,
				);
			}
			frozenHeadSha = head;
		}

		// codex-skip snapshot (frozen at execution start — §7.1/R3 #3): no
		// Claude job; durable skipped audit row (outbox-stamped after the
		// response actually lands); head-bound skipped record for code.
		if (session.codex_skip) {
			const skipInsert = this.store.insertCodexReviewJob({
				requestId,
				executionId,
				issueId: session.issue_id,
				projectName,
				reviewType,
				questionId,
				frozenHeadSha,
				authorFamily,
				status: "skipped",
			});
			if (!skipInsert.inserted) {
				// R13 MEDIUM-2 + R14 MEDIUM-1: a concurrent first POST won the
				// insert — validate it is the SAME binding before deferring to
				// the winner (who owns the respond/stamp).
				if (
					skipInsert.job.question_id !== questionId ||
					skipInsert.job.execution_id !== executionId ||
					skipInsert.job.review_type !== reviewType
				) {
					return reject(
						409,
						`requestId ${requestId} is already bound to a different request`,
					);
				}
				return {
					accepted: true,
					requestId,
					skipped: skipInsert.job.status === "skipped",
					duplicate: true,
				};
			}
			if (reviewType === "code" && frozenHeadSha) {
				this.store.markCodexReviewSkipped({
					executionId,
					targetPrHeadSha: frozenHeadSha,
					issueId: session.issue_id,
					projectName,
				});
			}
			const owned = await this.respond(
				session,
				questionId,
				{
					reviewVerdict: "SKIPPED",
					requestId,
					note: "codex_skip is active for this execution — review sanctioned as skipped; proceed.",
					...(skipInsert.job.delivery_nonce
						? { deliveryNonce: skipInsert.job.delivery_nonce }
						: {}),
				},
				{ executionId, reviewType },
			);
			if (owned) this.store.stampCodexReviewJobResponded(requestId);
			return { accepted: true, requestId, skipped: true, duplicate: false };
		}

		const round = this.store.countCodexReviewJobs(executionId, reviewType) + 1;
		const priorUuid = this.store.latestCodexReviewerSessionUuid(
			executionId,
			reviewType,
		);
		const insert = this.store.insertCodexReviewJob({
			requestId,
			executionId,
			issueId: session.issue_id,
			projectName,
			reviewType,
			round,
			questionId,
			targetPath: reviewType === "design" ? planPath : undefined,
			frozenHeadSha,
			reviewerSessionUuid: priorUuid ?? undefined,
			authorFamily,
		});
		if (!insert.inserted) {
			// R13 MEDIUM-2: concurrent first POST — the row already exists.
			// Validate it is the SAME binding, then defer to the winner (who
			// enqueued); do not double-enqueue or misreport duplicate:false.
			if (
				insert.job.question_id !== questionId ||
				insert.job.execution_id !== executionId ||
				insert.job.review_type !== reviewType
			) {
				return reject(
					409,
					`requestId ${requestId} is already bound to a different request`,
				);
			}
			return {
				accepted: true,
				requestId,
				skipped: insert.job.status === "skipped",
				duplicate: true,
			};
		}
		this.enqueue(requestId, executionId);
		return { accepted: true, requestId, skipped: false, duplicate: false };
	}

	/**
	 * Bridge boot: (1) R12 HIGH-4 outbox — re-deliver terminal verdicts whose
	 * gate response was lost in a crash (from the STORED verdict, never a
	 * re-review); (2) running → pending, then enqueue every redrivable job.
	 */
	redriveOnBoot(): number {
		for (const job of this.store.listUndeliveredCodexReviewJobs()) {
			void this.deliverStoredResponse(job).catch((err) => {
				this.log(
					`outbox re-delivery failed for ${job.request_id}: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		}
		const reset = this.store.resetRunningCodexReviewJobs();
		if (reset > 0) this.log(`boot: reset ${reset} in-flight job(s) → pending`);
		const jobs = this.store.listRedrivableCodexReviewJobs();
		for (const job of jobs) this.enqueue(job.request_id, job.execution_id);
		return jobs.length;
	}

	/** R12 HIGH-4: answer the bound gate from a job's STORED terminal verdict. */
	private async deliverStoredResponse(job: CodexReviewJob): Promise<void> {
		const session = this.store.getSession(job.execution_id);
		if (!session) return;
		// R13 MEDIUM-3: a skipped CODE job crash-recovered from the outbox must
		// re-assert the head-bound skipped record (idempotent upsert) — the
		// runner is told to proceed, so the FLY-827 gate must actually be
		// satisfied for the frozen head.
		if (
			job.status === "skipped" &&
			job.review_type === "code" &&
			job.frozen_head_sha
		) {
			this.store.markCodexReviewSkipped({
				executionId: job.execution_id,
				targetPrHeadSha: job.frozen_head_sha,
				issueId: job.issue_id ?? session.issue_id,
				projectName: job.project_name,
			});
		}
		// R17: the server-only delivery nonce makes this payload unforgeable —
		// a runner pre-writing a "predictable" bridge response cannot know it.
		const nonceField = job.delivery_nonce
			? { deliveryNonce: job.delivery_nonce }
			: {};
		const content: Record<string, unknown> =
			job.status === "skipped"
				? {
						reviewVerdict: "SKIPPED",
						requestId: job.request_id,
						note: "codex_skip is active for this execution — review sanctioned as skipped; proceed.",
						...nonceField,
					}
				: {
						reviewVerdict: job.verdict ?? "CHANGES_REQUESTED",
						requestId: job.request_id,
						round: job.round,
						findings: safeParseArray(job.findings_json),
						...(job.frozen_head_sha
							? { reviewedHeadSha: job.frozen_head_sha }
							: {}),
						...nonceField,
					};
		// R13 MEDIUM-1: stamp ONLY when the durable response in place is OURS
		// (freshly inserted or an idempotent replay of the exact canonical
		// payload). A foreign answer (e.g. a Lead cancellation) must not be
		// recorded as this job's delivery — leave it unstamped and alert.
		const owned = await this.respond(session, job.question_id, content, {
			executionId: job.execution_id,
			reviewType: job.review_type,
		});
		if (owned) {
			// R15 HIGH-2: authority follows delivery — a crash between the
			// live respond and the authority write is recovered HERE.
			this.commitAuthorityIfApproved(job);
			this.store.stampCodexReviewJobResponded(job.request_id);
		} else {
			this.alert(
				`review ${job.request_id}: gate ${job.question_id} already carries a FOREIGN answer — verdict not delivered; runner state needs Lead attention.`,
			);
		}
	}

	// ── scheduling ─────────────────────────────────────────────────────────

	private enqueue(requestId: string, executionId: string): void {
		const chain = this.execChains.get(executionId) ?? Promise.resolve();
		const next = chain.then(async () => {
			if (this.stopped) return;
			await this.acquireSlot();
			try {
				// R13 HIGH-3: re-check AFTER the slot wait — a waiter woken
				// during/after shutdown must not start a reviewer the one-shot
				// killAllClaudeReviewChildren() sweep can no longer reap.
				if (this.stopped) return;
				await this.runJob(requestId);
			} catch (err) {
				this.log(
					`job ${requestId} crashed: ${err instanceof Error ? err.message : String(err)}`,
				);
				try {
					this.store.failCodexReviewJob(requestId, "internal_error");
				} catch {
					/* store unavailable — job stays running, boot redrive recovers */
				}
			} finally {
				this.releaseSlot();
			}
		});
		this.execChains.set(executionId, next);
		void next.finally(() => {
			if (this.execChains.get(executionId) === next) {
				this.execChains.delete(executionId);
			}
		});
	}

	private acquireSlot(): Promise<void> {
		if (this.active < this.maxConcurrent) {
			this.active += 1;
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this.waiters.push(() => {
				this.active += 1;
				resolve();
			});
		});
	}

	private releaseSlot(): void {
		this.active -= 1;
		const next = this.waiters.shift();
		if (next) next();
	}

	// ── job execution ──────────────────────────────────────────────────────

	private async runJob(requestId: string): Promise<void> {
		const job = this.store.getCodexReviewJob(requestId);
		if (!job) return;
		if (!this.store.claimCodexReviewJobRunning(requestId)) return;
		const session = this.store.getSession(job.execution_id);
		if (!session) {
			this.store.failCodexReviewJob(requestId, "session_missing");
			return;
		}

		// R13 HIGH-2: a pre-crash run may have committed the §7.3 authority
		// record but died before writing the job's done verdict. That authority
		// is request-bound and final — restore the verdict DETERMINISTICALLY
		// instead of re-running the reviewer (a second run could disagree with
		// the standing approval).
		if (job.review_type === "code" && job.frozen_head_sha) {
			const rec = this.store.getCodexReviewRecord(
				job.execution_id,
				job.frozen_head_sha,
			);
			if (rec?.status === "approved" && rec.request_id === requestId) {
				this.log(
					`job ${requestId}: request-bound authority already committed — restoring APPROVED verdict without a re-review`,
				);
				this.store.completeCodexReviewJob(
					requestId,
					"APPROVED",
					job.findings_json ?? "[]",
				);
				const restored = this.store.getCodexReviewJob(requestId);
				if (restored) await this.deliverStoredResponse(restored);
				return;
			}
		}

		// reviewer session: round 1 gets a FRESH uuid at run time (a retried
		// round-1 must not collide with a half-created claude session);
		// rerounds resume the persisted prior-round uuid.
		let sessionUuid = job.reviewer_session_uuid;
		let resume = true;
		if (job.round <= 1 || !sessionUuid) {
			sessionUuid = randomUUID();
			this.store.setCodexReviewJobReviewerSession(requestId, sessionUuid);
			resume = false;
		}

		const cwd = session.worktree_path;
		if (!cwd) {
			this.store.failCodexReviewJob(requestId, "worktree_missing");
			this.alert(
				`review job ${requestId} (${job.issue_id ?? job.execution_id}) failed: no persisted worktree`,
			);
			return;
		}

		const roundRunner = this.deps.reviewRound ?? runClaudeReviewRound;
		const runRound = (roundResume: boolean, roundSessionUuid: string) =>
			roundRunner({
				prompt: this.buildPrompt(job, roundResume),
				sessionId: roundSessionUuid,
				resume: roundResume,
				cwd,
				binary: this.deps.reviewerBinary,
				model: this.deps.reviewerModel,
				// FLY-1224: forwarded on EVERY round; undefined → the runner's own
				// DEFAULT_REVIEW_EFFORT ("xhigh") applies.
				effort: this.deps.reviewerEffort,
				timeoutMs: this.deps.reviewerTimeoutMs,
			});
		let outcome: ClaudeReviewOutcome = await runRound(resume, sessionUuid);
		const failedAttempts: FailedReviewAttempt[] = [];

		if (outcome.kind === "failed") {
			failedAttempts.push({ label: "ATTEMPT 1 RESUME", outcome });
		}
		if (
			outcome.kind === "failed" &&
			resume &&
			outcome.reason === "nonzero_exit" &&
			SESSION_NOT_FOUND.test(`${outcome.stderrTail ?? ""} ${outcome.raw ?? ""}`)
		) {
			// A fresh fallback is bounded to once per runJob invocation. The new
			// uuid is durable, so a crash before its spawn may redrive as a resume;
			// that later runJob can independently fall back once and still converges.
			if (this.stopped) {
				this.failReviewerOutcome(job, outcome, failedAttempts);
				return;
			}
			if (
				!this.gateStillOpen(
					job.project_name,
					job.question_id,
					job.execution_id,
					job.review_type,
				)
			) {
				this.store.failCodexReviewJob(
					requestId,
					"gate_answered_externally",
					composeFailureRaw(failedAttempts),
				);
				this.alert(
					`claude review ${requestId}: gate ${job.question_id} closed before the lost-session fallback — no fresh reviewer started.`,
				);
				return;
			}
			if (job.review_type === "code") {
				const current = await this.tryDeriveHead(session);
				const frozen = job.frozen_head_sha?.toLowerCase();
				if (!current || !frozen || current !== frozen) {
					this.store.failCodexReviewJob(
						requestId,
						"head_moved",
						composeFailureRaw(failedAttempts),
					);
					this.alert(
						`claude review ${requestId}: head moved before the lost-session fallback (frozen ${frozen ?? "?"} vs current ${current ?? "?"}) — no fresh reviewer started.`,
					);
					return;
				}
			}
			this.log(
				`job ${requestId}: resume session lost — falling back to a fresh reviewer session (once)`,
			);
			sessionUuid = randomUUID();
			this.store.setCodexReviewJobReviewerSession(requestId, sessionUuid);
			outcome = await runRound(false, sessionUuid);
			if (outcome.kind === "failed") {
				failedAttempts.push({ label: "ATTEMPT 2 FRESH", outcome });
			}
		}

		if (outcome.kind === "failed") {
			this.failReviewerOutcome(job, outcome, failedAttempts);
			return; // fail-close: no response, gate stays shut
		}

		// R13 MEDIUM-1 + R14 HIGH-2: FULL gate re-validation before any
		// authority/verdict write — resolved/expired/re-purposed gates and
		// foreign answers all mean this verdict has no gate to land on, so the
		// job fails (still running → downgrade allowed) and no §7.3 record is
		// committed.
		if (
			!this.gateStillOpen(
				job.project_name,
				job.question_id,
				job.execution_id,
				job.review_type,
			)
		) {
			this.store.failCodexReviewJob(requestId, "gate_answered_externally");
			this.alert(
				`claude review ${requestId}: gate ${job.question_id} is no longer this job's open gate (resolved/expired/foreign-answered while the reviewer ran) — verdict discarded (no authority written).`,
			);
			return;
		}

		if (job.review_type === "code") {
			// accept-time freeze × verdict-time recheck for EVERY code verdict
			// (R3 #2 + R12 MEDIUM: findings against a moved head are as
			// misleading as a stale approval).
			const current = await this.tryDeriveHead(session);
			const frozen = job.frozen_head_sha?.toLowerCase();
			if (!current || !frozen || current !== frozen) {
				this.store.failCodexReviewJob(requestId, "head_moved");
				this.alert(
					`claude review ${requestId}: head moved (frozen ${frozen ?? "?"} vs current ${current ?? "?"}) — verdict voided; a new request/round is required.`,
				);
				return;
			}
			if (outcome.verdict === "APPROVED") {
				// R12 HIGH-6: the reviewer MUST echo the exact sha it reviewed —
				// a missing/mismatching echo can never become an authority record.
				if (!outcome.reviewedHeadSha || outcome.reviewedHeadSha !== frozen) {
					this.store.failCodexReviewJob(requestId, "reviewed_wrong_head");
					this.alert(
						`claude review ${requestId}: reviewer reports head ${outcome.reviewedHeadSha ?? "<missing>"} but the job froze ${frozen} — approval refused.`,
					);
					return;
				}
			} else if (
				outcome.reviewedHeadSha &&
				outcome.reviewedHeadSha !== frozen
			) {
				this.store.failCodexReviewJob(requestId, "reviewed_wrong_head");
				this.alert(
					`claude review ${requestId}: findings claim head ${outcome.reviewedHeadSha} but the job froze ${frozen} — verdict refused.`,
				);
				return;
			}
		}

		// R12 HIGH-4 outbox order + R15 HIGH-2 authority order: terminal
		// verdict FIRST (responded_at NULL), then the gate answer, and ONLY a
		// successfully OWNED delivery commits the §7.3 authority — an external
		// answer landing in the recheck→write window can no longer leave a
		// standing approval with a withheld delivery. A crash anywhere after
		// `done` is re-driven by the outbox, which re-runs this same
		// deliver-then-authority sequence from the stored verdict.
		const findingsJson = JSON.stringify(outcome.findings ?? []);
		this.store.completeCodexReviewJob(requestId, outcome.verdict, findingsJson);
		const owned = await this.respond(
			session,
			job.question_id,
			{
				reviewVerdict: outcome.verdict,
				requestId,
				round: job.round,
				findings: safeParseArray(findingsJson),
				...(job.frozen_head_sha
					? { reviewedHeadSha: job.frozen_head_sha }
					: {}),
				...(job.delivery_nonce ? { deliveryNonce: job.delivery_nonce } : {}),
			},
			{ executionId: job.execution_id, reviewType: job.review_type },
		);
		if (!owned) {
			// narrow race: a foreign answer landed between the pre-verdict
			// recheck and the write. The job stays done+unstamped (immutable),
			// NO authority is written, and the alert makes it loud.
			this.alert(
				`review ${requestId}: gate ${job.question_id} answered externally after the verdict landed — delivery withheld, no authority written.`,
			);
			return;
		}
		this.commitAuthorityIfApproved({
			...job,
			verdict: outcome.verdict,
		});
		this.store.stampCodexReviewJobResponded(requestId);
	}

	private failReviewerOutcome(
		job: CodexReviewJob,
		outcome: FailedClaudeReviewOutcome,
		attempts: FailedReviewAttempt[],
	): void {
		const failureRaw = composeFailureRaw(attempts);
		this.store.failCodexReviewJob(job.request_id, outcome.reason, failureRaw);
		const summary = sanitizeFailureSummary(failureRaw);
		this.alert(
			`claude review ${job.request_id} (${job.issue_id ?? job.execution_id}, ${job.review_type} R${job.round}) FAILED: ${outcome.reason} — gate stays closed; retry the request or use the codex-skip governance path.${summary ? ` Evidence: ${summary}` : ""}`,
		);
	}

	/**
	 * R15 HIGH-2: the §7.3 authority record is committed ONLY after an owned
	 * gate delivery. Idempotent (recordCodexReviewApproved same-request replay
	 * preserves anchors) — shared by the live path and the outbox recovery.
	 */
	private commitAuthorityIfApproved(job: CodexReviewJob): void {
		if (
			job.verdict !== "APPROVED" ||
			job.review_type !== "code" ||
			!job.frozen_head_sha
		) {
			return;
		}
		this.store.recordCodexReviewApproved({
			executionId: job.execution_id,
			targetPrHeadSha: job.frozen_head_sha,
			issueId: job.issue_id ?? job.execution_id,
			projectName: job.project_name,
			verdictEventId: `review-job:${job.request_id}`,
			reviewedTarget: "claude-review:code",
			authorFamily: job.author_family,
			reviewerFamily: "claude",
			requestId: job.request_id,
		});
	}

	private buildPrompt(
		job: {
			review_type: "design" | "code";
			round: number;
			target_path?: string;
			frozen_head_sha?: string;
			issue_id?: string;
			execution_id: string;
		},
		resume: boolean,
	): string {
		const contract =
			`You are the CROSS-FAMILY REVIEWER for ${job.issue_id ?? job.execution_id} ` +
			`(a codex-authored change; you are the independent Claude lane). ` +
			`Actively explore this repository — do not rely on any diff alone. ` +
			`When done, output ONLY a JSON object: {"verdict": "APPROVED" | "CHANGES_REQUESTED", ` +
			`"findings": [{"severity": "HIGH|MEDIUM|LOW", "file": "...", "line": 0, "title": "...", "detail": "..."}], ` +
			`"reviewedHeadSha": "<the exact commit you reviewed, git rev-parse HEAD>"}. ` +
			`No prose outside the JSON. Your very last line must be that JSON object itself.`;
		const target =
			job.review_type === "design"
				? `Review the DESIGN/PLAN at path: ${job.target_path ?? "engineering/doc (locate the plan for this issue)"} — read it fully, verify it against the codebase, judge soundness, completeness and risk.`
				: `Review the CODE at commit ${job.frozen_head_sha ?? "HEAD"} on the current branch. Diff it against the merge base with the default branch (git diff), read the touched files in full, check correctness, security, edge cases and error handling. Skip style nitpicks.`;
		if (job.round <= 1) {
			return `${contract}\n\n${target}\n\nThis is round ${job.round}.`;
		}
		if (resume) {
			return (
				`${contract}\n\nRound ${job.round} re-review — you reviewed this work before in THIS session and retain that context. ` +
				`${target}\n\nFocus on whether the issues you raised were correctly fixed and on anything new the changes introduced.`
			);
		}
		const prior = this.store.latestDoneCodexReviewJob(
			job.execution_id,
			job.review_type,
		);
		const priorContext = prior?.findings_json
			? `Your previous findings were:\n${prior.findings_json}`
			: "(no reliable record of your prior findings survives — treat this as a fresh, full review)";
		return (
			`${contract}\n\nRound ${job.round} fresh re-review (the prior reviewer session was unavailable). ` +
			`${target}\n\n${priorContext}\n\n` +
			`Perform a full review, using the durable prior context above when available.`
		);
	}

	// ── gate response ──────────────────────────────────────────────────────

	/**
	 * R12 HIGH-2: the gate binding must prove this question really IS this
	 * execution's OWN open review gate — a bare "id exists and unanswered"
	 * check would let a request bind another execution's question, a plain
	 * ask, or the wrong checkpoint. Every mismatch fails closed.
	 */
	private checkGate(
		projectName: string,
		questionId: string,
		executionId: string,
		reviewType: "design" | "code",
	): "open" | "missing" | "answered" | "mismatch" | "expired" {
		let db: ReviewCommDb | undefined;
		try {
			db = this.deps.openCommDb(this.deps.commDbPathFor(projectName));
			const q = db.getMessageById(questionId);
			if (!q) return "missing";
			if (q.type !== "question") return "mismatch";
			if (q.from_agent !== executionId) return "mismatch";
			if (q.checkpoint !== `review_${reviewType}`) return "mismatch";
			if (q.resolved_at) return "answered";
			if (q.expires_at && new Date(q.expires_at).getTime() < Date.now()) {
				return "expired";
			}
			if (db.getResponse(questionId)) return "answered";
			return "open";
		} catch (err) {
			this.log(
				`CommDB check failed for ${questionId}: ${err instanceof Error ? err.message : String(err)}`,
			);
			return "missing"; // unreachable CommDB → fail-close
		} finally {
			db?.close();
		}
	}

	/**
	 * Answer the bound question. Returns true only when the durable response
	 * in place is OURS — freshly inserted, or an existing answer that is
	 * byte-identical to our canonical payload (idempotent re-delivery). The
	 * insert itself is ATOMIC (R16): one conditional statement proves the
	 * question is still this execution's open review gate (type/owner/
	 * checkpoint/unresolved/unexpired/unanswered) in the same write — a
	 * concurrent resolveGate()/expiry/foreign answer makes it a no-op, and
	 * the re-read decides ownership. A FOREIGN outcome returns false: no
	 * overwrite, no wake, and the caller must not stamp delivery or commit
	 * authority.
	 */
	private async respond(
		session: Session,
		questionId: string,
		content: Record<string, unknown>,
		binding: { executionId: string; reviewType: "design" | "code" },
	): Promise<boolean> {
		const db = this.deps.openCommDb(
			this.deps.commDbPathFor(session.project_name),
		);
		try {
			const existing = db.getResponse(questionId);
			if (existing) {
				if (!isOurResponse(existing, content)) return false;
			} else {
				const inserted = db.insertResponseIfGateOpen({
					questionId,
					fromAgent: "bridge",
					content: JSON.stringify(content),
					expectedOwner: binding.executionId,
					expectedCheckpoint: `review_${binding.reviewType}`,
				});
				if (!inserted) {
					// the gate stopped being open in the window — resolved,
					// expired, or a racing answer landed. Re-read: only our own
					// canonical bytes count as delivered.
					const after = db.getResponse(questionId);
					if (!after || !isOurResponse(after, content)) return false;
				}
			}
		} finally {
			db.close();
		}
		if (this.deps.wakeRunner) {
			try {
				await this.deps.wakeRunner(
					session.execution_id,
					{
						issue_id: session.issue_id,
						project_name: session.project_name,
					},
					questionId,
					String(content.reviewVerdict ?? "answered"),
				);
			} catch (err) {
				this.log(
					`runner wake failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		return true;
	}

	/**
	 * R13 MEDIUM-1 + R14 HIGH-2: full post-review gate re-validation. While a
	 * job is being run its gate must STILL be this execution's OPEN review
	 * question — a running job's gate cannot legitimately be answered yet
	 * (idempotent re-delivery only happens on terminal jobs via the outbox),
	 * so resolved/expired/re-purposed/answered all mean the verdict has no
	 * gate to land on.
	 */
	private gateStillOpen(
		projectName: string,
		questionId: string,
		executionId: string,
		reviewType: "design" | "code",
	): boolean {
		return (
			this.checkGate(projectName, questionId, executionId, reviewType) ===
			"open"
		);
	}

	private async tryDeriveHead(session: Session): Promise<string | null> {
		const wt = session.worktree_path;
		if (!wt) return null;
		const derive = this.deps.deriveHead ?? deriveWorktreeHead;
		try {
			return await derive(wt);
		} catch (err) {
			this.log(
				`head derivation failed for ${session.execution_id}: ${err instanceof Error ? err.message : String(err)}`,
			);
			return null;
		}
	}

	private alert(message: string): void {
		this.log(`ALERT: ${message}`);
		try {
			this.deps.alertLead?.(message);
		} catch {
			/* alerts are best-effort */
		}
	}
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * R14 HIGH-1 + R15 HIGH-1: a response is OURS only when the CommDB row's
 * from_agent is "bridge" AND its content is BYTE-IDENTICAL to the exact
 * payload this job would deliver. from_agent alone is forgeable too
 * (`flywheel-comm respond --lead bridge` is caller-controlled), but a forger
 * cannot reproduce the canonical serialization of a verdict it wants to
 * differ from — any deviation (verdict, findings, round, key order) makes
 * the answer FOREIGN and delivery is withheld.
 */
function isOurResponse(
	existing: { content: string; from_agent?: string },
	expectedContent: Record<string, unknown>,
): boolean {
	if (existing.from_agent !== "bridge") return false;
	return existing.content === JSON.stringify(expectedContent);
}

function safeParseArray(json: string | undefined): unknown[] {
	if (!json) return [];
	try {
		const parsed = JSON.parse(json);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function reject(httpStatus: number, reason: string): AcceptReviewResult {
	return { accepted: false, httpStatus, reason };
}
