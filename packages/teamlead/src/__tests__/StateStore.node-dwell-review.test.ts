import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
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
			{ name: "episode_started_at", type: "TEXT", notnull: 0, pk: 0 },
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

	it("adds episode provenance to a pre-FLY-2298 receipt table without losing rows", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2298-dwell-migration-"));
		const dbPath = join(dir, "teamlead.db");
		const legacy = new Database(dbPath);
		legacy.exec(`
			CREATE TABLE node_dwell_review (
				run_id TEXT NOT NULL,
				node_id TEXT NOT NULL,
				attempt INTEGER NOT NULL,
				cycle_no INTEGER NOT NULL,
				verdict TEXT NOT NULL CHECK (verdict IN
					('normal','cleared','fixed','waiting_founder')),
				examined_at TEXT NOT NULL,
				examined_by TEXT NOT NULL,
				note TEXT,
				PRIMARY KEY (run_id,node_id,attempt,cycle_no)
			);
			INSERT INTO node_dwell_review VALUES (
				'run-legacy','pm',1,1,'waiting_founder',
				'2026-09-05T01:00:00.000Z','flywheel-eng-lead','legacy receipt'
			);
		`);
		legacy.close();

		let migrated: StateStore | undefined;
		try {
			migrated = await StateStore.create(dbPath);
			const reopened = new Database(dbPath, { readonly: true });
			try {
				expect(
					reopened
						.prepare(
							"SELECT run_id, verdict, episode_started_at FROM node_dwell_review",
						)
						.get(),
				).toEqual({
					run_id: "run-legacy",
					verdict: "waiting_founder",
					episode_started_at: null,
				});
			} finally {
				reopened.close();
			}
		} finally {
			migrated?.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
