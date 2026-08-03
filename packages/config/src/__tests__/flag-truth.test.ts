import { describe, expect, it } from "vitest";
import { FEATURE_FLAGS } from "../feature-flags/registry.js";
import {
	NON_FLAG_ALLOWLIST,
	RETIRED_FLAGS,
	validateFlagTruthEnvironment,
	validateWatchdogManifest,
} from "../feature-flags/truth.js";

describe("FLY-1393 flag truth", () => {
	it("FLY-1456 tombstones CHECKPOINT_WATCHDOG instead of registering it", () => {
		expect(NON_FLAG_ALLOWLIST.FLYWHEEL_EXEC_ID).toMatch(/execution id/);
		expect(NON_FLAG_ALLOWLIST.FLYWHEEL_CHECKPOINT_WATCHDOG).toBeUndefined();
		expect(NON_FLAG_ALLOWLIST.FLYWHEEL_CHECKPOINT_STUCK_MS).toBeUndefined();
		expect(
			FEATURE_FLAGS.find(
				(flag) => flag.envVar === "FLYWHEEL_CHECKPOINT_WATCHDOG",
			),
		).toBeUndefined();
		expect(
			RETIRED_FLAGS.find(
				(flag) => flag.envVar === "FLYWHEEL_CHECKPOINT_WATCHDOG",
			),
		).toMatchObject({ retiredBy: "FLY-1456" });
	});

	it("FLY-1456 tombstones QUOTA_DAEMON_CUTOVER after solidifying it on", () => {
		expect(
			FEATURE_FLAGS.find(
				(flag) => flag.envVar === "FLYWHEEL_QUOTA_DAEMON_CUTOVER",
			),
		).toBeUndefined();
		expect(
			RETIRED_FLAGS.find(
				(flag) => flag.envVar === "FLYWHEEL_QUOTA_DAEMON_CUTOVER",
			),
		).toMatchObject({ retiredBy: "FLY-1456" });
	});

	it("FLY-1466 tombstones all three FLY-1448 controls after solidifying them on", () => {
		const retired = [
			"FLYWHEEL_ENGINE_DECLARED_PARK",
			"FLYWHEEL_FOUNDER_DECISION_DEADLINE_MS",
			"FLYWHEEL_TERMINAL_RECEIPT_SETTLEMENT",
		] as const;
		const registered = new Set(
			FEATURE_FLAGS.flatMap((flag) => (flag.envVar ? [flag.envVar] : [])),
		);
		const tombstones = new Map(
			RETIRED_FLAGS.map((flag) => [flag.envVar, flag.retiredBy]),
		);

		for (const envVar of retired) {
			expect(registered.has(envVar), envVar).toBe(false);
			expect(tombstones.get(envVar), envVar).toBe("FLY-1466");
			const validation = validateFlagTruthEnvironment([`${envVar}=0`]);
			expect(validation.ok, envVar).toBe(false);
			expect(validation.errors.join("\n"), envVar).toMatch(/删这行/);
		}
	});

	it("FLY-1501 retires the unused swap-pressure percentage knobs", () => {
		const tombstones = new Map(
			RETIRED_FLAGS.map((flag) => [flag.envVar, flag.retiredBy]),
		);
		for (const envVar of [
			"FLYWHEEL_SWAP_PRESSURE_HIGH_PCT",
			"FLYWHEEL_SWAP_PRESSURE_LOW_PCT",
		]) {
			expect(NON_FLAG_ALLOWLIST[envVar]).toBeUndefined();
			expect(tombstones.get(envVar)).toBe("FLY-1501");
			expect(validateFlagTruthEnvironment([`${envVar}=95`]).ok).toBe(false);
		}
	});

	it("FLY-1501 solidifies the restart brake and registers only tuning/plumbing", () => {
		const tombstones = new Map(
			RETIRED_FLAGS.map((flag) => [flag.envVar, flag.retiredBy]),
		);
		expect(NON_FLAG_ALLOWLIST.FLYWHEEL_RESTART_STORM_GATE).toBeUndefined();
		expect(tombstones.get("FLYWHEEL_RESTART_STORM_GATE")).toBe("FLY-1501");
		expect(
			validateFlagTruthEnvironment(["FLYWHEEL_RESTART_STORM_GATE=0"]).ok,
		).toBe(false);

		for (const envVar of [
			"FLYWHEEL_RESTART_STORM_WINDOW_SEC",
			"FLYWHEEL_RESTART_STORM_MAX",
			"FLYWHEEL_RESTART_STORM_LOCK_DEADLINE_SEC",
			"FLYWHEEL_V2_RESTART_CONCURRENCY_MAX",
		]) {
			expect(NON_FLAG_ALLOWLIST[envVar], envVar).toMatch(/numeric tuning/i);
		}
		for (const envVar of [
			"FLYWHEEL_RESTART_STORM_GATE_BIN",
			"FLYWHEEL_META_ALERT_BIN",
			"FLYWHEEL_LEAD_ALERT_BIN",
		]) {
			expect(NON_FLAG_ALLOWLIST[envVar], envVar).toMatch(/plumbing/i);
		}
		expect(NON_FLAG_ALLOWLIST.FLYWHEEL_RESTART_STORM_FAULT).toMatch(
			/test-only fault/i,
		);
	});

	it("registers the FLY-1425 submission sentinel as non-flag plumbing", () => {
		expect(NON_FLAG_ALLOWLIST.FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED).toMatch(
			/plumbing/i,
		);
	});

	it("registers the FLY-1608 complete marker path as non-flag plumbing", () => {
		expect(NON_FLAG_ALLOWLIST.FLYWHEEL_COMPLETE_MARKER_DIR).toMatch(
			/plumbing.*marker dir/i,
		);
	});

	it("fails tombstones and unknown variables, but permits remaining retiring flags in env", () => {
		const tombstone = validateFlagTruthEnvironment([
			"FLYWHEEL_DETECTION_GAP_SCAN",
		]);
		expect(tombstone.ok).toBe(false);
		expect(tombstone.errors.join("\n")).toMatch(/删这行/);

		const unknown = validateFlagTruthEnvironment(["FLYWHEEL_NOT_A_REAL_FLAG"]);
		expect(unknown.ok).toBe(false);
		expect(unknown.errors.join("\n")).toMatch(/unknown/i);

		const retiredLegacy = validateFlagTruthEnvironment([
			"FLYWHEEL_LEGACY_DELIVERY_WATCHDOGS",
		]);
		expect(retiredLegacy.ok).toBe(false);
		expect(retiredLegacy.errors.join("\n")).toMatch(/删这行/);

		const retiring = validateFlagTruthEnvironment([
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

	it("FLY-1456 retires the five park-watch controls", () => {
		const retiredParkFlags = [
			"FLYWHEEL_PARK_WATCH",
			"FLYWHEEL_PARK_WATCH_EVERY_N_TICKS",
			"FLYWHEEL_PARK_N1_MS",
			"FLYWHEEL_PARK_N2_MS",
			"FLYWHEEL_PARK_QA_N3_MS",
		];
		const registered = new Set(
			FEATURE_FLAGS.flatMap((flag) => (flag.envVar ? [flag.envVar] : [])),
		);
		const tombstones = new Map(
			RETIRED_FLAGS.map((flag) => [flag.envVar, flag.retiredBy]),
		);

		for (const envVar of retiredParkFlags) {
			expect(registered.has(envVar), envVar).toBe(false);
			expect(tombstones.get(envVar), envVar).toBe("FLY-1456");
		}
	});

	it("FLY-1456 retires the six legacy delivery controls", () => {
		const retiredDeliveryFlags = [
			"FLYWHEEL_DELIVERY_ACK",
			"FLYWHEEL_DELIVERY_UNCONSUMED_V2",
			"FLYWHEEL_DELIVERY_ACK_TIMEOUT_MS",
			"FLYWHEEL_DELIVERY_MAX_REDELIVER",
			"FLYWHEEL_DELIVERY_MAX_TRANSPORT_FAILURES",
			"FLYWHEEL_ACK_LATE_WINDOW_MS",
		];
		const registered = new Set(
			FEATURE_FLAGS.flatMap((flag) => (flag.envVar ? [flag.envVar] : [])),
		);
		const tombstones = new Map(
			RETIRED_FLAGS.map((flag) => [flag.envVar, flag.retiredBy]),
		);

		for (const envVar of retiredDeliveryFlags) {
			expect(registered.has(envVar), envVar).toBe(false);
			expect(tombstones.get(envVar), envVar).toBe("FLY-1456");
		}
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
