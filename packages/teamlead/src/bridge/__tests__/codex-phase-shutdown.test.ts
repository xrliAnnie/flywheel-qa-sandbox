import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../StateStore.js";
import {
	DEFAULT_ACK_TIMEOUT_MS,
	DEFAULT_CONTROLLER_LEASE_MAX_AGE_MS,
	isFreshControllerHeartbeat,
	parseControllerHeartbeatMs,
	prepareCodexPhaseShutdown,
	type RunnerShutdownDb,
} from "../codex-phase-shutdown.js";

function phaseSession(overrides: Partial<Session> = {}): Session {
	return {
		execution_id: "exec-1",
		issue_id: "issue-1",
		project_name: "flywheel",
		status: "design_done",
		adapter_type: "codex-tmux",
		chat_thread_role: "design",
		heartbeat_at: "2026-07-14 12:00:00",
		...overrides,
	};
}

function fakeDb(overrides: Partial<RunnerShutdownDb> = {}): RunnerShutdownDb {
	let control: ReturnType<RunnerShutdownDb["getRunnerShutdown"]> | undefined;
	return {
		getRunnerShutdown: vi.fn(() => control ?? null),
		requestRunnerShutdown: vi.fn((executionId, requestId, nowMs) => {
			control = {
				execution_id: executionId,
				request_id: requestId,
				state: "requested",
				requested_at: nowMs,
				finished_at: null,
				error: null,
			};
			return control;
		}),
		close: vi.fn(),
		...overrides,
	};
}

function harness(args: {
	session?: Session;
	probe?: "alive" | "dead_pin" | "absent" | "indeterminate";
	db?: RunnerShutdownDb;
	afterSleep?: () => void;
}) {
	let session = args.session ?? phaseSession();
	const db = args.db ?? fakeDb();
	let nowMs = Date.parse("2026-07-14T12:00:10Z");
	const lookupTarget = vi.fn(() => ({
		kind: "found" as const,
		target: { tmuxWindow: "runner:@1", sessionName: "runner" },
	}));
	const probe = vi.fn(async () => args.probe ?? "alive");
	const sleep = vi.fn(async (ms: number) => {
		nowMs += ms;
		args.afterSleep?.();
	});
	return {
		db,
		lookupTarget,
		probe,
		sleep,
		setSession(next: Session) {
			session = next;
		},
		run: () =>
			prepareCodexPhaseShutdown(
				{
					executionId: "exec-1",
					projectName: "flywheel",
					getSession: () => session,
				},
				{
					resolveCommDbPath: () => "/tmp/comm.db",
					openCommDb: () => db,
					lookupTarget,
					probe,
					now: () => nowMs,
					sleep,
					randomId: () => "shutdown-1",
					shutdownAckTimeoutMs: 20,
					controllerLeaseMaxAgeMs: 60_000,
					pollIntervalMs: 10,
				},
			),
	};
}

describe("prepareCodexPhaseShutdown", () => {
	it("exports the exact heartbeat ruler used by the shutdown decision", () => {
		const now = Date.parse("2026-07-14T12:00:10Z");
		expect(DEFAULT_ACK_TIMEOUT_MS).toBe(30_000);
		expect(DEFAULT_CONTROLLER_LEASE_MAX_AGE_MS).toBe(60_000);
		expect(parseControllerHeartbeatMs("2026-07-14 12:00:00")).toBe(
			Date.parse("2026-07-14T12:00:00Z"),
		);
		expect(parseControllerHeartbeatMs("malformed")).toBeUndefined();
		expect(isFreshControllerHeartbeat("2026-07-14 12:00:00", now, 60_000)).toBe(
			true,
		);
		expect(isFreshControllerHeartbeat("2026-07-14 11:58:00", now, 60_000)).toBe(
			false,
		);
		expect(isFreshControllerHeartbeat("2026-07-14 12:00:11", now, 60_000)).toBe(
			false,
		);
	});

	it.each([
		phaseSession({ adapter_type: "claude-tmux" }),
		phaseSession({ chat_thread_role: "main" }),
	])(
		"leaves Claude phases and ordinary Codex on direct legacy cleanup",
		async (session) => {
			const h = harness({ session });
			expect(await h.run()).toEqual({ kind: "not_applicable" });
			expect(h.db.requestRunnerShutdown).not.toHaveBeenCalled();
		},
	);

	it("applies the resident shutdown protocol to a workflow-bound generic main actor", async () => {
		const h = harness({
			session: phaseSession({
				chat_thread_role: "main",
				workflow_node_id: "execute",
			}),
			probe: "absent",
		});
		expect(await h.run()).toEqual({ kind: "direct", reason: "absent" });
	});

	// FLY-1269 regression: these previously asserted `direct/controller_lease_stale`
	// — i.e. they GREEN-LIT culling a window whose pane had just probed ALIVE. A
	// missing/stale lease proves only that we cannot read the controller's beat,
	// never that the controller is gone, and killing a live one orphans its daemon.
	it.each([
		phaseSession({ heartbeat_at: undefined }),
		phaseSession({ heartbeat_at: "2026-07-14 11:58:00" }),
	])(
		"fails closed when the controller lease is missing or stale but the pane is alive",
		async (session) => {
			const h = harness({ session });
			expect(await h.run()).toEqual({
				kind: "blocked",
				error: "phase_shutdown_controller_lease_stale_live_pane",
			});
			expect(h.db.requestRunnerShutdown).not.toHaveBeenCalled();
		},
	);

	// FLY-1269 Authority Matrix: a stale lease is NOT what licenses cleanup — the
	// tmux-identity verdict is. Same stale/missing lease as above, but with a probe
	// that PROVES absence, must still cull (the fix must not over-block).
	it.each(["dead_pin", "absent"] as const)(
		"still culls a stale-lease phase when the probe proves it is %s",
		async (probe) => {
			const h = harness({
				session: phaseSession({ heartbeat_at: "2026-07-14 11:58:00" }),
				probe,
			});
			expect(await h.run()).toEqual({ kind: "direct", reason: probe });
			expect(h.db.requestRunnerShutdown).not.toHaveBeenCalled();
		},
	);

	it.each(["dead_pin", "absent"] as const)(
		"falls through to direct cleanup when the process probe is %s",
		async (probe) => {
			const h = harness({ probe });
			expect(await h.run()).toEqual({ kind: "direct", reason: probe });
			expect(h.db.requestRunnerShutdown).not.toHaveBeenCalled();
		},
	);

	it("fails closed when the process probe is indeterminate", async () => {
		const h = harness({ probe: "indeterminate" });
		expect(await h.run()).toEqual({
			kind: "blocked",
			error: "phase_shutdown_liveness_indeterminate",
		});
		expect(h.db.requestRunnerShutdown).not.toHaveBeenCalled();
	});

	it("writes a request first and accepts only a matching ack after the TUI is absent", async () => {
		let state: "requested" | "acked" = "requested";
		let requested = false;
		const db = fakeDb({
			getRunnerShutdown: vi.fn(() =>
				requested
					? {
							execution_id: "exec-1",
							request_id: "shutdown-1",
							state,
							requested_at: 1,
							finished_at: state === "acked" ? 2 : null,
							error: null,
						}
					: null,
			),
			requestRunnerShutdown: vi.fn((executionId, requestId, nowMs) => {
				requested = true;
				return {
					execution_id: executionId,
					request_id: requestId,
					state: "requested",
					requested_at: nowMs,
					finished_at: null,
					error: null,
				};
			}),
		});
		const h = harness({
			db,
			afterSleep: () => {
				state = "acked";
				h.lookupTarget.mockReturnValue({ kind: "gone" });
			},
		});

		expect(await h.run()).toEqual({
			kind: "graceful",
			requestId: "shutdown-1",
		});
		expect(db.requestRunnerShutdown).toHaveBeenCalledWith(
			"exec-1",
			"shutdown-1",
			expect.any(Number),
		);
	});

	it("reuses an existing pending request", async () => {
		const db = fakeDb({
			getRunnerShutdown: vi.fn(() => ({
				execution_id: "exec-1",
				request_id: "existing",
				state: "requested",
				requested_at: 1,
				finished_at: null,
				error: null,
			})),
		});
		const h = harness({ db });
		// FLY-1269: previously `direct/controller_heartbeat_stopped`. The pending
		// request is still reused (no second request written), but the ack wait
		// times out against a LIVE pane, so the decision must fail closed.
		expect(await h.run()).toEqual({
			kind: "blocked",
			error: "phase_shutdown_ack_timeout_heartbeat_stopped_live_pane",
		});
		expect(db.requestRunnerShutdown).not.toHaveBeenCalled();
	});

	it("blocks a failed acknowledgement and preserves its evidence", async () => {
		const db = fakeDb({
			getRunnerShutdown: vi.fn(() => ({
				execution_id: "exec-1",
				request_id: "shutdown-1",
				state: "failed",
				requested_at: 1,
				finished_at: 2,
				error: "drain unconfirmed",
			})),
		});
		const h = harness({ db });
		expect(await h.run()).toEqual({
			kind: "blocked",
			error: "phase_shutdown_failed:drain unconfirmed",
		});
	});

	it("blocks an ack when the adapter window is still live", async () => {
		const db = fakeDb({
			getRunnerShutdown: vi.fn(() => ({
				execution_id: "exec-1",
				request_id: "shutdown-1",
				state: "acked",
				requested_at: 1,
				finished_at: 2,
				error: null,
			})),
		});
		const h = harness({ db });
		expect(await h.run()).toEqual({
			kind: "blocked",
			error: "phase_shutdown_ack_tui_alive",
		});
	});

	it("blocks on timeout while the heartbeat advances and the process stays alive", async () => {
		const h = harness({
			afterSleep: () =>
				h.setSession(phaseSession({ heartbeat_at: "2026-07-14 12:00:11" })),
		});
		expect(await h.run()).toEqual({
			kind: "blocked",
			error: "phase_shutdown_ack_timeout_live_controller",
		});
	});

	// FLY-1269 regression: this previously asserted `direct/controller_heartbeat_stopped`
	// — the "orphan fallback". But a stopped heartbeat cannot tell a DEAD controller
	// from a live-but-wedged one, and the pane here probes ALIVE, so the fallback was
	// culling exactly the case it must not. Absence has one authority: the tmux probe.
	it("fails closed when the heartbeat stops during the ack wait but the pane is alive", async () => {
		const h = harness({});
		expect(await h.run()).toEqual({
			kind: "blocked",
			error: "phase_shutdown_ack_timeout_heartbeat_stopped_live_pane",
		});
	});

	// FLY-1269 invariant: the whole point of the fix in one assertion — no heartbeat
	// shape may ever yield `direct` while the pane probes ALIVE. Guards against a
	// future heartbeat-derived cull path being reintroduced anywhere in the flow.
	it.each([
		["missing", undefined],
		["stale", "2026-07-14 11:58:00"],
		["fresh-then-frozen", "2026-07-14 12:00:00"],
	])(
		"never returns direct on a live pane when the heartbeat is %s",
		async (_label, heartbeat_at) => {
			const h = harness({ session: phaseSession({ heartbeat_at }) });
			const decision = await h.run();
			expect(decision.kind).not.toBe("direct");
			expect(decision.kind).toBe("blocked");
		},
	);

	it("fails closed when opening or reading the shutdown DB fails", async () => {
		const h = harness({});
		await expect(
			prepareCodexPhaseShutdown(
				{
					executionId: "exec-1",
					projectName: "flywheel",
					getSession: () => phaseSession(),
				},
				{
					resolveCommDbPath: () => "/tmp/comm.db",
					openCommDb: () => {
						throw new Error("locked");
					},
					lookupTarget: h.lookupTarget,
					probe: h.probe,
					now: () => Date.parse("2026-07-14T12:00:10Z"),
					sleep: h.sleep,
					randomId: () => "shutdown-1",
				},
			),
		).resolves.toEqual({
			kind: "blocked",
			error: "phase_shutdown_db_error:locked",
		});
	});
});
