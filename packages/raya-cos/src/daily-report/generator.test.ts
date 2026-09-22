import { describe, expect, it } from "vitest";
import { assertDailyReportBody, buildDailyReportPrompt } from "./generator.js";

describe("current-turn report generation", () => {
	it("requires nonempty real facts and judgment sections within the UTF-8 budget", () => {
		expect(() =>
			assertDailyReportBody("## 今天各项目发生了什么\n\n## 我的判断\n"),
		).toThrow();
		expect(() =>
			assertDailyReportBody(
				"```md\n## 今天各项目发生了什么\nfacts\n## 我的判断\njudgment\n```",
			),
		).toThrow();
		expect(() =>
			assertDailyReportBody(
				`## 今天各项目发生了什么\n${"中".repeat(6000)}\n## 我的判断\n待确认`,
			),
		).toThrow(/16 KiB/);
		expect(() =>
			assertDailyReportBody(
				"## 今天各项目发生了什么\n没有收到新材料。\n## 我的判断\n现有证据不足，需要核对。",
			),
		).not.toThrow();
	});
	it("retains open, omitted and invalid provenance in model-visible material", () => {
		const prompt = buildDailyReportPrompt({
			date: "2026-09-15",
			timeZone: "UTC",
			mainCommit: "a".repeat(40),
			sources: [
				{
					project: "flywheel",
					lead: "eng",
					state: "open",
					pr: 123,
					head: "b".repeat(40),
					blob: "c".repeat(40),
					path: "summaries/flywheel/2026-09-15--eng--01.md",
					contract: "invalid:facts_missing",
					bytes: 99,
					truncated: false,
					omitted: true,
					divergent: false,
					also_in: [],
					content: "",
				},
			],
		});
		for (const value of [
			"未吸收",
			"invalid:facts_missing",
			"omitted",
			"123",
			"b".repeat(40),
			"c".repeat(40),
		])
			expect(prompt).toContain(value);
	});
});
