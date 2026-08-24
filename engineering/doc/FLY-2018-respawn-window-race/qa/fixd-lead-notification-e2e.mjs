// FLY-2018 independent QA — Fix D: the "engine will re-check at ~T" notice that
// makes the back-off window visible instead of looking like a silent stall.
//
// Real StateStore (temp SQLite), real lead_events journal, real MailboxQueue
// (temp comm.db), real production renderers from both Lead runtimes, and the
// real crash-recovery redrive path. No mocks.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const tl = (p) => import(join(repoRoot, "packages/teamlead/dist", p));

const { StateStore } = await tl("StateStore.js");
const { legacyWorkflowSeeds } = await tl("__tests__/fixtures/legacy-workflow-manifests.js");
const { MailboxLeadRuntime } = await tl("bridge/mailbox-lead-runtime.js");
const { CommDBLeadRuntime } = await tl("bridge/commdb-lead-runtime.js");
const { leadEventEnvelopeFromJournalRow } = await tl("bridge/legacy-lead-event-reconciler.js");
const { enqueueLeadEvent } = await tl("bridge/lead-event-queue.js");
const { resolveWorkflowReplacementLeadIntent, enqueueWorkflowReplacementLeadEvent } =
	await tl("bridge/workflow-replacement-lead-event.js");
const { MailboxQueue } = await import(
	join(repoRoot, "packages/flywheel-comm/dist/mailbox-queue.js")
);

const tmp = mkdtempSync(join(tmpdir(), "qa2018-fixd-"));
const results = [];
const ok = (n, c, d = "") => results.push([n, !!c, d]);

const WORKFLOW_ON = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
};
const PROJECTS = [
	{
		projectName: "flywheel",
		projectRoot: join(tmp, "proj"),
		leads: [{ agentId: "flywheel-eng-lead", match: { labels: ["eng"] } }],
	},
];

async function freshRun() {
	const store = await StateStore.create(":memory:");
	const seed = legacyWorkflowSeeds().find((c) => c.templateId === "tpl_eng_heavy");
	store.importWorkflowTemplateSeed(seed);
	store.materializeWorkflowRun({
		runId: "run-1", issueId: "FLY-2018", projectName: "flywheel", taskCategory: "code",
		templateId: seed.templateId, claimsReadEnrolled: true, actor: "lead", env: WORKFLOW_ON,
		startReservation: {
			idempotencyKey: "s1", selectionDigest: "d1", nodeId: "design",
			attempt: 1, executionId: "design-1", createdAt: "2026-07-20T00:00:00.000Z",
		},
	});
	store.upsertWorkflowRunNode({ runId: "run-1", nodeId: "design", attempt: 1, state: "running", executionId: "design-1" });
	store.commitWorkflowTransitionTx({
		runId: "run-1", nodeId: "design", attempt: 1, executionId: "design-1",
		outcome: "design_done", successorExecutionId: "impl-1",
		subjectDigest: "a".repeat(40), now: "2026-07-20T00:05:00.000Z",
	});
	startImpl(store, "impl-1", "2026-07-20T00:06:00.000Z");
	return store;
}
function startImpl(store, execId, now) {
	store.admitGeneralizedWorkflowExecution({
		runId: "run-1", nodeId: "implement", executionId: execId, attempt: 1,
		expiresAt: "2026-07-20T05:00:00.000Z", absoluteDeadlineAt: "2026-07-21T00:00:00.000Z",
		now, env: WORKFLOW_ON,
	});
	store.applyWorkflowLedgerBatch({
		projectName: "flywheel", issueId: "FLY-2018", runId: "run-1",
		ops: [{ op: "side_effect", node: "implement", attempt: 1, executionId: execId, to: "started" }],
	});
	store.upsertWorkflowRunNode({ runId: "run-1", nodeId: "implement", attempt: 1, state: "running", executionId: execId });
	store.upsertSession({ execution_id: execId, issue_id: "FLY-2018", project_name: "flywheel", status: "failed", workflow_node_id: "implement" });
}
const ENV_FAIL = { failureClass: "environment", failureCode: "codex:unauthorized" };
function failWithIntent(store, execId, uid, now, cls) {
	const run = store.getWorkflowRun("run-1");
	const leadIntent = resolveWorkflowReplacementLeadIntent({
		projects: PROJECTS, run, labels: store.getSessionLabels(execId) ?? [],
	});
	return store.recordEnrolledTerminalSignal({
		executionId: execId, sourceEventId: uid, signal: "failed",
		failureKind: "goal_blocked", ...(cls ?? {}),
		lastError: "goal ended non-complete: blocked", source: "direct-event-sink",
		now, ...(leadIntent ? { leadIntent } : {}),
	});
}

// ── D1: the notice is written atomically with the terminal fact ─────────────
const store = await freshRun();
const rec = failWithIntent(store, "impl-1", "d1", "2026-07-20T00:09:00.000Z");
ok("D1 terminal signal recorded", rec.ok === true);
ok("D1 a replacement-eligibility Lead event was committed in the same write",
	typeof rec.leadEventSeq === "number", `seq=${rec.leadEventSeq}`);
const row = store.getLeadEventBySeq(rec.leadEventSeq);
ok("D1 the journal row is addressed to the run's owning Lead",
	row?.lead_id === "flywheel-eng-lead" && row?.event_type === "workflow_replacement_eligibility");
const payload = JSON.parse(row.payload);
console.log("[D1] payload:", JSON.stringify(payload, null, 1));
ok("D1 the stable event id is namespaced + fully qualified",
	payload.workflow_event_id === "workflow-replacement-eligibility:run-1:implement:1:impl-1:1");
const ledgerCreatedAt = store.listWorkflowSideEffects("run-1")
	.filter((e) => e.node_id === "implement")
	.at(-1)?.created_at;
const ledgerMs = Date.parse(`${String(ledgerCreatedAt).replace(" ", "T")}Z`);
ok("D1 next_check_at = the real dispatch ledger time + the shared 60s first back-off",
	Date.parse(payload.next_check_at) - ledgerMs === 60_000,
	`ledger=${ledgerCreatedAt} next=${payload.next_check_at}`);
ok("D1 disposition is replacement_candidate on the first death",
	payload.next_check_disposition === "replacement_candidate");
ok("D1 blind-replacement counter is honest (0 of 3 used)",
	payload.blind_replacements === 0 && payload.max_blind_replacements === 3);

// ── D2: render parity across BOTH Lead runtimes ─────────────────────────────
const envelope = leadEventEnvelopeFromJournalRow(row, 2);
const mailboxRt = new MailboxLeadRuntime({ leadId: "flywheel-eng-lead", transport: { send: async () => ({ ok: true }) } });
const commdbRt = new CommDBLeadRuntime(join(tmp, "render-probe.db"), "flywheel-eng-lead");
const a = mailboxRt.renderEnvelope(envelope);
const b = commdbRt.renderEnvelope(envelope);
console.log("\n[D2] rendered Lead-facing text:\n" + a.split("\n").map((l) => "   " + l).join("\n"));
ok("D2 both Lead runtimes render byte-identical text", a === b);
ok("D2 the rendered text carries the stable event id (so a duplicate is recognizable)",
	a.includes(payload.workflow_event_id));
ok("D2 the rendered text states the earliest re-check time", a.includes(payload.next_check_at));
ok("D2 the rendered text is conditional, not a promise that a body was minted",
	a.includes("若死亡确认") && a.includes("铸替换体"));

// ── D3: crash recovery — committed row, enqueue never ran ───────────────────
const queue = new MailboxQueue(join(tmp, "comm.db"));
const registry = {
	getRawForLead: () => ({ renderEnvelope: (e) => mailboxRt.renderEnvelope(e) }),
	enqueueLeadEvent: (env) =>
		enqueueLeadEvent({ queue, envelope: env, content: mailboxRt.renderEnvelope(env) }),
};
const undelivered = store.listUndeliveredWorkflowReplacementLeadEvents({
	leadId: "flywheel-eng-lead", projectName: "flywheel",
});
ok("D3 the projector sees the committed-but-unsent row", undelivered.length === 1);
const r1 = enqueueWorkflowReplacementLeadEvent({ store, registry, seq: rec.leadEventSeq });
ok("D3 first redrive inserts exactly one mailbox row", r1?.outcome === "inserted", JSON.stringify(r1));
const r2 = enqueueWorkflowReplacementLeadEvent({ store, registry, seq: rec.leadEventSeq });
ok("D3 a second scan is a quiet duplicate (no re-insert, no wake storm)", r2?.outcome === "active", JSON.stringify(r2));
const rows = queue.listByRecipient
	? queue.listByRecipient("flywheel-eng-lead")
	: null;
ok("D3 exactly one durable mailbox row exists for this notice",
	queue.getById(r1.deliveryId) !== undefined && (rows === null || rows.length === 1));

// ── D4: cross-deployment renderer drift must not wedge the redrive ─────────
const driftedRegistry = {
	getRawForLead: () => ({ renderEnvelope: (e) => `DRIFTED RENDERER ${e.seq}` }),
	enqueueLeadEvent: (env) =>
		enqueueLeadEvent({ queue, envelope: env, content: `DRIFTED RENDERER ${env.seq}` }),
};
let drift;
try {
	drift = enqueueWorkflowReplacementLeadEvent({ store, registry: driftedRegistry, seq: rec.leadEventSeq });
} catch (err) {
	drift = { threw: err.message };
}
ok("D4 a renderer text change does NOT wedge the redrive on mailbox identity conflict",
	drift?.outcome === "active", JSON.stringify(drift));
ok("D4 the first durable materialization is what the Lead keeps reading",
	queue.getById(r1.deliveryId)?.content?.includes(payload.workflow_event_id) === true);

// ── D5: stale execution produces no notice ─────────────────────────────────
const store2 = await freshRun();
failWithIntent(store2, "impl-1", "d5a", "2026-07-20T00:09:00.000Z");
store2.rollbackDeadWorkflowNodeExecution({
	runId: "run-1", nodeId: "implement", attempt: 1, deadExecutionId: "impl-1",
	newExecutionId: "impl-2", reason: "terminal_session_and_dead_probe",
	livenessEvidence: { liveness: "dead", observedAt: "2026-07-20T00:10:00.000Z" },
	now: "2026-07-20T00:10:00.000Z",
});
startImpl(store2, "impl-2", "2026-07-20T00:11:00.000Z"); // impl-1 is now stale
const stale = failWithIntent(store2, "impl-1", "d5b", "2026-07-20T00:12:00.000Z");
ok("D5 a non-current execution's death emits no eligibility notice",
	stale.ok === true && stale.leadEventSeq === undefined, JSON.stringify(stale.leadEventSeq));

// ── D6: environment-hold disposition is signalled honestly ─────────────────
const store3 = await freshRun();
failWithIntent(store3, "impl-1", "e1", "2026-07-20T00:09:00.000Z", ENV_FAIL);
store3.rollbackDeadWorkflowNodeExecution({
	runId: "run-1", nodeId: "implement", attempt: 1, deadExecutionId: "impl-1",
	newExecutionId: "impl-2", reason: "terminal_session_and_dead_probe",
	livenessEvidence: { liveness: "dead", observedAt: "2026-07-20T00:10:00.000Z" },
	now: "2026-07-20T00:10:00.000Z",
});
startImpl(store3, "impl-2", "2026-07-20T00:11:00.000Z");
const second = failWithIntent(store3, "impl-2", "e2", "2026-07-20T00:12:00.000Z", ENV_FAIL);
const p3 = JSON.parse(store3.getLeadEventBySeq(second.leadEventSeq).payload);
console.log("\n[D6] disposition:", p3.next_check_disposition);
ok("D6 the 2nd consecutive environment death is announced as an environment hold candidate",
	p3.next_check_disposition === "environment_hold_candidate");
const rendered3 = mailboxRt.renderEnvelope(leadEventEnvelopeFromJournalRow(store3.getLeadEventBySeq(second.leadEventSeq), 2));
console.log("[D6] rendered:\n" + rendered3.split("\n").map((l) => "   " + l).join("\n"));
ok("D6 the Lead-facing text says 环境类收口, not 铸替换体", rendered3.includes("环境类收口"));

store.close(); store2.close(); store3.close();
console.log("\n=== VERDICT ===");
let allOk = true;
for (const [n, pass, d] of results) {
	console.log(`  ${pass ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`);
	if (!pass) allOk = false;
}
process.exit(allOk ? 0 : 1);
