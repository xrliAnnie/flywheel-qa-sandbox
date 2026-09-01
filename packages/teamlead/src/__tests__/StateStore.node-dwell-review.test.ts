import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

describe("StateStore FLY-2210 node dwell review receipts", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => store.close());

	function rawDb(): {
		prepare(sql: string): { all(...params: unknown[]): unknown[] };
	} {
		return (
			store as unknown as {
				db: {
					raw: {
						prepare(sql: string): { all(...params: unknown[]): unknown[] };
					};
				};
			}
		).db.raw as never;
	}

	it("creates the founder-approved receipt schema with the four-column primary key", () => {
		const db = rawDb();
		const columns = db
			.prepare("PRAGMA table_info(node_dwell_review)")
			.all() as Array<{
			name: string;
			type: string;
			notnull: number;
			pk: number;
		}>;

		expect(
			columns.map(({ name, type, notnull, pk }) => ({
				name,
				type,
				notnull,
				pk,
			})),
		).toEqual([
			{ name: "run_id", type: "TEXT", notnull: 1, pk: 1 },
			{ name: "node_id", type: "TEXT", notnull: 1, pk: 2 },
			{ name: "attempt", type: "INTEGER", notnull: 1, pk: 3 },
			{ name: "cycle_no", type: "INTEGER", notnull: 1, pk: 4 },
			{ name: "verdict", type: "TEXT", notnull: 1, pk: 0 },
			{ name: "examined_at", type: "TEXT", notnull: 1, pk: 0 },
			{ name: "examined_by", type: "TEXT", notnull: 1, pk: 0 },
			{ name: "note", type: "TEXT", notnull: 0, pk: 0 },
		]);

		const table = db
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type='table' AND name='node_dwell_review'",
			)
			.all() as Array<{ sql: string }>;
		expect(table).toHaveLength(1);
		for (const verdict of ["normal", "cleared", "fixed", "waiting_founder"]) {
			expect(table[0]?.sql).toContain(`'${verdict}'`);
		}
	});
});
