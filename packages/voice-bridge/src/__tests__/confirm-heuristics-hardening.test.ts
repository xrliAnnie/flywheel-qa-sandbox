/**
 * FLY-545 Codex R8 hardening — the correction-marker BLACKLIST could not close
 * the consent leak (「对,漏一条 action」/「对,第二条要改到下周三」 slip past any
 * finite marker list), so consent is judged by residue: an utterance is a yes
 * ONLY when nothing but agreement tokens and filler remains. These tests pin
 * Codex's leak examples at unit level AND through both real consumers, plus
 * the R8 MEDIUM: a concluding correction's journal entry must exclude BOTH
 * first-hand parties (host via the control turn, addressed via its own ears).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddressRouter } from "../huddle/AddressRouter.js";
import { ConfirmationLadder } from "../huddle/ConfirmationLadder.js";
import {
	isQualifiedAffirm,
	isUnconditionalAffirm,
} from "../huddle/confirm-heuristics.js";
import { FeedPipeline } from "../huddle/FeedPipeline.js";
import { type HuddleLine, HuddleSession } from "../huddle/HuddleSession.js";

describe("isUnconditionalAffirm — residue judgment", () => {
	const cleanYes = [
		"对",
		"好的",
		"确认",
		"确认,批准",
		"对,没问题",
		"嗯对,就这样",
		"ok",
		"yes, sure",
		"对对,没错!",
	];
	for (const u of cleanYes) {
		it(`clean 「${u}」 → consent`, () => {
			expect(isUnconditionalAffirm(u)).toBe(true);
			expect(isQualifiedAffirm(u)).toBe(false);
		});
	}

	const qualified = [
		// original QA kickback set
		"对,不过第二条改成下周三",
		"好,但时间不对",
		"可以,不过先别建 worktree",
		"是这样,但还差一条 action",
		"好,但先别动",
		// Codex R8 leaks — no marker word, pure content after the yes
		"对,漏一条 action",
		"对,第二条要改到下周三",
		"好,只是第二条时间挪一下",
		"对,再加一条:周五对齐",
		// Codex R9 leaks — global token deletion destroyed the syntax
		"是吧", // modal doubt, not consent
		"可以是可以", // concessive frame, implies 但是…
		"行是行",
		"好吧", // reluctant modal — fail closed
		// Codex R10 leaks — a separator must not hide the concessive frame
		"可以是,可以",
		"行 是行",
		"好,是好",
		"没问题,是没问题",
		// Codex R11 leaks — the concessive X must be unbounded, not ≤4 chars
		"确认没问题,是确认没问题",
		"确认没毛病是确认没毛病",
		"就这样办没问题是就这样办没问题",
	];
	for (const u of qualified) {
		it(`qualified 「${u}」 → NOT consent`, () => {
			expect(isUnconditionalAffirm(u)).toBe(false);
			expect(isQualifiedAffirm(u)).toBe(true);
		});
	}

	it("a non-affirm opener is neither (correction path / keep waiting)", () => {
		expect(isUnconditionalAffirm("只是第二条要改")).toBe(false);
		expect(isQualifiedAffirm("只是第二条要改")).toBe(false);
	});
});

// ---- consumer harness (mirrors the QA kickback suite's fakes) ----

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
	return { session, feed, land };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("HuddleSession — Codex R8/R9 leak utterances stay in concluding", () => {
	for (const u of [
		"对,漏一条 action",
		"对,第二条要改到下周三",
		"是吧",
		"可以是,可以",
		"确认没问题,是确认没问题",
	]) {
		it(`「${u}」 does not land`, () => {
			const { session, land } = setupHuddle();
			session.start();
			session.handleFounderVoiceState(true);
			session.handleLineTranscript("eng", {
				role: "user",
				text: "好,就这样吧",
				final: true,
			});
			expect(session.currentState).toBe("concluding");
			session.handleLineTranscript("eng", {
				role: "user",
				text: u,
				final: true,
			});
			expect(land).not.toHaveBeenCalled();
			expect(session.currentState).toBe("concluding");
		});
	}

	it("a concluding correction's journal entry excludes host AND addressed (R8 MEDIUM)", () => {
		const { session, feed } = setupHuddle();
		session.start();
		session.handleFounderVoiceState(true);
		// hand the floor to Hiro so the ADDRESSED line is not the host
		session.handleLineTranscript("eng", {
			role: "user",
			text: "Hiro,内存这块你怎么看?",
			final: true,
		});
		// concluding + the correction both arrive via the addressed line (joy)
		session.handleLineTranscript("joy", {
			role: "user",
			text: "就这样",
			final: true,
		});
		expect(session.currentState).toBe("concluding");
		session.handleLineTranscript("joy", {
			role: "user",
			text: "对,不过第二条改成下周三",
			final: true,
		});
		const last = feed.entries().at(-1);
		expect(last?.text).toBe("对,不过第二条改成下周三");
		// both first-hand parties excluded: joy heard it, eng gets it verbatim
		// in the control turn — a silent re-feed would double-deliver.
		expect([...(last?.exclude ?? [])].sort()).toEqual(["eng", "joy"]);
	});
});

describe("ConfirmationLadder — Codex R8/R9 leak utterances do not execute", () => {
	for (const u of [
		"对,漏一条 action",
		"对,第二条要改到下周三",
		"可以是可以",
		"行 是行",
		"确认没毛病是确认没毛病",
	]) {
		it(`「${u}」 declines the b-tier action`, async () => {
			const speak = vi.fn();
			const execute = vi.fn(async () => {});
			const ladder = new ConfirmationLadder({
				speaker: { speak },
				postReceipt: vi.fn(async () => {}),
			});
			const p = ladder.submitB({
				description: "关掉 runner",
				readback: "我把那个 runner 关掉",
				execute,
			});
			ladder.notifyFounderUtterance(u);
			await vi.advanceTimersByTimeAsync(0);
			expect(execute).not.toHaveBeenCalled();
			expect(speak).toHaveBeenCalledWith("行,不动。");
			await expect(p).resolves.toBe("declined");
		});
	}
});
