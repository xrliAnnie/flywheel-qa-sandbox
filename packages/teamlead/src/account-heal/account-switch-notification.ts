import type { CandidatePanoramaEntry } from "./account-candidate-selector.js";
import {
	type AccountStore,
	ackSwitchNotification,
	peekSwitchNotification,
} from "./account-store.js";
import type { DeliveryReport } from "./quota-monitor-alert.js";
import {
	type AccountUsageResult,
	findModelScopedQuota,
} from "./quota-usage-api.js";

type SuccessfulUsage = Extract<AccountUsageResult, { ok: unknown }>["ok"];
const MAX_NOTIFICATION_BODY = 4_000;
const TRUNCATED_SUFFIX = "\n… [truncated]";

export type SwitchNotificationTrigger =
	| { kind: "manual"; mode: "use" | "next" }
	| { kind: "quota" | "repair"; scope: "5h" | "weekly" | "both" }
	| { kind: "model"; models: readonly string[] };

export interface SwitchNotificationAccount {
	name: string;
	email: string | null;
	usage?: SuccessfulUsage | null;
}

export interface SwitchNotificationFormatInput {
	from: SwitchNotificationAccount;
	to: SwitchNotificationAccount;
	trigger: SwitchNotificationTrigger;
	timezone: string;
	panorama: readonly CandidatePanoramaEntry[];
	headroomDegraded?: boolean;
	cooldownFallbackName?: string;
}

interface LocalDateTime {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
}

function localDateTime(ms: number, timezone: string): LocalDateTime | null {
	if (!Number.isFinite(ms)) return null;
	try {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		}).formatToParts(new Date(ms));
		const read = (type: "year" | "month" | "day" | "hour" | "minute") =>
			Number(parts.find((part) => part.type === type)?.value);
		const value = {
			year: read("year"),
			month: read("month"),
			day: read("day"),
			hour: read("hour"),
			minute: read("minute"),
		};
		return Object.values(value).every(Number.isFinite) ? value : null;
	} catch {
		return null;
	}
}

const ASCII_WEEKDAYS = [
	"Sun",
	"Mon",
	"Tue",
	"Wed",
	"Thu",
	"Fri",
	"Sat",
] as const;

function resetTimestamp(resetAt: string | null, timezone: string): string {
	if (resetAt === null) return "not started";
	const reset = localDateTime(Date.parse(resetAt), timezone);
	if (!reset) return "n/a";
	const weekday =
		ASCII_WEEKDAYS[
			new Date(Date.UTC(reset.year, reset.month - 1, reset.day)).getUTCDay()
		]!;
	return `${String(reset.month).padStart(2, "0")}-${String(reset.day).padStart(2, "0")} ${weekday} ${String(reset.hour).padStart(2, "0")}:${String(reset.minute).padStart(2, "0")}`;
}

function formatPct(value: number): string {
	return Number.isInteger(value)
		? String(value)
		: value.toFixed(1).replace(/\.0$/, "");
}

function quotaTable(
	usage: SuccessfulUsage | null | undefined,
	timezone: string,
): string[] {
	const fable = usage ? findModelScopedQuota(usage.raw, "Fable") : null;
	const cells = (
		pct: number | null,
		resetsAt: string | null,
	): [string, string, string] => {
		if (pct === null) return ["n/a", "n/a", "n/a"];
		return [
			`${formatPct(pct)}%`,
			`${formatPct(Math.max(0, 100 - pct))}%`,
			resetTimestamp(resetsAt, timezone),
		];
	};
	const rows: Array<[string, string, string, string]> = [
		["5h", ...cells(usage?.fiveH.pct ?? null, usage?.fiveH.resetsAt ?? null)],
		["7d", ...cells(usage?.sevenD.pct ?? null, usage?.sevenD.resetsAt ?? null)],
		["Fable", ...cells(fable?.pct ?? null, fable?.resetsAt ?? null)],
	];
	const line = ([window, used, remaining, reset]: [
		string,
		string,
		string,
		string,
	]) => `${window.padEnd(7)} ${used.padEnd(6)} ${remaining.padEnd(6)} ${reset}`;
	return [
		"```text",
		line([
			"window",
			"used",
			"left",
			timezone === "America/Los_Angeles" ? "reset (PT)" : "reset (local)",
		]),
		...rows.map(line),
		"```",
	];
}

function accountUsageLines(
	account: SwitchNotificationAccount,
	timezone: string,
): string[] {
	return [
		account.email ?? "邮箱暂时未读到",
		...quotaTable(account.usage, timezone),
	];
}

function triggerLabel(trigger: SwitchNotificationTrigger): string {
	switch (trigger.kind) {
		case "manual":
			return `manual:${trigger.mode}`;
		case "quota":
		case "repair":
			return `${trigger.kind}:${trigger.scope}`;
		case "model":
			return `model:${trigger.models.join("+")}`;
	}
}

/** The only success-notification copy for manual, quota, model, and repair switches. */
export function formatSwitchNotification(
	input: SwitchNotificationFormatInput,
): string {
	const skipped = [...input.panorama]
		.filter((entry) => entry.excludedBy !== null)
		.sort((a, b) => a.name.localeCompare(b.name, "en-US"))
		.map((entry) => `${entry.name}:${entry.status}`);
	const body = [
		`Claude 已切号：**${input.from.name} → ${input.to.name}**（${triggerLabel(input.trigger)}）`,
		...(input.cooldownFallbackName === undefined
			? []
			: ["", `cooldown fallback to ${input.cooldownFallbackName}`]),
		...(input.headroomDegraded
			? ["", "weekly 有粮但 5h 已过 trigger；已按最早 weekly reset 切换。"]
			: []),
		...(skipped.length > 0 ? ["", `skipped=${skipped.join(",")}`] : []),
		"",
		`原账号 **${input.from.name}**`,
		...accountUsageLines(input.from, input.timezone),
		"",
		`新账号 **${input.to.name}**`,
		...accountUsageLines(input.to, input.timezone),
	].join("\n");
	if (body.length <= MAX_NOTIFICATION_BODY) return body;
	let prefix = body.slice(0, MAX_NOTIFICATION_BODY - TRUNCATED_SUFFIX.length);
	const finalCodeUnit = prefix.charCodeAt(prefix.length - 1);
	if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
		prefix = prefix.slice(0, -1);
	}
	return `${prefix}${TRUNCATED_SUFFIX}`;
}

export interface SwitchNotificationDrainDeps {
	withAccountsLock: <T>(fn: () => Promise<T>) => Promise<T>;
	readStore: () => Promise<AccountStore>;
	writeStore: (store: AccountStore) => Promise<void>;
	send: (alert: SwitchNotificationIntentAlert) => Promise<DeliveryReport>;
}

type SwitchNotificationIntentAlert = NonNullable<
	AccountStore["pendingSwitchNotifications"]
>[number]["alert"];

export type SwitchNotificationDrainResult =
	| { outcome: "empty" }
	| { outcome: "acknowledged" | "pending"; primary: DeliveryReport["primary"] };

const CONFIRMED_DELIVERIES = new Set<DeliveryReport["primary"]>([
	"sent",
	"duplicate",
	"queued_transient",
	"dead_lettered",
]);

/** Peek under lock, send outside it, then acknowledge only the exact event id. */
export async function drainSwitchNotification(
	deps: SwitchNotificationDrainDeps,
): Promise<SwitchNotificationDrainResult> {
	const intent = await deps.withAccountsLock(async () =>
		peekSwitchNotification(await deps.readStore()),
	);
	if (intent === null) return { outcome: "empty" };

	let report: DeliveryReport;
	try {
		report = await deps.send(intent.alert);
	} catch {
		report = { primary: "process_error" };
	}
	if (!CONFIRMED_DELIVERIES.has(report.primary)) {
		return { outcome: "pending", primary: report.primary };
	}

	await deps.withAccountsLock(async () => {
		const current = await deps.readStore();
		const next = ackSwitchNotification(current, intent.eventId);
		if (next !== current) await deps.writeStore(next);
	});
	return { outcome: "acknowledged", primary: report.primary };
}
