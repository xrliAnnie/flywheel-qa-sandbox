/**
 * FLY-1328 / FLY-1807 — retained ON-path coverage after ask hygiene became
 * unconditional. The pass must keep ASK and zombie-gate handling independent
 * and preserve their event order.
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

const GATE: ZombieCandidateQuestion = {
	id: "q-gate",
	from_agent: RUNNER,
	checkpoint: "brainstorm",
	created_at: agedSqliteUtc(),
};

function harness(resolveDeadGates = true) {
	const events: string[] = [];
	const retire = vi.fn().mockReturnValue(true);
	const deps = {
		store: {
			getSession: vi.fn().mockReturnValue(undefined),
			insertEvent: vi.fn((event) => {
				events.push(event.event_type);
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
		resolveDeadGates,
	} as unknown as ZombieGateHygieneDeps;
	return { deps, events, retire };
}

describe("FLY-1328 unconditional ASK hygiene", () => {
	it("runs the ask sweep without a gate intent under production Z1 policy", async () => {
		const h = harness(false);
		const result = await runZombieGateHygiene(h.deps);

		expect(result.retiredAsks).toEqual(["q-ask"]);
		expect(result.resolved).toEqual([]);
		expect(h.events).toEqual([
			"ask_hygiene_retire_intent",
			"ask_hygiene_retired",
		]);
		expect(h.retire.mock.calls.filter(([id]) => id === "q-gate")).toEqual([]);
	});

	it("handles ASK and gate candidates independently in event order", async () => {
		const h = harness();
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
});
