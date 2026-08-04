import { describe, expect, it } from "vitest";
import {
	buildWatchdogManifest,
	WatchdogCheckTracker,
} from "../watchdog-health.js";

describe("FLY-1393 watchdog health manifest", () => {
	it("tracks started/completed/in-flight timestamps with cadence-aware freshness", () => {
		let now = 1_000_000;
		const tracker = new WatchdogCheckTracker({
			cadenceMs: 30_000,
			now: () => now,
		});
		tracker.started();
		now += 2_000;
		tracker.completed();
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
		tracker.started();
		now += 5_000;
		expect(
			tracker.snapshot({ wired: true, effectiveEnabled: true }),
		).toMatchObject({ freshness: "in_flight", in_flight_age_ms: 5_000 });
	});

	it("publishes the four minimum-set contracts and per-Lead loop staleness", () => {
		const nowMs = Date.parse("2026-07-21T12:00:00.000Z");
		const tracker = (cadenceMs: number) => {
			const t = new WatchdogCheckTracker({ cadenceMs, now: () => nowMs });
			t.started();
			t.completed();
			return t;
		};
		const manifest = buildWatchdogManifest({
			nowMs,
			bridgeStartedAtMs: nowMs - 60 * 60_000,
			flags: { liveness: true, blocked: true },
			wiring: {
				liveness: true,
				externalDrift: true,
				blockedLead: true,
				blockedRunner: false,
			},
			trackers: {
				liveness: tracker(3_600_000),
				blockedLead: tracker(30_000),
				blockedRunner: tracker(300_000),
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
		});

		expect(manifest.schema_version).toBe(1);
		expect(manifest.components.w1_process_liveness).toMatchObject({
			class: "W-1",
			effective_enabled: true,
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
		expect(manifest.components.w4_lead_blocked.class).toBe("W-4");
		expect(manifest.components.w4_runner_blocked.class).toBe("W-4");
		expect(manifest.components.w4_runner_blocked.wired).toBe(false);
	});
});
