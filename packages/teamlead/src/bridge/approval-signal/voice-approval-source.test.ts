import { describe, expect, it } from "vitest";
import { evaluateVoiceSource } from "./voice-approval-source.js";

const GATE = {
	questionId: "q-1",
	prHeadSha: "abc123",
	canonicalFounderId: "annie-id",
};

const utter = (
	text: string,
	over: Partial<{ founderUserId: string }> = {},
) => ({
	transcriptId: "t-1",
	text,
	founderUserId: over.founderUserId ?? "annie-id",
});

describe("evaluateVoiceSource — §14 c-tier voice signal (no classifier, ever)", () => {
	it("a non-founder speaker produces NO signal (null)", () => {
		expect(
			evaluateVoiceSource({
				gate: GATE,
				utterance: utter("确认", { founderUserId: "someone-else" }),
			}),
		).toBeNull();
	});

	it("CONFIRM words normalize to an approve signal bound to the gate", () => {
		for (const text of ["确认", "对", "确认。", " 确认 "]) {
			expect(
				evaluateVoiceSource({ gate: GATE, utterance: utter(text) }),
			).toEqual({
				source: "voice",
				kind: "approve",
				questionId: "q-1",
				prHeadSha: "abc123",
				transcriptId: "t-1",
			});
		}
	});

	it("DENY words → reject", () => {
		for (const text of ["不对", "取消", "不批"]) {
			expect(
				evaluateVoiceSource({ gate: GATE, utterance: utter(text) })?.kind,
			).toBe("reject");
		}
	});

	it("anything else → unclear (explicit confirmation only — NEVER guessed)", () => {
		for (const text of [
			"嗯……应该可以吧",
			"ship 吧",
			"确认一下再说",
			"好的确认",
			"",
		]) {
			expect(
				evaluateVoiceSource({ gate: GATE, utterance: utter(text) })?.kind,
			).toBe("unclear");
		}
	});

	it("embedded confirm words never match (exact phrase, not substring)", () => {
		expect(
			evaluateVoiceSource({
				gate: GATE,
				utterance: utter("我不确认这个"),
			})?.kind,
		).toBe("unclear");
	});
});
