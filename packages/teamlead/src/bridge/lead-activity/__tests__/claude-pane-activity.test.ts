import { describe, expect, it } from "vitest";
import { parseClaudeLeadPaneActivity } from "../claude-pane-activity.js";

const LEAD = "flywheel-eng-lead";
const STATUS_BAR = [
	"  Opus 5.5/xhigh | ⚡flywheel-eng-lead | ~/.flywheel/lead-workspace | ctx 41%",
	"  ⏵⏵ bypass permissions on (shift+tab to cycle)",
];

/** Synthetic pane: filler text only — never real message bodies. */
function pane(
	above: string[],
	opts: { lead?: string; below?: string[]; prompt?: string } = {},
): string {
	return [
		"⏺ lorem ipsum filler reply",
		"  dolor sit amet",
		"",
		...above,
		`${"─".repeat(48)} @${opts.lead ?? LEAD} ──`,
		opts.prompt ?? "❯ ",
		"─".repeat(64),
		...(opts.below ?? STATUS_BAR),
	].join("\n");
}

describe("parseClaudeLeadPaneActivity — busy", () => {
	it.each([
		["✶ Spelunking… (8s · ↓ 298 tokens)", 8_000, "second"],
		["· Spelunking… (1m 4s · ↓ 547 tokens)", 64_000, "second"],
		["✻ Churning… (2h 3m 4s · ↓ 1.2k tokens)", 7_384_000, "second"],
		// ≥1 day: Claude's en() floors minutes and drops seconds, so the true
		// value is in [shown, shown + 60s) — the midpoint (+30s) bounds the error.
		["✽ Bunning… (1d 2h 3m · ↓ 1.5k tokens)", 93_810_000, "minute"],
		["✽ Bunning… (1d 0h 0m · ↓ 1.5k tokens)", 86_430_000, "minute"],
		["✽ Bunning… (1d 23h 59m)", 172_770_000, "minute"],
		["✢ Thinking… (40s)", 40_000, "second"],
		["✳ Pondering… (8.5s · ↓ 3 tokens)", 8_500, "second"],
		["* Working… (5m · ↓ 3 tokens)", 300_000, "minute"],
		["✻ Thinking… (12s · esc to interrupt)", 12_000, "second"],
	])("reads %s", (line, elapsedMs, precision) => {
		expect(parseClaudeLeadPaneActivity(pane([line, ""]), LEAD)).toEqual({
			state: "busy",
			elapsedMs,
			precision,
		});
	});

	it("skips indented tips and todo lists between the spinner and the box", () => {
		const text = pane([
			"✶ Spelunking… (36s · ↓ 423 tokens)",
			"  ⎿  Tip: filler tip text",
			"     ☐ filler todo one",
			"     ☐ filler todo two",
			"",
		]);
		expect(parseClaudeLeadPaneActivity(text, LEAD)).toEqual({
			state: "busy",
			elapsedMs: 36_000,
			precision: "second",
		});
	});

	it("stays busy when a queued `›` line renders ABOVE the spinner", () => {
		const text = pane([
			"✻ Worked for 3s · done 11:02 AM",
			"› filler queued message",
			"✽ Bunning… (39s · ↓ 1.5k tokens)",
			"",
		]);
		expect(parseClaudeLeadPaneActivity(text, LEAD)).toMatchObject({
			state: "busy",
			elapsedMs: 39_000,
		});
	});

	it("uses the bottom-most input box when stale scrollback holds an older box", () => {
		const text = [
			"✻ Worked for 1m 17s · done 12:17 PM",
			`${"─".repeat(48)} @${LEAD} ──`,
			"❯ ",
			"─".repeat(64),
			"⏺ filler",
			"✶ Spelunking… (8s · ↓ 298 tokens)",
			"",
			`${"─".repeat(48)} @${LEAD} ──`,
			"❯ ",
			"─".repeat(64),
			...STATUS_BAR,
		].join("\n");
		expect(parseClaudeLeadPaneActivity(text, LEAD)).toMatchObject({
			state: "busy",
			elapsedMs: 8_000,
		});
	});

	it("strips ANSI escapes before matching", () => {
		const text = pane([
			"\x1b[38;5;174m✶\x1b[39m \x1b[1mSpelunking…\x1b[22m (8s · ↓ 298 tokens)",
			"",
		]);
		expect(parseClaudeLeadPaneActivity(text, LEAD)).toMatchObject({
			state: "busy",
			elapsedMs: 8_000,
		});
	});
});

describe("parseClaudeLeadPaneActivity — idle", () => {
	it.each([
		"✻ Worked for 1m 17s · done 12:17 PM",
		"✻ Cogitated for 6s · done Thursday 12:42 AM",
		"· Baked for 2h 3m 4s · done 9:01 AM",
	])("reads %s", (line) => {
		expect(parseClaudeLeadPaneActivity(pane([line, ""]), LEAD)).toEqual({
			state: "idle",
		});
	});

	it("skips column-0 ⏺ notices printed after the done line", () => {
		const text = pane([
			"✻ Worked for 1m 17s · done 12:17 PM",
			"",
			"⏺ everything-claude-code: hooks.json filler warning",
			"  filler continuation",
			"⏺ Remote filler notice",
			"",
		]);
		expect(parseClaudeLeadPaneActivity(text, LEAD)).toEqual({ state: "idle" });
	});

	it("ignores a subagent timer rendered BELOW the input box", () => {
		const text = pane(["✻ Worked for 3s · done 11:02 AM", ""], {
			below: [
				...STATUS_BAR,
				"  ◯ Explore filler task 3m 41s · ↓ 135.7k tokens",
				"✶ Spelunking… (8s · ↓ 298 tokens)",
			],
		});
		expect(parseClaudeLeadPaneActivity(text, LEAD)).toEqual({ state: "idle" });
	});

	it("does not let an indented body line starting with `· ` occupy the slot", () => {
		const text = pane([
			"✻ Worked for 3s · done 11:02 AM",
			"  · filler bullet (5s · ↓ 3 tokens)",
			"",
		]);
		expect(parseClaudeLeadPaneActivity(text, LEAD)).toEqual({ state: "idle" });
	});
});

describe("parseClaudeLeadPaneActivity — fail-closed", () => {
	it.each([
		["an unknown glyph", "◆ Thinking… (8s · ↓ 3 tokens)"],
		["a queued `›` line", "› filler queued message"],
		["a just-submitted `❯` line", "❯ filler prompt"],
		["an empty duration", "✻ Thinking… ( · ↓ 3 tokens)"],
		["a pre-2.1 done line without `· done`", "✻ Crunched for 2s"],
	])("never lets an older done line authorize idle past %s", (_label, line) => {
		const text = pane(["✻ Worked for 1m 17s · done 12:17 PM", "", line, ""]);
		expect(parseClaudeLeadPaneActivity(text, LEAD)).toEqual({
			state: "unknown",
			reason: "unrecognized_status_line",
		});
	});

	it("answers no_turn_status_line when only the persistent status bar exists", () => {
		const text = [
			"",
			`${"─".repeat(48)} @${LEAD} ──`,
			"❯ ",
			"─".repeat(64),
			...STATUS_BAR,
		].join("\n");
		expect(parseClaudeLeadPaneActivity(text, LEAD)).toEqual({
			state: "unknown",
			reason: "no_turn_status_line",
		});
	});

	it("answers no_turn_status_line when only skippable lines sit above the box", () => {
		const text = pane(["⏺ filler notice", "  filler", ""]);
		expect(parseClaudeLeadPaneActivity(text, LEAD)).toEqual({
			state: "unknown",
			reason: "no_turn_status_line",
		});
	});

	it.each([
		[
			"a compacting spinner as the slot",
			["✳ Compacting conversation… (6m 5s · ↑ 16.4k tokens)", "  ▰▰▰ 71%", ""],
		],
		[
			"a compacting notice between an old done line and the box",
			[
				"✻ Worked for 3s · done 11:02 AM",
				"  ⎿  Compacting conversation filler",
				"",
			],
		],
		[
			"an esc-to-cancel prompt between the slot and the box",
			["✻ Worked for 3s · done 11:02 AM", "   Esc to cancel", ""],
		],
	])("answers status_line_blocked for %s", (_label, above) => {
		expect(parseClaudeLeadPaneActivity(pane(above), LEAD)).toEqual({
			state: "unknown",
			reason: "status_line_blocked",
		});
	});

	it.each([
		["another Lead's box", "product-lead", LEAD],
		["a longer name sharing the prefix", `${LEAD}-2`, LEAD],
		["a regex-metachar neighbour", "flywheelXeng-lead", "flywheel.eng-lead"],
	])("answers pane_unrecognized for %s", (_label, paneLead, askedLead) => {
		const text = pane(["✶ Spelunking… (8s · ↓ 298 tokens)", ""], {
			lead: paneLead,
		});
		expect(parseClaudeLeadPaneActivity(text, askedLead)).toEqual({
			state: "unknown",
			reason: "pane_unrecognized",
		});
	});

	it("answers pane_unrecognized for a menu with no input box", () => {
		const text = [
			"Resume Session",
			"❯ 1. filler session",
			"  2. filler session",
		].join("\n");
		expect(parseClaudeLeadPaneActivity(text, LEAD)).toEqual({
			state: "unknown",
			reason: "pane_unrecognized",
		});
	});

	it("answers pane_unrecognized when the box border is not followed by a prompt", () => {
		const text = pane(["✶ Spelunking… (8s · ↓ 298 tokens)", ""], {
			prompt: "  Do you want to proceed?",
		});
		expect(parseClaudeLeadPaneActivity(text, LEAD)).toEqual({
			state: "unknown",
			reason: "pane_unrecognized",
		});
	});

	it("answers pane_unrecognized for an empty capture", () => {
		expect(parseClaudeLeadPaneActivity("", LEAD)).toEqual({
			state: "unknown",
			reason: "pane_unrecognized",
		});
	});

	it("never returns pane text", () => {
		const sentinel = "SENTINEL-BODY-7f3a";
		for (const above of [
			[`✶ ${sentinel}… (8s · ↓ 1 tokens)`, ""],
			[`✻ ${sentinel} for 3s · done 11:02 AM`, ""],
			[`◆ ${sentinel}`, ""],
		]) {
			expect(
				JSON.stringify(parseClaudeLeadPaneActivity(pane(above), LEAD)),
			).not.toContain(sentinel);
		}
	});
});
