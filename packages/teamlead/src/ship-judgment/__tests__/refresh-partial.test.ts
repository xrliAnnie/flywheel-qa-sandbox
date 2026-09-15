import { expect, it, vi } from "vitest";
import {
	ProjectFetchFailure,
	ProjectRefreshStore,
	SharedProjectRefresh,
} from "../project-refresh.js";
import { bindingFixture, NOW } from "./binding-fixture.js";

it("publishes metadata before file collection and preserves verified partial files after failure/reopen", async () => {
	const { store, db } = await bindingFixture();
	try {
		let now = Date.parse(NOW);
		const config = {
			projectName: "flywheel",
			repositories: [{ repo_identity: "__main__", repo_slug: "owner/repo" }],
		};
		const prs = [1, 2].map((pr_number) => ({
			pr_number,
			head_sha: String(pr_number).repeat(40),
			base_ref: "main",
			base_sha: "a".repeat(40),
			draft: false,
			state: "open",
		}));
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		let fail = true;
		const api = {
			main: async () => "a".repeat(40),
			prs: async () => ({ items: prs, nextPage: null }),
			files: vi.fn(async (_repo: string, pr: number) => {
				if (pr === 1 && fail) await waiting;
				if (pr === 2 && fail)
					throw new ProjectFetchFailure("github_rate_limit", now);
				return { items: [{ path: `${pr}.ts` }], nextPage: null };
			}),
			pr: vi.fn(async (_repo: string, pr: number) => {
				const { pr_number: _, ...identity } = prs[pr - 1]!;
				return { ...identity, changed_files: 1 };
			}),
		};
		const refreshStore = new ProjectRefreshStore(db);
		const refresh = new SharedProjectRefresh(refreshStore, api, () => now);
		const result = refresh.refresh(config);
		try {
			const metadata = await refresh.metadata(config);
			expect(metadata?.prs).toHaveLength(2);
			expect(metadata?.prs.every((pr) => !pr.filesComplete)).toBe(true);
			expect(refreshStore.read(now)).toBeUndefined();
		} finally {
			release();
			await result;
		}
		expect(await result).toEqual({
			status: "unavailable",
			reason: "github_rate_limit",
		});
		expect(refreshStore.read(now)).toBeUndefined();
		expect(refreshStore.cacheForReuse()?.prs[0]).toMatchObject({
			pr_number: 1,
			filesComplete: true,
		});
		expect(refreshStore.cacheForReuse()?.prs[1]).toMatchObject({
			pr_number: 2,
			filesComplete: false,
		});
		fail = false;
		now += 60_001;
		const reopened = new SharedProjectRefresh(
			new ProjectRefreshStore(db),
			api,
			() => now,
		);
		expect((await reopened.refresh(config)).status).toBe("ready");
		expect(api.files.mock.calls.filter(([, pr]) => pr === 1)).toHaveLength(1);
		expect(api.pr.mock.calls.filter(([, pr]) => pr === 1)).toHaveLength(1);
		expect(refreshStore.read(now)?.prs.every((pr) => pr.filesComplete)).toBe(
			true,
		);
	} finally {
		store.close();
	}
});

it.each(["metadata", "files"])(
	"preserves warm inventories across %s failure and reuses them after reopen",
	async (phase) => {
		const { store, db } = await bindingFixture();
		try {
			let now = Date.parse(NOW);
			let failing = false;
			const config = {
				projectName: "flywheel",
				repositories: [{ repo_identity: "__main__", repo_slug: "owner/repo" }],
			};
			const prs = [1, 2].map((pr_number) => ({
				pr_number,
				head_sha: String(pr_number).repeat(40),
				base_ref: "main",
				base_sha: "a".repeat(40),
				draft: false,
				state: "open",
			}));
			const api = {
				main: async () => "a".repeat(40),
				prs: async () => {
					if (failing && phase === "metadata")
						throw new ProjectFetchFailure("request_budget_or_lease");
					return { items: prs, nextPage: null };
				},
				files: vi.fn(async (_repo: string, pr: number) => {
					if (failing) throw new ProjectFetchFailure("github_rate_limit", now);
					return { items: [{ path: `${pr}.ts` }], nextPage: null };
				}),
				pr: vi.fn(async (_repo: string, pr: number) => {
					const { pr_number: _, ...identity } = prs[pr - 1]!;
					return { ...identity, changed_files: 1 };
				}),
			};
			const refreshStore = new ProjectRefreshStore(db);
			const run = () =>
				new SharedProjectRefresh(
					new ProjectRefreshStore(db),
					api,
					() => now,
				).refresh(config);
			expect((await run()).status).toBe("ready");
			expect(
				refreshStore.cacheForReuse()?.prs.every((pr) => pr.filesComplete),
			).toBe(true);
			now += 60_001;
			// A changed first PR forces a file request before the second warm PR is visited.
			if (phase === "files") prs[0]!.head_sha = "c".repeat(40);
			failing = true;
			expect(await run()).toEqual({
				status: "unavailable",
				reason:
					phase === "metadata"
						? "request_budget_or_lease"
						: "github_rate_limit",
			});
			expect(refreshStore.read(now)).toBeUndefined();
			const retained = new ProjectRefreshStore(db).cacheForReuse();
			expect(retained?.prs.find((pr) => pr.pr_number === 2)).toMatchObject({
				filesComplete: true,
				files: [{ path: "2.ts" }],
			});
			if (phase === "metadata")
				expect(retained?.prs.filter((pr) => pr.filesComplete)).toHaveLength(2);
			const fileCalls = api.files.mock.calls.length;
			const identityCalls = api.pr.mock.calls.length;
			failing = false;
			now += 60_001;
			expect((await run()).status).toBe("ready");
			expect(api.files.mock.calls.length - fileCalls).toBe(
				phase === "metadata" ? 0 : 1,
			);
			expect(api.pr.mock.calls.length - identityCalls).toBe(
				phase === "metadata" ? 0 : 1,
			);
			expect(refreshStore.read(now)?.prs.every((pr) => pr.filesComplete)).toBe(
				true,
			);
		} finally {
			store.close();
		}
	},
);
