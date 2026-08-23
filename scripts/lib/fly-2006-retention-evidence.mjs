import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertFrozenCohort } from "./fly-2006-retention-cohort.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageRequire = createRequire(
	join(repoRoot, "packages/teamlead/package.json"),
);
const Database = packageRequire("better-sqlite3");

export const LEGACY_V1_SCRIPT_SHA256 =
	"163996daa030d636bf7de8064693ea3990d124414731add8d84f94564a7d4c8c";

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function sha256File(path) {
	return sha256(readFileSync(path));
}

function safeIdentifier(value) {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
		throw new Error(`sqlite_identifier_invalid:${value}`);
	return `"${value}"`;
}

function assertRegularFile(path, label, expectedMode) {
	const info = lstatSync(path);
	if (info.isSymbolicLink() || !info.isFile())
		throw new Error(`${label}_not_regular_file`);
	if (expectedMode !== undefined && (info.mode & 0o777) !== expectedMode)
		throw new Error(`${label}_permissions_unsafe`);
	return info;
}

export function writeSealedJson(path, value) {
	const internal = {
		...value,
		_internalSeal: {
			algorithm: "sha256",
			payloadSha256: sha256(JSON.stringify(value)),
		},
	};
	const bytes = `${JSON.stringify(internal, null, 2)}\n`;
	writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
	writeFileSync(`${path}.sha256`, `${sha256(bytes)}\n`, {
		flag: "wx",
		mode: 0o600,
	});
	return { path, sha256: sha256(bytes) };
}

export function readSealedJson(path, label) {
	assertRegularFile(path, label, 0o600);
	assertRegularFile(`${path}.sha256`, `${label}_digest`, 0o600);
	const bytes = readFileSync(path);
	if (sha256(bytes) !== readFileSync(`${path}.sha256`, "utf8").trim())
		throw new Error(`${label}_digest_mismatch`);
	let parsed;
	try {
		parsed = JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new Error(`${label}_json_invalid`);
	}
	const internal = parsed._internalSeal;
	delete parsed._internalSeal;
	if (
		internal?.algorithm !== "sha256" ||
		internal.payloadSha256 !== sha256(JSON.stringify(parsed))
	)
		throw new Error(`${label}_internal_digest_mismatch`);
	return parsed;
}

function tableSql(db, table) {
	const row = db
		.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?")
		.get(table);
	if (!row?.sql) throw new Error(`snapshot_table_missing:${table}`);
	return String(row.sql);
}

function loadRows(db, table, primaryKey, primaryKeys) {
	const result = [];
	for (let offset = 0; offset < primaryKeys.length; offset += 500) {
		const group = primaryKeys.slice(offset, offset + 500);
		const placeholders = group.map(() => "?").join(",");
		result.push(
			...db
				.prepare(
					`SELECT * FROM ${safeIdentifier(table)} WHERE ${safeIdentifier(primaryKey)} IN (${placeholders}) ORDER BY ${safeIdentifier(primaryKey)}`,
				)
				.all(...group),
		);
	}
	return result;
}

function insertRows(db, table, columns, rows) {
	const insert = db.prepare(
		`INSERT INTO ${safeIdentifier(table)} (${columns.map(safeIdentifier).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
	);
	const transaction = db.transaction(() => {
		for (const row of rows) insert.run(...columns.map((column) => row[column]));
	});
	transaction.immediate();
}

function projected(row, casFields) {
	return Object.fromEntries(casFields.map((field) => [field, row[field]]));
}

function finishShard(shards, shard, primaryKey) {
	if (shard.rowCount === 0) return;
	shards.push({
		minPrimaryKey: shard.minPrimaryKey,
		maxPrimaryKey: shard.maxPrimaryKey,
		rowCount: shard.rowCount,
		digest: shard.hash.digest("hex"),
	});
	shard.hash = createHash("sha256");
	shard.rowCount = 0;
	shard.minPrimaryKey = null;
	shard.maxPrimaryKey = null;
	shard.primaryKey = primaryKey;
}

function frozenFromIterable(iterable, { primaryKey, casFields }) {
	const digest = createHash("sha256");
	const shards = [];
	const shard = {
		hash: createHash("sha256"),
		rowCount: 0,
		minPrimaryKey: null,
		maxPrimaryKey: null,
	};
	let exactKeys = [];
	let rowCount = 0;
	let previous = null;
	let keyType = null;
	for (const row of iterable) {
		const key = row[primaryKey];
		keyType ??= typeof key;
		if (
			typeof key !== keyType ||
			!new Set(["number", "string"]).has(keyType) ||
			(keyType === "number" && !Number.isSafeInteger(key))
		)
			throw new Error("cohort_primary_key_type_mismatch");
		if (previous !== null && key <= previous)
			throw new Error("range_primary_key_not_strictly_monotonic");
		previous = key;
		const line = `${JSON.stringify(projected(row, casFields))}\n`;
		digest.update(line);
		shard.hash.update(line);
		shard.minPrimaryKey ??= key;
		shard.maxPrimaryKey = key;
		shard.rowCount += 1;
		rowCount += 1;
		if (exactKeys) {
			exactKeys.push(key);
			if (exactKeys.length > 20_000) {
				if (keyType !== "number")
					throw new Error("range_primary_key_not_safe_integer");
				exactKeys = null;
			}
		}
		if (shard.rowCount === 50_000) finishShard(shards, shard, primaryKey);
	}
	finishShard(shards, shard, primaryKey);
	const base = {
		rowCount,
		casFields: [...casFields],
		digest: digest.digest("hex"),
	};
	return exactKeys
		? { ...base, mode: "exact-keys", primaryKeys: exactKeys }
		: { ...base, mode: "range-digest", shards };
}

function assertSameFrozen(current, expected) {
	if (current.rowCount !== expected.rowCount || current.mode !== expected.mode)
		throw new Error("cohort_cas_count_mismatch");
	if (current.digest !== expected.digest)
		throw new Error("cohort_cas_digest_mismatch");
	if (
		current.mode === "exact-keys" &&
		JSON.stringify(current.primaryKeys) !== JSON.stringify(expected.primaryKeys)
	)
		throw new Error("cohort_cas_primary_keys_mismatch");
	if (
		current.mode === "range-digest" &&
		JSON.stringify(current.shards) !== JSON.stringify(expected.shards)
	)
		throw new Error("cohort_cas_shards_mismatch");
}

export async function createSqliteSnapshot({
	sourceDb,
	table,
	primaryKey,
	primaryKeys,
	casFields,
	frozen,
	snapshotPath,
}) {
	if (primaryKeys.length === 0) {
		return { rowCount: 0, snapshotPath: null, restoreVerified: true };
	}
	if (existsSync(snapshotPath)) throw new Error("snapshot_path_exists");
	const rows = loadRows(sourceDb, table, primaryKey, primaryKeys);
	assertFrozenCohort(rows, frozen, { primaryKey, casFields });
	const createSql = tableSql(sourceDb, table);
	const fd = openSync(snapshotPath, "wx", 0o600);
	closeSync(fd);
	let destination;
	try {
		destination = new Database(snapshotPath, { fileMustExist: true });
		destination.pragma("foreign_keys=OFF");
		destination.exec(createSql);
		const columns = destination
			.prepare(`PRAGMA table_info(${safeIdentifier(table)})`)
			.all()
			.map((row) => String(row.name));
		insertRows(destination, table, columns, rows);
		destination.close();
		destination = undefined;
		chmodSync(snapshotPath, 0o600);
		const snapshot = {
			snapshotPath,
			snapshotSha256: sha256File(snapshotPath),
			tableSqlSha256: sha256(createSql),
			rowCount: rows.length,
		};
		const verified = await verifySqliteSnapshot({
			...snapshot,
			expectedSha256: snapshot.snapshotSha256,
			table,
			primaryKey,
			casFields,
			frozen,
		});
		return { ...snapshot, restoreVerified: verified.restoreVerified };
	} catch (error) {
		destination?.close();
		rmSync(snapshotPath, { force: true });
		throw error;
	}
}

export async function createSqliteSnapshotFromQuery({
	sourceDb,
	table,
	primaryKey,
	casFields,
	query,
	params,
	snapshotPath,
}) {
	if (existsSync(snapshotPath)) throw new Error("snapshot_path_exists");
	if (!casFields.includes(primaryKey))
		throw new Error("cohort_cas_primary_key_required");
	const createSql = tableSql(sourceDb, table);
	const fd = openSync(snapshotPath, "wx", 0o600);
	closeSync(fd);
	let destination;
	try {
		destination = new Database(snapshotPath, { fileMustExist: true });
		destination.pragma("foreign_keys=OFF");
		destination.exec(createSql);
		const columns = destination
			.prepare(`PRAGMA table_info(${safeIdentifier(table)})`)
			.all()
			.map((row) => String(row.name));
		const insertColumns =
			primaryKey === "__rowid" ? ["rowid", ...columns] : columns;
		const insert = destination.prepare(
			`INSERT INTO ${safeIdentifier(table)} (${insertColumns.map(safeIdentifier).join(",")}) VALUES (${insertColumns.map(() => "?").join(",")})`,
		);
		destination.exec("BEGIN IMMEDIATE");
		let frozen;
		try {
			const iterator = sourceDb.prepare(query).iterate(...params);
			frozen = frozenFromIterable(
				(function* insertAndYield() {
					for (const row of iterator) {
						insert.run(
							...(primaryKey === "__rowid"
								? [row.__rowid, ...columns.map((column) => row[column])]
								: columns.map((column) => row[column])),
						);
						yield row;
					}
				})(),
				{ primaryKey, casFields },
			);
			destination.exec("COMMIT");
		} catch (error) {
			if (destination.inTransaction) destination.exec("ROLLBACK");
			throw error;
		}
		destination.close();
		destination = undefined;
		if (frozen.rowCount === 0) {
			rmSync(snapshotPath, { force: true });
			return {
				rowCount: 0,
				snapshotPath: null,
				restoreVerified: true,
				frozen,
			};
		}
		chmodSync(snapshotPath, 0o600);
		const snapshot = {
			snapshotPath,
			snapshotSha256: sha256File(snapshotPath),
			tableSqlSha256: sha256(createSql),
			rowCount: frozen.rowCount,
			frozen,
		};
		const verified = await verifySqliteSnapshot({
			...snapshot,
			expectedSha256: snapshot.snapshotSha256,
			table,
			primaryKey,
			casFields,
			frozen,
		});
		return { ...snapshot, restoreVerified: verified.restoreVerified };
	} catch (error) {
		destination?.close();
		rmSync(snapshotPath, { force: true });
		throw error;
	}
}

export async function verifySqliteSnapshot({
	snapshotPath,
	expectedSha256,
	table,
	primaryKey,
	casFields,
	frozen,
	tableSqlSha256,
}) {
	assertRegularFile(snapshotPath, "snapshot", 0o600);
	if (sha256File(snapshotPath) !== expectedSha256)
		throw new Error("snapshot_digest_mismatch");
	const root = mkdtempSync(join(dirname(snapshotPath), ".snapshot-restore-"));
	const restoredPath = join(root, "restored.db");
	const snapshot = new Database(snapshotPath, {
		readonly: true,
		fileMustExist: true,
	});
	try {
		await snapshot.backup(restoredPath);
	} finally {
		snapshot.close();
	}
	try {
		const restored = new Database(restoredPath, {
			readonly: true,
			fileMustExist: true,
		});
		try {
			if (restored.pragma("quick_check", { simple: true }) !== "ok")
				throw new Error("snapshot_quick_check_failed");
			if (sha256(tableSql(restored, table)) !== tableSqlSha256)
				throw new Error("snapshot_schema_digest_mismatch");
			const casProjection = casFields
				.map((field) =>
					field === "__rowid"
						? `rowid AS ${safeIdentifier("__rowid")}`
						: safeIdentifier(field),
				)
				.join(",");
			const orderBy =
				primaryKey === "__rowid" ? "rowid" : safeIdentifier(primaryKey);
			const current = frozenFromIterable(
				restored
					.prepare(
						`SELECT ${casProjection} FROM ${safeIdentifier(table)} ORDER BY ${orderBy}`,
					)
					.iterate(),
				{ primaryKey, casFields },
			);
			assertSameFrozen(current, frozen);
			return { rowCount: current.rowCount, restoreVerified: true };
		} finally {
			restored.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

export function readLegacyClosedEvidence({ manifestPath, applyReceiptPath }) {
	const manifest = readSealedJson(manifestPath, "legacy_manifest");
	if (
		manifest.issue !== "FLY-1998" ||
		manifest.schemaVersion !== 1 ||
		manifest.scriptSha256 !== LEGACY_V1_SCRIPT_SHA256
	)
		throw new Error("legacy_v1_manifest_identity_mismatch");
	const receipt = readSealedJson(applyReceiptPath, "legacy_apply_receipt");
	if (
		receipt.issue !== "FLY-1998" ||
		receipt.status !== "complete" ||
		receipt.manifestSha256 !== sha256File(manifestPath)
	)
		throw new Error("legacy_v1_complete_receipt_required");
	return {
		issue: "FLY-1998",
		status: "complete",
		manifest,
		receipt,
		legacyBaselineRechecked: false,
	};
}
