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
	readdirSync,
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
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	CodexDaemonAdapterDeps,
	CodexDaemonGoalRuntimeLike,
} from "../src/CodexTmuxAdapter.js";
import {
	CodexTmuxAdapter,
	readCodexLaunchSnapshot,
	TUI_OPEN_DEADLINE_MS,
	TUI_OPEN_MAX_ATTEMPTS,
} from "../src/CodexTmuxAdapter.js";
import type { CodexDaemonEvents } from "../src/codex-daemon-client.js";
import { GoalRunError } from "../src/codex-daemon-client.js";
import type {
	CodexDaemonGoalRuntimeOptions,
	RunGoalInput,
	RunGoalOutcome,
} from "../src/codex-daemon-goal-runtime.js";
import { CodexExecutionOwnershipRegistry } from "../src/codex-execution-ownership.js";
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
	ghCalls: string[][] = [];
	tmuxCalls: string[][] = [];
	displayMessageOut = `${WINDOW_ID}\n`;

	exec = (cmd: string, args: string[]): { stdout: string } => {
		if (cmd === "tmux") {
			this.tmuxCalls.push(args);
			if (args[0] === "-V") return { stdout: "tmux 3.4" };
			if (args[0] === "display-message")
				return { stdout: this.displayMessageOut };
			return { stdout: "" };
		}
		if (cmd === "codex") return { stdout: "codex-cli 0.144.1" };
		if (cmd === "gh") {
			this.ghCalls.push(args);
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
		private readonly script: (
			input: RunGoalInput,
			events?: CodexDaemonEvents,
		) => Promise<RunGoalOutcome>,
	) {}
	async runGoal(
		input: RunGoalInput,
		events?: CodexDaemonEvents,
	): Promise<RunGoalOutcome> {
		this.runGoalInputs.push(input);
		return this.script(input, events);
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
	let registryPath: string;
	let ledgerRoot: string;
	let fake: FakeExec;
	let execId: string;

	let capturedOpts: CodexDaemonGoalRuntimeOptions | undefined;
	let runtime: FakeRuntime;
	let ensureWindowCalls: Array<Record<string, unknown>>;
	let killWindowCalls: Array<Record<string, unknown>>;
	// FLY-1239: the injected ensureWindow now returns a RunnerTuiWindowOutcome.
	// A queue consumed one-per-call, last value sticky.
	let ensureWindowSeq: RunnerTuiWindowOutcome[];
	let transcriptSinkOptions: Record<string, unknown> | undefined;
	let transcriptHeaders: Array<Record<string, unknown>>;
	let transcriptMeta: string[];
	let transcriptScopes: string[];
	let transcriptNotifications: Array<{ method: string; params: unknown }>;
	let transcriptCloses: Array<string | undefined>;
	let executionOwners: CodexExecutionOwnershipRegistry;
	// FLY-1239: the injected reopen scheduler. Default = synchronous-immediate so
	// policy/outcome tests are deterministic; the ordering test overrides it with a
	// queued scheduler to prove the "hook returns → goal advances → retry" ordering.
	let reopenScheduler: (fn: () => void, ms: number) => () => void;

	const origMarkerEnv = process.env.FLYWHEEL_GATE_MARKER_DIR;
	const origCompleteMarkerEnv = process.env.FLYWHEEL_COMPLETE_MARKER_DIR;
	const origHomesEnv = process.env.FLYWHEEL_CODEX_HOMES_ROOT;
	const origSrcEnv = process.env.FLYWHEEL_CODEX_SOURCE_HOME;
	const origSessionEnv = process.env.FLYWHEEL_CODEX_SESSION_DIR;
	const origTmuxEnsureDeadlineEnv =
		process.env.FLYWHEEL_TMUX_ENSURE_DEADLINE_MS;

	function makeDeps(): CodexDaemonAdapterDeps {
		return {
			codexAccountRegistryPath: registryPath,
			codexAccountLedgerRoot: ledgerRoot,
			executionOwners,
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
			scheduleReopen: (fn, ms) => reopenScheduler(fn, ms),
			transcriptSinkFactory: (options) => {
				transcriptSinkOptions = options;
				return {
					writeHeader: (header) => transcriptHeaders.push(header),
					appendMeta: (line) => transcriptMeta.push(line),
					setThreadScope: (threadId) => transcriptScopes.push(threadId),
					onNotification: (method, params) =>
						transcriptNotifications.push({ method, params }),
					close: async (state) => {
						transcriptCloses.push(state);
					},
				};
			},
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
		registryPath = join(dir, "codex-account-registry.json");
		ledgerRoot = join(dir, "codex-account-ledger");
		process.env.FLYWHEEL_GATE_MARKER_DIR = markerDir;
		process.env.FLYWHEEL_COMPLETE_MARKER_DIR = join(dir, "complete-failed");
		const srcCodex = join(dir, "dotcodex");
		mkdirSync(join(srcCodex, "profiles", "personal"), { recursive: true });
		writeFileSync(
			registryPath,
			JSON.stringify({
				version: 1,
				primary: "personal",
				profiles: [
					{
						name: "school",
						email: "school@example.test",
						role: "manual_backup",
					},
					{
						name: "personal",
						email: "personal@example.test",
						role: "primary",
					},
					{
						name: "business",
						email: "business@example.test",
						role: "manual_backup",
					},
				],
			}),
		);
		writeFileSync(
			join(srcCodex, "auth.json"),
			codexAuth("personal@example.test", "acct-personal"),
		);
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
		ensureWindowSeq = [{ created: true, windowId: WINDOW_ID }];
		transcriptSinkOptions = undefined;
		transcriptHeaders = [];
		transcriptMeta = [];
		transcriptScopes = [];
		transcriptNotifications = [];
		transcriptCloses = [];
		executionOwners = new CodexExecutionOwnershipRegistry();
		// synchronous-immediate: the reopen chain runs to completion inside the call
		// that scheduled it — deterministic for policy tests (the ordering test
		// overrides this with a queued scheduler).
		reopenScheduler = (fn) => {
			fn();
			return () => {};
		};

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
		restore("FLYWHEEL_COMPLETE_MARKER_DIR", origCompleteMarkerEnv);
		restore("FLYWHEEL_CODEX_HOMES_ROOT", origHomesEnv);
		restore("FLYWHEEL_CODEX_SOURCE_HOME", origSrcEnv);
		restore("FLYWHEEL_CODEX_SESSION_DIR", origSessionEnv);
		restore("FLYWHEEL_TMUX_ENSURE_DEADLINE_MS", origTmuxEnsureDeadlineEnv);
		vi.restoreAllMocks();
	});

	function ctx(
		overrides?: Partial<AdapterExecutionContext>,
	): AdapterExecutionContext {
		return {
			executionId: execId,
			issueId: "FLY-1188",
			prompt: "do the task",
			cwd: realpathSync(dir),
			commDbPath: dbPath,
			leadId: "flywheel-eng-lead",
			projectName: "proj",
			label: "FLY-1188",
			...overrides,
		};
	}

	function codexAuth(email: string, accountId: string): string {
		const idToken = [
			Buffer.from('{"alg":"none"}').toString("base64url"),
			Buffer.from(
				JSON.stringify({
					email,
					"https://api.openai.com/auth": {
						chatgpt_account_id: accountId,
						chatgpt_plan_type: "pro",
					},
				}),
			).toString("base64url"),
			"signature",
		].join(".");
		return JSON.stringify({
			tokens: {
				id_token: idToken,
				access_token: "adapter-access-canary",
				refresh_token: "adapter-refresh-canary",
			},
		});
	}

	it("rejects an unknown Codex identity before GH/git credential or home writes", async () => {
		writeFileSync(
			join(dir, "dotcodex", "auth.json"),
			codexAuth("zombie@example.test", "acct-zombie"),
		);

		await expect(makeAdapter().execute(ctx())).rejects.toThrow(
			/unknown Codex/i,
		);
		expect(fake.ghCalls).toEqual([]);
		expect(fake.gitConfigCalls).toEqual([]);
		expect(existsSync(join(homesRoot, execId))).toBe(false);
		expect(existsSync(ledgerRoot)).toBe(false);
	});

	it("FLY-1961 trusts the real cwd in this execution's CODEX_HOME", async () => {
		await makeAdapter().execute(ctx({ pretrustWorkspace: true }));

		const config = parseToml(
			readFileSync(join(homesRoot, execId, "config.toml"), "utf8"),
		) as Record<string, Record<string, Record<string, unknown>>>;
		expect(config.projects[realpathSync(dir)].trust_level).toBe("trusted");
	});

	it("FLY-1961 does not add workspace trust without the signal", async () => {
		await makeAdapter().execute(ctx());

		const config = parseToml(
			readFileSync(join(homesRoot, execId, "config.toml"), "utf8"),
		) as Record<string, unknown>;
		expect(config.projects).toBeUndefined();
	});

	it("type + no streaming", () => {
		expect(makeAdapter().type).toBe("codex-tmux");
		expect(makeAdapter().supportsStreaming).toBe(false);
	});

	it("uses CommDB blocking-gate authority instead of the marker mirror", async () => {
		const db = new CommDB(dbPath);
		db.insertQuestion(execId, "flywheel-eng-lead", "blocking", {
			checkpoint: "question",
		});
		db.close();
		expect(listGateMarkersForExecution(markerDir, execId)).toEqual([]);
		const authority = vi.spyOn(CommDB.prototype, "hasPendingBlockingGateFrom");
		runtime = new FakeRuntime(async (input) => {
			expect(input.isWaiting?.()).toBe(true);
			return complete();
		});

		await makeAdapter().execute(ctx());
		expect(authority).toHaveBeenCalledWith(execId);
	});

	it("ignores a marker mirror when CommDB has no open gate", async () => {
		writeGateMarker(markerDir, {
			questionId: "marker-only",
			executionId: execId,
			backend: "codex-tmux",
			vendor: "codex",
			checkpoint: "question",
		});
		expect(listGateMarkersForExecution(markerDir, execId)).toHaveLength(1);
		const authority = vi.spyOn(CommDB.prototype, "hasPendingBlockingGateFrom");
		runtime = new FakeRuntime(async (input) => {
			expect(input.isWaiting?.()).toBe(false);
			return complete();
		});

		await makeAdapter().execute(ctx());
		expect(authority).toHaveBeenCalledWith(execId);
	});

	it("falls back to the marker mirror after a CommDB gate-query failure", async () => {
		writeGateMarker(markerDir, {
			questionId: "fallback-marker",
			executionId: execId,
			backend: "codex-tmux",
			vendor: "codex",
			checkpoint: "question",
		});
		vi.spyOn(CommDB.prototype, "hasPendingBlockingGateFrom").mockImplementation(
			() => {
				throw new Error("closed handle");
			},
		);
		runtime = new FakeRuntime(async (input) => {
			expect(input.isWaiting?.()).toBe(true);
			return complete();
		});

		await makeAdapter().execute(ctx());
	});

	it("a retained isWaiting closure uses marker fallback after execute closes CommDB", async () => {
		writeGateMarker(markerDir, {
			questionId: "closed-handle-marker",
			executionId: execId,
			backend: "codex-tmux",
			vendor: "codex",
			checkpoint: "question",
		});
		let isWaiting: (() => boolean) | undefined;
		runtime = new FakeRuntime(async (input) => {
			isWaiting = input.isWaiting;
			return complete();
		});

		await makeAdapter().execute(ctx());
		expect(isWaiting?.()).toBe(true);
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
			codexHome: join(homesRoot, execId),
			socketPath: capturedOpts?.socketPath,
			cwd: realpathSync(dir),
			threadId: THREAD_ID,
			executionId: execId,
		});
		expect(String(ensureWindowCalls[0]?.codexBin)).not.toContain(
			"flywheel-codex-with-fallback",
		);
		expect(killWindowCalls).toHaveLength(1);
		// daemon confirmed torn down
		expect(runtime.stopped).toBe(1);
		expect(runtime.drainedCalls).toBe(1);
	});

	it("publishes the execution id on the exact founder window", async () => {
		await makeAdapter().execute(ctx());

		expect(
			fake.tmuxCalls.find((args) => args.includes("@flywheel_exec_id")),
		).toEqual([
			"set-option",
			"-w",
			"-t",
			"=testsess:@7",
			"@flywheel_exec_id",
			execId,
		]);
	});

	it("does not start a visibility episode before the authoritative thread exists", async () => {
		const lost = vi.fn();
		const deps = makeDeps();
		deps.onTuiWindowLost = lost;
		runtime = new FakeRuntime(async (_input) => {
			expect(ensureWindowCalls).toHaveLength(0);
			expect(transcriptHeaders).toHaveLength(1);
			return complete();
		});
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
		expect(ensureWindowCalls).toHaveLength(0);
		expect(lost).not.toHaveBeenCalled();
	});

	it("starts the native TUI from onThreadReady without requiring onGoalActive", async () => {
		runtime = new FakeRuntime(async (input) => {
			expect(ensureWindowCalls).toHaveLength(0);
			input.onThreadReady?.(THREAD_ID, 0);
			await Promise.resolve();
			expect(ensureWindowCalls).toHaveLength(1);
			return complete();
		});

		await makeAdapter().execute(ctx());

		expect(transcriptScopes).toEqual([THREAD_ID]);
		expect(ensureWindowCalls[0]).toMatchObject({ threadId: THREAD_ID });
	});

	it("threads execution-bound state coordinates into the founder TUI", async () => {
		await makeAdapter().execute(
			ctx({ stateDbPath: "/tmp/slot-2/teamlead.db" }),
		);
		expect(ensureWindowCalls[0]).toMatchObject({
			executionId: execId,
			stateDbPath: "/tmp/slot-2/teamlead.db",
		});
	});

	it("forwards owned App Server notifications into the transcript sink", async () => {
		const params = {
			threadId: THREAD_ID,
			item: { type: "agentMessage", text: "visible progress" },
		};
		runtime = new FakeRuntime(async (input, events) => {
			input.onSpawnIdentity?.(4321);
			input.onThreadReady?.(THREAD_ID, 0);
			events?.onNotification?.("item/completed", params);
			return complete();
		});

		await makeAdapter().execute(ctx());

		expect(transcriptSinkOptions).toMatchObject({
			path: join(
				process.env.FLYWHEEL_CODEX_SESSION_DIR!,
				execId,
				"transcript.log",
			),
		});
		expect(transcriptMeta).toContain("daemon pgid: 4321");
		expect(transcriptNotifications).toEqual([
			{ method: "item/completed", params },
		]);
		expect(transcriptCloses).toEqual(["completed"]);
	});

	it("keeps heartbeat and transcript notification failures independent", async () => {
		const heartbeat = vi.fn(() => {
			throw new Error("heartbeat unavailable");
		});
		const sinkNotification = vi.fn(() => {
			throw new Error("transcript unavailable");
		});
		runtime = new FakeRuntime(async (_input, events) => {
			events?.onNotification?.("item/completed", {
				threadId: THREAD_ID,
				item: { type: "agentMessage", text: "still running" },
			});
			return complete();
		});
		const deps = makeDeps();
		deps.startHeartbeat = () => () => {};
		deps.transcriptSinkFactory = () => ({
			writeHeader: () => {},
			appendMeta: () => {},
			setThreadScope: () => {},
			onNotification: sinkNotification,
			close: async () => {},
		});
		const adapter = new CodexTmuxAdapter(
			"testsess",
			fake.exec,
			25,
			60_000,
			undefined,
			undefined,
			deps,
		);

		const result = await adapter.execute(ctx({ onHeartbeat: heartbeat }));

		expect(result.success).toBe(true);
		// Initial registration + the App Server notification both remain
		// best-effort even though this injected heartbeat throws.
		expect(heartbeat).toHaveBeenCalledTimes(2);
		expect(sinkNotification).toHaveBeenCalledTimes(1);
	});

	it("drains the daemon before closing the transcript sink", async () => {
		const order: string[] = [];
		let daemonEvents: CodexDaemonEvents | undefined;
		const drainingRuntime: CodexDaemonGoalRuntimeLike = {
			runGoal: async (_input, events) => {
				daemonEvents = events;
				return complete();
			},
			stop: () => order.push("runtime.stop"),
			drained: async () => {
				order.push("runtime.drained");
				daemonEvents?.onNotification?.("item/completed", {
					threadId: THREAD_ID,
					item: { type: "agentMessage", text: "last buffered event" },
				});
			},
		};
		const deps = makeDeps();
		deps.runtimeFactory = () => drainingRuntime;
		deps.transcriptSinkFactory = () => ({
			writeHeader: () => {},
			appendMeta: () => {},
			setThreadScope: () => {},
			onNotification: () => order.push("sink.notification"),
			close: async () => {
				order.push("sink.close");
			},
		});
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

		expect(order.indexOf("runtime.drained")).toBeLessThan(
			order.indexOf("sink.notification"),
		);
		expect(order.indexOf("sink.notification")).toBeLessThan(
			order.indexOf("sink.close"),
		);
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
		const comm = new CommDB(dbPath);
		try {
			expect(comm.getSession(execId)?.phase_keep_alive).toBe(1);
		} finally {
			comm.close();
		}
	});

	it("FLY-1774: phase registration failure prevents runtime and controller startup", async () => {
		const runtimeFactory = vi.fn(() => runtime);
		const phaseLifecycleFactory = vi.fn();
		const adapter = new CodexTmuxAdapter(
			"testsess",
			fake.exec,
			25,
			60_000,
			undefined,
			undefined,
			{ ...makeDeps(), runtimeFactory, phaseLifecycleFactory },
		);

		const result = await adapter.execute(
			ctx({
				phaseKeepAlive: { role: "implement" },
				commDbPath: dir,
			}),
		);

		expect(result.success).toBe(false);
		expect(runtimeFactory).not.toHaveBeenCalled();
		expect(phaseLifecycleFactory).not.toHaveBeenCalled();
	});

	it("FLY-1774: terminal phase session cannot be revived into a consumer", async () => {
		const comm = new CommDB(dbPath);
		try {
			comm.registerSession(
				execId,
				"testsess:FLY-1188",
				"proj",
				"FLY-1188",
				"flywheel-eng-lead",
				"codex",
				true,
			);
			comm.markSessionTerminalStatus(execId, "failed");
		} finally {
			comm.close();
		}
		const runtimeFactory = vi.fn(() => runtime);
		const phaseLifecycleFactory = vi.fn();
		const adapter = new CodexTmuxAdapter(
			"testsess",
			fake.exec,
			25,
			60_000,
			undefined,
			undefined,
			{ ...makeDeps(), runtimeFactory, phaseLifecycleFactory },
		);

		const result = await adapter.execute(
			ctx({ phaseKeepAlive: { role: "implement" } }),
		);

		expect(result.success).toBe(false);
		expect(runtimeFactory).not.toHaveBeenCalled();
		expect(phaseLifecycleFactory).not.toHaveBeenCalled();
		const after = new CommDB(dbPath);
		try {
			expect(after.getSession(execId)?.status).toBe("failed");
		} finally {
			after.close();
		}
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
			"credential.scrub",
			"tui.kill",
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

	it("ordinary Codex drains before retiring the native TUI", async () => {
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
			"runtime.stop",
			"runtime.drained",
			"credential.scrub",
			"tui.kill",
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

	it("FLY-1395 threads the bare-arm disable list into the provisioned CODEX_HOME", async () => {
		await makeAdapter().execute(
			ctx({
				skillFrameworkMode: "bare",
				codexSkillDisableNames: ["superpowers:brainstorming"],
			}),
		);
		const config = readFileSync(
			join(homesRoot, execId, "config.toml"),
			"utf-8",
		);
		expect(config).toContain('name = "superpowers:brainstorming"');
		expect(existsSync(join(homesRoot, execId, "skills", "matt-skills"))).toBe(
			false,
		);
		expect(
			existsSync(join(homesRoot, execId, "skills", "matt-skills:to-spec")),
		).toBe(false);
	});

	it("FLY-1395 threads the matt source into the provisioned CODEX_HOME", async () => {
		const source = join(dir, "matt-source");
		for (const name of [
			"code-review",
			"diagnosing-bugs",
			"grilling",
			"tdd",
			"to-spec",
			"to-tickets",
		]) {
			const skillDir = join(source, name);
			mkdirSync(skillDir, { recursive: true });
			writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\n---\n`);
		}
		await makeAdapter().execute(
			ctx({
				skillFrameworkMode: "matt",
				codexSkillDisableNames: ["superpowers:using-superpowers"],
				codexMattSkillsSourceDir: source,
			}),
		);
		const skillFile = join(
			homesRoot,
			execId,
			"skills",
			"matt-skills:to-spec",
			"SKILL.md",
		);
		expect(existsSync(skillFile)).toBe(true);
		expect(readFileSync(skillFile, "utf-8")).toContain(
			"name: matt-skills:to-spec",
		);
	});

	it("FLY-1395 default context leaves the CODEX_HOME free of managed skill state", async () => {
		await makeAdapter().execute(ctx());
		const config = readFileSync(
			join(homesRoot, execId, "config.toml"),
			"utf-8",
		);
		expect(config).not.toContain("flywheel-managed skills (FLY-1395)");
		expect(existsSync(join(homesRoot, execId, "skills", "matt-skills"))).toBe(
			false,
		);
		expect(
			existsSync(join(homesRoot, execId, "skills", "matt-skills:to-spec")),
		).toBe(false);
	});

	it("the daemon env carries the FLYWHEEL_* protocol vars + codex vendor", async () => {
		await makeAdapter().execute(
			ctx({
				bridgeUrl: "http://b",
				progressPath: "/p",
				workflowSubmissionCredential: "decision-ticket",
				workflowSubmissionExpected: true,
				workflowOutputCredential: "output-ticket",
				founderReviewRequired: true,
			}),
		);
		const env = (capturedOpts as CodexDaemonGoalRuntimeOptions).env ?? {};
		expect(env.FLYWHEEL_EXEC_ID).toBe(execId);
		expect(env.FLYWHEEL_ISSUE_ID).toBe("FLY-1188");
		expect(env.FLYWHEEL_RUNNER_VENDOR_ID).toBe("codex");
		expect(env.FLYWHEEL_RUNNER_BACKEND_ID).toBe("codex-tmux");
		expect(env.FLYWHEEL_GATE_MARKER_DIR).toBe(markerDir);
		expect(env.FLYWHEEL_COMPLETE_MARKER_DIR).toBe(join(dir, "complete-failed"));
		expect(env.FLYWHEEL_COMM_DB).toBe(dbPath);
		expect(env.FLYWHEEL_BRIDGE_URL).toBe("http://b");
		expect(env.FLYWHEEL_PROGRESS_PATH).toBe("/p");
		expect(env.FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL).toBe("decision-ticket");
		expect(env.FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED).toBe("1");
		expect(env.FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL).toBe("output-ticket");
		expect(env.FLYWHEEL_FOUNDER_REVIEW_REQUIRED).toBe("1");
	});

	it("drops hostile inherited Lead and Discord identity coordinates", async () => {
		const names = [
			"LEAD_ID",
			"PROJECT_NAME",
			"DISCORD_STATE_DIR",
			"DISCORD_BOT_TOKEN",
			"DISCORD_EXPECTED_BOT_USER_ID",
			"DISCORD_IDENTITY_MODE",
		] as const;
		const previous = names.map((name) => process.env[name]);
		try {
			for (const name of names) process.env[name] = `hostile-${name}`;
			await makeAdapter().execute(
				ctx({ leadId: "owner-lead", projectName: "canonical-project" }),
			);
			const env = (capturedOpts as CodexDaemonGoalRuntimeOptions).env ?? {};
			for (const name of names) expect(env[name]).toBeUndefined();
			expect(env.FLYWHEEL_LEAD_ID).toBe("owner-lead");
			expect(env.FLYWHEEL_PROJECT_NAME).toBe("canonical-project");
		} finally {
			for (const [index, name] of names.entries()) {
				const value = previous[index];
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	it("FLY-1643: authors only the reviewed runner FLYWHEEL_ environment", async () => {
		const transport = {
			buildRunnerSpawnConfig: vi.fn(() => ({
				args: [],
				env: {
					FLYWHEEL_AGENT_TEAM_NAME: "eng",
					FLYWHEEL_AGENT_NAME: "runner",
					FLYWHEEL_RUNNER_VENDOR_ID: "codex",
				},
			})),
			createReceiver: vi.fn(() => null),
		};
		await makeAdapter({ transport }).execute(
			ctx({
				agentName: "runner",
				teamName: "eng",
				bridgeUrl: "http://bridge",
				bridgeIngestToken: "ingest-ticket",
				stateDbPath: "/state.db",
				progressPath: "/progress.md",
				sentinelPath: "/land.json",
				workflowSubmissionCredential: "decision-ticket",
				workflowSubmissionExpected: true,
				workflowOutputCredential: "output-ticket",
			}),
		);
		const daemonEnv = (capturedOpts as CodexDaemonGoalRuntimeOptions).env ?? {};
		expect(
			Object.keys(daemonEnv)
				.filter(
					(key) => key.startsWith("FLYWHEEL_") && key !== "FLYWHEEL_COMM_CLI",
				)
				.sort(),
		).toEqual(
			[
				"FLYWHEEL_AGENT_NAME",
				"FLYWHEEL_AGENT_TEAM_NAME",
				"FLYWHEEL_BRIDGE_URL",
				"FLYWHEEL_COMM_DB",
				"FLYWHEEL_COMPLETE_MARKER_DIR",
				"FLYWHEEL_EXEC_ID",
				"FLYWHEEL_GATE_MARKER_DIR",
				"FLYWHEEL_INGEST_TOKEN",
				"FLYWHEEL_ISSUE_ID",
				"FLYWHEEL_LAND_STATUS_PATH",
				"FLYWHEEL_LEAD_ID",
				"FLYWHEEL_PROGRESS_PATH",
				"FLYWHEEL_PROJECT_NAME",
				"FLYWHEEL_RUNNER_BACKEND_ID",
				"FLYWHEEL_RUNNER_VENDOR_ID",
				"FLYWHEEL_STATE_DB_PATH",
				"FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL",
				"FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL",
				"FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED",
			].sort(),
		);
	});

	it("FLY-1643: workflow capabilities come only from the execution context", async () => {
		const names = [
			"FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL",
			"FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL",
			"FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED",
			"FLYWHEEL_FOUNDER_REVIEW_REQUIRED",
		] as const;
		const previous = names.map((name) => process.env[name]);
		try {
			process.env.FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL = "stale-output";
			process.env.FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL = "stale-submission";
			process.env.FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED = "1";
			process.env.FLYWHEEL_FOUNDER_REVIEW_REQUIRED = "1";

			await makeAdapter().execute(ctx());
			let daemonEnv = (capturedOpts as CodexDaemonGoalRuntimeOptions).env ?? {};
			for (const name of names) expect(daemonEnv[name]).toBeUndefined();

			// This assertion describes a distinct launch context, not a same-execution
			// resume. FLY-2211 makes launch capabilities immutable per executionId.
			execId = `exec-${Math.random().toString(36).slice(2, 10)}`;
			await makeAdapter().execute(
				ctx({
					workflowOutputCredential: "current-output",
					workflowSubmissionCredential: "current-submission",
					workflowSubmissionExpected: true,
					founderReviewRequired: true,
				}),
			);
			daemonEnv = (capturedOpts as CodexDaemonGoalRuntimeOptions).env ?? {};
			expect(daemonEnv.FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL).toBe(
				"current-output",
			);
			expect(daemonEnv.FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL).toBe(
				"current-submission",
			);
			expect(daemonEnv.FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED).toBe("1");
			expect(daemonEnv.FLYWHEEL_FOUNDER_REVIEW_REQUIRED).toBe("1");
		} finally {
			for (const [index, name] of names.entries()) {
				const value = previous[index];
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	it("FLY-1643: treats empty workflow credentials as absent", async () => {
		await makeAdapter().execute(
			ctx({
				workflowOutputCredential: "",
				workflowSubmissionCredential: "",
			}),
		);
		const daemonEnv = (capturedOpts as CodexDaemonGoalRuntimeOptions).env ?? {};
		expect(daemonEnv.FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL).toBeUndefined();
		expect(daemonEnv.FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL).toBeUndefined();
	});

	it("FLY-1643: rejects a changed workflow capability before runtime creation", async () => {
		const transport = {
			buildRunnerSpawnConfig: vi.fn(() => ({
				args: [],
				env: { FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL: "wrong-ticket" },
			})),
			createReceiver: vi.fn(() => null),
		};
		await expect(
			makeAdapter({ transport }).execute(
				ctx({
					agentName: "runner",
					teamName: "eng",
					workflowOutputCredential: "current-ticket",
				}),
			),
		).rejects.toThrow(/FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL/);
		expect(capturedOpts).toBeUndefined();
		expect(fake.gitConfigCalls).toEqual([]);
	});

	it("omits the complete-marker directory from daemon env when unset", async () => {
		delete process.env.FLYWHEEL_COMPLETE_MARKER_DIR;
		await makeAdapter().execute(ctx());
		const env = (capturedOpts as CodexDaemonGoalRuntimeOptions).env ?? {};
		expect(env.FLYWHEEL_COMPLETE_MARKER_DIR).toBeUndefined();
	});

	it("omits the workflow submission expectation sentinel outside the engine lane", async () => {
		await makeAdapter().execute(ctx());
		const env = (capturedOpts as CodexDaemonGoalRuntimeOptions).env ?? {};
		expect(env.FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED).toBeUndefined();
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

	it("does not open a founder window when onThreadReady never fires", async () => {
		runtime = new FakeRuntime(async () => complete()); // never fires onThreadReady
		await makeAdapter().execute(ctx());
		expect(ensureWindowCalls).toHaveLength(0);
	});

	it("reopens one replacement TUI for every daemon restart generation", async () => {
		runtime = new FakeRuntime(async (input) => {
			input.onThreadReady?.(THREAD_ID, 0);
			await Promise.resolve();
			input.onThreadReady?.(THREAD_ID, 1); // a daemon restart re-fires
			await Promise.resolve();
			input.onThreadReady?.(THREAD_ID, 2);
			await Promise.resolve();
			return complete();
		});
		await makeAdapter().execute(ctx());
		expect(ensureWindowCalls).toHaveLength(3);
		expect(ensureWindowCalls.map((call) => call.threadId)).toEqual([
			THREAD_ID,
			THREAD_ID,
			THREAD_ID,
		]);
	});

	it("reopens the native TUI after a daemon restart", async () => {
		runtime = new FakeRuntime(async (input) => {
			input.onThreadReady?.(THREAD_ID, 0); // first start → open
			await Promise.resolve();
			input.onThreadReady?.(THREAD_ID, 1);
			await Promise.resolve();
			return complete();
		});
		await makeAdapter().execute(ctx());
		expect(ensureWindowCalls.length).toBe(2);
		expect(transcriptMeta).toContain("daemon restart: 1");
	});

	// ── FLY-1239: bounded, non-blocking founder-window retry (rollout race) ─────
	describe("FLY-1239: bounded founder-window retry on the rollout race", () => {
		it("uses the 5s/15s ladder across three resume-side attempts", async () => {
			const queue: Array<() => void> = [];
			const delays: number[] = [];
			reopenScheduler = (fn, ms) => {
				delays.push(ms);
				queue.push(fn);
				return () => {};
			};
			ensureWindowSeq = [
				{
					created: false,
					category: "retryable-transient-ipc",
					reason: "window_died",
				},
				{
					created: false,
					category: "retryable-transient-ipc",
					reason: "window_died",
				},
				{ created: true, windowId: WINDOW_ID },
			];
			runtime = new FakeRuntime(async (input) => {
				input.onThreadReady?.(THREAD_ID, 0);
				for (let i = 0; i < 3; i++) {
					queue.shift()?.();
					await Promise.resolve();
				}
				return complete();
			});
			await makeAdapter().execute(ctx());
			expect(delays).toEqual([0, 5_000, 15_000]);
			expect(ensureWindowCalls).toHaveLength(3);
		});

		it("does not spend resume quota before tmux new-window is reached", async () => {
			const queue: Array<() => void> = [];
			reopenScheduler = (fn) => {
				queue.push(fn);
				return () => {};
			};
			ensureWindowSeq = [
				{
					created: false,
					category: "retryable-hold",
					reason: "hold_lock_unavailable",
				},
				{
					created: false,
					category: "retryable-transient-ipc",
					reason: "stale_window_unproven",
				},
				{
					created: false,
					category: "retryable-transient-ipc",
					reason: "window_died",
				},
			];
			runtime = new FakeRuntime(async (input) => {
				input.onThreadReady?.(THREAD_ID, 0);
				let guard = 0;
				while (queue.length && guard++ < 20) {
					queue.shift()?.();
					await Promise.resolve();
				}
				return complete();
			});
			await makeAdapter().execute(ctx());
			expect(ensureWindowCalls).toHaveLength(TUI_OPEN_MAX_ATTEMPTS + 2);
		});

		it("hard deadline aborts an in-flight attempt with cause=deadline and reports once after exit", async () => {
			let deadline!: () => void;
			let observedAbortReason: unknown;
			const lost = vi.fn();
			const deps = makeDeps();
			deps.scheduleTuiDeadline = (fn) => {
				deadline = fn;
				return () => {};
			};
			deps.onTuiWindowLost = lost;
			deps.ensureWindow = (async (_spec, windowDeps) =>
				new Promise<RunnerTuiWindowOutcome>((resolve) => {
					windowDeps.signal?.addEventListener(
						"abort",
						() => {
							observedAbortReason = windowDeps.signal?.reason;
							resolve({
								created: false,
								category: "cancellation",
								reason: "aborted",
								abortCause: "deadline",
							});
						},
						{ once: true },
					);
				})) as CodexDaemonAdapterDeps["ensureWindow"];
			runtime = new FakeRuntime(async (input) => {
				input.onThreadReady?.(THREAD_ID, 0);
				await Promise.resolve();
				deadline();
				await Promise.resolve();
				await Promise.resolve();
				return complete();
			});
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
			expect(observedAbortReason).toBe("deadline");
			expect(lost).toHaveBeenCalledOnce();
			expect(lost.mock.calls[0]?.[0]).toMatchObject({
				trigger: "deadline-exhausted",
				attempts: 1,
				lastFailure: { category: "cancellation", abortCause: "deadline" },
			});
		});

		it("ignores the retired persisted TUI episode timestamp", async () => {
			const episodeStartedAt = 10_000;
			const elapsed = 7 * 60_000;
			const sessionDir = join(process.env.FLYWHEEL_CODEX_SESSION_DIR!, execId);
			mkdirSync(sessionDir, { recursive: true });
			writeFileSync(
				join(sessionDir, "session.json"),
				JSON.stringify({ tuiWindowEpisodeStartedAt: episodeStartedAt }),
			);
			let scheduledFor = -1;
			const deps = makeDeps();
			deps.now = () => episodeStartedAt + elapsed;
			deps.scheduleTuiDeadline = (_fn, ms) => {
				scheduledFor = ms;
				return () => {};
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

			await adapter.execute(ctx());

			expect(scheduledFor).toBe(TUI_OPEN_DEADLINE_MS);
		});

		it("derives the outer deadline from the live tmux ensure env per execution", async () => {
			process.env.FLYWHEEL_TMUX_ENSURE_DEADLINE_MS = "123000";
			let scheduledFor = -1;
			const deps = makeDeps();
			deps.now = () => 0;
			deps.scheduleTuiDeadline = (_fn, ms) => {
				scheduledFor = ms;
				return () => {};
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

			await adapter.execute(ctx());

			expect(scheduledFor).toBe(2 * 123_000 + 60_000);
		});

		it("deduplicates permanent and run-ended terminal triggers", async () => {
			const lost = vi.fn();
			const deps = makeDeps();
			deps.onTuiWindowLost = lost;
			deps.ensureWindow = (async () => ({
				created: false,
				category: "permanent",
				reason: "tmux_absent",
			})) as CodexDaemonAdapterDeps["ensureWindow"];
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
				deps,
			);
			await adapter.execute(ctx());
			expect(lost).toHaveBeenCalledOnce();
			expect(lost.mock.calls[0]?.[0]).toMatchObject({ trigger: "permanent" });
		});

		it("retries a `died` outcome and latches once it finally opens", async () => {
			ensureWindowSeq = [
				{
					created: false,
					category: "retryable-transient-ipc",
					reason: "window_died",
				},
				{
					created: false,
					category: "retryable-transient-ipc",
					reason: "window_died",
				},
				{ created: true, windowId: WINDOW_ID },
			];
			runtime = new FakeRuntime(async (input) => {
				input.onThreadReady?.(THREAD_ID, 0);
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				return complete();
			});
			const res = await makeAdapter().execute(ctx());
			expect(res.success).toBe(true);
			expect(ensureWindowCalls.length).toBe(3); // died, died, created
		});

		it("stops at exactly TUI_OPEN_MAX_ATTEMPTS when every attempt dies (fail-loud, not infinite)", async () => {
			ensureWindowSeq = [
				{
					created: false,
					category: "retryable-transient-ipc",
					reason: "window_died",
				},
			]; // sticky: always dies
			runtime = new FakeRuntime(async (input) => {
				input.onThreadReady?.(THREAD_ID, 0);
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				return complete();
			});
			await makeAdapter().execute(ctx());
			// bounded: exactly the cap, never a MAX+1th attempt.
			expect(ensureWindowCalls.length).toBe(TUI_OPEN_MAX_ATTEMPTS);
		});

		it("does NOT retry a permanent tmux-absent outcome", async () => {
			ensureWindowSeq = [
				{ created: false, category: "permanent", reason: "tmux_absent" },
			];
			runtime = new FakeRuntime(async (input) => {
				input.onThreadReady?.(THREAD_ID, 0);
				return complete();
			});
			await makeAdapter().execute(ctx());
			expect(ensureWindowCalls.length).toBe(1);
		});

		it("every attempt targets the SAME windowName (so the module's same-name purge keeps ≤1 window)", async () => {
			ensureWindowSeq = [
				{
					created: false,
					category: "retryable-transient-ipc",
					reason: "window_died",
				},
				{
					created: false,
					category: "retryable-transient-ipc",
					reason: "window_died",
				},
				{ created: true, windowId: WINDOW_ID },
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

		it("does not add an outcome-time fallback after a permanent failure", async () => {
			ensureWindowSeq = [
				{ created: false, category: "permanent", reason: "tmux_absent" },
			];
			runtime = new FakeRuntime(async (input) => {
				input.onThreadReady?.(THREAD_ID, 0);
				return complete();
			});
			await makeAdapter().execute(ctx());
			expect(ensureWindowCalls.length).toBe(1); // no extra fallback attempt
		});

		it("a throwing pre-spawn observer open is fail-open", async () => {
			ensureWindowSeq = [{ created: true, windowId: WINDOW_ID }];
			const throwingDeps = makeDeps();
			throwingDeps.ensureWindow = (() => {
				ensureWindowCalls.push({});
				throw new Error("observer open failed");
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

		it("cleans a window created after the in-flight ensure outlives teardown join", async () => {
			const events: string[] = [];
			let releaseEnsure!: (outcome: RunnerTuiWindowOutcome) => void;
			const deferred = new Promise<RunnerTuiWindowOutcome>((resolve) => {
				releaseEnsure = resolve;
			});
			const deps = makeDeps();
			deps.ensureWindow = (async () => {
				events.push("ensure-start");
				const result = await deferred;
				events.push("ensure-settled");
				return result;
			}) as CodexDaemonAdapterDeps["ensureWindow"];
			deps.killWindow = (() => {
				events.push("terminal-kill");
			}) as CodexDaemonAdapterDeps["killWindow"];
			deps.cleanupWindows = (async () => {
				events.push("late-cleanup");
			}) as CodexDaemonAdapterDeps["cleanupWindows"];
			deps.tuiJoinTimeoutMs = 1;
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
				deps,
			);

			const result = await adapter.execute(ctx());
			expect(result.success).toBe(true);
			expect(events).toEqual(["ensure-start", "terminal-kill"]);
			releaseEnsure({ created: true, windowId: WINDOW_ID });
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			expect(events).toEqual([
				"ensure-start",
				"terminal-kill",
				"ensure-settled",
				"late-cleanup",
			]);
		});

		it("also cleans a late-created window during request-bound controlled shutdown", async () => {
			const events: string[] = [];
			let releaseEnsure!: (outcome: RunnerTuiWindowOutcome) => void;
			let rejectGoal!: (error: Error) => void;
			const deferred = new Promise<RunnerTuiWindowOutcome>((resolve) => {
				releaseEnsure = resolve;
			});
			const controlledRuntime: CodexDaemonGoalRuntimeLike = {
				runGoal: (input) => {
					input.onThreadReady?.(THREAD_ID, 0);
					return new Promise((_resolve, reject) => {
						rejectGoal = reject;
					});
				},
				stop: () =>
					rejectGoal(new GoalRunError("controlled", "transport_closed")),
				drained: async () => {},
			};
			const lifecycle = {
				start: vi.fn(async () => {}),
				stopIntake: vi.fn(async () => {}),
				stop: vi.fn(async () => {}),
				waitForShutdown: vi.fn(async () => ({ requestId: "shutdown-late" })),
				observe: vi.fn(() => null),
				getPhaseHold: vi.fn(() => null),
				enterHold: vi.fn(async () => {}),
				confirmHoldPaused: vi.fn(async () => {}),
				waitForActivity: vi.fn(async () => {}),
				leaveHold: vi.fn(async () => {}),
				markWakeStarted: vi.fn(),
				finishWake: vi.fn(),
				ackShutdown: vi.fn(),
			};
			const deps = makeDeps();
			deps.runtimeFactory = () => controlledRuntime;
			deps.phaseLifecycleFactory = () => lifecycle;
			deps.ensureWindow = (async () => {
				events.push("ensure-start");
				const result = await deferred;
				events.push("ensure-settled");
				return result;
			}) as CodexDaemonAdapterDeps["ensureWindow"];
			deps.killWindow = (() => {
				events.push("terminal-kill");
			}) as CodexDaemonAdapterDeps["killWindow"];
			deps.cleanupWindows = (async () => {
				events.push("late-cleanup");
			}) as CodexDaemonAdapterDeps["cleanupWindows"];
			deps.tuiJoinTimeoutMs = 1;
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
				ctx({ phaseKeepAlive: { role: "implement" } }),
			);
			expect(result.success).toBe(true);
			expect(events).toEqual(["ensure-start", "terminal-kill"]);
			releaseEnsure({ created: true, windowId: WINDOW_ID });
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			expect(events).toEqual([
				"ensure-start",
				"terminal-kill",
				"ensure-settled",
				"late-cleanup",
			]);
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
			const drainOne = async () => {
				queue.shift()?.();
				await Promise.resolve();
			};
			ensureWindowSeq = [
				{
					created: false,
					category: "retryable-transient-ipc",
					reason: "window_died",
				},
				{
					created: false,
					category: "retryable-transient-ipc",
					reason: "window_died",
				},
				{ created: true, windowId: WINDOW_ID },
			];
			runtime = new FakeRuntime(async (input) => {
				input.onThreadReady?.(THREAD_ID, 0); // queues attempt 1 (not yet run)
				await drainOne(); // attempt 1: died → queues attempt 2
				await drainOne(); // attempt 2: died → queues attempt 3
				await drainOne(); // attempt 3: created → latched, no re-queue
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
			ensureWindowSeq = [
				{
					created: false,
					category: "retryable-transient-ipc",
					reason: "window_died",
				},
			]; // sticky
			runtime = new FakeRuntime(async (input) => {
				input.onThreadReady?.(THREAD_ID, 0);
				// drain the whole queue (each died re-queues the next until the cap)
				let guard = 0;
				while (queue.length && guard++ < 50) {
					queue.shift()?.();
					await Promise.resolve();
				}
				return complete();
			});
			await makeAdapter().execute(ctx());
			expect(ensureWindowCalls.length).toBe(TUI_OPEN_MAX_ATTEMPTS);
			const logs = vi.mocked(console.log).mock.calls.map((c) => String(c[0]));
			const exhaustion = logs.filter((l) =>
				/terminal visibility loss.*deadline-exhausted/.test(l),
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
			ensureWindowSeq = [
				{
					created: false,
					category: "retryable-transient-ipc",
					reason: "window_died",
				},
				{ created: true, windowId: WINDOW_ID },
			];
			runtime = new FakeRuntime(async (input) => {
				input.onThreadReady?.(THREAD_ID, 0); // chain starts; attempt 1 queued (not run)
				input.onThreadReady?.(THREAD_ID, 1); // restart WHILE opening — must NOT queue a 2nd chain
				expect(queue.length).toBe(1); // single-flight: still just one pending attempt
				queue.shift()?.(); // attempt 1 → died → re-queue attempt 2
				await Promise.resolve();
				queue.shift()?.(); // attempt 2 → created
				await Promise.resolve();
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

		it("teardown cancels reopen, drains, then cleans an unpinned observer", async () => {
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
			expect(order.indexOf("cancel")).toBeLessThan(order.indexOf("stop"));
			expect(order.indexOf("stop")).toBeLessThan(order.indexOf("drained"));
			expect(order.indexOf("drained")).toBeLessThan(
				order.indexOf("killWindow"),
			);
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

	it("FLY-2211: persists an immutable, exact launch snapshot before constructing the daemon runtime", async () => {
		const result = await makeAdapter().execute(
			ctx({
				prompt: "exact recovery kick body",
				appendSystemPrompt: "exact system layer",
				model: "gpt-5.5",
				effort: "high",
				skillFrameworkMode: "bare",
				allowedTools: ["Read(**)", "Bash"],
				enablePonytail: true,
				codexSkillDisableNames: ["superpowers:using-superpowers"],
				workflowSubmissionExpected: true,
				founderReviewRequired: true,
				phaseKeepAlive: { role: "implement" },
			}),
		);

		expect(result.success).toBe(true);
		const snapshot = readCodexLaunchSnapshot(execId);
		expect(snapshot).toMatchObject({
			schemaVersion: 1,
			executionId: execId,
			objective: runtime.runGoalInputs[0]?.objective,
			kickText: runtime.runGoalInputs[0]?.kickText,
			launchContext: {
				model: "gpt-5.5",
				effort: "high",
				appsApprovalMode: "never",
				skillFrameworkMode: "bare",
				phaseRole: "implement",
			},
			rehydrationContext: {
				allowedTools: ["Read(**)", "Bash"],
				enablePonytail: true,
				codexSkillDisableNames: ["superpowers:using-superpowers"],
				codexMattSkillsSourceDir: null,
				workflowSubmissionExpected: true,
				founderReviewRequired: true,
			},
		});
		expect(snapshot.launchContext.sandboxWritableRoots).toContain(
			realpathSync(dir),
		);
		expect(snapshot.launchContext.capabilityDigest).toMatch(/^[a-f0-9]{64}$/);
	});

	it("FLY-2211: refuses to overwrite an existing launch snapshot with drifted instructions", async () => {
		await makeAdapter().execute(ctx({ prompt: "original kick" }));
		const before = readCodexLaunchSnapshot(execId);
		capturedOpts = undefined;
		runtime = new FakeRuntime(async () => complete());

		const result = await makeAdapter().execute(ctx({ prompt: "drifted kick" }));

		expect(result.success).toBe(false);
		expect(capturedOpts).toBeUndefined();
		expect(readCodexLaunchSnapshot(execId)).toEqual(before);
	});

	it("FLY-2211: strict snapshot reader rejects legacy session state instead of guessing recovery input", () => {
		const stateDir = join(dir, "codex-sessions", execId);
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			join(stateDir, "session.json"),
			JSON.stringify({
				executionId: execId,
				threadId: "legacy-thread",
				vendor: "codex",
			}),
		);

		expect(() => readCodexLaunchSnapshot(execId)).toThrow(
			/missing immutable launch snapshot/,
		);
	});

	it("FLY-2211: shared ownership rejects a parallel adapter for the same execution", async () => {
		let settleFirst: ((outcome: RunGoalOutcome) => void) | undefined;
		let calls = 0;
		runtime = new FakeRuntime(async (input) => {
			calls += 1;
			input.onThreadReady?.(THREAD_ID, 0);
			if (calls > 1) return complete();
			return new Promise<RunGoalOutcome>((resolve) => {
				settleFirst = resolve;
			});
		});

		const first = makeAdapter().execute(ctx());
		await vi.waitFor(() => expect(runtime.runGoalInputs).toHaveLength(1));
		expect(executionOwners.isExecutionOwned(execId)).toBe(true);
		const duplicate = await makeAdapter().execute(ctx());

		expect(duplicate.success).toBe(false);
		expect(runtime.runGoalInputs).toHaveLength(1);
		settleFirst?.(complete());
		expect((await first).success).toBe(true);
		expect(executionOwners.isExecutionOwned(execId)).toBe(false);
	});

	it("FLY-2211: resumeExistingExecution reuses exact snapshot input and awaits the hard receipt commit", async () => {
		await makeAdapter().execute(ctx({ prompt: "original recovery kick" }));
		const snapshot = readCodexLaunchSnapshot(execId);
		const commit = vi.fn(async () => {});
		runtime = new FakeRuntime(async (input) => {
			input.onThreadReady?.(THREAD_ID, 0);
			await input.onRecoveryOwnershipEstablished?.({
				kind: "turn_started",
				threadId: THREAD_ID,
				turnId: "turn-rescued",
			});
			return complete();
		});

		const result = await makeAdapter().resumeExistingExecution(
			ctx({ prompt: "must not reconstruct this kick" }),
			{ onRecoveryOwnershipEstablished: commit },
		);

		expect(result.success).toBe(true);
		expect(runtime.runGoalInputs[0]?.objective).toBe(snapshot.objective);
		expect(runtime.runGoalInputs[0]?.kickText).toBe(snapshot.kickText);
		expect(commit).toHaveBeenCalledWith({
			kind: "turn_started",
			threadId: THREAD_ID,
			turnId: "turn-rescued",
		});
		expect(executionOwners.isExecutionOwned(execId)).toBe(false);
	});

	it("FLY-2211: a failed recovery commit tears down and releases ownership", async () => {
		await makeAdapter().execute(ctx({ prompt: "original recovery kick" }));
		runtime = new FakeRuntime(async (input) => {
			input.onThreadReady?.(THREAD_ID, 0);
			await input.onRecoveryOwnershipEstablished?.({
				kind: "turn_started",
				threadId: THREAD_ID,
				turnId: "turn-rescued",
			});
			return complete();
		});

		const result = await makeAdapter().resumeExistingExecution(ctx(), {
			onRecoveryOwnershipEstablished: async () => {
				throw new Error("revision fence lost");
			},
		});

		expect(result.success).toBe(false);
		expect(runtime.stopped).toBe(1);
		expect(runtime.drainedCalls).toBe(1);
		expect(executionOwners.isExecutionOwned(execId)).toBe(false);
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

	it.each(["latch-first", "session-first"] as const)(
		"FLY-1940: atomic session writers preserve gateHold + threadId + daemonPgid (%s)",
		async (order) => {
			runtime = new FakeRuntime(async (input) => {
				if (order === "latch-first") input.writeGateHoldLatch?.(true);
				input.onSpawnIdentity?.(4321);
				input.onThreadReady?.(THREAD_ID, 0);
				if (order === "session-first") input.writeGateHoldLatch?.(true);
				return complete();
			});
			const res = await makeAdapter().execute(ctx());
			expect(res.success).toBe(true);
			const stateDir = join(dir, "codex-sessions", execId);
			const state = JSON.parse(
				readFileSync(join(stateDir, "session.json"), "utf-8"),
			);
			expect(state).toMatchObject({
				gateHold: true,
				threadId: THREAD_ID,
				daemonPgid: 4321,
			});
			expect(readdirSync(stateDir)).toEqual(["session.json"]);
		},
	);

	it("FLY-1257: Bridge re-execute restores the durable gate-hold latch from session.json", async () => {
		const stateDir = join(dir, "codex-sessions", execId);
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(
			join(stateDir, "session.json"),
			JSON.stringify({
				executionId: execId,
				threadId: "persisted-thread",
				daemonPgid: 4321,
				gateHold: true,
				unknownFutureField: "preserve-me",
			}),
		);
		let restored: boolean | undefined;
		runtime = new FakeRuntime(async (input) => {
			restored = input.readGateHoldLatch?.();
			input.onThreadReady?.("persisted-thread", 0);
			input.writeGateHoldLatch?.(false);
			return complete("persisted-thread");
		});
		const res = await makeAdapter().execute(ctx());
		expect(res.success).toBe(true);
		expect(restored).toBe(true);
		const state = JSON.parse(
			readFileSync(join(stateDir, "session.json"), "utf-8"),
		);
		expect(state).toMatchObject({
			gateHold: false,
			threadId: "persisted-thread",
			daemonPgid: 4321,
			unknownFutureField: "preserve-me",
		});
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
		expect(killWindowCalls).toHaveLength(1);
	});

	it("FLY-1279: a blocked goal preserves a typed failure and blocked CommDB status", async () => {
		runtime = new FakeRuntime(async () => ({
			threadId: THREAD_ID,
			result: {
				status: "blocked",
				tokensUsed: 9,
				turns: 3,
				succeeded: false,
			},
			restarts: 0,
		}));

		const res = await makeAdapter().execute(ctx());

		expect(res.success).toBe(false);
		expect(res.failure).toEqual({
			failureKind: "goal_blocked",
			failureReason: "goal ended non-complete: blocked",
		});
		const db = new CommDB(dbPath);
		expect(db.getSession(execId)?.status).toBe("blocked");
		db.close();
		expect(killWindowCalls).toHaveLength(1);
		expect(transcriptCloses).toEqual(["blocked"]);
	});

	it("FLY-2018: an owned unauthorized turn preserves the environment failure classification", async () => {
		runtime = new FakeRuntime(async () => ({
			threadId: THREAD_ID,
			result: {
				status: "blocked",
				tokensUsed: 9,
				turns: 1,
				succeeded: false,
				lastTurnError: {
					turnId: "turn-owned",
					message: "refresh token revoked",
					code: "unauthorized",
				},
			},
			restarts: 0,
		}));

		const res = await makeAdapter().execute(ctx());

		expect(res.failure).toEqual({
			failureKind: "goal_blocked",
			failureReason:
				"goal ended non-complete: blocked — last turn error: refresh token revoked [unauthorized]",
			failureClass: "environment",
			failureCode: "codex:unauthorized",
		});
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

	it("a thrown non-timeout failure drains the daemon and retires the TUI", async () => {
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

	it("keeps session state pending until an immutable window id commits", async () => {
		const queue: Array<() => void> = [];
		reopenScheduler = (fn) => {
			queue.push(fn);
			return () => {};
		};
		runtime = new FakeRuntime(async (input) => {
			input.onSpawnIdentity?.(4321);
			input.onThreadReady?.(THREAD_ID, 0);
			const pendingDb = new CommDB(dbPath);
			try {
				expect(pendingDb.getSession(execId)).toMatchObject({
					tmux_window: "testsess:pending",
					vendor: "codex",
				});
			} finally {
				pendingDb.close();
			}
			const pendingState = JSON.parse(
				readFileSync(
					join(dir, "codex-sessions", execId, "session.json"),
					"utf8",
				),
			);
			expect(pendingState).toMatchObject({
				threadId: THREAD_ID,
				daemonPgid: 4321,
				cwd: dir,
			});
			expect(pendingState).not.toHaveProperty("tmuxWindow");
			queue.shift()?.();
			await vi.waitFor(() => {
				const committed = JSON.parse(
					readFileSync(
						join(dir, "codex-sessions", execId, "session.json"),
						"utf8",
					),
				);
				expect(committed.tmuxWindow).toBe(`testsess:${WINDOW_ID}`);
			});
			return complete();
		});
		await makeAdapter().execute(ctx());
	});

	it("pins CommDB registration before retiring the native TUI", async () => {
		await makeAdapter().execute(ctx());
		const db = new CommDB(dbPath);
		const sess = db.getSession(execId);
		db.close();
		expect(sess?.tmux_window).toBe(`testsess:${WINDOW_ID}`);
		expect(killWindowCalls).toHaveLength(1);
	});

	it("kills the observer when immutable CommDB pinning affects no row", async () => {
		vi.spyOn(CommDB.prototype, "updateSessionTmuxWindow").mockReturnValue(0);

		await makeAdapter().execute(ctx());

		expect(killWindowCalls).toContainEqual({
			tmuxSession: "testsess",
			windowName: "FLY-1188",
			windowId: WINDOW_ID,
		});
	});

	it("kills the observer when CommDB terminal closeout fails", async () => {
		vi.spyOn(
			CommDB.prototype,
			"updateSessionStatusIfRunning",
		).mockImplementation(() => {
			throw new Error("closeout unavailable");
		});

		await makeAdapter().execute(ctx());

		expect(killWindowCalls).toContainEqual({
			tmuxSession: "testsess",
			windowName: "FLY-1188",
			windowId: WINDOW_ID,
		});
	});

	it("FLY-1940: persists the live daemon group before thread-ready, then reaps it on resume", async () => {
		// Run 1: the daemon reports its pid, then OUR thread becomes ready →
		// onSpawnIdentity writes daemonPgid before thread-ready adds threadId.
		runtime = new FakeRuntime(async (input) => {
			input.onSpawnIdentity?.(4321);
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
