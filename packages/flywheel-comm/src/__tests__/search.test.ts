import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommDB } from "../db.js";

// Track mock output for the promisified custom function
let mockStdout = "";
let mockError: Error | null = null;

// Mock child_process with proper __promisify__ support.
// promisify(execFile) uses the custom promisify symbol, so we must provide it.
vi.mock("node:child_process", () => {
	const fn = vi.fn() as ReturnType<typeof vi.fn> & {
		[key: symbol]: unknown;
	};
	fn[promisify.custom] = async () => {
		if (mockError) throw mockError;
		return { stdout: mockStdout, stderr: "" };
	};
	return { execFile: fn, execFileSync: vi.fn() };
});

import { search } from "../commands/search.js";

describe("search command", () => {
	let tmpDir: string;
	let dbPath: string;

	const MOCK_OUTPUT =
		"line one\nERROR: something broke\nline three\nERROR: another issue\nline five\n";

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "flywheel-comm-search-"));
		dbPath = join(tmpDir, "comm.db");

		const db = new CommDB(dbPath, true);
		db.registerSession(
			"exec-test-1",
			"flywheel:@0",
			"testproject",
			"FLY-11",
			"product-lead",
		);
		db.close();

		mockStdout = MOCK_OUTPUT;
		mockError = null;
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("should find matching lines in terminal output", async () => {
		const result = await search({
			execId: "exec-test-1",
			pattern: "ERROR",
			dbPath,
		});

		expect(result.matches).toHaveLength(2);
		expect(result.matches[0]).toEqual({
			line: 2,
			text: "ERROR: something broke",
		});
		expect(result.matches[1]).toEqual({
			line: 4,
			text: "ERROR: another issue",
		});
		expect(result.pattern).toBe("ERROR");
	});

	it("should return empty matches when pattern not found", async () => {
		const result = await search({
			execId: "exec-test-1",
			pattern: "NOTFOUND",
			dbPath,
		});

		expect(result.matches).toHaveLength(0);
		expect(result.total_lines).toBeGreaterThan(0);
	});

	it("should throw on missing session", async () => {
		await expect(
			search({
				execId: "nonexistent",
				pattern: "test",
				dbPath,
			}),
		).rejects.toThrow("No session found for execution: nonexistent");
	});

	it("should throw on missing database", async () => {
		await expect(
			search({
				execId: "exec-test-1",
				pattern: "test",
				dbPath: "/nonexistent/path/comm.db",
			}),
		).rejects.toThrow("Database not found");
	});

	it("should reject pattern longer than 200 chars", async () => {
		await expect(
			search({
				execId: "exec-test-1",
				pattern: "x".repeat(201),
				dbPath,
			}),
		).rejects.toThrow("Pattern too long");
	});

	it("should support case-insensitive matching", async () => {
		const result = await search({
			execId: "exec-test-1",
			pattern: "error",
			dbPath,
		});

		expect(result.matches).toHaveLength(2);
	});

	it("should report total_lines accurately", async () => {
		const result = await search({
			execId: "exec-test-1",
			pattern: "ERROR",
			dbPath,
		});

		// "line one\nERROR: something broke\nline three\nERROR: another issue\nline five\n" splits to 6 elements
		expect(result.total_lines).toBe(6);
	});

	it("should throw when tmux window not found", async () => {
		mockError = new Error("tmux error");

		await expect(
			search({
				execId: "exec-test-1",
				pattern: "test",
				dbPath,
			}),
		).rejects.toThrow("tmux window not found: flywheel:@0");
	});
});
