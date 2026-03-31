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

	it("stage set validates all 10 valid stages", async () => {
		const validStages = [
			"started",
			"brainstorm",
			"research",
			"plan",
			"design_review",
			"implement",
			"test",
			"code_review",
			"pr_created",
			"ship",
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
});
