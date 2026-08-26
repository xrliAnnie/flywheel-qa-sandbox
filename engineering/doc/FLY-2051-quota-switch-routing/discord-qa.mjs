import { sendQuotaMonitorAlert } from "../../../packages/teamlead/dist/account-heal/quota-monitor-alert.js";
import { formatAccountSwitchNotification } from "../../../packages/teamlead/dist/account-heal/quota-monitor.js";
import { readPoolProfileIdentity } from "../../../packages/teamlead/dist/account-heal/quota-monitor-credentials.js";

const marker = `FLY-2051-QA-${Date.now()}`;
const profilesDir = process.env.FLYWHEEL_CLAUDE_PROFILES_DIR?.trim()
	?? `${process.env.HOME}/.flywheel/claude-profiles`;
const fromIdentity = readPoolProfileIdentity(profilesDir, "shopping");
const toIdentity = readPoolProfileIdentity(profilesDir, "school");
if (!fromIdentity || !toIdentity) {
	throw new Error("missing trusted shopping/school identity anchors");
}
const usage = (fivePct, sevenPct, fiveReset, sevenReset, fablePct, fableReset) => ({
	raw: {
		five_hour: { utilization: fivePct, resets_at: fiveReset },
		seven_day: { utilization: sevenPct, resets_at: sevenReset },
		limits: [{
			kind: "weekly_scoped",
			percent: fablePct,
			resets_at: fableReset,
			scope: { model: { id: null, display_name: "Fable" }, surface: null },
		}],
	},
	fiveH: { pct: fivePct, resetsAt: fiveReset },
	sevenD: { pct: sevenPct, resetsAt: sevenReset },
});
const switchedBody = `${formatAccountSwitchNotification({
	from: {
		name: "shopping",
		email: fromIdentity.email,
		usage: usage(91, 74, "2026-08-26T00:00:00.000Z", "2026-08-31T15:00:00.000Z", 92, "2026-08-30T15:00:00.000Z"),
	},
	to: {
		name: "school",
		email: toIdentity.email,
		usage: usage(12, 8, "2026-08-26T02:00:00.000Z", "2026-09-01T15:00:00.000Z", 12, "2026-08-31T15:00:00.000Z"),
	},
	revive: { revived: 2, pending: 0, loginExpired: 0 },
	degraded: false,
	nowMs: Date.parse("2026-08-25T20:00:00.000Z"),
	timezone: "America/Los_Angeles",
})}\n\nQA: ${marker}`;
const controlBody = `${marker}; scope=5h; healthy_accounts=3`;

const switched = await sendQuotaMonitorAlert({
	kind: "account_switched",
	severity: "info",
	title: `[${marker}] Claude account switched QA`,
	body: switchedBody,
	signature: `${marker}-account-switched`,
});
const control = await sendQuotaMonitorAlert({
	kind: "quota_no_target",
	severity: "severe",
	title: `[${marker}] No Claude account has quota`,
	body: controlBody,
	signature: `${marker}-negative-control`,
});
if (switched.primary !== "sent" || control.primary !== "sent") {
	throw new Error(
		`delivery failed switched=${JSON.stringify(switched)} control=${JSON.stringify(control)}`,
	);
}

const notifyChannel = process.env.FLYWHEEL_NOTIFY_CHANNEL?.trim();
const alertChannel = process.env.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID?.trim();
const founderId = process.env.FLYWHEEL_FOUNDER_USER_ID?.trim();
const tokenName = process.env.FLYWHEEL_ALERT_SENDER_TOKEN_ENV?.trim();
const token = tokenName ? process.env[tokenName]?.trim() : undefined;
if (!notifyChannel || !alertChannel || !founderId || !token) {
	throw new Error("missing readback config");
}

const headers = { Authorization: `Bot ${token}` };
async function getJson(path) {
	const response = await fetch(`https://discord.com/api/v10${path}`, { headers });
	if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
	return response.json();
}

async function findMessage(channelId) {
	for (let attempt = 0; attempt < 6; attempt++) {
		const messages = await getJson(`/channels/${channelId}/messages?limit=50`);
		const found = messages.find((message) =>
			String(message.content ?? "").includes(marker),
		);
		if (found) return found;
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`message ${marker} not found in ${channelId}`);
}

const [switchMessage, controlMessage, notifyInfo, alertInfo] =
	await Promise.all([
		findMessage(notifyChannel),
		findMessage(alertChannel),
		getJson(`/channels/${notifyChannel}`),
		getJson(`/channels/${alertChannel}`),
	]);
const requiredSwitchFields = [
	"Claude 已自动切号：**shopping → school**",
	fromIdentity.email,
	toIdentity.email,
	"window  used   left   reset (PT)",
	"5h      91%    9%     08-25 Tue 17:00",
	"7d      74%    26%    08-31 Mon 08:00",
	"Fable   92%    8%     08-30 Sun 08:00",
	"5h      12%    88%    08-25 Tue 19:00",
	"7d      8%     92%    09-01 Tue 08:00",
	"Fable   12%    88%    08-31 Mon 08:00",
];
const switchContent = String(switchMessage.content ?? "");
const controlContent = String(controlMessage.content ?? "");
if (!switchContent.includes(`<@${founderId}>`)) {
	throw new Error("founder mention missing");
}
for (const field of requiredSwitchFields) {
	if (!switchContent.includes(field)) {
		throw new Error(`switch field missing: ${field}`);
	}
}
if ((switchContent.match(/```text/g) ?? []).length !== 2) {
	throw new Error("switch message does not contain two aligned quota tables");
}
const blocks = [...switchContent.matchAll(/```text\n([\s\S]*?)\n```/g)].map(
	(match) => match[1].split("\n"),
);
for (const block of blocks) {
	if (block.length !== 4 || block.some((line) => !/^[\x20-\x7e]+$/.test(line))) {
		throw new Error("quota table is not a four-line ASCII-only block");
	}
	const starts = [8, 15, 22];
	for (const line of block) {
		const widths = starts.map((start) =>
			Array.from(line.slice(0, start)).reduce((width, character) => {
				const code = character.codePointAt(0) ?? 0;
				return width + (code >= 0x20 && code <= 0x7e ? 1 : 2);
			}, 0),
		);
		if (
			widths.some((width, index) => width !== starts[index]) ||
			starts.some((start) => line[start] === " ")
		) {
			throw new Error(`quota table wcwidth drift: ${widths.join(",")}`);
		}
	}
}
if (
	/from5h=|to5h=|revived=|pending=|切号时|继续指令|仍在等待|已恢复|\(quota-monitor \/ account_switched\)/.test(
		switchContent,
	)
) {
	throw new Error("switch message contains superseded machine or alert-box copy");
}
if (!controlContent.includes("quota_no_target")) {
	throw new Error("negative control kind missing");
}

const switchUrl = `https://discord.com/channels/${notifyInfo.guild_id}/${notifyChannel}/${switchMessage.id}`;
const controlUrl = `https://discord.com/channels/${alertInfo.guild_id}/${alertChannel}/${controlMessage.id}`;
console.log(
	JSON.stringify({
		marker,
		switchedDelivery: switched.primary,
		switchMessageId: switchMessage.id,
		switchChannelName: notifyInfo.name,
		switchHasFounderMention: true,
		switchFieldsComplete: true,
		switchUrl,
		controlDelivery: control.primary,
		controlMessageId: controlMessage.id,
		controlChannelName: alertInfo.name,
		controlKind: "quota_no_target",
		controlUrl,
	}),
);
