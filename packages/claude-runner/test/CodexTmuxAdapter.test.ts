/**
 * FLY-123: CodexTmuxAdapter — §5.6 state machine unit tests with a fake
 * tmux + fake helper (the helper's own behavior is covered by
 * flywheel-comm codex-resume tests; real tmux/codex coverage is the
 * integration spike harness — plan §6 real-tool row).
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
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
import { CodexTmuxAdapter } from "../src/CodexTmuxAdapter.js";

const THREAD_ID = "019e9006-0b8e-72b0-bb80-9100d85473cf";
const WINDOW_ID = "@7";

/**
 * Fake tmux/codex exec layer. send-keys triggers an async "helper run":
 * the harness parses --state from the injected command, reads the state
 * file and emits jsonl + last message + done marker per the scenario.
 */
class FakeTmux {
	paneDead = false;
	paneCommand = "zsh";
	paneTail = "user@host dir %";
	/** list-clients output for the base session ("" = unattached). */
	attachedClients = "";
	/** display-message window name (set from new-window -n; overridable). */
	windowName = "";
	sendKeys: string[] = [];
	newWindowArgs: string[] = [];
	killWindowArgs: string[][] = [];
	/** Scenario hook: called per cycle with (cycle, state) — returns exit code etc. */
	onCycle: (
		cycle: number,
		state: Record<string, unknown>,
	) => { exitCode: number; lastMessage?: string; emitThread?: boolean } =
		() => ({
			exitCode: 0,
			lastMessage: "done",
			emitThread: true,
		});
	private cycleCount = 0;

	exec = (cmd: string, args: string[]): { stdout: string } => {
		if (cmd === "tmux") {
			const sub = args[0];
			switch (sub) {
				case "-V":
					return { stdout: "tmux 3.4" };
				case "kill-window":
					this.killWindowArgs.push(args);
					return { stdout: "" };
				case "has-session":
				case "set-option":
					return { stdout: "" };
				case "new-window": {
					this.newWindowArgs = args;
					const nameIdx = args.indexOf("-n");
					if (nameIdx >= 0 && !this.windowName) {
						this.windowName = args[nameIdx + 1] as string;
					}
					return { stdout: `${WINDOW_ID}\n` };
				}
				case "display-message":
					return { stdout: `${this.windowName}\n` };
				case "list-clients":
					return { stdout: this.attachedClients };
				case "list-panes": {
					const fmt = args[args.indexOf("-F") + 1];
					if (fmt?.includes("pane_current_command")) {
						return {
							stdout: `${this.paneDead ? "1" : "0"}|${this.paneCommand}`,
						};
					}
					return { stdout: this.paneDead ? "1" : "0" };
				}
				case "capture-pane":
					return { stdout: `scrollback\n${this.paneTail}\n` };
				case "send-keys": {
					const cmdLine = args[args.length - 2] as string;
					this.sendKeys.push(cmdLine);
					this.runHelper(cmdLine);
					return { stdout: "" };
				}
				default:
					return { stdout: "" };
			}
		}
		if (cmd === "codex") return { stdout: "codex-cli 0.135.0" };
		if (cmd === "which")
			return { stdout: "/usr/local/bin/codex-with-fallback" };
		if (cmd === "gh") {
			// FLY-209: gh auth token extraction (overridable per test)
			if (this.ghAuthThrows) throw new Error("gh: not logged in");
			return { stdout: `${this.ghToken}\n` };
		}
		if (cmd === "git") {
			this.gitConfigCalls.push(args);
			return { stdout: "" };
		}
		return { stdout: "" };
	};

	// FLY-209 knobs
	ghToken = "ghp_FAKE-123_456";
	ghAuthThrows = false;
	gitConfigCalls: string[][] = [];

	private runHelper(cmdLine: string): void {
		const m = cmdLine.match(/--state (\S+)/);
		if (!m) throw new Error(`no --state in injected command: ${cmdLine}`);
		const statePath = m[1] as string;
		const state = JSON.parse(readFileSync(statePath, "utf-8")) as Record<
			string,
			unknown
		>;
		const cycle = this.cycleCount++;
		const outcome = this.onCycle(cycle, state);
		// async, like the real helper
		setTimeout(() => {
			if (outcome.emitThread !== false) {
				writeFileSync(
					state.jsonlPath as string,
					`${JSON.stringify({ type: "thread.started", thread_id: THREAD_ID })}\n`,
				);
			}
			if (outcome.lastMessage !== undefined) {
				writeFileSync(state.lastMessagePath as string, outcome.lastMessage);
			}
			writeFileSync(
				state.doneMarkerPath as string,
				JSON.stringify({
					exitCode: outcome.exitCode,
					ts: new Date().toISOString(),
					mode: state.mode,
				}),
			);
		}, 10);
	}
}

describe("CodexTmuxAdapter (FLY-123 §5.6 state machine)", () => {
	let dir: string;
	let markerDir: string;
	let sessionDirBase: string;
	let dbPath: string;
	let fake: FakeTmux;
	let adapter: CodexTmuxAdapter;
	let execId: string;

	const origMarkerEnv = process.env.FLYWHEEL_GATE_MARKER_DIR;
	const origSessionEnv = process.env.FLYWHEEL_CODEX_SESSION_DIR;
	const origHomesEnv = process.env.FLYWHEEL_CODEX_HOMES_ROOT;
	const origSrcEnv = process.env.FLYWHEEL_CODEX_SOURCE_HOME;
	let homesRoot: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly123-codex-adapter-"));
		markerDir = join(dir, "codex-gates");
		sessionDirBase = join(dir, "codex-sessions");
		dbPath = join(dir, "comm.db");
		process.env.FLYWHEEL_GATE_MARKER_DIR = markerDir;
		process.env.FLYWHEEL_CODEX_SESSION_DIR = sessionDirBase;
		// FLY-123 WS-A: per-runner CODEX_HOME provisioning — point the home root
		// and the seed source ~/.codex at temp dirs so tests never touch the
		// real ~/.codex / ~/.flywheel.
		homesRoot = join(dir, "codex-homes");
		const srcCodex = join(dir, "dotcodex");
		mkdirSync(join(srcCodex, "profiles", "personal"), { recursive: true });
		writeFileSync(join(srcCodex, "auth.json"), '{"tokens":{"a":1}}');
		writeFileSync(join(srcCodex, "config.toml"), 'model = "gpt-5-codex"\n');
		process.env.FLYWHEEL_CODEX_HOMES_ROOT = homesRoot;
		process.env.FLYWHEEL_CODEX_SOURCE_HOME = srcCodex;
		fake = new FakeTmux();
		execId = `exec-${Math.random().toString(36).slice(2, 10)}`;
		adapter = new CodexTmuxAdapter("testsess", fake.exec, 25, 60_000);
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		if (origMarkerEnv === undefined)
			delete process.env.FLYWHEEL_GATE_MARKER_DIR;
		else process.env.FLYWHEEL_GATE_MARKER_DIR = origMarkerEnv;
		if (origSessionEnv === undefined)
			delete process.env.FLYWHEEL_CODEX_SESSION_DIR;
		else process.env.FLYWHEEL_CODEX_SESSION_DIR = origSessionEnv;
		if (origHomesEnv === undefined)
			delete process.env.FLYWHEEL_CODEX_HOMES_ROOT;
		else process.env.FLYWHEEL_CODEX_HOMES_ROOT = origHomesEnv;
		if (origSrcEnv === undefined) delete process.env.FLYWHEEL_CODEX_SOURCE_HOME;
		else process.env.FLYWHEEL_CODEX_SOURCE_HOME = origSrcEnv;
		vi.restoreAllMocks();
	});

	function ctx(
		overrides?: Partial<AdapterExecutionContext>,
	): AdapterExecutionContext {
		return {
			executionId: execId,
			issueId: "FLY-123",
			prompt: "do the task",
			cwd: dir,
			commDbPath: dbPath,
			leadId: "product-lead",
			projectName: "proj",
			waitingTimeoutMs: 1_500, // short gate deadline for tests
			...overrides,
		};
	}

	it("type + no streaming", () => {
		expect(adapter.type).toBe("codex-tmux");
		expect(adapter.supportsStreaming).toBe(false);
	});

	// Codex R5 HIGH-3: the durable COMMIT is written the instant BEFORE the codex
	// `send-keys` injection (the commit point) — so the dispatcher adopts a replay
	// only once codex is actually injected; a crash before injection leaves NO
	// commit and the dispatcher re-drives (never adopts the idle bare shell).
	it("R5: writes the durable commit IMMEDIATELY before the codex send-keys injection", async () => {
		const dir2 = mkdtempSync(join(tmpdir(), "fly245-codex-commit-"));
		try {
			const commitFile = join(dir2, "succ-9");
			fake.onCycle = () => ({ exitCode: 0, lastMessage: "ok" });
			expect(existsSync(commitFile)).toBe(false);
			const result = await adapter.execute(
				ctx({ launchCommitPath: commitFile }),
			);
			expect(result.success).toBe(true);
			// codex was injected (the FLY-123 helper command) AND the commit exists
			expect(fake.sendKeys).toHaveLength(1);
			expect(fake.sendKeys[0]).toMatch(/^node \S+ codex-resume --state \S+$/);
			expect(existsSync(commitFile)).toBe(true);
		} finally {
			rmSync(dir2, { recursive: true, force: true });
		}
	});

	it("R5: the NON-gateway path (no launchCommitPath) writes NO commit (byte-unchanged injection)", async () => {
		fake.onCycle = () => ({ exitCode: 0, lastMessage: "ok" });
		const result = await adapter.execute(ctx());
		expect(result.success).toBe(true);
		expect(fake.sendKeys).toHaveLength(1);
		// nothing extra — same fixed-shape injection
		expect(fake.sendKeys[0]).toMatch(/^node \S+ codex-resume --state \S+$/);
	});

	it("happy path: fresh cycle, no gate → terminal success with threadId + resultText", async () => {
		fake.onCycle = () => ({ exitCode: 0, lastMessage: "ALL DONE" });
		const result = await adapter.execute(ctx());
		expect(result.success).toBe(true);
		expect(result.sessionId).toBe(THREAD_ID);
		expect(result.resultText).toBe("ALL DONE");
		expect(result.sessionParams).toMatchObject({
			vendor: "codex",
			threadId: THREAD_ID,
		});
		expect(result.tmuxWindow).toBe(`testsess:${WINDOW_ID}`);
		// exactly one injected helper command, fixed shape
		expect(fake.sendKeys).toHaveLength(1);
		expect(fake.sendKeys[0]).toMatch(/^node \S+ codex-resume --state \S+$/);
	});

	it("fresh state file: mode=fresh, workspace-write sandbox, NO claude flags", async () => {
		let captured: Record<string, unknown> | null = null;
		fake.onCycle = (_cycle, state) => {
			captured = state;
			return { exitCode: 0, lastMessage: "ok" };
		};
		await adapter.execute(
			ctx({ permissionMode: "bypassPermissions", allowedTools: ["Bash"] }),
		);
		expect(captured).toBeTruthy();
		const state = captured as unknown as Record<string, unknown>;
		expect(state.mode).toBe("fresh");
		expect(state.sandbox).toBe("workspace-write");
		// R1 #9: Blueprint's claude-only fields must be DROPPED, not translated
		expect(JSON.stringify(state)).not.toMatch(
			/permission|allowed-tools|append-system-prompt|bypassPermissions/,
		);
		// QA Finding 1: flywheel protocol surface must be writable + network on
		const roots = state.writableRoots as string[];
		expect(roots).toContain(markerDir); // env-redirected marker dir included
		expect(roots.some((r) => r.endsWith(".flywheel"))).toBe(true);
		expect(roots).toContain(join(dir, "")); // commDbPath parent (= dir)
		expect(state.networkAccess).toBe(true);
	});

	it("appendSystemPrompt is folded into the prompt file (no flag)", async () => {
		let promptText = "";
		fake.onCycle = (_c, state) => {
			promptText = readFileSync(state.promptPath as string, "utf-8");
			return { exitCode: 0, lastMessage: "ok" };
		};
		await adapter.execute(ctx({ appendSystemPrompt: "SYSTEM RULES HERE" }));
		expect(promptText).toContain("SYSTEM RULES HERE");
		expect(promptText).toContain("do the task");
	});

	it("gate loop: exit+marker → awaiting_gate → CommDB answer → resume cycle with threadId → terminal", async () => {
		const db = new CommDB(dbPath);
		const questionId = db.insertQuestion(
			execId,
			"product-lead",
			"Which color?",
			{
				checkpoint: "question",
			},
		);

		const cycleStates: Array<Record<string, unknown>> = [];
		fake.onCycle = (cycle, state) => {
			cycleStates.push(state);
			if (cycle === 0) {
				// runner registers the gate and exits (gate-register would do this)
				writeGateMarker(markerDir, {
					questionId,
					executionId: execId,
					backend: "codex-tmux",
					vendor: "codex",
					checkpoint: "question",
				});
				// Lead answers shortly after the runner goes idle
				setTimeout(() => {
					db.insertResponse(questionId, "product-lead", "blue, please");
				}, 120);
				return { exitCode: 0, lastMessage: "GATE-QUESTION: which color?" };
			}
			return { exitCode: 0, lastMessage: "config updated" };
		};

		const result = await adapter.execute(ctx());
		db.close();

		expect(result.success).toBe(true);
		expect(fake.sendKeys).toHaveLength(2);

		// cycle 2 is a RESUME with the captured thread id and the Lead reply
		const resume = cycleStates[1] as Record<string, unknown>;
		expect(resume.mode).toBe("resume");
		expect(resume.threadId).toBe(THREAD_ID);
		const replyPrompt = readFileSync(resume.promptPath as string, "utf-8");
		expect(replyPrompt).toContain("blue, please");
		expect(replyPrompt).toContain("LEAD RESPONSE");

		// marker cleared after resume
		expect(listGateMarkersForExecution(markerDir, execId)).toEqual([]);
		expect(result.resultText).toBe("config updated");
	});

	it("gate deadline expiry → fail-close: question expired, marker cleared, gate_timed_out emitted", async () => {
		const db = new CommDB(dbPath);
		const questionId = db.insertQuestion(execId, "product-lead", "stuck?", {
			checkpoint: "question",
		});
		db.close();

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));

		fake.onCycle = () => {
			writeGateMarker(markerDir, {
				questionId,
				executionId: execId,
				backend: "codex-tmux",
				vendor: "codex",
				checkpoint: "question",
			});
			return { exitCode: 0, lastMessage: "waiting" };
		};

		const result = await adapter.execute(
			ctx({
				waitingTimeoutMs: 300,
				bridgeUrl: "http://127.0.0.1:9999",
			}),
		);

		expect(result.success).toBe(false);
		expect(result.timedOut).toBe(true);
		expect(listGateMarkersForExecution(markerDir, execId)).toEqual([]);

		// question expired (no longer pending)
		const check = CommDB.openReadonly(dbPath);
		const q = check.getMessageById(questionId);
		expect(q?.resolved_at).not.toBeNull();
		check.close();

		// FLY-159-isomorphic event emitted
		const gateCall = fetchSpy.mock.calls.find(([url]) =>
			String(url).endsWith("/events"),
		);
		expect(gateCall).toBeTruthy();
		const body = JSON.parse(String(gateCall?.[1]?.body));
		expect(body.event_type).toBe("gate_timed_out");
		expect(body.payload.question_id).toBe(questionId);
		expect(body.payload.timeout_behavior).toBe("fail-close");
	});

	it("non-zero codex exit → failure result", async () => {
		fake.onCycle = () => ({ exitCode: 3, lastMessage: "boom" });
		const result = await adapter.execute(ctx());
		expect(result.success).toBe(false);
		expect(result.timedOut).toBe(false);
	});

	it("idle gate: busy pane (codex running) → refuses injection and fails loud", async () => {
		fake.paneCommand = "node"; // not a shell — mid-run
		const fast = new CodexTmuxAdapter("testsess", fake.exec, 10, 60_000);
		// shrink the retry budget via short-circuit: pane never idles
		await expect(fast.execute(ctx())).rejects.toThrow(
			/never reached idle shell prompt/,
		);
		expect(fake.sendKeys).toHaveLength(0);
	}, 60_000);

	it("idle gate MEDIUM-3: attached client on base session → refuses injection", async () => {
		fake.attachedClients = "/dev/ttys001: someone attached\n";
		const fast = new CodexTmuxAdapter("testsess", fake.exec, 10, 60_000);
		await expect(fast.execute(ctx())).rejects.toThrow(
			/never reached idle shell prompt/,
		);
		expect(fake.sendKeys).toHaveLength(0);
	}, 60_000);

	it("idle gate MEDIUM-3: window name drifted (unmanaged) → refuses injection", async () => {
		fake.windowName = "some-other-window"; // pre-set: new-window won't overwrite
		const fast = new CodexTmuxAdapter("testsess", fake.exec, 10, 60_000);
		await expect(fast.execute(ctx())).rejects.toThrow(
			/never reached idle shell prompt/,
		);
		expect(fake.sendKeys).toHaveLength(0);
	}, 60_000);

	it("HIGH-1 regression: Lead answers BEFORE the adapter observes the cycle exit → still resumes (not terminal)", async () => {
		const db = new CommDB(dbPath);
		const questionId = db.insertQuestion(execId, "product-lead", "fast?", {
			checkpoint: "question",
		});
		const cycleStates: Array<Record<string, unknown>> = [];
		fake.onCycle = (cycle, state) => {
			cycleStates.push(state);
			if (cycle === 0) {
				// Runner registers the gate, Lead answers IMMEDIATELY — response
				// + answeredAt marker land before the adapter sees the done
				// marker (the R1 HIGH-1 race).
				writeGateMarker(markerDir, {
					questionId,
					executionId: execId,
					backend: "codex-tmux",
					vendor: "codex",
					checkpoint: "question",
					answeredAt: new Date().toISOString(), // respond already marked it
				});
				db.insertResponse(questionId, "product-lead", "instant answer");
				return { exitCode: 0, lastMessage: "GATE-QUESTION: fast?" };
			}
			return { exitCode: 0, lastMessage: "resumed fine" };
		};

		const result = await adapter.execute(ctx());
		db.close();

		expect(result.success).toBe(true);
		expect(fake.sendKeys).toHaveLength(2); // resume DID happen
		const replyPrompt = readFileSync(
			(cycleStates[1] as Record<string, unknown>).promptPath as string,
			"utf-8",
		);
		expect(replyPrompt).toContain("instant answer");
		expect(listGateMarkersForExecution(markerDir, execId)).toEqual([]);
	});

	it("HIGH-2 regression: marker's configured short timeout honored (not ctx 49h fallback)", async () => {
		const db = new CommDB(dbPath);
		const questionId = db.insertQuestion(execId, "product-lead", "short gate", {
			checkpoint: "question",
		});
		db.close();
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));

		fake.onCycle = () => {
			writeGateMarker(markerDir, {
				questionId,
				executionId: execId,
				backend: "codex-tmux",
				vendor: "codex",
				checkpoint: "question",
				timeoutMs: 200, // configured 200ms — must beat the huge ctx fallback
				timeoutBehavior: "fail-close",
				timeoutBehaviorSource: "flag",
				message: "short gate original message",
			});
			return { exitCode: 0, lastMessage: "waiting" };
		};

		const started = Date.now();
		const result = await adapter.execute(
			ctx({
				waitingTimeoutMs: 3_600_000, // 1h fallback — must NOT be used
				bridgeUrl: "http://127.0.0.1:9999",
			}),
		);
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(result.success).toBe(false);
		expect(result.timedOut).toBe(true);

		const gateCall = fetchSpy.mock.calls.find(([url]) =>
			String(url).endsWith("/events"),
		);
		const body = JSON.parse(String(gateCall?.[1]?.body));
		expect(body.payload.timeout_behavior).toBe("fail-close");
		expect(body.payload.timeout_behavior_source).toBe("flag");
		expect(body.payload.original_message).toBe("short gate original message");
	});

	it("HIGH-2 regression: fail-open gate timeout resumes with a continue prompt, no gate_timed_out", async () => {
		const db = new CommDB(dbPath);
		const questionId = db.insertQuestion(execId, "product-lead", "soft gate", {
			checkpoint: "review_hint",
		});
		db.close();
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));

		const cycleStates: Array<Record<string, unknown>> = [];
		fake.onCycle = (cycle, state) => {
			cycleStates.push(state);
			if (cycle === 0) {
				writeGateMarker(markerDir, {
					questionId,
					executionId: execId,
					backend: "codex-tmux",
					vendor: "codex",
					checkpoint: "review_hint",
					timeoutMs: 200,
					timeoutBehavior: "fail-open",
				});
				return { exitCode: 0, lastMessage: "asked softly" };
			}
			return { exitCode: 0, lastMessage: "continued per fail-open" };
		};

		const result = await adapter.execute(
			ctx({ waitingTimeoutMs: 3_600_000, bridgeUrl: "http://127.0.0.1:9999" }),
		);
		expect(result.success).toBe(true); // fail-open continues, NOT terminal failure
		expect(result.timedOut).toBe(false);
		expect(fake.sendKeys).toHaveLength(2);
		const resumePrompt = readFileSync(
			(cycleStates[1] as Record<string, unknown>).promptPath as string,
			"utf-8",
		);
		expect(resumePrompt).toContain("GATE TIMEOUT (fail-open)");
		// no gate_timed_out emitted for fail-open (FLY-159 parity)
		const gateCall = fetchSpy.mock.calls.find(
			([url, init]) =>
				String(url).endsWith("/events") &&
				String(init?.body).includes("gate_timed_out"),
		);
		expect(gateCall).toBeUndefined();
		expect(listGateMarkersForExecution(markerDir, execId)).toEqual([]);
	});

	it("window env carries the codex gate protocol vars", async () => {
		fake.onCycle = () => ({ exitCode: 0, lastMessage: "ok" });
		await adapter.execute(ctx());
		const env = fake.newWindowArgs.join(" ");
		expect(env).toContain(`FLYWHEEL_GATE_MARKER_DIR=${markerDir}`);
		expect(env).toContain("FLYWHEEL_RUNNER_BACKEND_ID=codex-tmux");
		expect(env).toContain("FLYWHEEL_RUNNER_VENDOR_ID=codex");
		expect(env).toContain(`FLYWHEEL_EXEC_ID=${execId}`);
		// bare shell window: new-window must NOT end with a binary to run
		expect(fake.newWindowArgs[fake.newWindowArgs.length - 1]).toBe(dir); // -c <cwd> is last
	});

	it("session state file persists threadId at discovery (crash recovery)", async () => {
		fake.onCycle = () => ({ exitCode: 0, lastMessage: "ok" });
		await adapter.execute(ctx());
		const sessionState = JSON.parse(
			readFileSync(join(sessionDirBase, execId, "session.json"), "utf-8"),
		);
		expect(sessionState.threadId).toBe(THREAD_ID);
		expect(sessionState.vendor).toBe("codex");
	});

	describe("FLY-209 + FLY-123 WS-C credentials (token in $CODEX_HOME/config.toml, never argv/state)", () => {
		const homeConfig = () =>
			readFileSync(join(homesRoot, execId, "config.toml"), "utf-8");

		it("token → 0600 config.toml in the per-runner home; NEVER the cycle state; CODEX_HOME set in window env; git helper configured", async () => {
			const states: Array<Record<string, unknown>> = [];
			// Capture the live config DURING a cycle — the finally scrubs the
			// token at terminal, so presence must be asserted mid-run.
			let cfgDuringRun = "";
			fake.onCycle = (_cycle, state) => {
				states.push(state);
				cfgDuringRun ||= homeConfig();
				return { exitCode: 0, lastMessage: "done" };
			};
			await adapter.execute(ctx());

			// WS-C: token is delivered via the per-runner config.toml...
			expect(cfgDuringRun).toContain('GH_TOKEN = "ghp_FAKE-123_456"');
			expect(cfgDuringRun).toContain("[shell_environment_policy.set]");
			expect(cfgDuringRun).toContain('model = "gpt-5-codex"'); // seeded base
			// ...and NEVER the cycle state file (no second plaintext copy).
			for (const s of states) {
				expect(s.ghToken).toBeUndefined();
			}
			// WS-A: CODEX_HOME injected into the tmux window env, mode 0600 config.
			expect(fake.newWindowArgs).toContain(
				`CODEX_HOME=${join(homesRoot, execId)}`,
			);
			expect(
				statSync(join(homesRoot, execId, "config.toml")).mode & 0o777,
			).toBe(0o600);
			// R1 HIGH #1: inherited GitHub-token env BLANKED in the window so it
			// never reaches node/shim/codex process env (ps-visible).
			expect(fake.newWindowArgs).toContain("GH_TOKEN=");
			expect(fake.newWindowArgs).toContain("GITHUB_TOKEN=");
			// git credential helper still configured on the worktree.
			const gitCfg = fake.gitConfigCalls.find((a) =>
				a.includes("credential.https://github.com.helper"),
			);
			expect(gitCfg).toBeTruthy();
			expect(gitCfg).toContain("!gh auth git-credential");
			expect(gitCfg).toContain(dir); // -C <cwd>
		});

		it("P5: credential scrubbed from the retained home on terminal completion", async () => {
			fake.onCycle = () => ({ exitCode: 0, lastMessage: "done" });
			await adapter.execute(ctx());
			// terminal → finally scrubs the live token, home/config retained.
			const cfg = homeConfig();
			expect(cfg).not.toContain("GH_TOKEN");
			expect(cfg).not.toContain("shell_environment_policy");
			expect(cfg).toContain('model = "gpt-5-codex"');
		});

		it("gh not authenticated → fail-open: no token in config, no git config, run still proceeds", async () => {
			fake.ghAuthThrows = true;
			fake.onCycle = (_c, state) => {
				expect(state.ghToken).toBeUndefined();
				return { exitCode: 0, lastMessage: "ok" };
			};
			const result = await adapter.execute(ctx());
			expect(result.success).toBe(true);
			// home still provisioned, but no credential block.
			expect(homeConfig()).not.toContain("GH_TOKEN");
			expect(
				fake.gitConfigCalls.some((a) =>
					a.includes("credential.https://github.com.helper"),
				),
			).toBe(false);
		});

		it("malformed gh token → skipped (no credential block in config)", async () => {
			fake.ghToken = "bad token with spaces";
			fake.onCycle = (_c, state) => {
				expect(state.ghToken).toBeUndefined();
				return { exitCode: 0, lastMessage: "ok" };
			};
			const result = await adapter.execute(ctx());
			expect(result.success).toBe(true);
			expect(homeConfig()).not.toContain("GH_TOKEN");
		});
	});
});
