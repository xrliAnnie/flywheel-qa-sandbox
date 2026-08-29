import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stage } from "../commands/stage.js";

describe("stage command", () => {
	const originalEnv = { ...process.env };
	let mockFetch: ReturnType<typeof vi.fn>;
	let exitSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		// Set up required env vars
		process.env.FLYWHEEL_EXEC_ID = "exec-test-1";
		process.env.FLYWHEEL_ISSUE_ID = "GEO-292";
		process.env.FLYWHEEL_PROJECT_NAME = "geoforge3d";
		process.env.FLYWHEEL_BRIDGE_URL = "http://localhost:9292";
		delete process.env.FLYWHEEL_INGEST_TOKEN;

		// Mock fetch
		mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal("fetch", mockFetch);

		// Mock process.exit to throw instead of killing the process
		exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number) => {
			throw new Error(`process.exit(${code})`);
		});

		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		process.env = { ...originalEnv };
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("stage set with valid stage succeeds", async () => {
		await stage({ subcommand: "set", stageName: "implement" });

		expect(mockFetch).toHaveBeenCalledOnce();
		const [url, opts] = mockFetch.mock.calls[0]!;
		expect(url).toBe("http://localhost:9292/events");
		expect(opts.method).toBe("POST");

		const body = JSON.parse(opts.body);
		expect(body.event_type).toBe("stage_changed");
		expect(body.execution_id).toBe("exec-test-1");
		expect(body.issue_id).toBe("GEO-292");
		expect(body.project_name).toBe("geoforge3d");
		expect(body.payload.stage).toBe("implement");
		expect(body.event_id).toBeTruthy();

		expect(logSpy).toHaveBeenCalledWith("Stage: implement");
	});

	it("stage set with invalid stage exits with error", async () => {
		await expect(
			stage({ subcommand: "set", stageName: "invalid_stage" }),
		).rejects.toThrow("process.exit(1)");

		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Invalid stage: invalid_stage"),
		);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("stage set without FLYWHEEL_EXEC_ID exits with error", async () => {
		delete process.env.FLYWHEEL_EXEC_ID;

		await expect(
			stage({ subcommand: "set", stageName: "implement" }),
		).rejects.toThrow("process.exit(1)");

		expect(errorSpy).toHaveBeenCalledWith(
			"FLYWHEEL_EXEC_ID environment variable is required",
		);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("stage set without FLYWHEEL_BRIDGE_URL exits with error", async () => {
		delete process.env.FLYWHEEL_BRIDGE_URL;

		await expect(
			stage({ subcommand: "set", stageName: "implement" }),
		).rejects.toThrow("process.exit(1)");

		expect(errorSpy).toHaveBeenCalledWith(
			"FLYWHEEL_BRIDGE_URL environment variable is required",
		);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	it("stage set with HTTP failure outputs warning but does not throw", async () => {
		mockFetch.mockResolvedValue({ ok: false, status: 500 });

		// Should NOT throw — fail-open behavior
		await stage({ subcommand: "set", stageName: "plan" });

		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Warning: Bridge returned 500"),
		);
		// No process.exit(1) — exits 0 implicitly
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("stage set with fetch network error outputs warning but does not throw", async () => {
		mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

		await stage({ subcommand: "set", stageName: "plan" });

		expect(errorSpy).toHaveBeenCalledWith(
			expect.stringContaining("ECONNREFUSED"),
		);
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it("stage set includes Authorization header when FLYWHEEL_INGEST_TOKEN exists", async () => {
		process.env.FLYWHEEL_INGEST_TOKEN = "secret-token-123";

		await stage({ subcommand: "set", stageName: "research" });

		const [, opts] = mockFetch.mock.calls[0]!;
		expect(opts.headers.Authorization).toBe("Bearer secret-token-123");
	});

	it("stage set omits Authorization header when FLYWHEEL_INGEST_TOKEN is missing", async () => {
		delete process.env.FLYWHEEL_INGEST_TOKEN;

		await stage({ subcommand: "set", stageName: "research" });

		const [, opts] = mockFetch.mock.calls[0]!;
		expect(opts.headers.Authorization).toBeUndefined();
	});

	it("stage set with unknown subcommand exits with error", async () => {
		await expect(
			stage({ subcommand: "get", stageName: "implement" }),
		).rejects.toThrow("process.exit(1)");

		expect(errorSpy).toHaveBeenCalledWith("Unknown stage subcommand: get");
	});

	it("stage set validates all valid stages (FLY-137 v1.27.2: 13 incl. onboard)", async () => {
		const validStages = [
			"started",
			"onboard", // FLY-137 v1.27.2
			"brainstorm",
			"research",
			"plan",
			"design_review",
			"implement",
			"test",
			"code_review",
			"pr_created",
			"approve",
			"ship",
			"completed",
		];
		for (const s of validStages) {
			mockFetch.mockClear();
			logSpy.mockClear();

			await stage({ subcommand: "set", stageName: s });
			expect(mockFetch).toHaveBeenCalledOnce();
			expect(logSpy).toHaveBeenCalledWith(`Stage: ${s}`);
		}
	});

	it("stage set without FLYWHEEL_ISSUE_ID exits with error", async () => {
		delete process.env.FLYWHEEL_ISSUE_ID;

		await expect(
			stage({ subcommand: "set", stageName: "implement" }),
		).rejects.toThrow("process.exit(1)");

		expect(errorSpy).toHaveBeenCalledWith(
			"FLYWHEEL_ISSUE_ID environment variable is required",
		);
	});

	it("stage set without FLYWHEEL_PROJECT_NAME exits with error", async () => {
		delete process.env.FLYWHEEL_PROJECT_NAME;

		await expect(
			stage({ subcommand: "set", stageName: "implement" }),
		).rejects.toThrow("process.exit(1)");

		expect(errorSpy).toHaveBeenCalledWith(
			"FLYWHEEL_PROJECT_NAME environment variable is required",
		);
	});

	// FLY-60 W2 (a): when stage=completed, attach landing_status from
	// land-status.json so Bridge can fire post-ship finalization on the
	// merge-proven event.
	describe("FLY-60 W2: landing_status payload on stage=completed", () => {
		let tmpRoot: string;
		const origCwd = process.cwd();

		beforeEach(() => {
			tmpRoot = join(tmpdir(), `stage-test-${Date.now()}-${Math.random()}`);
			mkdirSync(tmpRoot, { recursive: true });
			delete process.env.FLYWHEEL_LAND_STATUS_PATH;
		});

		afterEach(() => {
			process.chdir(origCwd);
			rmSync(tmpRoot, { recursive: true, force: true });
		});

		it("includes landing_status when FLYWHEEL_LAND_STATUS_PATH is set", async () => {
			const landPath = join(tmpRoot, "land-status.json");
			writeFileSync(
				landPath,
				JSON.stringify({
					status: "merged",
					prNumber: 42,
					mergeCommitSha: "abc123def456",
				}),
			);
			process.env.FLYWHEEL_LAND_STATUS_PATH = landPath;

			await stage({ subcommand: "set", stageName: "completed" });

			expect(mockFetch).toHaveBeenCalledOnce();
			const [, opts] = mockFetch.mock.calls[0]!;
			const body = JSON.parse(opts.body);
			expect(body.payload.stage).toBe("completed");
			expect(body.payload.landing_status).toEqual({
				status: "merged",
				prNumber: 42,
				mergeCommitSha: "abc123def456",
			});
		});

		it("falls back to cwd-derived land-status path when env unset", async () => {
			const runDir = join(tmpRoot, ".flywheel", "runs", "exec-test-1");
			mkdirSync(runDir, { recursive: true });
			writeFileSync(
				join(runDir, "land-status.json"),
				JSON.stringify({
					status: "merged",
					prNumber: 7,
					mergeCommitSha: "deadbeef",
				}),
			);
			process.chdir(tmpRoot);

			await stage({ subcommand: "set", stageName: "completed" });

			expect(mockFetch).toHaveBeenCalledOnce();
			const [, opts] = mockFetch.mock.calls[0]!;
			const body = JSON.parse(opts.body);
			expect(body.payload.landing_status).toEqual({
				status: "merged",
				prNumber: 7,
				mergeCommitSha: "deadbeef",
			});
		});

		it("omits landing_status when stage != completed", async () => {
			const landPath = join(tmpRoot, "land-status.json");
			writeFileSync(landPath, JSON.stringify({ status: "merged" }));
			process.env.FLYWHEEL_LAND_STATUS_PATH = landPath;

			await stage({ subcommand: "set", stageName: "ship" });

			expect(mockFetch).toHaveBeenCalledOnce();
			const [, opts] = mockFetch.mock.calls[0]!;
			const body = JSON.parse(opts.body);
			expect(body.payload.stage).toBe("ship");
			expect(body.payload).not.toHaveProperty("landing_status");
		});

		it("omits landing_status when file missing (back-compat)", async () => {
			// stage=completed but no FLYWHEEL_LAND_STATUS_PATH and no
			// cwd-derived file → payload should still POST cleanly.
			process.chdir(tmpRoot);

			await stage({ subcommand: "set", stageName: "completed" });

			expect(mockFetch).toHaveBeenCalledOnce();
			const [, opts] = mockFetch.mock.calls[0]!;
			const body = JSON.parse(opts.body);
			expect(body.payload.stage).toBe("completed");
			expect(body.payload).not.toHaveProperty("landing_status");
		});
	});

	// FLY-137 Phase 5: --plan flag carries the plan path into the
	// stage_changed payload so Bridge can persist + thread into the
	// Codex auto-trigger instruction.
	describe("FLY-137 Phase 5: --plan flag for design_review", () => {
		let tmpRoot: string;
		const origCwd = process.cwd();

		beforeEach(() => {
			tmpRoot = join(tmpdir(), `stage-plan-${Date.now()}-${Math.random()}`);
			mkdirSync(tmpRoot, { recursive: true });
			process.chdir(tmpRoot);
		});

		afterEach(() => {
			process.chdir(origCwd);
			rmSync(tmpRoot, { recursive: true, force: true });
		});

		it("includes plan_path in payload for stage=design_review", async () => {
			await stage({
				subcommand: "set",
				stageName: "design_review",
				planPath: "doc/engineer/plan/draft/v1.27.0-FLY-137-foo.md",
			});

			expect(mockFetch).toHaveBeenCalledOnce();
			const [, opts] = mockFetch.mock.calls[0]!;
			const body = JSON.parse(opts.body);
			expect(body.payload.stage).toBe("design_review");
			expect(body.payload.plan_path).toBe(
				"doc/engineer/plan/draft/v1.27.0-FLY-137-foo.md",
			);
		});

		it("rejects absolute --plan path", async () => {
			await expect(
				stage({
					subcommand: "set",
					stageName: "design_review",
					planPath: "/etc/passwd",
				}),
			).rejects.toThrow("process.exit(1)");
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("must be a relative path"),
			);
		});

		it("rejects --plan with .. traversal", async () => {
			await expect(
				stage({
					subcommand: "set",
					stageName: "design_review",
					planPath: "../escape/foo.md",
				}),
			).rejects.toThrow("process.exit(1)");
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("must not contain '..'"),
			);
		});

		it("rejects --plan on non-design_review stages", async () => {
			await expect(
				stage({
					subcommand: "set",
					stageName: "implement",
					planPath: "doc/foo.md",
				}),
			).rejects.toThrow("process.exit(1)");
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining("only valid for stage=design_review"),
			);
		});

		it("omits plan_path on design_review when flag not passed", async () => {
			await stage({ subcommand: "set", stageName: "design_review" });
			expect(mockFetch).toHaveBeenCalledOnce();
			const [, opts] = mockFetch.mock.calls[0]!;
			const body = JSON.parse(opts.body);
			expect(body.payload.stage).toBe("design_review");
			expect(body.payload).not.toHaveProperty("plan_path");
		});
	});

	// FLY-598: founder-UX gate — ux_hash on implement + fail-closed on the block code.
	describe("FLY-598 founder-ux gate", () => {
		let tmp: string;
		beforeEach(() => {
			tmp = join(tmpdir(), `stage-ux-${Date.now()}-${Math.random()}`);
			mkdirSync(tmp, { recursive: true });
		});
		afterEach(() => rmSync(tmp, { recursive: true, force: true }));

		it("attaches ux_hash to the implement payload from --ux-file", async () => {
			const brief = join(tmp, "ux-brief.md");
			writeFileSync(brief, "show a toast, not an alert\n");
			await stage({ subcommand: "set", stageName: "implement", uxFile: brief });
			const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
			expect(body.payload.ux_hash).toMatch(/^[0-9a-f]{64}$/);
		});

		it("rejects --ux-file on a non-implement stage", async () => {
			await expect(
				stage({ subcommand: "set", stageName: "test", uxFile: "/x.md" }),
			).rejects.toThrow("process.exit(1)");
			expect(mockFetch).not.toHaveBeenCalled();
		});

		it("FAIL-CLOSES (exit 1) on implement when the Bridge returns FOUNDER_UX_SIGNOFF_REQUIRED", async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 409,
				text: async () =>
					JSON.stringify({ error: "FOUNDER_UX_SIGNOFF_REQUIRED" }),
			});
			await expect(
				stage({ subcommand: "set", stageName: "implement" }),
			).rejects.toThrow("process.exit(1)");
		});

		it("stays fail-open (exit 0) on implement for an unrelated non-2xx", async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 500,
				text: async () => "upstream hiccup",
			});
			// resolves (no throw) — generic stage reporting is fail-open
			await stage({ subcommand: "set", stageName: "implement" });
		});

		it("stays fail-open on a non-implement stage even with the gate code (only implement fail-closes)", async () => {
			mockFetch.mockResolvedValue({
				ok: false,
				status: 409,
				text: async () =>
					JSON.stringify({ error: "FOUNDER_UX_SIGNOFF_REQUIRED" }),
			});
			await stage({ subcommand: "set", stageName: "test" }); // no throw
		});

		// Codex R1 HIGH: a GATED implement (carries a ux_hash) MUST fail-closed when
		// the gate cannot be confirmed — Bridge-down or any non-2xx — so a
		// founder-facing implement can't slip through while the Bridge is unreachable.
		it("FAIL-CLOSES (exit 1) on a gated implement when the Bridge is unreachable (transport error)", async () => {
			const brief = join(tmp, "ux-brief.md");
			writeFileSync(brief, "show a toast, not an alert\n");
			mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
			await expect(
				stage({ subcommand: "set", stageName: "implement", uxFile: brief }),
			).rejects.toThrow("process.exit(1)");
		});

		it("FAIL-CLOSES (exit 1) on a gated implement for an unrelated non-2xx (cannot confirm the gate)", async () => {
			const brief = join(tmp, "ux-brief.md");
			writeFileSync(brief, "show a toast, not an alert\n");
			mockFetch.mockResolvedValue({
				ok: false,
				status: 500,
				text: async () => "upstream hiccup",
			});
			await expect(
				stage({ subcommand: "set", stageName: "implement", uxFile: brief }),
			).rejects.toThrow("process.exit(1)");
		});

		it("enters implement (exit 0) on a gated implement when the Bridge confirms 2xx", async () => {
			const brief = join(tmp, "ux-brief.md");
			writeFileSync(brief, "show a toast, not an alert\n");
			mockFetch.mockResolvedValue({ ok: true, status: 200 });
			await stage({ subcommand: "set", stageName: "implement", uxFile: brief }); // no throw
			const body = JSON.parse(mockFetch.mock.calls[0]![1].body);
			expect(body.payload.ux_hash).toMatch(/^[0-9a-f]{64}$/);
		});
	});
});
