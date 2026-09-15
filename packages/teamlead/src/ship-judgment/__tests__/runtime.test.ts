import { expect, it, vi } from "vitest";
import { canonicalDigest, type FrozenPacket } from "../contract.js";
import { readEpicJudgment } from "../epic-facts.js";
import { ShipJudgmentRuntime } from "../runtime.js";
import { bindingFixture, CHANNEL, HEAD, NOW } from "./binding-fixture.js";

it("connects scans to durable jobs, reuses semantic results, and blocks stale input and mode changes", async () => {
	const { store, db } = await bindingFixture();
	try {
		let mode = "dry_run";
		const packet: FrozenPacket = {
			questionId: "q",
			channelId: CHANNEL,
			bindingDigest: canonicalDigest(
				store.readShipJudgmentBinding("q", CHANNEL),
			),
			targets: [
				{
					repo_identity: "__main__",
					pr_number: 2399,
					head_sha: HEAD,
					diff_base_sha: "b".repeat(40),
				},
			],
			sources: [
				{
					source_id: "plan",
					kind: "plan",
					revision: "1",
					text: "R1: implement",
				},
			],
			files: [{ repo_identity: "__main__", path: "a.ts" }],
			requirements: [
				{
					requirement_id: "R1",
					source_id: "plan",
					quote_start: 0,
					quote_end: 13,
				},
			],
			prompt: "Evaluate",
			model: {
				model: "fixture",
				effort: "high",
				configuration_digest: "c".repeat(64),
			},
		};
		const evaluate = vi.fn(async () => ({
			spawned: true,
			evaluation: {
				alignment: "undetermined" as const,
				coverage: "undetermined" as const,
				result: {},
				resultCode: "model_failed",
				durationMs: 1,
				usage: null,
				costUsd: null,
			},
		}));
		const deliver = vi.fn(async () => {});
		const material = vi.fn(),
			unavailable = vi.fn();
		const runtime = new ShipJudgmentRuntime({
			store,
			owner: "fixture",
			mode: () => mode,
			collect: async () => ({
				status: "ready",
				packet: structuredClone(packet),
			}),
			evaluate,
			material,
			unavailable,
			deliver,
		});
		await runtime.scanner.tick();
		expect(store.getShipJudgmentJobs().queued()).toHaveLength(1);
		expect(deliver).toHaveBeenCalledTimes(1);
		// A changed issue body is a new input; the old job cannot evaluate it under its old identity.
		packet.sources[0]!.revision = "2";
		await runtime.worker.tick();
		expect(evaluate).not.toHaveBeenCalled();
		expect(store.getShipJudgmentJobs().queued()).toHaveLength(1);
		await runtime.worker.tick();
		expect(evaluate).toHaveBeenCalledTimes(1);
		await runtime.scanner.tick();
		await runtime.worker.tick();
		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(
			db.prepare("SELECT COUNT(*) AS n FROM ship_judgment_evaluation").get(),
		).toEqual({ n: 1 });
		packet.sources[0]!.revision = "3";
		await runtime.scanner.tick();
		expect(store.getShipJudgmentJobs().queued()).toHaveLength(1);
		const sentBeforeOff = deliver.mock.calls.length;
		mode = "off";
		await runtime.scanner.tick();
		await runtime.worker.tick();
		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(store.getShipJudgmentJobs().queued()).toHaveLength(1);
		expect(deliver).toHaveBeenCalledTimes(sentBeforeOff);
		await runtime.stop();
	} finally {
		store.close();
	}
});

it.each(["modeSweep", "learningSweep"] as const)(
	"joins in-flight %s on shutdown and never overlaps sweeps",
	async (lane) => {
		const { store } = await bindingFixture();
		try {
			const modeSweep = vi.fn(
				async (signal: AbortSignal) =>
					new Promise<void>((resolve) =>
						signal.addEventListener("abort", () => resolve(), { once: true }),
					),
			);
			const runtime = new ShipJudgmentRuntime({
				store,
				owner: "fixture",
				mode: () => "dry_run",
				collect: vi.fn(),
				evaluate: vi.fn(),
				material: vi.fn(),
				unavailable: vi.fn(),
				[lane]: modeSweep,
			});
			const first = runtime.modeTick();
			expect(runtime.modeTick()).toBe(first);
			await first;
			expect(modeSweep).toHaveBeenCalledOnce();
			await runtime.stop();
			await first;
			await runtime.modeTick();
			expect(modeSweep).toHaveBeenCalledOnce();
		} finally {
			store.close();
		}
	},
);

it("keeps observing while delivery hangs, and stop waits for abort cleanup", async () => {
	const { store } = await bindingFixture();
	const observer = store.getShipJudgmentOutcomes();
	const observe = vi.spyOn(observer, "observeCancellations").mockReturnValue(0);
	vi.spyOn(store, "getShipJudgmentOutcomes").mockReturnValue(observer);
	let cleanup!: () => void;
	let aborted = false;
	const modeSweep = vi.fn(
		(signal: AbortSignal) =>
			new Promise<void>((resolve) => {
				cleanup = resolve;
				signal.addEventListener(
					"abort",
					() => {
						aborted = true;
					},
					{ once: true },
				);
			}),
	);
	const runtime = new ShipJudgmentRuntime({
		store,
		owner: "fixture",
		mode: () => "auto_merge_narrow_gate",
		collect: vi.fn(),
		evaluate: vi.fn(),
		material: vi.fn(),
		unavailable: vi.fn(),
		modeSweep,
	});
	try {
		let finished = false;
		const first = runtime.modeTick().then(() => {
			finished = true;
		});
		for (let i = 0; i < 5; i++)
			await new Promise<void>((resolve) => setImmediate(resolve));
		expect(finished).toBe(true);
		await first;
		await runtime.modeTick();
		expect(observe).toHaveBeenCalledTimes(2);
		expect(modeSweep).toHaveBeenCalledOnce();
		let stopped = false;
		const stopping = runtime.stop().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(aborted).toBe(true);
		expect(stopped).toBe(false);
		cleanup();
		await stopping;
	} finally {
		cleanup?.();
		await runtime.stop();
		store.close();
	}
});

it("rechecks off after yielding and clears the local latch without network dependencies", async () => {
	const { store } = await bindingFixture();
	let mode = "auto_merge_narrow_gate";
	const observer = store.getShipJudgmentOutcomes();
	const verdicts = vi
		.spyOn(observer, "observeVerdicts")
		.mockImplementation(() => {
			setImmediate(() => {
				mode = "off";
			});
			return 0;
		});
	const cancellations = vi
		.spyOn(observer, "observeCancellations")
		.mockReturnValue(0);
	vi.spyOn(store, "getShipJudgmentOutcomes").mockReturnValue(observer);
	const runtime = new ShipJudgmentRuntime({
		store,
		owner: "fixture",
		mode: () => mode,
		collect: vi.fn(),
		evaluate: vi.fn(),
		material: vi.fn(),
		unavailable: vi.fn(),
	});
	try {
		await runtime.modeTick();
		expect(cancellations).not.toHaveBeenCalled();
		verdicts.mockReturnValue(0);
		mode = "auto_merge_narrow_gate";
		await runtime.modeTick();
		await runtime.modeTick();
		expect(cancellations).toHaveBeenCalledTimes(2);
	} finally {
		await runtime.stop();
		store.close();
	}
});

it.each(["observeVerdicts", "observeCancellations"] as const)(
	"isolates %s failures from other decision sources and mode history",
	async (failed) => {
		const { store } = await bindingFixture();
		try {
			const observer = store.getShipJudgmentOutcomes();
			const verdicts = vi.spyOn(observer, "observeVerdicts").mockReturnValue(0);
			const cancellations = vi
				.spyOn(observer, "observeCancellations")
				.mockReturnValue(0);
			(failed === "observeVerdicts"
				? verdicts
				: cancellations
			).mockImplementation(() => {
				throw new Error("fixture failure");
			});
			vi.spyOn(store, "getShipJudgmentOutcomes").mockReturnValue(observer);
			const modeSweep = vi.fn(async () => {}),
				onError = vi.fn();
			const runtime = new ShipJudgmentRuntime({
				store,
				owner: "fixture",
				mode: () => "dry_run",
				collect: vi.fn(),
				evaluate: vi.fn(),
				material: vi.fn(),
				unavailable: vi.fn(),
				modeSweep,
				onError,
			});
			await runtime.modeTick();
			await runtime.stop();
			expect(verdicts).toHaveBeenCalledOnce();
			expect(cancellations).toHaveBeenCalledOnce();
			expect(modeSweep).toHaveBeenCalledOnce();
			expect(onError).toHaveBeenCalledExactlyOnceWith(
				failed === "observeVerdicts"
					? "verdict_observation_failed"
					: "cancellation_observation_failed",
			);
		} finally {
			store.close();
		}
	},
);

it("uses the actual interval for local pages while a timed-out transport retains its single flight", async () => {
	const { store } = await bindingFixture();
	vi.useFakeTimers({
		toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"],
	});
	let cleanup!: () => void;
	let signal!: AbortSignal;
	const observer = store.getShipJudgmentOutcomes();
	const cancellations = vi
		.spyOn(observer, "observeCancellations")
		.mockReturnValue(0);
	vi.spyOn(store, "getShipJudgmentOutcomes").mockReturnValue(observer);
	const modeSweep = vi.fn((input: AbortSignal) => {
		signal = input;
		return new Promise<void>((resolve) => {
			cleanup = resolve;
		});
	});
	const runtime = new ShipJudgmentRuntime({
		store,
		owner: "fixture",
		mode: () => "auto_merge_narrow_gate",
		collect: vi.fn(),
		evaluate: vi.fn(),
		material: vi.fn(),
		unavailable: vi.fn(),
		modeSweep,
	});
	// These independent loops have their own tests; exercise the mode interval.
	vi.spyOn(runtime.scanner, "start").mockImplementation(() => {});
	vi.spyOn(runtime.worker, "start").mockImplementation(() => {});
	try {
		runtime.start();
		await runtime.modeTick();
		expect(cancellations).toHaveBeenCalledTimes(1);
		for (let i = 0; i < 5; i++) {
			vi.advanceTimersByTime(3_000);
			await runtime.modeTick();
		}
		expect(cancellations).toHaveBeenCalledTimes(6);
		expect(signal.aborted).toBe(true);
		expect(modeSweep).toHaveBeenCalledOnce();
		cleanup();
		await runtime.stop();
	} finally {
		cleanup?.();
		await runtime.stop();
		vi.useRealTimers();
		store.close();
	}
});

it("off performs no observation, writes, delivery or model calls", async () => {
	const { store, db } = await bindingFixture();
	const observer = vi.spyOn(store, "getShipJudgmentOutcomes");
	const collect = vi.fn(),
		evaluate = vi.fn(),
		learningSweep = vi.fn(),
		modeSweep = vi.fn();
	const runtime = new ShipJudgmentRuntime({
		store,
		owner: "fixture",
		mode: () => "off",
		collect,
		evaluate,
		learningSweep,
		modeSweep,
		material: vi.fn(),
		unavailable: vi.fn(),
	});
	try {
		const before = db.prepare("SELECT total_changes() AS n").get();
		await runtime.modeTick();
		await runtime.scanner.tick();
		await runtime.worker.tick();
		expect(observer).not.toHaveBeenCalled();
		expect(collect).not.toHaveBeenCalled();
		expect(evaluate).not.toHaveBeenCalled();
		expect(learningSweep).not.toHaveBeenCalled();
		expect(modeSweep).not.toHaveBeenCalled();
		expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
	} finally {
		await runtime.stop();
		store.close();
	}
});

it("off closes existing opinion accounting as history without observation or transport", async () => {
	const { store, db } = await bindingFixture();
	const now = Date.parse(NOW);
	const binding = store.readShipJudgmentBinding("q", CHANNEL)!;
	store.getShipJudgmentOpinions().offer(
		{
			questionId: "q",
			channelId: CHANNEL,
			bindingDigest: canonicalDigest(binding),
			inputId: null,
			reason: "missing",
			mechanical: {
				verdict: "undetermined",
				reason: "missing",
				digest: "a".repeat(64),
				checkedAt: NOW,
				scope: "main",
				checkedRepos: 0,
				openPrCount: null,
				overlaps: [],
			},
		},
		now,
	);
	const delivery = store.getShipJudgmentDelivery();
	const post = delivery.claim("q", CHANNEL, "sender", now);
	if (post.status !== "claimed") throw new Error(post.status);
	expect(delivery.confirm(post, "123456789012345681", NOW, now)).toBe(true);
	expect(readEpicJudgment(db, "flywheel", ["FLY-2399"]).value?.display).toBe(
		"published",
	);
	const observer = vi.spyOn(store, "getShipJudgmentOutcomes"),
		collect = vi.fn(),
		evaluate = vi.fn(),
		learningSweep = vi.fn(),
		modeSweep = vi.fn();
	const runtime = new ShipJudgmentRuntime({
		store,
		owner: "fixture",
		mode: () => "off",
		now: () => now + 1,
		collect,
		evaluate,
		learningSweep,
		modeSweep,
		material: vi.fn(),
		unavailable: vi.fn(),
	});
	try {
		await runtime.modeTick();
		expect(readEpicJudgment(db, "flywheel", ["FLY-2399"]).value?.display).toBe(
			"history",
		);
		expect(
			db
				.prepare(
					"SELECT delivery_mode,message_id FROM ship_judgment_delivery WHERE purpose='opinion'",
				)
				.get(),
		).toEqual({ delivery_mode: "off", message_id: "123456789012345681" });
		const after = db.prepare("SELECT total_changes() AS n").get();
		await runtime.modeTick();
		await runtime.scanner.tick();
		await runtime.worker.tick();
		expect(db.prepare("SELECT total_changes() AS n").get()).toEqual(after);
		for (const fn of [observer, collect, evaluate, learningSweep, modeSweep])
			expect(fn).not.toHaveBeenCalled();
	} finally {
		await runtime.stop();
		store.close();
	}
});
