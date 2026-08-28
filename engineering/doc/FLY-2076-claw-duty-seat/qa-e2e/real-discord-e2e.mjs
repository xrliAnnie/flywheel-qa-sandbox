// QA FLY-2076 — one continuous, real-Discord acceptance chain.
//
// The same process and the same file-backed StateStore prove all required legs:
//   ON  → alert → real Discord root/thread → ticket → Claw CLI disposition ②
//   OFF → alert intake ledger only; no Discord, ticket, or Claw mailbox side effect
//   ON  → the SAME stable alert id delivers, without rebuilding or restarting
//
// Discord is never mocked. Isolation is the 529-Room test channel, a test bot,
// a temp StateStore/queue/claims tree, and fake snowflakes that cannot ping people.
// Usage: TEST_BOT_TOKEN_1=... node real-discord-e2e.mjs

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = (bin, args, env) =>
	new Promise((done) =>
		execFile(bin, args, { env, encoding: "utf8" }, (err, stdout, stderr) =>
			done({ code: err?.code ?? 0, stdout: stdout ?? "", stderr: stderr ?? "" }),
		),
	);

const repoRoot =
	process.env.QA_REPO_ROOT ?? "/Users/xiaorongli/Dev/flywheel-FLY-2076";
const tl = (path) => import(join(repoRoot, "packages/teamlead/dist", path));
const CHANNEL = "1519421055805165842"; // isolated #test-flywheel-alerts
const TOKEN_ENV = "TEST_BOT_TOKEN_1";
const TOKEN = process.env[TOKEN_ENV];
if (!TOKEN) {
	console.error(`FATAL: ${TOKEN_ENV} not set`);
	process.exit(2);
}

const stamp = Date.now();
const MARK = `[QA2076-${String(stamp).slice(-7)}]`;
const ON_EVENT = `qa2076-on-${stamp}`;
const OFF_EVENT = `qa2076-off-${stamp}`;
const DUTY_TOKEN = `duty-qa-${stamp}`;
const tmp = mkdtempSync(join(tmpdir(), "qa-fly2076-"));
process.env.FLYWHEEL_ALERT_QUEUE_DIR = join(tmp, "queue");
process.env.FLYWHEEL_ALERT_DEADLETTER_DIR = join(tmp, "deadletter");
process.env.FLYWHEEL_CLAIMS_DB = join(tmp, "claims.db");
process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV = TOKEN_ENV;

// Text-only fake mentions. Discord receives allowed_mentions.parse=[], so nobody
// is pinged in the test channel.
const CLAUDE_BOT = "100000000000000001";
const CODEX_BOT = "100000000000000002";
const TADASHI_BOT = "100000000000000003";
process.env.FLYWHEEL_CLAUDE_INFRA_BOT_USER_ID = CLAUDE_BOT;
process.env.FLYWHEEL_CODEX_INFRA_BOT_USER_ID = CODEX_BOT;

const { StateStore } = await tl("StateStore.js");
const { LeadAlertNotifier } = await tl("LeadAlertNotifier.js");
const { AlertChannelHub, createDiscordOps } = await tl(
	"bridge/AlertChannelHub.js",
);
const { buildInfraAlertRouting } = await tl("bridge/infra-alert-wiring.js");
const { initializeFlagStore, storeAlertSystemEnabled } = await tl(
	"bridge/flag-store-runtime.js",
);
const { createClaimsReader, createClaimsClaimer, resolveAlertDirsFromEnv } =
	await tl("bridge/lead-alert-helpers.js");
const { createAlertDutyRouter, dutyAuth } = await tl(
	"bridge/alert-duty-router.js",
);

const results = { pass: [], fail: [] };
const ok = (name, condition, detail = "") =>
	(condition ? results.pass : results.fail).push(
		`${name}${detail ? ` — ${detail}` : ""}`,
	);

const projects = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/qa-fly2076",
		generalChannel: CHANNEL,
		leads: [
			{
				agentId: "claude-infra-bot-lead",
				chatChannel: CHANNEL,
				match: { labels: ["infra"] },
				alertChannel: CHANNEL,
				alertBotTokenEnv: TOKEN_ENV,
				botUserId: CLAUDE_BOT,
			},
			{
				agentId: "flywheel-eng-lead",
				chatChannel: CHANNEL,
				match: { labels: ["eng"] },
				alertChannel: CHANNEL,
				alertBotTokenEnv: TOKEN_ENV,
				botUserId: TADASHI_BOT,
			},
		],
	},
];

const store = await StateStore.create(join(tmp, "state.db"));
// Explicitly exercise SQLite authority, never an inherited host-env bypass.
const flagStore = initializeFlagStore(store, {});
const alertEnabled = () => storeAlertSystemEnabled(flagStore);
const notifier = new LeadAlertNotifier({
	store,
	projects,
	deliveryEnabled: alertEnabled,
	claimsReader: createClaimsReader(process.env.FLYWHEEL_CLAIMS_DB),
	claimsClaimer: createClaimsClaimer(process.env.FLYWHEEL_CLAIMS_DB),
	unifiedAlert: { channelId: CHANNEL, repairBotTokenEnv: TOKEN_ENV },
	...resolveAlertDirsFromEnv(process.env),
});
const hub = new AlertChannelHub({
	store,
	notifier,
	discord: createDiscordOps(() => [TOKEN]),
});
const clawMailbox = [];
const routedAlertSink = buildInfraAlertRouting({
	store,
	projects,
	alertsEnabled: alertEnabled,
	globalBotToken: TOKEN,
	rawSink: { alert: (payload) => hub.handle(payload) },
	ticketSink: {
		alert: async (payload) => {
			clawMailbox.push(payload);
			return { queued: true };
		},
	},
	founderUserId: TADASHI_BOT,
});

const express = (
	await import(join(repoRoot, "packages/teamlead/node_modules/express/index.js"))
).default;
const app = express();
app.use(express.json({ limit: "512kb" }));
app.use(
	"/duty",
	dutyAuth(DUTY_TOKEN),
	createAlertDutyRouter({ store, projects, getAlertHub: () => hub }),
);
const server = createServer(app);
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const bridgeUrl = `http://127.0.0.1:${server.address().port}`;

const dget = async (path) => {
	const response = await fetch(`https://discord.com/api/v10${path}`, {
		headers: { Authorization: `Bot ${TOKEN}` },
	});
	return response.ok ? response.json() : { __status: response.status };
};
const dpost = async (path, body) => {
	const response = await fetch(`https://discord.com/api/v10${path}`, {
		method: "POST",
		headers: {
			Authorization: `Bot ${TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ ...body, allowed_mentions: { parse: [] } }),
	});
	return response.ok ? response.json() : { __status: response.status };
};

const alertPayload = (eventId, phase) => ({
	leadId: "claude-infra-bot-lead",
	projectName: "flywheel",
	eventId,
	eventType: "workflow_engine_escalation",
	title: `FLY-2076 ${phase} ${MARK}`,
	body: `真实全链验收 ${phase}; event=${eventId}`,
	severity: "warning",
});
const findDiscordMark = async (mark) => {
	const messages = await dget(`/channels/${CHANNEL}/messages?limit=100`);
	return Array.isArray(messages)
		? messages.find((message) => String(message.content ?? "").includes(mark))
		: undefined;
};

// 1. Default ON: alert → root/thread → ticket.
ok("default value is ON", alertEnabled() === true);
const onPayload = alertPayload(ON_EVENT, "ON");
const onResult = await routedAlertSink.alert(onPayload);
const onRow = store.getAlertThreadByEventId(ON_EVENT);
ok(
	"ON alert posts a real Discord root and opens a real thread/ticket",
	onResult.sent === true && !!onRow?.root_message_id && !!onRow?.thread_id,
	`result=${JSON.stringify(onResult)} status=${onRow?.ticket_status}`,
);
const onRoot = await dget(
	`/channels/${CHANNEL}/messages/${onRow?.root_message_id ?? "missing"}`,
);
ok(
	"ON root is re-fetched from Discord with ticket status NEW",
	String(onRoot.content ?? "").includes(MARK) &&
		/🎫 .* · 状态 NEW$/m.test(String(onRoot.content ?? "")),
	String(onRoot.content ?? "").split("\n").find((line) => line.startsWith("🎫")),
);

// 2. Claw triage ②: thread trace + real CLI handoff.
const triage = [
	`🧭 值守初审 · workflow_engine_escalation · 去向 ② 转 <@${TADASHI_BOT}>`,
	"看到:workflow engine 已把失败升级到 alerts 主管道。",
	"查了:只读 StateStore 与 thread 状态;未改系统状态试错。",
	"依据:contact book 命中 flywheel-eng-lead。",
	"根因线:暂判不清;已知到 workflow engine escalation 已持久化。",
	MARK,
].join("\n");
const triagePost = await dpost(`/channels/${onRow.thread_id}/messages`, {
	content: triage,
});
ok(
	"Claw disposition ② leaves a real thread trace with the R8 root-cause line",
	!!triagePost.id && triage.includes("根因线:") && triage.includes("去向 ②"),
	`message=${triagePost.id}`,
);
const cli = join(repoRoot, "packages/flywheel-comm/dist/index.js");
const cliResult = await run(
	"node",
	[
		cli,
		"alert-ticket",
		"handoff",
		"--event-id",
		ON_EVENT,
		"--to",
		"flywheel-eng-lead",
	],
	{
		...process.env,
		FLYWHEEL_ALERT_DUTY_TOKEN: DUTY_TOKEN,
		FLYWHEEL_BRIDGE_URL: bridgeUrl,
	},
);
const handed = store.getAlertThreadByEventId(ON_EVENT);
ok(
	"Claw CLI completes disposition ② and atomically stamps the ticket",
	cliResult.code === 0 &&
		handed?.ticket_status === "ESCALATED" &&
		handed?.owner_ref === "lead:flywheel-eng-lead" &&
		!!handed?.acked_at,
	`rc=${cliResult.code} status=${handed?.ticket_status} owner=${handed?.owner_ref}`,
);
const handedRoot = await dget(
	`/channels/${CHANNEL}/messages/${handed.root_message_id}`,
);
ok(
	"real Discord root re-renders the handoff owner and ESCALATED state",
	String(handedRoot.content ?? "").includes(`<@${TADASHI_BOT}>`) &&
		/· 状态 ESCALATED$/m.test(String(handedRoot.content ?? "")),
	String(handedRoot.content ?? "")
		.split("\n")
		.find((line) => line.startsWith("🎫")),
);

// 3. Hot OFF: ledger only, zero external/dispatch side effects.
const beforeOffMailboxCount = clawMailbox.length;
const alertFlag = store.getFlagValueRow("alert_system");
const disabled = store.applyFlagValueChange({
	name: "alert_system",
	rawTo: "0",
	expectedRevision: alertFlag.revision,
	actor: "bridge-local-operator",
	reason: "FLY-2076 continuous real-chain OFF proof",
});
ok("database flag write turns the running pipeline OFF", disabled.ok && !alertEnabled());
const offPayload = alertPayload(OFF_EVENT, "OFF");
const offResult = await routedAlertSink.alert(offPayload);
const offDiscord = await findDiscordMark(`FLY-2076 OFF ${MARK}`);
const offLedger = store
	.listUndeliveredLeadEvents()
	.find((row) => row.event_id === `alert-system-suppressed:${OFF_EVENT}`);
ok(
	"OFF alert is accepted into the existing lead_events ledger",
	!!offLedger && offLedger.payload === JSON.stringify(offPayload),
	`seq=${offLedger?.seq ?? "missing"}`,
);
ok(
	"OFF alert creates no Discord root/thread, ticket, or Claw mailbox delivery",
	offResult.skipped === "disabled" &&
		!offDiscord &&
		store.getAlertThreadByEventId(OFF_EVENT) === undefined &&
		clawMailbox.length === beforeOffMailboxCount,
	`result=${JSON.stringify(offResult)} discord=${offDiscord?.id ?? "none"} mailbox=${clawMailbox.length}`,
);

// 4. Hot ON again: same objects/process and SAME stable event id enter immediately.
const disabledRow = store.getFlagValueRow("alert_system");
const reenabled = store.applyFlagValueChange({
	name: "alert_system",
	rawTo: null,
	expectedRevision: disabledRow.revision,
	actor: "bridge-local-operator",
	reason: "FLY-2076 continuous real-chain ON proof",
});
ok(
	"database flag write turns the same running pipeline back ON",
	reenabled.ok && alertEnabled(),
);
const reonResult = await routedAlertSink.alert(offPayload);
const reonRow = store.getAlertThreadByEventId(OFF_EVENT);
ok(
	"RE-ON delivers the same stable event id and opens a ticket without restart",
	reonResult.sent === true && !!reonRow?.root_message_id && !!reonRow?.thread_id,
	`result=${JSON.stringify(reonResult)} status=${reonRow?.ticket_status}`,
);

server.close();
store.close?.();

console.log(`\n── QA FLY-2076 continuous real-Discord E2E (${MARK}) ──`);
console.log(`channel=#test-flywheel-alerts (${CHANNEL}) isolation=${tmp}`);
for (const pass of results.pass) console.log(`  ✓ ${pass}`);
for (const fail of results.fail) console.log(`  ✗ ${fail}`);
console.log(`\nPASS ${results.pass.length} FAIL ${results.fail.length}`);
process.exit(results.fail.length === 0 ? 0 : 1);
