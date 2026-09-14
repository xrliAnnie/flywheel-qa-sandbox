import { expect, it, vi } from "vitest";
import { historyContentDigest } from "../history-pages.js";
import { ShipJudgmentHistoryRuntime } from "../history-runtime.js";
import { bindingFixture, NOW } from "./binding-fixture.js";

it("publishes backward, reuses verified pages after failure and does zero network work for unchanged content", async () => {
	const { store } = await bindingFixture();
	try {
		let now = Date.parse(NOW),
			sequence = 0,
			fail = true;
		const base = store.getShipJudgmentHistory().read(NOW);
		const rows = Array.from({ length: 21 }, (_, n) => ({
			...base.rows[0]!,
			questionId: "q" + n,
		}));
		const snapshot = { ...base, rows, digest: historyContentDigest(rows) };
		const calls: string[] = [];
		const publisher = {
			origin: () => "https://reports.example.com",
			stage: vi.fn(async (html: string) => {
				const page = html.includes("第 2 / 2 页") ? "2" : "1";
				calls.push("stage" + page);
				const token = String(++sequence).padStart(32, "0");
				return {
					token,
					url: "https://reports.example.com/r/" + token + "/",
					html,
					createdAt: new Date(now).toISOString(),
				};
			}),
			publish: vi.fn(async (page: { html: string }) => {
				calls.push("publish" + (page.html.includes("第 2 / 2 页") ? "2" : "1"));
			}),
			verify: vi.fn(async (page: { html: string }) => {
				const number = page.html.includes("第 2 / 2 页") ? "2" : "1";
				calls.push("verify" + number);
				if (number === "1" && fail)
					throw new Error("fixture verification failure");
			}),
		};
		const onChanged = vi.fn();
		const deps = {
			state: store.getShipJudgmentHistoryState(),
			reader: { read: () => snapshot },
			publisher,
			now: () => now,
			onChanged,
		};
		const first = new ShipJudgmentHistoryRuntime(deps);
		expect((await first.run()).status).toBe("failed");
		expect(calls).toEqual([
			"stage2",
			"publish2",
			"verify2",
			"stage1",
			"publish1",
			"verify1",
		]);
		expect(deps.state.view().url).toBeNull();
		expect((await first.run()).status).toBe("deferred");
		now += 1800000;
		fail = false;
		calls.length = 0;
		const resumed = new ShipJudgmentHistoryRuntime(deps);
		expect((await resumed.run()).status).toBe("published");
		expect(calls).toEqual(["publish1", "verify1"]);
		expect(publisher.stage).toHaveBeenCalledTimes(2);
		expect(deps.state.view()).toMatchObject({ asOf: NOW, error: null });
		now += 1800000;
		calls.length = 0;
		expect((await resumed.run()).status).toBe("unchanged");
		expect(calls).toEqual([]);
		expect(onChanged).toHaveBeenCalledTimes(2);
		await first.stop();
		await resumed.stop();
	} finally {
		store.close();
	}
});
it("enforces whole-round timeout and shutdown even when a publisher ignores cancellation", async () => {
	vi.useFakeTimers({ now: Date.parse(NOW) });
	const { store } = await bindingFixture();
	try {
		let release!: () => void;
		const stage = vi.fn(
			() =>
				new Promise<never>((resolve) => {
					release = () => resolve({} as never);
				}),
		);
		const runtime = new ShipJudgmentHistoryRuntime({
			state: store.getShipJudgmentHistoryState(),
			reader: store.getShipJudgmentHistory(),
			publisher: {
				origin: () => "https://reports.example.com",
				stage,
				publish: vi.fn(),
				verify: vi.fn(),
			},
			now: Date.now,
		});
		const pending = runtime.run();
		await vi.advanceTimersByTimeAsync(120001);
		expect((await pending).status).toBe("failed");
		expect(store.getShipJudgmentHistoryState().view()).toMatchObject({
			url: null,
			error: "history_round_timeout",
		});
		release();
		await Promise.resolve();
		await Promise.resolve();
		expect(store.getShipJudgmentHistoryState().view().url).toBeNull();
		await runtime.stop();
	} finally {
		store.close();
		vi.useRealTimers();
	}
});

it("checks independently each minute, honors the durable interval, and stops its timer", async () => {
	vi.useFakeTimers({ now: Date.parse(NOW) });
	const { store } = await bindingFixture();
	try {
		const snapshot = store.getShipJudgmentHistory().read(NOW);
		const read = vi.fn(() => snapshot),
			stage = vi.fn(async (html: string) => ({
				token: "a".repeat(32),
				url: "https://reports.example.com/r/" + "a".repeat(32) + "/",
				html,
				createdAt: new Date().toISOString(),
			}));
		const runtime = new ShipJudgmentHistoryRuntime({
			state: store.getShipJudgmentHistoryState(),
			reader: { read },
			publisher: {
				origin: () => "https://reports.example.com",
				stage,
				publish: vi.fn(),
				verify: vi.fn(),
			},
			now: Date.now,
		});
		runtime.start();
		await runtime.run();
		expect(read).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(29 * 60000);
		expect(read).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(60000);
		expect(read).toHaveBeenCalledTimes(2);
		expect(stage).toHaveBeenCalledOnce();
		await runtime.stop();
		await vi.advanceTimersByTimeAsync(1800000);
		expect(read).toHaveBeenCalledTimes(2);
	} finally {
		store.close();
		vi.useRealTimers();
	}
});
it("shutdown aborts an active round without waiting for an unresponsive dependency", async () => {
	const { store } = await bindingFixture();
	try {
		const runtime = new ShipJudgmentHistoryRuntime({
			state: store.getShipJudgmentHistoryState(),
			reader: store.getShipJudgmentHistory(),
			publisher: {
				origin: () => "https://reports.example.com",
				stage: () => new Promise(() => {}),
				publish: vi.fn(),
				verify: vi.fn(),
			},
		});
		const pending = runtime.run();
		await runtime.stop();
		expect((await pending).status).toBe("failed");
		expect(store.getShipJudgmentHistoryState().view()).toMatchObject({
			url: null,
			error: "history_round_canceled",
		});
		expect((await runtime.run()).status).toBe("stopped");
	} finally {
		store.close();
	}
});

it("reports state-store failures without rejecting the background tick or exposing exception text", async () => {
	const { store } = await bindingFixture();
	try {
		const state = store.getShipJudgmentHistoryState(),
			onError = vi.fn();
		vi.spyOn(state, "claim").mockImplementationOnce(() => {
			throw new Error("private database details");
		});
		const runtime = new ShipJudgmentHistoryRuntime({
			state,
			reader: store.getShipJudgmentHistory(),
			publisher: {
				origin: () => "https://reports.example.com",
				stage: vi.fn(),
				publish: vi.fn(),
				verify: vi.fn(),
			},
			onError,
		});
		await expect(runtime.run()).resolves.toMatchObject({ status: "failed" });
		expect(onError).toHaveBeenCalledWith("history_state_unavailable");
		expect(JSON.stringify(onError.mock.calls)).not.toContain(
			"private database",
		);
		await runtime.stop();
	} finally {
		store.close();
	}
});
