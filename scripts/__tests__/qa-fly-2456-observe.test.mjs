import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { launchCommitsDelta } from "../lib/qa-fly-2456-launch-delta.mjs";

test("observer exposes post-bound capability drift outside the three campaign executions", (t) => {
	const dbPath = fixture(t, (db) =>
		sessionEvent(
			db,
			"reown_revive_failed",
			{ reason: "workflow capability drift for unrelated" },
			"unrelated",
		),
	);
	const r = observeRound({ dbPath, bounds, bodies });
	assert.equal(r.status, "pass");
	assert.equal(r.capabilityDriftEvents.length, 1);
	assert.equal(r.capabilityDriftEvents[0].execution_id, "unrelated");
});

import { eventBounds, observeRound } from "../lib/qa-fly-2456-observe.mjs";

test("launch delta derives replacement only from freshly parsed causal events", (t) => {
	for (const mismatch of [false, true]) {
		const dbPath = fixture(t, (db) => {
			exhausted(db);
			replacement(db, mismatch ? { materializedId: "wrong" } : {});
		});
		const beforePath = join(dirname(dbPath), "launch-before"),
			afterPath = join(dirname(dbPath), "launch-after");
		writeFileSync(beforePath, "");
		writeFileSync(afterPath, "new-exec\n");
		const manifest = {
			steps: {
				...Object.fromEntries(
					Object.entries(bodies).map(([label, body]) => [
						`start-${label}`,
						{
							intent: { detail: { kind: "start", label } },
							receipt: {
								result: {
									success: true,
									generalized: true,
									executionId: body.executionId,
									workflowRunId: body.runId,
									workflowNodeId: body.nodeId,
								},
							},
						},
					]),
				),
				cycle2: { intent: { detail: { kind: "cycle", preState: { bounds } } } },
			},
		};
		const r = launchCommitsDelta({
			beforePath,
			afterPath,
			manifest,
			dbPath,
			cycleStep: "cycle2",
		});
		assert.equal(r.status, mismatch ? "fail" : "pass");
	}
});

const require = createRequire(
	new URL("../../packages/flywheel-comm/package.json", import.meta.url),
);
const Database = require("better-sqlite3");
function realR1(t, change = () => {}) {
	const recorded = JSON.parse(
		readFileSync(
			new URL("./fixtures/qa-fly-2456-r1-b1-recovery.json", import.meta.url),
			"utf8",
		),
	);
	change(recorded.evidence);
	const dir = mkdtempSync(join(tmpdir(), "fly2456-real-r1-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const dbPath = join(dir, "recorded.evidence.json");
	const raw = JSON.stringify(recorded.evidence);
	writeFileSync(dbPath, raw);
	writeFileSync(
		`${dbPath}.meta.json`,
		JSON.stringify({
			sha256: createHash("sha256").update(raw).digest("hex"),
			source: recorded.evidence.source,
		}),
	);
	return observeRound({
		dbPath,
		bounds: recorded.bounds,
		bodies: recorded.bodies,
	});
}
test("real R1 B1 drift exhaustion retains its observed replacement chain", (t) => {
	const result = realR1(t);
	assert.equal(result.status, "pass");
	assert.equal(result.bodies.B1.classification, "replaced");
	assert.equal(
		result.bodies.B1.replacement.executionId,
		"4240e1e9-3dca-4a34-8521-0ea86533207e",
	);
	assert.equal(result.bodies.B1.claim.episode_attempts, 0);
	assert.equal(result.capabilityDriftEvents.length, 2);
});
for (const mutation of [
	"missing materialized",
	"missing launch",
	"wrong request",
	"wrong new execution",
	"wrong node",
	"launch before materialized",
	"missing exhaustion",
	"missing attempt 2",
]) {
	test(`real R1 evidence fails closed with ${mutation}`, (t) => {
		const result = realR1(t, (evidence) => {
			const table = evidence.tables.find(
				(t) =>
					t.name ===
					(mutation.startsWith("missing ex") || mutation === "missing attempt 2"
						? "session_events"
						: "workflow_run_event"),
			);
			const index = (key) => table.columns.findIndex((c) => c.name === key);
			if (
				mutation === "missing exhaustion" ||
				mutation === "missing attempt 2"
			) {
				table.rows = table.rows.filter((r) => {
					const p = JSON.parse(r[index("payload")]);
					return mutation === "missing exhaustion"
						? p.reason !== "episode_exhausted"
						: p.attempt !== 2;
				});
			} else {
				const kind =
					mutation === "missing materialized"
						? "rework_replacement_materialized"
						: "rework_replacement";
				const row = table.rows.find((r) => r[index("kind")] === kind);
				if (mutation.startsWith("missing"))
					table.rows = table.rows.filter((r) => r !== row);
				else if (mutation === "wrong node") row[index("node_id")] = "qa";
				else if (mutation === "launch before materialized")
					row[index("seq")] = 1;
				else {
					const p = JSON.parse(row[index("payload")]);
					p[mutation === "wrong request" ? "requestId" : "newExecutionId"] =
						"unrelated";
					row[index("payload")] = JSON.stringify(p);
				}
			}
		});
		assert.equal(result.status, "pass");
		assert.equal(
			result.bodies.B1.classification,
			mutation === "missing exhaustion" || mutation === "missing attempt 2"
				? "other"
				: "drift_exhausted",
		);
		assert.equal(result.bodies.B1.replacement, undefined);
	});
}

const bodies = Object.fromEntries(
	["B1", "B2", "B3"].map((label) => [
		label,
		{
			executionId: `exec-${label}`,
			runId: `run-${label}`,
			nodeId: "implement",
		},
	]),
);
const bounds = {
	sessionEventsMaxId: 0,
	runEventMaxSeq: { "run-B1": 0, "run-B2": 0, "run-B3": 0 },
};
const timestamp = "2026-09-08T00:00:00Z";
function fixture(t, change = () => {}) {
	const dir = mkdtempSync(join(tmpdir(), "fly2456-observe-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "snapshot.db");
	const db = new Database(path);
	const source = readFileSync(
		new URL("../../packages/teamlead/src/StateStore.ts", import.meta.url),
		"utf8",
	);
	for (const name of [
		"sessions",
		"session_events",
		"recovery_claim",
		"workflow_run",
		"workflow_run_event",
	])
		db.exec(
			source.match(
				new RegExp(
					`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\t\\t\\t\\)`,
				),
			)[0],
		);
	for (const [label, body] of Object.entries(bodies)) {
		db.prepare(
			"INSERT INTO sessions(execution_id,issue_id,project_name,status) VALUES(?,?,?,'running')",
		).run(body.executionId, label, "p");
		db.prepare(
			"INSERT INTO workflow_run(run_id,issue_id,project_name) VALUES(?,?,?)",
		).run(body.runId, label, "p");
	}
	change(db);
	db.close();
	writeFileSync(
		`${path}.meta.json`,
		JSON.stringify({
			observedAt: timestamp,
			sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
		}),
	);
	return path;
}
function sessionEvent(db, type, payload = {}, exec = "exec-B1") {
	const id = db
		.prepare("SELECT COALESCE(MAX(id),0)+1 AS id FROM session_events")
		.get().id;
	db.prepare(
		"INSERT INTO session_events(id,event_id,ts,execution_id,issue_id,project_name,event_type,payload,source) VALUES(?,?,?,?,?,'p',?,?,'bridge.codex-session-reown')",
	).run(
		id,
		`event-${id}`,
		timestamp,
		exec,
		"issue",
		type,
		JSON.stringify(payload),
	);
	return id;
}
function runEvent(
	db,
	kind,
	payload = {},
	exec = "exec-B1",
	run = "run-B1",
	node = "implement",
) {
	const seq = db
		.prepare(
			"SELECT COALESCE(MAX(seq),0)+1 AS seq FROM workflow_run_event WHERE run_id=?",
		)
		.get(run).seq;
	db.prepare(
		"INSERT INTO workflow_run_event(run_id,seq,event_uid,at,kind,node_id,execution_id,payload) VALUES(?,?,?,?,?,?,?,?)",
	).run(
		run,
		seq,
		`${run}-${seq}`,
		timestamp,
		kind,
		node,
		exec,
		JSON.stringify(payload),
	);
	return seq;
}
function exhausted(
	db,
	{
		episode = "episode",
		claim = episode,
		lastError = "Codex recovery exhausted after 2 attempts",
		reason = "workflow capability drift for exec-B1",
		secondEpisode = episode,
		exhaustedPayload = { reason: "episode_exhausted", attempts: 2 },
	} = {},
) {
	sessionEvent(db, "reown_revive_failed", {
		reason,
		episodeId: episode,
		attempt: 1,
	});
	sessionEvent(db, "reown_revive_failed", {
		reason,
		episodeId: secondEpisode,
		attempt: 2,
	});
	sessionEvent(db, "reown_revive_failed", exhaustedPayload);
	db.prepare(
		"INSERT INTO recovery_claim(execution_id,episode_id,episode_state,episode_attempts) VALUES('exec-B1',?,'open',2)",
	).run(claim);
	db.prepare(
		"UPDATE sessions SET status='failed',last_error=? WHERE execution_id='exec-B1'",
	).run(lastError);
}
function replacement(
	db,
	{
		newId = "new-exec",
		materializedId = newId,
		request = "request",
		launchedRequest = request,
		ordinal = 2,
		materializedOrdinal = ordinal,
		launchExec = materializedId,
		newSession = true,
		reverse = false,
	} = {},
) {
	const launch = () =>
		runEvent(
			db,
			"rework_replacement_launched",
			{ requestId: launchedRequest, activationId: "activation", attempt: 1 },
			launchExec,
		);
	if (reverse) launch();
	runEvent(db, "execution_dead_rolled_back", {
		attempt: 1,
		newExecutionId: newId,
		launchOrdinal: ordinal,
		reason: "dead",
		retryDisposition: "retry",
	});
	runEvent(db, "rework_replacement_materialized", {
		requestId: request,
		deadExecutionId: "exec-B1",
		newExecutionId: materializedId,
		launchOrdinal: materializedOrdinal,
		routeRevision: 2,
		reason: "dead",
		heldPaneLossRecovery: false,
	});
	if (!reverse) launch();
	if (newSession)
		db.prepare(
			"INSERT INTO sessions(execution_id,issue_id,project_name,status) VALUES(?,'B1','p','running')",
		).run(newId);
}
function observe(path, override = {}) {
	return observeRound({ dbPath: path, bounds, bodies, ...override });
}
test("event bounds capture global session id and each requested run sequence", (t) => {
	const path = fixture(t, (db) => {
		sessionEvent(db, "reown_watch_started");
		runEvent(db, "event");
	});
	const result = eventBounds(
		path,
		Object.values(bodies).map((b) => b.runId),
	);
	assert.equal(result.status, "pass");
	assert.equal(result.sessionEventsMaxId, 1);
	assert.deepEqual(result.runEventMaxSeq, {
		"run-B1": 1,
		"run-B2": 0,
		"run-B3": 0,
	});
});
test("bounds reject unknown run", (t) => {
	assert.equal(eventBounds(fixture(t), ["unknown"]).status, "fail");
});
test("bounds missing event table fails closed", (t) => {
	assert.equal(
		eventBounds(
			fixture(t, (db) => db.exec("DROP TABLE workflow_run_event")),
			["run-B1"],
		).status,
		"fail",
	);
});
test("drift exhaustion and exact replacement chain prove replacement", (t) => {
	const path = fixture(t, (db) => {
		exhausted(db);
		replacement(db);
	});
	const result = observe(path);
	assert.equal(result.status, "pass");
	const b = result.bodies.B1;
	assert.equal(b.classification, "replaced");
	assert.equal(b.episodeId, "episode");
	assert.equal(b.replacement.executionId, "new-exec");
	assert.equal(b.replacement.requestId, "request");
	assert.equal(b.replacement.launchOrdinal, 2);
	assert.equal(
		result.timeline.workflowRunEvents.at(-1).execution_id,
		"new-exec",
	);
	assert.equal(
		b.sessionEvents[2].payload,
		'{"reason":"episode_exhausted","attempts":2}',
	);
});
test("drift exhaustion without replacement remains drift_exhausted", (t) => {
	const result = observe(fixture(t, (db) => exhausted(db)));
	assert.equal(result.bodies.B1.classification, "drift_exhausted");
});
test("recovery attempt 2 on workflow binding attempt 1 does not prove binding attempt 2", (t) => {
	const path = fixture(t, (db) => {
		sessionEvent(db, "reown_revive_failed", {
			episodeId: "episode",
			attempt: 1,
			reason: "transient",
		});
		runEvent(db, "codex_recovery_capabilities_prepared", {
			attempt: 1,
			recoveryEpisodeId: "episode",
			recoveryAttempt: 2,
			hasOutputCredential: true,
			hasSubmissionCredential: true,
		});
		sessionEvent(db, "reown_revive_succeeded", {
			episodeId: "episode",
			attempt: 2,
			threadId: "thread",
			receiptKind: "goal",
			lifecycleRevision: 2,
		});
	});
	const result = observe(path);
	assert.equal(result.status, "pass");
	assert.equal(result.bodies.B1.classification, "succeeded");
	assert.equal(result.bodies.B1.attempt2PreparedProof, false);
	assert.equal(result.bodies.B1.preparedEvents.length, 1);
});
test("watch, skip and zero are distinct classifications", (t) => {
	const result = observe(
		fixture(t, (db) => {
			sessionEvent(db, "reown_watch_started");
			sessionEvent(db, "reown_skipped_not_turn_holder", {}, "exec-B2");
		}),
	);
	assert.equal(result.bodies.B1.classification, "watch_only");
	assert.equal(result.bodies.B2.classification, "skipped_not_holder");
	assert.equal(result.bodies.B3.classification, "excluded_or_ineligible");
});
test("lower bounds exclude previous cycle evidence", (t) => {
	const path = fixture(t, (db) => {
		exhausted(db);
		replacement(db);
		sessionEvent(db, "reown_watch_started");
	});
	const result = observe(path, {
		bounds: {
			sessionEventsMaxId: 3,
			runEventMaxSeq: { ...bounds.runEventMaxSeq, "run-B1": 3 },
		},
	});
	assert.equal(result.bodies.B1.classification, "watch_only");
	assert.equal(result.timeline.sessionEvents.length, 1);
	assert.equal(result.timeline.workflowRunEvents.length, 0);
});
for (const options of [
	{ secondEpisode: "later" },
	{ claim: "wrong" },
	{ lastError: "other error" },
	{ reason: "workflow capability drift for another" },
	{
		exhaustedPayload: {
			reason: "episode_exhausted",
			attempts: 2,
			episodeId: "fabricated",
		},
	},
])
	test(`unproven exhaustion stays other ${JSON.stringify(options)}`, (t) => {
		const result = observe(fixture(t, (db) => exhausted(db, options)));
		assert.equal(result.status, "pass");
		assert.equal(result.bodies.B1.classification, "other");
	});
test("later successful episode does not repair first episode classification", (t) => {
	const result = observe(
		fixture(t, (db) => {
			sessionEvent(db, "reown_revive_failed", {
				episodeId: "first",
				attempt: 1,
				reason: "failed",
			});
			sessionEvent(db, "reown_revive_succeeded", {
				episodeId: "later",
				attempt: 1,
			});
		}),
	);
	assert.equal(result.bodies.B1.episodeId, "first");
	assert.equal(result.bodies.B1.classification, "other");
});
test("prepared from another episode is exposed but cannot prove attempt2", (t) => {
	const result = observe(
		fixture(t, (db) => {
			sessionEvent(db, "reown_revive_succeeded", {
				episodeId: "first",
				attempt: 2,
			});
			runEvent(db, "codex_recovery_capabilities_prepared", {
				attempt: 2,
				recoveryEpisodeId: "later",
				recoveryAttempt: 2,
			});
		}),
	);
	assert.equal(result.bodies.B1.attempt2PreparedProof, false);
});
test("prepared capability event prevents drift exhaustion claim", (t) => {
	const result = observe(
		fixture(t, (db) => {
			exhausted(db);
			runEvent(db, "codex_recovery_capabilities_prepared", {
				attempt: 1,
				recoveryEpisodeId: "episode",
				recoveryAttempt: 1,
			});
		}),
	);
	assert.equal(result.bodies.B1.classification, "other");
});
for (const options of [
	{ materializedId: "other" },
	{ launchedRequest: "other" },
	{ materializedOrdinal: 3 },
	{ reverse: true },
	{ launchExec: "exec-B1" },
	{ newSession: false },
])
	test(`replacement mismatch cannot be adopted ${JSON.stringify(options)}`, (t) => {
		const result = observe(
			fixture(t, (db) => {
				exhausted(db);
				replacement(db, options);
			}),
		);
		assert.equal(result.status, "pass");
		assert.equal(result.bodies.B1.classification, "drift_exhausted");
		assert.equal(result.bodies.B1.replacement, undefined);
	});
for (const table of [
	"sessions",
	"session_events",
	"workflow_run",
	"workflow_run_event",
	"recovery_claim",
])
	test(`missing schema ${table} fails closed`, (t) => {
		assert.equal(
			observe(fixture(t, (db) => db.exec(`DROP TABLE ${table}`))).status,
			"fail",
		);
	});
test("missing run lower bound fails closed", (t) => {
	assert.equal(
		observe(fixture(t), {
			bounds: { sessionEventsMaxId: 0, runEventMaxSeq: {} },
		}).status,
		"fail",
	);
});
for (const table of ["session_events", "workflow_run_event"])
	test(`malformed event payload ${table} fails closed`, (t) => {
		const path = fixture(t, (db) => {
			if (table === "session_events") sessionEvent(db, "reown_watch_started");
			else runEvent(db, "event");
			db.exec(`UPDATE ${table} SET payload='{broken'`);
		});
		assert.equal(observe(path).status, "fail");
	});
test("malformed workflow sequence fails closed rather than yielding a timeline", (t) => {
	const path = fixture(t, (db) => {
		runEvent(db, "event");
		db.exec("UPDATE workflow_run_event SET seq='invalid'");
	});
	assert.equal(observe(path).status, "fail");
});
test("malformed first episode identity cannot be skipped in favor of later success", (t) => {
	const path = fixture(t, (db) => {
		sessionEvent(db, "reown_revive_failed", { episodeId: 42, attempt: 1 });
		sessionEvent(db, "reown_revive_succeeded", {
			episodeId: "later",
			attempt: 1,
		});
	});
	assert.equal(observe(path).status, "fail");
});
test("diagnostic suffix is accepted for exact execution drift reason", (t) => {
	assert.equal(
		observe(
			fixture(t, (db) =>
				exhausted(db, {
					reason: "workflow capability drift for exec-B1: diagnostic",
				}),
			),
		).bodies.B1.classification,
		"drift_exhausted",
	);
});
test("wrong node replacement chain cannot prove replacement", (t) => {
	const path = fixture(t, (db) => {
		exhausted(db);
		replacement(db);
		db.exec(
			"UPDATE workflow_run_event SET node_id='qa' WHERE kind='rework_replacement_launched'",
		);
	});
	assert.equal(observe(path).bodies.B1.classification, "drift_exhausted");
});
test("unrelated source reown-looking event is excluded", (t) => {
	const path = fixture(t, (db) => {
		sessionEvent(db, "reown_revive_succeeded", { episodeId: "unrelated" });
		db.exec("UPDATE session_events SET source='other'");
	});
	assert.equal(
		observe(path).bodies.B1.classification,
		"excluded_or_ineligible",
	);
});

test("workflow binding attempt 2 proves preparation on first recovery attempt", (t) => {
	const result = observe(
		fixture(t, (db) => {
			runEvent(db, "codex_recovery_capabilities_prepared", {
				attempt: 2,
				recoveryAttempt: 1,
				recoveryEpisodeId: "episode",
				hasOutputCredential: true,
				hasSubmissionCredential: true,
			});
			sessionEvent(db, "reown_revive_succeeded", {
				episodeId: "episode",
				attempt: 1,
				threadId: "thread",
				receiptKind: "goal",
				lifecycleRevision: 2,
			});
		}),
	);
	assert.equal(result.status, "pass");
	assert.equal(result.bodies.B1.classification, "succeeded");
	assert.equal(result.bodies.B1.attempt2PreparedProof, true);
});

test("released observation projection preserves first episode, replacement and global drift evidence", async (t) => {
	const { deriveEvidence } = await import("../lib/qa-fly-2456-evidence.mjs");
	for (const mismatch of [false, true]) {
		const dbPath = fixture(t, (db) => {
			exhausted(db);
			replacement(db, mismatch ? { materializedId: "wrong" } : {});
			sessionEvent(
				db,
				"reown_revive_failed",
				{ reason: "workflow capability drift for unrelated" },
				"unrelated",
			);
		});
		const expected = observeRound({ dbPath, bounds, bodies }),
			path = dbPath + ".evidence.json";
		deriveEvidence(dbPath, path, "observation");
		rmSync(dbPath);
		rmSync(dbPath + ".meta.json");
		assert.deepEqual(observeRound({ dbPath: path, bounds, bodies }), expected);
		assert.equal(
			expected.capabilityDriftEvents.some(
				(e) => e.execution_id === "unrelated",
			),
			true,
		);
	}
});

test("non-drift owner failure exhausted without successor is explicit (#15)", (t) => {
	const result = observe(
		fixture(t, (db) =>
			exhausted(db, { reason: "recovery owner failed before commit" }),
		),
	);
	assert.equal(
		result.bodies.B1.classification,
		"failed_exhausted_no_replacement",
	);
});
test("holder skip followed by superseded skips remains the negative control (#15)", (t) => {
	const result = observe(
		fixture(t, (db) => {
			sessionEvent(db, "reown_skipped_not_turn_holder", {}, "exec-B3");
			sessionEvent(
				db,
				"reown_skipped_superseded",
				{ retrySuccessor: null },
				"exec-B3",
			);
		}),
	);
	assert.equal(result.bodies.B3.classification, "skipped_not_holder");
});
