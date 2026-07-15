import { describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	classifyShipRelevantDiff,
	SHIP_RELEVANT_CLASSIFIER_VERSION,
	ShipRelevantDiffService,
	type ShipRelevantGitHubApi,
} from "../ship-relevant-diff.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

interface ApiFixture {
	metadata?: unknown;
	pages?: unknown[][];
	headTree?: unknown;
	baseTree?: unknown;
	failPath?: string;
}

function fakeApi(fixture: ApiFixture): {
	api: ShipRelevantGitHubApi;
	paths: string[];
} {
	const paths: string[] = [];
	return {
		paths,
		api: async (path) => {
			paths.push(path);
			if (fixture.failPath && path.includes(fixture.failPath)) {
				throw new Error("github unavailable");
			}
			if (path === "/repos/owner/repo/pulls/42") {
				return (
					fixture.metadata ?? {
						head: { sha: HEAD },
						base: { ref: "main", sha: BASE },
						changed_files: fixture.pages?.flat().length ?? 1,
					}
				);
			}
			const pageMatch = path.match(/[?&]page=(\d+)/);
			if (path.includes("/pulls/42/files") && pageMatch) {
				return fixture.pages?.[Number(pageMatch[1]) - 1] ?? [];
			}
			if (path === `/repos/owner/repo/git/trees/${HEAD}?recursive=1`) {
				return fixture.headTree;
			}
			if (path === `/repos/owner/repo/git/trees/${BASE}?recursive=1`) {
				return fixture.baseTree;
			}
			throw new Error(`unexpected path ${path}`);
		},
	};
}

const docFile = {
	status: "added",
	filename: "engineering/doc/FLY-1/a.md",
};

function tree(path: string, mode = "100644", type = "blob") {
	return { truncated: false, tree: [{ path, mode, type }] };
}

describe("classifyShipRelevantDiff", () => {
	it("classifies a code path as ship-relevant without trusting file contents", async () => {
		const { api, paths } = fakeApi({
			pages: [[{ status: "modified", filename: "packages/app.ts" }], []],
		});
		const result = await classifyShipRelevantDiff({
			repo: "owner/repo",
			prNumber: 42,
			prHeadSha: HEAD,
			api,
		});

		expect(result).toMatchObject({
			kind: "snapshot",
			snapshot: {
				classifier_version: SHIP_RELEVANT_CLASSIFIER_VERSION,
				ship_relevant: 1,
				file_count: 1,
			},
		});
		expect(paths.some((path) => path.includes("/git/trees/"))).toBe(false);
	});

	it("exempts only allowlisted regular 100644 blobs on every required side", async () => {
		const path = docFile.filename;
		const { api } = fakeApi({
			pages: [[docFile], []],
			headTree: tree(path),
			baseTree: tree("unused"),
		});
		const result = await classifyShipRelevantDiff({
			repo: "owner/repo",
			prNumber: 42,
			prHeadSha: HEAD,
			api,
		});
		expect(result).toMatchObject({
			kind: "snapshot",
			snapshot: { ship_relevant: 0 },
		});
	});

	it("treats code renamed into docs as ship-relevant", async () => {
		const { api } = fakeApi({
			pages: [
				[
					{
						status: "renamed",
						filename: "engineering/doc/app.md",
						previous_filename: "packages/app.ts",
					},
				],
				[],
			],
		});
		const result = await classifyShipRelevantDiff({
			repo: "owner/repo",
			prNumber: 42,
			prHeadSha: HEAD,
			api,
		});
		expect(result).toMatchObject({
			kind: "snapshot",
			snapshot: { ship_relevant: 1 },
		});
	});

	it("exempts a docs-to-docs rename only when both tree sides are regular files", async () => {
		const oldPath = "engineering/doc/old.md";
		const newPath = "engineering/doc/new.md";
		const { api } = fakeApi({
			pages: [
				[
					{
						status: "renamed",
						filename: newPath,
						previous_filename: oldPath,
					},
				],
				[],
			],
			headTree: tree(newPath),
			baseTree: tree(oldPath),
		});
		await expect(
			classifyShipRelevantDiff({
				repo: "owner/repo",
				prNumber: 42,
				prHeadSha: HEAD,
				api,
			}),
		).resolves.toMatchObject({
			kind: "snapshot",
			snapshot: { ship_relevant: 0 },
		});
	});

	it("treats a docs mode change and a malformed rename as ship-relevant", async () => {
		const path = "engineering/doc/runbook.md";
		const changedMode = fakeApi({
			pages: [[{ status: "modified", filename: path }], []],
			headTree: tree(path, "100755"),
			baseTree: tree(path),
		});
		await expect(
			classifyShipRelevantDiff({
				repo: "owner/repo",
				prNumber: 42,
				prHeadSha: HEAD,
				api: changedMode.api,
			}),
		).resolves.toMatchObject({
			kind: "snapshot",
			snapshot: { ship_relevant: 1 },
		});

		const malformedRename = fakeApi({
			pages: [[{ status: "renamed", filename: path }], []],
		});
		await expect(
			classifyShipRelevantDiff({
				repo: "owner/repo",
				prNumber: 42,
				prHeadSha: HEAD,
				api: malformedRename.api,
			}),
		).resolves.toMatchObject({
			kind: "snapshot",
			snapshot: { ship_relevant: 1 },
		});
	});

	it.each([
		["120000", "blob"],
		["160000", "commit"],
		["100755", "blob"],
	] as const)(
		"treats removed docs entry mode %s/type %s as ship-relevant",
		async (mode, type) => {
			const path = "engineering/doc/old.md";
			const { api } = fakeApi({
				pages: [[{ status: "removed", filename: path }], []],
				headTree: tree("unused"),
				baseTree: tree(path, mode, type),
			});
			const result = await classifyShipRelevantDiff({
				repo: "owner/repo",
				prNumber: 42,
				prHeadSha: HEAD,
				api,
			});
			expect(result).toMatchObject({
				kind: "snapshot",
				snapshot: { ship_relevant: 1 },
			});
		},
	);

	it("fails closed without a snapshot when a required tree is truncated", async () => {
		const { api } = fakeApi({
			pages: [[docFile], []],
			headTree: { truncated: true, tree: [] },
			baseTree: tree("unused"),
		});
		await expect(
			classifyShipRelevantDiff({
				repo: "owner/repo",
				prNumber: 42,
				prHeadSha: HEAD,
				api,
			}),
		).resolves.toEqual({ kind: "unknown", reason: "tree_incomplete" });
	});

	it("paginates through an empty terminator and rejects count mismatch", async () => {
		const { api } = fakeApi({
			metadata: {
				head: { sha: HEAD },
				base: { ref: "main", sha: BASE },
				changed_files: 2,
			},
			pages: [[docFile], []],
		});
		await expect(
			classifyShipRelevantDiff({
				repo: "owner/repo",
				prNumber: 42,
				prHeadSha: HEAD,
				api,
			}),
		).resolves.toEqual({ kind: "unknown", reason: "file_count_mismatch" });
	});

	it("marks more than 50 changed files ship-relevant without tree inspection", async () => {
		const files = Array.from({ length: 51 }, (_, index) => ({
			status: "added",
			filename: `engineering/doc/${index}.md`,
		}));
		const { api, paths } = fakeApi({ pages: [files, []] });
		const result = await classifyShipRelevantDiff({
			repo: "owner/repo",
			prNumber: 42,
			prHeadSha: HEAD,
			api,
		});
		expect(result).toMatchObject({
			kind: "snapshot",
			snapshot: { ship_relevant: 1, file_count: 51 },
		});
		expect(paths.some((path) => path.includes("/git/trees/"))).toBe(false);
	});

	it("does not classify a PR whose server head differs from the requested head", async () => {
		const { api } = fakeApi({
			metadata: {
				head: { sha: "f".repeat(40) },
				base: { ref: "main", sha: BASE },
				changed_files: 1,
			},
			pages: [[docFile], []],
		});
		await expect(
			classifyShipRelevantDiff({
				repo: "owner/repo",
				prNumber: 42,
				prHeadSha: HEAD,
				api,
			}),
		).resolves.toEqual({ kind: "unknown", reason: "head_mismatch" });
	});
});

describe("ShipRelevantDiffService", () => {
	it("persists a successful classification for the exact execution and head", async () => {
		const store = await StateStore.create(":memory:");
		const { api } = fakeApi({
			pages: [[{ status: "modified", filename: "packages/app.ts" }], []],
		});
		const service = new ShipRelevantDiffService(store);
		await service.ensure({
			executionId: "exec-1",
			repo: "owner/repo",
			prNumber: 42,
			prHeadSha: HEAD,
			api,
		});

		expect(store.getShipRelevantDiffSnapshot("exec-1", HEAD)).toMatchObject({
			ship_relevant: 1,
			base_oid: BASE,
		});
	});

	it("deletes a prior exemption when the authoritative refresh becomes unknown", async () => {
		const store = await StateStore.create(":memory:");
		store.putShipRelevantDiffSnapshot({
			execution_id: "exec-1",
			pr_head_sha: HEAD,
			repo: "owner/repo",
			pr_number: 42,
			base_ref: "main",
			base_oid: BASE,
			classifier_version: SHIP_RELEVANT_CLASSIFIER_VERSION,
			ship_relevant: 0,
			file_count: 1,
		});
		const { api } = fakeApi({ failPath: "/pulls/42" });
		const service = new ShipRelevantDiffService(store);
		await service.ensure({
			executionId: "exec-1",
			repo: "owner/repo",
			prNumber: 42,
			prHeadSha: HEAD,
			api,
		});

		expect(store.getShipRelevantDiffSnapshot("exec-1", HEAD)).toBeUndefined();
	});

	it("revalidates base identity inside the file-list backoff and invalidates on retarget", async () => {
		const store = await StateStore.create(":memory:");
		let now = 0;
		const first = fakeApi({
			pages: [[docFile], []],
			headTree: tree(docFile.filename),
		});
		const service = new ShipRelevantDiffService(store, { now: () => now });
		await service.ensure({
			executionId: "exec-1",
			repo: "owner/repo",
			prNumber: 42,
			prHeadSha: HEAD,
			api: first.api,
		});

		const before = first.paths.length;
		now = 30_000;
		await service.ensure({
			executionId: "exec-1",
			repo: "owner/repo",
			prNumber: 42,
			prHeadSha: HEAD,
			api: first.api,
		});
		expect(first.paths).toHaveLength(before + 1);
		expect(first.paths.at(-1)).toBe("/repos/owner/repo/pulls/42");

		now = 31_000;
		const nextBase = "c".repeat(40);
		const refreshed = fakeApi({
			metadata: {
				head: { sha: HEAD },
				base: { ref: "release", sha: nextBase },
				changed_files: 1,
			},
			pages: [[{ status: "modified", filename: "packages/app.ts" }], []],
		});
		await service.ensure({
			executionId: "exec-1",
			repo: "owner/repo",
			prNumber: 42,
			prHeadSha: HEAD,
			api: refreshed.api,
		});
		expect(store.getShipRelevantDiffSnapshot("exec-1", HEAD)).toMatchObject({
			base_ref: "release",
			base_oid: nextBase,
			ship_relevant: 1,
		});
	});

	it("prunes expired in-memory retry entries during later classifications", async () => {
		const store = await StateStore.create(":memory:");
		let now = 0;
		const fixture = fakeApi({
			pages: [[docFile], []],
			headTree: tree(docFile.filename),
		});
		const service = new ShipRelevantDiffService(store, { now: () => now });
		await service.ensure({
			executionId: "exec-old",
			repo: "owner/repo",
			prNumber: 42,
			prHeadSha: HEAD,
			api: fixture.api,
		});
		now = 61_000;
		await service.ensure({
			executionId: "exec-current",
			repo: "owner/repo",
			prNumber: 42,
			prHeadSha: HEAD,
			api: fixture.api,
		});

		const retryAfter = (
			service as unknown as { retryAfter: Map<string, number> }
		).retryAfter;
		expect(retryAfter.has(`exec-old:${HEAD}`)).toBe(false);
		expect(retryAfter.has(`exec-current:${HEAD}`)).toBe(true);
	});
});
