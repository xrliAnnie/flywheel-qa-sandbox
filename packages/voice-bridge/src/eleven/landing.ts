/**
 * /eleven landing — FLY-1160 §4.2-4: the AssistantLanding 形态 (summary →
 * verbatim transcript chunks → close, receipt-idempotent, failure order is
 * law) applied to the /eleven trail, PLUS the durable retry face:
 *
 *   - land(): on any non-terminal failure a PENDING-LANDING envelope is
 *     written next to the receipt — the §3.3 stage-aware continuation,
 *     RESTART-SELF-CONTAINED (it carries the minutes input verbatim, so a
 *     cold-started daemon needs neither the dead brain nor in-memory state).
 *   - reconcilePendingLandings(): boot scan — for each pending envelope,
 *     confirm which stage markers ALREADY landed by reading the issue's
 *     comments back (Bridge GET /api/linear/comments, §3.3 读口) and the
 *     issue state for the close stage, rebuild the local receipt from
 *     CONFIRMED facts only, then resume the landing. Never a blind re-post;
 *     unknown schema versions are kept + fail-loud and NEVER mutate Linear.
 */
import {
	existsSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	AssistantLanding,
	type LandingInput,
	type LandingLinear,
	type LandingResult,
	type TranscriptRow,
} from "../assistant/AssistantLanding.js";

// ---------------------------------------------------------------- paths ----

export const elevenTranscriptPath = (
	stateDir: string,
	sessionId: string,
): string => join(stateDir, `${sessionId}.jsonl`);
export const elevenReceiptPath = (
	stateDir: string,
	sessionId: string,
): string => join(stateDir, `${sessionId}.landing-receipt.json`);
export const elevenPendingPath = (
	stateDir: string,
	sessionId: string,
): string => join(stateDir, `${sessionId}.pending-landing.json`);

const PENDING_SUFFIX = ".pending-landing.json";

// ------------------------------------------------------- trail adapter ----

/**
 * The /eleven trail JSONL ({t, type:"user_transcript"|"agent_response",
 * text}) → the TranscriptRow shape AssistantLanding chunks deterministically.
 * Bad lines are skipped (a torn write must not sink the record); a missing
 * file is a 0-turn meeting, not a failure.
 */
export function readElevenTranscriptRows(path: string): TranscriptRow[] {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	const rows: TranscriptRow[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let e: Record<string, unknown>;
		try {
			e = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (
			(e.type === "user_transcript" || e.type === "agent_response") &&
			typeof e.text === "string"
		) {
			rows.push({
				ts: new Date(typeof e.t === "number" ? e.t : 0).toISOString(),
				role: e.type === "user_transcript" ? "user" : "assistant",
				text: e.text,
			});
		}
	}
	return rows;
}

// --------------------------------------------------- pending envelope ----

export type PendingStage = "summary" | "transcript" | "close";

/** §3.3 stage-aware continuation — versioned, restart-self-contained. */
export interface PendingLanding {
	version: 1;
	issueId: string;
	sessionId: string;
	outcome: "not_started" | "mutation_outcome_unknown";
	stage: PendingStage;
	summary?: { marker: string };
	transcript?: { chunkIndex: number; marker: string };
	close?: { closeTarget: string };
	/** everything a cold-start re-run needs (the brain may be gone). */
	input: {
		recapText: string;
		quotes: { ts: string; text: string }[];
		confirmed: boolean;
	};
}

function atomicWriteJson(path: string, value: unknown): void {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, 2));
	renameSync(tmp, path);
}

interface ReceiptShape {
	issueId: string;
	sessionId: string;
	commentAt: string;
	commentUrl?: string;
	transcript?: {
		rowCount: number;
		chunkCount: number;
		postedChunks: number;
		completeAt?: string;
	};
}

function readJsonSafe<T>(path: string): T | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return null;
	}
}

// ------------------------------------------------------------- landing ----

export interface ElevenLandingOptions {
	stateDir: string;
	sessionId: string;
	linear: LandingLinear;
	commandName?: string;
	log?: (line: string) => void;
	now?: () => Date;
}

export class ElevenLanding {
	constructor(private readonly opts: ElevenLandingOptions) {}

	private makeLanding(): AssistantLanding {
		const { stateDir, sessionId } = this.opts;
		return new AssistantLanding({
			linear: this.opts.linear,
			receiptPath: elevenReceiptPath(stateDir, sessionId),
			transcriptPath: elevenTranscriptPath(stateDir, sessionId),
			readTranscript: () =>
				readElevenTranscriptRows(elevenTranscriptPath(stateDir, sessionId)),
			commandName: this.opts.commandName ?? "eleven",
			log: this.opts.log,
		});
	}

	/** run the landing; every non-terminal failure leaves a pending envelope
	 * on disk (durable retry face), every terminal outcome removes it. */
	async land(
		input: LandingInput,
		runOpts: { signal?: AbortSignal } = {},
	): Promise<LandingResult> {
		const { stateDir, sessionId } = this.opts;
		const pendingPath = elevenPendingPath(stateDir, sessionId);
		const r = await this.makeLanding().run(input, runOpts);
		if (r.ok || r.landedAll) {
			try {
				if (existsSync(pendingPath)) unlinkSync(pendingPath);
			} catch {
				this.opts.log?.(
					`[eleven-landing] LOUD: could not remove ${pendingPath} after a landed run`,
				);
			}
			return r;
		}
		const receipt = readJsonSafe<ReceiptShape>(
			elevenReceiptPath(stateDir, sessionId),
		);
		const stage: PendingStage = r.stage === "comment" ? "summary" : r.stage;
		const pending: PendingLanding = {
			version: 1,
			issueId: input.issueId,
			sessionId,
			outcome: r.outcomeUnknown ? "mutation_outcome_unknown" : "not_started",
			stage,
			...(stage === "summary"
				? { summary: { marker: `assistant-summary ${sessionId}` } }
				: {}),
			...(stage === "transcript"
				? {
						transcript: {
							chunkIndex: receipt?.transcript?.postedChunks ?? 0,
							marker: `assistant-transcript ${sessionId} chunk`,
						},
					}
				: {}),
			...(stage === "close" ? { close: { closeTarget: input.issueId } } : {}),
			input: {
				recapText: input.recapText,
				quotes: input.quotes,
				confirmed: input.confirmed,
			},
		};
		atomicWriteJson(pendingPath, pending);
		this.opts.log?.(
			`[eleven-landing] pending envelope written (stage=${stage}, outcome=${pending.outcome}) — boot reconciliation resumes it`,
		);
		return r;
	}
}

// ------------------------------------------------------ reconciliation ----

/** the read side of §3.3 读口 — Bridge GET /api/linear/comments. */
export interface LandingReadBack {
	comments(
		issueId: string,
		opts?: { after?: string },
	): Promise<{
		comments: { id: string; body: string }[];
		hasNextPage: boolean;
		endCursor: string | null;
		state?: string;
		stateType?: string;
	}>;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ReconcileOptions {
	stateDir: string;
	linear: LandingLinear;
	read: LandingReadBack;
	commandName?: string;
	log?: (line: string) => void;
	now?: () => Date;
}

/**
 * Boot scan: resume every pending landing whose facts can be CONFIRMED.
 * Unknown versions / illegal stage payloads are kept + fail-loud and never
 * touch Linear (§3.3). A failing reconciliation keeps its envelope for the
 * next boot — never silently dropped.
 */
export async function reconcilePendingLandings(
	opts: ReconcileOptions,
): Promise<void> {
	const log = opts.log ?? (() => {});
	let files: string[];
	try {
		files = readdirSync(opts.stateDir).filter((f) =>
			f.endsWith(PENDING_SUFFIX),
		);
	} catch {
		return; // no state dir = nothing pending
	}
	for (const f of files) {
		const path = join(opts.stateDir, f);
		const pending = readJsonSafe<PendingLanding>(path);
		// FLY-1160 §3.3 (Codex #552 R1 MEDIUM-6): FAIL-CLOSED validation — every
		// field is checked against its legal domain before ANY Linear mutation.
		// An unknown version / illegal stage / illegal outcome / malformed input
		// is kept + LOUD and never touches Linear (never guess a mutation).
		const legalStage =
			pending?.stage === "summary" ||
			pending?.stage === "transcript" ||
			pending?.stage === "close";
		const legalOutcome =
			pending?.outcome === "not_started" ||
			pending?.outcome === "mutation_outcome_unknown";
		const legalInput =
			pending?.input != null &&
			typeof pending.input.recapText === "string" &&
			Array.isArray(pending.input.quotes) &&
			typeof pending.input.confirmed === "boolean";
		if (
			!pending ||
			pending.version !== 1 ||
			typeof pending.issueId !== "string" ||
			typeof pending.sessionId !== "string" ||
			!legalStage ||
			!legalOutcome ||
			!legalInput
		) {
			log(
				`[eleven-landing] LOUD: unknown/invalid pending-landing schema in ${f} — kept, NO Linear mutation (fix by hand or upgrade)`,
			);
			continue;
		}
		// §3.3 stage legality (Codex #552 R2 MEDIUM-5): EACH discriminated-union
		// arm is validated in full before ANY Linear call — a stage whose own
		// payload is missing/malformed is kept + LOUD, never guessed.
		const arm = {
			summary:
				pending.stage === "summary"
					? typeof pending.summary?.marker === "string" &&
						pending.summary.marker.length > 0
					: true,
			transcript:
				pending.stage === "transcript"
					? typeof pending.transcript?.chunkIndex === "number" &&
						Number.isInteger(pending.transcript.chunkIndex) &&
						pending.transcript.chunkIndex >= 0 &&
						typeof pending.transcript.marker === "string" &&
						pending.transcript.marker.length > 0
					: true,
			close:
				pending.stage === "close"
					? typeof pending.close?.closeTarget === "string" &&
						pending.close.closeTarget === pending.issueId
					: true,
		};
		if (!arm.summary || !arm.transcript || !arm.close) {
			log(
				`[eleven-landing] LOUD: pending ${f} stage=${pending.stage} has a missing/mismatched payload — kept, NO Linear mutation`,
			);
			continue;
		}
		try {
			await reconcileOne(opts, pending, log);
		} catch (err) {
			log(
				`[eleven-landing] reconciliation for ${pending.sessionId} failed (envelope kept for the next boot): ${String((err as Error).message ?? err)}`,
			);
		}
	}
}

async function reconcileOne(
	opts: ReconcileOptions,
	pending: PendingLanding,
	log: (line: string) => void,
): Promise<void> {
	const { stateDir } = opts;
	const sessionId = pending.sessionId;
	const pendingPath = elevenPendingPath(stateDir, sessionId);

	// 1. read back the issue's comments (all pages) + state — server truth.
	const bodies: string[] = [];
	let stateType: string | undefined;
	let after: string | undefined;
	do {
		const page = await opts.read.comments(pending.issueId, {
			...(after ? { after } : {}),
		});
		bodies.push(...page.comments.map((c) => c.body));
		if (page.stateType) stateType = page.stateType;
		after = page.hasNextPage && page.endCursor ? page.endCursor : undefined;
	} while (after);

	// 2. the locally-expected chunk split (deterministic — frozen trail). This
	// is the SOURCE OF TRUTH for how many chunks there are; server markers are
	// only trusted against it (Codex #552 R2 MEDIUM-6).
	const rows = readElevenTranscriptRows(
		elevenTranscriptPath(stateDir, sessionId),
	);
	const expectedChunks = AssistantLanding.buildTranscriptComments(rows, {
		sessionId,
		commandName: opts.commandName ?? "eleven",
		transcriptPath: elevenTranscriptPath(stateDir, sessionId),
	});
	const expectedN = expectedChunks.length;

	// 3. which stage markers are CONFIRMED landed? Codex #552 R1 HIGH-1: the max
	// marker index does NOT prove a contiguous prefix; R2 MEDIUM-6: a marker's
	// denominator MUST equal the local expected count and its index be in range,
	// else a stray `chunk 1/999` would be trusted as complete. Count only valid,
	// in-range indices, then the contiguous run from 1.
	const summaryPosted = bodies.some((b) =>
		b.includes(`assistant-summary ${sessionId}`),
	);
	const chunkRe = new RegExp(
		`assistant-transcript ${escapeRegExp(sessionId)} chunk (\\d+)/(\\d+)`,
	);
	const confirmedIdx = new Set<number>();
	for (const b of bodies) {
		const m = b.match(chunkRe);
		if (!m) continue;
		const i = Number(m[1]);
		const n = Number(m[2]);
		if (n === expectedN && i >= 1 && i <= expectedN) confirmedIdx.add(i);
	}
	let confirmedPrefix = 0;
	while (confirmedIdx.has(confirmedPrefix + 1)) confirmedPrefix++;
	const closed = stateType === "completed";

	if (summaryPosted && confirmedPrefix >= expectedChunks.length && closed) {
		log(
			`[eleven-landing] ${sessionId}: every stage confirmed landed (read-back) — pending cleared, nothing re-posted`,
		);
		unlinkSync(pendingPath);
		return;
	}

	// 4. reconcile the receipt with the read-back. Codex #552 R1 HIGH-1: the
	// server-confirmed contiguous prefix must be merged into the receipt EVEN
	// when a valid local receipt exists — a receipt whose postedChunks lags a
	// chunk the server already committed (client timed out AFTER the POST
	// landed) would otherwise re-post it. Merge = max(local, confirmed); never
	// regress the local cursor (a local record only over-counts if a POST it
	// saw did not land, which cannot happen — the client writes it AFTER ok).
	const receiptPath = elevenReceiptPath(stateDir, sessionId);
	const localReceipt = readJsonSafe<ReceiptShape>(receiptPath);
	const validLocal =
		localReceipt?.issueId === pending.issueId &&
		localReceipt?.sessionId === sessionId;
	const localPosted = validLocal
		? (localReceipt?.transcript?.postedChunks ?? 0)
		: 0;
	const mergedPosted = Math.max(localPosted, confirmedPrefix);
	if (summaryPosted && (!validLocal || mergedPosted > localPosted)) {
		const nowIso = (opts.now?.() ?? new Date()).toISOString();
		const rebuilt: ReceiptShape = {
			issueId: pending.issueId,
			sessionId,
			commentAt: localReceipt?.commentAt ?? nowIso,
			...(localReceipt?.commentUrl
				? { commentUrl: localReceipt.commentUrl }
				: {}),
			...(rows.length > 0
				? {
						transcript: {
							rowCount: rows.length,
							chunkCount: expectedChunks.length,
							postedChunks: mergedPosted,
							...(mergedPosted >= expectedChunks.length
								? { completeAt: nowIso }
								: {}),
						},
					}
				: {}),
		};
		atomicWriteJson(receiptPath, rebuilt);
		log(
			`[eleven-landing] ${sessionId}: receipt reconciled from read-back (summary posted, ${mergedPosted}/${expectedChunks.length} chunks confirmed; local was ${localPosted})`,
		);
	}

	// 5. resume the landing from the (rebuilt) cursor — land() owns the
	// pending file lifecycle from here (refreshes it on failure, removes it
	// on a landed run).
	const landing = new ElevenLanding({
		stateDir,
		sessionId,
		linear: opts.linear,
		commandName: opts.commandName,
		log,
		now: opts.now,
	});
	const r = await landing.land({
		issueId: pending.issueId,
		sessionId,
		recapText: pending.input.recapText,
		quotes: pending.input.quotes,
		confirmed: pending.input.confirmed,
	});
	if (!r.ok && !r.landedAll) {
		throw new Error(r.message);
	}
	log(`[eleven-landing] ${sessionId}: reconciliation landed the meeting`);
}
