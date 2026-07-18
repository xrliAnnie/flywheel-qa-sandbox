/**
 * QA·FLY-1365 — Capability ② part B: REAL Discord delivery ("实发实收").
 *
 * Drives the EXACT production alert composition (same seams plugin.ts uses):
 *   buildAbnormalExitAlertContent(prev, stall)  ← the FLY-1365 attributed content
 *   → new LeadAlertNotifier({...isolated dirs}).alert({ eventType:"bridge_abnormal_exit",
 *       eventId: abnormalExitTicketEventId(prev), severity:"severe", title, body })
 *   → REAL Discord API POST to the ISOLATED test-flywheel-alerts channel.
 *
 * Isolation: slot-local queue/claims/deadletter (env), isolated channel + TEST bot.
 * Production ~/.flywheel/alert-queue|deadletter|alerts/claims.db are NOT touched.
 *
 * Emits a JSON line: {sent, messageId, latencyMs, body}. The bash wrapper verifies
 * receipt + latency<30s + prod-dir isolation.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	abnormalExitTicketEventId,
	type BridgeExitMarker,
	type BridgeWatchdogStallRecord,
	buildAbnormalExitAlertContent,
} from "../../../../packages/teamlead/src/bridge/bridge-exit-marker.js";
import {
	createClaimsClaimer,
	createClaimsReader,
	resolveAlertDirsFromEnv,
} from "../../../../packages/teamlead/src/bridge/lead-alert-helpers.js";
import { LeadAlertNotifier } from "../../../../packages/teamlead/src/LeadAlertNotifier.js";
import { StateStore } from "../../../../packages/teamlead/src/StateStore.js";

const channelId = process.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID!;
const leadId = process.env.QA_LEAD_ID!;
const projectName = process.env.QA_PROJECT_NAME!;
const botTokenEnv = process.env.QA_BOT_TOKEN_ENV!;
const marker = process.env.QA_ALERT_MARKER || `fly1365-${process.pid}`;

for (const [k, v] of Object.entries({
	FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID: channelId,
	QA_LEAD_ID: leadId,
	QA_PROJECT_NAME: projectName,
	QA_BOT_TOKEN_ENV: botTokenEnv,
})) {
	if (!v) {
		console.error(`cap2b: missing required env ${k}`);
		process.exit(2);
	}
}

// Isolated dirs so production alert-queue/claims/deadletter are never touched.
const iso = mkdtempSync(join(tmpdir(), "fly1365-cap2b-"));
process.env.FLYWHEEL_ALERT_QUEUE_DIR = join(iso, "queue");
process.env.FLYWHEEL_ALERT_DEADLETTER_DIR = join(iso, "deadletter");
process.env.FLYWHEEL_CLAIMS_DB = join(iso, "claims.db");

// A realistic dirty-Bridge generation + its matching watchdog stall record,
// exactly like the 07-18 09:35 incident (main-loop wedged on the sync ensure).
const prev: BridgeExitMarker = {
	pid: 30576,
	bootTs: Date.now() - 120_000,
	state: "running",
};
const stall: BridgeWatchdogStallRecord = {
	event: "bridge_event_loop_stall",
	pid: prev.pid,
	bootTs: prev.bootTs,
	stall_age_ms: 64298,
	at: new Date(prev.bootTs + 61_000).toISOString(),
	last_sync_op: "codex-tui:tmux-exec",
};

// THE FLY-1365 attributed content — the exact function the boot emission site calls.
const content = buildAbnormalExitAlertContent(prev, stall);
// Tag the body with a unique marker so the verifier can find exactly this message.
const body = `${content.body}\n[qa-marker ${marker}]`;

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
const loggingFetch = async (url: any, init: any): Promise<any> => {
	const auth: string = init?.headers?.Authorization ?? "";
	const res = await (globalThis.fetch as any)(url, init);
	if (process.env.QA_DEBUG_FETCH) {
		let txt = "";
		try {
			txt = await res.clone().text();
		} catch {
			/* ignore */
		}
		console.error(
			`[fetch] ${init?.method ?? "GET"} ${url} auth=${auth.slice(0, 12)}… → ${res.status} ${txt.slice(0, 160)}`,
		);
	}
	return res;
};

const notifier = new LeadAlertNotifier({
	store,
	projects,
	claimsReader: createClaimsReader(process.env.FLYWHEEL_CLAIMS_DB),
	claimsClaimer: createClaimsClaimer(process.env.FLYWHEEL_CLAIMS_DB),
	unifiedAlert: { channelId, repairBotTokenEnv: botTokenEnv },
	fetchFn: loggingFetch,
	...resolveAlertDirsFromEnv(process.env),
} as any);

const payload = {
	leadId,
	projectName,
	eventId: abnormalExitTicketEventId(prev), // real dedup id (pid:bootTs)
	eventType: "bridge_abnormal_exit" as const,
	title: content.title,
	body,
	severity: "severe" as const,
};

const sentAt = Date.now();
try {
	const result: any = await notifier.alert(payload);
	console.log(
		JSON.stringify({
			ok: true,
			sentAt,
			marker,
			title: content.title,
			attributed: content.title.includes("卡死自杀"),
			messageId: result?.messageId ?? result?.id ?? null,
			result: result ?? null,
			isoDir: iso,
		}),
	);
	process.exit(0);
} catch (err: any) {
	console.error(`cap2b: alert() threw: ${err?.message ?? err}`);
	process.exit(1);
}
