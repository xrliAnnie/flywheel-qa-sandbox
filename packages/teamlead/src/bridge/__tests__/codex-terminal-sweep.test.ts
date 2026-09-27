import type {
	BodyObservation,
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
	let bodies: Map<string, BodyObservation["verdict"]>;
	let currentBody: boolean;
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

	const bodyObservation = (exec: string): BodyObservation => {
		const value = evidence.get(exec) ?? ABSENT;
		if (value instanceof Error) throw value;
		const verdict =
			bodies.get(exec) ??
			(ownership.get(exec) === "active"
				? "alive"
				: value.liveness === "alive"
					? "alive"
					: value.liveness === "absent" &&
							!(procs instanceof Error) &&
							unattributed === 0
						? "dead"
						: "unknown");
		return {
			identity: {
				executionId: exec,
				activationId: `activation-${exec}`,
				adapter: "codex-tmux",
				generation: 1,
				lifecycleRevision: store.getSession(exec)?.lifecycle_revision ?? 0,
			},
			ownerToken: "owner",
			spawnEpoch: 1,
			bindingDigest: "a".repeat(64),
			verdict,
			observedAt: clock.toISOString(),
			expiresAt: new Date(clock.getTime() + 10000).toISOString(),
			reason: "fixture_process_evidence",
		};
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
		bodyObserver: {
			observe: async (exec) => bodyObservation(exec),
			isCurrent: () => currentBody,
		},
		completionPending: () => false,
		stopAuthorized: () => true,
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
		bodies = new Map();
		currentBody = true;
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

	it("FLY-2919: exact dead body closes in this pass despite an unavailable diagnostic process snapshot", async () => {
		seed("exec-exact");
		bodies.set("exec-exact", "dead");
		procs = new Error("diagnostic unavailable");
		await sweep().tick();
		expect(row("exec-exact")?.state).toBe("closed");
		expect(unlinkSocket).toHaveBeenCalledOnce();
	});
	it("FLY-2919: missing daemon ledger and a silent socket never prove death", async () => {
		seed("exec-unbound");
		evidence.set("exec-unbound", NO_LEDGER_DEAD);
		const s = sweep();
		await s.tick();
		advance(5);
		await s.tick();
		expect(row("exec-unbound")?.state).toBe("probe_unknown");
		expect(unlinkSocket).not.toHaveBeenCalled();
	});
	it("FLY-2919: unknown body overrides a stale active ownership registry without stopping it", async () => {
		seed("exec-unknown");
		ownership.set("exec-unknown", "active");
		bodies.set("exec-unknown", "unknown");
		const s = sweep();
		await s.tick();
		advance(5);
		await s.tick();
		expect(row("exec-unknown")?.state).toBe("probe_unknown");
		expect(requestStop).not.toHaveBeenCalled();
	});
	it("FLY-2919: exact living body overrides an absent daemon-only observation", async () => {
		seed("exec-writer");
		bodies.set("exec-writer", "alive");
		await sweep().tick();
		expect(reap).toHaveBeenCalledOnce();
		expect(row("exec-writer")?.state).toBe("alive_reaped_pending");
	});
	it("FLY-2919: authority changed during token collection refuses death and cleanup", async () => {
		seed("exec-race");
		const s = sweep({
			tokens: () => {
				currentBody = false;
				return { rolloutPath: null };
			},
		});
		await s.tick();
		advance(5);
		await s.tick();
		expect(row("exec-race")?.state).toBe("probe_unknown");
		expect(unlinkSocket).not.toHaveBeenCalled();
	});

	it("FLY-2919: pending completion marker prevents stop, reap and death projection", async () => {
		for (const exec of ["exec-marker-live", "exec-marker-dead"]) seed(exec);
		bodies.set("exec-marker-live", "alive");
		ownership.set("exec-marker-live", "active");
		const s = sweep({ completionPending: () => true });
		await s.tick();
		advance(5);
		await s.tick();
		expect(requestStop).not.toHaveBeenCalled();
		expect(reap).not.toHaveBeenCalled();
		expect(unlinkSocket).not.toHaveBeenCalled();
		expect(row("exec-marker-dead")?.state).toBe("probe_unknown");
	});
	it("FLY-2919: disabling the signal switch during reap preflight denies the existing reap guard", async () => {
		seed("exec-switch");
		bodies.set("exec-switch", "alive");
		reap.mockImplementation(async (_session, beforeSignal: () => boolean) => {
			reapEnabled = false;
			return {
				outcome: beforeSignal() ? "reaped" : "unverifiable",
				socketPath: "/s",
			};
		});
		await sweep().tick();
		expect(row("exec-switch")?.state).toBe("alive_unverifiable");
	});
	it("FLY-2919: a changed body during alert await cannot write the old close state", async () => {
		seed("exec-alert-race");
		bodies.set("exec-alert-race", "alive");
		await sweep({
			alert: async () => {
				currentBody = false;
			},
		}).tick();
		expect(row("exec-alert-race")?.state).toBe("probe_unknown");
	});
	it("FLY-2919: approved retirement skips live cleanup but still recognizes a dead writer set", async () => {
		seed("exec-retired");
		bodyState.set("exec-retired", "retiring");
		await sweep().tick();
		expect(row("exec-retired")?.state).toBe("closed");
		expect(reap).not.toHaveBeenCalled();
	});

	it.each(["active", "none"] as const)(
		"FLY-2919: current TURN protects a %s owner from stop and reap",
		async (owner) => {
			seed("exec-turn");
			bodies.set("exec-turn", "alive");
			ownership.set("exec-turn", owner);
			const s = sweep({ stopAuthorized: () => false });
			await s.tick();
			advance(5);
			await s.tick();
			expect(requestStop).not.toHaveBeenCalled();
			expect(reap).not.toHaveBeenCalled();
		},
	);
	it("FLY-2919: a resident hold protects an owned terminal body from cooperative stop", async () => {
		seed("exec-held");
		ownership.set("exec-held", "active");
		const s = sweep({ residentHoldState: () => "woken" });
		await s.tick();
		advance(5);
		await s.tick();
		expect(requestStop).not.toHaveBeenCalled();
	});

	it("FLY-2919: unknown body stays unknown even when the diagnostic census sees an unbound process", async () => {
		seed("exec-unknown-view");
		bodies.set("exec-unknown-view", "unknown");
		procs = [proc("exec-unknown-view")];
		await sweep().tick();
		expect(row("exec-unknown-view")?.state).toBe("probe_unknown");
		expect(reap).not.toHaveBeenCalled();
		expect(requestStop).not.toHaveBeenCalled();
	});

	it("acceptance: a live terminal body is reaped and an exact dead sample closes it immediately", async () => {
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
		expect(row("exec-a")).toMatchObject({ state: "closed" });
		expect(row("exec-a")?.closed_at).toBeTruthy();
		expect(unlinkSocket).toHaveBeenCalledWith("exec-a");
		expect(closeEvents("exec-a")).toEqual([
			"codex_terminal_close_alive_reaped_pending",
			"codex_terminal_close_closed",
		]);
		// Closed rows leave the candidate set.
		advance(5);
		reap.mockClear();
		await s.tick();
		expect(reap).not.toHaveBeenCalled();
		expect(closeEvents("exec-a")).toHaveLength(2);
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
			state: "closed",
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
		expect(row("exec-r")?.state).toBe("closed");
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
			expect(row(exec)?.state).toBe("probe_unknown");
			expect(reap).not.toHaveBeenCalled();
			advance(5);
			await s.tick();
			expect(alerts.filter((a) => a.executionId === exec).at(-1)).toMatchObject(
				{
					executionId: exec,
					state: "probe_unknown",
					action: "none",
				},
			);
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

	it("a no_group ledger cannot substitute for an accepted process binding", async () => {
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
		expect(row("exec-n")?.state).toBe("probe_unknown");
	});

	it("late token ingestion does not revive an independently dead body", async () => {
		seed("exec-t");
		observeCodexTerminalClose(
			{
				store: store.codexTerminalClose,
				events: { insertEvent: (event) => store.insertEvent(event) },
			},
			"exec-t",
			{
				state: "pending_confirm",
				source: "bridge.codex-terminal-sweep",
				sessionStatus: "completed",
				evidence: {},
				tokens: { confirmTokens: 10 },
			},
		);
		tokens.set("exec-t", {
			rolloutPath: "/r.jsonl",
			read: {
				offset: 20,
				lastTotal: 5110,
				tokensAtTerminal: 100,
				tokensAfterTerminal: 5010,
				complete: true,
			},
		});
		await sweep().tick();
		expect(row("exec-t")).toMatchObject({
			state: "closed",
			tokens_after_terminal: 5010,
			rollout_offset: 20,
			rollout_last_total: 5110,
		});
		expect(alerts).toEqual([]);
	});

	it("token telemetry is retained alongside independently proven death", async () => {
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

	it("non-terminal, parked and Claude sessions are never terminal-sweep candidates", async () => {
		seed("exec-running", "running");
		seed("exec-parked", "ship_parked");
		seed("exec-claude", "completed", "claude-tmux");
		procs = [proc("exec-running"), proc("exec-parked"), proc("exec-claude")];
		evidence.set("exec-running", ALIVE);
		const probe = vi.fn(async (exec: string) => bodyObservation(exec));
		await sweep({
			bodyObserver: { observe: probe, isCurrent: () => currentBody },
		}).tick();
		expect(probe).not.toHaveBeenCalled();
		expect(row("exec-running")).toBeUndefined();
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
		expect(row("exec-e2")?.state).toBe("closed");
	});

	it("an incomplete token read cannot postpone exact process death", async () => {
		seed("exec-big");
		tokens.set("exec-big", {
			rolloutPath: "/r.jsonl",
			read: {
				offset: 100,
				lastTotal: 100,
				tokensAtTerminal: 0,
				tokensAfterTerminal: 100,
				complete: false,
				note: "read_truncated",
			},
		});
		await sweep().tick();
		expect(row("exec-big")).toMatchObject({
			state: "closed",
			rollout_offset: 100,
		});
	});
	it("FLY-2919: a newly terminal dead body is considered without a three minute delay", async () => {
		seed("exec-fresh");
		clock = new Date(Date.now() + 1000);
		await sweep().tick();
		expect(row("exec-fresh")?.state).toBe("closed");
	});

	it("an unresolvable rollout does not block exact process death", async () => {
		seed("exec-norollout");
		const s = sweep();
		await s.tick();
		advance(5);
		await s.tick();
		expect(row("exec-norollout")?.state).toBe("closed");
	});
});
