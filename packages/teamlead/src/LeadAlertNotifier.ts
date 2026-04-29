/**
 * FLY-83: Bridge-side alert emitter for Lead lifecycle incidents.
 *
 * Two invariants:
 * - Cross-process dedup: before POSTing Discord, consult shell's claims.db
 *   (single-source-of-truth for "already alerted in this 10-min bucket").
 *   Same-process dedup: StateStore.tryClaimLeadEvent against lead_events.
 * - Never throw from alert(): Discord is unreliable; failures get queued to
 *   $HOME/.flywheel/alert-queue/ for a later drainQueue() pass.
 *
 * Not responsible for deciding *when* to alert — LeadWatchdog drives that.
 */

import {
	mkdirSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LeadConfig, ProjectEntry } from "./ProjectConfig.js";
import type { StateStore } from "./StateStore.js";

export type AlertEventType =
	| "rate_limit"
	| "login_expired"
	| "permission_blocked"
	| "crash_loop"
	| "pane_hash_stuck";

export type AlertSeverity = "info" | "warning" | "severe";

export interface AlertPayload {
	leadId: string;
	projectName: string;
	eventId: string;
	eventType: AlertEventType;
	title: string;
	body: string;
	severity: AlertSeverity;
	sessionKey?: string;
}

export interface AlertResult {
	sent?: boolean;
	skipped?: "duplicate" | "no-channel" | "no-token" | "unknown-lead";
	queued?: boolean;
	dmSent?: boolean;
}

export type FetchLike = typeof globalThis.fetch;
export type ClaimsReader = () => Promise<Set<string>>;

export interface LeadAlertNotifierConfig {
	store: StateStore;
	projects: ProjectEntry[];
	fetchFn?: FetchLike;
	queueDir?: string;
	claimsReader?: ClaimsReader;
	logger?: (msg: string) => void;
}

const DISCORD_API = "https://discord.com/api/v10";

export class LeadAlertNotifier {
	private store: StateStore;
	private projects: ProjectEntry[];
	private fetchFn: FetchLike;
	private queueDir: string;
	private claimsReader?: ClaimsReader;
	private logger: (msg: string) => void;

	constructor(config: LeadAlertNotifierConfig) {
		this.store = config.store;
		this.projects = config.projects;
		this.fetchFn = config.fetchFn ?? (globalThis.fetch as FetchLike);
		this.queueDir =
			config.queueDir ?? join(homedir(), ".flywheel", "alert-queue");
		this.claimsReader = config.claimsReader;
		this.logger =
			config.logger ??
			((msg) => {
				console.log(`[LeadAlertNotifier] ${msg}`);
			});
		mkdirSync(this.queueDir, { recursive: true });
	}

	async alert(payload: AlertPayload): Promise<AlertResult> {
		const resolved = this.resolveLead(payload.leadId, payload.projectName);
		if (!resolved) {
			this.logger(
				`unknown lead: project=${payload.projectName} leadId=${payload.leadId}`,
			);
			return { skipped: "unknown-lead" };
		}
		const { lead, project } = resolved;

		// Step 1: shell-side claim check (single-source-of-truth for cross-proc).
		if (this.claimsReader) {
			try {
				const claimed = await this.claimsReader();
				if (claimed.has(payload.eventId)) {
					return { skipped: "duplicate" };
				}
			} catch (err) {
				this.logger(
					`claimsReader failed (treating as not claimed): ${(err as Error).message}`,
				);
			}
		}

		// Step 2: Bridge-side dedup via lead_events UNIQUE.
		const firstClaim = this.store.tryClaimLeadEvent(
			payload.leadId,
			payload.eventId,
			payload.eventType,
			JSON.stringify(payload),
			payload.sessionKey,
		);
		if (!firstClaim) {
			return { skipped: "duplicate" };
		}

		// Step 3: Resolve channel + token.
		const channel = this.resolveChannel(lead, project);
		if (!channel) {
			this.enqueue(payload, "no-channel");
			return { skipped: "no-channel", queued: true };
		}
		const token = this.resolveToken(lead);
		if (!token) {
			this.enqueue(payload, "no-token");
			return { skipped: "no-token", queued: true };
		}

		// Step 4: Fire the Discord POST.
		const sent = await this.postMessage(channel, token, payload);
		if (!sent) {
			this.enqueue(payload, "discord-5xx");
			return { queued: true };
		}

		// Step 5: Severe follow-up DM (best-effort; never alters primary result).
		let dmSent = false;
		if (payload.severity === "severe" && lead.alertDmUserId) {
			dmSent = await this.sendDm(lead.alertDmUserId, token, payload);
		}

		return dmSent ? { sent: true, dmSent: true } : { sent: true };
	}

	/**
	 * Retry everything in the queue directory. Oldest first. Files for alerts
	 * that succeed are removed; anything else stays for the next pass.
	 */
	async drainQueue(): Promise<{ sent: number; remaining: number }> {
		const entries = readdirSync(this.queueDir)
			.filter((f) => f.endsWith(".json"))
			.sort();
		let sent = 0;
		for (const file of entries) {
			const path = join(this.queueDir, file);
			let payload: AlertPayload;
			try {
				payload = JSON.parse(readFileSync(path, "utf-8")) as AlertPayload;
			} catch (err) {
				this.logger(
					`skip malformed queue entry ${file}: ${(err as Error).message}`,
				);
				continue;
			}
			const resolved = this.resolveLead(payload.leadId, payload.projectName);
			if (!resolved) continue;
			const { lead, project } = resolved;
			const channel = this.resolveChannel(lead, project);
			const token = this.resolveToken(lead);
			if (!channel || !token) continue;

			const ok = await this.postMessage(channel, token, payload);
			if (ok) {
				unlinkSync(path);
				sent++;
			}
		}
		const remaining = readdirSync(this.queueDir).filter((f) =>
			f.endsWith(".json"),
		).length;
		return { sent, remaining };
	}

	private resolveLead(
		leadId: string,
		projectName: string,
	): { lead: LeadConfig; project: ProjectEntry } | null {
		const project = this.projects.find((p) => p.projectName === projectName);
		if (!project) return null;
		const lead = project.leads.find((l) => l.agentId === leadId);
		if (!lead) return null;
		return { lead, project };
	}

	private resolveChannel(
		lead: LeadConfig,
		project: ProjectEntry,
	): string | null {
		if (lead.alertChannel) return lead.alertChannel;
		if (lead.alertFallbackToCore && project.generalChannel) {
			return project.generalChannel;
		}
		return null;
	}

	private resolveToken(lead: LeadConfig): string | null {
		const envName = lead.alertBotTokenEnv ?? lead.botTokenEnv;
		if (envName) {
			const fromEnv = process.env[envName];
			if (fromEnv) return fromEnv;
		}
		return lead.botToken ?? null;
	}

	private async postMessage(
		channelId: string,
		token: string,
		payload: AlertPayload,
	): Promise<boolean> {
		const url = `${DISCORD_API}/channels/${channelId}/messages`;
		try {
			const res = await this.fetchFn(url, {
				method: "POST",
				headers: {
					Authorization: `Bot ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					content: formatContent(payload),
				}),
			});
			if (!res.ok) {
				const text = await safeText(res);
				this.logger(
					`Discord POST ${res.status} ${res.statusText} for ${payload.leadId}/${payload.eventType}: ${text}`,
				);
				return false;
			}
			return true;
		} catch (err) {
			this.logger(
				`Discord POST threw for ${payload.leadId}/${payload.eventType}: ${(err as Error).message}`,
			);
			return false;
		}
	}

	private async sendDm(
		userId: string,
		token: string,
		payload: AlertPayload,
	): Promise<boolean> {
		const createUrl = `${DISCORD_API}/users/@me/channels`;
		try {
			const res = await this.fetchFn(createUrl, {
				method: "POST",
				headers: {
					Authorization: `Bot ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ recipient_id: userId }),
			});
			if (!res.ok) {
				this.logger(
					`DM channel create ${res.status} for user ${userId}: ${await safeText(res)}`,
				);
				return false;
			}
			const body =
				(await (
					res.json as undefined | (() => Promise<{ id?: string }>)
				)?.()) ?? {};
			const dmChannelId = body.id;
			if (!dmChannelId) return false;
			return this.postMessage(dmChannelId, token, payload);
		} catch (err) {
			this.logger(`DM fan-out failed: ${(err as Error).message}`);
			return false;
		}
	}

	private enqueue(payload: AlertPayload, reason: string): void {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		const file = `${stamp}-${payload.leadId}-${payload.eventType}.json`;
		const path = join(this.queueDir, file);
		const record = {
			...payload,
			queuedAt: new Date().toISOString(),
			queueReason: reason,
		};
		writeFileSync(path, JSON.stringify(record, null, 2), "utf-8");
	}
}

function formatContent(payload: AlertPayload): string {
	const sev =
		payload.severity === "severe"
			? "🚨"
			: payload.severity === "warning"
				? "⚠️"
				: "ℹ️";
	return `${sev} **${payload.title}** (${payload.leadId} / ${payload.eventType})\n${payload.body}`;
}

async function safeText(
	res: Response | { text?: () => Promise<string> },
): Promise<string> {
	try {
		return typeof res.text === "function" ? await res.text() : "";
	} catch {
		return "";
	}
}
