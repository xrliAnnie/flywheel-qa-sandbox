/**
 * FLY-83: Bridge-side Lead liveness watchdog.
 *
 * External observation: never prompt the Lead, never rely on its own
 * heartbeat. Poll tmux `capture-pane` text every 30s, hash it, and watch for
 * a pane that has been frozen.
 *
 * Two alert paths:
 *   - **Pattern-first** (Fix 1): if the captured pane matches a known stuck
 *     pattern (rate_limit / usage_limit / login_expired / permission_blocked)
 *     AND the pane has been stable for at least `paneHashStuckCycles` cycles
 *     (default 2 → ~60s confirmation), fire that classified alert
 *     immediately. Skips the longer 3-cycle wait used for unknown freezes.
 *   - **Pane-hash stuck** (legacy): for unknown freezes (no pattern match),
 *     wait for `paneHashAlertCycles` (default 3 → ~90s) before alerting
 *     with `pane_hash_stuck`.
 *
 * Dedup happens in two layers:
 *   - Cross-process: `claimsClaimer` runs an atomic INSERT OR IGNORE
 *     against `~/.flywheel/alerts/claims.db` — the SAME table that
 *     `scripts/lead-alert.sh` writes. First writer wins. (Fix 2)
 *   - Bridge-only: StateStore.lead_events UNIQUE via tryClaimLeadEvent.
 *
 * Event-id signature (Fix 3): `sha1(projectName|leadId|kind|pane-hash)`.
 *   Tying the eventId to a stable pane-content signature means recovery
 *   followed by re-stuck within the old 10-min bucket fires a fresh alert
 *   (different signature), and a Bridge restart that crosses the bucket
 *   boundary on the same stuck pane stays deduped (same signature).
 *
 * Reference: RunnerIdleWatchdog (packages/teamlead/src/RunnerIdleWatchdog.ts)
 * for external-observation pattern (FLY-92).
 */

import { createHash } from "node:crypto";
import type {
	AlertEventType,
	AlertPayload,
	AlertResult,
} from "./LeadAlertNotifier.js";
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

export type CaptureFn = (windowId: string, lines: number) => Promise<string>;

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
	/** Signature of the pane that triggered the last alert, used as the
	 * mute key while the pane stays unchanged inside Cooldown. */
	cooldownSignature: string | null;
}

const BLOCKED_KEYWORDS: Array<{ kind: AlertEventType; tokens: RegExp[] }> = [
	{ kind: "rate_limit", tokens: [/\brate[-\s]?limit\b/i] },
	{ kind: "usage_limit", tokens: [/\busage[-\s]?limit\b/i] },
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
			// First capture in this lead's lifecycle. Establish baseline; do not
			// alert yet because we need at least one prior tick to confirm the
			// pane is genuinely settled (not mid-render).
			state.lastHash = hash;
			state.stuckCycles = 1;
			if (state.state === "AwaitingFirstCapture") state.state = "Healthy";
			return;
		}
		if (hash !== state.lastHash) {
			// Pane content changed. Reset stuck tracking. (Fix 4) Cooldown is
			// signature-scoped: any change drops cooldown immediately so the
			// next genuine stuck (with a different signature) can fire fresh.
			state.lastHash = hash;
			state.stuckCycles = 1;
			state.cooldownSignature = null;
			state.state = "Healthy";
			return;
		}
		state.stuckCycles += 1;

		// Same pane signature as the last alert — stay muted. The signature
		// includes pane content (Fix 3), so a different stuck condition will
		// produce a different signature and bypass this guard.
		if (state.state === "Cooldown" && state.cooldownSignature === hash) {
			return;
		}
		// If we're somehow still in Cooldown but the signature no longer
		// matches (defensive — change branch above already handles the
		// common case), exit cooldown so classification can run.
		if (state.state === "Cooldown" && state.cooldownSignature !== hash) {
			state.state = "Healthy";
			state.cooldownSignature = null;
		}

		const kind = classify(pane);

		// Fix 1: pattern-first alert. Once the pane has been stable for at
		// least `paneHashStuckCycles` (default 2 → ~60s) AND we recognize a
		// blocked-prompt pattern, fire the classified alert immediately
		// instead of waiting for the longer pane_hash_stuck threshold.
		if (
			kind !== "pane_hash_stuck" &&
			state.stuckCycles >= this.config.paneHashStuckCycles
		) {
			await this.emitAlert(projectName, leadId, pane, state, kind, hash);
			return;
		}

		// Fix 1: unknown freeze — keep the legacy 3-cycle threshold so we
		// don't alert prematurely on routine TUI quiescence.
		if (state.stuckCycles >= this.config.paneHashAlertCycles) {
			await this.emitAlert(
				projectName,
				leadId,
				pane,
				state,
				"pane_hash_stuck",
				hash,
			);
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
		kind: AlertEventType,
		paneHash: string,
	): Promise<void> {
		// Fix 3: signature-based eventId. The pane hash is a stable
		// fingerprint of the actual stuck content; pairing it with
		// projectName + leadId + kind makes the eventId reproducible across
		// Bridge restarts (no bucket aliasing) and naturally distinct after
		// recovery+re-stuck (different pane content → different signature).
		const eventId = computeEventId(projectName, leadId, kind, paneHash);

		// Shell-side claim check (single-direction read). Atomic claim still
		// happens inside LeadAlertNotifier.alert() via claimsClaimer (Fix 2);
		// this read is a fast-path skip when the shell has clearly already
		// posted, so we don't even build the payload.
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
			body: bodyFor(kind, pane),
			severity: severityFor(kind),
		};

		try {
			const result = await this.config.notifier(payload);
			if (result.skipped === "duplicate") {
				state.state = "Silent";
			} else {
				state.state = "Cooldown";
			}
			state.cooldownSignature = paneHash;
			state.lastAlertAtMs = this.now();
		} catch (err) {
			this.logger(
				`notifier threw for ${leadId}/${kind}: ${(err as Error).message}`,
			);
			state.state = "Cooldown";
			state.cooldownSignature = paneHash;
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
				cooldownSignature: null,
			};
			this.leadStates.set(leadId, state);
		}
		return state;
	}
}

function hashPane(content: string): string {
	const normalized = content
		// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI escape sequences from tmux pane
		.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.replace(/\s+$/g, ""))
		.filter((line) => !/^\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?$/i.test(line))
		.join("\n")
		.trim();
	return createHash("sha1").update(normalized).digest("hex");
}

/**
 * Compute the cross-process event id. Format must stay byte-for-byte in
 * sync with `scripts/lead-alert.sh` (see `EVENT_ID=` block) so claims.db
 * dedup works across both paths.
 *
 * Inputs are joined with `|` separators; the signature (caller-supplied
 * pane hash for pane-driven kinds, or a daily date stamp for shell-driven
 * crash_loop) is the differentiator inside a (project, lead, kind) triple.
 */
export function computeEventId(
	projectName: string,
	leadId: string,
	kind: AlertEventType,
	signature: string,
): string {
	return createHash("sha1")
		.update(`${projectName}|${leadId}|${kind}|${signature}`)
		.digest("hex");
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
		case "usage_limit":
			return "Lead hit usage limit";
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

/**
 * Fix 5: per-kind alert body with concrete remediation. We deliberately do
 * NOT include raw pane content — Lead panes can contain customer prompts,
 * memory excerpts, internal IDs, or partial secrets. The kind + actionable
 * suggestion is enough for Annie to decide what to do; she can always open
 * the tmux pane for full context.
 */
export function bodyFor(kind: AlertEventType, _pane: string): string {
	switch (kind) {
		case "rate_limit":
			return "Anthropic API rate limit reached. Wait ~1 hr for reset, or check whether the Lead is in a tight loop.";
		case "usage_limit":
			return "Claude Code usage limit hit. Top up Anthropic billing (https://console.anthropic.com/settings/billing) and re-run.";
		case "login_expired":
			return "Claude CLI login expired. Re-run `claude login` on the Lead host, then remove the matching marker under ~/.flywheel/blocked/.";
		case "permission_blocked":
			return "Lead is waiting on a permission prompt that cannot be auto-confirmed. Approve / deny it in the Lead's tmux pane.";
		case "crash_loop":
			return "Lead has crashed repeatedly. Check the supervisor log under ~/.flywheel/logs/ — likely Claude CLI / config issue.";
		case "pane_hash_stuck":
			return "Lead pane has been frozen for several poll cycles with no recognizable blocked-prompt pattern. Open the tmux pane to investigate.";
	}
}
