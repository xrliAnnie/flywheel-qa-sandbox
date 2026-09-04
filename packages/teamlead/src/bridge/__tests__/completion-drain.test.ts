import { describe, expect, it } from "vitest";
import { parseCompletionDrainEnvelope } from "../completion-drain.js";

describe("completion drain envelope", () => {
	it("rejects a malformed challenge id instead of admitting it to authority lookup", () => {
		expect(
			parseCompletionDrainEnvelope({
				decision: { route: "needs_review" },
				drainReceipt: { challengeId: " \n" },
			}),
		).toEqual({ ok: false, reason: "drain_receipt_rejected" });
	});
});
