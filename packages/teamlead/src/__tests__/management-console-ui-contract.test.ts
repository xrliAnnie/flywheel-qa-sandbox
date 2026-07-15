import { describe, expect, it } from "vitest";
import { MANAGEMENT_CONSOLE_STATE_JS } from "../bridge/fleet-console-html.js";

type PureUi = {
	scheduleLabel(days: number[]): string;
	toggleScheduleDay(days: number[], day: number): number[];
	normalizeTimes(times: Array<{ hour: number; minute: number }>): Array<{
		hour: number;
		minute: number;
	}>;
	isValidTime(hour: number, minute: number): boolean;
	updateDraft(
		drafts: Record<string, unknown>,
		targetId: string,
		desiredValue: unknown,
		currentValue: unknown,
		observedRevision: string,
	): void;
};

function pureUi(): PureUi {
	return Function(
		`${MANAGEMENT_CONSOLE_STATE_JS};return {scheduleLabel:scheduleLabel,toggleScheduleDay:toggleScheduleDay,normalizeTimes:normalizeTimes,isValidTime:isValidTime,updateDraft:updateDraft};`,
	)() as PureUi;
}

describe("management console pure interaction contract", () => {
	const ui = pureUi();

	it("derives the four weekly labels and never allows zero selected days", () => {
		expect(ui.scheduleLabel([1, 2, 3, 4, 5, 6, 7])).toBe("每日");
		expect(ui.scheduleLabel([1, 2, 3, 4, 5])).toBe("工作日");
		expect(ui.scheduleLabel([6, 7])).toBe("周末");
		expect(ui.scheduleLabel([1, 3])).toBe("自定义");
		expect(ui.toggleScheduleDay([1], 1)).toEqual([1]);
		expect(ui.toggleScheduleDay([1], 2)).toEqual([1, 2]);
	});

	it("normalizes time rows, keeps at least one, and validates ranges", () => {
		expect(ui.normalizeTimes([])).toEqual([{ hour: 9, minute: 0 }]);
		expect(
			ui.normalizeTimes([
				{ hour: 18, minute: 30 },
				{ hour: 9, minute: 0 },
				{ hour: 18, minute: 30 },
			]),
		).toEqual([
			{ hour: 9, minute: 0 },
			{ hour: 18, minute: 30 },
		]);
		expect(ui.isValidTime(23, 59)).toBe(true);
		expect(ui.isValidTime(24, 0)).toBe(false);
		expect(ui.isValidTime(10, 60)).toBe(false);
	});

	it("keys drafts by targetId, replaces desired values, and removes a reverted draft", () => {
		const drafts: Record<string, unknown> = {};
		ui.updateDraft(drafts, "target-1", false, true, "revision-1");
		expect(drafts).toEqual({
			"target-1": {
				targetId: "target-1",
				desiredValue: false,
				observedRevision: "revision-1",
			},
		});
		ui.updateDraft(drafts, "target-1", "next", true, "revision-1");
		expect(drafts["target-1"]).toMatchObject({ desiredValue: "next" });
		ui.updateDraft(drafts, "target-1", true, true, "revision-1");
		expect(drafts).toEqual({});
	});
});
