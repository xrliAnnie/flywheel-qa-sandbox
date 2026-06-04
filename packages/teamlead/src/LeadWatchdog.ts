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
	/**
	 * FLY-182 B3 / FLY-193: when true, suppress `pane_hash_stuck` for panes that
	 * look alive-but-idle (see `isIdleHealthyPane`). The recognizer is now
	 * validated against committed real Lead pane fixtures
	 * (`__tests__/fixtures/lead-panes/`) so the Bridge wires this ON by default
	 * (override `FLYWHEEL_PANE_IDLE_SUPPRESS=0` to force off). Left optional here
	 * (undefined → falsy) so unit tests opt in explicitly.
	 */
	suppressIdleHealthy?: boolean;
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

		// FLY-182 B3: a Lead that is alive but IDLE has a naturally static pane
		// (no spinner / no "esc to interrupt") → the pane hash never changes and
		// the legacy threshold misfires `pane_hash_stuck`. In production 1447 of
		// 1667 queued alerts were exactly this. When suppression is enabled
		// (default OFF until QA validates the recognizer against real
		// idle/busy/blocked/frozen pane fixtures — FLY-169 lesson) AND this is an
		// unknown freeze (no blocked pattern) AND the pane looks idle-healthy,
		// treat the Lead as alive-idle and do NOT alert. Blocked patterns above
		// still fire; uncertain panes still escalate (fail-open to alerting).
		if (
			this.config.suppressIdleHealthy &&
			kind === "pane_hash_stuck" &&
			isIdleHealthyPane(pane)
		) {
			state.state = "Healthy";
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

/**
 * LIVE "operation in flight" markers — operations whose indicator is removed the
 * moment they finish, so a static pane that still shows one is genuinely frozen
 * mid-operation (→ must alert):
 *  - `esc to interrupt` / `esc to cancel`: the interrupt hint during generation.
 *  - `Compacting conversation`: the auto-compact progress overlay (verified to
 *    disappear once compaction completes — a Lead at ctx 100% mid-compact).
 *
 * Deliberately NOT included: the spinner glyph + elapsed-timer line
 * (`✢ … (11m 3s · almost done thinking)`) and the old bare-word markers
 * (`thinking` / `working` / token counter). Those **linger** in the transcript
 * after an extended-thinking turn completes, and the Lead's own scrollback
 * chatter ("runners are now working", "15,540 tokens used") trips them — that
 * over-match is exactly what defeated suppression for product-lead (FLY-193).
 *
 * KNOWN LIMITATION: a Lead genuinely hung mid-EXTENDED-THINKING (a frozen
 * `… almost done thinking` line with no interrupt hint) is indistinguishable
 * from idle-after-extended-thinking by a single static capture, so it is
 * suppressed (favouring no-spam). Such hangs are rare; the Lead remains
 * observable via tmux. An interrupt/cancel hint or a frozen compact still alert.
 */
const WORKING_MARKERS: RegExp[] = [
	/esc to interrupt/i,
	/\besc\b[^\n]*\bto cancel\b/i,
	/compacting conversation/i,
];

/**
 * High-confidence markers of an idle, ready-for-input Claude Code TUI. The first
 * three are the empty-input-box hints; the last two are the persistent status
 * bar (model + permissions + context gauge) which is the most reliable anchor —
 * it survives even when `shift+tab to cycle` is replaced by `N shell` for a Lead
 * with a background shell running.
 */
const IDLE_READY_MARKERS: RegExp[] = [
	/\?\s*for shortcuts/i,
	/shift\+tab to cycle/i,
	/\btry "/i, // the placeholder hint shown in an empty idle input box
	/⏵⏵\s+bypass permissions/i, // status-bar permissions indicator
	/\bctx\s+\d+%/i, // status-bar context gauge
];

/**
 * The top border of the input box, rendered as a long horizontal rule ending in
 * the agent handle: `──…── @product-lead ──`. Used to locate the live render
 * region (input box + status bar) at the bottom of the pane.
 */
const INPUT_BOX_TOP = /─{6,}[^\n]*@[\w-]+\s+─/u;

/**
 * FLY-193: extract the LIVE render region of a pane — the input box and status
 * bar at the bottom, plus a few lines above to catch a spinner that is actively
 * rendering (or frozen) immediately above the box.
 *
 * Why: `LeadWatchdog` captures 200 lines of scrollback (`capture-pane -S -200`).
 * Scanning the whole capture for working/idle markers gets poisoned by STALE
 * lines — a Lead that printed "…thinking…" or "…working…" 50 lines ago and is
 * now idle would never be recognized as idle (false positive persists). The live
 * TUI render is always the LAST thing in the pane, so we anchor to it.
 */
function liveRegion(pane: string): string {
	const lines = pane.replace(/\r/g, "").split("\n");
	let boxIdx = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (INPUT_BOX_TOP.test(lines[i]!)) {
			boxIdx = i;
			break;
		}
	}
	// 4 lines above the box top captures a spinner rendering just above the
	// input box; if no box border is found (e.g. a startup resume/compact menu
	// that has not rendered the normal TUI), fall back to the last 12 lines.
	const start =
		boxIdx >= 0 ? Math.max(0, boxIdx - 4) : Math.max(0, lines.length - 12);
	return lines.slice(start).join("\n");
}

/**
 * FLY-182 B3 / FLY-193 — recognize an alive-but-IDLE Claude Code Lead pane.
 *
 * NARROW allowlist, defaults to `false` on any uncertainty (fail-open to
 * alerting — a missed-suppression merely keeps a false positive, while a wrong
 * suppression would hide a real freeze). Evaluated against the LIVE render
 * region (see `liveRegion`), NOT the whole 200-line scrollback. Returns `true`
 * ONLY when, in that region:
 *  - no blocked-prompt keyword (rate_limit / usage_limit / login / permission),
 *  - no live "operation in flight" marker (esc-to-interrupt/cancel, or an
 *    in-progress compact), and
 *  - a high-confidence ready-for-input marker is present.
 *
 * Real-freeze safety: a startup resume/compact menu has no idle marker (and the
 * compact prompt carries "esc to cancel"), so it returns `false` → still alerts;
 * a frozen auto-compact still shows "Compacting conversation" → still alerts.
 * Validated against committed real fixtures in
 * `__tests__/fixtures/lead-panes/` (real idle Leads incl. a ctx-100% capture
 * must-suppress; the documented resume menu, compact prompt, and a frozen
 * compact must-NOT-suppress).
 */
export function isIdleHealthyPane(pane: string): boolean {
	if (!pane) return false;
	const region = liveRegion(pane);
	const lower = region.toLowerCase();
	// Any known blocked pattern in the live region → NOT idle-healthy.
	for (const { tokens } of BLOCKED_KEYWORDS) {
		if (tokens.some((t) => t.test(lower))) return false;
	}
	// A live operation in flight (or frozen mid-operation) → NOT idle. A frozen
	// working pane IS a real stuck condition we must keep alerting on.
	if (WORKING_MARKERS.some((t) => t.test(region))) return false;
	// Require a high-confidence idle-ready marker in the live region.
	return IDLE_READY_MARKERS.some((t) => t.test(region));
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
		// FLY-195: never emitted by LeadWatchdog (the stuck-runner detector owns
		// it and builds its own title); case exists for switch exhaustiveness.
		case "runner_stuck_unhandled":
			return "Runner stuck unhandled";
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
		// FLY-195: never emitted by LeadWatchdog (see titleFor).
		case "runner_stuck_unhandled":
			return "A stuck Runner episode received no Lead disposition within the grace window. Check the owning Lead, then the runner tmux window.";
	}
}
