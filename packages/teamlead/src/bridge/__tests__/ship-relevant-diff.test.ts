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

	it.each([
		[
			"head SHA",
			{
				head: { sha: "f".repeat(40) },
				base: { ref: "main", sha: BASE },
				changed_files: 1,
			},
			"head_mismatch",
		],
		[
			"base ref",
			{
				head: { sha: HEAD },
				base: { ref: "release", sha: BASE },
				changed_files: 1,
			},
			"metadata_drift",
		],
		[
			"base SHA",
			{
				head: { sha: HEAD },
				base: { ref: "main", sha: "c".repeat(40) },
				changed_files: 1,
			},
			"metadata_drift",
		],
		[
			"changed-file count",
			{
				head: { sha: HEAD },
				base: { ref: "main", sha: BASE },
				changed_files: 2,
			},
			"metadata_drift",
		],
	] as const)(
		"refuses a docs-only exemption when the final %s no longer matches the initial PR state",
		async (_label, finalMetadata, reason) => {
			let metadataReads = 0;
			const api: ShipRelevantGitHubApi = async (path) => {
				if (path === "/repos/owner/repo/pulls/42") {
					metadataReads += 1;
					return metadataReads === 1
						? {
								head: { sha: HEAD },
								base: { ref: "main", sha: BASE },
								changed_files: 1,
							}
						: finalMetadata;
				}
				if (path.includes("/pulls/42/files")) {
					const page = Number(path.match(/[?&]page=(\d+)/)?.[1]);
					return page === 1 ? [docFile] : [];
				}
				if (path === `/repos/owner/repo/git/trees/${HEAD}?recursive=1`) {
					return tree(docFile.filename);
				}
				throw new Error(`unexpected path ${path}`);
			};

			await expect(
				classifyShipRelevantDiff({
					repo: "owner/repo",
					prNumber: 42,
					prHeadSha: HEAD,
					api,
				}),
			).resolves.toEqual({ kind: "unknown", reason });
			expect(metadataReads).toBe(2);
		},
	);
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

	it("revalidates a docs-only exemption every time and invalidates it immediately on retarget", async () => {
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
		now = 3_000;
		await service.ensure({
			executionId: "exec-1",
			repo: "owner/repo",
			prNumber: 42,
			prHeadSha: HEAD,
			api: first.api,
		});
		expect(first.paths).toHaveLength(before + 1);
		expect(first.paths.at(-1)).toBe("/repos/owner/repo/pulls/42");

		now = 30_000;
		await service.ensure({
			executionId: "exec-1",
			repo: "owner/repo",
			prNumber: 42,
			prHeadSha: HEAD,
			api: first.api,
		});
		expect(first.paths).toHaveLength(before + 2);
		expect(first.paths.at(-1)).toBe("/repos/owner/repo/pulls/42");

		now = 59_000;
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
		expect(refreshed.paths).toHaveLength(4);
		expect(store.getShipRelevantDiffSnapshot("exec-1", HEAD)).toMatchObject({
			base_ref: "release",
			base_oid: nextBase,
			ship_relevant: 1,
		});
	});

	it("may throttle metadata revalidation for a cached ship-relevant result", async () => {
		const store = await StateStore.create(":memory:");
		let now = 0;
		const fixture = fakeApi({
			pages: [[{ status: "modified", filename: "packages/app.ts" }], []],
		});
		const service = new ShipRelevantDiffService(store, { now: () => now });
		await service.ensure({
			executionId: "exec-1",
			repo: "owner/repo",
			prNumber: 42,
			prHeadSha: HEAD,
			api: fixture.api,
		});
		const before = fixture.paths.length;

		now = 3_000;
		await service.ensure({
			executionId: "exec-1",
			repo: "owner/repo",
			prNumber: 42,
			prHeadSha: HEAD,
			api: fixture.api,
		});

		expect(fixture.paths).toHaveLength(before);
	});

	it("throttles a revalidated docs-only exemption for a bounded 10s sub-lease", async () => {
		// HIGH-3 over-correction fix: the docs-only side revalidated PR identity
		// on EVERY consumer pass, so a 3s GatePoller tick hammered /pulls/N
		// (~1200 calls/hr). A bounded 10s sub-lease — granted only AFTER the first
		// post-classify revalidation confirms the anchors — caps that at ~360/hr
		// while keeping the retarget-detection window <=10s (Lead-decided
		// trade-off; not a return to the old 30s that was HIGH-3's cause).
		const store = await StateStore.create(":memory:");
		let now = 0;
		const fixture = fakeApi({
			pages: [[docFile], []],
			headTree: tree(docFile.filename),
		});
		const service = new ShipRelevantDiffService(store, { now: () => now });

		// Pass 1: full classify (docs-only). No sub-lease granted yet.
		await service.ensure({
			executionId: "exec-1",
			repo: "owner/repo",
			prNumber: 42,
			prHeadSha: HEAD,
			api: fixture.api,
		});
		const afterClassify = fixture.paths.length;

		// Pass 2 (+3s): first consumer pass revalidates identity (1 metadata
		// fetch) and grants the 10s sub-lease.
		now = 3_000;
		await service.ensure({
			executionId: "exec-1",
			repo: "owner/repo",
			prNumber: 42,
			prHeadSha: HEAD,
			api: fixture.api,
		});
		expect(fixture.paths).toHaveLength(afterClassify + 1);
		expect(fixture.paths.at(-1)).toBe("/repos/owner/repo/pulls/42");

		// Pass 3 (within the sub-lease, +9s): throttled — NO new /pulls fetch.
		now = 9_000;
		await service.ensure({
			executionId: "exec-1",
			repo: "owner/repo",
			prNumber: 42,
			prHeadSha: HEAD,
			api: fixture.api,
		});
		expect(fixture.paths).toHaveLength(afterClassify + 1);

		// Pass 4 (after the sub-lease expires, +14s): revalidates again — the
		// exposure to an undetected retarget is bounded by the 10s lease.
		now = 14_000;
		await service.ensure({
			executionId: "exec-1",
			repo: "owner/repo",
			prNumber: 42,
			prHeadSha: HEAD,
			api: fixture.api,
		});
		expect(fixture.paths).toHaveLength(afterClassify + 2);
		expect(fixture.paths.at(-1)).toBe("/repos/owner/repo/pulls/42");
	});

	it("bounds the docs-only retarget fail-open to the sub-lease + poll interval", async () => {
		// Adjudicated (Eng Lead, FLY-1251): the docs-only sub-lease trades a
		// BOUNDED retarget fail-open for lower API load. The detection latency is
		// the sub-lease (10s) + the GatePoller poll interval (~3s) ≈ 13s, NOT
		// <=10s. This pins that bound end-to-end at the 3s cadence: the stale
		// exemption is served THROUGH the lease, then re-evaluated on the first
		// tick after it expires — it can never be served indefinitely.
		const store = await StateStore.create(":memory:");
		let now = 0;
		let retargeted = false; // flips true to simulate a base change (retarget)
		const paths: string[] = [];
		const api: ShipRelevantGitHubApi = async (path) => {
			paths.push(path);
			if (path === "/repos/owner/repo/pulls/42") {
				return retargeted
					? {
							head: { sha: HEAD },
							base: { ref: "release", sha: "c".repeat(40) },
							changed_files: 1,
						}
					: {
							head: { sha: HEAD },
							base: { ref: "main", sha: BASE },
							changed_files: 1,
						};
			}
			const pageMatch = path.match(/[?&]page=(\d+)/);
			if (path.includes("/pulls/42/files") && pageMatch) {
				if (Number(pageMatch[1]) !== 1) return [];
				// After the retarget the diff is a code file (ship-relevant);
				// before, a doc-only file.
				return [
					retargeted
						? { status: "modified", filename: "packages/app.ts" }
						: docFile,
				];
			}
			if (path === `/repos/owner/repo/git/trees/${HEAD}?recursive=1`) {
				return tree(docFile.filename);
			}
			if (path === `/repos/owner/repo/git/trees/${BASE}?recursive=1`) {
				return tree(docFile.filename);
			}
			throw new Error(`unexpected path ${path}`);
		};
		const service = new ShipRelevantDiffService(store, { now: () => now });
		const ensure = () =>
			service.ensure({
				executionId: "exec-1",
				repo: "owner/repo",
				prNumber: 42,
				prHeadSha: HEAD,
				api,
			});

		await ensure(); // t=0 full classify → docs-only
		now = 3_000;
		await ensure(); // t=3 first revalidation → grant 10s lease (expires 13s)
		expect(store.getShipRelevantDiffSnapshot("exec-1", HEAD)).toMatchObject({
			ship_relevant: 0,
		});

		retargeted = true; // base changes (~t=4) — a retarget the exemption must catch

		// Within the sub-lease the stale docs-only exemption is still served
		// (bounded fail-open) — the 3s ticks re-fetch NOTHING.
		const afterRevalidate = paths.length;
		now = 6_000;
		await ensure();
		now = 9_000;
		await ensure();
		now = 12_000;
		await ensure();
		expect(paths).toHaveLength(afterRevalidate);
		expect(store.getShipRelevantDiffSnapshot("exec-1", HEAD)).toMatchObject({
			ship_relevant: 0,
		});

		// First tick AFTER the lease expires (13s) re-fetches, detects the
		// retarget, and flips the classification away from the stale exemption —
		// so the window is bounded to ~13s (10s lease + 3s poll), never open.
		now = 15_000;
		await ensure();
		expect(store.getShipRelevantDiffSnapshot("exec-1", HEAD)).toMatchObject({
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
