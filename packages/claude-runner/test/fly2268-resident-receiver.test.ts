import { describe, expect, it } from "vitest";
import {
	CodexDaemonClient,
	type DaemonTransport,
	GoalRunError,
	parseThreadReadTurns,
	runGoalToTerminal,
} from "../src/codex-daemon-client.js";
import { CodexTurnBarrier } from "../src/codex-turn-barrier.js";

class FakeDaemon implements DaemonTransport {
	private messageHandler: ((frame: unknown) => void) | undefined;
	private closeHandler: ((reason: string) => void) | undefined;
	readonly responders = new Map<
		string,
		(params: unknown, push: (frame: unknown) => void) => unknown
	>();

	send(frame: unknown): void {
		const request = frame as { id?: number; method?: string; params?: unknown };
		if (typeof request.id !== "number" || !request.method) return;
		const result =
			this.responders.get(request.method)?.(request.params, (notification) =>
				this.push(notification),
			) ?? {};
		queueMicrotask(() => this.messageHandler?.({ id: request.id, result }));
	}

	onMessage(handler: (frame: unknown) => void): void {
		this.messageHandler = handler;
	}

	onClose(handler: (reason: string) => void): void {
		this.closeHandler = handler;
	}

	close(): void {
		this.closeHandler?.("closed");
	}

	push(frame: unknown): void {
		this.messageHandler?.(frame);
	}
}

function client(daemon: FakeDaemon) {
	return new CodexDaemonClient({ transport: daemon, logger: () => {} });
}

function goalNotification(status: "active" | "complete") {
	return {
		jsonrpc: "2.0",
		method: "thread/goal/updated",
		params: {
			threadId: "thread-1",
			goal: { objective: "finish", status },
		},
	};
}

function turnNotification(
	method: "turn/started" | "turn/completed",
	turnId = "turn-1",
) {
	return {
		jsonrpc: "2.0",
		method,
		params: {
			threadId: "thread-1",
			turn: {
				id: turnId,
				status: method === "turn/started" ? "inProgress" : "completed",
			},
		},
	};
}

function configureSetup(daemon: FakeDaemon): void {
	daemon.responders.set("thread/goal/get", () => ({ goal: null }));
	daemon.responders.set("thread/goal/set", () => ({}));
}

describe("FLY-2268 durable turn boundary", () => {
	it("strictly parses official and tested legacy thread/read envelopes", () => {
		expect(
			parseThreadReadTurns(
				{
					thread: {
						id: "thread-1",
						turns: [
							{ id: "turn-1", status: "completed" },
							{ id: "turn-2", status: "inProgress" },
						],
					},
				},
				"thread-1",
			),
		).toEqual([
			{ id: "turn-1", status: "completed" },
			{ id: "turn-2", status: "inProgress" },
		]);
		expect(
			parseThreadReadTurns(
				{ turns: [{ id: "legacy-turn", status: "interrupted" }] },
				"thread-1",
			),
		).toEqual([{ id: "legacy-turn", status: "interrupted" }]);
	});

	it.each([
		["wrong thread", { thread: { id: "other", turns: [] } }],
		["missing turns", { thread: { id: "thread-1" } }],
		[
			"unknown status",
			{
				thread: {
					id: "thread-1",
					turns: [{ id: "turn-1", status: "cancelled" }],
				},
			},
		],
	])("rejects %s in a thread/read result", (_label, result) => {
		expect(() => parseThreadReadTurns(result, "thread-1")).toThrow(
			/thread\/read reconciliation failed/,
		);
	});

	it("does not accept a terminal until the response-attributed turn start is durable", async () => {
		const daemon = new FakeDaemon();
		configureSetup(daemon);
		let release!: () => void;
		const persisted = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started = 0;
		daemon.responders.set("turn/start", (_params, push) => {
			push(turnNotification("turn/started"));
			push(goalNotification("complete"));
			return { turn: { id: "turn-1" } };
		});

		let settled = false;
		const run = runGoalToTerminal(client(daemon), {
			threadId: "thread-1",
			objective: "finish",
			turnLifecycle: {
				markTurnStarted: async () => {
					started += 1;
					await persisted;
				},
				markTurnCompleted: async () => {},
			},
		}).then((result) => {
			settled = true;
			return result;
		});

		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(started).toBeGreaterThan(0);
		expect(settled).toBe(false);
		release();
		await expect(run).resolves.toMatchObject({ status: "complete" });
	});

	it("latches a response with no attributable turn id even if started arrives later", async () => {
		const daemon = new FakeDaemon();
		configureSetup(daemon);
		let started = 0;
		daemon.responders.set("turn/start", () => {
			setTimeout(() => daemon.push(turnNotification("turn/started")), 0);
			return {};
		});

		const run = runGoalToTerminal(client(daemon), {
			threadId: "thread-1",
			objective: "finish",
			turnLifecycle: {
				markTurnStarted: async () => {
					started += 1;
				},
				markTurnCompleted: async () => {},
			},
		});

		await expect(run).rejects.toMatchObject({
			name: "GoalRunError",
			kind: "setup_failed",
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(started).toBe(0);
	});

	it("waits for turn completion persistence before returning the terminal", async () => {
		const daemon = new FakeDaemon();
		configureSetup(daemon);
		let release!: () => void;
		const persisted = new Promise<void>((resolve) => {
			release = resolve;
		});
		let completionStarted = false;
		daemon.responders.set("turn/start", (_params, push) => {
			push(turnNotification("turn/started"));
			return { turn: { id: "turn-1" } };
		});
		let firstSleep = true;

		let settled = false;
		const run = runGoalToTerminal(client(daemon), {
			threadId: "thread-1",
			objective: "finish",
			pollIntervalMs: 1,
			sleep: async () => {
				if (!firstSleep) return;
				firstSleep = false;
				daemon.push(turnNotification("turn/completed"));
				daemon.push(goalNotification("complete"));
			},
			turnLifecycle: {
				markTurnStarted: async () => {},
				markTurnCompleted: async () => {
					completionStarted = true;
					await persisted;
				},
			},
		}).then((result) => {
			settled = true;
			return result;
		});

		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(completionStarted).toBe(true);
		expect(settled).toBe(false);
		release();
		await expect(run).resolves.toMatchObject({ status: "complete" });
	});

	it("never claims an unowned started notification outside dispatch", async () => {
		const daemon = new FakeDaemon();
		configureSetup(daemon);
		const started: string[] = [];
		daemon.responders.set("turn/start", (_params, push) => {
			push(turnNotification("turn/started"));
			return { turn: { id: "turn-1" } };
		});
		let emitted = false;

		const result = await runGoalToTerminal(client(daemon), {
			threadId: "thread-1",
			objective: "finish",
			pollIntervalMs: 1,
			sleep: async () => {
				if (emitted) return;
				emitted = true;
				daemon.push(turnNotification("turn/started", "foreign-turn"));
				daemon.push(goalNotification("complete"));
			},
			turnLifecycle: {
				markTurnStarted: async (turnId) => {
					started.push(turnId);
				},
				markTurnCompleted: async () => {},
			},
		});

		expect(result.status).toBe("complete");
		expect(started).not.toContain("foreign-turn");
		expect(started.every((turnId) => turnId === "turn-1")).toBe(true);
	});

	it("lets a turn barrier failure outrank a simultaneous terminal", async () => {
		const daemon = new FakeDaemon();
		configureSetup(daemon);
		daemon.responders.set("turn/start", (_params, push) => {
			push(goalNotification("complete"));
			return { turn: { id: "turn-1" } };
		});

		const run = runGoalToTerminal(client(daemon), {
			threadId: "thread-1",
			objective: "finish",
			turnBarrier: new CodexTurnBarrier({ retryWindowMs: 0 }),
			turnLifecycle: {
				markTurnStarted: async () => {
					throw new Error("commdb unavailable");
				},
				markTurnCompleted: async () => {},
			},
		});

		await expect(run).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof GoalRunError &&
				error.kind === "setup_failed" &&
				error.message.includes("turn barrier failed"),
		);
	});
});
