import { describe, expect, it } from "vitest";
import {
	type CodexDaemonClient,
	CodexDaemonError,
	type DaemonTransport,
	type GoalPhaseLifecycle,
	GoalRunError,
	type GoalRunResult,
} from "../src/codex-daemon-client.js";
import {
	CodexDaemonGoalRuntime,
	type CodexDaemonGoalRuntimeOptions,
} from "../src/codex-daemon-goal-runtime.js";
import type { DaemonHandle } from "../src/codex-daemon-runtime.js";

// ── FLY-1188 M4c-2 — resident /goal runtime (collaborators injected) ──────

function fakeHandle(onStop: () => void): DaemonHandle {
	// Model a real daemon: killed by a signal it keeps exitCode null but sets
	// signalCode + fires the `exit` event, so the runtime's exit drain resolves.
	let exitCb: (() => void) | null = null;
	const child = {
		pid: 1,
		exitCode: null as number | null,
		signalCode: null as string | null,
		kill: () => true,
		once: (event: string, cb: () => void) => {
			if (event === "exit") exitCb = cb;
		},
	};
	return {
		child,
		socketPath: "/tmp/x.sock",
		ensureDead: async () => true,
		stop: () => {
			child.signalCode = "SIGTERM";
			onStop();
			exitCb?.();
		},
	} as unknown as DaemonHandle;
}

/** A scriptable client: records thread ops; startThread returns a fresh id. */
class FakeClient {
	initialized = 0;
	started: string[] = [];
	resumed: string[] = [];
	closed = 0;
	constructor(private readonly threadId: string) {}
	async initialize(): Promise<void> {
		this.initialized += 1;
	}
	async startThread(): Promise<string> {
		this.started.push(this.threadId);
		return this.threadId;
	}
	async resumeThread(id: string): Promise<string> {
		this.resumed.push(id);
		return id;
	}
	close(): void {
		this.closed += 1;
	}
}

const dummyTransport: DaemonTransport = {
	send: () => {},
	onMessage: () => {},
	onClose: () => {},
	close: () => {},
};

const COMPLETE: GoalRunResult = {
	status: "complete",
	tokensUsed: 100,
	turns: 2,
	succeeded: true,
};

interface Harness {
	spawns: string[]; // codexHome per spawn
	stops: number;
	clients: FakeClient[];
	opts: CodexDaemonGoalRuntimeOptions;
}

function makeHarness(
	overrides: Partial<CodexDaemonGoalRuntimeOptions> & {
		runGoalScript: Array<GoalRunResult | Error>;
		threadIds?: string[];
	},
): Harness {
	const spawns: string[] = [];
	let stops = 0;
	const clients: FakeClient[] = [];
	const threadIds = overrides.threadIds ?? ["t-1", "t-2", "t-3", "t-4"];
	let spawnIdx = 0;
	let goalIdx = 0;

	const opts: CodexDaemonGoalRuntimeOptions = {
		executionId: "exec-1",
		codexBin: "/bin/codex",
		codexHomes: ["/home/a", "/home/b", "/home/c"],
		cwd: "/work",
		socketPath: "/tmp/d.sock",
		spawnDaemon: async (o) => {
			spawns.push(o.codexHome);
			return fakeHandle(() => {
				stops += 1;
			});
		},
		connectTransport: async () => dummyTransport,
		makeClient: () => {
			const c = new FakeClient(threadIds[spawnIdx] ?? "t-x");
			spawnIdx += 1;
			clients.push(c);
			return c as unknown as CodexDaemonClient;
		},
		runGoalFn: (async () => {
			const step = overrides.runGoalScript[goalIdx] ?? COMPLETE;
			goalIdx += 1;
			if (step instanceof Error) throw step;
			return step;
		}) as CodexDaemonGoalRuntimeOptions["runGoalFn"],
		...overrides,
	};
	return {
		spawns,
		get stops() {
			return stops;
		},
		clients,
		opts,
	};
}

describe("CodexDaemonGoalRuntime", () => {
	it("happy path: spawn → connect → initialize → startThread → runGoal → complete", async () => {
		const h = makeHarness({ runGoalScript: [COMPLETE] });
		const rt = new CodexDaemonGoalRuntime(h.opts);
		const out = await rt.runGoal({ objective: "make files" });
		expect(out.result.succeeded).toBe(true);
		expect(out.restarts).toBe(0);
		expect(out.threadId).toBe("t-1");
		expect(h.spawns).toEqual(["/home/a"]); // first account
		expect(h.clients[0].initialized).toBe(1);
		expect(h.clients[0].started).toEqual(["t-1"]);
		expect(h.clients[0].resumed).toEqual([]);
		rt.stop();
	});

	it("passes sandboxWritableRoots + networkAccess through to the daemon spawn (M4d)", async () => {
		let seen: {
			sandboxWritableRoots?: string[];
			sandboxNetworkAccess?: boolean;
		} = {};
		const h = makeHarness({ runGoalScript: [COMPLETE] });
		const rt = new CodexDaemonGoalRuntime({
			...h.opts,
			sandboxWritableRoots: ["/work", "/main/.git", "/main/.git/worktrees/w"],
			networkAccess: true,
			spawnDaemon: async (o) => {
				seen = {
					sandboxWritableRoots: o.sandboxWritableRoots,
					sandboxNetworkAccess: o.sandboxNetworkAccess,
				};
				return fakeHandle(() => {});
			},
		});
		await rt.runGoal({ objective: "x" });
		expect(seen.sandboxWritableRoots).toEqual([
			"/work",
			"/main/.git",
			"/main/.git/worktrees/w",
		]);
		expect(seen.sandboxNetworkAccess).toBe(true);
		rt.stop();
	});

	it("fires onThreadReady with the authoritative own-thread id (M4d)", async () => {
		const ready: Array<[string, number]> = [];
		const h = makeHarness({ runGoalScript: [COMPLETE] });
		const rt = new CodexDaemonGoalRuntime(h.opts);
		await rt.runGoal({
			objective: "x",
			onThreadReady: (tid, restarts) => ready.push([tid, restarts]),
		});
		expect(ready).toEqual([["t-1", 0]]);
		rt.stop();
	});

	it("a throwing onThreadReady handler never breaks the run", async () => {
		const h = makeHarness({ runGoalScript: [COMPLETE] });
		const rt = new CodexDaemonGoalRuntime(h.opts);
		const out = await rt.runGoal({
			objective: "x",
			onThreadReady: () => {
				throw new Error("handler boom");
			},
		});
		expect(out.result.succeeded).toBe(true);
		rt.stop();
	});

	it("resumeThreadId → resumes the existing thread instead of starting a new one", async () => {
		const h = makeHarness({ runGoalScript: [COMPLETE] });
		const rt = new CodexDaemonGoalRuntime(h.opts);
		const out = await rt.runGoal({
			objective: "x",
			resumeThreadId: "prior-thread",
		});
		expect(out.threadId).toBe("prior-thread");
		expect(h.clients[0].resumed).toEqual(["prior-thread"]);
		expect(h.clients[0].started).toEqual([]);
	});

	it("a daemon death mid-run restarts on the NEXT account and RESUMES the same thread", async () => {
		const h = makeHarness({
			runGoalScript: [
				new GoalRunError("socket died", "transport_closed"),
				COMPLETE,
			],
		});
		const rt = new CodexDaemonGoalRuntime(h.opts);
		const out = await rt.runGoal({ objective: "x" });
		expect(out.result.succeeded).toBe(true);
		expect(out.restarts).toBe(1);
		// spawned twice, rotating account a → b
		expect(h.spawns).toEqual(["/home/a", "/home/b"]);
		// first client started t-1; after death, second client RESUMED t-1
		expect(h.clients[0].started).toEqual(["t-1"]);
		expect(h.clients[1].resumed).toEqual(["t-1"]);
		expect(h.stops).toBe(1); // the dead session was torn down
	});

	it("FLY-1236: same-thread in-run restart re-sends the exact same kick (rebuilt thread never goes goal-only)", async () => {
		// A mid-goal daemon death resumes the SAME thread, but runGoalToTerminal
		// re-runs setGoal + startTurn every iteration — so the full working kick is
		// re-delivered on the restart, never leaving the (resumed) thread with only
		// the north-star objective.
		const h = makeHarness({
			runGoalScript: [
				new GoalRunError("socket died", "transport_closed"),
				COMPLETE,
			],
		});
		const kicks: Array<string | undefined> = [];
		const orig = h.opts.runGoalFn as NonNullable<
			CodexDaemonGoalRuntimeOptions["runGoalFn"]
		>;
		const rt = new CodexDaemonGoalRuntime({
			...h.opts,
			runGoalFn: (async (c, input, ev) => {
				kicks.push(input.kickText);
				return orig(c, input, ev);
			}) as CodexDaemonGoalRuntimeOptions["runGoalFn"],
		});
		const KICK =
			"SYSTEM RULES\n\n---\n\nfull working instructions for the runner";
		await rt.runGoal({ objective: "[FLY-1225] pointer", kickText: KICK });
		expect(kicks).toHaveLength(2); // one per attempt (initial + restart)
		expect(kicks[0]).toBe(KICK);
		expect(kicks[1]).toBe(KICK); // byte-identical re-kick on the restart
		rt.stop();
	});

	it("HIGH-3: threads reapOrphanPid to the FIRST spawn only + reports each daemon pid via onDaemonPid", async () => {
		const seenReap: Array<number | undefined> = [];
		const h = makeHarness({
			// death then complete → forces one account-rotation restart (2nd spawn)
			runGoalScript: [
				new GoalRunError("socket died", "transport_closed"),
				COMPLETE,
			],
		});
		const rt = new CodexDaemonGoalRuntime({
			...h.opts,
			spawnDaemon: async (o) => {
				seenReap.push(o.reapOrphanPid);
				return fakeHandle(() => {});
			},
		});
		const pids: Array<number | undefined> = [];
		await rt.runGoal({
			objective: "x",
			reapOrphanPid: 4321,
			onDaemonPid: (p) => pids.push(p),
		});
		// first spawn reaps a prior orphan; the within-run restart tears down its
		// own daemon first, so there is NO orphan → reapOrphanPid omitted.
		expect(seenReap).toEqual([4321, undefined]);
		// each spawn reports its live pid (fakeHandle pid = 1)
		expect(pids).toEqual([1, 1]);
		rt.stop();
	});

	it("MED-7 R2: every restart's goal call shares the SAME run start (the budget never re-arms)", async () => {
		const h = makeHarness({
			// death then complete → one account-rotation restart (2 goal calls)
			runGoalScript: [
				new GoalRunError("socket died", "transport_closed"),
				COMPLETE,
			],
		});
		const startedAts: Array<number | undefined> = [];
		const orig = h.opts.runGoalFn as NonNullable<
			CodexDaemonGoalRuntimeOptions["runGoalFn"]
		>;
		const rt = new CodexDaemonGoalRuntime({
			...h.opts,
			runGoalFn: (async (c, input, ev) => {
				startedAts.push(input.startedAt);
				return orig(c, input, ev);
			}) as CodexDaemonGoalRuntimeOptions["runGoalFn"],
		});
		await rt.runGoal({ objective: "x", overallTimeoutMs: 10_000 });
		expect(startedAts).toHaveLength(2); // one per attempt
		expect(startedAts[0]).toBeTypeOf("number");
		// The restart reuses the SAME anchor — without this each restart re-armed a
		// fresh full budget and N restarts multiplied the cap (Codex R2 MEDIUM).
		expect(startedAts[1]).toBe(startedAts[0]);
		rt.stop();
	});

	it("FLY-1269 carries phase lifecycle and both restored deadlines across restart", async () => {
		const calls: Array<Record<string, unknown>> = [];
		let attempt = 0;
		const phaseLifecycle = {} as GoalPhaseLifecycle;
		const h = makeHarness({
			runGoalScript: [],
			runGoalFn: (async (_client, input) => {
				calls.push(input as unknown as Record<string, unknown>);
				attempt += 1;
				if (attempt === 1) {
					input.onBudgetRestored?.({
						deadlineMs: 50_000,
						hardDeadlineMs: 90_000,
					});
					throw new GoalRunError("socket died", "transport_closed");
				}
				return COMPLETE;
			}) as CodexDaemonGoalRuntimeOptions["runGoalFn"],
		});
		const rt = new CodexDaemonGoalRuntime(h.opts);
		await rt.runGoal({ objective: "phase", phaseLifecycle });

		expect(calls).toHaveLength(2);
		expect(calls[0]?.phaseLifecycle).toBe(phaseLifecycle);
		expect(calls[1]?.phaseLifecycle).toBe(phaseLifecycle);
		expect(calls[1]?.minDeadlineMs).toBe(50_000);
		expect(calls[1]?.minHardDeadlineMs).toBe(90_000);
		rt.stop();
	});

	it("a NON-transport failure (timeout) propagates without restarting", async () => {
		const h = makeHarness({
			runGoalScript: [new GoalRunError("deadline", "timeout")],
		});
		const rt = new CodexDaemonGoalRuntime(h.opts);
		await expect(rt.runGoal({ objective: "x" })).rejects.toMatchObject({
			kind: "timeout",
		});
		expect(h.spawns).toEqual(["/home/a"]); // no restart
	});

	it("a goal_replaced failure propagates without restarting", async () => {
		const h = makeHarness({
			runGoalScript: [new GoalRunError("replaced", "goal_replaced")],
		});
		const rt = new CodexDaemonGoalRuntime(h.opts);
		await expect(rt.runGoal({ objective: "x" })).rejects.toMatchObject({
			kind: "goal_replaced",
		});
		expect(h.spawns.length).toBe(1);
	});

	it("stops restarting after maxRestarts and propagates the last transport death", async () => {
		const h = makeHarness({
			maxRestarts: 2,
			runGoalScript: [
				new GoalRunError("d1", "transport_closed"),
				new GoalRunError("d2", "transport_closed"),
				new GoalRunError("d3", "transport_closed"),
			],
		});
		const rt = new CodexDaemonGoalRuntime(h.opts);
		await expect(rt.runGoal({ objective: "x" })).rejects.toBeInstanceOf(
			GoalRunError,
		);
		// initial + 2 restarts = 3 spawns (accounts a, b, c)
		expect(h.spawns).toEqual(["/home/a", "/home/b", "/home/c"]);
	});

	it("resolves (does NOT reject) on a non-complete terminal — the caller decides", async () => {
		const h = makeHarness({
			runGoalScript: [
				{ status: "usageLimited", tokensUsed: 200, turns: 3, succeeded: false },
			],
		});
		const rt = new CodexDaemonGoalRuntime(h.opts);
		const out = await rt.runGoal({ objective: "x" });
		expect(out.result.status).toBe("usageLimited");
		expect(out.result.succeeded).toBe(false);
	});

	it("stop() tears the session down and blocks further runGoal", async () => {
		const h = makeHarness({ runGoalScript: [COMPLETE] });
		const rt = new CodexDaemonGoalRuntime(h.opts);
		await rt.runGoal({ objective: "x" });
		rt.stop();
		expect(h.stops).toBe(1);
		await expect(rt.runGoal({ objective: "y" })).rejects.toThrow(
			/already stopped/,
		);
	});

	it("a transport death during thread SETUP (startThread) also restarts + resumes", async () => {
		let spawnIdx = 0;
		const spawns: string[] = [];
		let stops = 0;
		// client 0: startThread throws a raw client "closed" (daemon died during
		// setup) — must trigger restart. client 1: resumes the thread.
		const client0 = {
			initialize: async () => {},
			startThread: async () => {
				throw new CodexDaemonError("daemon closed", "closed");
			},
			resumeThread: async (id: string) => id,
			close: () => {},
		};
		const client1 = {
			initialize: async () => {},
			startThread: async () => "t-new",
			resumeThread: async (id: string) => id,
			close: () => {},
		};
		const clients = [client0, client1];
		const rt = new CodexDaemonGoalRuntime({
			executionId: "e",
			codexBin: "/b",
			codexHomes: ["/home/a", "/home/b"],
			cwd: "/w",
			socketPath: "/tmp/d.sock",
			spawnDaemon: async (o) => {
				spawns.push(o.codexHome);
				return fakeHandle(() => {
					stops += 1;
				});
			},
			connectTransport: async () => dummyTransport,
			makeClient: () => clients[spawnIdx++] as unknown as CodexDaemonClient,
			runGoalFn: (async () => COMPLETE) as never,
		});
		// no resumeThreadId → the first startThread throws closed → restart, but
		// the second session has no threadId either, so it startThreads fresh.
		const out = await rt.runGoal({ objective: "x" });
		expect(out.result.succeeded).toBe(true);
		expect(out.restarts).toBe(1);
		expect(spawns).toEqual(["/home/a", "/home/b"]); // rotated
		expect(stops).toBe(1); // the dead session was torn down
	});

	it("rejects a re-entrant runGoal while one is in progress", async () => {
		let release: (() => void) | null = null;
		const gate = new Promise<GoalRunResult>((r) => {
			release = () => r(COMPLETE);
		});
		const rt = new CodexDaemonGoalRuntime({
			executionId: "e",
			codexBin: "/b",
			codexHomes: ["/home/a"],
			cwd: "/w",
			socketPath: "/tmp/d.sock",
			spawnDaemon: async () => fakeHandle(() => {}),
			connectTransport: async () => dummyTransport,
			makeClient: () =>
				({
					initialize: async () => {},
					startThread: async () => "t-1",
					resumeThread: async (id: string) => id,
					close: () => {},
				}) as unknown as CodexDaemonClient,
			runGoalFn: (async () => gate) as never,
		});
		const first = rt.runGoal({ objective: "a" }); // stays pending on the gate
		await expect(rt.runGoal({ objective: "b" })).rejects.toThrow(
			/not re-entrant/,
		);
		release?.();
		await first; // let the first finish cleanly
	});

	it("closes the transport + daemon when connect fails (no leak)", async () => {
		let stops = 0;
		const transportClosed = false;
		const rt = new CodexDaemonGoalRuntime({
			executionId: "e",
			codexBin: "/b",
			codexHomes: ["/home/a"],
			cwd: "/w",
			socketPath: "/tmp/d.sock",
			spawnDaemon: async () =>
				fakeHandle(() => {
					stops += 1;
				}),
			connectTransport: async () => {
				throw new Error("no socket");
			},
			makeClient: () => {
				throw new Error("should not reach makeClient");
			},
			runGoalFn: (async () => COMPLETE) as never,
		});
		await expect(rt.runGoal({ objective: "x" })).rejects.toThrow(/no socket/);
		expect(stops).toBe(1); // daemon torn down on connect failure
		expect(transportClosed).toBe(false); // no transport was created
	});

	it("closes transport + daemon when makeClient throws (no leak)", async () => {
		let stops = 0;
		let transportClosed = false;
		const transport: DaemonTransport = {
			send: () => {},
			onMessage: () => {},
			onClose: () => {},
			close: () => {
				transportClosed = true;
			},
		};
		const rt = new CodexDaemonGoalRuntime({
			executionId: "e",
			codexBin: "/b",
			codexHomes: ["/home/a"],
			cwd: "/w",
			socketPath: "/tmp/d.sock",
			spawnDaemon: async () =>
				fakeHandle(() => {
					stops += 1;
				}),
			connectTransport: async () => transport,
			makeClient: () => {
				throw new Error("client boom");
			},
			runGoalFn: (async () => COMPLETE) as never,
		});
		await expect(rt.runGoal({ objective: "x" })).rejects.toThrow(/client boom/);
		expect(stops).toBe(1); // daemon torn down
		expect(transportClosed).toBe(true); // orphaned transport closed
	});

	// a daemon that never exits (stop is a no-op; the exit event never fires).
	function zombieHandle(): DaemonHandle {
		return {
			child: {
				pid: 1,
				exitCode: null,
				signalCode: null,
				kill: () => true,
				once: () => {},
			},
			socketPath: "/tmp/z.sock",
			ensureDead: async () => true,
			stop: () => {},
		} as unknown as DaemonHandle;
	}
	const liveClient = () =>
		({
			initialize: async () => {},
			startThread: async () => "t-1",
			resumeThread: async (id: string) => id,
			close: () => {},
		}) as unknown as CodexDaemonClient;

	it("HIGH: a restart fails loud (refuses to restart) if the killed daemon never exits after SIGKILL", async () => {
		const rt = new CodexDaemonGoalRuntime({
			executionId: "e",
			codexBin: "/b",
			codexHomes: ["/home/a", "/home/b"],
			cwd: "/w",
			socketPath: "/tmp/z.sock",
			spawnDaemon: async () => zombieHandle(),
			connectTransport: async () => dummyTransport,
			makeClient: () => liveClient(),
			runGoalFn: (async () => {
				throw new GoalRunError("died", "transport_closed");
			}) as never,
			sleep: () => Promise.resolve(), // make the exit races resolve instantly
		});
		await expect(rt.runGoal({ objective: "x" })).rejects.toThrow(
			/did not exit after SIGKILL/,
		);
	});

	it("HIGH: drained() re-throws when stop()'s teardown cannot confirm the daemon exited", async () => {
		const rt = new CodexDaemonGoalRuntime({
			executionId: "e",
			codexBin: "/b",
			codexHomes: ["/home/a"],
			cwd: "/w",
			socketPath: "/tmp/z.sock",
			spawnDaemon: async () => zombieHandle(),
			connectTransport: async () => dummyTransport,
			makeClient: () => liveClient(),
			runGoalFn: (async () => COMPLETE) as never,
			sleep: () => Promise.resolve(),
		});
		await rt.runGoal({ objective: "x" }); // runs on the (undying) daemon
		rt.stop(); // kicks off the background drain of the zombie
		await expect(rt.drained()).rejects.toThrow(/did not exit after SIGKILL/);
	});

	it("drained() resolves cleanly after stop() when the daemon exits", async () => {
		const h = makeHarness({ runGoalScript: [COMPLETE] });
		const rt = new CodexDaemonGoalRuntime(h.opts);
		await rt.runGoal({ objective: "x" });
		rt.stop(); // fakeHandle fires exit on stop → drain succeeds
		await expect(rt.drained()).resolves.toBeUndefined();
	});

	it("HIGH: a successful runGoal after a concurrent stop() waits for the daemon to EXIT before resolving", async () => {
		let exitCb: (() => void) | null = null;
		const child = {
			pid: 1,
			exitCode: null as number | null,
			signalCode: null as string | null,
			kill: () => true,
			once: (e: string, cb: () => void) => {
				if (e === "exit") exitCb = cb;
			},
		};
		// stop() does NOT fire exit here — the exit is fired manually below.
		const handle = {
			child,
			socketPath: "/tmp/g.sock",
			ensureDead: async () => true,
			stop: () => {},
		} as unknown as DaemonHandle;
		let releaseGoal: (() => void) | null = null;
		const goalGate = new Promise<GoalRunResult>((r) => {
			releaseGoal = () => r(COMPLETE);
		});
		let goalReached: (() => void) | null = null;
		const goalReachedP = new Promise<void>((r) => {
			goalReached = r;
		});
		const rt = new CodexDaemonGoalRuntime({
			executionId: "e",
			codexBin: "/b",
			codexHomes: ["/home/a"],
			cwd: "/w",
			socketPath: "/tmp/g.sock",
			spawnDaemon: async () => handle,
			connectTransport: async () => dummyTransport,
			makeClient: () => liveClient(),
			runGoalFn: (async () => {
				goalReached?.(); // startSession finished; we're AT the goal gate
				return goalGate;
			}) as never,
			sleep: () => new Promise<void>(() => {}), // exit races resolve ONLY via the exit event
		});
		let resolved = false;
		const p = rt.runGoal({ objective: "x" }).then((r) => {
			resolved = true;
			return r;
		});
		await goalReachedP; // startSession done + session set; runGoalFn is gated
		rt.stop(); // kills the (set) session; the daemon has NOT exited yet
		releaseGoal?.(); // runGoalFn resolves COMPLETE (terminal-before-close)
		await new Promise((r) => setTimeout(r, 5));
		expect(resolved).toBe(false); // still waiting for the daemon to exit
		child.signalCode = "SIGKILL";
		exitCb?.(); // the daemon exits
		const out = await p;
		expect(resolved).toBe(true);
		expect(out.result.succeeded).toBe(true);
	});

	it("HIGH: drained() waits for an in-flight run's startup cleanup when stop() races startSession", async () => {
		let releaseSpawn: (() => void) | null = null;
		const spawnGate = new Promise<void>((r) => {
			releaseSpawn = () => r();
		});
		let stopCalled = false;
		const handle = fakeHandle(() => {
			stopCalled = true;
		});
		const rt = new CodexDaemonGoalRuntime({
			executionId: "e",
			codexBin: "/b",
			codexHomes: ["/home/a"],
			cwd: "/w",
			socketPath: "/tmp/g.sock",
			spawnDaemon: async () => {
				await spawnGate;
				return handle;
			},
			connectTransport: async () => dummyTransport,
			makeClient: () => liveClient(),
			runGoalFn: (async () => COMPLETE) as never,
		});
		const run = rt.runGoal({ objective: "x" }).catch(() => {}); // rejects (stopped mid-startup)
		await Promise.resolve(); // reach the spawn gate
		rt.stop(); // stopped=true, but the session isn't set yet → killSession null
		let drainedResolved = false;
		const d = rt.drained().then(() => {
			drainedResolved = true;
		});
		await new Promise((r) => setTimeout(r, 5));
		expect(drainedResolved).toBe(false); // drained waits for the in-flight run
		releaseSpawn?.(); // spawn completes → startSession sees stopped → drains the daemon → run rejects
		await run;
		await d;
		expect(drainedResolved).toBe(true);
		expect(stopCalled).toBe(true); // the startup daemon WAS drained
	});

	it("requires at least one codexHome", () => {
		expect(
			() =>
				new CodexDaemonGoalRuntime({
					executionId: "e",
					codexBin: "/b",
					codexHomes: [],
					cwd: "/w",
				}),
		).toThrow(/at least one codexHome/);
	});
});
