// FLY-529: deterministic trigger for the Bridge-side alert writer path.
//
// Exercises the EXACT composition scripts/run-bridge.ts (plugin.ts) uses —
// resolveAlertDirsFromEnv(process.env) + createClaims{Reader,Claimer} +
// new LeadAlertNotifier({ unifiedAlert, ...dirs }).alert(payload) — against the
// real Discord API + the slot-local queue/claims/dead-letter dirs. This proves
// the Bridge writer path's channel delivery + filesystem isolation without
// needing a frozen Lead pane (the full LeadWatchdog → notifier trigger is
// FLY-368 downstream). Used by qa-fly-529-alert-smoke.sh.
//
// Required env (set by the smoke):
//   FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID  — the isolated test alert channel
//   FLYWHEEL_ALERT_REPAIR_BOT_TOKEN_ENV (optional, defaults CASS_BOT_TOKEN)
//   FLYWHEEL_ALERT_QUEUE_DIR / _DEADLETTER_DIR / FLYWHEEL_CLAIMS_DB — slot-local
//   QA_LEAD_ID / QA_PROJECT_NAME / QA_BOT_TOKEN_ENV — the test lead identity
//   QA_ALERT_TITLE — recognizable marker text
//   <QA_BOT_TOKEN_ENV> — the bot token value (so the owner-attributed send works)
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tl = (p) => import(join(repoRoot, "packages/teamlead/dist", p));

const { StateStore } = await tl("StateStore.js");
const { LeadAlertNotifier } = await tl("LeadAlertNotifier.js");
const { createClaimsReader, createClaimsClaimer, resolveAlertDirsFromEnv } =
	await tl("bridge/lead-alert-helpers.js");

const channelId = process.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID;
const repairBotTokenEnv =
	process.env.FLYWHEEL_ALERT_REPAIR_BOT_TOKEN_ENV || "CASS_BOT_TOKEN";
const leadId = process.env.QA_LEAD_ID;
const projectName = process.env.QA_PROJECT_NAME;
const botTokenEnv = process.env.QA_BOT_TOKEN_ENV;
const title = process.env.QA_ALERT_TITLE || "QA-529 bridge alert smoke";

for (const [k, v] of Object.entries({
	FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID: channelId,
	QA_LEAD_ID: leadId,
	QA_PROJECT_NAME: projectName,
	QA_BOT_TOKEN_ENV: botTokenEnv,
})) {
	if (!v) {
		console.error(`fire-bridge-alert: missing required env ${k}`);
		process.exit(2);
	}
}

const store = await StateStore.create(":memory:");
const projects = [
	{
		projectName,
		generalChannel: "",
		leads: [
			{
				agentId: leadId,
				botTokenEnv,
				alertChannel: channelId,
				alertFallbackToCore: false,
			},
		],
	},
];
const notifier = new LeadAlertNotifier({
	store,
	projects,
	claimsReader: createClaimsReader(process.env.FLYWHEEL_CLAIMS_DB),
	claimsClaimer: createClaimsClaimer(process.env.FLYWHEEL_CLAIMS_DB),
	unifiedAlert: { channelId, repairBotTokenEnv },
	// Same seam plugin.ts uses — slot-local queue/dead-letter when env is set.
	...resolveAlertDirsFromEnv(process.env),
});

const payload = {
	leadId,
	projectName,
	eventId: `qa-529-bridge-${process.pid}-${process.hrtime.bigint()}`,
	eventType: "rate_limit",
	title,
	body: "bridge writer-path isolation probe",
	severity: "warning",
};

try {
	const result = await notifier.alert(payload);
	console.log(JSON.stringify(result ?? { ok: true }));
	process.exit(0);
} catch (err) {
	console.error(`fire-bridge-alert: ${err?.message ?? err}`);
	process.exit(1);
}
