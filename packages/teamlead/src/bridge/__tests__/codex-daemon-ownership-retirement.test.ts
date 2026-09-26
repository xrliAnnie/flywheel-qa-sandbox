import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	admitCodexAgentHome,
	releaseCodexAgentHomeLease,
} from "flywheel-claude-runner";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CodexRunnerOrphanSweepDeps,
	defaultListCodexDaemonLedgers,
	sweepCodexRunnerOrphans,
} from "../codex-runner-orphan-reaper.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function fixture(
	present = false,
	generation: string | undefined = "00000000-0000-4000-8000-000000000001",
) {
	const root = mkdtempSync(join(tmpdir(), "fly2920-E-"));
	roots.push(root);
	const env = {
		FLYWHEEL_CODEX_HOMES_ROOT: join(root, "homes"),
		FLYWHEEL_CODEX_SESSION_DIR: join(root, "sessions"),
		FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT: join(root, "sockets"),
	};
	const executionId = "retired-exec";
	const sessionDir = join(env.FLYWHEEL_CODEX_SESSION_DIR, executionId);
	mkdirSync(sessionDir, { recursive: true });
	mkdirSync(env.FLYWHEEL_CODEX_HOMES_ROOT);
	const home = join(env.FLYWHEEL_CODEX_HOMES_ROOT, executionId);
	if (present) mkdirSync(home);
	const sessionPath = join(sessionDir, "session.json");
	const state = {
		executionId,
		daemonPgid: 4210,
		daemonOwnershipGeneration: generation,
		threadId: "keep-thread",
		gateHold: true,
		cwd: "/keep/worktree",
		future: { secret: "keep" },
	};
	writeFileSync(sessionPath, JSON.stringify(state));
	const original = readFileSync(sessionPath, "utf8");
	const audit = vi.fn();
	const signalGroup = vi.fn(() => ({ ok: true as const }));
	const deps: CodexRunnerOrphanSweepDeps = {
		env,
		audit,
		signalGroup,
		listProcesses: async () => ({ status: "ok", rows: [] }),
		socketHolderPids: async () => ({ status: "ok", pids: [] }),
	};
	const sweep = (isExecutionActive = () => false) =>
		sweepCodexRunnerOrphans(
			{ activeExecutionIds: new Set(), isExecutionActive },
			deps,
		);
	return {
		root,
		env,
		home,
		sessionDir,
		sessionPath,
		state,
		original,
		audit,
		signalGroup,
		deps,
		sweep,
	};
}

describe("FLY-2920 durable daemon ownership retirement", () => {
	it.each([false, true])(
		"retires file-backed %s home exactly once over two sweeps without modifying session or home",
		async (present) => {
			const f = fixture(present);
			const first = await f.sweep();
			const second = await f.sweep();
			expect(first.ledgerCandidates).toBe(1);
			expect(second.ledgerCandidates).toBe(0);
			expect(readFileSync(f.sessionPath, "utf8")).toBe(f.original);
			expect(existsSync(f.home)).toBe(present);
			expect(f.signalGroup).not.toHaveBeenCalled();
			expect(
				f.audit.mock.calls.filter(
					([event]) => event === "codex_daemon_ownership_retired",
				),
			).toHaveLength(1);
			expect(await defaultListCodexDaemonLedgers(f.env)).toEqual({
				status: "ok",
				ledgers: [],
			});
		},
	);
	it("does not mistake home inventory absence for missing home", async () => {
		const f = fixture(true);
		f.deps.listHomes = async () => ({ status: "ok", executionIds: [] });
		f.deps.listProcesses = async () => ({
			status: "ok",
			rows: [
				{
					pid: 4210,
					pgid: 4210,
					ppid: 1,
					elapsedSeconds: 99999,
					command: "other-process",
				},
			],
		});
		await f.sweep();
		await f.sweep();
		expect((await defaultListCodexDaemonLedgers(f.env)).status).toBe("ok");
		expect((await f.sweep()).ledgerCandidates).toBe(1);
		expect(f.signalGroup).not.toHaveBeenCalled();
	});
	it.each([
		"generation",
		"session-bytes",
		"active",
		"home-reappears",
		"process",
		"socket",
	])(
		"refuses publication when %s changes during the final probe",
		async (race) => {
			const f = fixture(race !== "home-reappears");
			let changed = false;
			let active = false;
			f.deps.socketHolderPids = async () => {
				if (!changed) {
					changed = true;
					if (race === "generation")
						writeFileSync(
							f.sessionPath,
							JSON.stringify({
								...f.state,
								daemonOwnershipGeneration:
									"00000000-0000-4000-8000-000000000002",
							}),
						);
					if (race === "session-bytes")
						writeFileSync(f.sessionPath, `${f.original}\n`);
					if (race === "active") active = true;
					if (race === "home-reappears") mkdirSync(f.home);
				}
				return { status: "ok", pids: race === "socket" ? [4210] : [] };
			};
			let probes = 0;
			f.deps.listProcesses = async () => {
				probes++;
				return {
					status: "ok",
					rows:
						race === "process" && probes > 1
							? [
									{
										pid: 4210,
										pgid: 4210,
										ppid: 1,
										elapsedSeconds: 9999,
										command: "other-process",
									},
								]
							: [],
				};
			};
			await f.sweep(() => active);
			expect(
				f.audit.mock.calls.filter(
					([event]) => event === "codex_daemon_ownership_retired",
				),
			).toHaveLength(0);
			expect(
				readdirSync(f.sessionDir).filter((n) =>
					n.startsWith("daemon-ownership-retired-"),
				),
			).toHaveLength(0);
		},
	);
	it("retains a live daemon leader even after its group and socket change", async () => {
		const f = fixture(true);
		f.deps.listProcesses = async () => ({
			status: "ok",
			rows: [
				{
					pid: 4210,
					pgid: 5999,
					ppid: 1,
					elapsedSeconds: 9999,
					command: "/opt/codex app-server --listen unix:///different/socket",
				},
			],
		});
		await f.sweep();
		expect((await f.sweep()).ledgerCandidates).toBe(1);
		expect(
			f.audit.mock.calls.filter(
				([event]) => event === "codex_daemon_ownership_retired",
			),
		).toHaveLength(0);
	});
	it("publishes one receipt and one durable audit when concurrent sweeps race", async () => {
		const f = fixture();
		await Promise.all([f.sweep(), f.sweep()]);
		expect(
			f.audit.mock.calls.filter(
				([event]) => event === "codex_daemon_ownership_retired",
			),
		).toHaveLength(1);
		expect(
			readdirSync(f.sessionDir).filter((n) =>
				n.startsWith("daemon-ownership-retired-"),
			),
		).toHaveLength(1);
		expect((await f.sweep()).ledgerCandidates).toBe(0);
	});
	it("refuses retirement when the fresh active-execution lookup throws", async () => {
		const f = fixture();
		await f.sweep(() => {
			throw new Error("database unavailable");
		});
		expect(await defaultListCodexDaemonLedgers(f.env)).toMatchObject({
			status: "ok",
			ledgers: [{ executionId: f.state.executionId }],
		});
		expect(
			f.audit.mock.calls.filter(
				([event]) => event === "codex_daemon_ownership_retired",
			),
		).toHaveLength(0);
	});

	it("rejects malformed ownership generation instead of treating it as legacy", async () => {
		const f = fixture(false, "not-a-generation");
		expect(await defaultListCodexDaemonLedgers(f.env)).toEqual({
			status: "ok",
			ledgers: [],
		});
	});
	it("does not treat filesystem EACCES as home absence", async () => {
		const f = fixture(true);
		f.deps.listHomes = async () => ({
			status: "ok",
			executionIds: [f.state.executionId],
		});
		chmodSync(f.env.FLYWHEEL_CODEX_HOMES_ROOT, 0);
		try {
			await f.sweep();
			expect((await f.sweep()).ledgerCandidates).toBe(1);
			expect(
				f.audit.mock.calls.filter(
					([event]) => event === "codex_daemon_ownership_retired",
				),
			).toHaveLength(0);
		} finally {
			chmodSync(f.env.FLYWHEEL_CODEX_HOMES_ROOT, 0o700);
		}
	});

	it.each(["new-generation", "legacy-upgrade"])(
		"never lets an old receipt suppress %s",
		async (mode) => {
			const f = fixture(
				false,
				mode === "legacy-upgrade"
					? undefined
					: "00000000-0000-4000-8000-000000000001",
			);
			if (mode === "legacy-upgrade") {
				const { daemonOwnershipGeneration: _, ...legacy } = f.state;
				writeFileSync(f.sessionPath, JSON.stringify(legacy));
			}
			await f.sweep();
			expect((await f.sweep()).ledgerCandidates).toBe(0);
			writeFileSync(
				f.sessionPath,
				JSON.stringify({
					...f.state,
					daemonOwnershipGeneration: "00000000-0000-4000-8000-000000000002",
				}),
			);
			expect((await f.sweep()).ledgerCandidates).toBe(1);
			expect((await f.sweep()).ledgerCandidates).toBe(0);
		},
	);
	it("suppresses mismatch audit replay but emits again for changed evidence", async () => {
		const f = fixture(true);
		let command = "unrelated-process";
		f.deps.listProcesses = async () => ({
			status: "ok",
			rows: [{ pid: 4210, pgid: 4210, ppid: 1, elapsedSeconds: 9999, command }],
		});
		await f.sweep();
		await f.sweep();
		command = "different-process";
		await f.sweep();
		expect(
			f.audit.mock.calls.filter(
				([event]) => event === "codex_app_server_orphan_identity_mismatch",
			),
		).toHaveLength(2);
		expect(f.signalGroup).not.toHaveBeenCalled();
		expect(readFileSync(f.sessionPath, "utf8")).toBe(f.original);
	});
	it.each([
		"home-symlink",
		"ancestor-symlink",
		"invalid-marker",
		"invalid-home-record",
		"process-unknown",
		"socket-unknown",
	])("fails closed for %s", async (mode) => {
		const f = fixture();
		if (mode === "home-symlink") symlinkSync(join(f.root, "missing"), f.home);
		if (mode === "ancestor-symlink") {
			rmSync(f.env.FLYWHEEL_CODEX_HOMES_ROOT, { recursive: true });
			const target = join(f.root, "target");
			mkdirSync(target);
			symlinkSync(target, f.env.FLYWHEEL_CODEX_HOMES_ROOT);
		}
		if (mode === "invalid-marker") {
			const home = join(
				f.env.FLYWHEEL_CODEX_HOMES_ROOT,
				"agents",
				"flywheel",
				"implement",
			);
			mkdirSync(home, { recursive: true });
			writeFileSync(
				f.sessionPath,
				JSON.stringify({
					...f.state,
					codexAgentHome: { home, project: "flywheel", role: "implement" },
				}),
			);
		}
		if (mode === "invalid-home-record")
			writeFileSync(
				f.sessionPath,
				JSON.stringify({ ...f.state, codexAgentHome: { home: f.home } }),
			);
		if (mode === "process-unknown")
			f.deps.listProcesses = async () => ({
				status: "unknown",
				error: "permission denied",
			});
		if (mode === "socket-unknown")
			f.deps.socketHolderPids = async () => ({
				status: "unknown",
				error: "permission denied",
			});
		await f.sweep();
		expect((await f.sweep()).ledgerCandidates).toBe(
			mode === "process-unknown" ? 0 : 1,
		);
		expect(
			f.audit.mock.calls.filter(
				([event]) => event === "codex_daemon_ownership_retired",
			),
		).toHaveLength(0);
	});
	it("resolves keyed homes after expired lease removal and preserves credentials", async () => {
		const f = fixture();
		const admission = await admitCodexAgentHome(
			{
				project: "flywheel",
				role: "implement",
				executionId: f.state.executionId,
				requestedAssemblyArm: "bare",
			},
			f.env,
		);
		const home = admission.handle.home;
		const credential = join(home, "auth.json");
		writeFileSync(credential, "keep-credential");
		writeFileSync(
			f.sessionPath,
			JSON.stringify({
				...f.state,
				codexAgentHome: { home, project: "flywheel", role: "implement" },
			}),
		);
		expect(
			await releaseCodexAgentHomeLease(admission.handle, f.env, {
				probe: async () => ({ status: "ok", holders: [] }),
			}),
		).toMatchObject({ released: true });
		expect(
			existsSync(join(home, ".flywheel-leases", f.state.executionId)),
		).toBe(false);
		// Release owns credential scrubbing; retirement must preserve newly refreshed credentials.
		writeFileSync(credential, "keep-credential");
		expect((await f.sweep()).ledgerCandidates).toBe(1);
		expect((await f.sweep()).ledgerCandidates).toBe(0);
		expect(readFileSync(credential, "utf8")).toBe("keep-credential");
	});
});
