/**
 * AssistantLanding (FLY-967 P6a, FLY-1065 P6 v2) — the /gemini after-meeting
 * pipeline: summary (assistant recap + the founder's VERBATIM quotes — control
 * prompts never enter the quote pool by construction) → POST comment →
 * verbatim transcript comment(s) → close issue.
 *
 * Failure order is law (545 §6 landing semantics): a failed comment leaves
 * the issue open and names the transcript path as the fallback; a failed
 * close keeps the receipt so a re-run goes straight to close. The receipt
 * makes re-runs idempotent at TWO granularities: the summary (commentAt, one
 * per session — Codex R1 #5) and each transcript chunk (transcript.postedChunks
 * advances after every successful POST, so a re-run after "chunk 1 ok, chunk 2
 * failed" continues at chunk 2 and never duplicates chunk 1 — FLY-1065 Codex
 * R1 #2). Comment bodies carry "assistant-summary <sessionId>" /
 * "assistant-transcript <sessionId> chunk i/n" marker lines for human audit.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { scrubTranscript } from "flywheel-voice-core";

export interface LandingLinear {
	/** FLY-1160 §3.3: opts.signal (when given) must reach the underlying
	 * fetch — the shutdown deadline aborts mutations mid-flight. */
	comment(
		issueId: string,
		body: string,
		opts?: { signal?: AbortSignal },
	): Promise<{ url?: string }>;
	closeIssue(issueId: string, opts?: { signal?: AbortSignal }): Promise<void>;
}

/** one verbatim turn as read from the per-meeting JSONL. */
export interface TranscriptRow {
	ts: string;
	role: "user" | "assistant";
	text: string;
	/** the turn was cut short by a barge-in (rendered as a tail note). */
	interrupted?: boolean;
}

export interface AssistantLandingOptions {
	linear: LandingLinear;
	/** landing-receipt.json, transcript-adjacent. */
	receiptPath: string;
	/** the per-meeting JSONL — read for the verbatim record AND named in
	 * founder-facing fallbacks when a comment fails. */
	transcriptPath: string;
	/** the shipped slash-command name shown in the summary header. */
	commandName?: string;
	/** test seam / alternate source; default reads transcriptPath JSONL. */
	readTranscript?: () => TranscriptRow[];
	/** per-comment char budget (default 20k — conservative vs Linear's
	 * undocumented cap; adjustable once verified against the real API). */
	transcriptChunkChars?: number;
	/** max transcript comments per meeting (default 3; overflow points at the
	 * on-disk JSONL). */
	transcriptMaxChunks?: number;
	log?: (line: string) => void;
}

export interface LandingInput {
	issueId: string;
	sessionId: string;
	/** the assistant's spoken recap (assistant transcript of the final turn). */
	recapText: string;
	/** the founder's verbatim lines (user transcript entries only). */
	quotes: { ts: string; text: string }[];
	/** false = she left before the verbal confirmation (degraded close). */
	confirmed: boolean;
}

export type LandingResult =
	| { ok: true; commentUrl?: string; transcriptChunks?: number }
	| { ok: false; stage: "comment" | "transcript" | "close"; message: string };

interface Receipt {
	issueId: string;
	sessionId: string;
	commentAt: string;
	commentUrl?: string;
	/** FLY-1065: chunk-granular transcript progress. Absent on pre-1065
	 * receipts = summary posted, verbatim record not (additive compat). */
	transcript?: {
		rowCount: number;
		chunkCount: number;
		postedChunks: number;
		completeAt?: string;
	};
}

const DEFAULT_CHUNK_CHARS = 20_000;
const DEFAULT_MAX_CHUNKS = 3;
/** header + marker + overflow-note allowance inside the per-chunk budget. */
const CHUNK_OVERHEAD_CHARS = 200;

export interface TranscriptCommentOptions {
	sessionId: string;
	commandName?: string;
	/** named in the overflow note when the record exceeds maxChunks. */
	transcriptPath: string;
	founderName?: string;
	assistantName?: string;
	maxChunkChars?: number;
	maxChunks?: number;
}

export class AssistantLanding {
	constructor(private readonly opts: AssistantLandingOptions) {}

	static buildSummary(input: LandingInput, commandName = "gemini"): string {
		const lines = [
			`## 会议纪要(/${commandName} 助理)`,
			`assistant-summary ${input.sessionId}`,
			"",
		];
		if (!input.confirmed) {
			lines.push(
				"> ⚠️ 本纪要**未经口头确认**(会议在 recap 确认前结束)——如有出入请直接在 issue 里改。",
				"",
			);
		}
		// FLY-1065: same defense in depth as the verbatim record — this is an
		// injectable Linear exit, so it scrubs even though the Gemini path
		// normally delivers already-scrubbed finals.
		lines.push(scrubTranscript(input.recapText.trim()), "", "### 原话引用");
		for (const q of input.quotes) {
			lines.push(`- [${q.ts}]「${scrubTranscript(q.text)}」`);
		}
		return lines.join("\n");
	}

	/**
	 * FLY-1065: the verbatim record as ready-to-POST comment bodies. PURE and
	 * DETERMINISTIC — the same rows always split into the same chunks, which is
	 * what makes receipt.postedChunks a valid resume cursor (the meeting is
	 * over; the JSONL no longer grows). Every line re-passes scrubTranscript
	 * (defense in depth: rows may come from an injected reader or an old file).
	 */
	static buildTranscriptComments(
		rows: TranscriptRow[],
		opts: TranscriptCommentOptions,
	): string[] {
		if (rows.length === 0) return [];
		const founder = opts.founderName ?? "Annie";
		const assistant = opts.assistantName ?? "助理";
		const maxChars = opts.maxChunkChars ?? DEFAULT_CHUNK_CHARS;
		const maxChunks = opts.maxChunks ?? DEFAULT_MAX_CHUNKS;
		const lineBudget = Math.max(200, maxChars - CHUNK_OVERHEAD_CHARS);

		const lines = rows.map((r) => {
			const name = r.role === "user" ? founder : assistant;
			const text = scrubTranscript(r.text);
			const tail = r.interrupted ? " (被打断)" : "";
			const line = `- [${formatLocalTime(r.ts)}] **${name}**:${text}${tail}`;
			// a single spoken turn larger than a whole comment is pathological —
			// hard-cap it so the chunker always terminates.
			return line.length > lineBudget
				? `${line.slice(0, lineBudget - 1)}…`
				: line;
		});

		const groups: string[][] = [];
		let cur: string[] = [];
		let curLen = 0;
		let dropped = 0;
		let dropping = false;
		for (const line of lines) {
			// once the cap is hit, EVERYTHING after is dropped — a later short line
			// must not sneak in and make the record non-contiguous.
			if (dropping) {
				dropped++;
				continue;
			}
			if (cur.length > 0 && curLen + line.length + 1 > lineBudget) {
				if (groups.length === maxChunks - 1) {
					dropping = true;
					dropped++;
					continue;
				}
				groups.push(cur);
				cur = [];
				curLen = 0;
			}
			cur.push(line);
			curLen += line.length + 1;
		}
		if (cur.length > 0) groups.push(cur);

		const n = groups.length;
		const commandName = opts.commandName ?? "gemini";
		return groups.map((group, i) => {
			const parts = [
				`## 逐字对话记录(/${commandName} 助理)`,
				`assistant-transcript ${opts.sessionId} chunk ${i + 1}/${n}`,
				"",
				...group,
			];
			if (i === n - 1 && dropped > 0) {
				parts.push("", `(更长部分见本机 ${opts.transcriptPath})`);
			}
			return parts.join("\n");
		});
	}

	async run(
		input: LandingInput,
		runOpts: { signal?: AbortSignal } = {},
	): Promise<LandingResult> {
		// FLY-1160 §3.3 Phase 2: the shutdown deadline is TRUE cancellation —
		// once the signal aborts, NO further external write happens and success
		// is never reported. The receipt (summary posted / postedChunks cursor /
		// close-by-issue-state) is the durable stage-aware continuation: a
		// re-run resumes exactly where the deadline cut, never re-posting.
		const deadline = (
			stage: "comment" | "transcript" | "close",
		): LandingResult => {
			this.opts.log?.(
				`[landing] LOUD: shutdown deadline hit at stage=${stage} for ${input.sessionId} — no further Linear writes; receipt keeps the resume cursor`,
			);
			return {
				ok: false,
				stage,
				message: `落地在 shutdown deadline 处中止(stage=${stage})——已落进度在 receipt 里,issue 保持打开,重跑从断点续发。`,
			};
		};
		// the deadline aborted a mutation MID-FLIGHT: the server may or may not
		// have committed it. Honest bookkeeping: the receipt cursor does NOT
		// advance, so a re-run retries this one write (a possible duplicate,
		// flagged loudly) — the marker-based read-back reconciliation that
		// removes even that duplicate ships with the §3.3 Bridge read endpoints
		// in the FLY-545/FLY-1006 wiring PRs.
		const unknownOutcome = (
			stage: "comment" | "transcript" | "close",
		): LandingResult => {
			this.opts.log?.(
				`[landing] LOUD: shutdown deadline aborted an IN-FLIGHT ${stage} mutation for ${input.sessionId} — outcome unknown; re-run may duplicate this one write`,
			);
			return {
				ok: false,
				stage,
				message: `落地的 ${stage} 写在 shutdown deadline 被中断,结果未知——issue 保持打开;重跑会重试这一步(可能出现一次重复,以显式重复换绝不静默丢)。`,
			};
		};
		// no-signal callers keep the exact legacy call shape (2-arg) — the
		// opts object appears only when a deadline signal actually exists.
		const postComment = (
			issueId: string,
			body: string,
		): Promise<{ url?: string }> =>
			runOpts.signal
				? this.opts.linear.comment(issueId, body, { signal: runOpts.signal })
				: this.opts.linear.comment(issueId, body);
		const closeIssue = (issueId: string): Promise<void> =>
			runOpts.signal
				? this.opts.linear.closeIssue(issueId, { signal: runOpts.signal })
				: this.opts.linear.closeIssue(issueId);

		let receipt = this.readReceipt();
		const receiptValid =
			receipt?.issueId === input.issueId &&
			receipt?.sessionId === input.sessionId;
		if (!receiptValid) receipt = null;

		if (!receipt) {
			if (runOpts.signal?.aborted) return deadline("comment");
			try {
				const posted = await postComment(
					input.issueId,
					AssistantLanding.buildSummary(input, this.opts.commandName),
				);
				receipt = {
					issueId: input.issueId,
					sessionId: input.sessionId,
					commentAt: new Date().toISOString(),
					commentUrl: posted.url,
				};
				this.writeReceipt(receipt);
			} catch (err) {
				if (runOpts.signal?.aborted) return unknownOutcome("comment");
				return {
					ok: false,
					stage: "comment",
					message: `纪要没写进 issue(${String((err as Error).message ?? err)})——完整记录在 ${this.opts.transcriptPath},issue 保持打开,可重跑落地。`,
				};
			}
			// post-await gate: the summary is CONFIRMED (recorded above); an
			// abort that landed while it was in flight stops the NEXT stage.
			if (runOpts.signal?.aborted) return deadline("transcript");
		} else {
			this.opts.log?.(
				`[landing] receipt found for ${input.sessionId} — skipping the summary comment`,
			);
		}

		// ---- FLY-1065: verbatim transcript comments (chunk-granular idempotent) ----
		let rows: TranscriptRow[];
		try {
			rows = this.readRows();
		} catch (err) {
			// a non-ENOENT read failure means the record MAY exist but cannot be
			// read — failing the stage keeps the issue open and re-runnable instead
			// of silently closing with a summary-only "success" (Codex code R1 HIGH).
			return {
				ok: false,
				stage: "transcript",
				message: `纪要已落,但逐字记录读取失败(${String((err as Error).message ?? err)})——记录文件在 ${this.opts.transcriptPath},issue 保持打开,修复后重跑续发。`,
			};
		}
		let transcriptChunks = 0;
		if (rows.length > 0) {
			const chunks = AssistantLanding.buildTranscriptComments(rows, {
				sessionId: input.sessionId,
				commandName: this.opts.commandName,
				transcriptPath: this.opts.transcriptPath,
				maxChunkChars: this.opts.transcriptChunkChars,
				maxChunks: this.opts.transcriptMaxChunks,
			});
			transcriptChunks = chunks.length;
			let t = receipt.transcript;
			if (!t) {
				t = {
					rowCount: rows.length,
					chunkCount: chunks.length,
					postedChunks: 0,
				};
				receipt.transcript = t;
				this.writeReceipt(receipt);
			} else if (t.rowCount !== rows.length || t.chunkCount !== chunks.length) {
				// theoretically impossible (the meeting is over, the JSONL is frozen,
				// the chunker is deterministic) — if it ever happens, honesty over
				// tidiness: keep the receipt's progress, post the REMAINING chunks of
				// the new split, never re-post counted ones.
				this.opts.log?.(
					`[landing] LOUD: transcript receipt mismatch for ${input.sessionId} — receipt ${t.rowCount} rows/${t.chunkCount} chunks vs rebuilt ${rows.length}/${chunks.length}; continuing from postedChunks=${t.postedChunks}`,
				);
				t.rowCount = rows.length;
				t.chunkCount = chunks.length;
				this.writeReceipt(receipt);
			}
			if (!t.completeAt) {
				for (const [i, body] of chunks.entries()) {
					if (i < t.postedChunks) continue; // already landed — never re-post
					if (runOpts.signal?.aborted) return deadline("transcript");
					try {
						await postComment(input.issueId, body);
					} catch (err) {
						if (runOpts.signal?.aborted) return unknownOutcome("transcript");
						return {
							ok: false,
							stage: "transcript",
							message: `纪要已落,逐字记录发到第 ${i + 1}/${chunks.length} 段失败(${String((err as Error).message ?? err)})——完整记录在 ${this.opts.transcriptPath},issue 保持打开,重跑从断点续发。`,
						};
					}
					// atomic per-chunk progress: a crash between chunks resumes exactly
					// where the last successful POST left off. Progress is CONFIRMED
					// (the POST resolved) — record it even when the deadline landed
					// while it was in flight, THEN stop before the next write.
					t.postedChunks = i + 1;
					this.writeReceipt(receipt);
				}
				t.completeAt = new Date().toISOString();
				this.writeReceipt(receipt);
			}
		}

		if (runOpts.signal?.aborted) return deadline("close");
		try {
			await closeIssue(input.issueId);
		} catch (err) {
			if (runOpts.signal?.aborted) return unknownOutcome("close");
			return {
				ok: false,
				stage: "close",
				message: `纪要已写进 issue,但关闭失败(${String((err as Error).message ?? err)})——请人工关闭 ${input.issueId};重跑只会补关闭,不会重发纪要。`,
			};
		}
		// post-await gate on the FINAL write too: success is never reported
		// past the deadline, even when the close itself committed — the daemon
		// is already tearing down and must not render a success TIV.
		if (runOpts.signal?.aborted) {
			this.opts.log?.(
				`[landing] LOUD: close committed but the shutdown deadline passed for ${input.sessionId} — not reporting success past the deadline`,
			);
			return {
				ok: false,
				stage: "close",
				message: `落地已全部完成(含关单),但确认落在 shutdown deadline 之后——按合同不报成功;issue 已关,无需重跑。`,
			};
		}
		return { ok: true, commentUrl: receipt?.commentUrl, transcriptChunks };
	}

	/** default transcript source: the per-meeting JSONL. Bad lines are skipped
	 * with a log (a torn write must not sink the whole record); a MISSING file
	 * (0-turn meeting) is an empty record, not a failure — but any other read
	 * error (EACCES/EISDIR/…) throws, because "the record may exist but can't
	 * be read" must fail the transcript stage, not skip it. */
	private readRows(): TranscriptRow[] {
		if (this.opts.readTranscript) return this.opts.readTranscript();
		let raw: string;
		try {
			raw = readFileSync(this.opts.transcriptPath, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw err;
		}
		const rows: TranscriptRow[] = [];
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			try {
				const e = JSON.parse(line) as Record<string, unknown>;
				if (
					(e.role === "user" || e.role === "assistant") &&
					typeof e.text === "string"
				) {
					rows.push({
						ts: typeof e.ts === "string" ? e.ts : "",
						role: e.role,
						text: e.text,
						...(e.interrupted === true ? { interrupted: true } : {}),
					});
				}
			} catch {
				this.opts.log?.(
					`[landing] skipping a corrupt JSONL line in ${this.opts.transcriptPath}`,
				);
			}
		}
		return rows;
	}

	private readReceipt(): Receipt | null {
		try {
			return JSON.parse(readFileSync(this.opts.receiptPath, "utf8")) as Receipt;
		} catch {
			return null;
		}
	}

	private writeReceipt(r: Receipt): void {
		mkdirSync(dirname(this.opts.receiptPath), { recursive: true });
		const tmp = `${this.opts.receiptPath}.tmp`;
		writeFileSync(tmp, JSON.stringify(r));
		renameSync(tmp, this.opts.receiptPath);
	}
}

/** HH:MM:SS in machine-local time (the record is for the founder's eyes;
 * meetings happen in her timezone). An unparsable ts renders as --:--:--. */
function formatLocalTime(ts: string): string {
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return "--:--:--";
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
