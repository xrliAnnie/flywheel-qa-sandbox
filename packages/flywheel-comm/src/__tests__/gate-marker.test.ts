/**
 * FLY-123: unanswered-gate marker module — question-bound (Codex R5 #1),
 * the awaiting_gate detection + wake-routing data source.
 */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	defaultGateMarkerDir,
	listGateMarkersForExecution,
	markGateMarkerAnswered,
	markGateMarkerAnsweredForExecution,
	readAskMarker,
	readGateMarker,
	removeGateMarker,
	writeAskMarker,
	writeGateMarker,
} from "../gate-marker.js";

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

describe("gate-marker (FLY-123)", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly123-marker-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const base = {
		questionId: "q-abc-123",
		executionId: "exec-1",
		backend: "codex-tmux",
		vendor: "codex",
		checkpoint: "brainstorm",
	};

	it("write + read round-trips, question-bound", () => {
		writeGateMarker(dir, base);
		const m = readGateMarker(dir, "q-abc-123");
		expect(m?.executionId).toBe("exec-1");
		expect(m?.backend).toBe("codex-tmux");
		expect(m?.vendor).toBe("codex");
		expect(m?.checkpoint).toBe("brainstorm");
		expect(m?.createdAt).toBeTruthy();
		expect(m?.answeredAt).toBeUndefined();
	});

	it("marker file is 0600", () => {
		writeGateMarker(dir, base);
		const mode = statSync(join(dir, "q-abc-123.json")).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("read of unknown question returns undefined", () => {
		expect(readGateMarker(dir, "nope")).toBeUndefined();
	});

	it("keeps safe marker reads working and treats out-of-domain ids as missing", () => {
		const gateId = "11111111-1111-4111-8111-111111111111";
		writeGateMarker(dir, { ...base, questionId: gateId });
		expect(readGateMarker(dir, gateId)?.executionId).toBe("exec-1");
		markGateMarkerAnswered(dir, gateId);
		expect(readGateMarker(dir, gateId)?.answeredAt).toBeTruthy();

		const askId = "22222222-2222-4222-8222-222222222222";
		writeAskMarker(dir, {
			questionId: askId,
			executionId: "exec-1",
			vendor: "codex",
		});
		expect(readAskMarker(dir, askId)?.executionId).toBe("exec-1");

		for (const questionId of ["turn-wait:waiter:holder:1", "../evil", "a/b"]) {
			expect(readGateMarker(dir, questionId)).toBeUndefined();
			expect(readAskMarker(dir, questionId)).toBeUndefined();
		}
	});

	it("rejects path-traversal question ids", () => {
		expect(() =>
			writeGateMarker(dir, { ...base, questionId: "../evil" }),
		).toThrow(/invalid questionId/);
		expect(() => writeGateMarker(dir, { ...base, questionId: "a/b" })).toThrow(
			/invalid questionId/,
		);
		expect(() =>
			writeGateMarker(dir, {
				...base,
				questionId: "turn-wait:waiter:holder:1",
			}),
		).toThrow(/invalid questionId/);
		expect(() =>
			writeAskMarker(dir, {
				questionId: "turn-wait:waiter:holder:1",
				executionId: "exec-1",
				vendor: "codex",
			}),
		).toThrow(/invalid questionId/);
	});

	it("markGateMarkerAnswered sets answeredAt", () => {
		writeGateMarker(dir, base);
		markGateMarkerAnswered(dir, "q-abc-123");
		expect(readGateMarker(dir, "q-abc-123")?.answeredAt).toBeTruthy();
	});

	it("removeGateMarker deletes; idempotent", () => {
		writeGateMarker(dir, base);
		removeGateMarker(dir, "q-abc-123");
		expect(readGateMarker(dir, "q-abc-123")).toBeUndefined();
		removeGateMarker(dir, "q-abc-123"); // no throw
	});

	it("listGateMarkersForExecution filters by execution", () => {
		writeGateMarker(dir, base);
		writeGateMarker(dir, { ...base, questionId: "q-2", executionId: "exec-2" });
		const list = listGateMarkersForExecution(dir, "exec-1");
		expect(list).toHaveLength(1);
		expect(list[0]?.questionId).toBe("q-abc-123");
		expect(listGateMarkersForExecution(dir, "exec-3")).toEqual([]);
	});

	it("does not reread marker files when the directory is unchanged", () => {
		writeGateMarker(dir, base);
		writeGateMarker(dir, { ...base, questionId: "q-2" });
		expect(listGateMarkersForExecution(dir, "exec-1")).toHaveLength(2);
		expect(vi.mocked(readFileSync)).toHaveBeenCalled();

		vi.mocked(readFileSync).mockClear();
		expect(listGateMarkersForExecution(dir, "exec-1")).toHaveLength(2);
		expect(vi.mocked(readFileSync)).not.toHaveBeenCalled();
	});

	it("retries transient marker IO failures on the next list", () => {
		writeGateMarker(dir, base);
		vi.mocked(readFileSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("too many open files"), { code: "EMFILE" });
		});

		expect(listGateMarkersForExecution(dir, "exec-1")).toEqual([]);
		expect(listGateMarkersForExecution(dir, "exec-1")).toHaveLength(1);
		expect(vi.mocked(readFileSync)).toHaveBeenCalledTimes(2);
	});

	it("negative-caches structurally unreadable marker entries", () => {
		writeGateMarker(dir, base);
		mkdirSync(join(dir, "directory.json"));
		expect(listGateMarkersForExecution(dir, "exec-1")).toHaveLength(1);

		vi.mocked(readFileSync).mockClear();
		expect(listGateMarkersForExecution(dir, "exec-1")).toHaveLength(1);
		expect(vi.mocked(readFileSync)).not.toHaveBeenCalled();
	});

	it("does not expose mutable objects retained by the process cache", () => {
		writeGateMarker(dir, base);
		const listed = listGateMarkersForExecution(dir, "exec-1");
		listed[0]!.answeredAt = "2026-08-29T00:00:00.000Z";

		expect(
			listGateMarkersForExecution(dir, "exec-1")[0]?.answeredAt,
		).toBeUndefined();
	});

	it("invalidates on answered rewrites, deletes, and corrupted additions", () => {
		writeGateMarker(dir, base);
		expect(listGateMarkersForExecution(dir, "exec-1")[0]?.answeredAt).toBe(
			undefined,
		);

		markGateMarkerAnswered(dir, base.questionId);
		expect(
			listGateMarkersForExecution(dir, "exec-1")[0]?.answeredAt,
		).toBeTruthy();

		writeFileSync(join(dir, "broken.json"), "{broken", "utf8");
		expect(listGateMarkersForExecution(dir, "exec-1")).toHaveLength(1);
		removeGateMarker(dir, base.questionId);
		expect(listGateMarkersForExecution(dir, "exec-1")).toEqual([]);
	});

	it("isolates caches for directories with identical mtimes", () => {
		const otherDir = mkdtempSync(join(tmpdir(), "fly123-marker-other-"));
		try {
			writeGateMarker(dir, base);
			writeGateMarker(otherDir, {
				...base,
				questionId: "q-other",
				executionId: "exec-other",
			});
			const sharedMtime = new Date("2026-08-29T01:15:00.000Z");
			utimesSync(dir, sharedMtime, sharedMtime);
			utimesSync(otherDir, sharedMtime, sharedMtime);

			expect(
				listGateMarkersForExecution(dir, "exec-1").map(
					({ questionId }) => questionId,
				),
			).toEqual(["q-abc-123"]);
			expect(
				listGateMarkersForExecution(otherDir, "exec-other").map(
					({ questionId }) => questionId,
				),
			).toEqual(["q-other"]);
		} finally {
			rmSync(otherDir, { recursive: true, force: true });
		}
	});

	it("reuses cached parses across an 8K-marker warm and incremental pass", () => {
		for (let index = 0; index < 8_000; index += 1) {
			writeFileSync(
				join(dir, `q-${String(index).padStart(4, "0")}.json`),
				JSON.stringify({
					...base,
					questionId: `q-${index}`,
				}),
				"utf8",
			);
		}
		expect(listGateMarkersForExecution(dir, "exec-1")).toHaveLength(8_000);

		vi.mocked(readFileSync).mockClear();
		expect(listGateMarkersForExecution(dir, "exec-1")).toHaveLength(8_000);
		expect(vi.mocked(readFileSync)).not.toHaveBeenCalled();

		writeFileSync(
			join(dir, "q-new.json"),
			JSON.stringify({ ...base, questionId: "q-new" }),
			"utf8",
		);
		vi.mocked(readFileSync).mockClear();
		expect(listGateMarkersForExecution(dir, "exec-1")).toHaveLength(8_001);
		expect(vi.mocked(readFileSync)).toHaveBeenCalledTimes(1);
	}, 30_000);

	it("defaultGateMarkerDir: env override wins, else ~/.flywheel default", () => {
		expect(
			defaultGateMarkerDir({
				FLYWHEEL_GATE_MARKER_DIR: "/x/y",
			} as NodeJS.ProcessEnv),
		).toBe("/x/y");
		expect(defaultGateMarkerDir({} as NodeJS.ProcessEnv)).toMatch(
			/\.flywheel\/state\/codex-gates$/,
		);
	});

	// FLY-1257 defect ① × ④ HIGH-1: the isWaiting() predicate a held codex goal
	// polls is `listGateMarkersForExecution(...).some(m => !m.answeredAt)`. The
	// review coordinator answers a review gate via CommDB (not the marker), so a
	// held goal would stay "waiting" ~72h. This helper is what the coordinator
	// now calls to flip that predicate false immediately once the gate is answered.
	const isWaiting = (execId: string) =>
		listGateMarkersForExecution(dir, execId).some((m) => !m.answeredAt);

	it("flips the isWaiting() predicate false once a review gate is answered", () => {
		writeGateMarker(dir, {
			...base,
			questionId: "q-review",
			checkpoint: "review_code",
		});
		expect(isWaiting("exec-1")).toBe(true); // held: gate open

		expect(markGateMarkerAnsweredForExecution(dir, "q-review", "exec-1")).toBe(
			true,
		);

		expect(isWaiting("exec-1")).toBe(false); // resumes at once, no 72h wait
		expect(readGateMarker(dir, "q-review")?.answeredAt).toBeTruthy();
	});

	it("is a no-op for a foreign / missing / already-answered marker", () => {
		writeGateMarker(dir, {
			...base,
			questionId: "q-review",
			checkpoint: "review_code",
		});
		// Foreign execution id must never touch a marker it doesn't own.
		expect(
			markGateMarkerAnsweredForExecution(dir, "q-review", "other-exec"),
		).toBe(false);
		expect(readGateMarker(dir, "q-review")?.answeredAt).toBeUndefined();
		// Missing marker.
		expect(markGateMarkerAnsweredForExecution(dir, "no-such-q", "exec-1")).toBe(
			false,
		);
		// Already answered → idempotent no-op.
		markGateMarkerAnswered(dir, "q-review");
		expect(markGateMarkerAnsweredForExecution(dir, "q-review", "exec-1")).toBe(
			false,
		);
	});
});
