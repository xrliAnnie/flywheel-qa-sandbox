import { expect, it } from "vitest";
import { TEAMLEAD_TABLE_CLASSIFICATION } from "../../../../scripts/lib/fly-2006-retention-registry.mjs";

it("protects FLY-2655 voice intent idempotency receipts from retention deletion", () => {
	expect(TEAMLEAD_TABLE_CLASSIFICATION.protectedCurrentOrReference).toContain(
		"voice_intents",
	);
	expect(TEAMLEAD_TABLE_CLASSIFICATION.deleteTarget).not.toContain(
		"voice_intents",
	);
});
