import { describe, expect, it, vi } from "vitest";
import type {
	ExecFn,
	LeadWindowRef,
	V2LeadClaudeProcess,
} from "../../LeadWindowLocator.js";
import {
	claudePromptEmpty,
	createClaudeInterruptPane,
} from "../lead-interrupt-claude-pane.js";
import { LEAD_INTERRUPT_PHRASE } from "../lead-interrupt-contract.js";
import { sendLiteralLineToLeadPane } from "../tmux-lookup.js";

const LEAD = "flywheel-eng-lead";
const WINDOW: LeadWindowRef = {
	windowId: "%0",
	windowName: "main",
	carrier: "v2",
	socketPath: "/tmp/fly2883.sock",
	sessionTarget: "=main",
	bodyPaneTarget: "%0",
};

/** Synthetic pane (FLY-2882 fixture shape): filler text only. */
function pane(
	above: string[],
	opts: { lead?: string; prompt?: string } = {},
): string {
	return [
		"⏺ lorem ipsum filler reply",
		"",
		...above,
		`${"─".repeat(48)} @${opts.lead ?? LEAD} ──`,
		opts.prompt ?? "❯ ",
		"─".repeat(64),
		"  ⏵⏵ bypass permissions on (shift+tab to cycle)",
	].join("\n");
}
const BUSY = pane(["✶ Spelunking… (36s · ↓ 423 tokens)", ""]);
const BUSY_TYPED = pane(["✶ Spelunking… (36s · ↓ 423 tokens)", ""], {
	prompt: "❯ founder is typing here",
});
const IDLE = pane(["✻ Worked for 1m 17s · done 12:17 PM", ""]);

describe("claudePromptEmpty", () => {
	it("is true only for a whitespace-only prompt under this Lead's border", () => {
		expect(claudePromptEmpty(BUSY, LEAD)).toBe(true);
		expect(claudePromptEmpty(pane([], { prompt: "❯  " }), LEAD)).toBe(true);
		expect(claudePromptEmpty(BUSY_TYPED, LEAD)).toBe(false);
		expect(claudePromptEmpty(pane([], { lead: "other-lead" }), LEAD)).toBe(
			false,
		);
		expect(claudePromptEmpty("no box at all", LEAD)).toBe(false);
	});
});

function harness(
	opts: {
		panes?: string[];
		processes?: V2LeadClaudeProcess[];
		window?: LeadWindowRef | null;
		captureError?: Error;
		send?: (
			window: LeadWindowRef,
			expectedClaudePid: string,
		) => Promise<{ sent: boolean; error?: string }>;
	} = {},
) {
	const panes = [...(opts.panes ?? [BUSY])];
	const processes = [...(opts.processes ?? [])];
	const capture = vi.fn(async () => {
		if (opts.captureError) throw opts.captureError;
		const next = panes.shift();
		if (next === undefined) throw new Error("no more scripted captures");
		return next;
	});
	const claudeProcess = vi.fn(
		async (): Promise<V2LeadClaudeProcess> =>
			processes.shift() ?? { state: "running", pid: "5000" },
	);
	const send = vi.fn(opts.send ?? (async () => ({ sent: true })));
	const paneApi = createClaudeInterruptPane({
		leadId: LEAD,
		locate: async () => (opts.window === undefined ? WINDOW : opts.window),
		capture,
		claudeProcess,
		sendPhrase: send,
	});
	return { paneApi, capture, claudeProcess, send };
}

describe("createClaudeInterruptPane.assess", () => {
	it.each([
		[[BUSY], { state: "busy_safe" }],
		[[BUSY_TYPED], { state: "busy_unsafe", reason: "prompt_not_empty" }],
		[[IDLE], { state: "idle", reason: "done_line" }],
		[
			[pane(["⏺ something new", "some column-0 line"])],
			{ state: "unknown", reason: "unrecognized_status_line" },
		],
	])("judges a scripted pane", async (panes, expected) => {
		const h = harness({ panes });
		expect(await h.paneApi.assess()).toEqual(expected);
	});

	it("does not type-judge an old in-progress line left in scrollback (R2#4)", async () => {
		const h = harness({
			panes: [
				pane([
					"✶ Spelunking… (36s · ↓ 423 tokens)",
					"⏺ filler reply",
					"✻ Worked for 40s · done 12:17 PM",
					"",
				]),
			],
		});
		expect(await h.paneApi.assess()).toEqual({
			state: "idle",
			reason: "done_line",
		});
	});

	it.each([
		[{ window: null }, "lead_window_unavailable"],
		[{ processes: [{ state: "absent" as const }] }, "lead_process_not_running"],
		[
			{ processes: [{ state: "indeterminate" as const }] },
			"lead_process_unverified",
		],
		[
			{
				processes: [
					{ state: "running" as const, pid: "5000" },
					{ state: "running" as const, pid: "5001" },
				],
			},
			"lead_process_unverified",
		],
		[{ captureError: new Error("boom") }, "pane_capture_failed"],
	])("is unknown when %j", async (opts, reason) => {
		const h = harness(opts);
		expect(await h.paneApi.assess()).toEqual({ state: "unknown", reason });
	});
});

describe("createClaudeInterruptPane.typePhrase", () => {
	it("re-captures, re-judges, calls the guard, then sends to the proven Claude pid", async () => {
		const order: string[] = [];
		const h = harness({
			panes: [BUSY],
			send: async (window, pid) => {
				order.push(`send:${pid}`);
				expect(window).toBe(WINDOW);
				return { sent: true };
			},
		});
		expect(
			await h.paneApi.typePhrase(() => {
				order.push("guard");
			}),
		).toEqual({ outcome: "nudged" });
		expect(order).toEqual(["guard", "send:5000"]);
		expect(h.capture).toHaveBeenCalledTimes(1);
	});

	it("skips without sending when the re-judgment is no longer safe (R1#8)", async () => {
		const h = harness({ panes: [BUSY_TYPED] });
		const guard = vi.fn();
		expect(await h.paneApi.typePhrase(guard)).toEqual({
			outcome: "skipped",
			reason: "prompt_not_empty",
		});
		expect(guard).not.toHaveBeenCalled();
		expect(h.send).not.toHaveBeenCalled();
	});

	it("never sends when the guard throws", async () => {
		const h = harness({ panes: [BUSY] });
		await expect(
			h.paneApi.typePhrase(() => {
				throw new Error("owner fence lost");
			}),
		).rejects.toThrow(/owner fence lost/);
		expect(h.send).not.toHaveBeenCalled();
	});

	it("reports a failed send", async () => {
		const h = harness({
			panes: [BUSY],
			send: async () => ({ sent: false, error: "claude pid changed" }),
		});
		expect(await h.paneApi.typePhrase(() => {})).toEqual({
			outcome: "failed",
			reason: "send_failed",
		});
	});
});

type Call = { file: string; args: string[] };
function fakeTmux(opts: { claudePid?: string; currentCommand?: string } = {}) {
	const calls: Call[] = [];
	const fn = vi.fn(async (file: string, args: readonly string[]) => {
		calls.push({ file, args: [...args] });
		const joined = args.join(" ");
		if (file === "tmux" && joined.includes("#{session_name}"))
			return {
				stdout: `%0\tmain\tbash /repo/packages/teamlead/scripts/lead-body.sh /m\t${opts.currentCommand ?? "bash"}\t0\t4242\n`,
				stderr: "",
			};
		if (file === "ps" && args.includes("command="))
			return {
				stdout: "/bin/bash /repo/packages/teamlead/scripts/lead-body.sh /m\n",
				stderr: "",
			};
		if (file === "tmux" && joined.includes("#{pane_dead}\t#{pane_pid}"))
			return { stdout: "%0\t0\t4242\n", stderr: "" };
		if (file === "ps" && args.includes("pid=,ppid=,ucomm="))
			return {
				stdout: ` 4242     1 bash\n ${opts.claudePid ?? "5000"}  4242 claude\n`,
				stderr: "",
			};
		return { stdout: "", stderr: "" };
	});
	return { fn: fn as unknown as ExecFn, calls };
}

describe("sendLiteralLineToLeadPane", () => {
	it("refuses any text other than the fixed phrase, before touching tmux", async () => {
		const tmux = fakeTmux();
		await expect(
			sendLiteralLineToLeadPane(WINDOW, "你现在在做什么?", {
				expectedClaudePid: "5000",
				execFn: tmux.fn,
			}),
		).rejects.toThrow(/fixed interrupt phrase/);
		expect(tmux.calls).toHaveLength(0);
	});

	it("types exactly the phrase literally, then Enter, into the proven body pane", async () => {
		const tmux = fakeTmux();
		expect(
			await sendLiteralLineToLeadPane(WINDOW, LEAD_INTERRUPT_PHRASE, {
				expectedClaudePid: "5000",
				execFn: tmux.fn,
			}),
		).toEqual({ sent: true });
		const sends = tmux.calls.filter((c) => c.args.includes("send-keys"));
		expect(sends.map((c) => c.args)).toEqual([
			[
				"-S",
				WINDOW.socketPath,
				"send-keys",
				"-t",
				"%0",
				"-l",
				"--",
				LEAD_INTERRUPT_PHRASE,
			],
			["-S", WINDOW.socketPath, "send-keys", "-t", "%0", "Enter"],
		]);
		expect(LEAD_INTERRUPT_PHRASE).not.toMatch(/li_/);
	});

	it("does not send when the Claude process changed since the judgment", async () => {
		const tmux = fakeTmux({ claudePid: "6000" });
		expect(
			await sendLiteralLineToLeadPane(WINDOW, LEAD_INTERRUPT_PHRASE, {
				expectedClaudePid: "5000",
				execFn: tmux.fn,
			}),
		).toMatchObject({ sent: false });
		expect(tmux.calls.some((c) => c.args.includes("send-keys"))).toBe(false);
	});

	it("does not send when the pane identity cannot be proven", async () => {
		const tmux = fakeTmux();
		(tmux.fn as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
			async () => ({ stdout: "%0\tother\tzsh\tzsh\t0\t4242\n", stderr: "" }),
		);
		expect(
			await sendLiteralLineToLeadPane(WINDOW, LEAD_INTERRUPT_PHRASE, {
				expectedClaudePid: "5000",
				execFn: tmux.fn,
			}),
		).toMatchObject({ sent: false });
		expect(tmux.calls.some((c) => c.args.includes("send-keys"))).toBe(false);
	});
});
