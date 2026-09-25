import { describe, expect, it, vi } from "vitest";
import type {
	LeadWindowRef,
	V2LeadClaudeProcess,
} from "../../../LeadWindowLocator.js";
import {
	CLAUDE_PANE_CAPTURE_LINES,
	readClaudeLeadActivity,
} from "../claude-lead-activity.js";

const LEAD = "flywheel-eng-lead";
const REF: LeadWindowRef = {
	windowId: "%0",
	windowName: "main",
	carrier: "v2",
	socketPath: "/tmp/fw-test.sock",
	sessionTarget: "=main",
	bodyPaneTarget: "%0",
};
const NOW = Date.parse("2026-09-25T20:00:00.000Z");

function pane(slot: string): string {
	return [
		slot,
		"",
		`${"─".repeat(48)} @${LEAD} ──`,
		"❯ ",
		"─".repeat(64),
		"  ⏵⏵ bypass permissions on (shift+tab to cycle)",
	].join("\n");
}

const RUNNING: V2LeadClaudeProcess = { state: "running", pid: "19966" };

function deps(over: {
	locate?: () => Promise<LeadWindowRef | null>;
	capture?: () => Promise<string>;
	claudePids?: V2LeadClaudeProcess[];
}) {
	const pids = [...(over.claudePids ?? [RUNNING, RUNNING])];
	return {
		locate: vi.fn(over.locate ?? (async () => REF)),
		capture: vi.fn(
			over.capture ?? (async () => pane("✻ Worked for 3s · done 1:00 PM")),
		),
		claudeProcess: vi.fn(async () => pids.shift() ?? RUNNING),
		now: () => NOW,
	};
}

describe("readClaudeLeadActivity", () => {
	it("derives the turn start from the spinner timer and never attributes an issue", async () => {
		const d = deps({
			capture: async () => pane("✶ Spelunking… (1m 4s · ↓ 547 tokens)"),
		});
		const result = await readClaudeLeadActivity("flywheel", LEAD, d);
		expect(result).toEqual({
			observedAtMs: NOW,
			reading: {
				state: "busy",
				turn: {
					startedAt: new Date(NOW - 64_000).toISOString(),
					elapsedMs: 64_000,
					precision: "second",
					origin: "unknown",
				},
				trigger: {
					kind: "undetermined",
					reason: "causality_unproven",
					detail: expect.stringContaining("判断不了"),
				},
			},
		});
		expect(d.locate).toHaveBeenCalledWith("flywheel", LEAD);
		expect(d.capture).toHaveBeenCalledWith(REF, CLAUDE_PANE_CAPTURE_LINES);
		expect(CLAUDE_PANE_CAPTURE_LINES).toBe(150);
	});

	it("reads idle from a done line", async () => {
		const result = await readClaudeLeadActivity("flywheel", LEAD, deps({}));
		expect(result.reading).toEqual({ state: "idle" });
	});

	it.each([
		[
			"locate returns null",
			{ locate: async () => null },
			"lead_window_unavailable",
		],
		[
			"locate throws",
			{
				locate: async () => {
					throw new Error("boom");
				},
			},
			"lead_window_unavailable",
		],
		[
			"capture fails the identity re-check",
			{
				capture: async () => {
					throw new Error("private Lead body pane identity is indeterminate");
				},
			},
			"lead_window_unavailable",
		],
		[
			"capture errors otherwise",
			{
				capture: async () => {
					throw new Error("tmux: can't find pane");
				},
			},
			"pane_capture_failed",
		],
		[
			"the pane has no input box",
			{ capture: async () => "menu" },
			"pane_unrecognized",
		],
	] as const)(
		"answers unknown when %s — never idle",
		async (_label, over, reason) => {
			const d = deps(over);
			const result = await readClaudeLeadActivity("flywheel", LEAD, d);
			expect(result.reading).toEqual({ state: "unknown", reason });
			if (reason === "lead_window_unavailable" && _label.startsWith("locate"))
				expect(d.capture).not.toHaveBeenCalled();
		},
	);
});

describe("readClaudeLeadActivity — Claude process liveness (design-correction C2)", () => {
	const ABSENT: V2LeadClaudeProcess = { state: "absent" };
	const UNSURE: V2LeadClaudeProcess = { state: "indeterminate" };
	it("checks the same live Claude pid before and after the capture", async () => {
		const d = deps({});
		const result = await readClaudeLeadActivity("flywheel", LEAD, d);
		expect(result.reading).toEqual({ state: "idle" });
		expect(d.claudeProcess).toHaveBeenCalledTimes(2);
		expect(d.claudeProcess).toHaveBeenNthCalledWith(1, REF);
		expect(d.claudeProcess.mock.invocationCallOrder[0]).toBeLessThan(
			d.capture.mock.invocationCallOrder[0]!,
		);
		expect(d.claudeProcess.mock.invocationCallOrder[1]).toBeGreaterThan(
			d.capture.mock.invocationCallOrder[0]!,
		);
	});

	it.each([
		[
			"Claude already gone before the capture",
			[ABSENT],
			"lead_process_not_running",
		],
		[
			"Claude gone by the end of the capture",
			[RUNNING, ABSENT],
			"lead_process_not_running",
		],
		[
			"liveness unknowable before the capture",
			[UNSURE],
			"lead_process_unverified",
		],
		[
			"liveness unknowable after the capture",
			[RUNNING, UNSURE],
			"lead_process_unverified",
		],
		[
			"a different Claude process after the capture",
			[RUNNING, { state: "running", pid: "777" }],
			"lead_process_unverified",
		],
	] as const)(
		"%s → unknown even though the old screen still says done",
		async (_label, claudePids, reason) => {
			const d = deps({ claudePids: [...claudePids] });
			const result = await readClaudeLeadActivity("flywheel", LEAD, d);
			expect(result.reading).toEqual({ state: "unknown", reason });
			if (claudePids.length === 1) expect(d.capture).not.toHaveBeenCalled();
		},
	);
});
