/**
 * FLY-927 (Task 2.4): bounded repair retry decision matrix (pure).
 */
import { describe, expect, it } from "vitest";
import {
	DEFAULT_TICKET_ESCALATION_POLICY,
	decideTicketEscalation,
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

describe("decideTicketEscalation (no automatic escalation)", () => {
	it("legacy (NULL) and terminal states never escalate", () => {
		for (const s of [null, "RESOLVED", "ESCALATED"]) {
			expect(decideTicketEscalation(row({ ticket_status: s }), NOW)).toBe(
				"none",
			);
		}
	});

	it("REPAIRING under budget → retry (second attempt, gates intact)", () => {
		expect(
			decideTicketEscalation(
				row({ ticket_status: "REPAIRING", attempt_count: 1 }),
				NOW,
			),
		).toBe("retry");
	});

	it("REPAIRING with the attempt budget burned → none", () => {
		expect(
			decideTicketEscalation(
				row({ ticket_status: "REPAIRING", attempt_count: 2 }),
				NOW,
			),
		).toBe("none");
	});

	it("REPAIRING/ACK past the timeout → none", () => {
		for (const s of ["REPAIRING", "ACK"]) {
			expect(
				decideTicketEscalation(
					row({
						ticket_status: s,
						attempt_count: 0,
						first_seen_at: AGE(6 * 60_000),
					}),
					NOW,
				),
			).toBe("none");
		}
	});

	it("ACK within the window → none (the owner bot is working)", () => {
		expect(decideTicketEscalation(row({ ticket_status: "ACK" }), NOW)).toBe(
			"none",
		);
	});

	it("MONITORING ignores unclaimed fallback and waits for the kind timeout", () => {
		const policy = {
			...DEFAULT_TICKET_ESCALATION_POLICY,
			timeoutMs: 30 * 60_000,
		};
		expect(
			decideTicketEscalation(
				row({ ticket_status: "MONITORING", first_seen_at: AGE(10 * 60_000) }),
				NOW,
				policy,
			),
		).toBe("none");
		expect(
			decideTicketEscalation(
				row({ ticket_status: "MONITORING", first_seen_at: AGE(31 * 60_000) }),
				NOW,
				policy,
			),
		).toBe("none");
	});

	it("NEW remains visible without an automatic fallback", () => {
		expect(
			decideTicketEscalation(row({ first_seen_at: AGE(6 * 60_000) }), NOW),
		).toBe("none");
	});

	it("missing or invalid first_seen_at fails closed before retry", () => {
		for (const first_seen_at of [null, "garbage"]) {
			expect(
				decideTicketEscalation(
					row({ ticket_status: "REPAIRING", first_seen_at }),
					NOW,
				),
			).toBe("none");
		}
	});

	it("locked defaults: 2 attempts / 300s", () => {
		expect(DEFAULT_TICKET_ESCALATION_POLICY).toEqual({
			maxAttempts: 2,
			timeoutMs: 300_000,
		});
	});
});
