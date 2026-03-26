import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommDB } from "flywheel-comm/db";
import {
	type CaptureError,
	type CaptureResult,
	type ExecCaptureFn,
	captureSession,
	isCaptureError,
} from "../bridge/session-capture.js";

describe("captureSession", () => {
	let tmpDir: string;
	let dbPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "capture-test-"));
		dbPath = join(tmpDir, "comm.db");
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function makeGetCommDbPath(path: string): (name: string) => string {
		return (_name: string) => path;
	}

	const successCapture: ExecCaptureFn = async (target, lines) =>
		`captured ${lines} lines from ${target}\n`;

	const failCapture: ExecCaptureFn = async () => {
		throw new Error("no server running on /tmp/tmux-501/default");
	};

	it("returns 404 when CommDB does not exist", async () => {
		const result = await captureSession(
			"exec-1",
			"test-project",
			100,
			successCapture,
			makeGetCommDbPath(join(tmpDir, "nonexistent.db")),
		);

		expect(isCaptureError(result)).toBe(true);
		const err = result as CaptureError;
		expect(err.status).toBe(404);
		expect(err.error).toContain("database not found");
	});

	it("returns 404 when session is not in CommDB", async () => {
		// Create a real CommDB but don't register any sessions
		const db = new CommDB(dbPath);
		db.close();

		const result = await captureSession(
			"exec-nonexistent",
			"test-project",
			100,
			successCapture,
			makeGetCommDbPath(dbPath),
		);

		expect(isCaptureError(result)).toBe(true);
		const err = result as CaptureError;
		expect(err.status).toBe(404);
		expect(err.error).toContain("No tmux window");
	});

	it("returns output when session exists and tmux capture succeeds", async () => {
		const db = new CommDB(dbPath);
		db.registerSession("exec-1", "flywheel:@42", "test-project");
		db.close();

		const result = await captureSession(
			"exec-1",
			"test-project",
			100,
			successCapture,
			makeGetCommDbPath(dbPath),
		);

		expect(isCaptureError(result)).toBe(false);
		const ok = result as CaptureResult;
		expect(ok.output).toBe("captured 100 lines from flywheel:@42\n");
		expect(ok.tmux_target).toBe("flywheel:@42");
		expect(ok.lines).toBe(100);
		expect(ok.captured_at).toBeTruthy();
		// Verify captured_at is a valid ISO string
		expect(new Date(ok.captured_at).toISOString()).toBe(ok.captured_at);
	});

	it("returns 502 when tmux capture fails", async () => {
		const db = new CommDB(dbPath);
		db.registerSession("exec-1", "flywheel:@42", "test-project");
		db.close();

		const result = await captureSession(
			"exec-1",
			"test-project",
			100,
			failCapture,
			makeGetCommDbPath(dbPath),
		);

		expect(isCaptureError(result)).toBe(true);
		const err = result as CaptureError;
		expect(err.status).toBe(502);
		expect(err.error).toContain("tmux window not found");
		expect(err.error).toContain("flywheel:@42");
	});

	it("passes correct lines value to ExecCaptureFn", async () => {
		const db = new CommDB(dbPath);
		db.registerSession("exec-1", "flywheel:@42", "test-project");
		db.close();

		const mockCapture = vi.fn<ExecCaptureFn>(async () => "output\n");

		await captureSession(
			"exec-1",
			"test-project",
			250,
			mockCapture,
			makeGetCommDbPath(dbPath),
		);

		expect(mockCapture).toHaveBeenCalledWith("flywheel:@42", 250);
	});

	it("returns 502 and logs to console.error when CommDB read fails", async () => {
		// Create a CommDB, then corrupt it
		const db = new CommDB(dbPath);
		db.registerSession("exec-1", "flywheel:@42", "test-project");
		db.close();

		// Point to a non-sqlite file to trigger a DB read error
		const badDbPath = join(tmpDir, "corrupt.db");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(badDbPath, "this is not a sqlite database");

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await captureSession(
			"exec-1",
			"test-project",
			100,
			successCapture,
			makeGetCommDbPath(badDbPath),
		);

		expect(isCaptureError(result)).toBe(true);
		const err = result as CaptureError;
		expect(err.status).toBe(502);
		expect(err.error).toContain("Failed to read");

		expect(consoleSpy).toHaveBeenCalled();
		const logMsg = consoleSpy.mock.calls[0]?.join(" ") ?? "";
		expect(logMsg).toContain("[capture]");
		expect(logMsg).toContain("test-project");
		expect(logMsg).toContain("exec-1");

		consoleSpy.mockRestore();
	});

	it("returns 400 for project_name with path traversal (../)", async () => {
		const result = await captureSession(
			"exec-1",
			"../../etc",
			100,
			successCapture,
			makeGetCommDbPath(dbPath),
		);

		expect(isCaptureError(result)).toBe(true);
		const err = result as CaptureError;
		expect(err.status).toBe(400);
		expect(err.error).toContain("Invalid project name");
	});

	it("returns 400 for project_name with forward slash", async () => {
		const result = await captureSession(
			"exec-1",
			"some/path",
			100,
			successCapture,
			makeGetCommDbPath(dbPath),
		);

		expect(isCaptureError(result)).toBe(true);
		const err = result as CaptureError;
		expect(err.status).toBe(400);
		expect(err.error).toContain("Invalid project name");
	});

	it("returns 400 for project_name with backslash", async () => {
		const result = await captureSession(
			"exec-1",
			"some\\path",
			100,
			successCapture,
			makeGetCommDbPath(dbPath),
		);

		expect(isCaptureError(result)).toBe(true);
		const err = result as CaptureError;
		expect(err.status).toBe(400);
		expect(err.error).toContain("Invalid project name");
	});

	it("logs tmux error context to console.error when capture fails", async () => {
		const db = new CommDB(dbPath);
		db.registerSession("exec-1", "flywheel:@42", "test-project");
		db.close();

		const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await captureSession(
			"exec-1",
			"test-project",
			100,
			failCapture,
			makeGetCommDbPath(dbPath),
		);

		expect(consoleSpy).toHaveBeenCalled();
		const logMsg = consoleSpy.mock.calls[0]?.join(" ") ?? "";
		expect(logMsg).toContain("[capture]");
		expect(logMsg).toContain("flywheel:@42");
		expect(logMsg).toContain("exec-1");

		consoleSpy.mockRestore();
	});
});

describe("isCaptureError", () => {
	it("returns true for CaptureError", () => {
		expect(isCaptureError({ error: "test", status: 404 })).toBe(true);
	});

	it("returns false for CaptureResult", () => {
		expect(
			isCaptureError({
				output: "text",
				tmux_target: "t",
				lines: 100,
				captured_at: new Date().toISOString(),
			}),
		).toBe(false);
	});
});
