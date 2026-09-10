import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
	commInvalidStorage,
	commMarkers,
	commMatch,
} from "./qa-fly-2456-comm-predicate.mjs";
import { openSnapshot } from "./qa-fly-2456-db.mjs";

const require = createRequire(
	new URL("../../packages/flywheel-comm/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
const quote = (s) => `"${s.replaceAll('"', '""')}"`;
const columnsByKind = {
	production: {
		sessions: [
			"execution_id",
			"issue_id",
			"project_name",
			"status",
			"terminal_at",
			"tmux_session",
		],
		session_events: [
			"id",
			"event_id",
			"execution_id",
			"issue_id",
			"project_name",
			"event_type",
			"ts",
			"source",
		],
	},
	observation: {
		sessions: ["execution_id", "status", "last_error"],
		session_events: [
			"id",
			"event_id",
			"ts",
			"execution_id",
			"source",
			"event_type",
			"payload",
		],
		workflow_run: ["run_id"],
		workflow_run_event: [
			"seq",
			"run_id",
			"event_uid",
			"at",
			"kind",
			"node_id",
			"execution_id",
			"payload",
		],
		recovery_claim: ["execution_id", "episode_id", "episode_attempts"],
	},
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Preserve storage classes: TEXT affinity must not hide malformed numeric/BLOB values.
const encode = (value) =>
	Buffer.isBuffer(value) ? { blob: value.toString("base64") } : value;
const decode = (value) => {
	if (
		value === null ||
		typeof value === "string" ||
		(typeof value === "number" && Number.isFinite(value))
	)
		return value;
	if (
		value &&
		Object.keys(value).length === 1 &&
		typeof value.blob === "string" &&
		Buffer.from(value.blob, "base64").toString("base64") === value.blob
	)
		return Buffer.from(value.blob, "base64");
	throw Error("derived cell invalid");
};
export function deriveEvidence(
	source,
	output,
	kind,
	{ slot, executions = [], lead } = {},
) {
	if (
		!output.endsWith(".evidence.json") ||
		!(kind === "comm" || Object.hasOwn(columnsByKind, kind))
	)
		throw Error("evidence arguments invalid");
	const markers =
		kind === "comm" ? commMarkers({ slot, executions, lead }, true) : [];
	const { db, metadata } = openSnapshot(source);
	try {
		const objects = db
			.prepare(
				"SELECT name,type FROM sqlite_master WHERE type IN ('table','view')" +
					(kind === "comm" ? "" : " ORDER BY name"),
			)
			.all();
		const tables = [];
		for (const object of objects.filter((o) => o.type === "table")) {
			if (kind !== "comm" && !Object.hasOwn(columnsByKind[kind], object.name))
				continue;
			const all = db.prepare(`PRAGMA table_info(${quote(object.name)})`).all();
			const selected = all.filter((c) =>
				kind === "comm"
					? /TEXT|JSON/i.test(c.type)
					: columnsByKind[kind][object.name].includes(c.name),
			);
			const rows =
				kind === "comm"
					? []
					: selected.length
						? db
								.prepare(
									`SELECT ${selected.map((c) => quote(c.name)).join(",")} FROM ${quote(object.name)}`,
								)
								.raw()
								.all()
								.map((row) => row.map(encode))
						: [];
			let fingerprint;
			const rowids = [];
			if (kind === "comm") {
				if (
					selected.length &&
					db
						.prepare(
							`SELECT 1 FROM ${quote(object.name)} WHERE ${commInvalidStorage(selected.map((c) => c.name))} LIMIT 1`,
						)
						.get()
				)
					throw Error("text_storage_invalid");
				let rowCount = 0;
				const hash = createHash("sha256");
				// One canonical JSON array per line, in rowid order. No whole-table
				// materialization: even unrelated archive text only visits one row.
				for (const row of db
					.prepare(
						`SELECT ${selected.length ? selected.map((c) => quote(c.name)).join(",") : "1"} FROM ${quote(object.name)} ORDER BY rowid`,
					)
					.raw()
					.iterate()) {
					hash.update(
						JSON.stringify(selected.length ? row.map(encode) : []) + "\n",
					);
					rowCount++;
				}
				fingerprint = {
					rowCount,
					sha256: hash.digest("hex"),
					schemaColumns: all.map(({ name, type }) => ({ name, type })),
				};
			}
			if (kind === "comm" && selected.length) {
				const match = commMatch(
					selected.map((c) => c.name),
					markers,
				);
				for (const row of db
					.prepare(
						`SELECT rowid, ${selected.map((c) => quote(c.name)).join(",")} FROM ${quote(object.name)} WHERE ${match.sql} ORDER BY rowid`,
					)
					.raw()
					.iterate(...match.params)) {
					rowids.push(row[0]);
					rows.push(row.slice(1).map(encode));
				}
			}
			tables.push({
				name: object.name,
				...fingerprint,
				...(kind === "comm" ? { rowids } : {}),
				columns: selected.map(({ name, type }) => ({ name, type })),
				rows,
			});
		}
		const value = {
			version: 1,
			kind,
			source: { path: source, ...metadata },
			tables,
			views:
				kind === "comm"
					? objects.filter((o) => o.type === "view").map((o) => o.name)
					: [],
		};
		const raw = JSON.stringify(value);
		writeFileSync(output, raw, { flag: "wx", mode: 0o600 });
		writeFileSync(
			output + ".meta.json",
			JSON.stringify({ sha256: digest(raw), source: value.source }),
			{ flag: "wx", mode: 0o600 },
		);
		return {
			status: "pass",
			path: output,
			sha256: digest(raw),
			source: value.source,
		};
	} finally {
		db.close();
	}
}
// Derived evidence is a projection, not a database copy: no source indexes,
// triggers, constraints, binary columns, or unrelated StateStore tables travel.
// Reconstruct only an in-memory query surface so existing predicates stay exact.
export function openEvidence(path, kind) {
	if (!path.endsWith(".evidence.json")) return openSnapshot(path);
	const raw = readFileSync(path),
		value = JSON.parse(raw),
		meta = JSON.parse(readFileSync(path + ".meta.json", "utf8"));
	if (
		value.version !== 1 ||
		value.kind !== kind ||
		!/^[a-f0-9]{64}$/.test(meta.sha256) ||
		digest(raw) !== meta.sha256 ||
		JSON.stringify(meta.source) !== JSON.stringify(value.source) ||
		!Number.isFinite(Date.parse(value.source?.observedAt)) ||
		!/^[a-f0-9]{64}$/.test(value.source?.sha256)
	)
		throw Error("derived evidence invalid");
	const db = new Database(":memory:");
	try {
		const seen = new Set();
		for (const table of value.tables) {
			if (
				typeof table.name !== "string" ||
				!table.name ||
				seen.has(table.name) ||
				!Array.isArray(table.columns) ||
				!Array.isArray(table.rows)
			)
				throw Error("derived table invalid");
			seen.add(table.name);
			if (table.name.startsWith("sqlite_")) {
				if (table.columns.length || table.rows.length)
					throw Error("unsupported internal text table");
				continue;
			}
			const names = new Set();
			for (const c of table.columns) {
				if (
					typeof c.name !== "string" ||
					!c.name ||
					names.has(c.name) ||
					typeof c.type !== "string"
				)
					throw Error("derived column invalid");
				names.add(c.name);
			}
			// Storage is untyped during insert to preserve typeof() negative guards.
			const placeholder = table.columns.length
				? table.columns
				: [{ name: "_unscanned", type: "" }];
			db.exec(
				`CREATE TABLE ${quote(table.name)} (${placeholder.map((c) => quote(c.name)).join(",")})`,
			);
			if (table.columns.length) {
				const hasRowids = kind === "comm";
				if (
					hasRowids &&
					(!Array.isArray(table.rowids) ||
						table.rowids.length !== table.rows.length ||
						new Set(table.rowids).size !== table.rowids.length ||
						table.rowids.some((id) => !Number.isSafeInteger(id)))
				)
					throw Error("derived rowids invalid");
				const insert = db.prepare(
					`INSERT INTO ${quote(table.name)} ${hasRowids ? `(rowid,${table.columns.map((c) => quote(c.name)).join(",")})` : ""} VALUES (${[...(hasRowids ? ["?"] : []), ...table.columns.map(() => "?")].join(",")})`,
				);
				db.transaction(() => {
					for (const [index, row] of table.rows.entries()) {
						if (!Array.isArray(row) || row.length !== table.columns.length)
							throw Error("derived row invalid");
						insert.run(
							...(hasRowids ? [table.rowids[index]] : []),
							...row.map(decode),
						);
					}
				})();
			}
		}
		// PRAGMA consumers need the original declared types, without coercing values.
		const prepare = db.prepare.bind(db);
		db.prepare = (sql) => {
			if (
				sql ===
				"SELECT name,type FROM sqlite_master WHERE type IN ('table','view')"
			)
				return {
					all: () => [
						...value.tables.map((t) => ({ name: t.name, type: "table" })),
						...value.views.map((name) => ({ name, type: "view" })),
					],
				};
			const match = /^PRAGMA table_info\("((?:[^"]|"")*)"\)$/.exec(sql);
			if (match) {
				const table = value.tables.find(
					(t) => t.name === match[1].replaceAll('""', '"'),
				);
				return {
					all: () =>
						(table?.schemaColumns ?? table?.columns ?? []).map((c, cid) => ({
							...c,
							cid,
						})),
				};
			}
			return prepare(sql);
		};
		for (const view of value.views) {
			if (typeof view !== "string" || !view || seen.has(view))
				throw Error("derived view invalid");
			seen.add(view);
			db.exec(
				`CREATE VIEW ${quote(view)} AS SELECT * FROM "_never_query_evidence_views"`,
			);
		}
		db.pragma("query_only=ON");
		return {
			db,
			metadata: {
				observedAt: value.source.observedAt,
				sha256: value.source.sha256,
			},
		};
	} catch (error) {
		db.close();
		throw error;
	}
}
