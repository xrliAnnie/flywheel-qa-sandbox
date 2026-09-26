import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	SPEECH_OVERRUN_UNALIGNED_CHARS,
	speechAlignment,
	unalignedText,
} from "../codex/SpeechOverrun.js";

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
