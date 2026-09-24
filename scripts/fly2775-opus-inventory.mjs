#!/usr/bin/env node
// FLY-2775 deployment gate: is every Opus-line dispatch surface following the
// latest release? READ-ONLY. It opens teamlead.db with a read-only handle and
// never writes projects.json or models.json.
//
// Scope:
//   1. every workflow_category_binding row → the bound template's CURRENT
//      published revision → every Claude node whose model is on the Opus line;
//   2. every Lead in projects.json.
// Each row is classified:
//   follows-latest     — stores a family alias (opus / opus-1m / opus[1m]) that
//                        resolves to a DISPATCHABLE exact id right now
//   unresolvable       — stores an alias the live registry cannot turn into a
//                        dispatchable exact id (a gate failure, not a pass)
//   migration-required — pins an exact claude-opus-* id (frozen)
//   not-opus           — another model line (Fable, Codex, …); out of scope
// Fails CLOSED: exit 1 on any unresolvable/migration-required row, exit 2 when
// projects.json or the model registry cannot be read (never a silent pass).
//
// Usage: node scripts/fly2775-opus-inventory.mjs [--db <teamlead.db>]
//          [--projects <projects.json>] [--json]

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FOLLOW_LATEST = new Set(["opus", "opus-1m", "opus[1m]"]);
const EXACT_OPUS = /^claude-opus-/;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function option(argv, name) {
	const index = argv.indexOf(name);
	if (index < 0) return undefined;
	const value = argv[index + 1];
	if (!value || value.startsWith("--"))
		throw new Error(`${name} requires a value`);
	return value;
}

export function classifyModel(model) {
	if (typeof model !== "string" || model.length === 0) return "not-opus";
	if (FOLLOW_LATEST.has(model)) return "follows-latest";
	if (EXACT_OPUS.test(model)) return "migration-required";
	return "not-opus";
}

async function loadResolver() {
	const entry =
		process.env.FLYWHEEL_CONFIG_DIST ??
		join(repoRoot, "packages/config/dist/index.js");
	// No try/catch: an unusable registry must fail the gate, not pass it.
	const { getModelConfigSnapshot } = await import(pathToFileURL(entry).href);
	const snapshot = getModelConfigSnapshot();
	return (model) => {
		const id = snapshot.getModelRegistryEntry(model)?.id ?? null;
		// Follow-latest only counts if the resolved exact id can be dispatched.
		return id !== null && snapshot.normalizeDispatchModel(id) === id
			? id
			: null;
	};
}

function openReadOnly(dbPath) {
	const require = createRequire(
		join(repoRoot, "packages/teamlead/package.json"),
	);
	const Database = require("better-sqlite3");
	return new Database(dbPath, { readonly: true, fileMustExist: true });
}

export async function buildInventory({ dbPath, projectsPath }) {
	const resolveModel = await loadResolver();
	const rows = [];
	const db = openReadOnly(dbPath);
	try {
		const bindings = db
			.prepare(
				"SELECT project, task_category, template_id FROM workflow_category_binding ORDER BY project, task_category",
			)
			.all();
		const manifests = new Map();
		for (const binding of bindings) {
			if (!manifests.has(binding.template_id)) {
				const revision = db
					.prepare(
						`SELECT r.revision, r.manifest FROM workflow_template t
						 JOIN workflow_template_revision r
						   ON r.template_id = t.template_id AND r.revision = t.current_published_revision
						 WHERE t.template_id = ?`,
					)
					.get(binding.template_id);
				manifests.set(
					binding.template_id,
					revision
						? {
								revision: revision.revision,
								manifest: JSON.parse(revision.manifest),
							}
						: null,
				);
			}
			const published = manifests.get(binding.template_id);
			if (!published) {
				rows.push({
					kind: "template",
					project: binding.project,
					category: binding.task_category,
					template: binding.template_id,
					node: "(unpublished)",
					stored: null,
					resolved: null,
					status: "migration-required",
				});
				continue;
			}
			for (const node of published.manifest.nodes ?? []) {
				if (node.vendor !== "claude" || typeof node.model !== "string")
					continue;
				const classified = classifyModel(node.model);
				if (classified === "not-opus") continue;
				const resolved = resolveModel(node.model);
				const status =
					classified === "follows-latest" && resolved === null
						? "unresolvable"
						: classified;
				rows.push({
					kind: "template",
					project: binding.project,
					category: binding.task_category,
					template: `${binding.template_id}@${published.revision}`,
					node: node.id,
					stored: node.model,
					resolved,
					status,
				});
			}
		}
	} finally {
		db.close();
	}
	// No try/catch: a missing or malformed projects.json must fail the gate —
	// silently skipping it would drop every Lead from an "all projects" check.
	const projects = JSON.parse(readFileSync(projectsPath, "utf8"));
	if (!Array.isArray(projects))
		throw new Error("projects.json is not an array");
	for (const project of projects) {
		for (const lead of project.leads ?? []) {
			const classified = classifyModel(lead.model);
			if (classified === "not-opus") continue;
			const resolved = resolveModel(lead.model);
			const status =
				classified === "follows-latest" && resolved === null
					? "unresolvable"
					: classified;
			rows.push({
				kind: "lead",
				project: project.projectName,
				category: "lead",
				template: "projects.json",
				node: lead.agentId,
				stored: lead.model,
				resolved,
				status,
			});
		}
	}
	return rows;
}

const STATUS_LABEL = {
	"follows-latest": "✅ 跟最新",
	unresolvable: "❌ 别名解析不到可派工 id",
	"migration-required": "❌ 需迁移",
};

export function renderMarkdown(rows) {
	const lines = [
		"| 项目 | 类别 | 模板 / 来源 | 节点 / Lead | 存储值 | 当前解析 | 状态 |",
		"|---|---|---|---|---|---|---|",
	];
	for (const row of rows) {
		lines.push(
			`| ${row.project} | ${row.category} | ${row.template} | ${row.node} | \`${row.stored ?? "—"}\` | \`${row.resolved ?? "—"}\` | ${STATUS_LABEL[row.status]} |`,
		);
	}
	const pending = rows.filter((row) => row.status !== "follows-latest").length;
	lines.push("", `共 ${rows.length} 行 Opus 线派工面,需迁移 ${pending} 行。`);
	return lines.join("\n");
}

async function main() {
	const argv = process.argv.slice(2);
	const home = process.env.FLYWHEEL_HOME ?? join(homedir(), ".flywheel");
	const rows = await buildInventory({
		dbPath: option(argv, "--db") ?? join(home, "teamlead.db"),
		projectsPath: option(argv, "--projects") ?? join(home, "projects.json"),
	});
	process.stdout.write(
		argv.includes("--json")
			? `${JSON.stringify(rows, null, 2)}\n`
			: `${renderMarkdown(rows)}\n`,
	);
	process.exitCode = rows.some((row) => row.status !== "follows-latest")
		? 1
		: 0;
}

if (
	process.argv[1] &&
	fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
	main().catch((error) => {
		process.stderr.write(
			`fly2775-opus-inventory: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 2;
	});
}
