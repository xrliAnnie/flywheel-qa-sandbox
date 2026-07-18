import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	emptyQuotaMonitorState,
	type QuotaMonitorState,
} from "../account-heal/quota-monitor-state.js";
import {
	classifyQuotaPane,
	isManagedClaudePane,
	makeTmuxReviveDeps,
	reviveScan,
	scanQuotaPanes,
} from "../account-heal/quota-revive-scan.js";

const NOW = Date.parse("2026-07-14T20:00:00Z");
const FIXTURES = join(import.meta.dirname, "fixtures", "lead-panes");
const LOGIN_EXPIRED = readFileSync(
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
);

function fixture(name: string): string {
	return readFileSync(join(FIXTURES, name), "utf8");
}

function modelCapture(model: string, afterCap = ""): string {
	return fixture("usage-limit-real.txt").replace(
		/^\s*⎿\s+Claude usage limit reached\.[^\n]*$/m,
		`  ⎿  You've reached your ${model} limit. Run /usage-credits to continue or switch models with /model.${afterCap}`,
	);
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
		expect(classifyQuotaPane(LOGIN_EXPIRED)).toBe("login_expired");
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

	it("refuses a Discord echo of the exact cap sentence inside an otherwise real Claude TUI", () => {
		expect(
			classifyQuotaPane(
				fixture("usage-limit-real.txt").replace(
					"  ⎿  Claude usage limit reached.",
					"← discord · Infra Bot: Claude usage limit reached.",
				),
			),
		).toBe("other");
	});
});

describe("managed Claude pane qualification", () => {
	const pane = {
		paneId: "%1",
		panePid: 4_000,
		sessionName: "flywheel",
		windowName: "flywheel-product-lead",
		currentCommand: "2.1.211",
		dead: false,
		qaInjection: false,
	};

	it("accepts live Flywheel Claude metadata plus high-confidence TUI anchors", () => {
		expect(
			isManagedClaudePane(pane, fixture("usage-limit-real.txt"), false),
		).toBe(true);
	});

	it.each([
		["shell cat of a cap fixture", { currentCommand: "zsh" }],
		["this plan opened in a shell", { currentCommand: "less" }],
		["a Codex pane", { currentCommand: "codex" }],
		["an unmanaged window", { windowName: "notes" }],
		["a dead pane", { dead: true }],
	])("refuses %s", (_label, override) => {
		expect(
			isManagedClaudePane(
				{ ...pane, ...override },
				fixture("usage-limit-real.txt"),
				false,
			),
		).toBe(false);
	});

	it("requires all live-TUI anchors even when metadata looks like Claude", () => {
		expect(
			isManagedClaudePane(pane, fixture("freeze-resume-menu.txt"), false),
		).toBe(false);
	});

	it("opens the shell-based QA seam only when both pane marker and env gate are present", () => {
		const qaPane = {
			...pane,
			currentCommand: "zsh",
			qaInjection: true,
			windowName: "FLY-1182-qa-model-cap",
		};
		expect(
			isManagedClaudePane(qaPane, fixture("usage-limit-real.txt"), false),
		).toBe(false);
		expect(
			isManagedClaudePane(qaPane, fixture("usage-limit-real.txt"), true),
		).toBe(true);
		expect(
			isManagedClaudePane(pane, fixture("usage-limit-real.txt"), true),
		).toBe(true);
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
				qaInjectionEnabled: false,
				listPanes: async () =>
					Object.keys(captures).map((paneId, index) => ({
						paneId,
						panePid: 4_000 + index,
						sessionName: "flywheel",
						windowName: `FLY-${100 + index}-claude-runner`,
						currentCommand: "2.1.211",
						dead: false,
						qaInjection: false,
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
			"%3": LOGIN_EXPIRED,
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

	it("revives a strictly capped model only under a matching committed model epoch", async () => {
		const h = deps({ "%1": modelCapture("Fable 5") });
		h.input.state.reviveEpoch!.trigger = {
			kind: "model",
			models: ["Fable 5", "Sonnet 5"],
		};

		const result = await reviveScan(h.input);

		expect(h.sendContinue).toHaveBeenCalledWith("%1");
		expect(result.summary.revived).toBe(1);
		expect(result.modelDetections).toEqual([
			expect.objectContaining({
				pane: expect.objectContaining({ paneId: "%1", panePid: 4_000 }),
				verdict: { state: "capped", model: "Fable 5" },
			}),
		]);
	});

	it("detects a model cap without an epoch but treats it as observation-only", async () => {
		const h = deps({ "%1": modelCapture("Fable 5") });
		h.input.state.reviveEpoch = null;

		const result = await reviveScan(h.input);

		expect(result.modelDetections).toEqual([
			expect.objectContaining({
				verdict: { state: "capped", model: "Fable 5" },
			}),
		]);
		expect(h.sendContinue).not.toHaveBeenCalled();
	});

	it("ignores a Discord echo of the exact model-cap sentence inside a managed Claude TUI", async () => {
		const echoed = modelCapture("Fable 5").replace(
			/^\s*⎿\s+You've reached your Fable 5 limit\.[^\n]*$/m,
			"← discord · Infra Bot: You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.",
		);
		const h = deps({ "%1": echoed });
		h.input.state.reviveEpoch = null;

		const result = await reviveScan(h.input);

		expect(result.modelDetections).toEqual([]);
		expect(h.sendContinue).not.toHaveBeenCalled();
	});

	it.each([
		["different model", 5, { kind: "model", models: ["Sonnet 5"] }],
		["generation mismatch", 4, { kind: "model", models: ["Fable 5"] }],
		["account epoch", 5, undefined],
	])(
		"does not revive a model cap under %s",
		async (_label, generation, trigger) => {
			const h = deps({ "%1": modelCapture("Fable 5") });
			h.input.state.reviveEpoch!.generation = generation;
			h.input.state.reviveEpoch!.trigger = trigger as
				| { kind: "model"; models: string[] }
				| undefined;
			const result = await reviveScan(h.input);
			expect(h.sendContinue).not.toHaveBeenCalled();
			expect(result.summary.revived).toBe(0);
		},
	);

	it("records and warns on model-cap unknown without ever sending keys", async () => {
		const h = deps({
			"%1": modelCapture("Fable 5", "\n✻ Cooking… (12s · esc to interrupt)"),
		});
		h.input.state.reviveEpoch = null;

		const result = await reviveScan(h.input);

		expect(h.sendContinue).not.toHaveBeenCalled();
		expect(result.modelDetections[0]?.verdict).toMatchObject({
			state: "unknown",
		});
		expect(h.alert).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "model_cap_unknown" }),
		);
	});

	it("persists a bounded unknown streak by pane instance, escalates at three, and clears on a known capture", async () => {
		const captures = {
			"%1": modelCapture("Fable 5", "\n✻ Cooking… (12s · esc to interrupt)"),
		};
		const h = deps(captures);
		h.input.state.reviveEpoch = null;

		let result = await reviveScan(h.input);
		expect(result.state.unknownPanes["flywheel:%1:4000"]?.count).toBe(1);
		for (let count = 2; count <= 3; count++) {
			h.input.state = result.state;
			h.input.nowMs += 60_000;
			result = await reviveScan(h.input);
			expect(result.state.unknownPanes["flywheel:%1:4000"]?.count).toBe(count);
		}
		expect(h.alert).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "model_cap_persistent_unknown" }),
		);
		expect(h.sendContinue).not.toHaveBeenCalled();

		captures["%1"] = fixture("idle-product-lead.txt");
		h.input.state = result.state;
		h.input.nowMs += 60_000;
		result = await reviveScan(h.input);
		expect(result.state.unknownPanes).toEqual({});
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

	it("consumes a supplied pane snapshot without listing or capturing again", async () => {
		const h = deps({ "%1": modelCapture("Fable 5") });
		h.input.state.reviveEpoch!.trigger = {
			kind: "model",
			models: ["Fable 5"],
		};
		const snapshot = await scanQuotaPanes({
			nowMs: NOW,
			socket: "flywheel",
			qaInjectionEnabled: false,
			listPanes: h.input.listPanes,
			capturePane: h.input.capturePane,
		});
		const listPanes = vi.fn(async () => {
			throw new Error("must not list twice");
		});
		const capturePane = vi.fn(async () => {
			throw new Error("must not capture twice");
		});

		const result = await reviveScan({
			...h.input,
			listPanes,
			capturePane,
			snapshot,
		});

		expect(listPanes).not.toHaveBeenCalled();
		expect(capturePane).not.toHaveBeenCalled();
		expect(h.sendContinue).toHaveBeenCalledWith("%1");
		expect(result.snapshot).toBe(snapshot);
		expect(result.modelDetections).toEqual([
			expect.objectContaining({
				verdict: { state: "capped", model: "Fable 5" },
			}),
		]);
	});
});

describe("scanQuotaPanes", () => {
	it("caps the fleet at 64 panes, times out each capture, and preserves partial failures", async () => {
		const panes = Array.from({ length: 66 }, (_, index) => ({
			paneId: `%${index + 1}`,
			panePid: 4_001 + index,
			sessionName: "flywheel",
			windowName: `FLY-${100 + index}-claude-runner`,
			currentCommand: "2.1.211",
			dead: false,
			qaInjection: false,
		}));
		const capturePane = vi.fn(async (paneId: string) => {
			if (paneId === "%2") throw new Error("capture exploded");
			if (paneId === "%3") return new Promise<string>(() => undefined);
			return modelCapture("Fable 5");
		});

		const snapshot = await scanQuotaPanes({
			nowMs: NOW,
			socket: "flywheel",
			qaInjectionEnabled: false,
			listPanes: async () => [panes[0], panes[0], ...panes.slice(1)],
			capturePane,
			captureTimeoutMs: 5,
			captureConcurrency: 8,
		});

		expect(snapshot.listedCount).toBe(66);
		expect(snapshot.observations).toHaveLength(64);
		expect(snapshot.omittedPanes.map((pane) => pane.paneId)).toEqual([
			"%65",
			"%66",
		]);
		expect(capturePane).toHaveBeenCalledTimes(64);
		expect(snapshot.observations[0]).toMatchObject({
			capture: expect.any(String),
			managed: true,
			modelVerdict: { state: "capped", model: "Fable 5" },
		});
		expect(snapshot.observations[1]).toMatchObject({
			capture: null,
			managed: false,
			captureError: "capture exploded",
		});
		expect(snapshot.observations[2]).toMatchObject({
			capture: null,
			managed: false,
			captureError: "capture timeout after 5ms",
		});
		expect(snapshot.complete).toBe(false);
	});

	it("returns a fail-closed partial snapshot when listing panes fails", async () => {
		const snapshot = await scanQuotaPanes({
			nowMs: NOW,
			socket: "flywheel",
			qaInjectionEnabled: false,
			listPanes: async () => {
				throw new Error("tmux unavailable");
			},
			capturePane: async () => "",
		});

		expect(snapshot).toMatchObject({
			complete: false,
			listedCount: 0,
			observations: [],
			omittedPanes: [],
			listError: "tmux unavailable",
		});
	});
});

describe("makeTmuxReviveDeps", () => {
	it("lists full managed-pane metadata, preserves the QA marker, and deduplicates linked panes", async () => {
		const execFile = vi.fn(async () => ({
			stdout: [
				"%7\t7007\tflywheel\tFLY-1182-claude-runner\t2.1.211\t0\t",
				"%7\t7007\tcmux-FLY-1182-claude-runner\tFLY-1182-claude-runner\t2.1.211\t0\t",
				"%8\t7008\tflywheel-quota-qa\tFLY-1182-qa-model-cap\tzsh\t0\t1",
				"malformed",
			].join("\n"),
			stderr: "",
		}));
		const tmux = makeTmuxReviveDeps({ socket: "flywheel", execFile });

		await expect(tmux.listPanes()).resolves.toEqual([
			{
				paneId: "%7",
				panePid: 7007,
				sessionName: "flywheel",
				windowName: "FLY-1182-claude-runner",
				currentCommand: "2.1.211",
				dead: false,
				qaInjection: false,
			},
			{
				paneId: "%8",
				panePid: 7008,
				sessionName: "flywheel-quota-qa",
				windowName: "FLY-1182-qa-model-cap",
				currentCommand: "zsh",
				dead: false,
				qaInjection: true,
			},
		]);
		expect(execFile).toHaveBeenCalledWith(
			"tmux",
			[
				"-L",
				"flywheel",
				"list-panes",
				"-a",
				"-F",
				"#{pane_id}\t#{pane_pid}\t#{session_name}\t#{window_name}\t#{pane_current_command}\t#{pane_dead}\t#{@flywheel_quota_qa}",
			],
			{ timeout: 5_000 },
		);
	});

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
