import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAILBOX_SCHEMA } from "../../packages/flywheel-comm/src/mailbox-schema.ts";
import { activationParse, campaignShape } from "../lib/qa-fly-2456-shape.mjs";

const require = createRequire(
	new URL("../../packages/flywheel-comm/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
const bodies = { B1: "exec-B1", B2: "exec-B2", B3: "exec-B3" };
function stamp(path) {
	writeFileSync(
		`${path}.meta.json`,
		JSON.stringify({
			observedAt: new Date().toISOString(),
			sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
		}),
	);
}
function fixture(t, mutate = () => {}) {
	const dir = mkdtempSync(join(tmpdir(), "fly2456-shape-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const dbPath = join(dir, "teamlead.db"),
		commPath = join(dir, "comm.db"),
		livenessPath = join(dir, "liveness.json");
	const db = new Database(dbPath),
		comm = new Database(commPath);
	db.pragma("foreign_keys=OFF");
	const source = readFileSync(
		new URL("../../packages/teamlead/src/StateStore.ts", import.meta.url),
		"utf8",
	);
	for (const name of [
		"sessions",
		"workflow_execution_binding",
		"workflow_run",
		"workflow_run_node",
	])
		db.exec(
			source.match(
				new RegExp(
					`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\t\\t\\t\\)`,
				),
			)[0],
		);
	db.exec("ALTER TABLE sessions ADD COLUMN adapter_type TEXT");
	const commSource = readFileSync(
		new URL("../../packages/flywheel-comm/src/db.ts", import.meta.url),
		"utf8",
	);
	comm.exec(MAILBOX_SCHEMA);
	comm.exec(
		commSource.match(
			/CREATE TABLE IF NOT EXISTS three_stage_turn \([\s\S]*?\n\);/,
		)[0],
	);
	const liveness = [];
	for (const [label, executionId] of Object.entries(bodies)) {
		const issue = `FLY-${label.slice(1)}`,
			run = `run-${label}`,
			parked = label === "B3";
		db.prepare(
			"INSERT INTO sessions(execution_id,issue_id,project_name,status,adapter_type) VALUES(?,?,?,?,?)",
		).run(
			executionId,
			issue,
			"test-slot-4",
			parked ? "ship_parked" : "running",
			"codex-tmux",
		);
		db.prepare(
			"INSERT INTO workflow_run(run_id,issue_id,project_name,status) VALUES(?,?,?,?)",
		).run(run, issue, "test-slot-4", "active");
		for (let attempt = 1; attempt <= (label === "B1" ? 2 : 1); attempt++) {
			db.prepare(
				"INSERT INTO workflow_execution_binding(activation_id,execution_id,run_id,node_id,attempt,mode,bound_at) VALUES(?,?,?,?,?,?,?)",
			).run(
				`activation-${label}-${attempt}`,
				executionId,
				run,
				"implement",
				attempt,
				attempt === 1 ? "spawn" : "wake",
				"2026-09-10T00:00:00Z",
			);
			db.prepare(
				"INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id) VALUES(?,?,?,?,?)",
			).run(
				run,
				"implement",
				attempt,
				parked ? "done" : "running",
				executionId,
			);
		}
		comm
			.prepare(
				"INSERT INTO three_stage_turn(issue_id,holder_exec_id,phase,epoch,granted_at,target_run_id) VALUES(?,?,?,?,?,?)",
			)
			.run(
				issue,
				parked ? "qa-exec" : executionId,
				parked ? "qa" : "implement",
				1,
				1,
				run,
			);
		if (!parked) {
			comm
				.prepare(
					"INSERT INTO mailbox_identity(id,delivery_id,insert_projection_hash) VALUES(?,?,?)",
				)
				.run(`gate-${label}`, `delivery-${label}`, "hash");
			comm
				.prepare(
					"INSERT INTO mailbox(id,delivery_id,from_agent,to_agent,recipient_kind,type,content,created_at,checkpoint,relay_state) VALUES(?,?,?,?,'lead','question',?,'2026-09-10T00:00:00Z','question','open')",
				)
				.run(
					`gate-${label}`,
					`delivery-${label}`,
					executionId,
					"flywheel-test-4",
					"FLY-2456 drill hold",
				);
		}
		liveness.push({
			executionId,
			verdict: "alive",
			socketPath: `/tmp/flywheel-test-slot-4/state/cdx-sock/${createHash("sha1").update(executionId).digest("hex").slice(0, 16)}.sock`,
			persistedPgidBefore: 123,
			persistedPgidAfter: 123,
			groupState: "alive",
			holderPids: [{ pid: 124, pgid: 123 }],
		});
	}
	mutate({ db, comm, liveness });
	db.close();
	comm.close();
	stamp(dbPath);
	stamp(commPath);
	writeFileSync(livenessPath, JSON.stringify(liveness));
	return { dbPath, commPath, livenessPath, bodies };
}
test("general activation parser describes multiple activations and current node without selecting a legacy single binding", (t) => {
	const f = fixture(t);
	const result = activationParse(f.dbPath, bodies.B1);
	assert.equal(result.status, "pass");
	assert.deepEqual(
		result.bindings.map((x) => [x.attempt, x.mode]),
		[
			[1, "spawn"],
			[2, "wake"],
		],
	);
	assert.equal(result.latestNodes[0].attempt, 2);
	assert.equal(result.latestNodes[0].execution_id, bodies.B1);
});
test("campaign accepts exact multi/single/parked shapes with live ownership and open holder gates", (t) => {
	const result = campaignShape(fixture(t));
	assert.equal(result.status, "pass", JSON.stringify(result));
	assert.deepEqual(result.failures, []);
});
const negatives = [
	[
		"B1 only spawn",
		({ db }) =>
			db.exec(
				"DELETE FROM workflow_execution_binding WHERE execution_id='exec-B1' AND attempt=2",
			),
	],
	[
		"B1 replacement plus two wakes",
		({ db }) => {
			db.exec(
				"UPDATE workflow_execution_binding SET mode='replacement' WHERE execution_id='exec-B1' AND attempt=1",
			);
			db.exec(
				"INSERT INTO workflow_execution_binding VALUES('activation-B1-3','exec-B1','run-B1','implement',3,'wake',null,'2026-09-10T00:01:00Z')",
			);
			db.exec(
				"INSERT INTO workflow_run_node(run_id,node_id,attempt,state,execution_id) VALUES('run-B1','implement',3,'running','exec-B1')",
			);
		},
	],
	[
		"latest node points to another execution",
		({ db }) =>
			db.exec(
				"UPDATE workflow_run_node SET execution_id='other' WHERE run_id='run-B1' AND attempt=2",
			),
	],
	[
		"B1 gate terminal disposed",
		({ comm }) =>
			comm.exec(
				"UPDATE mailbox SET relay_state='terminal_disposed' WHERE id='gate-B1'",
			),
	],
	[
		"B2 gate superseded",
		({ comm }) =>
			comm.exec(
				"UPDATE mailbox SET superseded_at='2026-09-10T00:01:00Z' WHERE id='gate-B2'",
			),
	],
	[
		"B3 remains holder",
		({ comm }) =>
			comm.exec(
				"UPDATE three_stage_turn SET holder_exec_id='exec-B3' WHERE issue_id='FLY-3'",
			),
	],
	[
		"B1 has lost holder",
		({ comm }) =>
			comm.exec(
				"UPDATE three_stage_turn SET holder_exec_id='other' WHERE issue_id='FLY-1'",
			),
	],
	[
		"B2 not running",
		({ db }) =>
			db.exec(
				"UPDATE sessions SET status='failed' WHERE execution_id='exec-B2'",
			),
	],
	[
		"B1 run held",
		({ db }) =>
			db.exec("UPDATE workflow_run SET status='held' WHERE run_id='run-B1'"),
	],
	[
		"B2 adapter not Codex",
		({ db }) =>
			db.exec(
				"UPDATE sessions SET adapter_type='claude' WHERE execution_id='exec-B2'",
			),
	],
	[
		"B2 lacks binding",
		({ db }) =>
			db.exec(
				"DELETE FROM workflow_execution_binding WHERE execution_id='exec-B2'",
			),
	],
	[
		"B1 holder wrong PGID",
		({ liveness }) => {
			liveness[0].holderPids[0].pgid = 999;
		},
	],
	[
		"B1 PGID changed during probe",
		({ liveness }) => {
			liveness[0].persistedPgidAfter = 999;
		},
	],
	[
		"B2 holder evidence missing",
		({ liveness }) => {
			delete liveness[1].holderPids;
		},
	],
	[
		"B3 unknown probe",
		({ liveness }) => {
			liveness[2].verdict = "unknown";
		},
	],
	[
		"B2 group absent despite alive verdict",
		({ liveness }) => {
			liveness[1].groupState = "absent";
		},
	],
	[
		"B1 nonpositive PGID",
		({ liveness }) => {
			liveness[0].persistedPgidBefore = 0;
			liveness[0].persistedPgidAfter = 0;
			liveness[0].holderPids[0].pgid = 0;
		},
	],
	[
		"B1 init PGID is not a daemon",
		({ liveness }) => {
			liveness[0].persistedPgidBefore = 1;
			liveness[0].persistedPgidAfter = 1;
			liveness[0].holderPids[0].pgid = 1;
		},
	],
];
for (const [name, mutate] of negatives)
	test(`campaign rejects ${name}`, (t) => {
		const result = campaignShape(fixture(t, mutate));
		assert.equal(result.status, "fail", JSON.stringify(result));
		assert.ok(result.failures.length > 0);
	});
test("general parser accepts replacement/wake/wake while campaign rejects it", (t) => {
	const f = fixture(t, negatives[1][1]);
	const result = activationParse(f.dbPath, bodies.B1);
	assert.equal(result.status, "pass");
	assert.deepEqual(
		result.bindings.map((x) => x.mode),
		["replacement", "wake", "wake"],
	);
	assert.equal(campaignShape(f).status, "fail");
});
test("campaign fails closed on missing schema and duplicate body identities", (t) => {
	const f = fixture(t, ({ db }) => db.exec("DROP TABLE workflow_run_node"));
	assert.equal(campaignShape(f).status, "fail");
	const good = fixture(t);
	assert.equal(
		campaignShape({ ...good, bodies: { ...bodies, B2: bodies.B1 } }).status,
		"fail",
	);
});
test("unbound activation cannot hide a missing latest-node schema", (t) => {
	const f = fixture(t, ({ db }) => db.exec("DROP TABLE workflow_run_node"));
	assert.equal(activationParse(f.dbPath, "unbound-exec").status, "fail");
});
