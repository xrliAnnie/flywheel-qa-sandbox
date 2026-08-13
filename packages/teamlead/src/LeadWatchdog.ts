/**
 * FLY-83: Bridge-side Lead liveness watchdog.
 *
 * Poll the Lead pane on the configured cadence and report only recognized
 * blocked conditions (rate/usage/login/permission). Static-pane inference was
 * removed in FLY-1570; the cadence remains the host for reconciliation riders.
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
import { deriveAccountLimitForAlert } from "./account-heal/derive-account-limit.js";
// FLY-1048 (Task A2): the live-region/echo-strip pure helpers moved to a shared
// module so the multi-frame window + runner detectors reuse the exact same
// parsing. Behavior is byte-identical (committed pane fixtures guard it);
// ALERT_ECHO_START is re-exported below for existing consumers.
import {
	ALERT_ECHO_START,
	hashPane,
	ownStateRegion,
} from "./bridge/pane-live-region.js";
import type {
	AlertEventType,
	AlertPayload,
	AlertResult,
} from "./LeadAlertNotifier.js";
import type { LeadWindowRef } from "./LeadWindowLocator.js";
import type { ProjectEntry } from "./ProjectConfig.js";

export { ALERT_ECHO_START };

export const DEFAULT_LEAD_WATCHDOG_INTERVAL_MS = 10 * 60_000;

/** FLY-1393: Annie-approved W-4 cadence, boot-captured and env-tunable. */
export function leadWatchdogIntervalMs(
	env: Record<string, string | undefined> = process.env,
): number {
	const value = Number(env.FLYWHEEL_LEAD_WATCHDOG_INTERVAL_MS);
	return Number.isFinite(value) && value > 0
		? Math.floor(value)
		: DEFAULT_LEAD_WATCHDOG_INTERVAL_MS;
}

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
	window: LeadWindowRef | string,
	lines: number,
) => Promise<string>;

export type NotifierFn = (payload: AlertPayload) => Promise<AlertResult>;

export interface LeadWatchdogConfig {
	pollIntervalMs: number;
	paneHashStuckCycles: number;
	projects: ProjectEntry[];
	/**
	 * FLY-247: dynamic per-tick membership (config snapshot + fleet evidence
	 * map resolved by the caller). When provided it supersedes the static
	 * `projects` list on every poll; state for leads that leave the
	 * membership is cleaned up (no stale cooldown/hash carryover).
	 */
	projectsProvider?: () => ProjectEntry[];
	notifier: NotifierFn;
	locateWindowFn: LocateWindowFn;
	captureFn: CaptureFn;
	claimsReader: () => Promise<Set<string>>;
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
	 * episode clears. The AlertChannelHub resolves the matching alert thread. Absent =
	 * unchanged behavior (FLY-231 not-normalized pattern).
	 */
	onRecovery?: (
		projectName: string,
		leadId: string,
		recoveredKind: AlertEventType,
	) => void;
	/**
	 * FLY-368: called once at the end of every full fleet cycle so a reconcile pass
	 * can piggyback this cadence WITHOUT adding a second timer (FLY-169 discipline).
	 * Wrapped fail-safe by the caller; errors must not wedge the poll loop.
	 */
	onPollComplete?: () => Promise<void> | void;
	/** FLY-1393 W-4: boot-captured gate for recognized blocked conditions. */
	watchdogBlockedEnabled?: boolean;
	watchdogTracker?: { started(): void; completed(): void };
}

interface LeadState {
	state: LeadWatchdogState;
	lastHash: string | null;
	stuckCycles: number;
	/** Signature of the pane that triggered the last alert, used as the
	 * mute key while the pane stays unchanged inside Cooldown. */
	cooldownSignature: string | null;
	/** FLY-220: the blocked-keyword kind of the CURRENT alerted episode (null when
	 * the Lead is not in an already-alerted block). Cleared when the live state no
	 * longer classifies as a blocked kind (recovery) so the next genuine block
	 * fires fresh. Makes a real block alert once-per-episode regardless of pane
	 * churn. */
	episodeKind: AlertEventType | null;
	/** FLY-368: the blocked kind of the LAST alert emitted for this lead, used to
	 * fire the onRecovery hook exactly once. Null once recovery has been signaled. */
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
	private timerHandle: ReturnType<typeof setTimeout> | null = null;
	private started = false;
	private staggerCursor = 0;
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
		if (this.started) return;
		this.started = true;
		this.scheduleNextStaggeredPoll();
	}

	stop(): void {
		this.started = false;
		if (this.timerHandle) {
			clearTimeout(this.timerHandle);
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

	private projectsSnapshot(): ProjectEntry[] {
		return this.config.projectsProvider
			? this.config.projectsProvider()
			: this.config.projects;
	}

	private scheduleNextStaggeredPoll(): void {
		if (!this.started) return;
		let count = 1;
		try {
			count = Math.max(
				1,
				this.projectsSnapshot().reduce(
					(total, project) => total + project.leads.length,
					0,
				),
			);
		} catch (error) {
			// A transient config snapshot failure must not break the recursive timer
			// chain. Fall back to one full cadence, then retry on the next tick.
			this.logger(
				`staggered schedule snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const delayMs = Math.max(1, Math.floor(this.config.pollIntervalMs / count));
		this.timerHandle = setTimeout(() => {
			this.timerHandle = null;
			void this.poll(true)
				.catch((error) => {
					this.logger(
						`staggered poll failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				})
				.finally(() => this.scheduleNextStaggeredPoll());
		}, delayMs);
	}

	private async poll(staggered = false): Promise<void> {
		if (this.polling) return;
		this.polling = true;
		this.config.watchdogTracker?.started();
		try {
			const projects = this.projectsSnapshot();
			const membership = new Set<string>();
			const targets: Array<{ projectName: string; leadId: string }> = [];
			for (const project of projects) {
				for (const lead of project.leads) {
					membership.add(stateKey(project.projectName, lead.agentId));
					targets.push({
						projectName: project.projectName,
						leadId: lead.agentId,
					});
				}
			}
			let scanTargets = targets;
			let cycleCompleted = true;
			if (staggered && targets.length > 0) {
				const index = this.staggerCursor % targets.length;
				scanTargets = [targets[index]!];
				this.staggerCursor = (index + 1) % targets.length;
				cycleCompleted = this.staggerCursor === 0;
			}
			for (const target of scanTargets) {
				await this.tickLead(target.projectName, target.leadId);
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
			// per-Lead cadence — no second timer. On a staggered fleet, post-poll work
			// runs once after the complete fleet cycle, never once per Lead slice.
			if (cycleCompleted && this.config.onPollComplete) {
				try {
					await this.config.onPollComplete();
				} catch (err) {
					this.logger(`onPollComplete threw: ${(err as Error).message}`);
				}
			}
		} finally {
			this.config.watchdogTracker?.completed();
			this.polling = false;
		}
	}

	private async tickLead(projectName: string, leadId: string): Promise<void> {
		// FLY-247 R3#4: state keyed by (projectName, leadId) — two projects
		// with a same-named lead must never share cooldown/hash state.
		const state = this.getOrInit(stateKey(projectName, leadId));

		// Find the Lead window.
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
			pane = await this.config.captureFn(windowRef, 200);
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
		// FLY-1393 W-4: gate recognized block alerts before recovery, cooldown,
		// episode, or fingerprint state can be opened or mutated.
		if (
			kind !== "pane_hash_stuck" &&
			this.config.watchdogBlockedEnabled === false
		) {
			return;
		}
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
		// billing" alert. Recognize it as a live, self-recovering state and
		// short-circuit classification.
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
		// after the configured confirmation threshold.
		if (
			kind !== "pane_hash_stuck" &&
			state.stuckCycles >= this.config.paneHashStuckCycles
		) {
			// FLY-220: mark this episode alerted so the same ongoing block stays
			// muted until the Lead no longer classifies as this kind.
			state.episodeKind = kind;
			await this.emitAlert(projectName, leadId, pane, state, kind, liveHash);
			return;
		}

		state.state = "Healthy";
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

		// FLY-696: for a REAL usage cap, attach account-switch metadata so the
		// AutoRepairBot / Infra Bot can rotate to the next account. FLY-1243: the
		// FLYWHEEL_ACCOUNT_SELF_HEAL gate is retired (固化 default-on).
		// isTransientThrottlePane already short-circuited above (§3.3 hard
		// boundary), so a usage_limit reaching here is a genuine 5h/weekly cap,
		// never a transient 529. A null result (ambiguous gauge / unprovisioned
		// pool) leaves the alert needs_human.
		if (kind === "usage_limit") {
			const accountLimit = deriveAccountLimitForAlert({
				pane,
				now: new Date(this.now()),
			});
			if (accountLimit) {
				payload.metadata = { ...payload.metadata, accountLimit };
			}
		}

		try {
			const result = await this.config.notifier(payload);
			if (result.skipped === "duplicate") {
				state.state = "Silent";
			} else {
				state.state = "Cooldown";
			}
			state.cooldownSignature = liveHash;
			// FLY-368: remember what we alerted so the recovery hook can fire once.
			state.lastAlertedKind = kind;
		} catch (err) {
			this.logger(
				`notifier threw for ${leadId}/${kind}: ${(err as Error).message}`,
			);
			state.state = "Cooldown";
			state.cooldownSignature = liveHash;
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
				cooldownSignature: null,
				episodeKind: null,
				lastAlertedKind: null,
			};
			this.leadStates.set(leadId, state);
		}
		return state;
	}
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
	// Legacy sentinel retained because AlertEventType has no "none" member.
	// LeadWatchdog never emits this retired kind.
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

/** Exact resume-menu markers retained by the safe Enter repair path. */
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
 * neither a usage cap nor a freeze. `LeadWatchdog.tickLead` consults this before
 * classification and short-circuits the usage_limit alert path when true.
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
	// classify() uses the same echo-stripped region.
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

export function titleFor(kind: AlertEventType): string {
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
			// Legacy display-only kind; no watchdog emits it after FLY-1570.
			return "Lead pane has been frozen";
		// FLY-1048 (A4): multi-frame veto 1 — a known error signature frozen in
		// an otherwise idle-looking live region.
		case "pane_error_stalled":
			return "Lead pane error-stalled";
		// FLY-1048 (PR-C): never emitted by LeadWatchdog (the detection reconcile
		// builds its own title); case exists for switch exhaustiveness.
		case "detection_fleet_aggregate":
			return "Fleet-scale detection incident";
		case "detection_page_undeliverable":
			return "Detection founder-page undeliverable";
		case "delivery_dead_letter":
			return "Lead delivery dead-lettered";
		case "inbox_loop_stalled":
			return "Lead inbox consume loop stalled";
		case "mailbox_dead_letter":
			return "Mailbox messages exhausted their acknowledgement lease";
		case "legacy_row_quarantined":
			return "Legacy inbox row quarantined during cutover";
		// FLY-1402: emitted only by the Claude launcher through lead-alert.sh.
		case "rules_bundle_legacy":
			return "Lead rules bundle legacy mode";
		case "workflow_route_input_rejected":
			return "Work-kind dispatch input rejected";
		case "stale_approved_ship_dead":
			return "Approved ship runner is dead";
		case "runner_pane_loss":
			return "Runner pane/body ownership lost";
		case "ship_attempt_failed":
			return "Founder-approved ship attempt failed";
		// FLY-195: never emitted by LeadWatchdog (the stuck-runner detector owns
		// it and builds its own title); case exists for switch exhaustiveness.
		case "runner_stuck_unhandled":
			return "Runner stuck unhandled";
		// FLY-579: never emitted by LeadWatchdog (AutoQaEffects builds its own
		// title); case exists for switch exhaustiveness.
		case "auto_qa_stuck":
			return "Auto-QA pipeline stuck";
		// FLY-793: never emitted by LeadWatchdog (the workflow engine builds its
		// own title); case exists for switch exhaustiveness.
		case "three_stage_stuck":
			return "DAG workflow stuck";
		case "three_stage_takeover_failed":
			return "DAG workflow worktree takeover failed";
		case "workflow_engine_escalation":
			return "Workflow engine recovery escalated";
		case "workflow_engine_issue_alert":
			return "Workflow dead-execution safety alert";
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
		// FLY-1278: emitted by the review coordinator, not LeadWatchdog.
		case "review_advisory_pass":
			return "Review passed with non-blocking advisories";
		case "review_ruling_recorded":
			return "Lead review ruling recorded";
		case "review_ruling_disputed":
			return "Reviewer disputed a Lead ruling";
		case "review_ruling_notify_failed":
			return "Review ruling audit post failed";
		// FLY-871 R2/C8: never emitted by LeadWatchdog (the runner auth scan owns
		// it and builds its own title); case exists for switch exhaustiveness.
		case "runner_login_expired":
			return "Runner logged out";
		// FLY-871 §12 W2: never emitted by LeadWatchdog (the windowed-TUI runtime
		// guard fires it directly via scripts/lead-alert.sh with its own title);
		// case exists for switch exhaustiveness.
		case "tui_window_lost":
			return "Infra Bot TUI window not visible";
		// FLY-913: never emitted by LeadWatchdog (the restart-guard hook fires it
		// directly via scripts/lead-alert.sh --strict-delivery with its own
		// title); case exists for switch exhaustiveness.
		case "restart_guard_bypass":
			return "Restart-guard BYPASS used";
		// FLY-1501: shell/Python gate supplies the concrete title; this keeps the
		// shared union switch readable if a queued record is rendered later.
		case "restart_storm_hold":
			return "Service restart storm held";
		// FLY-939 (G-D): never emitted by LeadWatchdog (boot-sha-check builds its
		// own title); case exists for switch exhaustiveness.
		case "bridge_boot_stale_checkout":
			return "Bridge running a STALE checkout";
		// FLY-927 (D4): never emitted by LeadWatchdog (the bridge wrapper fires it
		// via scripts/lead-alert.sh with its own title); case exists for switch
		// exhaustiveness.
		case "bridge_wrapper_fail":
			return "Bridge wrapper fail-loud";
		// Legacy persisted event kind; retained for rendering old queued rows.
		case "runner_throttle_stalled":
			return "Runner stalled after throttle";
		// FLY-954: never emitted by LeadWatchdog (converge-flywheel-bin.sh fires
		// it via lead-alert.sh with its own title); case exists for switch
		// exhaustiveness.
		case "bin_integrity_drift":
			return "bin runtime script drift";
		// FLY-1676: emitted by the launcher / deploy guard through
		// lead-alert.sh. This case keeps the shared alert-kind union exhaustive.
		case "discord_plugin_integrity_failed":
			return "Discord plugin fork integrity failed";
		// FLY-945: never emitted by LeadWatchdog (the external-merge reconcile
		// pass builds its own title); case exists for switch exhaustiveness.
		case "external_merge_suspect":
			return "Unverified external merge";
		// FLY-929: never emitted by LeadWatchdog (the notify-digest expect tick /
		// token-usage-daily.sh build their own titles); case exists for switch
		// exhaustiveness.
		case "notify_digest_failed":
			return "Daily token report not delivered";
		// FLY-1099: never emitted by LeadWatchdog (the founder-reply watchdog /
		// action-ledger drain build their own titles); cases exist for switch
		// exhaustiveness.
		case "founder_reply_pass_dead":
			return "Founder-reply ingest pass DEAD";
		case "founder_reply_pinned":
			return "Founder reply stuck (cursor pinned)";
		case "founder_reply_dead_letter":
			return "Founder reply dead-lettered";
		case "founder_notify_dead_letter":
			return "Founder notify dead-lettered";
		case "founder_reply_unreachable_runner":
			return "Runner unreachable for founder replies";
		case "commdb_finalize_stuck":
			return "CommDB finalization stuck";
		case "merged_gate_guard_unavailable":
			return "Merged gate guard unavailable";
		// FLY-1081: never emitted by LeadWatchdog (restart-services.sh /
		// update-flywheel.sh fire these via scripts/lead-alert.sh with their own
		// titles); cases exist for switch exhaustiveness.
		case "deploy_failed":
			return "Flywheel deploy failed";
		case "deploy_degraded":
			return "Flywheel deploy degraded";
		// FLY-1256: never emitted by LeadWatchdog; the external quota monitor
		// supplies its own title. Cases keep the shared union exhaustive.
		case "account_switched":
			return "Claude account switched";
		case "account_switch_degraded":
			return "Claude account switched with degraded verification";
		case "machine_account_conflict":
			return "Claude account identity conflict";
		case "model_config":
			return "Lead model policy fallback";
		case "model_cap_switched":
			return "Claude model-cap account switched";
		case "model_cap_unknown":
			return "Claude model cap temporarily ambiguous";
		case "model_cap_persistent_unknown":
			return "Claude model cap persistently ambiguous";
		case "model_bench_malformed":
			return "Claude model bench state malformed";
		case "quota_choice":
			return "Claude requires a manual model choice";
		case "quota_switch_confirmation":
			return "Claude quota switch recovery confirmation";
		case "quota_no_target":
			return "No Claude account has quota";
		case "quota_blocked_recovered":
			return "Claude quota block recovered";
		case "quota_read_blind":
			return "Claude quota monitor is blind";
		case "account_switch_failed":
			return "Claude account switch failed";
		case "account_identity_mismatch":
			return "Claude account identity mismatch";
		case "quota_revive_stuck":
			return "Claude pane revive stuck";
		case "quota_monitor_down":
			return "Claude quota monitor down";
		case "quota_guard_bypassed":
			return "Claude quota guard BYPASSED manually";
		// FLY-1082: fleet kinds — never emitted by LeadWatchdog (the fleet
		// sensors / server-loss coordinator / boot self-check build their own
		// titles); cases exist for switch exhaustiveness.
		case "swap_pressure_high":
			return "Swap pressure high (OOM early warning)";
		case "tmux_server_lost":
			return "tmux server lost (fleet-level)";
		case "tmux_hold":
			return "tmux safety hold";
		case "tmux_split_brain":
			return "tmux split brain";
		case "bridge_abnormal_exit":
			return "Bridge died without a clean shutdown";
		case "infra_bot_down":
			return "Infra bot down";
		case "zombie_session_backlog":
			return "Cross-Lead zombie session backlog";
		case "lead_dual_active":
			return "Multiple active Lead processes share one identity";
		case "lead_dual_active_sensor_degraded":
			return "Lead identity process sensor degraded";
		case "lead_lease_store_broken":
			return "Lead identity lease store unavailable";
		case "lead_lease_bypass_used":
			return "Lead identity lease bypass used";
		case "lead_lease_would_block":
			return "Lead identity lease would block a write";
		case "lead_lease_control_broken":
			return "Lead identity lease control plane broken";
		case "lead_identity_source_broken":
			return "Canonical Lead identity source broken";
		case "lead_backend_drift":
			return "Lead carrier/backend identity drift";
		case "cmux_cleanup":
			return "cmux cleanup needs operator review";
		case "cmux_flag_state":
			return "cmux A0B1 topology transition";
		case "tmux_rescue_hold":
			return "tmux rescue lock held too long";
	}
}

function severityFor(kind: AlertEventType): AlertPayload["severity"] {
	if (
		kind === "crash_loop" ||
		kind === "login_expired" ||
		kind === "runner_login_expired"
	)
		return "severe";
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
			return "Claude CLI login expired. Re-run `claude login` on the Lead host, then restart the Lead.";
		case "permission_blocked":
			return "Lead is waiting on a permission prompt that cannot be auto-confirmed. Approve / deny it in the Lead's tmux pane.";
		case "crash_loop":
			return "Lead has crashed repeatedly. Check its launchd and startup logs under ~/.flywheel/logs/ — likely Claude CLI / config issue.";
		case "pane_hash_stuck":
			// Legacy display-only kind; no watchdog emits it after FLY-1570.
			return "Lead pane has been frozen for several poll cycles with no recognizable blocked-prompt pattern. Open the tmux pane to investigate.";
		// FLY-1048 (A4): deliberately does NOT echo the matched error line
		// (FLY-220 echo immunity) — kind + suggested action only.
		case "pane_error_stalled":
			return "A known error is frozen in the Lead's live pane (error visible above an idle input box across multiple polls). The Lead likely errored and stopped; open the tmux pane and nudge or recover it.";
		// FLY-1048 (PR-C): never emitted by LeadWatchdog (the detection reconcile
		// builds its own body carrying kind + count + target summary).
		case "detection_fleet_aggregate":
			return "Several detection episodes of the same kind went unhandled at once — a fleet-scale incident. The founder was NOT paged per-episode; investigate the shared cause (Bridge, transport, or a fleet-wide runner condition).";
		case "detection_page_undeliverable":
			return "A detection founder page could not be addressed or posted (no session, no thread binding, or the POST failed). The episode stays LEAD_NOTIFIED and keeps retrying; fix the thread binding / bot token / routing.";
		case "delivery_dead_letter":
			return "A Lead-directed event exhausted bounded transport or acknowledgement retries. The founder was paged because the owning Lead path did not consume it.";
		case "inbox_loop_stalled":
			return "A Lead inbox consume loop stopped completing or has queue-native deadlines overdue. Inspect that Lead's loop heartbeat and pending comm.db rows.";
		case "mailbox_dead_letter":
			return "Mailbox messages exhausted their acknowledgement leases or could not be routed to an owning Lead. Inspect the dead-letter summaries and decide replay, discard, or reassignment.";
		case "legacy_row_quarantined":
			return "The boot cutover refused a deterministically-bad legacy lead_event row and skipped it so the rest of the fleet could recover. The row was NOT delivered. Inspect legacy_cutover_quarantine for the seq and reason, then decide replay or discard.";
		// FLY-1402: the launcher supplies generation-specific evidence in the
		// real shell alert body; this keeps the shared kind switch exhaustive.
		case "rules_bundle_legacy":
			return "A Claude Lead launched with the emergency legacy last-one-wins rule-loading path. Restore bundle mode and restart the Lead after investigating the compatibility override.";
		case "workflow_route_input_rejected":
			return "A fresh work-kind dispatch was rejected because an explicit category, tier, routing override, or template override was invalid. Correct the request and dispatch again; the dedup key in the notice identifies retries of the same input.";
		case "stale_approved_ship_dead":
			return "An approved_to_ship runner was proven dead through its exact tmux target. Resume the execution through the durable recovery path; this watchdog never self-ships.";
		case "runner_pane_loss":
			return "A runner's recorded tmux body is missing. Follow the issue-thread recovery proposal; Flywheel does not automatically redispatch this session.";
		case "ship_attempt_failed":
			return "A founder-approved ship attempt failed or could not be tracked to completion. The approval remains valid; inspect the workflow and explicitly wake the runner before retrying.";
		// FLY-195: never emitted by LeadWatchdog (see titleFor).
		case "runner_stuck_unhandled":
			return "A stuck Runner episode received no Lead disposition within the grace window. Check the owning Lead, then the runner tmux window.";
		// FLY-579: never emitted by LeadWatchdog (AutoQaEffects builds its own body).
		case "auto_qa_stuck":
			return "The auto-QA pipeline could not proceed (spawn failed, no verdict, or a fail-closed pr_head_sha). The founder was NOT surfaced; investigate the QA Runner.";
		// FLY-793: never emitted by LeadWatchdog (the workflow engine builds its own body).
		case "three_stage_stuck":
			return "A DAG workflow handoff (Design→Implement→QA) could not proceed (head-SHA capture failed, the previous phase runner would not close, or the next phase dispatch threw). The next phase was NOT started; investigate the phase Runner.";
		case "three_stage_takeover_failed":
			return "A shared branch-B worktree was dirty or at an unexpected HEAD, so Flywheel refused the in-place phase takeover. Inspect and preserve the parked phase's work before retrying.";
		case "workflow_engine_escalation":
			return "A workflow execution died without a completion receipt. The engine either held the run after a non-retryable/exhausted failure or used the approved design Fable→GPT-5.6 fallback. Inspect the run audit and use the quiescence-gated hold/terminate endpoints.";
		case "workflow_engine_issue_alert":
			return "A replaced execution showed later activity, or the same workflow node was repeatedly classified dead. Inspect the issue thread and both execution identities immediately; the Lead escalation copy was emitted separately.";
		// FLY-637-ext: never emitted by LeadWatchdog (the lead-pending escalation builds its own body).
		case "runner_lead_pending_unhandled":
			return "A runner has been blocked waiting on the Lead to answer its question, and the Lead did not respond after several reminders. Poke the Lead — the runner itself is fine.";
		// FLY-725: never emitted by LeadWatchdog (the milestone / founder-thread patrol builds its own body).
		case "founder_milestone_undelivered":
			return "The Bridge could not deliver a founder milestone / ship-ready ping to its issue thread. The founder was NOT pinged; check the thread / bot token / owner config.";
		// FLY-827: never emitted by LeadWatchdog (AutoQaEffects builds its own body).
		case "codex_gate_blocked":
			return "A PR reached awaiting_review but Codex code review is not APPROVED for the current head. The hard gate blocked auto-QA + merge and held the founder; the runner was re-sent the /codex-code-review instruction.";
		// FLY-1278: never emitted by LeadWatchdog (the review coordinator builds
		// request/ruling-specific bodies and deterministic event ids).
		case "review_advisory_pass":
			return "Cross-family review approved the head with non-blocking MEDIUM/LOW advisories. The hard review gate is satisfied; triage advisories into follow-up work as appropriate.";
		case "review_ruling_recorded":
			return "A Lead recorded a supervised governance ruling for an already-delivered review finding. The durable ruling and issue-thread audit are the authority; gate prose is not.";
		case "review_ruling_disputed":
			return "A reviewer supplied new HIGH-severity evidence against a governance-settled finding. The ruling still prevents a mechanical review loop; the Lead must reassess or revoke it.";
		case "review_ruling_notify_failed":
			return "A durable Lead review ruling is active, but its issue-thread audit post failed. Bridge boot redrive will retry; investigate Discord thread/token routing.";
		// FLY-871 R2/C8: never emitted by LeadWatchdog (the runner auth scan builds its own body).
		case "runner_login_expired":
			return "A Runner appears logged out (auth/login expired). Rescue restarts it in place so it re-reads the fresh Keychain; if that fails once, the founder is paged.";
		// FLY-871 §12 W2: never emitted by LeadWatchdog (the windowed-TUI runtime guard builds its own body).
		case "tui_window_lost":
			return "A windowed Codex Lead's founder-facing cmux pane could not be (re)created for several minutes. Check the launchd job + tmux window (verify-windowed-lead.sh).";
		// FLY-913: never emitted by LeadWatchdog (the restart-guard PreToolUse hook builds its own body via lead-alert.sh).
		case "restart_guard_bypass":
			return "An agent used the restart-guard bypass to run a manual Flywheel service restart. The command + reason are in ~/.flywheel/logs/restart-guard.log — review whether it was justified.";
		case "restart_storm_hold":
			return "An OS-supervised Flywheel service reached its durable restart ceiling, so the wrapper stopped launching it. Inspect the service logs and cause, then explicitly resume that child with restart-storm-gate.py.";
		// FLY-939 (G-D): never emitted by LeadWatchdog (boot-sha-check builds its own body).
		case "bridge_boot_stale_checkout":
			return "The Bridge booted on a checkout whose HEAD is behind origin/main — merged work is NOT live. Pull + restart the Bridge to deploy.";
		// FLY-927 (D4): never emitted by LeadWatchdog (the bridge wrapper builds its own body via lead-alert.sh).
		case "bridge_wrapper_fail":
			return "The Bridge launchd wrapper hit a fail-loud condition (port stuck / preflight failure) while the Bridge is down. Check ~/.flywheel/logs and the wrapper output.";
		// Legacy persisted event kind; retained for rendering old queued rows.
		case "runner_throttle_stalled":
			return "A legacy runner throttle-stall alert was queued before automated stuck detection was removed. Review it manually.";
		// FLY-954: never emitted by LeadWatchdog (converge-flywheel-bin.sh builds its own body via lead-alert.sh).
		case "bin_integrity_drift":
			return "A ~/.flywheel/bin runtime script drifted from its repo source. This kind is emitted by scripts/converge-flywheel-bin.sh via lead-alert.sh (shell path) — the Watchdog never raises it; see the shell alert body for file + sha details (FLY-954).";
		// FLY-1676: shell callers include concrete SHA/root evidence in the live
		// alert body; this fallback keeps queued rendering actionable.
		case "discord_plugin_integrity_failed":
			return "A Lead could not prove the configured Discord plugin came from the Flywheel fork at the expected remote SHA. Keep that Lead stopped, repair the pointer install, then rerun the integrity check before restarting it.";
		// FLY-945: never emitted by LeadWatchdog (the external-merge reconcile pass builds its own body).
		case "external_merge_suspect":
			return "The external-merge reconcile pass found a merged PR it cannot verify (missing founder-attributed approval, or the merged head differs from the approved head). The session was NOT finalized/archived — review the merge.";
		// FLY-929: never emitted by LeadWatchdog (the notify-digest expect tick /
		// token-usage-daily.sh build their own bodies via lead-alert.sh).
		case "notify_digest_failed":
			return "The daily token report was not delivered (no receipt / pipeline step failed). Check launchd com.flywheel.token-usage-daily, Bridge /api/reports delivery, and /tmp/flywheel-token-usage-daily.err.";
		// FLY-1099: never emitted by LeadWatchdog (the founder-reply watchdog /
		// action-ledger drain build their own bodies).
		case "founder_reply_pass_dead":
			return "The founder-reply deliver pass has not completed successfully past the stall threshold — founder replies (incl. ship approvals) are NOT being ingested. Check the Bridge log.";
		case "founder_reply_pinned":
			return "A founder message has been pinning its thread's ingest cursor past the threshold — every later founder reply in that thread is blocked behind it.";
		case "founder_reply_dead_letter":
			return "A founder message exhausted its bounded retries and was dead-lettered. It will NOT be auto-processed — a human must act on it (durable audit: founder_reply_dead_letter).";
		case "founder_notify_dead_letter":
			return "A founder-facing ledger action (held notice / rebound notice / codex nudge / feedback wake) failed terminally after bounded retries — the target never received it.";
		case "founder_reply_unreachable_runner":
			return "A LIVE session's CommDB registration row is gone (FLY-1049 shape) — founder replies to its gate cannot be wake-delivered and will dead-letter. Re-register or close the session.";
		case "commdb_finalize_stuck":
			return "A physically gone runner still has unresolved gates or a CommDB session because atomic finalization keeps failing. Issue closeout remains fail-closed; inspect comm.db and retry cleanup.";
		case "merged_gate_guard_unavailable":
			return "The Bridge could not establish the bound PR's merge state after bounded checks, so it suppressed founder-facing recovery copy. Verify GitHub and retire or re-drive the gate manually.";
		// FLY-1081: never emitted by LeadWatchdog (restart-services.sh /
		// update-flywheel.sh build their own bodies via lead-alert.sh).
		case "deploy_failed":
			return "A Flywheel deploy failed (restart / rollback / self-update). Shell-only kind via lead-alert.sh — see the shell alert body for specifics; check /tmp/flywheel-bridge.log and ~/.flywheel/deployed-sha.";
		case "deploy_degraded":
			return "A Flywheel deploy completed degraded (skipped/failed leads, plugin update problem, or idle-wait timeout). Shell-only kind via lead-alert.sh — see the shell alert body for specifics.";
		// FLY-1256: never emitted by LeadWatchdog. The external daemon supplies
		// account/quota/reset evidence in the real alert body.
		case "account_switched":
			return "The external quota monitor switched Claude accounts after verifying the target account had fresh quota.";
		case "account_switch_degraded":
			return "The external quota monitor switched Claude accounts using the controlled degraded-verification fallback; inspect the supplied panorama evidence.";
		case "machine_account_conflict":
			return "The external quota monitor found conflicting active-account witnesses and refused all quota actions.";
		case "model_config":
			return "The Lead launcher rejected or could not resolve its configured model and used the built-in Fable fallback. Inspect projects.json, models.json, and the launcher log before the next restart.";
		case "model_cap_switched":
			return "The external quota monitor switched accounts for a verified model-specific cap and recorded the affected panes.";
		case "model_cap_unknown":
			return "A managed Claude pane may show a model cap, but its live state is still ambiguous; no keys were sent.";
		case "model_cap_persistent_unknown":
			return "A managed Claude pane remained ambiguous across repeated model-cap scans; no keys were sent and a human should inspect it.";
		case "model_bench_malformed":
			return "The external quota monitor found malformed per-model bench state and excluded that account fail-closed.";
		case "quota_choice":
			return "Claude is asking for a paid-model choice. The monitor will not choose or send keys; a human must decide.";
		case "quota_switch_confirmation":
			return "The external quota monitor rechecked every recorded affected pane after the switch and reported the five-state recovery result.";
		case "quota_no_target":
			return "The external quota monitor found no fresh, usable target account under the configured thresholds.";
		case "quota_blocked_recovered":
			return "A persistent Claude quota-blocked episode recovered after usage normalized or an account switch succeeded.";
		case "quota_read_blind":
			return "The external quota monitor could not obtain trustworthy quota data; automatic switching is fail-closed.";
		case "account_switch_failed":
			return "The external quota monitor selected a verified target but the credential switch failed.";
		case "account_identity_mismatch":
			return "A live Claude credential resolved to a different account than its trusted pool label; automatic mutation is fail-closed until the mapping is repaired.";
		case "quota_revive_stuck":
			return "A Claude pane remained quota-stuck after the external monitor exhausted its audited revive budget.";
		case "quota_monitor_down":
			return "The launchd quota monitor stopped producing healthy polling evidence; inspect its run marker and logs.";
		case "quota_guard_bypassed":
			return "A human manually bypassed live 5h/7d quota verification before a Claude account switch. Review the target account and the shell alert audit details.";
		// FLY-1082: fleet kinds — never emitted by LeadWatchdog (their sensors
		// build their own bodies); cases exist for switch exhaustiveness.
		case "swap_pressure_high":
			return "Machine swap usage crossed the high watermark — OOM early warning. The auto-repair bot places a reversible dispatch pressure-hold and notifies Leads to shed load; the ticket resolves when swap falls below the low watermark.";
		case "tmux_server_lost":
			return "The tmux server hosting the runners is gone while sessions were still running. The server-loss coordinator migrates affected runners to their terminal state and notifies each Lead with its casualty list + resume pointers.";
		case "tmux_hold":
			return "The Bridge cannot positively prove a safe tmux recovery action. Affected runners remain held until target reconciliation succeeds; follow the FLY-1285 recovery runbook if this persists.";
		case "tmux_split_brain":
			return "Multiple tmux server generations appear to reference the canonical socket. The system will not choose or signal one automatically; a human must establish the authoritative generation.";
		case "bridge_abnormal_exit":
			return "The Bridge process exited without a clean shutdown (fatal exit / kill). launchd respawns it; the revived Bridge opens this ticket, runs boot reconcile, and resolves quietly when the self-check passes.";
		case "infra_bot_down":
			return "An infra bot (claude/codex windowed Lead) is down. The OTHER side's bot owns this ticket (nobody rescues their own side); the auto-repair action is launchctl kickstart -k of the dead job.";
		case "zombie_session_backlog":
			return "Cross-Lead zombie sessions (CommDB↔StateStore drift) reached the backlog threshold. No auto-reaping by design (FLY-1066 owns the reaper) — the ticket escalates directly with the sample list.";
		case "lead_dual_active":
			return "Two live Lead processes claim the same canonical identity. The newer process is not authorized to issue runner instructions or answer gates; establish the authoritative generation before recovery.";
		case "lead_dual_active_sensor_degraded":
			return "The Bridge could not obtain trustworthy process evidence for Lead identity uniqueness across repeated scans. Lease enforcement remains fail-closed; restore the process sensor before declaring the incident recovered.";
		case "lead_lease_store_broken":
			return "The durable Lead identity lease store is unavailable or corrupt. Mutating Lead actions are fail-closed until the store is repaired and the carrier generation is revalidated.";
		case "lead_lease_bypass_used":
			return "An explicit emergency bypass performed a Lead mutation without a normal lease grant. Review the audit provenance and restore ordinary lease enforcement immediately.";
		case "lead_lease_would_block":
			return "Observe-mode lease enforcement detected a Lead mutation that would have been rejected. Reconcile the active holder and backend before enabling enforcement.";
		case "lead_lease_control_broken":
			return "Lead lease policy or control state could not be validated. Mutating actions are fail-closed until the control plane is restored.";
		case "lead_identity_source_broken":
			return "The canonical Lead identity could not be resolved unambiguously from configured evidence. Repair the identity mapping before allowing Lead mutations.";
		case "lead_backend_drift":
			return "The configured Lead backend and the live carrier evidence disagree. The conflicting process is not authoritative; reconcile the carrier generation before restoring write authority.";
		case "cmux_cleanup":
			return "cmux-sync refused an unsafe cleanup or found authority state requiring manual review. Inspect the supplied generation, ref, and lease evidence; no foreign workspace was closed.";
		case "cmux_flag_state":
			return "cmux-sync entered A0B1. Exact-ref receipts remain mandatory; use the event evidence to distinguish strict-independent from grouped-rollback topology. The durable transition notice is informational; convergence remains enabled.";
		case "tmux_rescue_hold":
			return "A tmux rescue operation held its per-socket kernel lock beyond the warning threshold. Inspect the supplied socket, verb, caller, and acquisition audit evidence.";
	}
}
