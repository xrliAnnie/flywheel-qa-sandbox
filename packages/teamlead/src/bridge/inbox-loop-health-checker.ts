import type { LeadInboxQueue } from "flywheel-comm/lead-inbox-queue";
import type { AlertPayload } from "../LeadAlertNotifier.js";

export interface InboxLoopHealthTarget {
	projectName: string;
	leadId: string;
	queue: LeadInboxQueue;
}

export interface InboxLoopHealthCheckerOptions {
	targets: readonly InboxLoopHealthTarget[];
	alert: (payload: AlertPayload) => Promise<unknown>;
	startedAtMs?: number;
	stallMs?: number;
	startupGraceMs?: number;
	now?: () => number;
	enabled?: boolean;
	tracker?: { started(): void; completed(): void };
}

const DEFAULT_STALL_MS = 10 * 60_000;
const DEFAULT_STARTUP_GRACE_MS = 5 * 60_000;

export function inboxLoopStallMs(env: NodeJS.ProcessEnv = process.env): number {
	const minutes = Number(env.FLYWHEEL_INBOX_LOOP_STALL_MIN ?? "10");
	return Number.isFinite(minutes) && minutes > 0
		? minutes * 60_000
		: DEFAULT_STALL_MS;
}

/** The one retained delivery alarm: per-Lead loop stalls plus overdue SLA rows. */
export class InboxLoopHealthChecker {
	private readonly startedAtMs: number;
	private readonly stallMs: number;
	private readonly startupGraceMs: number;
	private readonly now: () => number;

	constructor(private readonly opts: InboxLoopHealthCheckerOptions) {
		this.startedAtMs = opts.startedAtMs ?? Date.now();
		this.stallMs = opts.stallMs ?? inboxLoopStallMs();
		this.startupGraceMs = opts.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS;
		this.now = opts.now ?? Date.now;
	}

	async check(): Promise<void> {
		if (this.opts.enabled === false) return;
		this.opts.tracker?.started();
		try {
			const nowMs = this.now();
			if (nowMs - this.startedAtMs < this.startupGraceMs) return;
			const now = new Date(nowMs).toISOString();
			const staleBefore = new Date(nowMs - this.stallMs).toISOString();
			for (const target of this.opts.targets) {
				try {
					const episode = target.queue.claimHealthEpisode({
						leadId: target.leadId,
						now,
						staleBefore,
					});
					if (!episode) continue;
					const facts = [
						`lead_id=${target.leadId}`,
						`stalled=${episode.stalled}`,
						`overdue=${episode.overdue}`,
						`p0_overdue=${episode.p0Overdue}`,
					];
					await this.opts.alert({
						leadId: target.leadId,
						projectName: target.projectName,
						eventId: `inbox-loop-stalled:${target.leadId}:${episode.episodeAt}`,
						eventType: "inbox_loop_stalled",
						title: "Lead inbox consume loop stalled",
						body: `inbox_loop_stalled ${facts.join(" ")}`,
						severity: episode.p0Overdue > 0 ? "severe" : "warning",
					});
				} catch (error) {
					console.warn(
						`[inbox-loop-health] ${target.projectName}/${target.leadId}: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			}
		} finally {
			this.opts.tracker?.completed();
		}
	}
}
