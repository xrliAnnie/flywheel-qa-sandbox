/**
 * GEO-288: Daily Standup Service v2 — System Status + Completions aggregator + Discord delivery.
 *
 * Simplified from v1: no StandupScheduler, no Linear backlog, no Blockers.
 * Those are handled by PM Triage (GEO-276) via Simba.
 */

import { type ProjectEntry, resolveLeadForIssue } from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";
import {
	DISCORD_API,
	MAX_DISCORD_MESSAGE_LENGTH,
	splitDiscordMessage,
} from "./discord-utils.js";

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Build a Markdown hyperlink for a Linear issue: [**GEO-1** — Title](url).
 * When linearBaseUrl is provided, produces a clickable link; otherwise plain bold text.
 */
function issueLink(
	identifier: string,
	title?: string,
	linearBaseUrl?: string,
): string {
	const label = title ? `**${identifier}** — ${title}` : `**${identifier}**`;
	if (!linearBaseUrl) return label;
	return `[${label}](${linearBaseUrl}/${identifier})`;
}

// ─── Types ───────────────────────────────────────────────────────────

export interface StandupReport {
	date: string; // YYYY-MM-DD (Pacific Time)
	projectName: string;
	systemStatus: {
		runningCount: number;
		awaitingReviewCount: number;
		maxRunners: number;
		stuckCount: number;
		oldCompletedFailedBlockedCount: number;
		staleThresholdHours: number;
	};
	completions: Array<{
		identifier?: string;
		title?: string;
		status: string;
		completedAt?: string;
		ownerLeadId?: string;
	}>;
}

// ─── Aggregator ──────────────────────────────────────────────────────

const COMPLETION_STATUSES = new Set(["completed", "approved"]);
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/** Pacific Time date in YYYY-MM-DD format. */
export function pacificDateString(now?: Date): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "America/Los_Angeles",
	}).format(now ?? new Date());
}

function parseActivityTimestamp(session: Session): number | null {
	if (!session.last_activity_at) return null;
	return new Date(`${session.last_activity_at.replace(" ", "T")}Z`).getTime();
}

function resolveOwner(
	session: Session,
	projects: ProjectEntry[],
): { leadId: string | undefined; isLabelMatch: boolean } {
	try {
		let labels: string[] = [];
		if (session.issue_labels) {
			try {
				const parsed: unknown = JSON.parse(session.issue_labels);
				if (
					Array.isArray(parsed) &&
					parsed.every((item): item is string => typeof item === "string")
				) {
					labels = parsed;
				}
			} catch {
				labels = session.issue_labels
					.split(",")
					.map((l) => l.trim())
					.filter(Boolean);
			}
		}
		const { lead, matchMethod } = resolveLeadForIssue(
			projects,
			session.project_name,
			labels,
		);
		return {
			leadId: lead.agentId,
			isLabelMatch: matchMethod === "label",
		};
	} catch (err) {
		console.warn(
			`[standup] resolveOwner failed for session ${session.execution_id}: ${(err as Error).message}`,
		);
		return { leadId: undefined, isLabelMatch: false };
	}
}

export async function aggregateStandup(
	store: StateStore,
	targetProjectName: string,
	maxConcurrentRunners: number,
	projects: ProjectEntry[],
	stuckThresholdMinutes: number,
	staleThresholdHours: number,
): Promise<StandupReport> {
	const now = Date.now();
	const today = pacificDateString();

	// ── System status ──
	const activeSessions = store
		.getActiveSessions()
		.filter((s) => s.project_name === targetProjectName);
	const runningCount = activeSessions.filter(
		(s) => s.status === "running",
	).length;
	const awaitingReviewCount = activeSessions.filter(
		(s) => s.status === "awaiting_review",
	).length;

	const stuckCount = store
		.getStuckSessions(stuckThresholdMinutes)
		.filter((s) => s.project_name === targetProjectName).length;

	const oldCompletedFailedBlockedCount = store
		.getStaleCompletedSessions(staleThresholdHours)
		.filter((s) => s.project_name === targetProjectName).length;

	// ── Completions (last 24h) ──
	const recentSessions = store.getRecentSessions(500);
	const projectRecent = recentSessions.filter(
		(s) => s.project_name === targetProjectName,
	);

	const completions = projectRecent
		.filter((s) => {
			if (!COMPLETION_STATUSES.has(s.status)) return false;
			const ts = parseActivityTimestamp(s);
			return ts !== null && now - ts < TWENTY_FOUR_HOURS_MS;
		})
		.map((s) => {
			const owner = resolveOwner(s, projects);
			return {
				identifier: s.issue_identifier,
				title: s.issue_title,
				status: s.status,
				completedAt: s.last_activity_at,
				ownerLeadId: owner.isLabelMatch ? owner.leadId : undefined,
			};
		});

	return {
		date: today,
		projectName: targetProjectName,
		systemStatus: {
			runningCount,
			awaitingReviewCount,
			maxRunners: maxConcurrentRunners,
			stuckCount,
			oldCompletedFailedBlockedCount,
			staleThresholdHours,
		},
		completions,
	};
}

// ─── Formatter ───────────────────────────────────────────────────────

const MAX_COMPLETIONS_DISPLAY = 10;

export function formatStandupReport(
	report: StandupReport,
	simbaMention?: string,
	linearBaseUrl?: string,
): string {
	const lines: string[] = [];
	const { systemStatus } = report;

	lines.push(`## ☀️ Good Morning — ${report.date}`);
	lines.push(`**Project**: ${report.projectName}`);
	lines.push("");

	// System Status
	lines.push("### System Status");
	lines.push(
		`- Running Runners: **${systemStatus.runningCount}**/${systemStatus.maxRunners}`,
	);
	lines.push(`- Awaiting Review: **${systemStatus.awaitingReviewCount}**`);
	lines.push(`- Stuck: **${systemStatus.stuckCount}**`);
	if (systemStatus.oldCompletedFailedBlockedCount > 0) {
		lines.push(
			`- Stale (completed/failed/blocked >${systemStatus.staleThresholdHours}h): **${systemStatus.oldCompletedFailedBlockedCount}**`,
		);
	}
	lines.push("");

	// Completions (capped at MAX_COMPLETIONS_DISPLAY)
	const totalCompletions = report.completions.length;
	const displayed = report.completions.slice(0, MAX_COMPLETIONS_DISPLAY);

	if (totalCompletions > 0) {
		lines.push(`### Completions (24h) — ${totalCompletions}`);
		for (const c of displayed) {
			const id = c.identifier ?? "unknown";
			const link = issueLink(id, c.title ?? undefined, linearBaseUrl);
			const owner = c.ownerLeadId ? ` (${c.ownerLeadId})` : "";
			lines.push(`- ${link} [${c.status}]${owner}`);
		}
		if (totalCompletions > MAX_COMPLETIONS_DISPLAY) {
			lines.push(`- …and ${totalCompletions - MAX_COMPLETIONS_DISPLAY} more`);
		}
		lines.push("");
	} else {
		lines.push("### Completions (24h)");
		lines.push("- None");
		lines.push("");
	}

	// Triage trigger
	if (simbaMention) {
		lines.push(`${simbaMention} 系统日报已发，请执行今日 triage`);
	}

	let result = lines.join("\n");

	// Preflight: ensure single-message budget
	if (result.length > MAX_DISCORD_MESSAGE_LENGTH) {
		console.warn(
			`[standup] Report exceeds ${MAX_DISCORD_MESSAGE_LENGTH} chars (${result.length}). Truncating completions.`,
		);
		// Rebuild with fewer completions until it fits
		for (let cap = displayed.length - 1; cap >= 0; cap--) {
			const truncated = buildFormattedReport(
				report,
				simbaMention,
				cap,
				linearBaseUrl,
			);
			if (truncated.length <= MAX_DISCORD_MESSAGE_LENGTH) {
				result = truncated;
				break;
			}
		}
	}

	return result;
}

/** Internal helper for truncated rebuilds. */
function buildFormattedReport(
	report: StandupReport,
	simbaMention: string | undefined,
	maxCompletions: number,
	linearBaseUrl?: string,
): string {
	const lines: string[] = [];
	const { systemStatus } = report;

	lines.push(`## ☀️ Good Morning — ${report.date}`);
	lines.push(`**Project**: ${report.projectName}`);
	lines.push("");

	lines.push("### System Status");
	lines.push(
		`- Running Runners: **${systemStatus.runningCount}**/${systemStatus.maxRunners}`,
	);
	lines.push(`- Awaiting Review: **${systemStatus.awaitingReviewCount}**`);
	lines.push(`- Stuck: **${systemStatus.stuckCount}**`);
	if (systemStatus.oldCompletedFailedBlockedCount > 0) {
		lines.push(
			`- Stale (completed/failed/blocked >${systemStatus.staleThresholdHours}h): **${systemStatus.oldCompletedFailedBlockedCount}**`,
		);
	}
	lines.push("");

	const totalCompletions = report.completions.length;
	const displayed = report.completions.slice(0, maxCompletions);

	if (totalCompletions > 0) {
		lines.push(`### Completions (24h) — ${totalCompletions}`);
		for (const c of displayed) {
			const id = c.identifier ?? "unknown";
			const link = issueLink(id, c.title ?? undefined, linearBaseUrl);
			const owner = c.ownerLeadId ? ` (${c.ownerLeadId})` : "";
			lines.push(`- ${link} [${c.status}]${owner}`);
		}
		if (totalCompletions > maxCompletions) {
			lines.push(`- …and ${totalCompletions - maxCompletions} more`);
		}
		lines.push("");
	} else {
		lines.push("### Completions (24h)");
		lines.push("- None");
		lines.push("");
	}

	if (simbaMention) {
		lines.push(`${simbaMention} 系统日报已发，请执行今日 triage`);
	}

	return lines.join("\n");
}

// Re-export splitDiscordMessage from shared utility for backward compat
export { splitDiscordMessage } from "./discord-utils.js";

// ─── Service ─────────────────────────────────────────────────────────

const DELIVERY_TIMEOUT_MS = 5000;

export class StandupService {
	constructor(
		private store: StateStore,
		private projects: ProjectEntry[],
		private discordBotToken: string | undefined,
		private maxConcurrentRunners: number,
		private stuckThresholdMinutes: number,
		private staleThresholdHours: number,
		private standupChannel: string | undefined,
		private simbaMention: string | undefined,
		private linearBaseUrl: string | undefined = undefined,
	) {}

	async aggregate(projectName: string): Promise<StandupReport> {
		return aggregateStandup(
			this.store,
			projectName,
			this.maxConcurrentRunners,
			this.projects,
			this.stuckThresholdMinutes,
			this.staleThresholdHours,
		);
	}

	async deliver(report: StandupReport): Promise<{
		channelId: string;
		messageCount: number;
	}> {
		if (!this.standupChannel) {
			throw new Error("STANDUP_CHANNEL not configured");
		}
		if (!this.discordBotToken) {
			throw new Error("No bot token available for standup delivery");
		}

		const markdown = formatStandupReport(
			report,
			this.simbaMention,
			this.linearBaseUrl,
		);
		const chunks = splitDiscordMessage(markdown);

		// Standup must be a single message to ensure triage trigger is delivered
		if (chunks.length > 1) {
			throw new Error(
				`Standup report exceeds single-message limit (${markdown.length} chars, ${chunks.length} chunks). This should not happen — formatter has a budget.`,
			);
		}

		let sent = 0;
		for (const chunk of chunks) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
			try {
				const res = await fetch(
					`${DISCORD_API}/channels/${this.standupChannel}/messages`,
					{
						method: "POST",
						headers: {
							Authorization: `Bot ${this.discordBotToken}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({ content: chunk }),
						signal: controller.signal,
					},
				);
				if (!res.ok) {
					const body = await res.text().catch(() => "");
					throw new Error(`Discord ${res.status}: ${body.slice(0, 200)}`);
				}
				sent++;
			} finally {
				clearTimeout(timeout);
			}
		}

		return { channelId: this.standupChannel, messageCount: sent };
	}

	async run(projectName: string): Promise<{
		report: StandupReport;
		channelId: string;
		messageCount: number;
	}> {
		const report = await this.aggregate(projectName);
		const delivery = await this.deliver(report);
		return { report, ...delivery };
	}

	async runDryRun(projectName: string): Promise<StandupReport> {
		return this.aggregate(projectName);
	}

	getStandupChannel(): string | undefined {
		return this.standupChannel;
	}
}
