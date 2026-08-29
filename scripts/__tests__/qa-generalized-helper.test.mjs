import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const helper = join(root, "scripts/lib/qa-generalized.mjs");
const requireFromTeamlead = createRequire(
	join(root, "packages/teamlead/package.json"),
);
const Database = requireFromTeamlead("better-sqlite3");

function fixtureDb(path, { missingTemplate = false } = {}) {
	const db = new Database(path);
	db.exec(`
		PRAGMA foreign_keys=ON;
		CREATE TABLE workflow_template (
			template_id TEXT PRIMARY KEY,
			current_published_revision INTEGER,
			retired_at TEXT,
			project_scope TEXT NOT NULL
		);
		CREATE TABLE workflow_category_binding (
			project TEXT NOT NULL,
			task_category TEXT NOT NULL,
			template_id TEXT NOT NULL,
			updated_by TEXT NOT NULL,
			updated_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY(project, task_category),
			FOREIGN KEY(template_id) REFERENCES workflow_template(template_id)
		);
		CREATE TABLE workflow_template_audit (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			at TEXT NOT NULL DEFAULT (datetime('now')),
			actor TEXT NOT NULL,
			action TEXT NOT NULL,
			template_id TEXT,
			detail JSON
		);
		CREATE TABLE flag_values (
			flag_name TEXT NOT NULL,
			scope TEXT NOT NULL,
			has_override INTEGER NOT NULL,
			raw_value TEXT,
			last_effective TEXT NOT NULL,
			PRIMARY KEY(flag_name, scope)
		);
	`);
	const ids = [
		"tpl_code",
		"tpl_simple_code",
		"tpl_prd",
		"tpl_design",
		"tpl_prototype",
		"tpl_generic_menu",
	];
	const insert = db.prepare(
		"INSERT INTO workflow_template VALUES (?, 1, NULL, 'global')",
	);
	for (const id of missingTemplate ? ids.slice(0, -1) : ids) insert.run(id);
	db.close();
}

function run(...args) {
	return spawnSync(process.execPath, [helper, ...args], {
		cwd: root,
		encoding: "utf8",
	});
}

test("binding seed derives the six canonical mappings and is a no-op on replay", () => {
	const dir = mkdtempSync(join(tmpdir(), "fly1775-binding-"));
	try {
		const path = join(dir, "teamlead.db");
		fixtureDb(path);
		const first = run(
			"seed-bindings",
			"--db",
			path,
			"--project",
			"test-slot-1",
		);
		assert.equal(first.status, 0, first.stderr);
		const db = new Database(path, { readonly: true });
		const firstRows = db
			.prepare(
				"SELECT project,task_category,template_id,updated_by,updated_at FROM workflow_category_binding ORDER BY task_category",
			)
			.all();
		const firstAudit = db
			.prepare(
				"SELECT actor,action,template_id,detail FROM workflow_template_audit ORDER BY id",
			)
			.all();
		db.close();
		assert.equal(firstRows.length, 6);
		assert.deepEqual(
			firstRows.map((row) => [row.task_category, row.template_id]),
			[
				["code", "tpl_code"],
				["design", "tpl_design"],
				["generic", "tpl_generic_menu"],
				["prd", "tpl_prd"],
				["prototype", "tpl_prototype"],
				["simple_code", "tpl_simple_code"],
			],
		);
		assert.equal(firstAudit.length, 6);

		const second = run(
			"seed-bindings",
			"--db",
			path,
			"--project",
			"test-slot-1",
		);
		assert.equal(second.status, 0, second.stderr);
		const replayDb = new Database(path, { readonly: true });
		assert.deepEqual(
			replayDb
				.prepare(
					"SELECT project,task_category,template_id,updated_by,updated_at FROM workflow_category_binding ORDER BY task_category",
				)
				.all(),
			firstRows,
		);
		assert.deepEqual(
			replayDb
				.prepare(
					"SELECT actor,action,template_id,detail FROM workflow_template_audit ORDER BY id",
				)
				.all(),
			firstAudit,
		);
		replayDb.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("binding seed and verification share an explicit audit actor", () => {
	const dir = mkdtempSync(join(tmpdir(), "fly1775-binding-actor-"));
	try {
		const path = join(dir, "teamlead.db");
		fixtureDb(path);
		const seed = run(
			"seed-bindings",
			"--db",
			path,
			"--project",
			"test-slot-1",
			"--actor",
			"qa:fixture",
		);
		assert.equal(seed.status, 0, seed.stderr);
		const verify = run(
			"verify-bindings",
			"--db",
			path,
			"--project",
			"test-slot-1",
			"--actor",
			"qa:fixture",
		);
		assert.equal(verify.status, 0, verify.stderr);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("binding seed rolls back every row when a canonical template is unavailable", () => {
	const dir = mkdtempSync(join(tmpdir(), "fly1775-binding-fail-"));
	try {
		const path = join(dir, "teamlead.db");
		fixtureDb(path, { missingTemplate: true });
		const result = run(
			"seed-bindings",
			"--db",
			path,
			"--project",
			"test-slot-1",
		);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /tpl_generic_menu/);
		const db = new Database(path, { readonly: true });
		assert.equal(
			db.prepare("SELECT count(*) AS n FROM workflow_category_binding").get().n,
			0,
		);
		assert.equal(
			db.prepare("SELECT count(*) AS n FROM workflow_template_audit").get().n,
			0,
		);
		db.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("strict config verification requires both scoped-store pipeline booleans", () => {
	const dir = mkdtempSync(join(tmpdir(), "fly1775-config-"));
	try {
		const good = join(dir, "good.yaml");
		const dbPath = join(dir, "teamlead.db");
		fixtureDb(dbPath);
		const db = new Database(dbPath);
		db.prepare("INSERT INTO flag_values VALUES (?, ?, 1, '1', 'true')").run(
			"pipeline_dag",
			"test-slot-1",
		);
		db.prepare("INSERT INTO flag_values VALUES (?, ?, 1, '1', 'true')").run(
			"pipeline_work_kind",
			"test-slot-1",
		);
		db.close();
		const base = `project: test-slot-1
linear:
  team_id: FLY
runners:
  default: claude
  available:
    claude:
      type: claude
      model: sonnet
teams:
  - name: default
    orchestrators:
      - type: dag
        runner: claude
decision_layer:
  autonomy_level: advisor
  escalation_channel: discord
`;
		writeFileSync(good, base);
		const accepted = run(
			"verify-config",
			"--file",
			good,
			"--db",
			dbPath,
			"--project",
			"test-slot-1",
		);
		assert.equal(accepted.status, 0, accepted.stderr);
		const disabledDb = new Database(dbPath);
		disabledDb
			.prepare(
				"UPDATE flag_values SET raw_value = '0', last_effective = 'false' WHERE flag_name = 'pipeline_work_kind' AND scope = 'test-slot-1'",
			)
			.run();
		disabledDb.close();
		const refused = run(
			"verify-config",
			"--file",
			good,
			"--db",
			dbPath,
			"--project",
			"test-slot-1",
		);
		assert.notEqual(refused.status, 0);
		assert.match(refused.stderr, /work_kind/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
