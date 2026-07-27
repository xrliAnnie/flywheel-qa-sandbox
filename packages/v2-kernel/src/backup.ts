import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	linkSync,
	mkdirSync,
	openSync,
	unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { openKernelDb } from "./connection.js";

interface MigrationRecord {
	id: string;
	checksum: string;
}

function migrationRecords(db: Database.Database): MigrationRecord[] {
	return db
		.prepare("SELECT id, checksum FROM schema_migrations ORDER BY id")
		.all() as MigrationRecord[];
}

function validateCopy(
	source: Database.Database,
	copy: Database.Database,
): void {
	const integrity = copy.pragma("integrity_check", { simple: true });
	if (integrity !== "ok") {
		throw new Error(`backup integrity_check failed: ${String(integrity)}`);
	}
	const foreignKeyViolations = copy.pragma("foreign_key_check") as unknown[];
	if (foreignKeyViolations.length > 0) {
		throw new Error(
			`backup foreign_key_check failed: ${JSON.stringify(foreignKeyViolations)}`,
		);
	}
	const sourceMigrations = migrationRecords(source);
	const copyMigrations = migrationRecords(copy);
	if (JSON.stringify(copyMigrations) !== JSON.stringify(sourceMigrations)) {
		throw new Error(
			"backup schema_migrations do not match the source snapshot",
		);
	}
}

function cleanupTempArtifacts(tempPath: string): void {
	for (const path of [
		tempPath,
		`${tempPath}-journal`,
		`${tempPath}-shm`,
		`${tempPath}-wal`,
	]) {
		if (existsSync(path)) {
			unlinkSync(path);
		}
	}
}

export async function backupDatabase(
	srcPath: string,
	destPath: string,
): Promise<void> {
	if (!srcPath || !destPath) {
		throw new TypeError("backup source and destination paths are required");
	}
	if (resolve(srcPath) === resolve(destPath)) {
		throw new TypeError("backup destination must differ from source");
	}

	const destDir = dirname(destPath);
	mkdirSync(destDir, { recursive: true, mode: 0o700 });
	chmodSync(destDir, 0o700);
	const tempPath = join(destDir, `.${basename(destPath)}.${randomUUID()}.tmp`);
	const source = openKernelDb({ path: srcPath, readonly: true });
	try {
		closeSync(openSync(tempPath, "wx", 0o600));
		await source.backup(tempPath);
		chmodSync(tempPath, 0o600);
		const copy = openKernelDb({ path: tempPath, readonly: true });
		try {
			validateCopy(source, copy);
		} finally {
			copy.close();
		}

		linkSync(tempPath, destPath);
	} finally {
		source.close();
		cleanupTempArtifacts(tempPath);
	}
}
