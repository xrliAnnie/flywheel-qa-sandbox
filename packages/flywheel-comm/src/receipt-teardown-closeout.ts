import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { canonicalJsonString } from "flywheel-config";
import {
	dropReceiptLedgerSchema,
	installMailboxRelayInvariantTriggers,
} from "./mailbox-schema.js";

export const FLY1645_EXTERNAL_DISPOSITIONS = [
	"matched_1574_delivery",
	"manually_completed",
	"unresolved",
] as const;

export type Fly1645ExternalDisposition =
	(typeof FLY1645_EXTERNAL_DISPOSITIONS)[number];

export interface Fly1645ExternalResolution {
	shard: string;
	id: string;
	disposition: Fly1645ExternalDisposition;
}

export interface ReceiptTeardownCloseoutOptions {
	dbPaths: string[];
	stateDbPath: string;
	apply: boolean;
	confirmQuiesced: boolean;
	resolutions: Fly1645ExternalResolution[];
	manifestPath?: string;
	now?: string;
}

interface MailboxSnapshotRow {
	seq: number;
	id: string;
	delivery_id: string;
	carrier: "inbox" | "external";
	state: "QUEUED" | "LEASED" | "ACKED" | "DEAD";
	relay_state: "open" | "protected" | "terminal_disposed";
	content_ref: string | null;
	[key: string]: unknown;
}

interface ShardInspection {
	path: string;
	externalRows: MailboxSnapshotRow[];
	externalChatCount: number;
	unresolvedExternalChatCount: number;
	nonQuestionActiveRelayCount: number;
	settledExternalNonAckedCount: number;
	inboxChatSnapshot: string;
	xdeptSnapshot: string;
	historySettlementSnapshot: string;
	receiptSchemaObjects: string[];
	quickCheck: string;
	foreignKeyViolations: unknown[];
}

export interface ReceiptTeardownManifestRecord {
	shard: string;
	id: string;
	carrier: "external";
	state: string;
	relay_state: string;
	disposition: Exclude<Fly1645ExternalDisposition, "unresolved">;
	backup_sha256: string;
}

interface ReceiptTeardownManifestShard {
	shard: string;
	backup_path: string;
	backup_sha256: string;
	status: "planned" | "applying" | "applied" | "failed";
	post_apply_sha256?: string;
	error?: string;
}

interface ReceiptTeardownManifest {
	schema_version: 2;
	issue: "FLY-1645";
	created_at: string;
	state_backup: { source: string; path: string; sha256: string };
	shards: ReceiptTeardownManifestShard[];
	records: ReceiptTeardownManifestRecord[];
}

export interface ReceiptTeardownCloseoutResult {
	issue: "FLY-1645";
	mode: "dry-run" | "apply";
	inspectedAt: string;
	shards: Array<
		Omit<
			ShardInspection,
			| "externalRows"
			| "inboxChatSnapshot"
			| "xdeptSnapshot"
			| "historySettlementSnapshot"
		>
	>;
	backups: Array<{ source: string; path: string; sha256: string }>;
	stateBackup?: { source: string; path: string; sha256: string };
	manifestRecords: ReceiptTeardownManifestRecord[];
	manifestPath?: string;
}

const RECEIPT_SCHEMA_NAMES = [
	"mailbox_receipt_root_lineage_insert",
	"receipt_root_lineage_no_update",
	"receipt_root_lineage_no_delete",
	"receipt_root_lineage",
	"receipt_handle_requests",
	"receipt_activation_episodes",
	"receipt_resend_deliveries",
	"receipt_exemption_audit",
	"mailbox_log_settlement_slot",
] as const;

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeManifest(path: string, manifest: ReceiptTeardownManifest): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
		mode: 0o600,
		flag: "wx",
	});
	renameSync(temporaryPath, path);
}

function assertDatabaseExists(path: string): void {
	if (!path || path === ":memory:" || !existsSync(path)) {
		throw new Error(`closeout_database_missing:${path}`);
	}
}

function assertUniqueFiles(paths: string[]): void {
	const seen = new Map<string, string>();
	for (const path of paths) {
		const stat = statSync(path);
		const identity = `${stat.dev}:${stat.ino}`;
		const prior = seen.get(identity);
		if (prior) throw new Error(`duplicate_closeout_database:${prior}:${path}`);
		seen.set(identity, path);
	}
}

function resolutionKey(shard: string, id: string): string {
	return `${resolve(shard)}\0${id}`;
}

function buildResolutionMap(
	resolutions: Fly1645ExternalResolution[],
): Map<string, Fly1645ExternalDisposition> {
	const result = new Map<string, Fly1645ExternalDisposition>();
	for (const resolution of resolutions) {
		if (!FLY1645_EXTERNAL_DISPOSITIONS.includes(resolution.disposition)) {
			throw new Error(`invalid_external_disposition:${resolution.disposition}`);
		}
		if (!resolution.id.startsWith("chat:")) {
			throw new Error(`invalid_external_resolution_id:${resolution.id}`);
		}
		const key = resolutionKey(resolution.shard, resolution.id);
		if (result.has(key))
			throw new Error(`duplicate_external_resolution:${key}`);
		result.set(key, resolution.disposition);
	}
	return result;
}

function rowsSnapshot(rows: unknown[]): string {
	return canonicalJsonString(rows);
}

function inspectShard(
	path: string,
	resolutionMap: Map<string, Fly1645ExternalDisposition>,
): ShardInspection {
	assertDatabaseExists(path);
	const db = new Database(path, { readonly: true, fileMustExist: true });
	try {
		db.pragma("query_only = ON");
		db.pragma("busy_timeout = 5000");
		const generation = db
			.prepare(
				"SELECT schema_generation FROM mailbox_migration_meta WHERE singleton = 1",
			)
			.get() as { schema_generation?: string } | undefined;
		if (generation?.schema_generation !== "mailbox_v1") {
			throw new Error(`closeout_schema_mismatch:${path}`);
		}
		const externalRows = db
			.prepare(
				"SELECT * FROM mailbox WHERE id LIKE 'chat:%' AND carrier = 'external' ORDER BY seq",
			)
			.all() as MailboxSnapshotRow[];
		const unresolvedExternalChatCount = externalRows.filter(
			(row) =>
				!resolutionMap.has(resolutionKey(path, row.id)) ||
				resolutionMap.get(resolutionKey(path, row.id)) === "unresolved",
		).length;
		const nonQuestionActiveRelayCount = (
			db
				.prepare(
					"SELECT COUNT(*) AS count FROM mailbox WHERE type != 'question' AND relay_state != 'terminal_disposed'",
				)
				.get() as { count: number }
		).count;
		const settledExternalNonAckedCount = (
			db
				.prepare(
					`SELECT COUNT(*) AS count
					   FROM mailbox
					  WHERE carrier = 'external' AND state != 'ACKED'
					    AND EXISTS (
					      SELECT 1 FROM mailbox_log
					       WHERE mailbox_log.message_id = mailbox.id
					         AND mailbox_log.event IN ('processed','disposed')
					    )`,
				)
				.get() as { count: number }
		).count;
		const inboxChatSnapshot = rowsSnapshot(
			db
				.prepare(
					"SELECT id, state, seq FROM mailbox WHERE id LIKE 'chat:%' AND carrier = 'inbox' ORDER BY seq",
				)
				.all(),
		);
		const xdeptSnapshot = rowsSnapshot(
			db
				.prepare("SELECT * FROM mailbox WHERE id LIKE 'xdept:%' ORDER BY seq")
				.all(),
		);
		const historySettlementSnapshot = rowsSnapshot(
			db
				.prepare(
					"SELECT event, COUNT(*) AS count FROM mailbox_log WHERE event IN ('processed','disposed') GROUP BY event ORDER BY event",
				)
				.all(),
		);
		const placeholders = RECEIPT_SCHEMA_NAMES.map(() => "?").join(",");
		const receiptSchemaObjects = (
			db
				.prepare(
					`SELECT name FROM sqlite_master WHERE name IN (${placeholders}) ORDER BY name`,
				)
				.all(...RECEIPT_SCHEMA_NAMES) as Array<{ name: string }>
		).map((row) => row.name);
		const quickCheck = String(db.pragma("quick_check", { simple: true }));
		const foreignKeyViolations = db.pragma("foreign_key_check") as unknown[];
		return {
			path,
			externalRows,
			externalChatCount: externalRows.length,
			unresolvedExternalChatCount,
			nonQuestionActiveRelayCount,
			settledExternalNonAckedCount,
			inboxChatSnapshot,
			xdeptSnapshot,
			historySettlementSnapshot,
			receiptSchemaObjects,
			quickCheck,
			foreignKeyViolations,
		};
	} finally {
		db.close();
	}
}

function publicInspection(inspection: ShardInspection) {
	const {
		externalRows: _externalRows,
		inboxChatSnapshot: _inboxChatSnapshot,
		xdeptSnapshot: _xdeptSnapshot,
		historySettlementSnapshot: _historySettlementSnapshot,
		...visible
	} = inspection;
	return visible;
}

function assertHealthyInspection(inspection: ShardInspection): void {
	if (inspection.quickCheck !== "ok") {
		throw new Error(`closeout_quick_check_failed:${inspection.path}`);
	}
	if (inspection.foreignKeyViolations.length > 0) {
		throw new Error(`closeout_foreign_key_check_failed:${inspection.path}`);
	}
}

async function backupDatabase(path: string, now: string) {
	const backupDir = join(dirname(path), "backups");
	mkdirSync(backupDir, { recursive: true });
	const stamp = now.replaceAll(":", "-").replaceAll(".", "-");
	const destination = join(
		backupDir,
		`${basename(path, ".db")}-pre-fly1645-${stamp}-${randomUUID()}.db`,
	);
	const db = new Database(path, { readonly: true, fileMustExist: true });
	try {
		await db.backup(destination);
	} finally {
		db.close();
	}
	return { source: path, path: destination, sha256: sha256File(destination) };
}

function archiveExternalRow(
	db: Database.Database,
	row: MailboxSnapshotRow,
	now: string,
): void {
	let rowJson = canonicalJsonString(row);
	let contentRef: { path: string; contentHash: string } | undefined;
	if (row.content_ref) {
		const bytes = readFileSync(row.content_ref);
		const contentHash = createHash("sha256").update(bytes).digest("hex");
		rowJson = canonicalJsonString({
			...row,
			content_ref_archive: {
				path: row.content_ref,
				bytes: bytes.length,
				sha256: contentHash,
				content_base64: bytes.toString("base64"),
			},
		});
		contentRef = { path: row.content_ref, contentHash };
	}
	db.prepare(
		`INSERT OR IGNORE INTO mailbox_log
		   (event_id, message_id, event, at, row_json)
		 VALUES (?, ?, 'archived', ?, ?)`,
	).run(`fly1645:archived:${row.id}`, row.id, now, rowJson);
	if (contentRef) {
		db.prepare(
			`INSERT OR IGNORE INTO content_ref_gc_outbox
			   (intent_id, message_id, path, content_hash, created_at)
			 VALUES (?, ?, ?, ?, ?)`,
		).run(
			`fly1645:gc:${row.id}`,
			row.id,
			contentRef.path,
			contentRef.contentHash,
			now,
		);
	}
	const identity = db
		.prepare(
			"UPDATE mailbox_identity SET archived_at = ? WHERE id = ? AND archived_at IS NULL",
		)
		.run(now, row.id);
	if (identity.changes !== 1) {
		throw new Error(`closeout_identity_archive_conflict:${row.id}`);
	}
	const deleted = db.prepare("DELETE FROM mailbox WHERE id = ?").run(row.id);
	if (deleted.changes !== 1) {
		throw new Error(`closeout_mailbox_delete_conflict:${row.id}`);
	}
}

function assertExternalContentRefsReadable(
	inspections: ShardInspection[],
): void {
	for (const inspection of inspections) {
		for (const row of inspection.externalRows) {
			if (!row.content_ref) continue;
			try {
				readFileSync(row.content_ref);
			} catch (error) {
				throw new Error(
					`closeout_content_ref_unreadable:${inspection.path}:${row.id}:${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}
}

function applyShard(
	inspection: ShardInspection,
	resolutionMap: Map<string, Fly1645ExternalDisposition>,
	now: string,
): void {
	const db = new Database(inspection.path, { fileMustExist: true });
	try {
		db.pragma("journal_mode = WAL");
		db.pragma("foreign_keys = ON");
		db.pragma("busy_timeout = 5000");
		db.transaction(() => {
			for (const row of inspection.externalRows) {
				const disposition = resolutionMap.get(
					resolutionKey(inspection.path, row.id),
				);
				if (!disposition || disposition === "unresolved") {
					throw new Error(
						`unresolved_external_chat:${inspection.path}:${row.id}`,
					);
				}
				archiveExternalRow(db, row, now);
			}
			db.prepare(
				`UPDATE mailbox
				    SET relay_state = 'terminal_disposed',
				        resolved_at = COALESCE(resolved_at, ?),
				        resolved_via = 'fly1645_teardown_final_sweep'
				  WHERE type != 'question'
				    AND relay_state != 'terminal_disposed'`,
			).run(now);
			dropReceiptLedgerSchema(db);
			installMailboxRelayInvariantTriggers(db);
			db.prepare(
				`INSERT OR IGNORE INTO mailbox_log
				   (event_id, message_id, event, at, source_table, row_json)
				 VALUES ('fly1645:receipt-teardown:v1', 'migration:fly1645',
				         'migration_snapshot', ?, 'mailbox', ?)`,
			).run(
				now,
				canonicalJsonString({
					issue: "FLY-1645",
					disposition: "receipt_ledger_removed",
				}),
			);
		}).immediate();
		db.pragma("wal_checkpoint(TRUNCATE)");
	} finally {
		db.close();
	}
}

function assertPostconditions(
	before: ShardInspection,
	after: ShardInspection,
): void {
	assertHealthyInspection(after);
	if (
		after.externalChatCount !== 0 ||
		after.nonQuestionActiveRelayCount !== 0 ||
		after.settledExternalNonAckedCount !== 0 ||
		after.receiptSchemaObjects.length !== 0
	) {
		throw new Error(`closeout_postcondition_failed:${after.path}`);
	}
	if (before.inboxChatSnapshot !== after.inboxChatSnapshot) {
		throw new Error(`closeout_inbox_chat_changed:${after.path}`);
	}
	if (before.xdeptSnapshot !== after.xdeptSnapshot) {
		throw new Error(`closeout_xdept_changed:${after.path}`);
	}
	if (before.historySettlementSnapshot !== after.historySettlementSnapshot) {
		throw new Error(`closeout_history_changed:${after.path}`);
	}
}

export async function runReceiptTeardownCloseout(
	options: ReceiptTeardownCloseoutOptions,
): Promise<ReceiptTeardownCloseoutResult> {
	const now = options.now ?? new Date().toISOString();
	const dbPaths = [
		...new Set(options.dbPaths.map((path) => resolve(path))),
	].sort();
	if (dbPaths.length === 0) throw new Error("closeout_database_list_empty");
	for (const path of [...dbPaths, options.stateDbPath]) {
		assertDatabaseExists(path);
	}
	assertUniqueFiles([...dbPaths, options.stateDbPath]);
	const resolutionMap = buildResolutionMap(options.resolutions);
	const before = dbPaths.map((path) => inspectShard(path, resolutionMap));
	for (const inspection of before) assertHealthyInspection(inspection);

	const base: ReceiptTeardownCloseoutResult = {
		issue: "FLY-1645",
		mode: options.apply ? "apply" : "dry-run",
		inspectedAt: now,
		shards: before.map(publicInspection),
		backups: [],
		manifestRecords: [],
	};
	if (!options.apply) return base;
	if (!options.confirmQuiesced) throw new Error("closeout_quiescence_required");
	const unresolved = before.flatMap((inspection) =>
		inspection.externalRows.filter(
			(row) =>
				!resolutionMap.has(resolutionKey(inspection.path, row.id)) ||
				resolutionMap.get(resolutionKey(inspection.path, row.id)) ===
					"unresolved",
		),
	);
	if (unresolved.length > 0) {
		throw new Error(
			`unresolved_external_chat:${unresolved.map((row) => row.id).join(",")}`,
		);
	}
	if (!options.manifestPath) throw new Error("closeout_manifest_required");
	assertExternalContentRefsReadable(before);

	const backups = [];
	for (const path of dbPaths) backups.push(await backupDatabase(path, now));
	const stateBackup = await backupDatabase(options.stateDbPath, now);
	const backupBySource = new Map(
		backups.map((backup) => [backup.source, backup]),
	);
	const manifestRecords: ReceiptTeardownManifestRecord[] = [];
	for (const inspection of before) {
		const backup = backupBySource.get(inspection.path)!;
		for (const row of inspection.externalRows) {
			manifestRecords.push({
				shard: inspection.path,
				id: row.id,
				carrier: "external",
				state: row.state,
				relay_state: row.relay_state,
				disposition: resolutionMap.get(
					resolutionKey(inspection.path, row.id),
				) as Exclude<Fly1645ExternalDisposition, "unresolved">,
				backup_sha256: backup.sha256,
			});
		}
	}
	const manifest: ReceiptTeardownManifest = {
		schema_version: 2,
		issue: "FLY-1645",
		created_at: now,
		state_backup: stateBackup,
		shards: backups.map((backup) => ({
			shard: backup.source,
			backup_path: backup.path,
			backup_sha256: backup.sha256,
			status: "planned",
		})),
		records: manifestRecords,
	};
	writeManifest(options.manifestPath, manifest);

	const after: ShardInspection[] = [];
	for (let index = 0; index < before.length; index += 1) {
		const inspection = before[index]!;
		const manifestShard = manifest.shards[index]!;
		manifestShard.status = "applying";
		writeManifest(options.manifestPath, manifest);
		try {
			applyShard(inspection, resolutionMap, now);
			const appliedInspection = inspectShard(inspection.path, resolutionMap);
			assertPostconditions(inspection, appliedInspection);
			after.push(appliedInspection);
			manifestShard.status = "applied";
			manifestShard.post_apply_sha256 = sha256File(inspection.path);
			writeManifest(options.manifestPath, manifest);
		} catch (error) {
			manifestShard.status = "failed";
			manifestShard.error =
				error instanceof Error ? error.message : String(error);
			manifestShard.post_apply_sha256 = sha256File(inspection.path);
			writeManifest(options.manifestPath, manifest);
			throw error;
		}
	}
	return {
		...base,
		shards: after.map(publicInspection),
		backups,
		stateBackup,
		manifestRecords,
		manifestPath: options.manifestPath,
	};
}
