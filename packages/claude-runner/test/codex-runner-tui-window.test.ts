import { describe, expect, it } from "vitest";
import {
	buildRunnerTuiCommand,
	ensureRunnerTuiWindow,
	isRunnerTuiWindowAlive,
	killRunnerTuiWindow,
	type RunnerTuiWindowSpec,
} from "../src/codex-runner-tui-window.js";

// ── FLY-1188 M4c-3 — founder-facing cmux TUI window (exec injected) ───────

const spec: RunnerTuiWindowSpec = {
	tmuxSession: "flywheel",
	windowName: "FLY-1188",
	codexHome: "/home/x/.flywheel/codex-homes/exec-1",
	socketPath: "/home/x/.flywheel/cdx-sock/abc.sock",
	cwd: "/home/x/Dev/flywheel-FLY-1188",
	threadId: "019f5740-57f6-76e1-9526-7f37de6c997c",
	codexBin: "/bin/codex",
};

describe("buildRunnerTuiCommand", () => {
	it("resumes the daemon's SHORT socket with workspace-write + no-approval, on the given thread", () => {
		const cmd = buildRunnerTuiCommand(spec);
		expect(cmd).toContain('CODEX_HOME="/home/x/.flywheel/codex-homes/exec-1"');
		expect(cmd).toContain("/bin/codex resume");
		// the EXPLICIT short socket path (not a CODEX_HOME-derived one)
		expect(cmd).toContain(
			'--remote "unix:///home/x/.flywheel/cdx-sock/abc.sock"',
		);
		expect(cmd).toContain('-C "/home/x/Dev/flywheel-FLY-1188"');
		expect(cmd).toContain("-s workspace-write");
		expect(cmd).toContain(`approval_policy="never"`);
		expect(cmd.trim().endsWith(spec.threadId)).toBe(true);
	});

	it("defaults the codex binary to `codex`", () => {
		const cmd = buildRunnerTuiCommand({ ...spec, codexBin: undefined });
		expect(cmd).toContain("codex resume");
	});

	it("throws (fail-loud) on a shell-unsafe threadId or path", () => {
		expect(() =>
			buildRunnerTuiCommand({ ...spec, threadId: 'x"; rm -rf /' }),
		).toThrow(/unsafe for the tmux shell/);
		expect(() =>
			buildRunnerTuiCommand({ ...spec, socketPath: "/tmp/$(evil).sock" }),
		).toThrow(/unsafe for the tmux shell/);
		expect(() =>
			buildRunnerTuiCommand({ ...spec, cwd: "/a b/with space" }),
		).toThrow(/unsafe for the tmux shell/);
	});
});

/** Records tmux invocations; scriptable ok per command. */
function recorder(okFor: (args: string[]) => boolean = () => true) {
	const calls: string[][] = [];
	return {
		calls,
		exec: (cmd: string, args: string[]) => {
			calls.push([cmd, ...args]);
			return { ok: okFor(args) };
		},
	};
}

/** QA · FLY-1188: ensure() now PROVES the pane survived (tmux reports success
 * even for a command that dies instantly), so a live window must be simulated —
 * `deps.execOut` answers the post-create liveness probe and `sleep` skips the
 * settle. A mock without them models a window that never came up. */
const aliveDeps = {
	execOut: () => `${spec.windowName} 0`,
	sleep: () => {},
};

describe("ensureRunnerTuiWindow", () => {
	it("probes tmux, ensures the session, stale-kills, then creates the window", () => {
		const r = recorder();
		const created = ensureRunnerTuiWindow(spec, { exec: r.exec, ...aliveDeps });
		expect(created).toBe(true);
		const verbs = r.calls.map((c) => `${c[1]}`);
		expect(verbs).toEqual([
			"-V", // tmux probe
			"new-session", // ensure session
			"kill-window", // stale-kill
			"new-window", // create
		]);
		// stale-kill + create target the same identity-scoped window
		expect(r.calls[2]).toContain("=flywheel:=FLY-1188");
		const createCall = r.calls[3];
		expect(createCall).toContain("FLY-1188");
		expect(createCall.some((a) => a.includes("codex resume"))).toBe(true);
	});

	it("skips (returns false) when tmux is unavailable — the run is unaffected", () => {
		const r = recorder((args) => args[0] !== "-V"); // -V fails
		const created = ensureRunnerTuiWindow(spec, { exec: r.exec });
		expect(created).toBe(false);
		expect(r.calls).toHaveLength(1); // only the probe
	});

	it("returns false (non-fatal) when window creation fails", () => {
		const r = recorder((args) => args[0] !== "new-window");
		expect(ensureRunnerTuiWindow(spec, { exec: r.exec })).toBe(false);
	});

	it("rejects a shell-unsafe session/window name up front", () => {
		const r = recorder();
		expect(() =>
			ensureRunnerTuiWindow(
				{ ...spec, windowName: "bad name; evil" },
				{ exec: r.exec },
			),
		).toThrow(/unsafe for the tmux shell/);
	});
});

describe("isRunnerTuiWindowAlive", () => {
	it("is alive when the window exists with a live (non-dead) pane", () => {
		expect(
			isRunnerTuiWindowAlive(
				{ tmuxSession: "flywheel", windowName: "FLY-1188" },
				{ execOut: () => "FLY-1188 0" },
			),
		).toBe(true);
	});

	it("is NOT alive on a dead pane or a missing/foreign window", () => {
		expect(
			isRunnerTuiWindowAlive(
				{ tmuxSession: "flywheel", windowName: "FLY-1188" },
				{ execOut: () => "FLY-1188 1" }, // pane dead
			),
		).toBe(false);
		expect(
			isRunnerTuiWindowAlive(
				{ tmuxSession: "flywheel", windowName: "FLY-1188" },
				{ execOut: () => "some-other-window 0" }, // tmux fell back to another window
			),
		).toBe(false);
		expect(
			isRunnerTuiWindowAlive(
				{ tmuxSession: "flywheel", windowName: "FLY-1188" },
				{ execOut: () => undefined }, // display-message failed
			),
		).toBe(false);
	});

	it("fail-open: a throwing execOut is treated as 'not alive', never propagated", () => {
		expect(
			isRunnerTuiWindowAlive(
				{ tmuxSession: "flywheel", windowName: "FLY-1188" },
				{
					execOut: () => {
						throw new Error("tmux blew up");
					},
				},
			),
		).toBe(false);
	});
});

describe("fail-open logging + kill result", () => {
	it("a throwing logger never breaks ensure / kill", () => {
		const boom = () => {
			throw new Error("logger down");
		};
		expect(() =>
			ensureRunnerTuiWindow(spec, {
				exec: () => ({ ok: true }),
				log: boom,
			}),
		).not.toThrow();
		expect(() =>
			killRunnerTuiWindow(
				{ tmuxSession: "flywheel", windowName: "FLY-1188" },
				{ exec: () => ({ ok: true }), log: boom },
			),
		).not.toThrow();
	});

	it("fail-open: a non-Error throw (e.g. `throw null`) never breaks ensure / kill", () => {
		const throwNull = () => {
			throw null; // JS allows this — (err as Error).message would TypeError
		};
		expect(() =>
			ensureRunnerTuiWindow(spec, { exec: throwNull as never }),
		).not.toThrow();
		expect(() =>
			killRunnerTuiWindow(
				{ tmuxSession: "flywheel", windowName: "FLY-1188" },
				{ exec: throwNull as never },
			),
		).not.toThrow();
	});

	it("fail-open: a HOSTILE error (throwing message getter) never breaks ensure / kill", () => {
		const hostile = () => {
			throw new Proxy(new Error("x"), {
				get() {
					throw new Error("message trap");
				},
			});
		};
		expect(() =>
			ensureRunnerTuiWindow(spec, { exec: hostile as never }),
		).not.toThrow();
		expect(() =>
			killRunnerTuiWindow(
				{ tmuxSession: "flywheel", windowName: "FLY-1188" },
				{ exec: hostile as never },
			),
		).not.toThrow();
	});

	it("kill logs success only when the kill actually succeeded", () => {
		const msgs: string[] = [];
		killRunnerTuiWindow(
			{ tmuxSession: "flywheel", windowName: "FLY-1188" },
			{ exec: () => ({ ok: false }), log: (m) => msgs.push(m) },
		);
		expect(msgs.join(" ")).toContain("non-ok");
		expect(msgs.join(" ")).not.toContain("killed (");
	});
});

describe("killRunnerTuiWindow", () => {
	it("kills the identity-scoped window", () => {
		const r = recorder();
		killRunnerTuiWindow(
			{ tmuxSession: "flywheel", windowName: "FLY-1188" },
			{ exec: r.exec },
		);
		expect(r.calls).toEqual([
			["tmux", "kill-window", "-t", "=flywheel:=FLY-1188"],
		]);
	});
});

// ── QA · FLY-1188 — regressions from the real-machine E2E (2026-07-13) ──────
//
// The founder-visible TUI (hard problem #3: "cmux 里的 tab 是空的") did NOT work
// on a real machine. `tmux new-window` reports success even when the command it
// launches dies instantly, so ensureRunnerTuiWindow logged "founder TUI up" and
// returned true for a window that was ALREADY GONE — the failure was invisible
// to every mocked test AND to the operator.
//
// Real-machine capture (engineering/doc/FLY-1188-.../qa/tui-failure-diagnosis.txt):
//     Error: stdout is not a terminal
//     TUI EXITED WITH CODE=1
//
// Root cause: the TUI was launched through `flywheel-codex-with-fallback`, which
// pipes codex's stdout through `tee` (to sniff 429s for account rotation). That
// makes stdout a PIPE, and a TUI refuses to render without a real TTY. The
// daemon may keep using the shim (`app-server` needs no TTY); the TUI may not.
describe("QA FLY-1188: the founder TUI must actually be RUNNING, not just spawned", () => {
	it("reports failure when the window dies immediately (tmux new-window 'succeeds' regardless)", () => {
		// tmux accepts every command, but the window never comes up — exactly what a
		// TUI that exits 1 on 'stdout is not a terminal' looks like from outside.
		const alive = false;
		const ok = ensureRunnerTuiWindow(spec, {
			exec: () => ({ ok: true }),
			execOut: (_cmd, args) =>
				// display-message identity echo: a dead/absent window resolves to nothing
				args.includes("display-message") && alive ? spec.windowName : undefined,
		});
		expect(ok).toBe(false); // must NOT claim "founder TUI up" for a dead pane
	});
});
