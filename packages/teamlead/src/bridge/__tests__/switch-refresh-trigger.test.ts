import { describe, expect, it } from "vitest";
import type { SwitchRecord } from "../switch-record.js";
import {
	createClaudeSweepRequester,
	createSwitchRefreshTrigger,
	type SwitchRefreshTriggerDeps,
} from "../switch-refresh-trigger.js";

function deferred() {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function harness(overrides: Partial<SwitchRefreshTriggerDeps> = {}) {
	const state = {
		codex: 1 as number | null,
		claude: 10 as number | null,
		now: Date.parse("2026-09-25T20:00:00.000Z"),
		claudeReads: 0,
		sweeps: [] as string[],
		refreshes: 0,
		lines: [] as string[],
		persisted: [] as SwitchRecord[],
		order: [] as string[],
	};
	const deps: SwitchRefreshTriggerDeps = {
		readCodexGeneration: () => state.codex,
		readClaudeGeneration: () => {
			state.claudeReads += 1;
			return state.claude;
		},
		requestClaudeSweep: (reason) => {
			state.sweeps.push(reason);
			state.order.push("sweep");
			return { sweepRequest: "ok", wake: "signaled" };
		},
		refreshBridge: async () => {
			state.refreshes += 1;
			state.order.push("refresh");
		},
		persistSwitchRecord: (record) => {
			state.order.push("persist");
			state.persisted.push(record);
		},
		readPersistedSwitchRecord: () => null,
		now: () => state.now,
		log: (line) => state.lines.push(line),
		...overrides,
	};
	const trigger = createSwitchRefreshTrigger(deps);
	return { state, trigger };
}

describe("FLY-2830 SwitchRefreshTrigger", () => {
	it("records the first reading as the baseline without refreshing", async () => {
		const { state, trigger } = harness();
		trigger.tick();
		await trigger.settled();
		expect(state.sweeps).toEqual([]);
		expect(state.refreshes).toBe(0);
		expect(trigger.latestSwitchRecord()).toBeNull();
	});

	it("refreshes once, both legs, when the Codex generation moves up", async () => {
		const { state, trigger } = harness();
		trigger.tick();
		state.codex = 2;
		state.now += 3_000;
		trigger.tick();
		await trigger.settled();
		expect(state.sweeps).toEqual(["codex_switch"]);
		expect(state.refreshes).toBe(1);
		expect(state.lines).toContain(
			"[switch-refresh] reason=codex_switch codexGen=2 claudeGen=10 sweepRequest=ok wake=signaled bridgeRefresh=ok",
		);
		// The record is written (memory first, then disk) before any refresh leg.
		expect(state.order.slice(0, 1)).toEqual(["persist"]);
		expect(trigger.latestSwitchRecord()).toEqual({
			schemaVersion: 1,
			codex: { generation: 2, observedAt: "2026-09-25T20:00:03.000Z" },
			claude: null,
		});
	});

	it("reads the Claude generation at most once per 10 s and triggers claude_switch", async () => {
		const { state, trigger } = harness();
		trigger.tick();
		state.claude = 11;
		state.now += 3_000;
		trigger.tick();
		expect(state.claudeReads).toBe(1);
		state.now += 7_000;
		trigger.tick();
		await trigger.settled();
		expect(state.claudeReads).toBe(2);
		expect(state.sweeps).toEqual(["claude_switch"]);
	});

	it("re-baselines on a legitimate rewind without refreshing, then triggers on the next rise", async () => {
		const { state, trigger } = harness();
		trigger.tick();
		state.codex = 0;
		state.now += 3_000;
		trigger.tick();
		await trigger.settled();
		expect(state.refreshes).toBe(0);
		expect(
			state.lines.some((l) => l.includes("codex_generation_rewound")),
		).toBe(true);
		state.codex = 1;
		state.now += 3_000;
		trigger.tick();
		await trigger.settled();
		expect(state.sweeps).toEqual(["codex_switch"]);
	});

	it("keeps the baseline and does not refresh while a read fails", async () => {
		const { state, trigger } = harness({
			readCodexGeneration: () => {
				if (state.codex === null) throw new Error("db closed");
				return state.codex;
			},
		});
		trigger.tick();
		state.codex = null;
		state.now += 3_000;
		trigger.tick();
		trigger.tick();
		await trigger.settled();
		expect(state.refreshes).toBe(0);
		expect(
			state.lines.filter((l) => l.includes("codex_generation_unreadable")),
		).toHaveLength(1);
		state.codex = 2;
		state.now += 3_000;
		trigger.tick();
		await trigger.settled();
		expect(state.sweeps).toEqual(["codex_switch"]);
	});

	it("still runs the Bridge refresh when the sweep request leg throws, and vice versa", async () => {
		const first = harness({
			requestClaudeSweep: () => {
				throw new Error("sweep_write_failed");
			},
		});
		first.trigger.tick();
		first.state.codex = 2;
		first.trigger.tick();
		await first.trigger.settled();
		expect(first.state.refreshes).toBe(1);
		expect(first.state.lines.at(-1)).toContain(
			"sweepRequest=failed:sweep_write_failed wake=signal_failed bridgeRefresh=ok",
		);

		const second = harness({
			refreshBridge: async () => {
				throw new Error("codex_round_timeout");
			},
		});
		second.trigger.tick();
		second.state.codex = 2;
		second.trigger.tick();
		await second.trigger.settled();
		expect(second.state.sweeps).toEqual(["codex_switch"]);
		expect(second.state.lines.at(-1)).toContain(
			"sweepRequest=ok wake=signaled bridgeRefresh=failed:codex_round_timeout",
		);
	});

	it("runs exactly one trailing round for switches that arrive while one is in flight", async () => {
		const gates = [deferred(), deferred()];
		let call = 0;
		const { state, trigger } = harness({
			refreshBridge: () => {
				state.refreshes += 1;
				return gates[call++]!.promise;
			},
		});
		trigger.tick();
		state.codex = 2;
		trigger.tick();
		state.codex = 3;
		trigger.tick();
		state.codex = 4;
		trigger.tick();
		await new Promise((r) => setTimeout(r, 0));
		expect(state.refreshes).toBe(1);
		gates[0]!.resolve();
		await new Promise((r) => setTimeout(r, 0));
		expect(state.refreshes).toBe(2);
		gates[1]!.resolve();
		await trigger.settled();
		expect(state.refreshes).toBe(2);
		expect(state.sweeps).toEqual(["codex_switch", "codex_switch"]);
	});

	it("keeps the in-process record and still refreshes when the disk write fails", async () => {
		const { state, trigger } = harness({
			persistSwitchRecord: () => {
				throw new Error("EROFS");
			},
		});
		trigger.tick();
		state.codex = 2;
		trigger.tick();
		await trigger.settled();
		expect(state.refreshes).toBe(1);
		expect(trigger.latestSwitchRecord()?.codex?.generation).toBe(2);
		expect(state.lines).toContain("[switch-record] persist_failed");
	});

	it("merges the vendor entry into the persisted record instead of dropping the other vendor", async () => {
		const persisted: SwitchRecord = {
			schemaVersion: 1,
			codex: null,
			claude: { generation: 10, observedAt: "2026-09-25T19:00:00.000Z" },
		};
		const { state, trigger } = harness({
			readPersistedSwitchRecord: () => persisted,
		});
		trigger.tick();
		state.codex = 2;
		trigger.tick();
		await trigger.settled();
		expect(state.persisted.at(-1)).toEqual({
			schemaVersion: 1,
			codex: { generation: 2, observedAt: "2026-09-25T20:00:00.000Z" },
			claude: { generation: 10, observedAt: "2026-09-25T19:00:00.000Z" },
		});
	});
});

describe("FLY-2830 Claude sweep requester", () => {
	it("writes the request, then wakes the daemon even if the write failed", () => {
		const calls: string[] = [];
		const ok = createClaudeSweepRequester({
			write: (input) => {
				calls.push(`write:${input.reason}`);
			},
			wake: () => {
				calls.push("wake");
				return "throttled";
			},
		});
		expect(ok("claude_switch")).toEqual({
			sweepRequest: "ok",
			wake: "throttled",
		});
		const failing = createClaudeSweepRequester({
			write: () => {
				throw new Error("/Users/x/secret path EACCES");
			},
			wake: () => "signaled",
		});
		expect(failing("codex_switch")).toEqual({
			sweepRequest: "failed:error",
			wake: "signaled",
		});
		expect(calls).toEqual(["write:claude_switch", "wake"]);
	});
});
