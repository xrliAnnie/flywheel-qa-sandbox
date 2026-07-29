import type Database from "better-sqlite3";
import { openKernelDb } from "./connection.js";
import {
	MIGRATIONS,
	type Migration,
	migrationChecksum,
} from "./migrations/index.js";
import type { MigrateOptions } from "./types.js";

const MIGRATION_TABLE_DDL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  id         TEXT PRIMARY KEY NOT NULL,
  checksum   TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;

interface AppliedMigration {
	checksum: string;
}

function foreignKeysEnabled(db: Database.Database): boolean {
	return db.pragma("foreign_keys", { simple: true }) === 1;
}

function assertForeignKeysEnabled(db: Database.Database): void {
	if (!foreignKeysEnabled(db)) {
		throw new Error("foreign key enforcement must be enabled");
	}
}

function validateAppliedChecksum(
	migration: Migration,
	row: AppliedMigration | undefined,
): boolean {
	if (!row) {
		return false;
	}
	const expected = migrationChecksum(migration.ddl);
	if (row.checksum !== expected) {
		throw new Error(
			`migration ${migration.id} checksum mismatch: expected ${expected}, found ${row.checksum}`,
		);
	}
	return true;
}

function readApplied(
	db: Database.Database,
	migration: Migration,
): AppliedMigration | undefined {
	return db
		.prepare("SELECT checksum FROM schema_migrations WHERE id = ?")
		.get(migration.id) as AppliedMigration | undefined;
}

function recordApplied(db: Database.Database, migration: Migration): void {
	db.prepare(
		"INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)",
	).run(
		migration.id,
		migrationChecksum(migration.ddl),
		new Date().toISOString(),
	);
}

function ensureMigrationTable(db: Database.Database): void {
	db.transaction(() => {
		db.exec(MIGRATION_TABLE_DDL);
	}).immediate();
}

function applyForeignKeysOnMigration(
	db: Database.Database,
	migration: Migration,
): boolean {
	return db
		.transaction(() => {
			const row = readApplied(db, migration);
			if (validateAppliedChecksum(migration, row)) {
				return false;
			}
			db.exec(migration.ddl);
			recordApplied(db, migration);
			return true;
		})
		.immediate();
}

function applyRebuildMigration(
	db: Database.Database,
	migration: Migration,
): boolean {
	assertForeignKeysEnabled(db);
	db.pragma("foreign_keys = OFF");
	try {
		return db
			.transaction(() => {
				const row = readApplied(db, migration);
				if (validateAppliedChecksum(migration, row)) {
					return false;
				}
				db.exec(migration.ddl);
				const violations = db.pragma("foreign_key_check") as unknown[];
				if (violations.length > 0) {
					throw new Error(
						`migration ${migration.id} failed foreign_key_check: ${JSON.stringify(violations)}`,
					);
				}
				recordApplied(db, migration);
				return true;
			})
			.immediate();
	} finally {
		db.pragma("foreign_keys = ON");
		assertForeignKeysEnabled(db);
	}
}

export function runMigrations(
	db: Database.Database,
	migrations: readonly Migration[] = MIGRATIONS,
): { applied: string[] } {
	assertForeignKeysEnabled(db);
	ensureMigrationTable(db);
	const applied: string[] = [];

	for (const migration of migrations) {
		const didApply =
			migration.fkMode === "rebuild"
				? applyRebuildMigration(db, migration)
				: applyForeignKeysOnMigration(db, migration);
		if (didApply) {
			applied.push(migration.id);
		}
	}

	return { applied };
}

export function migrateDatabase(opts: MigrateOptions): { applied: string[] } {
	const db = openKernelDb(opts);
	try {
		return runMigrations(db);
	} finally {
		db.close();
	}
}
