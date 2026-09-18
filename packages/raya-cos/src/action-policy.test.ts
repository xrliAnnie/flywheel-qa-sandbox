import { describe, expect, it } from "vitest";
import { evaluateActionPolicy } from "./action-policy.js";
import { readbackRequired } from "./readback-policy.js";

describe("CoS action policy", () => {
	it("keeps merge, deployment, and ship outside autonomous CoS authority", () => {
		for (const action of ["merge", "deploy", "ship"] as const) {
			expect(evaluateActionPolicy({ action, actor: "founder" })).toEqual({
				status: "external_authority_required",
				action,
			});
		}
	});

	it("requires attributed current-session readback for consequential proposals", () => {
		expect(
			readbackRequired({
				action: "ship",
				attributedToFounder: true,
				currentSession: true,
			}),
		).toBe(true);
		expect(
			readbackRequired({
				action: "note",
				attributedToFounder: false,
				currentSession: false,
			}),
		).toBe(false);
	});
});
