/**
 * FLY-123: unanswered-gate marker module — question-bound (Codex R5 #1),
 * the awaiting_gate detection + wake-routing data source.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	defaultGateMarkerDir,
	listGateMarkersForExecution,
	markGateMarkerAnswered,
	readGateMarker,
	removeGateMarker,
	writeGateMarker,
} from "../gate-marker.js";

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

	it("rejects path-traversal question ids", () => {
		expect(() =>
			writeGateMarker(dir, { ...base, questionId: "../evil" }),
		).toThrow(/invalid questionId/);
		expect(() => writeGateMarker(dir, { ...base, questionId: "a/b" })).toThrow(
			/invalid questionId/,
		);
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
});
