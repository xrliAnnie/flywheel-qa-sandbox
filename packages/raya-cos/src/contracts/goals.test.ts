import { describe, expect, it } from "vitest";
import * as contracts from "./index.js";

const GOALS_FILE = `# Raya goals(阶段一:她说的;append-only,撤销用状态行,不删)

## g-20260906-01
- 操作: 1414000000000000000:record:0
- 记于: 2026-09-06T23:40:12-07:00
- 来源: https://discord.com/channels/1/2/1414000000000000000
- 状态: active
- 原话: 「  保留 Ａ 与🙂  」

## g-20260906-02
- 操作: 1414000000000000001:record:0
- 记于: 2026-09-06T23:41:12-07:00
- 来源: https://discord.com/channels/1/2/1414000000000000001
- 状态: withdrawn
- 原话: 「第二个目标」
- 撤于: 2026-09-07T01:02:03-07:00
- 撤销来源: https://discord.com/channels/1/2/1414000000000000002
- 撤销操作: 1414000000000000002:withdraw:0
`;

describe("Raya goals file", () => {
	it("round-trips goals and preserves operation identity and original code points", () => {
		const api = contracts as typeof contracts & {
			parseGoalsFile?: (text: string) => Array<Record<string, unknown>>;
			renderGoalsFile?: (goals: Array<Record<string, unknown>>) => string;
			nextGoalId?: (
				goals: Array<Record<string, unknown>>,
				date: string,
			) => string;
			findByOperationId?: (
				goals: Array<Record<string, unknown>>,
				operationId: string,
			) => Record<string, unknown> | undefined;
			operationMatches?: (
				goal: Record<string, unknown>,
				operation:
					| { kind: "record"; text: string; sourceUrl: string }
					| { kind: "withdraw"; goalId: string; sourceUrl: string },
			) => boolean;
		};
		expect(api.parseGoalsFile).toBeTypeOf("function");
		if (
			!api.parseGoalsFile ||
			!api.renderGoalsFile ||
			!api.nextGoalId ||
			!api.findByOperationId ||
			!api.operationMatches
		)
			return;

		const goals = api.parseGoalsFile(GOALS_FILE);
		expect(goals).toHaveLength(2);
		expect(goals[0]?.text).toBe("  保留 Ａ 与🙂  ");
		expect(api.renderGoalsFile(goals)).toBe(GOALS_FILE);
		expect(api.nextGoalId(goals, "2026-09-06")).toBe("g-20260906-03");
		expect(api.nextGoalId(goals, "2026-09-07")).toBe("g-20260907-01");

		const recorded = api.findByOperationId(
			goals,
			"1414000000000000000:record:0",
		);
		expect(recorded?.id).toBe("g-20260906-01");
		expect(
			api.operationMatches(recorded ?? {}, {
				kind: "record",
				text: "  保留 Ａ 与🙂  ",
				sourceUrl: "https://discord.com/channels/1/2/1414000000000000000",
			}),
		).toBe(true);
		expect(
			api.operationMatches(goals[1] ?? {}, {
				kind: "withdraw",
				goalId: "g-20260906-02",
				sourceUrl: "https://discord.com/channels/1/2/1414000000000000002",
			}),
		).toBe(true);
	});

	it("rejects malformed operation identity at the file boundary", () => {
		const parseGoalsFile = (
			contracts as typeof contracts & {
				parseGoalsFile: (text: string) => unknown;
			}
		).parseGoalsFile;
		const malformed = GOALS_FILE.replace(
			"1414000000000000000:record:0",
			"not an operation",
		);

		expect(() => parseGoalsFile(malformed)).toThrow(/operation|操作/i);
	});

	it.each([
		["missing required field", GOALS_FILE.replace("- 来源: ", "- 来源缺失: ")],
		["invalid status", GOALS_FILE.replace("- 状态: active", "- 状态: paused")],
		[
			"duplicate id",
			GOALS_FILE.replace("## g-20260906-02", "## g-20260906-01"),
		],
		[
			"duplicate operation",
			GOALS_FILE.replace(
				"1414000000000000001:record:0",
				"1414000000000000000:record:0",
			),
		],
	])("rejects %s", (_name, text) => {
		const parseGoalsFile = (
			contracts as typeof contracts & {
				parseGoalsFile: (text: string) => unknown;
			}
		).parseGoalsFile;
		expect(() => parseGoalsFile(text)).toThrow(/goals file corrupt/);
	});
	it("round-trips inferred scope and correction identity without presenting inference as a quotation", () => {
		const [legacy] = contracts.parseGoalsFile(GOALS_FILE);
		if (!legacy) throw new Error("missing fixture");
		const inferred = {
			...legacy,
			kind: "inference" as const,
			projects: ["flywheel"],
			revision: 2,
			supersedes: "g-20260905-01",
		};
		const text = contracts.renderGoalsFile([inferred]);
		expect(text).toContain("- 提炼: 「");
		expect(text).not.toContain("- 原话:");
		expect(contracts.parseGoalsFile(text)).toEqual([inferred]);
	});
	it("rejects malformed scoped metadata and multi-line text at serialization", () => {
		const [legacy] = contracts.parseGoalsFile(GOALS_FILE);
		if (!legacy) throw new Error("missing fixture");
		expect(() =>
			contracts.renderGoalsFile([
				{ ...legacy, kind: "inference", projects: [] },
			]),
		).toThrow();
		expect(() =>
			contracts.renderGoalsFile([
				{ ...legacy, text: "first\n- 状态: withdrawn" },
			]),
		).toThrow();
	});
});
