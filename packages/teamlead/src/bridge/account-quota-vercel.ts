/**
 * FLY-2875 — the account page's Vercel section.
 *
 * One live row for the report-hosting account (from the stored reading) plus
 * the founder-declared retired accounts. The page shows aliases only
 * (FLY-2688): the live alias comes from matching the reading's email digest
 * against the Claude account emails already in Bridge memory. A next charge
 * date is shown only for Pro, where the billing period end is the renewal;
 * everything unread is 「读不到（原因）」, never a guess.
 */

import { createHash } from "node:crypto";
import type {
	VercelAccountStore,
	VercelReadNote,
} from "../vercel-quota/vercel-account-store.js";
import { formatAccountQuotaPageDate } from "./account-quota-page.js";

export interface VercelQuotaRow {
	name: string;
	planDisplay: string;
	team: string | null;
	active: boolean;
	retired: boolean;
	note: string | null;
	nextCharge: string;
	blobLines: string[];
}

export interface VercelQuotaSection {
	observedAt: string | null;
	rows: VercelQuotaRow[];
}

/**
 * Accounts the founder retired from report hosting. No token exists for them
 * on this machine, so they carry no live facts (FLY-2875 Lead ruling).
 */
export const RETIRED_VERCEL_ACCOUNTS: ReadonlyArray<{
	alias: string;
	plan: string;
}> = [{ alias: "personal2", plan: "Hobby" }];

const LIVE_FALLBACK_NAME = "报告托管账号";

const REASONS: Record<VercelReadNote, string> = {
	refresh_failed: "本轮读取出错",
	no_token: "本机没有 Vercel token",
	no_store_binding: "报告托管未绑定 store",
	registry_unreadable: "托管注册表读不到",
	unauthorized: "token 已失效",
	forbidden: "接口拒绝",
	not_found: "store 不在这个号",
	owner_mismatch: "store 不在这个号",
	rate_limited: "接口限流",
	http_error: "接口未返回",
	network: "接口未返回",
	malformed: "接口返回格式不对",
	deadline: "本轮超时",
};

const PLAN_DISPLAY: Record<string, string> = {
	pro: "Pro",
	hobby: "Hobby",
	enterprise: "Enterprise",
};

const unread = (reason: string) => `读不到（${reason}）`;
const NEVER_READ = unread("尚未读取");
const USAGE_SHARE_LINE = "本期占比：读不到（接口不给额度上限）";

export function formatVercelBytes(bytes: number): string {
	if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} KB`;
	if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
	return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

function aliasFor(
	emailSha256: string,
	claudeEmails: Readonly<Record<string, string>> | undefined,
): string | null {
	const matches = Object.entries(claudeEmails ?? {})
		.filter(
			([, email]) =>
				createHash("sha256")
					.update(email.trim().toLowerCase())
					.digest("hex") === emailSha256,
		)
		.map(([name]) => name)
		.sort((left, right) => left.localeCompare(right, "en-US"));
	return matches[0] ?? null;
}

function nextCharge(
	account: NonNullable<VercelAccountStore["account"]>,
	generatedAt: string,
): string {
	if (account.plan === "hobby") return "不扣费（Hobby 免费）";
	// Only Pro is evidenced to renew (and charge) at the billing period end.
	if (account.plan !== "pro") return unread("接口未给扣费日");
	if (account.canceled) {
		return account.periodEnd === null
			? "已取消"
			: `已取消 · ${formatAccountQuotaPageDate(account.periodEnd)} 到期`;
	}
	if (account.billingStatus !== "active") {
		return unread(`账单状态 ${account.billingStatus ?? "未知"}`);
	}
	if (account.periodEnd === null) return unread("接口未给账期");
	if (Date.parse(account.periodEnd) <= Date.parse(generatedAt)) {
		return unread("读数已过期");
	}
	return formatAccountQuotaPageDate(account.periodEnd);
}

function blobLines(store: VercelAccountStore): string[] {
	const blob = store.blob;
	if (blob === null) return [unread(REASONS[store.blobNote ?? "malformed"])];
	const status = blob.status.startsWith("limits-exceeded")
		? "超额被停"
		: blob.usageQuotaExceeded
			? "已超额"
			: blob.status === "available"
				? "正常"
				: `状态 ${blob.status}`;
	return [
		status,
		`已存 ${formatVercelBytes(blob.sizeBytes)} · ${blob.count} 个对象`,
		USAGE_SHARE_LINE,
	];
}

function unreadLiveRow(reason: string): VercelQuotaRow {
	const display = unread(reason);
	return {
		name: LIVE_FALLBACK_NAME,
		planDisplay: display,
		team: null,
		active: false,
		retired: false,
		note: null,
		nextCharge: display,
		blobLines: [display],
	};
}

function liveRow(
	store: VercelAccountStore | null,
	options: {
		generatedAt: string;
		claudeEmails?: Readonly<Record<string, string>>;
	},
): VercelQuotaRow {
	if (store === null) {
		return { ...unreadLiveRow("尚未读取"), blobLines: [NEVER_READ] };
	}
	const account = store.account;
	if (account === null) {
		const row = unreadLiveRow(REASONS[store.accountNote ?? "malformed"]);
		return { ...row, blobLines: blobLines(store) };
	}
	return {
		name:
			aliasFor(account.emailSha256, options.claudeEmails) ?? account.username,
		planDisplay: PLAN_DISPLAY[account.plan] ?? account.plan,
		team: `team ${account.teamSlug}`,
		active: store.blob !== null,
		retired: false,
		note: null,
		nextCharge: nextCharge(account, options.generatedAt),
		blobLines: blobLines(store),
	};
}

function retiredRows(liveName: string): VercelQuotaRow[] {
	return RETIRED_VERCEL_ACCOUNTS.filter(({ alias }) => alias !== liveName).map(
		({ alias, plan }) => ({
			name: alias,
			planDisplay: plan,
			team: null,
			active: false,
			retired: true,
			note: "已停用，不再使用",
			nextCharge: "已停用",
			blobLines: ["不再使用"],
		}),
	);
}

/** Never throws: a broken reading becomes a fixed 「读不到」 live row. */
export function buildVercelQuotaSection(
	store: VercelAccountStore | null,
	options: {
		generatedAt: string;
		claudeEmails?: Readonly<Record<string, string>>;
	},
): VercelQuotaSection {
	let live: VercelQuotaRow;
	try {
		live = liveRow(store, options);
	} catch {
		live = unreadLiveRow(REASONS.malformed);
	}
	return {
		observedAt: store?.observedAt ?? null,
		rows: [live, ...retiredRows(live.name)],
	};
}
