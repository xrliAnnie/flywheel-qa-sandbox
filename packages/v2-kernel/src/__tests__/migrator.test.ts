import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openKernelDb } from "../connection.js";
import { MIGRATIONS } from "../migrations/index.js";
import { migrateDatabase, runMigrations } from "../migrator.js";
import { makeTempDatabase, type TempDatabase } from "./helpers.js";

const EXPECTED_TABLES = [
	"activations",
	"agents",
	"archive_manifest",
	"attempts",
	"capabilities",
	"command_dependencies",
	"commands",
	"config",
	"events",
	"gates",
	"mailbox",
	"meta",
	"obligations",
	"processing_attempts",
	"schema_migrations",
	"source_receipts",
	"task_dependencies",
	"tasks",
	"thread_bindings",
];

const EXPECTED_NAMED_INDEXES = [
	"activations_one_per_attempt",
	"activations_one_per_session",
	"attempts_one_active_per_task",
	"mailbox_pending_age",
	"mailbox_pending_immediate",
	"mailbox_pending_immediate_f",
	"mailbox_pending_immediate_nf",
	"mailbox_pending_scheduled",
	"mailbox_pending_scheduled_f",
	"mailbox_pending_scheduled_nf",
	"obligations_episode_open",
	"pa_one_running",
	"thread_bindings_one_active",
];

describe("v2 migration chain", () => {
	let temp: TempDatabase | undefined;

	afterEach(() => {
		temp?.cleanup();
		temp = undefined;
	});

	it("creates the authoritative 17-table schema and all named indexes from zero", () => {
		temp = makeTempDatabase();
		expect(migrateDatabase({ path: temp.path })).toEqual({
			applied: MIGRATIONS.map((migration) => migration.id),
		});

		const db = new Database(temp.path, { readonly: true });
		try {
			const tables = db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
				)
				.pluck()
				.all();
			const indexes = db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
				)
				.pluck()
				.all();

			expect(tables).toEqual(EXPECTED_TABLES);
			expect(indexes).toEqual(EXPECTED_NAMED_INDEXES);
			expect(db.pragma("foreign_key_check")).toEqual([]);
		} finally {
			db.close();
		}
	});

	it("is idempotent and leaves foreign key enforcement enabled", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			expect(runMigrations(db).applied).toEqual(
				MIGRATIONS.map((migration) => migration.id),
			);
			expect(runMigrations(db)).toEqual({ applied: [] });
			expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
			expect(
				db
					.prepare("SELECT id FROM schema_migrations ORDER BY id")
					.pluck()
					.all(),
			).toEqual(MIGRATIONS.map((migration) => migration.id));
		} finally {
			db.close();
		}
	});

	it("fails loudly when an applied migration's DDL checksum drifts", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db);
			const changed = [
				{ ...MIGRATIONS[0], ddl: `${MIGRATIONS[0]?.ddl}\n-- drift` },
				...MIGRATIONS.slice(1),
			];
			expect(() => runMigrations(db, changed)).toThrow(/checksum mismatch/i);
		} finally {
			db.close();
		}
	});
});
