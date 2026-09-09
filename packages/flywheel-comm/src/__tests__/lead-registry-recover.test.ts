import {
	classifyRecovery,
	type LeadRegistryRecoveryError,
} from "../lead-registry-recover.js";

const BEFORE_PROJECTS = "a".repeat(64);
const BEFORE_RECEIPT = "b".repeat(64);
const PLANNED_PROJECTS = "c".repeat(64);
const PLANNED_RECEIPT = "d".repeat(64);

function intent(phase: "pending" | "done" = "pending") {
	return {
		schemaVersion: 1 as const,
		phase,
		leadKey: "raya-raya-product-lead",
		startedAt: "2026-09-08T02:00:00.000Z",
		projectsShaBefore: BEFORE_PROJECTS,
		receiptDigestBefore: BEFORE_RECEIPT,
		projectsShaPlanned: PLANNED_PROJECTS,
		receiptDigestPlanned: PLANNED_RECEIPT,
		backups: { projects: "/tmp/projects.bak", receipt: "/tmp/receipt.bak" },
	};
}

describe("classifyRecovery", () => {
	it("classifies a missing intent as no recovery work", () => {
		expect(classifyRecovery(undefined, "projects", "receipt", false)).toEqual({
			state: "none",
		});
	});

	it("rejects an invalid intent schema", () => {
		expect(() =>
			classifyRecovery(
				{ ...intent(), schemaVersion: 2 },
				BEFORE_PROJECTS,
				BEFORE_RECEIPT,
				false,
			),
		).toThrowError(
			expect.objectContaining<Partial<LeadRegistryRecoveryError>>({
				code: "lead_registry_intent_invalid",
			}),
		);
	});

	it("discards a done intent left behind during cleanup", () => {
		expect(
			classifyRecovery(
				intent("done"),
				"external-projects",
				"external-receipt",
				false,
			).state,
		).toBe("discard_done");
	});

	it("discards a pending intent when neither image was written", () => {
		expect(
			classifyRecovery(intent(), BEFORE_PROJECTS, BEFORE_RECEIPT, false).state,
		).toBe("discard_unwritten");
	});

	it("restores projects after the first rename only", () => {
		expect(
			classifyRecovery(intent(), PLANNED_PROJECTS, BEFORE_RECEIPT, false).state,
		).toBe("restore_projects");
	});

	it("finalizes when both planned images are active", () => {
		expect(
			classifyRecovery(intent(), PLANNED_PROJECTS, PLANNED_RECEIPT, true).state,
		).toBe("finalize");
	});

	it("fails closed for every other image combination", () => {
		expect(
			classifyRecovery(intent(), PLANNED_PROJECTS, PLANNED_RECEIPT, false)
				.state,
		).toBe("conflict");
	});
});
