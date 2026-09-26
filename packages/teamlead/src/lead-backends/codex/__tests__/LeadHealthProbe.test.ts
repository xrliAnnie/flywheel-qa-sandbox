import { describe, expect, it } from "vitest";
import {
	assessLeadHealth,
	DEFAULT_HEALTH_THRESHOLDS,
	LeadHealthProbe,
	type UnfinishedSummary,
} from "../LeadHealthProbe.js";

const NOW = 10_000_000;
const T = DEFAULT_HEALTH_THRESHOLDS;

function inputs(over: Partial<Parameters<typeof assessLeadHealth>[0]> = {}) {
	return {
		processAlive: true,
		now: NOW,
		lastActivityAt: NOW, // recently active by default
		unfinished: [] as UnfinishedSummary[],
		...over,
	};
}

describe("assessLeadHealth — definitive", () => {
	it("process dead → unhealthy", () => {
		const v = assessLeadHealth(inputs({ processAlive: false }));
		expect(v.status).toBe("unhealthy");
		expect(v.reasons).toContain("process_not_running");
	});

	it("alive + nothing in flight → healthy-idle (silence is normal, NOT an alert)", () => {
		// No in-flight turn, and even with NO recent activity, idle is healthy.
		const v = assessLeadHealth(
			inputs({ unfinished: [], lastActivityAt: NOW - 10 * 60 * 60 * 1000 }),
		);
		expect(v.status).toBe("healthy");
		expect(v.reasons).toEqual([]);
	});
});

describe("assessLeadHealth — in-flight turn (anti-false-alarm)", () => {
	it("HEALTHY-BUSY: a long in-flight turn that is still streaming (recent activity) is NOT stuck", () => {
		const v = assessLeadHealth(
			inputs({
				lastActivityAt: NOW - 1000, // app produced output 1s ago → progressing
				unfinished: [
					{ id: "e1", state: "dispatched", updatedAt: NOW - 2 * T.stuckTurnMs },
				],
			}),
		);
		expect(v.status).toBe("healthy"); // long turn but actively streaming
		expect(v.reasons).toEqual([]);
	});

	it("STUCK: in-flight turn + app-server silent past threshold + journal stale → unhealthy", () => {
		const v = assessLeadHealth(
			inputs({
				lastActivityAt: NOW - 2 * T.stuckTurnMs, // app silent
				unfinished: [
					{ id: "e1", state: "dispatched", updatedAt: NOW - 2 * T.stuckTurnMs },
				],
			}),
		);
		expect(v.status).toBe("unhealthy");
		expect(v.reasons[0]).toMatch(/turn_stuck:e1/);
	});

	it("does NOT assert stuck when no activity signal is available (can't prove silence)", () => {
		const v = assessLeadHealth({
			processAlive: true,
			now: NOW,
			lastActivityAt: undefined, // unknown
			unfinished: [
				{ id: "e1", state: "dispatched", updatedAt: NOW - 2 * T.stuckTurnMs },
			],
		});
		expect(v.status).toBe("healthy"); // conservative: don't false-alarm
	});

	it("young in-flight turn → healthy even if app briefly quiet", () => {
		const v = assessLeadHealth(
			inputs({
				lastActivityAt: NOW - 2 * T.stuckTurnMs,
				unfinished: [{ id: "e1", state: "dispatching", updatedAt: NOW - 1000 }], // just started
			}),
		);
		expect(v.status).toBe("healthy");
	});
});

describe("assessLeadHealth — delivery wedged", () => {
	it("a stalled output_pending row → degraded (independent of app activity)", () => {
		const v = assessLeadHealth(
			inputs({
				lastActivityAt: NOW, // app fine
				unfinished: [
					{
						id: "e2",
						state: "output_pending",
						updatedAt: NOW - 2 * T.stuckDeliveryMs,
					},
				],
			}),
		);
		expect(v.status).toBe("degraded");
		expect(v.reasons[0]).toMatch(/delivery_stuck:e2/);
	});

	it("unhealthy (stuck turn) outranks degraded (stuck delivery)", () => {
		const v = assessLeadHealth(
			inputs({
				lastActivityAt: NOW - 2 * T.stuckTurnMs,
				unfinished: [
					{ id: "e1", state: "dispatched", updatedAt: NOW - 2 * T.stuckTurnMs },
					{
						id: "e2",
						state: "output_pending",
						updatedAt: NOW - 2 * T.stuckDeliveryMs,
					},
				],
			}),
		);
		expect(v.status).toBe("unhealthy");
		expect(v.reasons.length).toBe(2);
	});
});

describe("LeadHealthProbe — gathers live signals", () => {
	it("wires processAlive + lastActivityAt + journal into the assessment", () => {
		const probe = new LeadHealthProbe({
			processAlive: () => true,
			lastActivityAt: () => NOW - 1000,
			journal: {
				listUnfinished: () => [
					{ id: "e1", state: "dispatched", updatedAt: NOW - 2 * T.stuckTurnMs },
				],
			},
			now: () => NOW,
		});
		// streaming → healthy-busy
		expect(probe.probe().status).toBe("healthy");
	});

	it("reports unhealthy when the process is gone", () => {
		const probe = new LeadHealthProbe({
			processAlive: () => false,
			lastActivityAt: () => NOW,
			journal: { listUnfinished: () => [] },
			now: () => NOW,
		});
		expect(probe.probe().status).toBe("unhealthy");
	});
});
