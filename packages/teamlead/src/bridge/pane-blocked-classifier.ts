/** Pure pane classification for blocked Lead and transient-throttle states. */

import type { AlertEventType } from "../LeadAlertNotifier.js";
import { ownStateRegion } from "./pane-live-region.js";

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

function classify(pane: string): AlertEventType {
	// FLY-220: scan the Lead's OWN live state, not the full pane — an alert
	// echoed back into the pane (shared core channel) must never re-classify as
	// that same blocked state. FLY-193 live-region scoping + echo/template strip.
	const lower = ownStateRegion(pane).toLowerCase();
	for (const { kind, tokens } of BLOCKED_KEYWORDS) {
		if (tokens.some((t) => t.test(lower))) return kind;
	}
	// Legacy sentinel retained because AlertEventType has no "none" member.
	// Nothing emits this retired kind.
	return "pane_hash_stuck";
}

/**
 * FLY-368: PUBLIC wrapper of the pane classifier so the AlertChannelHub
 * reconcile pass can decide whether a previously-alerted kind is still present —
 * WITHOUT duplicating the (security-sensitive) private `classify`/`ownStateRegion`
 * parsing (Codex R2 LOW-3). Same result as the internal classifier.
 */
export function classifyLeadAlertPane(pane: string): AlertEventType {
	return classify(pane);
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
 * neither a usage cap nor a freeze. The Lead-pane alert path consults this before
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
