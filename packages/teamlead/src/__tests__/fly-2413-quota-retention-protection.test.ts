import { describe, expect, it } from "vitest";
import {
	assertNoUnclassifiedSchema,
	TEAMLEAD_TABLE_CLASSIFICATION,
} from "../../../../scripts/lib/fly-2006-retention-registry.mjs";

describe("Quota retention protection", () => {
	it("protects every quota recovery table including lazy canonical observations from retention deletion", () => {
		const tables = [
			"admission_wait",
			"binding",
			"canonical_observation",
			"capacity_permit",
			"dispatch_demand",
			"execution_pause",
			"external_generation",
			"incident",
			"install_material",
			"legacy_start",
			"observation",
			"outbox",
			"outbox_attempt",
			"reading_episode",
			"resume_audit",
			"resume_output_proof",
			"review_model",
			"root",
			"sequence",
			"standby",
			"switch_audit",
			"target",
		].map((name) => `codex_quota_${name}`);
		expect(() => assertNoUnclassifiedSchema("teamlead", tables)).not.toThrow();
		expect(TEAMLEAD_TABLE_CLASSIFICATION.protectedCurrentOrReference).toEqual(
			expect.arrayContaining(tables),
		);
		for (const table of tables)
			expect(TEAMLEAD_TABLE_CLASSIFICATION.deleteTarget).not.toContain(table);
	});
});
