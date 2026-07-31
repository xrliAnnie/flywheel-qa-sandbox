import { describe, expect, it } from "vitest";
import {
	type BellCycleIo,
	type BellCycleState,
	initialBellState,
	runBellCycle,
} from "../bell.js";

function io(overrides: Partial<BellCycleIo> = {}): {
	io: BellCycleIo;
	events: string[];
} {
	const events: string[] = [];
	return {
		events,
		io: {
			peekMaxPendingSeq: async () => 10,
			notify: async () => {
				events.push("notify");
			},
			touchLease: () => {
				events.push("touch");
			},
			failStop: (reason) => {
				events.push(`failstop:${reason}`);
			},
			log: () => {},
			maxConsecutiveFailures: 5,
			...overrides,
		},
	};
}

describe("bell cycle (R3-F3)", () => {
	it("touches the lease only AFTER a required ring succeeded", async () => {
		const state = initialBellState();
		const { io: cycleIo, events } = io();
		await runBellCycle(state, cycleIo);
		expect(events).toEqual(["notify", "touch"]);
		expect(state.lastBelledSeq).toBe(10);
	});

	it("notification-only failures climb to fail-stop and never touch the lease", async () => {
		const state = initialBellState();
		const { io: cycleIo, events } = io({
			notify: async () => {
				throw new Error("channel rejected");
			},
		});
		for (let i = 0; i < 5; i++) await runBellCycle(state, cycleIo);
		expect(events.filter((e) => e === "touch")).toHaveLength(0);
		expect(state.consecutiveFailures).toBe(5);
		expect(events.some((e) => e.startsWith("failstop:"))).toBe(true);
	});

	it("a quiet cycle (nothing to ring) is healthy without notifying", async () => {
		const state: BellCycleState = {
			lastBelledSeq: 10,
			consecutiveFailures: 3,
			running: false,
		};
		const { io: cycleIo, events } = io();
		await runBellCycle(state, cycleIo);
		expect(events).toEqual(["touch"]);
		expect(state.consecutiveFailures).toBe(0);
	});

	it("never overlaps cycles (in-flight guard)", async () => {
		const state = initialBellState();
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered = 0;
		const { io: cycleIo } = io({
			peekMaxPendingSeq: async () => {
				entered += 1;
				await gate;
				return null;
			},
		});
		const first = runBellCycle(state, cycleIo);
		const second = runBellCycle(state, cycleIo);
		await second; // returns immediately — guard held by first
		expect(entered).toBe(1);
		release();
		await first;
	});

	it("status failures also climb the same counter", async () => {
		const state = initialBellState();
		const { io: cycleIo } = io({
			peekMaxPendingSeq: async () => {
				throw new Error("socket down");
			},
		});
		await runBellCycle(state, cycleIo);
		await runBellCycle(state, cycleIo);
		expect(state.consecutiveFailures).toBe(2);
	});
});
