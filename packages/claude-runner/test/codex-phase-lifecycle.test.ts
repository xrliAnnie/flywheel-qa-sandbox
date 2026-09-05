import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB, type PhaseWakeInput } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	atomicMergeCodexSessionState,
	CodexPhaseLifecycleController,
} from "../src/codex-phase-lifecycle.js";

class FakeWatcher {
	started = 0;
	stopped = 0;
	onDelivered?: (message: PhaseWakeInput) => void | Promise<void>;

	async start(): Promise<void> {
		this.started += 1;
	}

	async stop(): Promise<void> {
		this.stopped += 1;
	}

	async health(): Promise<{ ok: boolean }> {
		return { ok: this.started > this.stopped };
	}
}

describe("CodexPhaseLifecycleController (FLY-1269)", () => {
	let dir: string;
	let dbPath: string;
	let statePath: string;
	let db: CommDB;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1269-phase-controller-"));
		dbPath = join(dir, "comm.db");
		statePath = join(dir, "session", "session.json");
		db = new CommDB(dbPath);
	});

	afterEach(() => {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function controller(
		watcher: FakeWatcher | null = null,
		overrides: Partial<
			ConstructorParameters<typeof CodexPhaseLifecycleController>[0]
		> = {},
	) {
		return new CodexPhaseLifecycleController({
			executionId: "exec-1",
			role: "design",
			commDbPath: dbPath,
			sessionStatePath: statePath,
			shutdownPollIntervalMs: 5,
			now: () => 1_000,
			// A legacy caller may still carry stale watcher fields during rollout;
			// the lifecycle must ignore them rather than reclaim ownership.
			...(watcher ? { watcher } : {}),
			...overrides,
		} as ConstructorParameters<typeof CodexPhaseLifecycleController>[0]);
	}

	it("observes declared parked, cleared active, and DB errors as unknown", () => {
		const lifecycle = controller();
		db.upsertDeclaredState("exec-1", "parked", "handoff", 900, null);
		expect(lifecycle.observeBoundary()).toMatchObject({ kind: "parked" });
		expect(lifecycle.observe()).toMatchObject({ kind: "parked" });
		db.clearDeclaredState("exec-1");
		expect(lifecycle.observeBoundary()).toEqual({ kind: "active" });
		expect(lifecycle.observe()).toEqual({ kind: "active" });
		lifecycle.stop();

		const broken = controller(null, {
			db: {
				listPendingRunnerShutdowns: () => {
					throw new Error("sqlite unavailable");
				},
				getEffectiveDeclaredState: () => {
					throw new Error("sqlite unavailable");
				},
			} as never,
		});
		expect(broken.observe()).toEqual({
			kind: "unknown",
			error: "sqlite unavailable",
		});
		expect(broken.observeBoundary()).toEqual({
			kind: "unknown",
			error: "sqlite unavailable",
		});
	});

	it("start polls shutdown without starting mailbox intake while active", async () => {
		const watcher = new FakeWatcher();
		const lifecycle = controller(watcher);
		await lifecycle.start();
		expect(watcher.started).toBe(0);

		db.requestRunnerShutdown("exec-1", "shutdown-1", 1_001);
		await expect(lifecycle.waitForShutdown()).resolves.toEqual({
			requestId: "shutdown-1",
		});
		expect(watcher.started).toBe(0);
		await lifecycle.stop();
	});

	it("never owns mailbox intake across hold and shutdown transitions", async () => {
		const watcher = new FakeWatcher();
		const lifecycle = controller(watcher);
		await lifecycle.start();
		await lifecycle.enterHold({
			deadlineRemainingMs: 30_000,
			hardDeadlineRemainingMs: 60_000,
		});
		expect(watcher.started).toBe(0);
		expect(JSON.parse(readFileSync(statePath, "utf8")).phaseHold).toMatchObject(
			{
				state: "entering",
			},
		);
		await lifecycle.confirmHoldPaused();

		expect(watcher.started).toBe(0);
		expect(JSON.parse(readFileSync(statePath, "utf8")).phaseHold).toMatchObject(
			{
				state: "paused",
				deadlineRemainingMs: 30_000,
				hardDeadlineRemainingMs: 60_000,
			},
		);

		await lifecycle.leaveHold();
		expect(watcher.stopped).toBe(0);
		await lifecycle.enterHold({
			deadlineRemainingMs: 20_000,
			hardDeadlineRemainingMs: 50_000,
		});
		await lifecycle.confirmHoldPaused();
		await lifecycle.stopIntake();
		await lifecycle.stop();
		expect(watcher.started).toBe(0);
		expect(watcher.stopped).toBe(0);
	});

	it("persists the durable resident revision before pausing a loop target", async () => {
		const enters: Array<Record<string, unknown>> = [];
		const lifecycle = controller(null, {
			residentHold: {
				activationId: "activation-1",
				nodeId: "repair-any-name",
				enter: async (input) => {
					enters.push(input);
					return {
						ok: true as const,
						revision: 7,
						graceExpiresAt: "2026-09-04T11:00:00.000Z",
					};
				},
				close: async () => true,
				current: async () => undefined,
			},
		});

		await lifecycle.enterHold({
			deadlineRemainingMs: 30_000,
			hardDeadlineRemainingMs: 60_000,
		});

		expect(enters).toEqual([
			{
				executionId: "exec-1",
				activationId: "activation-1",
				nodeId: "repair-any-name",
				boundarySeq: 1,
			},
		]);
		expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
			residentBoundarySeq: 1,
			phaseHold: {
				schemaVersion: 2,
				nodeId: "repair-any-name",
				residentRevision: 7,
				graceExpiresAt: "2026-09-04T11:00:00.000Z",
				state: "entering",
				deadlineRemainingMs: 30_000,
				hardDeadlineRemainingMs: 60_000,
			},
		});
	});

	it("rebuilds a missing local hold from the current resident row on restart", async () => {
		const lifecycle = controller(null, {
			residentHold: {
				activationId: "activation-1",
				nodeId: "repair-any-name",
				enter: async () => ({ ok: false as const, reason: "unexpected" }),
				close: async () => true,
				current: async () => ({
					activationId: "activation-1",
					nodeId: "repair-any-name",
					state: "resident" as const,
					boundarySeq: 3,
					revision: 9,
					graceExpiresAt: "2026-09-04T11:30:00.000Z",
				}),
			},
			recoveryBudget: {
				deadlineRemainingMs: 40_000,
				hardDeadlineRemainingMs: 80_000,
			},
		});

		await lifecycle.start();

		expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
			residentBoundarySeq: 3,
			phaseHold: {
				schemaVersion: 2,
				nodeId: "repair-any-name",
				residentRevision: 9,
				graceExpiresAt: "2026-09-04T11:30:00.000Z",
				state: "paused",
				deadlineRemainingMs: 40_000,
				hardDeadlineRemainingMs: 80_000,
			},
		});
		await lifecycle.stop();
	});

	it("reconstructs a controller over the same persisted pending queue", async () => {
		db.enqueueRunnerPhaseWake(
			"exec-1",
			{ id: "persisted", to: "runner-agent", content: "resume" },
			1_100,
		);
		const first = controller();
		expect(first.observe()).toMatchObject({
			kind: "wake",
			message: { id: "persisted" },
		});
		await first.stop();

		const reconstructed = controller();
		expect(reconstructed.observe()).toMatchObject({
			kind: "wake",
			message: { id: "persisted" },
		});
		await reconstructed.stop();
	});

	it("shutdown requested wins over an already queued wake", () => {
		db.enqueueRunnerPhaseWake(
			"exec-1",
			{ id: "pending", to: "runner-agent", content: "work" },
			1_200,
		);
		db.requestRunnerShutdown("exec-1", "shutdown-wins", 1_201);
		expect(controller().observe()).toEqual({
			kind: "shutdown",
			requestId: "shutdown-wins",
		});
	});

	it("wake state transitions are idempotent for controller reconstruction", () => {
		db.enqueueRunnerPhaseWake(
			"exec-1",
			{ id: "stateful", to: "runner-agent", content: "work" },
			1_300,
		);
		const lifecycle = controller();
		lifecycle.markWakeStarted("stateful");
		lifecycle.markWakeStarted("stateful");
		lifecycle.finishWake("stateful");
		lifecycle.finishWake("stateful");
		expect(db.listRunnerPhaseWakes("exec-1")[0]?.state).toBe("finished");
	});

	it("request-bound shutdown acknowledgement is exact", () => {
		db.requestRunnerShutdown("exec-1", "shutdown-exact", 1_400);
		const lifecycle = controller();
		expect(() => lifecycle.ackShutdown("wrong", { ok: true })).toThrow(
			"shutdown acknowledgement refused",
		);
		lifecycle.ackShutdown("shutdown-exact", { ok: false, error: "drain" });
		expect(db.getRunnerShutdown("exec-1")).toMatchObject({
			state: "failed",
			error: "drain",
		});
	});

	it("settles every pending shutdown request with the same exit result", () => {
		db.requestRunnerShutdown("exec-1", "shutdown-first", 1_400);
		db.requestRunnerShutdown("exec-1", "shutdown-second", 1_401);
		const lifecycle = controller();

		lifecycle.ackAllPendingShutdowns({ ok: true });

		expect(
			db.getRunnerShutdownRequest("exec-1", "shutdown-first"),
		).toMatchObject({ state: "acked" });
		expect(
			db.getRunnerShutdownRequest("exec-1", "shutdown-second"),
		).toMatchObject({ state: "acked" });
	});

	it("atomic session merges preserve metadata and phaseHold in either writer order", () => {
		const phaseHold = {
			schemaVersion: 1 as const,
			role: "design" as const,
			state: "paused" as const,
			enteredAt: "2026-07-14T00:00:00.000Z",
			deadlineRemainingMs: 100,
			hardDeadlineRemainingMs: 200,
		};
		atomicMergeCodexSessionState(statePath, {
			threadId: "thread-a",
			daemonPid: 123,
			gateHold: { state: "waiting" },
		});
		atomicMergeCodexSessionState(statePath, { phaseHold });
		expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
			threadId: "thread-a",
			daemonPid: 123,
			gateHold: { state: "waiting" },
			phaseHold,
		});

		rmSync(join(dir, "session"), { recursive: true, force: true });
		atomicMergeCodexSessionState(statePath, { phaseHold });
		atomicMergeCodexSessionState(statePath, {
			threadId: "thread-b",
			daemonPid: 456,
		});
		expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
			threadId: "thread-b",
			daemonPid: 456,
			phaseHold,
		});
	});

	it.each([
		"{not-json",
		JSON.stringify({ phaseHold: { state: "paused" }, threadId: "keep" }),
		JSON.stringify(["not", "an", "object"]),
	])(
		"corrupt session state fails closed without truncation",
		async (corrupt) => {
			mkdirSync(join(dir, "session"), { recursive: true });
			writeFileSync(statePath, corrupt, "utf8");
			const lifecycle = controller();
			await expect(
				lifecycle.enterHold({
					deadlineRemainingMs: 1,
					hardDeadlineRemainingMs: 2,
				}),
			).rejects.toThrow();
			expect(readFileSync(statePath, "utf8")).toBe(corrupt);
		},
	);
});
