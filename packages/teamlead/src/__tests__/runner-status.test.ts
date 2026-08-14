import { describe, expect, it, vi } from "vitest";
import {
	createStatusQuery,
	detectTerminalStatus,
} from "../bridge/runner-status.js";
import type { CaptureError, CaptureResult } from "../bridge/session-capture.js";

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

// ── createStatusQuery ──

describe("createStatusQuery", () => {
	function makeQuery(
		captureFn: (
			executionId: string,
			projectName: string,
			lines: number,
		) => Promise<CaptureResult | CaptureError>,
	) {
		const sq = createStatusQuery(captureFn);
		return sq.query;
	}

	it("creates no background timer", () => {
		vi.useFakeTimers();
		try {
			createStatusQuery(async () => ({ error: "unused", status: 404 }));
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

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

	it("keeps unchanged active output executing across calls", async () => {
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

		// Time-independent status remains a pure function of the latest capture.
		const r2 = await query("exec-stall", "test-project");
		expect(r2.result.status).toBe("executing");
	});
});
