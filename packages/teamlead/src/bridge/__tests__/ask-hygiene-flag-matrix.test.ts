/**
 * FLY-1328 Chunk 4 — the reverse-compat sentinel across ASK × ZOMBIE ×
 * WATCHDOG.
 *
 * FLY-1328 puts a third capability inside a pass that already hosted two, so
 * "does the new flag change the old flags' behavior, or vice versa" is not a
 * theoretical question. Each combination below is asserted BOTH ways: what the
 * enabled capability does, and what the disabled ones must not do.
 *
 * Every negative assertion here is paired with a positive control in the same
 * test — an assertion that something did NOT happen passes just as happily when
 * the harness never wired the thing up at all (FLY-1281/1285).
 */
import { describe, expect, it, vi } from "vitest";
import type {
	ZombieCandidateQuestion,
	ZombieGateHygieneDeps,
} from "../zombie-gate-hygiene.js";
import { runZombieGateHygiene } from "../zombie-gate-hygiene.js";

const RUNNER = "11111111-2222-3333-4444-555555555555";

function agedSqliteUtc(): string {
	return new Date(Date.now() - 45 * 60_000)
		.toISOString()
		.replace("T", " ")
		.slice(0, 19);
}

const ASK: ZombieCandidateQuestion = {
	id: "q-ask",
	from_agent: RUNNER,
	checkpoint: null,
	created_at: agedSqliteUtc(),
};

/** A zombie gate in the Z1 shape: no session, no CommDB row, chronology n/a. */
const GATE: ZombieCandidateQuestion = {
	id: "q-gate",
	from_agent: RUNNER,
	checkpoint: "brainstorm",
	created_at: agedSqliteUtc(),
};

function harness(env: Record<string, string | undefined>) {
	const events: string[] = [];
	const retire = vi.fn().mockReturnValue(true);
	const deps = {
		store: {
			getSession: vi.fn().mockReturnValue(undefined),
			insertEvent: vi.fn((e) => {
				events.push(e.event_type);
				return true;
			}),
			getEventsByType: vi.fn().mockReturnValue([]),
		},
		projectName: "flywheel",
		pendingGateQuestions: [ASK, GATE],
		db: {
			getSession: vi.fn().mockReturnValue(undefined),
			retireQuestionGuarded: retire,
			retireShipGate: vi.fn().mockReturnValue(true),
			getResponse: vi.fn().mockReturnValue(undefined),
			getMessageById: vi.fn().mockReturnValue({ id: "q" }),
			isQuestionPending: vi.fn().mockReturnValue(false),
		},
		env,
	} as unknown as ZombieGateHygieneDeps;
	return { deps, events, retire };
}

describe("FLY-1328 flag matrix (ASK × ZOMBIE)", () => {
	it("ASK=0 + ZOMBIE on: the gate branch behaves exactly as it does today, the ask is untouched", async () => {
		const h = harness({ FLYWHEEL_ASK_HYGIENE: "0" });
		const result = await runZombieGateHygiene(h.deps);

		// Positive control: the zombie gate path still fires on this same input, so
		// "the ask was skipped" below means the ask branch was skipped — not that
		// the harness failed to produce a candidate at all.
		expect(result.resolved).toEqual(["q-gate"]);
		expect(h.events).toEqual([
			"founder_gate_zombie_resolve_intent",
			"founder_gate_zombie_resolved",
		]);

		expect(result.retiredAsks).toEqual([]);
		expect(h.retire.mock.calls.filter(([id]) => id === "q-ask")).toEqual([]);
		// The gate's own retire must NOT gain FLY-1328's provenance/retention.
		expect(h.retire).toHaveBeenCalledWith("q-gate", {
			expectedFromAgent: RUNNER,
			requireUnanswered: true,
		});
	});

	it("ASK on + ZOMBIE=0: the ask sweep runs; the gate branch does not even write an intent", async () => {
		const h = harness({ FLYWHEEL_ZOMBIE_GATE_RESOLVE: "0" });
		const result = await runZombieGateHygiene(h.deps);

		// Positive control: the ask branch fires, so the gate silence below is a
		// real kill-switch effect on a live pass.
		expect(result.retiredAsks).toEqual(["q-ask"]);
		expect(h.events).toEqual([
			"ask_hygiene_retire_intent",
			"ask_hygiene_retired",
		]);

		expect(result.resolved).toEqual([]);
		expect(h.retire.mock.calls.filter(([id]) => id === "q-gate")).toEqual([]);
	});

	it("both flags on: each branch handles its own candidate and neither leaks into the other", async () => {
		const h = harness({});
		const result = await runZombieGateHygiene(h.deps);

		expect(result.retiredAsks).toEqual(["q-ask"]);
		expect(result.resolved).toEqual(["q-gate"]);
		expect(h.events).toEqual([
			"ask_hygiene_retire_intent",
			"ask_hygiene_retired",
			"founder_gate_zombie_resolve_intent",
			"founder_gate_zombie_resolved",
		]);
	});

	it("both flags off: the pass writes nothing and touches no CommDB row", async () => {
		const h = harness({
			FLYWHEEL_ASK_HYGIENE: "0",
			FLYWHEEL_ZOMBIE_GATE_RESOLVE: "0",
		});
		const result = await runZombieGateHygiene(h.deps);

		expect(result).toEqual({ resolved: [], unreachable: [], retiredAsks: [] });
		expect(h.events).toEqual([]);
		expect(h.retire).not.toHaveBeenCalled();
	});
});
