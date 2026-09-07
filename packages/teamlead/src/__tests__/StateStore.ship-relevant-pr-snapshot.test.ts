import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "c".repeat(40);
const BASE_A = "b".repeat(40);

describe("StateStore ship_relevant_pr_snapshot", () => {
	it("keeps the same head independent across repositories and PR numbers", async () => {
		const store = await StateStore.create(":memory:");
		for (const [repoSlug, prNumber] of [
			["owner/repo-a", 41],
			["owner/repo-b", 41],
			["owner/repo-a", 42],
		] as const) {
			store.putShipRelevantPrSnapshot({
				execution_id: "exec-1",
				repo_slug: repoSlug,
				pr_number: prNumber,
				pr_head_sha: HEAD_A,
				role: prNumber === 41 ? "primary" : "declared",
				base_ref: "main",
				base_oid: BASE_A,
				classifier_version: 2,
				ship_relevant: 0,
				file_count: 1,
				commit_shas: [HEAD_A],
			});
		}

		expect(
			store.getShipRelevantPrSnapshot("exec-1", "owner/repo-a", 41),
		).toMatchObject({ repo_slug: "owner/repo-a", pr_number: 41 });
		expect(
			store.getShipRelevantPrSnapshot("exec-1", "owner/repo-b", 41),
		).toMatchObject({ repo_slug: "owner/repo-b", pr_number: 41 });
		expect(
			store.getShipRelevantPrSnapshot("exec-1", "owner/repo-a", 42),
		).toMatchObject({ repo_slug: "owner/repo-a", pr_number: 42 });
		store.close();
	});

	it("replaces a PR head and prunes only candidates outside the keep set", async () => {
		const store = await StateStore.create(":memory:");
		const put = (repoSlug: string, prNumber: number, headSha = HEAD_A) =>
			store.putShipRelevantPrSnapshot({
				execution_id: "exec-1",
				repo_slug: repoSlug,
				pr_number: prNumber,
				pr_head_sha: headSha,
				role: prNumber === 41 ? "primary" : "declared",
				base_ref: "main",
				base_oid: BASE_A,
				classifier_version: 2,
				ship_relevant: 0,
				file_count: 1,
				commit_shas: [headSha],
			});
		put("owner/main", 41);
		put("owner/nested", 42);
		put("owner/stale", 43);
		put("owner/nested", 42, HEAD_B);
		expect(
			store.deleteShipRelevantPrSnapshot("exec-1", "owner/nested", 42),
		).toBe(true);
		expect(
			store.getShipRelevantPrSnapshot("exec-1", "owner/nested", 42),
		).toBeUndefined();
		put("owner/nested", 42, HEAD_B);

		expect(
			store.deleteShipRelevantPrSnapshotsExcept("exec-1", [
				{ repoSlug: "owner/main", prNumber: 41 },
				{ repoSlug: "owner/nested", prNumber: 42 },
			]),
		).toBe(1);
		expect(
			store.getShipRelevantPrSnapshot("exec-1", "owner/nested", 42),
		).toMatchObject({ pr_head_sha: HEAD_B });
		expect(
			store.getShipRelevantPrSnapshot("exec-1", "owner/stale", 43),
		).toBeUndefined();
		store.close();
	});

	it("resolves a legacy primary snapshot only when repository ownership is unique", async () => {
		const store = await StateStore.create(":memory:");
		const putPrimary = (repoSlug: string) =>
			store.putShipRelevantPrSnapshot({
				execution_id: "exec-1",
				repo_slug: repoSlug,
				pr_number: 41,
				pr_head_sha: HEAD_A,
				role: "primary",
				base_ref: "main",
				base_oid: BASE_A,
				classifier_version: 2,
				ship_relevant: 0,
				file_count: 1,
				commit_shas: [HEAD_A],
			});

		expect(store.resolvePrimaryShipRelevantPrSnapshot("exec-1", 41)).toEqual({
			kind: "none",
		});
		putPrimary("owner/main");
		expect(
			store.resolvePrimaryShipRelevantPrSnapshot("exec-1", 41),
		).toMatchObject({
			kind: "one",
			snapshot: { repo_slug: "owner/main", pr_number: 41 },
		});
		putPrimary("owner/other");
		expect(
			store.resolvePrimaryShipRelevantPrSnapshot("exec-1", 41),
		).toMatchObject({ kind: "many", snapshots: [{}, {}] });
		store.close();
	});
});
