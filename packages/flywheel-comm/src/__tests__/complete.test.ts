/**
 * FLY-108: Tests for `flywheel-comm complete` subcommand.
 *
 * Covers:
 * - Payload shape (evidence nested fields, top-level fields, filesChangedCount not filesChanged)
 * - Flag validation (route enum, --merged requires --pr)
 * - Env validation
 * - Retry + exponential backoff + marker file (fail-close)
 * - Git field derivation (branch parse, commit count, diff numstat)
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock node:child_process so we can control git output
vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { complete } from "../commands/complete.js";

const execFileSyncMock = vi.mocked(execFileSync);

describe("complete command", () => {
	const originalEnv = { ...process.env };
	let mockFetch: ReturnType<typeof vi.fn>;
	let exitSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let logSpy: ReturnType<typeof vi.spyOn>;
	let tmpHome: string;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "fly-108-home-"));

		process.env.FLYWHEEL_EXEC_ID = "exec-108";
		process.env.FLYWHEEL_ISSUE_ID = "issue-108";
		process.env.FLYWHEEL_PROJECT_NAME = "geoforge3d";
		process.env.FLYWHEEL_BRIDGE_URL = "http://localhost:9292";
		process.env.HOME = tmpHome;
		delete process.env.FLYWHEEL_INGEST_TOKEN;

		mockFetch = vi
			.fn()
			.mockResolvedValue({ ok: true, status: 200, text: async () => "" });
		vi.stubGlobal("fetch", mockFetch);

		exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation((code?: number | string | null) => {
				throw new Error(`process.exit(${code})`);
			});

		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		execFileSyncMock.mockImplementation((cmd, args) => {
			if (cmd !== "git") throw new Error(`unexpected cmd ${cmd}`);
			const a = (args ?? []) as string[];
			if (a[0] === "rev-parse" && a[1] === "--abbrev-ref" && a[2] === "HEAD") {
				return "feat/v1.23.0-FLY-108-session-status-flip\n";
			}
			if (a[0] === "merge-base") {
				return "abc123base\n";
			}
			if (a[0] === "rev-list" && a.includes("--count")) {
				return "3\n";
			}
			if (a[0] === "diff" && a.includes("--numstat")) {
				return "60\t20\tfile-a.ts\n40\t15\tfile-b.ts\n20\t10\tfile-c.ts\n";
			}
			if (a[0] === "diff" && a.includes("--name-only")) {
				return "file-a.ts\nfile-b.ts\nfile-c.ts\n";
			}
			if (a[0] === "diff" && a.includes("--stat")) {
				return " 3 files changed, 120 insertions(+), 45 deletions(-)\n";
			}
			if (a[0] === "log" && a.includes("--format=%s")) {
				return "feat: complete cmd\ntest: add tests\nrefactor: cleanup\n";
			}
			return "";
		});
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		execFileSyncMock.mockReset();
		rmSync(tmpHome, { recursive: true, force: true });
	});

	it("valid flags → POST body with correct shape (evidence nested, filesChangedCount not filesChanged)", async () => {
		await complete({
			route: "auto_approve",
			pr: 123,
			merged: true,
		});

		expect(mockFetch).toHaveBeenCalledOnce();
		const [url, opts] = mockFetch.mock.calls[0]!;
		expect(url).toBe("http://localhost:9292/events");
		expect(opts.method).toBe("POST");

		const body = JSON.parse(opts.body);
		expect(body.event_type).toBe("session_completed");
		expect(body.source).toBe("flywheel-comm");
		expect(body.execution_id).toBe("exec-108");
		expect(body.issue_id).toBe("issue-108");
		expect(body.project_name).toBe("geoforge3d");

		// Top-level payload fields
		expect(body.payload.decision).toEqual({ route: "auto_approve" });
		expect(body.payload.sessionRole).toBe("main");
		expect(body.payload.exitReason).toBe("completed");
		expect(body.payload.issueIdentifier).toBe("FLY-108");

		// labels / projectId / consecutiveFailures are intentionally omitted
		expect(body.payload.labels).toBeUndefined();
		expect(body.payload.projectId).toBeUndefined();
		expect(body.payload.consecutiveFailures).toBeUndefined();

		// Evidence-nested fields
		expect(body.payload.evidence.landingStatus).toEqual({
			status: "merged",
			prNumber: 123,
		});
		expect(body.payload.evidence.commitCount).toBe(3);
		expect(body.payload.evidence.filesChangedCount).toBe(3); // NOT filesChanged
		expect(body.payload.evidence.filesChanged).toBeUndefined();
		expect(body.payload.evidence.linesAdded).toBe(120);
		expect(body.payload.evidence.linesRemoved).toBe(45);
		expect(body.payload.evidence.diffSummary).toContain("3 files changed");
		expect(body.payload.evidence.changedFilePaths).toEqual([
			"file-a.ts",
			"file-b.ts",
			"file-c.ts",
		]);
		expect(body.payload.evidence.commitMessages).toEqual([
			"feat: complete cmd",
			"test: add tests",
			"refactor: cleanup",
		]);
	});

	it("missing --route → exit 1", async () => {
		await expect(
			complete({ route: "", merged: false } as unknown as Parameters<
				typeof complete
			>[0]),
		).rejects.toThrow("process.exit(1)");
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("invalid --route (rejected) → exit 1", async () => {
		await expect(
			complete({ route: "rejected", merged: false }),
		).rejects.toThrow("process.exit(1)");
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Invalid --route"),
		);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("--merged without --pr → exit 1", async () => {
		await expect(
			complete({ route: "auto_approve", merged: true }),
		).rejects.toThrow("process.exit(1)");
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("--merged requires --pr"),
		);
	});

	it("missing FLYWHEEL_EXEC_ID → exit 1 with explicit env name", async () => {
		delete process.env.FLYWHEEL_EXEC_ID;
		await expect(
			complete({ route: "auto_approve", pr: 1, merged: true }),
		).rejects.toThrow("process.exit(1)");
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("FLYWHEEL_EXEC_ID"),
		);
	});

	it("missing FLYWHEEL_BRIDGE_URL → exit 1", async () => {
		delete process.env.FLYWHEEL_BRIDGE_URL;
		await expect(
			complete({ route: "auto_approve", pr: 1, merged: true }),
		).rejects.toThrow("process.exit(1)");
		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("FLYWHEEL_BRIDGE_URL"),
		);
	});

	it("Bridge 5xx x4 → marker file written + exit 1 (fail-close)", async () => {
		vi.useFakeTimers();
		try {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 500,
				text: async () => "server error",
			});

			const promise = complete({
				route: "auto_approve",
				pr: 42,
				merged: true,
			});

			const expectation = expect(promise).rejects.toThrow("process.exit(1)");
			// Advance through all retries (1s + 2s + 4s backoff)
			await vi.advanceTimersByTimeAsync(8000);
			await expectation;

			expect(mockFetch).toHaveBeenCalledTimes(4);

			const markerPath = join(
				tmpHome,
				".flywheel",
				"state",
				"complete-failed",
				"exec-108.json",
			);
			const marker = JSON.parse(readFileSync(markerPath, "utf8"));
			expect(marker.execution_id).toBe("exec-108");
			expect(marker.attempts).toBe(4);
			expect(marker.payload.decision.route).toBe("auto_approve");
		} finally {
			vi.useRealTimers();
		}
	});

	it("Bridge timeout → 200 on 2nd attempt → exit 0, no marker", async () => {
		vi.useFakeTimers();
		try {
			let attempt = 0;
			mockFetch.mockImplementation(() => {
				attempt += 1;
				if (attempt === 1) return Promise.reject(new Error("ETIMEDOUT"));
				return Promise.resolve({ ok: true, status: 200, text: async () => "" });
			});

			const p = complete({ route: "auto_approve", pr: 1, merged: true });
			await vi.advanceTimersByTimeAsync(2000);
			await p;

			expect(mockFetch).toHaveBeenCalledTimes(2);
			expect(exitSpy).not.toHaveBeenCalled();

			const markerDir = join(tmpHome, ".flywheel", "state", "complete-failed");
			// Marker should NOT exist
			expect(() => readFileSync(join(markerDir, "exec-108.json"))).toThrow();
		} finally {
			vi.useRealTimers();
		}
	});

	it("git branch not matching regex → issueIdentifier omitted", async () => {
		execFileSyncMock.mockImplementation((cmd, args) => {
			const a = (args ?? []) as string[];
			if (a[0] === "rev-parse" && a[1] === "--abbrev-ref") return "main\n";
			if (a[0] === "merge-base") return "base123\n";
			if (a[0] === "rev-list") return "1\n";
			if (a[0] === "diff" && a.includes("--numstat")) return "10\t5\tfoo.ts\n";
			if (a[0] === "diff" && a.includes("--name-only")) return "foo.ts\n";
			if (a[0] === "diff") return " 1 file changed\n";
			if (a[0] === "log") return "fix: thing\n";
			return "";
		});

		await complete({ route: "auto_approve", pr: 9, merged: true });

		const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
		expect(body.payload.issueIdentifier).toBeUndefined();
	});

	it("non-merged needs_review path → landingStatus omitted, route needs_review", async () => {
		await complete({ route: "needs_review", merged: false });

		expect(mockFetch).toHaveBeenCalledOnce();
		const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
		expect(body.payload.decision.route).toBe("needs_review");
		expect(body.payload.evidence.landingStatus).toBeUndefined();
	});

	it("includes Authorization header when FLYWHEEL_INGEST_TOKEN present", async () => {
		process.env.FLYWHEEL_INGEST_TOKEN = "token-xyz";
		await complete({ route: "auto_approve", pr: 1, merged: true });

		const opts = mockFetch.mock.calls[0]![1];
		expect(opts.headers.Authorization).toBe("Bearer token-xyz");
	});

	it("--exit-reason override is honored", async () => {
		await complete({
			route: "auto_approve",
			pr: 1,
			merged: true,
			exitReason: "crashed",
		});
		const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
		expect(body.payload.exitReason).toBe("crashed");
	});

	it("--summary override is honored", async () => {
		await complete({
			route: "auto_approve",
			pr: 1,
			merged: true,
			summary: "explicit summary",
		});
		const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
		expect(body.payload.summary).toBe("explicit summary");
	});

	it("default summary comes from HEAD commit subject when --summary absent", async () => {
		await complete({ route: "auto_approve", pr: 1, merged: true });
		const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
		expect(body.payload.summary).toBe("feat: complete cmd");
	});
});
