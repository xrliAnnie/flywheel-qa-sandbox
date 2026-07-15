/**
 * FLY-727: Daily fleet-wide completion digest — deployment-events model.
 *
 * One HTML message per day (00:35 PT) summarizing which issues actually **went
 * live** across the whole fleet, grouped by project. "Completed" = deployed to
 * live (⑤), sourced from the append-only `deployment_events` ledger (written by
 * each project's deploy hook via `POST /api/deployments/report`), NOT from a
 * git-ancestry heuristic. Delivered to the "Flywheel Notification" Discord channel via
 * `flywheel-comm publish-report` (this module produces HTML only; the Bridge has
 * no browser — the CLI does hosting + screenshot + Discord delivery).
 *
 * The digest is a **deployment timeline first**: each deployment_events row for
 * the target Pacific day renders as a deployed issue, enriched from `sessions`
 * (by issue → PR) for title/summary. A deployment with no matching session still
 * renders (summary unavailable) — the deploy happened even if Flywheel lacks a
 * summary. A light secondary count of "completed today but not yet live" comes
 * from `session_completed` (never affects the shipped count).
 *
 * Core (`aggregateDeploymentDigest` / `renderDigestHtml`) is pure + dependency-
 * injected so day/DST boundaries and the 512 KiB HTML budget are unit-testable.
 */

import type {
	CompletionEventRow,
	DeploymentEventRow,
	StateStore,
} from "../StateStore.js";

const FLYWHEEL_PROJECT = "flywheel";
/** publish-report / /api/reports/publish both cap HTML at 512 KiB. */
export const MAX_DIGEST_HTML_BYTES = 512 * 1024;
/** Per-item summary is truncated to keep the digest inside the HTML budget. */
const SUMMARY_MAX_CHARS = 240;

// ─── Types ───────────────────────────────────────────────────────────

export interface DigestItem {
	identifier?: string; // FLY-XXX (nullable — a deploy may report PR only)
	prNumber?: number;
	title?: string;
	summary?: string;
	source: string; // self-ship | vercel | fallback-git-log | ...
	inferred: boolean; // true for source=fallback-git-log
	deployedAt: string; // SQLite UTC string
}

export interface ProjectGroup {
	projectName: string;
	items: DigestItem[]; // newest-first
}

export interface FleetDigestReport {
	date: string; // target PT day YYYY-MM-DD
	projects: ProjectGroup[];
	shippedCount: number; // total deployed issues (the "真 ship" headline number)
	/** Completed today (session_completed) but not in today's deployments — context only. */
	completedNotLiveCount: number;
}

/** Minimal session projection for enrichment (title/summary). */
export interface SessionInfo {
	issue_identifier?: string;
	issue_title?: string;
	summary?: string;
	pr_number?: number;
}

export interface AggregateContext {
	deployments: DeploymentEventRow[];
	/** enrichment lookup: UPPER(issue) → session, and `pr#<n>` → session. */
	sessionByKey: Map<string, SessionInfo>;
	/** session_completed events (for the secondary "completed not live" count). */
	completions: CompletionEventRow[];
	day: string;
	tz: string;
}

// ─── Time helpers (repo idiom + DST-safe per-event filtering) ─────────

/** Parse a SQLite UTC string (`YYYY-MM-DD HH:MM:SS`) as a Date (repo idiom). */
export function parseSqliteUtc(ts: string): Date {
	return new Date(`${ts.replace(" ", "T")}Z`);
}

/** Civil date (`YYYY-MM-DD`) of `date` in `tz` — generalized `pacificDateString`. */
export function dateStringInZone(date: Date, tz: string): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(date);
}

// ─── Aggregation (pure) ──────────────────────────────────────────────

/** Stable dedup key for one deployed unit within a project (issue or PR). */
function itemKey(d: DeploymentEventRow): string {
	if (d.issue_identifier) return `i:${d.issue_identifier.toUpperCase()}`;
	if (d.pr_number != null) return `p:${d.pr_number}`;
	// No issue/pr (shouldn't happen — Bridge requires one) → fall back to id.
	return `x:${d.id}`;
}

// Lines that are git plumbing / merge noise, never a human "what they did". A
// `session.summary` often holds a raw diff or a merge-commit body (FLY-727 QA
// FLY-739 staging E2E found ~⅔ of real sessions like this), which the digest must
// NOT surface — the point is a clean one-line "who did what".
const SUMMARY_NOISE =
	/^(diff --git |index [0-9a-f]|@@ |\+\+\+ |--- |Merge |commit [0-9a-f]{7,}|Binary files |(new|deleted) file mode |(similarity index|rename (from|to)|copy (from|to)|old mode|new mode) )/i;

/**
 * Reduce a stored `session.summary` to ONE clean summary line, or undefined if it
 * has none. We take the first non-empty line and keep it only if it reads as prose
 * (a commit subject / description) rather than diff/merge plumbing. A summary that
 * *starts* with a diff/merge marker has no usable one-liner → undefined (the item's
 * issue title still carries the "what"); the render then shows "摘要暂缺".
 */
export function cleanSummary(
	raw: string | null | undefined,
): string | undefined {
	if (!raw) return undefined;
	for (const line of raw.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		return SUMMARY_NOISE.test(t) ? undefined : t;
	}
	return undefined;
}

/**
 * Aggregate deployment events into a per-project digest report. Pure: all IO
 * (deployment rows, session enrichment, completions) is injected.
 */
export function aggregateDeploymentDigest(
	ctx: AggregateContext,
): FleetDigestReport {
	const { deployments, sessionByKey, completions, day, tz } = ctx;

	// Group by project; within a project dedup by issue/PR keeping the LATEST
	// deploy of the PT day (rows arrive ASC by deployed_at → last write wins).
	const byProject = new Map<string, Map<string, DigestItem>>();
	const liveKeys = new Set<string>(); // `${project}|${issueUpper}` that went live today

	for (const d of deployments) {
		if (dateStringInZone(parseSqliteUtc(d.deployed_at), tz) !== day) continue;
		const session =
			(d.issue_identifier &&
				sessionByKey.get(`i:${d.issue_identifier.toUpperCase()}`)) ||
			(d.pr_number != null && sessionByKey.get(`p:${d.pr_number}`)) ||
			undefined;
		const item: DigestItem = {
			identifier: d.issue_identifier ?? session?.issue_identifier ?? undefined,
			prNumber: d.pr_number ?? session?.pr_number ?? undefined,
			title: session?.issue_title,
			summary: cleanSummary(session?.summary),
			source: d.source,
			inferred: d.source === "fallback-git-log",
			deployedAt: d.deployed_at,
		};
		const proj = byProject.get(d.project_name) ?? new Map<string, DigestItem>();
		proj.set(itemKey(d), item);
		byProject.set(d.project_name, proj);
		if (d.issue_identifier)
			liveKeys.add(`${d.project_name}|${d.issue_identifier.toUpperCase()}`);
	}

	let shippedCount = 0;
	const projects: ProjectGroup[] = [...byProject.entries()]
		.map(([projectName, items]) => {
			const arr = [...items.values()].sort((a, b) =>
				b.deployedAt.localeCompare(a.deployedAt),
			);
			shippedCount += arr.length;
			return { projectName, items: arr };
		})
		.sort((a, b) => {
			if (a.projectName === FLYWHEEL_PROJECT) return -1;
			if (b.projectName === FLYWHEEL_PROJECT) return 1;
			return a.projectName.localeCompare(b.projectName);
		});

	// Secondary context: issues that completed today but are not in today's
	// deployments (merged/done but not yet live). Count only — never shipped.
	const completedIssues = new Set<string>();
	for (const c of completions) {
		if (dateStringInZone(parseSqliteUtc(c.ts), tz) !== day) continue;
		const key = `${c.project_name}|${(c.issue_id ?? "").toUpperCase()}`;
		if (!liveKeys.has(key)) completedIssues.add(key);
	}

	return {
		date: day,
		projects,
		shippedCount,
		completedNotLiveCount: completedIssues.size,
	};
}

// ─── HTML render (Apple-light; 512 KiB budget) ───────────────────────

function esc(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

function renderItemRow(item: DigestItem, linearBaseUrl?: string): string {
	const idText =
		item.identifier ?? (item.prNumber ? `PR #${item.prNumber}` : "?");
	const label = item.title ? `${idText} — ${item.title}` : idText;
	const idHtml =
		linearBaseUrl && item.identifier && /^[A-Z]+-\d+$/.test(item.identifier)
			? `<a href="${linearBaseUrl}/${item.identifier}">${esc(label)}</a>`
			: esc(label);
	const pr =
		item.identifier && item.prNumber != null
			? ` <span class="pr">PR #${item.prNumber}</span>`
			: "";
	const badge = item.inferred ? "🚀 已上线*" : "🚀 已上线";
	const summary = item.summary
		? `<div class="summary">${esc(truncate(item.summary, SUMMARY_MAX_CHARS))}</div>`
		: `<div class="summary muted">摘要暂缺</div>`;
	return `<div class="item">
  <div class="item-head"><span class="badge">${badge}</span> <span class="id">${idHtml}</span>${pr} <span class="src">${esc(item.source)}</span></div>
  ${summary}
</div>`;
}

export interface RenderOptions {
	linearBaseUrl?: string;
}

/**
 * Render the digest as an Apple-light HTML page. Guarantees the output stays
 * within `MAX_DIGEST_HTML_BYTES` (sheds oldest items per project with a
 * "+N more" overflow row) so daily delivery never fails the 512 KiB cap.
 */
export function renderDigestHtml(
	report: FleetDigestReport,
	opts: RenderOptions = {},
): string {
	let cap = Number.POSITIVE_INFINITY;
	let html = buildHtml(report, opts, cap);
	while (Buffer.byteLength(html, "utf8") > MAX_DIGEST_HTML_BYTES && cap > 1) {
		cap = cap === Number.POSITIVE_INFINITY ? 20 : Math.floor(cap / 2);
		html = buildHtml(report, opts, cap);
	}
	return html;
}

function buildHtml(
	report: FleetDigestReport,
	opts: RenderOptions,
	perProjectCap: number,
): string {
	const sections = report.projects
		.map((g) => {
			const shown = g.items.slice(0, perProjectCap);
			const rows = shown
				.map((it) => renderItemRow(it, opts.linearBaseUrl))
				.join("\n");
			const more =
				g.items.length > shown.length
					? `<div class="more">…+${g.items.length - shown.length} more</div>`
					: "";
			return `<div class="section"><div class="section-title">${esc(g.projectName)} <span class="count">${g.items.length}</span></div>${rows}${more}</div>`;
		})
		.join("\n");

	const body =
		report.projects.length > 0
			? sections
			: `<div class="empty">今日无上线 🎉</div>`;

	const footer =
		report.completedNotLiveCount > 0
			? `<div class="footer">另有 ${report.completedNotLiveCount} 个今日完成但尚未上线（merged/进行中）。</div>`
			: "";
	const note = report.projects.some((p) => p.items.some((i) => i.inferred))
		? `<div class="note">* = 从提交推断的上线（无部署 marker）。</div>`
		: "";

	return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="robots" content="noindex"/>
<title>每日上线 Digest — ${esc(report.date)}</title>
<style>
  :root { color-scheme: light; }
  body { background:#f5f5f7; color:#1d1d1f; font-family:-apple-system,system-ui,sans-serif; margin:0; padding:24px; }
  .wrap { max-width:960px; margin:0 auto; }
  h1 { font-size:22px; margin:0 0 4px; }
  .overview { margin:12px 0 20px; }
  .stat { background:#fff; border-radius:10px; padding:6px 12px; font-size:14px; color:#34c759; box-shadow:0 1px 3px rgba(0,0,0,0.06); }
  .section { margin-bottom:22px; }
  .section-title { font-weight:600; font-size:16px; margin-bottom:8px; }
  .count { color:#86868b; font-weight:400; font-size:13px; }
  .item { background:#fff; border-radius:12px; border-left:4px solid #34c759; padding:10px 14px; margin-bottom:8px; box-shadow:0 1px 3px rgba(0,0,0,0.06); }
  .item-head { font-size:14px; }
  .badge { font-size:12px; color:#34c759; margin-right:6px; }
  .id { font-weight:600; } .id a { color:#1a365d; text-decoration:none; }
  .pr { font-family:'SF Mono',monospace; font-size:12px; color:#007aff; }
  .src { font-size:12px; color:#86868b; }
  .summary { margin-top:4px; font-size:13px; color:#424245; }
  .summary.muted { color:#86868b; font-style:italic; }
  .more { color:#86868b; font-size:13px; padding:2px 4px; }
  .empty { text-align:center; color:#86868b; padding:40px; font-size:18px; }
  .note, .footer { color:#86868b; font-size:13px; margin-top:8px; }
</style></head>
<body><div class="wrap">
  <h1>🚀 今日上线 Digest — ${esc(report.date)}</h1>
  <div class="overview"><span class="stat">🚀 今日上线 ${report.shippedCount}</span></div>
  ${body}
  ${note}
  ${footer}
</div></body></html>`;
}

// ─── DigestService (Bridge host: wires StateStore) ───────────────────

/** Shift a `YYYY-MM-DD` civil date by `delta` days (UTC arithmetic). */
export function shiftDay(day: string, delta: number): string {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + delta);
	return d.toISOString().slice(0, 10);
}

export interface DigestServiceOptions {
	tz: string;
	linearBaseUrl?: string;
}

/**
 * Bridge-side digest host: reads deployment_events (primary) + sessions
 * (enrichment) + session_completed (secondary count), runs the pure aggregator,
 * and renders HTML. Does NOT deliver to Discord — the CLI
 * `flywheel-comm publish-report` owns hosting + screenshot + delivery.
 */
export class DigestService {
	constructor(
		private readonly store: StateStore,
		private readonly opts: DigestServiceOptions,
	) {}

	aggregate(day: string): FleetDigestReport {
		// Wide UTC window amply covering the PT civil day (PT = UTC-7/-8).
		const sinceUtc = `${shiftDay(day, -1)} 00:00:00`;
		const untilUtc = `${shiftDay(day, 2)} 00:00:00`;
		const deployments = this.store.getDeploymentEventsInRange(
			sinceUtc,
			untilUtc,
		);
		const completions = this.store.getCompletionEventsInRange(
			sinceUtc,
			untilUtc,
		);

		// Enrichment: index the latest session per issue / PR from the day's
		// completion events' sessions. Look each deployed issue up on demand.
		const sessionByKey = new Map<string, SessionInfo>();
		for (const d of deployments) {
			for (const idKey of [
				d.issue_identifier && `i:${d.issue_identifier.toUpperCase()}`,
				d.pr_number != null && `p:${d.pr_number}`,
			]) {
				if (!idKey || sessionByKey.has(idKey)) continue;
				const s = d.issue_identifier
					? this.store.getSessionByIdentifier(d.issue_identifier)
					: undefined;
				if (s) {
					const info: SessionInfo = {
						issue_identifier: s.issue_identifier,
						issue_title: s.issue_title,
						summary: s.summary,
						pr_number: s.pr_number,
					};
					if (d.issue_identifier)
						sessionByKey.set(`i:${d.issue_identifier.toUpperCase()}`, info);
					if (s.pr_number != null) sessionByKey.set(`p:${s.pr_number}`, info);
				}
			}
		}

		return aggregateDeploymentDigest({
			deployments,
			sessionByKey,
			completions,
			day,
			tz: this.opts.tz,
		});
	}

	renderHtml(day: string): string {
		return renderDigestHtml(this.aggregate(day), {
			linearBaseUrl: this.opts.linearBaseUrl,
		});
	}

	/** The day the 00:35 job reports: YESTERDAY (the civil day that just ended). */
	defaultDay(now: Date = new Date()): string {
		return shiftDay(dateStringInZone(now, this.opts.tz), -1);
	}
}
