import type {
	AccountQuotaRow,
	AccountQuotaView,
	QuotaCell,
} from "./account-quota-view.js";
import {
	resolveAccountSubscriptionConfirmation,
	type SubscriptionConfirmation,
	type SubscriptionProvider,
} from "./account-subscription-manual.js";

const PAGE_TIMEZONE = "America/Los_Angeles";

export type AccountQuotaPageGroup = "available" | "full" | "unavailable";

export interface AccountQuotaPageRow {
	row: AccountQuotaRow;
	weeklyPct: number | null;
	fablePct: number | null;
	weeklyResetAt: string | null;
	fiveHResetAt: string | null;
	weeklyResetDisplay: string | null;
	fiveHResetDisplay: string | null;
	group: AccountQuotaPageGroup;
}

export interface AccountQuotaPageSection {
	group: AccountQuotaPageGroup;
	label: string | null;
	rows: AccountQuotaPageRow[];
}

export interface AccountQuotaMachineSubscription {
	status: "active" | "canceled" | "unknown";
	observedAt: string | null;
}

export interface AccountQuotaPageContext {
	confirmations?: readonly SubscriptionConfirmation[];
	identityKeys?: Readonly<Record<string, string>>;
	machineSubscriptions?: Readonly<
		Record<string, AccountQuotaMachineSubscription>
	>;
	onSubscriptionResolutionError?: (failure: {
		provider: SubscriptionProvider;
		profile: string;
		error: "identity_missing" | "identity_mismatch";
	}) => void;
}

export function reconcileCodexAccountSubscriptionIdentityKeys(
	liveIdentityKeys: Readonly<Record<string, string>>,
	readingIdentityKeys: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
	return Object.fromEntries(
		Object.entries(liveIdentityKeys).filter(([key, identityKey]) => {
			const readingIdentityKey = readingIdentityKeys[key];
			return (
				readingIdentityKey === undefined || readingIdentityKey === identityKey
			);
		}),
	);
}

function pagePct(cell: QuotaCell): number | null {
	if (cell.source !== "machine" || cell.rawValue === undefined) return null;
	if (
		typeof cell.rawValue !== "number" ||
		!Number.isFinite(cell.rawValue) ||
		cell.rawValue < 0 ||
		cell.rawValue > 100
	) {
		throw new Error("invalid page quota percentage");
	}
	return cell.rawValue;
}

function pageInstant(cell: QuotaCell): string | null {
	if (cell.source !== "machine" || cell.rawInstant === undefined) return null;
	const parsed = Date.parse(cell.rawInstant);
	if (
		!Number.isFinite(parsed) ||
		new Date(parsed).toISOString() !== cell.rawInstant
	) {
		throw new Error("invalid page quota instant");
	}
	return cell.rawInstant;
}

function pageInstantDisplay(cell: QuotaCell): string | null {
	return cell.source === "machine" && cell.display === "已取消"
		? cell.display
		: null;
}

function groupOf(weeklyPct: number | null): AccountQuotaPageGroup {
	if (weeklyPct === null) return "unavailable";
	return weeklyPct === 100 ? "full" : "available";
}

function comparePageRows(
	left: AccountQuotaPageRow,
	right: AccountQuotaPageRow,
): number {
	const leftTime =
		left.weeklyResetAt === null
			? Number.POSITIVE_INFINITY
			: Date.parse(left.weeklyResetAt);
	const rightTime =
		right.weeklyResetAt === null
			? Number.POSITIVE_INFINITY
			: Date.parse(right.weeklyResetAt);
	if (leftTime !== rightTime) return leftTime - rightTime;
	return left.row.name.localeCompare(right.row.name, "en-US");
}

function projectRow(row: AccountQuotaRow): AccountQuotaPageRow {
	const weeklyPct = pagePct(row.weeklyUsage);
	return {
		row,
		weeklyPct,
		fablePct: pagePct(row.fableUsage),
		weeklyResetAt: pageInstant(row.weeklyReset),
		fiveHResetAt: pageInstant(row.fiveHReset),
		weeklyResetDisplay: pageInstantDisplay(row.weeklyReset),
		fiveHResetDisplay: pageInstantDisplay(row.fiveHReset),
		group: groupOf(weeklyPct),
	};
}

/**
 * Build page-only groups without mutating the shared view consumed by patrol.
 * Tier, active state, 5h/Fable usage, staleness and the legacy sort key are
 * deliberately absent from the comparator.
 */
export function buildAccountQuotaPageSections(
	rows: readonly AccountQuotaRow[],
): AccountQuotaPageSection[] {
	const projected = rows.map(projectRow);
	const definitions: ReadonlyArray<{
		group: AccountQuotaPageGroup;
		label: string | null;
	}> = [
		{ group: "available", label: null },
		{ group: "full", label: null },
		{ group: "unavailable", label: "本轮读数不可用" },
	];
	return definitions.flatMap(({ group, label }) => {
		const grouped = projected
			.filter((item) => item.group === group)
			.sort(comparePageRows);
		return grouped.length === 0 ? [] : [{ group, label, rows: grouped }];
	});
}

export function formatAccountQuotaPageInstant(iso: string): string {
	const parsed = Date.parse(iso);
	if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== iso) {
		throw new Error("invalid page quota instant");
	}
	const parts = new Intl.DateTimeFormat("zh-CN", {
		timeZone: PAGE_TIMEZONE,
		month: "2-digit",
		day: "2-digit",
		weekday: "short",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(new Date(parsed));
	const values = Object.fromEntries(
		parts.map((part) => [part.type, part.value]),
	);
	if (
		!values.month ||
		!values.day ||
		!values.weekday ||
		!values.hour ||
		!values.minute
	) {
		throw new Error("invalid page quota date parts");
	}
	return `${values.month}/${values.day} ${values.weekday} ${values.hour}:${values.minute}`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function formatPct(value: number): string {
	return `${Number.isInteger(value) ? value : value.toFixed(1).replace(/\.0$/, "")}%`;
}

function renderProgress(
	value: number | null,
	dimension: "周" | "Fable",
): string {
	if (value === null) return '<span class="quota-na">无</span>';
	const full = value === 100;
	const label = full
		? `<span class="dimension-full">${dimension}已满</span>`
		: `<span class="dimension-label">${dimension}</span>`;
	return `<div class="quota-meter${full ? " dimension-is-full" : ""}"><div class="meter-copy"><span class="quota-pct">${formatPct(value)}</span>${label}</div><progress max="100" value="${value}" aria-label="${dimension}用量" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}">${formatPct(value)}</progress></div>`;
}

function pageTier(row: AccountQuotaRow): string {
	if (row.provider !== "Claude" || row.name !== "business") {
		return row.subscriptionTier.display;
	}
	const machine =
		row.subscriptionTier.source === "machine"
			? row.subscriptionTier.display.match(/(\d+)x/i)?.[1]
			: undefined;
	return machine
		? `机器读数 ${machine}x / 你说 20x，待你确认`
		: "机器档位未知 / 你说 20x，待你确认";
}

function renderIdentity(pageRow: AccountQuotaPageRow): string {
	const { row } = pageRow;
	const active = row.active
		? '<span class="active-dot"></span><span class="active-chip">在用</span>'
		: "";
	const accountMissing = row.accountMissing
		? '<span class="account-note">无机器数据</span>'
		: "";
	const note = row.note
		? `<span class="account-note">${escapeHtml(row.note)}</span>`
		: "";
	return `<td class="account-cell"><div class="account-name">${active}${escapeHtml(row.name)}</div><div class="account-tier">${escapeHtml(pageTier(row))}</div>${accountMissing}${note}</td>`;
}

function renderInstant(value: string | null, display: string | null): string {
	return display !== null
		? `<span class="reset-time">${escapeHtml(display)}</span>`
		: value === null
			? '<span class="quota-na">无</span>'
			: `<span class="reset-time">${escapeHtml(formatAccountQuotaPageInstant(value))}</span>`;
}

function renderCards(cell: QuotaCell): string {
	const display =
		cell.source === "missing" && cell.display === "—" ? "无" : cell.display;
	return `<div class="card-lines">${display
		.split("\n")
		.map((line) => `<span class="card-line">${escapeHtml(line)}</span>`)
		.join("")}</div>`;
}

function validMachineSubscription(
	value: AccountQuotaMachineSubscription | undefined,
): value is AccountQuotaMachineSubscription {
	if (value === undefined) return false;
	if (!(["active", "canceled", "unknown"] as const).includes(value.status)) {
		throw new Error("invalid machine subscription status");
	}
	if (
		value.observedAt !== null &&
		(!Number.isFinite(Date.parse(value.observedAt)) ||
			new Date(Date.parse(value.observedAt)).toISOString() !== value.observedAt)
	) {
		throw new Error("invalid machine subscription observation");
	}
	return true;
}

function subscriptionText(
	row: AccountQuotaRow,
	context: AccountQuotaPageContext,
): string | null {
	const key = `${row.provider}:${row.name}`;
	const identityKey = context.identityKeys?.[key] ?? null;
	const resolved = resolveAccountSubscriptionConfirmation(
		context.confirmations ?? [],
		{
			provider: row.provider as SubscriptionProvider,
			profile: row.name,
			identityKey,
		},
	);
	if (resolved.error !== null) {
		context.onSubscriptionResolutionError?.({
			provider: row.provider as SubscriptionProvider,
			profile: row.name,
			error: resolved.error,
		});
	}
	const machineCandidate = context.machineSubscriptions?.[key];
	const machine = validMachineSubscription(machineCandidate)
		? machineCandidate
		: undefined;
	const manual = resolved.error === null ? resolved.confirmation : null;
	if (
		manual?.status === "active" &&
		machine?.status === "canceled" &&
		machine.observedAt !== null &&
		Date.parse(machine.observedAt) > Date.parse(manual.confirmedAt)
	) {
		return "未知 · 状态待核对";
	}
	if (manual?.status === "active") return null;
	if (manual?.status === "unknown") return "未知";
	if (manual?.status === "canceled") {
		return manual.expiresOn === null
			? "已取消 · 日期待确认"
			: `已取消 · ${manual.expiresOn.slice(5).replace("-", "/")}`;
	}
	return machine?.status === "canceled" ? "已取消 · 日期待确认" : "未知";
}

function renderSubscription(
	row: AccountQuotaRow,
	context: AccountQuotaPageContext,
): string {
	const display = subscriptionText(row, context);
	return display === null
		? '<td class="subscription-empty"></td>'
		: `<td><span class="subscription-state">${escapeHtml(display)}</span></td>`;
}

function renderPageRow(
	pageRow: AccountQuotaPageRow,
	context: AccountQuotaPageContext,
): string {
	const { row } = pageRow;
	const classes = ["quota-row", row.active ? "active-account" : ""]
		.filter(Boolean)
		.join(" ");
	const token =
		row.provider === "Codex"
			? `<td><span class="token-status">${escapeHtml(row.tokenStatus.display === "打满" ? "正常" : row.tokenStatus.display)}</span></td>`
			: "";
	const fable =
		row.provider === "Claude"
			? `<td>${renderProgress(pageRow.fablePct, "Fable")}</td>`
			: "";
	return `<tr class="${classes}">${renderIdentity(pageRow)}${token}<td>${renderInstant(pageRow.weeklyResetAt, pageRow.weeklyResetDisplay)}</td><td>${renderInstant(pageRow.fiveHResetAt, pageRow.fiveHResetDisplay)}</td><td>${renderProgress(pageRow.weeklyPct, "周")}</td>${fable}<td>${renderCards(row.credits)}</td>${renderSubscription(row, context)}</tr>`;
}

function renderSectionRows(
	sections: readonly AccountQuotaPageSection[],
	columnCount: number,
	context: AccountQuotaPageContext,
): string {
	const spacer = `<tbody class="quota-group-spacer" aria-hidden="true"><tr><td colspan="${columnCount}"></td></tr></tbody>`;
	return sections
		.map(
			(section) =>
				`<tbody class="quota-group" data-group="${section.group}">${
					section.label === null
						? ""
						: `<tr class="group-title"><td colspan="${columnCount}">${escapeHtml(section.label)}</td></tr>`
				}${section.rows.map((item) => renderPageRow(item, context)).join("")}</tbody>`,
		)
		.join(spacer);
}

function renderTable(
	provider: "Claude" | "Codex",
	rows: readonly AccountQuotaRow[],
	unavailable: readonly string[],
	context: AccountQuotaPageContext,
): string {
	const claude = provider === "Claude";
	const tokenHeader = claude ? "" : "<th>token 状态</th>";
	const fableHeader = claude ? "<th>Fable 周用量</th>" : "";
	const cardHeader = claude ? "充值卡" : "兑换卡";
	const unavailableRows =
		unavailable.length === 0
			? ""
			: `<tbody class="provider-unavailable"><tr><td colspan="7">${[
					...new Set(unavailable),
				]
					.map((reason) => `<span>${escapeHtml(reason)}</span>`)
					.join("")}</td></tr></tbody>`;
	return `<section class="provider-table provider-${provider.toLowerCase()}"><h2>${provider}</h2><div class="table-wrap"><table><thead><tr><th>账号</th>${tokenHeader}<th>周重置日</th><th>5h reset</th><th>周用量</th>${fableHeader}<th>${cardHeader}</th><th>订阅到期</th></tr></thead>${unavailableRows}${renderSectionRows(buildAccountQuotaPageSections(rows), 7, context)}</table></div></section>`;
}

export function renderAccountQuotaPageHtml(
	view: AccountQuotaView,
	context: AccountQuotaPageContext = {},
): string {
	return `<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width,initial-scale=1">
	<title>账号额度一览</title>
	<style>
		:root{color-scheme:light;--ink:#1d1d1f;--muted:#6e6e73;--line:#e3e1dc;--paper:#fbfaf7;--page:#f0efec;--ok:#1f7a68;--active-bg:#e3f4ec;--full:#c0392b;--full-bg:#fdf0ee;--track:#e9e7e2}
		*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",system-ui,sans-serif}main{max-width:1280px;margin:0 auto;background:var(--paper);min-height:100vh;padding:38px 28px 48px}header{display:flex;align-items:baseline;justify-content:space-between;gap:16px;border-bottom:2px solid var(--ink);padding-bottom:14px}h1{margin:0;font-size:25px;letter-spacing:-.02em}.generated{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}section{margin-top:30px}h2{font-size:17px;margin:0 0 8px}.table-wrap{overflow-x:auto}table{width:100%;min-width:990px;border-collapse:collapse;border:1px solid var(--line)}th,td{text-align:left;padding:12px 13px;border-bottom:1px solid var(--line);vertical-align:middle}th{font-size:11px;letter-spacing:.06em;color:var(--muted);white-space:nowrap}.provider-unavailable td{color:var(--muted);font-size:12px}.provider-unavailable span{display:block}.quota-group-spacer td{height:10px;padding:0;border:0;background:var(--paper)}.quota-group[data-group="full"] .quota-row td{background:var(--full-bg)}.group-title td{background:var(--paper);color:var(--muted);font-size:12px;font-weight:650;letter-spacing:.04em;padding-top:15px;padding-bottom:6px}.active-account td{background:var(--active-bg)!important}.active-account td:first-child{box-shadow:inset 4px 0 0 var(--ok)}.account-name{display:flex;align-items:center;gap:7px;font-weight:700}.active-dot{width:8px;height:8px;border-radius:50%;background:var(--ok);flex:none}.active-chip{font-size:10px;color:var(--ok);background:#d8eee6;border-radius:5px;padding:1px 6px}.account-tier,.account-note{display:block;color:var(--muted);font-size:11px;margin-top:4px;max-width:240px;white-space:normal}.reset-time,.token-status,.card-lines{font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.card-lines{display:flex;flex-direction:column}.quota-na{color:#a1a1a6}.quota-meter{min-width:118px}.meter-copy{display:flex;align-items:baseline;gap:6px;margin-bottom:5px}.quota-pct{font:650 13px ui-monospace,SFMono-Regular,Menlo,monospace}.dimension-label{font-size:10px;color:var(--muted)}.dimension-full{font-size:10px;font-weight:700;color:var(--full)}progress{display:block;width:100%;height:6px;border:0;border-radius:3px;overflow:hidden;background:var(--track);accent-color:var(--ok)}progress::-webkit-progress-bar{background:var(--track)}progress::-webkit-progress-value{background:var(--ok)}progress::-moz-progress-bar{background:var(--ok)}.dimension-is-full progress{accent-color:var(--full)}.dimension-is-full progress::-webkit-progress-value{background:var(--full)}.dimension-is-full progress::-moz-progress-bar{background:var(--full)}.dimension-is-full .quota-pct{color:var(--full)}.subscription-state{white-space:nowrap}.subscription-empty{min-width:70px}@media(max-width:700px){main{padding:26px 14px 40px}header{display:block}.generated{margin-top:8px}h1{font-size:23px}}
	</style>
</head>
<body><main><header><h1>账号额度一览</h1><div class="generated">${escapeHtml(formatAccountQuotaPageInstant(view.generatedAt))}</div></header>${renderTable("Claude", view.claude, view.claudeUnavailable, context)}${renderTable("Codex", view.codex, view.codexUnavailable, context)}</main></body>
</html>`;
}
