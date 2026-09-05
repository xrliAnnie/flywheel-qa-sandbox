import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";

export const FLY2268_REBUILD_RECEIPT_SUFFIX = ".fly2268-rebuild-receipt.json";

export interface Fly2268CommDbRebuildReceipt {
	backupPath: string;
	backupSha256: string;
	sourceBinding: {
		mainSha256: string;
		walSha256: string | null;
	};
	sourceSchemaDigest: string;
	createdAt: string;
}

export class CommDbPreflightStaleError extends Error {
	constructor(detail: string) {
		super(`commdb_schema_preflight_stale: ${detail}`);
		this.name = "CommDbPreflightStaleError";
	}
}

function sha256Bytes(value: Buffer | string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function sha256File(path: string): string {
	return sha256Bytes(readFileSync(path));
}

export function commDbSourceBinding(dbPath: string): {
	mainSha256: string;
	walSha256: string | null;
} {
	return {
		mainSha256: sha256File(dbPath),
		walSha256: existsSync(`${dbPath}-wal`) ? sha256File(`${dbPath}-wal`) : null,
	};
}

function inspectRunnerShutdownSchema(dbPath: string): {
	legacy: boolean;
	sql: string | null;
} {
	if (!existsSync(dbPath)) return { legacy: false, sql: null };
	const sourceHasWal = existsSync(`${dbPath}-wal`);
	let snapshotDir: string | undefined;
	let probePath = dbPath;
	if (!sourceHasWal) {
		snapshotDir = mkdtempSync(join(tmpdir(), "flywheel-commdb-probe-"));
		probePath = join(snapshotDir, "comm.db");
		copyFileSync(dbPath, probePath);
	}
	const probe = new Database(probePath, {
		readonly: true,
		fileMustExist: true,
	});
	try {
		const columns = probe
			.prepare("PRAGMA table_info(runner_shutdown_controls)")
			.all() as Array<{ name: string; pk: number }>;
		const schema = probe
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runner_shutdown_controls'",
			)
			.get() as { sql?: string } | undefined;
		if (columns.length === 0) return { legacy: false, sql: null };
		const execution = columns.find((column) => column.name === "execution_id");
		const request = columns.find((column) => column.name === "request_id");
		return {
			legacy: execution?.pk === 1 && request?.pk !== 2,
			sql: schema?.sql ?? null,
		};
	} finally {
		probe.close();
		if (snapshotDir) rmSync(snapshotDir, { recursive: true, force: true });
	}
}

function connectionHasLegacyRunnerShutdownPrimaryKey(
	db: Database.Database,
): boolean {
	const columns = db
		.prepare("PRAGMA table_info(runner_shutdown_controls)")
		.all() as Array<{ name: string; pk: number }>;
	if (columns.length === 0) return false;
	const execution = columns.find((column) => column.name === "execution_id");
	const request = columns.find((column) => column.name === "request_id");
	return execution?.pk === 1 && request?.pk !== 2;
}

export function hasLegacyRunnerShutdownPrimaryKey(dbPath: string): boolean {
	return inspectRunnerShutdownSchema(dbPath).legacy;
}

export function runnerShutdownSchemaDigest(dbPath: string): string {
	const sql = inspectRunnerShutdownSchema(dbPath).sql;
	if (!sql) {
		throw new Error(
			"commdb_schema_preflight_required: shutdown schema missing",
		);
	}
	return sha256Bytes(sql);
}

function parseReceipt(
	dbPath: string,
	receiptPath: string,
): Fly2268CommDbRebuildReceipt {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(receiptPath, "utf8"));
	} catch (error) {
		throw new Error(
			`commdb_schema_preflight_required: invalid ${receiptPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!value || typeof value !== "object") {
		throw new Error(`commdb_schema_preflight_required: invalid ${receiptPath}`);
	}
	const receipt = value as Partial<Fly2268CommDbRebuildReceipt>;
	const hashes = [
		receipt.backupSha256,
		receipt.sourceBinding?.mainSha256,
		receipt.sourceSchemaDigest,
	];
	if (
		typeof receipt.backupPath !== "string" ||
		typeof receipt.createdAt !== "string" ||
		!receipt.sourceBinding ||
		hashes.some(
			(hash) => typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash),
		) ||
		(receipt.sourceBinding.walSha256 !== null &&
			(typeof receipt.sourceBinding.walSha256 !== "string" ||
				!/^[a-f0-9]{64}$/.test(receipt.sourceBinding.walSha256))) ||
		dirname(receipt.backupPath) !== dirname(dbPath) ||
		!basename(receipt.backupPath).startsWith(`${basename(dbPath)}.pre-fly2268-`)
	) {
		throw new Error(`commdb_schema_preflight_required: invalid ${receiptPath}`);
	}
	return receipt as Fly2268CommDbRebuildReceipt;
}

function sameBinding(
	left: Fly2268CommDbRebuildReceipt["sourceBinding"],
	right: Fly2268CommDbRebuildReceipt["sourceBinding"],
): boolean {
	return (
		left.mainSha256 === right.mainSha256 && left.walSha256 === right.walSha256
	);
}

function assertVerifiedReceiptBeforeLock(
	dbPath: string,
	db: Database.Database,
	receipt: Fly2268CommDbRebuildReceipt,
): void {
	if (!existsSync(receipt.backupPath)) {
		throw new Error("commdb_schema_preflight_required: backup missing");
	}
	if (sha256File(receipt.backupPath) !== receipt.backupSha256) {
		throw new Error("commdb_schema_preflight_required: backup hash mismatch");
	}
	const backup = new Database(receipt.backupPath, {
		readonly: true,
		fileMustExist: true,
	});
	try {
		if (String(backup.pragma("quick_check", { simple: true })) !== "ok") {
			throw new Error(
				"commdb_schema_preflight_required: backup quick_check failed",
			);
		}
	} finally {
		backup.close();
	}
	if (!sameBinding(commDbSourceBinding(dbPath), receipt.sourceBinding)) {
		throw new CommDbPreflightStaleError("source binding mismatch");
	}
	const schema = db
		.prepare(
			"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runner_shutdown_controls'",
		)
		.get() as { sql?: string } | undefined;
	if (!schema?.sql || sha256Bytes(schema.sql) !== receipt.sourceSchemaDigest) {
		throw new Error("commdb_schema_preflight_required: schema digest mismatch");
	}
}

function rebuildRunnerShutdownControls(db: Database.Database): void {
	const before = (
		db
			.prepare("SELECT COUNT(*) AS count FROM runner_shutdown_controls")
			.get() as {
			count: number;
		}
	).count;
	// FLY-1572 poison views intentionally reference missing tables. Legacy alter
	// mode prevents this unrelated table rebuild from reparsing those views.
	db.pragma("legacy_alter_table = ON");
	try {
		db.exec(`
			CREATE TABLE runner_shutdown_controls_fly2268 (
				execution_id TEXT NOT NULL,
				request_id TEXT NOT NULL,
				state TEXT NOT NULL CHECK(state IN ('requested','acked','failed')),
				requested_at INTEGER NOT NULL,
				finished_at INTEGER,
				error TEXT,
				settlement_reason TEXT,
				PRIMARY KEY (execution_id, request_id)
			);
			INSERT INTO runner_shutdown_controls_fly2268
				(execution_id, request_id, state, requested_at, finished_at, error, settlement_reason)
			SELECT execution_id, request_id, state, requested_at, finished_at, error, NULL
			FROM runner_shutdown_controls;
			DROP TABLE runner_shutdown_controls;
			ALTER TABLE runner_shutdown_controls_fly2268 RENAME TO runner_shutdown_controls;
		`);
	} finally {
		db.pragma("legacy_alter_table = OFF");
	}
	const after = (
		db
			.prepare("SELECT COUNT(*) AS count FROM runner_shutdown_controls")
			.get() as {
			count: number;
		}
	).count;
	if (after !== before) {
		throw new Error(
			`commdb_schema_preflight_required: shutdown row count changed (${before} -> ${after})`,
		);
	}
}

/**
 * FLY-2268: the only writable opener for CommDB files. A legacy shutdown
 * primary key must never be touched until the asynchronous Bridge preflight
 * has durably bound an intact backup to this exact source snapshot.
 */
let warnedLegacyWithoutReceipt = false;
let warnedLegacyWithStaleReceipt = false;

export function openCommDbWritable(dbPath: string): Database.Database {
	const opened = new Database(dbPath);
	opened.pragma("busy_timeout = 5000");
	const receiptPath = `${dbPath}${FLY2268_REBUILD_RECEIPT_SUFFIX}`;
	let consumed = false;
	try {
		if (!connectionHasLegacyRunnerShutdownPrimaryKey(opened)) {
			return opened;
		}
		if (!existsSync(receiptPath)) {
			if (!warnedLegacyWithoutReceipt) {
				warnedLegacyWithoutReceipt = true;
				console.warn(
					`[FLY-2268] CommDB legacy shutdown key remains writable until Bridge preflight publishes ${receiptPath}`,
				);
			}
			return opened;
		}
		const dataVersionBeforeValidation = Number(
			opened.pragma("data_version", { simple: true }),
		);
		const receipt = parseReceipt(dbPath, receiptPath);
		// Whole-backup and source-binding validation happens without a write lock.
		// data_version below closes the race between this work and BEGIN IMMEDIATE.
		assertVerifiedReceiptBeforeLock(dbPath, opened, receipt);
		opened.exec("BEGIN IMMEDIATE");
		// A concurrent migration winner may have completed while this connection
		// waited. The loser succeeds without trying to reuse the consumed receipt.
		if (!connectionHasLegacyRunnerShutdownPrimaryKey(opened)) {
			opened.exec("COMMIT");
			return opened;
		}
		const dataVersionAfterLock = Number(
			opened.pragma("data_version", { simple: true }),
		);
		if (dataVersionAfterLock !== dataVersionBeforeValidation) {
			throw new CommDbPreflightStaleError(
				"source changed before migration lock",
			);
		}
		rebuildRunnerShutdownControls(opened);
		opened.exec("COMMIT");
		consumed = true;
	} catch (error) {
		if (opened.inTransaction) opened.exec("ROLLBACK");
		if (error instanceof CommDbPreflightStaleError) {
			if (!warnedLegacyWithStaleReceipt) {
				warnedLegacyWithStaleReceipt = true;
				console.warn(
					`[FLY-2268] ${error.message}; legacy CommDB remains writable until Bridge refreshes ${receiptPath}`,
				);
			}
			return opened;
		}
		opened.close();
		throw error;
	}
	if (consumed) {
		const consumedPath = `${receiptPath}.consumed-${new Date()
			.toISOString()
			.replaceAll(":", "-")}`;
		renameSync(receiptPath, consumedPath);
	}
	return opened;
}
