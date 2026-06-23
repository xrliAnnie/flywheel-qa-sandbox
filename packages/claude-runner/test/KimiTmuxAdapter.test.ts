/**
 * FLY-494: KimiTmuxAdapter — kimi CLI launch, fail-closed auth preflight, and
 * kimi-flavored args (no claude-only flags). The vendor-neutral
 * poll/timeout/comm.db machinery is inherited from TmuxAdapter (covered by
 * TmuxAdapter.test.ts) and is NOT re-tested here. Mirrors AntigravityTmuxAdapter.test.ts.
 */
import type { AdapterExecutionContext } from "flywheel-core";
import { describe, expect, it } from "vitest";
import { KimiTmuxAdapter } from "../src/KimiTmuxAdapter.js";

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
	opts?: { timeoutMs?: number };
}

/** Mock exec that satisfies kimi preflight (version + KIMI_OK auth probe) and tmux. */
function makeMockExec(
	opts: { authOk?: boolean; authOut?: string; authThrow?: Error } = {},
) {
	const { authOk = true, authOut, authThrow } = opts;
	const calls: ExecCall[] = [];
	const fn = (
		cmd: string,
		args: string[],
		execOpts?: { timeoutMs?: number },
	): { stdout: string } => {
		calls.push({ cmd, args, opts: execOpts });
		if (cmd === "kimi") {
			if (args[0] === "--version") return { stdout: "kimi 0.18.0" };
			// auth probe: -p "Reply ..." --yolo
			if (args.includes("-p")) {
				// Simulate a hung/timed-out probe that the bounded exec kills → throw.
				if (authThrow) throw authThrow;
				return {
					stdout: authOut ?? (authOk ? "KIMI_OK" : "Authentication required"),
				};
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

/** Extract the launch command (binary + args) from the tmux new-window call. */
function launchCommand(calls: ExecCall[]): string[] {
	const nw = calls.find((c) => c.cmd === "tmux" && c.args[0] === "new-window");
	if (!nw) throw new Error("no new-window call");
	// new-window ... -c <cwd> <binary> <...cliArgs>
	const cIdx = nw.args.indexOf("-c");
	return nw.args.slice(cIdx + 2);
}

describe("KimiTmuxAdapter", () => {
	it("has type 'kimi-tmux'", () => {
		const { fn } = makeMockExec();
		expect(new KimiTmuxAdapter("flywheel", fn).type).toBe("kimi-tmux");
	});

	it("launches the `kimi` binary (not claude)", async () => {
		const { fn, calls } = makeMockExec();
		const adapter = new KimiTmuxAdapter("flywheel", fn, 10);
		await adapter.execute(makeCtx());
		expect(launchCommand(calls)[0]).toBe("kimi");
		// never launches claude
		expect(calls.some((c) => c.cmd === "claude")).toBe(false);
	});

	it("preflight checks kimi --version and runs the auth probe", async () => {
		const { fn, calls } = makeMockExec();
		await new KimiTmuxAdapter("flywheel", fn, 10).execute(makeCtx());
		expect(
			calls.some((c) => c.cmd === "kimi" && c.args[0] === "--version"),
		).toBe(true);
		expect(calls.some((c) => c.cmd === "kimi" && c.args.includes("-p"))).toBe(
			true,
		);
	});

	it("FAIL-CLOSED: kimi auth probe without KIMI_OK throws (not signed in)", async () => {
		const { fn } = makeMockExec({ authOk: false });
		await expect(
			new KimiTmuxAdapter("flywheel", fn, 10).execute(makeCtx()),
		).rejects.toThrow(/auth preflight failed/i);
	});

	it("FAIL-CLOSED: explicit 'Please sign in' output throws", async () => {
		const { fn } = makeMockExec({ authOut: "Please sign in to continue" });
		await expect(
			new KimiTmuxAdapter("flywheel", fn, 10).execute(makeCtx()),
		).rejects.toThrow(/auth preflight failed/i);
	});

	// Codex code review R1 (MED): a hanging probe must FAIL CLOSED, not wedge.
	it("FAIL-CLOSED: a probe that throws (timeout-killed child) throws clearly", async () => {
		const timeoutErr = new Error("spawnSync kimi ETIMEDOUT");
		const { fn } = makeMockExec({ authThrow: timeoutErr });
		await expect(
			new KimiTmuxAdapter("flywheel", fn, 10).execute(makeCtx()),
		).rejects.toThrow(/auth preflight failed or timed out/i);
	});

	it("bounds the auth probe with a timeout (so a stalled kimi cannot wedge dispatch)", async () => {
		const { fn, calls } = makeMockExec();
		await new KimiTmuxAdapter("flywheel", fn, 10).execute(makeCtx());
		const probe = calls.find((c) => c.cmd === "kimi" && c.args.includes("-p"));
		expect(probe?.opts?.timeoutMs).toBeGreaterThan(0);
	});

	it("emits kimi flags and NONE of the claude-only flags", async () => {
		const { fn, calls } = makeMockExec();
		await new KimiTmuxAdapter("flywheel", fn, 10).execute(
			makeCtx({ model: "kimi-for-coding" }),
		);
		const launch = launchCommand(calls);
		// kimi flags present (verified against kimi 0.18.0 — FLY-494 live spike)
		expect(launch).toContain("--yolo");
		expect(launch).toContain("--model");
		expect(launch).toContain("kimi-for-coding");
		expect(launch).toContain("-p");
		// the doc-based `--print` flag does NOT exist in the shipped binary
		expect(launch).not.toContain("--print");
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
		await new KimiTmuxAdapter("flywheel", fn, 10).execute(makeCtx());
		expect(launchCommand(calls)).not.toContain("--model");
	});

	it("bootstraps the prompt via a short -p pointer to a written file", async () => {
		const { fn, calls } = makeMockExec();
		await new KimiTmuxAdapter("flywheel", fn, 10).execute(
			makeCtx({ appendSystemPrompt: "BIG SYSTEM PROMPT", prompt: "do X" }),
		);
		const launch = launchCommand(calls);
		const pIdx = launch.indexOf("-p");
		const bootstrap = launch[pIdx + 1] ?? "";
		// short pointer, not the full prompt inlined
		expect(bootstrap).toMatch(/Read the instructions in .*kimi-bootstrap\.md/);
		expect(bootstrap).not.toContain("BIG SYSTEM PROMPT");
	});
});
