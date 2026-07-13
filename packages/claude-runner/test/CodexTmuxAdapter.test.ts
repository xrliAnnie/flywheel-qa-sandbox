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
import { CodexTmuxAdapter } from "../src/CodexTmuxAdapter.js";
import { GoalRunError } from "../src/codex-daemon-client.js";
import type {
	CodexDaemonGoalRuntimeOptions,
	RunGoalInput,
	RunGoalOutcome,
} from "../src/codex-daemon-goal-runtime.js";

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
	let ensureWindowReturns: boolean;
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
				return ensureWindowReturns;
			}) as CodexDaemonAdapterDeps["ensureWindow"],
			killWindow: ((spec: Record<string, unknown>) => {
				killWindowCalls.push(spec);
			}) as CodexDaemonAdapterDeps["killWindow"],
			windowAlive: () => windowAliveReturns,
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
		ensureWindowReturns = true;
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

	it("folds the appendSystemPrompt into the goal objective (no --append flag)", async () => {
		await makeAdapter().execute(ctx({ appendSystemPrompt: "SYSTEM RULES" }));
		const obj = runtime.runGoalInputs[0]?.objective ?? "";
		expect(obj).toContain("SYSTEM RULES");
		expect(obj).toContain("do the task");
		expect(obj.indexOf("SYSTEM RULES")).toBeLessThan(
			obj.indexOf("do the task"),
		);
	});

	it("FLY-615: enablePonytail injects the ponytail ruleset into the objective", async () => {
		await makeAdapter().execute(ctx({ enablePonytail: true }));
		expect(runtime.runGoalInputs[0]?.objective ?? "").toMatch(/ponytail/i);
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

	it("MEDIUM-1: a failing ensureWindow does NOT latch — the outcome fallback retries", async () => {
		ensureWindowReturns = false; // every ensureWindow attempt fails
		runtime = new FakeRuntime(async (input) => {
			input.onThreadReady?.(THREAD_ID, 0);
			return complete();
		});
		await makeAdapter().execute(ctx());
		// onThreadReady attempt + outcome-fallback attempt = 2 (would be 1 if the
		// failed attempt had latched tuiOpened)
		expect(ensureWindowCalls.length).toBeGreaterThanOrEqual(2);
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
});
