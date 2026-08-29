/**
 * FLY-1188 M4d: CodexTmuxAdapter — daemon-mode execute() unit tests. The
 * resident-/goal runtime + the founder cmux window are INJECTED, so these cover
 * the adapter's wiring + lifecycle (spawn options, sandbox roots, credentials,
 * window open on threadId, terminal reclaim, outcome→result) without a real
 * `codex app-server`. The runtime/window/client internals are covered by their
 * own suites; real-daemon behavior is the V5 (529) real-machine acceptance.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import {
	listGateMarkersForExecution,
	writeGateMarker,
} from "flywheel-comm/gate-marker";
import type { AdapterExecutionContext } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	CodexDaemonAdapterDeps,
	CodexDaemonGoalRuntimeLike,
} from "../src/CodexTmuxAdapter.js";
import {
	CodexTmuxAdapter,
	TUI_OPEN_MAX_ATTEMPTS,
} from "../src/CodexTmuxAdapter.js";
import { GoalRunError } from "../src/codex-daemon-client.js";
import type {
	CodexDaemonGoalRuntimeOptions,
	RunGoalInput,
	RunGoalOutcome,
} from "../src/codex-daemon-goal-runtime.js";
import type { RunnerTuiWindowOutcome } from "../src/codex-runner-tui-window.js";

const THREAD_ID = "019e9006-0b8e-72b0-bb80-9100d85473cf";
const WINDOW_ID = "@7";

/** Fake exec for tmux/gh/git/codex — enough for preflight + provision + window-id. */
class FakeExec {
	ghToken = "ghp_FAKE-123_456";
	ghAuthThrows = false;
	gitRevParseOut = "";
	gitRevParseThrows = false;
	gitConfigCalls: string[][] = [];
	displayMessageOut = `${WINDOW_ID}\n`;

	exec = (cmd: string, args: string[]): { stdout: string } => {
		if (cmd === "tmux") {
			if (args[0] === "-V") return { stdout: "tmux 3.4" };
			if (args[0] === "display-message")
				return { stdout: this.displayMessageOut };
			return { stdout: "" };
		}
		if (cmd === "codex") return { stdout: "codex-cli 0.144.1" };
		if (cmd === "gh") {
			if (this.ghAuthThrows) throw new Error("gh: not logged in");
			return { stdout: `${this.ghToken}\n` };
		}
		if (cmd === "git") {
			if (args.includes("rev-parse")) {
				if (this.gitRevParseThrows)
					throw new Error("fatal: not a git repository");
				return { stdout: this.gitRevParseOut };
			}
			this.gitConfigCalls.push(args);
			return { stdout: "" };
		}
		return { stdout: "" };
	};
}

/** A scriptable resident-/goal runtime (injected in place of the real one). The
 * script receives the RunGoalInput so it can fire the authoritative
 * `onThreadReady` hook (own-thread ready), mirroring the real runtime. */
class FakeRuntime implements CodexDaemonGoalRuntimeLike {
	runGoalInputs: RunGoalInput[] = [];
	stopped = 0;
	drainedCalls = 0;
	drainRejectsWith?: Error;
	constructor(
		private readonly script: (input: RunGoalInput) => Promise<RunGoalOutcome>,
	) {}
	async runGoal(input: RunGoalInput): Promise<RunGoalOutcome> {
		this.runGoalInputs.push(input);
		return this.script(input);
	}
	stop(): void {
		this.stopped += 1;
	}
	async drained(): Promise<void> {
		this.drainedCalls += 1;
		if (this.drainRejectsWith) throw this.drainRejectsWith;
	}
}

const complete = (threadId = THREAD_ID): RunGoalOutcome => ({
	threadId,
	result: { status: "complete", tokensUsed: 5, turns: 2, succeeded: true },
	restarts: 0,
});

describe("CodexTmuxAdapter (FLY-1188 M4d daemon mode)", () => {
	let dir: string;
	let markerDir: string;
	let dbPath: string;
	let homesRoot: string;
	let fake: FakeExec;
	let execId: string;

	let capturedOpts: CodexDaemonGoalRuntimeOptions | undefined;
	let runtime: FakeRuntime;
	let ensureWindowCalls: Array<Record<string, unknown>>;
	let killWindowCalls: Array<Record<string, unknown>>;
	// FLY-1239: the injected ensureWindow now returns a RunnerTuiWindowOutcome.
	// A queue consumed one-per-call, last value sticky.
	let ensureWindowSeq: RunnerTuiWindowOutcome[];
	// FLY-1239: the injected reopen scheduler. Default = synchronous-immediate so
	// policy/outcome tests are deterministic; the ordering test overrides it with a
	// queued scheduler to prove the "hook returns → goal advances → retry" ordering.
	let reopenScheduler: (fn: () => void, ms: number) => () => void;
	let windowAliveReturns: boolean;

	const origMarkerEnv = process.env.FLYWHEEL_GATE_MARKER_DIR;
	const origHomesEnv = process.env.FLYWHEEL_CODEX_HOMES_ROOT;
	const origSrcEnv = process.env.FLYWHEEL_CODEX_SOURCE_HOME;
	const origSessionEnv = process.env.FLYWHEEL_CODEX_SESSION_DIR;

	function makeDeps(): CodexDaemonAdapterDeps {
		return {
			runtimeFactory: (opts) => {
				capturedOpts = opts;
				return runtime;
			},
			ensureWindow: ((spec: Record<string, unknown>) => {
				ensureWindowCalls.push(spec);
				return ensureWindowSeq.length > 1
					? (ensureWindowSeq.shift() as RunnerTuiWindowOutcome)
					: ensureWindowSeq[0];
			}) as CodexDaemonAdapterDeps["ensureWindow"],
			killWindow: ((spec: Record<string, unknown>) => {
				killWindowCalls.push(spec);
			}) as CodexDaemonAdapterDeps["killWindow"],
			windowAlive: () => windowAliveReturns,
			scheduleReopen: (fn, ms) => reopenScheduler(fn, ms),
		};
	}

	function makeAdapter(opts?: {
		transport?: ConstructorParameters<typeof CodexTmuxAdapter>[5];
	}): CodexTmuxAdapter {
		return new CodexTmuxAdapter(
			"testsess",
			fake.exec,
			25,
			60_000,
			undefined,
			opts?.transport,
			makeDeps(),
		);
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1188-codex-adapter-"));
		markerDir = join(dir, "codex-gates");
		dbPath = join(dir, "comm.db");
		homesRoot = join(dir, "codex-homes");
		process.env.FLYWHEEL_GATE_MARKER_DIR = markerDir;
		const srcCodex = join(dir, "dotcodex");
		mkdirSync(join(srcCodex, "profiles", "personal"), { recursive: true });
		writeFileSync(join(srcCodex, "auth.json"), '{"tokens":{"a":1}}');
		writeFileSync(
			join(srcCodex, "config.toml"),
			'model = "gpt-5-codex"\nsandbox_mode = "danger-full-access"\n',
		);
		process.env.FLYWHEEL_CODEX_HOMES_ROOT = homesRoot;
		process.env.FLYWHEEL_CODEX_SOURCE_HOME = srcCodex;
		// Isolate the crash-recovery session.json dir (persistSessionState) off ~/.
		process.env.FLYWHEEL_CODEX_SESSION_DIR = join(dir, "codex-sessions");

		fake = new FakeExec();
		mkdirSync(join(dir, ".git"), { recursive: true });
		fake.gitRevParseOut = `${join(dir, ".git")}\n${join(dir, ".git")}\n`;
		execId = `exec-${Math.random().toString(36).slice(2, 10)}`;

		capturedOpts = undefined;
		runtime = new FakeRuntime(async (input) => {
			input.onThreadReady?.(THREAD_ID, 0);
			input.onGoalActive?.();
			return complete();
		});
		ensureWindowCalls = [];
		killWindowCalls = [];
		ensureWindowSeq = [{ created: true }];
		// synchronous-immediate: the reopen chain runs to completion inside the call
		// that scheduled it — deterministic for policy tests (the ordering test
		// overrides this with a queued scheduler).
		reopenScheduler = (fn) => {
			fn();
			return () => {};
		};
		windowAliveReturns = true;

		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		const restore = (k: string, v: string | undefined) => {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		};
		restore("FLYWHEEL_GATE_MARKER_DIR", origMarkerEnv);
		restore("FLYWHEEL_CODEX_HOMES_ROOT", origHomesEnv);
		restore("FLYWHEEL_CODEX_SOURCE_HOME", origSrcEnv);
		restore("FLYWHEEL_CODEX_SESSION_DIR", origSessionEnv);
		vi.restoreAllMocks();
	});

	function ctx(
		overrides?: Partial<AdapterExecutionContext>,
	): AdapterExecutionContext {
		return {
			executionId: execId,
			issueId: "FLY-1188",
			prompt: "do the task",
			cwd: dir,
			commDbPath: dbPath,
			leadId: "flywheel-eng-lead",
			projectName: "proj",
			label: "FLY-1188",
			...overrides,
		};
	}

	it("type + no streaming", () => {
		expect(makeAdapter().type).toBe("codex-tmux");
		expect(makeAdapter().supportsStreaming).toBe(false);
	});

	it("happy path: runGoal → complete → success result + terminal reclaim", async () => {
		const res = await makeAdapter().execute(ctx());
		expect(res.success).toBe(true);
		expect(res.timedOut).toBe(false);
		expect(res.sessionId).toBe(THREAD_ID);
		expect(res.sessionParams).toMatchObject({
			vendor: "codex",
			threadId: THREAD_ID,
		});
		// founder window opened once (on the streamed threadId), then torn down
		expect(ensureWindowCalls).toHaveLength(1);
		expect(ensureWindowCalls[0]).toMatchObject({
			tmuxSession: "testsess",
			windowName: "FLY-1188",
			threadId: THREAD_ID,
		});
		expect(killWindowCalls).toHaveLength(1);
		// daemon confirmed torn down
		expect(runtime.stopped).toBe(1);
		expect(runtime.drainedCalls).toBe(1);
	});

	it("phase keep-alive starts one controller without starting mailbox intake before hold", async () => {
		const watcher = {
			start: vi.fn(async () => {}),
			stop: vi.fn(async () => {}),
			health: vi.fn(async () => ({ ok: true })),
		};
		const transport = {
			buildRunnerSpawnConfig: vi.fn(() => ({ args: [], env: {} })),
			createReceiver: vi.fn(() => watcher),
		};
		const lifecycle = {
			start: vi.fn(async () => {}),
			stop: vi.fn(async () => {}),
			stopIntake: vi.fn(async () => {}),
			waitForShutdown: vi.fn(() => new Promise(() => {})),
			observe: vi.fn(() => ({ kind: "active" as const })),
			getPhaseHold: vi.fn(() => null),
			enterHold: vi.fn(async () => {}),
			confirmHoldPaused: vi.fn(async () => {}),
			waitForActivity: vi.fn(async () => {}),
			leaveHold: vi.fn(async () => {}),
			markWakeStarted: vi.fn(),
			finishWake: vi.fn(),
			ackShutdown: vi.fn(),
		};
		const deps = {
			...makeDeps(),
			phaseLifecycleFactory: vi.fn(() => lifecycle),
		};
		const adapter = new CodexTmuxAdapter(
			"testsess",
			fake.exec,
			25,
			60_000,
			undefined,
			transport,
			deps,
		);

		const result = await adapter.execute(
			ctx({
				phaseKeepAlive: { role: "design" },
				agentName: "runner-agent",
				teamName: "flywheel-eng-lead",
			}),
		);

		expect(result.success).toBe(true);
		expect(deps.phaseLifecycleFactory).toHaveBeenCalledOnce();
		expect(transport.createReceiver).toHaveBeenCalledOnce();
		expect(lifecycle.start).toHaveBeenCalledOnce();
		expect(lifecycle.stop).toHaveBeenCalledOnce();
		expect(watcher.start).not.toHaveBeenCalled();
		expect(runtime.runGoalInputs[0]?.phaseLifecycle).toBe(lifecycle);
		expect(runtime.stopped).toBe(1);
		expect(runtime.drainedCalls).toBe(1);
	});

	it("request-bound phase shutdown stops the runtime, drains, then acknowledges", async () => {
		let rejectGoal: ((error: Error) => void) | undefined;
		const order: string[] = [];
		const controlledRuntime: CodexDaemonGoalRuntimeLike = {
			runGoal: () =>
				new Promise((_resolve, reject) => {
					rejectGoal = reject;
				}),
			stop: () => {
				order.push("runtime.stop");
				rejectGoal?.(new GoalRunError("controlled close", "transport_closed"));
			},
			drained: async () => {
				order.push("runtime.drained");
			},
		};
		const lifecycle = {
			start: vi.fn(async () => {}),
			stopIntake: vi.fn(async () => order.push("intake.stop")),
			stop: vi.fn(async () => order.push("controller.stop")),
			waitForShutdown: vi.fn(async () => ({ requestId: "shutdown-1" })),
			observe: vi.fn(() => ({
				kind: "shutdown" as const,
				requestId: "shutdown-1",
			})),
			getPhaseHold: vi.fn(() => null),
			enterHold: vi.fn(async () => {}),
			confirmHoldPaused: vi.fn(async () => {}),
			waitForActivity: vi.fn(async () => {}),
			leaveHold: vi.fn(async () => {}),
			markWakeStarted: vi.fn(),
			finishWake: vi.fn(),
			ackShutdown: vi.fn(() => {
				const db = new CommDB(dbPath);
				try {
					expect(db.getSession(execId)?.status).toBe("completed");
				} finally {
					db.close();
				}
				order.push("shutdown.ack");
			}),
		};
		const deps = {
			...makeDeps(),
			runtimeFactory: () => controlledRuntime,
			phaseLifecycleFactory: () => lifecycle,
			killWindow: vi.fn(() => order.push("tui.kill")),
			scrubCredential: vi.fn(() => order.push("credential.scrub")),
			startHeartbeat: vi.fn(() => () => order.push("heartbeat.stop")),
		};
		const adapter = new CodexTmuxAdapter(
			"testsess",
			fake.exec,
			25,
			60_000,
			undefined,
			undefined,
			deps,
		);

		const result = await adapter.execute(
			ctx({ phaseKeepAlive: { role: "qa" } }),
		);

		expect(result.success).toBe(true);
		expect(lifecycle.ackShutdown).toHaveBeenCalledWith("shutdown-1", {
			ok: true,
		});
		expect(order).toEqual([
			"runtime.stop",
			"intake.stop",
			"runtime.stop",
			"runtime.drained",
			"tui.kill",
			"credential.scrub",
			"shutdown.ack",
			"heartbeat.stop",
			"controller.stop",
		]);
	});

	it("request-bound phase shutdown writes a failed ack when daemon drain is unconfirmed", async () => {
		let rejectGoal: ((error: Error) => void) | undefined;
		const order: string[] = [];
		const controlledRuntime: CodexDaemonGoalRuntimeLike = {
			runGoal: () =>
				new Promise((_resolve, reject) => {
					rejectGoal = reject;
				}),
			stop: () => {
				order.push("runtime.stop");
				rejectGoal?.(new GoalRunError("controlled close", "transport_closed"));
			},
			drained: async () => {
				order.push("runtime.drained");
				throw new Error("SIGKILL unconfirmed");
			},
		};
		const lifecycle = {
			start: vi.fn(async () => {}),
			stopIntake: vi.fn(async () => order.push("intake.stop")),
			stop: vi.fn(async () => order.push("controller.stop")),
			waitForShutdown: vi.fn(async () => ({ requestId: "shutdown-fail" })),
			observe: vi.fn(() => ({
				kind: "shutdown" as const,
				requestId: "shutdown-fail",
			})),
			getPhaseHold: vi.fn(() => null),
			enterHold: vi.fn(async () => {}),
			confirmHoldPaused: vi.fn(async () => {}),
			waitForActivity: vi.fn(async () => {}),
			leaveHold: vi.fn(async () => {}),
			markWakeStarted: vi.fn(),
			finishWake: vi.fn(),
			ackShutdown: vi.fn(() => order.push("shutdown.ack")),
		};
		const adapter = new CodexTmuxAdapter(
			"testsess",
			fake.exec,
			25,
			60_000,
			undefined,
			undefined,
			{
				...makeDeps(),
				runtimeFactory: () => controlledRuntime,
				phaseLifecycleFactory: () => lifecycle,
				killWindow: vi.fn(() => order.push("tui.kill")),
				scrubCredential: vi.fn(() => order.push("credential.scrub")),
				startHeartbeat: vi.fn(() => () => order.push("heartbeat.stop")),
			},
		);

		const result = await adapter.execute(
			ctx({ phaseKeepAlive: { role: "design" } }),
		);

		expect(result.success).toBe(false);
		expect(lifecycle.ackShutdown).toHaveBeenCalledWith("shutdown-fail", {
			ok: false,
			error: "SIGKILL unconfirmed",
		});
		expect(order.indexOf("credential.scrub")).toBeLessThan(
			order.indexOf("shutdown.ack"),
		);
		expect(order.indexOf("shutdown.ack")).toBeLessThan(
			order.indexOf("heartbeat.stop"),
		);
	});

	it("ordinary Codex keeps terminal-window-first teardown order", async () => {
		const order: string[] = [];
		const ordinaryRuntime: CodexDaemonGoalRuntimeLike = {
			runGoal: async () => complete(),
			stop: () => order.push("runtime.stop"),
			drained: async () => order.push("runtime.drained"),
		};
		const adapter = new CodexTmuxAdapter(
			"testsess",
			fake.exec,
			25,
			60_000,
			undefined,
			undefined,
			{
				...makeDeps(),
				runtimeFactory: () => ordinaryRuntime,
				killWindow: vi.fn(() => order.push("tui.kill")),
				scrubCredential: vi.fn(() => order.push("credential.scrub")),
				startHeartbeat: vi.fn(() => () => order.push("heartbeat.stop")),
			},
		);

		const result = await adapter.execute(ctx());

		expect(result.success).toBe(true);
		expect(order).toEqual([
			"heartbeat.stop",
			"tui.kill",
			"runtime.stop",
			"runtime.drained",
			"credential.scrub",
		]);
	});

	it("runs without phaseKeepAlive create no phase controller or receiver", async () => {
		const transport = {
			buildRunnerSpawnConfig: vi.fn(() => ({ args: [], env: {} })),
			createReceiver: vi.fn(() => null),
		};
		const phaseLifecycleFactory = vi.fn();
		const adapter = new CodexTmuxAdapter(
			"testsess",
			fake.exec,
			25,
			60_000,
			undefined,
			transport,
			{ ...makeDeps(), phaseLifecycleFactory },
		);

		await adapter.execute(
			ctx({
				agentName: "runner-agent",
				teamName: "flywheel-eng-lead",
			}),
		);
		await adapter.execute(
			ctx({
				agentName: "runner-agent",
				teamName: "flywheel-eng-lead",
				issueId: "FLY-AUTO-QA-SHAPED",
			}),
		);

		expect(phaseLifecycleFactory).not.toHaveBeenCalled();
		expect(transport.createReceiver).not.toHaveBeenCalled();
	});

	// ── QA · FLY-1188 (real-machine E2E, 2026-07-13) ────────────────────────
	// The founder TUI never rendered on a real machine: the pane died instantly
	// with `Error: stdout is not a terminal` (exit 1). The adapter hands the TUI
	// `flywheelCodexBin()` — the fallback shim — which pipes codex's stdout
	// through `tee` to sniff 429s for account rotation. A piped stdout is not a
	// TTY, and the `codex resume --remote` TUI refuses to run without one.
	//
	// The DAEMON may keep the shim (`app-server` needs no TTY, and it wants the
	// rotation); the founder-facing TUI must get a TTY-capable binary — exactly
	// what the working lead-side precedent does (lead-backends/codex/tui-window.ts
	// defaults to raw `codex`). Evidence: qa/tui-failure-diagnosis.txt.
	it("QA FLY-1188: does NOT launch the founder TUI through the stdout-piping fallback shim", async () => {
		await makeAdapter().execute(ctx());
		expect(ensureWindowCalls).toHaveLength(1);
		const tuiBin = String(ensureWindowCalls[0].codexBin ?? "");
		expect(tuiBin).not.toContain("flywheel-codex-with-fallback");
	});

	it("passes the sandbox writable roots + network + workspace-write to the runtime", async () => {
		await makeAdapter().execute(ctx());
		expect(capturedOpts).toBeDefined();
		const o = capturedOpts as CodexDaemonGoalRuntimeOptions;
		expect(o.sandbox).toBe("workspace-write");
		expect(o.approvalPolicy).toBe("never");
		expect(o.networkAccess).toBe(true);
		expect(o.cwd).toBe(realpathSync(dir)); // realpath'd cwd (FLY-793)
		// the FLY-1188 sandbox fix (daemon form): worktree + git metadata are roots
		expect(o.sandboxWritableRoots).toContain(realpathSync(dir));
		expect(o.sandboxWritableRoots).toContain(realpathSync(join(dir, ".git")));
		expect(o.sandboxWritableRoots?.some((r) => r.endsWith("/.flywheel"))).toBe(
			true,
		);
		expect(o.sandboxWritableRoots).toContain(markerDir);
		// single account home (MVP); socket derived
		expect(o.codexHomes).toHaveLength(1);
		expect(o.codexHomes[0]).toContain(execId);
		expect(o.socketPath).toContain("/cdx-sock/");
	});

	it("the daemon env carries the FLYWHEEL_* protocol vars + codex vendor", async () => {
		await makeAdapter().execute(
			ctx({ bridgeUrl: "http://b", progressPath: "/p" }),
		);
		const env = (capturedOpts as CodexDaemonGoalRuntimeOptions).env ?? {};
		expect(env.FLYWHEEL_EXEC_ID).toBe(execId);
		expect(env.FLYWHEEL_ISSUE_ID).toBe("FLY-1188");
		expect(env.FLYWHEEL_RUNNER_VENDOR_ID).toBe("codex");
		expect(env.FLYWHEEL_RUNNER_BACKEND_ID).toBe("codex-tmux");
		expect(env.FLYWHEEL_GATE_MARKER_DIR).toBe(markerDir);
		expect(env.FLYWHEEL_COMM_DB).toBe(dbPath);
		expect(env.FLYWHEEL_BRIDGE_URL).toBe("http://b");
		expect(env.FLYWHEEL_PROGRESS_PATH).toBe("/p");
	});

	it("FLY-1236: delivers appendSystemPrompt + prompt via the KICK turn (not the /goal objective)", async () => {
		await makeAdapter().execute(ctx({ appendSystemPrompt: "SYSTEM RULES" }));
		const inp = runtime.runGoalInputs[0];
		const kick = inp?.kickText ?? "";
		// full working body rides the kick turn, in order, byte-exact
		expect(kick).toBe("SYSTEM RULES\n\n---\n\ndo the task");
		expect(kick).toContain("SYSTEM RULES");
		expect(kick).toContain("do the task");
		expect(kick.indexOf("SYSTEM RULES")).toBeLessThan(
			kick.indexOf("do the task"),
		);
		// the durable /goal objective is a bounded pointer — NOT the body
		const obj = inp?.objective ?? "";
		expect(obj).not.toContain("SYSTEM RULES");
		expect(obj).not.toContain("do the task");
		expect(obj).toContain("FLY-1188"); // the task head (label/issueId)
	});

	it("FLY-615 + FLY-1236: enablePonytail injects the ponytail ruleset into the KICK, not the objective", async () => {
		await makeAdapter().execute(ctx({ enablePonytail: true }));
		const inp = runtime.runGoalInputs[0];
		expect(inp?.kickText ?? "").toMatch(/ponytail/i);
		expect(inp?.objective ?? "").not.toMatch(/ponytail/i);
	});

	it("FLY-1236: a real-scale prompt keeps the /goal objective under the cap and puts the full body in the kick (exact)", async () => {
		// The original incident: folding systemLayer+prompt into the objective blew
		// past the 4000-char thread/goal/set cap → setup_failed. Now the objective
		// stays a short pointer and the full body rides the kick turn.
		const bigPrompt = `TASK: ${"z".repeat(6000)}`;
		const sys = "SYS LAYER";
		await makeAdapter().execute(
			ctx({ appendSystemPrompt: sys, prompt: bigPrompt }),
		);
		const inp = runtime.runGoalInputs[0];
		expect((inp?.objective ?? "").length).toBeLessThanOrEqual(4000);
		// exact equality — not toContain, which could pass after truncation/dup
		expect(inp?.kickText).toBe(`${sys}\n\n---\n\n${bigPrompt}`);
		expect((inp?.kickText ?? "").length).toBeGreaterThan(6000);
		expect(inp?.objective ?? "").not.toContain(bigPrompt);
	});

	it("FLY-1236: a fresh execution on a brand-new thread (no previousSession, new execId) is kicked with the full reconstructed instructions, never goal-only", async () => {
		const sys = "SYSTEM RULES for the runner";
		const bigPrompt = `IMPLEMENT: ${"x".repeat(6000)}`;

		// Execution A — resumes a prior thread (previousSession present).
		const rtA = new FakeRuntime(async (input) => {
			input.onThreadReady?.("thread-A", 0);
			return complete("thread-A");
		});
		runtime = rtA;
		await makeAdapter().execute(
			ctx({
				executionId: "exec-A",
				previousSession: { threadId: "thread-A" },
				appendSystemPrompt: sys,
				prompt: bigPrompt,
				issueId: "FLY-1225",
				label: "FLY-1225-fix",
			}),
		);
		expect(rtA.runGoalInputs[0]?.resumeThreadId).toBe("thread-A");

		// Execution B — a GENUINELY new thread: different execId, NO previousSession,
		// no persisted B thread, its own runtime/thread. B's kick is NOT in the old
		// thread's history — it must be reconstructed from ctx and re-sent in full.
		const rtB = new FakeRuntime(async (input) => {
			input.onThreadReady?.("thread-B", 0);
			return complete("thread-B");
		});
		runtime = rtB;
		const resB = await makeAdapter().execute(
			ctx({
				executionId: "exec-B",
				appendSystemPrompt: sys,
				prompt: bigPrompt,
				issueId: "FLY-1225",
				label: "FLY-1225-fix",
			}),
		);
		const inB = rtB.runGoalInputs[0];
		expect(inB?.resumeThreadId).toBeUndefined(); // genuinely new thread
		expect(resB.sessionId).toBe("thread-B"); // distinct B thread
		// full reconstructed kick, EXACT — never left goal-only
		expect(inB?.kickText).toBe(`${sys}\n\n---\n\n${bigPrompt}`);
		// objective carries only the bounded pointer, not the working body
		expect((inB?.objective ?? "").length).toBeLessThanOrEqual(4000);
		expect(inB?.objective ?? "").not.toContain(bigPrompt);
		expect(inB?.objective ?? "").toContain("FLY-1225-fix");
	});

	it("opens the founder window from the outcome when onThreadReady never fired", async () => {
		runtime = new FakeRuntime(async () => complete()); // never fires onThreadReady
		await makeAdapter().execute(ctx());
		expect(ensureWindowCalls).toHaveLength(1);
		expect(ensureWindowCalls[0]).toMatchObject({ threadId: THREAD_ID });
	});

	it("opens the founder window ONCE even if onThreadReady fires repeatedly (restart/resume)", async () => {
		runtime = new FakeRuntime(async (input) => {
			input.onThreadReady?.(THREAD_ID, 0);
			input.onThreadReady?.(THREAD_ID, 1); // a daemon restart re-fires
			input.onThreadReady?.(THREAD_ID, 2);
			return complete();
		});
		await makeAdapter().execute(ctx());
		expect(ensureWindowCalls).toHaveLength(1);
	});

	it("Codex R2 MEDIUM: reopens the founder window on a daemon RESTART if the pane died", async () => {
		windowAliveReturns = false; // the old remote TUI exited when its socket closed
		runtime = new FakeRuntime(async (input) => {
			input.onThreadReady?.(THREAD_ID, 0); // first start → open
			input.onThreadReady?.(THREAD_ID, 1); // daemon restart → pane dead → reopen
			return complete();
		});
		await makeAdapter().execute(ctx());
		expect(ensureWindowCalls.length).toBe(2);
	});

	// ── FLY-1239: bounded, non-blocking founder-window retry (rollout race) ─────
	describe("FLY-1239: bounded founder-window retry on the rollout race", () => {
		it("retries a `died` outcome and latches once it finally opens", async () => {
			ensureWindowSeq = [
				{ created: false, reason: "died" },
				{ created: false, reason: "died" },
				{ created: true },
			];
			runtime = new FakeRuntime(async (input) => {
				input.onThreadReady?.(THREAD_ID, 0);
				return complete();
			});
			const res = await makeAdapter().execute(ctx());
			expect(res.success).toBe(true);
			expect(ensureWindowCalls.length).toBe(3); // died, died, created
		});

		it("stops at exactly TUI_OPEN_MAX_ATTEMPTS when every attempt dies (fail-loud, not infinite)", async () => {
			ensureWindowSeq = [{ created: false, reason: "died" }]; // sticky: always dies
			runtime = new FakeRuntime(async (input) => {
				input.onThreadReady?.(THREAD_ID, 0);
				return complete();
			});
			await makeAdapter().execute(ctx());
			// bounded: exactly the cap, never a MAX+1th attempt (threadReadySeen also
			// stops the fallback from adding one more).
			expect(ensureWindowCalls.length).toBe(TUI_OPEN_MAX_ATTEMPTS);
		});

		it("does NOT retry a non-retryable outcome (tmux-absent / create-failed) — exactly one attempt", async () => {
			for (const reason of ["tmux-absent", "create-failed"] as const) {
				ensureWindowCalls = [];
				ensureWindowSeq = [{ created: false, reason }];
				runtime = new FakeRuntime(async (input) => {
					input.onThreadReady?.(THREAD_ID, 0);
					return complete();
				});
				await makeAdapter().execute(ctx());
				expect(ensureWindowCalls.length).toBe(1);
			}
		});

		it("every attempt targets the SAME windowName (so the module's same-name purge keeps ≤1 window)", async () => {
			ensureWindowSeq = [
				{ created: false, reason: "died" },
				{ created: false, reason: "died" },
				{ created: true },
			];
			runtime = new FakeRuntime(async (input) => {
				input.onThreadReady?.(THREAD_ID, 0);
				return complete();
			});
			await makeAdapter().execute(ctx());
			for (const call of ensureWindowCalls) {
				expect(call.windowName).toBe("FLY-1188");
			}
		});

		it("the outcome fallback fires ONLY when onThreadReady never fired (threadReadySeen)", async () => {
			// hook DID fire but the window never opened (create-failed) → NO fallback
			ensureWindowSeq = [{ created: false, reason: "create-failed" }];
			runtime = new FakeRuntime(async (input) => {
				input.onThreadReady?.(THREAD_ID, 0);
				return complete();
			});
			await makeAdapter().execute(ctx());
			expect(ensureWindowCalls.length).toBe(1); // no extra fallback attempt
		});

		it("Codex R2 MED-2: a THROWING fallback (hook never fired) is fail-open — the run still succeeds", async () => {
			ensureWindowSeq = [{ created: true }];
			// make the injected ensureWindow throw on the fallback path
			const throwingDeps = makeDeps();
			throwingDeps.ensureWindow = (() => {
				ensureWindowCalls.push({});
				throw new Error("tui blew up in fallback");
			}) as CodexDaemonAdapterDeps["ensureWindow"];
			runtime = new FakeRuntime(async () => complete()); // never fires onThreadReady
			const adapter = new CodexTmuxAdapter(
				"testsess",
				fake.exec,
				25,
				60_000,
				undefined,
				undefined,
				throwingDeps,
			);
			const res = await adapter.execute(ctx());
			expect(res.success).toBe(true); // visibility-only throw never fails the run
			expect(runtime.drainedCalls).toBe(1); // teardown still ran
		});

		it("Codex R1 MED-5: the first attempt is DEFERRED — onThreadReady returns and the goal advances before any TUI work", async () => {
			// queued scheduler: capture the scheduled reopen callbacks; nothing runs
			// until we drain manually.
			const queue: Array<() => void> = [];
			reopenScheduler = (fn) => {
				queue.push(fn);
				return () => {
					const i = queue.indexOf(fn);
					if (i >= 0) queue.splice(i, 1);
				};
			};
			const events: string[] = [];
			runtime = new FakeRuntime(async (input) => {
				input.onThreadReady?.(THREAD_ID, 0);
				events.push("hook-returned");
				// the FIRST attempt must be queued, NOT yet run, when the hook returns
				expect(ensureWindowCalls.length).toBe(0);
				expect(queue.length).toBe(1);
				input.onGoalActive?.();
				events.push("goal-advanced");
				// drain the queued first attempt only AFTER goal progress
				queue.shift()?.();
				events.push("retry-ran");
				return complete();
			});
			await makeAdapter().execute(ctx());
			expect(events).toEqual(["hook-returned", "goal-advanced", "retry-ran"]);
			expect(ensureWindowCalls.length).toBe(1); // ran exactly once, AFTER goal progress
		});

		it("finally cancels a pending reopen and runEnded blocks a late callback from opening a window", async () => {
			// queued scheduler that also records cancellation
			let captured: (() => void) | undefined;
			let cancelled = false;
			reopenScheduler = (fn) => {
				captured = fn;
				return () => {
					cancelled = true;
				};
			};
			runtime = new FakeRuntime(async (input) => {
				input.onThreadReady?.(THREAD_ID, 0); // queues the first attempt (never drained)
				return complete();
			});
			await makeAdapter().execute(ctx());
			// the pending reopen was cancelled during teardown, before any window opened
			expect(cancelled).toBe(true);
			expect(ensureWindowCalls.length).toBe(0);
			// firing the stale callback AFTER the run ended must NOT open a window
			const before = ensureWindowCalls.length;
			captured?.();
			expect(ensureWindowCalls.length).toBe(before); // runEnded guard held
		});

		// ── Codex code review R1 MED-2: queued/interleaving + fail-open proofs ──
		it("died→died→created through a QUEUED scheduler drained one callback at a time", async () => {
			const queue: Array<() => void> = [];
			reopenScheduler = (fn) => {
				queue.push(fn);
				return () => {
					const i = queue.indexOf(fn);
					if (i >= 0) queue.splice(i, 1);
				};
			};
			const drainOne = () => queue.shift()?.();
			ensureWindowSeq = [
				{ created: false, reason: "died" },
				{ created: false, reason: "died" },
				{ created: true },
			];
			runtime = new FakeRuntime(async (input) => {
				input.onThreadReady?.(THREAD_ID, 0); // queues attempt 1 (not yet run)
				drainOne(); // attempt 1: died → queues attempt 2
				drainOne(); // attempt 2: died → queues attempt 3
				drainOne(); // attempt 3: created → latched, no re-queue
				return complete();
			});
			const res = await makeAdapter().execute(ctx());
			expect(res.success).toBe(true);
			expect(ensureWindowCalls.length).toBe(3);
			expect(queue.length).toBe(0); // no dangling scheduled retry after success
		});

		it("died×MAX through a queued scheduler stops at exactly the cap with ONE exhaustion log", async () => {
			const queue: Array<() => void> = [];
			reopenScheduler = (fn) => {
				queue.push(fn);
				return () => {};
			};
			ensureWindowSeq = [{ created: false, reason: "died" }]; // sticky
			runtime = new FakeRuntime(async (input) => {
				input.onThreadReady?.(THREAD_ID, 0);
				// drain the whole queue (each died re-queues the next until the cap)
				let guard = 0;
				while (queue.length && guard++ < 50) queue.shift()?.();
				return complete();
			});
			await makeAdapter().execute(ctx());
			expect(ensureWindowCalls.length).toBe(TUI_OPEN_MAX_ATTEMPTS);
			const logs = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			const exhaustion = logs.filter((l) =>
				/exited immediately on every attempt/.test(l),
			);
			expect(exhaustion).toHaveLength(1); // exactly one fail-loud line
			expect(exhaustion[0]).toContain(String(TUI_OPEN_MAX_ATTEMPTS)); // reports the attempt count
		});

		it("a restart fired WHILE the first chain is still opening does NOT start a second chain", async () => {
			const queue: Array<() => void> = [];
			reopenScheduler = (fn) => {
				queue.push(fn);
				return () => {};
			};
			ensureWindowSeq = [{ created: false, reason: "died" }, { created: true }];
			runtime = new FakeRuntime(async (input) => {
				input.onThreadReady?.(THREAD_ID, 0); // chain starts; attempt 1 queued (not run)
				input.onThreadReady?.(THREAD_ID, 1); // restart WHILE opening — must NOT queue a 2nd chain
				expect(queue.length).toBe(1); // single-flight: still just one pending attempt
				queue.shift()?.(); // attempt 1 → died → re-queue attempt 2
				queue.shift()?.(); // attempt 2 → created
				return complete();
			});
			await makeAdapter().execute(ctx());
			expect(ensureWindowCalls.length).toBe(2); // one chain, not two
		});

		it("a THROWING ensureWindow on the HOOK path is fail-open — the run still succeeds", async () => {
			const throwingDeps = makeDeps();
			throwingDeps.ensureWindow = (() => {
				ensureWindowCalls.push({});
				throw new Error("ensure blew up on hook path");
			}) as CodexDaemonAdapterDeps["ensureWindow"];
			runtime = new FakeRuntime(async (input) => {
				input.onThreadReady?.(THREAD_ID, 0);
				return complete();
			});
			const adapter = new CodexTmuxAdapter(
				"testsess",
				fake.exec,
				25,
				60_000,
				undefined,
				undefined,
				throwingDeps,
			);
			const res = await adapter.execute(ctx());
			expect(res.success).toBe(true);
			expect(runtime.drainedCalls).toBe(1);
		});

		it("a THROWING scheduleReopen is fail-open — the run still succeeds", async () => {
			reopenScheduler = () => {
				throw new Error("scheduler blew up");
			};
			runtime = new FakeRuntime(async (input) => {
				input.onThreadReady?.(THREAD_ID, 0);
				return complete();
			});
			const res = await makeAdapter().execute(ctx());
			expect(res.success).toBe(true);
		});

		it("teardown order: cancel reopen BEFORE killWindow, runtime.stop, and drained", async () => {
			const order: string[] = [];
			reopenScheduler = () => () => order.push("cancel");
			runtime = new FakeRuntime(async (input) => {
				input.onThreadReady?.(THREAD_ID, 0); // schedules a reopen (canceler recorded)
				return complete();
			});
			const origStop = runtime.stop.bind(runtime);
			runtime.stop = () => {
				order.push("stop");
				origStop();
			};
			const origDrained = runtime.drained.bind(runtime);
			runtime.drained = async () => {
				order.push("drained");
				return origDrained();
			};
			const deps = makeDeps();
			deps.killWindow = (() => {
				order.push("killWindow");
			}) as CodexDaemonAdapterDeps["killWindow"];
			const adapter = new CodexTmuxAdapter(
				"testsess",
				fake.exec,
				25,
				60_000,
				undefined,
				undefined,
				deps,
			);
			await adapter.execute(ctx());
			expect(order.indexOf("cancel")).toBeGreaterThanOrEqual(0);
			expect(order.indexOf("cancel")).toBeLessThan(order.indexOf("killWindow"));
			expect(order.indexOf("killWindow")).toBeLessThan(order.indexOf("stop"));
			expect(order.indexOf("stop")).toBeLessThan(order.indexOf("drained"));
		});

		it("Codex code R1 MED-1: a THROWING cancel handle does NOT abort teardown", async () => {
			reopenScheduler = () => () => {
				throw new Error("cancel blew up");
			};
			runtime = new FakeRuntime(async (input) => {
				input.onThreadReady?.(THREAD_ID, 0);
				return complete();
			});
			const res = await makeAdapter().execute(ctx());
			// teardown continued despite the throwing cancel handle (fail-open contract)
			expect(res.success).toBe(true);
			expect(killWindowCalls.length).toBe(1);
			expect(runtime.stopped).toBe(1);
			expect(runtime.drainedCalls).toBe(1);
		});
	});

	it("HIGH-4: passes previousSession.threadId as resumeThreadId (crash-recovery resume)", async () => {
		await makeAdapter().execute(
			ctx({ previousSession: { threadId: "prior-thread-xyz" } }),
		);
		expect(runtime.runGoalInputs[0]?.resumeThreadId).toBe("prior-thread-xyz");
	});

	it("HIGH-4: self-contained resume — reads the persisted session.json when previousSession is absent", async () => {
		// simulate a prior run of THIS execution that persisted its thread id
		const stateDir = join(dir, "codex-sessions", execId);
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			join(stateDir, "session.json"),
			JSON.stringify({
				executionId: execId,
				threadId: "persisted-thread",
				vendor: "codex",
			}),
		);
		await makeAdapter().execute(ctx()); // no previousSession
		expect(runtime.runGoalInputs[0]?.resumeThreadId).toBe("persisted-thread");
	});

	it("HIGH-3 + HIGH-4: onThreadReady writes the launch commit + persists the resume handle", async () => {
		const commitPath = join(dir, "commits", "launch");
		await makeAdapter().execute(ctx({ launchCommitPath: commitPath }));
		// FLY-245 durable launch commit written
		expect(existsSync(commitPath)).toBe(true);
		// session.json persisted with the discovered threadId (crash recovery)
		const sessionJson = JSON.parse(
			readFileSync(
				join(dir, "codex-sessions", execId, "session.json"),
				"utf-8",
			),
		);
		expect(sessionJson.threadId).toBe(THREAD_ID);
		expect(sessionJson.vendor).toBe("codex");
	});

	it("HIGH-6: an unconfirmed daemon teardown (drained rejects) fails the run", async () => {
		runtime = new FakeRuntime(async (input) => {
			input.onThreadReady?.(THREAD_ID, 0);
			return complete();
		});
		runtime.drainRejectsWith = new Error("daemon did not exit after SIGKILL");
		const res = await makeAdapter().execute(ctx());
		// the goal completed, but a live-daemon "completed" would be a lie
		expect(res.success).toBe(false);
		expect(runtime.drainedCalls).toBe(1);
	});

	it("a non-complete terminal (blocked/usageLimited) is a non-success", async () => {
		runtime = new FakeRuntime(async () => ({
			threadId: THREAD_ID,
			result: {
				status: "usageLimited",
				tokensUsed: 9,
				turns: 3,
				succeeded: false,
			},
			restarts: 1,
		}));
		const res = await makeAdapter().execute(ctx());
		expect(res.success).toBe(false);
		expect(res.timedOut).toBe(false);
		expect(res.sessionParams).toMatchObject({ threadId: THREAD_ID });
	});

	it("a GoalRunError timeout → timedOut result, teardown still runs", async () => {
		runtime = new FakeRuntime(async () => {
			throw new GoalRunError("active budget exceeded", "timeout");
		});
		const res = await makeAdapter().execute(ctx());
		expect(res.success).toBe(false);
		expect(res.timedOut).toBe(true);
		expect(killWindowCalls).toHaveLength(1);
		expect(runtime.stopped).toBe(1);
		expect(runtime.drainedCalls).toBe(1);
	});

	it("a thrown non-GoalRunError → failure, still tears the daemon + window down", async () => {
		runtime = new FakeRuntime(async () => {
			throw new Error("kaboom");
		});
		const res = await makeAdapter().execute(ctx());
		expect(res.success).toBe(false);
		expect(killWindowCalls).toHaveLength(1);
		expect(runtime.stopped).toBe(1);
		expect(runtime.drainedCalls).toBe(1);
	});

	it("HIGH-2: the concurrent gate-deadline watcher writes a timeout response that SURVIVES the runner's next `check` + emits gate_timed_out (FLY-159)", async () => {
		const db = new CommDB(dbPath);
		// Production-faithful: the codex `--no-block` gate (gate.ts) creates the
		// question with the DEFAULT 72h TTL — the gate DEADLINE lives only in the
		// marker's timeoutMs, so the question is UNEXPIRED when the watcher fires
		// (deadline ≤ 49h < 72h TTL). The HIGH-2 bug was NOT a pre-expired question
		// — it was the old resolveGate(_,0) forcing expires_at=now, so the next
		// read-write open's purge deleted the synthetic response before `check`
		// read it. `insertTimeoutResponse` instead bumps expires_at to a grace
		// window, so the response survives the purge.
		const questionId = db.insertQuestion(execId, "flywheel-eng-lead", "ok?", {
			checkpoint: "brainstorm",
		});
		db.close();
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));
		// an ALREADY-expired fail-close marker (timeoutMs 0)
		writeGateMarker(markerDir, {
			questionId,
			executionId: execId,
			backend: "codex-tmux",
			vendor: "codex",
			checkpoint: "brainstorm",
			timeoutMs: 0,
			timeoutBehavior: "fail-close",
		});
		// keep runGoal running long enough for the 25ms-poll watcher to fire
		runtime = new FakeRuntime(async (input) => {
			input.onThreadReady?.(THREAD_ID, 0);
			await new Promise((r) => setTimeout(r, 150));
			return complete();
		});
		await makeAdapter().execute(ctx({ bridgeUrl: "http://127.0.0.1:9999" }));
		// marker cleared + question resolved (no longer pending to the runner)
		expect(listGateMarkersForExecution(markerDir, execId)).toEqual([]);
		// HIGH-2 REGRESSION GUARD: a fresh READ-WRITE open runs purgeExpired() in
		// its constructor — exactly what `flywheel-comm check` does. The synthetic
		// timeout response MUST still be there (the old path lost it here).
		const check = new CommDB(dbPath);
		const resolved = check.getMessageById(questionId);
		expect(resolved?.resolved_at).not.toBeNull();
		expect(check.getResponse(questionId)?.content).toContain(
			"GATE TIMEOUT (fail-close)",
		);
		check.close();
		// FLY-159-isomorphic gate_timed_out event emitted
		const gateCall = fetchSpy.mock.calls.find(([url]) =>
			String(url).endsWith("/events"),
		);
		expect(gateCall).toBeTruthy();
		const body = JSON.parse(String(gateCall?.[1]?.body));
		expect(body.event_type).toBe("gate_timed_out");
		expect(body.payload.question_id).toBe(questionId);
		expect(body.payload.timeout_behavior).toBe("fail-close");
	});

	it("registers the CommDB session with vendor=codex (send routing source)", async () => {
		await makeAdapter().execute(ctx());
		const db = new CommDB(dbPath);
		const sess = db.getSession(execId);
		db.close();
		expect(sess?.vendor).toBe("codex");
	});

	it("HIGH-3: persists the live daemon pid, and a resuming re-execute threads it as reapOrphanPid", async () => {
		// Run 1: the daemon reports its pid, then OUR thread becomes ready →
		// persistSessionState writes {threadId, daemonPid} to session.json.
		runtime = new FakeRuntime(async (input) => {
			input.onDaemonPid?.(4321);
			input.onThreadReady?.(THREAD_ID, 0);
			return complete();
		});
		await makeAdapter().execute(ctx());

		// Run 2: the SAME execution re-executes (Bridge restart). The adapter reads
		// the persisted thread + daemon pid and threads BOTH into runGoal so the
		// resuming spawn resumes the thread AND reaps a prior orphan on our socket.
		const resumed = new FakeRuntime(async () => complete());
		runtime = resumed;
		await makeAdapter().execute(ctx());
		expect(resumed.runGoalInputs[0]?.resumeThreadId).toBe(THREAD_ID);
		expect(resumed.runGoalInputs[0]?.reapOrphanPid).toBe(4321);
	});

	it("FLY-1188 sandbox: git metadata resolution failure aborts BEFORE any runtime spawn", async () => {
		fake.gitRevParseThrows = true;
		await expect(makeAdapter().execute(ctx())).rejects.toThrow(
			/cannot resolve git metadata dirs/,
		);
		expect(capturedOpts).toBeUndefined(); // never reached the runtime
		expect(ensureWindowCalls).toHaveLength(0);
	});

	it("FLY-209: the gh token is extracted + the worktree git credential helper is wired", async () => {
		// (token DELIVERY into config.toml is covered by codex-home tests; here we
		// prove the adapter extracted a valid token + wired https push — the
		// config.toml is scrubbed at terminal by the P5 test below.)
		await makeAdapter().execute(ctx());
		expect(
			fake.gitConfigCalls.some((a) => a.join(" ").includes("credential.https")),
		).toBe(true);
		expect(
			fake.gitConfigCalls.some((a) => a.join(" ").includes("insteadOf")),
		).toBe(true);
	});

	it("P5: the live GH_TOKEN is scrubbed from the retained home on terminal", async () => {
		await makeAdapter().execute(ctx());
		const cfg = readFileSync(join(homesRoot, execId, "config.toml"), "utf-8");
		expect(cfg).not.toContain("GH_TOKEN");
	});

	it("gh not authenticated → fail-open: no token, run still proceeds to the runtime", async () => {
		fake.ghAuthThrows = true;
		const res = await makeAdapter().execute(ctx());
		expect(res.success).toBe(true);
		const cfg = readFileSync(join(homesRoot, execId, "config.toml"), "utf-8");
		expect(cfg).not.toContain("GH_TOKEN");
	});

	it("passes ctx.model through to the runtime when set", async () => {
		await makeAdapter().execute(ctx({ model: "gpt-5.6-codex" }));
		expect((capturedOpts as CodexDaemonGoalRuntimeOptions).model).toBe(
			"gpt-5.6-codex",
		);
	});

	// FLY-1224 (T5 integration): ctx.effort rides to the runtime options — the
	// goal runtime forwards it to the daemon spawn as
	// `-c model_reasoning_effort="<effort>"` (argv locked by the
	// buildDaemonEffortArgs unit tests).
	it("passes ctx.effort through to the runtime when set (FLY-1224)", async () => {
		await makeAdapter().execute(ctx({ model: "gpt-5.6-sol", effort: "xhigh" }));
		const opts = capturedOpts as CodexDaemonGoalRuntimeOptions;
		expect(opts.model).toBe("gpt-5.6-sol");
		expect(opts.effort).toBe("xhigh");
	});

	it("no ctx.effort → runtime options carry no effort (byte-compatible)", async () => {
		await makeAdapter().execute(ctx());
		expect(
			(capturedOpts as CodexDaemonGoalRuntimeOptions).effort,
		).toBeUndefined();
	});
});
