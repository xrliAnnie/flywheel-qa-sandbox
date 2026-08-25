import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	assertSocketPathFitsSunLen,
	buildDaemonAppsApprovalArgs,
	buildDaemonEffortArgs,
	buildDaemonSandboxArgs,
	codexDaemonExitWaitMs,
	codexSessionStateDir,
	createDefaultKillGroup,
	type DaemonChild,
	daemonSocketDir,
	probeCodexDaemonLiveness,
	reapCodexDaemonForExecution,
	resolveDaemonSocketPath,
	SUN_PATH_MAX,
	spawnCodexDaemon,
} from "../src/codex-daemon-runtime.js";

describe("FLY-1940 codex daemon execution ownership", () => {
	function ownershipFixture() {
		const root = mkdtempSync(join(tmpdir(), "flywheel-codex-owner-"));
		const env = {
			FLYWHEEL_CODEX_SESSION_DIR: join(root, "sessions"),
			FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT: join(root, "sockets"),
		};
		const executionId = "exec-owned";
		mkdirSync(codexSessionStateDir(executionId, env), { recursive: true });
		writeFileSync(
			join(codexSessionStateDir(executionId, env), "session.json"),
			JSON.stringify({ executionId, daemonPgid: 4321 }),
		);
		return { root, env, executionId };
	}

	it("classifies alive only when the socket holder belongs to the persisted group", async () => {
		const f = ownershipFixture();
		try {
			await expect(
				probeCodexDaemonLiveness(f.executionId, {
					env: f.env,
					isSocketLive: async () => true,
					socketHolderPids: () => [7654],
					processGroupOf: () => 4321,
					processGroupState: () => "alive",
				}),
			).resolves.toBe("alive");
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	it("requires both socket and process-group absence before classifying absent", async () => {
		const f = ownershipFixture();
		try {
			await expect(
				probeCodexDaemonLiveness(f.executionId, {
					env: f.env,
					isSocketLive: async () => false,
					processGroupState: () => "absent",
				}),
			).resolves.toBe("absent");
			await expect(
				probeCodexDaemonLiveness(f.executionId, {
					env: f.env,
					isSocketLive: async () => false,
					processGroupState: () => "alive",
				}),
			).resolves.toBe("unknown");
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	it("refuses to reap a persisted group when no live socket proves ownership", async () => {
		const f = ownershipFixture();
		const signals: NodeJS.Signals[] = [];
		try {
			await expect(
				reapCodexDaemonForExecution(f.executionId, {
					env: f.env,
					isSocketLive: async () => false,
					processGroupState: () => "alive",
					killGroup: (_pgid, signal) => {
						signals.push(signal);
					},
					sleep: async () => {},
				}),
			).resolves.toMatchObject({ outcome: "unverifiable", pgid: 4321 });
			expect(signals).toEqual([]);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	it("refuses to reap when a live socket holder is not in the persisted group", async () => {
		const f = ownershipFixture();
		const killGroup = vi.fn();
		try {
			await expect(
				reapCodexDaemonForExecution(f.executionId, {
					env: f.env,
					isSocketLive: async () => true,
					socketHolderPids: () => [7654],
					processGroupOf: () => 9999,
					processGroupState: () => "alive",
					killGroup,
				}),
			).resolves.toMatchObject({ outcome: "unverifiable", pgid: 4321 });
			expect(killGroup).not.toHaveBeenCalled();
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});
});

describe("daemon group-kill safety", () => {
	it("refuses the Bridge's actual process group and caches the lookup", () => {
		const kill = vi.fn();
		const processGroupOf = vi.fn(() => 777);
		const logger = vi.fn();
		const killGroup = createDefaultKillGroup({
			pid: 123,
			ppid: 12,
			processGroupOf,
			kill,
			logger,
		});

		killGroup(777, "SIGKILL");
		killGroup(777, "SIGTERM");

		expect(kill).not.toHaveBeenCalled();
		expect(processGroupOf).toHaveBeenCalledTimes(1);
		expect(logger).toHaveBeenCalledWith(expect.stringContaining("REFUSING"));
	});

	it("preserves the proven-group kill when own PGID lookup is unavailable", () => {
		const kill = vi.fn();
		const logger = vi.fn();
		const killGroup = createDefaultKillGroup({
			pid: 123,
			ppid: 12,
			processGroupOf: () => undefined,
			kill,
			logger,
		});

		killGroup(777, "SIGKILL");

		expect(kill).toHaveBeenCalledWith(-777, "SIGKILL");
		expect(logger).toHaveBeenCalledWith(
			expect.stringContaining("signal=SIGKILL"),
		);
	});

	it("uses the daemon's negative PGID for a normal isolated group", () => {
		const kill = vi.fn();
		const killGroup = createDefaultKillGroup({
			pid: 123,
			ppid: 12,
			processGroupOf: () => 321,
			kill,
		});

		killGroup(777, "SIGTERM");

		expect(kill).toHaveBeenCalledWith(-777, "SIGTERM");
	});
});

describe("codexDaemonExitWaitMs", () => {
	it("defaults daemon exit confirmation to 10 seconds", () => {
		expect(codexDaemonExitWaitMs({})).toBe(10_000);
	});

	it("accepts a positive integer env override and rejects unsafe values", () => {
		expect(
			codexDaemonExitWaitMs({ FLYWHEEL_CODEX_DAEMON_EXIT_WAIT_MS: "12345" }),
		).toBe(12_345);
		for (const value of ["", "0", "-1", "1.5", "Infinity", "wat"]) {
			expect(
				codexDaemonExitWaitMs({
					FLYWHEEL_CODEX_DAEMON_EXIT_WAIT_MS: value,
				}),
			).toBe(10_000);
		}
	});
});

// ── FLY-1188 M4c — daemon spawn + socket lifecycle (OS effects injected) ──

/** A scriptable fake spawned child. */
class FakeChild implements DaemonChild {
	pid = 4321;
	exitCode: number | null = null;
	killed: (NodeJS.Signals | number)[] = [];
	private exitCb?: (c: number | null, s: NodeJS.Signals | null) => void;
	private errorCb?: (e: Error) => void;

	kill(signal?: NodeJS.Signals | number): boolean {
		this.killed.push(signal ?? "SIGTERM");
		return true;
	}
	once(event: "exit" | "error", cb: (...a: never[]) => void): void {
		if (event === "exit")
			this.exitCb = cb as (c: number | null, s: NodeJS.Signals | null) => void;
		else this.errorCb = cb as (e: Error) => void;
	}
	emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
		this.exitCode = code;
		this.exitCb?.(code, signal);
	}
	emitError(err: Error): void {
		this.errorCb?.(err);
	}
}

const noSleep = () => Promise.resolve();

describe("resolveDaemonSocketPath / SUN_LEN", () => {
	it("derives a SHORT deterministic path from a hash of the execId (fits SUN_LEN)", () => {
		const longExec = "b684ab29-f8d9-460b-bc6c-613ad7cfb382";
		const p = resolveDaemonSocketPath(longExec, {});
		// under HOME (not world-writable /tmp), short, .sock
		expect(p).toContain("/.flywheel/cdx-sock/");
		expect(p.endsWith(".sock")).toBe(true);
		expect(Buffer.byteLength(p, "utf8")).toBeLessThanOrEqual(SUN_PATH_MAX);
		// deterministic — same execId → same socket (reconnect across restart)
		expect(resolveDaemonSocketPath(longExec, {})).toBe(p);
		// distinct execIds → distinct sockets
		expect(resolveDaemonSocketPath("other-exec", {})).not.toBe(p);
	});

	it("honors FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT override", () => {
		expect(daemonSocketDir({ FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT: "/x/y" })).toBe(
			"/x/y",
		);
		expect(
			resolveDaemonSocketPath("e", {
				FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT: "/x/y",
			}).startsWith("/x/y/"),
		).toBe(true);
	});

	it("assertSocketPathFitsSunLen throws for an over-length path", () => {
		const tooLong = `/tmp/${"a".repeat(SUN_PATH_MAX)}.sock`;
		expect(() => assertSocketPathFitsSunLen(tooLong)).toThrow(/SUN_LEN/);
		expect(() => assertSocketPathFitsSunLen("/tmp/ok.sock")).not.toThrow();
	});
});

// ── FLY-1188 M4d — daemon sandbox `-c` overrides (writable roots + network) ──
describe("buildDaemonSandboxArgs", () => {
	it("emits the exec-cycle-shaped writable_roots + network_access overrides", () => {
		const args = buildDaemonSandboxArgs({
			sandboxWritableRoots: ["/w/tree", "/main/.git", "/main/.git/worktrees/t"],
			sandboxNetworkAccess: true,
		});
		expect(args).toEqual([
			"-c",
			'sandbox_workspace_write.writable_roots=["/w/tree","/main/.git","/main/.git/worktrees/t"]',
			"-c",
			"sandbox_workspace_write.network_access=true",
		]);
	});

	it("omits writable_roots when the list is empty/undefined, and network when false", () => {
		expect(buildDaemonSandboxArgs({})).toEqual([]);
		expect(buildDaemonSandboxArgs({ sandboxWritableRoots: [] })).toEqual([]);
		expect(
			buildDaemonSandboxArgs({
				sandboxWritableRoots: ["/only/roots"],
				sandboxNetworkAccess: false,
			}),
		).toEqual(["-c", 'sandbox_workspace_write.writable_roots=["/only/roots"]']);
	});
});

// FLY-1565 — apps/connector tool approval preset → daemon `-c` override.
// Real-machine (codex 0.146.0): a bogus value fails config load with
// "unknown variant `bogus-mode`, expected one of `auto`, `prompt`, `writes`,
// `approve`", and `approve` is exactly what codex persists per-tool after a
// human picks "don't ask again" — i.e. the auto-grant state.
describe("buildDaemonAppsApprovalArgs", () => {
	it("approve → the exact TOML-quoted apps._default override argv", () => {
		expect(buildDaemonAppsApprovalArgs("approve")).toEqual([
			"-c",
			'apps._default.default_tools_approval_mode="approve"',
		]);
	});

	it("absent → no argv (byte-compatible: CODEX_HOME config default applies)", () => {
		expect(buildDaemonAppsApprovalArgs(undefined)).toEqual([]);
		expect(buildDaemonAppsApprovalArgs("")).toEqual([]);
	});

	it("unknown value → warn + ignore, NEVER spliced into the override", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(buildDaemonAppsApprovalArgs('bogus"; rm -rf /')).toEqual([]);
			expect(warn).toHaveBeenCalledOnce();
		} finally {
			warn.mockRestore();
		}
	});
});

// FLY-1224 (T5): per-phase reasoning effort → daemon `-c` override.
describe("buildDaemonEffortArgs", () => {
	it("xhigh → the exact TOML-quoted override argv", () => {
		expect(buildDaemonEffortArgs("xhigh")).toEqual([
			"-c",
			'model_reasoning_effort="xhigh"',
		]);
	});

	it("every RoleEffort level is accepted", () => {
		for (const e of ["low", "medium", "high", "xhigh", "max"]) {
			expect(buildDaemonEffortArgs(e)).toEqual([
				"-c",
				`model_reasoning_effort="${e}"`,
			]);
		}
	});

	it("absent → no argv (byte-compatible: CODEX_HOME config default applies)", () => {
		expect(buildDaemonEffortArgs(undefined)).toEqual([]);
		expect(buildDaemonEffortArgs("")).toEqual([]);
	});

	it("unknown value → warn + ignore, NEVER spliced into the override", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(buildDaemonEffortArgs('bogus"; rm -rf /')).toEqual([]);
			expect(warn).toHaveBeenCalledOnce();
		} finally {
			warn.mockRestore();
		}
	});
});

describe("spawnCodexDaemon", () => {
	const baseOpts = (child: FakeChild, extra: Record<string, unknown> = {}) => ({
		codexBin: "/bin/codex",
		codexHome: "/home/x/.flywheel/codex-homes/exec-1",
		socketPath: "/tmp/fw-codex-sock/abc.sock",
		spawnFn: () => child,
		ensureDir: () => {},
		removeStaleSocket: () => {},
		isSocketLive: () => Promise.resolve(false),
		acquireLock: () => ({ release: () => {} }),
		sleep: noSleep,
		...extra,
	});

	it("spawns the app-server with --remote-control + CODEX_HOME and resolves once the socket appears", async () => {
		const child = new FakeChild();
		let spawnedArgs: string[] = [];
		let spawnedEnv: NodeJS.ProcessEnv = {};
		let probes = 0;
		const handle = await spawnCodexDaemon({
			...baseOpts(child),
			spawnFn: (_bin, args, o) => {
				spawnedArgs = args;
				spawnedEnv = o.env;
				return child;
			},
			socketExists: () => {
				probes += 1;
				return probes >= 3; // socket appears on the 3rd poll
			},
		});
		expect(handle.child).toBe(child);
		expect(spawnedArgs).toEqual([
			"app-server",
			"--remote-control",
			"--listen",
			"unix:///tmp/fw-codex-sock/abc.sock",
		]);
		expect(spawnedEnv.CODEX_HOME).toBe("/home/x/.flywheel/codex-homes/exec-1");
	});

	it("FLY-1940: persists the daemon process-group identity before the first socket probe", async () => {
		const child = new FakeChild();
		const order: string[] = [];
		let spawned = false;
		await spawnCodexDaemon({
			...baseOpts(child),
			spawnFn: () => {
				spawned = true;
				return child;
			},
			onSpawnIdentity: (pgid) => {
				order.push(`identity:${pgid}`);
			},
			socketExists: () => {
				if (spawned) order.push("socket-probe");
				return spawned;
			},
		});

		expect(order).toEqual([`identity:${child.pid}`, "socket-probe"]);
	});

	it("FLY-1940: a spawn-identity persistence failure kills the whole group and rejects", async () => {
		const child = new FakeChild();
		child.exitCode = 1;
		const groupSignals: NodeJS.Signals[] = [];
		let spawned = false;
		await expect(
			spawnCodexDaemon({
				...baseOpts(child),
				spawnFn: () => {
					spawned = true;
					return child;
				},
				onSpawnIdentity: () => {
					throw new Error("session identity persist failed");
				},
				killGroup: (_pgid, signal) => groupSignals.push(signal),
				socketExists: () => {
					if (!spawned) return false;
					throw new Error("socket probe must not run");
				},
			}),
		).rejects.toThrow("session identity persist failed");
		expect(groupSignals).toEqual(["SIGKILL"]);
	});

	it("FLY-1643: delivers workflow capabilities to the spawned codex process", async () => {
		const child = new FakeChild();
		let spawnedEnv: NodeJS.ProcessEnv = {};
		await spawnCodexDaemon({
			...baseOpts(child),
			env: {
				FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL: "output-ticket",
				FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL: "submission-ticket",
				FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED: "1",
				GH_TOKEN: "must-not-leak",
			},
			spawnFn: (_bin, _args, options) => {
				spawnedEnv = options.env;
				return child;
			},
			socketExists: () => true,
		});
		expect(spawnedEnv.FLYWHEEL_WORKFLOW_OUTPUT_CREDENTIAL).toBe(
			"output-ticket",
		);
		expect(spawnedEnv.FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL).toBe(
			"submission-ticket",
		);
		expect(spawnedEnv.FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED).toBe("1");
		expect(spawnedEnv.GH_TOKEN).toBeUndefined();
	});

	it("FLY-1643: the defensive fallback inherits no FLYWHEEL_ variables", async () => {
		const previous = process.env.FLYWHEEL_COMM_DB;
		process.env.FLYWHEEL_COMM_DB = "/stale/comm.db";
		try {
			const child = new FakeChild();
			let spawnedEnv: NodeJS.ProcessEnv = {};
			await spawnCodexDaemon({
				...baseOpts(child),
				spawnFn: (_bin, _args, options) => {
					spawnedEnv = options.env;
					return child;
				},
				socketExists: () => true,
			});
			expect(spawnedEnv.FLYWHEEL_COMM_DB).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.FLYWHEEL_COMM_DB;
			else process.env.FLYWHEEL_COMM_DB = previous;
		}
	});

	it("appends the sandbox `-c` overrides to the app-server argv (M4d)", async () => {
		const child = new FakeChild();
		let spawnedArgs: string[] = [];
		let probes = 0;
		await spawnCodexDaemon({
			...baseOpts(child),
			sandboxWritableRoots: ["/w/tree", "/main/.git"],
			sandboxNetworkAccess: true,
			spawnFn: (_bin, args) => {
				spawnedArgs = args;
				return child;
			},
			socketExists: () => {
				probes += 1;
				return probes >= 2;
			},
		});
		expect(spawnedArgs).toEqual([
			"app-server",
			"--remote-control",
			"--listen",
			"unix:///tmp/fw-codex-sock/abc.sock",
			"-c",
			'sandbox_workspace_write.writable_roots=["/w/tree","/main/.git"]',
			"-c",
			"sandbox_workspace_write.network_access=true",
		]);
	});

	it("appends the apps approval `-c` override to the app-server argv (FLY-1565)", async () => {
		const child = new FakeChild();
		let spawnedArgs: string[] = [];
		let probes = 0;
		await spawnCodexDaemon({
			...baseOpts(child),
			sandboxNetworkAccess: true,
			appsDefaultToolsApprovalMode: "approve",
			spawnFn: (_bin, args) => {
				spawnedArgs = args;
				return child;
			},
			socketExists: () => {
				probes += 1;
				return probes >= 2;
			},
		});
		expect(spawnedArgs).toEqual([
			"app-server",
			"--remote-control",
			"--listen",
			"unix:///tmp/fw-codex-sock/abc.sock",
			"-c",
			"sandbox_workspace_write.network_access=true",
			"-c",
			'apps._default.default_tools_approval_mode="approve"',
		]);
	});

	it("rejects (and SIGKILLs) if the daemon exits before the socket appears", async () => {
		const child = new FakeChild();
		const p = spawnCodexDaemon({
			...baseOpts(child),
			socketExists: () => false,
		});
		child.emitExit(1, null); // dies immediately
		await expect(p).rejects.toThrow(/exited early/);
		expect(child.killed).toContain("SIGKILL");
	});

	it("rejects (and SIGKILLs) on a spawn error before the socket appears", async () => {
		const child = new FakeChild();
		const p = spawnCodexDaemon({
			...baseOpts(child),
			socketExists: () => false,
		});
		child.emitError(new Error("ENOENT codex"));
		await expect(p).rejects.toThrow(/spawn error/);
		expect(child.killed).toContain("SIGKILL");
	});

	it("rejects (and SIGKILLs) on socket-wait timeout", async () => {
		const child = new FakeChild();
		let clock = 0;
		const p = spawnCodexDaemon({
			...baseOpts(child),
			socketExists: () => false,
			now: () => {
				clock += 1000;
				return clock;
			},
			socketWaitTimeoutMs: 5000,
		});
		await expect(p).rejects.toThrow(/did not appear/);
		expect(child.killed).toContain("SIGKILL");
	});

	it("ensures the parent dir + removes a STALE (not-live) socket before spawning", async () => {
		const child = new FakeChild();
		const calls: string[] = [];
		await spawnCodexDaemon({
			...baseOpts(child),
			ensureDir: (d) => calls.push(`mkdir:${d}`),
			removeStaleSocket: (p) => calls.push(`rm:${p}`),
			socketExists: () => true,
			isSocketLive: () => Promise.resolve(false), // stale → safe to remove
		});
		expect(calls).toEqual([
			"mkdir:/tmp/fw-codex-sock",
			"rm:/tmp/fw-codex-sock/abc.sock",
		]);
	});

	it("HIGH: refuses to clobber a socket a LIVE daemon is still listening on", async () => {
		const child = new FakeChild();
		let removed = false;
		let spawned = false;
		await expect(
			spawnCodexDaemon({
				...baseOpts(child),
				spawnFn: () => {
					spawned = true;
					return child;
				},
				socketExists: () => true,
				isSocketLive: () => Promise.resolve(true), // a live daemon owns it
				removeStaleSocket: () => {
					removed = true;
				},
			}),
		).rejects.toThrow(/live codex daemon is already listening/);
		expect(removed).toBe(false); // never unlinked the live socket
		expect(spawned).toBe(false); // never spawned a second daemon
	});

	// ── FLY-1188 HIGH-3 R2 (Codex full-PR review + Lead ruling): a Bridge restart
	// orphans the daemon (detached:false does NOT kill the child on parent death).
	// On a resuming redrive the orphan can still hold our execution-private socket.
	// The reap is FAIL-CLOSED: kill the persisted pid ONLY if the OS proves it is a
	// current holder of THIS socket; otherwise refuse (never kill a stranger). ──
	it("HIGH-3: reaps the prior orphan ONLY when the OS proves it holds our socket, then reclaims + spawns", async () => {
		const child = new FakeChild();
		const killed: Array<[number, NodeJS.Signals]> = [];
		const removed: string[] = [];
		let spawned = false;
		let liveProbes = 0;
		await spawnCodexDaemon({
			...baseOpts(child),
			reapOrphanPid: 99999,
			socketHolderPids: () => [99999], // lsof: pid 99999 holds the socket
			processGroupOf: (pid) => (pid === 99999 ? 99999 : undefined), // ps: ...in our group
			killPid: (pid, sig) => killed.push([pid, sig]),
			spawnFn: () => {
				spawned = true;
				return child;
			},
			socketExists: () => true,
			// probe #1 (pre-reap) → live (the orphan); after the SIGKILL the socket
			// is no longer live, so the reap-wait exits + we reclaim + spawn.
			isSocketLive: () => Promise.resolve(++liveProbes === 1),
			removeStaleSocket: (p) => removed.push(p),
		});
		expect(killed).toEqual([[99999, "SIGKILL"]]); // reaped our own proven orphan
		expect(removed).toContain("/tmp/fw-codex-sock/abc.sock"); // socket reclaimed
		expect(spawned).toBe(true); // fresh daemon started
	});

	it("HIGH-3 FAIL-CLOSED: NEVER kills a persisted pid the OS does not prove is the socket holder", async () => {
		const child = new FakeChild();
		let killedAnything = false;
		let spawned = false;
		for (const holders of [[], [4321]]) {
			// [] = lsof unavailable / no holder; [4321] = a DIFFERENT pid holds it
			await expect(
				spawnCodexDaemon({
					...baseOpts(child),
					reapOrphanPid: 99999,
					socketHolderPids: () => holders, // 99999 is NOT proven → do not kill
					processGroupOf: () => undefined, // ...and the OS offers no group proof either
					killPid: () => {
						killedAnything = true;
					},
					killGroup: () => {
						killedAnything = true;
					},
					spawnFn: () => {
						spawned = true;
						return child;
					},
					socketExists: () => true,
					isSocketLive: () => Promise.resolve(true), // a live daemon owns it
				}),
			).rejects.toThrow(/live codex daemon is already listening/);
		}
		expect(killedAnything).toBe(false); // never SIGKILLed an unproven pid
		expect(spawned).toBe(false); // never clobbered a live daemon
	});

	it("bounds the socket-holder process-group proof loop to ten probes", async () => {
		const child = new FakeChild();
		let groupProbes = 0;
		await expect(
			spawnCodexDaemon({
				...baseOpts(child),
				reapOrphanPid: 99999,
				socketHolderPids: () =>
					Array.from({ length: 100 }, (_, index) => 10_000 + index),
				processGroupOf: () => {
					groupProbes += 1;
					return 12345;
				},
				socketExists: () => true,
				isSocketLive: () => Promise.resolve(true),
			}),
		).rejects.toThrow(/live codex daemon is already listening/);
		expect(groupProbes).toBe(10);
	});

	it("HIGH-3: still REFUSES to clobber when the PROVEN orphan survives the reap (socket stays live)", async () => {
		const child = new FakeChild();
		let spawned = false;
		let t = 0;
		const clock = () => {
			t += 40; // advance past the bounded reap wait on each read
			return t;
		};
		await expect(
			spawnCodexDaemon({
				...baseOpts(child),
				reapOrphanPid: 99999,
				socketHolderPids: () => [99999], // lsof: a holder...
				processGroupOf: () => 99999, // ...ps: in our group → proven → we DO try to kill
				killPid: () => {}, // kill is a no-op → orphan never dies
				spawnFn: () => {
					spawned = true;
					return child;
				},
				socketExists: () => true,
				isSocketLive: () => Promise.resolve(true), // always live
				now: clock,
				childExitWaitMs: 50,
			}),
		).rejects.toThrow(/did not die after reap/);
		expect(spawned).toBe(false); // never clobbered a still-live daemon
	});

	it("HIGH: strips GitHub-token vars from the daemon env (FLY-123)", async () => {
		const child = new FakeChild();
		let spawnedEnv: NodeJS.ProcessEnv = {};
		await spawnCodexDaemon({
			...baseOpts(child),
			env: {
				PATH: "/usr/bin",
				GH_TOKEN: "ghp_secret",
				GITHUB_TOKEN: "gh_secret2",
			},
			spawnFn: (_bin, _args, o) => {
				spawnedEnv = o.env;
				return child;
			},
			socketExists: () => true,
		});
		expect(spawnedEnv.GH_TOKEN).toBeUndefined();
		expect(spawnedEnv.GITHUB_TOKEN).toBeUndefined();
		expect(spawnedEnv.PATH).toBe("/usr/bin"); // non-secret env preserved
		expect(spawnedEnv.CODEX_HOME).toBe("/home/x/.flywheel/codex-homes/exec-1");
	});

	it("rejects up-front for an over-length socket path (SUN_LEN)", async () => {
		const child = new FakeChild();
		await expect(
			spawnCodexDaemon({
				...baseOpts(child),
				socketPath: `/tmp/${"a".repeat(SUN_PATH_MAX)}.sock`,
			}),
		).rejects.toThrow(/SUN_LEN/);
	});

	it("stop() forwards the signal to the child (default SIGTERM)", async () => {
		const child = new FakeChild();
		const handle = await spawnCodexDaemon({
			...baseOpts(child),
			socketExists: () => true,
		});
		handle.stop();
		expect(child.killed).toContain("SIGTERM");
	});

	it("HIGH: the default O_EXCL lock refuses a second concurrent same-exec spawn, then reuses after release", async () => {
		const base = mkdtempSync(join(tmpdir(), "fly1188-lock-"));
		try {
			const socketPath = join(base, "d.sock");
			const spawnOpts = () => {
				const child = new FakeChild();
				return {
					codexBin: "/bin/codex",
					codexHome: "/h",
					socketPath,
					spawnFn: () => child,
					socketExists: () => true, // resolve immediately
					isSocketLive: () => Promise.resolve(false),
					removeStaleSocket: () => {},
					ensureDir: () => {},
					sleep: noSleep,
					// acquireLock NOT injected → the real O_EXCL default
				};
			};
			const first = await spawnCodexDaemon(spawnOpts()); // takes the lock
			// a second live holder (our own pid) is refused
			await expect(spawnCodexDaemon(spawnOpts())).rejects.toThrow(
				/owns|already listening/,
			);
			first.stop(); // signals the tree...
			await first.ensureDead(); // ...and ONLY a proven death releases the lock
			const third = await spawnCodexDaemon(spawnOpts()); // free again
			third.stop();
			await third.ensureDead();
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("MEDIUM: a symlinked lock is treated as held (no follow / no block), never reclaimed", async () => {
		const base = mkdtempSync(join(tmpdir(), "fly1188-symlock-"));
		try {
			const socketPath = join(base, "d.sock");
			const target = join(base, "secret.txt");
			// valid-looking content w/ a LIVE pid — if the reader followed the
			// symlink it would say "owns (pid …)"; O_NOFOLLOW must refuse instead.
			writeFileSync(target, JSON.stringify({ pid: process.pid }));
			symlinkSync(target, `${socketPath}.lock`);
			const child = new FakeChild();
			await expect(
				spawnCodexDaemon({
					codexBin: "/bin/codex",
					codexHome: "/h",
					socketPath,
					spawnFn: () => child,
					socketExists: () => true,
					isSocketLive: () => Promise.resolve(false),
					removeStaleSocket: () => {},
					ensureDir: () => {},
					sleep: noSleep,
				}),
			).rejects.toThrow(/unreadable/); // held-as-unknown, NOT "owns"
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("reclaims a STALE lock whose holder pid is dead", async () => {
		const base = mkdtempSync(join(tmpdir(), "fly1188-stale-"));
		try {
			const socketPath = join(base, "d.sock");
			// pre-plant a lock held by an almost-certainly-dead pid
			writeFileSync(
				`${socketPath}.lock`,
				JSON.stringify({ pid: 2147483646, ts: 1 }),
			);
			const child = new FakeChild();
			const handle = await spawnCodexDaemon({
				codexBin: "/bin/codex",
				codexHome: "/h",
				socketPath,
				spawnFn: () => child,
				socketExists: () => true,
				isSocketLive: () => Promise.resolve(false),
				removeStaleSocket: () => {},
				ensureDir: () => {},
				sleep: noSleep,
			});
			handle.stop(); // succeeded → the stale lock was reclaimed
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	it("HIGH: the default secure-dir check rejects a symlinked socket dir", async () => {
		const base = mkdtempSync(join(tmpdir(), "fly1188-"));
		try {
			const target = join(base, "target");
			mkdirSync(target);
			const link = join(base, "link");
			symlinkSync(target, link);
			const child = new FakeChild();
			await expect(
				spawnCodexDaemon({
					codexBin: "/bin/codex",
					codexHome: "/h",
					socketPath: join(link, "s.sock"), // parent dir is a symlink
					spawnFn: () => child,
					socketExists: () => false,
					removeStaleSocket: () => {},
					isSocketLive: () => Promise.resolve(false),
					sleep: noSleep,
					// ensureDir NOT injected → exercises defaultEnsureSecureDir
				}),
			).rejects.toThrow(/symlink/);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});
});

// ── QA · FLY-1188 HIGH-2 (found by the real-machine E2E, invisible to mocks) ──
//
// Every codex runner once leaked a ~178MB `codex app-server`, still holding its
// socket after teardown. A historical launcher forked codex, so the app-server
// was the launcher's CHILD. `child.kill()` reaped the launcher and left the
// app-server behind, reparented to PID 1. Worse, the pid we persisted was the
// SHIM's, so `process.kill(pid, 0)` cheerfully reported the daemon "dead" while it
// was very much alive — the pid probe LIES here, which is why nothing caught this.
//
// The daemon now runs in its OWN process group and teardown signals the GROUP:
// the shim and the app-server together, and nothing else on the machine (the group
// holds only our own descendants). Death is confirmed BY SOCKET, never by pid.
describe("spawnCodexDaemon — HIGH-2: no orphaned codex app-server", () => {
	const opts = (child: FakeChild, extra: Record<string, unknown> = {}) => ({
		codexBin: "/bin/flywheel-codex-with-fallback",
		codexHome: "/home/x/.flywheel/codex-homes/exec-1",
		socketPath: "/tmp/fw-codex-sock/abc.sock",
		spawnFn: () => child,
		ensureDir: () => {},
		removeStaleSocket: () => {},
		isSocketLive: () => Promise.resolve(false),
		acquireLock: () => ({ release: () => {} }),
		sleep: () => Promise.resolve(),
		socketExists: () => true,
		...extra,
	});

	it("stop() signals the GROUP — the shim AND the app-server it forked", async () => {
		const child = new FakeChild(); // pid 4321 = the shim = its group leader
		const groups: Array<[number, NodeJS.Signals]> = [];
		const handle = await spawnCodexDaemon({
			...opts(child),
			killGroup: (pgid, sig) => groups.push([pgid, sig]),
		});
		handle.stop();
		expect(groups).toEqual([[4321, "SIGTERM"]]); // the whole tree, not one pid
		expect(child.killed).toEqual([]); // NOT the lone-child kill that leaked
	});

	it("with no group to signal (an injected spawnFn) it falls back to the child — a made-up pid must never reach kill(-pid)", async () => {
		const child = new FakeChild();
		const handle = await spawnCodexDaemon(opts(child)); // no killGroup seam
		handle.stop("SIGKILL");
		expect(child.killed).toEqual(["SIGKILL"]);
	});

	it("ensureDead: a daemon still listening after stop is escalated to a group SIGKILL, then the socket is unlinked", async () => {
		const child = new FakeChild();
		const groups: Array<[number, NodeJS.Signals]> = [];
		const removed: string[] = [];
		// The socket stays live through the post-stop wait (the app-server ignored
		// SIGTERM / the shim died without it) and only goes quiet after the SIGKILL.
		let killedGroup = false;
		let up = false; // it is only listening AFTER it has started
		const handle = await spawnCodexDaemon({
			...opts(child),
			killGroup: (pgid, sig) => {
				groups.push([pgid, sig]);
				if (sig === "SIGKILL") killedGroup = true;
			},
			isSocketLive: () => Promise.resolve(up && !killedGroup),
			removeStaleSocket: (p) => removed.push(p),
			childExitWaitMs: 5,
			socketPollMs: 1,
		});
		up = true;
		handle.stop();
		await expect(handle.ensureDead()).resolves.toBe(true);
		expect(groups).toEqual([
			[4321, "SIGTERM"],
			[4321, "SIGKILL"], // escalated: the socket proved it was still alive
		]);
		expect(removed).toContain("/tmp/fw-codex-sock/abc.sock");
	});

	it("ensureDead: a daemon that SURVIVES the group SIGKILL is NOT reported as a clean teardown (and its socket is left alone)", async () => {
		const child = new FakeChild();
		const removed: string[] = [];
		let up = false;
		const handle = await spawnCodexDaemon({
			...opts(child),
			killGroup: () => {},
			isSocketLive: () => Promise.resolve(up), // once up, it never dies
			removeStaleSocket: (p) => removed.push(p),
			childExitWaitMs: 5,
			socketPollMs: 1,
		});
		up = true;
		// (spawn itself cleans up a pre-existing stale socket — count from HERE)
		const removedBeforeTeardown = removed.length;
		handle.stop();
		await expect(handle.ensureDead()).resolves.toBe(false);
		// never unlink a socket a live daemon still owns
		expect(removed).toHaveLength(removedBeforeTeardown);
	});

	it("reap: kills the recorded GROUP once the OS proves a socket holder belongs to it (the shim's pid is never a holder — the app-server is)", async () => {
		const child = new FakeChild();
		const groups: Array<[number, NodeJS.Signals]> = [];
		let spawned = false;
		let probes = 0;
		await spawnCodexDaemon({
			...opts(child),
			reapOrphanPid: 5000, // the persisted pid = the orphaned shim = its pgid
			socketHolderPids: () => [5001], // lsof: the APP-SERVER holds the socket
			processGroupOf: (pid) => (pid === 5001 ? 5000 : undefined), // ps: it is in our group
			killGroup: (pgid, sig) => groups.push([pgid, sig]),
			spawnFn: () => {
				spawned = true;
				return child;
			},
			isSocketLive: () => Promise.resolve(++probes === 1), // dies after the reap
			childExitWaitMs: 5,
			socketPollMs: 1,
		});
		expect(groups).toEqual([[5000, "SIGKILL"]]); // the tree, by proven group
		expect(spawned).toBe(true); // socket reclaimed → fresh daemon
	});

	it("reap FAIL-CLOSED: a socket holder in a DIFFERENT group is NOT proof — refuse to kill, refuse to clobber", async () => {
		const child = new FakeChild();
		let killedAnything = false;
		await expect(
			spawnCodexDaemon({
				...opts(child),
				reapOrphanPid: 5000,
				socketHolderPids: () => [7777], // a holder...
				processGroupOf: () => 9999, // ...but the OS says it is NOT our group
				killGroup: () => {
					killedAnything = true;
				},
				killPid: () => {
					killedAnything = true;
				},
				isSocketLive: () => Promise.resolve(true),
			}),
		).rejects.toThrow(/live codex daemon is already listening/);
		expect(killedAnything).toBe(false); // "not provable = don't act"
	});
});

// ── Codex R9 (re-review of the QA fix) — three holes in my first cut. Each was a
// way for the ORIGINAL defect class to survive: an orphan the teardown could not
// see, or a destructive kill authorized by less than full proof. ──
describe("spawnCodexDaemon — Codex R9: the teardown holes", () => {
	const opts = (child: FakeChild, extra: Record<string, unknown> = {}) => ({
		codexBin: "/bin/flywheel-codex-with-fallback",
		codexHome: "/home/x/.flywheel/codex-homes/exec-1",
		socketPath: "/tmp/fw-codex-sock/abc.sock",
		spawnFn: () => child,
		ensureDir: () => {},
		removeStaleSocket: () => {},
		acquireLock: () => ({ release: () => {} }),
		sleep: () => Promise.resolve(),
		childExitWaitMs: 5,
		socketPollMs: 1,
		...extra,
	});

	// HIGH-A: the FAILED-spawn cleanup proved death by the shim's exit — the exact
	// false probe QA caught. The shim exits, the app-server keeps the socket, and
	// we would unlink a LIVE daemon's socket and report a clean cleanup.
	it("a failed spawn whose app-server still holds the socket: never unlink, never release the lock, fail loud", async () => {
		const child = new FakeChild();
		const removed: string[] = [];
		let released = false;
		child.exitCode = 0; // the SHIM is gone...
		await expect(
			spawnCodexDaemon({
				...opts(child),
				socketExists: () => false, // ...but the socket never came up → setup fails
				isSocketLive: () => Promise.resolve(true), // ...and the app-server is ALIVE on it
				removeStaleSocket: (p) => removed.push(p),
				acquireLock: () => ({
					release: () => {
						released = true;
					},
				}),
				killGroup: () => {},
				socketWaitTimeoutMs: 5,
			}),
		).rejects.toThrow(/socket never appeared|did not|timed out/i);
		expect(removed).toEqual([]); // a live daemon's socket is NOT ours to delete
		expect(released).toBe(false); // ...and nobody else may bind this path
	});

	it("a failed spawn whose daemon IS confirmed dead: socket unlinked + lock released (the happy cleanup still works)", async () => {
		const child = new FakeChild();
		const removed: string[] = [];
		let released = false;
		child.exitCode = 1;
		await expect(
			spawnCodexDaemon({
				...opts(child),
				socketExists: () => false,
				isSocketLive: () => Promise.resolve(false), // nothing is listening
				removeStaleSocket: (p) => removed.push(p),
				acquireLock: () => ({
					release: () => {
						released = true;
					},
				}),
				killGroup: () => {},
				socketWaitTimeoutMs: 5,
			}),
		).rejects.toThrow();
		expect(removed).toContain("/tmp/fw-codex-sock/abc.sock");
		expect(released).toBe(true);
	});

	// HIGH-B: `holders.includes(pid)` used to authorize the kill on ONE fact (lsof).
	// Both facts, always — a missing/failing `ps` is NOT proof.
	it("reap FAIL-CLOSED: lsof names the persisted pid itself as a holder, but ps gives no group proof → REFUSE", async () => {
		const child = new FakeChild();
		let killedAnything = false;
		await expect(
			spawnCodexDaemon({
				...opts(child),
				reapOrphanPid: 99999,
				socketHolderPids: () => [99999], // lsof: it IS a holder (one fact)...
				processGroupOf: () => undefined, // ...but ps cannot confirm the group
				killGroup: () => {
					killedAnything = true;
				},
				killPid: () => {
					killedAnything = true;
				},
				socketExists: () => true,
				isSocketLive: () => Promise.resolve(true),
			}),
		).rejects.toThrow(/live codex daemon is already listening/);
		expect(killedAnything).toBe(false);
	});

	// MEDIUM-C: stop() used to release the lock immediately, while ensureDead()
	// unlinked the socket later — a window in which a concurrent same-exec spawn
	// could take the lock, bind a NEW daemon, and have OUR late unlink delete its
	// live socket.
	it("stop() does NOT release the single-owner lock — only a PROVEN death does", async () => {
		const child = new FakeChild();
		let released = false;
		let up = false;
		let killed = false;
		const handle = await spawnCodexDaemon({
			...opts(child),
			acquireLock: () => ({
				release: () => {
					released = true;
				},
			}),
			killGroup: (_pgid, sig) => {
				if (sig === "SIGKILL") killed = true;
			},
			socketExists: () => true,
			isSocketLive: () => Promise.resolve(up && !killed),
		});
		up = true;
		handle.stop();
		expect(released).toBe(false); // the signal is fired; the daemon is not yet proven gone
		await expect(handle.ensureDead()).resolves.toBe(true);
		expect(released).toBe(true); // released only WITH the unlink, under our ownership
	});

	it("a daemon that survives SIGKILL keeps the lock HELD — nobody may bind a socket a live daemon owns", async () => {
		const child = new FakeChild();
		let released = false;
		let up = false;
		const handle = await spawnCodexDaemon({
			...opts(child),
			acquireLock: () => ({
				release: () => {
					released = true;
				},
			}),
			killGroup: () => {}, // the kill does not take
			socketExists: () => true,
			isSocketLive: () => Promise.resolve(up),
		});
		up = true;
		handle.stop();
		await expect(handle.ensureDead()).resolves.toBe(false);
		expect(released).toBe(false);
	});
});
