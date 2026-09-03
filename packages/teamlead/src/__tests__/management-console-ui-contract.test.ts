import { describe, expect, it } from "vitest";
import { MANAGEMENT_CONSOLE_STATE_JS } from "../bridge/fleet-console-html.js";

type PureUi = {
	templateKind(
		graph: {
			nodes: Array<{ type: string }>;
		} | null,
	): "engineering" | "product";
	maxChainLen(
		dags: Array<{ graph: { nodes: Array<{ type: string }> } | null }>,
	): number;
	nodeMetrics(
		maxChain: number,
		availableWidth: number,
	): { NW: number; GAP: number; perRow: number };
	flagReading(
		flag: {
			valueKind: "bool" | "int" | "enum";
			polarity: "default_on" | "opt_in";
			default: boolean | string | number;
			onMeans: "enables" | "disables" | null;
		},
		current: boolean | string | number | null,
	): { state: string; text: string; tone: string; tail: string };
	scheduleLabel(days: number[]): string;
	toggleScheduleDay(days: number[], day: number): number[];
	normalizeTimes(times: Array<{ hour: number; minute: number }>): Array<{
		hour: number;
		minute: number;
	}>;
	nextScheduleTime(
		times: Array<{ hour: number; minute: number }> /* current */,
	): { hour: number; minute: number } | null;
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
		`${MANAGEMENT_CONSOLE_STATE_JS};return {templateKind:templateKind,maxChainLen:maxChainLen,nodeMetrics:nodeMetrics,flagReading:flagReading,scheduleLabel:scheduleLabel,toggleScheduleDay:toggleScheduleDay,normalizeTimes:normalizeTimes,nextScheduleTime:nextScheduleTime,isValidTime:isValidTime,updateDraft:updateDraft};`,
	)() as PureUi;
}

describe("management console pure interaction contract", () => {
	const ui = pureUi();

	it("classifies templates from graph node types and treats unreadable shapes as product", () => {
		expect(ui.templateKind({ nodes: [{ type: "implement" }] })).toBe(
			"engineering",
		);
		expect(
			ui.templateKind({
				nodes: [{ type: "generic" }, { type: "gate" }, { type: "land" }],
			}),
		).toBe("product");
		expect(ui.templateKind(null)).toBe("product");
	});

	it("derives one global maximum chain length across every template", () => {
		const product = [
			{ graph: { nodes: [{ type: "generic" }, { type: "gate" }] } },
		];
		const engineering = [
			{
				graph: {
					nodes: Array.from({ length: 5 }, () => ({ type: "implement" })),
				},
			},
		];
		const maximum = ui.maxChainLen([...product, ...engineering]);
		expect(maximum).toBe(5);
		expect(ui.maxChainLen([{ graph: null }])).toBe(1);
		expect(ui.nodeMetrics(maximum, 900).NW).toBe(
			ui.nodeMetrics(maximum, 900).NW,
		);
	});

	it.each([
		{ width: 1200, NW: 118, perRow: 5 },
		{ width: 490, NW: 76, perRow: 5 },
		{ width: 480, NW: 76, perRow: 4 },
		{ width: 500, NW: 77, perRow: 5 },
	])(
		"keeps node boxes above the floor and wraps at width $width",
		({ width, NW, perRow }) => {
			expect(ui.nodeMetrics(5, width)).toMatchObject({ NW, perRow });
		},
	);

	it("uses the all-template maximum for equal sizing across product and engineering tabs", () => {
		const allDags = [
			{
				graph: {
					nodes: Array.from({ length: 3 }, () => ({ type: "generic" })),
				},
			},
			{
				graph: {
					nodes: Array.from({ length: 5 }, () => ({ type: "implement" })),
				},
			},
		];
		const globalMaximum = ui.maxChainLen(allDags);
		const productMetrics = ui.nodeMetrics(globalMaximum, 900);
		const engineeringMetrics = ui.nodeMetrics(globalMaximum, 900);
		expect(productMetrics.NW).toBe(engineeringMetrics.NW);
	});

	it.each([
		{
			name: "disables/open",
			flag: {
				valueKind: "bool",
				polarity: "default_on",
				default: false,
				onMeans: "disables",
			},
			current: true,
			expected: {
				state: "开",
				text: "这是一个【停用开关】,现在已经打开 —— 它管的那件事已经被停掉了。",
				tone: "changed",
				tail: "已偏离默认(默认 关)",
			},
		},
		{
			name: "disables/closed",
			flag: {
				valueKind: "bool",
				polarity: "default_on",
				default: false,
				onMeans: "disables",
			},
			current: false,
			expected: {
				state: "关",
				text: "这是一个【停用开关】,现在没有打开 —— 它管的那件事照常在跑。",
				tone: "normal",
				tail: "维持默认",
			},
		},
		{
			name: "default-on/open",
			flag: {
				valueKind: "bool",
				polarity: "default_on",
				default: true,
				onMeans: "enables",
			},
			current: true,
			expected: {
				state: "开",
				text: "这个功能正常运行中(默认就是开着的)。",
				tone: "normal",
				tail: "维持默认",
			},
		},
		{
			name: "default-on/closed",
			flag: {
				valueKind: "bool",
				polarity: "default_on",
				default: true,
				onMeans: "enables",
			},
			current: false,
			expected: {
				state: "关",
				text: "这个功能已经被关掉了 —— 默认是开着的,现在被关了。",
				tone: "changed",
				tail: "已偏离默认(默认 开)",
			},
		},
		{
			name: "opt-in/open",
			flag: {
				valueKind: "bool",
				polarity: "opt_in",
				default: false,
				onMeans: "enables",
			},
			current: true,
			expected: {
				state: "开",
				text: "这个功能已经启用 —— 默认是关着的,现在打开了。",
				tone: "changed",
				tail: "已偏离默认(默认 关)",
			},
		},
		{
			name: "opt-in/closed",
			flag: {
				valueKind: "bool",
				polarity: "opt_in",
				default: false,
				onMeans: "enables",
			},
			current: false,
			expected: {
				state: "关",
				text: "这个功能没有启用(默认就是关着的)。",
				tone: "normal",
				tail: "维持默认",
			},
		},
		{
			name: "non-bool",
			flag: {
				valueKind: "int",
				polarity: "opt_in",
				default: 12,
				onMeans: null,
			},
			current: 18,
			expected: {
				state: "18",
				text: "当前取值 18(默认 12)。这不是开关,是一个数值/枚举。",
				tone: "changed",
				tail: "已偏离默认(默认 12)",
			},
		},
	])(
		"reads $name in explicit human language",
		({ flag, current, expected }) => {
			expect(ui.flagReading(flag, current)).toEqual(expected);
		},
	);

	it("does not guess missing bool semantics and prioritizes an unreadable current value", () => {
		const missing = {
			valueKind: "bool" as const,
			polarity: "default_on" as const,
			default: true,
			onMeans: null,
		};
		expect(ui.flagReading(missing, true)).toMatchObject({
			state: "读不到",
			text: "这条 flag 没有登记「打开代表什么」(registry 缺项),这里不猜。",
			tone: "unknown",
		});
		expect(ui.flagReading(missing, null)).toMatchObject({
			state: "未知",
			text: "这个 flag 当前读不到值。",
			tone: "unknown",
			tail: "无法与默认比较(默认 开)",
		});
	});

	it("reads the effective draft value supplied by the caller", () => {
		const flag = {
			valueKind: "bool" as const,
			polarity: "opt_in" as const,
			default: false,
			onMeans: "enables" as const,
		};
		expect(ui.flagReading(flag, false).text).toContain("没有启用");
		expect(ui.flagReading(flag, true).text).toContain("已经启用");
	});

	it("derives the four weekly labels and never allows zero selected days", () => {
		expect(ui.scheduleLabel([1, 2, 3, 4, 5, 6, 7])).toBe("每日");
		expect(ui.scheduleLabel([1, 2, 3, 4, 5])).toBe("工作日");
		expect(ui.scheduleLabel([6, 7])).toBe("周末");
		expect(ui.scheduleLabel([1, 3])).toBe("自定义");
		expect(ui.toggleScheduleDay([1], 1)).toEqual([1]);
		expect(ui.toggleScheduleDay([1], 2)).toEqual([1, 2]);
	});

	it("normalizes time rows without inventing a replacement schedule", () => {
		expect(ui.normalizeTimes([])).toEqual([]);
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

	it("chooses a distinct default for every added schedule row", () => {
		expect(ui.nextScheduleTime([])).toEqual({ hour: 9, minute: 0 });
		expect(ui.nextScheduleTime([{ hour: 9, minute: 0 }])).toEqual({
			hour: 17,
			minute: 0,
		});
		expect(
			ui.nextScheduleTime([
				{ hour: 9, minute: 0 },
				{ hour: 17, minute: 0 },
			]),
		).toEqual({ hour: 0, minute: 0 });
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
