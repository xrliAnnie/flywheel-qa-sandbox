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
			actor: "auto-repair-bot",
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
});
