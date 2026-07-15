import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	emptyQuotaMonitorState,
	type QuotaMonitorState,
} from "../account-heal/quota-monitor-state.js";
import {
	classifyQuotaPane,
	makeTmuxReviveDeps,
	reviveScan,
} from "../account-heal/quota-revive-scan.js";

const NOW = Date.parse("2026-07-14T20:00:00Z");
const FIXTURES = join(import.meta.dirname, "fixtures", "lead-panes");

function fixture(name: string): string {
	return readFileSync(join(FIXTURES, name), "utf8");
}

function state(): QuotaMonitorState {
	return {
		...emptyQuotaMonitorState(5),
		lastPollAt: NOW,
		reviveEpoch: {
			open: true,
			sourceAccount: "shopping",
			generation: 5,
			openedAt: NOW - 60_000,
			expiresAt: NOW + 3_600_000,
			panes: {},
		},
	};
}

describe("classifyQuotaPane — committed real-pane fixtures", () => {
	it.each([
		"usage-limit-real.txt",
		"usage-limit-weekly.txt",
		"usage-limit-both.txt",
		"throttle-529-then-usage-cap.txt",
	])("classifies a high-confidence quota dialog: %s", (name) => {
		expect(classifyQuotaPane(fixture(name))).toBe("quota_stuck");
	});

	it("classifies a real OAuth-expired pane as login_expired", () => {
		expect(
			classifyQuotaPane(
				readFileSync(
					join(
						import.meta.dirname,
						"..",
						"bridge",
						"__tests__",
						"fixtures",
						"error-panes",
						"fn0-not-logged-in.txt",
					),
					"utf8",
				),
			),
		).toBe("login_expired");
	});

	it.each([
		"rate-limit-real.txt",
		"rate-limit-alert-echo.txt",
		"login-expired-alert-echo.txt",
		"freeze-resume-menu.txt",
		"freeze-compacting.txt",
		"idle-product-lead.txt",
	])("refuses adversarial/non-quota panes: %s", (name) => {
		expect(classifyQuotaPane(fixture(name))).toBe("other");
	});
});

describe("reviveScan", () => {
	function deps(captures: Record<string, string>) {
		const sendContinue = vi.fn(async () => ({ sent: true as const }));
		const persistState = vi.fn(async () => {});
		const alert = vi.fn(async () => {});
		return {
			sendContinue,
			persistState,
			alert,
			input: {
				state: state(),
				nowMs: NOW,
				socket: "flywheel",
				monitorOnly: false,
				listPanes: async () =>
					Object.keys(captures).map((paneId, index) => ({
						paneId,
						panePid: 4_000 + index,
					})),
				capturePane: async (paneId: string) => captures[paneId] ?? "",
				sendContinue,
				persistState,
				alert,
			},
		};
	}

	it("sends only to quota_stuck, persists the pane-instance attempt, and reports login without touching it", async () => {
		const h = deps({
			"%1": fixture("usage-limit-real.txt"),
			"%2": fixture("freeze-resume-menu.txt"),
			"%3": "Invalid API key · Please run /login to continue.\n❯",
		});

		const result = await reviveScan(h.input);

		expect(h.sendContinue).toHaveBeenCalledTimes(1);
		expect(h.sendContinue).toHaveBeenCalledWith("%1");
		expect(result.summary).toEqual({ revived: 1, pending: 0, loginExpired: 1 });
		expect(result.state.reviveEpoch?.panes).toEqual({
			"flywheel:%1:4000": { attempts: 1, lastAttemptAt: NOW },
		});
		expect(h.persistState).toHaveBeenCalledTimes(1);
	});

	it.each([
		["no epoch", null, false],
		[
			"expired epoch",
			{ ...state().reviveEpoch, expiresAt: NOW } as NonNullable<
				QuotaMonitorState["reviveEpoch"]
			>,
			false,
		],
		["monitor-only", state().reviveEpoch, true],
	])(
		"%s classifies but never sends keys",
		async (_label, epoch, monitorOnly) => {
			const h = deps({ "%1": fixture("usage-limit-real.txt") });
			h.input.state.reviveEpoch = epoch;
			h.input.monitorOnly = monitorOnly;
			const result = await reviveScan(h.input);
			expect(h.sendContinue).not.toHaveBeenCalled();
			expect(result.summary.revived).toBe(0);
		},
	);

	it("allows at most one attempt per poll tick and persists the three-attempt budget across restart", async () => {
		const h = deps({ "%1": fixture("usage-limit-real.txt") });
		h.input.state.reviveEpoch!.panes["flywheel:%1:4000"] = {
			attempts: 1,
			lastAttemptAt: NOW,
		};
		let result = await reviveScan(h.input);
		expect(h.sendContinue).not.toHaveBeenCalled();
		expect(result.summary.pending).toBe(1);

		h.input.nowMs = NOW + 10 * 60_000;
		h.input.state = structuredClone(result.state);
		result = await reviveScan(h.input);
		expect(h.sendContinue).toHaveBeenCalledTimes(1);
		expect(result.state.reviveEpoch?.panes["flywheel:%1:4000"].attempts).toBe(
			2,
		);
	});

	it("alerts and sends nothing after three unsuccessful attempts", async () => {
		const h = deps({ "%1": fixture("usage-limit-real.txt") });
		h.input.state.reviveEpoch!.panes["flywheel:%1:4000"] = {
			attempts: 3,
			lastAttemptAt: NOW - 1,
		};
		const result = await reviveScan(h.input);
		expect(h.sendContinue).not.toHaveBeenCalled();
		expect(result.summary.pending).toBe(1);
		expect(h.alert).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "quota_revive_stuck" }),
		);
	});

	it("a late-arriving quota dialog is caught on a later tick", async () => {
		const captures = { "%1": fixture("idle-product-lead.txt") };
		const h = deps(captures);
		let result = await reviveScan(h.input);
		expect(h.sendContinue).not.toHaveBeenCalled();

		captures["%1"] = fixture("usage-limit-real.txt");
		h.input.nowMs = NOW + 10 * 60_000;
		h.input.state = result.state;
		result = await reviveScan(h.input);
		expect(h.sendContinue).toHaveBeenCalledWith("%1");
		expect(result.summary.revived).toBe(1);
	});

	it("pane-id reuse gets a fresh budget because pane_pid is part of the instance key", async () => {
		const h = deps({ "%1": fixture("usage-limit-real.txt") });
		h.input.state.reviveEpoch!.panes["flywheel:%1:3999"] = {
			attempts: 3,
			lastAttemptAt: NOW - 1,
		};
		const result = await reviveScan(h.input);
		expect(h.sendContinue).toHaveBeenCalledWith("%1");
		expect(result.state.reviveEpoch?.panes).toEqual({
			"flywheel:%1:4000": { attempts: 1, lastAttemptAt: NOW },
		});
	});

	it("clears attempt records when a pane disappears or recovers", async () => {
		const h = deps({ "%1": fixture("idle-product-lead.txt") });
		h.input.state.reviveEpoch!.panes["flywheel:%1:4000"] = {
			attempts: 2,
			lastAttemptAt: NOW - 1,
		};
		h.input.state.reviveEpoch!.panes["flywheel:%9:4999"] = {
			attempts: 1,
			lastAttemptAt: NOW - 1,
		};
		const result = await reviveScan(h.input);
		expect(result.state.reviveEpoch?.panes).toEqual({});
		expect(h.persistState).toHaveBeenCalled();
	});
});

describe("makeTmuxReviveDeps", () => {
	it("uses the exact audited literal continue + Enter sequence", async () => {
		const execFile = vi.fn(async () => ({ stdout: "", stderr: "" }));
		const tmux = makeTmuxReviveDeps({ socket: "flywheel", execFile });
		await tmux.sendContinue("%7");
		expect(execFile.mock.calls.map(([file, args]) => [file, args])).toEqual([
			[
				"tmux",
				["-L", "flywheel", "send-keys", "-t", "%7", "-l", "--", "continue"],
			],
			["tmux", ["-L", "flywheel", "send-keys", "-t", "%7", "Enter"]],
		]);
	});
});
