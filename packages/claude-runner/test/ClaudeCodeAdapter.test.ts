import type { ExecFileOptions } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import type { AdapterExecutionContext } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "../src/ClaudeCodeAdapter.js";
import type { ExecFileLike, KillableChild } from "../src/wait-aware-exec.js";

type Callback = (error: Error | null, stdout: string, stderr: string) => void;

const nativeExecFile = vi.hoisted(() =>
	vi.fn((...args: unknown[]) => {
		const callback = args[3] as Callback;
		callback(new Error("unexpected native execFile"), "", "");
		return { kill: vi.fn(() => true) };
	}),
);

vi.mock("node:child_process", () => ({ execFile: nativeExecFile }));

const SUCCESS_JSON = JSON.stringify({
	type: "result",
	subtype: "success",
	total_cost_usd: 0.25,
	is_error: false,
	duration_ms: 42,
	num_turns: 3,
	result: "done",
	session_id: "session-1",
});

function fakeExec() {
	let callback: Callback | null = null;
	const calls: Array<{
		file: string;
		argv: readonly string[];
		options: ExecFileOptions;
	}> = [];
	const kill = vi.fn(() => {
		callback?.(new Error("child killed"), "", "terminated");
		return true;
	});
	const child: KillableChild = { kill };
	const execFile: ExecFileLike = (file, argv, options, cb) => {
		calls.push({ file, argv, options });
		callback = cb;
		return child;
	};

	return {
		calls,
		execFile,
		kill,
		fail(error = new Error("exit 1")) {
			callback?.(error, "", "failed");
		},
		succeed(stdout = SUCCESS_JSON) {
			callback?.(null, stdout, "");
		},
	};
}

function makeCtx(
	commDbPath: string | undefined,
	overrides: Partial<AdapterExecutionContext> = {},
): AdapterExecutionContext {
	return {
		executionId: "exec-1",
		issueId: "FLY-1253",
		prompt: "Implement the approved plan",
		cwd: "/repo",
		commDbPath,
		timeoutMs: 100,
		waitingTimeoutMs: 2_000,
		projectName: "flywheel",
		sentinelPath: "/repo/.flywheel/land-status.json",
		...overrides,
	};
}

async function advance(ms: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(ms);
}

describe("ClaudeCodeAdapter wait-aware direct execution", () => {
	let directory: string;
	let dbPath: string;
	let db: CommDB;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		nativeExecFile.mockClear();
		directory = mkdtempSync(join(tmpdir(), "claude-code-adapter-"));
		dbPath = join(directory, "comm.db");
		db = new CommDB(dbPath);
	});

	afterEach(() => {
		db.close();
		rmSync(directory, { recursive: true, force: true });
		vi.useRealTimers();
	});

	function adapter(proc: ReturnType<typeof fakeExec>): ClaudeCodeAdapter {
		return new ClaudeCodeAdapter(undefined, {
			execFile: proc.execFile,
			waitRetryMs: 10,
			now: Date.now,
			resolveCommCli: () => "/tmp/flywheel-comm.js",
		});
	}

	it("survives beyond the active timeout and continues the same child after a review verdict", async () => {
		const proc = fakeExec();
		const run = adapter(proc).execute(makeCtx(dbPath));

		await advance(40);
		const questionId = db.insertQuestion("exec-1", "lead-1", "review", {
			checkpoint: "review_code",
		});
		await advance(200);
		expect(proc.kill).not.toHaveBeenCalled();

		db.insertResponse(questionId, "lead-1", "APPROVED");
		await advance(10);
		proc.succeed();

		await expect(run).resolves.toMatchObject({
			success: true,
			sessionId: "session-1",
			sessionParams: { sessionId: "session-1" },
		});
		expect(proc.calls).toHaveLength(1);
		expect(proc.kill).not.toHaveBeenCalled();
	});

	it("also pauses for a generic checkpointed question gate", async () => {
		const questionId = db.insertQuestion("exec-1", "lead-1", "decision", {
			checkpoint: "question",
		});
		const proc = fakeExec();
		const run = adapter(proc).execute(makeCtx(dbPath));

		await advance(200);
		expect(proc.kill).not.toHaveBeenCalled();
		db.insertResponse(questionId, "lead-1", "continue");
		await advance(10);
		proc.succeed();

		await expect(run).resolves.toMatchObject({ success: true });
		expect(proc.calls).toHaveLength(1);
	});

	// QA (FLY-1253): the incident acceptance criterion — a bound review wait that
	// lasts many multiples of the active budget must NOT hard-kill the run, and
	// once the gate closes the run resumes with its REMAINING active budget (never
	// a refreshed one). A regression that re-armed a wall-clock kill, or that
	// granted a fresh budget on gate close, would flip exactly one of these two
	// assertions. The 100ms active timeout is paused across a 1000ms wait (10×),
	// then the ~30ms of budget left is exhausted right after the verdict lands.
	it("survives a wait far beyond the active timeout, then resumes the remaining (not refreshed) budget", async () => {
		const proc = fakeExec();
		const run = adapter(proc).execute(makeCtx(dbPath));

		await advance(60); // 60ms of active work consumed before any gate
		const questionId = db.insertQuestion("exec-1", "lead-1", "review", {
			checkpoint: "review_code",
		});
		await advance(1_000); // gate stays open 10× the 100ms active budget
		expect(proc.kill).not.toHaveBeenCalled();
		expect(proc.calls).toHaveLength(1);

		db.insertResponse(questionId, "lead-1", "APPROVED");
		await advance(10); // next probe observes the gate closed → budget resumes
		expect(proc.kill).not.toHaveBeenCalled();

		// Only ~30ms of active budget remained; exhaust it. A refreshed 100ms
		// budget would keep the child alive here — instead it must time out.
		await advance(60);
		await expect(run).resolves.toMatchObject({
			success: false,
			timedOut: true,
		});
		expect(proc.kill).toHaveBeenCalledTimes(1);
		expect(proc.calls).toHaveLength(1);
	});

	it.each([
		{
			name: "checkpoint-less ask",
			setup: (database: CommDB) =>
				database.insertQuestion("exec-1", "lead-1", "non-blocking ask"),
			path: () => dbPath,
		},
		{
			name: "gate owned by another execution",
			setup: (database: CommDB) =>
				database.insertQuestion("other-exec", "lead-1", "review", {
					checkpoint: "review_code",
				}),
			path: () => dbPath,
		},
		{
			name: "missing CommDB context",
			setup: () => undefined,
			path: () => undefined,
		},
	])(
		"keeps ordinary active timeout semantics for $name",
		async ({ setup, path }) => {
			setup(db);
			const proc = fakeExec();
			const run = adapter(proc).execute(makeCtx(path()));

			await advance(100);

			await expect(run).resolves.toMatchObject({
				success: false,
				timedOut: true,
			});
			expect(proc.kill).toHaveBeenCalledTimes(1);
		},
	);

	it("fails closed to the active timeout when the CommDB probe errors", async () => {
		const invalidDbPath = join(directory, "invalid.db");
		writeFileSync(invalidDbPath, "not a sqlite database");
		const proc = fakeExec();
		const run = adapter(proc).execute(makeCtx(invalidDbPath));

		await advance(100);

		await expect(run).resolves.toMatchObject({
			success: false,
			timedOut: true,
		});
		expect(proc.kill).toHaveBeenCalledTimes(1);
	});

	it("injects direct-run gate environment without changing transport identity", async () => {
		const inheritedMarker = process.env.FLYWHEEL_GATE_MARKER_DIR;
		delete process.env.FLYWHEEL_GATE_MARKER_DIR;
		try {
			const proc = fakeExec();
			const run = adapter(proc).execute(makeCtx(dbPath));
			const options = proc.calls[0]?.options;
			const env = options?.env;

			expect(options).not.toHaveProperty("timeout");
			expect(env).toMatchObject({
				FLYWHEEL_COMM_DB: dbPath,
				FLYWHEEL_EXEC_ID: "exec-1",
				FLYWHEEL_PROJECT_NAME: "flywheel",
				FLYWHEEL_ISSUE_ID: "FLY-1253",
				FLYWHEEL_LAND_STATUS_PATH: "/repo/.flywheel/land-status.json",
				FLYWHEEL_COMM_CLI: "/tmp/flywheel-comm.js",
				BASH_MAX_TIMEOUT_MS: "2000",
			});
			expect(env?.CLAUDECODE).toBeUndefined();
			expect(env?.FLYWHEEL_GATE_MARKER_DIR).toBeUndefined();

			proc.succeed();
			await expect(run).resolves.toMatchObject({ success: true });
		} finally {
			if (inheritedMarker === undefined) {
				delete process.env.FLYWHEEL_GATE_MARKER_DIR;
			} else {
				process.env.FLYWHEEL_GATE_MARKER_DIR = inheritedMarker;
			}
		}
	});

	it("does not label spawn, nonzero-exit, or parse failures as timeouts", async () => {
		const spawnProc = fakeExec();
		const spawnRun = adapter(spawnProc).execute(makeCtx(dbPath));
		spawnProc.fail(new Error("spawn ENOENT"));
		await expect(spawnRun).resolves.toEqual({ success: false, sessionId: "" });

		const parseProc = fakeExec();
		const parseRun = adapter(parseProc).execute(makeCtx(dbPath));
		parseProc.succeed("not json");
		await expect(parseRun).resolves.toEqual({ success: false, sessionId: "" });
	});
});
