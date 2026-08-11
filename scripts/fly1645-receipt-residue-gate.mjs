#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_MAIN_ROOT = resolve(SCRIPT_PATH, "../..");
const DEFAULT_CONFIG_PATH = resolve(
	DEFAULT_MAIN_ROOT,
	"scripts/fly1645-receipt-residue-gate.config.json",
);

function normalizedRelative(root, path) {
	return relative(root, path).split("\\").join("/");
}

function readConfig(path) {
	const config = JSON.parse(readFileSync(path, "utf8"));
	if (config.version !== 1) {
		throw new Error(
			`unsupported residue-gate config version: ${config.version}`,
		);
	}
	return config;
}

function walkFiles(root) {
	if (!existsSync(root)) throw new Error(`scan root does not exist: ${root}`);
	const files = [];
	const visit = (path) => {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const child = join(path, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === ".git" || entry.name === "node_modules") continue;
				visit(child);
			} else if (entry.isFile()) {
				files.push(child);
			}
		}
	};
	visit(root);
	return files;
}

function repositoryFiles(root, scope) {
	const files = [];
	for (const includeRoot of scope.includeRoots) {
		const absolute = resolve(root, includeRoot);
		for (const path of walkFiles(absolute)) {
			const relativePath = normalizedRelative(root, path);
			const framedPath = `/${relativePath}`;
			if (!scope.extensions.includes(extname(path))) continue;
			if (
				scope.excludeFragments.some((fragment) => framedPath.includes(fragment))
			) {
				continue;
			}
			files.push({ path, relativePath });
		}
	}
	return files.sort((left, right) =>
		left.relativePath.localeCompare(right.relativePath),
	);
}

function allowedMatch(rule, repo, relativePath, line) {
	return (rule.allows ?? []).some((allow) => {
		if (allow.repo !== repo || allow.path !== relativePath) return false;
		return new RegExp(allow.linePattern).test(line.trim());
	});
}

export function scanReceiptResidue({ mainRoot, pluginRoot, config }) {
	const roots = {
		main: resolve(mainRoot),
		plugin: resolve(pluginRoot),
	};
	const source = {};
	for (const [repo, root] of Object.entries(roots)) {
		source[repo] = repositoryFiles(root, config.repositories[repo]).map(
			(file) => ({
				...file,
				lines: readFileSync(file.path, "utf8").split(/\r?\n/),
			}),
		);
	}

	const violations = [];
	const allowedCounts = new Map();
	for (const rule of config.deniedSymbols) {
		for (const repo of rule.repos ?? Object.keys(roots)) {
			for (const file of source[repo]) {
				file.lines.forEach((line, index) => {
					if (!line.includes(rule.pattern)) return;
					if (allowedMatch(rule, repo, file.relativePath, line)) {
						allowedCounts.set(rule.id, (allowedCounts.get(rule.id) ?? 0) + 1);
						return;
					}
					violations.push({
						kind: "denied_symbol",
						rule: rule.id,
						repo,
						path: file.relativePath,
						line: index + 1,
						text: line.trim(),
					});
				});
			}
		}
		if (
			rule.expectedAllowedMatches !== undefined &&
			(allowedCounts.get(rule.id) ?? 0) !== rule.expectedAllowedMatches
		) {
			violations.push({
				kind: "allowlist_cardinality",
				rule: rule.id,
				expected: rule.expectedAllowedMatches,
				actual: allowedCounts.get(rule.id) ?? 0,
			});
		}
	}

	const relayAllowed = new Set(config.relayStateAllowedFiles);
	for (const [repo, files] of Object.entries(source)) {
		for (const file of files) {
			file.lines.forEach((line, index) => {
				if (!line.includes("relay_state")) return;
				if (repo === "main" && relayAllowed.has(file.relativePath)) return;
				violations.push({
					kind: "relay_state_outside_question_domain",
					repo,
					path: file.relativePath,
					line: index + 1,
					text: line.trim(),
				});
			});
		}
	}

	return {
		ok: violations.length === 0,
		scannedFiles: Object.fromEntries(
			Object.entries(source).map(([repo, files]) => [repo, files.length]),
		),
		allowedMatches: Object.fromEntries(allowedCounts),
		violations,
	};
}

function parseArgs(argv) {
	const args = {
		mainRoot: DEFAULT_MAIN_ROOT,
		pluginRoot: process.env.FLYWHEEL_DISCORD_PLUGIN_REPO,
		configPath: DEFAULT_CONFIG_PATH,
		json: false,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--json") {
			args.json = true;
			continue;
		}
		const next = argv[index + 1];
		if (!next) throw new Error(`${arg} requires a value`);
		if (arg === "--main-root") args.mainRoot = next;
		else if (arg === "--plugin-root") args.pluginRoot = next;
		else if (arg === "--config") args.configPath = next;
		else throw new Error(`unknown argument: ${arg}`);
		index += 1;
	}
	if (!args.pluginRoot) {
		throw new Error(
			"--plugin-root (or FLYWHEEL_DISCORD_PLUGIN_REPO) is required for the cross-repo gate",
		);
	}
	return args;
}

export function runReceiptResidueGate(argv = process.argv.slice(2)) {
	const args = parseArgs(argv);
	const result = scanReceiptResidue({
		mainRoot: args.mainRoot,
		pluginRoot: args.pluginRoot,
		config: readConfig(args.configPath),
	});
	if (args.json) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	} else if (result.ok) {
		process.stdout.write(
			`FLY-1645 residue gate passed (${result.scannedFiles.main} main files, ${result.scannedFiles.plugin} plugin files)\n`,
		);
	} else {
		for (const violation of result.violations) {
			if (violation.path) {
				process.stderr.write(
					`${violation.repo}:${violation.path}:${violation.line} [${violation.rule ?? violation.kind}] ${violation.text}\n`,
				);
			} else {
				process.stderr.write(
					`[${violation.rule}] allowlist cardinality expected ${violation.expected}, got ${violation.actual}\n`,
				);
			}
		}
	}
	return result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	try {
		process.exitCode = runReceiptResidueGate();
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 2;
	}
}
