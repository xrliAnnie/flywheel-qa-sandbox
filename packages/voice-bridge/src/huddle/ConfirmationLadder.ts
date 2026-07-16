/**
 * ConfirmationLadder (FLY-545 PR-2 P12′) — PRD §14's three action tiers, as
 * structure rather than convention:
 *
 *  (a) reversible/informational — execute immediately, narrate the result.
 *  (b) recoverable-but-consequential — spoken readback, wait for an explicit
 *      verbal yes; SILENCE IS NOT CONSENT (timeout → not executed, said so);
 *      an explicit no cancels.
 *  (c) irreversible/founder-gated — spoken readback + a TIV receipt card,
 *      and STRUCTURALLY NO EXECUTION PATH: the ladder never invokes an
 *      execute callback for tier c (there is no parameter to pass one). The
 *      receipt points at the existing founder gate; voice approval carries
 *      no authority here (A4: the FLY-546 third-signal source takes over
 *      when it lands — until then, readback + existing gate).
 *
 * Confirmation detection feeds on founder FINAL transcripts via
 * notifyFounderUtterance — affirmation/denial word lists are deliberately
 * conservative (mishearing a "对" costs a b-tier action, so only leading,
 * unambiguous forms count), and a leading yes qualified by a correction
 * marker (「好,但先别动」) is NOT consent (QA kickback R1).
 */
import {
	DENY_RE,
	isQualifiedAffirm,
	isUnconditionalAffirm,
} from "./confirm-heuristics.js";

export interface LadderSpeaker {
	/** spoken line through the host Lead's mouth. */
	speak(text: string): void;
}

export interface LadderOptions {
	speaker: LadderSpeaker;
	/** TIV receipt for tier c. */
	postReceipt: (content: string) => Promise<void>;
	/** b-tier confirmation window; default 15000ms. */
	confirmTimeoutMs?: number;
	setTimeoutFn?: typeof setTimeout;
	clearTimeoutFn?: typeof clearTimeout;
	log?: (line: string) => void;
}

export type LadderOutcome =
	| "executed"
	| "declined"
	| "timeout"
	| "receipt-posted";

interface PendingB {
	resolve: (o: LadderOutcome) => void;
	execute: () => Promise<void>;
	timer: ReturnType<typeof setTimeout>;
	description: string;
}

export class ConfirmationLadder {
	private pendingB?: PendingB;

	constructor(private readonly opts: LadderOptions) {}

	/** (a) reversible/informational: do it, then narrate. */
	async submitA(input: {
		description: string;
		execute: () => Promise<string | undefined>;
	}): Promise<LadderOutcome> {
		const narration = await input.execute();
		this.opts.speaker.speak(
			typeof narration === "string"
				? narration
				: `${input.description},弄好了。`,
		);
		return "executed";
	}

	/** (b) recoverable: readback → explicit verbal yes → execute. */
	submitB(input: {
		description: string;
		readback: string;
		execute: () => Promise<void>;
	}): Promise<LadderOutcome> {
		// one pending b-action at a time — a second submission supersedes the
		// first (the first resolves "declined" so its caller never hangs).
		if (this.pendingB) this.settleB("declined");
		this.opts.speaker.speak(`${input.readback} 对吧?`);
		const st = this.opts.setTimeoutFn ?? setTimeout;
		return new Promise<LadderOutcome>((resolve) => {
			const timer = st(() => {
				// silence ≠ consent (PRD §14) — say so, do nothing.
				this.pendingB = undefined;
				this.opts.speaker.speak("没听到确认,这个先不动。要做的话再说一次。");
				resolve("timeout");
			}, this.opts.confirmTimeoutMs ?? 15_000);
			timer.unref?.();
			this.pendingB = {
				resolve,
				execute: input.execute,
				timer,
				description: input.description,
			};
		});
	}

	/** (c) irreversible: readback + receipt; NO execution path exists here. */
	async submitC(input: {
		description: string;
		readback: string;
	}): Promise<LadderOutcome> {
		this.opts.speaker.speak(
			`${input.readback} — 这个是不可逆动作,我把确认卡贴到文字区了,你在 Discord 上照常走审批;语音里说「批准」不算数。`,
		);
		await this.opts.postReceipt(
			[
				"🧾 **不可逆动作确认卡(语音只送达,不授权)**",
				`- 动作: ${input.description}`,
				"- 执行路径: 现有 founder gate(reaction / verify-approval)照旧",
				"- 本卡片只是把 gate 端到你面前;语音「确认」不构成批准(FLY-175/FLY-945 口径)",
			].join("\n"),
		);
		return "receipt-posted";
	}

	/** feed founder FINAL transcripts; resolves a pending b-tier action. */
	notifyFounderUtterance(text: string): void {
		if (!this.pendingB) return;
		const t = text.trim();
		if (isUnconditionalAffirm(t)) {
			const pending = this.pendingB;
			this.pendingB = undefined;
			clearTimeout(pending.timer);
			void pending
				.execute()
				.then(() => {
					this.opts.speaker.speak("好,做了。");
					pending.resolve("executed");
				})
				.catch((err) => {
					this.opts.log?.(
						`[ladder] b-tier execute failed: ${err instanceof Error ? err.message : String(err)}`,
					);
					this.opts.speaker.speak("动手的时候出错了,先没做成,细节在文字区。");
					pending.resolve("declined");
				});
			return;
		}
		if (DENY_RE.test(t) || isQualifiedAffirm(t)) {
			// a hard no, OR a yes-with-a-but (「好,但先别动」) — QA kickback R1:
			// the qualified form used to execute against her decline. Declining
			// (not silently waiting) gives her immediate audible feedback; she
			// can re-issue the action once the caveat is sorted.
			this.opts.speaker.speak("行,不动。");
			this.settleB("declined");
		}
		// anything else: keep waiting — the window closes on timeout.
	}

	/** true while a b-tier confirmation window is open. */
	get awaitingConfirmation(): boolean {
		return this.pendingB !== undefined;
	}

	private settleB(outcome: LadderOutcome): void {
		const pending = this.pendingB;
		if (!pending) return;
		this.pendingB = undefined;
		clearTimeout(pending.timer);
		pending.resolve(outcome);
	}
}
