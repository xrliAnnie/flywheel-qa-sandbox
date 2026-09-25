/**
 * FLY-2882 §4.1 — pure, fail-closed reader of a Claude Code Lead pane.
 *
 * Claude Code 2.1.282 renders the turn state in ONE "status slot" just above
 * the input box: a spinner `✶ Verb… (1m 4s · ↓ 547 tokens)` while a turn runs
 * (timer is turn-wide), and `✻ Verb for 1m 17s · done 12:17 PM` once it ends.
 * The only lines allowed between that slot and the box are PROVEN skippable:
 * blank lines, indented lines (body text, `⎿ Tip`, todo lists) and column-0
 * `⏺ ` conversation entries (replies/tool calls/notices; an active spinner
 * always renders BELOW every entry). Any other column-0 line occupies the slot,
 * so an older done line can never authorize idle past something unrecognized.
 *
 * The persistent status bar below the box (`bypass permissions`, `ctx N%`,
 * subagent timers) is never consulted. Nothing returned contains pane text.
 */

export type ClaudePaneActivity =
	| { state: "busy"; elapsedMs: number; precision: "second" | "minute" }
	| { state: "idle" }
	| {
			state: "unknown";
			reason:
				| "pane_unrecognized"
				| "no_turn_status_line"
				| "unrecognized_status_line"
				| "status_line_blocked";
	  };

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI escape sequences from tmux pane
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const DURATION =
	"(?<d>\\d+d\\s*)?(?<h>\\d+h\\s*)?(?<m>\\d+m\\s*)?(?<s>\\d+(?:\\.\\d+)?s)?";
const IN_PROGRESS = new RegExp(
	`^[✻✶✳✢✽·*] \\S[^(]*…\\s*\\((?<dur>${DURATION})\\s*(?:·|\\))`,
	"u",
);
const DONE = /^[✻✶✳✢✽·*] \S+ for (?:\d+[dhms]\s*)+·\s*done\b/u;
// Same FLY-193 frozen-foreground markers as pane-blocked-classifier.ts.
const BLOCKED = [/compacting conversation/i, /\besc\b[^\n]*\bto cancel\b/i];

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function skippable(line: string): boolean {
	return line.length === 0 || /^\s/.test(line) || line.startsWith("⏺ ");
}

function durationMs(groups: Record<string, string | undefined>): number {
	const n = (value: string | undefined) =>
		value === undefined ? 0 : Number.parseFloat(value);
	return Math.round(
		n(groups.d) * 86_400_000 +
			n(groups.h) * 3_600_000 +
			n(groups.m) * 60_000 +
			n(groups.s) * 1_000,
	);
}

export function parseClaudeLeadPaneActivity(
	pane: string,
	leadId: string,
): ClaudePaneActivity {
	const lines = pane
		.replace(ANSI, "")
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.replace(/\s+$/u, ""));
	const border = new RegExp(`^─{6,}.*@${escapeRegExp(leadId)}\\s+─`, "u");
	let box = -1;
	for (let i = lines.length - 1; i >= 0; i--) {
		if (border.test(lines[i]!)) {
			box = i;
			break;
		}
	}
	if (box < 0 || !lines[box + 1]?.startsWith("❯"))
		return { state: "unknown", reason: "pane_unrecognized" };

	for (let i = box - 1; i >= 0; i--) {
		const line = lines[i]!;
		if (BLOCKED.some((marker) => marker.test(line)))
			return { state: "unknown", reason: "status_line_blocked" };
		if (skippable(line)) continue;
		const busy = IN_PROGRESS.exec(line);
		const groups = busy?.groups;
		if (groups && groups.dur!.trim().length > 0) {
			return {
				state: "busy",
				elapsedMs: durationMs(groups),
				precision: groups.s === undefined ? "minute" : "second",
			};
		}
		if (DONE.test(line)) return { state: "idle" };
		return { state: "unknown", reason: "unrecognized_status_line" };
	}
	return { state: "unknown", reason: "no_turn_status_line" };
}
