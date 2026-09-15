import { expect, it } from "vitest";
import { TEAMLEAD_TABLE_CLASSIFICATION } from "../../../../scripts/lib/fly-2006-retention-registry.mjs";

it("protects FLY-2563 observation and terminal archive progress from retention deletion", () => {
	for (const table of [
		"ship_judgment_observation_cursor",
		"ship_judgment_observation_pending",
		"workflow_terminal_archive_cursor",
	]) {
		expect(TEAMLEAD_TABLE_CLASSIFICATION.protectedCurrentOrReference).toContain(
			table,
		);
		expect(TEAMLEAD_TABLE_CLASSIFICATION.deleteTarget).not.toContain(table);
	}
});
