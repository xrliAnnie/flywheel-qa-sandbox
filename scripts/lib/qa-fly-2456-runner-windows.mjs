import { readFileSync } from "node:fs";
import { openEvidence } from "./qa-fly-2456-evidence.mjs";

const time = (value) =>
	typeof value === "string"
		? Date.parse(
				/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)
					? `${value.replace(" ", "T")}Z`
					: /(Z|[+-]\d\d:\d\d)$/.test(value)
						? value
						: "invalid",
			)
		: NaN;
function count(path) {
	const raw = readFileSync(path, "utf8");
	if (!/^\d+\n?$/.test(raw) || !Number.isSafeInteger(Number(raw)))
		throw new Error("count invalid");
	return Number(raw);
}
function identities(path, expected, bound, before) {
	const data = JSON.parse(readFileSync(path, "utf8")),
		at = time(data.metadata?.observedAt);
	if (
		data.status !== "pass" ||
		!Array.isArray(data.entries) ||
		!Number.isFinite(at) ||
		(before ? at > bound : at < bound) ||
		!/^[a-f0-9]{64}$/.test(data.metadata?.sha256)
	)
		throw new Error("sidecar provenance invalid");
	const entries = data.entries.filter((row) => row.windowIdentity !== null);
	if (
		entries.some(
			(row) =>
				typeof row.executionId !== "string" ||
				!row.executionId ||
				typeof row.windowIdentity !== "string" ||
				!/^([^|]+)\|@\d+\|([^|]+)$/.test(row.windowIdentity),
		) ||
		new Set(entries.map((row) => row.windowIdentity)).size !== entries.length ||
		new Set(entries.map((row) => row.executionId)).size !== entries.length
	)
		throw new Error("window identity ambiguous");
	const selected = entries.filter((row) =>
		row.windowIdentity.includes("runner-flywheel"),
	);
	if (selected.length !== expected) throw new Error("count identity mismatch");
	return new Map(selected.map((row) => [row.windowIdentity, row]));
}
export function runnerWindows({
	beforePath,
	afterPath,
	beforeIdentityPath,
	afterIdentityPath,
	dbPath,
	window,
}) {
	let db;
	try {
		const before = count(beforePath),
			after = count(afterPath);
		if (before === after)
			return { status: "pass", before, after, explanations: [] };
		const from = time(window?.from),
			to = time(window?.to);
		if (!Number.isFinite(from) || !Number.isFinite(to) || from > to)
			throw new Error("window invalid");
		const left = identities(beforeIdentityPath, before, from, true),
			right = identities(afterIdentityPath, after, to, false);
		const changes = [
			...[...left]
				.filter(([key]) => !right.has(key))
				.map(([, row]) => ({ ...row, change: "removed" })),
			...[...right]
				.filter(([key]) => !left.has(key))
				.map(([, row]) => ({ ...row, change: "added" })),
		];
		const opened = openEvidence(dbPath, "production");
		db = opened.db;
		if (time(opened.metadata.observedAt) < to)
			throw new Error("snapshot too early");
		for (const [table, columns] of Object.entries({
			sessions: [
				"execution_id",
				"issue_id",
				"project_name",
				"status",
				"terminal_at",
			],
			session_events: [
				"event_id",
				"execution_id",
				"issue_id",
				"project_name",
				"event_type",
				"ts",
				"source",
			],
		})) {
			if (
				!db
					.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
					.get(table)
			)
				throw new Error("production table missing");
			const actual = db.prepare(`PRAGMA table_info("${table}")`).all();
			for (const column of columns) {
				if (
					!actual.some((c) => c.name === column) ||
					db
						.prepare(
							`SELECT 1 FROM "${table}" WHERE "${column}" IS NOT NULL AND (typeof("${column}")!='text' OR instr("${column}",char(0))>0) LIMIT 1`,
						)
						.get()
				)
					throw new Error("production column invalid");
			}
		}
		const query = db.prepare(
			"SELECT id,event_type,execution_id,ts FROM session_events WHERE execution_id=? ORDER BY id",
		);
		const explanations = changes.map((change) => {
			if (
				!db
					.prepare("SELECT execution_id FROM sessions WHERE execution_id=?")
					.get(change.executionId)
			)
				throw new Error("session missing");
			const types =
				change.change === "added"
					? ["session_started"]
					: ["session_completed", "session_failed"];
			const events = query
				.all(change.executionId)
				.filter(
					(e) =>
						types.includes(e.event_type) &&
						time(e.ts) >= from &&
						time(e.ts) <= to,
				);
			if (!events.length)
				throw new Error("production event explanation missing");
			return { ...change, event: events[0] };
		});
		if (!explanations.length) throw new Error("unexplained count mismatch");
		return { status: "pass", before, after, explanations };
	} catch (error) {
		return { status: "fail", reason: error.message };
	} finally {
		db?.close();
	}
}
