/**
 * FLY-545 QA (Opus, DAG workflow QA phase) — KICKBACK evidence.
 *
 * Finding: the confirmation heuristic mis-reads an AFFIRM-LEADING correction /
 * partial-agreement as a full "yes". Both confirmation surfaces share the same
 * root cause:
 *
 *   AFFIRM = /^(对|是|确认|可以|好的|好|行|...)/  — anchored to the START only,
 *
 * so a very common founder response to a recap's "…对吗?" —
 *   「对,不过第二条改成下周三」 / 「好,但时间不对」 / 「可以,不过先别建 worktree」
 * — matches on its leading 对/好/可以 and is treated as an unconditional YES,
 * even though the rest of the sentence is a correction. AFFIRM is also tested
 * BEFORE DENY, so "yes-but-no" always resolves to yes.
 *
 * Impact (plan §C "关键在 recap 合同措辞", the flow's highest-stakes moment):
 *  - HuddleSession.concluding: landNow(confirmed=true) fires immediately. The
 *    host never re-recaps, and (because concluding utterances are NOT appended
 *    to the feed journal) her correction is dropped from the summary entirely —
 *    a wrong artifact lands marked confirmed, worktree is built, issue → Done.
 *  - ConfirmationLadder.submitB (b-tier, "recoverable-but-consequential"):
 *    execute() runs even though she was declining/qualifying the action.
 *
 * These tests assert the CORRECT expected behavior (an affirm-leading
 * correction must NOT count as consent) and therefore FAIL against the current
 * head — that RED is the kickback evidence for the implement phase.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddressRouter } from "../huddle/AddressRouter.js";
import { ConfirmationLadder } from "../huddle/ConfirmationLadder.js";
import { FeedPipeline } from "../huddle/FeedPipeline.js";
import { type HuddleLine, HuddleSession } from "../huddle/HuddleSession.js";

const issue = { id: "u1", identifier: "FLY-1234", url: "https://l/1234" };

class FakeLine implements HuddleLine {
	session = {
		texts: [] as string[],
		injected: [] as string[],
		interrupts: 0,
		sendAudio: () => {},
		sendText: (t: string) => void this.session.texts.push(t),
		injectContext: (t: string) => void this.session.injected.push(t),
		interrupt: () => void this.session.interrupts++,
	};
	mouth = {
		beginTurn: () => {},
		feed: () => {},
		endTurn: () => {},
		flush: () => {},
		noteToolCall: () => {},
		noteToolResolved: () => {},
	};
	constructor(
		readonly leadId: string,
		readonly displayName: string,
	) {}
}

function setupHuddle() {
	const tadashi = new FakeLine("eng", "Tadashi");
	const hiro = new FakeLine("joy", "Hiro");
	const feed = new FeedPipeline({
		now: () => new Date("2026-07-09T00:00:00Z"),
	});
	const land = vi.fn(async () => "landed" as const);
	const session = new HuddleSession({
		issue,
		hostLeadId: "eng",
		lines: [tadashi, hiro],
		router: new AddressRouter(
			[
				{ leadId: "eng", aliases: ["Tadashi"] },
				{ leadId: "joy", aliases: ["Hiro"] },
			],
			"eng",
		),
		feed,
		ladder: { notifyFounderUtterance: vi.fn() },
		tiv: { presence: vi.fn(), caption: vi.fn(), warn: vi.fn() },
		conclusion: { land, abortNoShow: vi.fn(async () => {}) },
		onTeardown: vi.fn(),
		assembleTimeoutMs: 600_000,
	});
	const founderSays = (text: string) =>
		session.handleLineTranscript("eng", { role: "user", text, final: true });
	return { session, founderSays, land };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("FLY-545 QA — recap confirm must not accept an affirm-leading correction", () => {
	// Each of these is a natural response to the host's "…对吗?" that AGREES on
	// the leading token but then corrects — it must NOT be an unconditional land.
	const affirmLeadingCorrections = [
		"对,不过第二条改成下周三",
		"好,但时间不对",
		"可以,不过先别建 worktree",
		"是这样,但还差一条 action",
	];

	for (const utterance of affirmLeadingCorrections) {
		it(`「${utterance}」 → correction, stays concluding, no landing`, () => {
			const { session, founderSays, land } = setupHuddle();
			session.start();
			session.handleFounderVoiceState(true);
			founderSays("好,就这样吧"); // → concluding, host recaps
			expect(session.currentState).toBe("concluding");

			founderSays(utterance);

			// It qualifies/corrects the recap — it is NOT consent to land.
			expect(land).not.toHaveBeenCalled();
			expect(session.currentState).toBe("concluding");
		});
	}

	it("a clean 「对,没问题」 still lands (no false negative)", async () => {
		const { session, founderSays, land } = setupHuddle();
		session.start();
		session.handleFounderVoiceState(true);
		founderSays("就这样");
		founderSays("对,没问题");
		await vi.runAllTimersAsync();
		expect(land).toHaveBeenCalledWith(
			expect.objectContaining({ confirmed: true }),
		);
	});
});

describe("FLY-545 QA re-test — adversarial edge probe (fix must hold)", () => {
	// leading-yes utterances that CARRY a correction/qualification/concession —
	// none may land the meeting. Probes beyond the original kickback set:
	// compound agreement + late correction, marker-less omission, concessive
	// frame, modal doubt, English mixed.
	const mustNotLand = [
		"对,再等等", // yes, but hold on
		"行吧,不过我再想想", // fine-ish, but let me think
		"好,除了第三条", // ok, except item 3
		"是这样没错,但漏了 Hiro", // right, but Hiro's item is missing
		"对对对,但时间改一下", // yes-yes-yes BUT change the time (compound + late but)
		"可以是可以,但是", // concessive 可以是可以 → implies 但是
		"嗯,那个第二条呢", // mm, what about item 2 (leading 嗯 + question)
		"yes but change the date",
		"ok, hold on",
	];
	for (const utterance of mustNotLand) {
		it(`「${utterance}」 does NOT land the meeting`, () => {
			const { session, founderSays, land } = setupHuddle();
			session.start();
			session.handleFounderVoiceState(true);
			founderSays("就这样");
			expect(session.currentState).toBe("concluding");
			founderSays(utterance);
			expect(land).not.toHaveBeenCalled();
			expect(session.currentState).toBe("concluding");
		});
	}

	// clean affirmatives that MUST still land — guards the fix from
	// over-correcting into false negatives.
	const mustLand = [
		"对",
		"对的",
		"好的",
		"确认",
		"没问题",
		"就这样",
		"对对对",
		"好的,就这样",
		"确认没问题",
		"yes",
	];
	for (const utterance of mustLand) {
		it(`「${utterance}」 still lands (no false negative)`, async () => {
			const { session, founderSays, land } = setupHuddle();
			session.start();
			session.handleFounderVoiceState(true);
			founderSays("就这样");
			founderSays(utterance);
			await vi.runAllTimersAsync();
			expect(land).toHaveBeenCalledWith(
				expect.objectContaining({ confirmed: true }),
			);
		});
	}
});

describe("FLY-545 QA — b-tier ladder must not execute on an affirm-leading decline", () => {
	it("「好,但先别动」 does NOT execute the b-tier action", async () => {
		const execute = vi.fn(async () => {});
		const ladder = new ConfirmationLadder({
			speaker: { speak: vi.fn() },
			postReceipt: vi.fn(async () => {}),
		});
		const p = ladder.submitB({
			description: "关掉 runner",
			readback: "我把那个 runner 关掉",
			execute,
		});
		// she qualifies with "但先别动" (but hold off) — silence≠consent, and this
		// is not consent either.
		ladder.notifyFounderUtterance("好,但先别动");
		await vi.advanceTimersByTimeAsync(0);
		expect(execute).not.toHaveBeenCalled();
		// window is still open (or declined) — but the action must not have run.
		void p;
	});
});
