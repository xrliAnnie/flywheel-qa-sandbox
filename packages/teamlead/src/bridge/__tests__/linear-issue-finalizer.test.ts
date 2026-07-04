/**
 * FLY-799 Part C (auto-Linear-Done-on-ship) — RED first.
 *
 * The genuine "auto 收尾" gap (Tadashi): after a runner self-ships (PR merged),
 * the Linear issue should flip to Done automatically. Gated on ship-success —
 * markLinearIssueDone is only ever called from runPostShipFinalization, which
 * runs solely on confirmed merge evidence. Resolves the team's completed-type
 * ("Done") workflow state; best-effort, never throws.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	makeLinearDoneFinalizer,
	markLinearIssueDone,
} from "../linear-issue-finalizer.js";

function fakeClient(over: Record<string, unknown> = {}) {
	const states = {
		nodes: [
			{ id: "s-backlog", name: "Backlog", type: "backlog" },
			{ id: "s-started", name: "In Progress", type: "started" },
			{ id: "s-done", name: "Done", type: "completed" },
			{ id: "s-canceled", name: "Canceled", type: "canceled" },
		],
	};
	const team = { states: vi.fn().mockResolvedValue(states) };
	const issue = { team: Promise.resolve(team) };
	return {
		issue: vi.fn().mockResolvedValue(issue),
		updateIssue: vi.fn().mockResolvedValue({ success: true }),
		...over,
	};
}

describe("markLinearIssueDone", () => {
	it("resolves the completed-type state and updates the issue's stateId", async () => {
		const client = fakeClient();
		const r = await markLinearIssueDone(client as never, "ISSUE-1");
		expect(r.done).toBe(true);
		expect(client.updateIssue).toHaveBeenCalledWith("ISSUE-1", {
			stateId: "s-done",
		});
	});

	it("prefers type=completed over a name match", async () => {
		const client = fakeClient({
			issue: vi.fn().mockResolvedValue({
				team: Promise.resolve({
					states: vi.fn().mockResolvedValue({
						nodes: [
							{ id: "s-x", name: "Done-ish", type: "started" },
							{ id: "s-complete", name: "Shipped", type: "completed" },
						],
					}),
				}),
			}),
		});
		const r = await markLinearIssueDone(client as never, "ISSUE-1");
		expect(r.done).toBe(true);
		expect(client.updateIssue).toHaveBeenCalledWith("ISSUE-1", {
			stateId: "s-complete",
		});
	});

	it("falls back to a name match when no completed-type state exists", async () => {
		const client = fakeClient({
			issue: vi.fn().mockResolvedValue({
				team: Promise.resolve({
					states: vi.fn().mockResolvedValue({
						nodes: [
							{ id: "s-a", name: "Todo", type: "unstarted" },
							{ id: "s-done", name: "Done", type: "started" },
						],
					}),
				}),
			}),
		});
		const r = await markLinearIssueDone(client as never, "ISSUE-1");
		expect(r.done).toBe(true);
		expect(client.updateIssue).toHaveBeenCalledWith("ISSUE-1", {
			stateId: "s-done",
		});
	});

	it("no resolvable Done state → done:false, no update", async () => {
		const client = fakeClient({
			issue: vi.fn().mockResolvedValue({
				team: Promise.resolve({
					states: vi.fn().mockResolvedValue({
						nodes: [{ id: "s-a", name: "Todo", type: "unstarted" }],
					}),
				}),
			}),
		});
		const r = await markLinearIssueDone(client as never, "ISSUE-1");
		expect(r.done).toBe(false);
		expect(client.updateIssue).not.toHaveBeenCalled();
	});

	it("no team on the issue → done:false, never throws", async () => {
		const client = fakeClient({
			issue: vi.fn().mockResolvedValue({ team: Promise.resolve(undefined) }),
		});
		const r = await markLinearIssueDone(client as never, "ISSUE-1");
		expect(r.done).toBe(false);
		expect(client.updateIssue).not.toHaveBeenCalled();
	});

	it("a thrown SDK error is swallowed → done:false (never throws)", async () => {
		const client = fakeClient({
			issue: vi.fn().mockRejectedValue(new Error("network")),
		});
		const r = await markLinearIssueDone(client as never, "ISSUE-1");
		expect(r.done).toBe(false);
		expect(r.reason).toBeTruthy();
	});
});

describe("makeLinearDoneFinalizer — gating", () => {
	afterEach(() => {
		delete process.env.FLYWHEEL_AUTO_LINEAR_DONE;
	});

	it("default-ON with an api key → returns a closure", () => {
		expect(makeLinearDoneFinalizer({ linearApiKey: "k" })).toBeInstanceOf(
			Function,
		);
	});

	it("kill-switch FLYWHEEL_AUTO_LINEAR_DONE=0 → undefined (byte-compat skip)", () => {
		process.env.FLYWHEEL_AUTO_LINEAR_DONE = "0";
		expect(makeLinearDoneFinalizer({ linearApiKey: "k" })).toBeUndefined();
	});

	it("no api key → undefined (no client, no-op)", () => {
		expect(makeLinearDoneFinalizer({})).toBeUndefined();
	});
});
