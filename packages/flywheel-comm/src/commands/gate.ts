import { randomUUID } from "node:crypto";
import { CommDB } from "../db.js";
import {
	CONTENT_REF_THRESHOLD,
	writeContentRef,
} from "../utils/content-ref.js";

/**
 * Source of `timeoutBehavior` value. Two-value enum (FLY-159 Codex R2 Issue 3):
 * - "default": CLI received no `--timeout-behavior` flag, default value applied
 * - "flag": CLI received an explicit `--timeout-behavior` flag (whether typed
 *           by a human or injected by Blueprint — the CLI cannot distinguish)
 */
export type TimeoutBehaviorSource = "default" | "flag";

export interface GateArgs {
	checkpoint: string;
	lead: string;
	execId: string;
	message: string;
	dbPath: string;
	timeoutMs: number;
	timeoutBehavior: "fail-open" | "fail-close";
	cleanupTtlHours: number;
	pollIntervalMs?: number;
	/** If set, report this stage to Bridge after creating the gate question (best-effort). */
	stage?: string;
	/** FLY-159: provenance of `timeoutBehavior` for `gate_timed_out` payload. Default: "default". */
	timeoutBehaviorSource?: TimeoutBehaviorSource;
	/**
	 * FLY-191 Phase 2: non-blocking mode. Insert the question (identical
	 * checkpoint/TTL metadata to the blocking path) + report stage, then return
	 * immediately with the questionId. MUST NOT poll, resolve, or expire the
	 * question — it stays pending so GatePoller relays it to the Lead and the
	 * founder-consent path can answer it later, after this process has exited.
	 * The runner goes idle and is woken by a plain-text mailbox message; ship
	 * authority comes from `verify-approval` (trusted-source re-check), never
	 * from the wake message itself.
	 */
	noBlock?: boolean;
}

export interface GateResult {
	status: "answered" | "timeout" | "error" | "pending";
	content?: string;
	approved?: boolean;
	exitCode: number;
	/**
	 * FLY-191 Phase 2: set in no-block mode — the CommDB question id, so the
	 * runner/Bridge logs can correlate the eventual approval with this request.
	 */
	questionId?: string;
}

/**
 * Generic gate command: ask → poll → resolve.
 * Blocks until the Lead responds or timeout is reached.
 *
 * Infrastructure errors (DB open/write/read failures) respect timeoutBehavior:
 * - fail-close gates: propagate the error (exit 1)
 * - fail-open gates: return {status: "error", exitCode: 0} so the runner continues
 *
 * Timeout (FLY-159):
 * - Always cleanup CommDB pending question via resolveGate(0)
 * - fail-close: best-effort POST gate_timed_out event + stderr stop msg + exitCode=1
 * - fail-open:  stderr "continuing" msg + exitCode=0 (no event POST, by design)
 */
export async function gate(args: GateArgs): Promise<GateResult> {
	let questionId: string | undefined;
	try {
		return await gateInner(args, (id) => {
			questionId = id;
		});
	} catch (err) {
		// Infrastructure error — respect timeoutBehavior
		if (args.timeoutBehavior === "fail-open") {
			console.error(
				`[gate] Infrastructure error (fail-open, continuing): ${(err as Error).message}`,
			);
			// Best-effort cleanup: if question was already written, expire it immediately
			// so getPendingQuestions() (which filters by expires_at > now) won't return it
			if (questionId) {
				safeResolveGate(args.dbPath, questionId);
			}
			return { status: "error", exitCode: 0 };
		}
		throw err; // fail-close: let it crash
	}
}

async function gateInner(
	args: GateArgs,
	onQuestionCreated: (id: string) => void,
): Promise<GateResult> {
	const pollInterval = args.pollIntervalMs ?? 15_000;

	// Phase 1: Create question with checkpoint
	const db = new CommDB(args.dbPath);
	let questionId: string;
	try {
		const useRef =
			Buffer.byteLength(args.message, "utf-8") > CONTENT_REF_THRESHOLD;
		let contentRef: string | undefined;
		let dbContent = args.message;

		if (useRef) {
			// Two-phase write: create ref file first, then DB row
			const tempId = crypto.randomUUID();
			contentRef = writeContentRef(args.dbPath, tempId, args.message);
			dbContent = `[content_ref: ${contentRef}]`;
		}

		questionId = db.insertQuestion(args.execId, args.lead, dbContent, {
			checkpoint: args.checkpoint,
			contentRef,
			contentType: useRef ? "ref" : "text",
		});
	} finally {
		db.close();
	}

	// Notify outer scope that question was created (for cleanup on error)
	onQuestionCreated(questionId);

	// Phase 1b: Report stage if configured (best-effort — don't block on error)
	if (args.stage) {
		await reportStageBestEffort(args.stage);
	}

	// FLY-191 Phase 2: no-block mode — question is parked for the
	// founder-consent approval path; return immediately. Deliberately NO
	// resolveGate/expiry here: the pending question must remain visible to
	// GatePoller (Lead relay) and the founder-consent wrapper after this
	// process exits. Timeout escalation moves Bridge-side
	// (HeartbeatService.checkAwaitingReviewTimeout, keyed on the persisted
	// awaiting_review_entered_at — NOT on this process's lifetime).
	//
	// FLY-123: when FLYWHEEL_GATE_MARKER_DIR is set (Codex runner env,
	// injected by CodexTmuxAdapter), also write the question-bound
	// unanswered-gate marker. The marker is what (a) lets the adapter
	// classify the subsequent process exit as awaiting_gate instead of
	// terminal, and (b) lets `respond` route the mailbox wake through the
	// target runner's transport backend (Codex R3/R4). Marker write failure
	// is FAIL-CLOSED (throw → non-zero exit → the model sees the failure and
	// can retry) — a silently missing marker would strand the runner forever.
	// Claude runners never have the env set → no marker → byte-compat.
	if (args.noBlock) {
		const markerDir = process.env.FLYWHEEL_GATE_MARKER_DIR?.trim();
		if (markerDir) {
			const { writeGateMarker } = await import("../gate-marker.js");
			writeGateMarker(markerDir, {
				questionId,
				executionId: args.execId,
				backend: process.env.FLYWHEEL_RUNNER_BACKEND_ID?.trim() || "codex-tmux",
				vendor: process.env.FLYWHEEL_RUNNER_VENDOR_ID?.trim() || "codex",
				checkpoint: args.checkpoint,
				// FLY-123 code review R1 HIGH-2: persist the checkpoint's
				// CONFIGURED gate semantics — the adapter-owned deadline must
				// honor --timeout/--timeout-behavior/--cleanup-ttl exactly as
				// the blocking path would (FLY-159 parity).
				timeoutMs: args.timeoutMs,
				timeoutBehavior: args.timeoutBehavior,
				timeoutBehaviorSource: args.timeoutBehaviorSource ?? "default",
				cleanupTtlHours: args.cleanupTtlHours,
				message:
					args.message.length > 500
						? `${args.message.slice(0, 500)}…`
						: args.message,
			});
		}
		return { status: "pending", questionId, exitCode: 0 };
	}

	// Phase 2: Poll for response
	const start = Date.now();
	const deadline = start + args.timeoutMs;

	while (Date.now() < deadline) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await sleep(Math.min(pollInterval, remaining));

		const pollDb = CommDB.openReadonly(args.dbPath);
		try {
			const response = pollDb.getResponse(questionId);
			if (response) {
				// Got answer — resolve the gate
				const writeDb = new CommDB(args.dbPath);
				try {
					writeDb.resolveGate(questionId, args.cleanupTtlHours);
				} finally {
					writeDb.close();
				}

				let content = response.content;
				// If original was ref, try to parse structured response
				let approved: boolean | undefined;
				try {
					const parsed = JSON.parse(content);
					if (typeof parsed.approved === "boolean") {
						approved = parsed.approved;
					}
				} catch {
					// Plain text response — not structured
				}

				// FLY-208 6c-②: the blocking gate hands the Lead's raw reply text
				// straight back to the Runner. In the production incident the
				// Runner read a plain-text "APPROVE — ..." reply as authorization
				// and merged BEFORE verify-approval. Only structured
				// {"approved": true} carries authority — for approve_to_ship,
				// stamp every non-structured-approval answer with an explicit
				// caution so the returned text can never read as a license.
				if (args.checkpoint === "approve_to_ship" && approved !== true) {
					content = `${content}\n\nNOTE: this reply text is NOT verified approval — run verify-approval before any merge.`;
				}

				return { status: "answered", content, approved, exitCode: 0 };
			}
		} finally {
			pollDb.close();
		}
	}

	// Phase 3: Timeout — FLY-159
	// Always: cleanup CommDB question so GatePoller / bootstrap don't relay
	// it after the Runner has stopped polling.
	const waitedMs = Date.now() - start;
	safeResolveGate(args.dbPath, questionId);

	if (args.timeoutBehavior === "fail-close") {
		// Best-effort emit gate_timed_out so Lead can notify Annie via Discord.
		// fail-close *only* — fail-open gates explicitly opt into "no answer is
		// fine, keep going", emitting a high-priority Annie alert there would be
		// noise (Codex R2 Issue 2).
		await reportGateTimedOutBestEffort(args, waitedMs, questionId);
		console.error(
			`[gate] TIMEOUT (fail-close) after ${waitedMs}ms checkpoint=${args.checkpoint}; Runner should stop`,
		);
		return { status: "timeout", exitCode: 1 };
	}

	// fail-open path
	console.error(
		`[gate] TIMEOUT (fail-open) after ${waitedMs}ms; continuing as configured`,
	);
	return { status: "timeout", exitCode: 0 };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Best-effort cleanup of a CommDB gate question — expire it immediately so
 * `getPendingQuestions()` (filter by `expires_at > now`) stops returning it.
 *
 * Used by both fail-open and fail-close timeout paths (FLY-159 Codex R1 Issue 3),
 * and by the infrastructure-error catch path above. Errors are swallowed; the
 * TTL on the row will reap stale rows eventually if this fails.
 */
function safeResolveGate(dbPath: string, questionId: string): void {
	try {
		const cleanupDb = new CommDB(dbPath);
		try {
			cleanupDb.resolveGate(questionId, 0); // 0 hours = expire NOW
		} finally {
			cleanupDb.close();
		}
	} catch {
		// Cleanup failed too — TTL will handle it eventually
	}
}

/**
 * Report stage to Bridge via HTTP POST. Best-effort: errors are logged but
 * don't throw. Inlined here (instead of calling stage.ts) to avoid
 * process.exit() side effects.
 */
async function reportStageBestEffort(stageName: string): Promise<void> {
	const bridgeUrl = process.env.FLYWHEEL_BRIDGE_URL;
	const execId = process.env.FLYWHEEL_EXEC_ID;
	const issueId = process.env.FLYWHEEL_ISSUE_ID;
	const projectName = process.env.FLYWHEEL_PROJECT_NAME;
	const ingestToken = process.env.FLYWHEEL_INGEST_TOKEN;

	if (!bridgeUrl || !execId || !issueId || !projectName) return;

	const body = {
		event_id: randomUUID(),
		execution_id: execId,
		issue_id: issueId,
		project_name: projectName,
		event_type: "stage_changed",
		source: "flywheel-comm",
		payload: { stage: stageName },
	};

	await postEventBestEffort(bridgeUrl, ingestToken, body);
}

/**
 * FLY-159: Report `gate_timed_out` event to Bridge. Best-effort — errors are
 * swallowed because the Runner is already exiting fail-close; we never want a
 * Bridge outage to block the exit. Lead-side delivery reliability is handled
 * by GUARDRAIL_EVENT_TYPES + HeartbeatService retry (post-ingest only).
 *
 * Payload fields are documented in HookPayload (packages/teamlead/src/bridge/
 * hook-payload.ts) and consumed by event-route.ts mapping for `gate_timed_out`.
 */
async function reportGateTimedOutBestEffort(
	args: GateArgs,
	waitedMs: number,
	questionId: string,
): Promise<void> {
	const bridgeUrl = process.env.FLYWHEEL_BRIDGE_URL;
	const execId = process.env.FLYWHEEL_EXEC_ID;
	const issueId = process.env.FLYWHEEL_ISSUE_ID;
	const projectName = process.env.FLYWHEEL_PROJECT_NAME;
	const ingestToken = process.env.FLYWHEEL_INGEST_TOKEN;

	if (!bridgeUrl || !execId || !issueId || !projectName) return;

	// Truncate original_message to 500 chars to keep event payload small
	// (full content already lives in CommDB content_ref if it was large).
	const truncated =
		args.message.length > 500 ? `${args.message.slice(0, 500)}…` : args.message;

	const body = {
		event_id: randomUUID(),
		execution_id: execId,
		issue_id: issueId,
		project_name: projectName,
		event_type: "gate_timed_out",
		source: "flywheel-comm",
		payload: {
			checkpoint: args.checkpoint,
			exec_id: execId,
			lead_id: args.lead,
			waited_ms: waitedMs,
			original_message: truncated,
			timeout_behavior: args.timeoutBehavior,
			timeout_behavior_source: args.timeoutBehaviorSource ?? "default",
			question_id: questionId,
		},
	};

	await postEventBestEffort(bridgeUrl, ingestToken, body);
}

async function postEventBestEffort(
	bridgeUrl: string,
	ingestToken: string | undefined,
	body: unknown,
): Promise<void> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (ingestToken) headers.Authorization = `Bearer ${ingestToken}`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 2000);
	try {
		await fetch(`${bridgeUrl}/events`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: controller.signal,
		});
	} catch {
		// best-effort
	} finally {
		clearTimeout(timer);
	}
}
