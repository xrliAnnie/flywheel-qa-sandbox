import { describe, expect, it } from "vitest";
import { collectStartedEpisodes, isIntakeEpic } from "../epic-intake.js";

const at = (second: number) =>
	new Date(Date.UTC(2026, 8, 14, 20, 0, second)).toISOString();
const span = (id: string, type: string, start: number, end: number | null) => ({
	id,
	stateId: `state-${type}`,
	state: { type },
	startedAt: at(start),
	endedAt: end === null ? null : at(end),
});

describe("Epic intake state identity", () => {
	it("keeps both rapid entries and deduplicates repeated, unordered history", () => {
		const spans = [
			span("a", "backlog", 0, 10),
			span("b", "started", 10, 20),
			span("c", "backlog", 20, 25),
			span("d", "started", 25, null),
		];
		expect(
			collectStartedEpisodes("issue-uuid", [spans[3], ...spans].reverse()),
		).toEqual([
			{
				eventUid: `epic_intake:issue-uuid:${at(10)}`,
				startedAt: at(10),
				endedAt: at(20),
				sourceSpanIds: ["b"],
				active: false,
			},
			{
				eventUid: `epic_intake:issue-uuid:${at(25)}`,
				startedAt: at(25),
				endedAt: null,
				sourceSpanIds: ["d"],
				active: true,
			},
		]);
	});
	it("merges adjacent started substates using the first source timestamp", () => {
		expect(
			collectStartedEpisodes("uuid", [
				span("a", "started", 0, 10),
				{
					...span("b", "started", 10, null),
					stateId: "different-started-state",
				},
			]),
		).toEqual([
			{
				eventUid: `epic_intake:uuid:${at(0)}`,
				startedAt: at(0),
				endedAt: null,
				sourceSpanIds: ["a", "b"],
				active: true,
			},
		]);
	});
	it("does not produce an episode for a directly completed or canceled issue", () => {
		for (const type of ["completed", "canceled"])
			expect(
				collectStartedEpisodes("uuid", [span("a", type, 0, null)]),
			).toEqual([]);
	});
	it.each([
		[span("a", "started", 0, 20), span("b", "backlog", 10, null)],
		[span("a", "started", 0, null), span("b", "started", 10, null)],
		[span("a", "started", 0, 10), span("b", "started", 20, null)],
		[span("a", "started", 0, 10), span("a", "started", 0, null)],
		[{ ...span("a", "started", 0, null), state: null }],
		[{ ...span("a", "started", 0, null), startedAt: "invalid" }],
		[span("a", "started", 20, 10)],
	])("rejects contradictory or incomplete history %#", (...history) => {
		expect(() => collectStartedEpisodes("uuid", history)).toThrow();
	});
});

describe("approved Epic admission", () => {
	it("requires the root, department, started boundary and children or no dispatch", () => {
		const root = {
			hasParent: false,
			departmentMatches: true,
			stateType: "started",
			hasChildIssues: false,
			hasProjectDispatch: false,
		};
		expect(isIntakeEpic(root)).toBe(true);
		expect(isIntakeEpic({ ...root, hasProjectDispatch: true })).toBe(false);
		expect(
			isIntakeEpic({ ...root, hasProjectDispatch: true, hasChildIssues: true }),
		).toBe(true);
		for (const override of [
			{ hasParent: true },
			{ departmentMatches: false },
			{ stateType: "completed" },
			{ hasChildIssues: null },
			{ hasProjectDispatch: null },
		]) {
			expect(isIntakeEpic({ ...root, ...override })).toBe(false);
		}
	});
});
