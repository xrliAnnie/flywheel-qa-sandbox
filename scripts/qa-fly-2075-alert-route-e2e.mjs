// QA·FLY-2075 — production route contract over the built teamlead dist.
//
// Ordinary alert: durable Claw mailbox row, zero Discord/alert_threads rows.
// Explicit escalation: isolated Discord root → thread → alert_threads row,
// carrying a fake founder snowflake so no real user can be pinged.
//
// Usage: pnpm --filter flywheel-teamlead build &&
//   node scripts/qa-fly-2075-alert-route-e2e.mjs
// Requires TEST_BOT_TOKEN_1. Production Bridge/state are never touched.

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tl = (path) => import(join(repoRoot, "packages/teamlead/dist", path));
const channelId = "1519421055805165842";
const tokenEnv = "TEST_BOT_TOKEN_1";
const token = process.env[tokenEnv];
if (!token) {
	console.error(`FATAL: ${tokenEnv} not set`);
	process.exit(2);
}

const mark = `[QA2075-${Date.now().toString().slice(-6)}]`;
const founderId = "100000000000000003";
const ownerLeadId = "claude-infra-bot-lead";
const root = mkdtempSync(join(tmpdir(), "qa-fly2075-"));
const dbFile = join(root, "state.db");
const commDbFile = join(root, "comm.db");
process.env.FLYWHEEL_ALERT_QUEUE_DIR = join(root, "queue");
process.env.FLYWHEEL_ALERT_DEADLETTER_DIR = join(root, "dead-letter");
process.env.FLYWHEEL_CLAIMS_DB = join(root, "claims.db");
process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV = tokenEnv;

const { StateStore } = await tl("StateStore.js");
const { LeadAlertNotifier } = await tl("LeadAlertNotifier.js");
const { AlertChannelHub, createDiscordOps } = await tl(
	"bridge/AlertChannelHub.js",
);
const { LeadInboxRuntime } = await tl("bridge/lead-inbox-runtime.js");
const { RuntimeRegistry } = await tl("bridge/runtime-registry.js");
const { buildInfraAlertRouting } = await tl("bridge/infra-alert-wiring.js");
const { createClaimsReader, createClaimsClaimer, resolveAlertDirsFromEnv } =
	await tl("bridge/lead-alert-helpers.js");

const projects = [
	{
		projectName: "flywheel",
		projectRoot: root,
		leads: [
			{
				agentId: ownerLeadId,
				chatChannel: channelId,
				alertChannel: channelId,
				alertBotTokenEnv: tokenEnv,
				match: { labels: ["Flywheel"] },
			},
		],
	},
];

const results = { pass: [], fail: [] };
const check = (name, condition, detail = "") =>
	(condition ? results.pass : results.fail).push(
		`${name}${detail ? ` — ${detail}` : ""}`,
	);
const discordFetch = (targetChannelId) =>
	JSON.parse(
		execFileSync(
			"curl",
			[
				"-s",
				"-H",
				`Authorization: Bot ${token}`,
				"-H",
				"User-Agent: FlywheelQA (https://flywheel, 1.0)",
				`https://discord.com/api/v10/channels/${targetChannelId}/messages?limit=30`,
			],
			{ encoding: "utf-8" },
		),
	);

const store = await StateStore.create(dbFile);
const inbox = new LeadInboxRuntime({
	projects,
	store,
	registry: new RuntimeRegistry(),
	commDbPathForProject: () => commDbFile,
	runLegacyCutover: () => {},
	adapterForLead: () => ({
		async deliverBatch(batch) {
			return {
				batchId: batch.batchId,
				memberIds: batch.members.map((member) => member.deliveryId),
				status: "accepted_new",
			};
		},
	}),
	runnerAdapterForProject: () => ({
		async deliver() {},
		resolveQuestion: () => undefined,
		close() {},
	}),
});
const notifier = new LeadAlertNotifier({
	store,
	projects,
	claimsReader: createClaimsReader(process.env.FLYWHEEL_CLAIMS_DB),
	claimsClaimer: createClaimsClaimer(process.env.FLYWHEEL_CLAIMS_DB),
	unifiedAlert: { channelId, repairBotTokenEnv: tokenEnv },
	...resolveAlertDirsFromEnv(process.env),
});
const rootPayloads = [];
const hub = new AlertChannelHub({
	store,
	notifier: {
		alert: (payload) => {
			rootPayloads.push(payload);
			return notifier.alert(payload);
		},
	},
	discord: createDiscordOps(() => [token]),
});
let mailboxReceipt;
const sink = buildInfraAlertRouting({
	store,
	projects,
	globalBotToken: token,
	rawSink: { alert: (payload) => hub.handle(payload) },
	ticketSink: {
		alert: async (payload) => {
			mailboxReceipt = inbox.enqueueInfraAlert(ownerLeadId, payload);
			return { queued: mailboxReceipt.queued };
		},
	},
	founderUserId: founderId,
});

const ordinary = {
	leadId: "bridge",
	projectName: "machine",
	eventId: `${mark}:ordinary`,
	eventType: "bridge_abnormal_exit",
	title: `${mark} ordinary alert`,
	body: "must stay in the Claw mailbox",
	severity: "warning",
};
const ordinaryResult = await sink.alert(ordinary);
const mailboxState = inbox.getLeadEventSettlement(
	"flywheel",
	mailboxReceipt?.deliveryId ?? "missing",
);
check("ordinary alert queued", ordinaryResult.queued === true);
check(
	"ordinary alert wrote one durable infra_alert mailbox row",
	mailboxReceipt?.deliveryId ===
		`infra_alert:${ownerLeadId}:bridge_abnormal_exit:${ordinary.eventId}`,
	mailboxReceipt?.deliveryId,
);
check(
	"ordinary alert is live in the durable mailbox",
	mailboxState.kind === "live" && mailboxState.state === "QUEUED",
	JSON.stringify(mailboxState),
);
check(
	"ordinary alert created zero alert_threads rows",
	store.listActiveAlertThreads().length === 0,
);

const escalation = {
	leadId: ownerLeadId,
	projectName: "flywheel",
	eventId: `${mark}:escalation`,
	eventType: "workflow_engine_escalation",
	title: `${mark} explicit escalation`,
	body: "must reach the isolated Discord Hub",
	severity: "severe",
};
const escalationResult = await sink.alert(escalation);
const ledger = store
	.listActiveAlertThreads()
	.find((row) => row.event_id === escalation.eventId);
check("escalation root sent", escalationResult.sent === true);
check(
	"escalation payload carries the fake founder mention",
	rootPayloads.at(-1)?.mentionUserId === founderId,
);
check(
	"escalation created a thread-backed alert_threads row",
	Boolean(ledger?.root_message_id && ledger.thread_id),
	ledger
		? `root=${ledger.root_message_id} thread=${ledger.thread_id}`
		: "missing",
);

await new Promise((resolve) => setTimeout(resolve, 2500));
const roots = discordFetch(channelId);
const rootMessage = roots.find((message) =>
	String(message.content ?? "").includes(`${mark} explicit escalation`),
);
const ordinaryMessage = roots.find((message) =>
	String(message.content ?? "").includes(`${mark} ordinary alert`),
);
const threadMessages = ledger?.thread_id ? discordFetch(ledger.thread_id) : [];
check("ordinary marker is absent from Discord", !ordinaryMessage);
check("escalation marker is present in Discord", Boolean(rootMessage));
check(
	"Discord root visibly names the fake founder id",
	String(rootMessage?.content ?? "").includes(`<@${founderId}>`),
);
check(
	"Discord thread contains the Hub acknowledgement",
	threadMessages.some((message) =>
		String(message.content ?? "").includes(`${mark} explicit escalation`),
	),
);

console.log(`marker=${mark}`);
console.log(
	`mailbox=${JSON.stringify({ deliveryId: mailboxReceipt?.deliveryId, settlement: mailboxState })}`,
);
console.log(`alert_threads=${JSON.stringify(ledger ?? null)}`);
console.log(`discord_root=${rootMessage?.id ?? "missing"}`);
console.log(`discord_thread=${ledger?.thread_id ?? "missing"}`);
for (const item of results.pass) console.log(`PASS ${item}`);
for (const item of results.fail) console.error(`FAIL ${item}`);

inbox.close();
store.close();
process.exit(results.fail.length === 0 ? 0 : 1);
