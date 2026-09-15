import { describe, expect, it, vi } from "vitest";
import { GithubProjectApi } from "../github-api.js";
import {
	ProjectFetchFailure,
	ProjectRefreshStore,
	SharedProjectRefresh,
} from "../project-refresh.js";
import { bindingFixture, NOW } from "./binding-fixture.js";

const snapshot = {
	repositories: [
		{
			repo_identity: "__main__",
			repo_slug: "owner/repo",
			main_sha: "a".repeat(40),
		},
	],
	prs: [],
	configurationDigest: "b".repeat(64),
};

describe("durable project refresh", () => {
	it("rejects file inventories when the PR moves during pagination", async () => {
		const { store, db } = await bindingFixture();
		try {
			const refresh = new SharedProjectRefresh(
				new ProjectRefreshStore(db),
				{
					main: async () => "a".repeat(40),
					prs: async () => ({
						items: [
							{
								pr_number: 1,
								head_sha: "b".repeat(40),
								base_ref: "main",
								base_sha: "a".repeat(40),
								draft: false,
								state: "open",
							},
						],
						nextPage: null,
					}),
					files: async () => ({ items: [{ path: "a.ts" }], nextPage: null }),
					pr: async () => ({
						head_sha: "c".repeat(40),
						base_ref: "main",
						base_sha: "a".repeat(40),
						draft: false,
						state: "open",
						changed_files: 1,
					}),
				},
				() => Date.parse(NOW),
			);
			expect(
				await refresh.refresh({
					projectName: "flywheel",
					repositories: [
						{ repo_identity: "__main__", repo_slug: "owner/repo" },
					],
				}),
			).toMatchObject({
				status: "ready",
				snapshot: {
					prs: [
						{
							pr_number: 1,
							filesComplete: false,
							files: [],
							filesError: "pr_changed_during_collection",
						},
					],
				},
			});
			expect(
				new ProjectRefreshStore(db).read(Date.parse(NOW))?.prs[0]
					?.filesComplete,
			).toBe(false);
		} finally {
			store.close();
		}
	});
	it("coalesces twenty cards into one project fetch and reuses unchanged-head file inventories", async () => {
		const { store, db } = await bindingFixture();
		try {
			let now = Date.parse(NOW);
			let baseSha = "a".repeat(40);
			const api = {
				main: vi.fn(async () => "a".repeat(40)),
				pr: vi.fn(async () => ({
					head_sha: "b".repeat(40),
					base_ref: "main",
					base_sha: baseSha,
					draft: false,
					state: "open",
					changed_files: 1,
				})),
				prs: vi.fn(async () => ({
					items: [
						{
							pr_number: 1,
							head_sha: "b".repeat(40),
							base_ref: "main",
							base_sha: baseSha,
							draft: false,
							state: "open",
						},
					],
					nextPage: null,
				})),
				files: vi.fn(async () => ({
					items: [{ path: "src/a.ts" }],
					nextPage: null,
				})),
			};
			const refresh = new SharedProjectRefresh(
				new ProjectRefreshStore(db),
				api,
				() => now,
			);
			const config = {
				projectName: "flywheel",
				repositories: [{ repo_identity: "__main__", repo_slug: "owner/repo" }],
			};
			const results = await Promise.all(
				Array.from({ length: 20 }, () => refresh.refresh(config)),
			);
			expect(results.every((result) => result.status === "ready")).toBe(true);
			expect(api.main).toHaveBeenCalledTimes(1);
			expect(api.prs).toHaveBeenCalledTimes(1);
			expect(api.files).toHaveBeenCalledTimes(1);
			now += 60_001;
			baseSha = "d".repeat(40);
			const advanced = await refresh.refresh(config);
			expect(advanced.status).toBe("ready");
			if (advanced.status !== "ready") throw new Error(advanced.reason);
			expect(advanced.snapshot.prs[0]?.base_sha).toBe(baseSha);
			expect(api.prs).toHaveBeenCalledTimes(2);
			expect(api.files).toHaveBeenCalledTimes(1);
			now += 60_001;
			api.prs.mockResolvedValueOnce({
				items: [
					{
						pr_number: 1,
						head_sha: "c".repeat(40),
						base_ref: "main",
						base_sha: baseSha,
						draft: false,
						state: "open",
					},
				],
				nextPage: null,
			});
			api.pr.mockResolvedValueOnce({
				head_sha: "c".repeat(40),
				base_ref: "main",
				base_sha: baseSha,
				draft: false,
				state: "open",
				changed_files: 1,
			});
			expect((await refresh.refresh(config)).status).toBe("ready");
			expect(api.files).toHaveBeenCalledTimes(2);
			now += 60_001;
			api.prs.mockRejectedValueOnce(new Error("private upstream diagnostic"));
			expect(await refresh.refresh(config)).toEqual({
				status: "unavailable",
				reason: "project_fetch_failed",
			});
			expect(new ProjectRefreshStore(db).failureReason()).toBe(
				"project_fetch_failed",
			);
			expect(new ProjectRefreshStore(db).read(now)).toBeUndefined();
			expect(
				(await refresh.refresh({ ...config, projectName: "raya" })).status,
			).toBe("out_of_scope");
			expect(api.prs).toHaveBeenCalledTimes(4);
		} finally {
			store.close();
		}
	});
	it("shares one lease, limits attempts to one minute, and never serves a stale or failed pass", async () => {
		const { store, db } = await bindingFixture();
		try {
			const a = new ProjectRefreshStore(db),
				b = new ProjectRefreshStore(db);
			const now = Date.parse(NOW);
			const lease = a.begin("worker-a", now);
			if (lease.status !== "claimed") throw new Error(lease.status);
			expect(b.begin("worker-b", now).status).toBe("pending");
			expect(a.reserveApi(lease, now)).toBe(true);
			expect(a.finish(lease, snapshot, now + 1)).toBe(true);
			expect(a.read(now + 2)?.prs).toEqual([]);
			expect(b.begin("worker-b", now + 59_999).status).toBe("cooldown");
			expect(a.read(now + 60_002)).toBeUndefined();
			const next = b.begin("worker-b", now + 60_002);
			if (next.status !== "claimed") throw new Error(next.status);
			expect(a.finish(lease, snapshot, now + 60_003)).toBe(false);
			expect(b.fail(next, "api_failure", now + 60_003, now + 180_000)).toBe(
				true,
			);
			expect(a.read(now + 60_004)).toBeUndefined();
			expect(a.failureReason()).toBe("api_failure");
			expect(a.begin("worker-a", now + 120_003).status).toBe("cooldown");
			expect(a.begin("worker-a", now + 180_000).status).toBe("claimed");
		} finally {
			store.close();
		}
	});
	it("reserves at most 120 HTTP calls per rolling hour across store instances", async () => {
		const { store, db } = await bindingFixture();
		try {
			const now = Date.parse(NOW),
				refresh = new ProjectRefreshStore(db);
			const lease = refresh.begin("worker", now);
			if (lease.status !== "claimed") throw new Error(lease.status);
			for (let n = 0; n < 120; n++)
				expect(new ProjectRefreshStore(db).reserveApi(lease, now + n)).toBe(
					true,
				);
			expect(refresh.reserveApi(lease, now + 121)).toBe(false);
			expect(
				refresh.reserveApi(
					{ ...lease, generation: lease.generation + 1 },
					now + 122,
				),
			).toBe(false);
			const later = refresh.begin("next", now + 3_600_001);
			if (later.status !== "claimed") throw new Error(later.status);
			expect(refresh.reserveApi(later, now + 3_600_002)).toBe(true);
		} finally {
			store.close();
		}
	});
});

it("aborts a live shared network refresh on shutdown and cannot start another", async () => {
	const { store, db } = await bindingFixture();
	try {
		let entered = false;
		const api = {
			main: vi.fn(
				async (_repo: string, signal: AbortSignal) =>
					new Promise<string>((_resolve, reject) => {
						entered = true;
						signal.addEventListener(
							"abort",
							() => reject(new Error("aborted")),
							{ once: true },
						);
					}),
			),
			pr: vi.fn(),
			prs: vi.fn(),
			files: vi.fn(),
		};
		const refresh = new SharedProjectRefresh(new ProjectRefreshStore(db), api);
		const config = {
			projectName: "flywheel",
			repositories: [{ repo_identity: "__main__", repo_slug: "owner/repo" }],
		};
		const pending = refresh.refresh(config);
		await vi.waitFor(() => expect(entered).toBe(true));
		await refresh.stop();
		expect((await pending).status).toBe("unavailable");
		expect(await refresh.refresh(config)).toEqual({
			status: "unavailable",
			reason: "refresh_stopped",
		});
		expect(api.main).toHaveBeenCalledTimes(1);
	} finally {
		store.close();
	}
});

it("shares merge probes by immutable repository and commit tuple without extending snapshot freshness", async () => {
	const { store, db } = await bindingFixture();
	try {
		const cache = new ProjectRefreshStore(db),
			now = Date.parse(NOW);
		const lease = cache.begin("probe-test", now);
		if (lease.status !== "claimed") throw new Error(lease.status);
		cache.finish(lease, snapshot, now);
		const key = {
			repoIdentity: "__main__",
			mainSha: "a".repeat(40),
			headSha: "b".repeat(40),
			targetBaseSha: "c".repeat(40),
		};
		const result = { verdict: "pass" as const, reason: "merge_clean" };
		expect(cache.saveMergeProbe(key, result, now + 10)).toBe(true);
		expect(new ProjectRefreshStore(db).readMergeProbe(key, now + 20)).toEqual(
			result,
		);
		for (const field of [
			"repoIdentity",
			"mainSha",
			"headSha",
			"targetBaseSha",
		] as const)
			expect(
				cache.readMergeProbe(
					{
						...key,
						[field]: field === "repoIdentity" ? "other" : "d".repeat(40),
					},
					now + 20,
				),
			).toBeUndefined();
		expect(cache.readMergeProbe(key, now - 1)).toBeUndefined();
		expect(cache.readMergeProbe(key, now + 60001)).toBeUndefined();
		expect(cache.saveMergeProbe(key, result, now + 60001)).toBe(false);
		expect(cache.read(now + 20)).toEqual(snapshot);
		for (let i = 1; i < 200; i++)
			expect(
				cache.saveMergeProbe(
					{ ...key, headSha: i.toString(16).padStart(40, "0") },
					result,
					now + 20,
				),
			).toBe(true);
		expect(
			cache.saveMergeProbe(
				{ ...key, headSha: "e".repeat(40) },
				result,
				now + 20,
			),
		).toBe(false);
		expect(cache.readMergeProbe(key, now + 20)).toEqual(result);
	} finally {
		store.close();
	}
});

it("persists per-PR failures, completes large real GitHub pages, and retries only incomplete inventories", async () => {
	const { store, db } = await bindingFixture();
	try {
		let now = Date.parse(NOW),
			failed = true;
		const pr = (n: number) => ({
			number: n,
			head: { sha: "b".repeat(40) },
			base: { ref: "main", sha: "a".repeat(40) },
			state: "open",
			draft: false,
		});
		const largeList = JSON.stringify(
			[1, 2, 3].map((n) => ({ ...pr(n), body: "x".repeat(300_000) })),
		);
		expect(Buffer.byteLength(largeList)).toBeGreaterThan(800 * 1024);
		const largeFiles = JSON.stringify(
			Array.from({ length: 20 }, (_, i) => ({
				filename: `src/${i}.ts`,
				patch: "x".repeat(50_000),
			})),
		);
		const fetcher = vi.fn(async (url: string) => {
			const u = new URL(url),
				page = u.searchParams.get("page");
			if (u.pathname.endsWith("/git/ref/heads/main"))
				return Response.json({ object: { sha: "a".repeat(40) } });
			if (u.pathname.endsWith("/pulls"))
				return new Response(
					page === "1" ? largeList : JSON.stringify([pr(4)]),
					{
						headers:
							page === "1"
								? {
										Link: '<https://api.github.com/repositories/1164340454/pulls?per_page=20&page=2>; rel="next"',
									}
								: {},
					},
				);
			const n = Number(u.pathname.match(/\/pulls\/(\d+)/)?.[1]);
			if (u.pathname.endsWith("/files")) {
				if (n === 1 && failed)
					return new Response("private error", { status: 500 });
				if (n === 2 && page === "1")
					return new Response(largeFiles, {
						headers: {
							Link: '<https://api.github.com/repositories/1164340454/pulls/2/files?per_page=100&page=2>; rel="next"',
						},
					});
				return Response.json([{ filename: `src/final${n}.ts` }]);
			}
			return Response.json({ ...pr(n), changed_files: n === 2 ? 21 : 1 });
		});
		const cache = new ProjectRefreshStore(db);
		const refresh = new SharedProjectRefresh(
			cache,
			new GithubProjectApi(["owner/repo"], () => "fixture", fetcher),
			() => now,
		);
		const config = {
			projectName: "flywheel",
			repositories: [{ repo_identity: "__main__", repo_slug: "owner/repo" }],
		};
		const first = await refresh.refresh(config);
		expect(first.status).toBe("ready");
		if (first.status !== "ready") throw new Error(first.reason);
		expect(first.snapshot.prs).toHaveLength(4);
		expect(first.snapshot.prs[0]).toMatchObject({
			pr_number: 1,
			filesComplete: false,
			files: [],
			filesError: "github_http_500",
		});
		expect(first.snapshot.prs[1]).toMatchObject({
			pr_number: 2,
			filesComplete: true,
		});
		expect(first.snapshot.prs[1]!.files).toHaveLength(21);
		expect(new ProjectRefreshStore(db).read(now)).toEqual(first.snapshot);
		expect(cache.failureReason()).toBeUndefined();
		expect(Buffer.byteLength(JSON.stringify(first.snapshot))).toBeLessThan(
			8192,
		);
		failed = false;
		now += 60_001;
		fetcher.mockClear();
		const next = await refresh.refresh(config);
		expect(next.status).toBe("ready");
		if (next.status !== "ready") throw new Error(next.reason);
		expect(next.snapshot.prs.every((p) => p.filesComplete)).toBe(true);
		expect(
			fetcher.mock.calls.filter(([url]) => url.includes("/files?")),
		).toHaveLength(1);
		expect(
			fetcher.mock.calls.some(([url]) => url.includes("/pulls/1/files?")),
		).toBe(true);
	} finally {
		store.close();
	}
});

it.each(["github_rate_limit", "request_budget_or_lease"])(
	"retains project-wide stop for %s during one PR's files",
	async (reason) => {
		const { store, db } = await bindingFixture();
		try {
			const now = Date.parse(NOW),
				cache = new ProjectRefreshStore(db);
			const api = {
				main: async () => "a".repeat(40),
				prs: async () => ({
					items: [
						{
							pr_number: 1,
							head_sha: "b".repeat(40),
							base_ref: "main",
							base_sha: "a".repeat(40),
							state: "open",
							draft: false,
						},
					],
					nextPage: null,
				}),
				files: async () => {
					throw new ProjectFetchFailure(reason, now + 180_000);
				},
				pr: vi.fn(),
			};
			const refresh = new SharedProjectRefresh(cache, api, () => now);
			expect(
				await refresh.refresh({
					projectName: "flywheel",
					repositories: [
						{ repo_identity: "__main__", repo_slug: "owner/repo" },
					],
				}),
			).toEqual({ status: "unavailable", reason });
			expect(cache.read(now)).toBeUndefined();
			expect(cache.failureReason()).toBe(reason);
			expect(api.pr).not.toHaveBeenCalled();
			expect(cache.begin("later", now + 60_001).status).toBe("cooldown");
		} finally {
			store.close();
		}
	},
);
