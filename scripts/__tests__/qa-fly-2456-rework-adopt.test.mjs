import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inspectAdoption } from "../lib/qa-fly-2456-adopt.mjs";
import { inspectReworkAdoption } from "../lib/qa-fly-2456-rework-adopt.mjs";

test("main adoption dispatcher preserves QA authority outcome", (t) => {
	const paths = fixture(t, (db) => effect(db));
	assert.equal(
		inspectAdoption({ ...paths, manifest: manifest(), step: "step", now })
			.action,
		"adopt-existing",
	);
});

const require = createRequire(
	new URL("../../packages/flywheel-comm/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
const createdAt = "2026-09-09T00:00:00Z",
	observedAt = "2026-09-09T00:02:00Z",
	now = Date.parse("2026-09-09T00:03:00Z");
const result = {
	requestId: "request",
	runId: "run",
	targetNodeId: "implement",
	targetAttempt: 2,
	preferredActorExecutionId: "b1",
	routeRevision: 1,
	state: "wake_delivered",
};
function manifest(kind = "qa-fail") {
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
						kind,
						label: "B1",
						issueId: "FLY-1",
						runId: "run",
						qaExecutionId: "qa",
						preferredActorExecutionId: "b1",
						targetNodeId: "implement",
						targetAttempt: 2,
						actor: "lead",
						leadFeedback: "redo",
						founderQuote: null,
						principal: "operator",
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
	const dir = mkdtempSync(join(tmpdir(), "fly2456-rework-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const dbPath = join(dir, "state.db"),
		commPath = join(dir, "comm.db");
	const db = new Database(dbPath),
		comm = new Database(commPath);
	db.pragma("foreign_keys=OFF");
	const source = readFileSync(
		new URL("../../packages/teamlead/src/StateStore.ts", import.meta.url),
		"utf8",
	);
	for (const table of [
		"workflow_run",
		"workflow_run_event",
		"workflow_submission_credential",
		"workflow_rework_request",
		"workflow_rework_route_revision",
		"workflow_rework_delivery",
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
			/CREATE TABLE IF NOT EXISTS runner_workflow_activation \([\s\S]*?\n\);/,
		)[0],
	);
	db.exec(
		"INSERT INTO workflow_run(run_id,issue_id,project_name) VALUES('run','FLY-1','p')",
	);
	comm
		.prepare(
			"INSERT INTO runner_workflow_activation(execution_id,epoch,activation_id,run_id,node_id,attempt,submission_credential,context_json,context_digest,created_at) VALUES('qa',1,'activation','run','qa',1,'secret-credential','{}','digest',1)",
		)
		.run();
	db.prepare(
		"INSERT INTO workflow_submission_credential(activation_id,credential_hash,run_id,node_id,execution_id,attempt,family,issued_at,expires_at,absolute_deadline_at) VALUES('activation',?,'run','qa','qa',1,'qa_verdict',?,'2026-09-10T00:00:00Z','2026-09-10T00:00:00Z')",
	).run(
		createHash("sha256").update("secret-credential").digest("hex"),
		createdAt,
	);
	change(db, comm);
	db.close();
	comm.close();
	stamp(dbPath);
	stamp(commPath);
	return { dbPath, commPath, now };
}
function effect(
	db,
	{
		operator = false,
		state = "wake_delivered",
		consumed = true,
		actor = "b1",
		attempt = 2,
	} = {},
) {
	if (consumed)
		db.exec(
			"UPDATE workflow_submission_credential SET consumed_at='2026-09-09T00:01:00Z',consumed_client_request_id='random-qa',consumed_submission_digest='digest'",
		);
	db.prepare(
		"INSERT INTO workflow_rework_request(request_id,run_id,source_event_id,authority,source_node_id,source_attempt,base_revision,authority_context_json,authority_context_digest,actor_id,founder_quote_json,lead_feedback,requested_at) VALUES('request','run',?,?,'qa',1,'base','{}','digest',?,?,?,'2026-09-09T00:01:00Z')",
	).run(
		operator ? "operator_rework:run:client" : "workflow_transition:digest",
		operator ? "lead" : "qa",
		operator ? "lead" : null,
		operator ? "null" : null,
		operator ? "redo" : null,
	);
	db.prepare(
		"INSERT INTO workflow_rework_route_revision VALUES('request',1,'implement',?,?,'[]','[]','engine','reason','2026-09-09T00:01:00Z')",
	).run(attempt, actor);
	db.prepare(
		"INSERT INTO workflow_rework_delivery(request_id,route_revision,state,updated_at) VALUES('request',1,?,'2026-09-09T00:01:00Z')",
	).run(state);
	if (operator)
		db.prepare(
			"INSERT INTO workflow_run_event(run_id,seq,event_uid,kind,node_id,execution_id,payload,at) VALUES('run',1,'operator_rework:run:client','operator_rework_requested','implement','b1',?,'2026-09-09T00:01:00Z')",
		).run(
			JSON.stringify({
				requestId: "request",
				targetNodeId: "implement",
				targetAttempt: 2,
				preferredActorExecutionId: "b1",
				authority: "lead",
				actor: "lead",
				founder_quote: null,
				lead_feedback: "redo",
				feedback: "redo",
				principal: "operator",
			}),
		);
}
function inspect(m, paths) {
	return inspectReworkAdoption({ manifest: m, step: "step", ...paths });
}
test("consumed QA credential plus exact delivered request adopts without exposing credential", (t) => {
	const output = inspect(
		manifest(),
		fixture(t, (db) => effect(db)),
	);
	assert.deepEqual(output, { action: "adopt-existing", result });
	assert.ok(!JSON.stringify(output).includes("secret-credential"));
});
test("matching receipt replays only after authority validation", (t) => {
	const m = manifest();
	m.steps.step.receipt = { result };
	assert.deepEqual(
		inspect(
			m,
			fixture(t, (db) => effect(db)),
		),
		{ action: "replay", result },
	);
});
test("conflicting receipt remains unchanged", (t) => {
	const m = manifest();
	m.steps.step.receipt = { result: { ...result, requestId: "wrong" } };
	const original = structuredClone(m);
	assert.equal(
		inspect(
			m,
			fixture(t, (db) => effect(db)),
		).action,
		"conflict",
	);
	assert.deepEqual(m, original);
});
test("unconsumed credential with no request permits execute", (t) => {
	assert.deepEqual(inspect(manifest(), fixture(t)), { action: "execute" });
});
test("consumed credential without request fails closed", (t) => {
	assert.equal(
		inspect(
			manifest(),
			fixture(t, (db) =>
				db.exec(
					"UPDATE workflow_submission_credential SET consumed_at='2026-09-09T00:01:00Z'",
				),
			),
		).action,
		"conflict",
	);
});
test("request without consumed credential fails closed", (t) => {
	assert.equal(
		inspect(
			manifest(),
			fixture(t, (db) => effect(db, { consumed: false })),
		).action,
		"conflict",
	);
});
for (const state of [
	"pending",
	"turn_granted",
	"awaiting_receipt",
	"replacement_pending",
	"completed",
	"held",
	"needs_lead",
])
	test(`intermediate or advanced ${state} conflicts`, (t) => {
		assert.equal(
			inspect(
				manifest(),
				fixture(t, (db) => effect(db, { state })),
			).action,
			"conflict",
		);
	});
for (const mutation of [
	"UPDATE workflow_submission_credential SET credential_hash='wrong'",
	"UPDATE workflow_submission_credential SET activation_id='wrong'",
	"UPDATE workflow_submission_credential SET attempt=2",
	"UPDATE workflow_submission_credential SET revoked=1",
	"UPDATE workflow_rework_request SET authority='engine'",
	"UPDATE workflow_rework_request SET source_attempt=2",
	"UPDATE workflow_rework_request SET requested_at='2026-09-08T00:00:00Z'",
	"DELETE FROM workflow_rework_route_revision",
	"DELETE FROM workflow_rework_delivery",
])
	test(`QA identity mismatch ${mutation}`, (t) => {
		assert.equal(
			inspect(
				manifest(),
				fixture(t, (db) => {
					effect(db);
					db.exec(mutation);
				}),
			).action,
			"conflict",
		);
	});
for (const options of [{ actor: "other" }, { attempt: 3 }])
	test(`route target mismatch ${JSON.stringify(options)}`, (t) => {
		assert.equal(
			inspect(
				manifest(),
				fixture(t, (db) => effect(db, options)),
			).action,
			"conflict",
		);
	});
test("ambiguous QA activation refuses execute", (t) => {
	const paths = fixture(t, (_db, comm) =>
		comm.exec(
			"INSERT INTO runner_workflow_activation SELECT execution_id,epoch+1,'activation2',run_id,node_id,attempt,output_credential,submission_credential,context_json,context_digest,created_at FROM runner_workflow_activation",
		),
	);
	assert.equal(inspect(manifest(), paths).action, "conflict");
});
test("operator event binds actual request and route", (t) => {
	assert.deepEqual(
		inspect(
			manifest("operator-rework"),
			fixture(t, (db) => effect(db, { operator: true })),
		),
		{ action: "adopt-existing", result },
	);
});
test("operator missing event and missing request permits execute", (t) => {
	assert.deepEqual(inspect(manifest("operator-rework"), fixture(t)), {
		action: "execute",
	});
});
for (const field of [
	"targetNodeId",
	"targetAttempt",
	"preferredActorExecutionId",
	"actor",
	"lead_feedback",
	"founder_quote",
	"principal",
])
	test(`operator payload mismatch ${field}`, (t) => {
		const paths = fixture(t, (db) => {
			effect(db, { operator: true });
			const p = JSON.parse(
				db.prepare("SELECT payload FROM workflow_run_event").get().payload,
			);
			p[field] = "wrong";
			db.prepare("UPDATE workflow_run_event SET payload=?").run(
				JSON.stringify(p),
			);
		});
		assert.equal(
			inspect(manifest("operator-rework"), paths).action,
			"conflict",
		);
	});
test("operator missing event with existing request conflicts", (t) => {
	assert.equal(
		inspect(
			manifest("operator-rework"),
			fixture(t, (db) => {
				effect(db, { operator: true });
				db.exec("DELETE FROM workflow_run_event");
			}),
		).action,
		"conflict",
	);
});
for (const table of [
	"workflow_rework_request",
	"workflow_rework_route_revision",
	"workflow_rework_delivery",
	"workflow_submission_credential",
])
	test(`missing authority table ${table} conflicts`, (t) => {
		assert.equal(
			inspect(
				manifest(),
				fixture(t, (db) => db.exec(`DROP TABLE ${table}`)),
			).action,
			"conflict",
		);
	});
test("changed manifest client id fails closed", (t) => {
	const m = manifest();
	m.steps.step.intent.clientRequestId = "changed";
	assert.equal(
		inspect(
			m,
			fixture(t, (db) => effect(db)),
		).action,
		"conflict",
	);
});
test("stale comm snapshot cannot permit replay or execution", (t) => {
	const paths = fixture(t);
	const meta = JSON.parse(readFileSync(`${paths.commPath}.meta.json`));
	meta.observedAt = createdAt;
	writeFileSync(`${paths.commPath}.meta.json`, JSON.stringify(meta));
	assert.equal(inspect(manifest(), paths).action, "conflict");
});
test("missing intent timestamp cannot bypass snapshot freshness", (t) => {
	const m = manifest();
	delete m.steps.step.intent.createdAt;
	assert.equal(
		inspect(
			m,
			fixture(t, (db) => effect(db)),
		).action,
		"conflict",
	);
});
for (const mutation of [
	"UPDATE workflow_submission_credential SET consumed_at='2026-09-09T00:10:00Z'",
	"UPDATE workflow_rework_request SET requested_at='2026-09-09T00:10:00Z'",
])
	test(`future effect time conflicts ${mutation}`, (t) => {
		assert.equal(
			inspect(
				manifest(),
				fixture(t, (db) => {
					effect(db);
					db.exec(mutation);
				}),
			).action,
			"conflict",
		);
	});
test("BLOB credential identity cannot silently permit execute", (t) => {
	const paths = fixture(t, (db) =>
		db
			.prepare("UPDATE workflow_submission_credential SET activation_id=?")
			.run(Buffer.from("activation")),
	);
	assert.equal(inspect(manifest(), paths).action, "conflict");
});
test("operator malformed payload fails closed", (t) => {
	assert.equal(
		inspect(
			manifest("operator-rework"),
			fixture(t, (db) => {
				effect(db, { operator: true });
				db.exec("UPDATE workflow_run_event SET payload='not-json'");
			}),
		).action,
		"conflict",
	);
});
test("operator receipt matches normalized authority", (t) => {
	const m = manifest("operator-rework");
	m.steps.step.receipt = { result };
	assert.deepEqual(
		inspect(
			m,
			fixture(t, (db) => effect(db, { operator: true })),
		),
		{ action: "replay", result },
	);
});
for (const direction of ["event-only", "intent-only"])
	test(`operator unsolicited or missing escalation acknowledgement ${direction} conflicts`, (t) => {
		const m = manifest("operator-rework");
		const ack = {
			holdEventUid: "hold",
			holdReceiptDigest: "a".repeat(64),
			decision: "continue",
		};
		if (direction === "intent-only")
			m.steps.step.intent.detail.escalationAck = ack;
		const paths = fixture(t, (db) => {
			effect(db, { operator: true });
			if (direction === "event-only") {
				const row = db.prepare("SELECT payload FROM workflow_run_event").get();
				const p = JSON.parse(row.payload);
				p.escalationAck = ack;
				db.prepare("UPDATE workflow_run_event SET payload=?").run(
					JSON.stringify(p),
				);
			}
		});
		assert.equal(inspect(m, paths).action, "conflict");
	});
for (const permanent of [0, 1, 2])
	test(`QA expired credential permanent=${permanent}`, (t) => {
		const paths = fixture(t, (db) =>
			db
				.prepare(
					"UPDATE workflow_submission_credential SET permanent=?,expires_at='2026-09-08T00:00:00Z'",
				)
				.run(permanent),
		);
		assert.equal(
			inspect(manifest(), paths).action,
			permanent === 1 ? "execute" : "conflict",
		);
	});
test("operator payload evidence digest cannot pass without expected identity digest", (t) => {
	const paths = fixture(t, (db) => {
		effect(db, { operator: true });
		const p = JSON.parse(
			db.prepare("SELECT payload FROM workflow_run_event").get().payload,
		);
		p.founderAuthorEvidenceIdentityDigest = "unexpected";
		db.prepare("UPDATE workflow_run_event SET payload=?").run(
			JSON.stringify(p),
		);
	});
	assert.equal(inspect(manifest("operator-rework"), paths).action, "conflict");
});
