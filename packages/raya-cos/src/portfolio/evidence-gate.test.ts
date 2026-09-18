import { describe, expect, it } from "vitest";
import type { Goal } from "../contracts/goals.js";
import { PatrolEvidenceGate } from "./evidence-gate.js";
import type { PortfolioSnapshot } from "./types.js";

const goal: Goal = {
	id: "g-20260906-01",
	operationId: "1414000000000000000:record:0",
	recordedAt: "2026-09-06T10:00:00Z",
	sourceUrl: "https://discord.com/channels/1/2/1414000000000000000",
	status: "active",
	text: "留住对话",
};

function snapshot(
	overrides: Partial<PortfolioSnapshot> = {},
): PortfolioSnapshot {
	return {
		v: 1,
		snapshotId: "snapshot-1",
		seq: 1,
		sampledAt: "2026-09-06T11:30:00Z",
		trigger: "patrol",
		projects: [],
		activityAvailable: true,
		all: { git: "ok", gh: "ok", linear: "unavailable" },
		...overrides,
	};
}

describe("PatrolEvidenceGate", () => {
	it.each([
		["goals_corrupt", new Error("goals_corrupt"), snapshot()],
		["no_active_goal", [], snapshot()],
		["no_activity_readings", [goal], snapshot({ activityAvailable: false })],
		["stale_snapshot", [goal], snapshot({ sampledAt: "2026-09-06T09:00:00Z" })],
	])("skips %s", (reason, goals, reading) => {
		expect(
			PatrolEvidenceGate.check({
				snapshot: reading,
				goals: goals as Goal[] | Error,
				now: new Date("2026-09-06T12:00:00Z"),
				staleAfterMs: 3_600_000,
			}),
		).toEqual({ proceed: false, reason });
	});

	it("returns only active goals when evidence is fresh", () => {
		expect(
			PatrolEvidenceGate.check({
				snapshot: snapshot(),
				goals: [goal, { ...goal, id: "g-20260906-02", status: "withdrawn" }],
				now: new Date("2026-09-06T12:00:00Z"),
				staleAfterMs: 3_600_000,
			}),
		).toEqual({ proceed: true, activeGoals: [goal] });
	});
});
