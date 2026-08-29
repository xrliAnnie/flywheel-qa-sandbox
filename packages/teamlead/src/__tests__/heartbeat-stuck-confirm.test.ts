/**
 * FLY-1234 (T2): HeartbeatService checkStuck confirm-layer integration.
 *
 * Covers the plan's named scenarios: tri-state holder semantics + arity
 * sentinel (INV-5), starvation regression (INV-2), re-entrancy guard (R1 #2),
 * post-await freshness re-read + cheap-gate replay (INV-3 / R2 #7), suppress
 * leaves no dedup, and exactly-once under a slow confirm.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CONFIRM_NOTES,
	type StuckConfirmResult,
} from "../bridge/stuck-pane-confirm.js";
import { HeartbeatService } from "../HeartbeatService.js";
import type { Session } from "../StateStore.js";

function makeSession(id: string, over: Partial<Session> = {}): Session {
	return {
		execution_id: id,
		issue_id: "FLY-1234",
		issue_identifier: "FLY-1234",
		project_name: "flywheel",
		status: "running",
		last_activity_at: "2026-07-13 18:00:00",
		...over,
	} as Session;
}

function makeStore(stuck: Session[]) {
	const notified = new Set<string>();
	const key = (e: string, s: string, f: string) => `${e}|${s}|${f}`;
	const sessions = new Map(stuck.map((s) => [s.execution_id, s]));
	return {
		getStuckSessions: vi.fn(() => stuck),
		getOrphanSessions: vi.fn(() => []),
		getStaleCompletedSessions: vi.fn(() => []),
		getAwaitingReviewTimedOut: vi.fn(() => []),
		getSession: vi.fn((id: string) => sessions.get(id)),
		_sessions: sessions,
		forceStatus: vi.fn(),
		_notified: notified,
		hasQuietWakeNotified: vi.fn((e: string, s: string, f: string) =>
			notified.has(key(e, s, f)),
		),
		recordQuietWakeNotified: vi.fn((e: string, s: string, f: string) => {
			notified.add(key(e, s, f));
		}),
		clearQuietWakeNotified: vi.fn(),
		pruneQuietWakeNotifiedNotIn: vi.fn(),
	};
}

function makeNotifier(persisted = true) {
	return {
		onSessionStuck: vi.fn(async () => persisted),
		onSessionOrphaned: vi.fn(async () => {}),
		onSessionStale: vi.fn(async () => {}),
		onSessionMonitoringLost: vi.fn(async () => {}),
		onSessionMonitoringReestablished: vi.fn(async () => {}),
	};
}

type Holder = {
	current: ((s: Session) => Promise<StuckConfirmResult>) | null;
};

function build(
	stuck: Session[],
	holder?: Holder,
	deps?: {
		store?: ReturnType<typeof makeStore>;
		notifier?: ReturnType<typeof makeNotifier>;
	},
) {
	const store = deps?.store ?? makeStore(stuck);
	const notifier = deps?.notifier ?? makeNotifier();
	const service = new HeartbeatService(
		store as unknown as ConstructorParameters<typeof HeartbeatService>[0],
		notifier as unknown as ConstructorParameters<typeof HeartbeatService>[1],
		15,
		300_000,
		60,
		undefined,
		24,
		6 * 3_600_000,
		undefined,
		48,
		undefined, // no quiet probe (isStuckWakeSuppressed → false)
		undefined,
		undefined,
		undefined,
		undefined,
		undefined, // onMaintenanceTick (FLY-1185)
		holder, // FLY-1234 confirm holder
	);
	return { service, store, notifier };
}

const ENV_KEYS = [
	"FLYWHEEL_STUCK_PANE_CONFIRM",
	"FLYWHEEL_STUCK_CONFIRM_PER_TICK",
	"FLYWHEEL_STUCK_FRAME_GAP_MS",
	"FLYWHEEL_STUCK_CONFIRM_DEADLINE_MS",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const k of ENV_KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
});
afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	vi.restoreAllMocks();
});

describe("FLY-1234 confirm layer — tri-state holder + arity sentinel (INV-5)", () => {
	it("holder undefined → legacy two-arg call, no confirm logs, no getSession", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { service, notifier, store } = build([makeSession("exec-legacy")]);
		await service.check();
		expect(notifier.onSessionStuck).toHaveBeenCalledTimes(1);
		// EXACT legacy arity: two arguments, no details object.
		expect(notifier.onSessionStuck.mock.calls[0]).toHaveLength(2);
		expect(store.getSession).not.toHaveBeenCalled();
		const confirmLogs = [...logSpy.mock.calls, ...warnSpy.mock.calls].filter(
			(c) => String(c[0]).includes("FLY-1234"),
		);
		expect(confirmLogs).toHaveLength(0);
	});

	it("kill-switch FLYWHEEL_STUCK_PANE_CONFIRM=0 → legacy two-arg even with a bound holder (sentinel)", async () => {
		process.env.FLYWHEEL_STUCK_PANE_CONFIRM = "0";
		const confirm = vi.fn();
		const { service, notifier } = build([makeSession("exec-killswitch")], {
			current: confirm as never,
		});
		await service.check();
		expect(confirm).not.toHaveBeenCalled();
		expect(notifier.onSessionStuck).toHaveBeenCalledTimes(1);
		expect(notifier.onSessionStuck.mock.calls[0]).toHaveLength(2);
	});

	it("holder.current === null → fail-open three-arg emit with confirm_unbound + warn", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { service, notifier } = build([makeSession("exec-unbound")], {
			current: null,
		});
		await service.check();
		expect(notifier.onSessionStuck).toHaveBeenCalledTimes(1);
		expect(notifier.onSessionStuck).toHaveBeenCalledWith(
			expect.objectContaining({ execution_id: "exec-unbound" }),
			expect.any(Number),
			{ confirmNote: CONFIRM_NOTES.confirm_unbound },
		);
		expect(
			warnSpy.mock.calls.some((c) => String(c[0]).includes("UNBOUND")),
		).toBe(true);
	});

	it("bound holder emit → three-arg with the confirm reason's note", async () => {
		const { service, notifier } = build([makeSession("exec-dead")], {
			current: async () => ({
				action: "emit",
				reason: "dead_pin",
				confirmNote: CONFIRM_NOTES.dead_pin,
			}),
		});
		await service.check();
		expect(notifier.onSessionStuck).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(Number),
			{ confirmNote: CONFIRM_NOTES.dead_pin },
		);
	});
});

describe("FLY-1234 confirm layer — suppress semantics", () => {
	it("suppress → no notifier call AND no dedup (re-evaluated next tick)", async () => {
		const { service, notifier, store } = build([makeSession("exec-working")], {
			current: async () => ({ action: "suppress", reason: "frames_changing" }),
		});
		await service.check();
		expect(notifier.onSessionStuck).not.toHaveBeenCalled();
		expect(store.recordQuietWakeNotified).not.toHaveBeenCalled();
		// Next tick re-evaluates: a now-dead runner emits immediately.
		const holder: Holder = {
			current: async () => ({
				action: "emit",
				reason: "dead_pin",
				confirmNote: CONFIRM_NOTES.dead_pin,
			}),
		};
		const second = build([makeSession("exec-working")], holder, {
			store,
			notifier,
		});
		await second.service.check();
		expect(notifier.onSessionStuck).toHaveBeenCalledTimes(1);
	});
});

describe("FLY-1234 confirm layer — starvation regression (INV-2)", () => {
	it("5 candidates, budget 3: beyond-budget candidates LEGACY-EMIT immediately with the budget annotation", async () => {
		const sessions = ["s1", "s2", "s3", "s4", "s5"].map((id) =>
			makeSession(id),
		);
		const probed: string[] = [];
		const { service, notifier } = build(sessions, {
			current: async (s) => {
				probed.push(s.execution_id);
				return { action: "suppress", reason: "judge_a_working" };
			},
		});
		await service.check();
		// First 3 consumed the budget and were suppressed; 4 and 5 must NOT be
		// deferred — they emit NOW with the budget annotation (the assertion is
		// the annotation, not dead_pin: beyond-budget sessions are unprobed).
		expect(probed).toEqual(["s1", "s2", "s3"]);
		expect(notifier.onSessionStuck).toHaveBeenCalledTimes(2);
		for (const call of notifier.onSessionStuck.mock.calls) {
			expect(call[2]).toEqual({
				confirmNote: CONFIRM_NOTES.confirm_budget_exhausted,
			});
			expect(["s4", "s5"]).toContain((call[0] as Session).execution_id);
		}
	});

	it("budget knob is read from env per tick (bounded)", async () => {
		process.env.FLYWHEEL_STUCK_CONFIRM_PER_TICK = "1";
		const probed: string[] = [];
		const { service, notifier } = build([makeSession("a"), makeSession("b")], {
			current: async (s) => {
				probed.push(s.execution_id);
				return { action: "suppress", reason: "judge_a_working" };
			},
		});
		await service.check();
		expect(probed).toEqual(["a"]);
		expect(notifier.onSessionStuck).toHaveBeenCalledTimes(1);
		expect(notifier.onSessionStuck.mock.calls[0]![2]).toEqual({
			confirmNote: CONFIRM_NOTES.confirm_budget_exhausted,
		});
	});
});

describe("FLY-1234 confirm layer — re-entrancy guard (R1 #2)", () => {
	it("kill-switch=0: overlap is NOT guarded — legacy timing preserved (INV-5, Codex R1 #2)", async () => {
		process.env.FLYWHEEL_STUCK_PANE_CONFIRM = "0";
		let notifierCalls = 0;
		let releaseFirst: (() => void) | undefined;
		const notifier = makeNotifier();
		notifier.onSessionStuck = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					notifierCalls += 1;
					if (notifierCalls === 1) {
						releaseFirst = () => resolve(false);
					} else {
						resolve(false);
					}
				}),
		);
		const store = makeStore([makeSession("exec-legacy-overlap")]);
		const confirm = vi.fn();
		const { service } = build(
			[makeSession("exec-legacy-overlap")],
			{ current: confirm as never },
			{ store, notifier },
		);
		const first = service.check();
		await new Promise((r) => setTimeout(r, 0)); // first tick now awaits notifier
		const second = service.check(); // legacy path: must RE-ENTER, not skip
		await new Promise((r) => setTimeout(r, 0));
		expect(notifierCalls).toBe(2);
		expect(confirm).not.toHaveBeenCalled();
		releaseFirst?.();
		await Promise.all([first, second]);
	});

	it("overlapping check() → the second tick skips checkStuck entirely", async () => {
		let resolveConfirm: (() => void) | undefined;
		const confirm = vi.fn(
			() =>
				new Promise<StuckConfirmResult>((resolve) => {
					resolveConfirm = () =>
						resolve({ action: "suppress", reason: "judge_a_working" });
				}),
		);
		const { service } = build([makeSession("exec-slow")], {
			current: confirm,
		});
		const first = service.check();
		await new Promise((r) => setTimeout(r, 0)); // first tick is now awaiting confirm
		const second = service.check(); // overlaps
		await second;
		expect(confirm).toHaveBeenCalledTimes(1); // second tick did not re-enter
		resolveConfirm?.();
		await first;
	});
});

describe("FLY-1234 confirm layer — post-await freshness (INV-3 / R2 #7)", () => {
	it("last_activity_at refreshed during the confirm await → zero notify, zero dedup", async () => {
		const store = makeStore([makeSession("exec-recovers")]);
		const notifier = makeNotifier();
		const { service } = build(
			[makeSession("exec-recovers")],
			{
				current: async () => {
					// The runner sends an event mid-confirm: the fresh row moves.
					store._sessions.set(
						"exec-recovers",
						makeSession("exec-recovers", {
							last_activity_at: "2026-07-13 19:59:00",
						}),
					);
					return {
						action: "emit",
						reason: "judge_unavailable",
						confirmNote: CONFIRM_NOTES.judge_unavailable,
					};
				},
			},
			{ store, notifier },
		);
		await service.check();
		expect(notifier.onSessionStuck).not.toHaveBeenCalled();
		expect(store.recordQuietWakeNotified).not.toHaveBeenCalled();
	});

	it("session left running (terminal) during the await → zero notify", async () => {
		const store = makeStore([makeSession("exec-completes")]);
		const notifier = makeNotifier();
		const { service } = build(
			[makeSession("exec-completes")],
			{
				current: async () => {
					store._sessions.set(
						"exec-completes",
						makeSession("exec-completes", { status: "completed" }),
					);
					return {
						action: "emit",
						reason: "dead_pin",
						confirmNote: CONFIRM_NOTES.dead_pin,
					};
				},
			},
			{ store, notifier },
		);
		await service.check();
		expect(notifier.onSessionStuck).not.toHaveBeenCalled();
	});

	it("another path deduped the episode during the await → gate replay drops it (no double notify)", async () => {
		const store = makeStore([makeSession("exec-deduped")]);
		const notifier = makeNotifier();
		const { service } = build(
			[makeSession("exec-deduped")],
			{
				current: async () => {
					// A concurrent path records the durable dedup mid-confirm.
					store.recordQuietWakeNotified("exec-deduped", "stuck", "stuck");
					store.recordQuietWakeNotified.mockClear();
					return {
						action: "emit",
						reason: "judge_suspicious",
						confirmNote: CONFIRM_NOTES.judge_suspicious,
					};
				},
			},
			{ store, notifier },
		);
		await service.check();
		expect(notifier.onSessionStuck).not.toHaveBeenCalled();
		expect(store.recordQuietWakeNotified).not.toHaveBeenCalled();
	});

	it("holder throwing (contract breach) → fail-open emit with confirm_error, never a swallow", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { service, notifier } = build([makeSession("exec-throws")], {
			current: async () => {
				throw new Error("holder bug");
			},
		});
		await service.check();
		expect(notifier.onSessionStuck).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(Number),
			{ confirmNote: CONFIRM_NOTES.confirm_error },
		);
	});
});

describe("FLY-1234 confirm layer — exactly-once emission", () => {
	it("confirmed emit dedups once; the next tick does not re-notify the same episode", async () => {
		const store = makeStore([makeSession("exec-once")]);
		const notifier = makeNotifier(true);
		const holder: Holder = {
			current: async () => ({
				action: "emit",
				reason: "frames_static_judge_c_stuck",
				confirmNote: CONFIRM_NOTES.frames_static_judge_c_stuck,
			}),
		};
		const { service } = build([makeSession("exec-once")], holder, {
			store,
			notifier,
		});
		await service.check();
		await service.check();
		expect(notifier.onSessionStuck).toHaveBeenCalledTimes(1);
		expect(store.recordQuietWakeNotified).toHaveBeenCalledTimes(1);
	});
});
