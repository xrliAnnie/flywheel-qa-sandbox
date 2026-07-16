/**
 * huddleTiv (FLY-545) — the /meet huddle's face over the SHARED TivPresenter
 * (discord/TivPresenter.ts, landed by FLY-1065 as the common /gemini + /meet +
 * /gemini-advanced text-panel surface; 谁后落谁抽 — /meet landed second, so
 * this adapter is the 抽).
 *
 * What the huddle needs that the shared presenter expresses differently:
 *  - presence(state, detail): a fixed state vocabulary (connecting/listening/
 *    thinking/speaking/paused) rendered as one emoji status line → status().
 *    "connecting" is the QA-R2 F2a state: while the meeting assembles, the
 *    panel MUST say "先别说话" or the founder talks into a half-built meeting
 *    and gets swallowed (the F1 abort window).
 *  - caption(speaker, text): MULTIPLE speakers (founder + per-lead display
 *    names) → the presenter's caption with nameOverride, keeping its
 *    scrub/truncation discipline.
 *  - warn(text) → error() (fail-visible, fire-and-forget).
 *  - card(content): AWAITED — conclusion/receipt cards are proof the landing
 *    posted, so they bypass the throttled status machinery and post directly.
 */
import type { TivPresenter } from "../discord/TivPresenter.js";

export type HuddlePresence =
	| "connecting" // assembly window (QA R2 F2a): "don't talk yet"
	| "listening"
	| "thinking"
	| "speaking"
	| "paused";

export const PRESENCE_LINE: Record<HuddlePresence, string> = {
	connecting: "🔌 连接中(先别说话)",
	listening: "🎙 在听",
	thinking: "🧠 在想",
	speaking: "💬 在说",
	paused: "⏸ 已暂停",
};

export interface HuddleTivPort {
	presence(state: HuddlePresence, detail?: string): void;
	caption(speaker: string, text: string): void;
	warn(text: string): void;
	/** awaited by callers that need posting proof (conclusion cards). */
	card(content: string): Promise<void>;
}

export interface HuddleTivOptions {
	presenter: TivPresenter;
	/** which caption speaker is the founder (default "Annie"). */
	founderName?: string;
	/** direct awaited post for cards (no throttle, no anchor). */
	postCard: (content: string) => Promise<void>;
}

export function createHuddleTiv(opts: HuddleTivOptions): HuddleTivPort {
	const founderName = opts.founderName ?? "Annie";
	return {
		presence(state, detail) {
			const line = detail
				? `${PRESENCE_LINE[state]} · ${detail}`
				: PRESENCE_LINE[state];
			opts.presenter.status(line);
		},
		caption(speaker, text) {
			const role = speaker === founderName ? "user" : "assistant";
			opts.presenter.caption(role, text, speaker);
		},
		warn(text) {
			opts.presenter.error(text);
		},
		async card(content) {
			await opts.postCard(content);
		},
	};
}
