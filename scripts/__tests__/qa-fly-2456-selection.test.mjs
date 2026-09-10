import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { loadWorkflowMenuSeeds } from "../../packages/teamlead/dist/workflow-menu.js";
import { resolveWorkflowTemplateSelection } from "../../packages/teamlead/dist/workflow-template-selection.js";
import { previewStartSelection } from "../lib/qa-fly-2456-selection.mjs";

const Database = createRequire(
	new URL("../../packages/flywheel-comm/package.json", import.meta.url),
)("better-sqlite3");
const modelDir = mkdtempSync(join(tmpdir(), "fly2456-selection-models-"));
const modelConfigPath = join(modelDir, "models.json");
writeFileSync(modelConfigPath, JSON.stringify({ version: 1 }));
const previousModelEnv = process.env.FLYWHEEL_MODELS_CONFIG;
process.env.FLYWHEEL_MODELS_CONFIG = modelConfigPath;
after(() => {
	if (previousModelEnv === undefined) delete process.env.FLYWHEEL_MODELS_CONFIG;
	else process.env.FLYWHEEL_MODELS_CONFIG = previousModelEnv;
	rmSync(modelDir, { recursive: true, force: true });
});
const checkout = fileURLToPath(new URL("../../", import.meta.url));
function fixture(t, mutate = () => {}) {
	const dir = mkdtempSync(join(tmpdir(), "fly2456-selection-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const dbPath = join(dir, "snapshot.sqlite"),
		requestPath = join(dir, "request.json"),
		hostRepo = join(dir, "host");
	mkdirSync(hostRepo);
	const source = readFileSync(
		join(checkout, "packages/teamlead/src/StateStore.ts"),
		"utf8",
	);
	const db = new Database(dbPath);
	db.pragma("foreign_keys=OFF");
	for (const table of [
		"workflow_template",
		"workflow_template_revision",
		"workflow_category_binding",
		"workflow_run",
		"workflow_run_issue_alias",
		"workflow_start_reservation",
	])
		db.exec(
			source.match(
				new RegExp(
					`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\t\\t\\t\\)`,
				),
			)[0],
		);
	db.exec(source.match(/CREATE TABLE flag_values \([\s\S]*?\n\t\t\t\t\)/)[0]);
	const seed = loadWorkflowMenuSeeds().find(
		(s) => s.templateId === "tpl_simple_code",
	);
	db.prepare(
		"INSERT INTO workflow_template(template_id,name,project_scope,current_published_revision,created_by) VALUES (?,?,?,?,?)",
	).run(seed.templateId, seed.name, "global", 1, "test");
	db.prepare(
		"INSERT INTO workflow_template_revision(template_id,revision,manifest,manifest_digest,schema_version,created_by) VALUES (?,1,?,?,?,?)",
	).run(
		seed.templateId,
		JSON.stringify(seed.manifest),
		seed.contentHash,
		seed.manifest.schema_version,
		"test",
	);
	db.prepare(
		"INSERT INTO workflow_category_binding(project,task_category,template_id,updated_by) VALUES (?,?,?,?)",
	).run("test", "simple_code", seed.templateId, "test");
	for (const name of ["pipeline_dag", "pipeline_work_kind"])
		db.prepare("INSERT INTO flag_values VALUES (?,?,1,?,?,NULL,1,0,?)").run(
			name,
			"test",
			"1",
			"1",
			"test",
		);
	const request = {
		issueId: "FLY-1",
		projectName: "test",
		leadId: "flywheel-test-4",
		taskCategory: "simple_code",
		idempotencyKey: "key-1",
		sessionRole: "main",
	};
	mutate(db, request, hostRepo);
	db.close();
	writeFileSync(requestPath, JSON.stringify(request));
	writeFileSync(
		dbPath + ".meta.json",
		JSON.stringify({
			observedAt: new Date().toISOString(),
			sha256: createHash("sha256").update(readFileSync(dbPath)).digest("hex"),
		}),
	);
	return {
		dbPath,
		requestPath,
		checkout,
		hostRepo,
		seed,
		request,
		modelConfigPath,
	};
}
test("preview captures actual resolver digest without mutating snapshot", async (t) => {
	const f = fixture(t),
		before = readFileSync(f.dbPath);
	const r = await previewStartSelection(f);
	assert.equal(r.status, "pass", r.reason);
	assert.match(r.selectionDigest, /^[a-f0-9]{64}$/);
	assert.equal(r.nodeId, "implement");
	assert.deepEqual(readFileSync(f.dbPath), before);
	let actual;
	const stop = {};
	await assert.rejects(
		resolveWorkflowTemplateSelection(
			{
				getWorkflowCategoryBinding: () => ({
					template_id: f.seed.templateId,
					task_category: "simple_code",
				}),
				getWorkflowTemplate: () => ({ current_published_revision: 1 }),
				getWorkflowTemplateRevision: () => ({
					revision: 1,
					schema_version: f.seed.manifest.schema_version,
					manifest: JSON.stringify(f.seed.manifest),
					manifest_digest: f.seed.contentHash,
				}),
				getWorkflowStartReservation: () => undefined,
				getActiveWorkflowRunForIssue: () => undefined,
				materializeWorkflowRun: (x) => {
					actual = x.startReservation.selectionDigest;
					throw stop;
				},
			},
			{
				project: "test",
				issueId: "FLY-1",
				issueIdentifier: "FLY-1",
				taskCategory: "simple_code",
				selectedBy: "flywheel-test-4",
				actor: "master",
				authKind: "master",
				canonicalRoot: f.hostRepo,
				idempotencyKey: "key-1",
				workKindEnforced: true,
				categorySource: "task_category",
			},
		),
		(e) => e === stop,
	);
	assert.equal(r.selectionDigest, actual);
});
test("alias-linked active issue fails before resolver can probe liveness", async (t) => {
	const f = fixture(t, (db) => {
		db.prepare(
			"INSERT INTO workflow_run(run_id,issue_id,project_name,template_id,template_revision,status,created_at) VALUES ('occupied','uuid','test','tpl_simple_code',1,'active','now')",
		).run();
		db.prepare(
			"INSERT INTO workflow_run_issue_alias VALUES ('occupied','FLY-1')",
		).run();
	});
	const r = await previewStartSelection(f);
	assert.equal(r.status, "fail");
	assert.match(r.reason, /existing/);
});
test("missing alias schema and poisoned text storage fail closed", async (t) => {
	for (const mutate of [
		(db) => db.exec("DROP TABLE workflow_run_issue_alias"),
		(db) =>
			db
				.prepare("UPDATE workflow_category_binding SET project=?")
				.run(Buffer.from("other")),
	]) {
		const r = await previewStartSelection(fixture(t, mutate));
		assert.equal(r.status, "fail");
		assert.match(r.reason, /schema|storage/);
	}
});
test("non-main request cannot receive a generalized preview", async (t) => {
	const r = await previewStartSelection(
		fixture(t, (_, r) => {
			r.sessionRole = "qa";
		}),
	);
	assert.equal(r.status, "fail");
});
function menuHost(_, request, host) {
	mkdirSync(join(host, ".flywheel", "menus"), { recursive: true });
	writeFileSync(join(host, ".flywheel", "config.yaml"), "project: test\n");
	writeFileSync(
		join(host, ".flywheel", "menus", "adoption.yaml"),
		"flywheel-test-4: [simple_code]\n",
	);
	writeFileSync(join(host, "agent.md"), "test");
	writeFileSync(
		join(host, ".flywheel", "menus", "ic-roster.yaml"),
		"implement: agent.md\nqa: agent.md\n",
	);
	request.overrides = { implement: { effort: "low" } };
}
test("request menu overrides reach actual selection digest and invalid menus fail", async (t) => {
	const plain = await previewStartSelection(fixture(t));
	const f = fixture(t, menuHost);
	const r = await previewStartSelection(f);
	assert.equal(r.status, "pass", r.reason);
	assert.notEqual(r.selectionDigest, plain.selectionDigest);
	const bad = fixture(t, (db, req, host) => {
		menuHost(db, req, host);
		req.overrides = { missing: { effort: "low" } };
	});
	assert.equal((await previewStartSelection(bad)).status, "fail");
});
test("routing override cannot preview a generalized start", async (t) => {
	assert.equal(
		(
			await previewStartSelection(
				fixture(t, (_, r) => {
					r.routingOverrides = ["no-three-stage"];
				}),
			)
		).status,
		"fail",
	);
});
test("existing exact reservation and raw active run stop before any liveness path", async (t) => {
	for (const mutate of [
		(db) =>
			db
				.prepare(
					"INSERT INTO workflow_start_reservation VALUES ('key-1','digest','run','implement',1,'exec','now')",
				)
				.run(),
		(db) =>
			db
				.prepare(
					"INSERT INTO workflow_run(run_id,issue_id,project_name,status) VALUES ('run','FLY-1','test','active')",
				)
				.run(),
	]) {
		const r = await previewStartSelection(fixture(t, mutate));
		assert.equal(r.status, "fail");
		assert.match(r.reason, /existing/);
	}
});
test("bad hash, missing metadata and WAL are rejected", async (t) => {
	for (const mutate of [
		(f) =>
			writeFileSync(
				f.dbPath + ".meta.json",
				JSON.stringify({
					observedAt: new Date().toISOString(),
					sha256: "a".repeat(64),
				}),
			),
		(f) => rmSync(f.dbPath + ".meta.json"),
		(f) => writeFileSync(f.dbPath + "-wal", "untrusted"),
	]) {
		const f = fixture(t);
		mutate(f);
		assert.equal((await previewStartSelection(f)).status, "fail");
	}
});
test("preview requires explicit model policy bound to the helper environment", async (t) => {
	const f = fixture(t);
	const r = await previewStartSelection({
		...f,
		modelConfigPath: join(f.hostRepo, "missing-models.json"),
	});
	assert.equal(r.status, "fail");
	assert.match(r.reason, /model/);
});
test("raw UUID or a conflicting hydrated identifier cannot be silently inferred", async (t) => {
	for (const change of [
		(r) => {
			r.issueId = "some-uuid";
		},
		(r) => {
			r.issueIdentifier = "FLY-2";
		},
	])
		assert.equal(
			(await previewStartSelection(fixture(t, (_, r) => change(r)))).status,
			"fail",
		);
});
test("ambient fallback and undeclared model files are rejected", async (t) => {
	const f = fixture(t),
		saved = process.env.FLYWHEEL_MODELS_CONFIG;
	try {
		delete process.env.FLYWHEEL_MODELS_CONFIG;
		assert.equal((await previewStartSelection(f)).status, "fail");
	} finally {
		process.env.FLYWHEEL_MODELS_CONFIG = saved;
	}
	assert.equal(
		(await previewStartSelection({ ...f, modelConfigPath: undefined })).status,
		"fail",
	);
});
test("preview digest equals a real materialized reservation on synthetic StateStore", async (t) => {
	const f = fixture(t);
	const preview = await previewStartSelection(f);
	assert.equal(preview.status, "pass", preview.reason);
	const { StateStore } = await import(
		"../../packages/teamlead/dist/StateStore.js"
	);
	const materializedPath = join(f.hostRepo, "materialized.sqlite");
	const store = await StateStore.create(materializedPath);
	try {
		store.importWorkflowTemplateSeed(f.seed);
		store.bindWorkflowCategory({
			project: "test",
			taskCategory: "simple_code",
			templateId: f.seed.templateId,
			updatedBy: "test",
		});
		const selected = await resolveWorkflowTemplateSelection(store, {
			project: "test",
			issueId: "FLY-1",
			issueIdentifier: "FLY-1",
			taskCategory: "simple_code",
			selectedBy: "flywheel-test-4",
			actor: "master",
			authKind: "master",
			canonicalRoot: checkout,
			idempotencyKey: "key-1",
			workKindEnforced: true,
			categorySource: "task_category",
		});
		assert.ok(selected?.runId);
		const reservation = store.getWorkflowStartReservation("key-1");
		assert.equal(reservation.selection_digest, preview.selectionDigest);
		assert.equal(reservation.node_id, preview.nodeId);
	} finally {
		store.close();
	}
	const persisted = new Database(materializedPath, {
		readonly: true,
		fileMustExist: true,
	});
	try {
		assert.equal(
			persisted
				.prepare(
					"SELECT selection_digest FROM workflow_start_reservation WHERE idempotency_key=?",
				)
				.get("key-1").selection_digest,
			preview.selectionDigest,
		);
	} finally {
		persisted.close();
	}
});
