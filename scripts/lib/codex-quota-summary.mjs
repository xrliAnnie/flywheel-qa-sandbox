#!/usr/bin/env node
// Read only the public audit projection. Never inspect auth or account files.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const safe = (value) =>
	typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
function summary(stateRoot) {
	const path = join(stateRoot, "codex-quota", "switch-audit.jsonl");
	let source;
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024)
			return "CODEX_SWITCH unavailable";
		source = readFileSync(path, "utf8");
	} catch (error) {
		return error.code === "ENOENT"
			? "CODEX_SWITCH none"
			: "CODEX_SWITCH unavailable";
	}
	// Writers append newline-terminated records. A torn final append is not a
	// complete record and cannot replace a previously observed successful switch.
	const lines = source.split("\n");
	if (lines.at(-1) !== "") lines.pop();
	const latest = new Map();
	const seen = new Map();
	for (const line of lines) {
		if (!line) continue;
		let row;
		try {
			row = JSON.parse(line);
		} catch {
			return "CODEX_SWITCH unavailable";
		}
		if (
			row?.schemaVersion !== 1 ||
			row.vendor !== "codex" ||
			!safe(row.switchId) ||
			!safe(row.incidentId) ||
			!safe(row.from) ||
			!safe(row.to) ||
			!safe(row.reason) ||
			!safe(row.probeResult) ||
			typeof row.committed !== "boolean" ||
			!count(row.generation) ||
			!count(row.recoveredCount) ||
			!count(row.targetCount) ||
			row.recoveredCount > row.targetCount ||
			typeof row.at !== "string" ||
			!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(row.at) ||
			!Number.isFinite(Date.parse(row.at))
		)
			return "CODEX_SWITCH unavailable";
		const canonical = JSON.stringify(row);
		if (seen.has(row.switchId) && seen.get(row.switchId) !== canonical)
			return "CODEX_SWITCH unavailable";
		seen.set(row.switchId, canonical);
		const prior = latest.get(row.committed);
		if (!prior || Date.parse(prior.at) <= Date.parse(row.at))
			latest.set(row.committed, row);
	}
	const rows = [...latest.values()].sort(
		(a, b) => Date.parse(a.at) - Date.parse(b.at),
	);
	return rows.length
		? rows
				.map(
					(row) =>
						`CODEX_SWITCH at=${row.at} from=${row.from} to=${row.to} reason=${row.reason} probe=${row.probeResult} committed=${row.committed} generation=${row.generation} recovered=${row.recoveredCount}/${row.targetCount}`,
				)
				.join("\n")
		: source.trim()
			? "CODEX_SWITCH unavailable"
			: "CODEX_SWITCH none";
}
// FLY-2900: the Bridge projects quota standby counts every maintenance tick.
// A missing, stale or malformed projection is reported as unavailable — never 0.
const STANDBY_STALE_MS = 15 * 60_000;
function standby(stateRoot, nowMs = Date.now()) {
	const path = join(stateRoot, "codex-quota", "standby-summary.json");
	let row;
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024)
			return "CODEX_STANDBY unavailable reason=invalid";
		row = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		return error?.code === "ENOENT"
			? "CODEX_STANDBY unavailable reason=missing"
			: "CODEX_STANDBY unavailable reason=invalid";
	}
	const generated =
		typeof row?.generatedAt === "string" ? Date.parse(row.generatedAt) : NaN;
	if (
		row?.schemaVersion !== 1 ||
		!Number.isFinite(generated) ||
		!count(row.count) ||
		!(row.oldestMinutes === null || count(row.oldestMinutes)) ||
		!count(row.resumed24h) ||
		!count(row.fallback24hCodex) ||
		!count(row.fallback24hClaude)
	)
		return "CODEX_STANDBY unavailable reason=invalid";
	if (nowMs - generated > STANDBY_STALE_MS)
		return "CODEX_STANDBY unavailable reason=stale";
	return `CODEX_STANDBY count=${row.count} oldest=${row.oldestMinutes === null ? "-" : `${row.oldestMinutes}m`} resumed_24h=${row.resumed24h} fallback_24h=${row.fallback24hCodex}/${row.fallback24hClaude}`;
}
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--state-root" || !args[1]) {
	console.log("CODEX_SWITCH unavailable");
	process.exitCode = 2;
} else console.log(`${summary(args[1])}\n${standby(args[1])}`);
