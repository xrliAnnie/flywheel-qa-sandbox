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
 * STAYS closed. Failure alerts derive recovery from the durable reason and
 * live gate state; superseded revisions stay internal. There is no "send a
 * summary and call it done" degradation.
 *
 * Scheduling: serial per execution, with no coordinator-wide concurrency
 * ceiling (§7.1 / FLY-2037). Boot redrive: pending/running jobs re-enqueue
 * (`redriveOnBoot`).
 */

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { adapterTypeToFamily, type RoleEffort } from "flywheel-config";
import type {
	CodexReviewJob,
	ReviewFindingRuling,
	Session,
	StateStore,
} from "../StateStore.js";
import {
	type ClaudeReviewOutcome,
	runClaudeReviewRound,
} from "./claude-review-runner.js";
import { buildGovernancePromptSegment } from "./review-governance-prompt.js";
import { parseReviewQuotaResetAt } from "./review-quota-retry.js";
import {
	computeEffectiveVerdict,
	type EffectiveReviewVerdict,
	type ReviewFindingRulingSnapshot,
} from "./review-verdict-policy.js";

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
				superseded_at?: string | null;
				superseded_by?: string | null;
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
	insertReviewResponseIfGateOpen(input: {
		questionId: string;
		fromAgent: string;
		content: string;
		expectedOwner: string;
		expectedCheckpoint: "review_design" | "review_code";
	}): {
		responseId: string;
	} | null;
	close(): void;
}

export interface ReviewRequestPayload {
	executionId?: unknown;
	requestId?: unknown;
	reviewType?: unknown;
	questionId?: unknown;
	planPath?: unknown;
	targetRepoPath?: unknown;
}

export type AcceptReviewResult =
	| {
			accepted: true;
			requestId: string;
			skipped: boolean;
			duplicate: boolean;
	  }
	| { accepted: false; httpStatus: number; reason: string };

export interface ReviewRulingPayload {
	projectName?: unknown;
	issue?: unknown;
	findingKey?: unknown;
	requestId?: unknown;
	findingIndex?: unknown;
	disposition?: unknown;
	followUpIssue?: unknown;
	rationale?: unknown;
	ruledBy?: unknown;
	executionId?: unknown;
	revokeRulingId?: unknown;
}

export type ReviewRulingResult =
	| {
			accepted: true;
			httpStatus: 200 | 201;
			ruling: ReviewFindingRuling;
	  }
	| { accepted: false; httpStatus: number; reason: string };

export type ReviewAlertKind =
	| "review_advisory_pass"
	| "review_job_failed"
	| "review_ruling_recorded"
	| "review_ruling_disputed"
	| "review_ruling_notify_failed";

export interface ReviewAlertEvent {
	kind: ReviewAlertKind;
	eventId: string;
	issueId: string;
	executionId?: string;
	requestId?: string;
	rulingId?: string;
	message: string;
}

export interface ReviewCoordinatorDeps {
	store: StateStore;
	commDbPathFor: (projectName: string) => string;
	openCommDb: (path: string) => ReviewCommDb;
	/** §7.2 round runner (test seam; default = real claude subprocess). */
	reviewRound?: typeof runClaudeReviewRound;
	/** Trusted head derivation (test seam; default = rev-parse, no shell). */
	deriveHead?: (worktreePath: string) => Promise<string>;
	/**
	 * FLY-1257 defect ① × ④ (Codex code review HIGH-1): flip the answered review
	 * gate's MARKER to answered so a resident codex `/goal` resumes at once. The
	 * coordinator answers via CommDB + mailbox wake, but a held goal's
	 * `isWaiting()` reads the gate marker's `answeredAt` — the CLI `respond` path
	 * marks it, this lane must too, or the goal waits ~72h for the deadline
	 * watcher. Best-effort (test seam); wired by plugin to
	 * `markGateMarkerAnsweredForExecution`. Absent → no-op (byte-compatible).
	 */
	markGateAnswered?: (questionId: string, executionId: string) => void;
	/** Lead-facing alert for fail-close job failures (wired by plugin). */
	alertLead?: (message: string) => void;
	logger?: (msg: string) => void;
	reviewerBinary?: string;
	reviewerModel?: string;
	/**
	 * FLY-1224: reviewer reasoning-effort OVERRIDE seam. The default ("xhigh",
	 * Annie's directive) lives in claude-review-runner (`DEFAULT_REVIEW_EFFORT`)
	 * — this dep only forwards an explicit override to every round's invocation.
	 */
	reviewerEffort?: RoleEffort;
	reviewerTimeoutMs?: number;
	/** Test seam for the legacy policy branch. */
	reviewSeverityPolicyEnabled?: boolean;
	/** Slice seam: StateStore-backed issue lookup is connected in FLY-1278/2. */
	listActiveReviewFindingRulings?: (input: {
		projectName: string;
		issueId: string;
	}) => readonly ReviewFindingRulingSnapshot[];
	/** Structured Lead alert path (late-bound routed notifier in production). */
	emitReviewAlert?: (event: ReviewAlertEvent) => Promise<void>;
	/** Best-effort supervised audit post to the source issue thread. */
	postReviewRulingThread?: (input: {
		session: Session;
		text: string;
	}) => Promise<{ ok: boolean }>;
	/** FLY-2177 call-time kill switch (production: managed flag store). */
	quotaAutoRetryEnabled?: () => boolean;
	/** Narrow deterministic clock/timer seams. */
	now?: () => number;
	setTimer?: (callback: () => void, delayMs: number) => unknown;
	clearTimer?: (handle: unknown) => void;
}

const REQUEST_ID_MAX = 128;
const PLAN_PATH_MAX = 512;
const TARGET_REPO_PATH_MAX = 512;
const SHA40 = /^[0-9a-f]{40}$/;
const SESSION_NOT_FOUND = /no conversation found with session id/i;
const FAILURE_RAW_MAX = 4000;
const ALERT_SUMMARY_MAX = 300;
const RESET_GRACE_MS = 60_000;
const MAX_RETRY_JITTER_MS = 5 * 60_000;
const GATE_EXPIRY_SAFETY_MS = 60_000;
const KILL_SWITCH_RECHECK_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

export function reviewRetryJitterMs(requestId: string): number {
	const digest = createHash("sha256").update(requestId).digest();
	return digest.readUInt32BE(0) % MAX_RETRY_JITTER_MS;
}

type FailedClaudeReviewOutcome = Extract<
	ClaudeReviewOutcome,
	{ kind: "failed" }
>;

type ReviewGateState =
	| "open"
	| "missing"
	| "answered"
	| "mismatch"
	| "expired"
	| "superseded"
	| "unknown";

interface ReviewGateInspection {
	state: ReviewGateState;
	expiresAtMs?: number;
}

function runtimeGateFailureReason(state: ReviewGateState): string {
	if (state === "superseded") return "superseded_by_revision";
	if (state === "answered") return "gate_answered_externally";
	return `gate_${state}`;
}

function acceptGateFailureReason(state: ReviewGateState): string {
	return state === "superseded" ? "superseded_by_revision" : `gate_${state}`;
}

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
const ISSUE_REF =
	/^(?:[A-Z][A-Z0-9]*-[0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const FOLLOW_UP_REF = /^[A-Z][A-Z0-9]*-[0-9]+$/;
const PROJECT_NAME = /^[A-Za-z0-9._-]+$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: privileged prompt fields reject all controls
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

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

function isSafeRepoPath(p: string): boolean {
	if (p.length === 0 || isAbsolute(p) || p.startsWith("~")) return false;
	if (CONTROL_CHAR.test(p)) return false;
	return !p.split(/[\\/]/).includes("..");
}

interface ReviewTarget {
	path: string;
	identity: string;
}

/**
 * Resolve a review repository strictly beneath the immutable authority root.
 * The main worktree keeps the explicit `__main__` sentinel; nested repositories
 * must prove both physical containment and their own git toplevel, then derive
 * identity from the origin remote rather than accepting caller authority.
 */
export async function resolveReviewTarget(
	authorityRoot: string,
	requestedRepoPath?: string,
): Promise<ReviewTarget> {
	if (!requestedRepoPath) {
		return { path: authorityRoot, identity: "__main__" };
	}
	const root = await realpath(authorityRoot);
	const target = await realpath(resolve(root, requestedRepoPath));
	const rel = relative(root, target);
	if (
		!rel ||
		rel === ".." ||
		rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
		isAbsolute(rel)
	) {
		throw new Error("target must be strictly contained in the bound worktree");
	}
	const { stdout: toplevelOut } = await execFileAsync(
		"git",
		["-C", target, "rev-parse", "--show-toplevel"],
		{ timeout: 15_000 },
	);
	const toplevel = await realpath(toplevelOut.trim());
	if (toplevel !== target) {
		throw new Error("target must be the root of a nested git repository");
	}
	const { stdout: remoteOut } = await execFileAsync(
		"git",
		["-C", target, "remote", "get-url", "origin"],
		{ timeout: 15_000 },
	);
	return { path: target, identity: normalizeRepoIdentity(remoteOut.trim()) };
}

function normalizeRepoIdentity(remote: string): string {
	const withoutQuery = remote.split(/[?#]/, 1)[0] ?? remote;
	const pathPart = withoutQuery.includes("://")
		? new URL(withoutQuery).pathname
		: withoutQuery.replace(/^[^@/]+@[^:]+:/, "");
	const pieces = pathPart
		.replace(/\\/g, "/")
		.replace(/\/+$/, "")
		.replace(/\.git$/i, "")
		.split("/")
		.filter(Boolean);
	if (pieces.length < 2) {
		throw new Error(
			"nested repository origin cannot be normalized to owner/repo",
		);
	}
	const owner = pieces.at(-2)!;
	const repo = pieces.at(-1)!;
	if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
		throw new Error("nested repository origin contains an invalid owner/repo");
	}
	return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
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
	/** Per-execution serialization chains. */
	private readonly execChains = new Map<string, Promise<void>>();
	private readonly retryTimers = new Map<string, unknown>();
	private readonly now: () => number;
	private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;
	private stopped = false;

	constructor(deps: ReviewCoordinatorDeps) {
		this.store = deps.store;
		this.deps = deps;
		this.log =
			deps.logger ?? ((m: string) => console.log(`[review-coordinator] ${m}`));
		this.now = deps.now ?? Date.now;
		this.setTimer =
			deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
		this.clearTimer =
			deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
	}

	stop(): void {
		this.stopped = true;
		for (const handle of this.retryTimers.values()) this.clearTimer(handle);
		this.retryTimers.clear();
	}

	/**
	 * FLY-1278 supervised Lead override. The caller supplies intent and a
	 * locator; StateStore derives every finding audit field from a delivered
	 * review job. Free-form gate/request text is deliberately not authority.
	 */
	async reviewRuling(
		payload: ReviewRulingPayload,
	): Promise<ReviewRulingResult> {
		const projectName = str(payload.projectName);
		const rationale = str(payload.rationale);
		const ruledBy = str(payload.ruledBy);
		const revokeRulingId = str(payload.revokeRulingId);
		if (
			!projectName ||
			projectName.length > 128 ||
			!PROJECT_NAME.test(projectName) ||
			!validPrivilegedText(rationale, 2_000) ||
			!validPrivilegedText(ruledBy, 64)
		) {
			return rejectRuling(400, "invalid projectName, rationale, or ruledBy");
		}

		if (revokeRulingId) {
			if (!validPrivilegedText(revokeRulingId, 128)) {
				return rejectRuling(400, "invalid revokeRulingId");
			}
			const ruling = this.store.revokeReviewFindingRuling({
				projectName,
				rulingId: revokeRulingId,
				revokedBy: ruledBy!,
				reason: rationale!,
			});
			return ruling
				? { accepted: true, httpStatus: 200, ruling }
				: rejectRuling(404, `review ruling ${revokeRulingId} not found`);
		}

		const issue = str(payload.issue);
		const findingKey = str(payload.findingKey);
		const requestId = str(payload.requestId);
		const findingIndex =
			typeof payload.findingIndex === "number" &&
			Number.isInteger(payload.findingIndex) &&
			payload.findingIndex >= 0
				? payload.findingIndex
				: undefined;
		const disposition = str(payload.disposition);
		const followUpIssue = str(payload.followUpIssue);
		const executionId = str(payload.executionId);
		const findingLocator = findingKey !== undefined;
		const requestLocator =
			requestId !== undefined || findingIndex !== undefined;
		if (
			!issue ||
			!ISSUE_REF.test(issue) ||
			findingLocator === requestLocator ||
			(requestLocator && (!requestId || findingIndex === undefined)) ||
			(findingKey !== undefined && !validPrivilegedText(findingKey, 128)) ||
			(requestId !== undefined && !validPrivilegedText(requestId, 128)) ||
			(executionId !== undefined && !validPrivilegedText(executionId, 128)) ||
			(disposition !== "overruled" && disposition !== "follow_up") ||
			(disposition === "follow_up" &&
				(!followUpIssue || !FOLLOW_UP_REF.test(followUpIssue))) ||
			(disposition === "overruled" && followUpIssue !== undefined)
		) {
			return rejectRuling(
				400,
				"invalid issue, locator, disposition, or follow-up",
			);
		}

		const recorded = this.store.recordReviewFindingRuling({
			projectName,
			issue,
			...(findingKey ? { findingKey } : {}),
			...(requestId ? { requestId } : {}),
			...(findingIndex !== undefined ? { findingIndex } : {}),
			disposition,
			...(followUpIssue ? { followUpIssue } : {}),
			rationale: rationale!,
			ruledBy: ruledBy!,
			...(executionId ? { executionId } : {}),
		});
		if (recorded.status === "issue_not_found") {
			return rejectRuling(
				404,
				`issue ${issue} not found in project ${projectName}`,
			);
		}
		if (recorded.status === "finding_not_found") {
			return rejectRuling(400, "finding was not present in a delivered review");
		}
		if (
			recorded.status === "issue_ambiguous" ||
			recorded.status === "finding_ambiguous" ||
			recorded.status === "conflict"
		) {
			return rejectRuling(409, recorded.status);
		}
		if (!recorded.ruling) {
			return rejectRuling(500, "review ruling was not persisted");
		}

		if (recorded.status === "created") {
			const sourceJob = this.store.getCodexReviewJob(
				recorded.ruling.source_request_id,
			);
			await this.emitReviewAlert({
				kind: "review_ruling_recorded",
				eventId: `review-ruling:${recorded.ruling.ruling_id}`,
				issueId:
					recorded.ruling.issue_identifier ??
					recorded.ruling.issue_id_canonical,
				...(sourceJob ? { executionId: sourceJob.execution_id } : {}),
				rulingId: recorded.ruling.ruling_id,
				message: `Lead recorded governance ruling ${recorded.ruling.ruling_id} for ${recorded.ruling.finding_key}.`,
			});
		}
		if (!recorded.ruling.notified_at) {
			await this.notifyReviewRuling(recorded.ruling);
		}
		return {
			accepted: true,
			httpStatus: recorded.status === "created" ? 201 : 200,
			ruling: recorded.ruling,
		};
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
		const requestedRepoPath = str(payload.targetRepoPath);
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
		if (
			requestedRepoPath &&
			(!isSafeRepoPath(requestedRepoPath) ||
				requestedRepoPath.length > TARGET_REPO_PATH_MAX)
		) {
			return reject(
				400,
				"targetRepoPath must be a safe relative repository path",
			);
		}

		const session = this.store.getSession(executionId);
		if (!session) return reject(404, `unknown execution ${executionId}`);
		const projectName = session.project_name;
		const worktreeBinding = this.store.getWorktreeBinding(executionId);
		if (!worktreeBinding) {
			return reject(
				422,
				`execution ${executionId} has no immutable worktree binding`,
			);
		}
		let reviewTarget: ReviewTarget;
		try {
			reviewTarget = await resolveReviewTarget(
				worktreeBinding.path,
				requestedRepoPath,
			);
		} catch (err) {
			return reject(
				422,
				`invalid review target: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

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
				existing.review_type !== reviewType ||
				existing.target_repo_identity !== reviewTarget.identity ||
				(existing.target_repo_path ?? worktreeBinding.path) !==
					reviewTarget.path
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
				const lineageTip =
					existing.failure_reason === "head_moved"
						? this.store.getCodexReviewJobByQuestionId(existing.question_id)
						: null;
				if (lineageTip && lineageTip.request_id !== existing.request_id) {
					if (lineageTip.status === "pending") {
						this.enqueue(lineageTip.request_id, lineageTip.execution_id);
					} else if (
						(lineageTip.status === "done" || lineageTip.status === "skipped") &&
						!lineageTip.responded_at
					) {
						await this.deliverStoredResponse(lineageTip);
					}
				} else {
					this.enqueue(existing.request_id, existing.execution_id);
				}
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
			this.failReviewJob(requestId, acceptGateFailureReason(gate));
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
			const head = await this.tryDeriveHead(executionId, reviewTarget.path);
			if (!head) {
				return reject(
					422,
					`cannot derive a trusted head for ${executionId} (target ${reviewTarget.path})`,
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
				targetRepoPath: reviewTarget.path,
				targetRepoIdentity: reviewTarget.identity,
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
					targetRepoIdentity: reviewTarget.identity,
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

		const round =
			this.store.countCodexReviewJobs(
				executionId,
				reviewType,
				reviewTarget.identity,
			) + 1;
		const priorSession = this.store.latestCodexReviewerSessionState(
			executionId,
			reviewType,
			reviewTarget.identity,
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
			targetRepoPath: reviewTarget.path,
			targetRepoIdentity: reviewTarget.identity,
			frozenHeadSha,
			reviewerSessionUuid: priorSession.sessionUuid,
			reviewerSessionGeneration: priorSession.generation,
			reviewerSessionFailureStreak: priorSession.failureStreak,
			authorFamily,
		});
		if (!insert.inserted) {
			// R13 MEDIUM-2: concurrent first POST — the row already exists.
			// Validate it is the SAME binding, then defer to the winner (who
			// enqueued); do not double-enqueue or misreport duplicate:false.
			if (
				insert.job.question_id !== questionId ||
				insert.job.execution_id !== executionId ||
				insert.job.review_type !== reviewType ||
				insert.job.target_repo_identity !== reviewTarget.identity ||
				(insert.job.target_repo_path ?? worktreeBinding.path) !==
					reviewTarget.path
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
		for (const ruling of this.store.listPendingReviewRulingNotifications()) {
			void this.notifyReviewRuling(ruling).catch((err) => {
				this.log(
					`ruling notification redrive failed for ${ruling.ruling_id}: ${err instanceof Error ? err.message : String(err)}`,
				);
			});
		}
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
		const scheduled = this.store.listScheduledCodexReviewJobs();
		for (const job of scheduled) this.armRetryTimer(job);
		return jobs.length + scheduled.length;
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
				targetRepoIdentity: job.target_repo_identity,
				targetPrHeadSha: job.frozen_head_sha,
				issueId: job.issue_id ?? session.issue_id,
				projectName: job.project_name,
			});
		}
		if (
			job.status !== "skipped" &&
			job.payload_version === 2 &&
			!job.response_json
		) {
			this.alert(
				`review ${job.request_id}: payload_version=2 is missing canonical response_json — outbox delivery and authority commit refused.`,
			);
			return;
		}
		// R17: the server-only delivery nonce makes this payload unforgeable —
		// a runner pre-writing a "predictable" bridge response cannot know it.
		const nonceField = job.delivery_nonce
			? { deliveryNonce: job.delivery_nonce }
			: {};
		const content: Record<string, unknown> | string =
			job.status === "skipped"
				? {
						reviewVerdict: "SKIPPED",
						requestId: job.request_id,
						note: "codex_skip is active for this execution — review sanctioned as skipped; proceed.",
						...nonceField,
					}
				: job.payload_version === 2 && job.response_json
					? job.response_json
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
			// R13 HIGH-3: this link starts only after its execution predecessor.
			// A stop while that predecessor runs prevents this reviewer from starting.
			if (this.stopped) return;
			try {
				await this.runJob(requestId);
			} catch (err) {
				this.log(
					`job ${requestId} crashed: ${err instanceof Error ? err.message : String(err)}`,
				);
				try {
					this.failReviewJob(requestId, "internal_error");
				} catch {
					/* store unavailable — job stays running, boot redrive recovers */
				}
			}
		});
		this.execChains.set(executionId, next);
		void next.finally(() => {
			if (this.execChains.get(executionId) === next) {
				this.execChains.delete(executionId);
			}
		});
	}

	// ── job execution ──────────────────────────────────────────────────────

	private async runJob(requestId: string): Promise<void> {
		const job = this.store.getCodexReviewJob(requestId);
		if (!job) return;
		if (!this.store.claimCodexReviewJobRunning(requestId)) return;
		const session = this.store.getSession(job.execution_id);
		if (!session) {
			this.failReviewJob(requestId, "session_missing");
			this.alert(
				`review job ${requestId} (${job.issue_id ?? job.execution_id}) failed: StateStore session ${job.execution_id} is missing; retry requires restoring or replacing the bound execution.`,
			);
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
				job.target_repo_identity,
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

		// A boot redrive or queued job may outlive its gate. Re-prove the binding
		// before allocating a reviewer session or spending reviewer quota. This is
		// intentionally after request-bound authority restoration above: a crash
		// after authority commit must still restore its terminal verdict/outbox.
		const preflightGate = this.inspectGate(
			job.project_name,
			job.question_id,
			job.execution_id,
			job.review_type,
		);
		if (preflightGate.state !== "open") {
			this.failReviewJob(
				requestId,
				runtimeGateFailureReason(preflightGate.state),
			);
			this.alert(
				`claude review ${requestId}: gate ${job.question_id} is ${preflightGate.state} before reviewer start — no reviewer started.`,
			);
			return;
		}

		const cwd =
			job.target_repo_path ??
			this.store.getWorktreeBinding(job.execution_id)?.path;
		if (!cwd) {
			this.failReviewJob(requestId, "worktree_missing");
			this.alert(
				`review job ${requestId} (${job.issue_id ?? job.execution_id}) failed: no persisted worktree`,
			);
			return;
		}
		if (job.review_type === "code") {
			const current = await this.tryDeriveHead(job.execution_id, cwd);
			const frozen = job.frozen_head_sha?.toLowerCase();
			if (!current || !frozen || current !== frozen) {
				this.handleHeadMoved(job, current);
				this.alert(
					`claude review ${requestId}: head moved before reviewer start (frozen ${frozen ?? "?"} vs current ${current ?? "?"}) — no reviewer started.`,
				);
				return;
			}
		}

		// reviewer session: round 1 gets a FRESH uuid at run time (a retried
		// round-1 must not collide with a half-created claude session);
		// rerounds resume the persisted prior-round uuid. Head preflight above
		// deliberately runs first so a stale request never consumes a UUID.
		let sessionUuid = job.reviewer_session_uuid;
		let resume = true;
		if (job.round <= 1 || !sessionUuid) {
			sessionUuid = randomUUID();
			this.store.setCodexReviewJobReviewerSession(requestId, sessionUuid);
			resume = false;
		}

		const policyEnabled = this.deps.reviewSeverityPolicyEnabled ?? true;
		// FLY-1278 R2 #1: one immutable pre-prompt snapshot is reused after the
		// reviewer returns. Mid-round create/revoke takes effect next round only.
		const rulingSnapshot: readonly ReviewFindingRulingSnapshot[] = policyEnabled
			? Object.freeze(
					(
						this.deps.listActiveReviewFindingRulings?.({
							projectName: job.project_name,
							issueId: job.issue_id ?? session.issue_id,
						}) ?? []
					).map((ruling) => Object.freeze({ ...ruling })),
				)
			: Object.freeze([]);
		const governancePrompt = policyEnabled
			? buildGovernancePromptSegment(rulingSnapshot, job.review_type)
			: { text: "", elided: 0 };
		if (governancePrompt.elided > 0) {
			await this.emitReviewAlert({
				kind: "review_advisory_pass",
				eventId: `review-advisory:${requestId}:governance-elided`,
				issueId: job.issue_id ?? session.issue_id,
				executionId: job.execution_id,
				requestId,
				message: `${governancePrompt.elided} older active governance ruling(s) were elided from the bounded reviewer prompt; review whether stale rulings should be revoked.`,
			});
		}
		const roundRunner = this.deps.reviewRound ?? runClaudeReviewRound;
		const runRound = (roundResume: boolean, roundSessionUuid: string) =>
			roundRunner({
				prompt: this.buildPrompt(
					job,
					roundResume,
					policyEnabled,
					governancePrompt.text,
				),
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
			const fallbackGate = this.inspectGate(
				job.project_name,
				job.question_id,
				job.execution_id,
				job.review_type,
			);
			if (fallbackGate.state !== "open") {
				this.failReviewJob(
					requestId,
					runtimeGateFailureReason(fallbackGate.state),
					composeFailureRaw(failedAttempts),
				);
				this.alert(
					`claude review ${requestId}: gate ${job.question_id} closed before the lost-session fallback — no fresh reviewer started.`,
				);
				return;
			}
			if (job.review_type === "code") {
				const current = await this.tryDeriveHead(job.execution_id, cwd);
				const frozen = job.frozen_head_sha?.toLowerCase();
				if (!current || !frozen || current !== frozen) {
					this.handleHeadMoved(job, current, composeFailureRaw(failedAttempts));
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
		if (
			outcome.repairedTrailingBrace &&
			!this.store.markCodexReviewJobTrailingBraceRepaired(requestId)
		) {
			this.failReviewJob(requestId, "repair_audit_failed");
			this.alert(
				`claude review ${requestId}: repaired verdict audit could not be persisted — verdict refused.`,
			);
			return;
		}

		// R13 MEDIUM-1 + R14 HIGH-2: FULL gate re-validation before any
		// authority/verdict write — resolved/expired/re-purposed gates and
		// foreign answers all mean this verdict has no gate to land on, so the
		// job fails (still running → downgrade allowed) and no §7.3 record is
		// committed.
		const verdictGate = this.inspectGate(
			job.project_name,
			job.question_id,
			job.execution_id,
			job.review_type,
		);
		if (verdictGate.state !== "open") {
			this.failReviewJob(
				requestId,
				runtimeGateFailureReason(verdictGate.state),
			);
			this.alert(
				`claude review ${requestId}: gate ${job.question_id} became ${verdictGate.state} while the reviewer ran — verdict discarded (no authority written).`,
			);
			return;
		}

		const policyResult = computeEffectiveVerdict({
			reviewerVerdict: outcome.verdict,
			findings: outcome.findings,
			reviewType: job.review_type,
			rulings: rulingSnapshot,
			enabled: policyEnabled,
		});

		if (job.review_type === "code") {
			// accept-time freeze × verdict-time recheck for EVERY code verdict
			// (R3 #2 + R12 MEDIUM: findings against a moved head are as
			// misleading as a stale approval).
			const current = await this.tryDeriveHead(job.execution_id, cwd);
			const frozen = job.frozen_head_sha?.toLowerCase();
			if (!current || !frozen || current !== frozen) {
				this.handleHeadMoved(job, current);
				this.alert(
					`claude review ${requestId}: head moved (frozen ${frozen ?? "?"} vs current ${current ?? "?"}) — verdict voided.`,
				);
				return;
			}
			if (policyResult.effectiveVerdict === "APPROVED") {
				// R12 HIGH-6: the reviewer MUST echo the exact sha it reviewed —
				// a missing/mismatching echo can never become an authority record.
				if (!outcome.reviewedHeadSha || outcome.reviewedHeadSha !== frozen) {
					this.failReviewJob(requestId, "reviewed_wrong_head");
					this.alert(
						`claude review ${requestId}: reviewer reports head ${outcome.reviewedHeadSha ?? "<missing>"} but the job froze ${frozen} — approval refused.`,
					);
					return;
				}
			} else if (
				outcome.reviewedHeadSha &&
				outcome.reviewedHeadSha !== frozen
			) {
				this.failReviewJob(requestId, "reviewed_wrong_head");
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
		const baseResponsePayload = policyEnabled
			? buildVerdictPayload(job, policyResult)
			: buildLegacyVerdictPayload(job, outcome.verdict, findingsJson);
		const responsePayload = {
			...baseResponsePayload,
			...(outcome.repairedTrailingBrace
				? {
						repairedTrailingBrace: true,
						reviewAudit: "verdict parsed after trailing-brace repair",
					}
				: {}),
		};
		const responseJson = JSON.stringify(responsePayload);
		this.store.completeCodexReviewJob(
			requestId,
			policyResult.effectiveVerdict,
			findingsJson,
			policyEnabled
				? {
						reviewerVerdict: outcome.verdict,
						advisoriesJson: JSON.stringify(policyResult.advisories),
						settledJson: JSON.stringify(policyResult.settled),
						responseJson,
						payloadVersion: 2,
					}
				: undefined,
		);
		if (
			policyResult.effectiveVerdict === "APPROVED" &&
			policyResult.advisories.length > 0
		) {
			await this.emitReviewAlert({
				kind: "review_advisory_pass",
				eventId: `review-advisory:${requestId}`,
				issueId: job.issue_id ?? session.issue_id,
				executionId: job.execution_id,
				requestId,
				message: `Review ${requestId} passed with ${policyResult.advisories.length} non-blocking advisory finding(s).`,
			});
		}
		for (const dispute of policyResult.disputes) {
			await this.emitReviewAlert({
				kind: "review_ruling_disputed",
				eventId: `review-dispute:${requestId}:${dispute.ruling.rulingId}`,
				issueId: job.issue_id ?? session.issue_id,
				executionId: job.execution_id,
				requestId,
				rulingId: dispute.ruling.rulingId,
				message: `Reviewer ${dispute.kind} dispute of governance ruling ${dispute.ruling.rulingId}: ${dispute.finding.title ?? dispute.finding.findingKey}.`,
			});
		}
		const owned = await this.respond(session, job.question_id, responseJson, {
			executionId: job.execution_id,
			reviewType: job.review_type,
		});
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
			verdict: policyResult.effectiveVerdict,
		});
		this.store.stampCodexReviewJobResponded(requestId);
	}

	private failReviewerOutcome(
		job: CodexReviewJob,
		outcome: FailedClaudeReviewOutcome,
		attempts: FailedReviewAttempt[],
	): void {
		const failureRaw = composeFailureRaw(attempts);
		let retryAt: string | undefined;
		try {
			if ((this.deps.quotaAutoRetryEnabled?.() ?? true) && outcome.raw) {
				const resetAt = parseReviewQuotaResetAt(outcome.raw, this.now());
				if (resetAt !== null) {
					const gate = this.inspectGate(
						job.project_name,
						job.question_id,
						job.execution_id,
						job.review_type,
					);
					const candidate =
						resetAt + RESET_GRACE_MS + reviewRetryJitterMs(job.request_id);
					if (
						gate.state === "open" &&
						gate.expiresAtMs !== undefined &&
						candidate < gate.expiresAtMs - GATE_EXPIRY_SAFETY_MS
					) {
						retryAt = new Date(candidate).toISOString();
					}
				}
			}
		} catch (err) {
			this.log(
				`quota retry classification failed for ${job.request_id}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		const persisted = this.store.recordCodexReviewJobFailure({
			requestId: job.request_id,
			reason: outcome.reason,
			failureRaw,
			retryAt,
		});
		if (persisted.scheduled && persisted.job) {
			this.armRetryTimer(persisted.job);
		}
		if (persisted.updated && persisted.job) {
			this.emitReviewJobFailureAlert(persisted.job);
		}
		const summary = sanitizeFailureSummary(failureRaw);
		const persistedGate = persisted.job
			? this.inspectGate(
					persisted.job.project_name,
					persisted.job.question_id,
					persisted.job.execution_id,
					persisted.job.review_type,
				)
			: null;
		const recovery =
			persisted.job && persistedGate
				? this.reviewFailureRecovery(persisted.job, persistedGate.state)
				: "gate stays closed; inspect the durable review job before retrying.";
		this.alert(
			`claude review ${job.request_id} (${job.issue_id ?? job.execution_id}, ${job.review_type} R${job.round}) FAILED: ${outcome.reason} — ${recovery}${summary ? ` Evidence: ${summary}` : ""}`,
		);
	}

	private emitReviewJobFailureAlert(
		job: CodexReviewJob,
		recoveryOverride?: string,
	): void {
		const gate = this.inspectGate(
			job.project_name,
			job.question_id,
			job.execution_id,
			job.review_type,
		);
		if (
			job.failure_reason === "superseded_by_revision" ||
			gate.state === "superseded"
		) {
			this.log(
				`review job ${job.request_id} failed after a same-execution revision supersede; external failure alert suppressed`,
			);
			return;
		}
		const issueId =
			job.issue_id ??
			this.store.getSession(job.execution_id)?.issue_id ??
			job.execution_id;
		const recovery =
			recoveryOverride ?? this.reviewFailureRecovery(job, gate.state);
		const repairAudit = job.repaired_trailing_brace
			? " Verdict parsed after trailing-brace repair (repaired_trailing_brace=true)."
			: "";
		void this.emitReviewAlert({
			kind: "review_job_failed",
			eventId: `review-failed:${job.request_id}:${job.failure_attempt_count}`,
			issueId,
			executionId: job.execution_id,
			requestId: job.request_id,
			message: `Review ${job.request_id} (${job.review_type} R${job.round}) failed: ${job.failure_reason ?? "unknown"}. ${recovery}${repairAudit}`,
		});
	}

	private handleHeadMoved(
		job: CodexReviewJob,
		currentHead: string | null,
		failureRaw?: string,
	): void {
		if (!currentHead) {
			this.failReviewJob(job.request_id, "head_moved_unresolved", failureRaw);
			return;
		}
		const result = this.store.failAndRequeueCodexReviewJobForHeadMove({
			requestId: job.request_id,
			successorRequestId: randomUUID(),
			currentHeadSha: currentHead,
			failureRaw,
		});
		if (result.outcome === "exhausted" || !result.successor) {
			this.emitReviewJobFailureAlert(
				result.parent,
				"Automatic head-move retries are exhausted. Open a new review gate and submit a new request for the current head.",
			);
			return;
		}
		this.emitReviewJobFailureAlert(
			result.parent,
			`The stale review was automatically requeued as ${result.successor.request_id} on head ${result.successor.frozen_head_sha}; the original gate remains bound.`,
		);
		if (result.successor.status === "pending") {
			this.enqueue(result.successor.request_id, result.successor.execution_id);
		}
	}

	private reviewFailureRecovery(
		job: CodexReviewJob,
		gateState: ReviewGateState,
	): string {
		if (
			(job.failure_reason === "no_verdict" ||
				job.failure_reason === "reviewed_wrong_head") &&
			!job.reviewer_session_uuid &&
			job.retired_reviewer_session_uuid
		) {
			const scheduled = job.retry_at
				? `automatic same-request retry is scheduled for ${job.retry_at}; `
				: "";
			return `${scheduled}reviewer session has already been replaced; retry this same requestId to start fresh. The gate remains closed.`;
		}
		if (job.retry_at) {
			return `automatic same-request retry is scheduled for ${job.retry_at}; the gate remains closed.`;
		}
		if (
			job.failure_reason === "head_moved" ||
			job.failure_reason === "reviewed_wrong_head"
		) {
			return "The reviewed head is stale or mismatched. Submit a new requestId to freeze and review the current head.";
		}
		if (
			job.failure_reason === "session_missing" ||
			job.failure_reason === "worktree_missing"
		) {
			return "Restore or replace the execution/worktree binding, then retry only if the bound review gate is verified open.";
		}
		if (
			job.failure_reason === "gate_answered" ||
			job.failure_reason === "gate_answered_externally" ||
			job.failure_reason === "gate_expired" ||
			job.failure_reason === "gate_missing" ||
			job.failure_reason === "gate_mismatch"
		) {
			return "The bound review gate is no longer open. Open a new review gate and submit a new request.";
		}
		if (gateState === "unknown") {
			return "The bound review gate could not be verified. Inspect CommDB and the gate before choosing a recovery path.";
		}
		if (gateState === "open") {
			return "Retry POST /review-requests with the same requestId; the gate remains closed.";
		}
		return "The bound review gate is no longer open. Open a new review gate and submit a new request.";
	}

	private failReviewJob(
		requestId: string,
		reason: string,
		failureRaw?: string,
	): void {
		const persisted = this.store.recordCodexReviewJobFailure({
			requestId,
			reason,
			failureRaw,
		});
		if (persisted.updated && persisted.job) {
			this.emitReviewJobFailureAlert(persisted.job);
		}
	}

	private armRetryTimer(job: CodexReviewJob, notBeforeMs?: number): void {
		if (this.stopped || !job.retry_at) return;
		const dueAt = Date.parse(job.retry_at);
		if (!Number.isFinite(dueAt)) return;
		const previous = this.retryTimers.get(job.request_id);
		if (previous !== undefined) this.clearTimer(previous);
		const target = Math.max(dueAt, notBeforeMs ?? dueAt);
		const delay = Math.max(
			0,
			Math.min(MAX_TIMER_DELAY_MS, target - this.now()),
		);
		try {
			const handle = this.setTimer(() => {
				this.retryTimers.delete(job.request_id);
				try {
					void this.handleScheduledRetry(job.request_id).catch((err) => {
						this.log(
							`scheduled review retry ${job.request_id} failed safely: ${err instanceof Error ? err.message : String(err)}`,
						);
					});
				} catch (err) {
					this.log(
						`scheduled review retry ${job.request_id} threw safely: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}, delay);
			this.retryTimers.set(job.request_id, handle);
		} catch (err) {
			this.log(
				`could not arm scheduled review retry ${job.request_id}; row remains patrol-visible: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	private async handleScheduledRetry(requestId: string): Promise<void> {
		if (this.stopped) return;
		const job = this.store.getCodexReviewJob(requestId);
		if (!job || job.status !== "failed" || !job.retry_at) return;
		const dueAt = Date.parse(job.retry_at);
		if (!Number.isFinite(dueAt)) return;
		if (dueAt > this.now()) {
			this.armRetryTimer(job);
			return;
		}
		let quotaAutoRetryEnabled: boolean;
		try {
			quotaAutoRetryEnabled = this.deps.quotaAutoRetryEnabled?.() ?? true;
		} catch (err) {
			this.log(
				`scheduled review retry ${requestId} could not read its kill switch; retrying the read later: ${err instanceof Error ? err.message : String(err)}`,
			);
			this.armRetryTimer(job, this.now() + KILL_SWITCH_RECHECK_MS);
			return;
		}
		if (!quotaAutoRetryEnabled) {
			this.armRetryTimer(job, this.now() + KILL_SWITCH_RECHECK_MS);
			return;
		}
		const gate = this.inspectGate(
			job.project_name,
			job.question_id,
			job.execution_id,
			job.review_type,
		);
		if (gate.state !== "open") {
			this.failReviewJob(requestId, runtimeGateFailureReason(gate.state));
			return;
		}
		if (job.review_type === "code") {
			const targetPath =
				job.target_repo_path ??
				this.store.getWorktreeBinding(job.execution_id)?.path;
			const current = targetPath
				? await this.tryDeriveHead(job.execution_id, targetPath)
				: null;
			const frozen = job.frozen_head_sha?.toLowerCase();
			if (!current || !frozen || current !== frozen) {
				this.handleHeadMoved(job, current);
				return;
			}
		}
		this.enqueue(requestId, job.execution_id);
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
			targetRepoIdentity: job.target_repo_identity,
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
			target_repo_identity: string;
			frozen_head_sha?: string;
			head_move_parent_request_id?: string;
			issue_id?: string;
			execution_id: string;
		},
		resume: boolean,
		policyEnabled: boolean,
		governancePrompt: string,
	): string {
		const legacyContract =
			`You are the CROSS-FAMILY REVIEWER for ${job.issue_id ?? job.execution_id} ` +
			`(a codex-authored change; you are the independent Claude lane). ` +
			`Actively explore this repository — do not rely on any diff alone. ` +
			`When done, output ONLY a JSON object: {"verdict": "APPROVED" | "CHANGES_REQUESTED", ` +
			`"findings": [{"severity": "HIGH|MEDIUM|LOW", "file": "...", "line": 0, "title": "...", "detail": "..."}], ` +
			`"reviewedHeadSha": "<the exact commit you reviewed, git rev-parse HEAD>"}. ` +
			`No prose outside the JSON. Your very last line must be that JSON object itself.`;
		const contract = policyEnabled
			? legacyContract.replace(
					`"findings": [{"severity": "HIGH|MEDIUM|LOW",`,
					`"findings": [{"id": "stable-short-slug", "severity": "HIGH|MEDIUM|LOW",`,
				) +
				` Severity policy: HIGH means a ship-unsafe defect in correctness, security, data loss, or authorization. MEDIUM means a non-ship-blocking improvement; LOW means a nit. Vote CHANGES_REQUESTED ONLY when at least one HIGH finding exists. If every finding is MEDIUM/LOW, vote APPROVED and list them as non-blocking advisories. Give every finding a stable "id" and reuse the same id for the same issue in every re-review round.`
			: legacyContract;
		const target =
			job.review_type === "design"
				? `Review the DESIGN/PLAN at path: ${job.target_path ?? "engineering/doc (locate the plan for this issue)"} — read it fully, verify it against the codebase, judge soundness, completeness and risk.`
				: `Review the CODE at commit ${job.frozen_head_sha ?? "HEAD"} on the current branch. Diff it against the merge base with the default branch (git diff), read the touched files in full, check correctness, security, edge cases and error handling. Skip style nitpicks.`;
		const governance = governancePrompt ? `\n\n${governancePrompt}` : "";
		if (job.round <= 1) {
			return `${contract}\n\n${target}${governance}\n\nThis is round ${job.round}.`;
		}
		if (job.head_move_parent_request_id) {
			return (
				`${contract}\n\nRound ${job.round} re-review. The reviewed head moved; perform a full review of the current head. ` +
				`${target}${governance}\n\nDo not assume findings from the stale head were fixed or still apply; inspect the complete current diff.`
			);
		}
		if (resume) {
			return (
				`${contract}\n\nRound ${job.round} re-review — you reviewed this work before in THIS session and retain that context. ` +
				`${target}${governance}\n\n` +
				(policyEnabled
					? `Focus on whether the issues NOT marked governance-settled were correctly fixed and on anything new the changes introduced.`
					: `Focus on whether the issues you raised were correctly fixed and on anything new the changes introduced.`)
			);
		}
		const prior = this.store.latestDoneCodexReviewJob(
			job.execution_id,
			job.review_type,
			job.target_repo_identity,
		);
		const priorContext = prior?.findings_json
			? `Your most recent durable findings came from review round ${prior.round}:\n${prior.findings_json}`
			: "(no reliable record of your prior findings survives — treat this as a fresh, full review)";
		return (
			`${contract}\n\nRound ${job.round} fresh re-review (the prior reviewer session was unavailable). ` +
			`${target}${governance}\n\n${priorContext}\n\n` +
			(policyEnabled
				? `Perform a full review, using the durable prior context above when available and without reopening governance-settled findings.`
				: `Perform a full review, using the durable prior context above when available.`)
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
	): ReviewGateState {
		return this.inspectGate(projectName, questionId, executionId, reviewType)
			.state;
	}

	private inspectGate(
		projectName: string,
		questionId: string,
		executionId: string,
		reviewType: "design" | "code",
	): ReviewGateInspection {
		let db: ReviewCommDb | undefined;
		try {
			db = this.deps.openCommDb(this.deps.commDbPathFor(projectName));
			const q = db.getMessageById(questionId);
			if (!q) return { state: "missing" };
			if (q.type !== "question") return { state: "mismatch" };
			if (q.from_agent !== executionId) return { state: "mismatch" };
			if (q.checkpoint !== `review_${reviewType}`) {
				return { state: "mismatch" };
			}
			if (q.superseded_at) {
				const supersessor = q.superseded_by
					? db.getMessageById(q.superseded_by)
					: undefined;
				if (
					supersessor?.type === "question" &&
					supersessor.from_agent === q.from_agent &&
					supersessor.checkpoint === q.checkpoint
				) {
					return { state: "superseded" };
				}
				// A cross-execution or incomplete supersede marker is terminal but
				// not proven benign. Keep it on the fail-loud answered path.
				return { state: "answered" };
			}
			if (q.resolved_at) return { state: "answered" };
			const expiresAtMs = q.expires_at ? Date.parse(q.expires_at) : undefined;
			if (expiresAtMs !== undefined && Number.isFinite(expiresAtMs)) {
				if (expiresAtMs < this.now()) return { state: "expired", expiresAtMs };
			}
			if (db.getResponse(questionId)) return { state: "answered", expiresAtMs };
			return {
				state: "open",
				...(expiresAtMs !== undefined && Number.isFinite(expiresAtMs)
					? { expiresAtMs }
					: {}),
			};
		} catch (err) {
			this.log(
				`CommDB check failed for ${questionId}: ${err instanceof Error ? err.message : String(err)}`,
			);
			return { state: "unknown" }; // unreachable CommDB → fail-close
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
		content: Record<string, unknown> | string,
		binding: { executionId: string; reviewType: "design" | "code" },
	): Promise<boolean> {
		const contentJson =
			typeof content === "string" ? content : JSON.stringify(content);
		const db = this.deps.openCommDb(
			this.deps.commDbPathFor(session.project_name),
		);
		try {
			const delivery = db.insertReviewResponseIfGateOpen({
				questionId,
				fromAgent: "bridge",
				content: contentJson,
				expectedOwner: binding.executionId,
				expectedCheckpoint: `review_${binding.reviewType}`,
			});
			if (!delivery) return false;
		} finally {
			db.close();
		}
		// FLY-1257 HIGH-1: mark the answered review gate's marker so a resident
		// codex `/goal` resumes at once (its `isWaiting()` reads `answeredAt`),
		// instead of waiting ~72h for the deadline watcher. Best-effort — a marker
		// failure must never fail the answer we already durably wrote.
		try {
			this.deps.markGateAnswered?.(questionId, session.execution_id);
		} catch (err) {
			this.log(
				`gate marker mark failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return true;
	}

	private async tryDeriveHead(
		executionId: string,
		targetRepoPath: string,
	): Promise<string | null> {
		const derive = this.deps.deriveHead ?? deriveWorktreeHead;
		try {
			return await derive(targetRepoPath);
		} catch (err) {
			this.log(
				`head derivation failed for ${executionId}: ${err instanceof Error ? err.message : String(err)}`,
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

	private async emitReviewAlert(event: ReviewAlertEvent): Promise<void> {
		try {
			await this.deps.emitReviewAlert?.(event);
		} catch (err) {
			this.log(
				`review alert ${event.eventId} failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	private async notifyReviewRuling(ruling: ReviewFindingRuling): Promise<void> {
		const sourceJob = this.store.getCodexReviewJob(ruling.source_request_id);
		const session = sourceJob
			? this.store.getSession(sourceJob.execution_id)
			: undefined;
		const text = formatReviewRulingThreadPost(ruling);
		let ok = false;
		if (session && this.deps.postReviewRulingThread) {
			try {
				ok = (await this.deps.postReviewRulingThread({ session, text })).ok;
			} catch (err) {
				this.log(
					`review ruling thread post failed for ${ruling.ruling_id}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		if (ok) {
			this.store.markReviewFindingRulingNotified(ruling.ruling_id);
			return;
		}
		await this.emitReviewAlert({
			kind: "review_ruling_notify_failed",
			eventId: `review-ruling:${ruling.ruling_id}:notify_failed`,
			issueId: ruling.issue_identifier ?? ruling.issue_id_canonical,
			...(sourceJob ? { executionId: sourceJob.execution_id } : {}),
			rulingId: ruling.ruling_id,
			message: `Governance ruling ${ruling.ruling_id} is active, but its issue-thread audit post failed and remains pending for boot redrive.`,
		});
	}
}

function str(v: unknown): string | undefined {
	return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

export const REVIEW_POLICY_NOTE = "medium_low_findings_are_non_blocking_v1";

export function buildVerdictPayload(
	job: Pick<
		CodexReviewJob,
		"request_id" | "round" | "frozen_head_sha" | "delivery_nonce"
	>,
	result: EffectiveReviewVerdict,
): Record<string, unknown> {
	return {
		reviewVerdict: result.effectiveVerdict,
		reviewerVerdict: result.reviewerVerdict,
		requestId: job.request_id,
		round: job.round,
		findings: result.findings,
		advisories: result.advisories,
		settled: result.settled,
		policyNote: REVIEW_POLICY_NOTE,
		...(job.frozen_head_sha ? { reviewedHeadSha: job.frozen_head_sha } : {}),
		...(job.delivery_nonce ? { deliveryNonce: job.delivery_nonce } : {}),
	};
}

function buildLegacyVerdictPayload(
	job: Pick<
		CodexReviewJob,
		"request_id" | "round" | "frozen_head_sha" | "delivery_nonce"
	>,
	verdict: string,
	findingsJson: string | undefined,
): Record<string, unknown> {
	return {
		reviewVerdict: verdict,
		requestId: job.request_id,
		round: job.round,
		findings: safeParseArray(findingsJson),
		...(job.frozen_head_sha ? { reviewedHeadSha: job.frozen_head_sha } : {}),
		...(job.delivery_nonce ? { deliveryNonce: job.delivery_nonce } : {}),
	};
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

function rejectRuling(httpStatus: number, reason: string): ReviewRulingResult {
	return { accepted: false, httpStatus, reason };
}

function validPrivilegedText(
	value: string | undefined,
	maxLength: number,
): value is string {
	return (
		value !== undefined &&
		value.length > 0 &&
		value.length <= maxLength &&
		!CONTROL_CHAR.test(value)
	);
}

function formatReviewRulingThreadPost(ruling: ReviewFindingRuling): string {
	const disposition =
		ruling.disposition === "follow_up"
			? `follow-up ${ruling.follow_up_issue}`
			: "overruled";
	const title = ruling.finding_title
		? ` — ${JSON.stringify(ruling.finding_title.slice(0, 200))}`
		: "";
	return (
		`⚖️ Review governance ruling recorded\n` +
		`ruling_id: ${ruling.ruling_id}\n` +
		`finding: ${ruling.finding_key}${title}\n` +
		`disposition: ${disposition}\n` +
		`ruled_by: ${ruling.ruled_by}\n` +
		`reason: ${ruling.rationale}`
	);
}
