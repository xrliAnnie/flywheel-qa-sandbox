// FLY-2018 independent QA: exercise the Fix B environment breaker's SAFETY
// predicates (the "must NOT trip" half) against the real built StateStore with
// a real SQLite database. The implementer's suite proves the trip path; this
// harness proves the fail-safe boundaries the plan promised (§2.2 / §5.9) that
// no committed test covers.
import { StateStore } from "../../../../packages/teamlead/dist/StateStore.js";
import { legacyWorkflowSeeds } from "../../../../packages/teamlead/dist/__tests__/fixtures/legacy-workflow-manifests.js";

const WORKFLOW_ON = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
};
const must = (label, cond) => {
	results.push([label, !!cond]);
};
const results = [];

async function engineRunWithImplement() {
	const store = await StateStore.create(":memory:");
	const seed = legacyWorkflowSeeds().find((c) => c.templateId === "tpl_eng_heavy");
	store.importWorkflowTemplateSeed(seed);
	store.materializeWorkflowRun({
		runId: "run-1", issueId: "FLY-1335", projectName: "flywheel",
		taskCategory: "code", templateId: seed.templateId, claimsReadEnrolled: true,
		actor: "lead", env: WORKFLOW_ON,
		startReservation: {
			idempotencyKey: "start-1", selectionDigest: "selection-1", nodeId: "design",
			attempt: 1, executionId: "design-1", createdAt: "2026-07-20T00:00:00.000Z",
		},
	});
	store.upsertWorkflowRunNode({ runId: "run-1", nodeId: "design", attempt: 1, state: "running", executionId: "design-1" });
	store.commitWorkflowTransitionTx({
		runId: "run-1", nodeId: "design", attempt: 1, executionId: "design-1",
		outcome: "design_done", successorExecutionId: "implement-dead",
		subjectDigest: "a".repeat(40), now: "2026-07-20T00:05:00.000Z",
	});
	store.admitGeneralizedWorkflowExecution({
		runId: "run-1", nodeId: "implement", executionId: "implement-dead", attempt: 1,
		expiresAt: "2026-07-20T01:00:00.000Z", absoluteDeadlineAt: "2026-07-21T00:00:00.000Z",
		now: "2026-07-20T00:06:00.000Z", env: WORKFLOW_ON,
	});
	store.applyWorkflowLedgerBatch({
		projectName: "flywheel", issueId: "FLY-1335", runId: "run-1",
		ops: [{ op: "side_effect", node: "implement", attempt: 1, executionId: "implement-dead", to: "started" }],
	});
	store.upsertWorkflowRunNode({ runId: "run-1", nodeId: "implement", attempt: 1, state: "running", executionId: "implement-dead" });
	store.upsertSession({ execution_id: "implement-dead", issue_id: "FLY-1335", project_name: "flywheel", status: "failed", workflow_node_id: "implement" });
	return store;
}

function startAndFailReservedImplement(store, executionId, now) {
	store.admitGeneralizedWorkflowExecution({
		runId: "run-1", nodeId: "implement", executionId, attempt: 1,
		expiresAt: "2026-07-20T05:00:00.000Z", absoluteDeadlineAt: "2026-07-21T00:00:00.000Z",
		now, env: WORKFLOW_ON,
	});
	store.applyWorkflowLedgerBatch({
		projectName: "flywheel", issueId: "FLY-1335", runId: "run-1",
		ops: [{ op: "side_effect", node: "implement", attempt: 1, executionId, to: "started" }],
	});
	store.upsertWorkflowRunNode({ runId: "run-1", nodeId: "implement", attempt: 1, state: "running", executionId });
	store.upsertSession({ execution_id: executionId, issue_id: "FLY-1335", project_name: "flywheel", status: "failed", workflow_node_id: "implement" });
}

function fail(store, executionId, sourceEventId, cls, now) {
	return store.recordEnrolledTerminalSignal({
		executionId, sourceEventId, signal: "failed", failureKind: "goal_blocked",
		...(cls ?? {}),
		lastError: "goal ended non-complete: blocked",
		source: "direct-event-sink", now,
	});
}

const ENV = { failureClass: "environment", failureCode: "codex:unauthorized" };
const ALERT = { leadId: "flywheel-eng-lead", projectName: "flywheel", leadResolution: "resolved" };

function rollback(store, dead, next, now) {
	return store.rollbackDeadWorkflowNodeExecution({
		runId: "run-1", nodeId: "implement", attempt: 1, deadExecutionId: dead,
		newExecutionId: next, reason: "terminal_session_and_dead_probe",
		alertIdentity: ALERT,
		livenessEvidence: { liveness: "dead", observedAt: now }, now,
	});
}

// ---- S1: first death is environment-classified -> still blind-replaces ------
{
	const store = await engineRunWithImplement();
	fail(store, "implement-dead", "e1", ENV, "2026-07-20T00:09:00.000Z");
	const r = rollback(store, "implement-dead", "retry-1", "2026-07-20T00:10:00.000Z");
	must("S1 a single environment death still mints a replacement (probe once)", r.ok === true && r.launchOrdinal === 2);
	store.close();
}

// ---- S2: non-environment death then environment death -> NOT held ----------
{
	const store = await engineRunWithImplement();
	fail(store, "implement-dead", "n1", undefined, "2026-07-20T00:09:00.000Z");
	const r1 = rollback(store, "implement-dead", "retry-1", "2026-07-20T00:10:00.000Z");
	startAndFailReservedImplement(store, "retry-1", "2026-07-20T00:11:00.000Z");
	fail(store, "retry-1", "e2", ENV, "2026-07-20T00:12:00.000Z");
	const r2 = rollback(store, "retry-1", "retry-2", "2026-07-20T00:13:00.000Z");
	must("S2 non-env -> env does NOT trip the breaker", r1.ok && r2.ok === true && r2.launchOrdinal === 3);
	must("S2 run stays active", store.getWorkflowRun("run-1")?.status === "active");
	store.close();
}

// ---- S3: regex-legal but unreviewed code is dropped, never trips -----------
{
	const store = await engineRunWithImplement();
	const UNKNOWN = { failureClass: "environment", failureCode: "codex:ratelimited" };
	fail(store, "implement-dead", "u1", UNKNOWN, "2026-07-20T00:09:00.000Z");
	const canonical = store.getWorkflowExecutionTerminalFailureCanonical("implement-dead");
	must("S3 unknown code is dropped from the persisted pair", canonical?.failureCode === null && canonical?.failureClass === null);
	rollback(store, "implement-dead", "retry-1", "2026-07-20T00:10:00.000Z");
	startAndFailReservedImplement(store, "retry-1", "2026-07-20T00:11:00.000Z");
	fail(store, "retry-1", "u2", UNKNOWN, "2026-07-20T00:12:00.000Z");
	const r2 = rollback(store, "retry-1", "retry-2", "2026-07-20T00:13:00.000Z");
	must("S3 two unknown-code deaths do NOT trip the breaker", r2.ok === true);
	store.close();
}

// ---- S4: canonical freeze -- first teardown unclassified wins forever ------
{
	const store = await engineRunWithImplement();
	fail(store, "implement-dead", "a1", undefined, "2026-07-20T00:09:00.000Z");
	fail(store, "implement-dead", "a2-late", ENV, "2026-07-20T00:09:30.000Z");
	const canonical = store.getWorkflowExecutionTerminalFailureCanonical("implement-dead");
	must("S4 later classified teardown does NOT rewrite the canonical absence", canonical?.failureClass === null);
	rollback(store, "implement-dead", "retry-1", "2026-07-20T00:10:00.000Z");
	startAndFailReservedImplement(store, "retry-1", "2026-07-20T00:11:00.000Z");
	fail(store, "retry-1", "b1", ENV, "2026-07-20T00:12:00.000Z");
	const r2 = rollback(store, "retry-1", "retry-2", "2026-07-20T00:13:00.000Z");
	must("S4 unclassifiable predecessor keeps the breaker off", r2.ok === true);
	store.close();
}

// ---- S5: same source id + different metadata must conflict ----------------
{
	const store = await engineRunWithImplement();
	fail(store, "implement-dead", "same-uid", undefined, "2026-07-20T00:09:00.000Z");
	const conflict = fail(store, "implement-dead", "same-uid", ENV, "2026-07-20T00:09:10.000Z");
	must("S5 replay with drifted classification is refused", conflict.ok === false && conflict.reason === "terminal_signal_conflict");
	const replay = fail(store, "implement-dead", "same-uid", undefined, "2026-07-20T00:09:20.000Z");
	must("S5 byte-identical replay is still idempotent", replay.ok === true);
	store.close();
}

// ---- S6: retry_limit outranks the environment breaker ---------------------
{
	const store = await engineRunWithImplement();
	fail(store, "implement-dead", "r1", ENV, "2026-07-20T00:09:00.000Z");
	rollback(store, "implement-dead", "retry-1", "2026-07-20T00:10:00.000Z");
	let prev = "retry-1";
	let outcome;
	for (let i = 1; i <= 4; i++) {
		startAndFailReservedImplement(store, prev, `2026-07-20T0${i}:11:00.000Z`);
		fail(store, prev, `r-${i}`, ENV, `2026-07-20T0${i}:12:00.000Z`);
		outcome = rollback(store, prev, `retry-${i + 1}`, `2026-07-20T0${i}:13:00.000Z`);
		if (!outcome.ok) break;
		prev = `retry-${i + 1}`;
	}
	must("S6 the breaker stops the chain and never runs away", outcome.ok === false);
	must("S6 the run ends held", store.getWorkflowRun("run-1")?.status === "held");
	must("S6 it stops via the environment breaker, not by burning the quota",
		outcome.reason === "environment_failure_escalated");
	console.log(`  [S6 detail] terminal reason = ${outcome.reason}, launches = ${store.listWorkflowSideEffects("run-1").length}`);
	store.close();
}

// ---- S6b: with NO classification the legacy blind-replacement quota still
//           governs, and retry_limit is what finally stops it ----------------
{
	const store = await engineRunWithImplement();
	fail(store, "implement-dead", "q0", undefined, "2026-07-20T00:09:00.000Z");
	let outcome = rollback(store, "implement-dead", "retry-1", "2026-07-20T00:10:00.000Z");
	let prev = "retry-1";
	for (let i = 1; i <= 5 && outcome.ok; i++) {
		startAndFailReservedImplement(store, prev, `2026-07-20T0${i}:11:00.000Z`);
		fail(store, prev, `q-${i}`, undefined, `2026-07-20T0${i}:12:00.000Z`);
		outcome = rollback(store, prev, `retry-${i + 1}`, `2026-07-20T0${i}:13:00.000Z`);
		prev = `retry-${i + 1}`;
	}
	console.log(`  [S6b detail] terminal reason = ${outcome.reason}`);
	must("S6b unclassified deaths still terminate on the legacy retry limit",
		outcome.ok === false && outcome.reason === "retry_limit_exceeded");
	store.close();
}

// ---- S7: an environment hold is NOT operator-reworkable (plan §2.2) -------
{
	const store = await engineRunWithImplement();
	fail(store, "implement-dead", "w1", ENV, "2026-07-20T00:09:00.000Z");
	rollback(store, "implement-dead", "retry-1", "2026-07-20T00:10:00.000Z");
	startAndFailReservedImplement(store, "retry-1", "2026-07-20T00:11:00.000Z");
	fail(store, "retry-1", "w2", ENV, "2026-07-20T00:12:00.000Z");
	rollback(store, "retry-1", "must-not-launch", "2026-07-20T00:13:00.000Z");
	must("S7 run is held", store.getWorkflowRun("run-1")?.status === "held");
	let rework;
	try {
		rework = store.openOperatorRework({
			runId: "run-1", targetNodeId: "implement", feedback: "qa probe",
			clientRequestId: "qa-probe-1", principal: "operator", evidence: [],
			now: "2026-07-20T00:20:00.000Z",
		});
	} catch (err) {
		rework = { ok: false, reason: `threw:${err.message}` };
	}
	console.log(`  [S7 detail] openOperatorRework -> ${JSON.stringify(rework)}`);
	must("S7 operator rework is refused on an environment hold", rework?.ok !== true);
	must("S7 the refusal is the hold policy, not a malformed request",
		rework?.reason !== "invalid_operator_rework_request");
	store.close();
}

// ---- S7b: positive control -- the SAME rework call shape is accepted (or at
//           least not rejected as malformed) on an ACTIVE run, proving S7's
//           refusal is produced by the environment hold and not by my request.
{
	const store = await engineRunWithImplement();
	let rework;
	try {
		rework = store.openOperatorRework({
			runId: "run-1", targetNodeId: "implement", feedback: "qa probe",
			clientRequestId: "qa-probe-ctl", principal: "operator", evidence: [],
			now: "2026-07-20T00:20:00.000Z",
		});
	} catch (err) {
		rework = { ok: false, reason: `threw:${err.message}` };
	}
	console.log(`  [S7b control] active-run rework -> ${JSON.stringify(rework)}`);
	must("S7b control: the identical request shape is NOT rejected as malformed",
		rework?.reason !== "invalid_operator_rework_request");
	store.close();
}

console.log("\n=== VERDICT ===");
let ok = true;
for (const [label, pass] of results) {
	console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}`);
	if (!pass) ok = false;
}
process.exit(ok ? 0 : 1);
