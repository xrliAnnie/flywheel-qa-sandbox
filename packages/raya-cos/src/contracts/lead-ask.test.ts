import { describe, expect, it } from "vitest";
import { parseLeadAskLines } from "./lead-ask.js";

describe("Lead ask marker parser", () => {
	it("extracts canonical half-width and full-width colon markers and preserves ordinary text", () => {
		const input = [
			"我先说我知道的。",
			"【问 Lead】 Tadashi : 这个项目现在卡在哪里？",
			"【问 Lead】Belle： Annie 明天有哪些冲突？",
			"【问 Ｌｅａｄ】Ops：部署完成了吗？",
			"结论先到这里。",
		].join("\n");

		expect(parseLeadAskLines(input)).toEqual({
			asks: [
				{
					leadName: "Tadashi",
					question: "这个项目现在卡在哪里？",
					line: "【问 Lead】 Tadashi : 这个项目现在卡在哪里？",
				},
				{
					leadName: "Belle",
					question: "Annie 明天有哪些冲突？",
					line: "【问 Lead】Belle： Annie 明天有哪些冲突？",
				},
				{
					leadName: "Ops",
					question: "部署完成了吗？",
					line: "【问 Ｌｅａｄ】Ops：部署完成了吗？",
				},
			],
			invalid: [],
			rest: "我先说我知道的。\n结论先到这里。",
		});
	});

	it("classifies marker near-misses without consuming their original lines", () => {
		const lines = [
			"【问 Lead】Tadashi 没冒号",
			"【问 Lead】: 问题",
			"【问 Lead】Tadashi:",
			"[问 Lead]Tadashi:问题",
			"【问错了】Tadashi:问题",
			"今天怎么样",
		];

		expect(parseLeadAskLines(lines.join("\n"))).toEqual({
			asks: [],
			invalid: [
				{ line: lines[0], reason: "missing_colon" },
				{ line: lines[1], reason: "empty_name" },
				{ line: lines[2], reason: "empty_question" },
				{ line: lines[3], reason: "malformed" },
				{ line: lines[4], reason: "malformed" },
			],
			rest: lines.join("\n"),
		});
	});

	it("rejects questions over 800 Unicode code points", () => {
		const accepted = `【问 Lead】Tadashi:${"🙂".repeat(800)}`;
		const rejected = `【问 Lead】Tadashi:${"🙂".repeat(801)}`;

		expect(parseLeadAskLines(accepted).asks[0]?.question).toBe(
			"🙂".repeat(800),
		);
		expect(parseLeadAskLines(rejected)).toEqual({
			asks: [],
			invalid: [{ line: rejected, reason: "too_long" }],
			rest: rejected,
		});
	});
});
