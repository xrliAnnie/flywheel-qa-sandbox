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
	const candidateRows = db.prepare(CANDIDATE_SQL).iterate();
	const questionRoots = new Set([
		...db
			.prepare("SELECT id FROM mailbox_archive WHERE type = 'question'")
			.pluck()
			.all(),
		...db
			.prepare("SELECT id FROM mailbox WHERE type = 'question'")
			.pluck()
			.all(),
	]);
	const sourceHash = createHash("sha256");
	const families = new Map();
	const unrepairable = {
		missingTerminalAt: 0,
		invalidContentRef: 0,
		familyBlocked: 0,
	};
	let candidateCount = 0;
	for (const row of candidateRows) {
		candidateCount++;
		sourceHash.update(row.id);
		sourceHash.update("\0");
		sourceHash.update(canonicalJsonString(row));
		sourceHash.update("\n");
		const familyRootId =
			row.type === "response" &&
			typeof row.ref_id === "string" &&
			questionRoots.has(row.ref_id)
				? row.ref_id
				: row.id;
		const family = families.get(familyRootId) ?? [];
		families.set(familyRootId, family);
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
			family.push({ row, familyRootId, error: "missingTerminalAt" });
			continue;
		}
		const content = contentRefEvidence(row);
		if (content.error) {
			unrepairable.invalidContentRef++;
			family.push({ row, familyRootId, error: "invalidContentRef" });
			continue;
		}
		family.push({ row, familyRootId, content });
	}
	const sourceDigest = sourceHash.digest("hex");
	const repairableFamilies = [];
	for (const [rootId, members] of families) {
		if (members.some((member) => member.error)) {
			unrepairable.familyBlocked += members.filter(
				(member) => !member.error,
			).length;
			continue;
		}
		repairableFamilies.push({ rootId, items: members });
	}
	const repairable = repairableFamilies.flatMap((family) => family.items);
	const contentRefBytes = repairable.reduce(
		(bytes, item) => bytes + item.content.bytes,
		0,
	);
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
		candidateCount,
		repairableCount: repairable.length,
		repairable,
		repairableFamilies,
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
		candidates: analysis.candidateCount,
		repairable: analysis.repairableCount,
		repaired: 0,
		unrepairable: analysis.unrepairable,
		remainingTorn: analysis.candidateCount,
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
		left.candidateCount === right.candidateCount &&
		left.repairableCount === right.repairableCount &&
		canonicalJsonString(left.schemaDigests) ===
			canonicalJsonString(right.schemaDigests)
	);
}

function analysisSummary(analysis) {
	return {
		candidateCount: analysis.candidateCount,
		repairableCount: analysis.repairableCount,
		unrepairable: analysis.unrepairable,
		sourceDigest: analysis.sourceDigest,
		schemaDigests: analysis.schemaDigests,
		sizeEstimate: analysis.sizeEstimate,
	};
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

function applyBatch(db, families, evidence, faultAfterLogId) {
	return db
		.transaction((familyBatch) => {
			for (const family of familyBatch) {
				for (const item of family.items) {
					assertCandidateStillMatches(db, item);
					const rowJson = snapshotJson(item, evidence);
					db.prepare(
						`INSERT INTO mailbox_log
					 (event_id, message_id, subject_id, event, at, source_table, row_json)
					 VALUES (?, ?, ?, 'archived', ?, 'mailbox_archive', ?)`,
					).run(
						`fly2165:archived:${item.row.id}`,
						item.row.id,
						family.rootId,
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
			}
		})
		.immediate(families);
}

function familyBatches(families, messageLimit) {
	const batches = [];
	let batch = [];
	let messages = 0;
	for (const family of families) {
		if (batch.length > 0 && messages + family.items.length > messageLimit) {
			batches.push(batch);
			batch = [];
			messages = 0;
		}
		batch.push(family);
		messages += family.items.length;
	}
	if (batch.length > 0) batches.push(batch);
	return batches;
}

function parseCli(argv) {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			db: { type: "string" },
			apply: { type: "boolean", default: false },
			backup: { type: "string" },
			now: { type: "string" },
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
	if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
		throw new Error("--batch-size_must_be_1_through_1000");
	}
	const repairNow = values.now?.trim();
	if (
		repairNow &&
		(!repairNow.endsWith("Z") ||
			!Number.isFinite(Date.parse(repairNow)) ||
			new Date(repairNow).toISOString() !== repairNow)
	) {
		throw new Error("--now_must_be_canonical_utc_iso");
	}
	const faultAfterLogId =
		values["test-fault-after-log-id"]?.trim() || undefined;
	if (faultAfterLogId && process.env.NODE_ENV !== "test") {
		throw new Error("--test-fault-after-log-id_requires_NODE_ENV=test");
	}
	return {
		dbPath: resolve(values.db),
		apply: values.apply,
		backupPath: values.backup ? resolve(values.backup) : undefined,
		batchSize,
		repairNow,
		faultAfterLogId,
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
		const initialAnalysis = analyze(readonly);
		if (!options.apply) {
			return receiptBase({
				mode: "dry-run",
				analysis: initialAnalysis,
				beforeAfterBytes: { before, after: before },
			});
		}

		assertBackupTarget(options.dbPath, options.backupPath);
		const backupDirectory = dirname(options.backupPath);
		const dbDirectory = dirname(options.dbPath);
		const backupAvailableFreeBytes = availableBytes(backupDirectory);
		const dbAvailableFreeBytes = availableBytes(dbDirectory);
		const backupBytes = before.db + before.wal;
		const dbGrowthRequiredBytes =
			3 * initialAnalysis.sizeEstimate.estimatedGrowthBytes;
		const sameFilesystem =
			statSync(backupDirectory).dev === statSync(dbDirectory).dev;
		if (sameFilesystem) {
			const combinedRequiredBytes = backupBytes + dbGrowthRequiredBytes;
			if (backupAvailableFreeBytes < combinedRequiredBytes) {
				throw new Error(
					`insufficient_free_space:shared:${backupAvailableFreeBytes}:${combinedRequiredBytes}`,
				);
			}
		} else {
			if (backupAvailableFreeBytes < backupBytes) {
				throw new Error(
					`insufficient_free_space:backup:${backupAvailableFreeBytes}:${backupBytes}`,
				);
			}
			if (dbAvailableFreeBytes < dbGrowthRequiredBytes) {
				throw new Error(
					`insufficient_free_space:db:${dbAvailableFreeBytes}:${dbGrowthRequiredBytes}`,
				);
			}
		}
		initialAnalysis.sizeEstimate = {
			...initialAnalysis.sizeEstimate,
			backupBytes,
			backupAvailableFreeBytes,
			dbAvailableFreeBytes,
			dbGrowthRequiredBytes,
			sameFilesystem,
		};
		initial = analysisSummary(initialAnalysis);
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
		const repairedAt = options.repairNow ?? new Date().toISOString();
		const evidence = {
			repairedAt,
			backupSha256,
			sourceDigest: current.sourceDigest,
		};
		let repaired = 0;
		for (const batch of familyBatches(
			current.repairableFamilies,
			options.batchSize,
		)) {
			applyBatch(db, batch, evidence, options.faultAfterLogId);
			repaired += batch.reduce(
				(count, family) => count + family.items.length,
				0,
			);
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
			remainingTorn: remaining.candidateCount,
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
