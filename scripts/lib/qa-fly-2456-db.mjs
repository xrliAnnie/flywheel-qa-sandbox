import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(
	new URL("../../packages/flywheel-comm/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
export function openSnapshot(path, { after, now = Date.now(), maxAgeMs } = {}) {
	const metadata = JSON.parse(readFileSync(`${path}.meta.json`, "utf8"));
	const observed =
		typeof metadata.observedAt === "string"
			? Date.parse(metadata.observedAt)
			: NaN;
	const current = typeof now === "number" ? now : Date.parse(now);
	if (
		!Number.isFinite(observed) ||
		!Number.isFinite(current) ||
		observed > current
	)
		throw new Error("snapshot freshness invalid");
	if (
		after !== undefined &&
		(!Number.isFinite(Date.parse(after)) || observed <= Date.parse(after))
	)
		throw new Error("snapshot precedes intent");
	if (
		maxAgeMs !== undefined &&
		(!Number.isFinite(maxAgeMs) ||
			maxAgeMs < 0 ||
			current - observed > maxAgeMs)
	)
		throw new Error("snapshot stale");
	if (existsSync(`${path}-wal`) || existsSync(`${path}-shm`))
		throw new Error("snapshot sidecar");
	const bytes = readFileSync(path);
	if (
		!/^[a-f0-9]{64}$/.test(metadata.sha256) ||
		createHash("sha256").update(bytes).digest("hex") !== metadata.sha256
	)
		throw new Error("snapshot hash invalid");
	// SQLite's memdb VFS cannot open WAL-mode headers. Normalize only the
	// hash-verified in-memory copy; the immutable snapshot stays unchanged.
	bytes[18] = bytes[19] = 0x01;
	const db = new Database(bytes, { readonly: true, fileMustExist: true });
	return { db, metadata };
}
// Keep the authoritative CommDB.getOpenGatesByRunner predicates verbatim.
export function openGates(db, executionId) {
	if (
		!db
			.prepare(
				"SELECT 1 FROM sqlite_master WHERE name='mailbox' AND type='table'",
			)
			.get() ||
		!db
			.prepare(
				"SELECT 1 FROM sqlite_master WHERE name='mailbox_message_projection' AND type='view'",
			)
			.get()
	)
		throw new Error("gate schema invalid");
	const columns = [
		"id",
		"from_agent",
		"to_agent",
		"type",
		"content",
		"checkpoint",
		"relay_state",
		"superseded_at",
		"ref_id",
		"created_at",
	];
	const actual = db.prepare("PRAGMA table_info(mailbox)").all();
	if (
		!columns.every((name) =>
			actual.some((c) => c.name === name && /TEXT/i.test(c.type)),
		)
	)
		throw new Error("gate schema invalid");
	for (const column of columns) {
		if (
			db
				.prepare(
					`SELECT 1 FROM mailbox WHERE "${column}" IS NOT NULL AND (typeof("${column}")!='text' OR instr("${column}",char(0))>0) LIMIT 1`,
				)
				.get()
		)
			throw new Error("gate text storage invalid");
	}

	return db
		.prepare(`SELECT q.* FROM mailbox_message_projection q
 WHERE q.from_agent = ? AND q.type = 'question'
   AND q.checkpoint IS NOT NULL
   AND q.relay_state != 'terminal_disposed'
   AND q.superseded_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM mailbox_message_projection response
      WHERE response.parent_id = q.id AND response.type = 'response'
   )
 ORDER BY q.created_at ASC, q.id ASC`)
		.all(executionId);
}
