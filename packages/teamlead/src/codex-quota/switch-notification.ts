import {
	isCodexIdentityLabel,
	isCodexSlotName,
} from "flywheel-claude-runner/bin/codex-account-core.mjs";
import { resetTimestamp } from "../account-heal/account-switch-notification.js";
import type { CodexQuotaWindow } from "./candidate-selector.js";

const EMAIL = /^[^\s@]+@[^\s@]+$/;
const MAX_DATE_MS = 8_640_000_000_000_000;

export interface CodexSwitchNotificationAccount {
	profile: string;
	accountKey: string;
	email: string | null;
	windows: CodexQuotaWindow[];
}

export interface CodexSwitchNotificationSnapshot {
	version: 1;
	from: CodexSwitchNotificationAccount;
	to: CodexSwitchNotificationAccount;
}

const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function parseAccount(
	value: unknown,
	kind: "source" | "target" | "manual_target",
): CodexSwitchNotificationAccount | null {
	if (
		!record(value) ||
		typeof value.profile !== "string" ||
		!(kind === "target"
			? isCodexSlotName(value.profile)
			: isCodexIdentityLabel(value.profile)) ||
		typeof value.accountKey !== "string" ||
		value.accountKey.length < 1 ||
		value.accountKey.length > 512 ||
		!Array.isArray(value.windows) ||
		value.windows.length > 2 ||
		!value.windows.every(
			(window) =>
				record(window) &&
				Number.isInteger(window.usedPercent) &&
				Number(window.usedPercent) >= 0 &&
				Number(window.usedPercent) <= 100 &&
				(window.resetsAt === null ||
					(typeof window.resetsAt === "number" &&
						Number.isSafeInteger(window.resetsAt) &&
						window.resetsAt > 0 &&
						window.resetsAt <= MAX_DATE_MS)),
		)
	)
		return null;
	const email = value.email;
	if (email !== null && (typeof email !== "string" || !EMAIL.test(email)))
		return null;
	return {
		profile: value.profile,
		accountKey: value.accountKey,
		email,
		windows: value.windows.map((window) => ({
			usedPercent: Number((window as Record<string, unknown>).usedPercent),
			resetsAt: (window as Record<string, unknown>).resetsAt as number | null,
		})),
	};
}

/**
 * FLY-2869: a manual switch can land on any canonical identity (someone ran
 * `codex login` or `codex-profile use`), so its target is an identity label;
 * an automatic switch only ever installs a pool slot.
 */
export function parseCodexSwitchNotificationSnapshot(
	value: unknown,
	options: { manual?: boolean } = {},
): CodexSwitchNotificationSnapshot | null {
	if (!record(value) || value.version !== 1) return null;
	const from = parseAccount(value.from, "source");
	const to = parseAccount(
		value.to,
		options.manual ? "manual_target" : "target",
	);
	return from && to ? { version: 1, from, to } : null;
}

function formatPercent(value: number): string {
	return Number.isInteger(value)
		? String(value)
		: value.toFixed(1).replace(/\.0$/, "");
}

function quotaTable(
	windows: readonly CodexQuotaWindow[],
	timezone: string,
): string[] {
	// Codex Pro currently exposes one weekly window. Until the protocol retains
	// window duration labels, two windows are ambiguous and must not be guessed.
	const weekly = windows.length === 1 ? windows[0] : undefined;
	const used = weekly ? `${formatPercent(weekly.usedPercent)}%` : "n/a";
	const left = weekly
		? `${formatPercent(Math.max(0, 100 - weekly.usedPercent))}%`
		: "n/a";
	const reset =
		weekly?.resetsAt == null
			? "n/a"
			: resetTimestamp(new Date(weekly.resetsAt).toISOString(), timezone);
	const line = ([window, usedCell, leftCell, resetCell]: [
		string,
		string,
		string,
		string,
	]) =>
		`${window.padEnd(7)} ${usedCell.padEnd(6)} ${leftCell.padEnd(6)} ${resetCell}`;
	return [
		"```text",
		line([
			"window",
			"used",
			"left",
			timezone === "America/Los_Angeles" ? "reset (PT)" : "reset (local)",
		]),
		line(["weekly", used, left, reset]),
		"```",
	];
}

function accountLines(
	label: "原账号" | "新账号",
	account: CodexSwitchNotificationAccount,
	timezone: string,
): string[] {
	return [
		`${label} **${account.profile}**`,
		account.email ?? "邮箱暂时未读到",
		...quotaTable(account.windows, timezone),
	];
}

/** Automatic switches are quota-triggered; FLY-2869 manual ones say so. */
export type CodexSwitchTrigger = "quota" | "manual";
const TRIGGER_LABEL: Record<CodexSwitchTrigger, string> = {
	quota: "quota:weekly",
	manual: "手动",
};

/** PRD §6.2 / D.2: Claude's N1 shape with only provider and window rows changed. */
export function formatCodexSwitchNotification(
	snapshot: CodexSwitchNotificationSnapshot,
	timezone: string,
	trigger: CodexSwitchTrigger = "quota",
): string {
	return [
		`Codex 已切号：**${snapshot.from.profile} → ${snapshot.to.profile}**（${TRIGGER_LABEL[trigger]}）`,
		"",
		...accountLines("原账号", snapshot.from, timezone),
		"",
		...accountLines("新账号", snapshot.to, timezone),
	].join("\n");
}
