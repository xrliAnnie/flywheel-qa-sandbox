/**
 * FLY-967 P6a — AssistantLanding: recap → summary(verbatim quotes) →
 * comment → close, with 545-style landing failure semantics (order is law:
 * any earlier failure leaves the issue OPEN and re-runnable) and re-run
 * idempotency via a local receipt (comment success is recorded; a re-run
 * skips the comment and goes straight to close — Codex R1 #5).
 */
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantLanding } from "../assistant/AssistantLanding.js";

describe("AssistantLanding (FLY-967 P6a)", () => {
	let dir: string;
	let comment: ReturnType<typeof vi.fn>;
	let closeIssue: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly967-landing-"));
		comment = vi.fn(async () => ({ url: "https://linear.app/c/1" }));
		closeIssue = vi.fn(async () => {});
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function makeLanding() {
		return new AssistantLanding({
			linear: { comment, closeIssue },
			receiptPath: join(dir, "landing-receipt.json"),
			transcriptPath: join(dir, "session.jsonl"),
		});
	}

	const input = {
		issueId: "FLY-1234",
		sessionId: "sess-abc",
		recapText: "今天聊清了两件事:声线用 Kore;简报预算 8k。",
		quotes: [
			{ ts: "2026-07-07T15:03:00.000Z", text: "声线就用那个稳一点的" },
			{ ts: "2026-07-07T15:09:00.000Z", text: "简报别太长" },
		],
		confirmed: true,
	};

	it("summary carries the marker, recap, and per-point verbatim quotes", () => {
		const s = AssistantLanding.buildSummary(input);
		expect(s).toContain("assistant-summary sess-abc");
		expect(s).toContain("今天聊清了两件事");
		expect(s).toContain("声线就用那个稳一点的");
		expect(s).toContain("2026-07-07T15:03:00.000Z");
		expect(s).not.toContain("未经口头确认");
	});

	it("an unconfirmed (she left) summary is loudly labeled", () => {
		const s = AssistantLanding.buildSummary({ ...input, confirmed: false });
		expect(s).toContain("未经口头确认");
	});

	it("happy path: comment → receipt → close, in that order", async () => {
		const landing = makeLanding();
		const r = await landing.run(input);
		expect(r).toMatchObject({ ok: true, commentUrl: "https://linear.app/c/1" });
		expect(comment).toHaveBeenCalledWith(
			"FLY-1234",
			expect.stringContaining("assistant-summary sess-abc"),
		);
		expect(closeIssue).toHaveBeenCalledWith("FLY-1234");
		const receipt = JSON.parse(
			readFileSync(join(dir, "landing-receipt.json"), "utf8"),
		);
		expect(receipt).toMatchObject({
			issueId: "FLY-1234",
			sessionId: "sess-abc",
		});
	});

	it("comment failure: no close, no receipt, transcript fallback named", async () => {
		comment.mockRejectedValue(new Error("bridge 502"));
		const landing = makeLanding();
		const r = await landing.run(input);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.stage).toBe("comment");
			expect(r.message).toContain("session.jsonl");
		}
		expect(closeIssue).not.toHaveBeenCalled();
		expect(existsSync(join(dir, "landing-receipt.json"))).toBe(false);
	});

	it("close failure after a good comment: receipt kept, manual close flagged", async () => {
		closeIssue.mockRejectedValue(new Error("state flip failed"));
		const landing = makeLanding();
		const r = await landing.run(input);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.stage).toBe("close");
		expect(existsSync(join(dir, "landing-receipt.json"))).toBe(true);
	});

	it("re-run after a close failure skips the comment (receipt) and only closes", async () => {
		closeIssue.mockRejectedValueOnce(new Error("flaky"));
		const landing = makeLanding();
		await landing.run(input); // comment ok, close failed, receipt written
		closeIssue.mockResolvedValue(undefined);
		const r2 = await landing.run(input);
		expect(r2.ok).toBe(true);
		expect(comment).toHaveBeenCalledTimes(1); // NOT re-sent
		expect(closeIssue).toHaveBeenCalledTimes(2);
	});

	it("a receipt for a DIFFERENT session does not suppress the comment", async () => {
		const landing = makeLanding();
		await landing.run(input);
		comment.mockClear();
		closeIssue.mockClear();
		const r = await landing.run({ ...input, sessionId: "sess-new" });
		expect(r.ok).toBe(true);
		expect(comment).toHaveBeenCalledTimes(1); // fresh session → fresh comment
	});
});

/**
 * FLY-1065 P6 — AssistantLanding v2: the verbatim transcript lands on the
 * kickoff issue as its own comment(s) after the summary, chunk-granular
 * idempotent (receipt.transcript.postedChunks — a re-run never re-posts a
 * chunk that already landed), deterministic chunking, scrubbed per line.
 */
describe("AssistantLanding v2 — verbatim transcript comments (FLY-1065 P6)", () => {
	let dir: string;
	let comment: ReturnType<typeof vi.fn>;
	let closeIssue: ReturnType<typeof vi.fn>;
	let logs: string[];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1065-landing-"));
		comment = vi.fn(async () => ({ url: "https://linear.app/c/1" }));
		closeIssue = vi.fn(async () => {});
		logs = [];
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function makeLanding(over: Record<string, unknown> = {}) {
		return new AssistantLanding({
			linear: { comment, closeIssue },
			receiptPath: join(dir, "landing-receipt.json"),
			transcriptPath: join(dir, "session.jsonl"),
			log: (l: string) => logs.push(l),
			...over,
		});
	}

	const input = {
		issueId: "FLY-1234",
		sessionId: "sess-abc",
		recapText: "recap 主体",
		quotes: [],
		confirmed: true,
	};

	const row = (
		role: "user" | "assistant",
		text: string,
		interrupted?: boolean,
	) => ({
		ts: "2026-07-09T15:03:00.000Z",
		role,
		text,
		...(interrupted ? { interrupted: true } : {}),
	});

	function writeJsonl(rows: unknown[]) {
		writeFileSync(
			join(dir, "session.jsonl"),
			`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
		);
	}

	describe("buildTranscriptComments (pure, deterministic)", () => {
		const opts = {
			sessionId: "sess-abc",
			commandName: "gemini",
			transcriptPath: "/state/sess-abc.jsonl",
		};

		it("renders header + chunk marker + per-turn role-labeled lines with local timestamps", () => {
			const chunks = AssistantLanding.buildTranscriptComments(
				[row("user", "今天聊转写"), row("assistant", "好的", true)],
				opts,
			);
			expect(chunks).toHaveLength(1);
			expect(chunks[0]).toContain("## 逐字对话记录(/gemini 助理)");
			expect(chunks[0]).toContain("assistant-transcript sess-abc chunk 1/1");
			expect(chunks[0]).toMatch(
				/- \[\d{2}:\d{2}:\d{2}\] \*\*Annie\*\*:今天聊转写/,
			);
			expect(chunks[0]).toContain("**助理**:好的 (被打断)");
		});

		it("is deterministic — same rows always split into the same chunks (the chunk-idempotency precondition)", () => {
			const rows = Array.from({ length: 40 }, (_, i) =>
				row(i % 2 ? "assistant" : "user", `第 ${i} 句内容不短不长`.repeat(3)),
			);
			const a = AssistantLanding.buildTranscriptComments(rows, opts);
			const b = AssistantLanding.buildTranscriptComments(rows, opts);
			expect(a).toEqual(b);
		});

		it("splits past the per-comment budget; markers agree on the total", () => {
			const rows = Array.from({ length: 30 }, (_, i) =>
				row("user", `一句比较长的话用来撑爆预算 ${i} `.repeat(4)),
			);
			const chunks = AssistantLanding.buildTranscriptComments(rows, {
				...opts,
				maxChunkChars: 600,
			});
			expect(chunks.length).toBeGreaterThan(1);
			for (const [i, c] of chunks.entries()) {
				expect(c.length).toBeLessThanOrEqual(600);
				expect(c).toContain(
					`assistant-transcript sess-abc chunk ${i + 1}/${chunks.length}`,
				);
			}
		});

		it("caps at maxChunks and the LAST chunk names the on-disk JSONL for the overflow", () => {
			const rows = Array.from({ length: 60 }, (_, i) =>
				row("user", `溢出用的长句 ${i} `.repeat(6)),
			);
			const chunks = AssistantLanding.buildTranscriptComments(rows, {
				...opts,
				maxChunkChars: 500,
				maxChunks: 2,
			});
			expect(chunks).toHaveLength(2);
			expect(chunks[1]).toContain("/state/sess-abc.jsonl");
			expect(chunks[1]).toContain("更长部分");
		});

		it("scrubs every line (defense in depth — rows may come from an injected reader or an old unscrubbed file)", () => {
			const chunks = AssistantLanding.buildTranscriptComments(
				[row("assistant", "key 是 sk-AbCdEfGhIjKlMnOp1234")],
				opts,
			);
			expect(chunks[0]).not.toContain("sk-AbCdEfGhIjKlMnOp1234");
			expect(chunks[0]).toContain("[redacted]");
		});

		it("empty rows → no chunks", () => {
			expect(AssistantLanding.buildTranscriptComments([], opts)).toEqual([]);
		});
	});

	it("happy path: summary → transcript comment(s) → close; receipt records chunk progress + completeAt", async () => {
		writeJsonl([
			{ ...row("user", "她说的"), sessionId: "b1", final: true },
			{ ...row("assistant", "它答的"), sessionId: "b2", final: true },
		]);
		const landing = makeLanding({ commandName: "gemini" });
		const r = await landing.run(input);
		expect(r).toMatchObject({ ok: true, transcriptChunks: 1 });
		expect(comment).toHaveBeenCalledTimes(2); // summary + 1 transcript chunk
		const transcriptBody = comment.mock.calls[1][1] as string;
		expect(transcriptBody).toContain("逐字对话记录");
		expect(transcriptBody).toContain("她说的");
		expect(transcriptBody).toContain("它答的");
		expect(closeIssue).toHaveBeenCalledTimes(1);
		const receipt = JSON.parse(
			readFileSync(join(dir, "landing-receipt.json"), "utf8"),
		);
		expect(receipt.transcript).toMatchObject({
			rowCount: 2,
			chunkCount: 1,
			postedChunks: 1,
		});
		expect(receipt.transcript.completeAt).toBeTruthy();
	});

	it("no JSONL / zero rows → transcript phase skipped, NOT a failure (0-turn meeting)", async () => {
		const landing = makeLanding();
		const r = await landing.run(input);
		expect(r).toMatchObject({ ok: true, transcriptChunks: 0 });
		expect(comment).toHaveBeenCalledTimes(1); // summary only
		expect(closeIssue).toHaveBeenCalledTimes(1);
	});

	it("bad JSONL lines are skipped with a log; good rows still land", async () => {
		writeFileSync(
			join(dir, "session.jsonl"),
			`${JSON.stringify(row("user", "好行"))}\n{{{corrupt\n${JSON.stringify(row("assistant", "又一好行"))}\n`,
		);
		const landing = makeLanding();
		const r = await landing.run(input);
		expect(r).toMatchObject({ ok: true, transcriptChunks: 1 });
		expect(comment.mock.calls[1][1]).toContain("好行");
		expect(logs.some((l) => l.includes("skip"))).toBe(true);
	});

	it("CHUNK idempotency (Codex R1 #2/#8): chunk 2 fails → issue stays open; the re-run never re-posts chunk 1, continues 2..n", async () => {
		const rows = Array.from({ length: 30 }, (_, i) =>
			row("user", `撑段落的长句 ${i} `.repeat(6)),
		);
		const landing = makeLanding({
			readTranscript: () => rows,
			transcriptChunkChars: 500,
		});
		comment.mockImplementation(async (_id: string, body: string) => {
			if (body.includes("chunk 2/")) throw new Error("linear 502");
			return { url: "https://linear.app/c/1" };
		});
		const r1 = await landing.run(input);
		expect(r1.ok).toBe(false);
		if (!r1.ok) {
			expect(r1.stage).toBe("transcript");
			expect(r1.message).toContain("session.jsonl");
			expect(r1.message).toMatch(/2\/\d+ 段/);
		}
		expect(closeIssue).not.toHaveBeenCalled();
		const chunk1Posts = comment.mock.calls.filter((c) =>
			String(c[1]).includes("chunk 1/"),
		).length;
		expect(chunk1Posts).toBe(1);
		// re-run: linear recovered
		comment.mockImplementation(async () => ({ url: "https://linear.app/c/1" }));
		const r2 = await landing.run(input);
		expect(r2.ok).toBe(true);
		const chunk1PostsAfter = comment.mock.calls.filter((c) =>
			String(c[1]).includes("chunk 1/"),
		).length;
		expect(chunk1PostsAfter).toBe(1); // NEVER re-posted
		const summaryPosts = comment.mock.calls.filter((c) =>
			String(c[1]).includes("assistant-summary"),
		).length;
		expect(summaryPosts).toBe(1); // summary receipt still honored
		expect(closeIssue).toHaveBeenCalledTimes(1);
	});

	it("an OLD receipt without the transcript field (pre-1065 summary already posted) posts ONLY the transcript on re-run", async () => {
		writeFileSync(
			join(dir, "landing-receipt.json"),
			JSON.stringify({
				issueId: "FLY-1234",
				sessionId: "sess-abc",
				commentAt: "2026-07-09T00:00:00.000Z",
			}),
		);
		writeJsonl([row("user", "旧会的转写")]);
		const landing = makeLanding();
		const r = await landing.run(input);
		expect(r).toMatchObject({ ok: true, transcriptChunks: 1 });
		expect(
			comment.mock.calls.filter((c) =>
				String(c[1]).includes("assistant-summary"),
			),
		).toHaveLength(0); // summary NOT re-sent
		expect(
			comment.mock.calls.filter((c) => String(c[1]).includes("逐字对话记录")),
		).toHaveLength(1);
	});

	it("a non-ENOENT transcript read failure fails the transcript stage — never a silent summary-only success (Codex code R1 HIGH)", async () => {
		const { mkdirSync } = await import("node:fs");
		mkdirSync(join(dir, "session.jsonl")); // EISDIR on read
		const landing = makeLanding();
		const r = await landing.run(input);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.stage).toBe("transcript");
			expect(r.message).toContain("session.jsonl");
		}
		expect(closeIssue).not.toHaveBeenCalled(); // issue stays open, re-runnable
	});

	it("buildSummary scrubs recap and quotes at the landing exit (same defense in depth as the verbatim record)", () => {
		const s = AssistantLanding.buildSummary({
			...input,
			recapText: "recap 里混了 sk-AbCdEfGhIjKlMnOp1234 这样的 key",
			quotes: [
				{
					ts: "2026-07-09T15:00:00.000Z",
					text: "引用里也有 ghp_ABCDEFGHIJKLMNOPQRST12",
				},
			],
		});
		expect(s).not.toContain("sk-AbCdEfGhIjKlMnOp1234");
		expect(s).not.toContain("ghp_ABCDEFGHIJKLMNOPQRST12");
		expect(s).toContain("[redacted]");
	});

	it("a rowCount/chunkCount drift vs the receipt logs LOUDLY and continues from the receipt's progress", async () => {
		writeFileSync(
			join(dir, "landing-receipt.json"),
			JSON.stringify({
				issueId: "FLY-1234",
				sessionId: "sess-abc",
				commentAt: "2026-07-09T00:00:00.000Z",
				transcript: { rowCount: 99, chunkCount: 5, postedChunks: 1 },
			}),
		);
		writeJsonl([row("user", "只剩一行的现实")]);
		const landing = makeLanding();
		const r = await landing.run(input);
		expect(r.ok).toBe(true);
		expect(logs.some((l) => l.includes("LOUD") || l.includes("mismatch"))).toBe(
			true,
		);
		// progress (1 posted) ≥ new chunk count (1) → nothing re-posted
		expect(
			comment.mock.calls.filter((c) => String(c[1]).includes("逐字对话记录")),
		).toHaveLength(0);
	});

	describe("shutdown deadline = TRUE cancellation (FLY-1160 §3.3 Phase 2, Codex #550 R2)", () => {
		it("a pre-aborted signal performs ZERO Linear writes and never reports success", async () => {
			const ctrl = new AbortController();
			ctrl.abort();
			const r = await makeLanding().run(input, { signal: ctrl.signal });
			expect(r).toMatchObject({ ok: false, stage: "comment" });
			expect(comment).not.toHaveBeenCalled();
			expect(closeIssue).not.toHaveBeenCalled();
		});

		it("abort after the summary: transcript/close never posted; a clean re-run RESUMES from the receipt without re-posting", async () => {
			writeJsonl([row("user", "第一句"), row("assistant", "第二句")]);
			const ctrl = new AbortController();
			comment.mockImplementation(async () => {
				if (comment.mock.calls.length === 1) ctrl.abort(); // deadline lands mid-flight
				return { url: "https://linear.app/c/1" };
			});
			const r1 = await makeLanding().run(input, { signal: ctrl.signal });
			expect(r1).toMatchObject({ ok: false, stage: "transcript" });
			expect(comment).toHaveBeenCalledTimes(1); // summary only
			expect(closeIssue).not.toHaveBeenCalled();

			const r2 = await makeLanding().run(input); // reconciliation re-run
			expect(r2.ok).toBe(true);
			expect(comment).toHaveBeenCalledTimes(2); // +1 transcript chunk, NO summary re-post
			expect(closeIssue).toHaveBeenCalledTimes(1);
		});

		it("a mutation aborted MID-FLIGHT is outcome-unknown: cursor NOT advanced, loud message, re-run retries that write", async () => {
			writeJsonl([row("user", "第一句")]);
			const ctrl = new AbortController();
			comment.mockImplementation(async () => {
				if (comment.mock.calls.length === 2) {
					// the chunk POST gets cut by the deadline mid-flight
					ctrl.abort();
					throw new Error("fetch aborted");
				}
				return { url: "https://linear.app/c/1" };
			});
			const r1 = await makeLanding().run(input, { signal: ctrl.signal });
			expect(r1).toMatchObject({ ok: false, stage: "transcript" });
			expect((r1 as { message?: string }).message).toContain("结果未知");
			expect(closeIssue).not.toHaveBeenCalled();

			// re-run RETRIES the unknown write (explicit possible duplicate over
			// silent loss) and completes
			comment.mockImplementation(async () => ({
				url: "https://linear.app/c/1",
			}));
			const r2 = await makeLanding().run(input);
			expect(r2.ok).toBe(true);
			expect(closeIssue).toHaveBeenCalledTimes(1);
		});

		it("close RESOLVES during the abort window: success is still NOT reported past the deadline (Codex #550 R4)", async () => {
			const ctrl = new AbortController();
			closeIssue.mockImplementation(async () => {
				ctrl.abort(); // the deadline lands while close is in flight; close commits
			});
			const r = await makeLanding().run(input, { signal: ctrl.signal });
			expect(r).toMatchObject({ ok: false, stage: "close" });
			expect((r as { message?: string }).message).toContain("issue 已关");
			expect(closeIssue).toHaveBeenCalledTimes(1);
		});

		it("abort before close: the issue stays open; a clean re-run only closes (no comment re-posts)", async () => {
			writeJsonl([row("user", "第一句")]);
			const ctrl = new AbortController();
			comment.mockImplementation(async () => {
				if (comment.mock.calls.length === 2) ctrl.abort(); // after the chunk POST
				return { url: "https://linear.app/c/1" };
			});
			const r1 = await makeLanding().run(input, { signal: ctrl.signal });
			expect(r1).toMatchObject({ ok: false, stage: "close" });
			expect(closeIssue).not.toHaveBeenCalled();

			const r2 = await makeLanding().run(input);
			expect(r2.ok).toBe(true);
			expect(comment).toHaveBeenCalledTimes(2); // nothing re-posted
			expect(closeIssue).toHaveBeenCalledTimes(1);
		});
	});
});
