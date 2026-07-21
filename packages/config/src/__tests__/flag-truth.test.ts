import { describe, expect, it } from "vitest";
import { FEATURE_FLAGS } from "../feature-flags/registry.js";
import {
	NON_FLAG_ALLOWLIST,
	RETIRED_FLAGS,
	validateFlagTruthEnvironment,
	validateWatchdogManifest,
} from "../feature-flags/truth.js";

describe("FLY-1393 flag truth", () => {
	it("shares the allowlist and removes CHECKPOINT_WATCHDOG from it", () => {
		expect(NON_FLAG_ALLOWLIST.FLYWHEEL_EXEC_ID).toMatch(/execution id/);
		expect(NON_FLAG_ALLOWLIST.FLYWHEEL_CHECKPOINT_WATCHDOG).toBeUndefined();
		expect(
			FEATURE_FLAGS.find(
				(flag) => flag.envVar === "FLYWHEEL_CHECKPOINT_WATCHDOG",
			),
		).toMatchObject({ retiring: "FLY-1393" });
	});

	it("fails tombstones and unknown variables, but permits retiring flags in env", () => {
		const tombstone = validateFlagTruthEnvironment([
			"FLYWHEEL_DETECTION_GAP_SCAN",
		]);
		expect(tombstone.ok).toBe(false);
		expect(tombstone.errors.join("\n")).toMatch(/删这行/);

		const unknown = validateFlagTruthEnvironment(["FLYWHEEL_NOT_A_REAL_FLAG"]);
		expect(unknown.ok).toBe(false);
		expect(unknown.errors.join("\n")).toMatch(/unknown/i);

		const retiring = validateFlagTruthEnvironment([
			"FLYWHEEL_LEGACY_DELIVERY_WATCHDOGS",
			"FLYWHEEL_ZOMBIE_GATE_RESOLVE",
		]);
		expect(retiring).toEqual({ ok: true, errors: [] });
	});

	it("tombstones all three fake historical switches", () => {
		expect(RETIRED_FLAGS.map((flag) => flag.envVar)).toEqual(
			expect.arrayContaining([
				"FLYWHEEL_DETECTION_GAP_SCAN",
				"FLYWHEEL_STUCK_ERRORSIG",
				"FLYWHEEL_DETECTION_ESCALATION",
			]),
		);
	});

	it("runtime validation catches a missing minimum-set row and any revived retiring lane", () => {
		const active = () => ({ wired: true, effective_enabled: true });
		const valid = {
			schema_version: 1,
			components: {
				w1_process_liveness: active(),
				w2_delivery_loop: {
					...active(),
					leads: [
						{ lead_id: "lead-fresh", freshness: "fresh" },
						{ lead_id: "lead-stale", freshness: "stale" },
					],
				},
				w3_external_drift: {
					...active(),
					observation: "static_contract",
				},
				w4_lead_blocked: { wired: true, effective_enabled: false },
				w4_runner_blocked: { wired: true, effective_enabled: false },
			},
			retiring: FEATURE_FLAGS.filter((flag) => flag.retiring).map((flag) => ({
				name: flag.name,
				effective_enabled: false,
			})),
		};
		expect(validateWatchdogManifest(valid)).toEqual({ ok: true, errors: [] });

		const wrong = structuredClone(valid);
		delete (wrong.components as Record<string, unknown>).w1_process_liveness;
		wrong.components.w2_delivery_loop.wired = false;
		delete (wrong.components.w3_external_drift as Record<string, unknown>)
			.observation;
		(
			wrong.components.w4_runner_blocked as {
				effective_enabled: unknown;
			}
		).effective_enabled = "0";
		wrong.retiring[0]!.effective_enabled = true;
		const result = validateWatchdogManifest(wrong);
		expect(result.ok).toBe(false);
		expect(result.errors.join("\n")).toMatch(/w1_process_liveness/);
		expect(result.errors.join("\n")).toMatch(/w2_delivery_loop.*wired=true/);
		expect(result.errors.join("\n")).toMatch(
			/w3_external_drift.*observation=static_contract/,
		);
		expect(result.errors.join("\n")).toMatch(/w4_runner_blocked.*boolean/);
		expect(result.errors.join("\n")).toMatch(/effective_enabled=true/);
	});

	it("rejects a W-2 Lead row whose identity or freshness is missing or invalid", () => {
		const manifest = (leads: unknown[]) => ({
			schema_version: 1,
			components: {
				w1_process_liveness: { wired: true, effective_enabled: true },
				w2_delivery_loop: {
					wired: true,
					effective_enabled: true,
					leads,
				},
				w3_external_drift: {
					wired: true,
					effective_enabled: true,
					observation: "static_contract",
				},
				w4_lead_blocked: { wired: true, effective_enabled: true },
				w4_runner_blocked: { wired: true, effective_enabled: true },
			},
			retiring: [],
		});

		for (const leads of [
			[{ lead_id: "lead-a" }],
			[{ lead_id: "", freshness: "stale" }],
			[{ lead_id: "lead-a", freshness: "unknown" }],
		]) {
			const result = validateWatchdogManifest(manifest(leads));
			expect(result.ok).toBe(false);
			expect(result.errors.join("\n")).toMatch(/w2_delivery_loop\.leads/);
		}
	});
});
