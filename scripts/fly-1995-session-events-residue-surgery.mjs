#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import {
	createReadStream,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	statfsSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const requireFromTeamlead = createRequire(
	join(repoRoot, "packages/teamlead/package.json"),
);
const Database = requireFromTeamlead("better-sqlite3");

const PREDICATE =
	"event_type = 'issue_thread_infra_notify_skipped' AND source = 'bridge.founder-thread-notifier' AND ts >= '2026-08-01 22:00:00' AND ts < '2026-08-05 04:00:00'";
const REQUIRED_COLUMNS = [
	"id",
	"event_id",
	"ts",
	"execution_id",
	"issue_id",
	"project_name",
	"event_type",
	"severity",
	"payload",
	"source",
];

function parseArgs(argv) {
	const parsed = {
		apply: false,
		dbPath: join(homedir(), ".flywheel", "teamlead.db"),
		outputDir: undefined,
		baselinePath: undefined,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--apply") parsed.apply = true;
		else if (arg === "--db")
			parsed.dbPath = resolve(
				required(argv[++index], "database_path_required"),
			);
		else if (arg === "--output-dir")
			parsed.outputDir = resolve(
				required(argv[++index], "output_dir_required"),
			);
		else if (arg === "--baseline")
			parsed.baselinePath = resolve(
				required(argv[++index], "baseline_path_required"),
			);
		else if (arg === "--help" || arg === "-h") parsed.help = true;
		else throw new Error(`unknown_argument:${arg}`);
	}
	parsed.outputDir ??= join(dirname(parsed.dbPath), "fly1995-evidence");
	if (parsed.apply && !parsed.baselinePath)
		throw new Error("baseline_required");
	return parsed;
}

function required(value, error) {
	if (!value) throw new Error(error);
	return value;
}

function usage() {
	return "Usage: node scripts/fly-1995-session-events-residue-surgery.mjs [--db PATH] [--output-dir PATH] [--apply --baseline RECEIPT]";
}

async function sha256(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

function cohort(db) {
	const row = db
		.prepare(`SELECT count(*) AS count, min(id) AS min_id, max(id) AS max_id,
			min(ts) AS min_ts, max(ts) AS max_ts FROM session_events WHERE ${PREDICATE}`)
		.get();
	return {
		count: Number(row.count),
		min_id: row.min_id === null ? null : Number(row.min_id),
		max_id: row.max_id === null ? null : Number(row.max_id),
		min_ts: row.min_ts ?? null,
		max_ts: row.max_ts ?? null,
	};
}

function breakdown(db) {
	return db
		.prepare(`SELECT execution_id, project_name, count(*) AS count
			FROM session_events WHERE ${PREDICATE}
			GROUP BY execution_id, project_name ORDER BY project_name DESC, execution_id DESC`)
		.all()
		.map((row) => ({ ...row, count: Number(row.count) }));
}

function assertSchema(db) {
	const columns = db
		.pragma("table_info(session_events)")
		.map((row) => row.name);
	if (columns.length === 0) throw new Error("session_events_table_missing");
	for (const column of REQUIRED_COLUMNS) {
		if (!columns.includes(column))
			throw new Error(`session_events_schema_missing:${column}`);
	}
	return columns;
}

function sourceIdentity(dbPath) {
	const realpath = realpathSync(dbPath);
	const stat = statSync(realpath);
	return {
		realpath,
		device: String(stat.dev),
		inode: String(stat.ino),
		bytes: stat.size,
	};
}

function readJson(path, errorPrefix) {
	if (!existsSync(path)) throw new Error(`${errorPrefix}_missing`);
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error(`${errorPrefix}_invalid`);
	}
}

function uniquePath(outputDir, label, extension) {
	const stamp = new Date().toISOString().replaceAll(":", "-");
	return join(outputDir, `${label}-${stamp}-${randomUUID()}.${extension}`);
}

function writeImmutable(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		flag: "wx",
		mode: 0o600,
	});
}

async function dryRun(args, scriptSha) {
	const source = sourceIdentity(args.dbPath);
	mkdirSync(args.outputDir, { recursive: true, mode: 0o700 });
	const snapshotPath = uniquePath(args.outputDir, "fly1995-baseline", "db");
	const receiptPath = uniquePath(
		args.outputDir,
		"fly1995-baseline-receipt",
		"json",
	);
	const sourceDb = new Database(args.dbPath, {
		readonly: true,
		fileMustExist: true,
	});
	try {
		await sourceDb.backup(snapshotPath);
	} finally {
		sourceDb.close();
	}

	const snapshotDb = new Database(snapshotPath, {
		readonly: true,
		fileMustExist: true,
	});
	let schema;
	let selected;
	let grouped;
	try {
		schema = assertSchema(snapshotDb);
		selected = cohort(snapshotDb);
		grouped = breakdown(snapshotDb);
	} finally {
		snapshotDb.close();
	}
	const receipt = {
		issue: "FLY-1995",
		schema_version: 1,
		created_at: new Date().toISOString(),
		source_db_realpath: source.realpath,
		source_db_identity: source,
		predicate: PREDICATE,
		session_events_columns: schema,
		cohort: selected,
		breakdown: grouped,
		script: { path: scriptPath, sha256: scriptSha },
		snapshot: {
			path: snapshotPath,
			bytes: statSync(snapshotPath).size,
			sha256: await sha256(snapshotPath),
		},
	};
	writeImmutable(receiptPath, receipt);
	return {
		mode: "dry-run",
		status: "baseline_ready",
		receiptPath,
		snapshotPath,
	};
}

async function validateBaseline(path, args, scriptSha) {
	const baseline = readJson(path, "baseline");
	const currentSource = sourceIdentity(args.dbPath);
	if (baseline.schema_version !== 1 || baseline.issue !== "FLY-1995") {
		throw new Error("baseline_schema_mismatch");
	}
	if (baseline.predicate !== PREDICATE)
		throw new Error("baseline_predicate_mismatch");
	if (baseline.source_db_realpath !== currentSource.realpath) {
		throw new Error("baseline_source_mismatch");
	}
	if (
		baseline.source_db_identity?.device !== currentSource.device ||
		baseline.source_db_identity?.inode !== currentSource.inode
	) {
		throw new Error("baseline_source_identity_mismatch");
	}
	if (baseline.script?.sha256 !== scriptSha)
		throw new Error("baseline_script_mismatch");
	if (!baseline.snapshot?.path || !existsSync(baseline.snapshot.path)) {
		throw new Error("baseline_snapshot_missing");
	}
	if ((await sha256(baseline.snapshot.path)) !== baseline.snapshot.sha256) {
		throw new Error("baseline_snapshot_hash_mismatch");
	}
	if (statSync(baseline.snapshot.path).size !== baseline.snapshot.bytes) {
		throw new Error("baseline_snapshot_size_mismatch");
	}
	if (
		!Number.isSafeInteger(baseline.cohort?.count) ||
		baseline.cohort.count < 0
	) {
		throw new Error("baseline_cohort_invalid");
	}
	return baseline;
}

function appliedReceiptPath(baselinePath) {
	return `${baselinePath}.applied.json`;
}

async function validBoundReceipt(path, args, baselinePath, scriptSha, status) {
	if (!existsSync(path)) return false;
	const receipt = readJson(path, "applied_receipt");
	const source = sourceIdentity(args.dbPath);
	return (
		receipt.status === status &&
		receipt.source_db_realpath === source.realpath &&
		receipt.source_db_identity?.device === source.device &&
		receipt.source_db_identity?.inode === source.inode &&
		receipt.predicate === PREDICATE &&
		receipt.script_sha256 === scriptSha &&
		receipt.baseline_receipt_sha256 === (await sha256(baselinePath))
	);
}

function assertDiskBudget(db, dbPath, outputDir) {
	const pageCount = Number(db.pragma("page_count", { simple: true }));
	const pageSize = Number(db.pragma("page_size", { simple: true }));
	const currentWalBytes = existsSync(`${dbPath}-wal`)
		? statSync(`${dbPath}-wal`).size
		: 0;
	const databaseBytes = pageCount * pageSize;
	const backupBytes = Math.max(1.8 * 1024 ** 3, databaseBytes);
	const projectedWalBytes = Math.max(currentWalBytes, databaseBytes);
	const dbDir = dirname(realpathSync(dbPath));
	const outputAvailable = (() => {
		const disk = statfsSync(outputDir);
		return disk.bavail * disk.bsize;
	})();
	const dbAvailable = (() => {
		const disk = statfsSync(dbDir);
		return disk.bavail * disk.bsize;
	})();
	const sameFilesystem = statSync(outputDir).dev === statSync(dbDir).dev;
	const enough = sameFilesystem
		? outputAvailable >= backupBytes + projectedWalBytes
		: outputAvailable >= backupBytes && dbAvailable >= projectedWalBytes;
	if (!enough) {
		throw new Error(
			`insufficient_disk_space:backup_required=${Math.ceil(backupBytes)}:wal_required=${Math.ceil(projectedWalBytes)}:output_available=${outputAvailable}:db_available=${dbAvailable}`,
		);
	}
}

async function apply(args, scriptSha) {
	const baseline = await validateBaseline(args.baselinePath, args, scriptSha);
	const receiptPath = appliedReceiptPath(args.baselinePath);
	const preparedReceiptPath = `${receiptPath}.pending`;
	const baselineReceiptSha = await sha256(args.baselinePath);
	mkdirSync(args.outputDir, { recursive: true, mode: 0o700 });
	const db = new Database(args.dbPath, { fileMustExist: true });
	try {
		db.pragma("busy_timeout = 5000");
		db.pragma("foreign_keys = ON");
		assertSchema(db);
		const beforeLock = cohort(db);
		if (beforeLock.count === 0) {
			if (
				await validBoundReceipt(
					receiptPath,
					args,
					args.baselinePath,
					scriptSha,
					"applied",
				)
			) {
				if (existsSync(preparedReceiptPath)) {
					try {
						unlinkSync(preparedReceiptPath);
					} catch {
						// The applied receipt is already authoritative.
					}
				}
				return {
					mode: "apply",
					status: "already_applied",
					deleted: 0,
					receiptPath,
				};
			}
			if (
				await validBoundReceipt(
					preparedReceiptPath,
					args,
					args.baselinePath,
					scriptSha,
					"prepared",
				)
			) {
				const prepared = readJson(preparedReceiptPath, "prepared_receipt");
				writeImmutable(receiptPath, {
					...prepared,
					status: "applied",
					recovered_at: new Date().toISOString(),
				});
				unlinkSync(preparedReceiptPath);
				return {
					mode: "apply",
					status: "already_applied",
					deleted: 0,
					recovered: true,
					receiptPath,
				};
			}
			throw new Error("target_missing");
		}
		if (existsSync(preparedReceiptPath)) {
			if (
				!(await validBoundReceipt(
					preparedReceiptPath,
					args,
					args.baselinePath,
					scriptSha,
					"prepared",
				))
			) {
				throw new Error("prepared_receipt_mismatch");
			}
			unlinkSync(preparedReceiptPath);
		}
		assertDiskBudget(db, args.dbPath, args.outputDir);

		db.exec("BEGIN IMMEDIATE");
		let backupPath;
		let preparedWritten = false;
		let committed = false;
		try {
			const locked = cohort(db);
			if (locked.count !== baseline.cohort.count) {
				throw new Error(
					`baseline_count_drift:expected=${baseline.cohort.count}:actual=${locked.count}`,
				);
			}
			backupPath = uniquePath(args.outputDir, "fly1995-pre-surgery", "db");
			const backupSource = new Database(args.dbPath, {
				readonly: true,
				fileMustExist: true,
			});
			try {
				await backupSource.backup(backupPath);
			} finally {
				backupSource.close();
			}
			const backup = new Database(backupPath, {
				readonly: true,
				fileMustExist: true,
			});
			try {
				if (backup.pragma("quick_check", { simple: true }) !== "ok") {
					throw new Error("backup_quick_check_failed");
				}
				if (cohort(backup).count !== baseline.cohort.count) {
					throw new Error("backup_cohort_mismatch");
				}
			} finally {
				backup.close();
			}
			const backupEvidence = {
				path: backupPath,
				bytes: statSync(backupPath).size,
				sha256: await sha256(backupPath),
			};

			const deleted = db
				.prepare(`DELETE FROM session_events WHERE ${PREDICATE}`)
				.run().changes;
			if (deleted !== baseline.cohort.count)
				throw new Error("delete_count_mismatch");
			if (db.pragma("foreign_key_check").length > 0)
				throw new Error("foreign_key_check_failed");
			if (cohort(db).count !== 0) throw new Error("target_still_present");
			const prepared = {
				issue: "FLY-1995",
				status: "prepared",
				prepared_at: new Date().toISOString(),
				source_db_realpath: realpathSync(args.dbPath),
				source_db_identity: sourceIdentity(args.dbPath),
				predicate: PREDICATE,
				baseline_receipt_sha256: baselineReceiptSha,
				script_sha256: scriptSha,
				deleted,
				backup: backupEvidence,
			};
			writeImmutable(preparedReceiptPath, prepared);
			preparedWritten = true;
			db.exec("COMMIT");
			committed = true;

			let checkpoint = { status: "ok" };
			try {
				const rows = db.pragma("wal_checkpoint(TRUNCATE)", {
					simple: false,
				});
				if (rows.some((row) => Number(row.busy) !== 0)) {
					checkpoint = { status: "busy" };
				}
			} catch (error) {
				checkpoint = {
					status: "failed",
					error: error instanceof Error ? error.message : String(error),
				};
			}
			const applied = {
				...prepared,
				status: "applied",
				applied_at: new Date().toISOString(),
				checkpoint,
			};
			writeImmutable(receiptPath, applied);
			try {
				unlinkSync(preparedReceiptPath);
			} catch {
				// The applied receipt is already authoritative.
			}
			return {
				mode: "apply",
				status: "applied",
				deleted,
				backupPath,
				receiptPath,
			};
		} catch (error) {
			if (db.inTransaction) db.exec("ROLLBACK");
			if (!committed && preparedWritten && existsSync(preparedReceiptPath)) {
				unlinkSync(preparedReceiptPath);
			}
			throw error;
		}
	} finally {
		db.close();
	}
}

async function main() {
	try {
		const args = parseArgs(process.argv.slice(2));
		if (args.help) {
			process.stdout.write(`${usage()}\n`);
			return;
		}
		if (!existsSync(args.dbPath))
			throw new Error(`database_missing:${args.dbPath}`);
		const scriptSha = await sha256(scriptPath);
		const result = args.apply
			? await apply(args, scriptSha)
			: await dryRun(args, scriptSha);
		process.stdout.write(`${JSON.stringify(result)}\n`);
	} catch (error) {
		process.stderr.write(
			`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`,
		);
		process.exitCode = 1;
	}
}

await main();
