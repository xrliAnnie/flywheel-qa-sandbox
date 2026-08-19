import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
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
import type { AdapterExecutionContext } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We'll test TmuxAdapter by injecting a mock execFileFn
import type { AsyncExecFileFn, ExecFileFn } from "../src/TmuxAdapter.js";
import {
	AMBIENT_IDENTITY_DENYLIST,
	assertLaunchCommandBudgets,
	buildAmbientSafeWindowCommand,
	ensureRunnerSession,
	LaunchCommandOversizeError,
	LaunchPrecommitError,
	pruneScaffoldWindow,
	TMUX_COMMAND_BUDGET_BYTES,
	TmuxAdapter,
	TmuxSessionHoldError,
} from "../src/TmuxAdapter.js";

// ─── Helpers ─────────────────────────────────────

function makeCtx(
	overrides: Partial<AdapterExecutionContext> = {},
): AdapterExecutionContext {
	return {
		executionId: "test-exec-1",
		issueId: "GEO-TEST",
		prompt: "Fix the bug in auth module",
		cwd: "/project/geoforge3d",
		onTmuxWindowOpened: () => {},
		...overrides,
	};
}

interface ExecCall {
	cmd: string;
	args: string[];
}

function promptFileFromTmuxArgs(args: string[]): string {
	const promptFile = args.find(
		(arg) =>
			arg.includes("/flywheel-runner-prompts/") &&
			arg.includes("/prompt-") &&
			arg.endsWith(".md"),
	);
	if (!promptFile) throw new Error("expected a per-launch prompt file");
	return promptFile;
}

describe("FLY-1715 ambient identity boundary", () => {
	it("executes direct and gated commands with six ambient names stripped and registry project identity restored", () => {
		const probeKeys = [
			...AMBIENT_IDENTITY_DENYLIST,
			"FLYWHEEL_LEAD_ID",
			"FLYWHEEL_INGEST_TOKEN",
			"SOME_UNLISTED_SECRET",
		];
		const probe = `const keys=${JSON.stringify(probeKeys)}; console.log(JSON.stringify(Object.fromEntries(keys.map((key) => [key, { present: Object.hasOwn(process.env, key), value: process.env[key] ?? null }]))));`;
		const poisonedEnv = {
			...process.env,
			LEAD_ID: "ambient-lead",
			DISCORD_STATE_DIR: "/ambient/discord",
			DISCORD_BOT_TOKEN: "ambient-discord-token",
			TEAMLEAD_API_TOKEN: "ambient-master-token",
			BRIDGE_URL: "http://ambient.invalid",
			PROJECT_NAME: "ambient-project",
			FLYWHEEL_LEAD_ID: "registry-lead",
			FLYWHEEL_INGEST_TOKEN: "registry-ingest",
			SOME_UNLISTED_SECRET: "boundary-canary",
		};
		const tmp = mkdtempSync(join(tmpdir(), "fly1715-identity-"));
		try {
			for (const gated of [false, true]) {
				for (const projectName of [undefined, "registry project; $(ignored)"]) {
					const token = "launch-token";
					const gateFile = join(
						tmp,
						`${gated}-${projectName ? "set" : "unset"}`,
					);
					if (gated) writeFileSync(gateFile, token);
					const command = buildAmbientSafeWindowCommand({
						binaryName: process.execPath,
						binaryArgs: ["-e", probe],
						projectName,
						...(gated
							? { gateFile, launchToken: token, cleanup: "keep" as const }
							: {}),
					});
					const result = spawnSync(command[0] as string, command.slice(1), {
						env: poisonedEnv,
						encoding: "utf8",
					});
					expect(result.status, result.stderr).toBe(0);
					const observed = JSON.parse(result.stdout.trim()) as Record<
						string,
						{ present: boolean; value: string | null }
					>;
					for (const key of AMBIENT_IDENTITY_DENYLIST) {
						if (key === "PROJECT_NAME" && projectName !== undefined) {
							expect(observed[key]).toEqual({
								present: true,
								value: projectName,
							});
						} else {
							expect(observed[key]).toEqual({ present: false, value: null });
						}
					}
					expect(observed.FLYWHEEL_LEAD_ID?.value).toBe("registry-lead");
					expect(observed.FLYWHEEL_INGEST_TOKEN?.value).toBe("registry-ingest");
					expect(observed.SOME_UNLISTED_SECRET?.value).toBe("boundary-canary");
				}
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("delivers a file-backed prompt as the final gated process argument", () => {
		const tmp = mkdtempSync(join(tmpdir(), "fly1869-prompt-gate-"));
		try {
			const gateFile = join(tmp, "launch-gate");
			const promptFile = join(tmp, "prompt.md");
			const token = "launch-token";
			const prompt = `issue description ${"x".repeat(100_000)}`;
			writeFileSync(gateFile, token);
			writeFileSync(promptFile, prompt);

			const command = buildAmbientSafeWindowCommand({
				binaryName: process.execPath,
				binaryArgs: [
					"-e",
					'process.stdout.write(process.argv[1] ?? "<missing>")',
				],
				gateFile,
				launchToken: token,
				cleanup: "keep",
				promptFile,
			});
			const result = spawnSync(command[0] as string, command.slice(1), {
				encoding: "utf8",
			});

			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout).toBe(prompt);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("fails closed with exit 78 when a configured prompt file is missing or empty", () => {
		const tmp = mkdtempSync(join(tmpdir(), "fly1869-prompt-failure-"));
		try {
			const gateFile = join(tmp, "launch-gate");
			const token = "launch-token";
			writeFileSync(gateFile, token);

			for (const [name, create] of [
				["missing", false],
				["empty", true],
			] as const) {
				const promptFile = join(tmp, `${name}.md`);
				if (create) writeFileSync(promptFile, "");
				const command = buildAmbientSafeWindowCommand({
					binaryName: process.execPath,
					binaryArgs: ["-e", 'process.stdout.write("EXECUTED")'],
					gateFile,
					launchToken: token,
					cleanup: "keep",
					promptFile,
				});
				const result = spawnSync(command[0] as string, command.slice(1), {
					encoding: "utf8",
				});

				expect(result.status, `${name}: ${result.stderr}`).toBe(78);
				expect(result.stdout).not.toContain("EXECUTED");
				expect(result.stderr).toContain(
					`FLYWHEEL_PROMPT_FILE_UNREADABLE ${promptFile}`,
				);
			}
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("rejects a prompt file when no launch gate can delay process start", () => {
		expect(() =>
			buildAmbientSafeWindowCommand({
				binaryName: "claude",
				binaryArgs: [],
				promptFile: "/tmp/prompt.md",
			}),
		).toThrow(/prompt file requires a gated launch/i);
	});
});

describe("FLY-1869 launch command budget", () => {
	it("allows the exact byte budget and rejects one byte over with flag attribution", () => {
		const exact = "x".repeat(TMUX_COMMAND_BUDGET_BYTES - 6);
		expect(() => assertLaunchCommandBudgets([exact])).not.toThrow();

		let error: unknown;
		try {
			assertLaunchCommandBudgets([`${exact}x`]);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(LaunchCommandOversizeError);
		expect(error).toMatchObject({
			code: "LAUNCH_COMMAND_OVERSIZE",
			reason: "tmux_command_budget",
			budgetBytes: TMUX_COMMAND_BUDGET_BYTES,
		});
		expect((error as Error).message).toContain("argv[0]=12283B");

		expect(() =>
			assertLaunchCommandBudgets([
				"--settings",
				"x".repeat(TMUX_COMMAND_BUDGET_BYTES - 16),
			]),
		).toThrow(/--settings value=12272B/);
	});
});

function makeMockExec(
	options: {
		paneDead?: boolean;
		windowId?: string;
		tmuxVersion?: string;
		hasSessionError?: boolean;
		killWindowThrows?: boolean;
		listWindows?: string;
	} = {},
) {
	const calls: ExecCall[] = [];
	const {
		paneDead = false,
		windowId = "@42",
		tmuxVersion = "tmux 3.4",
		hasSessionError = true, // session doesn't exist by default
		killWindowThrows = false,
		// FLY-758: `list-windows` output for pruneScaffoldWindow. Default "" is
		// byte-compatible — an empty inventory means <2 windows → no prune.
		listWindows = "",
	} = options;

	const fn = (cmd: string, args: string[]): { stdout: string } => {
		calls.push({ cmd, args });

		if (cmd === "claude") {
			return { stdout: "claude 2.1.63" };
		}

		if (cmd === "tmux") {
			const subcommand = args[0];

			if (subcommand === "-V") {
				return { stdout: tmuxVersion };
			}

			if (subcommand === "has-session") {
				if (hasSessionError) {
					throw new Error("session not found");
				}
				return { stdout: "" };
			}

			if (subcommand === "new-session") {
				return { stdout: "" };
			}

			if (subcommand === "set-environment") {
				return { stdout: "" };
			}

			if (subcommand === "set-option") {
				return { stdout: "" };
			}

			if (subcommand === "new-window") {
				return { stdout: `${windowId}|/tmp/tmux-test/default|1722700000` };
			}

			if (subcommand === "list-panes") {
				if (paneDead) {
					return { stdout: "1" };
				}
				return { stdout: "0" };
			}

			if (subcommand === "kill-window") {
				if (killWindowThrows) throw new Error("tmux kill-window failed");
				return { stdout: "" };
			}

			if (subcommand === "list-windows") {
				return { stdout: listWindows };
			}
		}

		return { stdout: "" };
	};

	return { fn, calls };
}

/** FLY-758: kill-window `-t` targets recorded by a mock, in call order. */
function killWindowTargets(calls: ExecCall[]): string[] {
	return calls
		.filter((c) => c.cmd === "tmux" && c.args[0] === "kill-window")
		.map((c) => c.args[c.args.indexOf("-t") + 1] ?? "");
}

/**
 * Create a mock exec that resolves pane_dead after N polls
 */
function makeMockExecWithDelayedDead(
	pollsBeforeDead: number,
	windowId = "@42",
) {
	const calls: ExecCall[] = [];
	let pollCount = 0;

	const fn = (cmd: string, args: string[]): { stdout: string } => {
		calls.push({ cmd, args });

		if (cmd === "claude") return { stdout: "claude 2.1.63" };

		if (cmd === "tmux") {
			const subcommand = args[0];
			if (subcommand === "-V") return { stdout: "tmux 3.4" };
			if (subcommand === "has-session") throw new Error("not found");
			if (subcommand === "new-session") return { stdout: "" };
			if (subcommand === "set-environment") return { stdout: "" };
			if (subcommand === "set-option") return { stdout: "" };
			if (subcommand === "new-window")
				return { stdout: `${windowId}|/tmp/tmux-test/default|1722700000` };
			if (subcommand === "list-panes") {
				pollCount++;
				return { stdout: pollCount >= pollsBeforeDead ? "1" : "0" };
			}
		}
		return { stdout: "" };
	};

	return { fn, calls };
}

// ─── Tests ───────────────────────────────────────

describe("TmuxAdapter", () => {
	// ─── Construction (lazy preflight) ──────────────

	it("does NOT check tmux in constructor", () => {
		const { fn, calls } = makeMockExec();
		const _adapter = new TmuxAdapter("flywheel", fn);
		// No calls at all during construction
		expect(calls).toHaveLength(0);
	});

	it("has type 'claude-tmux'", () => {
		const { fn } = makeMockExec();
		const adapter = new TmuxAdapter("flywheel", fn);
		expect(adapter.type).toBe("claude-tmux");
	});

	// ─── Preflight ──────────────────────────────────

	it("checks tmux -V and claude --version on first execute() call only", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(makeCtx());
		const firstRunTmuxV = calls.filter((c) => c.args[0] === "-V");
		const firstRunClaude = calls.filter((c) => c.cmd === "claude");
		expect(firstRunTmuxV).toHaveLength(1);
		expect(firstRunClaude).toHaveLength(1);

		// Second run should not check again
		const callsBefore = calls.length;
		await adapter.execute(makeCtx());
		const secondRunTmuxV = calls
			.slice(callsBefore)
			.filter((c) => c.args[0] === "-V");
		const secondRunClaude = calls
			.slice(callsBefore)
			.filter((c) => c.cmd === "claude");
		expect(secondRunTmuxV).toHaveLength(0);
		expect(secondRunClaude).toHaveLength(0);
	});

	it("throws when tmux is not installed", async () => {
		const fn = (cmd: string) => {
			if (cmd === "tmux") throw new Error("tmux not found");
			return { stdout: "" };
		};
		const adapter = new TmuxAdapter("flywheel", fn);

		await expect(adapter.execute(makeCtx())).rejects.toThrow("tmux not found");
	});

	it("throws when claude is not installed", async () => {
		const fn = (cmd: string, args: string[]) => {
			if (cmd === "tmux" && args[0] === "-V") return { stdout: "tmux 3.4" };
			if (cmd === "claude") throw new Error("claude not found");
			return { stdout: "" };
		};
		const adapter = new TmuxAdapter("flywheel", fn);

		await expect(adapter.execute(makeCtx())).rejects.toThrow(
			"claude not found",
		);
	});

	// ─── Session management ─────────────────────────

	it("creates tmux session if it doesn't exist", async () => {
		const { fn, calls } = makeMockExec({
			hasSessionError: true,
			paneDead: true,
		});
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(makeCtx());

		const newSession = calls.find((c) => c.args[0] === "new-session");
		expect(newSession).toBeDefined();
		expect(newSession!.args).toContain("flywheel");
	});

	it("reuses existing session", async () => {
		const { fn, calls } = makeMockExec({
			hasSessionError: false,
			paneDead: true,
		});
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(makeCtx());

		const newSession = calls.find((c) => c.args[0] === "new-session");
		expect(newSession).toBeUndefined();
	});

	// ─── R5/R6 HIGH-3: durable commit-gated launch (gateway-retry path) ───────

	it("R5/R6: the gateway path opens a TOKEN-gated shell; the commit file holds this launch's token", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "fly245-commit-"));
		try {
			const commitFile = join(tmp, "succ-9");
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter("flywheel", fn, 10);
			await adapter.execute(makeCtx({ launchCommitPath: commitFile }));
			const newWindow = calls.find(
				(c) => c.cmd === "tmux" && c.args[0] === "new-window",
			);
			// gated shell: `sh -c '<grep -qF $tok>; exec claude "$@"' <commitFile> <token> ...`
			expect(newWindow?.args).toContain("sh");
			expect(newWindow?.args.some((a) => a.includes("grep -qF"))).toBe(true);
			expect(newWindow?.args.some((a) => a.includes('exec "$@"'))).toBe(true);
			expect(newWindow?.args).toContain("claude");
			expect(newWindow?.args).toContain(commitFile);
			// the file holds THIS launch's token (a uuid) — the per-launch gate.
			const written = readFileSync(commitFile, "utf8");
			expect(written).toMatch(/^[0-9a-f-]{36}$/);
			// and the token in the commit file is the SAME one the shell greps for.
			expect(newWindow?.args).toContain(written);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("R6: two attempts of the SAME execId use DIFFERENT launch tokens (a replay can't release a stale shell)", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "fly245-twotoken-"));
		try {
			const commitFile = join(tmp, "succ-9");
			// attempt A
			const a = makeMockExec({ paneDead: true });
			await new TmuxAdapter("flywheel", a.fn, 10).execute(
				makeCtx({ launchCommitPath: commitFile }),
			);
			const tokenA = readFileSync(commitFile, "utf8");
			// attempt B (replay, same execId → same commit path) overwrites with tokenB
			const b = makeMockExec({ paneDead: true });
			await new TmuxAdapter("flywheel", b.fn, 10).execute(
				makeCtx({ launchCommitPath: commitFile }),
			);
			const tokenB = readFileSync(commitFile, "utf8");
			expect(tokenA).not.toBe(tokenB);
			// A's gated shell greps for tokenA; the file now holds tokenB → A never
			// matches (stays gated, times out). B greps for tokenB → matches.
			const aWin = a.calls.find(
				(c) => c.cmd === "tmux" && c.args[0] === "new-window",
			);
			expect(aWin?.args).toContain(tokenA);
			expect(aWin?.args).not.toContain(tokenB);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("R6: REAL sh gate — only the shell whose token is in the commit file proceeds (the other stays gated)", async () => {
		// Run the ACTUAL gate snippet against a real /bin/sh to prove the per-token
		// gate: with the commit file holding tokenB, a shell waiting on tokenA must
		// NOT proceed, while a shell waiting on tokenB does.
		const tmp = mkdtempSync(join(tmpdir(), "fly245-realgate-"));
		try {
			const commitFile = join(tmp, "succ-9");
			writeFileSync(commitFile, "TOKEN-B"); // the re-drive (B) committed
			// a SHORT-timeout variant of the production gate (~0.3s, then exit 1)
			const gate =
				'cf="$0"; tok="$1"; shift; n=0; while ! grep -qF "$tok" "$cf" 2>/dev/null; do [ "$n" -ge 15 ] && exit 1; sleep 0.02; n=$((n+1)); done; echo STARTED; exit 0';
			const run = (token: string) =>
				new Promise<{ code: number; out: string }>((resolve) => {
					const child = spawn("sh", ["-c", gate, commitFile, token], {
						stdio: ["ignore", "pipe", "ignore"],
					});
					let out = "";
					child.stdout.on("data", (d) => {
						out += d;
					});
					child.on("close", (code) => resolve({ code: code ?? -1, out }));
				});
			// the STALE shell (A) waits on tokenA → never matches (file holds B) → exits 1
			const a = await run("TOKEN-A");
			expect(a.out).not.toContain("STARTED");
			expect(a.code).toBe(1);
			// the matching shell (B) waits on tokenB → matches → STARTED
			const b = await run("TOKEN-B");
			expect(b.out).toContain("STARTED");
			expect(b.code).toBe(0);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("R5: a commit-write failure ABORTS the launch — Claude never started (gated + no commit → replay re-drives)", async () => {
		// point launchCommitPath at a path whose parent can't be created (a FILE),
		// so mkdirSync/writeFileSync throws.
		const tmp = mkdtempSync(join(tmpdir(), "fly245-commitfail-"));
		try {
			const blocker = join(tmp, "blocker");
			writeFileSync(blocker, "x"); // a file where a dir is needed
			const commitFile = join(blocker, "succ-9"); // parent is a file → ENOTDIR
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter("flywheel", fn, 10);
			await expect(
				adapter.execute(makeCtx({ launchCommitPath: commitFile })),
			).rejects.toThrow(/launch aborted: could not write durable commit/i);
			// gated shell was opened (claude not started), and we never polled
			const newWindow = calls.find(
				(c) => c.cmd === "tmux" && c.args[0] === "new-window",
			);
			expect(newWindow?.args.some((a) => a.includes('exec "$@"'))).toBe(true);
			expect(newWindow?.args).toContain("claude");
			expect(existsSync(commitFile)).toBe(false); // no commit → replay re-drives
			expect(
				calls.find((c) => c.cmd === "tmux" && c.args[0] === "list-panes"),
			).toBeUndefined();
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("gates the normal Claude path until the generation credential is persisted", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);
		const opened = vi.fn();
		await adapter.execute(makeCtx({ onTmuxWindowOpened: opened }));
		const newWindow = calls.find(
			(c) => c.cmd === "tmux" && c.args[0] === "new-window",
		);
		expect(newWindow?.args).toContain("sh");
		expect(newWindow?.args.some((arg) => arg.includes('exec "$@"'))).toBe(true);
		expect(newWindow?.args).toContain("claude");
		expect(newWindow?.args.some((arg) => arg.includes("rm -f"))).toBe(true);
		expect(opened).toHaveBeenCalledWith({
			baseSessionName: "flywheel",
			windowId: "@42",
			socketPath: "/tmp/tmux-test/default",
			serverStartTime: "1722700000",
			executionId: "test-exec-1",
		});
	});

	it("prunes an authority-approved terminal same-name window by exact id before session capacity admission", async () => {
		const base = makeMockExec({
			paneDead: true,
			hasSessionError: false,
			listWindows: "@7|GEO-TEST|old-exec|1|old-fingerprint",
		});
		let staleKilled = false;
		const fn: ExecFileFn = (cmd, args) => {
			if (
				cmd === "tmux" &&
				args[0] === "kill-window" &&
				args[2] === "=flywheel:@7"
			) {
				staleKilled = true;
			}
			if (
				cmd === "tmux" &&
				args[0] === "display-message" &&
				args.includes("=flywheel:@7") &&
				staleKilled
			) {
				throw new Error("window not found");
			}
			return base.fn(cmd, args);
		};
		const authority = vi.fn(() => "prune" as const);
		await new TmuxAdapter("flywheel", fn, 10).execute(
			makeCtx({
				label: "GEO-TEST",
				workflowTmuxWindowAuthority: authority,
			}),
		);

		expect(authority).toHaveBeenCalledWith({
			windowId: "@7",
			windowName: "GEO-TEST",
			executionId: "old-exec",
			launchGeneration: 1,
			launchFingerprint: "old-fingerprint",
		});
		expect(killWindowTargets(base.calls)).toContain("=flywheel:@7");
		const newWindow = base.calls.find((call) => call.args[0] === "new-window")!;
		expect(newWindow.args[newWindow.args.indexOf("-n") + 1]).toBe("GEO-TEST");
	});

	it("uses an execution suffix when a same-name window lacks prune authority", async () => {
		const base = makeMockExec({
			paneDead: true,
			hasSessionError: false,
			listWindows: "@7|GEO-TEST|live-exec|2|live-fingerprint",
		});
		await new TmuxAdapter("flywheel", base.fn, 10).execute(
			makeCtx({
				label: "GEO-TEST",
				workflowTmuxWindowAuthority: () => "keep",
			}),
		);
		const newWindow = base.calls.find((call) => call.args[0] === "new-window")!;
		expect(newWindow.args[newWindow.args.indexOf("-n") + 1]).toBe(
			"GEO-TEST-test-exe",
		);
		expect(killWindowTargets(base.calls)).not.toContain("=flywheel:@7");
	});

	it("reserves room for execution and owner-generation suffixes on long labels", async () => {
		const canonical = "A".repeat(50);
		const base = makeMockExec({
			paneDead: true,
			hasSessionError: false,
			listWindows: `@7|${canonical}|live-exec|2|live-fingerprint`,
		});
		await new TmuxAdapter("flywheel", base.fn, 10).execute(
			makeCtx({
				label: canonical,
				executionId: "test-execution-id",
				launchGeneration: 3,
				workflowTmuxWindowAuthority: () => "keep",
			}),
		);
		const newWindow = base.calls.find((call) => call.args[0] === "new-window")!;
		const selected = newWindow.args[newWindow.args.indexOf("-n") + 1]!;
		expect(selected).toHaveLength(50);
		expect(selected).toMatch(/-test-exe-g3$/);
	});

	it("preflights the suffixed fallback and selects a bounded unique retry name", async () => {
		const base = makeMockExec({
			paneDead: true,
			hasSessionError: false,
			listWindows:
				"@7|GEO-TEST|live-exec|2|live-fingerprint\n" +
				"@8|GEO-TEST-test-exe-g3|other-exec|1|other-fingerprint",
		});
		await new TmuxAdapter("flywheel", base.fn, 10).execute(
			makeCtx({
				label: "GEO-TEST",
				executionId: "test-execution-id",
				launchGeneration: 3,
				workflowTmuxWindowAuthority: () => "keep",
			}),
		);
		const newWindow = base.calls.find((call) => call.args[0] === "new-window")!;
		expect(newWindow.args[newWindow.args.indexOf("-n") + 1]).toBe(
			"GEO-TEST-test-exe-g3-r1",
		);
	});

	it("fails a workflow launch closed with a typed result when exact window identity cannot be published", async () => {
		const base = makeMockExec({ paneDead: true });
		let killed = false;
		const fn: ExecFileFn = (cmd, args) => {
			if (
				cmd === "tmux" &&
				args[0] === "set-option" &&
				args.includes("@flywheel_launch_generation")
			) {
				throw new Error("option write failed");
			}
			if (cmd === "tmux" && args[0] === "kill-window") killed = true;
			if (cmd === "tmux" && args[0] === "display-message" && killed) {
				throw new Error("window not found");
			}
			return base.fn(cmd, args);
		};
		let error: unknown;
		try {
			await new TmuxAdapter("flywheel", fn, 10).execute(
				makeCtx({
					launchCommitPath: "/tmp/fly1638-identity-commit",
					launchGateToken: "launch-token",
					launchGeneration: 3,
					launchFingerprint: "launch-fingerprint",
					commitWorkflowLaunch: () => ({ ok: true }),
				}),
			);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(LaunchPrecommitError);
		expect((error as LaunchPrecommitError).launchFailure).toEqual({
			code: "LAUNCH_WINDOW_IDENTITY_FAILED",
			reason: "identity_publish_failed",
			physicalEvidence: "cleaned",
		});
	});

	it("repairs an existing direct launch-gate directory to owner-only permissions", async () => {
		const gateDir = join(tmpdir(), "flywheel-launch-gates");
		mkdirSync(gateDir, { recursive: true });
		chmodSync(gateDir, 0o777);
		let gateFile: string | undefined;
		try {
			const { fn, calls } = makeMockExec({ paneDead: true });
			await new TmuxAdapter("flywheel", fn, 10).execute(makeCtx());
			const newWindow = calls.find(
				(call) => call.cmd === "tmux" && call.args[0] === "new-window",
			);
			gateFile = newWindow?.args.find((arg) => arg.startsWith(`${gateDir}/`));
			expect(statSync(gateDir).mode & 0o777).toBe(0o700);
		} finally {
			chmodSync(gateDir, 0o700);
			if (gateFile) rmSync(gateFile, { force: true });
		}
	});

	it("fails closed and kills the Claude window when generation persistence is unavailable", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		await expect(
			new TmuxAdapter("flywheel", fn, 10).execute(
				makeCtx({ onTmuxWindowOpened: undefined }),
			),
		).rejects.toThrow(/generation credential callback is required/i);
		expect(killWindowTargets(calls)).toContain("=flywheel:@42");
		expect(calls.some((call) => call.args[0] === "list-panes")).toBe(false);
	});

	it("fails closed before release when generation persistence rejects the tuple", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		await expect(
			new TmuxAdapter("flywheel", fn, 10).execute(
				makeCtx({
					onTmuxWindowOpened: () => {
						throw new Error("terminal row");
					},
				}),
			),
		).rejects.toThrow(/terminal row/i);
		expect(killWindowTargets(calls)).toContain("=flywheel:@42");
		expect(calls.some((call) => call.args[0] === "list-panes")).toBe(false);
	});

	// ─── FLY-615: ponytail --settings flag ───────────
	const expectDiscordDisabledSettings = (
		settingsJson: string,
		extraEnabledPlugins: Record<string, boolean> = {},
	): void => {
		expect(JSON.parse(settingsJson)).toEqual({
			enabledPlugins: {
				...extraEnabledPlugins,
				"discord@flywheel-plugins": false,
				"discord@claude-plugins-official": false,
			},
		});
	};

	it("FLY-615: enablePonytail adds --settings <json> (normal path)", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);
		await adapter.execute(makeCtx({ enablePonytail: true }));
		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const idx = newWindow!.args.indexOf("--settings");
		expect(idx).toBeGreaterThan(-1);
		expectDiscordDisabledSettings(newWindow!.args[idx + 1] as string, {
			"ponytail@ponytail": true,
		});
	});

	it('FLY-615: --settings survives the gateway launch path (sh -c "$@")', async () => {
		const tmp = mkdtempSync(join(tmpdir(), "fly615-ponytail-"));
		try {
			const commitFile = join(tmp, "succ-1");
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter("flywheel", fn, 10);
			await adapter.execute(
				makeCtx({ enablePonytail: true, launchCommitPath: commitFile }),
			);
			const newWindow = calls.find(
				(c) => c.cmd === "tmux" && c.args[0] === "new-window",
			);
			const idx = newWindow!.args.indexOf("--settings");
			expect(idx).toBeGreaterThan(-1);
			expectDiscordDisabledSettings(newWindow!.args[idx + 1] as string, {
				"ponytail@ponytail": true,
			});
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("FLY-615/1715: no enablePonytail keeps ponytail absent while disabling Discord", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);
		await adapter.execute(makeCtx());
		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const idx = newWindow!.args.indexOf("--settings");
		expectDiscordDisabledSettings(newWindow!.args[idx + 1] as string);
	});

	// ─── FLY-751: per-runner MCP slimming (disabledPlugins + disableChrome) ───

	it("FLY-751: disabledPlugins → single --settings disabling each plugin", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);
		await adapter.execute(
			makeCtx({
				disabledPlugins: [
					"discord@claude-plugins-official",
					"serena@claude-plugins-official",
				],
			}),
		);
		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const idx = newWindow!.args.indexOf("--settings");
		expect(idx).toBeGreaterThan(-1);
		expectDiscordDisabledSettings(newWindow!.args[idx + 1] as string, {
			"serena@claude-plugins-official": false,
		});
		// exactly one --settings flag
		expect(
			newWindow!.args.filter((a: string) => a === "--settings"),
		).toHaveLength(1);
	});

	it("FLY-751: ponytail + disabledPlugins merge into ONE --settings map", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);
		await adapter.execute(
			makeCtx({
				enablePonytail: true,
				disabledPlugins: ["discord@claude-plugins-official"],
			}),
		);
		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const settingsArgs = newWindow!.args.filter(
			(a: string) => a === "--settings",
		);
		expect(settingsArgs).toHaveLength(1);
		const idx = newWindow!.args.indexOf("--settings");
		expectDiscordDisabledSettings(newWindow!.args[idx + 1] as string, {
			"ponytail@ponytail": true,
		});
	});

	it("FLY-1715: every Claude tmux launch disables both Discord plugin identities", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		await new TmuxAdapter("flywheel", fn, 10).execute(makeCtx());
		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const settingsIndexes = newWindow!.args.flatMap((arg, index) =>
			arg === "--settings" ? [index] : [],
		);
		expect(settingsIndexes).toHaveLength(1);
		const settings = JSON.parse(
			newWindow!.args[(settingsIndexes[0] as number) + 1] as string,
		);
		expect(settings.enabledPlugins).toMatchObject({
			"discord@flywheel-plugins": false,
			"discord@claude-plugins-official": false,
		});
	});

	it("FLY-1715: forbidden Discord entries override caller positive opt-ins", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		await new TmuxAdapter("flywheel", fn, 10).execute(
			makeCtx({
				enabledPluginsExtra: [
					"discord@flywheel-plugins",
					"discord@claude-plugins-official",
				],
			}),
		);
		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const index = newWindow!.args.indexOf("--settings");
		const settings = JSON.parse(newWindow!.args[index + 1] as string);
		expect(settings.enabledPlugins).toMatchObject({
			"discord@flywheel-plugins": false,
			"discord@claude-plugins-official": false,
		});
	});

	it("FLY-751: disableChrome stays in CLI args before the runtime prompt", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);
		await adapter.execute(
			makeCtx({ prompt: "Fix the browser bug", disableChrome: true }),
		);
		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const noChromeIdx = newWindow!.args.indexOf("--no-chrome");
		expect(noChromeIdx).toBeGreaterThan(-1);
		expect(newWindow!.args).not.toContain("Fix the browser bug");
		expect(readFileSync(promptFileFromTmuxArgs(newWindow!.args), "utf8")).toBe(
			"Fix the browser bug",
		);
		expect(newWindow!.args.some((arg) => arg.includes('exec "$@" "$p"'))).toBe(
			true,
		);
	});

	it("FLY-751: slim flags survive the gateway launch path", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "fly751-slim-"));
		try {
			const commitFile = join(tmp, "succ-1");
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter("flywheel", fn, 10);
			await adapter.execute(
				makeCtx({
					disabledPlugins: ["discord@claude-plugins-official"],
					disableChrome: true,
					launchCommitPath: commitFile,
				}),
			);
			const newWindow = calls.find(
				(c) => c.cmd === "tmux" && c.args[0] === "new-window",
			);
			expect(newWindow!.args).toContain("--settings");
			expect(newWindow!.args).toContain("--no-chrome");
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("FLY-751/1715: empty disabledPlugins still applies Discord deny policy", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);
		await adapter.execute(makeCtx({ disabledPlugins: [] }));
		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const idx = newWindow!.args.indexOf("--settings");
		expectDiscordDisabledSettings(newWindow!.args[idx + 1] as string);
		expect(newWindow!.args).not.toContain("--no-chrome");
	});

	it("FLY-751: absent fields → no --no-chrome (byte-compatible)", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);
		await adapter.execute(makeCtx());
		const newWindow = calls.find((c) => c.args[0] === "new-window");
		expect(newWindow!.args).not.toContain("--no-chrome");
	});

	// ─── Window launch ──────────────────────────────

	it("launches tmux window with -c ctx.cwd", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(makeCtx({ cwd: "/my/project" }));

		const newWindow = calls.find((c) => c.args[0] === "new-window");
		expect(newWindow).toBeDefined();
		const cwdIdx = newWindow!.args.indexOf("-c");
		expect(cwdIdx).toBeGreaterThan(-1);
		expect(newWindow!.args[cwdIdx + 1]).toBe("/my/project");
	});

	it("uses ctx.label for window name", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(makeCtx({ label: "GEO-101" }));

		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const nIdx = newWindow!.args.indexOf("-n");
		expect(newWindow!.args[nIdx + 1]).toBe("GEO-101");
	});

	it("falls back to timestamp-based name when no label", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(makeCtx({ label: undefined }));

		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const nIdx = newWindow!.args.indexOf("-n");
		const windowName = newWindow!.args[nIdx + 1]!;
		expect(windowName).toMatch(/^issue-\d+$/);
	});

	it("sanitizes window name (removes special chars)", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(makeCtx({ label: "GEO/101:special.chars!" }));

		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const nIdx = newWindow!.args.indexOf("-n");
		const windowName = newWindow!.args[nIdx + 1]!;
		expect(windowName).toMatch(/^[a-zA-Z0-9-]+$/);
		expect(windowName).not.toContain("/");
		expect(windowName).not.toContain(":");
	});

	it("truncates window name to 50 characters", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);
		const longLabel = "a".repeat(100);

		await adapter.execute(makeCtx({ label: longLabel }));

		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const nIdx = newWindow!.args.indexOf("-n");
		const windowName = newWindow!.args[nIdx + 1]!;
		expect(windowName.length).toBeLessThanOrEqual(50);
	});

	// ─── Claude args ────────────────────────────────

	it("passes --session-id <uuid> to claude (ignores previousSession)", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(
			makeCtx({ previousSession: { sessionId: "old-session-id" } }),
		);

		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const claudeArgs = newWindow!.args;
		// Should contain --session-id with a UUID, not "old-session-id"
		const sessionIdx = claudeArgs.indexOf("--session-id");
		expect(sessionIdx).toBeGreaterThan(-1);
		const sessionId = claudeArgs[sessionIdx + 1]!;
		expect(sessionId).not.toBe("old-session-id");
		expect(sessionId).toMatch(/^[0-9a-f-]{36}$/); // UUID format
	});

	it("does NOT include --print or --output-format", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(makeCtx());

		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const allArgs = newWindow!.args.join(" ");
		expect(allArgs).not.toContain("--print");
		expect(allArgs).not.toContain("--output-format");
	});

	it("includes --permission-mode and --append-system-prompt-file (FLY-154 hotfix)", async () => {
		// FLY-154 hotfix: large system prompts overflowed tmux's `new-window`
		// internal command buffer ("command too long" — caught by qa-fly-372
		// hybrid swap test). The adapter now writes the prompt to a file and
		// passes --append-system-prompt-file <path>, keeping argv small.
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		const promptBody = "Always use TypeScript";
		await adapter.execute(
			makeCtx({
				executionId: "exec-prompt-file-1",
				permissionMode: "bypassPermissions",
				appendSystemPrompt: promptBody,
			}),
		);

		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const args = newWindow!.args;
		expect(args).toContain("--permission-mode");
		expect(args).toContain("bypassPermissions");

		// Inline form must be GONE — that's the whole point of this fix.
		expect(args).not.toContain("--append-system-prompt");
		expect(args).not.toContain(promptBody);

		// File form must be present + path must look right.
		expect(args).toContain("--append-system-prompt-file");
		const fileFlagIdx = args.indexOf("--append-system-prompt-file");
		const promptPath = args[fileFlagIdx + 1];
		expect(promptPath).toMatch(
			/flywheel-runner-prompts\/exec-prompt-file-1\/append-system-prompt\.md$/,
		);

		// File must actually contain the prompt body.
		const { readFileSync } = await import("node:fs");
		expect(readFileSync(promptPath, "utf-8")).toBe(promptBody);
	});

	it("restricts prompt dir to 0o700 and file to 0o600 (Codex R3 LOW hardening)", async () => {
		// Defense-in-depth: prompts in shared tmpdir could contain designer
		// + issue-body text. Other local users must not be able to read.
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(
			makeCtx({
				executionId: "exec-perms-1",
				appendSystemPrompt: "secret designer prompt",
			}),
		);

		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const fileFlagIdx = newWindow!.args.indexOf("--append-system-prompt-file");
		const promptPath = newWindow!.args[fileFlagIdx + 1] as string;

		const { statSync } = await import("node:fs");
		const { dirname } = await import("node:path");
		const fileMode = statSync(promptPath).mode & 0o777;
		const dirMode = statSync(dirname(promptPath)).mode & 0o777;
		expect(fileMode).toBe(0o600);
		expect(dirMode).toBe(0o700);
	});

	it("handles 14KB+ designer-sized system prompts via the file path (FLY-154 hotfix regression)", async () => {
		// Reproduces the qa-fly-372 designer canary size: agent.md (~6.3KB)
		// + domain config (~1KB) + baseline rules (~1KB) + ample headroom.
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		const bigPrompt = `## Agent Role\n${"x".repeat(14_000)}\n## Baseline Rules\n`;
		expect(bigPrompt.length).toBeGreaterThan(14_000);

		await adapter.execute(
			makeCtx({
				executionId: "exec-14kb",
				appendSystemPrompt: bigPrompt,
			}),
		);

		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const args = newWindow!.args;

		// Critical: argv must NOT contain the 14KB blob anywhere.
		const totalArgv = args.join(" ");
		expect(totalArgv).not.toContain("x".repeat(14_000));
		expect(totalArgv.length).toBeLessThan(2_000);

		// File path is what the Runner consumes.
		const fileFlagIdx = args.indexOf("--append-system-prompt-file");
		expect(fileFlagIdx).toBeGreaterThan(-1);
		const { readFileSync } = await import("node:fs");
		expect(readFileSync(args[fileFlagIdx + 1] as string, "utf-8")).toBe(
			bigPrompt,
		);
	});

	it("externalizes a 100KB task prompt to a per-launch owner-only file", async () => {
		const executionId = "fly1869-100kb-prompt";
		const launchToken = "fly1869-launch-token";
		const promptDir = join(tmpdir(), "flywheel-runner-prompts", executionId);
		rmSync(promptDir, { recursive: true, force: true });
		try {
			const prompt = `Task\n${"x".repeat(102_400)}`;
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter("flywheel", fn, 10);

			await adapter.execute(
				makeCtx({ executionId, launchGateToken: launchToken, prompt }),
			);

			const args = calls.find((call) => call.args[0] === "new-window")!.args;
			const promptPath = join(promptDir, `prompt-${launchToken}.md`);
			expect(args).not.toContain(prompt);
			expect(args).toContain(promptPath);
			expect(readFileSync(promptPath, "utf8")).toBe(prompt);
			expect(statSync(promptDir).mode & 0o777).toBe(0o700);
			expect(statSync(promptPath).mode & 0o777).toBe(0o600);
		} finally {
			rmSync(promptDir, { recursive: true, force: true });
		}
	});

	it.each(["", "\n"])(
		"keeps a blank task prompt inline without creating a prompt file (%j)",
		async (prompt) => {
			const executionId = `fly1869-blank-${prompt.length}`;
			const { fn, calls } = makeMockExec({ paneDead: true });
			await new TmuxAdapter("flywheel", fn, 10).execute(
				makeCtx({ executionId, launchGateToken: "blank-token", prompt }),
			);

			const args = calls.find((call) => call.args[0] === "new-window")!.args;
			expect(args.at(-1)).toBe(prompt);
			expect(
				args.some((arg) =>
					arg.includes(`flywheel-runner-prompts/${executionId}/prompt-`),
				),
			).toBe(false);
		},
	);

	it("rejects a 120,001-byte workflow prompt before tmux with a typed precommit failure", async () => {
		const executionId = "fly1869-prompt-budget";
		const promptDir = join(tmpdir(), "flywheel-runner-prompts", executionId);
		rmSync(promptDir, { recursive: true, force: true });
		try {
			const { fn, calls } = makeMockExec({ paneDead: true });
			let error: unknown;
			try {
				await new TmuxAdapter("flywheel", fn, 10).execute(
					makeCtx({
						executionId,
						prompt: "x".repeat(120_001),
						launchCommitPath: join(promptDir, "commit"),
						launchGateToken: "prompt-budget-token",
						launchGeneration: 1,
						launchFingerprint: "prompt-budget-fingerprint",
						commitWorkflowLaunch: () => ({ ok: true }),
					}),
				);
			} catch (caught) {
				error = caught;
			}

			expect(error).toBeInstanceOf(LaunchPrecommitError);
			expect((error as LaunchPrecommitError).launchFailure).toEqual({
				code: "LAUNCH_COMMAND_OVERSIZE",
				reason: "prompt_size_budget",
				physicalEvidence: "absent",
			});
			expect((error as Error).message).toContain("120001");
			expect((error as Error).message).toContain("120000");
			expect(calls.some((call) => call.args[0] === "new-window")).toBe(false);
		} finally {
			rmSync(promptDir, { recursive: true, force: true });
		}
	});

	it("rejects an oversized workflow tmux command before invoking tmux", async () => {
		const executionId = "fly1869-command-budget";
		const promptDir = join(tmpdir(), "flywheel-runner-prompts", executionId);
		rmSync(promptDir, { recursive: true, force: true });
		try {
			const { fn, calls } = makeMockExec({ paneDead: true });
			let error: unknown;
			try {
				await new TmuxAdapter("flywheel", fn, 10).execute(
					makeCtx({
						executionId,
						allowedTools: ["x".repeat(13_000)],
						launchCommitPath: join(promptDir, "commit"),
						launchGateToken: "command-budget-token",
						launchGeneration: 1,
						launchFingerprint: "command-budget-fingerprint",
						commitWorkflowLaunch: () => ({ ok: true }),
					}),
				);
			} catch (caught) {
				error = caught;
			}

			expect(error).toBeInstanceOf(LaunchPrecommitError);
			expect((error as LaunchPrecommitError).launchFailure).toEqual({
				code: "LAUNCH_COMMAND_OVERSIZE",
				reason: "tmux_command_budget",
				physicalEvidence: "absent",
			});
			expect((error as Error).message).toContain(
				"--allowed-tools value=13000B",
			);
			expect(calls.some((call) => call.args[0] === "new-window")).toBe(false);
		} finally {
			rmSync(promptDir, { recursive: true, force: true });
		}
	});

	it("rejects an oversized direct tmux command with the typed launch error", async () => {
		const executionId = "fly1869-direct-command-budget";
		const promptDir = join(tmpdir(), "flywheel-runner-prompts", executionId);
		rmSync(promptDir, { recursive: true, force: true });
		try {
			const { fn, calls } = makeMockExec({ paneDead: true });
			let error: unknown;
			try {
				await new TmuxAdapter("flywheel", fn, 10).execute(
					makeCtx({
						executionId,
						allowedTools: ["x".repeat(13_000)],
					}),
				);
			} catch (caught) {
				error = caught;
			}

			expect(error).toBeInstanceOf(LaunchCommandOversizeError);
			expect(error).toMatchObject({
				code: "LAUNCH_COMMAND_OVERSIZE",
				reason: "tmux_command_budget",
				budgetBytes: TMUX_COMMAND_BUDGET_BYTES,
			});
			expect((error as Error).message).toContain(
				"--allowed-tools value=13000B",
			);
			expect(calls.some((call) => call.args[0] === "new-window")).toBe(false);
		} finally {
			rmSync(promptDir, { recursive: true, force: true });
		}
	});

	it("canonicalizes and passes --model when specified", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(makeCtx({ model: "opus" }));

		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const args = newWindow!.args;
		expect(args).toContain("--model");
		expect(args[args.indexOf("--model") + 1]).toMatch(/^claude-opus-5/);
	});

	// FLY-1650 (Codex R1 HIGH): the model and the effort arrive from different
	// config keys — `roles.runner.model` vs `roles.runner.effort` — so the pair
	// is only knowable at this seam. Opus 4.6 predates the `xhigh` tier; without
	// a check here the flag rides straight to the CLI and comes back a 400.
	it("drops an --effort the resolved model does not support (Opus 4.6 has no xhigh)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(
			makeCtx({ model: "claude-opus-4-6[1m]", effort: "xhigh" }),
		);

		const args = calls.find((c) => c.args[0] === "new-window")!.args;
		expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-4-6[1m]");
		expect(args).not.toContain("--effort");
		expect(warn.mock.calls.flat().join(" ")).toMatch(/xhigh/);
		warn.mockRestore();
	});

	it("keeps an --effort the resolved model does support", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(
			makeCtx({ model: "claude-opus-4-6[1m]", effort: "high" }),
		);

		const args = calls.find((c) => c.args[0] === "new-window")!.args;
		expect(args[args.indexOf("--effort") + 1]).toBe("high");
	});

	it("leaves every other model's --effort byte-unchanged, xhigh included", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(makeCtx({ model: "opus", effort: "xhigh" }));

		const args = calls.find((c) => c.args[0] === "new-window")!.args;
		expect(args[args.indexOf("--effort") + 1]).toBe("xhigh");
	});

	it("omits --model entirely when no model is specified", async () => {
		// Absent stays absent: the account default is inherited, which is what
		// FLYWHEEL_RUNNER_DEFAULT_MODEL=off asks for. RoleAdapterResolver is the
		// layer that injects the fleet default when nobody opted out.
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(makeCtx());

		const newWindow = calls.find((call) => call.args[0] === "new-window");
		expect(newWindow!.args).not.toContain("--model");
	});

	it("rejects an unresolvable model before opening a tmux window", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await expect(
			adapter.execute(makeCtx({ model: "claude-not-a-model" })),
		).rejects.toThrow(/unknown model/i);
		expect(calls.some((call) => call.args[0] === "new-window")).toBe(false);
	});

	it("passes --allowed-tools when specified", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(makeCtx({ allowedTools: ["Read", "Bash"] }));

		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const args = newWindow!.args;
		expect(args).toContain("--allowed-tools");
		expect(args).toContain("Read");
		expect(args).toContain("Bash");
	});

	it("does NOT pass --max-turns (flag does not exist in CLI)", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(makeCtx({ maxTurns: 50 }));

		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const allArgs = newWindow!.args.join(" ");
		expect(allArgs).not.toContain("--max-turns");
	});

	it("does NOT pass --allowed-tools when array is empty", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(makeCtx({ allowedTools: [] }));

		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const allArgs = newWindow!.args.join(" ");
		expect(allArgs).not.toContain("--allowed-tools");
	});

	it("does NOT pass --max-budget-usd", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(makeCtx());

		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const allArgs = newWindow!.args.join(" ");
		expect(allArgs).not.toContain("--max-budget-usd");
	});

	it("passes --name when sessionDisplayName is set", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(
			makeCtx({ sessionDisplayName: "GEO-101 Fix auth bug" }),
		);

		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const args = newWindow!.args;
		expect(args).toContain("--name");
		expect(args).toContain("GEO-101 Fix auth bug");
	});

	it("does NOT pass --name when sessionDisplayName is absent", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(makeCtx());

		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const allArgs = newWindow!.args.join(" ");
		expect(allArgs).not.toContain("--name");
	});

	// ─── remain-on-exit ─────────────────────────────

	it("injects FLYWHEEL_MARKER_DIR into tmux session environment", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(makeCtx());

		const setEnvCalls = calls.filter((c) => c.args[0] === "set-environment");
		const markerDirCall = setEnvCalls.find(
			(c) => c.args.includes("FLYWHEEL_MARKER_DIR") && !c.args.includes("-u"),
		);
		expect(markerDirCall).toBeDefined();
		expect(markerDirCall!.args).toContain("-t");
		expect(markerDirCall!.args).toContain("=flywheel");
	});

	it("unsets CLAUDECODE env var to prevent nested Claude hang", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(makeCtx());

		const setEnvCalls = calls.filter((c) => c.args[0] === "set-environment");
		const unsetCall = setEnvCalls.find(
			(c) => c.args.includes("-u") && c.args.includes("CLAUDECODE"),
		);
		expect(unsetCall).toBeDefined();
		expect(unsetCall!.args).toContain("-t");
		expect(unsetCall!.args).toContain("=flywheel");
	});

	it("sets remain-on-exit on the exact new Claude window before commit release and scaffold prune", async () => {
		const base = makeMockExec({
			paneDead: true,
			windowId: "@42",
			listWindows: "@0|zsh\n@42|GEO-TEST-claude-fix",
		});
		const journal: string[] = [];
		const fn: ExecFileFn = (cmd, args) => {
			journal.push(`${cmd}:${args[0]}`);
			return base.fn(cmd, args);
		};
		const adapter = new TmuxAdapter("runner-test", fn, 10);

		await adapter.execute(
			makeCtx({
				launchCommitPath: "/tmp/fly1272-launch-commit",
				launchGateToken: "fly1272-token",
				launchGeneration: 1,
				launchFingerprint: "fly1272-fingerprint",
				commitWorkflowLaunch: () => {
					journal.push("commit-release");
					return { ok: true };
				},
			}),
		);

		const remainCalls = base.calls.filter(
			(c) => c.args[0] === "set-option" && c.args.includes("remain-on-exit"),
		);
		expect(remainCalls).toHaveLength(1);
		expect(remainCalls[0]?.args).toEqual([
			"set-option",
			"-w",
			"-t",
			"=runner-test:@42",
			"remain-on-exit",
			"on",
		]);
		expect(journal.indexOf("tmux:new-window")).toBeLessThan(
			journal.indexOf("tmux:set-option"),
		);
		expect(journal.indexOf("tmux:set-option")).toBeLessThan(
			journal.indexOf("commit-release"),
		);
		expect(journal.indexOf("commit-release")).toBeLessThan(
			journal.indexOf("tmux:list-windows"),
		);
	});

	it("kills only the exact new window and aborts before commit/prune when remain-on-exit fails", async () => {
		const base = makeMockExec({
			paneDead: true,
			windowId: "@42",
			listWindows: "@0|zsh\n@42|GEO-TEST-claude-fix",
		});
		const fn: ExecFileFn = (cmd, args) => {
			if (
				cmd === "tmux" &&
				args[0] === "set-option" &&
				args.includes("remain-on-exit")
			) {
				throw new Error("set-option failed");
			}
			return base.fn(cmd, args);
		};
		const commitWorkflowLaunch = vi.fn(() => ({ ok: true }));
		const adapter = new TmuxAdapter("runner-test", fn, 10);

		await expect(
			adapter.execute(
				makeCtx({
					launchCommitPath: "/tmp/fly1272-launch-commit-failure",
					launchGateToken: "fly1272-token",
					launchGeneration: 1,
					launchFingerprint: "fly1272-fingerprint",
					commitWorkflowLaunch,
				}),
			),
		).rejects.toThrow(/remain-on-exit.*runner-test:@42/i);
		expect(commitWorkflowLaunch).not.toHaveBeenCalled();
		expect(killWindowTargets(base.calls)).toEqual(["=runner-test:@42"]);
		expect(base.calls.some((c) => c.args[0] === "list-windows")).toBe(false);
	});

	it("does not set remain-on-exit for non-Claude tmux adapters", async () => {
		class NonClaudeAdapter extends TmuxAdapter {
			readonly type = "kimi-tmux";

			protected override buildCliArgs() {
				return { args: ["-p", "pointer"] };
			}
		}
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new NonClaudeAdapter("flywheel", fn, 10);

		await adapter.execute(makeCtx());

		expect(
			calls.some(
				(c) => c.args[0] === "set-option" && c.args.includes("remain-on-exit"),
			),
		).toBe(false);
	});

	// ─── Completion detection ───────────────────────

	it("resolves when pane_dead = 1 (fallback path) with timedOut=false", async () => {
		const { fn } = makeMockExecWithDelayedDead(1);
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		const result = await adapter.execute(makeCtx());

		expect(result.success).toBe(true);
		expect(result.timedOut).toBe(false);
	});

	it("resolves when window is gone entirely (catch path)", async () => {
		let pollCount = 0;
		const calls: ExecCall[] = [];
		const fn = (cmd: string, args: string[]): { stdout: string } => {
			calls.push({ cmd, args });
			if (cmd === "claude") return { stdout: "claude 2.1.63" };
			if (cmd === "tmux") {
				if (args[0] === "-V") return { stdout: "tmux 3.4" };
				if (args[0] === "has-session") throw new Error("not found");
				if (args[0] === "new-session") return { stdout: "" };
				if (args[0] === "set-environment") return { stdout: "" };
				if (args[0] === "set-option") return { stdout: "" };
				if (args[0] === "new-window")
					return { stdout: "@42|/tmp/tmux-test/default|1722700000" };
				if (args[0] === "list-panes") {
					pollCount++;
					if (pollCount >= 1) throw new Error("window gone");
				}
			}
			return { stdout: "" };
		};
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		const result = await adapter.execute(makeCtx());
		expect(result.success).toBe(true);
	});

	// ─── Timeout ────────────────────────────────────

	it("honors ctx.timeoutMs over default timeout", async () => {
		// Use a very short timeout + never-dead pane
		const { fn } = makeMockExec({ paneDead: false });
		const adapter = new TmuxAdapter("flywheel", fn, 10, 60000);

		// Short timeout should resolve quickly
		const start = Date.now();
		const result = await adapter.execute(makeCtx({ timeoutMs: 50 }));
		const elapsed = Date.now() - start;

		expect(result.success).toBe(true); // timeout resolves, not rejects
		expect(elapsed).toBeLessThan(5000); // should be fast
	});

	it("resolves on timeout with timedOut=true and kills zombie window (FLY-86)", async () => {
		const { fn, calls } = makeMockExec({ paneDead: false });
		const adapter = new TmuxAdapter("flywheel", fn, 10, 50); // 50ms default timeout

		const result = await adapter.execute(makeCtx());

		// Timeout resolves (not rejects) — Blueprint checks git for actual success
		expect(result.success).toBe(true);
		expect(result.tmuxWindow).toBeDefined();
		expect(result.timedOut).toBe(true);

		// FLY-86: Verify kill-window is called on timeout
		const killCalls = calls.filter(
			(c) => c.cmd === "tmux" && c.args[0] === "kill-window",
		);
		expect(killCalls.length).toBeGreaterThanOrEqual(1);
	});

	// ─── Return values ──────────────────────────────

	it("returns sessionId as UUID (same used for --session-id)", async () => {
		const { fn } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		const result = await adapter.execute(makeCtx());

		expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("captures window_id from tmux new-window -P -F", async () => {
		const { fn } = makeMockExec({ paneDead: true, windowId: "@99" });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		const result = await adapter.execute(makeCtx());

		expect(result.tmuxWindow).toBe("flywheel:@99");
	});

	it("uses window_id (not window_name) for polling", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true, windowId: "@55" });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(makeCtx({ label: "GEO-101" }));

		const listPanes = calls.find((c) => c.args[0] === "list-panes");
		expect(listPanes).toBeDefined();
		// Should use @55, not "GEO-101"
		const tIdx = listPanes!.args.indexOf("-t");
		expect(listPanes!.args[tIdx + 1]).toBe("@55");
	});

	it("returns tmuxWindow in format session:@id", async () => {
		const { fn } = makeMockExec({ paneDead: true, windowId: "@42" });
		const adapter = new TmuxAdapter("test-session", fn, 10);

		const result = await adapter.execute(makeCtx());

		expect(result.tmuxWindow).toBe("test-session:@42");
	});

	it("returns durationMs", async () => {
		const { fn } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		const result = await adapter.execute(makeCtx());

		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	// ─── Prompt positioning ─────────────────────────

	it("keeps options in CLI argv and appends the file-backed prompt at exec", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(
			makeCtx({
				prompt: "Fix the bug",
				permissionMode: "bypassPermissions",
			}),
		);

		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const args = newWindow!.args;
		// Find "claude" in args, then check the task prompt is no longer part of
		// tmux's command and the gated shell appends it only at exec time.
		const claudeIdx = args.indexOf("claude");
		const claudeArgs = args.slice(claudeIdx + 1);
		expect(args).not.toContain("Fix the bug");
		expect(readFileSync(promptFileFromTmuxArgs(args), "utf8")).toBe(
			"Fix the bug",
		);
		expect(args.some((arg) => arg.includes('exec "$@" "$p"'))).toBe(true);
		const permIdx = claudeArgs.indexOf("--permission-mode");
		expect(permIdx).toBeGreaterThan(-1);
	});

	// ─── v0.2: hookServer integration ──────────────

	describe("v0.2 hookServer mode", () => {
		function makeMockHookServer(
			options: { port?: number; resolveImmediately?: boolean } = {},
		) {
			const { port = 9876, resolveImmediately = true } = options;
			return {
				getPort: vi.fn(() => port),
				waitForCompletion: vi.fn(async (_token: string, _timeoutMs: number) => {
					if (resolveImmediately) {
						return {
							token: _token,
							sessionId: "hook-session",
							issueId: "GEO-42",
						};
					}
					// Never resolve — let pane_dead or timeout win
					return new Promise(() => {});
				}),
				cancelWait: vi.fn(),
			};
		}

		it("accepts optional hookServer in constructor", () => {
			const { fn } = makeMockExec();
			const hookServer = makeMockHookServer();
			const adapter = new TmuxAdapter("flywheel", fn, 10, 30000, hookServer);
			expect(adapter.type).toBe("claude-tmux");
		});

		it("execute() without hookServer — no env vars injected (v0.1.1 path)", async () => {
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter("flywheel", fn, 10);

			await adapter.execute(makeCtx());

			const newWindow = calls.find((c) => c.args[0] === "new-window");
			const args = newWindow!.args;
			expect(args.join(" ")).not.toContain("FLYWHEEL_CALLBACK_PORT");
			expect(args.join(" ")).not.toContain("FLYWHEEL_CALLBACK_TOKEN");
		});

		it("execute() with hookServer — env vars in tmux new-window args", async () => {
			const hookServer = makeMockHookServer({ port: 12345 });
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter("flywheel", fn, 10, 30000, hookServer);

			await adapter.execute(makeCtx({ issueId: "GEO-42" }));

			const newWindow = calls.find((c) => c.args[0] === "new-window");
			const args = newWindow!.args;

			// Check -e flags are present
			const envArgStr = args.join(" ");
			expect(envArgStr).toContain("FLYWHEEL_CALLBACK_PORT=12345");
			expect(envArgStr).toContain("FLYWHEEL_CALLBACK_TOKEN=");
			expect(envArgStr).toContain("FLYWHEEL_ISSUE_ID=GEO-42");
		});

		// GEO-206: commDbPath env injection
		it("execute() with commDbPath — injects FLYWHEEL_COMM_DB env", async () => {
			const hookServer = makeMockHookServer({ port: 12345 });
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter("flywheel", fn, 10, 30000, hookServer);

			await adapter.execute(
				makeCtx({ commDbPath: "/home/user/.flywheel/comm/geoforge3d/comm.db" }),
			);

			const newWindow = calls.find((c) => c.args[0] === "new-window");
			const envArgStr = newWindow!.args.join(" ");
			expect(envArgStr).toContain(
				"FLYWHEEL_COMM_DB=/home/user/.flywheel/comm/geoforge3d/comm.db",
			);
		});

		it("injects the engine submission expectation sentinel only when requested", async () => {
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter("flywheel", fn, 10);

			await adapter.execute(
				makeCtx({
					workflowSubmissionCredential: "decision-ticket",
					workflowSubmissionExpected: true,
					founderReviewRequired: true,
				}),
			);

			const newWindow = calls.find((c) => c.args[0] === "new-window");
			const envArgStr = newWindow!.args.join(" ");
			expect(envArgStr).toContain(
				"FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL=decision-ticket",
			);
			expect(envArgStr).toContain("FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED=1");
			expect(envArgStr).toContain("FLYWHEEL_FOUNDER_REVIEW_REQUIRED=1");

			const absent = makeMockExec({ paneDead: true });
			await new TmuxAdapter("flywheel", absent.fn, 10).execute(makeCtx());
			const absentWindow = absent.calls.find((c) => c.args[0] === "new-window");
			expect(absentWindow!.args.join(" ")).not.toContain(
				"FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED",
			);
			expect(absentWindow!.args.join(" ")).not.toContain(
				"FLYWHEEL_FOUNDER_REVIEW_REQUIRED",
			);
		});

		// FLY-1188: `send` routes wakes by the session row's vendor — the
		// claude adapter must register itself explicitly as "claude-code".
		it("execute() with commDbPath — registers the session with vendor=claude-code", async () => {
			const tmpDb = mkdtempSync(join(tmpdir(), "fly1188-tmux-vendor-"));
			try {
				const commDbPath = join(tmpDb, "comm.db");
				const { fn } = makeMockExec({ paneDead: true });
				const adapter = new TmuxAdapter("flywheel", fn, 10);
				await adapter.execute(makeCtx({ commDbPath }));

				const { CommDB } = await import("flywheel-comm/db");
				const db = new CommDB(commDbPath);
				expect(db.getSession("test-exec-1")?.vendor).toBe("claude-code");
				db.close();
			} finally {
				rmSync(tmpDb, { recursive: true, force: true });
			}
		});

		it("publishes the execution id on the exact runner window", async () => {
			const { fn, calls } = makeMockExec({
				paneDead: true,
				windowId: "@42",
			});

			await new TmuxAdapter("flywheel", fn, 10).execute(makeCtx());

			expect(
				calls.find(
					(call) =>
						call.cmd === "tmux" && call.args.includes("@flywheel_exec_id"),
				)?.args,
			).toEqual([
				"set-option",
				"-w",
				"-t",
				"=flywheel:@42",
				"@flywheel_exec_id",
				"test-exec-1",
			]);
		});

		it("execute() without commDbPath — no FLYWHEEL_COMM_DB env", async () => {
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter("flywheel", fn, 10);

			await adapter.execute(makeCtx());

			const newWindow = calls.find((c) => c.args[0] === "new-window");
			const args = newWindow!.args;
			expect(args.join(" ")).not.toContain("FLYWHEEL_COMM_DB");
		});

		it("passes a configured complete-marker directory into the runner window only when set", async () => {
			const original = process.env.FLYWHEEL_COMPLETE_MARKER_DIR;
			try {
				process.env.FLYWHEEL_COMPLETE_MARKER_DIR =
					"  /tmp/fly1608-slot/complete-failed  ";
				const present = makeMockExec({ paneDead: true });
				await new TmuxAdapter("flywheel", present.fn, 10).execute(makeCtx());
				const presentWindow = present.calls.find(
					(c) => c.args[0] === "new-window",
				);
				expect(presentWindow?.args.join(" ")).toContain(
					"FLYWHEEL_COMPLETE_MARKER_DIR=/tmp/fly1608-slot/complete-failed",
				);

				delete process.env.FLYWHEEL_COMPLETE_MARKER_DIR;
				const absent = makeMockExec({ paneDead: true });
				await new TmuxAdapter("flywheel", absent.fn, 10).execute(makeCtx());
				const absentWindow = absent.calls.find(
					(c) => c.args[0] === "new-window",
				);
				expect(absentWindow?.args.join(" ")).not.toContain(
					"FLYWHEEL_COMPLETE_MARKER_DIR",
				);
			} finally {
				if (original === undefined) {
					delete process.env.FLYWHEEL_COMPLETE_MARKER_DIR;
				} else {
					process.env.FLYWHEEL_COMPLETE_MARKER_DIR = original;
				}
			}
		});

		// GEO-266: FLYWHEEL_EXEC_ID env injection
		it("execute() always injects FLYWHEEL_EXEC_ID", async () => {
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter("flywheel", fn, 10);

			await adapter.execute(makeCtx({ executionId: "exec-abc-123" }));

			const newWindow = calls.find((c) => c.args[0] === "new-window");
			const envArgStr = newWindow!.args.join(" ");
			expect(envArgStr).toContain("FLYWHEEL_EXEC_ID=exec-abc-123");
		});

		it("execute() injects FLYWHEEL_EXEC_ID even without hookServer", async () => {
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter("flywheel", fn, 10);

			await adapter.execute(makeCtx());

			const newWindow = calls.find((c) => c.args[0] === "new-window");
			const envArgStr = newWindow!.args.join(" ");
			expect(envArgStr).toContain("FLYWHEEL_EXEC_ID=test-exec-1");
		});

		it("scrubs inherited Lead identity coordinates at the Runner tmux boundary", async () => {
			const { fn, calls } = makeMockExec({ paneDead: true });
			await new TmuxAdapter("flywheel", fn, 10).execute(
				makeCtx({ projectName: "canonical-project", leadId: "owner-lead" }),
			);

			const newWindow = calls.find((c) => c.args[0] === "new-window");
			const envValues = (newWindow?.args ?? [])
				.map((arg, index, args) => (args[index - 1] === "-e" ? arg : undefined))
				.filter((value): value is string => value !== undefined);
			expect(envValues).toEqual(
				expect.arrayContaining([
					"FLYWHEEL_PROJECT_NAME=canonical-project",
					"PROJECT_NAME=canonical-project",
					"FLYWHEEL_LEAD_ID=owner-lead",
					"LEAD_ID=",
					"DISCORD_STATE_DIR=",
					"DISCORD_IDENTITY_MODE=",
					"DISCORD_BOT_TOKEN=",
				]),
			);
		});

		// FLY-102 / FLY-159: BASH_MAX_TIMEOUT_MS env injection (49h to accommodate 48h gate timeout + 1h buffer)
		it("execute() always injects BASH_MAX_TIMEOUT_MS=176400000", async () => {
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter("flywheel", fn, 10);

			await adapter.execute(makeCtx());

			const newWindow = calls.find((c) => c.args[0] === "new-window");
			const envArgStr = newWindow!.args.join(" ");
			expect(envArgStr).toContain("BASH_MAX_TIMEOUT_MS=176400000");
		});

		// FLY-60 W2 (a): FLYWHEEL_LAND_STATUS_PATH injection so flywheel-comm
		// stage CLI can read landing-status.json and attach landing_status to
		// stage_changed=completed event payload.
		it("execute() injects FLYWHEEL_LAND_STATUS_PATH when ctx.sentinelPath present", async () => {
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter("flywheel", fn, 10);

			await adapter.execute(
				makeCtx({ sentinelPath: "/tmp/test-runs/exec-x/land-status.json" }),
			);

			const newWindow = calls.find((c) => c.args[0] === "new-window");
			const envArgStr = newWindow!.args.join(" ");
			expect(envArgStr).toContain(
				"FLYWHEEL_LAND_STATUS_PATH=/tmp/test-runs/exec-x/land-status.json",
			);
		});

		it("execute() omits FLYWHEEL_LAND_STATUS_PATH when ctx.sentinelPath absent", async () => {
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter("flywheel", fn, 10);

			await adapter.execute(makeCtx());

			const newWindow = calls.find((c) => c.args[0] === "new-window");
			const envArgStr = newWindow!.args.join(" ");
			expect(envArgStr).not.toContain("FLYWHEEL_LAND_STATUS_PATH");
		});

		it("waitForCompletion resolves on HTTP callback", async () => {
			const hookServer = makeMockHookServer({ resolveImmediately: true });
			const { fn } = makeMockExec({ paneDead: false });
			const adapter = new TmuxAdapter("flywheel", fn, 100, 5000, hookServer);

			const result = await adapter.execute(makeCtx());

			expect(result.timedOut).toBe(false);
			expect(hookServer.waitForCompletion).toHaveBeenCalled();
		});

		it("waitForCompletion resolves on pane_dead even with hookServer", async () => {
			// hookServer never resolves, but pane dies
			const hookServer = makeMockHookServer({ resolveImmediately: false });
			const { fn } = makeMockExecWithDelayedDead(1);
			const adapter = new TmuxAdapter("flywheel", fn, 10, 5000, hookServer);

			const result = await adapter.execute(makeCtx());

			expect(result.timedOut).toBe(false);
		});

		it("callbackToken is unique per execute() call", async () => {
			const hookServer = makeMockHookServer();
			const { fn } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter("flywheel", fn, 10, 30000, hookServer);

			await adapter.execute(makeCtx());
			await adapter.execute(makeCtx());

			const calls = hookServer.waitForCompletion.mock.calls;
			expect(calls).toHaveLength(2);
			const token1 = calls[0]![0];
			const token2 = calls[1]![0];
			expect(token1).not.toBe(token2);
		});

		it("timeout still works with hookServer", async () => {
			const hookServer = makeMockHookServer({ resolveImmediately: false });
			const { fn } = makeMockExec({ paneDead: false });
			const adapter = new TmuxAdapter("flywheel", fn, 100, 50, hookServer);

			const result = await adapter.execute(makeCtx());

			expect(result.timedOut).toBe(true);
		});

		it("v0.2 mode does not set FLYWHEEL_MARKER_DIR in session env", async () => {
			const hookServer = makeMockHookServer();
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter("flywheel", fn, 10, 30000, hookServer);

			await adapter.execute(makeCtx());

			const setEnvCalls = calls.filter((c) => c.args[0] === "set-environment");
			const markerDirCall = setEnvCalls.find(
				(c) => c.args.includes("FLYWHEEL_MARKER_DIR") && !c.args.includes("-u"),
			);
			expect(markerDirCall).toBeUndefined();
		});

		it("uses issueId from ctx (not label) for env var", async () => {
			const hookServer = makeMockHookServer({ port: 8888 });
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter("flywheel", fn, 10, 30000, hookServer);

			await adapter.execute(
				makeCtx({ label: "GEO-42-Fix auth bug", issueId: "GEO-42" }),
			);

			const newWindow = calls.find((c) => c.args[0] === "new-window");
			const args = newWindow!.args;
			expect(args.join(" ")).toContain("FLYWHEEL_ISSUE_ID=GEO-42");
		});

		// ─── FLY-921 Fix A: sessionId passed to hookServer ──────────

		it("waitForCompletion passes the runner's claudeSessionId as expectedSessionId", async () => {
			const hookServer = makeMockHookServer({ resolveImmediately: true });
			const { fn, calls } = makeMockExec({ paneDead: false });
			const adapter = new TmuxAdapter("flywheel", fn, 100, 5000, hookServer);

			await adapter.execute(makeCtx());

			// The session id the adapter generated is visible in the claude CLI args
			const newWindow = calls.find((c) => c.args[0] === "new-window");
			const args = newWindow!.args;
			const sessionIdIdx = args.findIndex((a) => a === "--session-id");
			expect(sessionIdIdx).toBeGreaterThan(-1);
			const claudeSessionId = args[sessionIdIdx + 1];

			expect(hookServer.waitForCompletion).toHaveBeenCalled();
			const call = hookServer.waitForCompletion.mock.calls[0]!;
			expect(call[2]).toBe(claudeSessionId);
		});

		it("nested-session callback (mismatched sessionId) does not settle; pane_dead settles later", async () => {
			// Mock a hookServer that honors expectedSessionId the way the real one
			// does post-FLY-921: a mismatched callback never resolves the promise.
			const waitForCompletion = vi.fn(
				(_token: string, _timeoutMs: number, _expected?: string) =>
					new Promise<never>(() => {}),
			);
			const hookServer = {
				getPort: vi.fn(() => 9876),
				waitForCompletion,
				cancelWait: vi.fn(),
			};
			const { fn } = makeMockExecWithDelayedDead(2);
			const adapter = new TmuxAdapter("flywheel", fn, 10, 5000, hookServer);

			const result = await adapter.execute(makeCtx());

			// Callback path never fired (nested session filtered); pane_dead backstop settled
			expect(result.timedOut).toBe(false);
			expect(waitForCompletion).toHaveBeenCalled();
			expect(waitForCompletion.mock.calls[0]![2]).toBeDefined();
		});
	});

	// =========================================================================
	// FLY-142 PR 1.2 — vendor-neutral Agent Team transport wiring
	// =========================================================================
	describe("FLY-142 PR 1.2 — Agent Team transport wiring", () => {
		function makeMockTransport() {
			const buildRunnerSpawnConfig = vi.fn(
				(ctx: { runnerName: string; teamName: string; leadName: string }) => ({
					args: [
						"--agent-id",
						`${ctx.runnerName}@${ctx.teamName}`,
						"--agent-name",
						ctx.runnerName,
						"--team-name",
						ctx.teamName,
					],
					env: {
						CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
						FLYWHEEL_AGENT_BACKEND: "claude-code",
					},
				}),
			);
			return { buildRunnerSpawnConfig };
		}

		it("spawn omits transport flags when transport is undefined (backward compat)", async () => {
			const { fn, calls } = makeMockExec({ paneDead: true });
			// 6th positional arg (transport) intentionally omitted.
			const adapter = new TmuxAdapter("flywheel", fn, 10, 30000);

			await adapter.execute(
				makeCtx({
					agentName: "runner-FLY-142-abc1",
					teamName: "cos-lead",
					vendor: "claude-code",
				}),
			);

			const newWindow = calls.find((c) => c.args[0] === "new-window");
			const joined = newWindow!.args.join(" ");
			expect(joined).not.toContain("--agent-id");
			expect(joined).not.toContain("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS");
		});

		it("spawn omits transport flags when ctx is missing agentName (backward compat)", async () => {
			const transport = makeMockTransport();
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter(
				"flywheel",
				fn,
				10,
				30000,
				undefined,
				transport,
			);

			// ctx has vendor but NO agentName/teamName → transport not invoked.
			await adapter.execute(makeCtx({ vendor: "claude-code" }));

			expect(transport.buildRunnerSpawnConfig).not.toHaveBeenCalled();
			const newWindow = calls.find((c) => c.args[0] === "new-window");
			const joined = newWindow!.args.join(" ");
			expect(joined).not.toContain("--agent-id");
			expect(joined).not.toContain("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS");
		});

		it("when transport + ctx fields all set, merges identity flags + env", async () => {
			const transport = makeMockTransport();
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter(
				"flywheel",
				fn,
				10,
				30000,
				undefined,
				transport,
			);

			await adapter.execute(
				makeCtx({
					leadId: "cos-lead",
					agentName: "runner-FLY-142-abc1",
					teamName: "cos-lead",
					leadSessionId: "lead-session-uuid",
					agentColor: "cyan",
					permissionMode: "bypassPermissions",
					vendor: "claude-code",
				}),
			);

			expect(transport.buildRunnerSpawnConfig).toHaveBeenCalledWith(
				expect.objectContaining({
					leadName: "cos-lead",
					runnerName: "runner-FLY-142-abc1",
					teamName: "cos-lead",
					parentSessionId: "lead-session-uuid",
					color: "cyan",
					permissionMode: "bypassPermissions",
				}),
			);

			const newWindow = calls.find((c) => c.args[0] === "new-window");
			const joined = newWindow!.args.join(" ");
			// Transport-supplied env vars present in tmux -e flags.
			expect(joined).toContain("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1");
			expect(joined).toContain("FLYWHEEL_AGENT_BACKEND=claude-code");
			// Transport-supplied identity flags present in claude args.
			expect(joined).toContain("--agent-id");
			expect(joined).toContain("runner-FLY-142-abc1@cos-lead");
			expect(joined).toContain("--team-name");
			expect(joined).toContain("cos-lead");
		});

		it("prepends transport identity flags before ctx flags and externalizes the prompt", async () => {
			const transport = makeMockTransport();
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter(
				"flywheel",
				fn,
				10,
				30000,
				undefined,
				transport,
			);

			await adapter.execute(
				makeCtx({
					prompt: "do work",
					leadId: "cos-lead",
					agentName: "runner-x",
					teamName: "cos-lead",
					vendor: "claude-code",
				}),
			);

			const newWindow = calls.find((c) => c.args[0] === "new-window");
			const args = newWindow!.args;
			// Transport identity still precedes buildClaudeArgs inside the gated
			// command's positional argv.
			expect(args.indexOf("--agent-id")).toBeLessThan(
				args.indexOf("--session-id"),
			);
			expect(args).not.toContain("do work");
			expect(readFileSync(promptFileFromTmuxArgs(args), "utf8")).toBe(
				"do work",
			);
			expect(args.some((arg) => arg.includes('exec "$@" "$p"'))).toBe(true);
		});

		it("transport throw is non-fatal — falls back to no-transport spawn", async () => {
			const transport = {
				buildRunnerSpawnConfig: vi.fn(() => {
					throw new Error("transport boom");
				}),
			};
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter(
				"flywheel",
				fn,
				10,
				30000,
				undefined,
				transport,
			);

			// Should NOT throw — adapter swallows transport error.
			await adapter.execute(
				makeCtx({
					leadId: "cos-lead",
					agentName: "runner-x",
					teamName: "cos-lead",
					vendor: "claude-code",
				}),
			);

			const newWindow = calls.find((c) => c.args[0] === "new-window");
			const joined = newWindow!.args.join(" ");
			expect(joined).not.toContain("--agent-id");
			expect(joined).not.toContain("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS");
		});
	});

	// =========================================================================
	// FLY-142 PR 1.4 — mailbox sentinel + commdb rollback gate (Codex r1 HIGH)
	// =========================================================================
	describe("FLY-142 PR 1.4 — mailbox sentinel + rollback gate", () => {
		const ORIGINAL_BACKEND = process.env.FLYWHEEL_COMM_BACKEND;
		// These assert the mailbox sentinel dir the adapter mkdir's under
		// `homedir()/.flywheel/runner-state`; isolate HOME to a temp dir so they
		// pass on a read-only real HOME (sandbox/CI) and never touch real state.
		const ORIGINAL_HOME = process.env.HOME;
		let tmpHome: string;
		beforeEach(() => {
			tmpHome = mkdtempSync(join(tmpdir(), "fly142-home-"));
			process.env.HOME = tmpHome;
		});
		afterEach(() => {
			if (ORIGINAL_BACKEND === undefined) {
				delete process.env.FLYWHEEL_COMM_BACKEND;
			} else {
				process.env.FLYWHEEL_COMM_BACKEND = ORIGINAL_BACKEND;
			}
			if (ORIGINAL_HOME === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = ORIGINAL_HOME;
			}
			rmSync(tmpHome, { recursive: true, force: true });
		});

		it("default (env unset → mailbox): writes sentinel + injects FLYWHEEL_RUNNER_STATE_DIR", async () => {
			delete process.env.FLYWHEEL_COMM_BACKEND;
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter("flywheel", fn, 10);

			await adapter.execute(makeCtx());

			const newWindow = calls.find((c) => c.args[0] === "new-window");
			const joined = newWindow!.args.join(" ");
			expect(joined).toContain("FLYWHEEL_RUNNER_STATE_DIR=");
			expect(joined).toContain("/.flywheel/runner-state/");
			expect(joined).toContain(
				"/mailbox-active".replace("/mailbox-active", ""),
			); // dir, not file
			expect(joined).not.toContain("FLYWHEEL_DISABLE_MAILBOX_SENTINEL=1");
		});

		it("FLYWHEEL_COMM_BACKEND=mailbox explicit: writes sentinel + injects state dir", async () => {
			process.env.FLYWHEEL_COMM_BACKEND = "mailbox";
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter("flywheel", fn, 10);

			await adapter.execute(makeCtx());

			const newWindow = calls.find((c) => c.args[0] === "new-window");
			const joined = newWindow!.args.join(" ");
			expect(joined).toContain("FLYWHEEL_RUNNER_STATE_DIR=");
			expect(joined).not.toContain("FLYWHEEL_DISABLE_MAILBOX_SENTINEL=1");
		});

		it("FLYWHEEL_COMM_BACKEND=commdb (rollback): does NOT write sentinel + propagates DISABLE=1 to Runner env (Codex r1 HIGH fix)", async () => {
			process.env.FLYWHEEL_COMM_BACKEND = "commdb";
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter("flywheel", fn, 10);

			await adapter.execute(makeCtx());

			const newWindow = calls.find((c) => c.args[0] === "new-window");
			const joined = newWindow!.args.join(" ");
			// Defense-in-depth: even if a stale sentinel exists from a prior
			// mailbox-mode spawn, hook must ignore it.
			expect(joined).toContain("FLYWHEEL_DISABLE_MAILBOX_SENTINEL=1");
			// Sentinel state dir env must NOT be set on rollback (no sentinel written).
			expect(joined).not.toContain("FLYWHEEL_RUNNER_STATE_DIR=");
		});

		it("FLYWHEEL_COMM_BACKEND=COMMDB (case-insensitive): treats as rollback", async () => {
			process.env.FLYWHEEL_COMM_BACKEND = "COMMDB";
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter("flywheel", fn, 10);

			await adapter.execute(makeCtx());

			const newWindow = calls.find((c) => c.args[0] === "new-window");
			const joined = newWindow!.args.join(" ");
			expect(joined).toContain("FLYWHEEL_DISABLE_MAILBOX_SENTINEL=1");
			expect(joined).not.toContain("FLYWHEEL_RUNNER_STATE_DIR=");
		});

		it("unknown backend value: defaults to mailbox (matches plugin.ts factory behavior)", async () => {
			process.env.FLYWHEEL_COMM_BACKEND = "garbage-value";
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter("flywheel", fn, 10);

			await adapter.execute(makeCtx());

			const newWindow = calls.find((c) => c.args[0] === "new-window");
			const joined = newWindow!.args.join(" ");
			// Adapter is conservative: any non-"commdb" value falls back to
			// sentinel-on (mailbox path). plugin.ts logs a warning and does
			// the same. This keeps the most-recoverable path as default.
			expect(joined).toContain("FLYWHEEL_RUNNER_STATE_DIR=");
			expect(joined).not.toContain("FLYWHEEL_DISABLE_MAILBOX_SENTINEL=1");
		});
	});

	// FLY-766: per-runner browser temp dir + owner marker (claude-tmux only).
	describe("FLY-766 — browser-tmp TMPDIR + owner marker", () => {
		const ORIGINAL_BACKEND = process.env.FLYWHEEL_COMM_BACKEND;
		const ORIGINAL_HOME = process.env.HOME;
		const OWNER_DB = "/Users/x/.flywheel/teamlead.db";
		// Isolate HOME to a temp dir so the adapter's real `homedir()`-based
		// browser-tmp/marker writes are hermetic + reproducible in sandboxed/CI
		// environments (never touch a developer's real ~/.flywheel/runner-state).
		let tmpHome: string;
		beforeEach(() => {
			tmpHome = mkdtempSync(join(tmpdir(), "fly766-home-"));
			process.env.HOME = tmpHome;
		});
		afterEach(() => {
			if (ORIGINAL_BACKEND === undefined) {
				delete process.env.FLYWHEEL_COMM_BACKEND;
			} else {
				process.env.FLYWHEEL_COMM_BACKEND = ORIGINAL_BACKEND;
			}
			if (ORIGINAL_HOME === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = ORIGINAL_HOME;
			}
			rmSync(tmpHome, { recursive: true, force: true });
		});

		function markerFor(execId: string): string {
			return join(
				tmpHome,
				".flywheel",
				"runner-state",
				execId,
				"browser-tmp",
				".flywheel-owner.json",
			);
		}

		it("claude-tmux (mailbox): injects TMPDIR=…/browser-tmp + writes owner marker with the threaded db path", async () => {
			delete process.env.FLYWHEEL_COMM_BACKEND;
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter(
				"flywheel",
				fn,
				10,
				undefined,
				undefined,
				undefined,
				OWNER_DB,
			);

			await adapter.execute(makeCtx({ executionId: "fly766-mbx" }));

			const joined = calls
				.find((c) => c.args[0] === "new-window")!
				.args.join(" ");
			expect(joined).toContain("TMPDIR=");
			expect(joined).toContain("/browser-tmp");
			const marker = JSON.parse(readFileSync(markerFor("fly766-mbx"), "utf-8"));
			expect(marker.execId).toBe("fly766-mbx");
			expect(marker.stateDbPath).toBe(OWNER_DB);
		});

		it("claude-tmux (commdb rollback): STILL injects TMPDIR (gated on type, not backend)", async () => {
			process.env.FLYWHEEL_COMM_BACKEND = "commdb";
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter(
				"flywheel",
				fn,
				10,
				undefined,
				undefined,
				undefined,
				OWNER_DB,
			);

			await adapter.execute(makeCtx({ executionId: "fly766-rb" }));

			const joined = calls
				.find((c) => c.args[0] === "new-window")!
				.args.join(" ");
			expect(joined).toContain("TMPDIR=");
			expect(joined).toContain("/browser-tmp");
			// Rollback still skips the mailbox sentinel dir.
			expect(joined).not.toContain("FLYWHEEL_RUNNER_STATE_DIR=");
		});

		it("owner marker stateDbPath is null when no ownerStateDbPath is threaded", async () => {
			delete process.env.FLYWHEEL_COMM_BACKEND;
			const { fn } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter("flywheel", fn, 10);
			await adapter.execute(makeCtx({ executionId: "fly766-noown" }));
			const marker = JSON.parse(
				readFileSync(markerFor("fly766-noown"), "utf-8"),
			);
			expect(marker.stateDbPath).toBeNull();
		});

		it("non-claude adapter (kimi/agy type) does NOT inject TMPDIR (v1 scope gate)", async () => {
			delete process.env.FLYWHEEL_COMM_BACKEND;
			// Real Kimi/Antigravity adapters inherit this base `execute()` and set a
			// non-"claude-tmux" `type`; a minimal subclass isolates the gate without
			// their fail-closed auth preflight.
			class NonClaudeAdapter extends TmuxAdapter {
				readonly type = "kimi-tmux";

				protected override buildCliArgs() {
					return { args: ["-p", "pointer"] };
				}
			}
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new NonClaudeAdapter(
				"flywheel",
				fn,
				10,
				undefined,
				undefined,
				undefined,
				OWNER_DB,
			);
			await adapter.execute(makeCtx({ executionId: "fly766-kimi" }));
			const joined = calls
				.find((c) => c.args[0] === "new-window")!
				.args.join(" ");
			expect(joined).not.toContain("TMPDIR=");
			expect(existsSync(markerFor("fly766-kimi"))).toBe(false);
		});
	});

	// FLY-159 Codex r1 R1 HIGH: waiting cap must measure per-wait-period,
	// not session-total. A 46h-active Runner that enters a 48h gate must
	// still get a full 48h wait budget (+ 1h buffer = 49h cap).
	describe("FLY-159: per-wait-period hard cap (Codex r1 R1)", () => {
		const HARD_CAP_49H = 176_400_000;

		it("returns false when not currently waiting (lastWaitStart=null)", () => {
			expect(
				TmuxAdapter._isWaitingPeriodExpired(null, Date.now(), HARD_CAP_49H),
			).toBe(false);
		});

		it("returns false when wait elapsed < cap", () => {
			const lastWaitStart = 1_000;
			const now = lastWaitStart + 47 * 3600 * 1000; // 47h in
			expect(
				TmuxAdapter._isWaitingPeriodExpired(lastWaitStart, now, HARD_CAP_49H),
			).toBe(false);
		});

		it("returns false at the exact cap boundary (not strictly greater)", () => {
			const lastWaitStart = 1_000;
			const now = lastWaitStart + HARD_CAP_49H;
			expect(
				TmuxAdapter._isWaitingPeriodExpired(lastWaitStart, now, HARD_CAP_49H),
			).toBe(false);
		});

		it("returns true 1ms past the cap", () => {
			const lastWaitStart = 1_000;
			const now = lastWaitStart + HARD_CAP_49H + 1;
			expect(
				TmuxAdapter._isWaitingPeriodExpired(lastWaitStart, now, HARD_CAP_49H),
			).toBe(true);
		});

		it("session-total time does NOT factor in (the HIGH bug fix)", () => {
			// Simulate: Runner spent 46h on active work, THEN entered wait.
			// Pre-fix: session_elapsed (46h+wait) was compared to 49h cap →
			// wait killed at 3h, gate's 48h timer never fires → silent bypass.
			// Post-fix: only the current wait window matters.
			const sessionStart = 1_000;
			const lastWaitStart = sessionStart + 46 * 3600 * 1000; // 46h into session
			const now = lastWaitStart + 47 * 3600 * 1000; // 47h into wait, 93h session-total
			expect(
				TmuxAdapter._isWaitingPeriodExpired(lastWaitStart, now, HARD_CAP_49H),
			).toBe(false);
		});
	});

	// FLY-159 Codex r2+r3: outer hardTimeoutMs must be generous enough
	// that the inner per-wait cap fires FIRST. Pre-fix it was 49h
	// (session-total), which would preempt the inner cap. Round 2 fix used
	// `* 3` multiplier — Codex r3 MEDIUM caught that 4+ sequential gates
	// (brainstorm + N question + approve_to_ship) would still preempt.
	// Final: `waitingBudget * 7` ≈ 14.3 days, fits inside setTimeout max.
	// (Multiplier 14 → 7 when gate timeout bumped 24h → 48h; product stays
	// ≈ 14 days.)
	describe("FLY-159: outer ultra-safety hard timeout (Codex r2+r3)", () => {
		const HARD_CAP_49H = 176_400_000;
		const SET_TIMEOUT_MAX_MS = 2_147_483_647; // 2^31 - 1

		it("is at least 7x the waiting budget so inner cap always fires first", () => {
			const timeoutMs = 5_400_000; // 1.5h active
			const outer = TmuxAdapter._computeOuterHardTimeoutMs(
				timeoutMs,
				HARD_CAP_49H,
			);
			expect(outer).toBeGreaterThanOrEqual(HARD_CAP_49H * 7);
		});

		it("never returns less than the active timeout (degenerate inputs)", () => {
			const timeoutMs = 172_800_000; // 48h active (degenerate large)
			const outer = TmuxAdapter._computeOuterHardTimeoutMs(timeoutMs, 0);
			expect(outer).toBeGreaterThanOrEqual(timeoutMs);
		});

		it("equals waitingBudget * 7 at production defaults", () => {
			const timeoutMs = 5_400_000; // 1.5h
			const outer = TmuxAdapter._computeOuterHardTimeoutMs(
				timeoutMs,
				HARD_CAP_49H,
			);
			// 7 * 49h = 343h = 1.235 billion ms
			expect(outer).toBe(HARD_CAP_49H * 7);
		});

		it("fits inside Node's setTimeout max (2^31-1 ms ≈ 24.85 days)", () => {
			const outer = TmuxAdapter._computeOuterHardTimeoutMs(
				5_400_000,
				HARD_CAP_49H,
			);
			expect(outer).toBeLessThanOrEqual(SET_TIMEOUT_MAX_MS);
		});

		it("allows 46h active + 48h gate (94h realistic) without preempting", () => {
			// Round 1 regression scenario, scaled for 48h gate timeout.
			const outer = TmuxAdapter._computeOuterHardTimeoutMs(
				5_400_000,
				HARD_CAP_49H,
			);
			const realisticSessionMs = (46 + 48) * 3600 * 1000; // 94h
			expect(outer).toBeGreaterThan(realisticSessionMs);
		});

		it("allows 4+ sequential 48h gates (Codex r3 regression)", () => {
			// Worst-case Runner: brainstorm gate (48h) + 2 question gates
			// (each 48h) + approve_to_ship gate (48h) = 192h waits + active
			// time in between. Round 3 final multiplier (* 7) at 49h
			// waitingBudget gives 343h — covers the 4-gate worst case.
			const outer = TmuxAdapter._computeOuterHardTimeoutMs(
				5_400_000,
				HARD_CAP_49H,
			);
			const fourGateSessionMs = 4 * 48 * 3600 * 1000 + 5_400_000 * 4; // 192h waits + ~6h active
			expect(outer).toBeGreaterThan(fourGateSessionMs);
		});
	});
});

describe("FLY-1253: production claude-tmux review-wait compatibility", () => {
	function controllablePane(windowId: string) {
		const calls: ExecCall[] = [];
		let paneDead = false;
		const fn: ExecFileFn = (cmd, args) => {
			calls.push({ cmd, args });
			if (cmd === "claude") return { stdout: "claude 2.1.63" };
			if (cmd !== "tmux") return { stdout: "" };
			switch (args[0]) {
				case "-V":
					return { stdout: "tmux 3.4" };
				case "has-session":
					throw new Error("not found");
				case "new-session":
				case "set-environment":
				case "set-option":
				case "list-windows":
				case "kill-window":
					return { stdout: "" };
				case "new-window":
					return {
						stdout: `${windowId}|/tmp/tmux-test/default|1722700000`,
					};
				case "list-panes":
					return { stdout: paneDead ? "1|0" : "0|" };
				default:
					return { stdout: "" };
			}
		};
		return {
			calls,
			fn,
			markDead: () => {
				paneDead = true;
			},
		};
	}

	it("characterizes production claude-tmux across bound review wait", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "flywheel-tmux-bound-wait-"));
		const commDbPath = join(tmpDir, "comm.db");
		const db = new CommDB(commDbPath);
		const questionId = db.insertQuestion(
			"test-exec-1",
			"flywheel-eng-lead",
			"review this head",
			{ checkpoint: "review_code" },
		);
		const pane = controllablePane("@42");
		const heartbeats: string[] = [];
		let settled = false;

		try {
			const adapter = new TmuxAdapter("flywheel", pane.fn, 5, 25);
			const run = adapter
				.execute(
					makeCtx({
						commDbPath,
						timeoutMs: 25,
						waitingTimeoutMs: 500,
						onHeartbeat: (id) => heartbeats.push(id),
					}),
				)
				.finally(() => {
					settled = true;
				});

			await new Promise((resolve) => setTimeout(resolve, 70));
			expect(settled).toBe(false);
			expect(heartbeats.length).toBeGreaterThan(2);
			expect(killWindowTargets(pane.calls)).toEqual([]);

			db.insertResponse(questionId, "flywheel-eng-lead", "APPROVED");
			pane.markDead();
			const result = await run;

			expect(result.timedOut).toBe(false);
			expect(result.tmuxWindow).toBe("flywheel:@42");
			expect(
				pane.calls.filter((call) => call.args[0] === "new-window"),
			).toHaveLength(1);
			expect(killWindowTargets(pane.calls)).toEqual([]);
		} finally {
			db.close();
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it("keeps the ordinary active timeout when no question is pending", async () => {
		const tmpDir = mkdtempSync(join(tmpdir(), "flywheel-tmux-no-wait-"));
		const commDbPath = join(tmpDir, "comm.db");
		const db = new CommDB(commDbPath);
		const pane = controllablePane("@43");
		try {
			const adapter = new TmuxAdapter("flywheel", pane.fn, 5, 25);
			const result = await adapter.execute(
				makeCtx({ commDbPath, timeoutMs: 25, waitingTimeoutMs: 500 }),
			);
			expect(result.timedOut).toBe(true);
			expect(killWindowTargets(pane.calls)).toContain("@43");
		} finally {
			db.close();
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

// ─── FLY-758: win0 scaffold prune ────────────────────────────────────────────

describe("pruneScaffoldWindow (FLY-758)", () => {
	function mockExec(
		listWindows: string,
		opts: { throwOnList?: boolean } = {},
	): { fn: ExecFileFn; calls: ExecCall[] } {
		const calls: ExecCall[] = [];
		const fn: ExecFileFn = (cmd, args) => {
			calls.push({ cmd, args });
			if (cmd === "tmux" && args[0] === "list-windows") {
				if (opts.throwOnList) throw new Error("tmux list-windows failed");
				return { stdout: listWindows };
			}
			return { stdout: "" };
		};
		return { fn, calls };
	}

	it("prunes the win0 zsh scaffold in a runner-* session", () => {
		const { fn, calls } = mockExec("@0|zsh\n@42|GEO-TEST-claude-fix");
		pruneScaffoldWindow(fn, "runner-test", "@42");
		expect(killWindowTargets(calls)).toEqual(["@0"]);
	});

	it("prunes a bash scaffold too", () => {
		const { fn, calls } = mockExec("@0|bash\n@42|GEO-TEST-claude-fix");
		pruneScaffoldWindow(fn, "runner-test", "@42");
		expect(killWindowTargets(calls)).toEqual(["@0"]);
	});

	it("never prunes when only the runner window exists (would kill the session)", () => {
		const { fn, calls } = mockExec("@42|GEO-TEST-claude-fix");
		pruneScaffoldWindow(fn, "runner-test", "@42");
		expect(killWindowTargets(calls)).toEqual([]);
	});

	it("never prunes a runner-named window", () => {
		const { fn, calls } = mockExec("@1|GEO-A-claude-a\n@2|GEO-B-claude-b");
		pruneScaffoldWindow(fn, "runner-test", "@1");
		expect(killWindowTargets(calls)).toEqual([]);
	});

	it("runner-* scope guard: makes no tmux call for a non-runner session", () => {
		const { fn, calls } = mockExec("@0|zsh\n@42|GEO-TEST-claude-fix");
		pruneScaffoldWindow(fn, "flywheel", "@42");
		// Guard returns before any tmux invocation — protects the Lead/base session.
		expect(calls).toHaveLength(0);
	});

	it("never kills the just-created windowId even if it is shell-named (defense in depth)", () => {
		const { fn, calls } = mockExec("@42|zsh\n@7|GEO-TEST-claude-fix");
		// @42 is the runner we just created; it must be skipped even though named "zsh".
		pruneScaffoldWindow(fn, "runner-test", "@42");
		expect(killWindowTargets(calls)).toEqual([]);
	});

	it("only prunes zsh/bash, not sh or dash-shells (cmux-sync predicate alignment)", () => {
		const { fn, calls } = mockExec(
			"@0|sh\n@1|-zsh\n@2|-bash\n@42|GEO-TEST-claude-fix",
		);
		pruneScaffoldWindow(fn, "runner-test", "@42");
		expect(killWindowTargets(calls)).toEqual([]);
	});

	it("is best-effort: a list-windows failure never throws", () => {
		const { fn } = mockExec("", { throwOnList: true });
		expect(() => pruneScaffoldWindow(fn, "runner-test", "@42")).not.toThrow();
	});

	it("wiring: execute() prunes the win0 scaffold for a runner-* session", async () => {
		const { fn, calls } = makeMockExec({
			paneDead: true,
			windowId: "@42",
			listWindows: "@0|zsh\n@42|GEO-TEST-claude-fix",
		});
		const adapter = new TmuxAdapter("runner-test", fn, 10);
		await adapter.execute(makeCtx());
		const targets = killWindowTargets(calls);
		expect(targets).toContain("@0"); // scaffold pruned
		expect(targets).not.toContain("@42"); // runner window never killed
	});
});

// ─── FLY-758: scaffold naming (defeats the async automatic-rename race) ───────

describe("ensureRunnerSession (FLY-758)", () => {
	function renameCalls(calls: ExecCall[]): ExecCall[] {
		return calls.filter(
			(c) => c.cmd === "tmux" && c.args.includes("rename-window"),
		);
	}

	function mockExec(opts: { sessionExists?: boolean; scaffoldId?: string }): {
		fn: ExecFileFn;
		asyncFn: AsyncExecFileFn;
		calls: ExecCall[];
	} {
		const calls: ExecCall[] = [];
		const fn: ExecFileFn = (cmd, args) => {
			calls.push({ cmd, args });
			return { stdout: "" };
		};
		const asyncFn: AsyncExecFileFn = async (cmd, args) => {
			calls.push({ cmd, args });
			return {
				stdout: JSON.stringify({
					action: opts.sessionExists ? "verified" : "created",
					createStdout: opts.sessionExists ? "" : (opts.scaffoldId ?? "@0"),
					reachablePid: 100,
				}),
				stderr: "",
			};
		};
		return { fn, asyncFn, calls };
	}

	it("creates the session through the guard and renames the scaffold window to zsh (runner-* session)", async () => {
		const { fn, asyncFn, calls } = mockExec({
			sessionExists: false,
			scaffoldId: "@0",
		});
		await ensureRunnerSession(fn, "runner-test", { asyncExecFileFn: asyncFn });
		expect(calls[0].cmd).toContain("tmux-server-rescue");
		expect(calls[0].args).toContain("--verify");
		expect(calls[0].args).toContain("--create");
		const rn = renameCalls(calls);
		expect(rn).toHaveLength(1);
		expect(rn[0].args).toEqual(
			expect.arrayContaining(["rename-window", "-t", "@0", "zsh"]),
		);
	});

	it("does not issue any unguarded tmux create when the session already exists", async () => {
		const { fn, asyncFn, calls } = mockExec({ sessionExists: true });
		await ensureRunnerSession(fn, "runner-test", { asyncExecFileFn: asyncFn });
		expect(
			calls.filter((c) => c.cmd === "tmux" && c.args[0] === "new-session"),
		).toHaveLength(0);
		expect(renameCalls(calls)).toHaveLength(0);
	});

	it("uses the 90s per-attempt cap by default", async () => {
		const seenTimeouts: Array<number | undefined> = [];
		const fn: ExecFileFn = () => ({ stdout: "" });
		const asyncFn: AsyncExecFileFn = async (_cmd, _args, opts) => {
			seenTimeouts.push(opts?.timeoutMs);
			return {
				stdout: JSON.stringify({
					action: "verified",
					createStdout: "",
					reachablePid: 100,
				}),
				stderr: "",
			};
		};
		await ensureRunnerSession(fn, "runner-test", { asyncExecFileFn: asyncFn });
		expect(seenTimeouts[0]).toBe(90_000);
	});

	it("honors an injected per-attempt cap and a self-consistent non-default budget tuple", async () => {
		const seenTimeouts: Array<number | undefined> = [];
		const fn: ExecFileFn = () => ({ stdout: "" });
		const asyncFn: AsyncExecFileFn = async (_cmd, _args, opts) => {
			seenTimeouts.push(opts?.timeoutMs);
			return {
				stdout: JSON.stringify({
					action: "verified",
					createStdout: "",
					reachablePid: 100,
				}),
				stderr: "",
			};
		};
		const lockBaseSec = 5;
		const factorMax = 8;
		const totalBudgetSec = 100;
		const startupMarginSec = 5;
		const attemptCapMs = 150_000;
		const deadlineMs = 321_000;
		expect(attemptCapMs).toBeGreaterThanOrEqual(
			(lockBaseSec * factorMax + totalBudgetSec + startupMarginSec) * 1_000,
		);
		expect(deadlineMs).toBeGreaterThan(2 * attemptCapMs + 1_000);
		await ensureRunnerSession(fn, "runner-test", {
			asyncExecFileFn: asyncFn,
			attemptCapMs,
			deadlineMs,
		});
		expect(seenTimeouts[0]).toBe(attemptCapMs);
	});

	it("defaults the overall ensure deadline to 210s", async () => {
		vi.useFakeTimers();
		const previous = process.env.FLYWHEEL_TMUX_ENSURE_DEADLINE_MS;
		delete process.env.FLYWHEEL_TMUX_ENSURE_DEADLINE_MS;
		try {
			const fn: ExecFileFn = () => ({ stdout: "" });
			const asyncFn: AsyncExecFileFn = () => new Promise(() => {});
			let state: "pending" | "rejected" = "pending";
			const observed = ensureRunnerSession(fn, "runner-test", {
				asyncExecFileFn: asyncFn,
				attemptCapMs: 300_000,
				retryDelayMs: 0,
			}).then(
				() => undefined,
				() => {
					state = "rejected";
				},
			);
			await vi.advanceTimersByTimeAsync(100_000);
			expect(state).toBe("pending");
			await vi.advanceTimersByTimeAsync(111_000);
			await observed;
			expect(state).toBe("rejected");
		} finally {
			if (previous === undefined) {
				delete process.env.FLYWHEEL_TMUX_ENSURE_DEADLINE_MS;
			} else {
				process.env.FLYWHEEL_TMUX_ENSURE_DEADLINE_MS = previous;
			}
			vi.useRealTimers();
		}
	});

	it("never renames a non-runner session's scaffold (but still guards it)", async () => {
		const { fn, asyncFn, calls } = mockExec({
			sessionExists: false,
			scaffoldId: "@0",
		});
		await ensureRunnerSession(fn, "flywheel", { asyncExecFileFn: asyncFn });
		expect(renameCalls(calls)).toHaveLength(0);
		expect(calls.some((c) => c.cmd.includes("tmux-server-rescue"))).toBe(true);
	});

	it("fails closed with a typed hold instead of falling back to plain create", async () => {
		const fn: ExecFileFn = () => ({ stdout: "" });
		const asyncFn: AsyncExecFileFn = async () => {
			const err = new Error("guarded hold") as Error & {
				code: number;
				stdout: string;
			};
			err.code = 2;
			err.stdout = JSON.stringify({
				action: "hold_saturated",
				evidence: { reason: "socket_present_unreachable" },
			});
			throw err;
		};
		await expect(
			ensureRunnerSession(fn, "runner-test", {
				asyncExecFileFn: asyncFn,
				deadlineMs: 1,
				retryDelayMs: 0,
			}),
		).rejects.toMatchObject({ kind: "saturated" });
	});

	it("rejects an exit-0 helper payload whose action is not a success verdict", async () => {
		const fn: ExecFileFn = () => ({ stdout: "" });
		const asyncFn: AsyncExecFileFn = async () => ({
			stdout: JSON.stringify({
				action: "hold_unknown",
				reachablePid: 100,
			}),
			stderr: "",
		});
		await expect(
			ensureRunnerSession(fn, "runner-test", {
				asyncExecFileFn: asyncFn,
				deadlineMs: 1,
				retryDelayMs: 0,
			}),
		).rejects.toMatchObject({
			kind: "unknown",
			evidence: { reason: "invalid_helper_output" },
		});
	});

	it("a hung first guard probe yields the event loop and expires as a typed hold", async () => {
		vi.useFakeTimers();
		const fn: ExecFileFn = () => ({ stdout: "" });
		const asyncFn: AsyncExecFileFn = () => new Promise(() => {});
		let timerServed = false;
		setTimeout(() => {
			timerServed = true;
		}, 5);
		const pending = ensureRunnerSession(fn, "runner-test", {
			asyncExecFileFn: asyncFn,
			deadlineMs: 20,
			retryDelayMs: 1,
		});
		const rejection =
			expect(pending).rejects.toBeInstanceOf(TmuxSessionHoldError);
		await vi.advanceTimersByTimeAsync(25);
		expect(timerServed).toBe(true);
		await rejection;
		vi.useRealTimers();
	});
});
