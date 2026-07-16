import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const HEAD = "a".repeat(40);

async function claimed(source: "auto" | "manual" = "auto") {
	const store = await StateStore.create(":memory:");
	store.claimAutoQaRecord({
		parentExecutionId: "main-1",
		targetPrHeadSha: HEAD,
		issueId: "FLY-1",
		projectName: "flywheel",
		enrollmentSource: source,
	});
	return store;
}

describe("StateStore manual QA enrollment", () => {
	it.each(["auto", "manual"] as const)(
		"persists the server-owned %s enrollment source",
		async (source) => {
			const store = await claimed(source);
			expect(store.getAutoQaRecord("main-1", HEAD)?.enrollment_source).toBe(
				source,
			);
		},
	);

	it.each(["stuck", "failed"] as const)(
		"CAS-revives a dead %s row as manual without creating a second record",
		async (status) => {
			const store = await claimed();
			store.setAutoQaQaExecutionId("main-1", HEAD, "qa-dead");
			store.setAutoQaStatus("main-1", HEAD, status, {});

			expect(store.reviveAutoQaRecordForManualSpawn("main-1", HEAD)).toBe(true);
			expect(store.getAutoQaRecord("main-1", HEAD)).toMatchObject({
				status: "running",
				enrollment_source: "manual",
			});
			expect(
				store.getAutoQaRecord("main-1", HEAD)?.qa_execution_id,
			).toBeUndefined();
		},
	);

	it.each(["running", "awaiting_retest", "passed"] as const)(
		"refuses to revive a %s row",
		async (status) => {
			const store = await claimed();
			store.setAutoQaStatus("main-1", HEAD, status, {});
			expect(store.reviveAutoQaRecordForManualSpawn("main-1", HEAD)).toBe(
				false,
			);
			expect(store.getAutoQaRecord("main-1", HEAD)?.status).toBe(status);
		},
	);
});
