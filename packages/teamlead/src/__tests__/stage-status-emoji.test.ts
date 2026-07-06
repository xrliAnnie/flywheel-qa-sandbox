import { describe, expect, it } from "vitest";
import {
	applyModelMarker,
	BLOCKED_EMOJI,
	hasIssueKeyHead,
	modelMarkerCode,
	STAGE_EMOJI,
	STAGE_WORD,
	splitStatusEmoji,
	stageBadge,
	stageEmoji,
	stageWord,
	stripModelMarker,
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
		// FLY-795: pr_created split out of the ⏳ cluster to its own 📬.
		expect(stageEmoji("pr_created")).toBe("📬");
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

	it("splits pr_created (PR已开) from approve (待批) — FLY-795 Annie correction", () => {
		expect(stageWord("pr_created")).toBe("PR已开");
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
		// FLY-795: pr_created split to 📬PR已开; approve keeps ⏳待批.
		expect(stageBadge("pr_created", true)).toBe("📬PR已开");
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

describe("FLY-755: model-code front marker ([F]/[O]/[S]/[H])", () => {
	it("applyModelMarker prepends the code before the issue key — all four codes", () => {
		expect(applyModelMarker("[FLY-728] Title", "F")).toBe(
			"[F] [FLY-728] Title",
		);
		expect(applyModelMarker("[FLY-728] Title", "O")).toBe(
			"[O] [FLY-728] Title",
		);
		expect(applyModelMarker("[FLY-728] Title", "S")).toBe(
			"[S] [FLY-728] Title",
		);
		expect(applyModelMarker("[FLY-728] Title", "H")).toBe(
			"[H] [FLY-728] Title",
		);
	});

	it("applyModelMarker is idempotent (re-stamp does not double the marker)", () => {
		expect(applyModelMarker("[F] [FLY-728] Title", "F")).toBe(
			"[F] [FLY-728] Title",
		);
		// and it can SWAP the code (model never changes in practice, but be safe)
		expect(applyModelMarker("[F] [FLY-728] Title", "S")).toBe(
			"[S] [FLY-728] Title",
		);
	});

	it("undefined code strips any existing marker (account default = no code)", () => {
		expect(applyModelMarker("[F] [FLY-728] Title", undefined)).toBe(
			"[FLY-728] Title",
		);
		expect(applyModelMarker("[FLY-728] Title", undefined)).toBe(
			"[FLY-728] Title",
		);
		// legacy tail is cleared too
		expect(applyModelMarker("[FLY-728] Title ·F", undefined)).toBe(
			"[FLY-728] Title",
		);
	});

	it("applyModelMarker migrates a legacy tail suffix to the front", () => {
		expect(applyModelMarker("[FLY-728] Title ·F", "F")).toBe(
			"[F] [FLY-728] Title",
		);
	});

	it("applyModelMarker never stamps a keyless base (no issue key head)", () => {
		// FLY-755 paired contract (Codex design R2): insertion is anchored on a
		// bracketed issue key — keyless titles (even bracket-start ones) are never
		// stamped, so recognition can never mis-strip a real title later.
		expect(applyModelMarker("Bare title", "F")).toBe("Bare title");
		expect(applyModelMarker("[infra] Title", "F")).toBe("[infra] Title");
		expect(applyModelMarker("[Fable] Title", "F")).toBe("[Fable] Title");
	});

	it("stripModelMarker removes the leading marker and/or a legacy tail", () => {
		expect(stripModelMarker("[F] [FLY-728] Title")).toBe("[FLY-728] Title");
		expect(stripModelMarker("[FLY-728] Title ·H")).toBe("[FLY-728] Title");
		// both forms present (defensive) → both removed
		expect(stripModelMarker("[F] [FLY-728] Title ·H")).toBe("[FLY-728] Title");
		expect(stripModelMarker("[FLY-728] Title")).toBe("[FLY-728] Title");
		// marker directly in front of a bare-key placeholder ([KEY] at end)
		expect(stripModelMarker("[F] [FLY-728]")).toBe("[FLY-728]");
		// a middle-dot elsewhere in the title is untouched
		expect(stripModelMarker("[FLY-728] A·B thing")).toBe("[FLY-728] A·B thing");
	});

	it("stripModelMarker never mis-strips bracket-start titles (Lead gate cases)", () => {
		// The marker regex is single-letter [FOSH] followed by a bracketed issue
		// key — multi-letter bracket segments and keyless brackets pass through.
		expect(stripModelMarker("[founder-UX] Title")).toBe("[founder-UX] Title");
		expect(stripModelMarker("[infra] Title")).toBe("[infra] Title");
		expect(stripModelMarker("[Fable] Title")).toBe("[Fable] Title");
		expect(stripModelMarker("[FIX] Title")).toBe("[FIX] Title");
		// literal single-letter bracket titles WITHOUT an issue key behind them
		// are real title text, not our marker (Codex design R1/R2)
		expect(stripModelMarker("[F] Founder copy")).toBe("[F] Founder copy");
		expect(stripModelMarker("[F] [infra] copy")).toBe("[F] [infra] copy");
	});

	it("coexists with the stage-emoji prefix — splitStatusEmoji peels only the badge", () => {
		// The stage badge is the outermost PREFIX; the model marker sits between
		// the badge and the issue key. Stripping the badge keeps the marker.
		const stamped = "🔨实现中 [F] [FLY-728] Title";
		expect(splitStatusEmoji(stamped).base).toBe("[F] [FLY-728] Title");
		expect(stripModelMarker(splitStatusEmoji(stamped).base)).toBe(
			"[FLY-728] Title",
		);
	});

	it("modelMarkerCode extracts the front marker, falling back to the legacy tail", () => {
		expect(modelMarkerCode("[F] [FLY-728] Title")).toBe("F");
		expect(modelMarkerCode("[H] [FLY-728] Title")).toBe("H");
		// legacy tail fallback (preserve path on un-migrated threads)
		expect(modelMarkerCode("[FLY-728] Title ·H")).toBe("H");
		// front wins over a (defensive) simultaneous legacy tail
		expect(modelMarkerCode("[F] [FLY-728] Title ·H")).toBe("F");
		expect(modelMarkerCode("[FLY-728] Title")).toBeUndefined();
		expect(modelMarkerCode("[FLY-728] A·B thing")).toBeUndefined();
		// keyless literal bracket titles carry no code
		expect(modelMarkerCode("[F] Founder copy")).toBeUndefined();
		expect(modelMarkerCode("[F] [infra] copy")).toBeUndefined();
	});

	it("hasIssueKeyHead recognizes only a bracketed Linear issue key head", () => {
		expect(hasIssueKeyHead("[FLY-728] Title")).toBe(true);
		expect(hasIssueKeyHead("[FLY-728]")).toBe(true);
		expect(hasIssueKeyHead("[GEO3D-12] Title")).toBe(true);
		expect(hasIssueKeyHead("[infra] Title")).toBe(false);
		expect(hasIssueKeyHead("[Fable] Title")).toBe(false);
		expect(hasIssueKeyHead("[F] Title")).toBe(false);
		expect(hasIssueKeyHead("Bare title")).toBe(false);
	});
});
