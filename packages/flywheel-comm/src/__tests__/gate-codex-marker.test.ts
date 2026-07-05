/**
 * FLY-123: `gate --no-block` writes the unanswered-gate marker ONLY when
 * FLYWHEEL_GATE_MARKER_DIR is present in the env (Codex runner spawn env).
 * Claude runners (no env) must see byte-identical no-block behavior.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type GateArgs, gate } from "../commands/gate.js";
import { listGateMarkersForExecution, readGateMarker } from "../gate-marker.js";

describe("gate --no-block marker write (FLY-123)", () => {
	let tmpDir: string;
	let dbPath: string;
	let markerDir: string;

	const origMarkerDir = process.env.FLYWHEEL_GATE_MARKER_DIR;
	const origBackendId = process.env.FLYWHEEL_RUNNER_BACKEND_ID;
	const origVendorId = process.env.FLYWHEEL_RUNNER_VENDOR_ID;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fly123-gate-marker-"));
		dbPath = join(tmpDir, "comm.db");
		markerDir = join(tmpDir, "codex-gates");
		delete process.env.FLYWHEEL_GATE_MARKER_DIR;
		delete process.env.FLYWHEEL_RUNNER_BACKEND_ID;
		delete process.env.FLYWHEEL_RUNNER_VENDOR_ID;
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		if (origMarkerDir === undefined)
			delete process.env.FLYWHEEL_GATE_MARKER_DIR;
		else process.env.FLYWHEEL_GATE_MARKER_DIR = origMarkerDir;
		if (origBackendId === undefined)
			delete process.env.FLYWHEEL_RUNNER_BACKEND_ID;
		else process.env.FLYWHEEL_RUNNER_BACKEND_ID = origBackendId;
		if (origVendorId === undefined)
			delete process.env.FLYWHEEL_RUNNER_VENDOR_ID;
		else process.env.FLYWHEEL_RUNNER_VENDOR_ID = origVendorId;
	});

	function args(overrides?: Partial<GateArgs>): GateArgs {
		return {
			checkpoint: "brainstorm",
			lead: "product-lead",
			execId: "exec-fly123",
			message: "My understanding: do the thing.",
			dbPath,
			timeoutMs: 48 * 3_600_000,
			timeoutBehavior: "fail-close",
			cleanupTtlHours: 24,
			noBlock: true,
			...overrides,
		};
	}

	it("writes a question-bound marker when FLYWHEEL_GATE_MARKER_DIR is set", async () => {
		process.env.FLYWHEEL_GATE_MARKER_DIR = markerDir;
		process.env.FLYWHEEL_RUNNER_BACKEND_ID = "codex-tmux";
		process.env.FLYWHEEL_RUNNER_VENDOR_ID = "codex";

		const result = await gate(args());
		expect(result.status).toBe("pending");
		const marker = readGateMarker(markerDir, result.questionId as string);
		expect(marker).toBeTruthy();
		expect(marker?.executionId).toBe("exec-fly123");
		expect(marker?.backend).toBe("codex-tmux");
		expect(marker?.vendor).toBe("codex");
		expect(marker?.checkpoint).toBe("brainstorm");
		expect(marker?.answeredAt).toBeUndefined();
	});

	it("marker carries the checkpoint's configured gate semantics (code review HIGH-2)", async () => {
		process.env.FLYWHEEL_GATE_MARKER_DIR = markerDir;
		const result = await gate(
			args({
				timeoutMs: 4 * 3_600_000,
				timeoutBehavior: "fail-open",
				timeoutBehaviorSource: "flag",
				cleanupTtlHours: 6,
				message: "m".repeat(600), // > 500 → truncated
			}),
		);
		const marker = readGateMarker(markerDir, result.questionId as string);
		expect(marker?.timeoutMs).toBe(4 * 3_600_000);
		expect(marker?.timeoutBehavior).toBe("fail-open");
		expect(marker?.timeoutBehaviorSource).toBe("flag");
		expect(marker?.cleanupTtlHours).toBe(6);
		expect(marker?.message?.length).toBeLessThanOrEqual(501);
		expect(marker?.message?.endsWith("…")).toBe(true);
	});

	it("byte-compat: NO marker when env is unset (Claude runner)", async () => {
		const result = await gate(args());
		expect(result.status).toBe("pending");
		expect(listGateMarkersForExecution(markerDir, "exec-fly123")).toEqual([]);
	});

	it("blocking mode never writes a marker even with env set", async () => {
		process.env.FLYWHEEL_GATE_MARKER_DIR = markerDir;
		await gate(
			args({ noBlock: false, timeoutMs: 200, timeoutBehavior: "fail-open" }),
		);
		expect(listGateMarkersForExecution(markerDir, "exec-fly123")).toEqual([]);
	});
});
