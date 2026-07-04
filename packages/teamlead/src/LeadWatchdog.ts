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
	/**
	 * FLY-247: dynamic per-tick membership (config snapshot + fleet evidence
	 * map resolved by the caller). When provided it supersedes the static
	 * `projects` list on every poll; state for leads that leave the
	 * membership is cleaned up (no stale cooldown/hash carryover).
	 */
	projectsProvider?: () => ProjectEntry[];
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
	 * FLY-368: real-time recovery hook (optimization, NOT the source of truth —
	 * reconcile is). Fired when a previously-alerted Lead recovers: a blocked
	 * episode clears (kind→null) or a pane_hash_stuck pane changes back to
	 * healthy. The AlertChannelHub resolves the matching alert thread. Absent =
	 * unchanged behavior (FLY-231 not-normalized pattern).
	 */
	onRecovery?: (
		projectName: string,
		leadId: string,
		recoveredKind: AlertEventType,
	) => void;
	/**
	 * FLY-368: called once at the end of every poll cycle so a reconcile pass can
	 * piggyback this 30s cadence WITHOUT adding a second timer (FLY-169 discipline).
	 * Wrapped fail-safe by the caller; errors must not wedge the poll loop.
	 */
	onPollComplete?: () => Promise<void> | void;
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
	/** FLY-220: the blocked-keyword kind of the CURRENT alerted episode (null when
	 * the Lead is not in an already-alerted block). Cleared when the live state no
	 * longer classifies as a blocked kind (recovery) so the next genuine block
	 * fires fresh. Makes a real block alert once-per-episode regardless of pane
	 * churn. */
	episodeKind: AlertEventType | null;
	/** FLY-368: the kind of the LAST alert emitted for this lead, used to fire the
	 * onRecovery hook exactly once when the lead recovers (covers both blocked
	 * kinds and pane_hash_stuck). Null once recovery has been signaled. */
	lastAlertedKind: AlertEventType | null;
}

const BLOCKED_KEYWORDS: Array<{ kind: AlertEventType; tokens: RegExp[] }> = [
	{ kind: "rate_limit", tokens: [/\brate[-\s]?limit\b/i] },
	// FLY-218: the negative lookbehind keeps a transient Anthropic 529 throttle
	// ("Server is temporarily limiting requests (not your usage limit)") from
	// matching as a real quota cap. classify() scans the WHOLE pane, so even a
	// STALE "not your usage limit" line in scrollback would otherwise trip this
	// (the live-region recognizer below only guards the bottom render region).
	{ kind: "usage_limit", tokens: [/(?<!not your )\busage[-\s]?limit\b/i] },
	{
		kind: "login_expired",
		tokens: [/\blogin\b.*\bexpired\b/i, /\breauth(?:enticat\w+)?\b/i],
	},
	{
		kind: "permission_blocked",
		tokens: [/\bpermission\b.*\b(?:required|denied)\b/i],
	},
];

/** FLY-247 R3#4: composite per-lead state key. */
function stateKey(projectName: string, leadId: string): string {
	return `${projectName}:${leadId}`;
}

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

	getState(leadId: string, projectName?: string): LeadWatchdogState {
		if (projectName !== undefined) {
			return (
				this.leadStates.get(stateKey(projectName, leadId))?.state ??
				"AwaitingFirstCapture"
			);
		}
		// Back-compat single-arg lookup: match any project's entry for this
		// leadId (pre-FLY-247 keying was bare leadId).
		for (const [key, st] of this.leadStates) {
			if (key.endsWith(`:${leadId}`)) return st.state;
		}
		return "AwaitingFirstCapture";
	}

	private async poll(): Promise<void> {
		if (this.polling) return;
		this.polling = true;
		try {
			const projects = this.config.projectsProvider
				? this.config.projectsProvider()
				: this.config.projects;
			const membership = new Set<string>();
			for (const project of projects) {
				for (const lead of project.leads) {
					membership.add(stateKey(project.projectName, lead.agentId));
					await this.tickLead(project.projectName, lead.agentId);
				}
			}
			// FLY-247 R3#4: drop state for removed/excluded leads so a
			// re-included lead starts fresh and same-name leads across
			// projects never share cooldown/hash state.
			if (this.config.projectsProvider) {
				for (const key of this.leadStates.keys()) {
					if (!membership.has(key)) this.leadStates.delete(key);
				}
			}
			// FLY-368: run the reconcile pass (or any post-poll work) on the SAME
			// 30s cadence — no second timer. Wrapped so it can never wedge the poll.
			if (this.config.onPollComplete) {
				try {
					await this.config.onPollComplete();
				} catch (err) {
					this.logger(`onPollComplete threw: ${(err as Error).message}`);
				}
			}
		} finally {
			this.polling = false;
		}
	}

	private async tickLead(projectName: string, leadId: string): Promise<void> {
		// FLY-247 R3#4: state keyed by (projectName, leadId) — two projects
		// with a same-named lead must never share cooldown/hash state.
		const state = this.getOrInit(stateKey(projectName, leadId));

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

		// FLY-220: classify the Lead's OWN live state (echo/scrollback stripped) up
		// front, so recovery is detected on EVERY tick — even one where the pane
		// changed (a working/idle recovery churns the pane and would otherwise
		// early-return below before classification). The moment the live state stops
		// showing the alerted block, the episode is over → clear it so the next
		// genuine block fires fresh (Codex R5 HIGH-1: an episode must never outlive
		// the condition that opened it, or a real new block of the same kind is
		// silenced forever).
		const kind = classify(pane);
		if (state.episodeKind !== null && state.episodeKind !== kind) {
			// FLY-368: a blocked episode just cleared → fire the recovery hook once.
			this.fireRecovery(projectName, leadId, state, state.episodeKind);
			state.episodeKind = null;
		}

		// FLY-220: CHANGE-DETECTION + cooldown signature hash the Lead's OWN live
		// state (echo/scrollback stripped). A persistent real block therefore
		// accumulates `stuckCycles` and fires its FIRST alert even while the Bridge's
		// own alert echoes churn the full pane every poll (Codex R6 HIGH-1: a
		// full-pane hash changed every poll → never reached the threshold → the real
		// block's first alert was never sent). The eventId is computed SEPARATELY
		// from the full pane in `emitAlert` (FLY-83/shell parity, distinct episodes).
		const liveHash = hashPane(ownStateRegion(pane));
		if (state.lastHash === null) {
			// First capture in this lead's lifecycle. Establish baseline; do not
			// alert yet because we need at least one prior tick to confirm the
			// pane is genuinely settled (not mid-render).
			state.lastHash = liveHash;
			state.stuckCycles = 1;
			if (state.state === "AwaitingFirstCapture") state.state = "Healthy";
			return;
		}
		if (liveHash !== state.lastHash) {
			// Live state changed. Reset stuck tracking. (Fix 4) Cooldown is
			// signature-scoped: any change drops cooldown immediately so the
			// next genuine stuck (with a different signature) can fire fresh.
			// FLY-368: if we had alerted (pane_hash_stuck path — blocked kinds are
			// handled by the episodeKind-clear above, which nulls lastAlertedKind),
			// the pane moving = recovery → fire the hook once.
			if (state.lastAlertedKind !== null) {
				this.fireRecovery(projectName, leadId, state, state.lastAlertedKind);
			}
			state.lastHash = liveHash;
			state.stuckCycles = 1;
			state.cooldownSignature = null;
			state.state = "Healthy";
			return;
		}
		state.stuckCycles += 1;

		// Same live-state signature as the last alert — stay muted.
		if (state.state === "Cooldown" && state.cooldownSignature === liveHash) {
			return;
		}
		// If we're somehow still in Cooldown but the signature no longer
		// matches (defensive — change branch above already handles the
		// common case), exit cooldown so classification can run.
		if (state.state === "Cooldown" && state.cooldownSignature !== liveHash) {
			state.state = "Healthy";
			state.cooldownSignature = null;
		}

		// FLY-218: a transient Anthropic 529 server-side throttle ("Server is
		// temporarily limiting requests (not your usage limit)") is neither a
		// usage cap nor a freeze — the Lead is alive and the throttle self-resolves
		// in seconds. Left to fall through it would (a) classify as usage_limit
		// (the substring "usage limit" inside the negation) → a false "Top up
		// billing" alert, or (b) if that were tightened away, stall as a static
		// error pane and trip pane_hash_stuck. Recognize it as a live,
		// self-recovering state and short-circuit BOTH paths. The markers are
		// unambiguous, so this fires regardless of `suppressIdleHealthy`.
		if (isTransientThrottlePane(pane)) {
			state.state = "Healthy";
			return;
		}

		// FLY-220 episode dedup: a GENUINE block alerts ONCE per episode. Once we
		// have alerted this kind, stay muted until the Lead RECOVERS (the every-tick
		// recovery check above cleared `episodeKind`). This — not the pane-hash
		// cooldown, which drifts as alert echoes/scrollback churn the pane — is what
		// makes a real rate_limit/usage cap fire once instead of forever (Annie's
		// "it never stops" report).
		if (kind !== "pane_hash_stuck" && state.episodeKind === kind) {
			state.state = "Silent";
			return;
		}

		// Fix 1: pattern-first alert. Once the pane has been stable for at
		// least `paneHashStuckCycles` (default 2 → ~60s) AND we recognize a
		// blocked-prompt pattern, fire the classified alert immediately
		// instead of waiting for the longer pane_hash_stuck threshold.
		if (
			kind !== "pane_hash_stuck" &&
			state.stuckCycles >= this.config.paneHashStuckCycles
		) {
			// FLY-220: mark this episode alerted so the same ongoing block stays
			// muted until the Lead recovers (kind → pane_hash_stuck above).
			state.episodeKind = kind;
			await this.emitAlert(projectName, leadId, pane, state, kind, liveHash);
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
				liveHash,
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
		liveHash: string,
	): Promise<void> {
		// Fix 3: signature-based eventId. Computed from the FULL pane (FLY-220:
		// NOT the live-state `liveHash` used for change-detection) so it stays
		// byte-for-byte in sync with `scripts/lead-alert.sh` (cross-process
		// claims.db parity) and naturally distinct after recovery+re-stuck
		// (the surrounding scrollback differs between episodes). `liveHash` is
		// only the in-process cooldown signature.
		const eventId = computeEventId(projectName, leadId, kind, hashPane(pane));

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
			state.cooldownSignature = liveHash;
			state.lastAlertAtMs = this.now();
			// FLY-368: remember what we alerted so the recovery hook can fire once.
			state.lastAlertedKind = kind;
		} catch (err) {
			this.logger(
				`notifier threw for ${leadId}/${kind}: ${(err as Error).message}`,
			);
			state.state = "Cooldown";
			state.cooldownSignature = liveHash;
			state.lastAlertAtMs = this.now();
			state.lastAlertedKind = kind;
		}
	}

	/**
	 * FLY-368: fire the optional recovery hook once and clear `lastAlertedKind` so
	 * the same recovery is never signaled twice (the two call sites — blocked
	 * episode clear, pane-hash change — would otherwise both fire in one tick).
	 * Best-effort: a throwing hook must never break the watchdog tick.
	 */
	private fireRecovery(
		projectName: string,
		leadId: string,
		state: LeadState,
		recoveredKind: AlertEventType,
	): void {
		state.lastAlertedKind = null;
		if (!this.config.onRecovery) return;
		try {
			this.config.onRecovery(projectName, leadId, recoveredKind);
		} catch (err) {
			this.logger(
				`onRecovery threw for ${leadId}/${recoveredKind}: ${(err as Error).message}`,
			);
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
				episodeKind: null,
				lastAlertedKind: null,
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
	// FLY-220: scan the Lead's OWN live state, not the full pane — an alert
	// echoed back into the pane (shared core channel) must never re-classify as
	// that same blocked state. FLY-193 live-region scoping + echo/template strip.
	const lower = ownStateRegion(pane).toLowerCase();
	for (const { kind, tokens } of BLOCKED_KEYWORDS) {
		if (tokens.some((t) => t.test(lower))) return kind;
	}
	return "pane_hash_stuck";
}

/**
 * FLY-368: PUBLIC wrapper of the watchdog's pane classifier so the AlertChannelHub
 * reconcile pass can decide whether a previously-alerted kind is still present —
 * WITHOUT duplicating the (security-sensitive) private `classify`/`ownStateRegion`
 * parsing (Codex R2 LOW-3). Same result as the internal classifier.
 */
export function classifyLeadAlertPane(pane: string): AlertEventType {
	return classify(pane);
}

/**
 * FLY-368: PUBLIC live-state hash of a Lead pane (echo/scrollback stripped). The
 * reconcile pass uses this for the conservative two-capture rule on a
 * `pane_hash_stuck` thread: the pane is only treated as recovered when this hash
 * CHANGES across captures (a still-identical live region is still frozen).
 */
export function leadPaneLiveHash(pane: string): string {
	return hashPane(ownStateRegion(pane));
}

/**
 * FLY-368 — the resume-menu options + the "Enter to confirm" action hint. The
 * resume menu lets a single Enter accept "Resume from summary (recommended)",
 * which is the safe, reversible unstick a human does manually.
 */
const RESUME_MENU_MARKERS: RegExp[] = [
	/resume from summary/i,
	/resume full session/i,
	/enter to confirm/i,
];

/**
 * FLY-368 — shapes that look superficially similar but whose Enter does something
 * NOT equivalent to acknowledging the resume menu (e.g. proactively STARTING a
 * compaction). Their presence vetoes the safe-resume-Enter recognizer (Codex R1
 * MEDIUM-7: compact prompt / in-flight compaction is a separate product decision).
 */
const NOT_RESUME_MENU_MARKERS: RegExp[] = [
	/compact the conversation/i,
	/compacting conversation/i,
];

/**
 * FLY-368 — recognize the EXACT resume-menu shape that is safe for the
 * auto-repair bot to clear with a single Enter. NARROW + fail-closed: returns
 * true ONLY when all resume-menu markers are present AND no compact-prompt /
 * compacting marker is. Validated against the real `freeze-resume-menu.txt`
 * fixture (must-pass) and `freeze-compact-prompt.txt` / `freeze-compacting.txt`
 * (must-fail). The Lead `permission_blocked` prompt never matches (no resume
 * markers) and is intentionally NEVER auto-confirmed.
 */
export function isSafeResumeMenuForEnter(pane: string): boolean {
	if (!pane) return false;
	const region = ownStateRegion(pane);
	if (NOT_RESUME_MENU_MARKERS.some((t) => t.test(region))) return false;
	return RESUME_MENU_MARKERS.every((t) => t.test(region));
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
 * FLY-220 — signals that a pane line STARTS an alert echo (a Bridge alert posted
 * to a SHARED core channel echoes into every Lead's pane). These are
 * BRIDGE-UNIQUE — text a real Claude Code TUI never emits about itself — so
 * stripping a line on them alone can NEVER hide a genuine Lead block (Codex R1
 * HIGH-1). Inbound messages render `←`-prefixed and are usually truncated to one
 * line (see the real `idle-product-lead.txt` fixture); the `(<lead> / <kind>)`
 * signature + the canned titles cover a non-`←` first line too.
 */
const INBOUND_ECHO_LINE = /^\s*←/;
const ALERT_ECHO_START =
	/\(\s*[a-z0-9-]+\s*\/\s*(?:rate_limit|usage_limit|login_expired|permission_blocked|pane_hash_stuck|crash_loop|runner_stuck_unhandled)\s*\)|\blead hit (?:rate|usage) limit\b|\blead login expired\b|\blead waiting on permission prompt\b|\blead pane has been frozen\b|\blead crash-looping\b|\brunner stuck unhandled\b/i;

/**
 * FLY-220 — the Lead's OWN live state text: the live render region (FLY-193) with
 * inbound-Discord echoes and the Bridge's own alert template removed (line by
 * line). EVERY blocked-keyword read (`classify`, `isIdleHealthyPane`,
 * `isTransientThrottlePane`) goes through this, so an alert echoed back into a
 * pane (or a stale one in the live region) can never re-trigger the same alert —
 * root cure for the cross-Lead alert-amplification loop on a shared channel.
 *
 * A line is dropped ONLY when it is unambiguously NOT the Lead's own state:
 *  - `←`-prefixed (an inbound Discord message — tmux's inbound marker), OR
 *  - it carries a Bridge-UNIQUE alert signature (`ALERT_ECHO_START`: the
 *    `(<lead> / <kind>)` token or a canned title — text a real Claude TUI never
 *    emits about itself).
 *
 * Deliberately a per-line filter with NO body-continuation stripping (Codex R3):
 * real inbound echoes render TRUNCATED to a single `←` line (see the committed
 * `idle-product-lead.txt` fixture — even the kind is cut: `pane_hash_stuc…`), so
 * the alert body never appears on its own line. Trying to strip a "wrapped body"
 * would risk swallowing a genuine block rendered right after an echo — and hiding
 * a real block is worse than a duplicate alarm. If a future REAL capture ever
 * shows a multi-line (wrapped) echo, the un-stripped body would at worst produce
 * one extra alarm (fail-toward-alerting), never a hidden block.
 *
 * Echoes are removed from the FULL pane BEFORE the live-region window is taken
 * (Codex R7 HIGH-2): otherwise several inbound echoes accumulating between a real
 * block line and the input box would consume the window's 4-line budget and push
 * the genuine block out of view → classify misses it → first alert never fires.
 */
function ownStateRegion(pane: string): string {
	const withoutEchoes = pane
		.split("\n")
		.filter(
			(line) => !INBOUND_ECHO_LINE.test(line) && !ALERT_ECHO_START.test(line),
		)
		.join("\n");
	return liveRegion(withoutEchoes);
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
	// FLY-220: ignore inbound-echo / Bridge-alert-template lines so an echoed
	// alert in the live region can't make a healthy idle Lead look blocked.
	const region = ownStateRegion(pane);
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

/**
 * FLY-218 — markers of a TRANSIENT Anthropic 529 server-side throttle (HTTP 529
 * / `overloaded_error`). Claude Code renders `Server is temporarily limiting
 * requests (not your usage limit)` while it backs off and retries. These are
 * deliberately the exact production wording Annie reported plus the API error
 * type — tight enough that a GENUINE usage cap ("usage limit reached", a 5h bar
 * at 100%) never matches, so suppressing on them can never hide a real cap.
 */
const TRANSIENT_THROTTLE_MARKERS: RegExp[] = [
	/server is temporarily limiting requests/i,
	/not your usage limit/i,
	/overloaded_error/i,
];

/**
 * FLY-218 (Codex R2 HIGH) — foreground operations that are NEVER a 529 retry and
 * are themselves must-alert states per FLY-193 (a frozen auto-compact; a
 * compact/resume prompt awaiting input). Their presence in the live region means
 * a stale throttle line beside them must NOT be suppressed. Deliberately EXCLUDES
 * `esc to interrupt`: a live 529 retry renders exactly that hint, so a recent
 * throttle + an interruptible operation is overwhelmingly a live retry — and the
 * truly-hung-after-529 variant is structurally identical in a single capture
 * (the same accepted blind spot FLY-193 documents for frozen mid-work).
 */
const NON_RETRY_OPERATION_MARKERS: RegExp[] = [
	/compacting conversation/i,
	/\besc\b[^\n]*\bto cancel\b/i,
];

/**
 * FLY-218 (Codex R3) — evidence that an in-flight interruptible operation IS a
 * 529 retry (vs an unrelated foreground turn that merely has a stale throttle
 * line above it). A live 529 backoff always renders a retry status; a normal
 * frozen turn shows `esc to interrupt` with none.
 */
const RETRY_INDICATOR_MARKERS: RegExp[] = [
	/\bretry(?:ing)?\b/i,
	/\battempt\s+\d+\s*\/\s*\d+/i,
];

const INTERRUPT_HINT = /esc to interrupt/i;

/**
 * FLY-218 — recognize a transient Anthropic 529 throttle in the LIVE render
 * region. The Lead is ALIVE and the throttle self-resolves in seconds; it is
 * neither a usage cap nor a freeze. `LeadWatchdog.tickLead` consults this BEFORE
 * classification and short-circuits both the usage_limit and pane_hash_stuck
 * alert paths when it returns true.
 *
 * Scoped to `liveRegion` (NOT the whole 200-line scrollback) so a STALE 529 line
 * left in the transcript after the Lead recovered does NOT keep suppressing a
 * later genuine freeze — same poisoning trap FLY-193 fixed for idle detection.
 *
 * Codex R1 HIGH guard: a stale throttle line can still share the (small) live
 * region with a NEWER must-alert signal — the `liveRegion` 12-line fallback for
 * a menu overlay, or a cap printed right below a just-passed 529. Suppression
 * must never mask a higher-priority state, so it is withheld when the live
 * region ALSO shows either:
 *   (a) a genuine blocked condition — BLOCKED_KEYWORDS still match a real cap /
 *       rate / login / permission (the `usage_limit` token is tightened to
 *       exclude "not your usage limit"), so its presence vetoes suppression; or
 *   (b) a frozen resume/compact MENU overlay — those replace the TUI and carry
 *       NO status-bar / idle anchor, so requiring one means a throttle line
 *       lingering above such a menu is NOT suppressed and still alerts.
 * Defaults to `false` on any uncertainty (fail-open to alerting).
 */
export function isTransientThrottlePane(pane: string): boolean {
	if (!pane) return false;
	// FLY-220: own-state region (echo/template stripped) — consistent with
	// classify/isIdleHealthyPane so an echoed alert never affects suppression.
	const region = ownStateRegion(pane);
	const lower = region.toLowerCase();
	// Must carry a transient-throttle marker in the live region.
	if (!TRANSIENT_THROTTLE_MARKERS.some((t) => t.test(lower))) return false;
	// (a) A real blocked condition sharing the region wins — never suppress it.
	for (const { tokens } of BLOCKED_KEYWORDS) {
		if (tokens.some((t) => t.test(lower))) return false;
	}
	// (c) A non-retry foreground operation (frozen auto-compact, or a
	// compact/resume prompt using "esc to cancel") is a distinct FLY-193
	// must-alert — never a 529 retry — so a stale throttle line beside it must
	// not be suppressed.
	if (NON_RETRY_OPERATION_MARKERS.some((t) => t.test(region))) return false;
	// (d) An interruptible operation is in flight ("esc to interrupt"). Treat it
	// as a 529 retry ONLY when the CURRENT spinner line — the bottom-most line
	// carrying that hint — itself shows a retry indicator. Codex R4: scanning the
	// whole region is fooled because a stale 529 error line carries its own
	// "Retrying in Ns (attempt N/M)" text, which would wrongly vouch for a normal
	// frozen turn rendered below it. A SETTLED 529 error shows no "esc to
	// interrupt" at all and is still suppressed below.
	const regionLines = region.split("\n");
	let spinnerLine: string | undefined;
	for (let i = regionLines.length - 1; i >= 0; i--) {
		if (INTERRUPT_HINT.test(regionLines[i]!)) {
			spinnerLine = regionLines[i];
			break;
		}
	}
	if (
		spinnerLine !== undefined &&
		!RETRY_INDICATOR_MARKERS.some((t) => t.test(spinnerLine!))
	) {
		return false;
	}
	// (b) Require a live-TUI anchor (status bar / idle hint). A frozen menu
	// overlay has none → a stale throttle line above it stays un-suppressed.
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
		// FLY-579: never emitted by LeadWatchdog (AutoQaEffects builds its own
		// title); case exists for switch exhaustiveness.
		case "auto_qa_stuck":
			return "Auto-QA pipeline stuck";
		// FLY-793: never emitted by LeadWatchdog (the PhaseOrchestrator builds its
		// own title); case exists for switch exhaustiveness.
		case "three_stage_stuck":
			return "Three-stage pipeline stuck";
		// FLY-637-ext: never emitted by LeadWatchdog (the lead-pending escalation
		// builds its own title); case exists for switch exhaustiveness.
		case "runner_lead_pending_unhandled":
			return "Runner waiting — Lead unresponsive";
		// FLY-725: never emitted by LeadWatchdog (the milestone patrol builds its
		// own title); case exists for switch exhaustiveness.
		case "founder_milestone_undelivered":
			return "Milestone ping undelivered";
		// FLY-827: never emitted by LeadWatchdog (AutoQaEffects builds its own
		// title); case exists for switch exhaustiveness.
		case "codex_gate_blocked":
			return "Codex code review not passed";
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
		// FLY-579: never emitted by LeadWatchdog (AutoQaEffects builds its own body).
		case "auto_qa_stuck":
			return "The auto-QA pipeline could not proceed (spawn failed, no verdict, or a fail-closed pr_head_sha). The founder was NOT surfaced; investigate the QA Runner.";
		// FLY-793: never emitted by LeadWatchdog (the PhaseOrchestrator builds its own body).
		case "three_stage_stuck":
			return "A three-stage pipeline phase handoff (Design→Implement→QA) could not proceed (head-SHA capture failed, the previous phase runner would not close, or the next phase dispatch threw). The next phase was NOT started; investigate the phase Runner.";
		// FLY-637-ext: never emitted by LeadWatchdog (the lead-pending escalation builds its own body).
		case "runner_lead_pending_unhandled":
			return "A runner has been blocked waiting on the Lead to answer its question, and the Lead did not respond after several reminders. Poke the Lead — the runner itself is fine.";
		// FLY-725: never emitted by LeadWatchdog (the milestone / founder-thread patrol builds its own body).
		case "founder_milestone_undelivered":
			return "The Bridge could not deliver a founder milestone / ship-ready ping to its issue thread. The founder was NOT pinged; check the thread / bot token / owner config.";
		// FLY-827: never emitted by LeadWatchdog (AutoQaEffects builds its own body).
		case "codex_gate_blocked":
			return "A PR reached awaiting_review but Codex code review is not APPROVED for the current head. The hard gate blocked auto-QA + merge and held the founder; the runner was re-sent the /codex-code-review instruction.";
	}
}
