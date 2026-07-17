import { afterEach, describe, expect, it } from "vitest";
import { resolveUsageStore, syncLocalToRemote } from "../store/index.js";
import { LocalSqliteUsageStore } from "../store/local-sqlite-store.js";
import {
	type SupabaseLike,
	SupabaseUsageStore,
} from "../store/supabase-store.js";
import type { DailyRow } from "../types.js";

function row(p: Partial<DailyRow>): DailyRow {
	return {
		day: "2026-06-26",
		scope: "total",
		dimKey: "",
		project: null,
		inputTokens: 1,
		outputTokens: 2,
		cacheReadTokens: 3,
		cacheWriteTokens: 4,
		totalTokens: 10,
		freshTokens: 7,
		costMicroUsd: 100,
		isCompleted: null,
		...p,
	};
}

const stores: LocalSqliteUsageStore[] = [];
function mem(): LocalSqliteUsageStore {
	const s = new LocalSqliteUsageStore(":memory:");
	stores.push(s);
	return s;
}
afterEach(() => {
	while (stores.length) stores.pop()?.close();
});

describe("LocalSqliteUsageStore", () => {
	it("round-trips rows including isCompleted tri-state", async () => {
		const s = mem();
		await s.replaceDaily("2026-06-26", [
			row({
				scope: "issue",
				dimKey: "FLY-1",
				project: "flywheel",
				isCompleted: true,
			}),
			row({
				scope: "issue",
				dimKey: "FLY-2",
				project: "flywheel",
				isCompleted: false,
			}),
			row({ scope: "total", dimKey: "", isCompleted: null }),
		]);
		const got = await s.queryDaily({ scope: "issue" });
		expect(got).toHaveLength(2);
		expect(got.find((r) => r.dimKey === "FLY-1")?.isCompleted).toBe(true);
		expect(got.find((r) => r.dimKey === "FLY-2")?.isCompleted).toBe(false);
	});

	it("replaceDaily removes stale rows (delete-then-insert)", async () => {
		const s = mem();
		await s.replaceDaily("2026-06-26", [
			row({ scope: "project", dimKey: "flywheel" }),
			row({ scope: "project", dimKey: "sub" }),
		]);
		await s.replaceDaily("2026-06-26", [
			row({ scope: "project", dimKey: "flywheel" }),
		]); // sub disappears
		const got = await s.queryDaily({ scope: "project" });
		expect(got.map((r) => r.dimKey)).toEqual(["flywheel"]);
	});

	it("replaceDaily only touches the given day", async () => {
		const s = mem();
		await s.replaceDaily("2026-06-25", [row({ day: "2026-06-25" })]);
		await s.replaceDaily("2026-06-26", [row({ day: "2026-06-26" })]);
		await s.replaceDaily("2026-06-26", []); // wipe only 26
		expect(
			await s.queryDaily({ since: "2026-06-25", until: "2026-06-25" }),
		).toHaveLength(1);
		expect(
			await s.queryDaily({ since: "2026-06-26", until: "2026-06-26" }),
		).toHaveLength(0);
	});

	it("is atomic: a failing insert rolls back the delete (old rows survive)", async () => {
		const s = mem();
		await s.replaceDaily("2026-06-26", [
			row({ scope: "total", dimKey: "", totalTokens: 999 }),
		]);
		// two rows with identical PK (day,scope,dim_key) → second insert violates PK → throws
		await expect(
			s.replaceDaily("2026-06-26", [
				row({ scope: "project", dimKey: "dup" }),
				row({ scope: "project", dimKey: "dup" }),
			]),
		).rejects.toThrow();
		const got = await s.queryDaily();
		expect(got).toHaveLength(1);
		expect(got[0]?.totalTokens).toBe(999); // original preserved
	});

	it("tracks pending/synced for fallback replay", async () => {
		const s = mem();
		await s.replaceDaily("2026-06-26", [row({})]);
		expect(s.pendingDays()).toEqual(["2026-06-26"]);
		s.markDaySynced("2026-06-26");
		expect(s.pendingDays()).toEqual([]);
	});

	it("marks an EMPTY-day replacement pending so the clear is replayed to remote (Codex R1)", async () => {
		const s = mem();
		await s.replaceDaily("2026-06-26", []); // zero-token day → must still sync to clear remote
		expect(s.pendingDays()).toEqual(["2026-06-26"]);
	});
});

describe("SupabaseUsageStore (mocked client)", () => {
	function dbRows(count: number): Record<string, unknown>[] {
		return Array.from({ length: count }, (_, i) => ({
			day: `2026-06-${String(Math.floor(i / 100) + 1).padStart(2, "0")}`,
			scope: "project",
			dim_key: `project-${String(i).padStart(4, "0")}`,
			total_tokens: i + 1,
		}));
	}

	function cappedQueryClient(
		rows: Record<string, unknown>[],
		serverCap: number,
		options: { alwaysFull?: boolean } = {},
	): {
		client: SupabaseLike;
		ops: unknown[][];
		ranges: [number, number][];
	} {
		const ops: unknown[][] = [];
		const ranges: [number, number][] = [];
		const client: SupabaseLike = {
			rpc: () => Promise.resolve({ error: null }),
			from: () => {
				let from = 0;
				let to = 999;
				const builder = {
					select(c: string) {
						ops.push(["select", c]);
						return this;
					},
					gte(c: string, v: string) {
						ops.push(["gte", c, v]);
						return this;
					},
					lte(c: string, v: string) {
						ops.push(["lte", c, v]);
						return this;
					},
					eq(c: string, v: string) {
						ops.push(["eq", c, v]);
						return this;
					},
					order(c: string) {
						ops.push(["order", c]);
						return this;
					},
					range(start: number, end: number) {
						from = start;
						to = end;
						ranges.push([start, end]);
						ops.push(["range", start, end]);
						return this;
					},
					// biome-ignore lint/suspicious/noThenProperty: mock must be awaitable like the real supabase query builder
					then(resolve: (x: { data: unknown[]; error: null }) => void) {
						const length = Math.min(serverCap, to - from + 1);
						const data = options.alwaysFull
							? Array.from({ length }, (_, i) => ({
									day: "2026-06-26",
									scope: "project",
									dim_key: `pathological-${from + i}`,
									total_tokens: 1,
								}))
							: rows.slice(from, Math.min(to + 1, from + serverCap));
						resolve({ data, error: null });
					},
				};
				return builder;
			},
		};
		return { client, ops, ranges };
	}

	it("replaceDaily calls the atomic RPC with day/source/rows", async () => {
		let captured: { fn: string; args: Record<string, unknown> } | null = null;
		const client: SupabaseLike = {
			rpc: (fn, args) => {
				captured = { fn, args };
				return Promise.resolve({ error: null });
			},
			from: () => ({}),
		};
		const store = new SupabaseUsageStore(client);
		await store.replaceDaily("2026-06-26", [
			row({ scope: "project", dimKey: "flywheel", totalTokens: 42 }),
		]);
		expect(captured?.fn).toBe("replace_token_usage_daily");
		expect(captured?.args.p_day).toBe("2026-06-26");
		expect(captured?.args.p_source).toBe("cc-jsonl");
		expect((captured?.args.p_rows as unknown[])[0]).toMatchObject({
			scope: "project",
			dim_key: "flywheel",
			total_tokens: 42,
		});
	});

	it("replaceDaily throws on RPC error", async () => {
		const client: SupabaseLike = {
			rpc: () => Promise.resolve({ error: { message: "boom" } }),
			from: () => ({}),
		};
		await expect(
			new SupabaseUsageStore(client).replaceDaily("2026-06-26", [row({})]),
		).rejects.toThrow(/boom/);
	});

	it("queryDaily builds the filter chain and maps rows", async () => {
		const ops: unknown[][] = [];
		let rangeStart = 0;
		const builder = {
			select(c: string) {
				ops.push(["select", c]);
				return this;
			},
			gte(c: string, v: string) {
				ops.push(["gte", c, v]);
				return this;
			},
			lte(c: string, v: string) {
				ops.push(["lte", c, v]);
				return this;
			},
			eq(c: string, v: string) {
				ops.push(["eq", c, v]);
				return this;
			},
			order(c: string) {
				ops.push(["order", c]);
				return this;
			},
			range(from: number, to: number) {
				rangeStart = from;
				ops.push(["range", from, to]);
				return this;
			},
			// biome-ignore lint/suspicious/noThenProperty: mock must be awaitable like the real supabase query builder
			then(res: (x: { data: unknown; error: null }) => void) {
				res({
					data:
						rangeStart === 0
							? [
									{
										day: "2026-06-26",
										scope: "total",
										dim_key: "",
										total_tokens: 5,
									},
								]
							: [],
					error: null,
				});
			},
		};
		const client: SupabaseLike = {
			rpc: () => Promise.resolve({ error: null }),
			from: () => builder,
		};
		const got = await new SupabaseUsageStore(client).queryDaily({
			since: "2026-06-01",
			scope: "total",
			project: "flywheel",
		});
		expect(got[0]).toMatchObject({
			day: "2026-06-26",
			scope: "total",
			totalTokens: 5,
		});
		expect(ops).toContainEqual(["gte", "day", "2026-06-01"]);
		expect(ops).toContainEqual(["eq", "scope", "total"]);
		expect(ops.filter((op) => op[0] === "order").slice(0, 3)).toEqual([
			["order", "day"],
			["order", "scope"],
			["order", "dim_key"],
		]);
	});

	it("queryDaily paginates beyond PostgREST's 1000-row cap", async () => {
		const rows = dbRows(1_252);
		const { client, ranges } = cappedQueryClient(rows, 1_000);

		const got = await new SupabaseUsageStore(client).queryDaily();

		expect(got).toHaveLength(1_252);
		expect(got.at(-1)?.dimKey).toBe("project-1251");
		expect(ranges).toEqual([
			[0, 999],
			[1_000, 1_999],
			[1_252, 2_251],
		]);
	});

	it("queryDaily advances by the actual batch length when the server cap is smaller", async () => {
		const rows = dbRows(1_252);
		const { client, ranges } = cappedQueryClient(rows, 10);

		const got = await new SupabaseUsageStore(client).queryDaily();

		expect(got).toHaveLength(1_252);
		expect(ranges.slice(0, 3)).toEqual([
			[0, 999],
			[10, 1_009],
			[20, 1_019],
		]);
		expect(ranges.at(-1)).toEqual([1_252, 2_251]);
	});

	it("queryDaily fails loudly at the 100000-row safety fuse", async () => {
		const { client, ranges } = cappedQueryClient([], 1_000, {
			alwaysFull: true,
		});

		await expect(new SupabaseUsageStore(client).queryDaily()).rejects.toThrow(
			/99000.*100000|100000.*99000/,
		);
		expect(ranges).toHaveLength(100);
	});
});

describe("resolveUsageStore + sync", () => {
	it("falls back to local with a warning when no Supabase creds", async () => {
		const r = await resolveUsageStore({ localPath: ":memory:", env: {} });
		expect(r.mode).toBe("local");
		expect(r.warning).toMatch(/creds absent/);
		r.store.close?.();
	});

	it("syncLocalToRemote replays pending days then marks synced", async () => {
		const local = mem();
		await local.replaceDaily("2026-06-26", [row({})]);
		const pushed: string[] = [];
		const remote = {
			replaceDaily: (day: string) => {
				pushed.push(day);
				return Promise.resolve();
			},
			queryDaily: () => Promise.resolve([]),
		};
		const synced = await syncLocalToRemote(local, remote);
		expect(synced).toEqual(["2026-06-26"]);
		expect(pushed).toEqual(["2026-06-26"]);
		expect(local.pendingDays()).toEqual([]);
	});

	it("syncLocalToRemote replays an empty-day clear (remote.replaceDaily called with [])", async () => {
		const local = mem();
		await local.replaceDaily("2026-06-26", []); // empty day
		let pushedRows: number | null = null;
		const remote = {
			replaceDaily: (_day: string, rows: DailyRow[]) => {
				pushedRows = rows.length;
				return Promise.resolve();
			},
			queryDaily: () => Promise.resolve([]),
		};
		await syncLocalToRemote(local, remote);
		expect(pushedRows).toBe(0); // remote cleared for that day
		expect(local.pendingDays()).toEqual([]);
	});
});
