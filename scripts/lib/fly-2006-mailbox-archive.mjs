import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

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

function assertUtcIsoTimestamp(value) {
	if (
		typeof value !== "string" ||
		!value.endsWith("Z") ||
		!Number.isFinite(Date.parse(value))
	)
		throw new Error("now must be a valid UTC ISO timestamp");
}

function validContentRef(path) {
	const resolved = resolve(path);
	return basename(dirname(resolved)) === "refs" && resolved.endsWith(".txt");
}

function getById(db, id) {
	return db.prepare("SELECT * FROM mailbox WHERE id = ?").get(id);
}

function familyRootId(db, row) {
	if (
		row.type === "response" &&
		row.ref_id &&
		db
			.prepare("SELECT 1 FROM mailbox WHERE id = ? AND type = 'question'")
			.get(row.ref_id)
	)
		return row.ref_id;
	return row.id;
}

function loadFamily(db, rootId) {
	const root = getById(db, rootId);
	if (!root) return [];
	if (root.type !== "question") return [root];
	return db
		.prepare(
			"SELECT * FROM mailbox WHERE id = ? OR (type = 'response' AND ref_id = ?) ORDER BY seq",
		)
		.all(rootId, rootId);
}

export function archiveMailboxFamily({
	db,
	id,
	now,
	retentionMs = 72 * 60 * 60_000,
	maxFamilyBytes = 2 * 1024 * 1024,
}) {
	assertUtcIsoTimestamp(now);
	if (!Number.isSafeInteger(retentionMs) || retentionMs < 0)
		throw new Error("retentionMs must be a non-negative safe integer");
	const member = getById(db, id);
	if (!member) {
		const identity = db
			.prepare("SELECT archived_at FROM mailbox_identity WHERE id = ?")
			.get(id);
		if (identity?.archived_at) return "idempotent";
		throw new Error(`mailbox row not found: ${id}`);
	}
	const rootId = familyRootId(db, member);
	const rows = loadFamily(db, rootId);
	if (
		rows.length === 0 ||
		rows.some((row) => row.state !== "ACKED" && row.state !== "DEAD")
	)
		return "not_due";
	const question = rows.find(
		(row) => row.id === rootId && row.type === "question",
	);
	if (
		question &&
		question.relay_state !== "terminal_disposed" &&
		!rows.some((row) => row.type === "response" && row.ref_id === rootId)
	)
		return "not_due";
	const terminalTimes = rows.map((row) =>
		Date.parse(
			row.state === "ACKED" ? (row.acked_at ?? "") : (row.dead_at ?? ""),
		),
	);
	if (
		terminalTimes.some((value) => !Number.isFinite(value)) ||
		Math.max(...terminalTimes) + retentionMs > Date.parse(now)
	)
		return "not_due";

	const snapshots = [];
	let familyBytes = 0;
	for (const row of rows) {
		let contentRefArchive;
		if (row.content_ref) {
			if (!validContentRef(row.content_ref)) return "invalid_content_ref";
			let bytes;
			try {
				bytes = readFileSync(row.content_ref);
			} catch {
				return "invalid_content_ref";
			}
			contentRefArchive = {
				path: row.content_ref,
				bytes: bytes.length,
				sha256: sha256(bytes),
				content_base64: bytes.toString("base64"),
			};
		}
		const rowJson = canonicalJsonString({
			...row,
			...(contentRefArchive ? { content_ref_archive: contentRefArchive } : {}),
		});
		familyBytes += Buffer.byteLength(rowJson);
		snapshots.push({
			row,
			rowJson,
			...(contentRefArchive
				? {
						ref: {
							path: contentRefArchive.path,
							hash: contentRefArchive.sha256,
						},
					}
				: {}),
		});
	}
	if (familyBytes > maxFamilyBytes) return "oversized";

	return db
		.transaction(() => {
			const liveRows = loadFamily(db, rootId);
			if (canonicalJsonString(liveRows) !== canonicalJsonString(rows))
				return "not_due";
			for (const snapshot of snapshots) {
				db.prepare(
					"INSERT INTO mailbox_log (event_id, message_id, subject_id, event, at, row_json) VALUES (?, ?, ?, 'archived', ?, ?)",
				).run(
					`archived:${snapshot.row.id}`,
					snapshot.row.id,
					rootId,
					now,
					snapshot.rowJson,
				);
				if (snapshot.ref) {
					db.prepare(
						`INSERT INTO content_ref_gc_outbox
						 (intent_id, message_id, path, content_hash, created_at)
						 VALUES (?, ?, ?, ?, ?)`,
					).run(
						`gc:${snapshot.row.id}`,
						snapshot.row.id,
						snapshot.ref.path,
						snapshot.ref.hash,
						now,
					);
				}
				if (
					db
						.prepare(
							"UPDATE mailbox_identity SET archived_at = ? WHERE id = ? AND archived_at IS NULL",
						)
						.run(now, snapshot.row.id).changes !== 1
				)
					throw new Error(
						`mailbox identity archive conflict: ${snapshot.row.id}`,
					);
				db.prepare("DELETE FROM mailbox WHERE id = ?").run(snapshot.row.id);
			}
			return "archived";
		})
		.immediate();
}
