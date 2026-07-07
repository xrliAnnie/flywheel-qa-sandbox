/**
 * FLY-927 (Task 2.4): T2 decision matrix (pure) + owner-configured predicate.
 */
import { describe, expect, it } from "vitest";
import {
	DEFAULT_TICKET_ESCALATION_POLICY,
	decideTicketEscalation,
	ticketOwnerConfigured,
} from "../ticket-escalation.js";

const NOW = Date.UTC(2026, 6, 7, 12, 0, 0);
const AGE = (ms: number): string =>
	new Date(NOW - ms).toISOString().replace("T", " ").slice(0, 19);

function row(over: Partial<Parameters<typeof decideTicketEscalation>[0]> = {}) {
	return {
		ticket_status: "NEW",
		attempt_count: 0,
		first_seen_at: AGE(60_000),
		acked_at: null,
		...over,
	};
}

describe("decideTicketEscalation (T2 locked: 2 tries / 5 min)", () => {
	it("legacy (NULL) and terminal states never escalate", () => {
		for (const s of [null, "RESOLVED", "ESCALATED"]) {
			expect(decideTicketEscalation(row({ ticket_status: s }), NOW, true)).toBe(
				"none",
			);
		}
	});

	it("REPAIRING under budget → retry (second attempt, gates intact)", () => {
		expect(
			decideTicketEscalation(
				row({ ticket_status: "REPAIRING", attempt_count: 1 }),
				NOW,
				true,
			),
		).toBe("retry");
	});

	it("REPAIRING with the attempt budget burned → escalate", () => {
		expect(
			decideTicketEscalation(
				row({ ticket_status: "REPAIRING", attempt_count: 2 }),
				NOW,
				true,
			),
		).toBe("escalate");
	});

	it("REPAIRING/ACK past the 5-minute window → escalate regardless of attempts", () => {
		for (const s of ["REPAIRING", "ACK"]) {
			expect(
				decideTicketEscalation(
					row({
						ticket_status: s,
						attempt_count: 0,
						first_seen_at: AGE(6 * 60_000),
					}),
					NOW,
					true,
				),
			).toBe("escalate");
		}
	});

	it("ACK within the window → none (the owner bot is working)", () => {
		expect(
			decideTicketEscalation(row({ ticket_status: "ACK" }), NOW, true),
		).toBe("none");
	});

	it("NEW unclaimed > 5 min WITH a configured owner → escalate", () => {
		expect(
			decideTicketEscalation(
				row({ first_seen_at: AGE(6 * 60_000) }),
				NOW,
				true,
			),
		).toBe("escalate");
	});

	it("NEW unclaimed but owner NOT configured → none (Cass status quo, FLY-928 flip)", () => {
		expect(
			decideTicketEscalation(
				row({ first_seen_at: AGE(60 * 60_000) }),
				NOW,
				false,
			),
		).toBe("none");
	});

	it("missing first_seen_at is treated as age 0 (no premature escalation)", () => {
		expect(
			decideTicketEscalation(row({ first_seen_at: null }), NOW, true),
		).toBe("none");
	});

	it("locked defaults: 2 attempts / 300s", () => {
		expect(DEFAULT_TICKET_ESCALATION_POLICY).toEqual({
			maxAttempts: 2,
			timeoutMs: 300_000,
			unclaimedMs: 300_000,
		});
	});
});

describe("ticketOwnerConfigured", () => {
	const REG = { claudeBotUserId: "111111111111111111", codexBotUserId: null };
	it("matches the owner side's env id presence", () => {
		expect(ticketOwnerConfigured("infra_bot:claude", REG)).toBe(true);
		expect(ticketOwnerConfigured("infra_bot:codex", REG)).toBe(false);
	});
	it("lead / empty / null owner refs never arm the fallback", () => {
		expect(ticketOwnerConfigured("lead:tadashi", REG)).toBe(false);
		expect(ticketOwnerConfigured("", REG)).toBe(false);
		expect(ticketOwnerConfigured(null, REG)).toBe(false);
	});
});
