import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	atomicMergeCodexSessionState,
	CodexPhaseLifecycleController,
	type CodexWakeWatcher,
} from "../src/codex-phase-lifecycle.js";

type WakeMessage = Parameters<NonNullable<CodexWakeWatcher["onDelivered"]>>[0];

class FakeWatcher implements CodexWakeWatcher {
	started = 0;
	stopped = 0;
	onDelivered?: (message: WakeMessage) => void | Promise<void>;
	constructor(private readonly initial: WakeMessage[] = []) {}

	async start(): Promise<void> {
		this.started += 1;
		for (const message of this.initial) await this.onDelivered?.(message);
	}

	async stop(): Promise<void> {
		this.stopped += 1;
	}

	async health(): Promise<{ ok: boolean }> {
		return { ok: this.started > this.stopped };
	}

	async emit(message: WakeMessage): Promise<void> {
		await this.onDelivered?.(message);
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
		watcher: CodexWakeWatcher | null = null,
		overrides: Partial<
			ConstructorParameters<typeof CodexPhaseLifecycleController>[0]
		> = {},
	) {
		return new CodexPhaseLifecycleController({
			executionId: "exec-1",
			role: "design",
			commDbPath: dbPath,
			sessionStatePath: statePath,
			mailboxAgentName: "runner-agent",
			watcher,
			shutdownPollIntervalMs: 5,
			now: () => 1_000,
			...overrides,
		});
	}

	it("observes declared parked, cleared active, and DB errors as unknown", () => {
		const lifecycle = controller();
		db.upsertDeclaredState("exec-1", "parked", "handoff", 900, null);
		expect(lifecycle.observe()).toMatchObject({ kind: "parked" });
		db.clearDeclaredState("exec-1");
		expect(lifecycle.observe()).toEqual({ kind: "active" });
		lifecycle.stop();

		const broken = controller(null, {
			db: {
				getRunnerShutdown: () => {
					throw new Error("sqlite unavailable");
				},
			} as never,
		});
		expect(broken.observe()).toEqual({
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

	it("enterHold persists entering before pause confirmation starts mailbox intake", async () => {
		const instructionId = db.insertInstruction("lead", "exec-1", "revise");
		const watcher = new FakeWatcher([
			{
				id: "vendor-1",
				to: "runner-agent",
				content: "revise",
				metadata: { flywheelId: instructionId, execId: "exec-1" },
			},
		]);
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

		expect(watcher.started).toBe(1);
		expect(lifecycle.observe()).toMatchObject({
			kind: "wake",
			message: { id: "vendor-1", content: "revise" },
		});
		expect(db.getUnreadInstructions("exec-1")).toEqual([]);
		expect(JSON.parse(readFileSync(statePath, "utf8")).phaseHold).toMatchObject(
			{
				state: "paused",
				deadlineRemainingMs: 30_000,
				hardDeadlineRemainingMs: 60_000,
			},
		);

		await lifecycle.leaveHold();
		expect(watcher.stopped).toBe(1);
		await lifecycle.enterHold({
			deadlineRemainingMs: 20_000,
			hardDeadlineRemainingMs: 50_000,
		});
		expect(watcher.started).toBe(1);
		await lifecycle.confirmHoldPaused();
		expect(watcher.started).toBe(2);
		await lifecycle.stop();
	});

	it("watcher callback resolves only after durable enqueue and preserves order/dedupe", async () => {
		const watcher = new FakeWatcher();
		const lifecycle = controller(watcher);
		await lifecycle.start();
		await lifecycle.enterHold({
			deadlineRemainingMs: 1,
			hardDeadlineRemainingMs: 2,
		});
		await lifecycle.confirmHoldPaused();

		await watcher.emit({
			id: "v-1",
			to: "runner-agent",
			content: "first",
		});
		expect(db.listRunnerPhaseWakes("exec-1")).toHaveLength(1);
		await watcher.emit({
			id: "v-1",
			to: "runner-agent",
			content: "first",
		});
		await watcher.emit({
			id: "v-2",
			to: "runner-agent",
			content: "second",
		});
		expect(
			db.listRunnerPhaseWakes("exec-1").map((wake) => wake.message_id),
		).toEqual(["v-1", "v-2"]);
		await lifecycle.stop();
	});

	it("queues an instruction envelope even after the active runner listed it", async () => {
		const instructionId = db.insertInstruction("lead", "exec-1", "listed");
		db.markInstructionRead(instructionId);
		const watcher = new FakeWatcher();
		const lifecycle = controller(watcher);
		await lifecycle.start();
		await lifecycle.enterHold({
			deadlineRemainingMs: 1,
			hardDeadlineRemainingMs: 2,
		});
		await lifecycle.confirmHoldPaused();
		await watcher.emit({
			id: "listed-vendor",
			to: "runner-agent",
			content: "listed",
			metadata: { flywheelId: instructionId, execId: "exec-1" },
		});
		expect(db.listRunnerPhaseWakes("exec-1")).toHaveLength(1);
		await lifecycle.stop();
	});

	it("rejects a mailbox envelope addressed to another runner before enqueue", async () => {
		const watcher = new FakeWatcher();
		const lifecycle = controller(watcher);
		await lifecycle.start();
		await lifecycle.enterHold({
			deadlineRemainingMs: 1,
			hardDeadlineRemainingMs: 2,
		});
		await lifecycle.confirmHoldPaused();
		await expect(
			watcher.emit({
				id: "wrong-recipient",
				to: "runner-other",
				content: "no",
			}),
		).rejects.toThrow("recipient mismatch");
		expect(db.listRunnerPhaseWakes("exec-1")).toEqual([]);
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
