import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
	commInvalidStorage,
	commMarkers,
	commMatch,
} from "./qa-fly-2456-comm-predicate.mjs";
import { openEvidence } from "./qa-fly-2456-evidence.mjs";

const require = createRequire(
	new URL("../../packages/flywheel-comm/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
const quote = (value) => `"${value.replaceAll('"', '""')}"`;
const fail = (reason) => ({ status: "fail", reason, hitCount: null, hits: [] });
function snapshotScan(path, scan, kind) {
	let db;
	try {
		if (path.endsWith(".evidence.json")) {
			const opened = openEvidence(path, kind);
			db = opened.db;
			return { ...scan(db), ...opened.metadata };
		}
		const meta = JSON.parse(readFileSync(`${path}.meta.json`, "utf8"));
		if (
			typeof meta.observedAt !== "string" ||
			!Number.isFinite(Date.parse(meta.observedAt)) ||
			!/^[a-f0-9]{64}$/.test(meta.sha256)
		)
			return fail("snapshot_invalid");
		if (existsSync(`${path}-wal`) || existsSync(`${path}-shm`))
			return fail("snapshot_sidecar");
		const bytes = readFileSync(path);
		if (createHash("sha256").update(bytes).digest("hex") !== meta.sha256)
			return fail("snapshot_invalid");
		db = new Database(bytes, { readonly: true, fileMustExist: true });
		return { ...scan(db), observedAt: meta.observedAt, sha256: meta.sha256 };
	} catch {
		return fail("snapshot_or_query_error");
	} finally {
		db?.close();
	}
}
function schema(db, required, views = []) {
	const objects = db
		.prepare(
			"SELECT name,type FROM sqlite_master WHERE type IN ('table','view')",
		)
		.all();
	const tables = objects
		.filter((o) => o.type === "table")
		.map(({ name }) => ({
			name,
			columns: db.prepare(`PRAGMA table_info(${quote(name)})`).all(),
		}));
	for (const [name, columns] of Object.entries(required)) {
		const table = tables.find((t) => t.name === name);
		if (
			!table ||
			!columns.every((c) =>
				table.columns.some(
					(col) => col.name === c && /TEXT|JSON/i.test(col.type),
				),
			)
		)
			return null;
	}
	if (
		!views.every((name) =>
			objects.some((o) => o.name === name && o.type === "view"),
		)
	)
		return null;
	return tables;
}
// SQLite affinity does not guarantee text storage; LIKE also stops at NUL.
function invalidTextStorage(db, table, columns) {
	return Boolean(
		db
			.prepare(
				`SELECT 1 FROM ${quote(table)} WHERE ${columns
					.map((column) => {
						const name = quote(column);
						return `(${name} IS NOT NULL AND (typeof(${name}) != 'text' OR instr(${name}, char(0)) > 0))`;
					})
					.join(" OR ")} LIMIT 1`,
			)
			.get(),
	);
}
export function commScan(dbPath, { slot, executions, lead } = {}) {
	return snapshotScan(
		dbPath,
		(db) => {
			const tables = schema(
				db,
				{
					mailbox: ["from_agent", "to_agent", "type", "content"],
					sessions: ["execution_id"],
					three_stage_turn: ["holder_exec_id"],
					runner_workflow_activation: ["execution_id"],
					mailbox_terminal_archive: [],
					mailbox_log: [],
				},
				["messages", "mailbox_message_projection"],
			);
			if (!tables) return fail("schema_invalid");
			let markers;
			try {
				markers = commMarkers({ slot, executions, lead });
			} catch {
				return fail("arguments_invalid");
			}
			const hits = [],
				hitRows = [];
			let scannedColumns = 0;
			for (const { name, columns } of tables)
				for (const column of columns.filter((c) => /TEXT|JSON/i.test(c.type))) {
					scannedColumns++;
					if (
						db
							.prepare(
								`SELECT 1 FROM ${quote(name)} WHERE ${commInvalidStorage([column.name])} LIMIT 1`,
							)
							.get()
					)
						return fail("text_storage_invalid");
					const match = commMatch([column.name], markers);
					let count = 0;
					for (const { rowid } of db
						.prepare(
							`SELECT rowid FROM ${quote(name)} WHERE ${match.sql} ORDER BY rowid`,
						)
						.iterate(...match.params)) {
						hitRows.push({ table: name, rowid, column: column.name });
						count++;
					}
					if (count) hits.push({ table: name, column: column.name, count });
				}
			const hitCount = hits.reduce((sum, h) => sum + h.count, 0);
			return {
				status: hitCount ? "fail" : "pass",
				hitCount,
				hits,
				hitRows,
				scannedTables: tables.length,
				scannedColumns,
			};
		},
		"comm",
	);
}
export function prodStatestoreCheck(dbPath, { executions } = {}) {
	return snapshotScan(
		dbPath,
		(db) => {
			if (
				!schema(db, {
					sessions: ["execution_id"],
					session_events: ["execution_id", "source"],
				})
			)
				return fail("schema_invalid");
			if (
				!Array.isArray(executions) ||
				!executions.length ||
				executions.some((x) => typeof x !== "string" || !x)
			)
				return fail("arguments_invalid");
			const hits = [],
				hitRows = [];
			const placeholders = executions.map(() => "?").join(",");
			for (const table of ["sessions", "session_events"]) {
				if (
					invalidTextStorage(
						db,
						table,
						table === "sessions"
							? ["execution_id"]
							: ["execution_id", "source"],
					)
				)
					return fail("text_storage_invalid");
				let count = 0;
				const identity = table === "sessions" ? "execution_id" : "id";
				for (const { rowid } of db
					.prepare(
						`SELECT ${identity} AS rowid FROM ${quote(table)} WHERE execution_id IN (${placeholders})${table === "session_events" ? " AND source = 'bridge.codex-session-reown'" : ""} ORDER BY ${identity}`,
					)
					.iterate(...executions)) {
					hitRows.push({ table, rowid, column: "execution_id" });
					count++;
				}
				if (count) hits.push({ table, column: "execution_id", count });
			}
			const hitCount = hits.reduce((sum, h) => sum + h.count, 0);
			return {
				status: hitCount ? "fail" : "pass",
				hits,
				hitRows,
				hitCount,
				scannedTables: 2,
			};
		},
		"production",
	);
}

// Compare identities, never aggregate counts: deletion cannot hide an addition.
export function scanDelta(before, after) {
	const key = (row) => JSON.stringify([row.table, row.rowid, row.column]);
	const valid = (record) => {
		if (
			!record ||
			record.reason ||
			!Array.isArray(record.hitRows) ||
			!Array.isArray(record.hits) ||
			record.hitCount !== record.hitRows.length ||
			record.status !== (record.hitCount ? "fail" : "pass")
		)
			return false;
		const rows = record.hitRows;
		if (
			rows.some(
				(row) =>
					!row ||
					typeof row.table !== "string" ||
					!row.table ||
					typeof row.column !== "string" ||
					!row.column ||
					!(
						Number.isSafeInteger(row.rowid) ||
						(typeof row.rowid === "string" && row.rowid)
					),
			)
		)
			return false;
		if (new Set(rows.map(key)).size !== rows.length) return false;
		const counts = new Map();
		for (const row of rows) {
			const k = JSON.stringify([row.table, row.column]);
			counts.set(k, (counts.get(k) ?? 0) + 1);
		}
		return (
			record.hits.length === counts.size &&
			new Set(record.hits.map((hit) => JSON.stringify([hit.table, hit.column])))
				.size === record.hits.length &&
			record.hits.every(
				(hit) =>
					counts.get(JSON.stringify([hit.table, hit.column])) === hit.count,
			)
		);
	};
	if (!valid(before) || !valid(after))
		return {
			status: "fail",
			reason: "invalid scan identity proof",
			baselineHitCount: null,
			newHitCount: null,
			added: [],
		};
	const baseline = new Set(before.hitRows.map(key));
	const added = after.hitRows.filter((row) => !baseline.has(key(row)));
	return {
		status: added.length ? "fail" : "pass",
		baselineHitCount: before.hitCount,
		newHitCount: added.length,
		added,
	};
}
