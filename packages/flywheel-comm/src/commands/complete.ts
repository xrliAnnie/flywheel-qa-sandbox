/**
 * FLY-108: Runner-driven `session_completed` emitter.
 *
 * Terminal event that drives WorkflowFSM to a terminal state + (when merged)
 * triggers `runPostShipFinalization` on Bridge. Must be reliable (retry with
 * exponential backoff, fail-close + marker file on all failure) because a
 * lost event means the bug this command is meant to fix reproduces verbatim.
 *
 * Payload shape is aligned field-by-field with `TeamLeadClient.emitCompleted()`
 * (`packages/edge-worker/src/ExecutionEventEmitter.ts:61-85`) and the Bridge
 * consumers in `packages/teamlead/src/bridge/event-route.ts:313-553`.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { normalizeOptionalBearer } from "flywheel-config";
import { CommDB } from "../db.js";
import {
	type DesignHtmlEvidence,
	findDesignHtmlPaths,
} from "../design-html-evidence.js";
import { resolveFounderId } from "../founder-attribution.js";
import {
	type FounderReviewVerdict,
	resolveFounderReviewVerdictAtCommit,
} from "../founder-review.js";
import { createReadonlySqliteFounderReviewStateReader } from "../founder-review-sqlite.js";
import { resolveRunnerStateDir } from "../runner-state.js";
import { truncateCodePoints } from "../text-truncate.js";
import { resolveStateDbPath } from "./verify-approval.js";
import { currentWorkflowCompletionActivationFromEnv } from "./workflow-activation.js";

// FLY-222 #1: `no_code` is the terminal route for a runner-driven no-code /
// no-merge clean success (e.g. the scheduled learning Runner — reads, analyzes,
// creates issue drafts + memory, never writes code or merges). The Bridge maps
// it to terminal `completed` (NOT awaiting_review), so the runner doesn't get
// stuck and a fixed reusable trigger issue isn't 409-blocked next cadence.
// FLY-493: `pr_handoff` is the terminal route for a no-transport (antigravity)
// Runner that builds + opens a PR but cannot be woken to drive the founder-gated
// ship. The Bridge maps it to terminal `completed` (NOT awaiting_review, so no
// wake-dependent approve loop) while recording PR + `ready_to_merge` evidence;
// the founder ships the PR by hand. REQUIRES --pr, REJECTS --merged.
const VALID_ROUTES = new Set([
	"auto_approve",
	"needs_review",
	"blocked",
	// FLY-1505: non-terminal ship-attempt settlement. The Bridge records the
	// failed/stalled attempt while preserving approved_to_ship.
	"ship_attempt_failed",
	"no_code",
	"pr_handoff",
	// FLY-793: DAG workflow Design phase completion (docs committed, no PR/merge).
	"phase_design_complete",
]);

const ATTEMPT_COUNT = 4;
const ATTEMPT_TIMEOUT_MS = 5000;
const BACKOFF_MS = [1000, 2000, 4000] as const;

type Evidence = {
	// FLY-493: `ready_to_merge` (pr_handoff) joins `merged` — a no-transport
	// Runner records PR evidence without a merge.
	landingStatus?: {
		status: "merged" | "ready_to_merge";
		prNumber: number;
		targetRepoPath?: string;
	};
	commitCount: number;
	filesChangedCount: number;
	linesAdded: number;
	linesRemoved: number;
	diffSummary: string;
	changedFilePaths: string[];
	commitMessages: string[];
	/** FLY-1505: PR identity for a non-terminal ship-attempt receipt. */
	prNumber?: number;
	/**
	 * FLY-191 Phase 2 (§5.5.2): the worktree HEAD at completion time. For
	 * route=needs_review this is the PR head the review request is bound to;
	 * the Bridge persists it as `sessions.pr_head_sha`, and `verify-approval`
	 * fail-closes unless the approval matches the runner's CURRENT head.
	 * Omitted (NOT defaulted) when git is unavailable — verify-approval treats
	 * a missing persisted sha as not-approved. Field name matches
	 * ExecutionEvidence.headSha (the in-process emitter path) so both /events
	 * producers stay field-aligned.
	 */
	headSha?: string;
};

type Payload = {
	decision: { route: string };
	evidence: Evidence;
	sessionRole: string;
	summary?: string;
	exitReason: string;
	issueIdentifier?: string;
	/**
	 * FLY-191 Phase 2 (Codex PR R1 CRITICAL): the CommDB question id from
	 * `gate approve_to_ship --no-block` — binds this review request to ONE
	 * exact question. The Bridge persists it as the session's
	 * review_question_id; verify-approval honors a response ONLY on it.
	 */
	reviewQuestionId?: string;
	/** FLY-1404: minted only after the CLI proves committed issue-scoped HTML. */
	designHtmlEvidence?: DesignHtmlEvidence;
	workflowActivation?: {
		activationId: string;
		runId: string;
		nodeId: string;
		attempt: number;
		turnEpoch: number;
	};
};

export interface CompleteOpts {
	route: string;
	pr?: number;
	merged: boolean;
	sessionRole?: string;
	summary?: string;
	exitReason?: string;
	baseRef?: string;
	targetRepo?: string;
	/** FLY-191 Phase 2: questionId from `gate --no-block` (route=needs_review). */
	questionId?: string;
}

export function founderReviewCompletionBlockReason(input: {
	required: boolean;
	route: string;
	verdict: FounderReviewVerdict | undefined;
}): string | undefined {
	if (
		!input.required ||
		(input.route !== "needs_review" && input.route !== "no_code")
	) {
		return undefined;
	}
	if (!input.verdict) return "founder_review authority is unavailable";
	if (input.verdict.status === "passed") return undefined;
	return `founder_review ${input.verdict.status}${
		"reason" in input.verdict ? ` (${input.verdict.reason})` : ""
	}; publish the current interactive HTML, open a new founder_review round, and wait for founder pass`;
}

export async function complete(opts: CompleteOpts): Promise<void> {
	if (!opts.route) {
		console.error("--route is required");
		process.exit(1);
	}
	if (!VALID_ROUTES.has(opts.route)) {
		console.error(
			`Invalid --route: ${opts.route}. Must be one of: ${[...VALID_ROUTES].join(", ")}`,
		);
		process.exit(1);
	}
	if (opts.merged && (opts.pr === undefined || opts.pr === null)) {
		console.error("--merged requires --pr <number>");
		process.exit(1);
	}
	if (opts.pr !== undefined && (!Number.isInteger(opts.pr) || opts.pr <= 0)) {
		console.error("--pr must be a positive integer");
		process.exit(1);
	}
	if (opts.targetRepo && opts.pr === undefined) {
		console.error("--target-repo requires --pr");
		process.exit(1);
	}
	// FLY-222 #1: no_code is a no-merge completion — reject contradictory flags
	// so a misuse can't silently look like a merged completion.
	// FLY-793: phase_design_complete is likewise a no-code/no-merge phase handoff.
	if (
		(opts.route === "no_code" || opts.route === "phase_design_complete") &&
		(opts.merged || opts.pr !== undefined)
	) {
		console.error(
			`--route ${opts.route} is for no-code/no-merge completions; do not pass --merged or --pr`,
		);
		process.exit(1);
	}
	// FLY-493: pr_handoff records an OPEN PR (no merge). PR evidence is mandatory
	// (the handoff is ambiguous without it); --merged is contradictory.
	if (opts.route === "pr_handoff") {
		// Codex code review R1: the CLI parses --pr via parseInt, so a missing
		// value or `--pr abc` yields NaN. NaN serializes to JSON `null`, which the
		// event sinks would still terminalize — reject any non-positive-integer PR
		// up front so a malformed handoff can never emit null PR evidence.
		if (
			opts.pr === undefined ||
			opts.pr === null ||
			!Number.isInteger(opts.pr) ||
			opts.pr <= 0
		) {
			console.error("--route pr_handoff requires --pr <positive integer>");
			process.exit(1);
		}
		if (opts.merged) {
			console.error(
				"--route pr_handoff is for an OPEN PR handed to the founder; do not pass --merged",
			);
			process.exit(1);
		}
	}
	if (opts.route === "ship_attempt_failed") {
		if (
			opts.pr === undefined ||
			opts.pr === null ||
			!Number.isInteger(opts.pr) ||
			opts.pr <= 0
		) {
			console.error(
				"--route ship_attempt_failed requires --pr <positive integer>",
			);
			process.exit(1);
		}
		if (opts.merged) {
			console.error(
				"--route ship_attempt_failed describes an unmerged ship attempt; do not pass --merged",
			);
			process.exit(1);
		}
		if (!opts.questionId?.trim()) {
			console.error(
				"--route ship_attempt_failed requires --question-id <approve_to_ship question id>",
			);
			process.exit(1);
		}
	}

	const execId = requireEnv("FLYWHEEL_EXEC_ID");
	const issueId = requireEnv("FLYWHEEL_ISSUE_ID");
	const projectName = requireEnv("FLYWHEEL_PROJECT_NAME");
	const bridgeUrl = requireEnv("FLYWHEEL_BRIDGE_URL");
	const ingestToken = normalizeOptionalBearer(
		process.env.FLYWHEEL_INGEST_TOKEN,
	);

	// FLY-1257 M1-c: marker presence is an explicit Codex capability signal.
	// Claude runners do not receive this env var and retain their prior behavior.
	// Marker files are runner-writable wake mirrors, not lifecycle authority:
	// query CommDB so deleting a marker cannot hide an unanswered gate.
	const gateMarkerDir = process.env.FLYWHEEL_GATE_MARKER_DIR?.trim();
	if (opts.route === "blocked" && gateMarkerDir) {
		const commDbPath = process.env.FLYWHEEL_COMM_DB?.trim();
		if (!commDbPath) {
			console.error(
				"[complete] FLYWHEEL_COMM_DB is required to prove Codex gate state; refusing route=blocked.",
			);
			process.exit(1);
		}
		let pendingGates: ReturnType<CommDB["getPendingGatesByRunner"]>;
		let db: CommDB | undefined;
		try {
			db = new CommDB(commDbPath, false);
			pendingGates = db.getPendingGatesByRunner(execId);
		} catch (error) {
			console.error(
				`[complete] cannot prove gate state from CommDB ${commDbPath}; refusing route=blocked. ${error instanceof Error ? error.message : String(error)}`,
			);
			process.exit(1);
		} finally {
			db?.close();
		}
		const pending = pendingGates[0];
		if (pending) {
			console.error(
				`[complete] gate/review pending is not blocked; refusing route=blocked while ${pending.checkpoint} gate ${pending.id} is unanswered. Continue polling with flywheel-comm check ${pending.id}.`,
			);
			process.exit(1);
		}
	}

	const sessionRole = opts.sessionRole ?? "main";
	const exitReason = opts.exitReason ?? "completed";
	const baseRef = opts.baseRef ?? deriveBaseRef(opts.targetRepo);
	const issueIdentifier = deriveIssueIdentifier();
	const evidence = collectEvidence({
		baseRef,
		merged: opts.merged,
		pr: opts.pr,
		targetRepo: opts.targetRepo,
	});
	if (opts.route === "ship_attempt_failed" && opts.pr !== undefined) {
		evidence.prNumber = opts.pr;
	}
	const designHtmlEvidence =
		opts.route === "phase_design_complete"
			? collectDesignHtmlEvidence({ baseRef, issueIdentifier, evidence })
			: undefined;
	// FLY-493: pr_handoff carries `ready_to_merge` landing evidence (the OPEN PR
	// the founder will ship). Fail-closed: if a land-status file is present
	// (FLYWHEEL_LAND_STATUS_PATH), its prNumber MUST match --pr — a mismatch is a
	// wiring bug, fail loud rather than completing with ambiguous evidence.
	if (opts.route === "pr_handoff" && opts.pr !== undefined) {
		validateLandStatusPr(opts.pr);
	}
	if (
		(opts.route === "pr_handoff" || opts.route === "needs_review") &&
		opts.pr !== undefined
	) {
		evidence.landingStatus = {
			status: "ready_to_merge",
			prNumber: opts.pr,
			...(opts.targetRepo ? { targetRepoPath: opts.targetRepo } : {}),
		};
	}
	const summary = opts.summary ?? evidence.commitMessages[0];
	let workflowActivation: ReturnType<
		typeof currentWorkflowCompletionActivationFromEnv
	>;
	try {
		workflowActivation = currentWorkflowCompletionActivationFromEnv(execId);
	} catch (error) {
		console.error(
			`[complete] workflow activation authority is unavailable; refusing route=${opts.route}. ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}
	const founderReviewRequired =
		process.env.FLYWHEEL_FOUNDER_REVIEW_REQUIRED === "1";
	if (
		founderReviewRequired &&
		(opts.route === "needs_review" || opts.route === "no_code")
	) {
		let verdict: FounderReviewVerdict | undefined;
		try {
			if (!workflowActivation) {
				throw new Error("current workflow activation is missing");
			}
			const commDbPath = process.env.FLYWHEEL_COMM_DB?.trim();
			if (!commDbPath) throw new Error("FLYWHEEL_COMM_DB is missing");
			if (!evidence.headSha) throw new Error("current Git HEAD is unavailable");
			const stateDbPath = resolveStateDbPath(undefined, process.env);
			const sqlite = createReadonlySqliteFounderReviewStateReader({
				stateDbPath,
				commDbPath,
			});
			try {
				verdict = resolveFounderReviewVerdictAtCommit({
					reader: sqlite.reader,
					runId: workflowActivation.run_id,
					repoRoot: resolve(process.cwd(), opts.targetRepo ?? "."),
					head: evidence.headSha,
					founderId: resolveFounderId({ processEnv: process.env }),
				});
			} finally {
				sqlite.close();
			}
		} catch (error) {
			console.error(
				`[complete] founder_review authority is unavailable; refusing route=${opts.route}. ${error instanceof Error ? error.message : String(error)}`,
			);
			process.exit(1);
		}
		const blocked = founderReviewCompletionBlockReason({
			required: true,
			route: opts.route,
			verdict,
		});
		if (blocked) {
			console.error(`[complete] ${blocked}`);
			process.exit(1);
		}
	}

	const payload: Payload = {
		decision: { route: opts.route },
		evidence,
		sessionRole,
		exitReason,
	};
	if (summary) payload.summary = summary;
	if (issueIdentifier) payload.issueIdentifier = issueIdentifier;
	if (designHtmlEvidence) payload.designHtmlEvidence = designHtmlEvidence;
	if (workflowActivation) {
		payload.workflowActivation = {
			activationId: workflowActivation.activation_id,
			runId: workflowActivation.run_id,
			nodeId: workflowActivation.node_id,
			attempt: workflowActivation.attempt,
			turnEpoch: workflowActivation.epoch,
		};
	}
	// FLY-191/FLY-1505: bind review requests and failed ship attempts to the
	// exact approval question that produced them. Consumers must not infer this
	// from the current session row during delayed replay.
	if (opts.questionId?.trim())
		payload.reviewQuestionId = opts.questionId.trim();
	// FLY-945 Fix C: re-opening review FROM approved_to_ship (an approval
	// expired because the head moved — verify-approval pr_head_sha mismatch)
	// REQUIRES a NEW --question-id (a fresh `gate approve_to_ship --no-block`).
	// Without one the Bridge treats this completion as the FLY-208 5a
	// evidence-gap terminal instead of a fresh review window. Warn loudly —
	// the CLI cannot see the session status, so this is advisory, not a guard.
	if (opts.route === "needs_review" && !opts.questionId?.trim()) {
		console.warn(
			"[complete] needs_review WITHOUT --question-id: if this session was " +
				"already approved_to_ship (re-review after a head move), the Bridge " +
				"will NOT re-open the review window — open a NEW " +
				"`gate approve_to_ship --no-block` and pass its questionId via " +
				"--question-id.",
		);
	}

	const body = {
		event_id: randomUUID(),
		execution_id: execId,
		issue_id: issueId,
		project_name: projectName,
		event_type: "session_completed",
		source: "flywheel-comm",
		payload,
	};
	writeRunnerStopBreadcrumb({
		execId,
		issueId,
		eventId: body.event_id,
		route: opts.route,
		pr: opts.pr,
		summary,
	});

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (ingestToken) headers.Authorization = `Bearer ${ingestToken}`;

	let lastError: string | undefined;
	let attemptsMade = 0;
	for (let attempt = 1; attempt <= ATTEMPT_COUNT; attempt += 1) {
		attemptsMade = attempt;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
		try {
			const response = await fetch(`${bridgeUrl}/events`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (response.ok) {
				console.log(
					`[complete] session_completed delivered (attempt ${attempt}/${ATTEMPT_COUNT})`,
				);
				try {
					const parsed = JSON.parse(await response.text()) as {
						completionDisposition?: unknown;
					};
					if (parsed.completionDisposition === "engine_gate_handoff") {
						console.log(
							"run 已进入 engine-owned gate;本节点已终结,不会有 approve/ship 环节找你;不要等待、不要跑 verify-approval,立即收尾退出。",
						);
					} else if (parsed.completionDisposition === "runner_ship_park") {
						console.log("已 park 等待 ship gate;等 wake,勿自行轮询。");
					}
				} catch {
					// A 2xx is authoritative; receipt guidance is best-effort compatibility.
				}
				return;
			}
			let responseText = "";
			let responseJson: Record<string, unknown> | undefined;
			try {
				responseText = (await response.text()).slice(0, 1000);
				const parsed = responseText ? JSON.parse(responseText) : undefined;
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					responseJson = parsed as Record<string, unknown>;
				}
			} catch {
				// The status remains authoritative when the response is not JSON.
			}
			const detail =
				typeof responseJson?.reason === "string"
					? responseJson.reason
					: typeof responseJson?.error === "string"
						? responseJson.error
						: responseText.trim();
			lastError = `Bridge returned ${response.status}${detail ? `: ${detail}` : ""}`;
			console.error(
				`[complete] attempt ${attempt}/${ATTEMPT_COUNT} failed: ${lastError}`,
			);
			if (
				response.status >= 400 &&
				response.status < 500 &&
				response.status !== 429 &&
				responseJson?.retryable !== true
			) {
				break;
			}
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err);
			console.error(
				`[complete] attempt ${attempt}/${ATTEMPT_COUNT} failed: ${lastError}`,
			);
		} finally {
			clearTimeout(timer);
		}
		if (attempt < ATTEMPT_COUNT) {
			const delay = BACKOFF_MS[attempt - 1] ?? 0;
			await sleep(delay);
		}
	}

	// All retries exhausted — fail-close + marker file.
	const markerWritten = writeMarker({
		execId,
		body,
		attempts: attemptsMade,
		lastError,
	});
	const markerStatus = markerWritten
		? "Marker written."
		: "Marker NOT written (see above).";
	console.error(
		`[complete] FAIL-CLOSE: ${attemptsMade} attempts failed. ${markerStatus} Last error: ${lastError}`,
	);
	process.exit(1);
}

function writeRunnerStopBreadcrumb(args: {
	execId: string;
	issueId: string;
	eventId: string;
	route: string;
	pr?: number;
	summary?: string;
}): void {
	const dir = resolveRunnerStateDir(args.execId);
	const target = join(dir, "last-complete.json");
	const temp = join(dir, `.last-complete.${process.pid}.${randomUUID()}.tmp`);
	try {
		mkdirSync(dir, { recursive: true });
		const sanitizedSummary = truncateCodePoints(
			(args.summary ?? "")
				.replace(/\p{Cc}/gu, " ")
				.replace(/\s+/g, " ")
				.trim(),
			200,
		).text;
		writeFileSync(
			temp,
			`${JSON.stringify({
				v: 1,
				completionEventId: args.eventId,
				executionId: args.execId,
				issueId: args.issueId,
				route: args.route,
				...(args.pr !== undefined ? { pr: args.pr } : {}),
				sanitizedSummary,
				createdAt: new Date().toISOString(),
			})}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
		renameSync(temp, target);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {
			// Nothing to clean up.
		}
		console.error(
			`[complete] runner-stop breadcrumb write failed (continuing): ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function collectDesignHtmlEvidence(args: {
	baseRef: string;
	issueIdentifier: string | undefined;
	evidence: Evidence;
}): DesignHtmlEvidence | undefined {
	if (process.env.FLYWHEEL_DESIGN_HTML_GATE === "0") {
		console.error(
			"[complete] design-HTML gate DISABLED via FLYWHEEL_DESIGN_HTML_GATE=0 — skipping founder design HTML validation; the Bridge process must also have FLYWHEEL_DESIGN_HTML_GATE=0 or it will reject this attestation-less completion",
		);
		return undefined;
	}
	const issueIdentifier = args.issueIdentifier;
	if (!issueIdentifier) {
		failDesignHtmlCompletion(
			"the current branch name does not contain a canonical issue token (for example feat-FLY-123)",
			undefined,
		);
	}
	const headSha = args.evidence.headSha;
	if (!headSha) {
		failDesignHtmlCompletion(
			"the committed HEAD SHA could not be proven",
			issueIdentifier,
		);
	}
	const range = `${args.baseRef}..${headSha}`;
	const changed = git([
		"diff",
		"--name-only",
		"--diff-filter=ACMR",
		range,
	]).trim();
	const candidates = findDesignHtmlPaths(
		changed ? changed.split("\n") : [],
		issueIdentifier,
	).filter((path) => gitObjectExists(headSha, path));
	if (candidates.length === 0) {
		failDesignHtmlCompletion(
			`no committed .html exists under doc/${issueIdentifier}-<slug>/ in ${range}`,
			issueIdentifier,
		);
	}
	return {
		version: 1,
		issueIdentifier,
		paths: candidates,
		headSha,
	};
}

function failDesignHtmlCompletion(
	reason: string,
	issueIdentifier: string | undefined,
): never {
	const issue = issueIdentifier ?? "<ISSUE-ID>";
	const project = process.env.FLYWHEEL_PROJECT_NAME ?? "<project>";
	const execId = process.env.FLYWHEEL_EXEC_ID ?? "<exec-id>";
	const lead = process.env.FLYWHEEL_LEAD_ID ?? "<lead-id>";
	console.error(
		`[complete] FLY-1404 founder design HTML is required before phase_design_complete: ${reason}.\n` +
			`Remediation: create doc/${issue}-<slug>/design.html with all five sections: ` +
			"① one-sentence summary ② core flow diagram/before-after ③ data and structure ④ key tradeoffs and rejected alternatives ⑤ honest boundaries (done/not done). " +
			"Commit and push the HTML, then publish without Discord delivery:\n" +
			`  node "$FLYWHEEL_COMM_CLI" publish-report --html <absolute-html-path> --project ${project} --publish-only\n` +
			"Report the hosted URL to the Lead (or publish-failed plus repo path):\n" +
			`  node "$FLYWHEEL_COMM_CLI" ask --lead ${lead} --exec-id ${execId} --report \"DESIGN-HTML ready: <hosted-url> | repo: <repo-path> | issue: ${issue}\"\n` +
			'Then re-run `node "$FLYWHEEL_COMM_CLI" complete --route phase_design_complete`. Emergency operator escape only: FLYWHEEL_DESIGN_HTML_GATE=0.',
	);
	process.exit(1);
}

function requireEnv(name: string): string {
	const v = process.env[name];
	if (!v) {
		console.error(`${name} environment variable is required`);
		process.exit(1);
	}
	return v;
}

function deriveIssueIdentifier(): string | undefined {
	try {
		const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
		const match = branch.match(/[A-Z]+-\d+/);
		return match ? match[0] : undefined;
	} catch {
		return undefined;
	}
}

function deriveBaseRef(targetRepo?: string): string {
	try {
		const base = gitAt(resolveEvidenceRepo(targetRepo), [
			"merge-base",
			"HEAD",
			"origin/main",
		]).trim();
		return base || "origin/main";
	} catch {
		return "origin/main";
	}
}

function collectEvidence(args: {
	baseRef: string;
	merged: boolean;
	pr?: number;
	targetRepo?: string;
}): Evidence {
	const { baseRef, merged, pr } = args;
	const evidenceRepo = resolveEvidenceRepo(args.targetRepo);
	const repoGit = (gitArgs: string[]) => gitAt(evidenceRepo, gitArgs);
	// Capture HEAD exactly once, before any diff/object reads. Every evidence
	// query below and the FLY-1404 HTML attestation use this immutable object id,
	// so a concurrent branch update cannot mix content from one commit with the
	// headSha of another.
	const parsedHeadSha = repoGit(["rev-parse", "HEAD"]).trim().toLowerCase();
	const headSha = /^[0-9a-f]{40}$/.test(parsedHeadSha)
		? parsedHeadSha
		: undefined;
	const range = `${baseRef}..${headSha ?? "HEAD"}`;

	const commitCount = parseInt(
		repoGit(["rev-list", "--count", range]).trim() || "0",
		10,
	);

	const numstat = repoGit(["diff", "--numstat", range]).trim();
	const numstatLines = numstat ? numstat.split("\n") : [];
	let linesAdded = 0;
	let linesRemoved = 0;
	for (const line of numstatLines) {
		const [addedStr, removedStr] = line.split("\t");
		const added = parseInt(addedStr ?? "0", 10);
		const removed = parseInt(removedStr ?? "0", 10);
		if (!Number.isNaN(added)) linesAdded += added;
		if (!Number.isNaN(removed)) linesRemoved += removed;
	}

	const nameOnly = repoGit(["diff", "--name-only", range]).trim();
	const changedFilePaths = nameOnly ? nameOnly.split("\n") : [];

	const diffSummary =
		repoGit(["diff", "--stat", range]).trim().split("\n").pop()?.trim() ?? "";

	const logOut = repoGit(["log", "--format=%s", range]).trim();
	const commitMessages = logOut ? logOut.split("\n") : [];

	const evidence: Evidence = {
		commitCount,
		filesChangedCount: changedFilePaths.length,
		linesAdded,
		linesRemoved,
		diffSummary,
		changedFilePaths,
		commitMessages,
	};
	// FLY-191 Phase 2: bind this completion to the exact head being submitted
	// for review. Full sha only; on git failure leave the field absent
	// (verify-approval fail-closes on a missing persisted sha — never guess).
	if (headSha) {
		evidence.headSha = headSha;
	}
	if (merged && pr !== undefined) {
		evidence.landingStatus = { status: "merged", prNumber: pr };
	}
	return evidence;
}

/**
 * FLY-493: fail-closed validation that a present land-status file agrees with
 * the --pr passed to `complete --route pr_handoff`. If `FLYWHEEL_LAND_STATUS_PATH`
 * is unset or the file is absent, the --pr is the sole authority (no-op). If the
 * file is present and its `prNumber` disagrees with --pr, exit 1 (loud) rather
 * than emit ambiguous handoff evidence.
 */
function validateLandStatusPr(pr: number): void {
	const path = process.env.FLYWHEEL_LAND_STATUS_PATH?.trim();
	if (!path || !existsSync(path)) return;
	let filePr: unknown;
	try {
		filePr = JSON.parse(readFileSync(path, "utf8"))?.prNumber;
	} catch (err) {
		console.error(
			`[complete] pr_handoff: land-status file ${path} is unreadable/invalid JSON: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
		process.exit(1);
	}
	if (filePr !== pr) {
		console.error(
			`[complete] pr_handoff: land-status prNumber (${String(filePr)}) does not match --pr (${pr}). Refusing to emit ambiguous handoff evidence.`,
		);
		process.exit(1);
	}
}

function git(args: string[]): string {
	return gitAt(undefined, args);
}

function gitAt(cwd: string | undefined, args: string[]): string {
	try {
		return execFileSync("git", args, {
			...(cwd ? { cwd } : {}),
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		return "";
	}
}

function resolveEvidenceRepo(targetRepo?: string): string | undefined {
	if (!targetRepo) return undefined;
	const hasControlCharacter = [...targetRepo].some((character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || code === 127;
	});
	if (
		isAbsolute(targetRepo) ||
		targetRepo.startsWith("~") ||
		targetRepo.split(/[\\/]/).includes("..") ||
		hasControlCharacter
	) {
		console.error("--target-repo must be a safe relative repository path");
		process.exit(1);
	}
	try {
		const root = realpathSync(process.cwd());
		const target = realpathSync(resolve(root, targetRepo));
		const rel = relative(root, target);
		if (
			!rel ||
			rel === ".." ||
			rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
		) {
			throw new Error("target must be strictly beneath the worktree root");
		}
		const toplevel = realpathSync(
			execFileSync("git", ["-C", target, "rev-parse", "--show-toplevel"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}).trim(),
		);
		if (toplevel !== target) {
			throw new Error("target is not an exact nested repository root");
		}
		return target;
	} catch (error) {
		console.error(
			`--target-repo is invalid: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}
}

/** True only when git proves that ref:path exists. Empty stdout is success. */
export function gitObjectExists(ref: string, path: string): boolean {
	try {
		execFileSync("git", ["cat-file", "-e", `${ref}:${path}`], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		return true;
	} catch {
		return false;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function writeMarker(args: {
	execId: string;
	body: unknown;
	attempts: number;
	lastError: string | undefined;
}): boolean {
	// Mirrors teamlead complete-marker-reconciler defaultMarkerDir(). QA slots
	// override both writer and reader; unset remains the legacy HOME path.
	const fromEnv = process.env.FLYWHEEL_COMPLETE_MARKER_DIR?.trim();
	const dir =
		fromEnv ||
		join(
			process.env.HOME ?? homedir(),
			".flywheel",
			"state",
			"complete-failed",
		);
	const markerPath = join(dir, `${args.execId}.json`);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			markerPath,
			JSON.stringify(
				{
					execution_id: args.execId,
					attempts: args.attempts,
					error: args.lastError,
					timestamp: new Date().toISOString(),
					...(typeof args.body === "object" ? args.body : {}),
				},
				null,
				2,
			),
			"utf8",
		);
		return true;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(
			`[complete] CRITICAL: marker write failed at ${markerPath}: ${msg}`,
		);
		console.error(
			`[complete] session_completed emit failed AND marker could not be persisted — stale patrol has no record of this failure. Check disk/permissions at ${dir}.`,
		);
		return false;
	}
}
