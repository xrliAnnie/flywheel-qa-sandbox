import { describe, expect, it } from "vitest";
import {
	BLOCKED_EMOJI,
	STAGE_EMOJI,
	STAGE_WORD,
	splitStatusEmoji,
	stageBadge,
	stageEmoji,
	stageWord,
	stripStatusEmojiPrefix,
	VALID_STAGES,
} from "../bridge/stage-utils.js";

describe("FLY-560: stage → status emoji", () => {
	it("maps every valid pipeline stage to an emoji", () => {
		for (const stage of VALID_STAGES) {
			expect(stageEmoji(stage), `stage=${stage}`).toBeTruthy();
		}
	});

	it("maps the planning cluster (started/onboard/brainstorm/research/plan) to 🧠", () => {
		for (const stage of [
			"started",
			"onboard",
			"brainstorm",
			"research",
			"plan",
		]) {
			expect(stageEmoji(stage)).toBe("🧠");
		}
	});

	it("maps the distinct delivery stages to their issue-defined emoji", () => {
		// v2 (Annie): both codex reviews share 👀; the word tells them apart.
		expect(stageEmoji("design_review")).toBe("👀");
		expect(stageEmoji("code_review")).toBe("👀");
		expect(stageEmoji("implement")).toBe("🔨");
		expect(stageEmoji("test")).toBe("🧪");
		expect(stageEmoji("pr_created")).toBe("⏳");
		expect(stageEmoji("approve")).toBe("⏳");
		expect(stageEmoji("ship")).toBe("🚀");
		expect(stageEmoji("completed")).toBe("✅");
	});

	it("returns undefined for an unknown stage", () => {
		expect(stageEmoji("nonsense")).toBeUndefined();
		expect(stageEmoji("")).toBeUndefined();
	});

	it("exposes BLOCKED_EMOJI as 🔴 and includes it in STAGE_EMOJI values universe", () => {
		expect(BLOCKED_EMOJI).toBe("🔴");
		// BLOCKED is cross-cutting (not a pipeline stage), so it must NOT be a
		// stageEmoji() result but MUST be a recognized status emoji for stripping.
		expect(Object.values(STAGE_EMOJI)).not.toContain(BLOCKED_EMOJI);
	});
});

describe("FLY-560: splitStatusEmoji / stripStatusEmojiPrefix", () => {
	it("splits a leading status emoji from the base title", () => {
		expect(splitStatusEmoji("🔨 [FLY-560] Title")).toEqual({
			emoji: "🔨",
			base: "[FLY-560] Title",
		});
	});

	it("recognizes the blocked emoji as a status prefix", () => {
		expect(splitStatusEmoji("🔴 [FLY-560] Stuck")).toEqual({
			emoji: "🔴",
			base: "[FLY-560] Stuck",
		});
	});

	it("returns no emoji when the name has no leading status emoji", () => {
		expect(splitStatusEmoji("[FLY-560] Title")).toEqual({
			base: "[FLY-560] Title",
		});
	});

	it("does not treat an unrelated leading emoji as a status prefix", () => {
		// 🧵 is used in the thread root message but is NOT a status emoji.
		expect(splitStatusEmoji("🧵 [FLY-560] Title")).toEqual({
			base: "🧵 [FLY-560] Title",
		});
	});

	it("strips only ONE leading status emoji (no accumulation)", () => {
		expect(stripStatusEmojiPrefix("🔨 [FLY-560] Title")).toBe(
			"[FLY-560] Title",
		);
		expect(stripStatusEmojiPrefix("[FLY-560] Title")).toBe("[FLY-560] Title");
	});

	it("collapses extra whitespace after the stripped emoji", () => {
		expect(stripStatusEmojiPrefix("✅   [FLY-560] Done")).toBe(
			"[FLY-560] Done",
		);
	});
});

describe("FLY-560 UX iteration: stage → status word", () => {
	it("maps every valid pipeline stage to a short word (≤3 chars where Chinese)", () => {
		for (const stage of VALID_STAGES) {
			expect(stageWord(stage), `stage=${stage}`).toBeTruthy();
		}
	});

	it("collapses the planning cluster to one shared 规划 (no churn)", () => {
		// FINAL (Annie): started/onboard/brainstorm/research/plan all → 规划 so the
		// title never changes while a Runner moves through the early phases.
		for (const stage of [
			"started",
			"onboard",
			"brainstorm",
			"research",
			"plan",
		]) {
			expect(stageWord(stage)).toBe("规划");
		}
	});

	it("tells the two reviews apart by WORD under a shared 👀 emoji", () => {
		expect(stageWord("design_review")).toBe("设计审");
		expect(stageWord("code_review")).toBe("代码审");
		// v2 (Annie): same emoji, distinct words → 👀设计审 vs 👀代码审.
		expect(stageBadge("design_review", true)).toBe("👀设计审");
		expect(stageBadge("code_review", true)).toBe("👀代码审");
		expect(stageEmoji("design_review")).toBe(stageEmoji("code_review"));
	});

	it("collapses the ⏳ awaiting cluster (pr_created/approve) to one 待批", () => {
		expect(stageWord("pr_created")).toBe("待批");
		expect(stageWord("approve")).toBe("待批");
	});

	it("keeps the distinct delivery-stage words", () => {
		expect(stageWord("implement")).toBe("实现中");
		expect(stageWord("test")).toBe("QA");
		expect(stageWord("ship")).toBe("ship");
		expect(stageWord("completed")).toBe("完成");
	});

	it("returns undefined for an unknown stage", () => {
		expect(stageWord("nonsense")).toBeUndefined();
		expect(stageWord("")).toBeUndefined();
	});

	it("every word stays well within Discord's 100-char title budget", () => {
		for (const word of Object.values(STAGE_WORD)) {
			// Words are tiny labels; guard against an accidental long string.
			expect(word.length).toBeLessThanOrEqual(6);
		}
	});
});

describe("FLY-560 UX iteration: stageBadge (emoji-only vs emoji+word)", () => {
	it("emoji-only mode returns the bare emoji", () => {
		expect(stageBadge("implement", false)).toBe("🔨");
		expect(stageBadge("code_review", false)).toBe("👀");
		expect(stageBadge("completed", false)).toBe("✅");
	});

	it("emoji+word mode glues the word directly behind the emoji", () => {
		expect(stageBadge("implement", true)).toBe("🔨实现中");
		expect(stageBadge("design_review", true)).toBe("👀设计审");
		expect(stageBadge("test", true)).toBe("🧪QA");
		expect(stageBadge("code_review", true)).toBe("👀代码审");
		expect(stageBadge("pr_created", true)).toBe("⏳待批");
		expect(stageBadge("approve", true)).toBe("⏳待批");
		expect(stageBadge("ship", true)).toBe("🚀ship");
		expect(stageBadge("completed", true)).toBe("✅完成");
		expect(stageBadge("brainstorm", true)).toBe("🧠规划");
		expect(stageBadge("research", true)).toBe("🧠规划");
		expect(stageBadge("plan", true)).toBe("🧠规划");
	});

	it("returns undefined for an unknown stage in either mode", () => {
		expect(stageBadge("nonsense", false)).toBeUndefined();
		expect(stageBadge("nonsense", true)).toBeUndefined();
		expect(stageBadge("", true)).toBeUndefined();
	});
});

describe("FLY-560 UX iteration: splitStatusEmoji peels the glued word", () => {
	it("peels emoji + its paired word from an emoji+word title", () => {
		expect(splitStatusEmoji("🔨实现中 [FLY-560] Title")).toEqual({
			emoji: "🔨",
			word: "实现中",
			base: "[FLY-560] Title",
		});
		expect(splitStatusEmoji("🔴受阻 [FLY-560] Stuck")).toEqual({
			emoji: "🔴",
			word: "受阻",
			base: "[FLY-560] Stuck",
		});
	});

	it("peels the merged cluster words (🧠规划, ⏳待批)", () => {
		expect(splitStatusEmoji("🧠规划 [FLY-560] X")).toEqual({
			emoji: "🧠",
			word: "规划",
			base: "[FLY-560] X",
		});
		expect(splitStatusEmoji("⏳待批 [FLY-560] X")).toEqual({
			emoji: "⏳",
			word: "待批",
			base: "[FLY-560] X",
		});
	});

	it("peels either review word under the shared 👀 (the only multi-word emoji)", () => {
		// FINAL (Annie): 👀 carries BOTH review words; splitting must try each.
		for (const word of ["设计审", "代码审"]) {
			expect(splitStatusEmoji(`👀${word} [FLY-560] X`)).toEqual({
				emoji: "👀",
				word,
				base: "[FLY-560] X",
			});
		}
	});

	it("emoji-only titles still reduce to the same base (no word)", () => {
		expect(splitStatusEmoji("🔨 [FLY-560] Title")).toEqual({
			emoji: "🔨",
			base: "[FLY-560] Title",
		});
	});

	it("does not peel a word that is not one of the emoji's words", () => {
		// 实现中 belongs to 🔨, not 🧪 — leave it in the base.
		expect(splitStatusEmoji("🧪实现中 [FLY-560] X")).toEqual({
			emoji: "🧪",
			base: "实现中 [FLY-560] X",
		});
	});

	it("stripStatusEmojiPrefix removes both the emoji and its word", () => {
		expect(stripStatusEmojiPrefix("🔨实现中 [FLY-560] Title")).toBe(
			"[FLY-560] Title",
		);
		expect(stripStatusEmojiPrefix("✅完成 [FLY-560] Done")).toBe(
			"[FLY-560] Done",
		);
	});
});
