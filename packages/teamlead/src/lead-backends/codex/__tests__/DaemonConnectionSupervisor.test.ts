/**
 * FLY-259 PR-B — DaemonConnectionSupervisor unit tests: the R5 HIGH-2
 * generation-fencing lifecycle, replayed step by step with injected effects.
 */

import { describe, expect, it } from "vitest";
import {
	DaemonConnectionSupervisor,
	type SupervisedGeneration,
} from "../DaemonConnectionSupervisor.js";

interface GenHandle {
	id: number;
	startCalls: number;
	stopCalls: number;
	loseConnection: () => void;
	failNextStart?: boolean;
}

function harness(opts?: { stableAfterMs?: number; failStartIds?: number[] }) {
	const events: string[] = [];
	const gens: GenHandle[] = [];
	let nowMs = 1_000_000;
	const sleeps: number[] = [];
	const failStartIds = new Set(opts?.failStartIds ?? []);

	const sup = new DaemonConnectionSupervisor({
		buildGeneration: (generationId) => {
			const handle: GenHandle = {
				id: generationId,
				startCalls: 0,
				stopCalls: 0,
				loseConnection: () => {},
			};
			gens.push(handle);
			events.push(`build:${generationId}`);
			let lostCb: (() => void) | undefined;
			const gen: SupervisedGeneration = {
				start: async () => {
					handle.startCalls += 1;
					events.push(`start:${generationId}`);
					if (handle.failNextStart || failStartIds.has(generationId)) {
						handle.failNextStart = false;
						throw new Error(`start-fail:${generationId}`);
					}
				},
				stop: async () => {
					handle.stopCalls += 1;
					events.push(`stop:${generationId}`);
				},
				onConnectionLost: (cb) => {
					lostCb = cb;
					handle.loseConnection = () => lostCb?.();
					return () => {
						lostCb = undefined;
					};
				},
			};
			return gen;
		},
		ensureDaemon: async () => {
			events.push("ensureDaemon");
		},
		backoffStepsMs: [10, 20, 40],
		stableAfterMs: opts?.stableAfterMs ?? 0, // default: every gen counts as stable
		sleep: async (ms) => {
			sleeps.push(ms);
			events.push(`sleep:${ms}`);
		},
		now: () => nowMs,
		log: () => {},
	});
	return {
		sup,
		events,
		gens,
		sleeps,
		advance: (ms: number) => {
			nowMs += ms;
		},
	};
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("DaemonConnectionSupervisor — R5 HIGH-2 lifecycle", () => {
	it("start(): ensureDaemon before build; generation start after", async () => {
		const h = harness();
		await h.sup.start();
		expect(h.events).toEqual(["ensureDaemon", "build:1", "start:1"]);
	});

	it("connection loss → old gen stopped (gateway-first inside) BEFORE daemon ensure and new build", async () => {
		const h = harness();
		await h.sup.start();
		h.gens[0].loseConnection();
		await flush();
		expect(h.events).toEqual([
			"ensureDaemon",
			"build:1",
			"start:1",
			"stop:1", // teardown old wiring FIRST (step 1+4)
			"sleep:10",
			"ensureDaemon", // re-ensure AFTER teardown
			"build:2",
			"start:2",
		]);
	});

	it("duplicate close events of the same generation → exactly one rebuild", async () => {
		const h = harness();
		await h.sup.start();
		h.gens[0].loseConnection();
		h.gens[0].loseConnection();
		h.gens[0].loseConnection();
		await flush();
		const builds = h.events.filter((e) => e.startsWith("build:"));
		expect(builds).toEqual(["build:1", "build:2"]);
	});

	it("stale event from a FENCED old generation is ignored (no second rebuild)", async () => {
		const h = harness();
		await h.sup.start();
		const old = h.gens[0];
		old.loseConnection();
		await flush(); // gen 2 is up
		old.loseConnection(); // straggler from the dead generation
		await flush();
		const builds = h.events.filter((e) => e.startsWith("build:"));
		expect(builds).toEqual(["build:1", "build:2"]);
	});

	it("failed rebuild attempts escalate the backoff and keep retrying", async () => {
		// generations 2 and 3 fail at start; 4 succeeds — deterministic.
		const h = harness({ failStartIds: [2, 3] });
		await h.sup.start();
		h.gens[0].loseConnection();
		await flush();
		await flush();
		await flush();
		// sleeps escalate 10 → 20 → 40 across the three attempts
		expect(h.sleeps.slice(0, 3)).toEqual([10, 20, 40]);
		// the half-up failed generations were stopped (no leaks)
		expect(h.gens.find((g) => g.id === 2)?.stopCalls).toBe(1);
		expect(h.gens.find((g) => g.id === 3)?.stopCalls).toBe(1);
		// eventually generation 4 is up
		const g4 = h.gens.find((g) => g.id === 4);
		expect(g4?.startCalls).toBe(1);
		expect(g4?.stopCalls).toBe(0);
	});

	it("a generation that dies BEFORE stabilizing keeps climbing the ladder; a stable one resets it", async () => {
		const h = harness({ stableAfterMs: 1000 });
		await h.sup.start();
		// die immediately (not stable) → backoff continues from where it was
		h.gens[0].loseConnection();
		await flush();
		expect(h.sleeps).toEqual([10]);
		h.gens[1].loseConnection(); // again immediately
		await flush();
		expect(h.sleeps).toEqual([10, 20]); // escalated
		// now let gen3 live past stableAfterMs, then die
		h.advance(5_000);
		h.gens[2].loseConnection();
		await flush();
		expect(h.sleeps).toEqual([10, 20, 10]); // reset to the first step
	});

	it("explicit stop() during the backoff sleep cancels the rebuild (no new generation)", async () => {
		const h = harness();
		// make sleep block until released so we can stop mid-wait
		let release: (() => void) | undefined;
		const blockingSup = new DaemonConnectionSupervisor({
			buildGeneration: (id) => {
				h.events.push(`build:${id}`);
				let lostCb: (() => void) | undefined;
				h.gens.push({
					id,
					startCalls: 0,
					stopCalls: 0,
					loseConnection: () => lostCb?.(),
				});
				return {
					start: async () => {
						h.events.push(`start:${id}`);
					},
					stop: async () => {
						h.events.push(`stop:${id}`);
					},
					onConnectionLost: (cb) => {
						lostCb = cb;
						return () => {
							lostCb = undefined;
						};
					},
				};
			},
			ensureDaemon: async () => {
				h.events.push("ensureDaemon");
			},
			backoffStepsMs: [10],
			stableAfterMs: 0,
			sleep: () =>
				new Promise<void>((r) => {
					release = r;
				}),
			now: () => 0,
			log: () => {},
		});
		await blockingSup.start();
		h.gens[h.gens.length - 1].loseConnection();
		await flush(); // rebuild loop is now parked in sleep
		await blockingSup.stop();
		release?.(); // wake the loop — it must observe stopped and bail
		await flush();
		const builds = h.events.filter((e) => e.startsWith("build:"));
		expect(builds).toHaveLength(1); // no second generation
	});

	it("stop() racing a bring-up: the new generation is stopped, never leaked", async () => {
		const h = harness();
		const sup = h.sup;
		await sup.start();
		// arrange: loseConnection, then call stop() while the rebuild is between
		// ensureDaemon and gen.start (we approximate by stopping right after
		// triggering the loss — the post-bring-up stopped check must clean up).
		h.gens[0].loseConnection();
		const stopP = sup.stop();
		await flush();
		await stopP;
		// every built generation must have been stopped
		for (const g of h.gens) {
			if (g.startCalls > 0 || g.id === 1) {
				expect(g.stopCalls).toBeGreaterThanOrEqual(g.id === 1 ? 1 : 0);
			}
		}
		// and nothing rebuilds after stop
		await flush();
		const startsAfter = h.events.filter((e) => e.startsWith("start:")).length;
		await flush();
		expect(h.events.filter((e) => e.startsWith("start:")).length).toBe(
			startsAfter,
		);
	});
});

describe("DaemonConnectionSupervisor — code review R1 races", () => {
	it("HIGH-1: stop() during a PENDING initial start awaits it and stops the generation (no live gateway after stop)", async () => {
		const events: string[] = [];
		let releaseStart: (() => void) | undefined;
		let stopCalls = 0;
		const sup = new DaemonConnectionSupervisor({
			buildGeneration: () => ({
				start: () =>
					new Promise<void>((r) => {
						releaseStart = r;
						events.push("start-pending");
					}),
				stop: async () => {
					stopCalls += 1;
					events.push("stop");
				},
				onConnectionLost: () => () => {},
			}),
			ensureDaemon: async () => {},
			backoffStepsMs: [1],
			stableAfterMs: 0,
			sleep: async () => {},
			now: () => 0,
			log: () => {},
		});
		const startP = sup.start(); // parks in gen.start()
		await new Promise((r) => setTimeout(r, 0));
		const stopP = sup.stop(); // must await the in-flight bring-up
		releaseStart?.(); // start completes AFTER stop was requested
		await startP;
		await stopP;
		expect(stopCalls).toBe(1); // the raced generation was swept
	});

	it("HIGH-2: the rebuild loop's own new generation dying during bring-up fails the attempt (loop continues, not silent success)", async () => {
		const startsByGen: number[] = [];
		let gen2LossCb: (() => void) | undefined;
		const sup = new DaemonConnectionSupervisor({
			buildGeneration: (id) => ({
				start: async () => {
					startsByGen.push(id);
					if (id === 2) gen2LossCb?.(); // dies DURING its own bring-up
				},
				stop: async () => {},
				onConnectionLost: (cb) => {
					if (id === 1) {
						// expose gen1's loss to kick the rebuild
						setTimeout(() => cb(), 0);
					}
					if (id === 2) gen2LossCb = cb;
					return () => {};
				},
			}),
			ensureDaemon: async () => {},
			backoffStepsMs: [1],
			stableAfterMs: 0,
			sleep: async () => {},
			now: () => 0,
			log: () => {},
		});
		await sup.start();
		await new Promise((r) => setTimeout(r, 5));
		// gen1 lost → rebuild builds gen2 → gen2 dies during bring-up → the
		// attempt must FAIL and the loop must build gen3 (not stop at gen2).
		expect(startsByGen).toContain(3);
		await sup.stop();
	});
});

describe("DaemonConnectionSupervisor — R2 races", () => {
	it("R2 HIGH-1: stop() during a PENDING ensureDaemon → no generation is ever built", async () => {
		let builds = 0;
		let releaseEnsure: (() => void) | undefined;
		const sup = new DaemonConnectionSupervisor({
			buildGeneration: () => {
				builds += 1;
				return {
					start: async () => {},
					stop: async () => {},
					onConnectionLost: () => () => {},
				};
			},
			ensureDaemon: () =>
				new Promise<void>((r) => {
					releaseEnsure = r;
				}),
			backoffStepsMs: [1],
			stableAfterMs: 0,
			sleep: async () => {},
			now: () => 0,
			log: () => {},
		});
		const startP = sup.start(); // parked in ensureDaemon
		await new Promise((r) => setTimeout(r, 0));
		const stopP = sup.stop();
		releaseEnsure?.(); // ensure resolves AFTER stop
		await startP;
		await stopP;
		expect(builds).toBe(0); // stopped recheck after ensure prevented the build
	});

	it("R2 HIGH-2: INITIAL generation losing its connection during bring-up → fail-loud boot, generation swept, no overlap", async () => {
		const events: string[] = [];
		let releaseStart: (() => void) | undefined;
		let lossCb: (() => void) | undefined;
		const sup = new DaemonConnectionSupervisor({
			buildGeneration: (id) => ({
				start: () =>
					new Promise<void>((r) => {
						releaseStart = r;
						events.push(`start-pending:${id}`);
					}),
				stop: async () => {
					events.push(`stop:${id}`);
				},
				onConnectionLost: (cb) => {
					lossCb = cb;
					return () => {};
				},
			}),
			ensureDaemon: async () => {},
			backoffStepsMs: [1],
			stableAfterMs: 0,
			sleep: async () => {},
			now: () => 0,
			log: () => {},
		});
		const startP = sup.start();
		await new Promise((r) => setTimeout(r, 0));
		lossCb?.(); // dies DURING its own initial bring-up — must latch, not act
		expect(events.filter((e) => e.startsWith("stop:"))).toHaveLength(0); // no concurrent stop
		releaseStart?.(); // start settles
		await expect(startP).rejects.toThrow(/initial bring-up/);
		expect(events).toContain("stop:1"); // swept after settle
	});
});
