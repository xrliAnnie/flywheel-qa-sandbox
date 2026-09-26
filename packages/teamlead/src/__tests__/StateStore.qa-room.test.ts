import { expect, it } from "vitest";
import { loadRetentionSnapshot } from "../../../../scripts/lib/fly-2006-retention-loader.mjs";
import { StateStore } from "../StateStore.js";

it("initializes room journals on the StateStore connection and protects them from retention", async () => {
	const store = await StateStore.create(":memory:");
	try {
		expect(store.qaRooms.rooms()).toEqual([]);
		store.qaRooms.audit({
			at: new Date().toISOString(),
			actor_key: "lead:eng",
			actor_issue: null,
			action: "deploy",
			room_id: null,
			slot: null,
			decision: "refused",
			reason: "invalid_request",
			head: null,
			request_digest: "x",
		});
		store.migrate();
		expect(store.qaRooms.audits()).toHaveLength(1);
		const classifications = loadRetentionSnapshot(
			new URL(
				"../../../../scripts/lib/fly-2006-retention-tables/",
				import.meta.url,
			),
		).classifications;
		for (const table of [
			"qa_room",
			"qa_room_slot",
			"qa_room_operation",
			"qa_room_audit",
		]) {
			expect(classifications.teamlead.protectedCurrentOrReference).toContain(
				table,
			);
		}
	} finally {
		store.close();
	}
});
