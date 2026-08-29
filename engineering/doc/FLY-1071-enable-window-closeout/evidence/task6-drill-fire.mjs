// FLY-1071 Task 6 — 注入演练(真告警走全链,runbook 步6 ①)。
// 非产品代码:住在 evidence/,不进 scripts/。
//
// 组合 = 生产 dist 的逐字同款(镜像 plugin.ts):
//   StateStore.create(":memory:") + createClaims{Reader,Claimer} + LeadAlertNotifier
//   + buildInfraAlertRouting(rawSink = notifier)
// 生产 plugin.ts 另有 AlertChannelHub(threads)与 createAlertRateLimiter 注入 ——
// 独立演练不自建(计划 6.3 硬证据边界:thread 生命周期/状态 edit/攒批 → 观察日真实工单取证)。
//
// 运行方式(必须 source 生产 env):
//   bash -c 'set -a; source ~/.flywheel/.env; set +a; node task6-drill-fire.mjs'
//
// 前置门(全过才 POST):
//   1) env 指针:SENDER 与 REPAIR 两个 *_TOKEN_ENV 都必须指向 FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN
//      (root 帖作者 = dispatcher 的生产不变量,由 SENDER 那个 env 决定 — Codex R1 #2)
//   2) FLYWHEEL_ALERT_ROUTING=1 + FLYWHEEL_ALERT_TICKETS=1(🎫 头 + owner 富化开着)
//   3) 等效渲染 owner:provider 由 leadId 的 backend 派生(codex-app-server → codex),
//      login_expired ∈ ACCOUNT_AUTH_KINDS → 跨援 → owner 必须恰好 = claw;
//      不满足「恰好一个 owner mention 且 = claw」→ 拒绝 POST(Codex R1 #1/#3)

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DIST = "/Users/xiaorongli/Dev/flywheel/packages/teamlead/dist";
const tl = (p) => import(join(DIST, p));

const { StateStore } = await tl("StateStore.js");
const { LeadAlertNotifier } = await tl("LeadAlertNotifier.js");
const { createClaimsReader, createClaimsClaimer, resolveAlertDirsFromEnv } =
	await tl("bridge/lead-alert-helpers.js");
const { buildInfraAlertRouting } = await tl("bridge/infra-alert-wiring.js");
const {
	ownerRegistryFromEnv,
	deriveTicketProvider,
	resolveTicketOwner,
	ownerTicketFace,
} = await tl("bridge/ticket-owner-map.js");

const CLAW_ID = "1524829037825101975"; // claw-infra-bot(唯一合法 @-target)
const DISPATCH_ENV = "FLYWHEEL_ALERT_DISPATCH_BOT_TOKEN";

const fail = (msg) => {
	console.error(`[drill] REFUSE: ${msg}`);
	process.exit(3);
};

// --- 门 1:env 指针(sender 不变量) ---
const senderPtr = process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV?.trim();
const repairPtr = process.env.FLYWHEEL_ALERT_REPAIR_BOT_TOKEN_ENV?.trim();
console.log(`[drill] FLYWHEEL_ALERT_SENDER_TOKEN_ENV = ${senderPtr}`);
console.log(`[drill] FLYWHEEL_ALERT_REPAIR_BOT_TOKEN_ENV = ${repairPtr}`);
if (senderPtr !== DISPATCH_ENV)
	fail(`SENDER 指针必须 = ${DISPATCH_ENV},实际 ${senderPtr}`);
if (repairPtr !== DISPATCH_ENV)
	fail(`REPAIR 指针必须 = ${DISPATCH_ENV},实际 ${repairPtr}`);
if (!process.env[DISPATCH_ENV]?.trim())
	fail(`${DISPATCH_ENV} 未设置(是否忘了 source ~/.flywheel/.env?)`);

// --- 门 2:routing + tickets 开关 ---
if (process.env.FLYWHEEL_ALERT_ROUTING !== "1")
	fail("FLYWHEEL_ALERT_ROUTING != 1");
if (process.env.FLYWHEEL_ALERT_TICKETS !== "1")
	fail("FLYWHEEL_ALERT_TICKETS != 1");
const channelId = process.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID?.trim();
if (!channelId) fail("FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID 未设置");

// --- 真 projects.json(与 Bridge 同一份 config) ---
const rawProjects = JSON.parse(
	readFileSync(join(homedir(), ".flywheel/projects.json"), "utf8"),
);
const projects = Array.isArray(rawProjects)
	? rawProjects
	: (rawProjects.projects ?? []);
const fly = projects.find((p) => p.projectName === "flywheel");
if (!fly) fail("projects.json 里找不到 flywheel 项目");

// --- payload 合同(Codex R1 #3):provider 由 leadId 的 backend 派生,kind 本身不够 ---
const payload = {
	leadId: "codex-infra-bot-lead", // codex 后端 → provider=codex → 跨援归 claw
	projectName: "flywheel",
	eventId: `fly1071-drill-${process.pid}-${process.hrtime.bigint()}`,
	eventType: "login_expired", // ∈ ACCOUNT_AUTH_KINDS(账号/auth 类)
	title: "[FLY-1071 演练 可删] codex-infra auth 演练工单",
	body: "演练:真告警走全链(FLY-1049 runbook 步6 ①)。注入的演练工单,owner 认领 ACK 即可,无需真修。收口后可删。",
	severity: "warning",
	// 刻意无 sessionKey:unbound → Router 直通 rawSink(unified 频道工单路径)
};

// --- 门 3:owner 等效渲染(与 infra-alert-wiring enrich 同一批 dist 函数) ---
const reg = ownerRegistryFromEnv(process.env);
const lead = fly.leads?.find((l) => l.agentId === payload.leadId);
if (!lead) fail(`flywheel 项目里找不到 lead ${payload.leadId}`);
const provider = deriveTicketProvider({ leadBackend: lead.backend ?? null });
const owner = resolveTicketOwner(payload.eventType, provider, reg);
const face = ownerTicketFace(owner);
console.log(
	`[drill] preflight owner render: backend=${lead.backend} provider=${provider} owner=${JSON.stringify(owner)} face=${JSON.stringify(face)}`,
);
if (provider !== "codex") fail(`provider 应为 codex,实际 ${provider}`);
if (face.ownerUserId !== CLAW_ID)
	fail(
		`owner mention 必须恰好 = claw(${CLAW_ID}),实际 ${face.ownerUserId ?? "(null → 不会 ping)"}`,
	);
if (face.ownerUserId === process.env.FLYWHEEL_INFRA_BOT_USER_ID?.trim())
	fail("owner 解析成了 Codex bot — 跨援方向反了");
console.log(
	"[drill] preflight PASS — 恰好一个 owner mention 且 = claw,放行 POST",
);

// --- 组合并发射(镜像 plugin.ts;Hub/rate-limiter 刻意不建,见文件头边界) ---
const store = await StateStore.create(":memory:");
const notifier = new LeadAlertNotifier({
	store,
	projects,
	claimsReader: createClaimsReader(process.env.FLYWHEEL_CLAIMS_DB),
	claimsClaimer: createClaimsClaimer(process.env.FLYWHEEL_CLAIMS_DB),
	unifiedAlert: { channelId, repairBotTokenEnv: repairPtr },
	...resolveAlertDirsFromEnv(process.env),
});
const routed = buildInfraAlertRouting({ store, projects, rawSink: notifier });

try {
	const result = await routed.alert(payload);
	console.log(`[drill] result: ${JSON.stringify(result ?? { ok: true })}`);
	console.log(`[drill] eventId: ${payload.eventId}`);
	process.exit(0);
} catch (err) {
	console.error(`[drill] alert failed: ${err?.message ?? err}`);
	process.exit(1);
}
