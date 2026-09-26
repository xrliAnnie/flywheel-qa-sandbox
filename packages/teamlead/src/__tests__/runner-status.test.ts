import { afterEach, describe, expect, it } from "vitest";
import {
	applyStallWatchdog,
	clearStallCache,
	createStatusQuery,
	detectTerminalStatus,
	evictStaleEntries,
	stallCacheSize,
} from "../bridge/runner-status.js";
import type { CaptureError, CaptureResult } from "../bridge/session-capture.js";

afterEach(() => {
	clearStallCache();
});

// ── detectTerminalStatus ──

describe("detectTerminalStatus", () => {
	it("returns idle for empty output", () => {
		const result = detectTerminalStatus("");
		expect(result.status).toBe("idle");
		expect(result.reason).toContain("empty");
	});

	it("returns idle for whitespace-only output", () => {
		const result = detectTerminalStatus("   \n  \n  ");
		expect(result.status).toBe("idle");
	});

	it("detects waiting: [Y/n] prompt", () => {
		const result = detectTerminalStatus(
			"Some output\nDo you want to proceed? [Y/n]",
		);
		expect(result.status).toBe("waiting");
		expect(result.reason).toContain("matched");
	});

	it("detects waiting: Allow? prompt", () => {
		const result = detectTerminalStatus(
			"Working...\nClaude wants to edit file.ts\nAllow?",
		);
		expect(result.status).toBe("waiting");
	});

	it("detects waiting: [Allow] / [Deny]", () => {
		const result = detectTerminalStatus("Read file\n[Allow] [Deny]");
		expect(result.status).toBe("waiting");
	});

	it("detects waiting: Would you like to", () => {
		const result = detectTerminalStatus("Done.\nWould you like to continue?");
		expect(result.status).toBe("waiting");
	});

	it("detects idle: bare shell prompt $", () => {
		const result = detectTerminalStatus("some previous output\n$  ");
		expect(result.status).toBe("idle");
		expect(result.reason).toContain("shell prompt");
	});

	it("detects idle: user@host prompt", () => {
		const result = detectTerminalStatus("exit\nuser@macbook:~ $  ");
		expect(result.status).toBe("idle");
	});

	it("returns executing when no signals match", () => {
		const result = detectTerminalStatus(
			"Reading file src/index.ts\nAnalyzing dependencies...\nBuilding project",
		);
		expect(result.status).toBe("executing");
		expect(result.reason).toContain("no prompt or wait signal");
	});

	it("checks last 15 non-empty lines only", () => {
		// Build output where the waiting pattern is beyond the 15-line window
		const filler = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
		const result = detectTerminalStatus(
			`Do you want to proceed? [Y/n]\n${filler}`,
		);
		// The [Y/n] is beyond the 15-line tail → should not match
		expect(result.status).toBe("executing");
	});

	it("prioritizes waiting over idle when both present", () => {
		// Last line is a shell prompt, but a waiting pattern is also in the tail
		const result = detectTerminalStatus(
			"Some work\nDo you want to proceed? [Y/n]\n$ ",
		);
		expect(result.status).toBe("waiting");
	});
});

// ── applyStallWatchdog ──

describe("applyStallWatchdog", () => {
	const BASE_TIME = 1_000_000_000;

	it("passes through non-executing status unchanged", () => {
		const raw = { status: "waiting" as const, reason: "matched: [Y/n]" };
		const result = applyStallWatchdog("exec-1", "output", raw, BASE_TIME);
		expect(result.status).toBe("waiting");
		expect(result.stale_seconds).toBeUndefined();
	});

	it("passes through idle status unchanged", () => {
		const raw = { status: "idle" as const, reason: "shell prompt" };
		const result = applyStallWatchdog("exec-1", "output", raw, BASE_TIME);
		expect(result.status).toBe("idle");
	});

	it("returns executing on first call (no cache entry)", () => {
		const raw = { status: "executing" as const, reason: "active" };
		const result = applyStallWatchdog("exec-1", "output", raw, BASE_TIME);
		expect(result.status).toBe("executing");
		expect(stallCacheSize()).toBe(1);
	});

	it("returns executing when output changes", () => {
		const raw = { status: "executing" as const, reason: "active" };
		applyStallWatchdog("exec-1", "output-v1", raw, BASE_TIME);
		const result = applyStallWatchdog(
			"exec-1",
			"output-v2",
			raw,
			BASE_TIME + 60_000,
		);
		expect(result.status).toBe("executing");
	});

	it("returns executing when output unchanged but under 45s", () => {
		const raw = { status: "executing" as const, reason: "active" };
		applyStallWatchdog("exec-1", "same-output", raw, BASE_TIME);
		const result = applyStallWatchdog(
			"exec-1",
			"same-output",
			raw,
			BASE_TIME + 30_000,
		);
		expect(result.status).toBe("executing");
		expect(result.stale_seconds).toBeUndefined();
	});

	it("downgrades to waiting when output unchanged for 45s", () => {
		const raw = { status: "executing" as const, reason: "active" };
		applyStallWatchdog("exec-1", "same-output", raw, BASE_TIME);
		const result = applyStallWatchdog(
			"exec-1",
			"same-output",
			raw,
			BASE_TIME + 45_000,
		);
		expect(result.status).toBe("waiting");
		expect(result.reason).toContain("stall watchdog");
		expect(result.stale_seconds).toBe(45);
	});

	it("downgrades to waiting when output unchanged for 90s", () => {
		const raw = { status: "executing" as const, reason: "active" };
		applyStallWatchdog("exec-1", "same-output", raw, BASE_TIME);
		const result = applyStallWatchdog(
			"exec-1",
			"same-output",
			raw,
			BASE_TIME + 90_000,
		);
		expect(result.status).toBe("waiting");
		expect(result.stale_seconds).toBe(90);
	});

	it("resets timer when output changes after stall", () => {
		const raw = { status: "executing" as const, reason: "active" };
		applyStallWatchdog("exec-1", "same-output", raw, BASE_TIME);
		// 50s later (stalled)
		const stalled = applyStallWatchdog(
			"exec-1",
			"same-output",
			raw,
			BASE_TIME + 50_000,
		);
		expect(stalled.status).toBe("waiting");

		// Output changes → back to executing
		const recovered = applyStallWatchdog(
			"exec-1",
			"new-output",
			raw,
			BASE_TIME + 51_000,
		);
		expect(recovered.status).toBe("executing");
	});

	it("tracks separate sessions independently", () => {
		const raw = { status: "executing" as const, reason: "active" };
		applyStallWatchdog("exec-1", "output-A", raw, BASE_TIME);
		applyStallWatchdog("exec-2", "output-B", raw, BASE_TIME);

		// exec-1 stalls, exec-2 changes
		const r1 = applyStallWatchdog(
			"exec-1",
			"output-A",
			raw,
			BASE_TIME + 50_000,
		);
		const r2 = applyStallWatchdog(
			"exec-2",
			"output-B-v2",
			raw,
			BASE_TIME + 50_000,
		);

		expect(r1.status).toBe("waiting");
		expect(r2.status).toBe("executing");
	});
});

// ── evictStaleEntries ──

describe("evictStaleEntries", () => {
	const BASE_TIME = 1_000_000_000;

	it("evicts entries older than 1 hour", () => {
		const raw = { status: "executing" as const, reason: "active" };
		applyStallWatchdog("exec-1", "output", raw, BASE_TIME);
		applyStallWatchdog("exec-2", "output", raw, BASE_TIME);
		expect(stallCacheSize()).toBe(2);

		const evicted = evictStaleEntries(BASE_TIME + 3_600_001);
		expect(evicted).toBe(2);
		expect(stallCacheSize()).toBe(0);
	});

	it("keeps recent entries", () => {
		const raw = { status: "executing" as const, reason: "active" };
		applyStallWatchdog("exec-1", "output", raw, BASE_TIME);
		applyStallWatchdog("exec-2", "output", raw, BASE_TIME + 3_600_000);

		const evicted = evictStaleEntries(BASE_TIME + 3_600_001);
		expect(evicted).toBe(1);
		expect(stallCacheSize()).toBe(1);
	});
});

// ── createStatusQuery ──

describe("createStatusQuery", () => {
	let stopEviction: () => void;

	afterEach(() => {
		stopEviction?.();
	});

	function makeQuery(
		captureFn: (
			executionId: string,
			projectName: string,
			lines: number,
		) => Promise<CaptureResult | CaptureError>,
	) {
		const sq = createStatusQuery(captureFn);
		stopEviction = sq.stopEviction;
		return sq.query;
	}

	it("returns unknown when tmux capture fails (502 tmux)", async () => {
		const captureFn = async (): Promise<CaptureError> => ({
			error: "tmux window not found: GEO-100:@0",
			status: 502,
		});

		const query = makeQuery(captureFn);
		const { result, captureErrorStatus } = await query(
			"exec-1",
			"test-project",
		);
		expect(result.status).toBe("unknown");
		expect(result.reason).toContain("tmux window not found");
		expect(captureErrorStatus).toBeUndefined();
	});

	it("propagates 502 CommDB read failure (not tmux)", async () => {
		const captureFn = async (): Promise<CaptureError> => ({
			error: "Failed to read communication database for project 'test'",
			status: 502,
		});

		const query = makeQuery(captureFn);
		const { result, captureErrorStatus } = await query(
			"exec-1",
			"test-project",
		);
		expect(result.status).toBe("unknown");
		expect(captureErrorStatus).toBe(502);
	});

	it("propagates 404 capture error (missing CommDB)", async () => {
		const captureFn = async (): Promise<CaptureError> => ({
			error: "Communication database not found for project 'missing'",
			status: 404,
		});

		const query = makeQuery(captureFn);
		const { result, captureErrorStatus } = await query("exec-1", "missing");
		expect(result.status).toBe("unknown");
		expect(captureErrorStatus).toBe(404);
	});

	it("propagates 400 capture error (bad project name)", async () => {
		const captureFn = async (): Promise<CaptureError> => ({
			error: "Invalid project name: '../evil'",
			status: 400,
		});

		const query = makeQuery(captureFn);
		const { captureErrorStatus } = await query("exec-1", "../evil");
		expect(captureErrorStatus).toBe(400);
	});

	it("returns executing for active terminal output", async () => {
		const captureFn = async (): Promise<CaptureResult> => ({
			output: "Reading file...\nAnalyzing code...\nBuilding",
			tmux_target: "test:@0",
			lines: 100,
			captured_at: new Date().toISOString(),
		});

		const query = makeQuery(captureFn);
		const { result } = await query("exec-1", "test-project");
		expect(result.status).toBe("executing");
	});

	it("returns waiting for prompt output", async () => {
		const captureFn = async (): Promise<CaptureResult> => ({
			output: "Edit file.ts\nAllow?",
			tmux_target: "test:@0",
			lines: 100,
			captured_at: new Date().toISOString(),
		});

		const query = makeQuery(captureFn);
		const { result } = await query("exec-1", "test-project");
		expect(result.status).toBe("waiting");
	});

	it("returns idle for shell prompt", async () => {
		const captureFn = async (): Promise<CaptureResult> => ({
			output: "exit\n$ ",
			tmux_target: "test:@0",
			lines: 100,
			captured_at: new Date().toISOString(),
		});

		const query = makeQuery(captureFn);
		const { result } = await query("exec-1", "test-project");
		expect(result.status).toBe("idle");
	});

	it("applies stall watchdog across calls", async () => {
		const output = "Building project continuously...";
		const captureFn = async (): Promise<CaptureResult> => ({
			output,
			tmux_target: "test:@0",
			lines: 100,
			captured_at: new Date().toISOString(),
		});

		const query = makeQuery(captureFn);

		// First call — executing
		const r1 = await query("exec-stall", "test-project");
		expect(r1.result.status).toBe("executing");

		// Same output on subsequent call (stall watchdog uses real clock,
		// so within <45s it should still be executing)
		const r2 = await query("exec-stall", "test-project");
		expect(r2.result.status).toBe("executing");
	});
});
