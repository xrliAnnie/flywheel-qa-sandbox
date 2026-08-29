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

async function loadBuiltConfig() {
	try {
		return await import(configModuleUrl);
	} catch (error) {
		throw new Error(
			`built flywheel-config is unavailable; run pnpm install --frozen-lockfile && pnpm --filter flywheel-config build (${error.message})`,
		);
	}
}

async function canonicalBindings() {
	const config = await loadBuiltConfig();
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

function scopedBoolean(db, config, name, project) {
	const spec = config.FEATURE_FLAGS.find(
		(candidate) => candidate.name === name,
	);
	const codec = config.getFlagStoreCodec(name);
	if (!spec || typeof spec.default !== "boolean" || !codec) {
		throw new Error(`missing scoped boolean flag policy: ${name}`);
	}
	const row = db
		.prepare(
			`SELECT has_override, raw_value
			   FROM flag_values
			  WHERE flag_name = ? AND scope IN (?, '*')
			  ORDER BY CASE WHEN scope = ? THEN 0 ELSE 1 END
			  LIMIT 1`,
		)
		.get(name, project, project);
	const effective = row
		? codec.parse({
				hasOverride: Number(row.has_override) === 1,
				raw: row.raw_value ?? null,
			})
		: spec.default;
	if (typeof effective !== "boolean") {
		throw new Error(`scoped flag is not boolean: ${name}`);
	}
	return effective;
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

async function seedProjectFlags(values) {
	const dbPath = required(values, "db");
	const project = required(values, "project");
	const updatedBy = values.actor?.trim() || "system:test-deploy-generalized";
	const rows = values.flags
		? values.flags.split(",").map((name) => name.trim())
		: ["pipeline_dag", "pipeline_work_kind"];
	if (rows.length === 0 || rows.some((name) => !name)) {
		throw new Error("--flags must be a comma-separated list of flag names");
	}
	if (new Set(rows).size !== rows.length) {
		throw new Error("--flags must not contain duplicate flag names");
	}
	const config = await loadBuiltConfig();
	for (const name of rows) {
		const spec = config.FEATURE_FLAGS.find(
			(candidate) => candidate.name === name,
		);
		if (
			!config.PROJECT_STORE_MANAGED_FLAGS.has(name) ||
			typeof spec?.default !== "boolean"
		) {
			throw new Error(`project flag ${name} is not allowed for QA seeding`);
		}
	}
	const db = openDatabase(dbPath);
	try {
		const current = db.prepare(
			`SELECT has_override,raw_value,last_effective,revision,updated_by
			   FROM flag_values WHERE flag_name = ? AND scope = ?`,
		);
		const insert = db.prepare(
			`INSERT INTO flag_values (
				flag_name,scope,has_override,raw_value,last_effective,
				value_last_changed,revision,updated_at,updated_by
			 ) VALUES (?,?,1,'1','true',NULL,1,?,?)`,
		);
		const update = db.prepare(
			`UPDATE flag_values SET
				has_override=1,raw_value='1',last_effective='true',
				value_last_changed=?,revision=revision+1,updated_at=?,updated_by=?
			 WHERE flag_name=? AND scope=?`,
		);
		const audit = db.prepare(
			`INSERT INTO flag_value_changelog (
				flag_name,scope,action,from_present,from_raw,to_present,to_raw,
				from_effective,to_effective,changed_by,changed_at,reason
			 ) VALUES (?,?,'set',?,?,1,'1',?,'true',?,?,'seed generalized QA project flags')`,
		);
		let changed = 0;
		db.transaction(() => {
			const now = Date.now();
			for (const name of rows) {
				const prior = current.get(name, project);
				if (
					prior?.has_override === 1 &&
					prior.raw_value === "1" &&
					prior.last_effective === "true"
				) {
					continue;
				}
				if (prior) {
					update.run(now, now, updatedBy, name, project);
				} else {
					insert.run(name, project, now, updatedBy);
				}
				audit.run(
					name,
					project,
					prior ? 1 : null,
					prior?.raw_value ?? null,
					prior?.last_effective ?? null,
					updatedBy,
					now,
				);
				changed += 1;
			}
		}).immediate();
		process.stdout.write(
			`${JSON.stringify({ success: true, project, flags: rows.length, changed })}\n`,
		);
	} finally {
		db.close();
	}
}

async function verifyConfig(values) {
	const file = required(values, "file");
	const dbPath = required(values, "db");
	const project = required(values, "project");
	const { config } = await canonicalBindings();
	const loader = new config.ConfigLoader((path) => readFile(path, "utf8"));
	const loaded = await loader.load(file);
	if (loaded.project !== project) {
		throw new Error(
			`config project ${loaded.project} does not match ${project}`,
		);
	}
	const db = openDatabase(dbPath, true);
	let dag;
	let workKind;
	try {
		dag = scopedBoolean(db, config, "pipeline_dag", project);
		workKind = scopedBoolean(db, config, "pipeline_work_kind", project);
	} finally {
		db.close();
	}
	if (!dag) {
		throw new Error("pipeline_dag must resolve to true in the scoped store");
	}
	if (!workKind) {
		throw new Error(
			"pipeline_work_kind must resolve to true in the scoped store",
		);
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
		case "seed-project-flags":
			await seedProjectFlags(values);
			break;
		case "verify-config":
			await verifyConfig(values);
			break;
		default:
			throw new Error(
				"usage: qa-generalized.mjs seed-bindings|verify-bindings|seed-project-flags|verify-config [options; verify-config requires --db]",
			);
	}
}

main().catch((error) => {
	process.stderr.write(`[qa-generalized] ${error.message}\n`);
	process.exitCode = 1;
});
