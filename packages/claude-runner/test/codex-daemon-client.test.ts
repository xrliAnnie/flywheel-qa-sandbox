import { describe, expect, it } from "vitest";
import {
	CodexDaemonClient,
	CodexDaemonError,
	type DaemonTransport,
	GOAL_OBJECTIVE_MAX_CHARS,
	GoalRunError,
	type GoalStatus,
	isTerminalGoalStatus,
	runGoalToTerminal,
} from "../src/codex-daemon-client.js";

// ── FLY-1188 M4 — codex daemon client lifecycle (transport injected) ─────

/**
 * A scriptable fake daemon: the test wires request→response and can push
 * notifications. Mirrors the real ws framing (one JSON object per message).
 */
class FakeDaemon implements DaemonTransport {
	private msgHandler: ((f: unknown) => void) | null = null;
	private closeHandler: ((r: string) => void) | null = null;
	sent: Array<Record<string, unknown>> = [];
	/** method → (params, id) => result | ((push)=>void). */
	responders = new Map<
		string,
		(params: unknown, id: number, push: (n: unknown) => void) => unknown
	>();
	closed = false;

	send(frame: unknown): void {
		const f = frame as {
			id?: number;
			method?: string;
			params?: unknown;
		};
		this.sent.push(f as Record<string, unknown>);
		if (typeof f.id === "number" && f.method) {
			const r = this.responders.get(f.method);
			const result = r ? r(f.params, f.id, (n) => this.push(n)) : {};
			// reply async (next tick) like a real socket
			queueMicrotask(() => this.msgHandler?.({ id: f.id, result }));
		}
	}
	onMessage(h: (f: unknown) => void): void {
		this.msgHandler = h;
	}
	onClose(h: (r: string) => void): void {
		this.closeHandler = h;
	}
	close(): void {
		this.closed = true;
		this.closeHandler?.("closed by test");
	}
	push(notification: unknown): void {
		this.msgHandler?.(notification);
	}
	triggerClose(reason = "socket hang up"): void {
		this.closeHandler?.(reason);
	}
	sentMethods(): string[] {
		return this.sent.map((s) => s.method as string).filter(Boolean);
	}
}

function makeClient(daemon: FakeDaemon, opts = {}) {
	return new CodexDaemonClient({
		transport: daemon,
		logger: () => {},
		...opts,
	});
}

describe("isTerminalGoalStatus", () => {
	it("complete/blocked/usageLimited/budgetLimited are terminal; active/paused are not", () => {
		for (const s of [
			"complete",
			"blocked",
			"usageLimited",
			"budgetLimited",
		] as GoalStatus[]) {
			expect(isTerminalGoalStatus(s)).toBe(true);
		}
		expect(isTerminalGoalStatus("active")).toBe(false);
		expect(isTerminalGoalStatus("paused")).toBe(false);
	});
});

describe("CodexDaemonClient — handshake + protocol", () => {
	it("initialize sends initialize THEN the initialized notification", async () => {
		const d = new FakeDaemon();
		d.responders.set("initialize", () => ({ userAgent: "codex/0.144" }));
		const c = makeClient(d);
		await c.initialize();
		const methods = d.sentMethods();
		expect(methods).toEqual(["initialize", "initialized"]);
	});

	it("thread/start extracts the thread id from {thread:{id}}", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/start", () => ({ thread: { id: "th-1" } }));
		const c = makeClient(d);
		expect(await c.startThread({ cwd: "/w", sandbox: "workspace-write" })).toBe(
			"th-1",
		);
		const start = d.sent.find((s) => s.method === "thread/start");
		expect((start?.params as { sandbox?: string }).sandbox).toBe(
			"workspace-write",
		);
	});

	it("thread/resume returns the resumed id (survives daemon restart — V2)", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/resume", (p) => ({
			thread: { id: (p as { threadId: string }).threadId },
		}));
		const c = makeClient(d);
		expect(await c.resumeThread("th-42")).toBe("th-42");
	});

	it("goal/set forwards objective + budget + active status", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/set", () => ({}));
		const c = makeClient(d);
		await c.setGoal({ threadId: "t", objective: "do X", tokenBudget: 200000 });
		const g = d.sent.find((s) => s.method === "thread/goal/set");
		expect(g?.params).toMatchObject({
			threadId: "t",
			objective: "do X",
			status: "active",
			tokenBudget: 200000,
		});
	});

	it("FLY-1236: setGoal fails closed on an oversized objective — no thread/goal/set frame reaches the daemon", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/set", () => ({}));
		const c = makeClient(d);
		const oversized = "x".repeat(GOAL_OBJECTIVE_MAX_CHARS + 1);
		await expect(
			c.setGoal({ threadId: "t", objective: oversized }),
		).rejects.toMatchObject({ kind: "setup_failed" });
		// the guard fires BEFORE the RPC — the daemon never sees an oversized frame
		expect(d.sent.find((s) => s.method === "thread/goal/set")).toBeUndefined();
	});

	it("FLY-1236: setGoal at EXACTLY the max length still sends the frame (boundary, guards against >=)", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/set", () => ({}));
		const c = makeClient(d);
		const exactly = "x".repeat(GOAL_OBJECTIVE_MAX_CHARS);
		await c.setGoal({ threadId: "t", objective: exactly });
		expect(d.sent.find((s) => s.method === "thread/goal/set")).toBeDefined();
	});

	it("an rpc error rejects with CodexDaemonError(rpc_error)", async () => {
		const d = new FakeDaemon();
		// override send to reply with an error frame
		const orig = d.send.bind(d);
		d.send = (frame) => {
			const f = frame as { id?: number; method?: string };
			d.sent.push(f as Record<string, unknown>);
			if (f.method === "thread/goal/get") {
				queueMicrotask(() =>
					d.push({ id: f.id, error: { code: -1, message: "boom" } }),
				);
			} else {
				orig(frame);
			}
		};
		const c = makeClient(d);
		await expect(c.getGoal("t")).rejects.toBeInstanceOf(CodexDaemonError);
	});

	it("a daemon close rejects all in-flight requests", async () => {
		const d = new FakeDaemon();
		// never respond → request stays pending until close
		d.send = (frame) => {
			d.sent.push(frame as Record<string, unknown>);
		};
		const c = makeClient(d);
		const p = c.getGoal("t");
		d.triggerClose("socket hang up");
		await expect(p).rejects.toMatchObject({ kind: "closed" });
	});

	it("requests after close reject immediately", async () => {
		const d = new FakeDaemon();
		const c = makeClient(d);
		d.triggerClose("gone");
		await expect(c.getGoal("t")).rejects.toMatchObject({ kind: "closed" });
	});
});

describe("runGoalToTerminal", () => {
	const noSleep = () => Promise.resolve();

	it("resolves complete when a goal notification reports status=complete (V1 shape)", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/set", () => ({}));
		d.responders.set("turn/start", (_p, _id, push) => {
			// emulate the daemon: a few active goal updates then complete
			push({
				method: "goal/updated",
				params: {
					threadId: "t",
					turnId: "turn-a",
					goal: { status: "active", tokensUsed: 100 },
				},
			});
			push({
				method: "goal/updated",
				params: {
					threadId: "t",
					turnId: "turn-b",
					goal: { status: "active", tokensUsed: 500 },
				},
			});
			push({
				method: "goal/updated",
				params: {
					threadId: "t",
					turnId: "turn-b",
					goal: { status: "complete", tokensUsed: 900 },
				},
			});
			return {};
		});
		d.responders.set("thread/goal/get", () => ({
			goal: { status: "complete", tokensUsed: 900 },
		}));
		const c = makeClient(d);
		const res = await runGoalToTerminal(c, {
			threadId: "t",
			objective: "make files",
			sleep: noSleep,
			now: () => 0,
		});
		expect(res.succeeded).toBe(true);
		expect(res.status).toBe("complete");
		expect(res.tokensUsed).toBe(900);
		expect(res.turns).toBe(2); // turn-a + turn-b
		// Restart-safe preflight runs first; goal is then set active BEFORE kick.
		expect(d.sentMethods().slice(0, 3)).toEqual([
			"thread/goal/get",
			"thread/goal/set",
			"turn/start",
		]);
	});

	it("FLY-1236: the full kick (even > the goal cap) rides turn/start verbatim; thread/goal/set gets only the short objective", async () => {
		// Locks the final wire hop: the working body must reach the daemon via the
		// kick turn (unbounded by the goal cap), NOT the objective — and it must NOT
		// silently fall back to the "Begin working…" stub (the instruction-empty bug).
		const d = new FakeDaemon();
		d.responders.set("thread/goal/set", () => ({}));
		d.responders.set("turn/start", (_p, _id, push) => {
			push({
				method: "goal/updated",
				params: {
					threadId: "t",
					turnId: "turn-a",
					goal: { status: "complete", tokensUsed: 10 },
				},
			});
			return {};
		});
		d.responders.set("thread/goal/get", () => ({
			goal: { status: "complete", tokensUsed: 10 },
		}));
		const c = makeClient(d);
		// A representative kick that is itself well OVER the goal's 4000-char cap —
		// which is exactly why it must ride the kick turn, not the objective.
		const bigKick = `SYS\n\n---\n\n${"z".repeat(GOAL_OBJECTIVE_MAX_CHARS + 2000)}`;
		const shortObjective = "[FLY-1225] pointer";
		const res = await runGoalToTerminal(c, {
			threadId: "t",
			objective: shortObjective,
			kickText: bigKick,
			sleep: noSleep,
			now: () => 0,
		});
		expect(res.succeeded).toBe(true);
		const goalSet = d.sent.find((s) => s.method === "thread/goal/set");
		const turnStart = d.sent.find((s) => s.method === "turn/start");
		expect((goalSet?.params as { objective: string }).objective).toBe(
			shortObjective,
		);
		// the full kick delivered byte-for-byte via turn/start — not the stub
		expect((turnStart?.params as { input: unknown }).input).toEqual([
			{ type: "text", text: bigKick },
		]);
	});

	it("resolves (does NOT reject) on a blocked terminal status — caller decides", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/set", () => ({}));
		d.responders.set("turn/start", (_p, _id, push) => {
			push({
				method: "goal/updated",
				params: {
					threadId: "t",
					turnId: "x",
					goal: { status: "blocked", tokensUsed: 50 },
				},
			});
			return {};
		});
		d.responders.set("thread/goal/get", () => ({
			goal: { status: "blocked", tokensUsed: 50 },
		}));
		const c = makeClient(d);
		const res = await runGoalToTerminal(c, {
			threadId: "t",
			objective: "x",
			sleep: noSleep,
			now: () => 0,
		});
		expect(res.status).toBe("blocked");
		expect(res.succeeded).toBe(false);
	});

	it("FLY-1257: a blocked notification while a gate is open holds, then reactivates with objective + budget and completes", async () => {
		const d = new FakeDaemon();
		let starts = 0;
		d.responders.set("thread/goal/get", () => ({ goal: null }));
		d.responders.set("thread/goal/set", () => ({}));
		d.responders.set("turn/start", (_p, _id, push) => {
			starts += 1;
			push({
				method: "goal/updated",
				params: {
					threadId: "t",
					goal: {
						status: starts === 1 ? "blocked" : "complete",
						objective: "ship FLY-1257",
						tokensUsed: starts === 1 ? 50 : 75,
					},
				},
			});
			return {};
		});
		let waiting = true;
		let latched = false;
		const latchWrites: boolean[] = [];
		const res = await runGoalToTerminal(makeClient(d), {
			threadId: "t",
			objective: "ship FLY-1257",
			tokenBudget: 123_456,
			kickText: "initial task body",
			isWaiting: () => waiting,
			readGateHoldLatch: () => latched,
			writeGateHoldLatch: (held) => {
				latched = held;
				latchWrites.push(held);
			},
			sleep: async () => {
				waiting = false; // Lead answers after the blocked notification.
			},
			now: () => 0,
		});

		expect(res.status).toBe("complete");
		expect(latchWrites).toEqual([true, false]);
		const sets = d.sent.filter((frame) => frame.method === "thread/goal/set");
		expect(sets).toHaveLength(2);
		expect(sets[1]?.params).toMatchObject({
			threadId: "t",
			objective: "ship FLY-1257",
			tokenBudget: 123_456,
			status: "active",
		});
		const turns = d.sent.filter((frame) => frame.method === "turn/start");
		expect(turns).toHaveLength(2);
		expect(JSON.stringify(turns[1]?.params)).toContain("gate result is ready");
	});

	it("FLY-1257: the poll fallback uses the same blocked/waiting classifier without a duplicate wake", async () => {
		const d = new FakeDaemon();
		let setCalls = 0;
		let getCalls = 0;
		let starts = 0;
		d.responders.set("thread/goal/set", () => {
			setCalls += 1;
			return {};
		});
		d.responders.set("turn/start", () => {
			starts += 1;
			return {};
		});
		d.responders.set("thread/goal/get", () => {
			getCalls += 1;
			if (setCalls === 0) return { goal: null }; // restart preflight
			if (setCalls === 1) {
				return {
					goal: {
						status: "blocked",
						objective: "poll fixture",
						tokensUsed: 10,
					},
				};
			}
			return {
				goal: {
					status: "complete",
					objective: "poll fixture",
					tokensUsed: 20,
				},
			};
		});
		let waiting = true;
		let sleeps = 0;
		let latched = false;
		const writes: boolean[] = [];
		const res = await runGoalToTerminal(makeClient(d), {
			threadId: "t",
			objective: "poll fixture",
			tokenBudget: 900,
			isWaiting: () => waiting,
			readGateHoldLatch: () => latched,
			writeGateHoldLatch: (held) => {
				latched = held;
				writes.push(held);
			},
			sleep: async () => {
				sleeps += 1;
				if (sleeps >= 2) waiting = false;
			},
			now: () => 0,
		});
		expect(res.status).toBe("complete");
		expect(getCalls).toBeGreaterThanOrEqual(3);
		expect(writes).toEqual([true, false]);
		expect(setCalls).toBe(2);
		expect(starts).toBe(2);
	});

	it("FLY-1257: restart preflight holds an already-blocked own goal and wakes it only after the marker resolves", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/get", () => ({
			goal: {
				status: "blocked",
				objective: "restart fixture",
				tokensUsed: 40,
			},
		}));
		d.responders.set("thread/goal/set", () => ({}));
		d.responders.set("turn/start", (_p, _id, push) => {
			push({
				method: "goal/updated",
				params: {
					threadId: "t",
					goal: { status: "complete", objective: "restart fixture" },
				},
			});
			return {};
		});
		let waiting = true;
		let latched = true; // persisted by the pre-crash adapter
		const writes: boolean[] = [];
		const res = await runGoalToTerminal(makeClient(d), {
			threadId: "t",
			objective: "restart fixture",
			tokenBudget: 777,
			isWaiting: () => waiting,
			readGateHoldLatch: () => latched,
			writeGateHoldLatch: (held) => {
				latched = held;
				writes.push(held);
			},
			sleep: async () => {
				waiting = false;
			},
			now: () => 0,
		});
		expect(res.status).toBe("complete");
		expect(d.sentMethods()[0]).toBe("thread/goal/get");
		expect(d.sentMethods().filter((m) => m === "thread/goal/set")).toHaveLength(1);
		expect(writes).toEqual([false]);
		const wake = d.sent.find((frame) => frame.method === "turn/start");
		expect(JSON.stringify(wake?.params)).toContain("gate result is ready");
	});

	it("FLY-1257: an unlatched blocked preflight with no open gate remains a legitimate terminal", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/get", () => ({
			goal: {
				status: "blocked",
				objective: "legitimate block",
				tokensUsed: 88,
			},
		}));
		const res = await runGoalToTerminal(makeClient(d), {
			threadId: "t",
			objective: "legitimate block",
			isWaiting: () => false,
			readGateHoldLatch: () => false,
			sleep: noSleep,
			now: () => 0,
		});
		expect(res).toMatchObject({
			status: "blocked",
			tokensUsed: 88,
			succeeded: false,
		});
		expect(d.sentMethods()).toEqual(["thread/goal/get"]);
	});

	it("FLY-1257: a failed wake kick never clears the durable gate-hold latch", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/get", () => ({
			goal: { status: "blocked", objective: "kick failure fixture" },
		}));
		d.responders.set("thread/goal/set", () => ({}));
		const originalSend = d.send.bind(d);
		d.send = (frame) => {
			const f = frame as { id?: number; method?: string };
			if (f.method === "turn/start") {
				d.sent.push(f as Record<string, unknown>);
				queueMicrotask(() =>
					d.push({ id: f.id, error: { code: -1, message: "kick rejected" } }),
				);
				return;
			}
			originalSend(frame);
		};
		let latched = true;
		const writes: boolean[] = [];
		await expect(
			runGoalToTerminal(makeClient(d), {
				threadId: "t",
				objective: "kick failure fixture",
				tokenBudget: 321,
				isWaiting: () => false,
				readGateHoldLatch: () => latched,
				writeGateHoldLatch: (held) => {
					latched = held;
					writes.push(held);
				},
				now: () => 0,
			}),
		).rejects.toMatchObject({ kind: "setup_failed" });
		expect(latched).toBe(true);
		expect(writes).not.toContain(false);
		expect(d.sentMethods()[0]).toBe("thread/goal/get");
	});

	it("FLY-1257: latch persistence failure stays fail-closed even if the wake already streamed complete", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/get", () => ({
			goal: { status: "blocked", objective: "latch write fixture" },
		}));
		d.responders.set("thread/goal/set", () => ({}));
		d.responders.set("turn/start", (_p, _id, push) => {
			push({
				method: "goal/updated",
				params: {
					threadId: "t",
					goal: { status: "complete", objective: "latch write fixture" },
				},
			});
			return {};
		});
		let latched = true;
		await expect(
			runGoalToTerminal(makeClient(d), {
				threadId: "t",
				objective: "latch write fixture",
				isWaiting: () => false,
				readGateHoldLatch: () => latched,
				writeGateHoldLatch: (held) => {
					if (!held) throw new Error("disk full");
					latched = held;
				},
				now: () => 0,
			}),
		).rejects.toMatchObject({
			kind: "setup_failed",
			message: expect.stringContaining("gate-hold latch write failed"),
		});
		expect(latched).toBe(true);
	});

	it("FLY-1257: FLYWHEEL_CODEX_GATE_WAIT=0 restores the legacy blocked terminal", async () => {
		const prior = process.env.FLYWHEEL_CODEX_GATE_WAIT;
		process.env.FLYWHEEL_CODEX_GATE_WAIT = "0";
		try {
			const d = new FakeDaemon();
			d.responders.set("thread/goal/set", () => ({}));
			d.responders.set("turn/start", (_p, _id, push) => {
				push({
					method: "goal/updated",
					params: { threadId: "t", goal: { status: "blocked" } },
				});
				return {};
			});
			const writes: boolean[] = [];
			const res = await runGoalToTerminal(makeClient(d), {
				threadId: "t",
				objective: "legacy",
				isWaiting: () => true,
				readGateHoldLatch: () => true,
				writeGateHoldLatch: (held) => writes.push(held),
				sleep: noSleep,
				now: () => 0,
			});
			expect(res.status).toBe("blocked");
			expect(writes).toEqual([]);
			expect(d.sentMethods()[0]).toBe("thread/goal/set");
		} finally {
			if (prior === undefined) delete process.env.FLYWHEEL_CODEX_GATE_WAIT;
			else process.env.FLYWHEEL_CODEX_GATE_WAIT = prior;
		}
	});

	it("poll fallback catches a terminal status missed by the notification stream", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/set", () => ({}));
		d.responders.set("turn/start", () => ({})); // NO notifications pushed
		let gets = 0;
		d.responders.set("thread/goal/get", () => {
			gets += 1;
			// first poll still active, second poll complete
			return {
				goal: {
					status: gets >= 2 ? "complete" : "active",
					tokensUsed: 1000,
				},
			};
		});
		let t = 0;
		const tick = () => {
			t += 1000;
			return t;
		};
		const c = makeClient(d);
		const res = await runGoalToTerminal(c, {
			threadId: "t",
			objective: "x",
			sleep: noSleep,
			now: tick,
			pollIntervalMs: 1,
			overallTimeoutMs: 100000,
		});
		expect(res.status).toBe("complete");
		expect(gets).toBeGreaterThanOrEqual(2);
	});

	it("streams notifications + goal updates to the caller's events", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/set", () => ({}));
		d.responders.set("turn/start", (_p, _id, push) => {
			push({ method: "item/started", params: {} });
			push({
				method: "goal/updated",
				params: { turnId: "z", goal: { status: "complete", tokensUsed: 10 } },
			});
			return {};
		});
		d.responders.set("thread/goal/get", () => ({
			goal: { status: "complete" },
		}));
		const notifs: string[] = [];
		const goals: GoalStatus[] = [];
		const c = makeClient(d);
		await runGoalToTerminal(
			c,
			{ threadId: "t", objective: "x", sleep: noSleep, now: () => 0 },
			{
				onNotification: (m) => notifs.push(m),
				onGoalUpdate: (n) => {
					if (n.goal?.status) goals.push(n.goal.status);
				},
			},
		);
		expect(notifs).toContain("item/started");
		expect(goals).toContain("complete");
	});
});

// ── R19 findings — regression coverage ──────────────────────────────────

describe("runGoalToTerminal — R19 thread isolation + framing", () => {
	const noSleep = () => Promise.resolve();

	it("HIGH-1: a goal complete for ANOTHER thread does NOT terminate our run", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/set", () => ({}));
		d.responders.set("turn/start", (_p, _id, push) => {
			// stray complete for a DIFFERENT thread — must be ignored
			push({
				method: "goal/updated",
				params: {
					threadId: "other-thread",
					goal: { status: "complete", tokensUsed: 999 },
				},
			});
			// our thread only ever goes active in the stream…
			push({
				method: "goal/updated",
				params: { threadId: "t", goal: { status: "active", tokensUsed: 10 } },
			});
			return {};
		});
		let gets = 0;
		d.responders.set("thread/goal/get", () => {
			gets += 1;
			return { goal: { status: gets >= 2 ? "complete" : "active" } };
		});
		let clock = 0;
		const c = makeClient(d);
		const res = await runGoalToTerminal(c, {
			threadId: "t",
			objective: "x",
			sleep: noSleep,
			now: () => {
				clock += 1000;
				return clock;
			},
			pollIntervalMs: 1,
			overallTimeoutMs: 100000,
		});
		// terminated via OUR thread's poll, not the stray notification
		expect(res.status).toBe("complete");
		expect(gets).toBeGreaterThanOrEqual(2);
	});

	it("HIGH-1: turn count ignores turns for other threads", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/set", () => ({}));
		d.responders.set("turn/start", (_p, _id, push) => {
			push({
				method: "turn/started",
				params: { threadId: "t", turnId: "mine" },
			});
			push({
				method: "turn/started",
				params: { threadId: "other", turnId: "theirs" },
			});
			push({
				method: "goal/updated",
				params: { threadId: "t", goal: { status: "complete" } },
			});
			return {};
		});
		d.responders.set("thread/goal/get", () => ({
			goal: { status: "complete" },
		}));
		const c = makeClient(d);
		const res = await runGoalToTerminal(c, {
			threadId: "t",
			objective: "x",
			sleep: noSleep,
			now: () => 0,
		});
		expect(res.turns).toBe(1); // only "mine"
	});

	it("MEDIUM: turn count accepts the nested turn.id shape", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/set", () => ({}));
		d.responders.set("turn/start", (_p, _id, push) => {
			push({
				method: "turn/started",
				params: { threadId: "t", turn: { id: "nested-1" } },
			});
			push({
				method: "goal/updated",
				params: {
					threadId: "t",
					turn: { id: "nested-2" },
					goal: { status: "complete" },
				},
			});
			return {};
		});
		d.responders.set("thread/goal/get", () => ({
			goal: { status: "complete" },
		}));
		const c = makeClient(d);
		const res = await runGoalToTerminal(c, {
			threadId: "t",
			objective: "x",
			sleep: noSleep,
			now: () => 0,
		});
		expect(res.turns).toBe(2);
	});
});

describe("CodexDaemonClient — R19 framing + cleanup", () => {
	it("HIGH-2: a server request that reuses a pending id is NOT resolved as our response", async () => {
		const d = new FakeDaemon();
		// swallow the request; then push a same-id SERVER REQUEST (has method)
		d.send = (frame) => {
			const f = frame as { id?: number; method?: string };
			d.sent.push(f as Record<string, unknown>);
			if (f.method === "thread/goal/get") {
				queueMicrotask(() =>
					d.push({
						id: f.id,
						method: "applyPatchApproval/request",
						params: {},
					}),
				);
				// the REAL response arrives after
				queueMicrotask(() =>
					queueMicrotask(() =>
						d.push({ id: f.id, result: { goal: { status: "active" } } }),
					),
				);
			}
		};
		const c = makeClient(d);
		const goal = await c.getGoal("t");
		// resolved by the RESULT frame, not the same-id server request
		expect(goal?.status).toBe("active");
	});

	it("R20 HIGH-2: a server-initiated request gets a bounded method-not-found response", async () => {
		const d = new FakeDaemon();
		makeClient(d);
		// the daemon pushes a REQUEST (id + method) this client cannot serve
		d.push({ id: 77, method: "someServer/request", params: {} });
		await Promise.resolve();
		const reply = d.sent.find(
			(m) => (m as { id?: number }).id === 77 && "error" in m,
		);
		expect(reply).toBeDefined();
		expect((reply as { error: { code: number } }).error.code).toBe(-32601);
	});

	it("MEDIUM: a synchronous send failure rejects and leaks no pending entry", async () => {
		const d = new FakeDaemon();
		d.send = () => {
			throw new Error("socket write failed");
		};
		const c = makeClient(d);
		await expect(c.getGoal("t")).rejects.toBeInstanceOf(CodexDaemonError);
		// a subsequent request still behaves (no wedged state) — it also fails
		// closed the same way, proving the client did not hang
		await expect(c.getGoal("t")).rejects.toBeInstanceOf(CodexDaemonError);
	});

	it("MEDIUM: client.close() rejects in-flight requests before transport close", async () => {
		const d = new FakeDaemon();
		d.send = (frame) => {
			d.sent.push(frame as Record<string, unknown>);
		}; // never reply
		const c = makeClient(d);
		const p = c.getGoal("t");
		c.close();
		await expect(p).rejects.toMatchObject({ kind: "closed" });
		expect(d.closed).toBe(true);
	});
});

// ── R20 findings — timeout/transport-death REJECT + server-request reply ──

describe("runGoalToTerminal — R20 fail-close semantics", () => {
	const noSleep = () => Promise.resolve();

	it("HIGH-1: overall timeout REJECTS with GoalRunError(timeout), not a stale active", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/set", () => ({}));
		d.responders.set("turn/start", () => ({})); // no terminal ever
		d.responders.set("thread/goal/get", () => ({ goal: { status: "active" } }));
		let clock = 0;
		const c = makeClient(d);
		await expect(
			runGoalToTerminal(c, {
				threadId: "t",
				objective: "x",
				sleep: noSleep,
				now: () => {
					clock += 5000;
					return clock;
				},
				pollIntervalMs: 1,
				overallTimeoutMs: 10000,
			}),
		).rejects.toMatchObject({ kind: "timeout" });
	});

	// ── FLY-1188 MED-7 (Codex full-PR review): the overall budget is the ACTIVE
	// cap by default; the larger waiting cap applies ONLY while a gate is open. ──
	it("MED-7: a never-waiting run is capped at the ACTIVE budget, not the waiting ceiling", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/set", () => ({}));
		d.responders.set("turn/start", () => ({}));
		d.responders.set("thread/goal/get", () => ({ goal: { status: "active" } }));
		let clock = 0;
		const c = makeClient(d);
		await expect(
			runGoalToTerminal(c, {
				threadId: "t",
				objective: "x",
				sleep: noSleep,
				now: () => {
					clock += 5000;
					return clock;
				},
				pollIntervalMs: 1,
				overallTimeoutMs: 10000, // active cap
				waitingTimeoutMs: 10_000_000, // huge waiting ceiling…
				isWaiting: () => false, // …but never waiting → the active cap wins
			}),
		).rejects.toMatchObject({ kind: "timeout" });
	});

	it("MED-7 R2: a past `startedAt` anchors the ceiling — a restart cannot re-arm the budget", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/set", () => ({}));
		d.responders.set("turn/start", () => ({}));
		d.responders.set("thread/goal/get", () => ({ goal: { status: "active" } }));
		let clock = 100_000; // "now"
		const c = makeClient(d);
		await expect(
			runGoalToTerminal(c, {
				threadId: "t",
				objective: "x",
				sleep: noSleep,
				now: () => {
					clock += 1000;
					return clock;
				},
				pollIntervalMs: 1,
				overallTimeoutMs: 10_000,
				// The RUN started 60s ago — well past the 10s active cap. Anchoring to
				// it (instead of this call's now()) means the restart gets NO fresh
				// budget: the deadline is already blown.
				startedAt: 40_000,
				isWaiting: () => false,
			}),
		).rejects.toMatchObject({ kind: "timeout" });
	});

	it("MED-7 R3: a carried minDeadlineMs floor survives a transport restart (no instant timeout after a gate extension)", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/set", () => ({}));
		d.responders.set("turn/start", () => ({}));
		let gets = 0;
		d.responders.set("thread/goal/get", () => {
			gets += 1;
			return { goal: { status: gets >= 2 ? "complete" : "active" } };
		});
		let clock = 60_000; // "now" is well past startedAt + activeCap
		const c = makeClient(d);
		const res = await runGoalToTerminal(c, {
			threadId: "t",
			objective: "x",
			sleep: noSleep,
			now: () => {
				clock += 1000;
				return clock;
			},
			pollIntervalMs: 1,
			overallTimeoutMs: 10_000, // active cap → startedAt+active = 10k < now(60k)
			startedAt: 0, // the run started long ago (a prior, extended call)
			waitingTimeoutMs: 10_000_000,
			isWaiting: () => false, // the gate already closed
			// A PRIOR call extended the deadline to 100k while waiting on the gate;
			// without carrying it, this restart would rebuild deadline=10k and time
			// out instantly. The floor keeps the run alive.
			minDeadlineMs: 100_000,
		});
		expect(res.status).toBe("complete");
	});

	it("MED-7: while a gate is OPEN the deadline extends past the active cap (up to the waiting ceiling)", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/set", () => ({}));
		d.responders.set("turn/start", () => ({}));
		let gets = 0;
		d.responders.set("thread/goal/get", () => {
			gets += 1;
			// stays active well past the 10s ACTIVE cap; completes only much later
			return { goal: { status: gets >= 6 ? "complete" : "active" } };
		});
		let clock = 0;
		const c = makeClient(d);
		const res = await runGoalToTerminal(c, {
			threadId: "t",
			objective: "x",
			sleep: noSleep,
			now: () => {
				clock += 5000; // wall-time ≫ the 10s active cap by poll 6
				return clock;
			},
			pollIntervalMs: 1,
			overallTimeoutMs: 10000, // would fire long before poll 6 WITHOUT extension
			waitingTimeoutMs: 10_000_000,
			isWaiting: () => true, // a gate is open → extend past the active cap
		});
		expect(res.status).toBe("complete");
		expect(gets).toBeGreaterThanOrEqual(6);
	});

	it("MED-7: the extended deadline does NOT retract when the gate closes mid-run (no reset-kill)", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/set", () => ({}));
		d.responders.set("turn/start", () => ({}));
		let gets = 0;
		d.responders.set("thread/goal/get", () => {
			gets += 1;
			return { goal: { status: gets >= 5 ? "complete" : "active" } };
		});
		let clock = 0;
		const c = makeClient(d);
		const res = await runGoalToTerminal(c, {
			threadId: "t",
			objective: "x",
			sleep: noSleep,
			now: () => {
				clock += 1000;
				return clock;
			},
			pollIntervalMs: 1,
			overallTimeoutMs: 10000,
			waitingTimeoutMs: 10_000_000,
			// Gate open through the first 3 polls (wall-clock passes the 10s active
			// cap), then CLOSES. A deadline that snapped back to the active cap would
			// be < now → instant timeout; the monotonic deadline keeps the budget so
			// the goal completes. Gated on the poll count (stable) because isWaiting
			// is now consulted on every budget read.
			isWaiting: () => gets < 4,
		});
		expect(res.status).toBe("complete");
		expect(gets).toBe(5);
	});

	it("FLY-1253: continues one goal on the same thread after a bound review wait closes", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/set", () => ({}));
		d.responders.set("turn/start", () => ({}));
		let gets = 0;
		d.responders.set("thread/goal/get", () => {
			gets += 1;
			return { goal: { status: gets >= 5 ? "complete" : "active" } };
		});
		let clock = 0;
		const deadlines: number[] = [];
		const c = makeClient(d);
		const result = await runGoalToTerminal(c, {
			threadId: "thread-bound-review",
			objective: "finish the original goal",
			sleep: noSleep,
			now: () => {
				clock += 1_000;
				return clock;
			},
			pollIntervalMs: 1,
			overallTimeoutMs: 10_000,
			waitingTimeoutMs: 1_000_000,
			isWaiting: () => gets < 3,
			onDeadlineExtended: (deadline) => deadlines.push(deadline),
		});

		expect(result.status).toBe("complete");
		expect(clock).toBeGreaterThan(10_000);
		expect(
			d.sent.filter((frame) => frame.method === "thread/goal/set"),
		).toHaveLength(1);
		expect(
			d.sent.filter((frame) => frame.method === "turn/start"),
		).toHaveLength(1);
		const goalGets = d.sent.filter(
			(frame) => frame.method === "thread/goal/get",
		);
		expect(goalGets.length).toBeGreaterThan(0);
		expect(
			goalGets.every(
				(frame) =>
					(frame.params as { threadId?: string }).threadId ===
					"thread-bound-review",
			),
		).toBe(true);
		expect(deadlines.length).toBeGreaterThan(0);
		expect(deadlines).toEqual([...deadlines].sort((a, b) => a - b));
	});

	it("HIGH-1: a transport close mid-run REJECTS (never returns a stale status)", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/set", () => ({}));
		d.responders.set("turn/start", () => ({}));
		let polls = 0;
		d.responders.set("thread/goal/get", () => {
			polls += 1;
			if (polls >= 2) d.triggerClose("socket hang up"); // die mid-run
			return { goal: { status: "active" } };
		});
		let clock = 0;
		const c = makeClient(d);
		await expect(
			runGoalToTerminal(c, {
				threadId: "t",
				objective: "x",
				sleep: noSleep,
				now: () => {
					clock += 100;
					return clock;
				},
				pollIntervalMs: 1,
				overallTimeoutMs: 100000,
			}),
		).rejects.toBeInstanceOf(GoalRunError);
	});

	it("MEDIUM: an unscoped goal complete (no threadId) does NOT terminate the run", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/set", () => ({}));
		d.responders.set("turn/start", (_p, _id, push) => {
			// NO threadId — diagnostics only, must not be authority
			push({
				method: "goal/updated",
				params: { goal: { status: "complete", tokensUsed: 5 } },
			});
			return {};
		});
		let gets = 0;
		d.responders.set("thread/goal/get", () => {
			gets += 1;
			return { goal: { status: gets >= 3 ? "complete" : "active" } };
		});
		let clock = 0;
		const c = makeClient(d);
		const res = await runGoalToTerminal(c, {
			threadId: "t",
			objective: "x",
			sleep: noSleep,
			now: () => {
				clock += 1000;
				return clock;
			},
			pollIntervalMs: 1,
			overallTimeoutMs: 100000,
		});
		// terminated only when OUR thread's poll reported complete
		expect(res.status).toBe("complete");
		expect(gets).toBeGreaterThanOrEqual(3);
	});
});

// ── R21 findings — hard ceiling + terminal preservation + cleanup ────────

describe("runGoalToTerminal — R21 fail-close hardening", () => {
	const noSleep = () => Promise.resolve();

	it("HIGH-1: a genuine setGoal rpc failure fails as setup_failed, NOT transport_closed", async () => {
		const d = new FakeDaemon();
		const orig = d.send.bind(d);
		d.send = (frame) => {
			const f = frame as { id?: number; method?: string };
			d.sent.push(f as Record<string, unknown>);
			if (f.method === "thread/goal/set") {
				// daemon rejects the goal — transport stays OPEN, deadline unmet
				queueMicrotask(() =>
					d.push({ id: f.id, error: { code: -1, message: "nope" } }),
				);
			} else {
				orig(frame);
			}
		};
		const c = makeClient(d);
		await expect(
			runGoalToTerminal(c, {
				threadId: "t",
				objective: "x",
				sleep: noSleep,
				now: () => 0,
			}),
		).rejects.toMatchObject({ kind: "setup_failed" });
		// a genuine rpc failure must not have marked the transport closed
		expect(c.isClosed()).toBe(false);
	});

	it("HIGH-2: a terminal seen during the sleep is preserved even if the transport then closes", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/set", () => ({}));
		d.responders.set("turn/start", () => ({})); // no notifications from the turn
		// getGoal must NOT be what decides this run — if it were reached after
		// the close it would clobber the real terminal with transport_closed.
		d.responders.set("thread/goal/get", () => ({ goal: { status: "active" } }));
		const sleepThenTerminalAndClose = () => {
			// the terminal notification lands during the sleep, then the socket
			// dies in the same tick
			d.push({
				method: "goal/updated",
				params: {
					threadId: "t",
					turnId: "final",
					goal: { status: "complete", tokensUsed: 42 },
				},
			});
			d.triggerClose("socket hang up");
			return Promise.resolve();
		};
		const c = makeClient(d);
		const res = await runGoalToTerminal(c, {
			threadId: "t",
			objective: "x",
			sleep: sleepThenTerminalAndClose,
			now: () => 0,
			pollIntervalMs: 1,
			overallTimeoutMs: 100000,
		});
		expect(res.status).toBe("complete");
		expect(res.succeeded).toBe(true);
		expect(res.tokensUsed).toBe(42);
	});

	it("MEDIUM: after a run finishes, late notifications no longer reach the caller's events", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/set", () => ({}));
		d.responders.set("turn/start", (_p, _id, push) => {
			push({
				method: "goal/updated",
				params: { threadId: "t", goal: { status: "complete", tokensUsed: 7 } },
			});
			return {};
		});
		d.responders.set("thread/goal/get", () => ({
			goal: { status: "complete" },
		}));
		let goalCbCount = 0;
		const c = makeClient(d);
		await runGoalToTerminal(
			c,
			{ threadId: "t", objective: "x", sleep: noSleep, now: () => 0 },
			{
				onGoalUpdate: () => {
					goalCbCount += 1;
				},
			},
		);
		const countAtFinish = goalCbCount;
		// a stray post-run notification must NOT invoke the finished run's closure
		d.push({
			method: "goal/updated",
			params: { threadId: "t", goal: { status: "active", tokensUsed: 999 } },
		});
		expect(goalCbCount).toBe(countAtFinish);
	});
});

describe("CodexDaemonClient — R21 send-failure marks transport closed", () => {
	it("a synchronous send failure flips isClosed() so the goal loop can fail closed", async () => {
		const d = new FakeDaemon();
		d.send = () => {
			throw new Error("write EPIPE");
		};
		const c = makeClient(d);
		await expect(c.getGoal("t")).rejects.toBeInstanceOf(CodexDaemonError);
		expect(c.isClosed()).toBe(true);
	});
});

// ── R22 findings — post-close authority + zero-budget fail-close ─────────

describe("runGoalToTerminal — R22 close ordering", () => {
	it("HIGH: a terminal arriving AFTER the transport closes is NOT accepted as success", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/set", () => ({}));
		d.responders.set("turn/start", () => ({}));
		d.responders.set("thread/goal/get", () => ({ goal: { status: "active" } }));
		const closeThenTerminal = () => {
			// close FIRST, then a late terminal frame — the late frame must be
			// dropped, not become lifecycle authority.
			d.triggerClose("socket hang up");
			d.push({
				method: "goal/updated",
				params: {
					threadId: "t",
					goal: { status: "complete", tokensUsed: 1 },
				},
			});
			return Promise.resolve();
		};
		const c = makeClient(d);
		await expect(
			runGoalToTerminal(c, {
				threadId: "t",
				objective: "x",
				sleep: closeThenTerminal,
				now: () => 0,
				pollIntervalMs: 1,
				overallTimeoutMs: 100000,
			}),
		).rejects.toMatchObject({ kind: "transport_closed" });
	});
});

describe("CodexDaemonClient — R22 zero-budget fail-close", () => {
	it("a zero remaining-time budget rejects BEFORE sending (no response can beat the ceiling)", async () => {
		const d = new FakeDaemon();
		let sent = false;
		d.responders.set("thread/goal/get", () => {
			sent = true;
			return { goal: { status: "complete" } };
		});
		const c = makeClient(d);
		await expect(c.getGoal("t", 0)).rejects.toMatchObject({ kind: "timeout" });
		expect(sent).toBe(false); // the RPC was never even sent
	});
});

// ── R23 findings — setup-phase terminal ordering + goal-generation binding ─

describe("runGoalToTerminal — R23 setup-phase ordering", () => {
	const noSleep = () => Promise.resolve();

	it("HIGH: a terminal streamed during setup (before the turn/start response) wins over a following close", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/set", () => ({}));
		// the daemon streams OUR terminal, THEN the socket dies before the
		// turn/start response — the real terminal must win, not transport_closed.
		d.responders.set("turn/start", (_p, _id, push) => {
			push({
				method: "goal/updated",
				params: {
					threadId: "t",
					objective: "make files",
					goal: { status: "complete", tokensUsed: 7 },
				},
			});
			d.triggerClose("socket hang up");
			return {}; // this queued response will be dropped post-close
		});
		const c = makeClient(d);
		const res = await runGoalToTerminal(c, {
			threadId: "t",
			objective: "make files",
			sleep: noSleep,
			now: () => 0,
		});
		expect(res.status).toBe("complete");
		expect(res.succeeded).toBe(true);
		expect(res.tokensUsed).toBe(7);
	});

	it("HIGH: a stale prior-goal terminal (different objective / before setGoal is armed) does NOT end the run", async () => {
		const d = new FakeDaemon();
		// setGoal: a stale OLD-goal complete arrives for the SAME thread BEFORE
		// our setGoal is confirmed — must be ignored (not yet armed).
		const orig = d.send.bind(d);
		d.send = (frame) => {
			const f = frame as { id?: number; method?: string };
			if (f.method === "thread/goal/set") {
				d.sent.push(f as Record<string, unknown>);
				d.push({
					method: "goal/updated",
					params: {
						threadId: "t",
						goal: {
							status: "complete",
							objective: "OLD-GOAL",
							tokensUsed: 999,
						},
					},
				});
				queueMicrotask(() => d.push({ id: f.id, result: {} }));
			} else {
				orig(frame);
			}
		};
		// turn/start: another stale prior-goal complete AFTER arming — rejected
		// by the objective-generation guard.
		d.responders.set("turn/start", (_p, _id, push) => {
			push({
				method: "goal/updated",
				params: {
					threadId: "t",
					goal: {
						status: "complete",
						objective: "OLD-GOAL",
						tokensUsed: 888,
					},
				},
			});
			return {};
		});
		let gets = 0;
		d.responders.set("thread/goal/get", () => {
			gets += 1;
			return {
				goal: { status: gets >= 2 ? "complete" : "active", objective: "NEW" },
			};
		});
		let clock = 0;
		const c = makeClient(d);
		const res = await runGoalToTerminal(c, {
			threadId: "t",
			objective: "NEW",
			sleep: noSleep,
			now: () => {
				clock += 1000;
				return clock;
			},
			pollIntervalMs: 1,
			overallTimeoutMs: 100000,
		});
		// terminated ONLY by OUR (NEW) goal's poll, never by a stale terminal
		expect(res.status).toBe("complete");
		expect(res.tokensUsed).not.toBe(999);
		expect(res.tokensUsed).not.toBe(888);
		expect(gets).toBeGreaterThanOrEqual(2);
	});
});

// ── R24 findings — poll-path generation binding + pre-arm turn count ──────

describe("runGoalToTerminal — R24 poll ownership + turn arming", () => {
	const noSleep = () => Promise.resolve();

	it("HIGH: a poll that returns a FOREIGN objective (our goal was replaced) fails closed, not success", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/set", () => ({}));
		d.responders.set("turn/start", () => ({}));
		// another control end replaced the thread's goal after our setGoal
		d.responders.set("thread/goal/get", () => ({
			goal: { status: "complete", objective: "SOMEONE-ELSES-GOAL" },
		}));
		let clock = 0;
		const c = makeClient(d);
		await expect(
			runGoalToTerminal(c, {
				threadId: "t",
				objective: "OURS",
				sleep: noSleep,
				now: () => {
					clock += 1000;
					return clock;
				},
				pollIntervalMs: 1,
				overallTimeoutMs: 100000,
			}),
		).rejects.toMatchObject({ kind: "goal_replaced" });
	});

	it("HIGH: a real terminal seen while getGoal is in flight beats a foreign-objective poll (no false goal_replaced)", async () => {
		const d = new FakeDaemon();
		d.responders.set("thread/goal/set", () => ({}));
		d.responders.set("turn/start", () => ({}));
		// getGoal: as the poll is served, OUR real terminal lands via the
		// notification stream; the poll itself then returns a just-replaced
		// (foreign) goal. The terminal we already reached must win.
		d.responders.set("thread/goal/get", (_p, _id, push) => {
			push({
				method: "goal/updated",
				params: {
					threadId: "t",
					goal: { status: "complete", objective: "OURS", tokensUsed: 55 },
				},
			});
			return { goal: { status: "complete", objective: "SOMEONE-ELSE" } };
		});
		let clock = 0;
		const c = makeClient(d);
		const res = await runGoalToTerminal(c, {
			threadId: "t",
			objective: "OURS",
			sleep: noSleep,
			now: () => {
				clock += 1000;
				return clock;
			},
			pollIntervalMs: 1,
			overallTimeoutMs: 100000,
		});
		expect(res.status).toBe("complete");
		expect(res.succeeded).toBe(true);
		expect(res.tokensUsed).toBe(55);
	});

	it("MEDIUM: a turn emitted BEFORE the goal is armed is not counted", async () => {
		const d = new FakeDaemon();
		// setGoal: a stale prior-goal turn arrives for the SAME thread BEFORE
		// our setGoal is confirmed — it must not inflate res.turns.
		const orig = d.send.bind(d);
		d.send = (frame) => {
			const f = frame as { id?: number; method?: string };
			if (f.method === "thread/goal/set") {
				d.sent.push(f as Record<string, unknown>);
				d.push({
					method: "turn/started",
					params: { threadId: "t", turnId: "STALE-PRE-ARM-TURN" },
				});
				queueMicrotask(() => d.push({ id: f.id, result: {} }));
			} else {
				orig(frame);
			}
		};
		d.responders.set("turn/start", (_p, _id, push) => {
			push({
				method: "turn/started",
				params: { threadId: "t", turnId: "REAL-TURN" },
			});
			push({
				method: "goal/updated",
				params: {
					threadId: "t",
					goal: { status: "complete", objective: "OURS" },
				},
			});
			return {};
		});
		d.responders.set("thread/goal/get", () => ({
			goal: { status: "complete", objective: "OURS" },
		}));
		const c = makeClient(d);
		const res = await runGoalToTerminal(c, {
			threadId: "t",
			objective: "OURS",
			sleep: noSleep,
			now: () => 0,
		});
		expect(res.turns).toBe(1); // only REAL-TURN; the pre-arm turn was dropped
	});
});
