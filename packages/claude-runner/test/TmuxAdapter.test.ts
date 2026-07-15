import { spawn } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import type { AdapterExecutionContext } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We'll test TmuxAdapter by injecting a mock execFileFn
import type { ExecFileFn } from "../src/TmuxAdapter.js";
import {
	ensureRunnerSession,
	pruneScaffoldWindow,
	TmuxAdapter,
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
		...overrides,
	};
}

interface ExecCall {
	cmd: string;
	args: string[];
}

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
				return { stdout: windowId };
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
			if (subcommand === "new-window") return { stdout: windowId };
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
			expect(newWindow?.args.some((a) => a.includes("exec claude"))).toBe(true);
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
			expect(newWindow?.args.some((a) => a.includes("exec claude"))).toBe(true);
			expect(existsSync(commitFile)).toBe(false); // no commit → replay re-drives
			expect(
				calls.find((c) => c.cmd === "tmux" && c.args[0] === "list-panes"),
			).toBeUndefined();
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("the NORMAL fleet path (no launchCommitPath) launches Claude DIRECTLY (byte-unchanged)", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);
		await adapter.execute(makeCtx());
		const newWindow = calls.find(
			(c) => c.cmd === "tmux" && c.args[0] === "new-window",
		);
		// command segment is `claude ...` directly — no gating shell wrapper
		expect(newWindow?.args).toContain("claude");
		expect(newWindow?.args).not.toContain("sh");
	});

	// ─── FLY-615: ponytail --settings flag ───────────
	const PONYTAIL_SETTINGS_JSON =
		'{"enabledPlugins":{"ponytail@ponytail":true}}';

	it("FLY-615: enablePonytail adds --settings <json> (normal path)", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);
		await adapter.execute(makeCtx({ enablePonytail: true }));
		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const idx = newWindow!.args.indexOf("--settings");
		expect(idx).toBeGreaterThan(-1);
		expect(newWindow!.args[idx + 1]).toBe(PONYTAIL_SETTINGS_JSON);
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
			expect(newWindow!.args[idx + 1]).toBe(PONYTAIL_SETTINGS_JSON);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	it("FLY-615: no enablePonytail → no --settings (byte-compatible)", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);
		await adapter.execute(makeCtx());
		const newWindow = calls.find((c) => c.args[0] === "new-window");
		expect(newWindow!.args).not.toContain("--settings");
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
		expect(newWindow!.args[idx + 1]).toBe(
			'{"enabledPlugins":{"discord@claude-plugins-official":false,"serena@claude-plugins-official":false}}',
		);
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
		expect(newWindow!.args[idx + 1]).toBe(
			'{"enabledPlugins":{"ponytail@ponytail":true,"discord@claude-plugins-official":false}}',
		);
	});

	it("FLY-751: disableChrome → --no-chrome BEFORE the prompt (last positional)", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);
		await adapter.execute(makeCtx({ disableChrome: true }));
		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const noChromeIdx = newWindow!.args.indexOf("--no-chrome");
		expect(noChromeIdx).toBeGreaterThan(-1);
		// prompt is the final arg of the window command
		expect(noChromeIdx).toBeLessThan(newWindow!.args.length - 1);
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

	it("FLY-751: empty disabledPlugins + no chrome flag → byte-compatible argv", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);
		await adapter.execute(makeCtx({ disabledPlugins: [] }));
		const newWindow = calls.find((c) => c.args[0] === "new-window");
		expect(newWindow!.args).not.toContain("--settings");
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

	it("passes --model when specified", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(makeCtx({ model: "opus" }));

		const newWindow = calls.find((c) => c.args[0] === "new-window");
		const args = newWindow!.args;
		expect(args).toContain("--model");
		expect(args).toContain("opus");
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

	it("sets remain-on-exit on", async () => {
		const { fn, calls } = makeMockExec({ paneDead: true });
		const adapter = new TmuxAdapter("flywheel", fn, 10);

		await adapter.execute(makeCtx());

		const setOption = calls.find((c) => c.args[0] === "set-option");
		expect(setOption).toBeDefined();
		expect(setOption!.args).toContain("remain-on-exit");
		expect(setOption!.args).toContain("on");
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
				if (args[0] === "new-window") return { stdout: "@42" };
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

	it("puts prompt as last positional argument (options before prompt)", async () => {
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
		// Find "claude" in args, then check prompt is last
		const claudeIdx = args.indexOf("claude");
		const claudeArgs = args.slice(claudeIdx + 1);
		// Prompt should be last
		expect(claudeArgs[claudeArgs.length - 1]).toBe("Fix the bug");
		// --permission-mode should come before prompt
		const permIdx = claudeArgs.indexOf("--permission-mode");
		expect(permIdx).toBeLessThan(claudeArgs.length - 1);
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

		it("execute() without commDbPath — no FLYWHEEL_COMM_DB env", async () => {
			const { fn, calls } = makeMockExec({ paneDead: true });
			const adapter = new TmuxAdapter("flywheel", fn, 10);

			await adapter.execute(makeCtx());

			const newWindow = calls.find((c) => c.args[0] === "new-window");
			const args = newWindow!.args;
			expect(args.join(" ")).not.toContain("FLYWHEEL_COMM_DB");
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

		it("transport identity flags are prepended BEFORE ctx flags so prompt stays last", async () => {
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
			const claudeIdx = args.indexOf("claude");
			expect(claudeIdx).toBeGreaterThan(-1);
			// First flag after `claude` should be from transport (--agent-id),
			// not from buildClaudeArgs (--session-id).
			expect(args[claudeIdx + 1]).toBe("--agent-id");
			// Last positional MUST be the prompt — never overtaken by transport flags.
			expect(args[args.length - 1]).toBe("do work");
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
					return { stdout: windowId };
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
		const pane = controllablePane("@bound-wait");
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
			expect(result.tmuxWindow).toBe("flywheel:@bound-wait");
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
		const pane = controllablePane("@no-wait");
		try {
			const adapter = new TmuxAdapter("flywheel", pane.fn, 5, 25);
			const result = await adapter.execute(
				makeCtx({ commDbPath, timeoutMs: 25, waitingTimeoutMs: 500 }),
			);
			expect(result.timedOut).toBe(true);
			expect(killWindowTargets(pane.calls)).toContain("@no-wait");
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
			(c) => c.cmd === "tmux" && c.args[0] === "rename-window",
		);
	}

	function mockExec(opts: { sessionExists?: boolean; scaffoldId?: string }): {
		fn: ExecFileFn;
		calls: ExecCall[];
	} {
		const calls: ExecCall[] = [];
		const fn: ExecFileFn = (cmd, args) => {
			calls.push({ cmd, args });
			if (cmd === "tmux" && args[0] === "has-session") {
				if (!opts.sessionExists) throw new Error("session not found");
				return { stdout: "" };
			}
			if (cmd === "tmux" && args[0] === "new-session") {
				// the -P -F form returns the created scaffold window id
				return { stdout: args.includes("-P") ? (opts.scaffoldId ?? "@0") : "" };
			}
			return { stdout: "" };
		};
		return { fn, calls };
	}

	it("creates the session and renames the scaffold window to zsh (runner-* session)", () => {
		const { fn, calls } = mockExec({ sessionExists: false, scaffoldId: "@0" });
		ensureRunnerSession(fn, "runner-test");
		const rn = renameCalls(calls);
		expect(rn).toHaveLength(1);
		expect(rn[0].args).toEqual(["rename-window", "-t", "@0", "zsh"]);
	});

	it("does not create or rename when the session already exists", () => {
		const { fn, calls } = mockExec({ sessionExists: true });
		ensureRunnerSession(fn, "runner-test");
		expect(calls.filter((c) => c.args[0] === "new-session")).toHaveLength(0);
		expect(renameCalls(calls)).toHaveLength(0);
	});

	it("never renames a non-runner session's scaffold (but still creates it)", () => {
		const { fn, calls } = mockExec({ sessionExists: false, scaffoldId: "@0" });
		ensureRunnerSession(fn, "flywheel");
		expect(renameCalls(calls)).toHaveLength(0);
		expect(calls.some((c) => c.args[0] === "new-session")).toBe(true);
	});

	it("falls back to a plain create when -P/-F throws, and never throws", () => {
		const calls: ExecCall[] = [];
		const fn: ExecFileFn = (cmd, args) => {
			calls.push({ cmd, args });
			if (cmd === "tmux" && args[0] === "has-session")
				throw new Error("not found");
			if (cmd === "tmux" && args[0] === "new-session" && args.includes("-P")) {
				throw new Error("-P unsupported");
			}
			return { stdout: "" };
		};
		expect(() => ensureRunnerSession(fn, "runner-test")).not.toThrow();
		const ns = calls.filter((c) => c.args[0] === "new-session");
		expect(ns).toHaveLength(2); // -P -F attempt (threw) + plain fallback
		expect(ns[1].args).toEqual(["new-session", "-d", "-s", "runner-test"]);
		expect(renameCalls(calls)).toHaveLength(0); // no id → no rename
	});
});
