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

/**
 * FLY-1239 — a STATEFUL fake tmux that models the identity/lifecycle semantics
 * that matter (Codex R1 HIGH-1 / R2 MED-1): windows keyed by IMMUTABLE id (so
 * DUPLICATE names are representable, unlike a Set-by-name), and "killing a
 * session's LAST window destroys the session" so a later `list-windows` fails.
 * `exec` handles -V / new-session / kill-window / new-window; `execOut` answers
 * list-windows and the display-message liveness probe.
 */
function fakeTmux(
	opts: {
		initial?: Array<{ id: string; name: string }>; // pre-existing windows (id → name)
		sessionExists?: boolean; // default true
		tmuxAvailable?: boolean; // -V result (default true)
		createOk?: boolean; // new-window result (default true)
		killEffective?: boolean; // whether kill-window actually removes (default true)
		paneAlive?: boolean; // liveness of the created window (default true)
		listFails?: boolean; // list-windows always returns undefined (default false)
		verifyListFails?: boolean; // only the SECOND+ (verify) list returns undefined
	} = {},
) {
	const WINDOW = spec.windowName;
	let listCalls = 0;
	let seq = 0;
	const newId = () => `@${++seq}`;
	const windows = new Map<string, string>(); // id → name
	for (const w of opts.initial ?? []) windows.set(w.id, w.name);
	let sessionExists = opts.sessionExists ?? true;
	const execCalls: string[][] = [];
	const outCalls: string[][] = [];
	let pileUp = false; // set true if new-window is ever called over an existing same-name window
	let createdOverResidual = false;
	const sameNameCount = () =>
		[...windows.values()].filter((n) => n === WINDOW).length;
	// peak same-named count the CODE ever ESTABLISHES via new-window (starts at 0,
	// NOT the pre-seeded stale count — those preloaded duplicates are the bad input
	// the purge must clean, not a pile-up the code created).
	let maxSameName = 0;

	const exec = (cmd: string, args: string[]) => {
		execCalls.push([cmd, ...args]);
		const verb = args[0];
		if (verb === "-V") return { ok: opts.tmuxAvailable ?? true };
		if (verb === "new-session") {
			if (!sessionExists) {
				sessionExists = true;
				windows.set(newId(), "zsh"); // recreated scaffold window (DIFFERENT name)
			}
			return { ok: true };
		}
		if (verb === "kill-window") {
			const id = args[args.indexOf("-t") + 1];
			if (opts.killEffective !== false) {
				windows.delete(id);
				if (windows.size === 0) sessionExists = false; // tmux: last window → session gone
			}
			return { ok: true };
		}
		if (verb === "new-window") {
			if (opts.createOk === false) return { ok: false };
			const name = args[args.indexOf("-n") + 1];
			if (name === WINDOW && sameNameCount() > 0) {
				pileUp = true; // creating a same-named window ON TOP of an existing one
				createdOverResidual = true;
			}
			if (!sessionExists) sessionExists = true;
			windows.set(newId(), name);
			if (sameNameCount() > maxSameName) maxSameName = sameNameCount();
			return { ok: true };
		}
		return { ok: true };
	};

	const execOut = (cmd: string, args: string[]): string | undefined => {
		outCalls.push([cmd, ...args]);
		if (args.includes("list-windows")) {
			listCalls++;
			if (opts.listFails) return undefined;
			if (opts.verifyListFails && listCalls >= 2) return undefined; // the verify list fails
			if (!sessionExists) return undefined; // "no server running" / session destroyed
			return [...windows].map(([id, name]) => `${id} ${name}`).join("\n");
		}
		if (args.includes("display-message")) {
			const present = [...windows.values()].includes(WINDOW);
			return present && (opts.paneAlive ?? true) ? `${WINDOW} 0` : undefined;
		}
		return undefined;
	};

	return {
		exec,
		execOut,
		sleep: () => {},
		execCalls,
		outCalls,
		get pileUp() {
			return pileUp;
		},
		get createdOverResidual() {
			return createdOverResidual;
		},
		get maxSameName() {
			return maxSameName;
		},
		get sameNameNow() {
			return sameNameCount();
		},
		verbs: () => execCalls.map((c) => `${c[1]}`),
		newWindowCalled: () => execCalls.some((c) => c[1] === "new-window"),
	};
}

describe("ensureRunnerTuiWindow", () => {
	it("probes tmux, ensures the session, purges + re-ensures + verifies, then creates the window", () => {
		const t = fakeTmux({ initial: [{ id: "@0", name: "zsh" }] }); // clean session, no stale FLY-1188
		const outcome = ensureRunnerTuiWindow(spec, {
			exec: t.exec,
			execOut: t.execOut,
			sleep: t.sleep,
		});
		expect(outcome).toEqual({ created: true });
		// No stale same-named window → no kill; the verb sequence is
		// probe → ensure → re-ensure → create (list-windows go through execOut).
		expect(t.verbs()).toEqual([
			"-V",
			"new-session",
			"new-session",
			"new-window",
		]);
		expect(t.outCalls.filter((c) => c[1] === "list-windows")).toHaveLength(2);
		const createCall = t.execCalls.find((c) => c[1] === "new-window");
		expect(createCall).toContain("FLY-1188");
		expect(createCall?.some((a) => a.includes("codex resume"))).toBe(true);
		expect(t.pileUp).toBe(false);
	});

	it("returns tmux-absent when tmux is unavailable — the run is unaffected", () => {
		const t = fakeTmux({ tmuxAvailable: false });
		expect(
			ensureRunnerTuiWindow(spec, { exec: t.exec, execOut: t.execOut }),
		).toEqual({ created: false, reason: "tmux-absent" });
		expect(t.execCalls).toHaveLength(1); // only the -V probe
		expect(t.newWindowCalled()).toBe(false);
	});

	it("returns create-failed (non-fatal) when window creation fails", () => {
		const t = fakeTmux({
			initial: [{ id: "@0", name: "zsh" }],
			createOk: false,
		});
		expect(
			ensureRunnerTuiWindow(spec, {
				exec: t.exec,
				execOut: t.execOut,
				sleep: t.sleep,
			}),
		).toEqual({ created: false, reason: "create-failed" });
	});

	it("returns died when the pane dies during settle (the rollout-landing race)", () => {
		const t = fakeTmux({
			initial: [{ id: "@0", name: "zsh" }],
			paneAlive: false, // window created but the TUI exited immediately
		});
		expect(
			ensureRunnerTuiWindow(spec, {
				exec: t.exec,
				execOut: t.execOut,
				sleep: t.sleep,
			}),
		).toEqual({ created: false, reason: "died" });
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

// ── FLY-1239 — the founder must NEVER see a pile-up of same-named dead panes ──
// (Lead hard requirement; Codex R1 HIGH-1 + R2 MED-1). These use the STATEFUL
// fake so duplicates are representable and the "kill last window destroys the
// session" rule is modeled — the properties a Set-by-name fake could not test.
describe("FLY-1239: provable stale purge (≤1 same-named window)", () => {
	it("kills a single stale same-named window by immutable id, verifies clean, then creates", () => {
		const t = fakeTmux({
			initial: [
				{ id: "@0", name: "zsh" },
				{ id: "@1", name: spec.windowName }, // a stale dead-pane leftover
			],
		});
		const outcome = ensureRunnerTuiWindow(spec, {
			exec: t.exec,
			execOut: t.execOut,
			sleep: t.sleep,
		});
		expect(outcome).toEqual({ created: true });
		// killed by IMMUTABLE id (@1), not by ambiguous name
		expect(t.execCalls).toContainEqual(["tmux", "kill-window", "-t", "@1"]);
		expect(t.pileUp).toBe(false);
		expect(t.maxSameName).toBeLessThanOrEqual(1);
		expect(t.sameNameNow).toBe(1);
	});

	it("purges PRE-EXISTING DUPLICATES (both same-named) by id before creating", () => {
		const t = fakeTmux({
			initial: [
				{ id: "@0", name: "zsh" },
				{ id: "@1", name: spec.windowName },
				{ id: "@2", name: spec.windowName }, // tmux permits duplicate names
			],
		});
		const outcome = ensureRunnerTuiWindow(spec, {
			exec: t.exec,
			execOut: t.execOut,
			sleep: t.sleep,
		});
		expect(outcome).toEqual({ created: true });
		expect(t.execCalls).toContainEqual(["tmux", "kill-window", "-t", "@1"]);
		expect(t.execCalls).toContainEqual(["tmux", "kill-window", "-t", "@2"]);
		expect(t.pileUp).toBe(false);
		expect(t.maxSameName).toBeLessThanOrEqual(1);
	});

	it("re-ensures the session when the stale window was the session's ONLY window (kill destroys session)", () => {
		const t = fakeTmux({
			initial: [{ id: "@1", name: spec.windowName }], // the ONLY window
		});
		const outcome = ensureRunnerTuiWindow(spec, {
			exec: t.exec,
			execOut: t.execOut,
			sleep: t.sleep,
		});
		// killing @1 destroys the session; the re-ensure recreates it → verify finds
		// zero FLY-1188 → create succeeds (would be a false create-failed without it).
		expect(outcome).toEqual({ created: true });
		expect(t.pileUp).toBe(false);
		expect(t.maxSameName).toBeLessThanOrEqual(1);
	});

	it("refuses to create (create-failed) when a same-named window CANNOT be proven gone", () => {
		const t = fakeTmux({
			initial: [
				{ id: "@0", name: "zsh" },
				{ id: "@1", name: spec.windowName },
			],
			killEffective: false, // simulate a kill that does not remove the window
		});
		const outcome = ensureRunnerTuiWindow(spec, {
			exec: t.exec,
			execOut: t.execOut,
			sleep: t.sleep,
		});
		expect(outcome).toEqual({ created: false, reason: "create-failed" });
		// the crucial no-pile-up guarantee: NEVER new-window while a same-name remains
		expect(t.newWindowCalled()).toBe(false);
		expect(t.createdOverResidual).toBe(false);
	});

	it("refuses to create (create-failed) when the session cannot be listed", () => {
		const t = fakeTmux({ listFails: true });
		const outcome = ensureRunnerTuiWindow(spec, {
			exec: t.exec,
			execOut: t.execOut,
			sleep: t.sleep,
		});
		expect(outcome).toEqual({ created: false, reason: "create-failed" });
		expect(t.newWindowCalled()).toBe(false);
	});

	it("refuses to create when the VERIFY listing fails (first list ok, second fails) — Codex code R1 LOW-3", () => {
		const t = fakeTmux({
			initial: [
				{ id: "@0", name: "zsh" },
				{ id: "@1", name: spec.windowName },
			],
			verifyListFails: true, // purge succeeds, but the re-list to PROVE it fails
		});
		const outcome = ensureRunnerTuiWindow(spec, {
			exec: t.exec,
			execOut: t.execOut,
			sleep: t.sleep,
		});
		expect(outcome).toEqual({ created: false, reason: "create-failed" });
		// cannot PROVE clean → never create
		expect(t.newWindowCalled()).toBe(false);
	});

	it("parses window names WITH SPACES and kills only the EXACT-name target id — Codex code R1 LOW-3", () => {
		const t = fakeTmux({
			initial: [
				{ id: "@0", name: "zsh -l" }, // a name with a space
				{ id: "@1", name: "my long name" }, // a name with spaces
				{ id: "@2", name: spec.windowName }, // the ONLY exact match
				{ id: "@3", name: `${spec.windowName}-other` }, // a prefix, NOT an exact match
			],
		});
		const outcome = ensureRunnerTuiWindow(spec, {
			exec: t.exec,
			execOut: t.execOut,
			sleep: t.sleep,
		});
		expect(outcome).toEqual({ created: true });
		const killed = t.execCalls
			.filter((c) => c[1] === "kill-window")
			.map((c) => c[c.indexOf("-t") + 1]);
		expect(killed).toEqual(["@2"]); // ONLY the exact-name match, not space-names / prefix
		expect(t.pileUp).toBe(false);
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
		const t = fakeTmux({ initial: [{ id: "@0", name: "zsh" }] });
		expect(() =>
			ensureRunnerTuiWindow(spec, {
				exec: t.exec,
				execOut: t.execOut,
				sleep: t.sleep,
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
	it("reports died when the window dies immediately (tmux new-window 'succeeds' regardless)", () => {
		// tmux accepts every command and the purge/verify pass, but the window never
		// comes up — exactly what a TUI that exits 1 on 'stdout is not a terminal' (or
		// the FLY-1239 'no rollout found' race) looks like from outside.
		const t = fakeTmux({
			initial: [{ id: "@0", name: "zsh" }],
			paneAlive: false,
		});
		const outcome = ensureRunnerTuiWindow(spec, {
			exec: t.exec,
			execOut: t.execOut,
			sleep: t.sleep,
		});
		// must NOT claim "founder TUI up" for a dead pane; must classify as retryable died
		expect(outcome).toEqual({ created: false, reason: "died" });
	});
});
