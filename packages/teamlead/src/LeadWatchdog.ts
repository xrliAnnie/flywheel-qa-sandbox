/**
 * FLY-83: Bridge-side Lead liveness watchdog.
 *
 * External observation: never prompt the Lead, never rely on its own
 * heartbeat. Poll tmux `capture-pane` text every 30s, hash it, and watch for
 * a pane that has been frozen for N cycles. If the frozen content also looks
 * like a blocked prompt (rate limit / login expired / permission), tag the
 * alert with that kind so Annie sees something actionable.
 *
 * Dedup happens in two layers:
 *   - Shell path writes ~/.flywheel/alerts/claims.db via `lead-alert.sh`.
 *     We read it to avoid re-alerting after shell has already notified.
 *   - Bridge path uses StateStore.lead_events UNIQUE via
 *     LeadAlertNotifier.alert() + tryClaimLeadEvent.
 *
 * Reference: RunnerIdleWatchdog (packages/teamlead/src/RunnerIdleWatchdog.ts)
 * for external-observation pattern (FLY-92).
 */

import { createHash } from "node:crypto";
import type { AlertEventType, AlertPayload, AlertResult } from "./LeadAlertNotifier.js";
import type { LeadWindowRef } from "./LeadWindowLocator.js";
import type { ProjectEntry } from "./ProjectConfig.js";
import type { StateStore } from "./StateStore.js";

export type LeadWatchdogState =
	| "AwaitingFirstCapture"
	| "Healthy"
	| "Suspicious"
	| "Cooldown"
	| "Silent";

export type LocateWindowFn = (
	projectName: string,
	leadId: string,
) => Promise<LeadWindowRef | null>;

export type CaptureFn = (
	windowId: string,
	lines: number,
) => Promise<string>;

export type NotifierFn = (payload: AlertPayload) => Promise<AlertResult>;

export interface LeadWatchdogConfig {
	pollIntervalMs: number;
	paneHashStuckCycles: number;
	paneHashAlertCycles: number;
	cooldownMs: number;
	projects: ProjectEntry[];
	store: StateStore;
	notifier: NotifierFn;
	locateWindowFn: LocateWindowFn;
	captureFn: CaptureFn;
	claimsReader: () => Promise<Set<string>>;
	blockedMarkerReader: (leadId: string) => Promise<string[]>;
	now?: () => number;
	/**
	 * Test-only hook: when true, ANY non-empty claimsReader result is treated
	 * as "this eventId was already claimed." Production always compares the
	 * actual eventId.
	 */
	claimsReaderMatchAll?: boolean;
	logger?: (msg: string) => void;
}

interface LeadState {
	state: LeadWatchdogState;
	lastHash: string | null;
	stuckCycles: number;
	lastAlertAtMs: number | null;
}

const BLOCKED_KEYWORDS: Array<{ kind: AlertEventType; tokens: RegExp[] }> = [
	{
		kind: "rate_limit",
		tokens: [/\brate[-\s]?limit\b/i, /\busage[-\s]?limit\b/i],
	},
	{
		kind: "login_expired",
		tokens: [/\blogin\b.*\bexpired\b/i, /\breauth(?:enticat\w+)?\b/i],
	},
	{
		kind: "permission_blocked",
		tokens: [/\bpermission\b.*\b(?:required|denied)\b/i],
	},
];

export class LeadWatchdog {
	private leadStates = new Map<string, LeadState>();
	private timerHandle: ReturnType<typeof setInterval> | null = null;
	private polling = false;
	private readonly now: () => number;
	private readonly logger: (msg: string) => void;

	constructor(private readonly config: LeadWatchdogConfig) {
		this.now = config.now ?? (() => Date.now());
		this.logger =
			config.logger ??
			((msg) => {
				console.log(`[LeadWatchdog] ${msg}`);
			});
	}

	start(): void {
		if (this.timerHandle) return;
		this.timerHandle = setInterval(() => {
			void this.poll();
		}, this.config.pollIntervalMs);
	}

	stop(): void {
		if (this.timerHandle) {
			clearInterval(this.timerHandle);
			this.timerHandle = null;
		}
	}

	async pollOnce(): Promise<void> {
		await this.poll();
	}

	getState(leadId: string): LeadWatchdogState {
		return this.leadStates.get(leadId)?.state ?? "AwaitingFirstCapture";
	}

	private async poll(): Promise<void> {
		if (this.polling) return;
		this.polling = true;
		try {
			for (const project of this.config.projects) {
				for (const lead of project.leads) {
					await this.tickLead(project.projectName, lead.agentId);
				}
			}
		} finally {
			this.polling = false;
		}
	}

	private async tickLead(projectName: string, leadId: string): Promise<void> {
		const state = this.getOrInit(leadId);

		// 1. Blocked marker takes precedence. supervisor already alerted, stay silent.
		try {
			const markers = await this.config.blockedMarkerReader(leadId);
			if (markers.length > 0) {
				state.state = "Silent";
				return;
			}
		} catch (err) {
			this.logger(
				`blockedMarkerReader failed for ${leadId}: ${(err as Error).message}`,
			);
		}

		// 2. Find the tmux window.
		let windowRef: LeadWindowRef | null = null;
		try {
			windowRef = await this.config.locateWindowFn(projectName, leadId);
		} catch (err) {
			this.logger(
				`locateWindowFn failed for ${leadId}: ${(err as Error).message}`,
			);
		}
		if (!windowRef) {
			if (state.state === "Silent") state.state = "AwaitingFirstCapture";
			if (state.state !== "Cooldown") state.state = "AwaitingFirstCapture";
			state.lastHash = null;
			state.stuckCycles = 0;
			return;
		}

		// 3. Capture pane content.
		let pane: string;
		try {
			pane = await this.config.captureFn(windowRef.windowId, 200);
		} catch (err) {
			this.logger(
				`captureFn failed for ${leadId}@${windowRef.windowId}: ${(err as Error).message}`,
			);
			if (state.state !== "Cooldown") state.state = "AwaitingFirstCapture";
			return;
		}

		const hash = hashPane(pane);
		if (state.lastHash === null) {
			state.lastHash = hash;
			state.stuckCycles = 1;
			if (state.state === "AwaitingFirstCapture") state.state = "Healthy";
			return;
		}
		if (hash !== state.lastHash) {
			state.lastHash = hash;
			state.stuckCycles = 1;
			if (state.state === "Cooldown") {
				const elapsed = this.now() - (state.lastAlertAtMs ?? 0);
				if (elapsed >= this.config.cooldownMs) {
					state.state = "Healthy";
				}
			} else {
				state.state = "Healthy";
			}
			return;
		}
		state.stuckCycles += 1;

		if (state.state === "Cooldown") {
			// Still frozen inside cooldown — don't re-alert. Wait.
			return;
		}

		if (state.stuckCycles >= this.config.paneHashAlertCycles) {
			await this.emitAlert(projectName, leadId, pane, state);
			return;
		}
		if (state.stuckCycles >= this.config.paneHashStuckCycles) {
			state.state = "Suspicious";
		}
	}

	private async emitAlert(
		projectName: string,
		leadId: string,
		pane: string,
		state: LeadState,
	): Promise<void> {
		const kind = classify(pane);
		const bucket = Math.floor(this.now() / (10 * 60 * 1000));
		const eventId = createHash("sha1")
			.update(`${leadId}|${kind}|${bucket}`)
			.digest("hex");

		// Shell-side claim check (single-direction dedup).
		try {
			const claimed = await this.config.claimsReader();
			const hit =
				this.config.claimsReaderMatchAll && claimed.size > 0
					? true
					: claimed.has(eventId);
			if (hit) {
				state.state = "Silent";
				state.lastAlertAtMs = this.now();
				return;
			}
		} catch (err) {
			this.logger(
				`claimsReader failed during alert for ${leadId}: ${(err as Error).message}`,
			);
		}

		const payload: AlertPayload = {
			leadId,
			projectName,
			eventId,
			eventType: kind,
			title: titleFor(kind),
			body: summarizePane(pane),
			severity: severityFor(kind),
		};

		try {
			const result = await this.config.notifier(payload);
			if (result.skipped === "duplicate") {
				state.state = "Silent";
			} else {
				state.state = "Cooldown";
			}
			state.lastAlertAtMs = this.now();
		} catch (err) {
			this.logger(
				`notifier threw for ${leadId}/${kind}: ${(err as Error).message}`,
			);
			state.state = "Cooldown";
			state.lastAlertAtMs = this.now();
		}
	}

	private getOrInit(leadId: string): LeadState {
		let state = this.leadStates.get(leadId);
		if (!state) {
			state = {
				state: "AwaitingFirstCapture",
				lastHash: null,
				stuckCycles: 0,
				lastAlertAtMs: null,
			};
			this.leadStates.set(leadId, state);
		}
		return state;
	}
}

function hashPane(content: string): string {
	const normalized = content
		.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.replace(/\s+$/g, ""))
		.filter((line) => !/^\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?$/i.test(line))
		.join("\n")
		.trim();
	return createHash("sha1").update(normalized).digest("hex");
}

function classify(pane: string): AlertEventType {
	const lower = pane.toLowerCase();
	for (const { kind, tokens } of BLOCKED_KEYWORDS) {
		if (tokens.some((t) => t.test(lower))) return kind;
	}
	return "pane_hash_stuck";
}

function titleFor(kind: AlertEventType): string {
	switch (kind) {
		case "rate_limit":
			return "Lead hit rate limit";
		case "login_expired":
			return "Lead login expired";
		case "permission_blocked":
			return "Lead waiting on permission prompt";
		case "crash_loop":
			return "Lead crash-looping";
		case "pane_hash_stuck":
			return "Lead pane has been frozen";
	}
}

function severityFor(kind: AlertEventType): AlertPayload["severity"] {
	if (kind === "crash_loop" || kind === "login_expired") return "severe";
	if (kind === "permission_blocked") return "warning";
	return "warning";
}

function summarizePane(pane: string): string {
	const lines = pane
		.split("\n")
		.map((l) => l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd())
		.filter((l) => l.length > 0);
	const tail = lines.slice(-5).join("\n");
	return tail.length > 800 ? `${tail.slice(0, 800)}…` : tail;
}
