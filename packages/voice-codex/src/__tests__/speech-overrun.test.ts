import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	opensWith,
	readbackSentences,
	SPEECH_OVERRUN_UNALIGNED_CHARS,
	speechAlignment,
	spokenPrefix,
	unalignedText,
} from "../codex/SpeechOverrun.js";
import { stripHandoffCorrelation } from "../speech.js";

const readback = JSON.parse(
	readFileSync(
		new URL("./fixtures/fly2866-v3-readback.json", import.meta.url),
		"utf8",
	),
) as {
	expected: string;
	transcripts: Array<{ run: string; overrun: boolean; text: string }>;
};

describe("read-aloud overrun alignment (FLY-2885 T5c)", () => {
	it("counts nothing unaligned for a faithful reading", () => {
		expect(
			speechAlignment(
				"测试已经完成，谢谢你的配合。",
				"测试已经完成,谢谢你的配合。",
			),
		).toMatchObject({ unaligned: 0, overrun: false });
	});

	it("tolerates the 1-6 character rewrites v3 makes", () => {
		const expected = "测试已经完成，谢谢你的配合。";
		// research R4: v3 dropped 你的配合 once.
		const rewritten = "测试已经完成，谢谢。";
		expect(speechAlignment(expected, rewritten).unaligned).toBe(0);
		const swapped = "测试已经做完，谢谢您的配合。";
		const result = speechAlignment(expected, swapped);
		expect(result.unaligned).toBeLessThanOrEqual(6);
		expect(result.overrun).toBe(false);
	});

	it("catches a rewrite plus an appended passage (the design-review R4 counterexample)", () => {
		const expected =
			"目前这件事已经进入评审，结果出来之后我会第一时间告诉你，你不用再单独跟进了。";
		expect(Array.from(expected.replace(/[，。]/gu, ""))).toHaveLength(35);
		const actual = `${expected.replace("目前", "现在")}另外今天还有两件事情已经顺利完成了呢。`;
		const result = speechAlignment(expected, actual);
		expect(result.unaligned).toBe(20);
		expect(result.overrun).toBe(true);
		// Canonical form (两 → 2); either 了 may be the aligned one.
		const extra = unalignedText(expected, actual);
		expect(Array.from(extra)).toHaveLength(20);
		expect(extra.startsWith("现在")).toBe(true);
		expect(extra).toContain("另外今天还有2件事情已经顺利完成");
		expect(SPEECH_OVERRUN_UNALIGNED_CHARS).toBe(8);
	});

	it("treats a transcript far longer than the line as overrun without aligning it", () => {
		const result = speechAlignment("你好。", "好".repeat(200));
		expect(result.overrun).toBe(true);
	});

	it("flags each real FLY-2866 invented report shortly after the line ends, and never a faithful one", () => {
		const expectedChars = speechAlignment(readback.expected, "").expectedChars;
		expect(expectedChars).toBeGreaterThan(45);
		for (const transcript of readback.transcripts) {
			let accumulated = "";
			let triggeredAt: number | undefined;
			for (const char of Array.from(transcript.text)) {
				accumulated += char;
				const result = speechAlignment(readback.expected, accumulated);
				if (result.overrun) {
					triggeredAt = result.actualChars;
					break;
				}
			}
			if (transcript.overrun) {
				expect(triggeredAt, transcript.run).toBeDefined();
				// Within the expected line plus the 8-character allowance.
				expect(triggeredAt!, transcript.run).toBeLessThanOrEqual(
					expectedChars + SPEECH_OVERRUN_UNALIGNED_CHARS + 2,
				);
			} else {
				expect(triggeredAt, transcript.run).toBeUndefined();
			}
		}
	});
});

describe("where a Lead reply resumes after an overrun (FLY-2885 founder rework A)", () => {
	it("splits a chunk into sentences that join back into the chunk", () => {
		const text = "第一句。第二句!第三句?\n\n最后一句没有句号";
		const sentences = readbackSentences(text);
		expect(sentences).toEqual([
			"第一句。",
			"第二句!",
			"第三句?\n\n",
			"最后一句没有句号",
		]);
		expect(sentences.join("")).toBe(text);
	});

	it("resumes after the last sentence read, with a 1-6 character rewrite tolerated", () => {
		const expected =
			"我有 Peter 的角色背景,但没有读取他的完整 memory。知道他是产品负责人,需要查记录。";
		expect(
			spokenPrefix(
				expected,
				"我有 Peter 的角色背景,但是没读他的完整 memory。目前还在推进三件事",
			),
		).toEqual({
			spoken: "我有 Peter 的角色背景,但没有读取他的完整 memory。",
			remainder: "知道他是产品负责人,需要查记录。",
			spokenSentences: 1,
			totalSentences: 2,
		});
	});

	it("does not count a sentence the invented part only brushes against", () => {
		// "还", "有" and "两"(=2) of the invented text also occur in sentence two.
		expect(
			spokenPrefix(
				"第一句话已经说完了。第二句话还没有念。",
				"第一句话已经说完了。另外今天还有两件事情完成了呢。",
			).remainder,
		).toBe("第二句话还没有念。");
	});

	it("has nothing left when every sentence was read before the overrun", () => {
		expect(
			spokenPrefix("第一句。第二句。", "第一句。第二句。然后我再补充很多内容"),
		).toMatchObject({ remainder: "", spokenSentences: 2 });
	});

	it("resumes from the start when nothing of the chunk was read", () => {
		expect(
			spokenPrefix(
				"今天下午三点开会。",
				"我现在去帮你查一下这个问题的具体情况。",
			),
		).toEqual({
			spoken: "",
			remainder: "今天下午三点开会。",
			spokenSentences: 0,
			totalSentences: 1,
		});
	});

	it("never lets shared wording further on mark an unread sentence as read (review R1)", () => {
		// "完" of the invented text used to complete sentence two's "第二项完成".
		expect(
			spokenPrefix(
				"第一项完成。第二项完成。",
				"第一项完成。第二项。这里是完全编造的额外内容",
			),
		).toMatchObject({ remainder: "第二项完成。", spokenSentences: 1 });
	});

	it("does not count the next sentence when only its first half was read", () => {
		expect(
			spokenPrefix(
				"会议改到明天。地点还是三楼的大会议室。",
				"会议改到明天。地点还是另外我再说一件别的事情",
			),
		).toMatchObject({
			remainder: "地点还是三楼的大会议室。",
			spokenSentences: 1,
		});
	});

	it("keeps the prefix contiguous when a later sentence repeats earlier wording", () => {
		// Sentence two is skipped; sentence three repeats sentence one's words.
		expect(
			spokenPrefix(
				"我们今天开会。明天出结果。我们今天开会。",
				"我们今天开会。然后今天大家都很开心我们今天开会",
			),
		).toMatchObject({
			remainder: "明天出结果。我们今天开会。",
			spokenSentences: 1,
		});
	});

	it("never leaves a punctuation-only remainder to read", () => {
		expect(
			spokenPrefix("好的。\n\n", "好的。我再说点别的内容吧"),
		).toMatchObject({ remainder: "", spokenSentences: 1 });
	});
});

describe("the handoff correlation line is not read aloud (FLY-2885 founder rework)", () => {
	const id = "9cd193a6-7a84-45da-b4af-dcce7d9d3954";

	it.each([
		`关联 Handoff ID：${id}`,
		`Handoff ID: ${id}`,
		`  关联Handoff ID :${id}  `,
	])("drops the whole line %j", (line) => {
		expect(stripHandoffCorrelation(`第一句。\n\n${line}\n最后一句。`)).toBe(
			"第一句。\n\n\n最后一句。",
		);
	});

	it.each([
		`这件事的 Handoff ID: ${id} 我已经记下了`,
		`Handoff ID: ${id} 已处理`,
		"Handoff ID: 9cd193a6",
		`Request ID: ${id}`,
	])("leaves %j alone", (line) => {
		expect(stripHandoffCorrelation(line)).toBe(line);
	});
});

describe("which final an overrun chunk may claim (FLY-2885 review R3)", () => {
	const heard = "好的。第一项已经完成。另外今天还有两件事情完成了呢。";

	it("claims its own final, which opens with everything its deltas showed", () => {
		expect(opensWith(heard, `${heard}而且下周还会继续推进。`)).toBe(true);
	});

	it("does not claim an answer that only shares the opening sentence", () => {
		expect(
			opensWith(
				heard,
				"好的。这是对新问题的完整回答，内容与刚才那句朗读完全不同。",
			),
		).toBe(false);
	});

	it("claims nothing with an empty prefix", () => {
		expect(opensWith("", "任何内容")).toBe(false);
	});
});
