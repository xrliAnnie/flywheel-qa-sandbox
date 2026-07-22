// FLY-1415 §5.3 场景③ — 完整 Discord E2E(模块驱动,不起全 Bridge、不碰生产 Bridge)
// 整条腿:真 StateStore 盲换耗尽 → 真 workflow_alert_outbox → 真 dispatcher.reconcileWorkflowEngineAlerts
//         → 真 LeadAlertNotifier → 真 Discord POST → 隔离频道 readback。
// 所属 Lead 权威链:run.selected_by(owning-lead)经真 resolveWorkflowRunAlertIdentity 解析。

import { resolveWorkflowRunAlertIdentity } from "/Users/xiaorongli/Dev/flywheel-FLY-1415/packages/teamlead/dist/bridge/plugin.js";
import { WorkflowEngineDispatcher } from "/Users/xiaorongli/Dev/flywheel-FLY-1415/packages/teamlead/dist/bridge/workflow-engine-dispatcher.js";
import { LeadAlertNotifier } from "/Users/xiaorongli/Dev/flywheel-FLY-1415/packages/teamlead/dist/LeadAlertNotifier.js";
import {
	MAX_BLIND_REPLACEMENTS,
	StateStore,
} from "/Users/xiaorongli/Dev/flywheel-FLY-1415/packages/teamlead/dist/StateStore.js";
import { loadBundledWorkflowSeeds } from "/Users/xiaorongli/Dev/flywheel-FLY-1415/packages/teamlead/dist/workflow-template.js";

const CHANNEL = "1519421055805165842"; // #test-flywheel-alerts (isolated)
const TOKEN = process.env.TEST_BOT_TOKEN_1;
const WORKFLOW_ON = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
};
const projects = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel",
		leads: [
			{
				agentId: "default-lead",
				chatChannel: "default-channel",
				match: { labels: ["ops"] },
			},
			{
				agentId: "owning-lead",
				chatChannel: "owner-channel",
				match: { labels: ["engineering"] },
			},
		],
	},
];

const out = [];
const rec = (name, pass, detail) => {
	out.push({ name, pass, detail });
	console.log(
		`${pass ? "PASS" : "FAIL"}  ${name}${detail ? " :: " + detail : ""}`,
	);
};
const dh = (...a) => fetch(...a);

async function discordGET(path) {
	const r = await dh(`https://discord.com/api/v10${path}`, {
		headers: { Authorization: `Bot ${TOKEN}` },
	});
	return { status: r.status, body: await r.json().catch(() => null) };
}

async function main() {
	if (!TOKEN) throw new Error("TEST_BOT_TOKEN_1 not in env");

	// ---------- positive control: token+channel really reachable ----------
	const ctrl = await discordGET(`/channels/${CHANNEL}`);
	rec(
		"阳性对照: 隔离频道 GET 200 (尺子校准)",
		ctrl.status === 200 && ctrl.body?.name === "test-flywheel-alerts",
		`status=${ctrl.status} name=${ctrl.body?.name}`,
	);

	// cursor: latest msg id BEFORE we deliver — readback reads only NEW msgs
	const pre = await discordGET(`/channels/${CHANNEL}/messages?limit=1`);
	const cursorId = pre.body?.[0]?.id ?? "0";
	console.log(`  pre-delivery cursor msg id = ${cursorId}`);

	// ---------- 1. seed run (selected_by = owning-lead) → implement-dead ----------
	const store = await StateStore.create(":memory:");
	const seed = loadBundledWorkflowSeeds().find(
		(c) => c.templateId === "tpl_eng_heavy",
	);
	store.importWorkflowTemplateSeed(seed);
	store.materializeWorkflowRun({
		runId: "run-1",
		issueId: "FLY-1335",
		projectName: "flywheel",
		taskCategory: "code",
		templateId: seed.templateId,
		claimsReadEnrolled: true,
		actor: "lead",
		env: WORKFLOW_ON,
		selection: {
			source: "lead",
			selectedBy: "owning-lead",
			reason: "issue owner",
		},
		startReservation: {
			idempotencyKey: "start-1",
			selectionDigest: "sel-1",
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			createdAt: "2026-07-20T00:00:00.000Z",
		},
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "design",
		attempt: 1,
		state: "running",
		executionId: "design-1",
	});
	store.commitWorkflowTransitionTx({
		runId: "run-1",
		nodeId: "design",
		attempt: 1,
		executionId: "design-1",
		outcome: "design_done",
		successorExecutionId: "implement-dead",
		now: "2026-07-20T00:05:00.000Z",
	});
	store.admitGeneralizedWorkflowExecution({
		runId: "run-1",
		nodeId: "implement",
		executionId: "implement-dead",
		attempt: 1,
		expiresAt: "2026-07-20T01:00:00.000Z",
		absoluteDeadlineAt: "2026-07-21T00:00:00.000Z",
		now: "2026-07-20T00:06:00.000Z",
		env: WORKFLOW_ON,
	});
	store.applyWorkflowShadowBatch({
		projectName: "flywheel",
		issueId: "FLY-1335",
		runId: "run-1",
		ops: [
			{
				op: "side_effect",
				node: "implement",
				attempt: 1,
				executionId: "implement-dead",
				to: "started",
			},
		],
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "implement",
		attempt: 1,
		state: "running",
		executionId: "implement-dead",
	});
	store.upsertSession({
		execution_id: "implement-dead",
		issue_id: "FLY-1335",
		project_name: "flywheel",
		status: "failed",
		workflow_node_id: "implement",
	});

	// ---------- 2. 所属 Lead 权威链: 真 resolveWorkflowRunAlertIdentity ----------
	const identity = resolveWorkflowRunAlertIdentity({
		store,
		projects,
		defaultLeadAgentId: "default-lead",
		projectName: "flywheel",
		issueId: "FLY-1335",
		runId: "run-1",
	});
	rec(
		"所属 Lead 权威链: 解析到 owning-lead (非 default), leadResolution=resolved",
		identity.leadId === "owning-lead" && identity.leadResolution === "resolved",
		JSON.stringify(identity),
	);

	// ---------- 3. 盲换耗尽: rollback ×3 replacements + 1 exhaust ----------
	const startAndFail = (execId, at) => {
		store.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "implement",
			executionId: execId,
			attempt: 1,
			expiresAt: "2026-07-20T05:00:00.000Z",
			absoluteDeadlineAt: "2026-07-21T00:00:00.000Z",
			now: at,
			env: WORKFLOW_ON,
		});
		store.applyWorkflowShadowBatch({
			projectName: "flywheel",
			issueId: "FLY-1335",
			runId: "run-1",
			ops: [
				{
					op: "side_effect",
					node: "implement",
					attempt: 1,
					executionId: execId,
					to: "started",
				},
			],
		});
		store.upsertWorkflowRunNode({
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
			state: "running",
			executionId: execId,
		});
		store.upsertSession({
			execution_id: execId,
			issue_id: "FLY-1335",
			project_name: "flywheel",
			status: "failed",
			workflow_node_id: "implement",
		});
	};
	let dead = "implement-dead";
	for (let retry = 1; retry <= 3; retry += 1) {
		const nx = `implement-retry-${retry}`,
			at = `2026-07-20T00:${10 + retry}:00.000Z`;
		const r = store.rollbackDeadWorkflowNodeExecution({
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
			deadExecutionId: dead,
			newExecutionId: nx,
			reason: "terminal_session_and_dead_probe",
			alertIdentity: identity,
			livenessEvidence: { liveness: "dead", observedAt: at },
			now: at,
		});
		if (!r.ok)
			throw new Error(
				`replacement ${retry} unexpectedly blocked: ${JSON.stringify(r)}`,
			);
		startAndFail(nx, at);
		dead = nx;
	}
	const midAlerts = store.listWorkflowAlertOutbox().length;
	rec(
		"盲换 3 次自愈期间 0 中途告警 (决策 B)",
		midAlerts === 0,
		`outbox during swaps=${midAlerts}`,
	);

	const exhaust = store.rollbackDeadWorkflowNodeExecution({
		runId: "run-1",
		nodeId: "implement",
		attempt: 1,
		deadExecutionId: dead,
		newExecutionId: "implement-retry-4",
		reason: "terminal_session_and_dead_probe",
		alertIdentity: identity,
		livenessEvidence: {
			liveness: "dead",
			observedAt: "2026-07-20T00:20:00.000Z",
		},
		now: "2026-07-20T00:20:00.000Z",
	});
	rec(
		"第 4 次盲换被拦 → retry_limit_exceeded",
		exhaust.ok === false && exhaust.reason === "retry_limit_exceeded",
		JSON.stringify(exhaust),
	);
	rec(
		"run 被 held",
		store.getWorkflowRun("run-1")?.status === "held",
		store.getWorkflowRun("run-1")?.status,
	);

	// ---------- 4. 验 outbox 里的耗尽告警 payload (人话 + owning-lead) ----------
	const outbox = store.listWorkflowAlertOutbox();
	const alertRow = outbox[0];
	const p = alertRow?.payload;
	rec("outbox 有 1 条耗尽告警", outbox.length === 1, `count=${outbox.length}`);
	rec(
		"告警 routed to owning-lead",
		p?.leadId === "owning-lead",
		`leadId=${p?.leadId}`,
	);
	rec(
		"告警 title 人话「盲换 3 次」",
		typeof p?.title === "string" &&
			p.title.includes(`盲换 ${MAX_BLIND_REPLACEMENTS} 次`),
		p?.title,
	);
	rec(
		"告警 body 人话「换了 3 次仍起不来」且不含 POST /api",
		typeof p?.body === "string" &&
			p.body.includes("换了 3 次仍起不来") &&
			!p.body.includes("POST /api"),
		p?.body,
	);
	rec(
		"metadata 全字段 (launchCount/maxBlindReplacements/management.terminate/leadResolution)",
		p?.metadata?.workflowEngine?.launchCount === 4 &&
			p?.metadata?.workflowEngine?.maxBlindReplacements === 3 &&
			!!p?.metadata?.workflowEngine?.management?.terminate &&
			p?.metadata?.workflowEngine?.leadResolution === "resolved",
		JSON.stringify(p?.metadata?.workflowEngine),
	);

	// ---------- 5. 真投递: dispatcher.reconcileWorkflowEngineAlerts → LeadAlertNotifier → 真 Discord ----------
	const notifier = new LeadAlertNotifier({
		store,
		projects,
		unifiedAlert: { channelId: CHANNEL, repairBotTokenEnv: "TEST_BOT_TOKEN_1" },
		queueDir: process.env.FLYWHEEL_ALERT_QUEUE_DIR,
		deadLetterDir: process.env.FLYWHEEL_ALERT_DEADLETTER_DIR,
	});
	let captured = null;
	const capturingSink = {
		alert: async (payload) => {
			const r = await notifier.alert(payload);
			captured = r;
			return r;
		},
	};
	const dispatcher = new WorkflowEngineDispatcher({
		store,
		startDispatcher: {
			dispatch: async () => {
				throw new Error("startDispatcher not used in alert drain");
			},
		},
		alertSink: { current: capturingSink },
	});
	const finalized = await dispatcher.reconcileWorkflowEngineAlerts();
	rec(
		"真 dispatcher drain 处理 1 条",
		finalized === 1,
		`finalized=${finalized}`,
	);
	rec(
		"LeadAlertNotifier.alert 返回 sent + channelId + messageId (真 Discord POST)",
		captured?.sent === true &&
			captured?.channelId === CHANNEL &&
			!!captured?.messageId,
		JSON.stringify(captured),
	);

	// outbox row 现应为 delivered/sent 终态
	const afterRow = store.getWorkflowAlertOutbox(alertRow.escalation_uid);
	rec(
		"outbox 行转终态 sent (投递已销账)",
		afterRow?.state === "sent",
		`state=${afterRow?.state}`,
	);
	const postedEvt = store
		.listWorkflowRunEvents("run-1")
		.filter((e) => e.kind === "workflow_engine_alert_posted");
	rec(
		"追加 workflow_engine_alert_posted 审计事件",
		postedEvt.length === 1,
		`count=${postedEvt.length}`,
	);

	// ---------- 6. Discord readback: 频道真收到该消息 (终点取证) ----------
	const mid = captured?.messageId;
	let readback = null;
	if (mid) readback = await discordGET(`/channels/${CHANNEL}/messages/${mid}`);
	const rbContent = readback?.body?.content ?? "";
	rec(
		"Discord readback: GET 该 message id = 200 (频道真收到)",
		readback?.status === 200,
		`status=${readback?.status}`,
	);
	rec(
		"Discord readback: 消息正文含人话「换了 3 次仍起不来」(终点取证,非工具自报)",
		rbContent.includes("换了 3 次仍起不来"),
		rbContent.slice(0, 200),
	);
	rec(
		"Discord readback: 正文含 issue FLY-1335 + node implement",
		rbContent.includes("FLY-1335") && rbContent.includes("implement"),
		`hasIssue=${rbContent.includes("FLY-1335")} hasNode=${rbContent.includes("implement")}`,
	);

	// negative control: a NEW message really appeared after the cursor
	const post = await discordGET(
		`/channels/${CHANNEL}/messages?after=${cursorId}&limit=10`,
	);
	const appeared =
		Array.isArray(post.body) && post.body.some((m) => m.id === mid);
	rec(
		"阴性对照: cursor 之后确有新消息且 id 匹配 (排除读到旧回声)",
		appeared,
		`new_after_cursor=${Array.isArray(post.body) ? post.body.length : "?"}`,
	);

	store.close();

	const failed = out.filter((r) => !r.pass);
	console.log(`\n=== E2E ${out.length - failed.length}/${out.length} PASS ===`);
	console.log(
		`EVIDENCE: channel=${CHANNEL} (#test-flywheel-alerts) messageId=${mid} url=https://discord.com/channels/1485787271192907816/${CHANNEL}/${mid}`,
	);
	process.exit(failed.length === 0 ? 0 : 1);
}
main().catch((e) => {
	console.error("HARNESS ERROR:", e);
	process.exit(2);
});
