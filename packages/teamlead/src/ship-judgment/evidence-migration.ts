import type Database from "better-sqlite3";
import { EVIDENCE_LEDGER_MIGRATION } from "./evidence-ledger.js";

/** Rebuild the immutable parent table without dropping clarification children or weakening old constraints. */
export function migrateEvidenceLedger(db: Database.Database): void {
	const applied = db
		.prepare("SELECT 1 FROM state_store_migration WHERE migration_id=?")
		.get(EVIDENCE_LEDGER_MIGRATION);
	const columns = db.pragma("table_info(ship_judgment_opinion)") as {
		name: string;
	}[];
	if (applied && columns.some((column) => column.name === "evidence_json"))
		return;
	if (applied || columns.some((column) => column.name === "evidence_json"))
		throw new Error("evidence_migration_schema_mismatch");
	const schema = db
		.prepare(
			"SELECT sql FROM sqlite_master WHERE type='table' AND name='ship_judgment_opinion'",
		)
		.get() as { sql: string } | undefined;
	const oldCheck =
		"CHECK((input_id IS NOT NULL AND evaluation_id IS NOT NULL) OR overall='undetermined')";
	if (!schema?.sql.includes(oldCheck))
		throw new Error("evidence_migration_legacy_schema_unknown");
	const foreignKeys = Number(db.pragma("foreign_keys", { simple: true }));
	const legacyAlter = Number(db.pragma("legacy_alter_table", { simple: true }));
	db.pragma("foreign_keys=OFF");
	// Other-table triggers reference the parent name during the temporary drop/rename gap.
	db.pragma("legacy_alter_table=ON");
	try {
		db.transaction(() => {
			const triggers = db
				.prepare(
					"SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='ship_judgment_opinion'",
				)
				.all() as { name: string; sql: string }[];
			if (
				triggers.length !== 3 ||
				triggers.some(
					(t) =>
						![
							"ship_judgment_opinion_no_update",
							"ship_judgment_opinion_no_delete",
							"ship_judgment_opinion_history_dirty",
						].includes(t.name),
				)
			)
				throw new Error("evidence_migration_triggers_unknown");
			const indexes = db
				.prepare(
					"SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='ship_judgment_opinion' AND sql IS NOT NULL",
				)
				.all() as { sql: string }[];
			for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger.name}`);
			db.exec(
				schema.sql
					.replace(
						/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?ship_judgment_opinion["`]?/i,
						"CREATE TABLE ship_judgment_opinion_new",
					)
					.replace(
						oldCheck,
						"evidence_json TEXT NULL CHECK(evidence_json IS NULL OR (json_valid(evidence_json) AND length(CAST(evidence_json AS BLOB))<=49152)), CHECK((input_id IS NOT NULL AND evaluation_id IS NOT NULL) OR evidence_json IS NOT NULL OR overall='undetermined')",
					),
			);
			db.exec(
				"INSERT INTO ship_judgment_opinion_new SELECT *,NULL FROM ship_judgment_opinion",
			);
			db.exec("DROP TABLE ship_judgment_opinion");
			db.exec(
				"ALTER TABLE ship_judgment_opinion_new RENAME TO ship_judgment_opinion",
			);
			for (const index of indexes) db.exec(index.sql);
			for (const trigger of triggers) db.exec(trigger.sql);
			// Unrelated historical violations must not block this table migration.
			if (
				(db.pragma("foreign_key_check(ship_judgment_opinion)") as unknown[])
					.length ||
				(
					db.pragma(
						"foreign_key_check(ship_judgment_clarification)",
					) as unknown[]
				).length
			)
				throw new Error("evidence_migration_foreign_key_check");
			db.prepare(
				"INSERT INTO state_store_migration(migration_id,applied_at) VALUES (?,?)",
			).run(EVIDENCE_LEDGER_MIGRATION, new Date().toISOString());
		}).immediate();
	} finally {
		db.pragma(`legacy_alter_table=${legacyAlter}`);
		db.pragma(`foreign_keys=${foreignKeys}`);
	}
}
