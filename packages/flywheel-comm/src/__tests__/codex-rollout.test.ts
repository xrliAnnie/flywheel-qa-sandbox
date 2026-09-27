import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	findRolloutForThread,
	MAX_RECORD_BYTES,
	readCodexTurnEvidence,
	readTurnEvidence,
	resolveCodexHome,
} from "../codex-rollout.js";

const THREAD = "01a0daf6-1f50-7522-b7dc-f0b3812a5dab";
const TURN_A = "01a0daf6-2634-7a23-a8e9-c1669023f458";
const TURN_B = "01a0db01-8aa3-7cf1-8ec1-05aaa7a94307";

type Line = Record<string, unknown>;

function meta(id = THREAD): Line {
	return {
		timestamp: "2026-09-25T23:45:58.000Z",
		type: "session_meta",
		payload: { id, session_id: id, cwd: "/tmp/x" },
	};
}
function started(turn: string, at = "2026-09-25T23:46:00.000Z"): Line {
	return {
		timestamp: at,
		type: "event_msg",
		payload: { type: "task_started", turn_id: turn },
	};
}
function context(
	turn: string,
	model = "gpt-6-astra",
	effort = "xhigh",
	at = "2026-09-25T23:46:01.000Z",
): Line {
	return {
		timestamp: at,
		type: "turn_context",
		payload: { turn_id: turn, model, effort, cwd: "/tmp/x" },
	};
}
function complete(turn: string, at = "2026-09-25T23:55:38.144Z"): Line {
	return {
		timestamp: at,
		type: "event_msg",
		payload: { type: "task_complete", turn_id: turn },
	};
}
function aborted(turn: string, at = "2026-09-25T23:56:00.000Z"): Line {
	return {
		timestamp: at,
		type: "event_msg",
		payload: { type: "turn_aborted", turn_id: turn, reason: "interrupted" },
	};
}
function filler(bytes: number): Line {
	return {
		timestamp: "2026-09-25T23:50:00.000Z",
		type: "response_item",
		payload: { type: "message", content: "x".repeat(bytes) },
	};
}

describe("codex rollout evidence (FLY-2891)", () => {
	let home: string;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "fly2891-codex-home-"));
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	function writeRollout(
		lines: Line[],
		opts: {
			dir?: string;
			name?: string;
			trailingNewline?: boolean;
			rawTail?: string;
		} = {},
	): string {
		const dir = join(home, opts.dir ?? "sessions/2026/09/25");
		mkdirSync(dir, { recursive: true });
		const path = join(
			dir,
			opts.name ?? `rollout-2026-09-25T16-45-58-${THREAD}.jsonl`,
		);
		const body = lines.map((line) => JSON.stringify(line)).join("\n");
		writeFileSync(
			path,
			`${body}${opts.trailingNewline === false ? "" : "\n"}${opts.rawTail ?? ""}`,
		);
		return path;
	}

	it("resolves CODEX_HOME with a ~/.codex fallback", () => {
		expect(resolveCodexHome({ CODEX_HOME: " /x/codex " })).toBe("/x/codex");
		expect(resolveCodexHome({ CODEX_HOME: "  " })).toMatch(/\.codex$/);
		expect(resolveCodexHome({})).toMatch(/\.codex$/);
	});

	it("finds rollouts under sessions/ and archived_sessions/, newest first", () => {
		const archived = writeRollout([meta()], { dir: "archived_sessions" });
		expect(findRolloutForThread(home, THREAD)).toBe(archived);
		const live = writeRollout([meta()]);
		utimesSync(archived, new Date(1_000_000), new Date(1_000_000));
		expect(findRolloutForThread(home, THREAD)).toBe(live);
		expect(
			findRolloutForThread(home, "01a0daf6-0000-0000-0000-000000000000"),
		).toBe(undefined);
	});

	it("rejects malformed thread ids before touching the filesystem", () => {
		expect(findRolloutForThread(home, "../etc")).toBeUndefined();
		expect(
			readCodexTurnEvidence({
				codexHome: home,
				threadId: "a/b",
				turnId: TURN_A,
			}),
		).toMatchObject({ ok: false, reason: "invalid_thread_id" });
		expect(
			readCodexTurnEvidence({
				codexHome: home,
				threadId: THREAD,
				turnId: "x y",
			}),
		).toMatchObject({ ok: false, reason: "invalid_turn_id" });
	});

	it("reads the model and effort of an exact turn", () => {
		const path = writeRollout([
			meta(),
			started(TURN_A),
			context(TURN_A),
			complete(TURN_A),
		]);
		expect(readTurnEvidence(home, path, THREAD, TURN_A)).toEqual({
			ok: true,
			evidence: {
				threadId: THREAD,
				turnId: TURN_A,
				model: "gpt-6-astra",
				effort: "xhigh",
				completedAt: "2026-09-25T23:55:38.144Z",
			},
		});
		expect(
			readCodexTurnEvidence({
				codexHome: home,
				threadId: THREAD,
				turnId: TURN_A,
			}),
		).toMatchObject({ ok: true, evidence: { model: "gpt-6-astra" } });
	});

	it("rejects a rollout whose session_meta id is another thread", () => {
		const path = writeRollout([
			meta("01a0ffff-1f50-7522-b7dc-f0b3812a5dab"),
			context(TURN_A),
			complete(TURN_A),
		]);
		expect(readTurnEvidence(home, path, THREAD, TURN_A)).toMatchObject({
			ok: false,
			reason: "meta_mismatch",
		});
	});

	it("rejects symlinked rollouts and paths outside the codex roots", () => {
		const real = writeRollout([meta(), context(TURN_A), complete(TURN_A)], {
			dir: "elsewhere",
		});
		mkdirSync(join(home, "sessions"), { recursive: true });
		const link = join(home, "sessions", `rollout-link-${THREAD}.jsonl`);
		symlinkSync(real, link);
		expect(readTurnEvidence(home, link, THREAD, TURN_A)).toMatchObject({
			ok: false,
			reason: "rollout_path_invalid",
		});
		expect(readTurnEvidence(home, real, THREAD, TURN_A)).toMatchObject({
			ok: false,
			reason: "rollout_path_invalid",
		});
	});

	it("ignores a half-written trailing line", () => {
		const path = writeRollout([meta(), started(TURN_A), context(TURN_A)], {
			rawTail: JSON.stringify(complete(TURN_A)),
		});
		expect(readTurnEvidence(home, path, THREAD, TURN_A)).toMatchObject({
			ok: false,
			reason: "turn_incomplete",
		});
	});

	it("finds a turn whose context sits many megabytes before the file end", () => {
		const lines: Line[] = [meta(), started(TURN_A), context(TURN_A)];
		for (let i = 0; i < 12; i += 1) lines.push(filler(512 * 1024));
		lines.push(complete(TURN_A));
		lines.push(started(TURN_B, "2026-09-26T00:00:00.000Z"));
		lines.push(context(TURN_B, "gpt-5.6-sol", "high"));
		for (let i = 0; i < 12; i += 1) lines.push(filler(512 * 1024));
		lines.push(complete(TURN_B, "2026-09-26T00:10:00.000Z"));
		const path = writeRollout(lines);
		expect(readTurnEvidence(home, path, THREAD, TURN_A)).toMatchObject({
			ok: true,
			evidence: { model: "gpt-6-astra", effort: "xhigh" },
		});
	});

	it("skips a single record larger than the per-record cap without losing sync", () => {
		const path = writeRollout([
			meta(),
			started(TURN_A),
			context(TURN_A),
			filler(40 * 1024 * 1024),
			filler(3 * 1024 * 1024),
			complete(TURN_A),
		]);
		expect(readTurnEvidence(home, path, THREAD, TURN_A)).toMatchObject({
			ok: true,
			evidence: {
				model: "gpt-6-astra",
				completedAt: "2026-09-25T23:55:38.144Z",
			},
		});
	});

	it("accepts a record of exactly the cap and skips one byte over it", () => {
		const paddedComplete = (bytes: number): string => {
			const base = (pad: string) =>
				JSON.stringify({
					timestamp: "2026-09-25T23:55:38.144Z",
					type: "event_msg",
					payload: { type: "task_complete", turn_id: TURN_A, pad },
				});
			const overhead = Buffer.byteLength(base(""));
			return base("x".repeat(bytes - overhead));
		};
		const at = writeRollout([meta(), started(TURN_A), context(TURN_A)], {
			rawTail: `${paddedComplete(MAX_RECORD_BYTES)}\n`,
		});
		expect(readTurnEvidence(home, at, THREAD, TURN_A)).toMatchObject({
			ok: true,
		});
		const over = writeRollout([meta(), started(TURN_A), context(TURN_A)], {
			name: `rollout-over-${THREAD}.jsonl`,
			rawTail: `${paddedComplete(MAX_RECORD_BYTES + 1)}\n${JSON.stringify(started(TURN_B))}\n${JSON.stringify(context(TURN_B))}\n${JSON.stringify(complete(TURN_B))}\n`,
		});
		expect(readTurnEvidence(home, over, THREAD, TURN_A)).toMatchObject({
			ok: false,
			reason: "turn_incomplete",
		});
		// Still in sync after the skipped record.
		expect(readTurnEvidence(home, over, THREAD, TURN_B)).toMatchObject({
			ok: true,
		});
	}, 60_000);

	it("rejects a turn whose turn_context entries disagree", () => {
		const path = writeRollout([
			meta(),
			context(TURN_A, "gpt-6-astra", "xhigh"),
			context(TURN_A, "gpt-5.6-sol", "xhigh"),
			complete(TURN_A),
		]);
		expect(readTurnEvidence(home, path, THREAD, TURN_A)).toMatchObject({
			ok: false,
			reason: "turn_context_conflict",
		});
	});

	it("accepts repeated identical turn_context entries (post-compaction)", () => {
		const path = writeRollout([
			meta(),
			context(TURN_A),
			context(TURN_A),
			complete(TURN_A),
		]);
		expect(readTurnEvidence(home, path, THREAD, TURN_A)).toMatchObject({
			ok: true,
		});
	});

	it("rejects a turn without task_complete, and a missing turn", () => {
		const path = writeRollout([meta(), started(TURN_A), context(TURN_A)]);
		expect(readTurnEvidence(home, path, THREAD, TURN_A)).toMatchObject({
			ok: false,
			reason: "turn_incomplete",
		});
		expect(readTurnEvidence(home, path, THREAD, TURN_B)).toMatchObject({
			ok: false,
			reason: "turn_not_found",
		});
		const noContext = writeRollout([meta(), complete(TURN_A)], {
			name: `rollout-2-${THREAD}.jsonl`,
		});
		expect(readTurnEvidence(home, noContext, THREAD, TURN_A)).toMatchObject({
			ok: false,
			reason: "turn_not_found",
		});
	});

	it("without a turn id picks the last completed turn", () => {
		const path = writeRollout([
			meta(),
			started(TURN_A),
			context(TURN_A, "gpt-5.6-sol", "xhigh"),
			complete(TURN_A),
			started(TURN_B, "2026-09-26T00:00:00.000Z"),
			context(TURN_B, "gpt-6-astra", "xhigh"),
			complete(TURN_B, "2026-09-26T00:10:00.000Z"),
		]);
		expect(readTurnEvidence(home, path, THREAD)).toMatchObject({
			ok: true,
			evidence: { turnId: TURN_B, model: "gpt-6-astra" },
		});
	});

	it("without a turn id is ambiguous when a later turn is still running", () => {
		const path = writeRollout([
			meta(),
			started(TURN_A),
			context(TURN_A),
			complete(TURN_A),
			started(TURN_B, "2026-09-26T00:00:00.000Z"),
			context(TURN_B),
		]);
		expect(readTurnEvidence(home, path, THREAD)).toMatchObject({
			ok: false,
			reason: "ambiguous",
		});
	});

	it("an aborted later turn does not make the last completed turn ambiguous", () => {
		const path = writeRollout([
			meta(),
			started(TURN_A),
			context(TURN_A),
			complete(TURN_A),
			started(TURN_B, "2026-09-26T00:00:00.000Z"),
			context(TURN_B),
			aborted(TURN_B),
		]);
		expect(readTurnEvidence(home, path, THREAD)).toMatchObject({
			ok: true,
			evidence: { turnId: TURN_A },
		});
	});

	it("keeps the original turn when a later follow-up on the thread changes model", () => {
		const path = writeRollout([
			meta(),
			started(TURN_A),
			context(TURN_A, "gpt-6-astra", "xhigh"),
			complete(TURN_A),
			started(TURN_B, "2026-09-26T00:00:00.000Z"),
			context(TURN_B, "gpt-5.6-sol", "medium"),
			complete(TURN_B, "2026-09-26T00:10:00.000Z"),
		]);
		expect(readTurnEvidence(home, path, THREAD, TURN_A)).toMatchObject({
			ok: true,
			evidence: { turnId: TURN_A, model: "gpt-6-astra", effort: "xhigh" },
		});
	});

	it("reports rollout_not_found when no file exists for the thread", () => {
		expect(
			readCodexTurnEvidence({
				codexHome: home,
				threadId: THREAD,
				turnId: TURN_A,
			}),
		).toMatchObject({ ok: false, reason: "rollout_not_found" });
	});
});
