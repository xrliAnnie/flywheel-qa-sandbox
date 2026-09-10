import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectParkAdoption } from "../lib/qa-fly-2456-park-adopt.mjs";

const require = createRequire(
	new URL("../../packages/flywheel-comm/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
const createdAt = "2026-09-09T00:00:00Z",
	observedAt = "2026-09-09T00:02:00Z",
	now = Date.parse("2026-09-09T00:03:00Z");
function manifest() {
	return {
		config: { issues: { B1: "FLY-1" } },
		bodies: {
			B1: {
				issueId: "FLY-1",
				idempotencyKey: "key",
				clientRequestId: "client",
			},
		},
		steps: {
			step: {
				intent: {
					createdAt,
					idempotencyKey: "key",
					clientRequestId: "client",
					detail: {
						kind: "park-complete",
						label: "B1",
						issueId: "FLY-1",
						executionId: "exec",
						runId: "run",
					},
				},
			},
		},
	};
}
function stamp(path) {
	writeFileSync(
		`${path}.meta.json`,
		JSON.stringify({
			observedAt,
			sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
		}),
	);
}
function fixture(t, change = () => {}) {
	const dir = mkdtempSync(join(tmpdir(), "fly2456-park-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const dbPath = join(dir, "state.db"),
		commPath = join(dir, "comm.db");
	const db = new Database(dbPath),
		comm = new Database(commPath);
	const source = readFileSync(
		new URL("../../packages/teamlead/src/StateStore.ts", import.meta.url),
		"utf8",
	);
	for (const table of [
		"sessions",
		"workflow_run",
		"workflow_run_node",
		"workflow_engine_park_outbox",
	])
		db.exec(
			source.match(
				new RegExp(
					`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\t\\t\\t\\)`,
				),
			)[0],
		);
	const commSource = readFileSync(
		new URL("../../packages/flywheel-comm/src/db.ts", import.meta.url),
		"utf8",
	);
	comm.exec(
		commSource.match(
			/CREATE TABLE IF NOT EXISTS workflow_engine_park \([\s\S]*?\n\);/,
		)[0],
	);
	db.exec(
		"INSERT INTO sessions(execution_id,issue_id,project_name,status) VALUES('exec','FLY-1','p','running');INSERT INTO workflow_run(run_id,issue_id,project_name,status) VALUES('run','FLY-1','p','active');INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id) VALUES('run','implement',1,'running','exec')",
	);
	change(db, comm);
	db.close();
	comm.close();
	stamp(dbPath);
	stamp(commPath);
	return { dbPath, commPath, now };
}
function parked(db, comm) {
	db.exec(
		"UPDATE sessions SET status='ship_parked';UPDATE workflow_run_node SET state='done',ended_at='2026-09-09T00:01:00Z';INSERT INTO workflow_engine_park_outbox(event_id,project_name,execution_id,run_id,node_id,attempt,activation_id,generation,event,reason,created_at) VALUES('engine-park-open:activation','p','exec','run','implement',1,'activation',1,'park_opened','runner_ship_gate_wait','2026-09-09T00:01:00Z')",
	);
	comm.exec(
		"INSERT INTO workflow_engine_park VALUES('exec','run','implement',1,'activation',1,'open','runner_ship_gate_wait',1,'2026-09-09T00:01:00Z')",
	);
}
function inspect(m, paths) {
	return inspectParkAdoption({ manifest: m, step: "step", ...paths });
}
test("park complete adopts current open projection and source park_opened", (t) => {
	const output = inspect(manifest(), fixture(t, parked));
	assert.equal(output.action, "adopt-existing");
	assert.equal(output.result.status, "ship_parked");
	assert.equal(output.result.parkEventId, "engine-park-open:activation");
});
test("running intact node and no park effect execute", (t) => {
	assert.deepEqual(inspect(manifest(), fixture(t)), { action: "execute" });
});
test("matching receipt replay still validates current authority", (t) => {
	const paths = fixture(t, parked),
		m = manifest(),
		output = inspect(m, paths);
	m.steps.step.receipt = { result: output.result };
	assert.deepEqual(inspect(m, paths), { ...output, action: "replay" });
});
test("wrong receipt remains untouched", (t) => {
	const m = manifest();
	m.steps.step.receipt = { result: { status: "wrong" } };
	const original = structuredClone(m);
	assert.equal(inspect(m, fixture(t, parked)).action, "conflict");
	assert.deepEqual(m, original);
});
for (const sql of [
	"UPDATE sessions SET status='running'",
	"UPDATE sessions SET status='completed'",
	"UPDATE sessions SET issue_id='FLY-2'",
	"UPDATE workflow_run SET issue_id='FLY-2'",
	"UPDATE workflow_run SET status='completed'",
	"UPDATE workflow_run_node SET state='running'",
	"UPDATE workflow_run_node SET execution_id='other'",
	"UPDATE workflow_run_node SET attempt=2",
	"DELETE FROM workflow_engine_park_outbox",
	"UPDATE workflow_engine_park_outbox SET event='park_cleared'",
	"UPDATE workflow_engine_park_outbox SET activation_id='other'",
	"UPDATE workflow_engine_park_outbox SET generation=2",
	"UPDATE workflow_engine_park_outbox SET created_at='2026-09-08T00:00:00Z'",
])
	test(`partial or wrong StateStore park ${sql}`, (t) => {
		assert.equal(
			inspect(
				manifest(),
				fixture(t, (db, comm) => {
					parked(db, comm);
					db.exec(sql);
				}),
			).action,
			"conflict",
		);
	});
for (const sql of [
	"DELETE FROM workflow_engine_park",
	"UPDATE workflow_engine_park SET state='cleared'",
	"UPDATE workflow_engine_park SET source_row_id=2",
	"UPDATE workflow_engine_park SET execution_id='other'",
	"UPDATE workflow_engine_park SET run_id='other'",
	"UPDATE workflow_engine_park SET node_id='qa'",
	"UPDATE workflow_engine_park SET attempt=2",
	"UPDATE workflow_engine_park SET reason='other'",
])
	test(`partial or wrong CommDB park ${sql}`, (t) => {
		assert.equal(
			inspect(
				manifest(),
				fixture(t, (db, comm) => {
					parked(db, comm);
					comm.exec(sql);
				}),
			).action,
			"conflict",
		);
	});
test("newer outbox clear blocks stale open CommDB projection", (t) => {
	const paths = fixture(t, (db, comm) => {
		parked(db, comm);
		db.exec(
			"INSERT INTO workflow_engine_park_outbox(event_id,project_name,execution_id,run_id,node_id,attempt,activation_id,generation,event,reason,created_at) VALUES('clear','p','exec','run','implement',1,'activation',1,'park_cleared','resume','2026-09-09T00:01:30Z')",
		);
	});
	assert.equal(inspect(manifest(), paths).action, "conflict");
});
test("done node without projected park is partial and cannot reexecute", (t) => {
	assert.equal(
		inspect(
			manifest(),
			fixture(t, (db) => db.exec("UPDATE workflow_run_node SET state='done'")),
		).action,
		"conflict",
	);
});
test("newer implementation attempt blocks adoption of earlier park", (t) => {
	assert.equal(
		inspect(
			manifest(),
			fixture(t, (db, comm) => {
				parked(db, comm);
				db.exec(
					"INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id) VALUES('run','implement',2,'running','exec')",
				);
			}),
		).action,
		"conflict",
	);
});
for (const table of [
	"sessions",
	"workflow_run",
	"workflow_run_node",
	"workflow_engine_park_outbox",
])
	test(`missing table ${table} fails closed`, (t) => {
		assert.equal(
			inspect(
				manifest(),
				fixture(t, (db) => db.exec(`DROP TABLE ${table}`)),
			).action,
			"conflict",
		);
	});
test("missing CommDB park table fails closed", (t) => {
	assert.equal(
		inspect(
			manifest(),
			fixture(t, (db, comm) => comm.exec("DROP TABLE workflow_engine_park")),
		).action,
		"conflict",
	);
});
for (const key of ["dbPath", "commPath"])
	test(`stale ${key} cannot replay`, (t) => {
		const paths = fixture(t, parked),
			path = paths[key];
		const meta = JSON.parse(readFileSync(`${path}.meta.json`));
		meta.observedAt = createdAt;
		writeFileSync(`${path}.meta.json`, JSON.stringify(meta));
		assert.equal(inspect(manifest(), paths).action, "conflict");
	});
test("changed manifest body key conflicts", (t) => {
	const m = manifest();
	m.steps.step.intent.clientRequestId = "other";
	assert.equal(inspect(m, fixture(t, parked)).action, "conflict");
});

test("spawn-cleared park projection permits first complete (#12)", (t) => {
	const paths = fixture(t, (db, comm) => {
		parked(db, comm);
		db.exec(
			"UPDATE sessions SET status='running';UPDATE workflow_run_node SET state='running';UPDATE workflow_engine_park_outbox SET event='park_cleared',reason='activation_spawn_admitted'",
		);
		comm.exec(
			"UPDATE workflow_engine_park SET state='cleared',reason='activation_spawn_admitted'",
		);
	});
	assert.deepEqual(inspect(manifest(), paths), { action: "execute" });
});
