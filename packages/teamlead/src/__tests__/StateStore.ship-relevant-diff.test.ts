import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const BASE_A = "c".repeat(40);

async function freshStore(): Promise<StateStore> {
	return StateStore.create(":memory:");
}

describe("StateStore ship_relevant_diff_snapshot", () => {
	it("persists a server-classified snapshot keyed by execution and head", async () => {
		const store = await freshStore();
		store.putShipRelevantDiffSnapshot({
			execution_id: "exec-1",
			pr_head_sha: HEAD_A,
			repo: "owner/repo",
			pr_number: 42,
			base_ref: "main",
			base_oid: BASE_A,
			classifier_version: 1,
			ship_relevant: 0,
			file_count: 2,
			sample_paths: ["engineering/doc/a.md"],
		});

		expect(store.getShipRelevantDiffSnapshot("exec-1", HEAD_A)).toMatchObject({
			execution_id: "exec-1",
			pr_head_sha: HEAD_A,
			repo: "owner/repo",
			pr_number: 42,
			base_ref: "main",
			base_oid: BASE_A,
			classifier_version: 1,
			ship_relevant: 0,
			file_count: 2,
			sample_paths: ["engineering/doc/a.md"],
		});
	});

	it("keeps different heads independent and replaces only the exact key", async () => {
		const store = await freshStore();
		for (const [head, relevant] of [
			[HEAD_A, 0],
			[HEAD_B, 1],
		] as const) {
			store.putShipRelevantDiffSnapshot({
				execution_id: "exec-1",
				pr_head_sha: head,
				repo: "owner/repo",
				pr_number: 42,
				base_ref: "main",
				base_oid: BASE_A,
				classifier_version: 1,
				ship_relevant: relevant,
				file_count: 1,
			});
		}

		expect(
			store.getShipRelevantDiffSnapshot("exec-1", HEAD_A)?.ship_relevant,
		).toBe(0);
		expect(
			store.getShipRelevantDiffSnapshot("exec-1", HEAD_B)?.ship_relevant,
		).toBe(1);
	});

	it("deletes a stale snapshot when the PR base identity changes", async () => {
		const store = await freshStore();
		store.putShipRelevantDiffSnapshot({
			execution_id: "exec-1",
			pr_head_sha: HEAD_A,
			repo: "owner/repo",
			pr_number: 42,
			base_ref: "main",
			base_oid: BASE_A,
			classifier_version: 1,
			ship_relevant: 0,
			file_count: 1,
		});

		expect(store.deleteShipRelevantDiffSnapshot("exec-1", HEAD_A)).toBe(true);
		expect(store.getShipRelevantDiffSnapshot("exec-1", HEAD_A)).toBeUndefined();
		expect(store.deleteShipRelevantDiffSnapshot("exec-1", HEAD_A)).toBe(false);
	});

	it("prunes superseded heads while retaining the current candidate", async () => {
		const store = await freshStore();
		for (const head of [HEAD_A, HEAD_B]) {
			store.putShipRelevantDiffSnapshot({
				execution_id: "exec-1",
				pr_head_sha: head,
				repo: "owner/repo",
				pr_number: 42,
				base_ref: "main",
				base_oid: BASE_A,
				classifier_version: 1,
				ship_relevant: 0,
				file_count: 1,
			});
		}

		expect(store.deleteOtherShipRelevantDiffSnapshots("exec-1", HEAD_B)).toBe(
			1,
		);
		expect(store.getShipRelevantDiffSnapshot("exec-1", HEAD_A)).toBeUndefined();
		expect(store.getShipRelevantDiffSnapshot("exec-1", HEAD_B)).toBeDefined();
	});
});
