#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function normalizeName(value) {
	return String(value).replace(/^['"`[]|['"`\]]$/g, "");
}

function consumerKey(consumer) {
	return `${consumer.file}:${consumer.relation}:${consumer.baseTable}:${consumer.usage}`;
}

function runtimeSourcePath(path) {
	if (!/\.(?:ts|tsx|js|mjs)$/.test(path)) return false;
	if (
		path.includes("/__tests__/") ||
		path.includes("/dist/") ||
		/\.(?:test|spec)\.[^.]+$/.test(path)
	)
		return false;
	if (/^packages\/[^/]+\/src\//.test(path)) return true;
	if (!path.startsWith("scripts/")) return false;
	return !new Set([
		"scripts/fly-1998-database-retention-sweep.mjs",
		"scripts/fly-2006-retention-consumer-gate.mjs",
	]).has(path);
}

function visitFiles(root, path, result) {
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const absolute = join(path, entry.name);
		if (entry.isDirectory()) {
			if (
				new Set([".git", "node_modules", "dist", "__tests__"]).has(entry.name)
			)
				continue;
			visitFiles(root, absolute, result);
		} else if (entry.isFile()) {
			const repoPath = relative(root, absolute).replaceAll("\\", "/");
			if (runtimeSourcePath(repoPath))
				result.set(repoPath, readFileSync(absolute, "utf8"));
		}
	}
}

export function collectProductionSources(repoRoot) {
	const result = new Map();
	for (const child of ["packages", "scripts"]) {
		const root = join(repoRoot, child);
		try {
			visitFiles(repoRoot, root, result);
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
		}
	}
	return new Map(
		[...result].sort(([left], [right]) => left.localeCompare(right)),
	);
}

function errorKey(consumer) {
	return `${consumer.file}:${consumer.baseTable}:${consumer.usage}`;
}

function viewDefinitions(files) {
	const views = new Map();
	const viewPattern =
		/\bCREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([A-Za-z_][A-Za-z0-9_]*)["`\]]?\s+AS\s+([\s\S]*?)(?:;|`)/gi;
	for (const source of files.values()) {
		for (const match of source.matchAll(viewPattern)) {
			const relation = match[2]?.match(
				/\b(?:FROM|JOIN)\s+["`[]?([A-Za-z_][A-Za-z0-9_]*)["`\]]?/i,
			)?.[1];
			if (relation) views.set(normalizeName(match[1]), normalizeName(relation));
		}
	}
	return views;
}

function withoutViewDefinitions(source) {
	return source.replace(
		/\bCREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?[A-Za-z_][A-Za-z0-9_]*["`\]]?\s+AS\s+[\s\S]*?(?:;|`)/gi,
		"",
	);
}

function resolveBaseTable(relation, views) {
	const seen = new Set();
	let current = relation;
	while (views.has(current)) {
		if (seen.has(current)) throw new Error(`retention_view_cycle:${current}`);
		seen.add(current);
		current = views.get(current);
	}
	return current;
}

function relationUsage(source, offset) {
	const prefix = source.slice(Math.max(0, offset - 500), offset);
	const lastNotExists = Math.max(
		prefix.lastIndexOf("NOT EXISTS"),
		prefix.lastIndexOf("not exists"),
	);
	if (lastNotExists < 0) return "read";
	const tail = prefix.slice(lastNotExists);
	let depth = 0;
	for (const char of tail) {
		if (char === "(") depth += 1;
		if (char === ")") depth -= 1;
	}
	return depth > 0 ? "anti_join" : "read";
}

export function scanRetentionConsumers({ files, targetTables }) {
	if (!(files instanceof Map)) throw new Error("consumer_files_map_required");
	const targets = new Set(targetTables);
	const views = viewDefinitions(files);
	const consumers = new Map();
	const relationPattern =
		/\b(?:FROM|JOIN)\s+["`[]?([A-Za-z_][A-Za-z0-9_]*)["`\]]?/gi;
	for (const [file, rawSource] of [...files].sort(([a], [b]) =>
		a.localeCompare(b),
	)) {
		const source = withoutViewDefinitions(rawSource);
		for (const match of source.matchAll(relationPattern)) {
			const relation = normalizeName(match[1]);
			const baseTable = resolveBaseTable(relation, views);
			if (!targets.has(baseTable)) continue;
			const consumer = {
				file,
				relation,
				baseTable,
				usage: relationUsage(source, match.index),
			};
			consumers.set(consumerKey(consumer), consumer);
		}
	}
	return [...consumers.values()].sort((left, right) =>
		consumerKey(left).localeCompare(consumerKey(right)),
	);
}

export function auditRetentionConsumers({ consumers, config }) {
	if (config?.version !== 1 || !Array.isArray(config.consumers)) {
		throw new Error("retention_consumer_config_invalid");
	}
	const actual = new Map(consumers.map((item) => [consumerKey(item), item]));
	const expected = new Map(
		config.consumers.map((item) => [consumerKey(item), item]),
	);
	const errors = [];
	for (const [key, consumer] of actual) {
		const classified = expected.get(key);
		if (!classified) {
			errors.push(`unclassified_retention_consumer:${errorKey(consumer)}`);
			continue;
		}
		if (
			!new Set(["protect", "candidate_guarded"]).has(classified.disposition)
		) {
			errors.push(`invalid_retention_disposition:${errorKey(consumer)}`);
		}
	}
	for (const [key, consumer] of expected) {
		if (!actual.has(key))
			errors.push(`stale_retention_consumer:${errorKey(consumer)}`);
	}
	return { ok: errors.length === 0, errors: errors.sort(), consumers };
}

function runCli() {
	const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
	const configPath = resolve(
		process.argv[2] ??
			join(repoRoot, "scripts/fly-2006-retention-consumer-gate.config.json"),
	);
	const config = JSON.parse(readFileSync(configPath, "utf8"));
	if (!Array.isArray(config.targetTables))
		throw new Error("retention_target_tables_required");
	const files = collectProductionSources(repoRoot);
	const consumers = scanRetentionConsumers({
		files,
		targetTables: config.targetTables,
	});
	const result = auditRetentionConsumers({ consumers, config });
	process.stdout.write(`${JSON.stringify(result)}\n`);
	if (!result.ok) process.exitCode = 1;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) runCli();
