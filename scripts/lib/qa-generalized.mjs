#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const requireFromTeamlead = createRequire(
	resolve(root, "packages/teamlead/package.json"),
);
const Database = requireFromTeamlead("better-sqlite3");
const configModuleUrl = pathToFileURL(
	resolve(root, "packages/config/dist/index.js"),
).href;

function parseArgs(argv) {
	const [command, ...rest] = argv;
	const values = {};
	for (let index = 0; index < rest.length; index += 1) {
		const key = rest[index];
		if (!key?.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
		const value = rest[index + 1];
		if (!value || value.startsWith("--")) {
			throw new Error(`${key} requires a value`);
		}
		values[key.slice(2)] = value;
		index += 1;
	}
	return { command, values };
}

function required(values, key) {
	const value = values[key]?.trim();
	if (!value) throw new Error(`--${key} is required`);
	return value;
}

async function canonicalBindings() {
	let config;
	try {
		config = await import(configModuleUrl);
	} catch (error) {
		throw new Error(
			`built flywheel-config is unavailable; run pnpm install --frozen-lockfile && pnpm --filter flywheel-config build (${error.message})`,
		);
	}
	const bindings = config.WORKFLOW_MENU_BINDINGS;
	if (!Array.isArray(bindings) || bindings.length !== 6) {
		throw new Error(
			"built WORKFLOW_MENU_BINDINGS must contain exactly six rows",
		);
	}
	return { config, bindings };
}

function openDatabase(path, readonly = false) {
	const db = new Database(path, {
		readonly,
		fileMustExist: true,
		timeout: 5_000,
	});
	db.pragma("busy_timeout = 5000");
	if (!readonly) db.pragma("foreign_keys = ON");
	return db;
}

async function seedBindings(values) {
	const dbPath = required(values, "db");
	const project = required(values, "project");
	const updatedBy = values.actor?.trim() || "system:test-deploy-generalized";
	const { bindings } = await canonicalBindings();
	const db = openDatabase(dbPath);
	try {
		const template = db.prepare(
			`SELECT template_id,current_published_revision,retired_at,project_scope
			   FROM workflow_template WHERE template_id = ?`,
		);
		const current = db.prepare(
			`SELECT template_id,updated_by FROM workflow_category_binding
			  WHERE project = ? AND task_category = ?`,
		);
		const upsert = db.prepare(
			`INSERT INTO workflow_category_binding
			 (project,task_category,template_id,updated_by)
			 VALUES (?,?,?,?)
			 ON CONFLICT(project,task_category) DO UPDATE SET
			   template_id=excluded.template_id,
			   updated_by=excluded.updated_by,
			   updated_at=datetime('now')`,
		);
		const audit = db.prepare(
			`INSERT INTO workflow_template_audit
			 (actor,action,template_id,detail) VALUES (?,'rebind',?,?)`,
		);
		let changed = 0;
		db.transaction(() => {
			for (const binding of bindings) {
				const row = template.get(binding.templateId);
				if (!row)
					throw new Error(`workflow template not found: ${binding.templateId}`);
				if (
					row.current_published_revision === null ||
					row.retired_at !== null
				) {
					throw new Error(
						`workflow template must be published and not retired: ${binding.templateId}`,
					);
				}
				if (row.project_scope !== "global" && row.project_scope !== project) {
					throw new Error(
						`workflow template project scope ${row.project_scope} does not allow ${project}`,
					);
				}
			}
			for (const binding of bindings) {
				const prior = current.get(project, binding.taskCategory);
				if (
					prior?.template_id === binding.templateId &&
					prior?.updated_by === updatedBy
				) {
					continue;
				}
				upsert.run(
					project,
					binding.taskCategory,
					binding.templateId,
					updatedBy,
				);
				audit.run(
					updatedBy,
					binding.templateId,
					JSON.stringify({ project, task_category: binding.taskCategory }),
				);
				changed += 1;
			}
		}).immediate();
		process.stdout.write(
			`${JSON.stringify({ success: true, project, bindings: bindings.length, changed })}\n`,
		);
	} finally {
		db.close();
	}
}

async function verifyBindings(values) {
	const dbPath = required(values, "db");
	const project = required(values, "project");
	const updatedBy = values.actor?.trim() || "system:test-deploy-generalized";
	const { bindings } = await canonicalBindings();
	const db = openDatabase(dbPath, true);
	try {
		const rows = db
			.prepare(
				`SELECT task_category,template_id,updated_by
				   FROM workflow_category_binding WHERE project = ?
				   ORDER BY task_category`,
			)
			.all(project);
		const expected = [...bindings]
			.map((entry) => ({
				task_category: entry.taskCategory,
				template_id: entry.templateId,
				updated_by: updatedBy,
			}))
			.sort((left, right) =>
				left.task_category.localeCompare(right.task_category),
			);
		if (JSON.stringify(rows) !== JSON.stringify(expected)) {
			throw new Error(
				`workflow_category_binding mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(rows)}`,
			);
		}
		process.stdout.write(
			`${JSON.stringify({ success: true, project, bindings: rows.length })}\n`,
		);
	} finally {
		db.close();
	}
}

async function verifyConfig(values) {
	const file = required(values, "file");
	const project = required(values, "project");
	const { config } = await canonicalBindings();
	const loader = new config.ConfigLoader((path) => readFile(path, "utf8"));
	const loaded = await loader.load(file);
	if (loaded.project !== project) {
		throw new Error(
			`config project ${loaded.project} does not match ${project}`,
		);
	}
	if (loaded.pipeline?.dag !== true) {
		throw new Error("pipeline.dag must resolve to true");
	}
	if (loaded.pipeline?.work_kind !== true) {
		throw new Error("pipeline.work_kind must resolve to true");
	}
	process.stdout.write(
		`${JSON.stringify({ success: true, project, dag: true, workKind: true })}\n`,
	);
}

async function main() {
	const { command, values } = parseArgs(process.argv.slice(2));
	switch (command) {
		case "seed-bindings":
			await seedBindings(values);
			break;
		case "verify-bindings":
			await verifyBindings(values);
			break;
		case "verify-config":
			await verifyConfig(values);
			break;
		default:
			throw new Error(
				"usage: qa-generalized.mjs seed-bindings|verify-bindings|verify-config [options]",
			);
	}
}

main().catch((error) => {
	process.stderr.write(`[qa-generalized] ${error.message}\n`);
	process.exitCode = 1;
});
