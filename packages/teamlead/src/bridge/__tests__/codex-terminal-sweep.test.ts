import type {
	CodexDaemonEvidence,
	CodexProcessRecord,
} from "flywheel-claude-runner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { observeCodexTerminalClose } from "../codex-terminal-close-ledger.js";
import {
	CodexTerminalSweep,
	type CodexTerminalSweepAlert,
	type CodexTerminalSweepDeps,
	type SweepTokenObservation,
} from "../codex-terminal-sweep.js";

const ALIVE: CodexDaemonEvidence = {
	liveness: "alive",
	ledger: "valid_group",
	socketLive: true,
	spawnLock: "absent",
};
const ABSENT: CodexDaemonEvidence = {
	liveness: "absent",
	ledger: "valid_group",
	socketLive: false,
	spawnLock: "absent",
};
const NO_LEDGER_DEAD: CodexDaemonEvidence = {
	liveness: "unknown",
	ledger: "missing",
	socketLive: false,
	spawnLock: "absent",
};

function proc(
	exec: string,
	home = "/h/agents/flywheel/qa",
): CodexProcessRecord {
	return {
		pid: 4242,
		startIdentity: "Fri Sep 25 10:00:00 2026",
		argv0: "codex",
		codexHome: home,
		home: "/Users/x",
		executionId: exec,
	};
}

describe("FLY-2903 terminal Codex sweep", () => {
	let store: StateStore;
	let realNow: number;
	let clock: Date;
	let ownership: Map<string, "none" | "reserved" | "active">;
	let evidence: Map<string, CodexDaemonEvidence | Error>;
	let procs: CodexProcessRecord[] | Error;
	let unattributed: number;
	let tokens: Map<string, SweepTokenObservation>;
	let reapOutcome: "reaped" | "absent" | "residual" | "unverifiable";
	let reapEnabled: boolean;
	let bodyState: Map<string, string>;
	let alerts: CodexTerminalSweepAlert[];
	let requestStop: ReturnType<typeof vi.fn>;
	let reap: ReturnType<typeof vi.fn>;
	let unlinkSocket: ReturnType<typeof vi.fn>;

	const seed = (
		exec: string,
		status = "completed",
		adapter = "codex-tmux",
	): void => {
		store.upsertSession({
			execution_id: exec,
			issue_id: `issue-${exec}`,
			issue_identifier: "FLY-2903",
			project_name: "flywheel",
			status: "running",
			adapter_type: adapter,
		});
		if (status !== "running") store.forceStatus(exec, status, "", "x");
	};

	const deps = (
		overrides: Partial<CodexTerminalSweepDeps> = {},
	): CodexTerminalSweepDeps => ({
		now: () => clock,
		ledger: store.codexTerminalClose,
		observe: (exec, observation) =>
			observeCodexTerminalClose(
				{
					store: store.codexTerminalClose,
					events: {
						insertEvent: (event) => store.insertEvent(event),
						transaction: (fn) => store.runInTransaction(fn),
					},
					now: () => clock,
				},
				exec,
				observation,
			),
		getSession: (exec) => store.getSession(exec),
		processBodyState: (exec) => bodyState.get(exec),
		residentHoldState: () => undefined,
		snapshot: async () => {
			if (procs instanceof Error) throw procs;
			return {
				codex: procs,
				unattributed: Array.from({ length: unattributed }, (_, i) => ({
					pid: 9000 + i,
					startIdentity: "x",
					executable: "codex",
					reason: "process_home_unknown" as const,
				})),
			};
		},
		owners: {
			ownershipState: (exec) => ownership.get(exec) ?? "none",
			requestStop,
		},
		probeEvidence: async (exec) => {
			const value = evidence.get(exec) ?? ABSENT;
			if (value instanceof Error) throw value;
			return value;
		},
		reap,
		tokens: ({ executionId }) =>
			tokens.get(executionId) ?? { rolloutPath: null },
		unlinkSocket,
		reapEnabled: () => reapEnabled,
		alert: async (alert) => {
			alerts.push(alert);
		},
		log: () => {},
		...overrides,
	});
	const sweep = (overrides?: Partial<CodexTerminalSweepDeps>) =>
		new CodexTerminalSweep(deps(overrides));
	const row = (exec: string) => store.codexTerminalClose.get(exec);
	const closeEvents = (exec: string) =>
		store
			.getEventsByExecution(exec)
			.map((e) => e.event_type)
			.filter((t) => t.startsWith("codex_terminal_close_"));
	const advance = (minutes: number) => {
		clock = new Date(clock.getTime() + minutes * 60_000);
	};

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		realNow = Date.now();
		clock = new Date(realNow + 10 * 60_000);
		ownership = new Map();
		evidence = new Map();
		procs = [];
		unattributed = 0;
		tokens = new Map();
		reapOutcome = "reaped";
		reapEnabled = true;
		bodyState = new Map();
		alerts = [];
		requestStop = vi.fn(async () => "stopped");
		reap = vi.fn(async (_session, beforeSignal: () => boolean) => {
			if (!beforeSignal()) return { outcome: "unverifiable", socketPath: "/s" };
			return { outcome: reapOutcome, socketPath: "/s" };
		});
		unlinkSocket = vi.fn();
	});
	afterEach(() => store.close());

	it("acceptance: a terminal body with a live daemon is reaped, then proven closed in two samples", async () => {
		seed("exec-a");
		evidence.set("exec-a", ALIVE);
		procs = [proc("exec-a")];
		const s = sweep();

		await s.tick();
		expect(reap).toHaveBeenCalledOnce();
		expect(row("exec-a")?.state).toBe("alive_reaped_pending");
		expect(alerts.map((a) => a.state)).toEqual(["alive_reaped_pending"]);

		evidence.set("exec-a", ABSENT);
		procs = [];
		advance(5);
		await s.tick();
		expect(row("exec-a")?.state).toBe("pending_confirm");

		advance(5);
		await s.tick();
		expect(row("exec-a")).toMatchObject({ state: "closed" });
		expect(row("exec-a")?.closed_at).toBeTruthy();
		expect(unlinkSocket).toHaveBeenCalledWith("exec-a");
		expect(closeEvents("exec-a")).toEqual([
			"codex_terminal_close_alive_reaped_pending",
			"codex_terminal_close_pending_confirm",
			"codex_terminal_close_closed",
		]);
		// Closed rows leave the candidate set.
		advance(5);
		reap.mockClear();
		await s.tick();
		expect(reap).not.toHaveBeenCalled();
		expect(closeEvents("exec-a")).toHaveLength(3);
	});

	it("the reap's final guard re-checks terminal status, ownership and resident hold", async () => {
		seed("exec-g");
		evidence.set("exec-g", ALIVE);
		reap.mockImplementation(async (_session, beforeSignal: () => boolean) => {
			ownership.set("exec-g", "active");
			return {
				outcome: beforeSignal() ? "reaped" : "unverifiable",
				socketPath: "/s",
			};
		});
		await sweep().tick();
		expect(row("exec-g")?.state).toBe("alive_unverifiable");
	});

	it("FLY-2766 shape: a still-owned terminal body is only noted once, then asked to stop", async () => {
		seed("exec-o");
		ownership.set("exec-o", "active");
		evidence.set("exec-o", ALIVE);
		const s = sweep();
		await s.tick();
		expect(row("exec-o")).toMatchObject({
			state: "owned_seen",
			owned_streak: 1,
		});
		expect(requestStop).not.toHaveBeenCalled();
		expect(alerts).toEqual([]);
		expect(reap).not.toHaveBeenCalled();

		advance(5);
		await s.tick();
		expect(requestStop).toHaveBeenCalledWith("exec-o", "terminal_sweep", {
			timeoutMs: 5_000,
		});
		expect(row("exec-o")).toMatchObject({
			state: "stop_requested",
			owned_streak: 2,
		});
		expect(alerts).toEqual([
			expect.objectContaining({
				executionId: "exec-o",
				state: "stop_requested",
				action: "requestStop:stopped",
			}),
		]);
		expect(reap).not.toHaveBeenCalled();
	});

	it("an owner seen once and gone next tick resets the streak without a stop", async () => {
		seed("exec-f");
		ownership.set("exec-f", "active");
		const s = sweep();
		await s.tick();
		ownership.delete("exec-f");
		evidence.set("exec-f", ABSENT);
		advance(5);
		await s.tick();
		expect(row("exec-f")).toMatchObject({
			state: "pending_confirm",
			owned_streak: 0,
		});
		expect(requestStop).not.toHaveBeenCalled();
	});

	it("a reserved-only body is fenced (never reported as running) and judged ownerless", async () => {
		seed("exec-r");
		ownership.set("exec-r", "reserved");
		requestStop.mockResolvedValue("reserved_fenced");
		reapEnabled = false; // the fence is not flag-gated
		await sweep().tick();
		expect(requestStop).toHaveBeenCalledWith(
			"exec-r",
			"terminal_sweep",
			expect.anything(),
		);
		expect(row("exec-r")?.state).toBe("pending_confirm");
		expect(alerts).toEqual([]);
	});

	it("residual and unverifiable reaps alert without further signals", async () => {
		seed("exec-res");
		seed("exec-unv");
		evidence.set("exec-res", ALIVE);
		evidence.set("exec-unv", ALIVE);
		reap.mockImplementation(async (session: { execution_id: string }) => ({
			outcome:
				session.execution_id === "exec-res" ? "residual" : "unverifiable",
			socketPath: "/s",
		}));
		await sweep().tick();
		expect(row("exec-res")?.state).toBe("alive_residual");
		expect(row("exec-unv")?.state).toBe("alive_unverifiable");
		expect(alerts.map((a) => `${a.executionId}:${a.action}`).sort()).toEqual([
			"exec-res:reap:residual",
			"exec-unv:reap:unverifiable",
		]);
	});

	it("R1 HIGH: a live codex process that the ledger cannot bind is never closed, in any home", async () => {
		for (const home of ["/h/agents/flywheel/qa", "/elsewhere/codex-home"]) {
			const exec = `exec-h-${home.length}`;
			seed(exec);
			evidence.set(exec, NO_LEDGER_DEAD);
			procs = [proc(exec, home)];
			const s = sweep();
			await s.tick();
			advance(5);
			await s.tick();
			expect(row(exec)?.state).toBe("alive_unverifiable");
			expect(reap).not.toHaveBeenCalled();
			expect(alerts.at(-1)).toMatchObject({
				executionId: exec,
				state: "alive_unverifiable",
				action: "none",
			});
		}
	});

	it("an unattributed codex process makes the process view unknown: never closed, alert on the third miss", async () => {
		seed("exec-u");
		evidence.set("exec-u", NO_LEDGER_DEAD);
		unattributed = 1;
		const s = sweep();
		await s.tick();
		advance(5);
		await s.tick();
		expect(row("exec-u")).toMatchObject({
			state: "probe_unknown",
			unknown_streak: 2,
		});
		expect(alerts).toEqual([]);
		advance(5);
		await s.tick();
		expect(alerts.map((a) => a.state)).toEqual(["probe_unknown"]);
	});

	it("a failed snapshot is unknown, not closed", async () => {
		seed("exec-s");
		procs = new Error("process_authority_invalid");
		const s = sweep();
		await s.tick();
		advance(5);
		await s.tick();
		expect(row("exec-s")?.state).toBe("probe_unknown");
	});

	it("a daemon that never spawned (no_group ledger, dead socket) closes after two samples", async () => {
		seed("exec-n", "failed");
		evidence.set("exec-n", {
			liveness: "unknown",
			ledger: "no_group",
			socketLive: false,
			spawnLock: "absent",
		});
		const s = sweep();
		await s.tick();
		advance(5);
		await s.tick();
		expect(row("exec-n")?.state).toBe("closed");
	});

	it("tokens that grew after pending_confirm are a false success: probe_unknown + alert", async () => {
		seed("exec-t");
		tokens.set("exec-t", {
			rolloutPath: "/r.jsonl",
			read: {
				offset: 10,
				lastTotal: 110,
				tokensAtTerminal: 100,
				tokensAfterTerminal: 10,
				complete: true,
			},
		});
		const s = sweep();
		await s.tick();
		expect(row("exec-t")).toMatchObject({
			state: "pending_confirm",
			confirm_tokens: 10,
		});
		tokens.set("exec-t", {
			rolloutPath: "/r.jsonl",
			read: {
				offset: 20,
				lastTotal: 5_110,
				tokensAtTerminal: 100,
				tokensAfterTerminal: 5_010,
				complete: true,
			},
		});
		advance(5);
		await s.tick();
		expect(row("exec-t")).toMatchObject({
			state: "probe_unknown",
			tokens_after_terminal: 5_010,
			rollout_offset: 20,
			rollout_last_total: 5_110,
		});
		expect(alerts).toEqual([
			expect.objectContaining({
				state: "probe_unknown",
				tokensAfterTerminal: 5_010,
			}),
		]);
	});

	it("unchanged tokens across the two samples close the body", async () => {
		seed("exec-same");
		const read = {
			rolloutPath: "/r.jsonl",
			read: {
				offset: 10,
				lastTotal: 100,
				tokensAtTerminal: 100,
				tokensAfterTerminal: 0,
				complete: true,
			},
		};
		tokens.set("exec-same", read);
		const s = sweep();
		await s.tick();
		advance(5);
		await s.tick();
		expect(row("exec-same")).toMatchObject({
			state: "closed",
			tokens_after_terminal: 0,
			rollout_path: "/r.jsonl",
		});
	});

	it("a process-snapshot hit revives a long-closed body regardless of age", async () => {
		seed("exec-old");
		observeCodexTerminalClose(
			{
				store: store.codexTerminalClose,
				events: { insertEvent: (event) => store.insertEvent(event) },
			},
			"exec-old",
			{
				state: "closed",
				source: "bridge.codex-terminal-sweep",
				sessionStatus: "completed",
				evidence: {},
			},
		);
		clock = new Date(realNow + 72 * 3_600_000);
		procs = [proc("exec-old")];
		evidence.set("exec-old", ALIVE);
		await sweep().tick();
		expect(reap).toHaveBeenCalledOnce();
		expect(row("exec-old")?.state).toBe("alive_reaped_pending");
	});

	it("non-terminal, parked, Claude and fresh sessions are never candidates", async () => {
		seed("exec-running", "running");
		seed("exec-parked", "ship_parked");
		seed("exec-claude", "completed", "claude-tmux");
		procs = [proc("exec-running"), proc("exec-parked"), proc("exec-claude")];
		evidence.set("exec-running", ALIVE);
		const probe = vi.fn(async () => ALIVE);
		await sweep({ probeEvidence: probe }).tick();
		seed("exec-fresh");
		clock = new Date(Date.now() + 60_000);
		await sweep({ probeEvidence: probe }).tick();
		expect(probe).not.toHaveBeenCalled();
		expect(row("exec-running")).toBeUndefined();
		expect(row("exec-fresh")).toBeUndefined();
	});

	it("a standby / resuming / retiring process body is skipped this tick", async () => {
		seed("exec-body");
		bodyState.set("exec-body", "standby");
		evidence.set("exec-body", ALIVE);
		await sweep().tick();
		expect(row("exec-body")).toBeUndefined();
		expect(reap).not.toHaveBeenCalled();
	});

	it("caps each tick at 25 candidates and leaves the rest for the next tick", async () => {
		for (let i = 0; i < 30; i += 1) seed(`exec-${String(i).padStart(2, "0")}`);
		const s = sweep();
		const first = await s.tick();
		expect(first).toMatchObject({ evaluated: 25 });
		advance(5);
		const second = await s.tick();
		expect(second.evaluated).toBeGreaterThanOrEqual(5);
		expect(row("exec-29")).toBeDefined();
	});

	it("stops when the soft budget runs out", async () => {
		for (let i = 0; i < 4; i += 1) seed(`exec-b${i}`);
		let t = 0;
		const result = await sweep({
			budgetMs: 25,
			clockMs: () => {
				t += 10;
				return t;
			},
		}).tick();
		expect(result.evaluated).toBeLessThan(4);
		expect(result.deferred).toBeGreaterThan(0);
	});

	it("is single-flight", async () => {
		seed("exec-sf");
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const s = sweep({
			snapshot: async () => {
				await gate;
				return { codex: [], unattributed: [] };
			},
		});
		const first = s.tick();
		const second = await s.tick();
		expect(second).toMatchObject({ skipped: "inflight" });
		release();
		await first;
	});

	it("with the kill switch off it only records and alerts: zero requestStop, zero reap", async () => {
		reapEnabled = false;
		seed("exec-k1");
		seed("exec-k2");
		ownership.set("exec-k1", "active");
		evidence.set("exec-k2", ALIVE);
		const s = sweep();
		await s.tick();
		advance(5);
		await s.tick();
		expect(requestStop).not.toHaveBeenCalled();
		expect(reap).not.toHaveBeenCalled();
		expect(row("exec-k1")?.state).toBe("owned_seen");
		expect(row("exec-k2")?.state).toBe("alive_residual");
		expect(alerts.map((a) => `${a.executionId}:${a.action}`).sort()).toEqual([
			"exec-k1:none",
			"exec-k2:none",
		]);
	});

	it("dedupes alerts per state and token order of magnitude", async () => {
		seed("exec-d");
		evidence.set("exec-d", ALIVE);
		reapOutcome = "residual";
		const s = sweep();
		const withTokens = (n: number) =>
			tokens.set("exec-d", {
				rolloutPath: "/r.jsonl",
				read: {
					offset: n,
					lastTotal: n,
					tokensAtTerminal: 0,
					tokensAfterTerminal: n,
					complete: true,
				},
			});
		withTokens(20);
		await s.tick();
		withTokens(50);
		advance(5);
		await s.tick();
		expect(alerts).toHaveLength(1);
		withTokens(500);
		advance(5);
		await s.tick();
		expect(alerts).toHaveLength(2);
		expect(row("exec-d")?.alerted_key).toBe("alive_residual:2");
	});

	it("an alert that fails to send is retried next tick", async () => {
		seed("exec-retry");
		evidence.set("exec-retry", ALIVE);
		reapOutcome = "residual";
		let fail = true;
		const sent: string[] = [];
		const s = sweep({
			alert: async (alert) => {
				if (fail) throw new Error("sink not ready");
				sent.push(alert.executionId);
			},
		});
		await s.tick();
		expect(row("exec-retry")?.alerted_key).toBeNull();
		fail = false;
		advance(5);
		await s.tick();
		expect(sent).toEqual(["exec-retry"]);
	});

	it("an evidence probe failure is contained to its candidate", async () => {
		seed("exec-e1");
		seed("exec-e2");
		evidence.set("exec-e1", new Error("lsof failed"));
		evidence.set("exec-e2", ABSENT);
		await sweep().tick();
		expect(row("exec-e1")?.state).toBe("probe_unknown");
		expect(JSON.parse(row("exec-e1")?.last_evidence ?? "{}")).toMatchObject({
			error: "evidence_probe_failed",
		});
		expect(row("exec-e2")?.state).toBe("pending_confirm");
	});

	it("review R1 MEDIUM: an incomplete rollout read keeps pending_confirm until a complete baseline exists", async () => {
		seed("exec-big");
		const set = (after: number, complete: boolean) =>
			tokens.set("exec-big", {
				rolloutPath: "/r.jsonl",
				read: {
					offset: after,
					lastTotal: after,
					tokensAtTerminal: 0,
					tokensAfterTerminal: after,
					complete,
					...(complete ? {} : { note: "read_truncated" as const }),
				},
			});
		const s = sweep();
		set(100, false);
		await s.tick();
		expect(row("exec-big")).toMatchObject({
			state: "pending_confirm",
			confirm_tokens: null,
		});
		set(200, false);
		advance(5);
		await s.tick();
		expect(row("exec-big")?.state).toBe("pending_confirm");
		// First complete read becomes the baseline; one more sample is required.
		set(300, true);
		advance(5);
		await s.tick();
		expect(row("exec-big")).toMatchObject({
			state: "pending_confirm",
			confirm_tokens: 300,
		});
		// Tokens grew between the two complete samples: not closed.
		set(900, true);
		advance(5);
		await s.tick();
		expect(row("exec-big")?.state).toBe("probe_unknown");
		expect(alerts.map((a) => a.state)).toEqual(["probe_unknown"]);
	});

	it("an unresolvable rollout still closes on two process-free samples", async () => {
		seed("exec-norollout");
		const s = sweep();
		await s.tick();
		advance(5);
		await s.tick();
		expect(row("exec-norollout")?.state).toBe("closed");
	});
});
