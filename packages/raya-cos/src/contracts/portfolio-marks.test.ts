import { describe, expect, it } from "vitest";
import * as contracts from "./index.js";

describe("portfolio marker parser", () => {
	it("extracts authorized marker shapes without normalizing goal payloads", () => {
		const api = contracts as typeof contracts & {
			parseGoalLines?: (text: string) => unknown;
			parseRefreshLines?: (text: string) => unknown;
			looksSecretLike?: (text: string) => boolean;
		};
		expect(api.parseGoalLines).toBeTypeOf("function");
		if (!api.parseGoalLines || !api.parseRefreshLines || !api.looksSecretLike)
			return;

		const input = [
			"普通正文",
			"【记目标】  保留 Ａ 与🙂  ",
			"【记目标】第二个",
			"【撤目标】 g-20260906-01",
			"【记目标】",
			"【撤目标】not-an-id",
			"[记目标]半角括号",
		].join("\n");
		expect(api.parseGoalLines(input)).toEqual({
			records: [
				{
					text: "  保留 Ａ 与🙂  ",
					ordinal: 0,
					line: "【记目标】  保留 Ａ 与🙂  ",
				},
				{ text: "第二个", ordinal: 1, line: "【记目标】第二个" },
			],
			withdrawals: [
				{
					goalId: "g-20260906-01",
					ordinal: 0,
					line: "【撤目标】 g-20260906-01",
				},
			],
			invalid: [
				{ line: "【记目标】", reason: "empty_text" },
				{ line: "【撤目标】not-an-id", reason: "bad_goal_id" },
				{ line: "[记目标]半角括号", reason: "malformed" },
			],
			rest: "普通正文",
		});
		expect(api.parseGoalLines(`【记目标】${"🙂".repeat(501)}`)).toMatchObject({
			records: [],
			invalid: [{ reason: "too_long" }],
			rest: "",
		});
		expect(api.parseRefreshLines("正文\n【刷新读数】\n【刷新读数】")).toEqual({
			requested: true,
			rest: "正文",
		});
		expect(api.looksSecretLike(`sk-${"a".repeat(24)}`)).toBe(true);
		expect(api.looksSecretLike("把 geoforge3d 推起来")).toBe(false);
	});
});
