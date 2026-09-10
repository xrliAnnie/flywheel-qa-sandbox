import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAILBOX_SCHEMA } from "../../packages/flywheel-comm/src/mailbox-schema.ts";
import { inspectAdoption } from "../lib/qa-fly-2456-adopt.mjs";
import { openSnapshot } from "../lib/qa-fly-2456-db.mjs";

test("PRE start uses its separately persisted request identity", (t) => {
	const path = fixture(t, (db) => start(db)),
		m = manifest();
	m.auxiliaryBodies = { PRE: { ...m.bodies.B1 } };
	m.steps.step.intent.detail.label = "PRE";
	assert.equal(inspect(m, path).action, "adopt-existing");
});

const require = createRequire(
	new URL("../../packages/flywheel-comm/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
const now = Date.parse("2026-09-09T00:10:00Z");
const observedAt = "2026-09-09T00:09:00Z";
const createdAt = "2026-09-09T00:08:00Z";
const response = {
	success: true,
	generalized: true,
	executionId: "exec",
	workflowRunId: "run",
	workflowNodeId: "node",
	issueId: "FLY-1",
};
function manifest(kind = "start") {
	return {
		config: { slot: 4, issues: { B1: "FLY-1" } },
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
						kind,
						label: "B1",
						issueId: "FLY-1",
						selectionDigest: "digest",
						executionId: "exec",
						workflowRunId: "run",
						workflowNodeId: "node",
						attempt: 1,
						checkpoint: "hold",
					},
				},
			},
		},
	};
}
function stamp(path, when = observedAt) {
	writeFileSync(
		`${path}.meta.json`,
		JSON.stringify({
			observedAt: when,
			sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
		}),
	);
}
function fixture(t, change = () => {}, kind = "start") {
	const dir = mkdtempSync(join(tmpdir(), "fly2456-adopt-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "snapshot.db");
	const db = new Database(path);
	if (kind === "gate") db.exec(MAILBOX_SCHEMA);
	else {
		const source = readFileSync(
			new URL("../../packages/teamlead/src/StateStore.ts", import.meta.url),
			"utf8",
		);
		for (const table of [
			"workflow_run",
			"workflow_run_issue_alias",
			"workflow_start_reservation",
			"workflow_start_stage",
			"workflow_start_response",
		])
			db.exec(
				source.match(
					new RegExp(
						`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\t\\t\\t\\)`,
					),
				)[0],
			);
	}
	change(db);
	db.close();
	stamp(path);
	return path;
}
function start(
	db,
	{
		stage = "responded",
		key = "key",
		digest = "digest",
		result = response,
		issue = "FLY-1",
	} = {},
) {
	db.prepare(
		"INSERT INTO workflow_run(run_id,issue_id,project_name) VALUES('run',?,'p')",
	).run(issue);
	db.prepare(
		"INSERT INTO workflow_start_reservation VALUES(?,?,'run','node',1,'exec',?)",
	).run(key, digest, createdAt);
	if (stage !== null)
		db.prepare("INSERT INTO workflow_start_stage VALUES(?,?,?)").run(
			key,
			stage,
			observedAt,
		);
	if (result !== null)
		db.prepare("INSERT INTO workflow_start_response VALUES(?,?,?)").run(
			key,
			JSON.stringify(result),
			observedAt,
		);
}
function inspect(m, path) {
	return inspectAdoption({
		manifest: m,
		step: "step",
		dbPath: path,
		commPath: path,
		now,
	});
}
test("fresh hash-verified snapshot opens immutable readonly bytes", (t) => {
	const path = fixture(t);
	const opened = openSnapshot(path, {
		after: createdAt,
		now,
		maxAgeMs: 600000,
	});
	try {
		assert.equal(opened.metadata.observedAt, observedAt);
		assert.throws(() => opened.db.exec("CREATE TABLE forbidden(x)"));
	} finally {
		opened.db.close();
	}
});
test("checkpointed WAL snapshot opens readonly without changing original bytes or hash", (t) => {
	const path = fixture(t, (db) => {
		assert.equal(db.pragma("journal_mode = WAL", { simple: true }), "wal");
		start(db);
		db.pragma("wal_checkpoint(TRUNCATE)");
	});
	const original = readFileSync(path);
	assert.deepEqual([...original.subarray(18, 20)], [2, 2]);
	const sha256 = createHash("sha256").update(original).digest("hex");
	const opened = openSnapshot(path, { now });
	try {
		assert.equal(opened.metadata.sha256, sha256);
		assert.equal(
			opened.db.prepare("SELECT stage FROM workflow_start_stage").get().stage,
			"responded",
		);
		assert.throws(() => opened.db.exec("DELETE FROM workflow_start_stage"));
	} finally {
		opened.db.close();
	}
	assert.deepEqual(readFileSync(path), original);
	const normalized = Buffer.from(original);
	normalized[18] = normalized[19] = 1;
	writeFileSync(
		`${path}.meta.json`,
		JSON.stringify({
			observedAt,
			sha256: createHash("sha256").update(normalized).digest("hex"),
		}),
	);
	assert.throws(() => openSnapshot(path, { now }), /snapshot hash invalid/);
});
for (const when of [
	createdAt,
	"2026-09-09T00:07:00Z",
	"2026-09-09T00:11:00Z",
	"2026-09-08T23:59:00Z",
	"bad",
])
	test(`snapshot rejects invalid freshness ${when}`, (t) => {
		const path = fixture(t);
		stamp(path, when);
		assert.throws(() =>
			openSnapshot(path, { after: createdAt, now, maxAgeMs: 600000 }),
		);
	});
for (const mutation of ["hash", "meta", "wal", "shm"])
	test(`snapshot rejects ${mutation}`, (t) => {
		const path = fixture(t);
		if (mutation === "hash") writeFileSync(path, "changed");
		else if (mutation === "meta") rmSync(`${path}.meta.json`);
		else writeFileSync(`${path}-${mutation}`, "bytes");
		assert.throws(() =>
			openSnapshot(path, { after: createdAt, now, maxAgeMs: 600000 }),
		);
	});
test("snapshot age alone rejects old capture even after earlier intent", (t) => {
	const path = fixture(t);
	stamp(path, "2026-09-08T23:59:59Z");
	assert.throws(() =>
		openSnapshot(path, {
			after: "2026-09-08T23:00:00Z",
			now,
			maxAgeMs: 600000,
		}),
	);
});
test("responded start adopts normalized actual API response", (t) => {
	assert.deepEqual(
		inspect(
			manifest(),
			fixture(t, (db) => start(db)),
		),
		{ action: "adopt-existing", result: response },
	);
});
test("matching receipt replays only with matching authority and ignores optional API extras", (t) => {
	const m = manifest();
	m.steps.step.receipt = {
		result: { ...response, resolved: { nodeModels: [] } },
	};
	assert.deepEqual(
		inspect(
			m,
			fixture(t, (db) =>
				start(db, { result: { ...response, workKind: { category: "code" } } }),
			),
		),
		{ action: "replay", result: response },
	);
});
test("receipt alone cannot prove start", (t) => {
	const m = manifest();
	m.steps.step.receipt = { result: response };
	const result = inspect(m, fixture(t));
	assert.equal(result.action, "conflict");
	assert.equal(result.reason, "receipt_authority_conflict");
});
test("receipt mismatch preserves receipt and conflicts", (t) => {
	const m = manifest();
	m.steps.step.receipt = { result: { ...response, executionId: "wrong" } };
	const original = structuredClone(m);
	assert.equal(
		inspect(
			m,
			fixture(t, (db) => start(db)),
		).reason,
		"receipt_authority_conflict",
	);
	assert.deepEqual(m, original);
});
test("no matching effect and no issue conflict executes", (t) => {
	assert.deepEqual(inspect(manifest(), fixture(t)), { action: "execute" });
});
for (const stage of [
	"materialized",
	"admitted",
	"commdb_registered",
	"launch_committed",
	null,
])
	test(`start stage ${stage} conflicts`, (t) => {
		assert.equal(
			inspect(
				manifest(),
				fixture(t, (db) => start(db, { stage })),
			).reason,
			"start_incomplete",
		);
	});
for (const [label, options] of [
	["digest", { digest: "wrong" }],
	["response missing", { result: null }],
	["response unsuccessful", { result: { ...response, success: false } }],
	["response execution", { result: { ...response, executionId: "wrong" } }],
	["response run", { result: { ...response, workflowRunId: "wrong" } }],
	["response node", { result: { ...response, workflowNodeId: "wrong" } }],
	["response issue", { result: { ...response, issueId: "FLY-2" } }],
	["run issue", { issue: "FLY-2" }],
])
	test(`start rejects ${label}`, (t) => {
		const result = inspect(
			manifest(),
			fixture(t, (db) => start(db, options)),
		);
		assert.equal(result.action, "conflict");
		assert.ok(result.reason);
	});
for (const [field, value] of [
	["executionId", "other"],
	["workflowRunId", "other"],
	["workflowNodeId", "other"],
	["attempt", 2],
])
	test(`start intent ${field} mismatch`, (t) => {
		const m = manifest();
		m.steps.step.intent.detail[field] = value;
		assert.equal(
			inspect(
				m,
				fixture(t, (db) => start(db)),
			).action,
			"conflict",
		);
	});
test("different key reservation on same issue conflicts", (t) => {
	assert.equal(
		inspect(
			manifest(),
			fixture(t, (db) => start(db, { key: "other" })),
		).reason,
		"issue_start_conflict",
	);
});
test("active same-issue run without reservation conflicts", (t) => {
	assert.equal(
		inspect(
			manifest(),
			fixture(t, (db) =>
				db.exec(
					"INSERT INTO workflow_run(run_id,issue_id,project_name) VALUES('other','FLY-1','p')",
				),
			),
		).reason,
		"issue_start_conflict",
	);
});
test("changed intent key against body fails closed", (t) => {
	const m = manifest();
	m.steps.step.intent.idempotencyKey = "wrong";
	assert.equal(inspect(m, fixture(t)).reason, "manifest_identity_conflict");
});
test("unknown kind conflicts", (t) => {
	assert.equal(
		inspect(manifest("cancel"), fixture(t)).reason,
		"kind_unsupported",
	);
});
test("stale authority fails closed even with receipt", (t) => {
	const path = fixture(t, (db) => start(db));
	stamp(path, createdAt);
	const m = manifest();
	m.steps.step.receipt = { result: response };
	assert.equal(inspect(m, path).reason, "snapshot_or_schema_invalid");
});
function gate(
	db,
	{
		id = "q",
		owner = "exec",
		recipient = "flywheel-test-4",
		content = "FLY-2456 drill hold",
		checkpoint = "hold",
		relay = "open",
		superseded = null,
		type = "question",
		parent = null,
	} = {},
) {
	db.prepare(
		"INSERT INTO mailbox_identity(id,delivery_id,insert_projection_hash) VALUES(?,?,?)",
	).run(id, `delivery-${id}`, "hash");
	db.prepare(
		"INSERT INTO mailbox(id,delivery_id,from_agent,to_agent,recipient_kind,type,content,checkpoint,relay_state,superseded_at,ref_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(
		id,
		`delivery-${id}`,
		owner,
		recipient,
		"lead",
		type,
		content,
		checkpoint,
		relay,
		superseded,
		parent,
		observedAt,
	);
}
test("one matching open gate adopts question id", (t) => {
	assert.deepEqual(
		inspect(
			manifest("gate"),
			fixture(t, (db) => gate(db), "gate"),
		),
		{ action: "adopt-existing", result: { questionId: "q" } },
	);
});
test("no open gate executes", (t) => {
	assert.deepEqual(inspect(manifest("gate"), fixture(t, undefined, "gate")), {
		action: "execute",
	});
});
test("matching gate receipt replays", (t) => {
	const m = manifest("gate");
	m.steps.step.receipt = { result: { questionId: "q" } };
	assert.deepEqual(
		inspect(
			m,
			fixture(t, (db) => gate(db), "gate"),
		),
		{ action: "replay", result: { questionId: "q" } },
	);
});
test("wrong gate receipt conflicts without mutation", (t) => {
	const m = manifest("gate");
	m.steps.step.receipt = { result: { questionId: "other" } };
	const original = structuredClone(m);
	assert.equal(
		inspect(
			m,
			fixture(t, (db) => gate(db), "gate"),
		).reason,
		"receipt_authority_conflict",
	);
	assert.deepEqual(m, original);
});
for (const options of [
	{ relay: "terminal_disposed" },
	{ superseded: observedAt },
	{ owner: "other" },
	{ checkpoint: null },
	{ type: "report" },
])
	test(`excluded gate ${JSON.stringify(options)} allows execute`, (t) => {
		assert.deepEqual(
			inspect(
				manifest("gate"),
				fixture(t, (db) => gate(db, options), "gate"),
			),
			{ action: "execute" },
		);
	});
test("responded gate excluded even when response has terminal relay", (t) => {
	assert.deepEqual(
		inspect(
			manifest("gate"),
			fixture(
				t,
				(db) => {
					gate(db);
					gate(db, {
						id: "response",
						owner: "lead",
						type: "response",
						parent: "q",
						relay: "terminal_disposed",
					});
				},
				"gate",
			),
		),
		{ action: "execute" },
	);
});
for (const options of [
	{ recipient: "flywheel-test-1" },
	{ content: "wrong" },
	{ checkpoint: "wrong" },
])
	test(`nonmatching open gate conflicts ${JSON.stringify(options)}`, (t) => {
		assert.equal(
			inspect(
				manifest("gate"),
				fixture(t, (db) => gate(db, options), "gate"),
			).reason,
			"gate_identity_conflict",
		);
	});
test("multiple open gates conflict", (t) => {
	assert.equal(
		inspect(
			manifest("gate"),
			fixture(
				t,
				(db) => {
					gate(db);
					gate(db, { id: "q2" });
				},
				"gate",
			),
		).reason,
		"gate_ambiguous",
	);
});
test("gate checkpoint defaults to question", (t) => {
	const m = manifest("gate");
	delete m.steps.step.intent.detail.checkpoint;
	assert.equal(
		inspect(
			m,
			fixture(t, (db) => gate(db, { checkpoint: "question" }), "gate"),
		).action,
		"adopt-existing",
	);
});
for (const table of [
	"workflow_run",
	"workflow_start_reservation",
	"workflow_start_stage",
	"workflow_start_response",
])
	test(`missing start authority ${table} conflicts`, (t) => {
		assert.equal(
			inspect(
				manifest(),
				fixture(t, (db) => db.exec(`DROP TABLE ${table}`)),
			).reason,
			"snapshot_or_schema_invalid",
		);
	});
for (const [table, column] of [
	["workflow_start_reservation", "idempotency_key"],
	["workflow_run", "issue_id"],
])
	test(`malformed start storage ${table}.${column} cannot allow execute`, (t) => {
		const path = fixture(t, (db) => {
			start(db);
			db.pragma("foreign_keys = OFF");
			db.prepare(`UPDATE ${table} SET ${column}=?`).run(
				Buffer.from(column === "issue_id" ? "FLY-1" : "key"),
			);
		});
		assert.equal(
			inspect(manifest(), path).reason,
			"snapshot_or_schema_invalid",
		);
	});
for (const [field, value] of [
	["owner", Buffer.from("exec")],
	["owner", "exec\0suffix"],
	["type", Buffer.from("question")],
	["content", Buffer.from("FLY-2456 drill hold")],
])
	test(`malformed gate ${field} storage conflicts`, (t) => {
		const path = fixture(t, (db) => gate(db, { [field]: value }), "gate");
		assert.equal(
			inspect(manifest("gate"), path).reason,
			"snapshot_or_schema_invalid",
		);
	});
test("projection table masquerading as gate view fails closed", (t) => {
	const path = fixture(
		t,
		(db) =>
			db.exec(
				"DROP VIEW mailbox_message_projection; CREATE TABLE mailbox_message_projection(from_agent TEXT,type TEXT,checkpoint TEXT,relay_state TEXT,superseded_at TEXT,parent_id TEXT,id TEXT,created_at TEXT)",
			),
		"gate",
	);
	assert.equal(
		inspect(manifest("gate"), path).reason,
		"snapshot_or_schema_invalid",
	);
});
for (const reservation of [true, false])
	test(`alias-bound existing UUID run conflicts (reservation=${reservation})`, (t) => {
		const path = fixture(t, (db) => {
			if (reservation) start(db, { key: "other", issue: "uuid-issue" });
			else
				db.exec(
					"INSERT INTO workflow_run(run_id,issue_id,project_name) VALUES('run','uuid-issue','p')",
				);
			db.exec("INSERT INTO workflow_run_issue_alias VALUES('run','FLY-1')");
		});
		assert.equal(inspect(manifest(), path).reason, "issue_start_conflict");
	});
test("unrelated UUID run without matching alias allows execute", (t) => {
	const path = fixture(t, (db) => {
		start(db, { key: "other", issue: "uuid-issue" });
		db.exec("INSERT INTO workflow_run_issue_alias VALUES('run','FLY-2')");
	});
	assert.deepEqual(inspect(manifest(), path), { action: "execute" });
});
for (const change of [
	"DROP TABLE workflow_run_issue_alias",
	"DROP TABLE workflow_run_issue_alias; CREATE TABLE workflow_run_issue_alias(run_id TEXT,wrong TEXT)",
])
	test(`alias schema fail closed: ${change}`, (t) => {
		assert.equal(
			inspect(
				manifest(),
				fixture(t, (db) => db.exec(change)),
			).reason,
			"snapshot_or_schema_invalid",
		);
	});
test("alias BLOB storage fails closed", (t) => {
	const path = fixture(t, (db) => {
		start(db, { key: "other", issue: "uuid-issue" });
		db.prepare("INSERT INTO workflow_run_issue_alias VALUES(?,?)").run(
			"run",
			Buffer.from("FLY-1"),
		);
	});
	assert.equal(inspect(manifest(), path).reason, "snapshot_or_schema_invalid");
});
test("same-key adoption retains original request issue identity despite alias", (t) => {
	const path = fixture(t, (db) => {
		start(db, { issue: "uuid-issue" });
		db.exec("INSERT INTO workflow_run_issue_alias VALUES('run','FLY-1')");
	});
	assert.equal(inspect(manifest(), path).reason, "start_identity_conflict");
});
