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

import {
	PHASE_THREAD_BADGE_PARTS,
	RUNNER_MODEL_MARKER_PAYLOAD_MAX,
} from "flywheel-config";

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
	// FLY-795 (Annie): pr_created is "PR opened, awaiting review" — split from
	// `approve` ("awaiting founder ship approval") which keeps ⏳待批. `test` stays
	// 🧪QA (auto-QA stamps stage=test for the real independent QA).
	pr_created: "📬",
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
 * FINAL (Annie locked): collapse the early planning cluster to ONE state so a
 * Runner's title does NOT churn while it moves through that cluster (Discord
 * caps renames at 2/10-min — distinct words per sub-stage would change the title
 * on every transition). 12 stages → 9 unique titles:
 *   - 🧠规划: started/onboard/brainstorm/research/plan (one shared title)
 *   - the rest stay distinct: 👀设计审 · 👀代码审 · 🔨实现中 · 🧪QA · 📬PR已开 ·
 *     ⏳待批 · 🚀ship · ✅完成
 * FLY-795 (Annie): pr_created split OUT of the ⏳待批 cluster to its own 📬PR已开
 * ("PR opened, awaiting review") so the founder can tell "PR is up for review"
 * from "awaiting my ship approval". That is one rename across two genuinely
 * distinct stages, not churn within a cluster.
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
	// FLY-795: test stays "QA" (auto-QA stamps stage=test for real independent QA).
	test: "QA",
	code_review: "代码审",
	// FLY-795 (Annie): pr_created = "PR已开" (PR opened, awaiting review), split
	// from `approve` = "待批" (awaiting founder ship approval).
	pr_created: "PR已开",
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

/**
 * FLY-623: cross-cutting "monitoring re-connecting" marker. Like BLOCKED_EMOJI
 * it is NOT a pipeline stage (a Runner can be re-adopted at any stage) — so it
 * is deliberately absent from STAGE_EMOJI/STAGE_ORDER/VALID_STAGES and never
 * returned by stageEmoji(). It is stamped onto the `[FLY-XX]` thread title while
 * a Runner is detached-but-alive after a Bridge restart (HeartbeatService
 * re-adopt), so the founder reads "⚠️重连中" instead of a frozen "🔨实现中", and
 * cleared back to the real/terminal badge once the Runner's own event channel is
 * proven live again. Included in the recognized status-emoji universe below so
 * prefix stripping + re-stamping stay forward-compatible.
 */
export const RECONNECTING_EMOJI = "⚠️";

/** Word paired with ⚠️ (cross-cutting monitoring re-connecting marker). */
export const RECONNECTING_WORD = "重连中";

/** All emoji the status-prefix logic may have placed at the front of a title. */
const ALL_STATUS_EMOJI: ReadonlySet<string> = new Set([
	...Object.values(STAGE_EMOJI),
	BLOCKED_EMOJI,
	RECONNECTING_EMOJI,
	// FLY-892 (Step 6): the DAG workflow badges (🎨设计/🔨实现/🧪QA) are
	// stamped in place of the fine-grained stage badge on a DAG workflow issue, so
	// strip/restamp must recognize their emoji (🎨 is new; 🔨/🧪 are shared).
	...Object.values(PHASE_THREAD_BADGE_PARTS).map((p) => p.emoji),
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
	add(RECONNECTING_EMOJI, RECONNECTING_WORD); // FLY-623
	// FLY-892 (Step 6): register the phase badge words so a phase badge peels
	// cleanly (🎨设计/🔨实现/🧪QA). 🔨实现 coexists with the FLY-560 🔨实现中 stage
	// word (longest-first sort peels 实现中 before 实现); 🧪QA equals the `test`
	// word (idempotent add).
	for (const { emoji, word } of Object.values(PHASE_THREAD_BADGE_PARTS)) {
		add(emoji, word);
	}
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
 * FLY-623: build the cross-cutting reconnecting badge:
 *   withWord=false → `⚠️`        (emoji only)
 *   withWord=true  → `⚠️重连中`   (emoji + short word)
 * Mirrors stageBadge()'s emoji-only vs emoji+word modes for callers that render
 * badges directly.
 */
export function reconnectingBadge(withWord: boolean): string {
	return withWord
		? `${RECONNECTING_EMOJI}${RECONNECTING_WORD}`
		: RECONNECTING_EMOJI;
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

/**
 * FLY-755/1255: the model marker is stamped as a LEADING bracket marker placed
 * after the FLY-560 stage badge and before the issue key, e.g.
 * `🧠规划 [F] [FLY-755] Title` or `🔨实现 [G] [FLY-1255] Title`.
 *
 * FLY-1255 (Plan B — Annie): every vendor folds to a single letter — Claude
 * keeps F/O/S/H, codex/GPT-5.6 → `G`, kimi → `K`. An UNvetted vendor/model that
 * has no curated letter (gemini, antigravity, or another unlisted family) is
 * still stamped with the human-readable `Model <safe-id>` namespace rather
 * than a fabricated letter, so the grammar keeps recognizing that long form
 * too. The FLY-728 tail
 * suffix (` ·F`) was invisible on mobile, where long titles truncate and the
 * tail never renders. The marker still rides the SAME thread rename as the stage
 * badge (splitStatusEmoji peels only the badge, leaving the marker at the front
 * of the base), so it never adds a Discord rate-limit rename of its own.
 *
 * Recognition and insertion are a PAIRED contract anchored on a bracketed
 * Linear issue key: the marker is only recognized when followed by `[KEY-N]`,
 * and only ever inserted in front of a base that starts with `[KEY-N]`. A
 * keyless title — even one literally starting with `[F] ` or `[infra] ` — is
 * therefore never mis-stripped or mis-stamped, and anything we insert is
 * always strippable on the next re-stamp (no double-stamp). The legacy FLY-728
 * tail form is still recognized so existing threads migrate to the front
 * marker on their next re-stamp; no proactive mass rename.
 */
const ISSUE_KEY_HEAD_RE = /^\[[A-Z][A-Z0-9]*-\d+\](?:\s|$)/;
// FLY-1255 (Plan B): the curated single-letter codes across every vendor —
// Claude F/O/S/H + codex `G` + kimi `K`. Maintained in lockstep with the
// `flywheel-config` short-code tables (`modelShortCode` + `vendorModelShortCode`).
const MODEL_MARKER_CODE_CLASS = "[FGHKOS]";
const MODEL_MARKER_PAYLOAD_RE = `[A-Za-z0-9][A-Za-z0-9._+-]{0,${RUNNER_MODEL_MARKER_PAYLOAD_MAX - 1}}`;
const MODEL_MARKER_VALUE_RE = new RegExp(
	`^(?:${MODEL_MARKER_CODE_CLASS}|Model ${MODEL_MARKER_PAYLOAD_RE})$`,
);
const MODEL_MARKER_RE = new RegExp(
	`^\\[((?:${MODEL_MARKER_CODE_CLASS}|Model ${MODEL_MARKER_PAYLOAD_RE}))\\] (?=\\[[A-Z][A-Z0-9]*-\\d+\\](?:\\s|$))`,
);
// Legacy FLY-728 tail (` ·F`) is Claude-only — `G`/`K` never shipped as a tail,
// so old-thread migration recognizes only the original F/O/S/H suffix.
const LEGACY_MODEL_SUFFIX_RE = / ·([FOSH])$/;

/** True when `base` starts with a bracketed Linear issue key (`[FLY-755] …`). */
export function hasIssueKeyHead(base: string): boolean {
	return ISSUE_KEY_HEAD_RE.test(base);
}

/**
 * Strip the leading model marker (`[F] ` before an issue key) and/or a legacy
 * FLY-728 tail suffix (` ·F`), if present. Idempotent.
 */
export function stripModelMarker(base: string): string {
	return base.replace(MODEL_MARKER_RE, "").replace(LEGACY_MODEL_SUFFIX_RE, "");
}

/**
 * Extract the model marker — the leading marker wins; the legacy F/O/S/H tail
 * suffix is the fallback (preserve path on threads not yet migrated).
 */
export function modelMarkerLabel(base: string): string | undefined {
	const front = base.match(MODEL_MARKER_RE);
	if (front) return front[1];
	const tail = base.match(LEGACY_MODEL_SUFFIX_RE);
	return tail?.[1];
}

/**
 * Ensure `base` carries exactly the given model marker at the front. Strips any
 * existing marker/legacy suffix first (idempotent + churn-safe under
 * re-stamping), then prepends `[<marker>] ` — but ONLY in front of an issue-key
 * base (see the paired contract above). Only legacy F/O/S/H or the explicit
 * `Model <safe-token>` namespace are accepted. `undefined` → no marker. Keyless
 * bases are returned marker-free either way.
 */
export function applyModelMarker(
	base: string,
	marker: string | undefined,
): string {
	const bare = stripModelMarker(base);
	return marker && MODEL_MARKER_VALUE_RE.test(marker) && hasIssueKeyHead(bare)
		? `[${marker}] ${bare}`
		: bare;
}
