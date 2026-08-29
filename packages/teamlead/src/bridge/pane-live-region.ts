/**
 * FLY-1048 (Task A2): shared pane live-region pure helpers.
 *
 * Extracted VERBATIM from LeadWatchdog (FLY-193/FLY-220 logic — behavior must
 * stay byte-identical; the committed lead-pane fixtures are the guard) so the
 * multi-frame observation window (`pane-frames.ts`) and the runner-side
 * detectors can reuse the exact same region/echo semantics instead of
 * duplicating security-sensitive parsing. LeadWatchdog imports from here and
 * re-exports `ALERT_ECHO_START` for its existing consumers.
 */

import { createHash } from "node:crypto";
import { ALERT_EVENT_TYPES } from "../LeadAlertNotifier.js";

/** Normalize + sha1 a pane region (ANSI stripped, clock lines dropped). */
export function hashPane(content: string): string {
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
export function liveRegion(pane: string): string {
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

/**
 * FLY-927 (Task 1.2): the kind alternation is DERIVED from the shared
 * `ALERT_EVENT_TYPES` table (LeadAlertNotifier) — the old hand-enumerated list
 * covered only 7 kinds, so a first-line echo of any newer kind
 * (runner_login_expired / three_stage_stuck / codex_gate_blocked / …) leaked
 * past the strip and could re-trigger the FLY-220 storm family. Single source
 * ⇒ a future kind can never silently miss echo immunity. The `|^\s*🎫\s`
 * branch strips the FLY-927 ticket-header line (Bridge-unique — a real Claude
 * TUI never renders it about itself).
 */
export const ALERT_ECHO_START = new RegExp(
	`\\(\\s*[a-z0-9-]+\\s*\\/\\s*(?:${ALERT_EVENT_TYPES.join("|")})\\s*\\)` +
		"|^\\s*🎫\\s" +
		"|\\blead hit (?:rate|usage) limit\\b|\\blead login expired\\b|\\blead waiting on permission prompt\\b|\\blead pane has been frozen\\b|\\blead crash-looping\\b|\\brunner stuck unhandled\\b",
	"i",
);

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
export function ownStateRegion(pane: string): string {
	const withoutEchoes = pane
		.split("\n")
		.filter(
			(line) => !INBOUND_ECHO_LINE.test(line) && !ALERT_ECHO_START.test(line),
		)
		.join("\n");
	return liveRegion(withoutEchoes);
}
