import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	inspectTerminateAdoption,
	TERMINAL_STATUSES,
} from "../lib/qa-fly-2456-terminate-adopt.mjs";

const require = createRequire(
	new URL("../../packages/flywheel-comm/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
const createdAt = "2026-09-09T00:00:00Z",
	observedAt = "2026-09-09T00:02:00Z",
	now = Date.parse("2026-09-09T00:03:00Z");
function manifest(purpose = "precondition") {
	return {
		steps: {
			step: {
				intent: {
					createdAt,
					detail: {
						kind: "terminate",
						executionId: "exec",
						reason: "drill cleanup",
						purpose,
					},
				},
			},
		},
	};
}
function fixture(t, change = () => {}) {
	const dir = mkdtempSync(join(tmpdir(), "fly2456-terminate-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const dbPath = join(dir, "state.db");
	const db = new Database(dbPath);
	const source = readFileSync(
		new URL("../../packages/teamlead/src/StateStore.ts", import.meta.url),
		"utf8",
	);
	for (const table of ["sessions", "lead_events"])
		db.exec(
			source.match(
				new RegExp(
					`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\t\\t\\t\\)`,
				),
			)[0],
		);
	db.exec(
		"INSERT INTO sessions(execution_id,issue_id,project_name,status) VALUES('exec','issue','project','running')",
	);
	change(db);
	db.close();
	writeFileSync(
		`${dbPath}.meta.json`,
		JSON.stringify({
			observedAt,
			sha256: createHash("sha256").update(readFileSync(dbPath)).digest("hex"),
		}),
	);
	return { dbPath, now };
}
function terminated(
	db,
	{
		at = "2026-09-09 00:01:00",
		reason = "drill cleanup",
		payload = {},
		event = true,
	} = {},
) {
	db.prepare(
		"UPDATE sessions SET status='terminated',terminal_at=?,last_error=?",
	).run(at, reason);
	if (event)
		db.prepare(
			"INSERT INTO lead_events(lead_id,event_id,event_type,payload,created_at) VALUES('lead','action-exec-terminate-1','action_executed',?,?)",
		).run(
			JSON.stringify({
				event_type: "action_executed",
				execution_id: "exec",
				issue_id: "issue",
				project_name: "project",
				status: "terminated",
				action: "terminate",
				action_source_status: "running",
				action_target_status: "terminated",
				action_reason: reason,
				...payload,
			}),
			at,
		);
}
function inspect(m, paths) {
	return inspectTerminateAdoption({ manifest: m, step: "step", ...paths });
}
test("precondition adopts actual terminated action event with reason", (t) => {
	const output = inspect(
		manifest(),
		fixture(t, (db) => terminated(db)),
	);
	assert.equal(output.action, "adopt-existing");
	assert.equal(output.result.noop, false);
	assert.equal(output.result.actionEventId, "action-exec-terminate-1");
});
test("irrecoverable terminal set matches canonical source", () => {
	const source = readFileSync(
		new URL(
			"../../packages/teamlead/src/workflow-ledger-states.ts",
			import.meta.url,
		),
		"utf8",
	);
	const block = source.match(
		/ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES = \[([\s\S]*?)\]/,
	)[1];
	assert.deepEqual(
		TERMINAL_STATUSES,
		[...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]),
	);
});
test("clearly running with no action evidence executes", (t) => {
	assert.deepEqual(inspect(manifest(), fixture(t)), { action: "execute" });
});
for (const status of [
	"completed",
	"failed",
	"terminated",
	"blocked",
	"rejected",
	"deferred",
	"shelved",
])
	test(`QA fallback terminal ${status} is explicit no-op`, (t) => {
		const output = inspect(
			manifest("qa-fallback"),
			fixture(t, (db) =>
				db
					.prepare("UPDATE sessions SET status=?,terminal_at=?")
					.run(status, "2026-09-08T00:00:00Z"),
			),
		);
		assert.equal(output.action, "adopt-existing");
		assert.equal(output.result.noop, true);
		assert.equal(output.result.outcome, "not-executed");
		assert.equal(output.result.status, status);
	});
for (const status of ["completed", "failed"])
	test(`precondition natural ${status} cannot adopt`, (t) => {
		assert.equal(
			inspect(
				manifest(),
				fixture(t, (db) =>
					db
						.prepare("UPDATE sessions SET status=?,terminal_at=?")
						.run(status, "2026-09-08T00:00:00Z"),
				),
			).action,
			"conflict",
		);
	});
for (const options of [
	{ event: false },
	{ reason: "other" },
	{ at: "2026-09-08T00:00:00Z" },
	{ payload: { execution_id: "other" } },
	{ payload: { action: "approve" } },
	{ payload: { action_target_status: "completed" } },
	{ payload: { action_reason: "other" } },
])
	test(`termination evidence mismatch ${JSON.stringify(options)} conflicts`, (t) => {
		assert.equal(
			inspect(
				manifest(),
				fixture(t, (db) => terminated(db, options)),
			).action,
			"conflict",
		);
	});
test("late action after snapshot conflicts", (t) => {
	assert.equal(
		inspect(
			manifest(),
			fixture(t, (db) => terminated(db, { at: "2026-09-09T00:10:00Z" })),
		).action,
		"conflict",
	);
});
test("running state contradicting action evidence conflicts", (t) => {
	assert.equal(
		inspect(
			manifest(),
			fixture(t, (db) => {
				terminated(db);
				db.exec("UPDATE sessions SET status='running'");
			}),
		).action,
		"conflict",
	);
});
test("matching precondition receipt replays with authority", (t) => {
	const paths = fixture(t, (db) => terminated(db)),
		m = manifest();
	const output = inspect(m, paths);
	m.steps.step.receipt = { result: output.result };
	assert.deepEqual(inspect(m, paths), { ...output, action: "replay" });
});
test("matching fallback receipt replays no-op", (t) => {
	const paths = fixture(t, (db) =>
			db.exec("UPDATE sessions SET status='failed'"),
		),
		m = manifest("qa-fallback");
	const output = inspect(m, paths);
	m.steps.step.receipt = { result: output.result };
	assert.deepEqual(inspect(m, paths), { ...output, action: "replay" });
});
test("wrong receipt conflicts and is preserved", (t) => {
	const m = manifest();
	m.steps.step.receipt = { result: { executionId: "wrong" } };
	const original = structuredClone(m);
	assert.equal(
		inspect(
			m,
			fixture(t, (db) => terminated(db)),
		).action,
		"conflict",
	);
	assert.deepEqual(m, original);
});
for (const table of ["sessions", "lead_events"])
	test(`missing ${table} fails closed`, (t) => {
		assert.equal(
			inspect(
				manifest(),
				fixture(t, (db) => db.exec(`DROP TABLE ${table}`)),
			).action,
			"conflict",
		);
	});
test("malformed action payload fails closed", (t) => {
	assert.equal(
		inspect(
			manifest(),
			fixture(t, (db) => {
				terminated(db);
				db.exec("UPDATE lead_events SET payload='bad-json'");
			}),
		).action,
		"conflict",
	);
});
test("missing intent timestamp fails closed", (t) => {
	const m = manifest();
	delete m.steps.step.intent.createdAt;
	assert.equal(
		inspect(
			m,
			fixture(t, (db) => terminated(db)),
		).action,
		"conflict",
	);
});
test("SQLite action timestamps interpreted as UTC under local timezone", (t) => {
	const previous = process.env.TZ;
	process.env.TZ = "America/Los_Angeles";
	t.after(() => {
		if (previous === undefined) delete process.env.TZ;
		else process.env.TZ = previous;
	});
	assert.equal(
		inspect(
			manifest(),
			fixture(t, (db) => terminated(db)),
		).action,
		"adopt-existing",
	);
});
