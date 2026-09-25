import type {
	VercelQuotaRow,
	VercelQuotaSection,
} from "./account-quota-vercel.js";
import type {
	AccountQuotaRow,
	AccountQuotaView,
	QuotaCell,
} from "./account-quota-view.js";

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

function pacificParts(iso: string): Record<string, string> {
	const parsed = Date.parse(iso);
	if (!Number.isFinite(parsed)) throw new Error("invalid page quota instant");
	return Object.fromEntries(
		new Intl.DateTimeFormat("en-US", {
			timeZone: PAGE_TIMEZONE,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		})
			.formatToParts(new Date(parsed))
			.map((part) => [part.type, part.value]),
	);
}

/**
 * FLY-2830: a reading or switch moment — "HH:MM" on the page's own Pacific
 * day, "MM/DD HH:MM" otherwise (a day-old reading must not look current).
 */
export function formatAccountQuotaPageClock(
	iso: string,
	generatedAt: string,
): string {
	const at = pacificParts(iso);
	const page = pacificParts(generatedAt);
	const clock = `${at.hour}:${at.minute}`;
	return at.year === page.year && at.month === page.month && at.day === page.day
		? clock
		: `${at.month}/${at.day} ${clock}`;
}

/** FLY-2864: a Pacific calendar day with its weekday, e.g. "10/22 周四". */
export function formatAccountQuotaPageDate(iso: string): string {
	const parsed = Date.parse(iso);
	if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== iso) {
		throw new Error("invalid page quota instant");
	}
	return formatDateParts(new Date(parsed), PAGE_TIMEZONE);
}

/** A founder-entered `YYYY-MM-DD` is already a calendar day: no zone shift. */
export function formatAccountQuotaPageCalendarDate(day: string): string {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
	const noon = match
		? new Date(
				Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12),
			)
		: null;
	if (
		noon === null ||
		!Number.isFinite(noon.valueOf()) ||
		noon.toISOString().slice(0, 10) !== day
	) {
		throw new Error("invalid page calendar date");
	}
	return formatDateParts(noon, "UTC");
}

function formatDateParts(date: Date, timeZone: string): string {
	const values = Object.fromEntries(
		new Intl.DateTimeFormat("zh-CN", {
			timeZone,
			month: "2-digit",
			day: "2-digit",
			weekday: "short",
		})
			.formatToParts(date)
			.map((part) => [part.type, part.value]),
	);
	if (!values.month || !values.day || !values.weekday) {
		throw new Error("invalid page quota date parts");
	}
	return `${values.month}/${values.day} ${values.weekday}`;
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

/** FLY-2830: the switch the page compares every cell's own source against. */
export interface AccountQuotaPageSwitch {
	at: string;
	vendor: "Codex" | "Claude";
}

export interface AccountQuotaPageOptions {
	lastSwitch?: AccountQuotaPageSwitch | null;
}

type MarkedCell =
	| "tier"
	| "weeklyReset"
	| "fiveHReset"
	| "weeklyUsage"
	| "fableUsage"
	| "credits"
	| "nextCharge";

/** Which store dates each rendered cell. Anything unmapped is never marked. */
const CODEX_CELL_SOURCE: Partial<
	Record<MarkedCell, "quota" | "resetCredits" | "subscription">
> = {
	tier: "quota",
	weeklyReset: "quota",
	fiveHReset: "quota",
	weeklyUsage: "quota",
	credits: "resetCredits",
	nextCharge: "subscription",
};
const CLAUDE_CELL_SOURCE: Record<MarkedCell, "usage" | "detail"> = {
	tier: "detail",
	weeklyReset: "usage",
	fiveHReset: "usage",
	weeklyUsage: "usage",
	fableUsage: "usage",
	credits: "detail",
	nextCharge: "detail",
};

function cellOf(row: AccountQuotaRow, key: MarkedCell): QuotaCell {
	return key === "tier" ? row.subscriptionTier : row[key];
}

interface MarkContext {
	lastSwitch: AccountQuotaPageSwitch | null;
	generatedAt: string;
}

/**
 * FLY-2830: a cell whose own data source was read before the last switch (or
 * never) says so. Manual cells and rows without sources are exempt.
 */
function switchMark(
	row: AccountQuotaRow,
	key: MarkedCell,
	context: MarkContext,
): string | null {
	const { lastSwitch } = context;
	if (lastSwitch === null || row.sources === undefined) return null;
	if (cellOf(row, key).source === "manual") return null;
	let sourceAt: string | null;
	if (row.sources.provider === "Codex") {
		const source = CODEX_CELL_SOURCE[key];
		if (source === undefined) return null;
		sourceAt = row.sources[source];
	} else {
		sourceAt = row.sources[CLAUDE_CELL_SOURCE[key]];
	}
	const switchedAt = formatAccountQuotaPageClock(
		lastSwitch.at,
		context.generatedAt,
	);
	if (sourceAt === null) return `切号后尚未读到（切号 ${switchedAt}）`;
	if (Date.parse(sourceAt) >= Date.parse(lastSwitch.at)) return null;
	return `切号后尚未刷新（切号 ${switchedAt}，读于 ${formatAccountQuotaPageClock(sourceAt, context.generatedAt)}）`;
}

function renderMark(
	row: AccountQuotaRow,
	key: MarkedCell,
	context: MarkContext,
): string {
	const mark = switchMark(row, key, context);
	return mark === null
		? ""
		: `<span class="switch-stale">${escapeHtml(mark)}</span>`;
}

function markedCells(row: AccountQuotaRow): MarkedCell[] {
	return [
		"tier",
		"weeklyReset",
		"fiveHReset",
		"weeklyUsage",
		...(row.provider === "Claude" ? (["fableUsage"] as const) : []),
		"credits",
		"nextCharge",
	];
}

function readingTime(iso: string | null, generatedAt: string): string {
	return iso === null
		? "从未读到"
		: formatAccountQuotaPageClock(iso, generatedAt);
}

function renderReadingTime(row: AccountQuotaRow, generatedAt: string): string {
	const sources = row.sources;
	if (sources === undefined) return "";
	const text =
		sources.provider === "Codex"
			? `读于 ${readingTime(sources.quota, generatedAt)}`
			: `用量读于 ${readingTime(sources.usage, generatedAt)} · 卡读于 ${readingTime(sources.detail, generatedAt)}`;
	return `<span class="reading-time">${escapeHtml(text)}</span>`;
}

function renderIdentity(
	pageRow: AccountQuotaPageRow,
	context: MarkContext,
): string {
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
	return `<td class="account-cell"><div class="account-name">${active}${escapeHtml(row.name)}</div><div class="account-tier">${escapeHtml(row.subscriptionTier.display)}</div>${renderMark(row, "tier", context)}${renderReadingTime(row, context.generatedAt)}${accountMissing}${note}</td>`;
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

function renderNextCharge(row: AccountQuotaRow, context: MarkContext): string {
	return `<td><span class="next-charge">${escapeHtml(row.nextCharge.display)}</span>${renderMark(row, "nextCharge", context)}</td>`;
}

function renderPageRow(
	pageRow: AccountQuotaPageRow,
	context: MarkContext,
): string {
	const { row } = pageRow;
	const classes = ["quota-row", row.active ? "active-account" : ""]
		.filter(Boolean)
		.join(" ");
	const mark = (key: MarkedCell) => renderMark(row, key, context);
	const fable =
		row.provider === "Claude"
			? `<td>${renderProgress(pageRow.fablePct, "Fable")}${mark("fableUsage")}</td>`
			: "";
	return `<tr class="${classes}">${renderIdentity(pageRow, context)}<td>${renderInstant(pageRow.weeklyResetAt, pageRow.weeklyResetDisplay)}${mark("weeklyReset")}</td><td>${renderInstant(pageRow.fiveHResetAt, pageRow.fiveHResetDisplay)}${mark("fiveHReset")}</td><td>${renderProgress(pageRow.weeklyPct, "周")}${mark("weeklyUsage")}</td>${fable}<td>${renderCards(row.credits)}${mark("credits")}</td>${renderNextCharge(row, context)}</tr>`;
}

/** FLY-2830: a fact about reading times, never a claim that a refresh ran. */
function renderSwitchBanner(
	view: AccountQuotaView,
	context: MarkContext,
): string {
	const { lastSwitch } = context;
	if (lastSwitch === null) return "";
	const pending = [...view.claude, ...view.codex].reduce(
		(count, row) =>
			count +
			markedCells(row).filter((key) => switchMark(row, key, context) !== null)
				.length,
		0,
	);
	const switchedAt = formatAccountQuotaPageClock(
		lastSwitch.at,
		context.generatedAt,
	);
	const text =
		pending === 0
			? `${switchedAt} ${lastSwitch.vendor} 切号后已全部重读`
			: `${switchedAt} ${lastSwitch.vendor} 切号后，还有 ${pending} 格未刷新`;
	return `<div class="switch-banner">${escapeHtml(text)}</div>`;
}

function renderSectionRows(
	sections: readonly AccountQuotaPageSection[],
	columnCount: number,
	context: MarkContext,
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
	context: MarkContext,
): string {
	const claude = provider === "Claude";
	// 账号 · 周重置日 · 5h reset · 周用量 · [Fable 周用量] · 卡 · 下次扣费日
	const columnCount = claude ? 7 : 6;
	const fableHeader = claude ? "<th>Fable 周用量</th>" : "";
	const cardHeader = claude ? "充值卡" : "兑换卡";
	const unavailableRows =
		unavailable.length === 0
			? ""
			: `<tbody class="provider-unavailable"><tr><td colspan="${columnCount}">${[
					...new Set(unavailable),
				]
					.map((reason) => `<span>${escapeHtml(reason)}</span>`)
					.join("")}</td></tr></tbody>`;
	return `<section class="provider-table provider-${provider.toLowerCase()}"><h2>${provider}</h2><div class="table-wrap"><table><thead><tr><th>账号</th><th>周重置日</th><th>5h reset</th><th>周用量</th>${fableHeader}<th>${cardHeader}</th><th>下次扣费日</th></tr></thead>${unavailableRows}${renderSectionRows(buildAccountQuotaPageSections(rows), columnCount, context)}</table></div></section>`;
}

function renderVercelRow(row: VercelQuotaRow): string {
	const classes = [
		"quota-row",
		row.active ? "active-account" : "",
		row.retired ? "retired-account" : "",
	]
		.filter(Boolean)
		.join(" ");
	const active = row.active
		? '<span class="active-dot"></span><span class="active-chip">在用</span>'
		: "";
	const notes = [row.team, row.note]
		.filter((value): value is string => value !== null)
		.map((value) => `<span class="account-note">${escapeHtml(value)}</span>`)
		.join("");
	const lines = row.blobLines
		.map((line) => `<span class="card-line">${escapeHtml(line)}</span>`)
		.join("");
	return `<tr class="${classes}"><td class="account-cell"><div class="account-name">${active}${escapeHtml(row.name)}</div><div class="account-tier">${escapeHtml(row.planDisplay)}</div>${notes}</td><td><span class="next-charge">${escapeHtml(row.nextCharge)}</span></td><td><div class="card-lines">${lines}</div></td></tr>`;
}

/** FLY-2875: never throws, so a bad reading cannot take the page down. */
function renderVercelTable(section: VercelQuotaSection): string {
	let caption = "";
	if (section.observedAt !== null) {
		try {
			caption = `<div class="section-caption">读于 ${escapeHtml(formatAccountQuotaPageInstant(section.observedAt))}</div>`;
		} catch {
			caption = "";
		}
	}
	return `<section class="provider-table provider-vercel"><h2>Vercel</h2>${caption}<div class="table-wrap"><table class="vercel-table"><thead><tr><th>账号</th><th>下次扣费日</th><th>报告托管 Blob</th></tr></thead><tbody class="quota-group" data-group="vercel">${section.rows.map(renderVercelRow).join("")}</tbody></table></div></section>`;
}

export function renderAccountQuotaPageHtml(
	view: AccountQuotaView,
	vercel?: VercelQuotaSection,
	options: AccountQuotaPageOptions = {},
): string {
	const context: MarkContext = {
		lastSwitch: options.lastSwitch ?? null,
		generatedAt: view.generatedAt,
	};
	return `<!doctype html>
<html lang="zh-CN">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width,initial-scale=1">
	<title>账号额度一览</title>
	<style>
		:root{color-scheme:light;--ink:#1d1d1f;--muted:#6e6e73;--line:#e3e1dc;--paper:#fbfaf7;--page:#f0efec;--ok:#1f7a68;--active-bg:#e3f4ec;--full:#c0392b;--full-bg:#fdf0ee;--track:#e9e7e2}
		*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",system-ui,sans-serif}main{max-width:1280px;margin:0 auto;background:var(--paper);min-height:100vh;padding:38px 28px 48px}header{display:flex;align-items:baseline;justify-content:space-between;gap:16px;border-bottom:2px solid var(--ink);padding-bottom:14px}h1{margin:0;font-size:25px;letter-spacing:-.02em}.generated{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}section{margin-top:30px}h2{font-size:17px;margin:0 0 8px}.table-wrap{overflow-x:auto}table{width:100%;min-width:990px;border-collapse:collapse;border:1px solid var(--line)}th,td{text-align:left;padding:12px 13px;border-bottom:1px solid var(--line);vertical-align:middle}th{font-size:11px;letter-spacing:.06em;color:var(--muted);white-space:nowrap}.provider-unavailable td{color:var(--muted);font-size:12px}.provider-unavailable span{display:block}.quota-group-spacer td{height:10px;padding:0;border:0;background:var(--paper)}.quota-group[data-group="full"] .quota-row td{background:var(--full-bg)}.group-title td{background:var(--paper);color:var(--muted);font-size:12px;font-weight:650;letter-spacing:.04em;padding-top:15px;padding-bottom:6px}.active-account td{background:var(--active-bg)!important}.active-account td:first-child{box-shadow:inset 4px 0 0 var(--ok)}.account-name{display:flex;align-items:center;gap:7px;font-weight:700}.active-dot{width:8px;height:8px;border-radius:50%;background:var(--ok);flex:none}.active-chip{font-size:10px;color:var(--ok);background:#d8eee6;border-radius:5px;padding:1px 6px}.account-tier,.account-note{display:block;color:var(--muted);font-size:11px;margin-top:4px;max-width:240px;white-space:normal}.reset-time,.card-lines{font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.card-lines{display:flex;flex-direction:column}.quota-na{color:#a1a1a6}.quota-meter{min-width:118px}.meter-copy{display:flex;align-items:baseline;gap:6px;margin-bottom:5px}.quota-pct{font:650 13px ui-monospace,SFMono-Regular,Menlo,monospace}.dimension-label{font-size:10px;color:var(--muted)}.dimension-full{font-size:10px;font-weight:700;color:var(--full)}progress{display:block;width:100%;height:6px;border:0;border-radius:3px;overflow:hidden;background:var(--track);accent-color:var(--ok)}progress::-webkit-progress-bar{background:var(--track)}progress::-webkit-progress-value{background:var(--ok)}progress::-moz-progress-bar{background:var(--ok)}.dimension-is-full progress{accent-color:var(--full)}.dimension-is-full progress::-webkit-progress-value{background:var(--full)}.dimension-is-full progress::-moz-progress-bar{background:var(--full)}.dimension-is-full .quota-pct{color:var(--full)}.next-charge{white-space:nowrap}table.vercel-table{min-width:640px}.section-caption{font-size:12px;color:var(--muted);margin:-4px 0 8px}.retired-account td{color:var(--muted)}.reading-time{display:block;color:var(--muted);font-size:11px;margin-top:4px}.switch-stale{display:block;color:#b25e00;font-size:11px;margin-top:4px;white-space:normal}.switch-banner{margin-top:14px;padding:8px 12px;border-left:4px solid #ff9500;background:#fff6e8;font-size:13px}@media(max-width:700px){main{padding:26px 14px 40px}header{display:block}.generated{margin-top:8px}h1{font-size:23px}}
	</style>
</head>
<body><main><header><h1>账号额度一览</h1><div class="generated">${escapeHtml(formatAccountQuotaPageInstant(view.generatedAt))}</div></header>${renderSwitchBanner(view, context)}${renderTable("Claude", view.claude, view.claudeUnavailable, context)}${renderTable("Codex", view.codex, view.codexUnavailable, context)}${vercel === undefined ? "" : renderVercelTable(vercel)}</main></body>
</html>`;
}
