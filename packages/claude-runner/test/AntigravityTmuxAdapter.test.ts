/**
 * FLY-493: AntigravityTmuxAdapter — agy CLI launch, fail-closed auth preflight,
 * and agy-flavored args (no claude-only flags). The vendor-neutral
 * poll/timeout/comm.db machinery is inherited from TmuxAdapter (covered by
 * TmuxAdapter.test.ts) and is NOT re-tested here.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterExecutionContext } from "flywheel-core";
import { describe, expect, it } from "vitest";
import { AntigravityTmuxAdapter } from "../src/AntigravityTmuxAdapter.js";

function makeCtx(
	overrides: Partial<AdapterExecutionContext> = {},
): AdapterExecutionContext {
	return {
		executionId: "fly493-exec-1",
		issueId: "FLY-493",
		prompt: "Implement the feature",
		cwd: "/project/flywheel",
		...overrides,
	};
}

interface ExecCall {
	cmd: string;
	args: string[];
}

/** Mock exec that satisfies agy preflight (version + AGY_OK auth probe) and tmux. */
function makeMockExec(opts: { authOk?: boolean; authOut?: string } = {}) {
	const { authOk = true, authOut } = opts;
	const calls: ExecCall[] = [];
	const fn = (cmd: string, args: string[]): { stdout: string } => {
		calls.push({ cmd, args });
		if (cmd === "agy") {
			if (args[0] === "--version") return { stdout: "agy 0.1.0" };
			// auth probe: --dangerously-skip-permissions -p "Reply ..."
			if (args.includes("-p")) {
				return {
					stdout: authOut ?? (authOk ? "AGY_OK" : "Authentication required"),
				};
			}
			return { stdout: "" };
		}
		if (cmd === "tmux") {
			const sub = args[0];
			if (sub === "-V") return { stdout: "tmux 3.4" };
			if (sub === "has-session") throw new Error("session not found");
			if (sub === "new-window") return { stdout: "@7" };
			if (sub === "list-panes") return { stdout: "1" }; // pane dead → completes
			return { stdout: "" };
		}
		return { stdout: "" };
	};
	return { fn, calls };
}

/** Extract the launch command (binary + args) from the tmux new-window call. */
function launchCommand(calls: ExecCall[]): string[] {
	const nw = calls.find((c) => c.cmd === "tmux" && c.args[0] === "new-window");
	if (!nw) throw new Error("no new-window call");
	// new-window ... -c <cwd> <binary> <...cliArgs>
	const cIdx = nw.args.indexOf("-c");
	return nw.args.slice(cIdx + 2);
}

/** Resolve the positional binary after the FLY-1999 shell env boundary. */
function launchedBinary(calls: ExecCall[]): string | undefined {
	const command = launchCommand(calls);
	if (command[0] !== "sh" || command[1] !== "-c") return command[0];
	return command[command[2]?.includes('cf="$0"') ? 7 : 4];
}

describe("AntigravityTmuxAdapter", () => {
	it("has type 'antigravity-tmux'", () => {
		const { fn } = makeMockExec();
		expect(new AntigravityTmuxAdapter("flywheel", fn).type).toBe(
			"antigravity-tmux",
		);
	});

	it("launches the `agy` binary (not claude)", async () => {
		const { fn, calls } = makeMockExec();
		const adapter = new AntigravityTmuxAdapter("flywheel", fn, 10);
		await adapter.execute(makeCtx());
		expect(launchedBinary(calls)).toBe("agy");
		// never launches claude
		expect(calls.some((c) => c.cmd === "claude")).toBe(false);
	});

	it("preflight checks agy --version and runs the auth probe", async () => {
		const { fn, calls } = makeMockExec();
		await new AntigravityTmuxAdapter("flywheel", fn, 10).execute(makeCtx());
		expect(
			calls.some((c) => c.cmd === "agy" && c.args[0] === "--version"),
		).toBe(true);
		expect(calls.some((c) => c.cmd === "agy" && c.args.includes("-p"))).toBe(
			true,
		);
	});

	it("FAIL-CLOSED: agy auth probe without AGY_OK throws (not signed in)", async () => {
		const { fn } = makeMockExec({ authOk: false });
		await expect(
			new AntigravityTmuxAdapter("flywheel", fn, 10).execute(makeCtx()),
		).rejects.toThrow(/auth preflight failed/i);
	});

	it("FAIL-CLOSED: explicit 'Please sign in' output throws", async () => {
		const { fn } = makeMockExec({ authOut: "Please sign in to continue" });
		await expect(
			new AntigravityTmuxAdapter("flywheel", fn, 10).execute(makeCtx()),
		).rejects.toThrow(/auth preflight failed/i);
	});

	it("emits agy flags and NONE of the claude-only flags", async () => {
		const { fn, calls } = makeMockExec();
		await new AntigravityTmuxAdapter("flywheel", fn, 10).execute(
			makeCtx({ model: "gemini-3.1-pro" }),
		);
		const launch = launchCommand(calls);
		// agy flags present
		expect(launch).toContain("--model");
		expect(launch).toContain("gemini-3.1-pro");
		expect(launch).toContain("--dangerously-skip-permissions");
		expect(launch).toContain("-i");
		// claude-only flags ABSENT
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
		await new AntigravityTmuxAdapter("flywheel", fn, 10).execute(makeCtx());
		expect(launchCommand(calls)).not.toContain("--model");
	});

	it("bootstraps the prompt via a short -i pointer to a written file", async () => {
		const { fn, calls } = makeMockExec();
		await new AntigravityTmuxAdapter("flywheel", fn, 10).execute(
			makeCtx({ appendSystemPrompt: "BIG SYSTEM PROMPT", prompt: "do X" }),
		);
		const launch = launchCommand(calls);
		const iIdx = launch.indexOf("-i");
		const bootstrap = launch[iIdx + 1] ?? "";
		// short pointer, not the full prompt inlined
		expect(bootstrap).toMatch(/Read the instructions in .*agy-bootstrap\.md/);
		expect(bootstrap).not.toContain("BIG SYSTEM PROMPT");
	});
	// FLY-1188: a no-transport session must be registered vendor="none" so a
	// Lead `send` fails LOUD instead of writing a claude-code mailbox nobody
	// reads and stamping a false delivered_at.
	it('registers the CommDB session with vendor="none" (no-transport)', async () => {
		const tmpDb = mkdtempSync(join(tmpdir(), "fly1188-agy-vendor-"));
		try {
			const commDbPath = join(tmpDb, "comm.db");
			const { fn } = makeMockExec();
			await new AntigravityTmuxAdapter("flywheel", fn, 10).execute(
				makeCtx({ commDbPath }),
			);
			const { CommDB } = await import("flywheel-comm/db");
			const db = new CommDB(commDbPath);
			expect(db.getSession("fly493-exec-1")?.vendor).toBe("none");
			db.close();
		} finally {
			rmSync(tmpDb, { recursive: true, force: true });
		}
	});
});
