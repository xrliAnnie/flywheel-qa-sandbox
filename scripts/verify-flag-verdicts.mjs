#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const requireFromTeamlead = createRequire(
	new URL("../packages/teamlead/package.json", import.meta.url),
);

function parseArgs(argv) {
	const options = { preflight: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--preflight") options.preflight = true;
		else if (arg === "--verdicts") options.verdicts = argv[++index];
		else if (arg === "--db") options.db = argv[++index];
		else if (arg === "--registry") options.registry = argv[++index];
		else throw new Error(`unknown argument: ${arg}`);
	}
	if (!options.verdicts) throw new Error("--verdicts is required");
	if (options.preflight && !options.db) {
		throw new Error("--db is required with --preflight");
	}
	return options;
}

function digest(value) {
	return createHash("sha256").update(value).digest("hex");
}

function loadVerdicts(path) {
	const parsed = JSON.parse(readFileSync(path, "utf8"));
	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new Error("verdict file must be a non-empty array");
	}
	const seen = new Set();
	for (const [index, row] of parsed.entries()) {
		if (!row || typeof row !== "object" || Array.isArray(row)) {
			throw new Error(`verdict[${index}] must be an object`);
		}
		for (const field of [
			"flag",
			"verdict",
			"runToken",
			"decidedAt",
			"canonicalDigest",
		]) {
			if (typeof row[field] !== "string" || row[field].trim() === "") {
				throw new Error(`verdict[${index}].${field} must be non-empty`);
			}
		}
		if (!/^[a-z0-9_]+$/.test(row.flag)) {
			throw new Error(`verdict[${index}].flag is invalid`);
		}
		if (seen.has(row.flag)) throw new Error(`duplicate verdict: ${row.flag}`);
		seen.add(row.flag);
		if (!/^(keep|clear)$/.test(row.verdict)) {
			throw new Error(`verdict[${index}].verdict must be keep or clear`);
		}
		if (!/^\d{4}-\d{2}-\d{2}$/.test(row.decidedAt)) {
			throw new Error(`verdict[${index}].decidedAt must be YYYY-MM-DD`);
		}
		if (!/^[a-f0-9]{64}$/.test(row.canonicalDigest)) {
			throw new Error(`verdict[${index}].canonicalDigest must be SHA-256`);
		}
		if (row.verdict === "keep" && (!row.reason || !String(row.reason).trim())) {
			throw new Error(`keep verdict ${row.flag} requires reason`);
		}
		if (
			row.verdict === "clear" &&
			!/^((FLY|GEO)-\d+)$/.test(String(row.execIssue ?? ""))
		) {
			throw new Error(`clear verdict ${row.flag} requires execIssue`);
		}
	}
	return parsed;
}

function registryObjects(source) {
	const arrayAt = source.indexOf("FEATURE_FLAGS");
	const opening = source.indexOf("[", arrayAt);
	if (arrayAt < 0 || opening < 0)
		throw new Error("FEATURE_FLAGS array not found");
	const objects = new Map();
	let quote = null;
	let escaped = false;
	let lineComment = false;
	let blockComment = false;
	let depth = 0;
	let objectStart = -1;
	for (let index = opening + 1; index < source.length; index += 1) {
		const char = source[index];
		const next = source[index + 1];
		if (lineComment) {
			if (char === "\n") lineComment = false;
			continue;
		}
		if (blockComment) {
			if (char === "*" && next === "/") {
				blockComment = false;
				index += 1;
			}
			continue;
		}
		if (quote) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === "/" && next === "/") {
			lineComment = true;
			index += 1;
			continue;
		}
		if (char === "/" && next === "*") {
			blockComment = true;
			index += 1;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			continue;
		}
		if (char === "{") {
			if (depth === 0) objectStart = index;
			depth += 1;
		} else if (char === "}") {
			depth -= 1;
			if (depth === 0 && objectStart >= 0) {
				const object = source.slice(objectStart, index + 1);
				const name = /\bname\s*:\s*["']([a-z0-9_]+)["']/.exec(object)?.[1];
				if (name) objects.set(name, object);
				objectStart = -1;
			}
		} else if (char === "]" && depth === 0) break;
	}
	return objects;
}

function preflight(options, verdicts) {
	const dbPath = resolve(options.db);
	const Database = requireFromTeamlead("better-sqlite3");
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		for (const row of verdicts) {
			const frozen = db
				.prepare(
					`SELECT i.canonical, i.bucket
					   FROM flag_scan_run_items i
					   JOIN flag_scan_runs r ON r.run_id = i.run_id
					  WHERE r.run_token = ? AND i.flag_name = ?`,
				)
				.get(row.runToken, row.flag);
			if (!frozen) throw new Error(`${row.flag}: frozen candidate not found`);
			if (!["candidate", "orphan_candidate"].includes(frozen.bucket)) {
				throw new Error(`${row.flag}: frozen row is not a candidate`);
			}
			if (typeof frozen.canonical !== "string" || frozen.canonical === "") {
				throw new Error(`${row.flag}: frozen canonical value is empty`);
			}
			if (digest(frozen.canonical) !== row.canonicalDigest) {
				throw new Error(`${row.flag}: canonicalDigest mismatch`);
			}
			console.log(
				`EVIDENCE ${row.flag} run=${row.runToken} bucket=${frozen.bucket} digest=${row.canonicalDigest}`,
			);
		}
	} finally {
		db.close();
	}
}

function verifyRegistry(options, verdicts) {
	const registryPath = resolve(
		options.registry ?? "packages/config/src/feature-flags/registry.ts",
	);
	const bytes = readFileSync(registryPath);
	const before = digest(bytes);
	const objects = registryObjects(bytes.toString("utf8"));
	for (const [flag, object] of objects) {
		const hasKeep = /\blongTermKeep\s*:\s*true\b/.test(object);
		const hasKeepReason = /\bkeepReason\s*:/.test(object);
		const retiring = /\bretiring\s*:\s*["']([^"']*)["']/.exec(object)?.[1];
		if (hasKeep && retiring) {
			throw new Error(
				`${flag}: longTermKeep and retiring are mutually exclusive`,
			);
		}
		if (hasKeepReason && !hasKeep) {
			throw new Error(`${flag}: keepReason requires longTermKeep: true`);
		}
		if (retiring !== undefined && !/^(FLY|GEO)-\d+$/.test(retiring)) {
			throw new Error(`${flag}: retiring must be a bare FLY/GEO issue id`);
		}
	}
	for (const row of verdicts) {
		const object = objects.get(row.flag);
		if (!object) throw new Error(`${row.flag}: registry entry not found`);
		const hasKeep = /\blongTermKeep\s*:\s*true\b/.test(object);
		const keepReason = /\bkeepReason\s*:\s*["']([^"']+)["']/.exec(object)?.[1];
		const retiring = /\bretiring\s*:\s*["']([^"']+)["']/.exec(object)?.[1];
		if (row.verdict === "keep") {
			if (!hasKeep || retiring) {
				throw new Error(
					`${row.flag}: keep must set longTermKeep and remove retiring`,
				);
			}
			const prefix = `${row.decidedAt} [flag-scan:${row.runToken}]:`;
			if (!keepReason?.startsWith(prefix) || !keepReason.includes(row.reason)) {
				throw new Error(`${row.flag}: keepReason binding/reason mismatch`);
			}
		} else if (retiring !== row.execIssue || hasKeep || keepReason) {
			throw new Error(
				`${row.flag}: clear must set retiring=execIssue and remove keep fields`,
			);
		}
	}
	if (digest(readFileSync(registryPath)) !== before) {
		throw new Error("verifier modified registry.ts");
	}
}

try {
	const options = parseArgs(process.argv.slice(2));
	const verdicts = loadVerdicts(resolve(options.verdicts));
	if (options.preflight) preflight(options, verdicts);
	else verifyRegistry(options, verdicts);
	console.log(
		`PASS: verified ${verdicts.length} flag verdict(s) (${options.preflight ? "preflight" : "registry"})`,
	);
} catch (error) {
	console.error(
		`FAIL: ${error instanceof Error ? error.message : String(error)}`,
	);
	process.exitCode = 1;
}
