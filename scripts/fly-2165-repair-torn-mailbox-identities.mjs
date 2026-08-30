#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	readFileSync,
	statfsSync,
	statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

const requireFromComm = createRequire(
	new URL("../packages/flywheel-comm/package.json", import.meta.url),
);
const Database = requireFromComm("better-sqlite3");

const ISSUE = "FLY-2165";
const DRY_REPAIRED_AT = "0000-00-00T00:00:00.000Z";
const DRY_BACKUP_SHA = "0".repeat(64);

function canonicalJsonString(value) {
	if (Array.isArray(value)) {
		return `[${value
			.map((child) =>
				child === undefined ? "null" : canonicalJsonString(child),
			)
			.join(",")}]`;
	}
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.filter(([, child]) => child !== undefined)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(
				([key, child]) =>
					`${JSON.stringify(key)}:${canonicalJsonString(child)}`,
			)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function fileSha256(path) {
	return sha256(readFileSync(path));
}

function fileBytes(path) {
	return existsSync(path) ? statSync(path).size : 0;
}

function databaseBytes(dbPath) {
	return { db: fileBytes(dbPath), wal: fileBytes(`${dbPath}-wal`) };
}

function sqliteAffinity(declaredType) {
	const type = String(declaredType ?? "").toUpperCase();
	if (type.includes("INT")) return "INTEGER";
	if (type.includes("CHAR") || type.includes("CLOB") || type.includes("TEXT")) {
		return "TEXT";
	}
	if (type === "" || type.includes("BLOB")) return "BLOB";
	if (type.includes("REAL") || type.includes("FLOA") || type.includes("DOUB")) {
		return "REAL";
	}
	return "NUMERIC";
}

function schemaDescriptor(db, table) {
	return db
		.prepare(`PRAGMA table_info("${table}")`)
		.all()
		.map((column) => ({
			name: column.name,
			affinity: sqliteAffinity(column.type),
		}));
}

function assertArchiveSchemaParity(db) {
	const mailbox = schemaDescriptor(db, "mailbox");
	const mailboxArchive = schemaDescriptor(db, "mailbox_archive");
	const mailboxJson = canonicalJsonString(mailbox);
	const archiveJson = canonicalJsonString(mailboxArchive);
	if (mailbox.length === 0) throw new Error("mailbox_schema_missing");
	if (mailboxArchive.length === 0)
		throw new Error("mailbox_archive_schema_missing");
	if (mailboxJson !== archiveJson) {
		throw new Error(
			`mailbox_archive_schema_mismatch:${sha256(mailboxJson)}:${sha256(archiveJson)}`,
		);
	}
	return {
		mailbox: sha256(mailboxJson),
		mailboxArchive: sha256(archiveJson),
	};
}

const CANDIDATE_SQL = `
SELECT archive.*
  FROM mailbox_identity AS identity
  JOIN mailbox_archive AS archive
    ON archive.id = identity.id
   AND archive.delivery_id = identity.delivery_id
  LEFT JOIN mailbox AS live ON live.id = identity.id
 WHERE identity.archived_at IS NULL
   AND live.id IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM mailbox_log AS log WHERE log.message_id = identity.id
   )
 ORDER BY archive.id`;

function validContentRef(path) {
	if (typeof path !== "string" || path.length === 0) return false;
	const resolved = resolve(path);
	return basename(dirname(resolved)) === "refs" && resolved.endsWith(".txt");
}

function contentRefEvidence(row) {
	if (row.content_ref == null) return { archive: undefined, bytes: 0 };
	if (!validContentRef(row.content_ref)) {
		return { error: "invalid_content_ref", bytes: 0 };
	}
	let content;
	try {
		content = readFileSync(row.content_ref);
	} catch {
		return { error: "unreadable_content_ref", bytes: 0 };
	}
	return {
		bytes: content.length,
		archive: {
			path: row.content_ref,
			bytes: content.length,
			sha256: sha256(content),
			content_base64: content.toString("base64"),
		},
	};
}

function repairProvenance({ repairedAt, backupSha256, sourceDigest }) {
	return {
		issue: ISSUE,
		source_table: "mailbox_archive",
		repaired_at: repairedAt,
		backup_sha256: backupSha256,
		source_digest: sourceDigest,
	};
}

function snapshotJson(item, evidence) {
	return canonicalJsonString({
		...item.row,
		...(item.content.archive
			? { content_ref_archive: item.content.archive }
			: {}),
		lead_repair: repairProvenance(evidence),
	});
}

function analyze(db) {
	const schemaDigests = assertArchiveSchemaParity(db);
	const rows = db.prepare(CANDIDATE_SQL).all();
	const sourceHash = createHash("sha256");
	const repairable = [];
	const unrepairable = {
		missingTerminalAt: 0,
		invalidContentRef: 0,
	};
	let contentRefBytes = 0;
	for (const row of rows) {
		sourceHash.update(row.id);
		sourceHash.update("\0");
		sourceHash.update(canonicalJsonString(row));
		sourceHash.update("\n");
		const terminalAt =
			row.state === "ACKED"
				? row.acked_at
				: row.state === "DEAD"
					? row.dead_at
					: null;
		if (
			typeof terminalAt !== "string" ||
			!Number.isFinite(Date.parse(terminalAt))
		) {
			unrepairable.missingTerminalAt++;
			continue;
		}
		const content = contentRefEvidence(row);
		if (content.error) {
			unrepairable.invalidContentRef++;
			continue;
		}
		contentRefBytes += content.bytes;
		repairable.push({ row, content });
	}
	const sourceDigest = sourceHash.digest("hex");
	let rowJsonBytes = 0;
	for (const item of repairable) {
		rowJsonBytes += Buffer.byteLength(
			snapshotJson(item, {
				repairedAt: DRY_REPAIRED_AT,
				backupSha256: DRY_BACKUP_SHA,
				sourceDigest,
			}),
		);
	}
	return {
		rows,
		repairable,
		unrepairable,
		sourceDigest,
		schemaDigests,
		sizeEstimate: {
			rowJsonBytes,
			contentRefBytes,
			estimatedGrowthBytes: rowJsonBytes + repairable.length * 512,
		},
	};
}

function receiptBase({ mode, analysis, beforeAfterBytes }) {
	return {
		mode,
		candidates: analysis.rows.length,
		repairable: analysis.repairable.length,
		repaired: 0,
		unrepairable: analysis.unrepairable,
		remainingTorn: analysis.rows.length,
		sourceDigest: analysis.sourceDigest,
		schemaDigests: analysis.schemaDigests,
		sizeEstimate: analysis.sizeEstimate,
		beforeAfterBytes,
		backup: null,
		checkpoint: null,
	};
}

function availableBytes(path) {
	const stats = statfsSync(path);
	return Number(stats.bavail) * Number(stats.bsize);
}

function assertBackupTarget(dbPath, backupPath) {
	if (resolve(dbPath) === resolve(backupPath)) {
		throw new Error("backup_path_must_differ_from_db");
	}
	if (existsSync(backupPath)) {
		const kind = lstatSync(backupPath).isSymbolicLink()
			? "symlink"
			: "existing";
		throw new Error(`backup_path_${kind}:${backupPath}`);
	}
	const parent = dirname(backupPath);
	if (!existsSync(parent) || !statSync(parent).isDirectory()) {
		throw new Error(`backup_parent_missing:${parent}`);
	}
}

function sameAnalysisAuthority(left, right) {
	return (
		left.sourceDigest === right.sourceDigest &&
		left.rows.length === right.rows.length &&
		left.repairable.length === right.repairable.length &&
		canonicalJsonString(left.schemaDigests) ===
			canonicalJsonString(right.schemaDigests)
	);
}

function assertCandidateStillMatches(db, item) {
	const current = db
		.prepare(
			`SELECT archive.*
			   FROM mailbox_identity AS identity
			   JOIN mailbox_archive AS archive
			     ON archive.id=identity.id AND archive.delivery_id=identity.delivery_id
			  WHERE identity.id=? AND identity.archived_at IS NULL
			    AND NOT EXISTS (SELECT 1 FROM mailbox WHERE id=identity.id)
			    AND NOT EXISTS (SELECT 1 FROM mailbox_log WHERE message_id=identity.id)`,
		)
		.get(item.row.id);
	if (
		!current ||
		canonicalJsonString(current) !== canonicalJsonString(item.row)
	) {
		throw new Error(`repair_candidate_changed:${item.row.id}`);
	}
}

function applyBatch(db, batch, evidence, faultAfterLogId) {
	return db
		.transaction((items) => {
			for (const item of items) {
				assertCandidateStillMatches(db, item);
				const rowJson = snapshotJson(item, evidence);
				db.prepare(
					`INSERT INTO mailbox_log
					 (event_id, message_id, subject_id, event, at, source_table, row_json)
					 VALUES (?, ?, ?, 'archived', ?, 'mailbox_archive', ?)`,
				).run(
					`fly2165:archived:${item.row.id}`,
					item.row.id,
					item.row.id,
					evidence.repairedAt,
					rowJson,
				);
				if (faultAfterLogId === item.row.id) {
					throw new Error(`fault_after_log:${item.row.id}`);
				}
				if (item.content.archive) {
					db.prepare(
						`INSERT INTO content_ref_gc_outbox
						 (intent_id, message_id, path, content_hash, created_at)
						 VALUES (?, ?, ?, ?, ?)`,
					).run(
						`fly2165:gc:${item.row.id}`,
						item.row.id,
						item.content.archive.path,
						item.content.archive.sha256,
						evidence.repairedAt,
					);
				}
				const stamped = db
					.prepare(
						"UPDATE mailbox_identity SET archived_at=? WHERE id=? AND delivery_id=? AND archived_at IS NULL",
					)
					.run(evidence.repairedAt, item.row.id, item.row.delivery_id);
				if (stamped.changes !== 1) {
					throw new Error(`repair_identity_cas_failed:${item.row.id}`);
				}
			}
		})
		.immediate(batch);
}

function parseCli(argv) {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			db: { type: "string" },
			apply: { type: "boolean", default: false },
			backup: { type: "string" },
			"batch-size": { type: "string", default: "500" },
			"test-fault-after-log-id": { type: "string" },
		},
		allowPositionals: true,
	});
	if (positionals.length > 0) throw new Error("unexpected_positionals");
	if (!values.db?.trim()) throw new Error("--db_is_required");
	if (values.apply && !values.backup?.trim()) {
		throw new Error("--apply_requires_--backup");
	}
	if (!values.apply && values.backup !== undefined) {
		throw new Error("--backup_requires_--apply");
	}
	const batchSize = Number(values["batch-size"]);
	if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
		throw new Error("--batch-size_must_be_1_through_10000");
	}
	return {
		dbPath: resolve(values.db),
		apply: values.apply,
		backupPath: values.backup ? resolve(values.backup) : undefined,
		batchSize,
		faultAfterLogId: values["test-fault-after-log-id"]?.trim() || undefined,
	};
}

async function run(argv) {
	const options = parseCli(argv);
	const before = databaseBytes(options.dbPath);
	const readonly = new Database(options.dbPath, {
		readonly: true,
		fileMustExist: true,
	});
	readonly.pragma("busy_timeout = 5000");
	let initial;
	try {
		initial = analyze(readonly);
		if (!options.apply) {
			return receiptBase({
				mode: "dry-run",
				analysis: initial,
				beforeAfterBytes: { before, after: before },
			});
		}

		assertBackupTarget(options.dbPath, options.backupPath);
		const availableFreeBytes = availableBytes(dirname(options.backupPath));
		const backupBytes = before.db + before.wal;
		const requiredFreeBytes =
			backupBytes + 3 * initial.sizeEstimate.estimatedGrowthBytes;
		if (availableFreeBytes < requiredFreeBytes) {
			throw new Error(
				`insufficient_free_space:${availableFreeBytes}:${requiredFreeBytes}`,
			);
		}
		initial.sizeEstimate = {
			...initial.sizeEstimate,
			backupBytes,
			availableFreeBytes,
			requiredFreeBytes,
		};
		await readonly.backup(options.backupPath);
	} finally {
		readonly.close();
	}

	const backup = new Database(options.backupPath, {
		readonly: true,
		fileMustExist: true,
	});
	let backupQuickCheck;
	try {
		backupQuickCheck = backup.pragma("quick_check", { simple: true });
		if (backupQuickCheck !== "ok") throw new Error("backup_quick_check_failed");
	} finally {
		backup.close();
	}
	const backupSha256 = fileSha256(options.backupPath);

	const db = new Database(options.dbPath);
	db.pragma("busy_timeout = 5000");
	try {
		const current = analyze(db);
		if (!sameAnalysisAuthority(initial, current)) {
			throw new Error("repair_authority_changed_after_backup");
		}
		const repairedAt = new Date().toISOString();
		const evidence = {
			repairedAt,
			backupSha256,
			sourceDigest: current.sourceDigest,
		};
		let repaired = 0;
		for (
			let index = 0;
			index < current.repairable.length;
			index += options.batchSize
		) {
			const batch = current.repairable.slice(index, index + options.batchSize);
			applyBatch(db, batch, evidence, options.faultAfterLogId);
			repaired += batch.length;
		}
		const checkpointRow = db.pragma("wal_checkpoint(PASSIVE)")[0] ?? {};
		const remaining = analyze(db);
		const after = databaseBytes(options.dbPath);
		return {
			...receiptBase({
				mode: "apply",
				analysis: initial,
				beforeAfterBytes: { before, after },
			}),
			repaired,
			remainingTorn: remaining.rows.length,
			backup: {
				path: options.backupPath,
				sha256: backupSha256,
				quickCheck: backupQuickCheck,
			},
			checkpoint: {
				busy: checkpointRow.busy ?? 0,
				log: checkpointRow.log ?? 0,
				checkpointed: checkpointRow.checkpointed ?? 0,
			},
		};
	} finally {
		db.close();
	}
}

try {
	const receipt = await run(process.argv.slice(2));
	process.stdout.write(`${JSON.stringify(receipt)}\n`);
} catch (error) {
	process.stderr.write(
		`fly2165-repair: ${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exitCode = 1;
}
