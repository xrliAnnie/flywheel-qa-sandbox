import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	readCodexRolloutTokens,
	resolveCodexRolloutPath,
} from "../codex-rollout-token-watch.js";

const THREAD = "019a0000-aaaa-bbbb-cccc-000000002903";

function usage(at: string, total: number, type = "token_count"): string {
	const input = Math.floor(total / 2);
	return `${JSON.stringify({
		timestamp: at,
		type: "event_msg",
		payload: {
			type,
			info: {
				total_token_usage: {
					input_tokens: input,
					cached_input_tokens: 0,
					output_tokens: total - input,
					reasoning_output_tokens: 0,
					total_tokens: total,
				},
			},
		},
	})}\n`;
}

const CUT = Date.parse("2026-09-25T10:02:00.000Z");
const EMPTY = {
	offset: null,
	lastTotal: null,
	tokensAtTerminal: null,
	tokensAfterTerminal: null,
};

describe("FLY-2903 rollout token watch", () => {
	let root: string;
	let home: string;
	let rollout: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fly2903-rollout-"));
		home = join(root, "agents", "flywheel", "qa");
		mkdirSync(join(home, "sessions", "2026", "09", "25"), { recursive: true });
		rollout = join(
			home,
			"sessions",
			"2026",
			"09",
			"25",
			`rollout-2026-09-25T10-00-00-${THREAD}.jsonl`,
		);
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	describe("resolveCodexRolloutPath", () => {
		it("prefers the scorecard cursor over session.json and never walks the tree", () => {
			writeFileSync(rollout, "");
			const findRollout = vi.fn();
			const readThreadId = vi.fn(() => THREAD);
			expect(
				resolveCodexRolloutPath("exec-1", {
					codexHomesRoot: root,
					latestCursor: () => ({
						source_locator: rollout,
						native_session_id: THREAD,
					}),
					processHomes: [home],
					readThreadId,
					findRollout,
				}),
			).toBe(rollout);
			expect(findRollout).not.toHaveBeenCalled();
		});

		it("still resolves through the cursor after session.json is deleted", () => {
			writeFileSync(rollout, "");
			expect(
				resolveCodexRolloutPath("exec-1", {
					codexHomesRoot: root,
					latestCursor: () => ({
						source_locator: rollout,
						native_session_id: THREAD,
					}),
					processHomes: [],
					readThreadId: () => undefined,
				}),
			).toBe(rollout);
		});

		it("finds a cursor file Codex already moved to archived_sessions", () => {
			const archived = join(
				home,
				"archived_sessions",
				`rollout-2026-09-25T10-00-00-${THREAD}.jsonl`,
			);
			mkdirSync(join(home, "archived_sessions"), { recursive: true });
			writeFileSync(archived, "");
			expect(
				resolveCodexRolloutPath("exec-1", {
					codexHomesRoot: root,
					latestCursor: () => ({
						source_locator: rollout,
						native_session_id: THREAD,
					}),
					processHomes: [],
					readThreadId: () => undefined,
				}),
			).toBe(archived);
		});

		it("falls back to a snapshot process home plus the session.json thread id", () => {
			writeFileSync(rollout, "");
			const findRollout = vi.fn(() => rollout);
			expect(
				resolveCodexRolloutPath("exec-1", {
					codexHomesRoot: root,
					latestCursor: () => undefined,
					processHomes: [home],
					readThreadId: () => THREAD,
					findRollout,
				}),
			).toBe(rollout);
			expect(findRollout).toHaveBeenCalledWith(home, THREAD, [
				"sessions",
				"archived_sessions",
			]);
		});

		it("returns null without a cursor or a live process home", () => {
			expect(
				resolveCodexRolloutPath("exec-1", {
					codexHomesRoot: root,
					latestCursor: () => undefined,
					processHomes: [],
					readThreadId: () => THREAD,
				}),
			).toBeNull();
		});

		it("rejects a symlink, a path outside the homes root, a relative path and a foreign file name", () => {
			writeFileSync(rollout, "");
			const link = join(home, "sessions", `rollout-link-${THREAD}.jsonl`);
			symlinkSync(rollout, link);
			const outside = mkdtempSync(join(tmpdir(), "fly2903-outside-"));
			try {
				mkdirSync(join(outside, "sessions"), { recursive: true });
				const foreignRoot = join(
					outside,
					"sessions",
					`rollout-${THREAD}.jsonl`,
				);
				writeFileSync(foreignRoot, "");
				const foreignName = join(home, "sessions", "rollout-other.jsonl");
				writeFileSync(foreignName, "");
				for (const candidate of [
					link,
					foreignRoot,
					"sessions/rollout.jsonl",
					foreignName,
				]) {
					expect(
						resolveCodexRolloutPath("exec-1", {
							codexHomesRoot: root,
							latestCursor: () => ({
								source_locator: candidate,
								native_session_id: THREAD,
							}),
							processHomes: [],
							readThreadId: () => undefined,
						}),
					).toBeNull();
				}
			} finally {
				rmSync(outside, { recursive: true, force: true });
			}
		});
	});

	describe("readCodexRolloutTokens", () => {
		it("first read: cut at terminal+2min, differential after-terminal sum, whole lines only", () => {
			const lines = [
				usage("2026-09-25T09:59:00.000Z", 100),
				usage("2026-09-25T10:01:59.000Z", 150),
				usage("2026-09-25T10:05:00.000Z", 175),
				usage("2026-09-25T10:06:00.000Z", 200),
			];
			writeFileSync(rollout, `${lines.join("")}{"partial":`);
			const read = readCodexRolloutTokens(rollout, EMPTY, { cutMs: CUT });
			expect(read).toMatchObject({
				tokensAtTerminal: 150,
				tokensAfterTerminal: 50,
				lastTotal: 200,
				offset: Buffer.byteLength(lines.join("")),
				complete: true,
			});
			expect(read.note).toBeUndefined();
		});

		it("no post-terminal usage reads as a known zero", () => {
			writeFileSync(rollout, usage("2026-09-25T09:59:00.000Z", 100));
			expect(
				readCodexRolloutTokens(rollout, EMPTY, { cutMs: CUT }),
			).toMatchObject({ tokensAtTerminal: 100, tokensAfterTerminal: 0 });
		});

		it("an incremental read consumes only new bytes", () => {
			writeFileSync(rollout, usage("2026-09-25T09:59:00.000Z", 100));
			const first = readCodexRolloutTokens(rollout, EMPTY, { cutMs: CUT });
			appendFileSync(rollout, usage("2026-09-25T11:00:00.000Z", 1_100));
			const second = readCodexRolloutTokens(rollout, first, { cutMs: CUT });
			expect(second).toMatchObject({
				tokensAtTerminal: 100,
				tokensAfterTerminal: 1_000,
				lastTotal: 1_100,
				complete: true,
			});
			expect(second.offset).toBeGreaterThan(first.offset);
		});

		it("a counter that falls back starts a new segment from zero", () => {
			writeFileSync(
				rollout,
				[
					usage("2026-09-25T09:59:00.000Z", 1_000),
					usage("2026-09-25T10:10:00.000Z", 1_200),
					usage("2026-09-25T10:20:00.000Z", 300),
				].join(""),
			);
			expect(
				readCodexRolloutTokens(rollout, EMPTY, { cutMs: CUT }),
			).toMatchObject({ tokensAfterTerminal: 500, lastTotal: 300 });
		});

		it("ignores non-usage lines and malformed usage", () => {
			writeFileSync(
				rollout,
				[
					usage("2026-09-25T09:59:00.000Z", 100),
					'{"type":"response_item","payload":{"text":"token_count"}}\n',
					"not json token_count\n",
					usage("2026-09-25T10:30:00.000Z", 400, "agent_message"),
				].join(""),
			);
			expect(
				readCodexRolloutTokens(rollout, EMPTY, { cutMs: CUT }),
			).toMatchObject({ tokensAtTerminal: 100, tokensAfterTerminal: 0 });
		});

		it("stops at the byte budget, reports truncation and continues next time", () => {
			const lines = [
				usage("2026-09-25T09:59:00.000Z", 100),
				usage("2026-09-25T10:10:00.000Z", 300),
				usage("2026-09-25T10:20:00.000Z", 600),
			];
			writeFileSync(rollout, lines.join(""));
			const budget = Buffer.byteLength(lines[0]!) + 10;
			const first = readCodexRolloutTokens(rollout, EMPTY, {
				cutMs: CUT,
				maxBytes: budget,
			});
			expect(first).toMatchObject({ complete: false, note: "read_truncated" });
			let state = first;
			for (let i = 0; i < 5 && !state.complete; i += 1) {
				state = readCodexRolloutTokens(rollout, state, {
					cutMs: CUT,
					maxBytes: budget,
				});
			}
			expect(state).toMatchObject({
				complete: true,
				tokensAtTerminal: 100,
				tokensAfterTerminal: 500,
			});
		});

		it("rescans from zero when the file shrank below the committed offset", () => {
			writeFileSync(
				rollout,
				[
					usage("2026-09-25T09:59:00.000Z", 100),
					usage("2026-09-25T10:10:00.000Z", 300),
				].join(""),
			);
			const first = readCodexRolloutTokens(rollout, EMPTY, { cutMs: CUT });
			truncateSync(rollout, 0);
			writeFileSync(rollout, usage("2026-09-25T09:59:00.000Z", 40));
			const rewound = readCodexRolloutTokens(rollout, first, { cutMs: CUT });
			expect(rewound).toMatchObject({
				note: "rewound",
				tokensAtTerminal: 40,
				tokensAfterTerminal: 0,
				complete: true,
			});
		});

		it("refuses to read through a symlink", () => {
			writeFileSync(rollout, usage("2026-09-25T09:59:00.000Z", 100));
			const link = join(home, "sessions", `link-${THREAD}.jsonl`);
			symlinkSync(rollout, link);
			expect(() =>
				readCodexRolloutTokens(link, EMPTY, { cutMs: CUT }),
			).toThrow();
		});
	});
});
