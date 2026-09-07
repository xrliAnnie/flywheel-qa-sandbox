import { describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	ShipRelevantDiffService,
	type ShipRelevantGitHubApi,
	type ShipRelevantRefreshCandidate,
	type ShipRelevantRunRefresh,
} from "../ship-relevant-diff.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

function candidate(input: {
	executionId: string;
	repoSlug: string;
	prNumber: number;
	role: "primary" | "declared";
	api: ShipRelevantGitHubApi;
	head?: string;
}): ShipRelevantRefreshCandidate {
	return {
		executionId: input.executionId,
		repoIdentity: input.role === "primary" ? "__main__" : input.repoSlug,
		repoSlug: input.repoSlug,
		prNumber: input.prNumber,
		prHeadSha: input.head ?? HEAD,
		role: input.role,
		api: input.api,
	};
}

function fixtureApi(
	kind: "code" | "docs",
	onCall: (path: string, signal: AbortSignal) => void = () => {},
): ShipRelevantGitHubApi {
	return async (path, { signal }) => {
		onCall(path, signal);
		if (/\/pulls\/\d+$/.test(path)) {
			return {
				head: { sha: HEAD },
				base: { ref: "main", sha: BASE },
				changed_files: 1,
				commits: 1,
			};
		}
		const page = Number(path.match(/[?&]page=(\d+)/)?.[1]);
		if (path.includes("/commits")) return page === 1 ? [{ sha: HEAD }] : [];
		if (path.includes("/files")) {
			return page === 1
				? [
						kind === "code"
							? { status: "modified", filename: "packages/app.ts" }
							: {
									status: "added",
									filename: "engineering/doc/FLY-2395/note.md",
								},
					]
				: [];
		}
		if (path.includes(`/git/trees/${HEAD}`)) {
			return {
				truncated: false,
				tree: [
					{
						path: "engineering/doc/FLY-2395/note.md",
						mode: "100644",
						type: "blob",
					},
				],
			};
		}
		throw new Error(`unexpected path ${path}`);
	};
}

describe("ShipRelevantDiffService batch refresh", () => {
	it("short-circuits every declared PR when the primary is ship-relevant", async () => {
		const store = await StateStore.create(":memory:");
		const now = 0;
		const primaryApi = vi.fn(fixtureApi("code"));
		const nestedApi = vi.fn(fixtureApi("docs"));
		const service = new ShipRelevantDiffService(store, { now: () => now });
		const run: ShipRelevantRunRefresh = {
			executionId: "exec-1",
			primary: candidate({
				executionId: "exec-1",
				repoSlug: "owner/main",
				prNumber: 41,
				role: "primary",
				api: primaryApi,
			}),
			declared: [
				candidate({
					executionId: "exec-1",
					repoSlug: "owner/nested",
					prNumber: 42,
					role: "declared",
					api: nestedApi,
				}),
			],
		};

		await service.refresh([run], { deadline: 2_500 });

		expect(primaryApi).toHaveBeenCalled();
		expect(nestedApi).not.toHaveBeenCalled();
		expect(
			store.getShipRelevantPrSnapshot("exec-1", "owner/main", 41),
		).toMatchObject({ ship_relevant: 1, role: "primary" });
		store.close();
	});

	it("enforces the pass request cap and skips overflow runs before I/O", async () => {
		const store = await StateStore.create(":memory:");
		let calls = 0;
		const api = fixtureApi("docs", () => {
			calls += 1;
		});
		const makeRun = (runIndex: number, declaredCount: number) => {
			const executionId = `exec-${runIndex}`;
			return {
				executionId,
				primary: candidate({
					executionId,
					repoSlug: `owner/main-${runIndex}`,
					prNumber: 100 + runIndex,
					role: "primary",
					api,
				}),
				declared: Array.from({ length: declaredCount }, (_, nestedIndex) =>
					candidate({
						executionId,
						repoSlug: `owner/nested-${runIndex}-${nestedIndex}`,
						prNumber: 200 + nestedIndex,
						role: "declared",
						api,
					}),
				),
			};
		};
		const service = new ShipRelevantDiffService(store, { now: () => 0 });

		await service.refresh([makeRun(1, 8), makeRun(2, 8), makeRun(3, 8)], {
			deadline: 2_500,
		});
		expect(calls).toBe(40);

		calls = 0;
		const overflowService = new ShipRelevantDiffService(store, {
			now: () => 0,
		});
		await overflowService.refresh([makeRun(4, 9)], { deadline: 2_500 });
		expect(calls).toBe(0);
		store.close();
	});

	it("lets two fast gates finish while another gate is waiting", async () => {
		const store = await StateStore.create(":memory:");
		let releaseSlow!: () => void;
		const slow = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		let firstSlowCall = true;
		const slowBase = fixtureApi("code");
		const slowApi: ShipRelevantGitHubApi = async (path, options) => {
			if (firstSlowCall) {
				firstSlowCall = false;
				await slow;
			}
			return slowBase(path, options);
		};
		const fastApi = fixtureApi("code");
		const run = (
			executionId: string,
			repoSlug: string,
			api: ShipRelevantGitHubApi,
		): ShipRelevantRunRefresh => ({
			executionId,
			primary: candidate({
				executionId,
				repoSlug,
				prNumber: 41,
				role: "primary",
				api,
			}),
			declared: [],
		});
		const service = new ShipRelevantDiffService(store, { now: () => 0 });
		const refresh = service.refresh(
			[
				run("exec-slow", "owner/slow", slowApi),
				run("exec-fast-1", "owner/fast-1", fastApi),
				run("exec-fast-2", "owner/fast-2", fastApi),
			],
			{ deadline: 2_500 },
		);

		await vi.waitFor(() => {
			expect(
				store.getShipRelevantPrSnapshot("exec-fast-1", "owner/fast-1", 41),
			).toBeDefined();
			expect(
				store.getShipRelevantPrSnapshot("exec-fast-2", "owner/fast-2", 41),
			).toBeDefined();
		});
		releaseSlow();
		await refresh;
		store.close();
	});

	it("never runs more than four candidate classifiers concurrently", async () => {
		const store = await StateStore.create(":memory:");
		let active = 0;
		let maxActive = 0;
		const baseApi = fixtureApi("code");
		const api: ShipRelevantGitHubApi = async (path, options) => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 2));
			try {
				return await baseApi(path, options);
			} finally {
				active -= 1;
			}
		};
		const runs = Array.from({ length: 6 }, (_, index) => {
			const executionId = `exec-${index}`;
			return {
				executionId,
				primary: candidate({
					executionId,
					repoSlug: `owner/repo-${index}`,
					prNumber: 41 + index,
					role: "primary",
					api,
				}),
				declared: [],
			};
		});
		const service = new ShipRelevantDiffService(store, { now: () => 0 });

		await service.refresh(runs, { deadline: 2_500 });

		expect(maxActive).toBe(4);
		store.close();
	});

	it("invalidates a 429 result and backs off without reusing the docs-only snapshot", async () => {
		const store = await StateStore.create(":memory:");
		store.putShipRelevantPrSnapshot({
			execution_id: "exec-1",
			repo_slug: "owner/main",
			pr_number: 41,
			pr_head_sha: HEAD,
			role: "primary",
			base_ref: "main",
			base_oid: BASE,
			classifier_version: 2,
			ship_relevant: 0,
			file_count: 1,
			commit_shas: [HEAD],
			computed_at: new Date(0).toISOString(),
		});
		let calls = 0;
		const api: ShipRelevantGitHubApi = async () => {
			calls += 1;
			throw Object.assign(new Error("rate limited"), { status: 429 });
		};
		const service = new ShipRelevantDiffService(store, { now: () => 0 });
		const input = {
			executionId: "exec-1",
			repo: "owner/main",
			prNumber: 41,
			prHeadSha: HEAD,
			api,
		};

		await expect(service.ensure(input)).resolves.toEqual({
			kind: "unknown",
			reason: "api_error",
		});
		expect(
			store.getShipRelevantPrSnapshot("exec-1", "owner/main", 41),
		).toBeUndefined();
		await service.ensure(input);
		expect(calls).toBe(1);
		store.close();
	});

	it("catches a declared-PR force-push by the 30s lease plus one poll", async () => {
		const store = await StateStore.create(":memory:");
		const nextHead = "c".repeat(40);
		let now = 0;
		let actualHead = HEAD;
		let kind: "docs" | "code" = "docs";
		const api: ShipRelevantGitHubApi = async (path) => {
			if (/\/pulls\/42$/.test(path)) {
				return {
					head: { sha: actualHead },
					base: { ref: "main", sha: BASE },
					changed_files: 1,
					commits: 1,
				};
			}
			const page = Number(path.match(/[?&]page=(\d+)/)?.[1]);
			if (path.includes("/commits")) {
				return page === 1 ? [{ sha: actualHead }] : [];
			}
			if (path.includes("/files")) {
				return page === 1
					? [
							kind === "docs"
								? {
										status: "added",
										filename: "engineering/doc/FLY-2395/note.md",
									}
								: { status: "modified", filename: "packages/app.ts" },
						]
					: [];
			}
			if (path.includes(`/git/trees/${HEAD}`)) {
				return {
					truncated: false,
					tree: [
						{
							path: "engineering/doc/FLY-2395/note.md",
							mode: "100644",
							type: "blob",
						},
					],
				};
			}
			throw new Error(`unexpected path ${path}`);
		};
		const service = new ShipRelevantDiffService(store, { now: () => now });
		const ensure = (head: string) =>
			service.ensure({
				executionId: "exec-1",
				repo: "owner/nested",
				prNumber: 42,
				prHeadSha: head,
				role: "declared",
				api,
			});

		await ensure(HEAD);
		now = 3_000;
		await ensure(HEAD);
		actualHead = nextHead;
		kind = "code";
		now = 30_000;
		await ensure(HEAD);
		expect(
			store.getShipRelevantPrSnapshot("exec-1", "owner/nested", 42),
		).toMatchObject({ ship_relevant: 0 });

		now = 33_000;
		await expect(ensure(HEAD)).resolves.toEqual({
			kind: "unknown",
			reason: "head_mismatch",
		});
		expect(
			store.getShipRelevantPrSnapshot("exec-1", "owner/nested", 42),
		).toBeUndefined();

		now = 36_000;
		await expect(ensure(nextHead)).resolves.toMatchObject({
			kind: "snapshot",
			snapshot: { ship_relevant: 1, pr_head_sha: nextHead },
		});
		store.close();
	});

	it("does not overlap passes and aborts the active GitHub subprocess signal at deadline", async () => {
		const store = await StateStore.create(":memory:");
		let now = 0;
		let observedSignal: AbortSignal | undefined;
		let calls = 0;
		const api: ShipRelevantGitHubApi = async (_path, { signal }) => {
			calls += 1;
			observedSignal = signal;
			await new Promise<void>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new Error("aborted")), {
					once: true,
				});
			});
		};
		const service = new ShipRelevantDiffService(store, { now: () => now });
		const run: ShipRelevantRunRefresh = {
			executionId: "exec-1",
			primary: candidate({
				executionId: "exec-1",
				repoSlug: "owner/main",
				prNumber: 41,
				role: "primary",
				api,
			}),
			declared: [],
		};

		const first = service.refresh([run], { deadline: 10 });
		await service.refresh([run], { deadline: 10 });
		expect(calls).toBe(1);
		await first;
		expect(observedSignal?.aborted).toBe(true);
		expect(
			(service as unknown as { inFlight: Map<string, unknown> }).inFlight.size,
		).toBe(0);
		for (let tick = 1; tick < 10; tick++) {
			now += 61_000;
			await service.refresh([run], { deadline: now + 5 });
			expect(
				(service as unknown as { inFlight: Map<string, unknown> }).inFlight
					.size,
			).toBe(0);
			expect(
				(service as unknown as { passInFlight?: Promise<void> }).passInFlight,
			).toBeUndefined();
		}
		store.close();
	});

	it("keeps both the normal and saturated one-hour soak within 1,500 requests", async () => {
		const soak = async (nestedCount: number) => {
			const store = await StateStore.create(":memory:");
			let now = 0;
			let calls = 0;
			const api = fixtureApi("docs", () => {
				calls += 1;
			});
			const runs: ShipRelevantRunRefresh[] = Array.from(
				{ length: 3 },
				(_, runIndex) => {
					const executionId = `exec-${runIndex}`;
					return {
						executionId,
						primary: candidate({
							executionId,
							repoSlug: `owner/main-${runIndex}`,
							prNumber: 100 + runIndex,
							role: "primary",
							api,
						}),
						declared: Array.from({ length: nestedCount }, (_, nestedIndex) =>
							candidate({
								executionId,
								repoSlug: `owner/nested-${runIndex}-${nestedIndex}`,
								prNumber: 200 + nestedIndex,
								role: "declared",
								api,
							}),
						),
					};
				},
			);
			const service = new ShipRelevantDiffService(store, { now: () => now });
			for (now = 0; now < 60 * 60_000; now += 3_000) {
				await service.refresh(runs, { deadline: now + 2_500 });
			}
			const currentSnapshots = runs
				.flatMap((run) => [run.primary, ...run.declared])
				.filter((entry) => {
					const snapshot = store.getShipRelevantPrSnapshot(
						entry.executionId,
						entry.repoSlug,
						entry.prNumber,
					);
					return (
						snapshot !== undefined &&
						now - Date.parse(snapshot.computed_at) <= 60_000
					);
				}).length;
			store.close();
			return {
				calls,
				currentSnapshots,
				totalCandidates: 3 * (nestedCount + 1),
			};
		};

		const normal = await soak(1);
		expect(normal.calls).toBeLessThanOrEqual(1_500);
		expect(normal.currentSnapshots).toBe(normal.totalCandidates);

		const saturated = await soak(8);
		expect(saturated.calls).toBeLessThanOrEqual(1_500);
		expect(saturated.currentSnapshots).toBeLessThan(saturated.totalCandidates);
	}, 60_000);
});
