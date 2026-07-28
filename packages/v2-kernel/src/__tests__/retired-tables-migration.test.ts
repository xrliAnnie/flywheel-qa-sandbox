import { afterEach, describe, expect, it } from "vitest";
import { openKernelDb } from "../connection.js";
import { MIGRATIONS } from "../migrations/index.js";
import { runMigrations } from "../migrator.js";
import { makeTempDatabase, type TempDatabase } from "./helpers.js";
import { seedRetiredRows } from "./retired-tables-test-helpers.js";

describe("0008 retired command and obligation tables", () => {
	let temp: TempDatabase | undefined;

	afterEach(() => {
		temp?.cleanup();
		temp = undefined;
	});

	it("discards populated retired tables with an exact durable count receipt", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db, MIGRATIONS.slice(0, -1));
			seedRetiredRows(db);

			expect(runMigrations(db, MIGRATIONS.slice(-1))).toEqual({
				applied: ["0008-drop-retired-command-obligation-tables"],
			});
			expect(
				db
					.prepare(
						`SELECT name FROM sqlite_master
						 WHERE type='table'
						   AND name IN ('commands','command_dependencies','obligations')`,
					)
					.pluck()
					.all(),
			).toEqual([]);
			expect(
				JSON.parse(
					db
						.prepare(
							`SELECT payload FROM events
							 WHERE event_uid='migration:0008:retired-rows-discarded'`,
						)
						.pluck()
						.get() as string,
				),
			).toEqual({
				commands: 2,
				command_dependencies: 1,
				obligations: 2,
			});
			expect(db.pragma("foreign_key_check")).toEqual([]);
		} finally {
			db.close();
		}
	});
});
