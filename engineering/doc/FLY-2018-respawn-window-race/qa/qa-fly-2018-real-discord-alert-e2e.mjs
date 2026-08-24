// FLY-2018 independent QA — REAL Discord E2E in the isolated 529 QA Room.
//
// Chain under test, all real, no mocks:
//   real StateStore (temp file)
//     -> real rollbackDeadWorkflowNodeExecution environment breaker
//     -> real workflow alert outbox
//     -> real WorkflowEngineDispatcher.reconcileWorkflowEngineAlerts()
//     -> real buildInfraAlertRouting / LeadAlertNotifier / createDiscordOps
//     -> real HTTP POST to the isolated #test-flywheel-alerts channel
//     -> re-fetched from Discord to prove the founder-visible text landed.
//
// Isolation: temp alert queue/deadletter dirs, temp claims.db, temp StateStore,
// test bot token, 529 test channel. Production Bridge, channels, claims.db and
// alert spools are never touched (asserted at the end).
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const tl = (p) => import(join(repoRoot, "packages/teamlead/dist", p));

const CHANNEL = "1519421055805165842"; // test-flywheel-alerts (529 Room)
const TOKEN_ENV = "TEST_BOT_TOKEN_1";
const TOKEN = process.env[TOKEN_ENV];
if (!TOKEN) {
	console.error(`FATAL: ${TOKEN_ENV} not set`);
	process.exit(2);
}
const MARK = `[QA2018-${Date.now().toString().slice(-6)}]`;

const tmp = mkdtempSync(join(tmpdir(), "qa-fly2018-"));
process.env.FLYWHEEL_ALERT_QUEUE_DIR = join(tmp, "queue");
process.env.FLYWHEEL_ALERT_DEADLETTER_DIR = join(tmp, "dl");
process.env.FLYWHEEL_CLAIMS_DB = join(tmp, "claims.db");
process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV = TOKEN_ENV;

// production spool snapshot BEFORE (isolation proof)
const prodDirs = [
	join(homedir(), ".flywheel", "alerts", "queue"),
	join(homedir(), ".flywheel", "alerts", "deadletter"),
];
const snapshot = () =>
	prodDirs.map((d) => (existsSync(d) ? readdirSync(d).sort().join("|") : "<absent>"));
const before = snapshot();

const { StateStore } = await tl("StateStore.js");
const { LeadAlertNotifier } = await tl("LeadAlertNotifier.js");
const { createDiscordOps } = await tl("bridge/AlertChannelHub.js");
const { buildInfraAlertRouting } = await tl("bridge/infra-alert-wiring.js");
const { createClaimsReader, createClaimsClaimer, resolveAlertDirsFromEnv } =
	await tl("bridge/lead-alert-helpers.js");
const { WorkflowEngineDispatcher } = await tl("bridge/workflow-engine-dispatcher.js");
const { legacyWorkflowSeeds } = await tl("__tests__/fixtures/legacy-workflow-manifests.js");

const results = [];
const ok = (name, cond, detail = "") => results.push([name, !!cond, detail]);

const WORKFLOW_ON = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
};
const projects = [
	{
		projectName: "flywheel",
		projectRoot: join(tmp, "proj"),
		generalChannel: CHANNEL,
		leads: [
			{
				agentId: "flywheel-eng-lead",
				chatChannel: CHANNEL,
				match: { labels: ["eng"] },
				alertChannel: CHANNEL,
				alertBotTokenEnv: TOKEN_ENV,
			},
		],
	},
];

const store = await StateStore.create(join(tmp, "state.db"));
const seed = legacyWorkflowSeeds().find((c) => c.templateId === "tpl_eng_heavy");
store.importWorkflowTemplateSeed(seed);
store.materializeWorkflowRun({
	runId: "run-1", issueId: "FLY-2018", projectName: "flywheel", taskCategory: "code",
	templateId: seed.templateId, claimsReadEnrolled: true, actor: "lead", env: WORKFLOW_ON,
	startReservation: {
		idempotencyKey: "start-1", selectionDigest: "sel-1", nodeId: "design",
		attempt: 1, executionId: "design-1", createdAt: "2026-07-20T00:00:00.000Z",
	},
});
store.upsertWorkflowRunNode({ runId: "run-1", nodeId: "design", attempt: 1, state: "running", executionId: "design-1" });
store.commitWorkflowTransitionTx({
	runId: "run-1", nodeId: "design", attempt: 1, executionId: "design-1",
	outcome: "design_done", successorExecutionId: "impl-1",
	subjectDigest: "a".repeat(40), now: "2026-07-20T00:05:00.000Z",
});
const startImpl = (execId, now) => {
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
};
startImpl("impl-1", "2026-07-20T00:06:00.000Z");

// The exact sanitized text the real Codex daemon produced in the companion
// real-daemon probe (real message, real code).
const REAL_CAUSE =
	"goal ended non-complete: blocked — last turn error: Your access token could not be refreshed. Please log out and sign in again. [unauthorized]";
const ENV_FAIL = { failureClass: "environment", failureCode: "codex:unauthorized" };
const failIt = (execId, uid, now) =>
	store.recordEnrolledTerminalSignal({
		executionId: execId, sourceEventId: uid, signal: "failed",
		failureKind: "goal_blocked", ...ENV_FAIL, lastError: REAL_CAUSE,
		source: "direct-event-sink", now,
	});

failIt("impl-1", "u1", "2026-07-20T00:09:00.000Z");
store.rollbackDeadWorkflowNodeExecution({
	runId: "run-1", nodeId: "implement", attempt: 1, deadExecutionId: "impl-1",
	newExecutionId: "impl-2", reason: "terminal_session_and_dead_probe",
	alertIdentity: { leadId: "flywheel-eng-lead", projectName: "flywheel", leadResolution: "resolved" },
	livenessEvidence: { liveness: "dead", observedAt: "2026-07-20T00:10:00.000Z" },
	now: "2026-07-20T00:10:00.000Z",
});
startImpl("impl-2", "2026-07-20T00:11:00.000Z");
failIt("impl-2", "u2", "2026-07-20T00:12:00.000Z");
const held = store.rollbackDeadWorkflowNodeExecution({
	runId: "run-1", nodeId: "implement", attempt: 1, deadExecutionId: "impl-2",
	newExecutionId: "must-not-launch", reason: "terminal_session_and_dead_probe",
	alertIdentity: { leadId: "flywheel-eng-lead", projectName: "flywheel", leadResolution: "resolved" },
	livenessEvidence: { liveness: "dead", observedAt: "2026-07-20T00:13:00.000Z" },
	now: "2026-07-20T00:13:00.000Z",
});
ok("breaker held the run on the 2nd consecutive unauthorized death",
	held.ok === false && held.reason === "environment_failure_escalated" && store.getWorkflowRun("run-1")?.status === "held");

// ── real production alert chain ──
const notifier = new LeadAlertNotifier({
	store,
	projects,
	claimsReader: createClaimsReader(process.env.FLYWHEEL_CLAIMS_DB),
	claimsClaimer: createClaimsClaimer(process.env.FLYWHEEL_CLAIMS_DB),
	unifiedAlert: { channelId: CHANNEL, repairBotTokenEnv: TOKEN_ENV },
	...resolveAlertDirsFromEnv(process.env),
});
const discordOps = createDiscordOps(() => [TOKEN]);
// Same shape plugin.ts installs: notifier is the raw sink behind the routing.
const routedAlertSink = buildInfraAlertRouting({
	store,
	projects,
	globalBotToken: TOKEN,
	rawSink: { alert: (p) => notifier.alert(p) },
});
const alertSink = {
	current: {
		alert: async (p) => {
			const r = await routedAlertSink.alert({ ...p, title: `${p.title} ${MARK}` });
			console.log(`[sink] ${p.eventType}/${p.eventId} -> ${JSON.stringify(r)}`);
			return r;
		},
	},
};
const dispatcher = new WorkflowEngineDispatcher({
	store, projects, alertSink, now: () => new Date(),
});
const uid = "env_failure:run-1:implement:1:codex:unauthorized";
console.log("[diag] outbox row before drain:", JSON.stringify(store.getWorkflowAlertOutbox(uid)));
const finalized = await dispatcher.reconcileWorkflowEngineAlerts(5);
console.log("[diag] outbox row after drain :", JSON.stringify(store.getWorkflowAlertOutbox(uid)));
ok("workflow alert outbox drained through the production dispatcher", finalized >= 1, `finalized=${finalized}`);

// ── re-fetch from Discord: did the founder-visible text really land? ──
const res = await fetch(
	`https://discord.com/api/v10/channels/${CHANNEL}/messages?limit=25`,
	{ headers: { Authorization: `Bot ${TOKEN}` } },
);
if (!res.ok) {
	console.error(`FATAL: Discord fetch ${res.status}`);
	process.exit(2);
}
const messages = await res.json();
const mine = messages.filter((m) => JSON.stringify(m).includes(MARK));
console.log(`\n--- ${mine.length} message(s) with marker ${MARK} in #test-flywheel-alerts ---`);
for (const m of mine) {
	console.log(`\n[${m.id}] ${m.content?.slice(0, 900) ?? ""}`);
	for (const e of m.embeds ?? []) {
		console.log(`  embed.title: ${e.title ?? ""}`);
		console.log(`  embed.desc : ${(e.description ?? "").slice(0, 900)}`);
	}
}
const blob = JSON.stringify(mine);
ok("the alert really landed in the isolated 529 Discord channel", mine.length >= 1);
ok("it names the environment failure class + code", blob.includes("环境类失败") && blob.includes("codex:unauthorized"));
ok("it carries the REAL cause instead of the old fixed 'blocked' text",
	blob.includes("access token could not be refreshed") && blob.includes("[unauthorized]"));
ok("it states the honest recovery path (terminate, not rework)", blob.includes("terminate"));
ok("it says the run is held", blob.includes("held"));

// ── isolation proof ──
const after = snapshot();
ok("production alert queue/deadletter untouched", JSON.stringify(before) === JSON.stringify(after),
	`${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

store.close();
console.log("\n=== VERDICT ===");
let allOk = true;
for (const [name, pass, detail] of results) {
	console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!pass) allOk = false;
}
console.log(`\nEvidence: #test-flywheel-alerts (${CHANNEL}), marker ${MARK}`);
process.exit(allOk ? 0 : 1);
