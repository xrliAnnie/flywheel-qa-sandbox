import { validateLivenessManifest } from "flywheel-config";
import { describe, expect, it } from "vitest";
import {
	buildLivenessManifest,
	LivenessCheckTracker,
} from "../liveness-manifest.js";

describe("FLY-1393 liveness manifest", () => {
	it("tracks started/completed/in-flight timestamps with cadence-aware freshness", () => {
		let now = 1_000_000;
		const tracker = new LivenessCheckTracker({
			cadenceMs: 30_000,
			now: () => now,
		});
		const first = tracker.started();
		now += 2_000;
		tracker.completed(first);
		expect(
			tracker.snapshot({ wired: true, effectiveEnabled: true }),
		).toMatchObject({
			wired: true,
			effective_enabled: true,
			last_check_started_at: new Date(1_000_000).toISOString(),
			last_check_completed_at: new Date(1_002_000).toISOString(),
			in_flight_age_ms: null,
			freshness: "fresh",
		});

		now += 70_000;
		expect(
			tracker.snapshot({ wired: true, effectiveEnabled: true }).freshness,
		).toBe("stale");
		const owner = tracker.started();
		now += 5_000;
		expect(
			tracker.snapshot({ wired: true, effectiveEnabled: true }),
		).toMatchObject({ freshness: "in_flight", in_flight_age_ms: 5_000 });
		const overlapping = tracker.started();
		tracker.completed(owner);
		expect(
			tracker.snapshot({ wired: true, effectiveEnabled: true }).freshness,
		).toBe("in_flight");
		tracker.completed(overlapping);
		expect(
			tracker.snapshot({ wired: true, effectiveEnabled: true }).freshness,
		).toBe("fresh");
	});

	it("publishes the three surviving contracts and per-Lead loop staleness", () => {
		const nowMs = Date.parse("2026-07-21T12:00:00.000Z");
		const tracker = (cadenceMs: number) => {
			const t = new LivenessCheckTracker({ cadenceMs, now: () => nowMs });
			const token = t.started();
			t.completed(token);
			return t;
		};
		const manifest = buildLivenessManifest({
			nowMs,
			bridgeStartedAtMs: nowMs - 60 * 60_000,
			wiring: {
				liveness: true,
				externalDrift: true,
			},
			trackers: {
				liveness: tracker(3_600_000),
			},
			deliveryLoopWired: true,
			loopStallMs: 10 * 60_000,
			loopTargets: [
				{
					projectName: "flywheel",
					leadId: "lead-stale",
					queue: {
						getHeartbeat: () => ({
							lead_id: "lead-stale",
							// A loop that keeps starting but never succeeds is stale.
							last_started_at: "2026-07-21T11:59:59.000Z",
							last_success_at: "2026-07-21T11:39:00.000Z",
						}),
					},
				},
				{
					projectName: "flywheel",
					leadId: "lead-fresh",
					queue: {
						getHeartbeat: () => ({
							lead_id: "lead-fresh",
							last_started_at: "2026-07-21T11:59:59.000Z",
							last_success_at: "2026-07-21T11:59:59.500Z",
						}),
					},
				},
			] as never,
			probeForensics: {
				lookup_error: 2,
				probe_throw: 1,
				probe_unclear: 3,
				pending_sentinel: 4,
				last_at: "2026-07-21T11:59:59.750Z",
			},
		});

		expect(manifest.schema_version).toBe(2);
		expect(manifest.components.w1_process_liveness).toMatchObject({
			class: "W-1",
			effective_enabled: true,
			switch: "required",
		});
		expect(manifest.components.w2_delivery_loop.leads).toEqual([
			expect.objectContaining({ lead_id: "lead-stale", freshness: "stale" }),
			expect.objectContaining({ lead_id: "lead-fresh", freshness: "fresh" }),
		]);
		expect(manifest.components.w2_delivery_loop).toMatchObject({
			class: "W-2",
			wired: true,
			effective_enabled: true,
			switch: "required",
		});
		expect(manifest.components.w2_delivery_loop).not.toHaveProperty(
			"freshness",
		);
		expect(manifest.components.w3_external_drift).toMatchObject({
			class: "W-3",
			wired: true,
			effective_enabled: true,
			observation: "static_contract",
			switch: "required/no_switch",
		});
		expect(manifest.components).not.toHaveProperty("w4_lead_blocked");
		expect(manifest.probe_forensics).toEqual({
			lookup_error: 2,
			probe_throw: 1,
			probe_unclear: 3,
			pending_sentinel: 4,
			last_at: "2026-07-21T11:59:59.750Z",
		});
		expect(validateLivenessManifest(manifest)).toEqual({
			ok: true,
			errors: [],
		});
	});

	it("omits probe forensics until the late-bound HeartbeatService exists", () => {
		const tracker = new LivenessCheckTracker({ cadenceMs: 30_000 });
		const manifest = buildLivenessManifest({
			bridgeStartedAtMs: Date.now(),
			wiring: { liveness: true, externalDrift: true },
			trackers: { liveness: tracker },
			deliveryLoopWired: true,
			loopStallMs: 60_000,
			loopTargets: [],
		});
		expect(manifest).not.toHaveProperty("probe_forensics");
	});

	// FLY-1560 刀 6: the schema-v2 contract is only real if the producer here and
	// the validator the probe/check-flag-truth enforce agree on the same bytes.
	// Asserting the manifest against a hand-written fixture would let the two
	// drift apart silently, so run the real output through the real validator —
	// in every freshness state W-1 can reach, including a hung pass.
	it("every real W-1 state satisfies the shipped liveness manifest validator", () => {
		const nowMs = Date.parse("2026-08-14T09:00:00.000Z");
		const cadenceMs = 3_600_000;
		const build = (liveness: LivenessCheckTracker) =>
			buildLivenessManifest({
				nowMs,
				bridgeStartedAtMs: nowMs - 60 * 60_000,
				wiring: { liveness: true, externalDrift: true },
				trackers: { liveness },
				deliveryLoopWired: true,
				loopStallMs: 10 * 60_000,
				loopTargets: [
					{
						projectName: "flywheel",
						leadId: "lead-a",
						queue: {
							getHeartbeat: () => ({
								lead_id: "lead-a",
								last_started_at: "2026-08-14T08:59:59.000Z",
								last_success_at: "2026-08-14T08:59:59.500Z",
							}),
						},
					},
				] as never,
			});

		const notStarted = new LivenessCheckTracker({
			cadenceMs,
			now: () => nowMs,
		});
		expect(build(notStarted).components.w1_process_liveness.freshness).toBe(
			"not_started",
		);

		let clock = nowMs - cadenceMs;
		const completed = new LivenessCheckTracker({
			cadenceMs,
			now: () => clock,
		});
		completed.completed(completed.started());
		clock = nowMs;
		expect(build(completed).components.w1_process_liveness.freshness).toBe(
			"fresh",
		);

		let staleClock = nowMs - cadenceMs * 10;
		const stale = new LivenessCheckTracker({
			cadenceMs,
			now: () => staleClock,
		});
		stale.completed(stale.started());
		staleClock = nowMs;
		expect(build(stale).components.w1_process_liveness.freshness).toBe("stale");

		let hungClock = nowMs - cadenceMs * 10;
		const hung = new LivenessCheckTracker({ cadenceMs, now: () => hungClock });
		hung.started();
		hungClock = nowMs;
		const hungManifest = build(hung);
		expect(hungManifest.components.w1_process_liveness).toMatchObject({
			freshness: "in_flight",
			in_flight_age_ms: cadenceMs * 10,
		});

		for (const manifest of [
			build(notStarted),
			build(completed),
			build(stale),
			hungManifest,
		]) {
			expect(validateLivenessManifest(manifest)).toEqual({
				ok: true,
				errors: [],
			});
		}
	});
});
