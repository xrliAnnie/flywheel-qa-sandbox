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
	raceMarkIssueDoneWithAbort,
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
	// FLY-1185 (Codex R2#9): the finalizer now fail-closes on an unreadable
	// state and double-reads before the write — happy fixtures carry a stable
	// nonterminal state.
	const issue = {
		team: Promise.resolve(team),
		state: Promise.resolve({
			id: "s-started",
			name: "Started",
			type: "started",
		}),
	};
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
				state: Promise.resolve({
					id: "s-cur",
					name: "Started",
					type: "started",
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
				state: Promise.resolve({
					id: "s-cur",
					name: "Started",
					type: "started",
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
	it("default-ON with an api key → returns a closure", () => {
		expect(makeLinearDoneFinalizer({ linearApiKey: "k" })).toBeInstanceOf(
			Function,
		);
	});

	it("no api key → undefined (no client, no-op)", () => {
		expect(makeLinearDoneFinalizer({})).toBeUndefined();
	});
});

describe("FLY-1185 Codex R2#9 — fail-closed + double-read", () => {
	it("unreadable state → done:false (fail-closed, zero write)", async () => {
		const client = fakeClient();
		(client.issue as ReturnType<typeof vi.fn>).mockResolvedValue({
			team: Promise.resolve({
				states: vi.fn().mockResolvedValue({ nodes: [] }),
			}),
			// no `state` field at all → unreadable
		});
		const r = await markLinearIssueDone(client as never, "ISSUE-1");
		expect(r.done).toBe(false);
		expect(r.reason).toBe("state_unreadable_fail_closed");
		expect(client.updateIssue).not.toHaveBeenCalled();
	});

	it("canceled state → never overwritten to Done", async () => {
		const client = fakeClient();
		(client.issue as ReturnType<typeof vi.fn>).mockResolvedValue({
			team: Promise.resolve({
				states: vi.fn().mockResolvedValue({ nodes: [] }),
			}),
			state: Promise.resolve({ id: "s-x", name: "Canceled", type: "canceled" }),
		});
		const r = await markLinearIssueDone(client as never, "ISSUE-1");
		expect(r.done).toBe(false);
		expect(r.reason).toBe("issue_canceled_never_overwritten");
		expect(client.updateIssue).not.toHaveBeenCalled();
	});

	it("first read started → second read canceled → zero write (TOCTOU guard)", async () => {
		const client = fakeClient();
		let reads = 0;
		(client.issue as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
			team: Promise.resolve({
				states: vi.fn().mockResolvedValue({
					nodes: [{ id: "s-done", name: "Done", type: "completed" }],
				}),
			}),
			get state() {
				reads++;
				return Promise.resolve(
					reads <= 1
						? { id: "s-started", name: "Started", type: "started" }
						: { id: "s-x", name: "Canceled", type: "canceled" },
				);
			},
		}));
		const r = await markLinearIssueDone(client as never, "ISSUE-1");
		expect(r.done).toBe(false);
		expect(r.reason).toBe("issue_canceled_never_overwritten");
		expect(client.updateIssue).not.toHaveBeenCalled();
	});
});

describe("bounded Linear Done finalization", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns after the deadline when the SDK promise never settles", async () => {
		vi.useFakeTimers();
		let observedSignal: AbortSignal | undefined;
		const finalizer = vi.fn(
			async (_issueId: string, _identifier?: string, signal?: AbortSignal) => {
				observedSignal = signal;
				return new Promise<never>(() => undefined);
			},
		);

		const result = raceMarkIssueDoneWithAbort(
			finalizer,
			"ISSUE-1",
			"FLY-1",
			15_000,
		);
		await vi.advanceTimersByTimeAsync(15_000);

		await expect(result).resolves.toEqual({
			done: false,
			reason: "linear_done_timeout",
		});
		expect(observedSignal?.aborted).toBe(true);
	});

	it("reports timeout and rejection observers without changing the bounded result", async () => {
		vi.useFakeTimers();
		const onTimeout = vi.fn();
		const timeoutResult = raceMarkIssueDoneWithAbort(
			vi.fn(async () => new Promise<never>(() => undefined)),
			"ISSUE-timeout",
			undefined,
			10,
			{ onTimeout, timeoutReason: "mark_issue_done_timeout" },
		);
		await vi.advanceTimersByTimeAsync(10);
		await expect(timeoutResult).resolves.toEqual({
			done: false,
			reason: "mark_issue_done_timeout",
		});
		expect(onTimeout).toHaveBeenCalledWith(10);

		const onRejected = vi.fn();
		await expect(
			raceMarkIssueDoneWithAbort(
				vi.fn().mockRejectedValue(new Error("linear down")),
				"ISSUE-reject",
				undefined,
				10,
				{ onRejected },
			),
		).resolves.toEqual({ done: false, reason: "linear down" });
		expect(onRejected).toHaveBeenCalledWith(expect.any(Error));
	});

	it("aborts before mutation when a delayed read recovers after timeout", async () => {
		vi.useFakeTimers();
		let resolveIssue:
			| ((
					value: Awaited<ReturnType<ReturnType<typeof fakeClient>["issue"]>>,
			  ) => void)
			| undefined;
		const delayedIssue = new Promise<
			Awaited<ReturnType<ReturnType<typeof fakeClient>["issue"]>>
		>((resolve) => {
			resolveIssue = resolve;
		});
		const client = fakeClient({
			issue: vi.fn().mockReturnValue(delayedIssue),
		});
		const result = raceMarkIssueDoneWithAbort(
			(issueId, _identifier, signal) =>
				markLinearIssueDone(client as never, issueId, signal),
			"ISSUE-1",
			undefined,
			15_000,
		);

		await vi.advanceTimersByTimeAsync(15_000);
		await expect(result).resolves.toEqual({
			done: false,
			reason: "linear_done_timeout",
		});
		resolveIssue?.({
			team: Promise.resolve({
				states: vi.fn().mockResolvedValue({ nodes: [] }),
			}),
			state: Promise.resolve({
				id: "s-started",
				name: "Started",
				type: "started",
			}),
		});
		await vi.runAllTimersAsync();
		await Promise.resolve();

		expect(client.updateIssue).not.toHaveBeenCalled();
	});
});
