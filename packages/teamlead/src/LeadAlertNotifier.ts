/**
 * FLY-83: Bridge-side alert emitter for Lead lifecycle incidents.
 *
 * Two invariants:
 * - Cross-process atomic claim (Fix 2): we run the SAME
 *   `BEGIN IMMEDIATE + INSERT OR IGNORE + SELECT changes()` transaction
 *   that `scripts/lead-alert.sh` runs against `~/.flywheel/alerts/claims.db`.
 *   First writer wins, regardless of which path (Bridge or shell) fired
 *   first. The earlier `claimsReader` Set is kept as a fast-path skip
 *   (avoids building a payload when shell has already posted), but the
 *   load-bearing dedup is the atomic claimer, not the reader.
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
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MetaAlertReason } from "./MetaAlertNotifier.js";
import type { LeadConfig, ProjectEntry } from "./ProjectConfig.js";
import type { StateStore } from "./StateStore.js";

/**
 * FLY-182 Track B: minimal sink so LeadAlertNotifier can fire a Discord-
 * independent meta-alert when its own delivery path fails (config gap,
 * permanent failure, drain stuck). Satisfied by `MetaAlertNotifier`.
 */
export interface MetaAlertSink {
	notify(input: {
		reason: MetaAlertReason;
		title: string;
		body: string;
	}): Promise<unknown>;
}

export type AlertEventType =
	| "rate_limit"
	| "usage_limit"
	| "login_expired"
	| "permission_blocked"
	| "crash_loop"
	| "pane_hash_stuck"
	// FLY-195 (plan §3.6 Q7): a stuck-runner episode the owning Lead did not
	// dispose of within the grace window — Bridge pages Annie directly.
	// eventId format: `runner-stuck-unhandled:${execution_id}:${fingerprint}`.
	| "runner_stuck_unhandled";

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
	/** FLY-182: payload routed to dead-letter (permanent failure, no retry). */
	deadLettered?: boolean;
}

export type FetchLike = typeof globalThis.fetch;
export type ClaimsReader = () => Promise<Set<string>>;

/**
 * Atomic claim against the shared `claims.db`.
 *  - `true`  → this caller inserted the row (we won the race; proceed).
 *  - `false` → row already existed (another Bridge or the shell path
 *    already claimed; skip Discord POST).
 *  - `null`  → claim infrastructure failed (sqlite missing, DB locked
 *    past timeout, etc.). Caller should fall through to "best-effort
 *    POST anyway" — duplicate alerts are recoverable; silent failures
 *    are not.
 */
export type ClaimsClaimer = (
	eventId: string,
	leadId: string,
	kind: AlertEventType,
) => Promise<boolean | null>;

export interface LeadAlertNotifierConfig {
	store: StateStore;
	projects: ProjectEntry[];
	fetchFn?: FetchLike;
	queueDir?: string;
	claimsReader?: ClaimsReader;
	claimsClaimer?: ClaimsClaimer;
	logger?: (msg: string) => void;
	/** FLY-182: Discord-independent meta-alert sink (best-effort). */
	metaAlert?: MetaAlertSink;
	/** FLY-182: dead-letter dir (default ~/.flywheel/alert-deadletter). */
	deadLetterDir?: string;
	/** FLY-182: max queue files before oldest are dead-lettered (default 500). */
	queueMax?: number;
	/** FLY-182: max queue-file age before dead-lettered (default 3 days). */
	queueMaxAgeMs?: number;
}

/** Queue reasons that are PERMANENT — config doesn't change at runtime, so
 * retrying is pointless. These are dead-lettered on drain regardless of
 * whether today's config could now resolve a channel (Codex design R1#3 —
 * prevents the legacy `no-channel` backlog from flooding core on config flip). */
const PERMANENT_QUEUE_REASONS = new Set([
	"no-channel",
	"no-token",
	"unknown-lead",
]);

const DEFAULT_QUEUE_MAX = 500;
const DEFAULT_QUEUE_MAX_AGE_MS = 259_200_000; // 3 days

const DISCORD_API = "https://discord.com/api/v10";

/** Result of a Discord POST attempt. `transient` failures are retryable. */
type PostOutcome =
	| { ok: true }
	| { ok: false; status?: number; transient: boolean };

/** 5xx and 429 are transient (retry); other 4xx are permanent (dead-letter). */
function isTransientStatus(status: number): boolean {
	return status >= 500 || status === 429;
}

export class LeadAlertNotifier {
	private store: StateStore;
	private projects: ProjectEntry[];
	private fetchFn: FetchLike;
	private queueDir: string;
	private claimsReader?: ClaimsReader;
	private claimsClaimer?: ClaimsClaimer;
	private logger: (msg: string) => void;
	private metaAlert?: MetaAlertSink;
	private deadLetterDir: string;
	private queueMax: number;
	private queueMaxAgeMs: number;

	constructor(config: LeadAlertNotifierConfig) {
		this.store = config.store;
		this.projects = config.projects;
		this.fetchFn = config.fetchFn ?? (globalThis.fetch as FetchLike);
		this.queueDir =
			config.queueDir ?? join(homedir(), ".flywheel", "alert-queue");
		this.claimsReader = config.claimsReader;
		this.claimsClaimer = config.claimsClaimer;
		this.logger =
			config.logger ??
			((msg) => {
				console.log(`[LeadAlertNotifier] ${msg}`);
			});
		this.metaAlert = config.metaAlert;
		this.deadLetterDir =
			config.deadLetterDir ?? join(homedir(), ".flywheel", "alert-deadletter");
		this.queueMax = config.queueMax ?? DEFAULT_QUEUE_MAX;
		this.queueMaxAgeMs = config.queueMaxAgeMs ?? DEFAULT_QUEUE_MAX_AGE_MS;
		mkdirSync(this.queueDir, { recursive: true });
	}

	/** Fire a meta-alert (Discord-independent), best-effort — never throws. */
	private async fireMetaAlert(
		reason: MetaAlertReason,
		title: string,
		body: string,
	): Promise<void> {
		if (!this.metaAlert) return;
		try {
			await this.metaAlert.notify({ reason, title, body });
		} catch (err) {
			this.logger(`meta-alert notify failed: ${(err as Error).message}`);
		}
	}

	/**
	 * Route a payload to the dead-letter dir (PERMANENT failure — never retried,
	 * kept for audit) and fire a meta-alert so the silent failure surfaces.
	 */
	private async deadLetter(
		payload: AlertPayload,
		reason: string,
	): Promise<void> {
		try {
			mkdirSync(this.deadLetterDir, { recursive: true });
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			const file = `${stamp}-${payload.leadId}-${payload.eventType}.json`;
			writeFileSync(
				join(this.deadLetterDir, file),
				JSON.stringify(
					{ ...payload, deadLetteredAt: new Date().toISOString(), reason },
					null,
					2,
				),
				"utf-8",
			);
		} catch (err) {
			this.logger(`dead-letter write failed: ${(err as Error).message}`);
		}
		await this.fireMetaAlert(
			"alert_dead_lettered",
			"LeadAlert dropped (dead-letter)",
			`A Lead alert could not be delivered and was dead-lettered (reason=${reason}, lead=${payload.leadId}, type=${payload.eventType}). The Discord alert path may be misconfigured or down.`,
		);
	}

	async alert(payload: AlertPayload): Promise<AlertResult> {
		const resolved = this.resolveLead(payload.leadId, payload.projectName);
		if (!resolved) {
			this.logger(
				`unknown lead: project=${payload.projectName} leadId=${payload.leadId}`,
			);
			// Permanent routing failure (Codex CR R1) — dead-letter for audit
			// (deadLetter() also fires the Discord-independent meta-alert) so the
			// dropped payload is recorded, not just announced.
			await this.deadLetter(payload, "unknown-lead");
			return { skipped: "unknown-lead", deadLettered: true };
		}
		const { lead, project } = resolved;

		// Step 1: shell-side fast-path read. Avoids building a payload when
		// shell has already posted an alert for this eventId. Not the
		// load-bearing dedup — that's Step 2.
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

		// Step 2 (Fix 2): atomic cross-process claim. INSERT OR IGNORE inside
		// BEGIN IMMEDIATE against the SAME claims.db file that lead-alert.sh
		// writes. Whoever writes the row first wins; everyone else gets
		// `false` and skips. On infrastructure failure (`null`) we proceed
		// to the Bridge-only dedup so a partial outage doesn't silence
		// alerts entirely.
		if (this.claimsClaimer) {
			try {
				const won = await this.claimsClaimer(
					payload.eventId,
					payload.leadId,
					payload.eventType,
				);
				if (won === false) {
					return { skipped: "duplicate" };
				}
				// won === true  → proceed; we own the alert.
				// won === null  → claim infra broken; fall through to Bridge-side dedup.
			} catch (err) {
				this.logger(
					`claimsClaimer threw (falling back to Bridge dedup): ${(err as Error).message}`,
				);
			}
		}

		// Step 3: Bridge-only dedup via lead_events UNIQUE. Catches duplicate
		// in-process Watchdog re-fires plus same-Bridge-process retries that
		// might bypass the cross-process claim (e.g., when claimsClaimer
		// returned null).
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

		// Step 4: Resolve channel + token. Both are PERMANENT failures (config
		// doesn't change at runtime) — dead-letter + meta-alert, do NOT queue
		// for blind retry (FLY-182: the no-channel retry loop was the 1667
		// backlog root cause).
		const channel = this.resolveChannel(lead, project);
		if (!channel) {
			await this.deadLetter(payload, "no-channel");
			return { skipped: "no-channel", deadLettered: true };
		}
		const token = this.resolveToken(lead);
		if (!token) {
			await this.deadLetter(payload, "no-token");
			return { skipped: "no-token", deadLettered: true };
		}

		// Step 5: Fire the Discord POST. Classify failures: transient (5xx /
		// 429 / network) → queue for retry; permanent (other 4xx — bad token,
		// forbidden, channel gone) → dead-letter (retry is pointless).
		const outcome = await this.postMessage(channel, token, payload);
		if (!outcome.ok) {
			if (outcome.transient) {
				this.enqueue(payload, `discord-${outcome.status ?? "net"}`);
				return { queued: true };
			}
			await this.deadLetter(payload, `discord-${outcome.status ?? "4xx"}`);
			return { deadLettered: true };
		}

		// Step 6: Severe follow-up DM (best-effort; never alters primary result).
		let dmSent = false;
		if (payload.severity === "severe" && lead.alertDmUserId) {
			dmSent = await this.sendDm(lead.alertDmUserId, token, payload);
		}

		return dmSent ? { sent: true, dmSent: true } : { sent: true };
	}

	/**
	 * Drain the retry queue. Oldest first. Successes are unlinked; TRANSIENT
	 * failures stay for the next pass; everything else (permanent reason,
	 * malformed, unknown lead, unresolved channel/token, permanent 4xx, aged
	 * out, over cap) is moved to the dead-letter dir so the queue can never
	 * grow without bound or spin forever at sent=0 (FLY-182).
	 *
	 * Does NOT fire meta-alerts per file (would be 1667× on a backlog drain);
	 * returns `deadLettered` so the caller (Bridge drain loop) can fire ONE
	 * debounced meta-alert when dead-lettering occurs.
	 */
	async drainQueue(): Promise<{
		sent: number;
		remaining: number;
		deadLettered: number;
	}> {
		let entries = readdirSync(this.queueDir)
			.filter((f) => f.endsWith(".json"))
			.sort(); // names start with an ISO-ish stamp → lexical ≈ chronological
		let sent = 0;
		let deadLettered = 0;

		// Cap: dead-letter the oldest beyond queueMax before doing any work.
		if (entries.length > this.queueMax) {
			const overflow = entries.slice(0, entries.length - this.queueMax);
			for (const file of overflow) {
				this.moveQueueFileToDeadLetter(file, "queue-cap");
				deadLettered++;
			}
			entries = entries.slice(entries.length - this.queueMax);
		}

		for (const file of entries) {
			const path = join(this.queueDir, file);
			let parsed: AlertPayload & { queueReason?: string; queuedAt?: string };
			try {
				parsed = JSON.parse(readFileSync(path, "utf-8"));
			} catch (err) {
				// Malformed → dead-letter (never skip forever — Codex CR R2#2).
				this.logger(`malformed queue entry ${file}: ${(err as Error).message}`);
				this.moveQueueFileToDeadLetter(file, "malformed");
				deadLettered++;
				continue;
			}

			// Aging.
			if (this.queueFileAgeMs(parsed.queuedAt, path) > this.queueMaxAgeMs) {
				this.moveQueueFileToDeadLetter(file, "aged-out");
				deadLettered++;
				continue;
			}

			// Recorded permanent reason → dead-letter REGARDLESS of whether
			// today's config can resolve a channel (Codex design R1#3: stops the
			// legacy no-channel backlog flooding core after fallbackToCore flip).
			if (
				parsed.queueReason &&
				PERMANENT_QUEUE_REASONS.has(parsed.queueReason)
			) {
				this.moveQueueFileToDeadLetter(file, `permanent-${parsed.queueReason}`);
				deadLettered++;
				continue;
			}

			const resolved = this.resolveLead(parsed.leadId, parsed.projectName);
			if (!resolved) {
				this.moveQueueFileToDeadLetter(file, "unknown-lead");
				deadLettered++;
				continue;
			}
			const { lead, project } = resolved;
			const channel = this.resolveChannel(lead, project);
			const token = this.resolveToken(lead);
			if (!channel || !token) {
				// Config problem — permanent. Dead-letter, don't spin.
				this.moveQueueFileToDeadLetter(
					file,
					channel ? "no-token" : "no-channel",
				);
				deadLettered++;
				continue;
			}

			const outcome = await this.postMessage(channel, token, parsed);
			if (outcome.ok) {
				unlinkSync(path);
				sent++;
			} else if (!outcome.transient) {
				// Permanent 4xx → dead-letter (retry pointless).
				this.moveQueueFileToDeadLetter(
					file,
					`discord-${outcome.status ?? "4xx"}`,
				);
				deadLettered++;
			}
			// transient → leave for the next pass.
		}

		const remaining = readdirSync(this.queueDir).filter((f) =>
			f.endsWith(".json"),
		).length;
		return { sent, remaining, deadLettered };
	}

	/** Move a queue file into the dead-letter dir (no retry, kept for audit). */
	private moveQueueFileToDeadLetter(file: string, reason: string): void {
		const src = join(this.queueDir, file);
		try {
			mkdirSync(this.deadLetterDir, { recursive: true });
			renameSync(src, join(this.deadLetterDir, `${reason}-${file}`));
		} catch (err) {
			this.logger(
				`dead-letter move failed for ${file} (${reason}): ${(err as Error).message}`,
			);
			// Best-effort: remove so a permanently-broken file can't loop forever.
			try {
				unlinkSync(src);
			} catch {
				/* already gone */
			}
		}
	}

	/** Age of a queue file in ms — from `queuedAt` if present, else file mtime. */
	private queueFileAgeMs(queuedAt: string | undefined, path: string): number {
		const now = Date.now();
		if (queuedAt) {
			const t = Date.parse(queuedAt);
			if (!Number.isNaN(t)) return now - t;
		}
		try {
			return now - statSync(path).mtimeMs;
		} catch {
			return 0;
		}
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
	): Promise<PostOutcome> {
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
				return {
					ok: false,
					status: res.status,
					transient: isTransientStatus(res.status),
				};
			}
			return { ok: true };
		} catch (err) {
			// Network/transport error — transient, retry via queue.
			this.logger(
				`Discord POST threw for ${payload.leadId}/${payload.eventType}: ${(err as Error).message}`,
			);
			return { ok: false, transient: true };
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
			return (await this.postMessage(dmChannelId, token, payload)).ok;
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

/** A Lead whose alert path can never deliver with the current config. */
export interface UnreachableAlertLead {
	projectName: string;
	leadId: string;
	reason: string;
}

/**
 * FLY-182 (§4.1): find Leads whose alert channel/token cannot resolve from
 * config — the silent gap that broke alerting for 25 days. Called at Bridge
 * startup so a misconfigured alert path is surfaced LOUDLY instead of failing
 * silently. Token check is config-shape only (a configured env var may still
 * be empty at runtime; that surfaces as a permanent no-token dead-letter).
 */
export function findUnreachableAlertLeads(
	projects: ProjectEntry[],
): UnreachableAlertLead[] {
	const out: UnreachableAlertLead[] = [];
	for (const project of projects) {
		for (const lead of project.leads) {
			const hasChannel =
				!!lead.alertChannel ||
				(!!lead.alertFallbackToCore && !!project.generalChannel);
			if (!hasChannel) {
				out.push({
					projectName: project.projectName,
					leadId: lead.agentId,
					reason:
						"no alertChannel and no alertFallbackToCore+generalChannel — alerts cannot resolve a channel",
				});
				continue;
			}
			// Codex CR R1: check the token actually RESOLVES at runtime, not just
			// that an env-var NAME is configured — a misspelled/unset env var would
			// otherwise pass startup and only surface as a dead-letter on the first
			// real alert.
			const tokenEnvName = lead.alertBotTokenEnv ?? lead.botTokenEnv;
			const tokenResolves =
				(!!tokenEnvName && !!process.env[tokenEnvName]) || !!lead.botToken;
			if (!tokenResolves) {
				out.push({
					projectName: project.projectName,
					leadId: lead.agentId,
					reason: tokenEnvName
						? `alert token env "${tokenEnvName}" is not set / empty (and no inline botToken)`
						: "no alertBotTokenEnv / botTokenEnv / botToken configured",
				});
			}
		}
	}
	return out;
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
