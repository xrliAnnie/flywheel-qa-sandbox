#!/usr/bin/env node
/** FLY-2913: summarize explicitly collected diagnostics, never estimate from transcripts.
 * Input samples are normalized diagnostic observations with raw evidence paths.
 * Validation proves arithmetic/pairing/provenance, not that CLI controls took effect.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
	collectWeeklyToolUse,
	readWeeklyToolManifest,
} from "./lib/qa-2913-weekly-tools.mjs";

export const PREFIX_ROLES = [
	"design",
	"implement",
	"qa",
	"review-design",
	"review-code",
];
const COMPONENTS = [
	"system-role",
	"builtin-tools",
	"mcp-deferred",
	"mcp-expanded",
	"skills-agents",
	"rules-memory",
	"hook-context",
	"unattributed",
];
const METHODS = ["diagnostic-estimate", "controlled-ablation-estimate"];
const IDENTITY = [
	"executionId",
	"capturedAt",
	"cliVersion",
	"cliSha256",
	"head",
	"model",
	"effort",
	"cwd",
	"project",
	"taskDigest",
	"permissionMode",
	"skillArm",
	"carrier",
	"settingsDigest",
	"sourceManifestDigest",
	"profileDigest",
];
// Head and settings intentionally differ in an implementation's before/after pair.
const MATCH = [
	"cliVersion",
	"cliSha256",
	"model",
	"effort",
	"cwd",
	"project",
	"taskDigest",
	"permissionMode",
	"skillArm",
	"carrier",
	"measurementMethod",
];
const SOURCE_FIELDS = [
	"sourceName",
	"kind",
	"version",
	"sha256",
	"loaded",
	"advertised",
	"deferred",
	"observedCalls",
	"requiredBy",
	"decision",
	"reason",
	"plugin",
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const requireValue = (condition, message) => {
	if (!condition) throw new Error(message);
};
const numberOrUnknown = (value, name) => {
	requireValue(
		value === null || (Number.isFinite(value) && value >= 0),
		`${name} must be nonnegative or null (unknown)`,
	);
	return value;
};
const percent = (tokens, total) =>
	tokens === null || total === null || total === 0
		? null
		: (tokens / total) * 100;
const p50 = (values) => {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b),
		mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const stats = (samples) => {
	const values = samples
		.filter((s) => s.measurementComplete)
		.map((s) => s.fixedPrefixTokens);
	return {
		sampleCount: samples.length,
		measuredCount: values.length,
		p50: p50(values),
		range: values.length ? [Math.min(...values), Math.max(...values)] : null,
	};
};

/** Current CLI get_context_usage response, sampled in 529 on 2.1.283.
 * Deferred schema estimates describe potential expansion, not sent tokens.
 * Hook additionalContext and the deferred name roster are not individually
 * attributed by this endpoint; preserve that gap instead of inventing zeroes.
 */
export function summarizeClaudeContextDiagnostic(data) {
	requireValue(Array.isArray(data?.categories), "context categories required");
	const fixedNames = new Set([
		"System prompt",
		"System tools",
		"MCP tools",
		"MCP server instructions",
		"Custom agents",
		"Memory files",
		"Skills",
		"Slash commands",
	]);
	const categories = data.categories.map((c) => {
		requireValue(
			fixedNames.has(c.name) ||
				[
					"Messages",
					"MCP tools (deferred)",
					"System tools (deferred)",
					"Autocompact buffer",
					"Free space",
				].includes(c.name),
			"unrecognized context category",
		);
		requireValue(
			["used", "deferred", "buffer", "free"].includes(c.kind),
			"unrecognized context category kind",
		);
		requireValue(
			Number.isFinite(c.tokens) && c.tokens >= 0,
			"invalid context category tokens",
		);
		return {
			name: c.name,
			tokens: c.tokens,
			kind: c.kind,
			isDeferred: c.isDeferred === true,
		};
	});
	requireValue(
		new Set(categories.map((c) => c.name)).size === categories.length,
		"duplicate context category",
	);
	const used = categories.filter((c) => c.kind === "used" && !c.isDeferred);
	const usedTotal = used.reduce((n, c) => n + c.tokens, 0);
	requireValue(
		Number.isFinite(data.totalTokens) && usedTotal === data.totalTokens,
		"context used categories do not reconcile",
	);
	const entries = (rows, fields) =>
		rows === undefined
			? null
			: rows.map((row) =>
					Object.fromEntries(fields.map((f) => [f, row[f] ?? null])),
				);
	return {
		measurementMethod: "diagnostic-estimate",
		model: data.model,
		reportedContextTokens: data.totalTokens,
		knownFixedCategoryTokens: used
			.filter((c) => fixedNames.has(c.name))
			.reduce((n, c) => n + c.tokens, 0),
		deferredSchemaTokens: categories
			.filter((c) => c.kind === "deferred")
			.reduce((n, c) => n + c.tokens, 0),
		fixedPrefixTokens: null,
		unmeasured: [
			"hook additionalContext attribution",
			"deferred tool roster placement/cost",
			"per-builtin tool costs if diagnostic omits systemTools",
		],
		categories,
		memoryFiles: entries(data.memoryFiles, ["path", "type", "tokens"]),
		mcpTools: entries(data.mcpTools, [
			"name",
			"serverName",
			"tokens",
			"isLoaded",
		]),
		agents: entries(data.agents, ["agentType", "source", "tokens"]),
		systemTools: entries(data.systemTools, ["name", "tokens"]),
		deferredBuiltinTools: entries(data.deferredBuiltinTools, [
			"name",
			"tokens",
			"isLoaded",
		]),
		skills: data.skills
			? {
					totalSkills: data.skills.totalSkills,
					includedSkills: data.skills.includedSkills,
					tokens: data.skills.tokens,
					skillFrontmatter: entries(data.skills.skillFrontmatter, [
						"name",
						"source",
						"tokens",
					]),
				}
			: null,
	};
}

function evidenceFile(path) {
	requireValue(
		typeof path === "string" && isAbsolute(path) && !/[?*[\]{}]/.test(path),
		"evidence requires an explicit absolute file path, not a glob",
	);
	const bytes = readFileSync(path);
	return { path, bytes: bytes.length, sha256: digest(bytes) };
}

function normalizeSample(sample) {
	requireValue(sample && typeof sample === "object", "invalid sample");
	requireValue(PREFIX_ROLES.includes(sample.role), "unknown prefix role");
	requireValue(
		["legacy", "role-v1"].includes(sample.mode),
		"unknown prefix mode",
	);
	for (const field of ["pairId", "sessionId", ...IDENTITY]) {
		requireValue(
			typeof sample[field] === "string" && sample[field].length > 0,
			`missing sample ${field}`,
		);
	}
	requireValue(
		Number.isFinite(Date.parse(sample.capturedAt)),
		"invalid capturedAt",
	);
	requireValue(
		/^\/tmp\/flywheel-test-slot-\d+\//.test(sample.cwd) ||
			/^\/private\/tmp\/flywheel-test-slot-\d+\//.test(sample.cwd),
		"sample cwd must identify a 529 slot",
	);
	for (const field of [
		"cliSha256",
		"taskDigest",
		"settingsDigest",
		"sourceManifestDigest",
		"profileDigest",
	]) {
		requireValue(/^[a-f0-9]{64}$/.test(sample[field]), `invalid ${field}`);
	}
	requireValue(/^[a-f0-9]{40}$/.test(sample.head), "invalid head");
	requireValue(
		METHODS.includes(sample.measurementMethod),
		"unsupported prefix measurement method",
	);
	requireValue(
		Array.isArray(sample.evidencePaths) && sample.evidencePaths.length > 0,
		"missing raw diagnostic evidence",
	);
	const total = numberOrUnknown(sample.fixedPrefixTokens, "fixedPrefixTokens");
	requireValue(
		Array.isArray(sample.components) &&
			sample.components.length === COMPONENTS.length,
		"all fixed-prefix components including unknown/residual required",
	);
	const byKind = new Map(sample.components.map((c) => [c.kind, c]));
	requireValue(
		byKind.size === COMPONENTS.length && COMPONENTS.every((k) => byKind.has(k)),
		"invalid or duplicated component",
	);
	const components = COMPONENTS.map((kind) => {
		const tokens = numberOrUnknown(
			byKind.get(kind).tokens,
			`component ${kind}`,
		);
		return { kind, tokens, percent: percent(tokens, total) };
	});
	const known = components.every((c) => c.tokens !== null);
	if (known && total !== null) {
		requireValue(
			Math.abs(components.reduce((n, c) => n + c.tokens, 0) - total) < 0.000001,
			"fixed-prefix components do not reconcile with total",
		);
	}
	requireValue(Array.isArray(sample.sources), "source inventory required");
	const sources = sample.sources.map((source) => {
		requireValue(
			[
				"tool",
				"mcp",
				"skill",
				"agent",
				"rule",
				"system",
				"hook",
				"plugin",
			].includes(source.kind),
			"invalid source kind",
		);
		requireValue(
			typeof source.sourceName === "string" && source.sourceName.length > 0,
			"sourceName required",
		);
		requireValue(
			["keep", "remove", "unknown"].includes(source.decision),
			"source decision required",
		);
		requireValue(
			typeof source.reason === "string" && source.reason.length > 0,
			"source decision reason required",
		);
		for (const field of ["loaded", "advertised", "deferred"])
			requireValue(
				source[field] === null || typeof source[field] === "boolean",
				`${field} must be boolean or unknown`,
			);
		requireValue(
			source.sha256 === null || /^[a-f0-9]{64}$/.test(source.sha256),
			"source sha256 must be a digest or unknown",
		);
		requireValue(
			Array.isArray(source.requiredBy) &&
				source.requiredBy.every((s) => typeof s === "string"),
			"source requiredBy must list contracts",
		);
		const tokens = numberOrUnknown(source.tokens, "source tokens");
		numberOrUnknown(source.observedCalls, "observedCalls");
		return {
			...Object.fromEntries(SOURCE_FIELDS.map((f) => [f, source[f] ?? null])),
			tokens,
			percent: percent(tokens, total),
			measurementMethod: sample.measurementMethod,
		};
	});
	return {
		role: sample.role,
		mode: sample.mode,
		pairId: sample.pairId,
		sessionId: sample.sessionId,
		...Object.fromEntries(IDENTITY.map((f) => [f, sample[f]])),
		measurementMethod: sample.measurementMethod,
		fixedPrefixTokens: total,
		components,
		sources,
		evidence: sample.evidencePaths.map(evidenceFile),
		measurementComplete: known && total !== null,
	};
}

export function summarizePrefixInventory(manifest) {
	requireValue(
		manifest?.version === 1 && Array.isArray(manifest.samples),
		"expected version 1 explicit samples manifest",
	);
	const samples = manifest.samples.map(normalizeSample);
	const pairs = new Map(),
		sessions = new Set();
	for (const sample of samples) {
		requireValue(
			!sessions.has(sample.sessionId),
			"duplicate session cannot count as a new measurement",
		);
		sessions.add(sample.sessionId);
		const key = `${sample.role}:${sample.pairId}`;
		const pair = pairs.get(key) ?? {};
		requireValue(!pair[sample.mode], "duplicate paired sample");
		pair[sample.mode] = sample;
		if (pair.legacy && pair["role-v1"]) {
			for (const field of MATCH)
				requireValue(
					pair.legacy[field] === pair["role-v1"][field],
					`paired sample mismatch: ${field}`,
				);
		}
		pairs.set(key, pair);
	}
	const roles = PREFIX_ROLES.map((role) => {
		const selected = samples.filter((s) => s.role === role);
		const before = stats(selected.filter((s) => s.mode === "legacy"));
		const after = stats(selected.filter((s) => s.mode === "role-v1"));
		const completePairs = [...pairs.values()].filter(
			(p) =>
				p.legacy?.role === role &&
				p.legacy.measurementComplete &&
				p["role-v1"]?.measurementComplete,
		);
		return {
			role,
			before,
			after,
			pairedSamples: completePairs.length,
			deltaP50: p50(
				completePairs.map(
					(p) => p["role-v1"].fixedPrefixTokens - p.legacy.fixedPrefixTokens,
				),
			),
			measurementComplete:
				completePairs.length >= 3 &&
				completePairs.length * 2 === selected.length &&
				selected.every((s) => s.measurementComplete),
			inventoryComplete:
				selected.length > 0 &&
				selected.every(
					(s) =>
						s.sources.length > 0 &&
						s.sources.every((source) =>
							[
								"version",
								"sha256",
								"loaded",
								"advertised",
								"deferred",
								"tokens",
								"observedCalls",
							].every((field) => source[field] !== null),
						),
				),
			decisionsComplete:
				selected.length > 0 &&
				selected.every(
					(s) =>
						s.sources.length > 0 &&
						s.sources.every((r) => r.decision !== "unknown"),
				),
		};
	});
	return {
		version: 1,
		evidenceKind: "normalized-diagnostic-observations",
		validationScope:
			"arithmetic, source evidence hashes and paired conditions; runtime control/529 success require separate receipts",
		complete: roles.every(
			(r) =>
				r.measurementComplete && r.inventoryComplete && r.decisionsComplete,
		),
		roles,
		samples,
	};
}

export function inventoryCsv(report) {
	const fields = [
		"role",
		"mode",
		"sessionId",
		...SOURCE_FIELDS,
		"tokens",
		"percent",
		"measurementMethod",
	];
	const cell = (value) =>
		`"${(value === null || value === undefined ? "unknown" : Array.isArray(value) ? value.join(";") : String(value)).replaceAll('"', '""')}"`;
	const rows = report.samples.flatMap((s) =>
		s.sources.map((source) => ({
			role: s.role,
			mode: s.mode,
			sessionId: s.sessionId,
			...source,
		})),
	);
	return `${[
		fields.join(","),
		...rows.map((r) => fields.map((f) => cell(r[f])).join(",")),
	].join("\n")}\n`;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	try {
		if (process.argv[2] === "weekly") {
			const [manifest, cutoff, output, ...extra] = process.argv.slice(3);
			requireValue(
				manifest && cutoff && output && !extra.length,
				"Usage: qa-2913-prefix-inventory.mjs weekly <manifest.json> <cutoff-ISO> <weekly-tool-use.json>",
			);
			const result = await collectWeeklyToolUse({
				manifest: await readWeeklyToolManifest(manifest),
				cutoff,
			});
			writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, {
				mode: 0o600,
			});
			console.log(
				JSON.stringify({
					inputCount: result.inputCount,
					totalCalls: result.totalCalls,
					diagnostics: result.diagnostics,
				}),
			);
		} else {
			const [input, jsonOutput, csvOutput, ...extra] = process.argv.slice(2);
			requireValue(
				input && jsonOutput && csvOutput && !extra.length,
				"Usage: qa-2913-prefix-inventory.mjs <explicit-manifest.json> <inventory-before-after.json> <role-capabilities.csv>",
			);
			const report = summarizePrefixInventory(
				JSON.parse(readFileSync(input, "utf8")),
			);
			writeFileSync(jsonOutput, `${JSON.stringify(report, null, 2)}\n`, {
				mode: 0o600,
			});
			writeFileSync(csvOutput, inventoryCsv(report), { mode: 0o600 });
			console.log(
				JSON.stringify({ complete: report.complete, roles: report.roles }),
			);
		}
	} catch (error) {
		console.error(`prefix inventory: ${error.message}`);
		process.exitCode = 1;
	}
}
