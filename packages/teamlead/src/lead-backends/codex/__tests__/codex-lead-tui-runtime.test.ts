/**
 * FLY-259 PR-D — unit tests for the pure glue: parseCodexLeadTuiRuntimeConfig
 * and wireDemuxedProcess (demux ↔ executor facade contract).
 */

import { describe, expect, it, vi } from "vitest";
import {
	type CodexLeadProcess,
	CodexLeadProcessError,
} from "../CodexLeadProcess.js";
import type { CodexLeadRuntimeConfig } from "../codex-lead-runtime.js";
import {
	buildTuiDaemonEnv,
	isTurnlessRolloutError,
	parseCodexLeadTuiRuntimeConfig,
	reportSuccessfulDaemonEnsure,
	requirePersona,
	wireDemuxedProcess,
} from "../codex-lead-tui-runtime.js";

describe("buildTuiDaemonEnv — runtime→home daemon-env boundary (FLY-398 Codex R1 HIGH-1)", () => {
	const base = {
		env: {
			HOME: "/Users/x",
			PATH: "/bin",
			DISCORD_BOT_TOKEN: "tok-from-env",
			FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID: "alerts-channel",
			TEAMLEAD_API_TOKEN: "api-tok",
			FLYWHEEL_CODEX_LEAD_PROFILE: "full-access", // present in source env
			SOME_RANDOM_SECRET: "leak-me",
		} as NodeJS.ProcessEnv,
		codexHome: "/Users/x/.codex-mufasa",
		botToken: "tok-cfg",
	};

	it("full-access: re-pins FLYWHEEL_CODEX_LEAD_PROFILE so ensure-daemon does stop-before-start", () => {
		// THE bug Codex R1 HIGH-1 caught: buildFullAccessEnv strips
		// FLYWHEEL_CODEX_LEAD_PROFILE, so without re-pinning, the home script's
		// stop-before-start condition is false and a stale read-only daemon survives.
		const e = buildTuiDaemonEnv({ ...base, profile: "full-access" });
		expect(e.FLYWHEEL_CODEX_LEAD_PROFILE).toBe("full-access");
		expect(e.FLYWHEEL_CODEX_TUI_HOME).toBe("/Users/x/.codex-mufasa");
		// the bot token reaches the daemon (by NAME, for the lead_actions MCP child).
		expect(e.DISCORD_BOT_TOKEN).toBe("tok-cfg");
		// H-1 positive allowlist: a random non-allowlisted secret is NOT forwarded.
		expect(e.SOME_RANDOM_SECRET).toBeUndefined();
		// allowlisted Claude-pane env survives.
		expect(e.TEAMLEAD_API_TOKEN).toBe("api-tok");
		expect(e.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID).toBe("alerts-channel");
		expect(e.FLYWHEEL_ALERT_SENDER_TOKEN_ENV).toBe("DISCORD_BOT_TOKEN");
	});

	it("full-access: stays available when the optional alert route is absent", () => {
		const e = buildTuiDaemonEnv({
			...base,
			profile: "full-access",
			env: { ...base.env, FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID: undefined },
		});
		expect(e.FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID).toBeUndefined();
		expect(e.FLYWHEEL_ALERT_SENDER_TOKEN_ENV).toBeUndefined();
	});

	it("companion: raw env (byte-compat) + home pin", () => {
		const e = buildTuiDaemonEnv({ ...base, profile: "companion" });
		expect(e.SOME_RANDOM_SECRET).toBe("leak-me"); // raw — companion has no secrets in play
		expect(e.FLYWHEEL_CODEX_TUI_HOME).toBe("/Users/x/.codex-mufasa");
	});

	it("injects one carrier generation into both full-access and companion daemons", () => {
		for (const profile of ["full-access", "companion"] as const) {
			const e = buildTuiDaemonEnv({
				...base,
				profile,
				carrierInstanceId: "generation_capability",
				leadId: "mufasa-lead",
				projectName: "growth",
			});
			expect(e).toMatchObject({
				FLYWHEEL_LEAD_CARRIER_INSTANCE_ID: "generation_capability",
				FLYWHEEL_LEAD_ID: "mufasa-lead",
				FLYWHEEL_PROJECT_NAME: "growth",
			});
		}
	});
});

describe("reportSuccessfulDaemonEnsure", () => {
	it("keeps successful self-heal output in the Lead log", () => {
		const log = vi.fn();
		reportSuccessfulDaemonEnsure(
			Buffer.from("[codex-lead-tui-home] daemon OK: /tmp/control.sock\n"),
			log,
		);
		expect(log).toHaveBeenCalledWith(
			"[codex-lead-tui-home] daemon OK: /tmp/control.sock",
		);
	});

	it("does not add an empty log line", () => {
		const log = vi.fn();
		reportSuccessfulDaemonEnsure("", log);
		expect(log).not.toHaveBeenCalled();
	});
});

function fakeProc() {
	const handlers = new Map<string, ((...a: unknown[]) => void)[]>();
	let startTurnImpl: () => Promise<string | undefined> = async () => "t1";
	const proc = {
		on: (ev: string, cb: (...a: unknown[]) => void) => {
			const l = handlers.get(ev) ?? [];
			l.push(cb);
			handlers.set(ev, l);
		},
		startTurn: () => startTurnImpl(),
		request: async () => ({ result: {} }),
	} as unknown as CodexLeadProcess;
	const fire = (ev: string, ...a: unknown[]) => {
		for (const cb of handlers.get(ev) ?? []) cb(...a);
	};
	return {
		proc,
		fire,
		setStartTurn: (f: () => Promise<string | undefined>) => {
			startTurnImpl = f;
		},
	};
}

describe("wireDemuxedProcess", () => {
	it("claimed sidecar turn: early deltas replay, completion delivered, turn released", async () => {
		const f = fakeProc();
		const founderCompleted: string[] = [];
		const { facade } = wireDemuxedProcess({
			proc: f.proc,
			onFounderTurnCompleted: (id) => founderCompleted.push(id),
		});
		const notif: Array<[string, unknown]> = [];
		const completed: unknown[] = [];
		facade.on("notification", (m, p) => notif.push([m, p]));
		facade.on("turnCompleted", (p) => completed.push(p));

		const turnP = facade.startTurn({ threadId: "th", input: [] });
		// notification-before-response: early delta arrives before claim
		f.fire("notification", "item/agentMessage/delta", {
			turnId: "t1",
			delta: "early",
		});
		const id = await turnP; // resolves → claim → replay
		expect(id).toBe("t1");
		expect(notif).toEqual([
			["item/agentMessage/delta", { turnId: "t1", delta: "early" }],
		]);
		f.fire("turnCompleted", { turn: { id: "t1" } });
		expect(completed).toHaveLength(1);
		expect(founderCompleted).toEqual([]); // ours, not founder
		// released: a late straggler is dropped (tombstoned), not founder
		f.fire("notification", "item/agentMessage/delta", {
			turnId: "t1",
			delta: "late",
		});
		expect(notif).toHaveLength(1);
		expect(founderCompleted).toEqual([]);
	});

	it("founder turn: events never reach the facade; completion records ONE observation", () => {
		const f = fakeProc();
		const founderCompleted: string[] = [];
		const { facade } = wireDemuxedProcess({
			proc: f.proc,
			onFounderTurnCompleted: (id) => founderCompleted.push(id),
		});
		const notif: unknown[] = [];
		facade.on("notification", (m, p) => notif.push([m, p]));
		f.fire("notification", "item/agentMessage/delta", {
			turnId: "founder-1",
			delta: "typed in TUI",
		});
		f.fire("turnCompleted", { turn: { id: "founder-1" } });
		expect(notif).toEqual([]);
		expect(founderCompleted).toEqual(["founder-1"]);
	});

	it("startTurn failure → abortDispatch (held events settle as founder)", async () => {
		const f = fakeProc();
		const founderCompleted: string[] = [];
		const { facade } = wireDemuxedProcess({
			proc: f.proc,
			onFounderTurnCompleted: (id) => founderCompleted.push(id),
		});
		f.setStartTurn(async () => {
			throw new Error("rpc failed");
		});
		const p = facade.startTurn({ threadId: "th", input: [] });
		f.fire("notification", "turn/completed", { turn: { id: "whose" } });
		await expect(p).rejects.toThrow("rpc failed");
		// held event settled to observer on abort → founder completion recorded
		expect(founderCompleted).toEqual(["whose"]);
	});

	it("undefined turnId from startTurn → abort, no registration", async () => {
		const f = fakeProc();
		const { facade } = wireDemuxedProcess({
			proc: f.proc,
			onFounderTurnCompleted: () => {},
		});
		f.setStartTurn(async () => undefined);
		await expect(
			facade.startTurn({ threadId: "th", input: [] }),
		).resolves.toBeUndefined();
	});

	it("activity callback fires for every routed event", () => {
		const f = fakeProc();
		let activity = 0;
		wireDemuxedProcess({
			proc: f.proc,
			onFounderTurnCompleted: () => {},
			onActivity: () => {
				activity += 1;
			},
		});
		f.fire("notification", "thread/tokenUsage/updated", {});
		f.fire("notification", "item/agentMessage/delta", { turnId: "x" });
		expect(activity).toBe(2);
	});

	it("observes raw token usage before turn demux filtering", () => {
		const f = fakeProc();
		const usage: unknown[] = [];
		wireDemuxedProcess({
			proc: f.proc,
			onFounderTurnCompleted: () => {},
			onTokenUsage: (params) => usage.push(params),
		});
		const params = {
			threadId: "raya-thread",
			turnId: "founder-turn",
			tokenUsage: { total: { totalTokens: 10 }, modelContextWindow: 1_000_000 },
		};
		f.fire("notification", "thread/tokenUsage/updated", params);
		f.fire("notification", "item/agentMessage/delta", {
			turnId: "founder-turn",
		});
		expect(usage).toEqual([params]);
	});
});

describe("awaitTurnCompletion (bootstrap turn isolation — review HIGH-2)", () => {
	it("resolves 'completed' when the matching turn completes", async () => {
		const f = fakeProc();
		const { facade, awaitTurnCompletion } = wireDemuxedProcess({
			proc: f.proc,
			onFounderTurnCompleted: () => {},
		});
		const id = await facade.startTurn({ threadId: "th", input: [] });
		const p = awaitTurnCompletion(id as string, 10_000);
		f.fire("turnCompleted", { turn: { id: "t1" } });
		await expect(p).resolves.toBe("completed");
	});

	it("ignores OTHER turns' completions (only its own id resolves it)", async () => {
		const f = fakeProc();
		const { facade, awaitTurnCompletion } = wireDemuxedProcess({
			proc: f.proc,
			onFounderTurnCompleted: () => {},
		});
		const id = await facade.startTurn({ threadId: "th", input: [] });
		const p = awaitTurnCompletion(id as string, 10_000);
		let resolved = false;
		void p.then(() => {
			resolved = true;
		});
		// a foreign completion routes to the observer, not our await
		f.fire("turnCompleted", { turn: { id: "founder-9" } });
		await Promise.resolve();
		expect(resolved).toBe(false);
		f.fire("turnCompleted", { turn: { id: "t1" } });
		await expect(p).resolves.toBe("completed");
	});

	it("completion-before-response: a turn completed during claim-replay still resolves 'completed' (review R2 HIGH-1)", async () => {
		const f = fakeProc();
		const { facade, awaitTurnCompletion } = wireDemuxedProcess({
			proc: f.proc,
			onFounderTurnCompleted: () => {},
		});
		// turn/completed arrives BEFORE the RPC response resolves — held by the
		// pending-dispatch window, replayed + consumed on claim, BEFORE the waiter
		// is ever registered.
		f.setStartTurn(async () => {
			f.fire("turnCompleted", { turn: { id: "t1" } });
			return "t1";
		});
		const id = await facade.startTurn({ threadId: "th", input: [] });
		expect(id).toBe("t1");
		// the waiter registers AFTER completion already happened → must still see it
		// (recently-completed set), not hang until the 90s timeout.
		await expect(awaitTurnCompletion("t1", 90_000)).resolves.toBe("completed");
	});

	it("resolves 'timeout' and tombstones the turn so a late delta is dropped", async () => {
		vi.useFakeTimers();
		try {
			const f = fakeProc();
			const { facade, awaitTurnCompletion } = wireDemuxedProcess({
				proc: f.proc,
				onFounderTurnCompleted: () => {},
			});
			const notif: unknown[] = [];
			facade.on("notification", (m, p) => notif.push([m, p]));
			const id = await facade.startTurn({ threadId: "th", input: [] });
			const p = awaitTurnCompletion(id as string, 90_000);
			await vi.advanceTimersByTimeAsync(90_000);
			await expect(p).resolves.toBe("timeout");
			// a straggler delta for the timed-out turn must NOT reach the executor
			f.fire("notification", "item/agentMessage/delta", {
				turnId: "t1",
				delta: "late",
			});
			expect(notif).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("isTurnlessRolloutError (self-heal predicate — review HIGH-3)", () => {
	it("true ONLY for a protocol error with rpcCode -32600 AND the phrase", () => {
		expect(
			isTurnlessRolloutError(
				new CodexLeadProcessError(
					"thread failed: no rollout found (code -32600)",
					"protocol",
					-32600,
				),
			),
		).toBe(true);
	});
	it("false when the rpc code is not -32600 (unrelated resume failure)", () => {
		expect(
			isTurnlessRolloutError(
				new CodexLeadProcessError("no rollout found", "protocol", -32000),
			),
		).toBe(false);
	});
	it("false for a plain Error containing the phrase (no structured code)", () => {
		expect(isTurnlessRolloutError(new Error("no rollout found"))).toBe(false);
	});
	it("false when code matches but the message does not (memory must not silently drop)", () => {
		expect(
			isTurnlessRolloutError(
				new CodexLeadProcessError("invalid request", "protocol", -32600),
			),
		).toBe(false);
	});
});

describe("requirePersona (fail-close at every read point — review R2 MED)", () => {
	const cfg = (files: string[]) =>
		({ systemPromptFiles: files }) as CodexLeadRuntimeConfig;
	it("returns undefined when no persona files are configured (byte-compat)", () => {
		expect(requirePersona(cfg([]))).toBeUndefined();
	});
	it("throws when persona files are configured but none is readable", () => {
		expect(() => requirePersona(cfg(["/no/such/persona-file-xyz.md"]))).toThrow(
			/no file was readable/,
		);
	});
});

describe("parseCodexLeadTuiRuntimeConfig", () => {
	const BASE = {
		FLYWHEEL_LEAD_ID: "mufasa-lead",
		FLYWHEEL_PROJECT_NAME: "growth",
		FLYWHEEL_LEAD_KEY: "growth-mufasa-lead",
		FLYWHEEL_LEAD_BACKEND: "codex-app-server",
		FLYWHEEL_LEAD_IDENTITY_DIGEST: "a".repeat(64),
		DISCORD_EXPECTED_BOT_USER_ID: "1",
		DISCORD_BOT_TOKEN: "tok",
		FLYWHEEL_LEAD_CHAT_CHANNEL_ID: "chan",
		FLYWHEEL_CODEX_LEAD_STATE_DIR: "/state",
		FLYWHEEL_COMM_DB: "/state/comm.db",
		FLYWHEEL_CODEX_BIN: "/bin/codex",
		CODEX_HOME: "/home/.codex-x",
	};
	it("requires FLYWHEEL_CODEX_TUI_CWD on top of the base config", () => {
		expect(() => parseCodexLeadTuiRuntimeConfig({ ...BASE })).toThrow(
			/FLYWHEEL_CODEX_TUI_CWD/,
		);
		const c = parseCodexLeadTuiRuntimeConfig({
			...BASE,
			FLYWHEEL_CODEX_TUI_CWD: "/work",
		});
		expect(c.tuiCwd).toBe("/work");
		expect(c.codexHome).toBe("/home/.codex-x");
	});
});
