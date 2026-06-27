/**
 * GEO-292: Session stage constants for pipeline tracking.
 * Shared between event-route.ts, actions.ts, and flywheel-comm.
 *
 * FLY-137 v1.27.2: added `onboard` stage between `started` and `brainstorm`.
 * Semantics: "Runner attempted onboarding" (not "onboarding succeeded"). Runner
 * sets `onboard` BEFORE invoking the onboard skill so the dashboard reflects intent.
 * On success → `brainstorm`. On skill absent → `brainstorm` directly. On hard failure
 * → `flywheel-comm complete --route blocked --summary "onboard_failed: <reason>"`
 * (existing fail channel — no new error stage needed).
 */

export const VALID_STAGES = new Set([
	"started",
	"onboard",
	"brainstorm",
	"research",
	"plan",
	"design_review",
	"implement",
	"test",
	"code_review",
	"pr_created",
	"approve",
	"ship",
	"completed",
]);

export const STAGE_ORDER: Record<string, number> = {
	started: 0,
	onboard: 1,
	brainstorm: 2,
	research: 3,
	plan: 4,
	design_review: 5,
	implement: 6,
	test: 7,
	code_review: 8,
	pr_created: 9,
	approve: 10,
	ship: 11,
	completed: 12,
};

/**
 * FLY-560: stage → status emoji, used to auto-prefix the `[FLY-XX]` Discord
 * thread title so Annie can read an issue's pipeline state at a glance
 * (Feature A). Visual vocabulary:
 *   🧠 plan/brainstorm/research · 👀 design-review + code-review · 🔨 impl ·
 *   🧪 QA · ⏳ awaiting-review (等 merge) + awaiting-approve · 🚀 awaiting-restart ·
 *   ✅ done
 *
 * v2 (Annie): the two codex reviews SHARE the 👀 emoji and are told apart by
 * their word (👀设计审 vs 👀代码审) — she preferred one review glyph + distinct
 * words over two different emoji.
 *
 * The planning cluster (started/onboard/brainstorm/research/plan) shares a
 * single 🧠 so the title's EMOJI does not churn while a Runner moves through the
 * early thinking phases (the words still distinguish them in emoji+word mode).
 */
export const STAGE_EMOJI: Record<string, string> = {
	started: "🧠",
	onboard: "🧠",
	brainstorm: "🧠",
	research: "🧠",
	plan: "🧠",
	design_review: "👀",
	implement: "🔨",
	test: "🧪",
	code_review: "👀",
	pr_created: "⏳",
	approve: "⏳",
	ship: "🚀",
	completed: "✅",
};

/**
 * FLY-560 (UX iteration): short status WORD per stage, paired with STAGE_EMOJI
 * to form an "emoji+word" badge (e.g. `🔨实现中`). Annie's feedback was that an
 * emoji alone is hard to memorise at a glance, so the thread title carries a
 * tiny label after the emoji. Words are intentionally short (≤3 chars) to stay
 * well within Discord's 100-char thread-title limit.
 *
 * FINAL (Annie locked): collapse the two early clusters each to ONE state so a
 * Runner's title does NOT churn while it moves through that cluster (Discord
 * caps renames at 2/10-min — distinct words per sub-stage would change the title
 * on every transition). 11 stages → 8 unique titles:
 *   - 🧠规划: started/onboard/brainstorm/research/plan (one shared title)
 *   - ⏳待批: pr_created/approve (one shared title)
 *   - the rest stay distinct: 👀设计审 · 👀代码审 · 🔨实现中 · 🧪QA · 🚀ship · ✅完成
 * The two codex reviews keep separate WORDS under the shared 👀 (Annie's call)
 * because she wants design-review vs code-review legible — that is one rename
 * across two genuinely distinct stages, not churn within a cluster.
 *
 * Words are easily swapped here; Annie can still change 规划/待批.
 */
export const STAGE_WORD: Record<string, string> = {
	started: "规划",
	onboard: "规划",
	brainstorm: "规划",
	research: "规划",
	plan: "规划",
	design_review: "设计审",
	implement: "实现中",
	test: "QA",
	code_review: "代码审",
	pr_created: "待批",
	approve: "待批",
	ship: "ship",
	completed: "完成",
};

/**
 * FLY-560: cross-cutting "Blocked" marker. NOT a pipeline stage — a Runner can
 * be blocked at any stage — so it is deliberately absent from STAGE_EMOJI and
 * never returned by stageEmoji(). v1 (Feature A) stamps only stage emoji on
 * `stage_changed`; the 🔴 trigger (driven by the blocked completion route) is
 * scoped to the follow-up status-board PR. It is included in the recognized
 * status-emoji universe here so prefix stripping stays forward-compatible.
 */
export const BLOCKED_EMOJI = "🔴";

/** Word paired with 🔴 (cross-cutting Blocked marker). Not stamped in v1. */
export const BLOCKED_WORD = "受阻";

/** All emoji the status-prefix logic may have placed at the front of a title. */
const ALL_STATUS_EMOJI: ReadonlySet<string> = new Set([
	...Object.values(STAGE_EMOJI),
	BLOCKED_EMOJI,
]);

/**
 * Reverse map: status emoji → all words that may be glued behind it. A single
 * emoji can now carry several words (v2: the 🧠 planning cluster → 规划/脑暴/调研/
 * 计划, the ⏳ awaiting cluster → PR/待批), so re-stamping must try every word
 * for the matched emoji. Words are sorted longest-first so a longer word is
 * peeled before any shorter one (defensive; the v2 vocab has no shared prefixes).
 */
const EMOJI_TO_WORDS: Readonly<Record<string, readonly string[]>> = (() => {
	const sets: Record<string, Set<string>> = {};
	const add = (emoji: string, word: string): void => {
		const set = sets[emoji] ?? new Set<string>();
		set.add(word);
		sets[emoji] = set;
	};
	for (const [stage, emoji] of Object.entries(STAGE_EMOJI)) {
		const word = STAGE_WORD[stage];
		if (word) add(emoji, word);
	}
	add(BLOCKED_EMOJI, BLOCKED_WORD);
	const out: Record<string, string[]> = {};
	for (const [emoji, set] of Object.entries(sets)) {
		out[emoji] = [...set].sort((a, b) => b.length - a.length);
	}
	return out;
})();

/** Emoji for a pipeline stage, or undefined for an unknown/empty stage. */
export function stageEmoji(stage: string): string | undefined {
	return STAGE_EMOJI[stage];
}

/** Short status word for a pipeline stage, or undefined for an unknown stage. */
export function stageWord(stage: string): string | undefined {
	return STAGE_WORD[stage];
}

/**
 * Build the thread-title status badge for a stage:
 *   withWord=false → `🔨`        (emoji only)
 *   withWord=true  → `🔨实现中`   (emoji + short word)
 * Returns undefined for an unknown stage so callers can no-op. Falls back to the
 * bare emoji when a stage has an emoji but no configured word.
 */
export function stageBadge(
	stage: string,
	withWord: boolean,
): string | undefined {
	const emoji = STAGE_EMOJI[stage];
	if (!emoji) return undefined;
	if (!withWord) return emoji;
	const word = STAGE_WORD[stage];
	return word ? `${emoji}${word}` : emoji;
}

/**
 * Split a thread title into its leading status emoji (if any), the short status
 * word glued to it (emoji+word mode, if present), and the base title. Only a
 * single recognized status emoji is peeled; unrelated leading emoji (e.g. the
 * 🧵 thread glyph) are left untouched so they are not mistaken for status. The
 * word is peeled only when it is the exact word paired with that emoji and is
 * glued directly behind it — so plain emoji-only titles (`🔨 [FLY-XX] …`) and
 * emoji+word titles (`🔨实现中 [FLY-XX] …`) both reduce to the same base, which
 * keeps re-stamping idempotent and lets the mode flip without leaking a word.
 */
export function splitStatusEmoji(name: string): {
	emoji?: string;
	word?: string;
	base: string;
} {
	for (const emoji of ALL_STATUS_EMOJI) {
		if (name.startsWith(emoji)) {
			let rest = name.slice(emoji.length);
			let word: string | undefined;
			for (const candidate of EMOJI_TO_WORDS[emoji] ?? []) {
				if (rest.startsWith(candidate)) {
					word = candidate;
					rest = rest.slice(candidate.length);
					break;
				}
			}
			const base = rest.replace(/^\s+/, "");
			return word ? { emoji, word, base } : { emoji, base };
		}
	}
	return { base: name };
}

/** Title with any single leading status emoji (and its trailing space) removed. */
export function stripStatusEmojiPrefix(name: string): string {
	return splitStatusEmoji(name).base;
}
