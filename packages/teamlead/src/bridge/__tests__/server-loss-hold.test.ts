import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertPayload } from "../../LeadAlertNotifier.js";
import type { Session } from "../../StateStore.js";
import { StateStore } from "../../StateStore.js";
import {
	ServerLossCoordinator,
	type TmuxSocketInspection,
} from "../server-loss.js";

const SOCKET = "/private/tmp/tmux-501/default";

function session(id: string): Session {
	return {
		execution_id: id,
		issue_id: `issue-${id}`,
		issue_identifier: `FLY-${id}`,
		project_name: "flywheel",
		status: "running",
		adapter_type: "claude-tmux",
		summary: "flywheel-eng-lead",
	} as Session;
}

function inspect(
	verdict: TmuxSocketInspection["verdict"],
	overrides: Partial<TmuxSocketInspection> = {},
): TmuxSocketInspection {
	return {
		verdict,
		socketPresent: true,
		socketPath: SOCKET,
		candidatePids: [],
		scanComplete: true,
		...overrides,
	};
}

describe("ServerLossCoordinator durable tmux holds (FLY-1285)", () => {
	let store: StateStore;
	let migrations: string[];
	let alerts: AlertPayload[];
	let targetVerdicts: Record<string, boolean | null>;
	let nowMs: number;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime("2026-07-15T08:00:00.000Z");
		store = await StateStore.create(":memory:");
		migrations = [];
		alerts = [];
		targetVerdicts = {};
		nowMs = Date.parse("2026-07-15T08:20:00.000Z");
	});
	afterEach(() => {
		store.close();
		vi.useRealTimers();
	});

	function put(...ids: string[]) {
		for (const id of ids) store.upsertSession(session(id));
	}

	function coordinator(
		inspection: () => Promise<TmuxSocketInspection>,
		probe: "up" | "down" | "unknown" = "down",
	) {
		return new ServerLossCoordinator({
			store,
			probeServer: async () => probe,
			inspectSocket: inspection,
			normalizedSocketPath: SOCKET,
			targetGone: async (s) => targetVerdicts[s.execution_id] ?? null,
			migrate: async (s) => {
				migrations.push(s.execution_id);
				store.forceStatus(s.execution_id, "failed", "2026-07-15 08:00:00", "x");
				return true;
			},
			resolveLeadId: () => "flywheel-eng-lead",
			notifyLead: async () => true,
			alert: async (payload) => {
				alerts.push(payload);
				return { sent: true };
			},
			resolveHoldAlert: vi.fn().mockResolvedValue(undefined),
			now: () => nowMs,
			env: {},
			logger: () => {},
		});
	}

	it("helper failure fail-closes every running tmux session without migration", async () => {
		put("a", "b");
		const result = await coordinator(async () => {
			throw new Error("helper missing");
		}).check();
		expect([...result.claimed]).toEqual([]);
		expect([...result.heldExecutionIds].sort()).toEqual(["a", "b"]);
		expect(migrations).toEqual([]);
	});

	it("an indeterminate down probe creates one durable hydrated hold", async () => {
		put("a", "b");
		const result = await coordinator(async () => inspect("unknown")).check();
		expect([...result.heldExecutionIds].sort()).toEqual(["a", "b"]);
		expect(store.listActiveTmuxHolds()).toHaveLength(1);
		expect(store.listActiveTmuxHolds()[0]?.currentReason).toBe("unknown");
		expect(migrations).toEqual([]);
	});

	it("reachable all-present reconciliation resolves the hold and releases sessions", async () => {
		put("a", "b");
		const active = store.getOrCreateActiveTmuxHold(SOCKET, {
			reason: "saturated",
			shape: "provisional",
			shapeSource: "observation",
			evidence: {},
			affectedExecutionIds: ["a", "b"],
		});
		targetVerdicts = { a: false, b: false };
		const instance = coordinator(async () =>
			inspect("reachable", { reachablePid: 222 }),
		);
		const result = await instance.check();
		expect([...result.heldExecutionIds]).toEqual([]);
		expect(store.getActiveTmuxHold(SOCKET)).toBeUndefined();
		expect(store.listTmuxHoldHistory(SOCKET)[0]?.incidentId).toBe(
			active.incidentId,
		);
		expect(store.getServerLossEpisode()).toBeUndefined();
	});

	it("reachable all-gone converts the same incident to server_fresh and replays the outbox", async () => {
		put("a", "b");
		const active = store.getOrCreateActiveTmuxHold(SOCKET, {
			reason: "unknown",
			shape: "provisional",
			shapeSource: "observation",
			evidence: {
				originalServerPid: 111,
				originalServerPidSource: "supervisor_archive",
			},
			affectedExecutionIds: ["a", "b"],
		});
		targetVerdicts = { a: true, b: true };
		const result = await coordinator(async () =>
			inspect("reachable", { reachablePid: 222 }),
		).check();
		expect(new Set(migrations)).toEqual(new Set(["a", "b"]));
		expect(result.claimed).toEqual(new Set(["a", "b"]));
		expect(store.listTmuxHoldHistory(SOCKET)[0]?.shape).toBe("server_fresh");
		expect(store.getServerLossEpisode()?.signature).toBe(active.incidentId);
	});

	it("reachable mixed without generation evidence releases present and keeps only gone held", async () => {
		put("a", "b");
		store.getOrCreateActiveTmuxHold(SOCKET, {
			reason: "ambiguous",
			shape: "provisional",
			shapeSource: "observation",
			evidence: {},
			affectedExecutionIds: ["a", "b"],
		});
		targetVerdicts = { a: false, b: true };
		const result = await coordinator(async () =>
			inspect("reachable", { reachablePid: 222 }),
		).check();
		expect([...result.heldExecutionIds]).toEqual(["b"]);
		expect(store.getActiveTmuxHold(SOCKET)?.affectedExecutionIds).toEqual([
			"b",
		]);
		expect(store.getServerLossEpisode()).toBeUndefined();
		expect(migrations).toEqual([]);
	});

	it("scan-complete dead evidence shapes server_down before the atomic transition", async () => {
		put("a");
		store.getOrCreateActiveTmuxHold(SOCKET, {
			reason: "rescue_failed",
			shape: "provisional",
			shapeSource: "observation",
			evidence: {},
			affectedExecutionIds: ["a"],
		});
		targetVerdicts = { a: true };
		const result = await coordinator(async () =>
			inspect("dead", { socketPresent: false }),
		).check();
		expect([...result.claimed]).toEqual(["a"]);
		expect(migrations).toEqual(["a"]);
		expect(store.listTmuxHoldHistory(SOCKET)[0]?.shape).toBe("server_down");
	});

	it("escalates one correlated tmux_hold ticket after the durable 10 minute age", async () => {
		put("a");
		const active = store.getOrCreateActiveTmuxHold(SOCKET, {
			reason: "saturated",
			shape: "provisional",
			shapeSource: "observation",
			evidence: {},
			affectedExecutionIds: ["a"],
		});
		const instance = coordinator(async () => inspect("saturated"));
		await instance.check();
		await instance.check();
		const holdAlerts = alerts.filter(
			(alert) => alert.eventType === "tmux_hold",
		);
		expect(holdAlerts).toHaveLength(2); // routed sink dedups by stable event/session
		expect(holdAlerts[0]).toMatchObject({
			eventId: `tmux-hold:${active.incidentId}`,
			sessionKey: active.incidentId,
			severity: "severe",
			metadata: {
				tmuxHold: { incidentId: active.incidentId, casualtiesHeld: 1 },
			},
		});
	});

	it("split brain emits its founder-directed ticket immediately under the same incident", async () => {
		put("a");
		nowMs = Date.parse("2026-07-15T08:01:00.000Z");
		const active = store.getOrCreateActiveTmuxHold(SOCKET, {
			reason: "split_brain",
			shape: "provisional",
			shapeSource: "observation",
			evidence: {},
			affectedExecutionIds: ["a"],
		});
		await coordinator(async () =>
			inspect("split_brain", { candidatePids: [111, 222] }),
		).check();
		expect(alerts).toContainEqual(
			expect.objectContaining({
				eventType: "tmux_split_brain",
				eventId: `tmux-split-brain:${active.incidentId}:111,222`,
				sessionKey: active.incidentId,
			}),
		);
	});

	it("a first-tick split-brain detection opens the hold and ticket together", async () => {
		put("a");
		nowMs = Date.parse("2026-07-15T08:01:00.000Z");
		const result = await coordinator(async () =>
			inspect("split_brain", { candidatePids: [333, 444] }),
		).check();
		const active = store.getActiveTmuxHold(SOCKET);
		expect([...result.heldExecutionIds]).toEqual(["a"]);
		expect(active?.incidentId).toEqual(expect.any(String));
		expect(alerts).toContainEqual(
			expect.objectContaining({
				eventType: "tmux_split_brain",
				sessionKey: active?.incidentId,
			}),
		);
	});
});
