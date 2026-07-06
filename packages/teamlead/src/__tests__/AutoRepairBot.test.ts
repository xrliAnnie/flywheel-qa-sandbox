/**
 * FLY-368: AutoRepairBot — conservative dispatch to the two safe actions only.
 */
import { describe, expect, it, vi } from "vitest";
import { AutoRepairBot } from "../bridge/AutoRepairBot.js";
import type { AlertPayload } from "../LeadAlertNotifier.js";

function payload(over: Partial<AlertPayload> = {}): AlertPayload {
	return {
		leadId: "tadashi",
		projectName: "flywheel",
		eventId: "evt-1",
		eventType: "pane_hash_stuck",
		title: "t",
		body: "b",
		severity: "warning",
		...over,
	};
}

function makeBot(
	over: {
		runnerNudge?: ReturnType<typeof vi.fn>;
		leadResumeEnter?: ReturnType<typeof vi.fn>;
		accountSwitch?: {
			canAttempt: ReturnType<typeof vi.fn>;
			enqueue: ReturnType<typeof vi.fn>;
			executeSwitch: ReturnType<typeof vi.fn>;
		};
	} = {},
) {
	const runnerNudge =
		over.runnerNudge ??
		vi.fn(async () => ({
			status: 200,
			body: { nudged: true, tmuxWindow: "w:@1" },
		}));
	const leadResumeEnter =
		over.leadResumeEnter ??
		vi.fn(async () => ({ sent: true, reason: "Enter sent" }));
	const bot = new AutoRepairBot({
		runnerNudge: runnerNudge as never,
		leadResumeEnter: leadResumeEnter as never,
		accountSwitch: over.accountSwitch as never,
		logger: () => {},
	});
	return { bot, runnerNudge, leadResumeEnter };
}

describe("AutoRepairBot (FLY-368)", () => {
	const CK = "flywheel|tadashi|pane_hash_stuck|";

	it("runner_stuck_unhandled WITH structured fingerprint → nudges → attempted", async () => {
		const { bot, runnerNudge } = makeBot();
		const r = await bot.attempt(
			payload({
				eventType: "runner_stuck_unhandled",
				metadata: {
					runnerStuck: {
						executionId: "exec-9",
						episodeFingerprint: "abcdef0123456789",
					},
				},
			}),
			CK,
		);
		expect(r.outcome).toBe("attempted");
		expect(r.action).toBe("runner_nudge");
		expect(runnerNudge).toHaveBeenCalledTimes(1);
		expect(runnerNudge.mock.calls[0]![0]).toMatchObject({
			actor: "aunt-cass",
			executionId: "exec-9",
			fingerprint: "abcdef0123456789",
			phrase: "continue",
		});
	});

	it("runner_stuck_unhandled WITHOUT structured fingerprint → needs_human, no nudge", async () => {
		const { bot, runnerNudge } = makeBot();
		const r = await bot.attempt(
			payload({ eventType: "runner_stuck_unhandled" }),
			CK,
		);
		expect(r.outcome).toBe("needs_human");
		expect(runnerNudge).not.toHaveBeenCalled();
	});

	it("runner nudge refused by a gate → needs_human", async () => {
		const runnerNudge = vi.fn(async () => ({
			status: 409,
			body: { nudged: false, error: "fingerprint mismatch" },
		}));
		const { bot } = makeBot({ runnerNudge });
		const r = await bot.attempt(
			payload({
				eventType: "runner_stuck_unhandled",
				metadata: {
					runnerStuck: {
						executionId: "exec-9",
						episodeFingerprint: "abcdef0123456789",
					},
				},
			}),
			CK,
		);
		expect(r.outcome).toBe("needs_human");
		expect(r.detail).toContain("fingerprint mismatch");
	});

	it("pane_hash_stuck → tries lead resume Enter → attempted when sent", async () => {
		const { bot, leadResumeEnter } = makeBot();
		const r = await bot.attempt(payload({ eventType: "pane_hash_stuck" }), CK);
		expect(r.outcome).toBe("attempted");
		expect(r.action).toBe("lead_resume_enter");
		expect(leadResumeEnter).toHaveBeenCalledTimes(1);
	});

	it("pane_hash_stuck but not a resume menu → needs_human", async () => {
		const leadResumeEnter = vi.fn(async () => ({
			sent: false,
			reason: "not the safe resume-menu shape",
		}));
		const { bot } = makeBot({ leadResumeEnter });
		const r = await bot.attempt(payload({ eventType: "pane_hash_stuck" }), CK);
		expect(r.outcome).toBe("needs_human");
		expect(r.detail).toContain("resume-menu");
	});

	it.each([
		"rate_limit",
		"usage_limit",
		"login_expired",
		"permission_blocked",
	] as const)(
		"%s → never auto-acted, needs_human (no nudge / no enter)",
		async (eventType) => {
			const { bot, runnerNudge, leadResumeEnter } = makeBot();
			const r = await bot.attempt(payload({ eventType }), CK);
			expect(r.outcome).toBe("needs_human");
			expect(r.action).toBe("none");
			expect(runnerNudge).not.toHaveBeenCalled();
			expect(leadResumeEnter).not.toHaveBeenCalled();
		},
	);

	// FLY-368 v1.58.0: canAttempt — pure predicate the Hub uses to word the ack
	// honestly (only the two kinds the bot truly tries get "正在尝试自动修复…").
	it("canAttempt is true only for the two repairable kinds (no accountSwitch)", () => {
		const { bot } = makeBot();
		expect(
			bot.canAttempt(payload({ eventType: "runner_stuck_unhandled" })),
		).toBe(true);
		expect(bot.canAttempt(payload({ eventType: "pane_hash_stuck" }))).toBe(
			true,
		);
		for (const k of [
			"rate_limit",
			"usage_limit",
			"login_expired",
			"permission_blocked",
			"crash_loop",
		] as const) {
			expect(bot.canAttempt(payload({ eventType: k }))).toBe(false);
		}
	});

	// FLY-368 v1.58.0 (Codex LOW-1): canAttempt and attempt() must agree so the ack
	// never claims a repair the bot won't try. Any kind canAttempt rejects → attempt
	// returns needs_human / action:"none".
	it("canAttempt(false) kinds always resolve to needs_human in attempt()", async () => {
		const { bot } = makeBot();
		for (const k of [
			"rate_limit",
			"usage_limit",
			"login_expired",
			"permission_blocked",
			"crash_loop",
		] as const) {
			expect(bot.canAttempt(payload({ eventType: k }))).toBe(false);
			const r = await bot.attempt(payload({ eventType: k }), CK);
			expect(r.outcome).toBe("needs_human");
			expect(r.action).toBe("none");
		}
	});

	// FLY-696: usage_limit becomes attemptable when the account-switch repair is
	// wired AND says so — canAttempt/attempt delegate to it, kept in sync.
	it("usage_limit with a wired attemptable accountSwitch → enqueues the switch", async () => {
		const accountSwitch = {
			canAttempt: vi.fn(() => true),
			enqueue: vi.fn(async () => ({
				outcome: "attempted" as const,
				action: "account_switch",
				detail: "🔧 已排队 Claude 账号切换（from personal）",
			})),
			executeSwitch: vi.fn(),
		};
		const { bot } = makeBot({ accountSwitch });
		expect(bot.canAttempt(payload({ eventType: "usage_limit" }))).toBe(true);
		const r = await bot.attempt(payload({ eventType: "usage_limit" }), CK);
		expect(r.outcome).toBe("attempted");
		expect(r.action).toBe("account_switch");
		expect(accountSwitch.enqueue).toHaveBeenCalledTimes(1);
	});

	it("usage_limit but accountSwitch not attemptable → needs_human, no enqueue", async () => {
		const accountSwitch = {
			canAttempt: vi.fn(() => false),
			enqueue: vi.fn(),
			executeSwitch: vi.fn(),
		};
		const { bot } = makeBot({ accountSwitch });
		expect(bot.canAttempt(payload({ eventType: "usage_limit" }))).toBe(false);
		const r = await bot.attempt(payload({ eventType: "usage_limit" }), CK);
		expect(r.outcome).toBe("needs_human");
		expect(accountSwitch.enqueue).not.toHaveBeenCalled();
	});

	it("usage_limit with NO accountSwitch dep → needs_human (byte-compat)", async () => {
		const { bot } = makeBot();
		const r = await bot.attempt(payload({ eventType: "usage_limit" }), CK);
		expect(r.outcome).toBe("needs_human");
		expect(r.action).toBe("none");
	});

	// FLY-368 v1.58.0 (Plan C): the bot's needs_human detail is now reason-ONLY —
	// the Hub owns the "🙋 @Annie …" framing + the real ping. The bot must not bake
	// in its own "需要 Annie" text (would double up under the Hub's wrapper).
	it("needs_human detail carries the reason only (no '需要 Annie' prefix)", async () => {
		const { bot } = makeBot();
		const r = await bot.attempt(payload({ eventType: "rate_limit" }), CK);
		expect(r.outcome).toBe("needs_human");
		expect(r.detail).not.toContain("需要 Annie");
		expect(r.detail.length).toBeGreaterThan(0);
	});
});
