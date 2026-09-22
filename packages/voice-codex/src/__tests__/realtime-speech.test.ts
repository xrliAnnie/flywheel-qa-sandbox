import { describe, expect, it } from "vitest";
import {
	isFiniteSpeechEquivalent,
	prepareReplySpeech,
	projectForSpeech,
} from "../speech.js";

describe("realtime speech projection", () => {
	it("projects markdown, URLs, issue ids, emoji, and secrets exactly once", () => {
		const secret = "q9Zx7Yw2Vt5Ur8Sq1Po4Nm6Lk3Ji0Hg9Fe8Dc7Ba";
		const projected = projectForSpeech(
			`📻 **已合入 FLY-2655** [详情](https://linear.app/x) https://example.test/x ${secret}`,
		);
		expect(projected).toBe(
			"已合入 F L Y 二 六 五 五 详情 链接见文字消息 敏感内容已隐藏",
		);
		expect(projected).not.toContain(secret);
	});

	it("keeps every code point from a 600-character reply in sentence-first chunks of at most 80", () => {
		const raw = `${"甲".repeat(199)}。${"乙".repeat(199)}！${"丙".repeat(200)}`;
		const expected = projectForSpeech(raw);
		const prepared = prepareReplySpeech(raw, 600);
		expect(prepared.length).toBeGreaterThan(3);
		expect(prepared.map((item) => item.spokenText).join("")).toBe(expected);
		expect(
			prepared.every((item) => Array.from(item.spokenText).length <= 80),
		).toBe(true);
		expect(
			prepared.every(
				(item) =>
					item.generationBudgetMs ===
					Math.min(
						70_000,
						Math.max(20_000, 10_000 + 700 * Array.from(item.spokenText).length),
					),
			),
		).toBe(true);
	});

	it.each([
		["已经完成。", "已经完成"],
		["Finished F L Y 二 六 五 五", "finished fly 2655"],
		["等待 60 秒。", "等待六十秒"],
		["温度 -1.5 度", "温度负一点五度"],
	])(
		"accepts only deterministic readback equivalents: %s",
		(expected, actual) => {
			expect(isFiniteSpeechEquivalent(expected, actual)).toBe(true);
		},
	);

	it.each([
		["未完成 60 秒", "已完成 60 秒"],
		["未完成 60 秒", "未完成 600 秒"],
		["请等待", "好的，我来解释，请等待"],
		["温度 -1.5 度", "温度 1.5 度"],
	])("rejects semantic or numeric drift: %s vs %s", (expected, actual) => {
		expect(isFiniteSpeechEquivalent(expected, actual)).toBe(false);
	});

	it("returns no speech for decoration-only input", () => {
		expect(prepareReplySpeech("📻✨ ** **", 80)).toEqual([]);
	});
});
