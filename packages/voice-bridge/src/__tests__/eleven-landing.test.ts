/**
 * FLY-1160 §4.2-4 — /eleven landing: AssistantLanding 形态 on the /eleven
 * trail + the durable retry face (pending-landing envelope, §3.3 stage-aware
 * restart-self-contained continuation) + boot reconciliation via the Bridge
 * comments read-back (markers confirmed, never blind re-posts).
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
import {
	ElevenLanding,
	elevenPendingPath,
	elevenReceiptPath,
	elevenTranscriptPath,
	type PendingLanding,
	readElevenTranscriptRows,
	reconcilePendingLandings,
} from "../eleven/landing.js";

describe("eleven landing (FLY-1160 §4.2-4)", () => {
	let dir: string;
	let comment: ReturnType<typeof vi.fn>;
	let closeIssue: ReturnType<typeof vi.fn>;
	const SID = "sess-el";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1160-eleven-landing-"));
		comment = vi.fn(async () => ({ url: "https://linear.app/c/1" }));
		closeIssue = vi.fn(async () => {});
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const input = {
		issueId: "FLY-2000",
		sessionId: SID,
		recapText: "定了两件事:先修耳朵,再上常驻脑。",
		quotes: [{ ts: "2026-07-11T08:00:00.000Z", text: "先修耳朵" }],
		confirmed: true,
	};

	function writeTrail(lines: unknown[]) {
		writeFileSync(
			elevenTranscriptPath(dir, SID),
			`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
		);
	}

	function makeLanding() {
		return new ElevenLanding({
			stateDir: dir,
			sessionId: SID,
			linear: { comment, closeIssue },
			log: () => {},
		});
	}

	it("trail adapter: user_transcript/agent_response become rows; junk lines and other event types are skipped", () => {
		writeTrail([
			{ t: 1752220800000, type: "user_transcript", text: "先修耳朵" },
			{ t: 1752220860000, type: "agent_response", text: "收到,先修耳朵。" },
			{ t: 1752220900000, type: "cue_start" },
			"not-json",
			{ t: 1752220910000, type: "user_transcript" }, // no text
		]);
		const rows = readElevenTranscriptRows(elevenTranscriptPath(dir, SID));
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ role: "user", text: "先修耳朵" });
		expect(rows[1].role).toBe("assistant");
		// missing file = 0-turn meeting, not a failure
		expect(readElevenTranscriptRows(join(dir, "nope.jsonl"))).toEqual([]);
	});

	it("land success: summary + chunks + close, receipt written, NO pending envelope", async () => {
		writeTrail([{ t: 1, type: "user_transcript", text: "先修耳朵" }]);
		const r = await makeLanding().land(input);
		expect(r.ok).toBe(true);
		expect(existsSync(elevenReceiptPath(dir, SID))).toBe(true);
		expect(existsSync(elevenPendingPath(dir, SID))).toBe(false);
		expect(closeIssue).toHaveBeenCalledTimes(1);
	});

	it("land failure mid-transcript: pending envelope is stage-aware and restart-self-contained", async () => {
		writeTrail([{ t: 1, type: "user_transcript", text: "先修耳朵" }]);
		comment.mockImplementation(async (_id: string, body: string) => {
			if (String(body).includes("assistant-transcript"))
				throw new Error("linear down");
			return { url: "https://linear.app/c/1" };
		});
		const r = await makeLanding().land(input);
		expect(r.ok).toBe(false);
		const pending = JSON.parse(
			readFileSync(elevenPendingPath(dir, SID), "utf8"),
		) as PendingLanding;
		expect(pending).toMatchObject({
			version: 1,
			issueId: "FLY-2000",
			sessionId: SID,
			stage: "transcript",
			outcome: "not_started",
			transcript: { chunkIndex: 0 },
		});
		expect(pending.input.recapText).toContain("先修耳朵");
		expect(pending.input.quotes).toHaveLength(1);
	});

	it("land aborted MID-FLIGHT records outcome=mutation_outcome_unknown", async () => {
		writeTrail([{ t: 1, type: "user_transcript", text: "先修耳朵" }]);
		const ctrl = new AbortController();
		comment.mockImplementation(async (_id: string, body: string) => {
			if (String(body).includes("assistant-transcript")) {
				ctrl.abort();
				throw new Error("fetch aborted");
			}
			return { url: "https://linear.app/c/1" };
		});
		await makeLanding().land(input, { signal: ctrl.signal });
		const pending = JSON.parse(
			readFileSync(elevenPendingPath(dir, SID), "utf8"),
		) as PendingLanding;
		expect(pending.outcome).toBe("mutation_outcome_unknown");
		expect(pending.stage).toBe("transcript");
	});

	it("landedAll (close committed past the deadline) is terminal: pending removed, nothing to re-run", async () => {
		writeTrail([{ t: 1, type: "user_transcript", text: "先修耳朵" }]);
		// leave a stale pending from an earlier failure
		writeFileSync(elevenPendingPath(dir, SID), JSON.stringify({ version: 1 }));
		const ctrl = new AbortController();
		closeIssue.mockImplementation(async () => {
			ctrl.abort(); // deadline lands while close is in flight; close commits
		});
		const r = await makeLanding().land(input, { signal: ctrl.signal });
		expect(r.ok).toBe(false);
		expect((r as { landedAll?: boolean }).landedAll).toBe(true);
		expect(existsSync(elevenPendingPath(dir, SID))).toBe(false);
	});

	describe("boot reconciliation (§3.3 read-back, never blind re-posts)", () => {
		function writePending(p: Partial<PendingLanding>) {
			writeFileSync(
				elevenPendingPath(dir, SID),
				JSON.stringify({
					version: 1,
					issueId: "FLY-2000",
					sessionId: SID,
					outcome: "mutation_outcome_unknown",
					stage: "transcript",
					transcript: { chunkIndex: 0, marker: "x" },
					input: {
						recapText: input.recapText,
						quotes: input.quotes,
						confirmed: true,
					},
					...p,
				}),
			);
		}

		function readBack(opts: { bodies: string[]; stateType?: string }): {
			comments: ReturnType<typeof vi.fn>;
		} {
			return {
				comments: vi.fn(async () => ({
					comments: opts.bodies.map((body, i) => ({ id: `c${i}`, body })),
					hasNextPage: false,
					endCursor: null,
					state: opts.stateType === "completed" ? "Done" : "In Progress",
					stateType: opts.stateType ?? "started",
				})),
			};
		}

		it("cold-start: rebuilds the receipt from CONFIRMED markers and posts ONLY what is missing", async () => {
			writeTrail([{ t: 1, type: "user_transcript", text: "先修耳朵" }]);
			writePending({});
			// server truth: summary landed, the single transcript chunk did NOT
			const read = readBack({
				bodies: [`assistant-summary ${SID}\n纪要正文`],
			});
			await reconcilePendingLandings({
				stateDir: dir,
				linear: { comment, closeIssue },
				read,
				log: () => {},
			});
			// summary NOT re-posted; the missing chunk + close landed
			const summaryPosts = comment.mock.calls.filter(([, b]) =>
				String(b).includes("assistant-summary"),
			);
			const chunkPosts = comment.mock.calls.filter(([, b]) =>
				String(b).includes("assistant-transcript"),
			);
			expect(summaryPosts).toHaveLength(0);
			expect(chunkPosts).toHaveLength(1);
			expect(closeIssue).toHaveBeenCalledTimes(1);
			expect(existsSync(elevenPendingPath(dir, SID))).toBe(false);
		});

		it("everything already landed (markers + completed state): pending cleared with ZERO writes", async () => {
			writeTrail([{ t: 1, type: "user_transcript", text: "先修耳朵" }]);
			writePending({});
			const read = readBack({
				bodies: [
					`assistant-summary ${SID}`,
					`assistant-transcript ${SID} chunk 1/1`,
				],
				stateType: "completed",
			});
			await reconcilePendingLandings({
				stateDir: dir,
				linear: { comment, closeIssue },
				read,
				log: () => {},
			});
			expect(comment).not.toHaveBeenCalled();
			expect(closeIssue).not.toHaveBeenCalled();
			expect(existsSync(elevenPendingPath(dir, SID))).toBe(false);
		});

		it("unknown envelope version: kept + fail-loud, NEVER mutates Linear", async () => {
			writePending({ version: 99 as unknown as 1 });
			const logs: string[] = [];
			await reconcilePendingLandings({
				stateDir: dir,
				linear: { comment, closeIssue },
				read: readBack({ bodies: [] }),
				log: (l) => logs.push(l),
			});
			expect(comment).not.toHaveBeenCalled();
			expect(closeIssue).not.toHaveBeenCalled();
			expect(existsSync(elevenPendingPath(dir, SID))).toBe(true);
			expect(logs.some((l) => l.includes("LOUD"))).toBe(true);
		});

		it("illegal stage payload (close without closeTarget): kept + fail-loud, no mutation", async () => {
			writePending({
				stage: "close",
				close: undefined,
				transcript: undefined,
			});
			const logs: string[] = [];
			await reconcilePendingLandings({
				stateDir: dir,
				linear: { comment, closeIssue },
				read: readBack({ bodies: [] }),
				log: (l) => logs.push(l),
			});
			expect(comment).not.toHaveBeenCalled();
			expect(closeIssue).not.toHaveBeenCalled();
			expect(existsSync(elevenPendingPath(dir, SID))).toBe(true);
			expect(logs.some((l) => l.includes("LOUD"))).toBe(true);
		});

		it("Codex #552 MEDIUM-6: illegal outcome enum → kept + LOUD, NO mutation", async () => {
			writePending({ outcome: "garbage" as never });
			const logs: string[] = [];
			await reconcilePendingLandings({
				stateDir: dir,
				linear: { comment, closeIssue },
				read: readBack({ bodies: [] }),
				log: (l) => logs.push(l),
			});
			expect(comment).not.toHaveBeenCalled();
			expect(closeIssue).not.toHaveBeenCalled();
			expect(existsSync(elevenPendingPath(dir, SID))).toBe(true);
			expect(logs.some((l) => l.includes("LOUD"))).toBe(true);
		});

		it("Codex #552 HIGH-1: a valid receipt lagging a server-confirmed chunk does NOT re-post it", async () => {
			// trail has 1 chunk; the server already has summary + chunk 1/1, but the
			// local receipt's postedChunks lags at 0 (client timed out after the POST).
			writeTrail([{ t: 1, type: "user_transcript", text: "先修耳朵" }]);
			writePending({ stage: "close", close: { closeTarget: "FLY-2000" } });
			writeFileSync(
				elevenReceiptPath(dir, SID),
				JSON.stringify({
					issueId: "FLY-2000",
					sessionId: SID,
					commentAt: "t",
					transcript: { rowCount: 1, chunkCount: 1, postedChunks: 0 },
				}),
			);
			const read = readBack({
				bodies: [
					`assistant-summary ${SID}`,
					`assistant-transcript ${SID} chunk 1/1`,
				],
			});
			await reconcilePendingLandings({
				stateDir: dir,
				linear: { comment, closeIssue },
				read,
				log: () => {},
			});
			// the already-landed chunk is NOT re-posted; only the close remains
			const chunkPosts = comment.mock.calls.filter(([, b]) =>
				String(b).includes("assistant-transcript"),
			);
			expect(chunkPosts).toHaveLength(0);
			expect(closeIssue).toHaveBeenCalledTimes(1);
		});

		it("Codex #552 HIGH-1: a NON-contiguous marker set does not count as a confirmed prefix", async () => {
			// server has a high-index chunk marker but NOT chunk 1 → the confirmed
			// contiguous prefix is 0, so the transcript prefix must still be posted
			// (the max marker index is not trusted as a prefix).
			writeTrail([{ t: 1, type: "user_transcript", text: "先修耳朵" }]);
			writePending({});
			const read = readBack({
				bodies: [
					`assistant-summary ${SID}`,
					`assistant-transcript ${SID} chunk 2/2`,
				],
			});
			await reconcilePendingLandings({
				stateDir: dir,
				linear: { comment, closeIssue },
				read,
				log: () => {},
			});
			// the transcript prefix (chunk 1) IS posted — non-contiguous ≠ confirmed
			const posted = comment.mock.calls
				.map(([, b]) => String(b))
				.some((b) => b.includes("assistant-transcript"));
			expect(posted).toBe(true);
		});

		it("a still-failing resume keeps the envelope for the next boot", async () => {
			writeTrail([{ t: 1, type: "user_transcript", text: "先修耳朵" }]);
			writePending({});
			comment.mockRejectedValue(new Error("linear still down"));
			await reconcilePendingLandings({
				stateDir: dir,
				linear: { comment, closeIssue },
				read: readBack({ bodies: [] }),
				log: () => {},
			});
			expect(existsSync(elevenPendingPath(dir, SID))).toBe(true);
		});
	});
});
