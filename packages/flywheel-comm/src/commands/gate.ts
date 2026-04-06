import { randomUUID } from "node:crypto";
import { CommDB } from "../db.js";
import {
	CONTENT_REF_THRESHOLD,
	writeContentRef,
} from "../utils/content-ref.js";

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
	/** If set, report this stage to Bridge after creating the gate question (fail-open). */
	stage?: string;
}

export interface GateResult {
	status: "answered" | "timeout" | "error";
	content?: string;
	approved?: boolean;
	exitCode: number;
}

/**
 * Generic gate command: ask → poll → resolve.
 * Blocks until the Lead responds or timeout is reached.
 *
 * Infrastructure errors (DB open/write/read failures) respect timeoutBehavior:
 * - fail-close gates: propagate the error (exit 1)
 * - fail-open gates: return {status: "error", exitCode: 0} so the runner continues
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
				try {
					const cleanupDb = new CommDB(args.dbPath);
					try {
						cleanupDb.resolveGate(questionId, 0); // 0 hours = expire NOW
					} finally {
						cleanupDb.close();
					}
				} catch {
					// Cleanup failed too — TTL will handle it eventually
				}
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

	// Phase 1b: Report stage if configured (fail-open — don't block on error)
	if (args.stage) {
		await reportStageFailOpen(args.stage);
	}

	// Phase 2: Poll for response
	const deadline = Date.now() + args.timeoutMs;

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

				const content = response.content;
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

				return { status: "answered", content, approved, exitCode: 0 };
			}
		} finally {
			pollDb.close();
		}
	}

	// Phase 3: Timeout
	const exitCode = args.timeoutBehavior === "fail-close" ? 1 : 0;
	return { status: "timeout", exitCode };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Report stage to Bridge via HTTP POST. Fail-open: errors are logged but don't throw.
 * Inlined here (instead of calling stage.ts) to avoid process.exit() side effects.
 */
async function reportStageFailOpen(stageName: string): Promise<void> {
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

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (ingestToken) headers.Authorization = `Bearer ${ingestToken}`;

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 2000);
	try {
		await fetch(`${bridgeUrl}/events`, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: controller.signal,
		});
	} catch {
		// fail-open
	} finally {
		clearTimeout(timeout);
	}
}
