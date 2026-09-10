import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { openEvidence } from "./qa-fly-2456-evidence.mjs";
import { foldTmuxWindows } from "./qa-fly-2456-tmux-inventory.mjs";

const text = (x) =>
	typeof x === "string" && x.length > 0 && !/[\r\n\0]/.test(x);
const fail = (reason) => ({ status: "fail", reason });
// Mirrors StateStore's operational-terminal-status.ts; approved_to_ship stays live.
const terminalStatuses = new Set([
	"completed",
	"terminated",
	"failed",
	"blocked",
	"timeout",
	"canceled",
	"cancelled",
	"rejected",
	"deferred",
	"shelved",
	"approved",
]);
function timestamp(value) {
	if (typeof value !== "string") return NaN;
	if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value))
		return Date.parse(value.replace(" ", "T") + "Z");
	if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return NaN;
	return Date.parse(value);
}
function lines(path) {
	const raw = readFileSync(path, "utf8");
	if (raw.includes("\r") || raw.includes("\0")) throw new Error("invalid text");
	return raw.endsWith("\n") ? raw.slice(0, -1).split("\n") : raw.split("\n");
}
function windowParts(line) {
	const p = line.split("|");
	if (p.length !== 3 || !p.every(text) || !/^@\d+$/.test(p[1]))
		throw new Error("window invalid");
	return p;
}
function requireSchema(db, required) {
	for (const [table, names] of Object.entries(required)) {
		if (
			!db
				.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
				.get(table)
		)
			throw new Error("table missing");
		const columns = db.prepare(`PRAGMA table_info("${table}")`).all();
		if (!names.every((name) => columns.some((c) => c.name === name)))
			throw new Error("column missing");
		for (const name of names)
			if (
				db
					.prepare(
						`SELECT 1 FROM "${table}" WHERE "${name}" IS NOT NULL AND (typeof("${name}")!='text' OR instr("${name}",char(0))>0) LIMIT 1`,
					)
					.get()
			)
				throw new Error("storage invalid");
	}
}
export function fleetIdentity({ dbPath, tmuxInventoryPath, prodSocketRoot }) {
	let db;
	try {
		if (!text(prodSocketRoot) || !isAbsolute(prodSocketRoot))
			throw new Error("socket root invalid");
		const opened = openEvidence(dbPath, "production");
		db = opened.db;
		requireSchema(db, { sessions: ["execution_id", "tmux_session", "status"] });
		const sessions = db
			.prepare(
				"SELECT execution_id,tmux_session,status FROM sessions ORDER BY execution_id",
			)
			.all();
		const windows = new Map();
		const inventory = lines(tmuxInventoryPath).map((line) => line.split("|"));
		for (const p of foldTmuxWindows(inventory, { executionMarker: true })) {
			const identity = p.slice(1).join("|");
			if (p[0] === "") continue;
			const session = sessions.find((s) => s.execution_id === p[0]);
			if (
				!session ||
				windows.has(p[0]) ||
				(session.tmux_session !== null && session.tmux_session !== p[1])
			)
				throw new Error("execution mapping invalid");
			windows.set(p[0], identity);
		}
		const entries = sessions.map((row) => {
			if (!text(row.execution_id) || !text(row.status))
				throw new Error("execution invalid");
			if (
				row.tmux_session !== null &&
				!terminalStatuses.has(row.status) &&
				!windows.has(row.execution_id)
			)
				throw new Error("live window missing");
			return {
				executionId: row.execution_id,
				socketPath: join(
					prodSocketRoot,
					`${createHash("sha1").update(row.execution_id).digest("hex").slice(0, 16)}.sock`,
				),
				windowIdentity: windows.get(row.execution_id) ?? null,
			};
		});
		return { status: "pass", entries, metadata: opened.metadata };
	} catch {
		return fail("identity_evidence_invalid");
	} finally {
		db?.close();
	}
}
function parseFleet(path, decoy) {
	const data = lines(path);
	if (data[0] !== "[codex-app-servers]") throw new Error("header missing");
	const section = data.indexOf("[tmux-windows]");
	if (section < 1) throw new Error("window header missing");
	const sockets = data.slice(1, section);
	const rawWindows = data.slice(section + 1);
	if (
		sockets.some((s) => !text(s) || !isAbsolute(s) || /\s/.test(s)) ||
		new Set(sockets).size !== sockets.length
	)
		throw new Error("socket rows invalid");
	const parsed = foldTmuxWindows(rawWindows.map(windowParts));
	const windows = parsed.map((row) => row.join("|"));
	if (parsed.filter((p) => p[2] === decoy).length !== 1)
		throw new Error("decoy missing or ambiguous");
	return [
		...sockets.map((line) => ({ kind: "socket", line })),
		...windows.map((line) => ({ kind: "window", line })),
	];
}
function readLedger(paths) {
	if (
		!Array.isArray(paths) ||
		!paths.length ||
		new Set(paths).size !== paths.length
	)
		throw new Error("ledger missing");
	return paths.flatMap((path) => {
		const raw = readFileSync(path, "utf8");
		if (raw === "") return [];
		return lines(path).map((line) => {
			const row = JSON.parse(line);
			if (
				row.schemaVersion !== 1 ||
				!Number.isFinite(timestamp(row.ts)) ||
				!["pid", "pgid", "tmux-window"].includes(row.targetKind) ||
				!["source", "signal", "reason"].every((k) => text(row[k])) ||
				(row.execId !== undefined && !text(row.execId))
			)
				throw new Error("ledger invalid");
			if (
				row.targetKind === "tmux-window"
					? !text(row.target)
					: !Number.isSafeInteger(row.target) || row.target <= 1
			)
				throw new Error("ledger target invalid");
			return row;
		});
	});
}
function targeted(row, entry) {
	if (row.execId === entry.executionId) return true;
	if (row.targetKind !== "tmux-window") return !row.execId;
	if (row.target === entry.socketPath || row.target === entry.windowIdentity)
		return true;
	if (entry.windowIdentity) {
		const [session, id, name] = windowParts(entry.windowIdentity);
		if (
			[id, `${session}:${id}`, `${session}:${name}`, `${session}:`].includes(
				row.target,
			)
		)
			return true;
	}
	return false;
}
export function fleetDiff({
	beforePath,
	afterPath,
	mode,
	declaredSockets = [],
	decoy = "fly2454-decoy",
	sidecarPath,
	dbPath,
	killLedgerPaths,
	window,
}) {
	let db;
	try {
		if (
			!["live", "post-teardown"].includes(mode) ||
			!text(decoy) ||
			!Array.isArray(declaredSockets) ||
			!declaredSockets.every((s) => text(s) && isAbsolute(s))
		)
			throw new Error("arguments invalid");
		const before = parseFleet(beforePath, decoy);
		const after = parseFleet(afterPath, decoy);
		const key = (row) => `${row.kind}:${row.line}`;
		const beforeSet = new Set(before.map(key));
		const afterSet = new Set(after.map(key));
		const added = after.filter((row) => !beforeSet.has(key(row)));
		const removed = before.filter((row) => !afterSet.has(key(row)));
		if (mode === "live")
			return {
				status:
					!removed.length &&
					added.every(
						(row) =>
							row.kind === "socket" && declaredSockets.includes(row.line),
					)
						? "pass"
						: "fail",
				added,
				removed,
			};
		if (added.length)
			return {
				status: "fail",
				reason: "post_teardown_additions",
				added,
				removed,
			};
		if (!removed.length) return { status: "pass", added, removed };
		const from = timestamp(window?.from);
		const to = timestamp(window?.to);
		if (!Number.isFinite(from) || !Number.isFinite(to) || from > to)
			throw new Error("window invalid");
		const sidecar = JSON.parse(readFileSync(sidecarPath, "utf8"));
		if (
			sidecar.status !== "pass" ||
			!Array.isArray(sidecar.entries) ||
			!sidecar.entries.every(
				(e) =>
					text(e.executionId) &&
					text(e.socketPath) &&
					isAbsolute(e.socketPath) &&
					(e.windowIdentity === null || text(e.windowIdentity)),
			)
		)
			throw new Error("sidecar invalid");
		if (
			!Number.isFinite(timestamp(sidecar.metadata?.observedAt)) ||
			timestamp(sidecar.metadata?.observedAt) > from ||
			!/^[a-f0-9]{64}$/.test(sidecar.metadata?.sha256) ||
			new Set(sidecar.entries.map((e) => e.executionId)).size !==
				sidecar.entries.length ||
			new Set(sidecar.entries.map((e) => e.socketPath)).size !==
				sidecar.entries.length
		)
			throw new Error("sidecar identity invalid");
		const identityWindows = sidecar.entries
			.filter((e) => e.windowIdentity !== null)
			.map((e) => {
				windowParts(e.windowIdentity);
				return e.windowIdentity;
			});
		if (new Set(identityWindows).size !== identityWindows.length)
			throw new Error("sidecar windows ambiguous");
		const ledger = readLedger(killLedgerPaths).filter(
			(row) => timestamp(row.ts) >= from && timestamp(row.ts) <= to,
		);
		const opened = openEvidence(dbPath, "production");
		db = opened.db;
		if (timestamp(opened.metadata.observedAt) < to)
			throw new Error("after snapshot too early");
		requireSchema(db, {
			sessions: ["execution_id", "status", "terminal_at"],
			session_events: ["execution_id", "event_type", "ts"],
		});
		const attributions = [];
		for (const row of removed) {
			const matches = sidecar.entries.filter(
				(e) =>
					(row.kind === "socket" ? e.socketPath : e.windowIdentity) ===
					row.line,
			);
			if (matches.length !== 1) throw new Error("mapping ambiguous");
			const entry = matches[0];
			if (ledger.some((event) => targeted(event, entry)))
				throw new Error("kill target not excluded");
			const session = db
				.prepare("SELECT status,terminal_at FROM sessions WHERE execution_id=?")
				.get(entry.executionId);
			if (!session) throw new Error("session missing");
			const terminalAt = timestamp(session.terminal_at);
			let evidence =
				["completed", "failed", "terminated", "cancelled"].includes(
					session.status,
				) &&
				terminalAt >= from &&
				terminalAt <= to
					? { source: "sessions.terminal_at", at: session.terminal_at }
					: null;
			if (!evidence) {
				const event = db
					.prepare(
						"SELECT event_type,ts FROM session_events WHERE execution_id=? AND event_type IN ('session_completed','session_failed') ORDER BY id",
					)
					.all(entry.executionId)
					.find((e) => timestamp(e.ts) >= from && timestamp(e.ts) <= to);
				if (event) evidence = { source: "session_events", ...event };
			}
			if (!evidence) throw new Error("terminal evidence missing");
			attributions.push({
				...row,
				executionId: entry.executionId,
				terminalEvidence: evidence,
			});
		}
		return { status: "needs-attribution", added, removed, attributions };
	} catch {
		return fail("fleet_evidence_invalid");
	} finally {
		db?.close();
	}
}
