/**
 * FLY-494: KimiTmuxAdapter — kimi CLI launch, FAST fail-closed preflight, and
 * kimi-flavored args (no claude-only flags). The vendor-neutral
 * poll/timeout/comm.db machinery is inherited from TmuxAdapter (covered by
 * TmuxAdapter.test.ts) and is NOT re-tested here. Mirrors AntigravityTmuxAdapter.test.ts.
 *
 * FLY-530 QA + FLY-494 F0 follow-up: the original preflight ran a live
 * `kimi -p "Reply KIMI_OK"` model round-trip bounded at 20s. kimi 0.18.0
 * cold-starts ~11-18s (measured: `kimi --version`, a purely-local call, takes
 * ~18s to first byte then exits instantly — so the cost is STARTUP, not the
 * "exit delay" the QA first guessed), and a `-p` round-trip totals ~50-60s.
 * That reliably TIMED OUT on a correctly-signed-in machine → kimi runners could
 * not be dispatched at all. The fix replaces the live model probe with an
 * INSTANT credential-presence check (config.toml / credentials dir) and bounds
 * the `kimi --version` liveness call so it can never wedge dispatch.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterExecutionContext } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KimiTmuxAdapter } from "../src/KimiTmuxAdapter.js";
import type { ExecFileFn } from "../src/TmuxAdapter.js";

function makeCtx(
	overrides: Partial<AdapterExecutionContext> = {},
): AdapterExecutionContext {
	return {
		executionId: "fly494-exec-1",
		issueId: "FLY-494",
		prompt: "Implement the feature",
		cwd: "/project/flywheel",
		...overrides,
	};
}

interface ExecCall {
	cmd: string;
	args: string[];
	opts?: { timeoutMs?: number; env?: Record<string, string | undefined> };
}

/** Mock exec satisfying kimi --version + tmux (NO live `-p` auth probe anymore). */
function makeMockExec(opts: { versionThrow?: Error } = {}) {
	const { versionThrow } = opts;
	const calls: ExecCall[] = [];
	const fn = (
		cmd: string,
		args: string[],
		execOpts?: { timeoutMs?: number; env?: Record<string, string | undefined> },
	): { stdout: string } => {
		calls.push({ cmd, args, opts: execOpts });
		if (cmd === "kimi") {
			if (args[0] === "--version") {
				if (versionThrow) throw versionThrow;
				return { stdout: "kimi 0.18.0" };
			}
			return { stdout: "" };
		}
		if (cmd === "tmux") {
			const sub = args[0];
			if (sub === "-V") return { stdout: "tmux 3.4" };
			if (sub === "has-session") throw new Error("session not found");
			if (sub === "new-window") return { stdout: "@9" };
			if (sub === "list-panes") return { stdout: "1" }; // pane dead → completes
			return { stdout: "" };
		}
		return { stdout: "" };
	};
	return { fn, calls };
}

/** Test subclass: point the kimi config dir at an injectable temp path. */
class TestKimiAdapter extends KimiTmuxAdapter {
	constructor(
		private readonly configDir: string,
		sessionName: string,
		execFileFn: ExecFileFn,
		pollIntervalMs?: number,
	) {
		super(sessionName, execFileFn, pollIntervalMs);
	}
	protected override resolveKimiConfigDir(): string {
		return this.configDir;
	}
}

let tmpRoot: string;
/** A kimi config dir that looks "signed in" (config.toml with an api_key). */
function configuredDir(): string {
	const dir = join(tmpRoot, `kimi-cfg-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.toml"), 'api_key = "sk-test"\n');
	return dir;
}
/** A kimi config dir that looks signed-out (empty — no config, no credentials). */
function emptyDir(): string {
	const dir = join(
		tmpRoot,
		`kimi-empty-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
}

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "fly494-kimi-"));
	delete process.env.FLYWHEEL_KIMI_PREFLIGHT_TIMEOUT_MS;
});
afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
	delete process.env.FLYWHEEL_KIMI_PREFLIGHT_TIMEOUT_MS;
});

/** Extract the launch command (binary + args) from the tmux new-window call. */
function launchCommand(calls: ExecCall[]): string[] {
	const nw = calls.find((c) => c.cmd === "tmux" && c.args[0] === "new-window");
	if (!nw) throw new Error("no new-window call");
	const cIdx = nw.args.indexOf("-c");
	return nw.args.slice(cIdx + 2);
}

/** Resolve the positional binary after the FLY-1999 shell env boundary. */
function launchedBinary(calls: ExecCall[]): string | undefined {
	const command = launchCommand(calls);
	if (command[0] !== "sh" || command[1] !== "-c") return command[0];
	return command[command[2]?.includes('cf="$0"') ? 7 : 4];
}

describe("KimiTmuxAdapter", () => {
	it("has type 'kimi-tmux'", () => {
		const { fn } = makeMockExec();
		expect(new TestKimiAdapter(configuredDir(), "flywheel", fn).type).toBe(
			"kimi-tmux",
		);
	});

	it("launches the `kimi` binary (not claude)", async () => {
		const { fn, calls } = makeMockExec();
		await new TestKimiAdapter(configuredDir(), "flywheel", fn, 10).execute(
			makeCtx(),
		);
		expect(launchedBinary(calls)).toBe("kimi");
		expect(calls.some((c) => c.cmd === "claude")).toBe(false);
	});

	it("preflight runs a bounded `kimi --version` and NO live `-p` model probe", async () => {
		const { fn, calls } = makeMockExec();
		await new TestKimiAdapter(configuredDir(), "flywheel", fn, 10).execute(
			makeCtx(),
		);
		const version = calls.find(
			(c) => c.cmd === "kimi" && c.args[0] === "--version",
		);
		expect(version).toBeDefined();
		// the version liveness call is BOUNDED so a hung kimi can't wedge dispatch
		expect(version?.opts?.timeoutMs).toBeGreaterThan(0);
		// NO direct `kimi -p ...` model round-trip anywhere in preflight (the
		// launch `-p` bootstrap is a tmux call, cmd==="tmux", not a direct kimi exec)
		expect(calls.some((c) => c.cmd === "kimi" && c.args.includes("-p"))).toBe(
			false,
		);
	});

	it("FAIL-CLOSED: throws when kimi is not signed in (no config.toml / credentials)", async () => {
		const { fn } = makeMockExec();
		await expect(
			new TestKimiAdapter(emptyDir(), "flywheel", fn, 10).execute(makeCtx()),
		).rejects.toThrow(/not signed in/i);
	});

	it("auth passes via credentials/ dir even without config.toml", async () => {
		const dir = emptyDir();
		mkdirSync(join(dir, "credentials"), { recursive: true });
		writeFileSync(join(dir, "credentials", "token.json"), "{}");
		const { fn, calls } = makeMockExec();
		await new TestKimiAdapter(dir, "flywheel", fn, 10).execute(makeCtx());
		expect(launchedBinary(calls)).toBe("kimi");
	});

	// Codex R1 (LOW): a DIRECTORY named config.toml has non-zero size but is not
	// a real credential file — it must NOT satisfy the auth check.
	it("FAIL-CLOSED: a directory named config.toml does not count as signed in", async () => {
		const dir = emptyDir();
		mkdirSync(join(dir, "config.toml"), { recursive: true }); // a DIR, not a file
		const { fn } = makeMockExec();
		await expect(
			new TestKimiAdapter(dir, "flywheel", fn, 10).execute(makeCtx()),
		).rejects.toThrow(/not signed in/i);
	});

	// An empty config.toml (0 bytes) is not a usable credential → fail closed.
	it("FAIL-CLOSED: an empty config.toml does not count as signed in", async () => {
		const dir = emptyDir();
		writeFileSync(join(dir, "config.toml"), "");
		const { fn } = makeMockExec();
		await expect(
			new TestKimiAdapter(dir, "flywheel", fn, 10).execute(makeCtx()),
		).rejects.toThrow(/not signed in/i);
	});

	it("FAIL-CLOSED: a `kimi --version` that throws (missing/hung binary) throws clearly", async () => {
		const versionErr = new Error("spawnSync kimi ETIMEDOUT");
		const { fn } = makeMockExec({ versionThrow: versionErr });
		await expect(
			new TestKimiAdapter(configuredDir(), "flywheel", fn, 10).execute(
				makeCtx(),
			),
		).rejects.toThrow(/kimi --version failed or timed out/i);
	});

	// FLY-554 re-QA: the no-env default bound must stay >= 60s. FLY-530's instant
	// fs-auth fix was correct, but a 30s default still false-failed on a normal
	// high-load box (`kimi --version` measured up to ~48s at load 150) — the exact
	// recurrence FLY-554 flagged. Locked as a FLOOR (not an exact value) so a later
	// legit tweak within Annie's 60-90s range won't break this guard.
	it("no-env default preflight timeout is >= 60s (FLY-554 load-margin regression guard)", async () => {
		const { fn, calls } = makeMockExec();
		await new TestKimiAdapter(configuredDir(), "flywheel", fn, 10).execute(
			makeCtx(),
		);
		const version = calls.find(
			(c) => c.cmd === "kimi" && c.args[0] === "--version",
		);
		expect(version?.opts?.timeoutMs).toBeGreaterThanOrEqual(60_000);
	});

	it("preflight timeout is env-configurable via FLYWHEEL_KIMI_PREFLIGHT_TIMEOUT_MS", async () => {
		process.env.FLYWHEEL_KIMI_PREFLIGHT_TIMEOUT_MS = "90000";
		const { fn, calls } = makeMockExec();
		await new TestKimiAdapter(configuredDir(), "flywheel", fn, 10).execute(
			makeCtx(),
		);
		const version = calls.find(
			(c) => c.cmd === "kimi" && c.args[0] === "--version",
		);
		expect(version?.opts?.timeoutMs).toBe(90000);
	});

	it("invalid FLYWHEEL_KIMI_PREFLIGHT_TIMEOUT_MS falls back to a positive default", async () => {
		process.env.FLYWHEEL_KIMI_PREFLIGHT_TIMEOUT_MS = "not-a-number";
		const { fn, calls } = makeMockExec();
		await new TestKimiAdapter(configuredDir(), "flywheel", fn, 10).execute(
			makeCtx(),
		);
		const version = calls.find(
			(c) => c.cmd === "kimi" && c.args[0] === "--version",
		);
		expect(version?.opts?.timeoutMs).toBeGreaterThan(0);
	});

	// Codex R1 (MED): a sub-1ms override must NOT floor to 0 (= "no timeout" =
	// the wedge the fix closes) — it falls back to the positive default.
	it("FLYWHEEL_KIMI_PREFLIGHT_TIMEOUT_MS=0.5 floors to 0 → falls back to default (never disables the bound)", async () => {
		process.env.FLYWHEEL_KIMI_PREFLIGHT_TIMEOUT_MS = "0.5";
		const { fn, calls } = makeMockExec();
		await new TestKimiAdapter(configuredDir(), "flywheel", fn, 10).execute(
			makeCtx(),
		);
		const version = calls.find(
			(c) => c.cmd === "kimi" && c.args[0] === "--version",
		);
		expect(version?.opts?.timeoutMs).toBeGreaterThan(0);
	});

	it("forces IPv4-first DNS for the `kimi --version` probe (kimi IPv6 stall, ~6s)", async () => {
		const { fn, calls } = makeMockExec();
		await new TestKimiAdapter(configuredDir(), "flywheel", fn, 10).execute(
			makeCtx(),
		);
		const version = calls.find(
			(c) => c.cmd === "kimi" && c.args[0] === "--version",
		);
		expect(version?.opts?.env?.NODE_OPTIONS).toMatch(
			/--dns-result-order=ipv4first/,
		);
	});

	// Codex R1 (LOW): an inherited but CONFLICTING dns-result-order must be
	// REPLACED with ipv4first (not left as-is, which would defeat the injection),
	// while preserving every other NODE_OPTIONS token.
	it("replaces a conflicting inherited NODE_OPTIONS dns-result-order with ipv4first", async () => {
		const prev = process.env.NODE_OPTIONS;
		process.env.NODE_OPTIONS =
			"--max-old-space-size=4096 --dns-result-order=ipv6first";
		try {
			const { fn, calls } = makeMockExec();
			await new TestKimiAdapter(configuredDir(), "flywheel", fn, 10).execute(
				makeCtx(),
			);
			const version = calls.find(
				(c) => c.cmd === "kimi" && c.args[0] === "--version",
			);
			const opt = version?.opts?.env?.NODE_OPTIONS ?? "";
			expect(opt).toContain("--dns-result-order=ipv4first");
			expect(opt).not.toContain("ipv6first");
			// other tokens preserved
			expect(opt).toContain("--max-old-space-size=4096");
		} finally {
			if (prev === undefined) delete process.env.NODE_OPTIONS;
			else process.env.NODE_OPTIONS = prev;
		}
	});

	it("injects NODE_OPTIONS=ipv4first into the runner pane env", async () => {
		const { fn, calls } = makeMockExec();
		await new TestKimiAdapter(configuredDir(), "flywheel", fn, 10).execute(
			makeCtx(),
		);
		const nw = calls.find(
			(c) => c.cmd === "tmux" && c.args[0] === "new-window",
		);
		const env = (nw?.args ?? []).filter((_, i) => nw?.args[i - 1] === "-e");
		expect(
			env.some((e) => /^NODE_OPTIONS=.*--dns-result-order=ipv4first/.test(e)),
		).toBe(true);
	});

	it("emits kimi flags and NONE of the claude-only flags", async () => {
		const { fn, calls } = makeMockExec();
		await new TestKimiAdapter(configuredDir(), "flywheel", fn, 10).execute(
			makeCtx({ model: "kimi-for-coding" }),
		);
		const launch = launchCommand(calls);
		expect(launch).toContain("--model");
		expect(launch).toContain("kimi-for-coding");
		expect(launch).toContain("-p");
		// `-p` mode auto-approves tools by default AND the CLI hard-rejects
		// combining --yolo/--auto with -p, so the launch must carry NEITHER.
		expect(launch).not.toContain("--yolo");
		expect(launch).not.toContain("--auto");
		// the doc-based `--print` / `--afk` flags do NOT exist in the shipped binary
		expect(launch).not.toContain("--print");
		expect(launch).not.toContain("--afk");
		for (const claudeFlag of [
			"--session-id",
			"--permission-mode",
			"--append-system-prompt-file",
			"--allowed-tools",
			"--name",
		]) {
			expect(launch).not.toContain(claudeFlag);
		}
	});

	it("no --model flag when ctx.model is unset", async () => {
		const { fn, calls } = makeMockExec();
		await new TestKimiAdapter(configuredDir(), "flywheel", fn, 10).execute(
			makeCtx(),
		);
		expect(launchCommand(calls)).not.toContain("--model");
	});

	it("bootstraps the prompt via a short -p pointer to a written file", async () => {
		const { fn, calls } = makeMockExec();
		await new TestKimiAdapter(configuredDir(), "flywheel", fn, 10).execute(
			makeCtx({ appendSystemPrompt: "BIG SYSTEM PROMPT", prompt: "do X" }),
		);
		const launch = launchCommand(calls);
		const pIdx = launch.indexOf("-p");
		const bootstrap = launch[pIdx + 1] ?? "";
		expect(bootstrap).toMatch(/Read the instructions in .*kimi-bootstrap\.md/);
		expect(bootstrap).not.toContain("BIG SYSTEM PROMPT");
	});

	// FLY-1188: a no-transport session must be registered vendor="none" so a
	// Lead `send` fails LOUD instead of writing a claude-code mailbox nobody
	// reads and stamping a false delivered_at.
	it('registers the CommDB session with vendor="none" (no-transport)', async () => {
		const tmpDb = mkdtempSync(join(tmpdir(), "fly1188-kimi-vendor-"));
		try {
			const commDbPath = join(tmpDb, "comm.db");
			const { fn } = makeMockExec();
			await new TestKimiAdapter(configuredDir(), "flywheel", fn, 10).execute(
				makeCtx({ commDbPath }),
			);
			const { CommDB } = await import("flywheel-comm/db");
			const db = new CommDB(commDbPath);
			expect(db.getSession("fly494-exec-1")?.vendor).toBe("none");
			db.close();
		} finally {
			rmSync(tmpDb, { recursive: true, force: true });
		}
	});
});
