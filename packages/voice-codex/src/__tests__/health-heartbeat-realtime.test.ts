import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	VoiceHealthHelperClient,
	VoiceHealthReporter,
	type VoiceHealthSuccessLog,
} from "../health.js";

const BOOT_ID = "22222222-2222-4222-8222-222222222222";

// FLY-2693 R3: production polls every 5 s, which is shorter than the 20 s
// idle_success aggregate window, so every success after the first lands in the
// aggregate branch and reaches the ledger through the timer-driven flush.
// QA attempt 2 proved on a real daemon that this path never produced a heartbeat
// (256 s / 48 successes / 0 heartbeat lines). This regression uses the real
// helper, real SQLite, real setTimeout and the wall clock; no fake clocks.
const PRODUCTION_IDLE_POLL_MS = 5_000;
// Reporter constants this regression models (health.ts): successes after the
// first are flushed on the 20s aggregate cadence, and a heartbeat is scheduled
// at the first flush >= 60s after the previous success log.
const AGGREGATE_WINDOW_MS = 20_000;
const HEARTBEAT_MS = 60_000;
// Review R6 (realtime-heartbeat-test-wallclock-flake): on a loaded host the
// aggregate timers drift, so the expected heartbeat count is derived from the
// span the reporter actually observed, with one aggregate window plus a drift
// slack subtracted, instead of a fixed count for a fixed run length. The run
// is long enough that the derived floor still demands the two heartbeats R3
// required.
const DRIFT_SLACK_MS = 10_000;
const RUN_FOR_MS = 165_000;
const TEST_TIMEOUT_MS = 240_000;

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

describe("VoiceHealthReporter real-time heartbeat", () => {
	it(
		"emits at least two committed heartbeats at the production 5s poll cadence",
		async () => {
			const stateRoot = await mkdtemp(
				join(tmpdir(), "voice-health-heartbeat-realtime-"),
			);
			const logs: VoiceHealthSuccessLog[] = [];
			const reporter = new VoiceHealthReporter({
				client: new VoiceHealthHelperClient({
					helperPath: resolve(
						process.cwd(),
						"../../scripts/lib/voice-health.py",
					),
					stateRoot,
				}),
				bootId: BOOT_ID,
				stateRoot,
				onSuccessLog: (entry) => {
					logs.push(entry);
				},
			});

			try {
				expect(await reporter.registerBoot()).toBe(true);
				const startedAt = Date.now();
				let successes = 0;
				const submittedObservedAt = new Set<string>();
				let firstObservedAt = "";
				let lastObservedAt = "";
				while (Date.now() - startedAt < RUN_FOR_MS) {
					const observedAt = new Date().toISOString();
					submittedObservedAt.add(observedAt);
					if (!firstObservedAt) firstObservedAt = observedAt;
					lastObservedAt = observedAt;
					reporter.observe({
						kind: "idle_success",
						observedAt,
						durationMs: 3,
					});
					successes += 1;
					await sleep(PRODUCTION_IDLE_POLL_MS);
				}
				await reporter.whenSettled();

				// Snapshot before stop(): stop() flushes any open aggregate, and a
				// flush-time heartbeat must not be what makes this assertion green.
				const beforeStop = logs.map((entry) => entry.event);
				const heartbeats = logs.filter((entry) => entry.event === "heartbeat");
				// The span is taken from the observations this test submitted (the
				// data the reporter saw), and every bound below is a floor on
				// operation counts over that span; a slower host only widens it.
				const observedSpanMs =
					Date.parse(lastObservedAt) - Date.parse(firstObservedAt);
				const expectedHeartbeats = Math.max(
					1,
					Math.floor(
						(observedSpanMs - AGGREGATE_WINDOW_MS - DRIFT_SLACK_MS) /
							HEARTBEAT_MS,
					),
				);
				// R3 requirement: the run must be long enough to demand two heartbeats.
				expect(expectedHeartbeats).toBeGreaterThanOrEqual(2);
				expect(successes).toBeGreaterThanOrEqual(
					Math.floor(observedSpanMs / PRODUCTION_IDLE_POLL_MS / 2),
				);
				expect(beforeStop[0]).toBe("initial_idle_success");
				expect(beforeStop).not.toContain("recovered");
				expect(heartbeats.length).toBeGreaterThanOrEqual(expectedHeartbeats);

				// Heartbeats are bounded: spaced at least 60 s apart, and each one
				// reports counters taken from the committed receipt, not local guesses.
				for (let index = 1; index < heartbeats.length; index += 1) {
					const previous = Date.parse(heartbeats[index - 1].timestamp);
					const current = Date.parse(heartbeats[index].timestamp);
					expect(current - previous).toBeGreaterThanOrEqual(55_000);
				}
				let lastSuccessCount = 0;
				for (const entry of logs) {
					expect(entry.bootId).toBe(BOOT_ID);
					expect(entry.mode).toBe("idle");
					expect(entry.failureCount).toBe(0);
					expect(entry.failureStreak).toBe(0);
					expect(entry.successCount).toBeGreaterThan(lastSuccessCount);
					lastSuccessCount = entry.successCount;
					// State assertion (FLY-2693 wall-clock audit): the logged last success
					// must be one of the observations this test submitted, never a value
					// invented by the reporter or compared against the host clock.
					expect(submittedObservedAt.has(entry.lastIterationSuccessAt)).toBe(
						true,
					);
				}
				const lastHeartbeat = heartbeats[heartbeats.length - 1];
				expect(lastHeartbeat.successCount).toBeGreaterThanOrEqual(
					Math.floor(
						(HEARTBEAT_MS * expectedHeartbeats) / PRODUCTION_IDLE_POLL_MS / 2,
					),
				);
			} finally {
				reporter.stop();
				await reporter.whenSettled();
				await rm(stateRoot, { recursive: true, force: true });
			}
		},
		TEST_TIMEOUT_MS,
	);
});
