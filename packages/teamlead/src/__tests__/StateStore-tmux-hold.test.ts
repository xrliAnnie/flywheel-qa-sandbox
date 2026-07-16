import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore, type TmuxHoldObservation } from "../StateStore.js";

const stores: StateStore[] = [];
const dirs: string[] = [];

async function memoryStore(): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	stores.push(store);
	return store;
}

function observation(
	reason: TmuxHoldObservation["reason"],
	overrides: Partial<TmuxHoldObservation> = {},
): TmuxHoldObservation {
	return {
		reason,
		shape: "provisional",
		shapeSource: "observation",
		evidence: { source: "test" },
		affectedExecutionIds: ["exec-1", "exec-2"],
		...overrides,
	};
}

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

describe("StateStore tmux_hold (FLY-1285)", () => {
	it("two first reports with different reasons converge on one immutable incident id", async () => {
		const store = await memoryStore();
		const socket = "/private/tmp/tmux-501/default";
		const first = store.getOrCreateActiveTmuxHold(
			socket,
			observation("saturated"),
		);
		const second = store.getOrCreateActiveTmuxHold(
			socket,
			observation("unknown"),
		);

		expect(second.incidentId).toBe(first.incidentId);
		expect(store.listActiveTmuxHolds()).toHaveLength(1);
		expect(second.firstReason).toBe("saturated");
		expect(second.currentReason).toBe("unknown");
		expect(second.reasonHistory).toEqual(["saturated", "unknown"]);
		expect(second.affectedExecutionIds.sort()).toEqual(["exec-1", "exec-2"]);
	});

	it("ack echo mismatch and resolved stale retry are rejected without mutation", async () => {
		const store = await memoryStore();
		const socket = "/private/tmp/tmux-501/default";
		const active = store.getOrCreateActiveTmuxHold(
			socket,
			observation("saturated"),
		);

		expect(() =>
			store.getOrCreateActiveTmuxHold(
				socket,
				observation("split_brain", { incidentId: "wrong-id" }),
			),
		).toThrow(/incident.*mismatch/i);
		expect(store.getActiveTmuxHold(socket)?.currentReason).toBe("saturated");

		expect(store.resolveTmuxHold(socket, active.incidentId)).toBe(true);
		expect(() =>
			store.getOrCreateActiveTmuxHold(
				socket,
				observation("unknown", { incidentId: active.incidentId }),
			),
		).toThrow(/resolved|stale/i);
		expect(store.listActiveTmuxHolds()).toHaveLength(0);

		const next = store.getOrCreateActiveTmuxHold(
			socket,
			observation("unknown"),
		);
		expect(next.incidentId).not.toBe(active.incidentId);
		expect(store.listTmuxHoldHistory(socket)).toHaveLength(2);
	});

	it("originalServerPid is immutable first-report evidence", async () => {
		const store = await memoryStore();
		const socket = "/private/tmp/tmux-501/default";
		const first = store.getOrCreateActiveTmuxHold(
			socket,
			observation("ambiguous", {
				evidence: { originalServerPid: 111, source: "supervisor_archive" },
			}),
		);
		const second = store.getOrCreateActiveTmuxHold(
			socket,
			observation("split_brain", {
				incidentId: first.incidentId,
				evidence: { originalServerPid: 999, orphanPids: [222] },
			}),
		);

		expect(second.evidence.originalServerPid).toBe(111);
		expect(second.evidence.originalServerPidSource).toBe("supervisor_archive");
		expect(second.evidence.orphanPids).toEqual([222]);
	});

	it("atomically resolves only a shaped hold while arming the same-id server-loss ledger", async () => {
		const store = await memoryStore();
		const socket = "/private/tmp/tmux-501/default";
		const active = store.getOrCreateActiveTmuxHold(
			socket,
			observation("unknown"),
		);

		expect(() =>
			store.transitionTmuxHoldToServerLossEpisode({
				normalizedSocketPath: socket,
				incidentId: active.incidentId,
				shape: "server_down",
				claimedExecutionIds: ["exec-1"],
				leadIdsByExecutionId: { "exec-1": "lead-a" },
			}),
		).toThrow(/provisional/i);
		expect(store.getServerLossEpisode()).toBeUndefined();
		expect(store.getActiveTmuxHold(socket)?.incidentId).toBe(active.incidentId);

		store.getOrCreateActiveTmuxHold(
			socket,
			observation("unknown", {
				incidentId: active.incidentId,
				shape: "server_down",
				shapeSource: "coordinator",
			}),
		);
		expect(
			store.transitionTmuxHoldToServerLossEpisode({
				normalizedSocketPath: socket,
				incidentId: active.incidentId,
				shape: "server_down",
				claimedExecutionIds: ["exec-1"],
				leadIdsByExecutionId: { "exec-1": "lead-a" },
			}),
		).toBe(true);
		expect(store.getActiveTmuxHold(socket)).toBeUndefined();
		expect(store.getServerLossEpisode()).toEqual({
			signature: active.incidentId,
			state: {
				shape: "server_down",
				claimed: ["exec-1"],
				ticketDone: false,
				notifiedLeads: [],
				failedLeads: [],
				notifyAttempts: {},
			},
		});
	});

	it("a conflicting singleton episode leaves the active hold untouched", async () => {
		const store = await memoryStore();
		const socket = "/private/tmp/tmux-501/default";
		const active = store.getOrCreateActiveTmuxHold(
			socket,
			observation("split_brain", {
				shape: "server_fresh",
				shapeSource: "coordinator",
			}),
		);
		store.setServerLossEpisode("other-incident", {
			shape: "server_down",
			claimed: ["other-exec"],
			ticketDone: false,
			notifiedLeads: [],
			failedLeads: [],
			notifyAttempts: {},
		});

		expect(
			store.transitionTmuxHoldToServerLossEpisode({
				normalizedSocketPath: socket,
				incidentId: active.incidentId,
				shape: "server_fresh",
				claimedExecutionIds: ["exec-1"],
				leadIdsByExecutionId: { "exec-1": "lead-a" },
			}),
		).toBe(false);
		expect(store.getActiveTmuxHold(socket)?.incidentId).toBe(active.incidentId);
		expect(store.getServerLossEpisode()?.signature).toBe("other-incident");
	});

	it("active hold and authoritative created_at survive a Bridge restart", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1285-hold-"));
		dirs.push(dir);
		const db = join(dir, "state.db");
		const firstStore = await StateStore.create(db);
		const active = firstStore.getOrCreateActiveTmuxHold(
			"/private/tmp/tmux-501/default",
			observation("lock_unavailable"),
		);
		firstStore.close();

		const reopened = await StateStore.create(db);
		stores.push(reopened);
		const row = reopened.getActiveTmuxHold("/private/tmp/tmux-501/default");
		expect(row?.incidentId).toBe(active.incidentId);
		expect(row?.createdAt).toBe(active.createdAt);
		expect(row?.currentReason).toBe("lock_unavailable");
	});
});
