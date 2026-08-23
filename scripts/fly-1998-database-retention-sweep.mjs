#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const packageRequire = createRequire(
	join(repoRoot, "packages/teamlead/package.json"),
);
const Database = packageRequire("better-sqlite3");

const ISSUE = "FLY-1998";
const MANIFEST_VERSION = 1;
const RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
const BATCH_SIZE = 200;
const MIN_SQLITE_VERSION = "3.42.0";
const FORBIDDEN_TARGETS = new Set([
	"dead_letter_alerts",
	"session_events",
	"sessions",
	"mailbox",
	"mailbox_log",
	"mailbox_identity",
]);

const WORKFLOW_EVENT_PREDICATE = `
	e.kind IN (
		'rework_delivery_claimed',
		'rework_delivery_released',
		'workflow_engine_alert_enqueued',
		'workflow_engine_alert_posted'
	)
	AND julianday(e.at) IS NOT NULL
	AND julianday(e.at) < julianday(?)
	AND EXISTS (
		SELECT 1 FROM workflow_run r
		WHERE r.run_id = e.run_id
		  AND r.status IN ('completed','terminated','canceled','cancelled')
	)
	AND (
		(e.kind IN ('rework_delivery_claimed','rework_delivery_released')
		 AND json_valid(e.payload)
		 AND json_type(e.payload,'$.requestId') = 'text'
		 AND json_type(e.payload,'$.generation') = 'integer'
		 AND EXISTS (
			SELECT 1 FROM workflow_rework_delivery d
			WHERE d.request_id = json_extract(e.payload,'$.requestId')
			  AND d.generation >= CAST(json_extract(e.payload,'$.generation') AS INTEGER)
		 ))
		OR
		(e.kind = 'workflow_engine_alert_enqueued'
		 AND substr(e.event_uid,1,length('alert_enqueued:')) = 'alert_enqueued:'
		 AND length(e.event_uid) > length('alert_enqueued:')
		 AND EXISTS (
			SELECT 1 FROM workflow_alert_outbox o
			WHERE o.escalation_uid = substr(e.event_uid,length('alert_enqueued:')+1)
			  AND o.state IN ('sent','failed')
		 ))
		OR
		(e.kind = 'workflow_engine_alert_posted'
		 AND substr(e.event_uid,1,length('alert_posted:')) = 'alert_posted:'
		 AND length(e.event_uid) > length('alert_posted:')
		 AND EXISTS (
			SELECT 1 FROM workflow_alert_outbox o
			WHERE o.escalation_uid = substr(e.event_uid,length('alert_posted:')+1)
			  AND o.state = 'sent'
		 ))
	)`;
function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
	return sha256(readFileSync(path));
}

function orderedDigest(values) {
	const hash = createHash("sha256");
	for (const value of values) hash.update(`${JSON.stringify(value)}\n`);
	return hash.digest("hex");
}

function compareVersions(left, right) {
	const a = String(left).split(".").map(Number);
	const b = String(right).split(".").map(Number);
	for (let index = 0; index < 3; index += 1) {
		const delta = (a[index] ?? 0) - (b[index] ?? 0);
		if (delta !== 0) return Math.sign(delta);
	}
	return 0;
}

export function assertSupportedSqliteVersion(version) {
	if (!/^\d+\.\d+\.\d+(?:\D.*)?$/.test(String(version))) {
		throw new Error(`sqlite_version_unparseable:${version}`);
	}
	const normalized = String(version).match(/^\d+\.\d+\.\d+/)?.[0];
	if (!normalized || compareVersions(normalized, MIN_SQLITE_VERSION) < 0) {
		throw new Error(
			`sqlite_version_unsupported:${version}:minimum=${MIN_SQLITE_VERSION}`,
		);
	}
	return normalized;
}

export function encodeSqliteLiteral(value) {
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value))
			throw new Error("unsafe_numeric_primary_key");
		return String(value);
	}
	if (typeof value === "string") {
		if (value.includes("\0"))
			throw new Error("nul_text_primary_key_unsupported");
		return `'${value.replaceAll("'", "''")}'`;
	}
	throw new Error("unsupported_primary_key_type");
}

function writeExclusive(path, value, mode = 0o600) {
	const fd = openSync(path, "wx", mode);
	try {
		const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
		let offset = 0;
		while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	fsyncDirectory(dirname(path));
}

function writeAtomicExclusive(path, value, mode = 0o600) {
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeExclusive(temporaryPath, value, mode);
		linkSync(temporaryPath, path);
		fsyncDirectory(dirname(path));
	} finally {
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
		fsyncDirectory(dirname(path));
	}
}

function fsyncDirectory(path) {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function writeSealedJson(path, value) {
	const payloadSha256 = sha256(JSON.stringify(value));
	const bytes = `${JSON.stringify(
		{
			...value,
			_internalSeal: { algorithm: "sha256", payloadSha256 },
		},
		null,
		2,
	)}\n`;
	writeAtomicExclusive(path, bytes);
	writeAtomicExclusive(`${path}.sha256`, `${sha256(bytes)}\n`);
}

function readSealedJson(path, label) {
	assertRegularNoSymlink(path, label);
	const bytes = readFileSync(path);
	let parsed;
	try {
		parsed = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new Error(`${label}_json_invalid`);
	}
	const internalSeal = parsed?._internalSeal;
	delete parsed._internalSeal;
	if (
		internalSeal?.algorithm !== "sha256" ||
		internalSeal.payloadSha256 !== sha256(JSON.stringify(parsed))
	) {
		throw new Error(`${label}_internal_digest_mismatch`);
	}
	const digestPath = `${path}.sha256`;
	if (!existsSync(digestPath)) {
		try {
			writeAtomicExclusive(digestPath, `${sha256(bytes)}\n`);
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
		}
	}
	assertRegularNoSymlink(digestPath, `${label}_digest`);
	const expected = readFileSync(digestPath, "utf8").trim();
	if (sha256(bytes) !== expected) throw new Error(`${label}_digest_mismatch`);
	return parsed;
}

function assertRegularNoSymlink(path, label) {
	const info = lstatSync(path);
	if (info.isSymbolicLink() || !info.isFile())
		throw new Error(`${label}_not_regular_file`);
	return { realpath: realpathSync(path), dev: info.dev, ino: info.ino };
}

function dbIdentity(path) {
	const identity = assertRegularNoSymlink(path, "database");
	return { ...identity, path: resolve(path) };
}

function fileMeasurements(path) {
	const result = {};
	for (const suffix of ["", "-wal", "-shm"]) {
		const candidate = `${path}${suffix}`;
		result[suffix || "main"] = existsSync(candidate)
			? { exists: true, bytes: statSync(candidate).size }
			: { exists: false, bytes: 0 };
	}
	return result;
}

function tableExists(db, table) {
	return Boolean(
		db
			.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?")
			.get(table),
	);
}

function tableSql(db, table) {
	const row = db
		.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?")
		.get(table);
	if (!row?.sql) throw new Error(`required_table_missing:${table}`);
	return String(row.sql);
}

function triggerSql(db, trigger) {
	const row = db
		.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?")
		.get(trigger);
	if (!row?.sql) throw new Error(`required_trigger_missing:${trigger}`);
	return String(row.sql);
}

function tableTriggerSet(db, table) {
	return db
		.prepare(
			"SELECT name, sql FROM sqlite_schema WHERE type='trigger' AND tbl_name=? ORDER BY name",
		)
		.all(table)
		.map((row) => ({ name: String(row.name), sql: String(row.sql) }));
}

function triggerSetDigest(triggers) {
	return sha256(JSON.stringify(triggers));
}

function openReadonly(path) {
	const db = new Database(path, { readonly: true, fileMustExist: true });
	db.pragma("query_only = ON");
	if (Number(db.pragma("query_only", { simple: true })) !== 1) {
		db.close();
		throw new Error("query_only_not_enabled");
	}
	return db;
}

function assertDriverPreflight(db, cutoff) {
	const version = String(
		db.prepare("SELECT sqlite_version() AS version").get().version,
	);
	assertSupportedSqliteVersion(version);
	const parsed = Number(
		db.prepare("SELECT julianday(?) IS NOT NULL AS ok").get(cutoff).ok,
	);
	if (parsed !== 1) throw new Error("cutoff_unparseable_by_driver");
	return version;
}

function recordStatement(receipt, id, sql) {
	receipt.push({ id, sha256: sha256(sql.trim()) });
}

function rowsWithReceipt(db, receipt, id, sql, ...params) {
	recordStatement(receipt, id, sql);
	return db.prepare(sql).all(...params);
}

function targetDescriptors() {
	const descriptors = [
		{
			key: "workflowRunEvent",
			table: "workflow_run_event",
			pk: "id",
			pkType: "integer",
		},
	];
	for (const descriptor of descriptors) {
		if (FORBIDDEN_TARGETS.has(descriptor.table)) {
			throw new Error(`forbidden_cleanup_target:${descriptor.table}`);
		}
	}
	return descriptors;
}

function workflowCandidateIds(db, cutoff, ids) {
	const idClause = ids ? `e.id IN (${ids.map(() => "?").join(",")}) AND` : "";
	return db
		.prepare(
			`SELECT e.id FROM workflow_run_event e
			 WHERE ${idClause} ${WORKFLOW_EVENT_PREDICATE}
			 ORDER BY e.id`,
		)
		.all(...(ids ?? []), cutoff)
		.map((row) => Number(row.id));
}

function fly1995MailboxState(db) {
	const liveSql = `SELECT q.id FROM mailbox q
		WHERE q.type='question'
		  AND q.checkpoint IS NULL
		  AND q.from_agent='voice-honeylemon-fly1911'
		  AND q.relay_state != 'terminal_disposed'
		  AND NOT EXISTS (
			SELECT 1 FROM mailbox r WHERE r.ref_id=q.id AND r.type='response'
		  )
		ORDER BY q.id`;
	const forensicSql = `SELECT q.id FROM mailbox q
		WHERE q.type='question' AND q.resolved_via='fly1995_sessionless_ask'
		ORDER BY q.id`;
	const liveIds = db
		.prepare(liveSql)
		.all()
		.map((row) => String(row.id));
	const forensicIds = db
		.prepare(forensicSql)
		.all()
		.map((row) => String(row.id));
	const baselineIds = [...new Set([...liveIds, ...forensicIds])].sort();
	return {
		liveIds,
		forensicIds,
		baselineIds,
		unionCount: baselineIds.length,
		baselineDigest: orderedDigest(baselineIds),
		statements: [
			{ id: "fly1995_mailbox_voice", sha256: sha256(liveSql) },
			{ id: "fly1995_mailbox_forensic", sha256: sha256(forensicSql) },
		],
	};
}

function fly1995SessionEventsState(db) {
	const sql = `SELECT
		count(*) AS count,
		min(id) AS min_id,
		max(id) AS max_id,
		sum(id) AS sum_id,
		sum(id % 1000000007) AS sum_mod,
		sum(((id % 1000000007) * (id % 1000000007)) % 1000000007) AS sum_square_mod
		FROM session_events
		WHERE event_type='issue_thread_infra_notify_skipped'
		  AND source='bridge.founder-thread-notifier'
		  AND ts >= '2026-08-01 22:00:00'
		  AND ts < '2026-08-05 04:00:00'`;
	const row = db.prepare(sql).get();
	const proof = {
		count: Number(row.count),
		minId: row.min_id === null ? null : Number(row.min_id),
		maxId: row.max_id === null ? null : Number(row.max_id),
		sumId: row.sum_id === null ? null : Number(row.sum_id),
		sumMod: row.sum_mod === null ? null : Number(row.sum_mod),
		sumSquareMod:
			row.sum_square_mod === null ? null : Number(row.sum_square_mod),
	};
	return {
		...proof,
		digest: sha256(JSON.stringify(proof)),
		statement: { id: "fly1995_session_events", sha256: sha256(sql) },
	};
}

function databaseMeasurements(db, path, tables, statementReceipt, prefix) {
	const counts = {};
	for (const table of tables) {
		const existsSql =
			"SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?";
		recordStatement(
			statementReceipt,
			`${prefix}_table_exists_${table}`,
			existsSql,
		);
		if (tableExists(db, table)) {
			const countSql = `SELECT count(*) AS count FROM "${table}"`;
			recordStatement(statementReceipt, `${prefix}_count_${table}`, countSql);
			counts[table] = Number(db.prepare(countSql).get().count);
		}
	}
	for (const pragma of [
		"page_count",
		"freelist_count",
		"page_size",
		"data_version",
	]) {
		recordStatement(
			statementReceipt,
			`${prefix}_pragma_${pragma}`,
			`PRAGMA ${pragma}`,
		);
	}
	return {
		files: fileMeasurements(path),
		pageCount: Number(db.pragma("page_count", { simple: true })),
		freelistCount: Number(db.pragma("freelist_count", { simple: true })),
		pageSize: Number(db.pragma("page_size", { simple: true })),
		dataVersion: Number(db.pragma("data_version", { simple: true })),
		counts,
	};
}

function percentile(values, fraction) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[
		Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
	];
}

async function sampleHealth(url, count, timeoutMs) {
	const samples = [];
	for (let index = 0; index < count; index += 1) {
		const started = performance.now();
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(url, {
				signal: controller.signal,
				redirect: "error",
			});
			await response.body?.cancel();
			samples.push({
				index: index + 1,
				status: response.status,
				success: response.ok,
				durationMs: Math.round((performance.now() - started) * 100) / 100,
			});
		} catch (error) {
			samples.push({
				index: index + 1,
				status: null,
				success: false,
				durationMs: Math.round((performance.now() - started) * 100) / 100,
				error: error instanceof Error ? error.name : "request_failed",
			});
		} finally {
			clearTimeout(timeout);
		}
	}
	const durations = samples.map((sample) => sample.durationMs);
	return {
		samples,
		successCount: samples.filter((sample) => sample.success).length,
		successRatio:
			samples.filter((sample) => sample.success).length / samples.length,
		p50Ms: percentile(durations, 0.5),
		p95Ms: percentile(durations, 0.95),
		maxMs: durations.length > 0 ? Math.max(...durations) : null,
	};
}

async function runProcess(command, args, options = {}) {
	return await new Promise((resolvePromise, rejectPromise) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			stdio: [
				options.stdinFd ?? (options.input !== undefined ? "pipe" : "ignore"),
				options.stdoutFd ?? "pipe",
				"pipe",
			],
		});
		let stdout = "";
		let stderr = "";
		if (child.stdout) {
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
			});
		}
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", rejectPromise);
		child.stdin?.on("error", () => {});
		child.on("close", (code, signal) =>
			resolvePromise({ code, signal, stdout, stderr }),
		);
		if (options.input !== undefined) child.stdin?.end(options.input);
	});
}

async function systemSqlitePreflight(dbPath, cutoff) {
	const versionResult = await runProcess("sqlite3", ["--version"]);
	if (versionResult.code !== 0) throw new Error("sqlite3_cli_unavailable");
	const version = assertSupportedSqliteVersion(
		versionResult.stdout.trim().split(/\s+/)[0],
	);
	// The CLI cannot bind argv values. Use the same audited encoder as snapshot export.
	const literalResult = await runProcess("sqlite3", [
		"-readonly",
		dbPath,
		`SELECT CASE WHEN julianday(${encodeSqliteLiteral(cutoff)}) IS NOT NULL THEN 1 ELSE 0 END;`,
	]);
	if (literalResult.code !== 0 || literalResult.stdout.trim() !== "1") {
		throw new Error("cutoff_unparseable_by_sqlite3_cli");
	}
	return version;
}

function chunk(values, size = BATCH_SIZE) {
	const groups = [];
	for (let index = 0; index < values.length; index += size)
		groups.push(values.slice(index, index + size));
	return groups;
}

async function exportModeInsert({
	dbPath,
	table,
	pk,
	primaryKeys,
	snapshotPath,
}) {
	const fd = openSync(snapshotPath, "wx", 0o600);
	let scriptSha256;
	try {
		const statements =
			primaryKeys.length > 0
				? chunk(primaryKeys)
						.map(
							(group) =>
								`SELECT * FROM "${table}" WHERE "${pk}" IN (${group.map(encodeSqliteLiteral).join(",")}) ORDER BY "${pk}";`,
						)
						.join("\n")
				: "";
		const script = `.bail on\nPRAGMA query_only=ON;\n.mode insert ${table}\n${statements}\n`;
		scriptSha256 = sha256(script);
		const result = await runProcess("sqlite3", ["-readonly", dbPath], {
			stdoutFd: fd,
			input: script,
		});
		if (result.code !== 0)
			throw new Error(
				`snapshot_export_failed:${table}:${result.stderr.trim()}`,
			);
		fsyncSync(fd);
	} catch (error) {
		closeSync(fd);
		rmSync(snapshotPath, { force: true });
		throw error;
	}
	closeSync(fd);
	fsyncDirectory(dirname(snapshotPath));
	return { scriptSha256 };
}

async function verifySnapshotRestore({
	snapshotPath,
	table,
	tableCreateSql,
	pk,
	primaryKeys,
}) {
	const scratchRoot = mkdtempSync(join(tmpdir(), "fly1998-restore-"));
	const scratchPath = join(scratchRoot, "restore.db");
	try {
		const setup = new Database(scratchPath);
		setup.exec(tableCreateSql);
		setup.close();
		const inputFd = openSync(snapshotPath, "r");
		let imported;
		try {
			imported = await runProcess("sqlite3", [scratchPath], {
				stdinFd: inputFd,
			});
		} finally {
			closeSync(inputFd);
		}
		if (imported.code !== 0)
			throw new Error(
				`snapshot_restore_failed:${table}:${imported.stderr.trim()}`,
			);
		const restored = new Database(scratchPath, { readonly: true });
		try {
			if (restored.pragma("quick_check", { simple: true }) !== "ok") {
				throw new Error(`snapshot_quick_check_failed:${table}`);
			}
			const values = restored
				.prepare(`SELECT "${pk}" AS id FROM "${table}" ORDER BY "${pk}"`)
				.all()
				.map((row) => row.id);
			if (orderedDigest(values) !== orderedDigest(primaryKeys)) {
				throw new Error(
					`snapshot_primary_key_digest_mismatch:${table}:restored=${values.length}:expected=${primaryKeys.length}:restored_types=${[...new Set(values.map((value) => typeof value))].join(",")}:expected_types=${[...new Set(primaryKeys.map((value) => typeof value))].join(",")}`,
				);
			}
		} finally {
			restored.close();
		}
		return true;
	} finally {
		rmSync(scratchRoot, { recursive: true, force: true });
	}
}

function validateHealthUrl(value) {
	const url = new URL(value);
	if (
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		url.pathname !== "/health" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		!url.port
	) {
		throw new Error("health_url_not_canonical_loopback");
	}
	return url.toString();
}

function validateProductionInventoryPaths(input) {
	if (input.allowFixturePaths === true) return;
	const expectedTeamlead = realpathSync(
		join(homedir(), ".flywheel", "teamlead.db"),
	);
	const expectedComm = realpathSync(
		join(homedir(), ".flywheel", "comm", "flywheel", "comm.db"),
	);
	if (realpathSync(input.teamleadDbPath) !== expectedTeamlead)
		throw new Error("teamlead_db_path_not_canonical");
	if (realpathSync(input.commDbPath) !== expectedComm)
		throw new Error("comm_db_path_not_canonical");
	const evidenceRoot = join(homedir(), ".flywheel", "maintenance", "fly-1998");
	mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
	const evidenceRootInfo = lstatSync(evidenceRoot);
	if (
		evidenceRootInfo.isSymbolicLink() ||
		!evidenceRootInfo.isDirectory() ||
		(evidenceRootInfo.mode & 0o777) !== 0o700
	) {
		throw new Error("evidence_root_permissions_unsafe");
	}
	const evidenceParent = realpathSync(dirname(resolve(input.evidenceDir)));
	if (
		evidenceParent !== realpathSync(evidenceRoot) ||
		resolve(input.evidenceDir) === resolve(evidenceRoot)
	) {
		throw new Error("evidence_dir_not_canonical_child");
	}
}

export async function executeInventory(input) {
	if (!input || typeof input !== "object")
		throw new Error("inventory_input_required");
	validateHealthUrl(input.healthUrl);
	validateProductionInventoryPaths(input);
	const teamleadIdentity = dbIdentity(input.teamleadDbPath);
	const commIdentity = dbIdentity(input.commDbPath);
	if (existsSync(input.evidenceDir))
		throw new Error("evidence_dir_already_exists");
	mkdirSync(input.evidenceDir, { mode: 0o700 });
	const receiptsDir = join(input.evidenceDir, "receipts");
	mkdirSync(receiptsDir, { mode: 0o700 });
	const startedAt = input.now ?? new Date().toISOString();
	const cutoff14 = new Date(Date.parse(startedAt) - RETENTION_MS).toISOString();
	const statementReceipt = [];
	let teamlead;
	let comm;
	try {
		teamlead = openReadonly(input.teamleadDbPath);
		comm = openReadonly(input.commDbPath);
		const dataVersionBefore = {
			teamlead: Number(teamlead.pragma("data_version", { simple: true })),
			comm: Number(comm.pragma("data_version", { simple: true })),
		};
		recordStatement(
			statementReceipt,
			"teamlead_query_only",
			"PRAGMA query_only",
		);
		recordStatement(statementReceipt, "comm_query_only", "PRAGMA query_only");
		recordStatement(
			statementReceipt,
			"teamlead_data_version_before",
			"PRAGMA data_version",
		);
		recordStatement(
			statementReceipt,
			"comm_data_version_before",
			"PRAGMA data_version",
		);
		const driverVersions = {
			teamlead: assertDriverPreflight(teamlead, cutoff14),
			comm: assertDriverPreflight(comm, cutoff14),
		};
		recordStatement(
			statementReceipt,
			"driver_sqlite_version",
			"SELECT sqlite_version() AS version",
		);
		recordStatement(
			statementReceipt,
			"driver_cutoff_parseable",
			"SELECT julianday(?) IS NOT NULL AS ok",
		);
		const systemSqliteVersion = await systemSqlitePreflight(
			input.teamleadDbPath,
			cutoff14,
		);
		const descriptors = targetDescriptors();
		if (
			descriptors.length !== 1 ||
			descriptors[0]?.key !== "workflowRunEvent"
		) {
			throw new Error("unexpected_cleanup_descriptor_set");
		}
		const descriptor = descriptors[0];
		tableSql(teamlead, descriptor.table);
		const workflowSql = `SELECT e.id FROM workflow_run_event e WHERE ${WORKFLOW_EVENT_PREDICATE} ORDER BY e.id`;
		const workflowPrimaryKeys = rowsWithReceipt(
			teamlead,
			statementReceipt,
			"workflow_event_candidates",
			workflowSql,
			cutoff14,
		).map((row) => Number(row.id));
		const deleteTrigger = triggerSql(teamlead, "workflow_run_event_no_delete");
		const snapshotPath = join(input.evidenceDir, `${descriptor.table}.sql`);
		const snapshotExport = await exportModeInsert({
			dbPath: input.teamleadDbPath,
			table: descriptor.table,
			pk: descriptor.pk,
			primaryKeys: workflowPrimaryKeys,
			snapshotPath,
		});
		const createSql = tableSql(teamlead, descriptor.table);
		const triggers = tableTriggerSet(teamlead, descriptor.table);
		const restoreVerified = await verifySnapshotRestore({
			snapshotPath,
			table: descriptor.table,
			tableCreateSql: createSql,
			pk: descriptor.pk,
			primaryKeys: workflowPrimaryKeys,
		});
		const targets = {
			workflowRunEvent: {
				table: descriptor.table,
				primaryKey: descriptor.pk,
				primaryKeyType: descriptor.pkType,
				primaryKeys: workflowPrimaryKeys,
				primaryKeyDigest: orderedDigest(workflowPrimaryKeys),
				rowCount: workflowPrimaryKeys.length,
				snapshotPath,
				snapshotSha256: sha256File(snapshotPath),
				exportScriptSha256: snapshotExport.scriptSha256,
				restoreVerified,
				tableSqlSha256: sha256(createSql),
				triggerSetSha256: triggerSetDigest(triggers),
				triggerName: "workflow_run_event_no_delete",
				triggerSqlSha256: sha256(deleteTrigger),
			},
		};
		const mailbox = fly1995MailboxState(comm);
		const sessionEvents = fly1995SessionEventsState(teamlead);
		statementReceipt.push(...mailbox.statements, sessionEvents.statement);
		const before = {
			teamlead: databaseMeasurements(
				teamlead,
				input.teamleadDbPath,
				[
					"session_events",
					"workflow_run_event",
					"sessions",
					"dead_letter_alerts",
				],
				statementReceipt,
				"teamlead",
			),
			comm: databaseMeasurements(
				comm,
				input.commDbPath,
				[
					"mailbox",
					"mailbox_log",
					"mailbox_identity",
					"sessions",
					"receipt_alert_outbox",
				],
				statementReceipt,
				"comm",
			),
			health: await sampleHealth(
				input.healthUrl,
				input.healthSampleCount ?? 20,
				input.healthTimeoutMs ?? 5_000,
			),
		};
		const manifest = {
			schemaVersion: MANIFEST_VERSION,
			issue: ISSUE,
			startedAt,
			completedAt: new Date().toISOString(),
			cutoff14,
			healthUrl: input.healthUrl,
			scriptPath,
			scriptSha256: sha256File(scriptPath),
			sqliteVersions: { system: systemSqliteVersion, driver: driverVersions },
			databases: {
				teamlead: {
					...teamleadIdentity,
					schemaSha256: sha256(
						targetDescriptors()
							.map((item) => tableSql(teamlead, item.table))
							.join("\n"),
					),
				},
				comm: { ...commIdentity },
			},
			targets,
			exclusions: {
				fly1995: {
					authority: {
						commit: "09b64bf7f",
						path: "engineering/doc/FLY-1995-bridge-health-stall/cleanup-exclusion-manifest.md",
					},
					mailbox,
					sessionEvents,
				},
			},
			readonlyProof: {
				teamleadQueryOnly: 1,
				commQueryOnly: 1,
				concurrentWriterObservation: {
					before: dataVersionBefore,
					after: {
						teamlead: Number(teamlead.pragma("data_version", { simple: true })),
						comm: Number(comm.pragma("data_version", { simple: true })),
					},
				},
				statements: statementReceipt,
			},
			measurements: before,
		};
		const manifestPath = join(input.evidenceDir, "manifest.json");
		writeSealedJson(manifestPath, manifest);
		return { status: "inventory_complete", manifestPath, manifest };
	} catch (error) {
		if (!existsSync(join(input.evidenceDir, "manifest.json"))) {
			writeExclusive(
				join(input.evidenceDir, "inventory-error.json"),
				`${JSON.stringify({ issue: ISSUE, error: error instanceof Error ? error.message : String(error) })}\n`,
			);
		}
		throw error;
	} finally {
		teamlead?.close();
		comm?.close();
	}
}

function readSealedManifest(manifestPath) {
	const manifest = readSealedJson(manifestPath, "manifest");
	if (manifest.issue !== ISSUE || manifest.schemaVersion !== MANIFEST_VERSION) {
		throw new Error("manifest_identity_mismatch");
	}
	if (manifest.scriptSha256 !== sha256File(scriptPath))
		throw new Error("script_digest_mismatch");
	return manifest;
}

function validateProductionApplyPaths(manifest, allowFixturePaths) {
	if (allowFixturePaths === true) return;
	const expectedTeamlead = realpathSync(
		join(homedir(), ".flywheel", "teamlead.db"),
	);
	const expectedComm = realpathSync(
		join(homedir(), ".flywheel", "comm", "flywheel", "comm.db"),
	);
	if (
		manifest.databases.teamlead.realpath !== expectedTeamlead ||
		manifest.databases.comm.realpath !== expectedComm
	) {
		throw new Error("manifest_database_paths_not_production");
	}
	const evidenceRoot = realpathSync(
		join(homedir(), ".flywheel", "maintenance", "fly-1998"),
	);
	const evidenceDir = realpathSync(
		dirname(manifest.targets.workflowRunEvent.snapshotPath),
	);
	if (!evidenceDir.startsWith(`${evidenceRoot}/`)) {
		throw new Error("manifest_evidence_path_not_production");
	}
}

function assertIdentity(path, expected) {
	const current = dbIdentity(path);
	if (
		current.realpath !== expected.realpath ||
		Number(current.dev) !== Number(expected.dev) ||
		Number(current.ino) !== Number(expected.ino)
	) {
		throw new Error("database_identity_mismatch");
	}
}

function assertSnapshot(target) {
	assertRegularNoSymlink(target.snapshotPath, "snapshot");
	if (sha256File(target.snapshotPath) !== target.snapshotSha256) {
		throw new Error(`snapshot_digest_mismatch:${target.table}`);
	}
	if (orderedDigest(target.primaryKeys) !== target.primaryKeyDigest) {
		throw new Error(`manifest_primary_key_digest_mismatch:${target.table}`);
	}
}

function assertTriggerSet(db, target) {
	if (
		triggerSetDigest(tableTriggerSet(db, target.table)) !==
		target.triggerSetSha256
	) {
		throw new Error(`table_trigger_set_mismatch:${target.table}`);
	}
}

function assertFly1995State(teamlead, comm, expected) {
	const currentMailbox = fly1995MailboxState(comm);
	const placeholders = expected.mailbox.baselineIds.map(() => "?").join(",");
	const present = expected.mailbox.baselineIds.length
		? comm
				.prepare(
					`SELECT id FROM mailbox WHERE id IN (${placeholders}) ORDER BY id`,
				)
				.all(...expected.mailbox.baselineIds)
				.map((row) => String(row.id))
		: [];
	if (orderedDigest(present) !== orderedDigest(expected.mailbox.baselineIds)) {
		throw new Error("fly1995_mailbox_baseline_missing");
	}
	if (currentMailbox.unionCount < expected.mailbox.unionCount) {
		throw new Error("fly1995_mailbox_union_shrank");
	}
	const currentSessions = fly1995SessionEventsState(teamlead);
	if (
		currentSessions.count !== expected.sessionEvents.count ||
		currentSessions.digest !== expected.sessionEvents.digest
	) {
		throw new Error("fly1995_session_events_changed");
	}
}

function sameValues(left, right) {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

async function beginImmediateWithRetry(db, attempts = 5) {
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			db.exec("BEGIN IMMEDIATE");
			return;
		} catch (error) {
			if (error?.code !== "SQLITE_BUSY" || attempt === attempts) throw error;
			await new Promise((resolvePromise) =>
				setTimeout(resolvePromise, 25 * 2 ** (attempt - 1)),
			);
		}
	}
}

function batchReceiptPath(manifestPath, table, index) {
	return join(
		dirname(manifestPath),
		"receipts",
		`${table}-${String(index + 1).padStart(4, "0")}.json`,
	);
}

function readBatchReceipt(path, table, batch, primaryKeys) {
	const receipt = readSealedJson(path, "batch_receipt");
	if (
		receipt.issue !== ISSUE ||
		receipt.table !== table ||
		receipt.batch !== batch ||
		receipt.status !== "committed" ||
		!sameValues(receipt.primaryKeys, primaryKeys)
	) {
		throw new Error("batch_receipt_identity_mismatch");
	}
	return receipt;
}

function committedBatchCount(manifestPath, target) {
	return chunk(target.primaryKeys).filter((_group, index) =>
		existsSync(batchReceiptPath(manifestPath, target.table, index)),
	).length;
}

async function applyWorkflowTarget(db, manifestPath, manifest, target) {
	assertTriggerSet(db, target);
	const currentTrigger = triggerSql(db, target.triggerName);
	if (sha256(currentTrigger) !== target.triggerSqlSha256)
		throw new Error("trigger_digest_mismatch");
	let deleted = 0;
	const groups = chunk(target.primaryKeys);
	for (let index = 0; index < groups.length; index += 1) {
		const ids = groups[index];
		const receiptPath = batchReceiptPath(manifestPath, target.table, index);
		const existing = ids.filter((id) =>
			db.prepare("SELECT 1 FROM workflow_run_event WHERE id=?").get(id),
		);
		if (existsSync(receiptPath)) {
			readBatchReceipt(receiptPath, target.table, index + 1, ids);
			if (existing.length !== 0)
				throw new Error("batch_receipt_row_still_present");
			deleted += ids.length;
			continue;
		}
		if (existing.length !== ids.length)
			throw new Error("candidate_missing_without_receipt");
		await beginImmediateWithRetry(db);
		const started = performance.now();
		try {
			assertTriggerSet(db, target);
			const candidates = workflowCandidateIds(db, manifest.cutoff14, ids);
			if (!sameValues(candidates, ids))
				throw new Error("candidate_cas_mismatch:workflow_run_event");
			const trigger = triggerSql(db, target.triggerName);
			if (sha256(trigger) !== target.triggerSqlSha256)
				throw new Error("trigger_digest_mismatch");
			const triggerIdentifier = `"${target.triggerName.replaceAll('"', '""')}"`;
			db.exec(`DROP TRIGGER ${triggerIdentifier}`);
			const placeholders = ids.map(() => "?").join(",");
			const changes = db
				.prepare(`DELETE FROM workflow_run_event WHERE id IN (${placeholders})`)
				.run(...ids).changes;
			if (changes !== ids.length)
				throw new Error("delete_changes_mismatch:workflow_run_event");
			db.exec(trigger);
			if (performance.now() - started >= 5_000)
				throw new Error("batch_transaction_budget_exceeded");
			db.exec("COMMIT");
		} catch (error) {
			if (db.inTransaction) db.exec("ROLLBACK");
			throw error;
		}
		if (
			sha256(triggerSql(db, target.triggerName)) !== target.triggerSqlSha256
		) {
			throw new Error("trigger_not_restored_after_commit");
		}
		assertTriggerSet(db, target);
		writeSealedJson(receiptPath, {
			issue: ISSUE,
			table: target.table,
			batch: index + 1,
			primaryKeys: ids,
			status: "committed",
		});
		deleted += ids.length;
	}
	return deleted;
}

export async function executeApply(input) {
	const manifest = readSealedManifest(input.manifestPath);
	validateProductionApplyPaths(manifest, input.allowFixturePaths);
	const applyReceiptPath = join(
		dirname(input.manifestPath),
		"apply-receipt.json",
	);
	if (existsSync(applyReceiptPath)) {
		const existing = readSealedJson(applyReceiptPath, "apply_receipt");
		if (
			existing.issue !== ISSUE ||
			existing.status !== "complete" ||
			existing.manifestSha256 !== sha256File(input.manifestPath)
		) {
			throw new Error("apply_receipt_identity_mismatch");
		}
		return { ...existing, applyReceiptPath };
	}
	assertIdentity(manifest.databases.teamlead.path, manifest.databases.teamlead);
	assertIdentity(manifest.databases.comm.path, manifest.databases.comm);
	validateHealthUrl(input.healthUrl ?? manifest.healthUrl);
	for (const target of Object.values(manifest.targets)) assertSnapshot(target);
	const teamlead = new Database(manifest.databases.teamlead.path, {
		fileMustExist: true,
	});
	const comm = openReadonly(manifest.databases.comm.path);
	try {
		teamlead.pragma("busy_timeout = 250");
		teamlead.pragma("foreign_keys = ON");
		if (Number(teamlead.pragma("foreign_keys", { simple: true })) !== 1) {
			throw new Error("foreign_keys_not_enabled");
		}
		assertDriverPreflight(teamlead, manifest.cutoff14);
		assertDriverPreflight(comm, manifest.cutoff14);
		await systemSqlitePreflight(
			manifest.databases.teamlead.path,
			manifest.cutoff14,
		);
		for (const target of Object.values(manifest.targets)) {
			if (sha256(tableSql(teamlead, target.table)) !== target.tableSqlSha256) {
				throw new Error(`table_schema_digest_mismatch:${target.table}`);
			}
			assertTriggerSet(teamlead, target);
			await verifySnapshotRestore({
				snapshotPath: target.snapshotPath,
				table: target.table,
				tableCreateSql: tableSql(teamlead, target.table),
				pk: target.primaryKey,
				primaryKeys: target.primaryKeys,
			});
		}
		assertFly1995State(teamlead, comm, manifest.exclusions.fly1995);
		const deleted = {
			workflowRunEvent: await applyWorkflowTarget(
				teamlead,
				input.manifestPath,
				manifest,
				manifest.targets.workflowRunEvent,
			),
		};
		assertFly1995State(teamlead, comm, manifest.exclusions.fly1995);
		const applyStatements = [];
		const measurements = {
			teamlead: databaseMeasurements(
				teamlead,
				manifest.databases.teamlead.path,
				[
					"session_events",
					"workflow_run_event",
					"sessions",
					"dead_letter_alerts",
				],
				applyStatements,
				"teamlead_after",
			),
			comm: databaseMeasurements(
				comm,
				manifest.databases.comm.path,
				[
					"mailbox",
					"mailbox_log",
					"mailbox_identity",
					"sessions",
					"receipt_alert_outbox",
				],
				applyStatements,
				"comm_after",
			),
			health: await sampleHealth(
				input.healthUrl ?? manifest.healthUrl,
				input.healthSampleCount ?? 20,
				input.healthTimeoutMs ?? 5_000,
			),
		};
		const partialPath = join(dirname(input.manifestPath), "apply-partial.json");
		let supersedesPartial;
		if (existsSync(partialPath)) {
			const partial = readSealedJson(partialPath, "apply_partial");
			if (
				partial.issue !== ISSUE ||
				partial.status !== "partial" ||
				partial.manifestSha256 !== sha256File(input.manifestPath)
			) {
				throw new Error("apply_partial_identity_mismatch");
			}
			supersedesPartial = {
				path: realpathSync(partialPath),
				sha256: sha256File(partialPath),
				committedBatches: partial.committedBatches,
				recordedAt: partial.recordedAt,
			};
		}
		const receipt = {
			issue: ISSUE,
			status: "complete",
			manifestPath: realpathSync(input.manifestPath),
			manifestSha256: sha256File(input.manifestPath),
			deleted,
			measurements,
			statementReceipt: applyStatements,
			supersedesPartial,
			completedAt: new Date().toISOString(),
		};
		writeSealedJson(applyReceiptPath, receipt);
		return { ...receipt, applyReceiptPath };
	} catch (error) {
		const committedBatches = committedBatchCount(
			input.manifestPath,
			manifest.targets.workflowRunEvent,
		);
		if (committedBatches > 0 && !existsSync(applyReceiptPath)) {
			const partialPath = join(
				dirname(input.manifestPath),
				"apply-partial.json",
			);
			if (!existsSync(partialPath)) {
				try {
					writeSealedJson(partialPath, {
						issue: ISSUE,
						status: "partial",
						manifestSha256: sha256File(input.manifestPath),
						committedBatches,
						error: error instanceof Error ? error.message : String(error),
						recordedAt: new Date().toISOString(),
					});
				} catch (markerError) {
					throw new Error(
						`apply_partial_marker_failed:${error instanceof Error ? error.message : String(error)}:${markerError instanceof Error ? markerError.message : String(markerError)}`,
					);
				}
			}
		}
		throw error;
	} finally {
		teamlead.close();
		comm.close();
	}
}

async function defaultLaunchctlJobAbsent() {
	const result = await runProcess("launchctl", [
		"print",
		`gui/${process.getuid()}/com.flywheel.bridge`,
	]);
	if (result.code === 0) return false;
	if (
		/could not find service|service not found/i.test(
			`${result.stdout}\n${result.stderr}`,
		)
	)
		return true;
	throw new Error("bridge_launchctl_probe_inconclusive");
}

async function defaultBridgePortReleased(port) {
	const result = await runProcess("lsof", [
		"-nP",
		`-iTCP:${port}`,
		"-sTCP:LISTEN",
		"-t",
	]);
	if (
		result.code === 1 &&
		result.stdout.trim() === "" &&
		result.stderr.trim() === ""
	)
		return true;
	if (result.code === 0 && result.stdout.trim() !== "") return false;
	throw new Error("bridge_port_probe_inconclusive");
}

async function defaultListOpenFileHolders(path) {
	const result = await runProcess("lsof", ["-t", "--", path]);
	if (
		result.code === 1 &&
		result.stdout.trim() === "" &&
		result.stderr.trim() === ""
	)
		return [];
	if (result.code === 0) {
		const holders = result.stdout
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.map(Number)
			.filter(Number.isSafeInteger);
		if (holders.length === 0) throw new Error("bridge_log_lsof_inconclusive");
		return holders;
	}
	throw new Error("bridge_log_lsof_inconclusive");
}

function assertRotationPath(path, allowFixturePaths) {
	const identity = assertRegularNoSymlink(path, "bridge_log");
	if (
		!allowFixturePaths &&
		identity.realpath !== "/private/tmp/flywheel-bridge.log"
	) {
		throw new Error("bridge_log_path_not_canonical");
	}
	return identity;
}

function rotationReceipt(input, rotated, fresh, recoveredFromStartedMarker) {
	return {
		issue: ISSUE,
		status: "rotated_restore_required",
		manifestSha256: sha256File(input.manifestPath),
		applyReceiptSha256: sha256File(input.applyReceiptPath),
		bridgeLogPath: realpathSync(input.bridgeLogPath),
		rotatedInode: rotated.ino,
		freshInode: fresh.ino,
		recoveredFromStartedMarker,
		restoreRequired: true,
		restoreRunbook: [
			"bash scripts/install-bridge-launchd.sh",
			"launchctl kickstart -k gui/$(id -u)/com.flywheel.bridge",
			"verify launchctl KeepAlive and bounded /health",
		],
	};
}

export async function executeRotateLog(input) {
	const manifest = readSealedManifest(input.manifestPath);
	validateProductionApplyPaths(manifest, input.allowFixturePaths);
	const expectedApplyReceipt = join(
		dirname(input.manifestPath),
		"apply-receipt.json",
	);
	if (resolve(input.applyReceiptPath) !== resolve(expectedApplyReceipt)) {
		throw new Error("apply_receipt_path_mismatch");
	}
	const applyReceipt = readSealedJson(input.applyReceiptPath, "apply_receipt");
	if (
		applyReceipt.issue !== ISSUE ||
		applyReceipt.status !== "complete" ||
		applyReceipt.manifestSha256 !== sha256File(input.manifestPath)
	) {
		throw new Error("complete_apply_receipt_required");
	}
	const rotationReceiptPath = join(
		dirname(input.manifestPath),
		"rotation-receipt.json",
	);
	if (existsSync(rotationReceiptPath)) {
		const existing = readSealedJson(rotationReceiptPath, "rotation_receipt");
		if (
			existing.issue !== ISSUE ||
			existing.status !== "rotated_restore_required" ||
			existing.manifestSha256 !== sha256File(input.manifestPath) ||
			existing.applyReceiptSha256 !== sha256File(input.applyReceiptPath)
		) {
			throw new Error("rotation_receipt_identity_mismatch");
		}
		return { ...existing, rotationReceiptPath };
	}
	const rotationStartedPath = join(
		dirname(input.manifestPath),
		"rotation-started.json",
	);
	const started = existsSync(rotationStartedPath)
		? readSealedJson(rotationStartedPath, "rotation_started")
		: null;
	if (started) {
		if (
			started.issue !== ISSUE ||
			started.status !== "rotation_started" ||
			started.manifestSha256 !== sha256File(input.manifestPath) ||
			started.applyReceiptSha256 !== sha256File(input.applyReceiptPath) ||
			started.bridgeLogPath !== resolve(input.bridgeLogPath)
		) {
			throw new Error("rotation_started_identity_mismatch");
		}
	}
	let current;
	try {
		current = assertRotationPath(
			input.bridgeLogPath,
			input.allowFixturePaths === true,
		);
	} catch (error) {
		if (started)
			throw new Error("rotation_incomplete_manual_recovery_required");
		throw error;
	}
	const hooks = {
		launchctlJobAbsent:
			input.testHooks?.launchctlJobAbsent ?? defaultLaunchctlJobAbsent,
		bridgePortReleased:
			input.testHooks?.bridgePortReleased ?? defaultBridgePortReleased,
		listOpenFileHolders:
			input.testHooks?.listOpenFileHolders ?? defaultListOpenFileHolders,
	};
	if (!(await hooks.launchctlJobAbsent()))
		throw new Error("bridge_launchd_job_loaded");
	const healthPort = Number(new URL(manifest.healthUrl).port);
	if (!Number.isInteger(healthPort) || healthPort < 1 || healthPort > 65_535) {
		throw new Error("manifest_health_port_invalid");
	}
	if (!(await hooks.bridgePortReleased(healthPort)))
		throw new Error("bridge_port_still_bound");
	if (started) {
		const rotatedPath = `${input.bridgeLogPath}.1`;
		if (!existsSync(rotatedPath))
			throw new Error("rotation_incomplete_manual_recovery_required");
		const rotatedIdentity = assertRegularNoSymlink(
			rotatedPath,
			"rotated_bridge_log",
		);
		const rotated = statSync(rotatedPath);
		const fresh = statSync(input.bridgeLogPath);
		if (
			rotatedIdentity.dev !== started.original.dev ||
			rotatedIdentity.ino !== started.original.ino ||
			current.ino === started.original.ino ||
			fresh.size !== 0
		) {
			throw new Error("rotation_incomplete_manual_recovery_required");
		}
		for (const path of [
			input.bridgeLogPath,
			rotatedPath,
			`${input.bridgeLogPath}.2`,
			`${input.bridgeLogPath}.3`,
		]) {
			if (existsSync(path)) {
				assertRegularNoSymlink(path, "bridge_log_recovery_generation");
				if ((await hooks.listOpenFileHolders(path)).length > 0) {
					throw new Error("rotation_recovery_log_has_open_holders");
				}
			}
		}
		const receipt = rotationReceipt(input, rotated, fresh, true);
		writeSealedJson(rotationReceiptPath, receipt);
		return { ...receipt, rotationReceiptPath };
	}
	const original = current;
	let holders = await hooks.listOpenFileHolders(input.bridgeLogPath);
	if (holders.length > 0) throw new Error("bridge_log_has_open_holders");
	for (const generation of [1, 2, 3]) {
		const path = `${input.bridgeLogPath}.${generation}`;
		if (existsSync(path)) {
			assertRegularNoSymlink(path, "bridge_log_generation");
			const generationHolders = await hooks.listOpenFileHolders(path);
			if (generationHolders.length > 0) {
				throw new Error("bridge_log_generation_has_open_holders");
			}
		}
	}
	// Signal-time revalidation immediately before the first rename.
	holders = await hooks.listOpenFileHolders(input.bridgeLogPath);
	if (holders.length > 0) throw new Error("bridge_log_has_open_holders");
	writeSealedJson(rotationStartedPath, {
		issue: ISSUE,
		status: "rotation_started",
		manifestSha256: sha256File(input.manifestPath),
		applyReceiptSha256: sha256File(input.applyReceiptPath),
		bridgeLogPath: resolve(input.bridgeLogPath),
		original: {
			dev: original.dev,
			ino: original.ino,
			size: statSync(input.bridgeLogPath).size,
		},
		generations: Object.fromEntries(
			[1, 2, 3].map((generation) => {
				const path = `${input.bridgeLogPath}.${generation}`;
				if (!existsSync(path)) return [String(generation), null];
				const identity = assertRegularNoSymlink(path, "bridge_log_generation");
				return [String(generation), { ...identity, size: statSync(path).size }];
			}),
		),
		createdAt: new Date().toISOString(),
	});
	if (existsSync(`${input.bridgeLogPath}.3`))
		unlinkSync(`${input.bridgeLogPath}.3`);
	if (existsSync(`${input.bridgeLogPath}.2`)) {
		renameSync(`${input.bridgeLogPath}.2`, `${input.bridgeLogPath}.3`);
	}
	if (existsSync(`${input.bridgeLogPath}.1`)) {
		renameSync(`${input.bridgeLogPath}.1`, `${input.bridgeLogPath}.2`);
	}
	renameSync(input.bridgeLogPath, `${input.bridgeLogPath}.1`);
	const fd = openSync(input.bridgeLogPath, "wx", 0o600);
	fsyncSync(fd);
	closeSync(fd);
	fsyncDirectory(dirname(input.bridgeLogPath));
	const rotated = statSync(`${input.bridgeLogPath}.1`);
	const fresh = statSync(input.bridgeLogPath);
	if (
		rotated.ino !== original.ino ||
		fresh.ino === original.ino ||
		fresh.size !== 0
	) {
		throw new Error("bridge_log_rotation_inode_verification_failed");
	}
	holders = await hooks.listOpenFileHolders(`${input.bridgeLogPath}.1`);
	if (holders.length > 0)
		throw new Error("rotated_bridge_log_has_open_holders");
	const receipt = rotationReceipt(input, rotated, fresh, false);
	writeSealedJson(rotationReceiptPath, receipt);
	return { ...receipt, rotationReceiptPath };
}

function parseArgs(argv) {
	const [command, ...rest] = argv;
	if (!["inventory", "apply", "rotate-log"].includes(command))
		throw new Error("command_required");
	const contracts = {
		inventory: ["--teamlead-db", "--comm-db", "--evidence-dir", "--health-url"],
		apply: ["--manifest"],
		"rotate-log": ["--manifest", "--bridge-log"],
	};
	const allowed = new Set(contracts[command]);
	const args = { command };
	for (let index = 0; index < rest.length; index += 1) {
		const key = rest[index];
		if (!allowed.has(key) || index + 1 >= rest.length)
			throw new Error(`invalid_argument:${key}`);
		if (args[key]) throw new Error(`duplicate_argument:${key}`);
		args[key] = rest[++index];
	}
	for (const required of contracts[command]) {
		if (!args[required]) throw new Error(`missing_argument:${required}`);
	}
	return args;
}

async function runCli() {
	try {
		const args = parseArgs(process.argv.slice(2));
		let result;
		if (args.command === "inventory") {
			result = await executeInventory({
				teamleadDbPath: args["--teamlead-db"],
				commDbPath: args["--comm-db"],
				evidenceDir: args["--evidence-dir"],
				healthUrl: args["--health-url"],
			});
		} else if (args.command === "apply") {
			result = await executeApply({ manifestPath: args["--manifest"] });
		} else {
			const manifestPath = args["--manifest"];
			result = await executeRotateLog({
				manifestPath,
				applyReceiptPath: join(dirname(manifestPath), "apply-receipt.json"),
				bridgeLogPath: args["--bridge-log"],
			});
		}
		process.stdout.write(
			`${JSON.stringify({
				status: result.status,
				manifestPath: result.manifestPath,
				applyReceiptPath: result.applyReceiptPath,
				rotationReceiptPath: result.rotationReceiptPath,
				deleted: result.deleted,
				counts: result.measurements
					? {
							teamlead: result.measurements.teamlead.counts,
							comm: result.measurements.comm.counts,
						}
					: undefined,
			})}\n`,
		);
	} catch (error) {
		process.stderr.write(
			`fly1998_retention_error: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	}
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) await runCli();
