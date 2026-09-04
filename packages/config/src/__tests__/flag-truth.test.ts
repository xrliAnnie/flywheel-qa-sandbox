import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FLAG_EXEMPTIONS } from "../feature-flags/exemptions.js";
import { FEATURE_FLAGS } from "../feature-flags/registry.js";
import { STORE_MANAGED_FLAGS } from "../feature-flags/store-policy.js";
import {
	NON_FLAG_ALLOWLIST,
	RETIRED_CONFIG_PATHS,
	RETIRED_FLAGS,
	validateFlagTruthEnvironment,
	validateLivenessManifest,
} from "../feature-flags/truth.js";

/**
 * FLY-1560 刀 6: the W-1 row is produced by LivenessCheckTracker.snapshot(), so
 * schema v2 requires the tracker fields on every manifest. Health judgment on
 * `freshness` lives in the out-of-process probe; the validator only enforces
 * that the fields the probe consumes are present and well-typed.
 */
const W1_TRACKED_FIELDS = {
	class: "W-1",
	switch: "required",
	last_check_started_at: "2026-08-14T09:00:00.000Z",
	last_check_completed_at: "2026-08-14T09:00:01.000Z",
	in_flight_age_ms: null,
	freshness: "fresh",
};

const FLY_1806_RETIRED_FLAGS = [
	"FLYWHEEL_GATEPOLLER_CIRCUIT",
	"FLYWHEEL_FOUNDER_THREAD_NOTIFY",
	"FLYWHEEL_FOUNDER_REPLY_DELIVER",
	"FLYWHEEL_DEFERRED_FOUNDER_APPROVAL",
	"FLYWHEEL_HELD_DECLINED_REPLY",
	"FLYWHEEL_FOUNDER_NOTIFY_RETRY_MAX",
	"FLYWHEEL_FOUNDER_REPLY_RETRY_MAX",
	"FLYWHEEL_HEARTBEAT_READOPT",
	"FLYWHEEL_LIVENESS_PANE_DEAD",
	"FLYWHEEL_ISSUE_STATUS_WORD",
	"FLYWHEEL_STALE_TERMINAL_CLOSE",
	"FLYWHEEL_ZOMBIE_RECONCILE",
	"FLYWHEEL_BOOT_SHA_CHECK",
	"FLYWHEEL_WORKTREE_AUTOCLEAN",
	"FLYWHEEL_BRIDGE_LOOP_GUARD",
	"FLYWHEEL_ISSUE_STATUS_EMOJI",
	"FLYWHEEL_ISSUE_ATTACH_PIN",
	"FLYWHEEL_ISSUE_DISPLAY_REFRESH",
	"FLYWHEEL_CRASH_REAPER",
	"FLYWHEEL_COMMDB_FSM_RECONCILE",
	"FLYWHEEL_TERMINAL_THREAD_ARCHIVE",
	"FLYWHEEL_DISPOSITION_RECEIPT",
	"FLYWHEEL_SHIP_READY_NOTIFY",
	"FLYWHEEL_SHIP_READY_REMIND_MS",
	"FLYWHEEL_CODEX_LEAD_TYPING",
	"FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE",
	"FLYWHEEL_LEAD_CHROME_ENABLED",
	"FLYWHEEL_ROUNDTABLE_THREAD_OWN_BOT",
	"FLYWHEEL_CMUX_AUTOSTART_EXEC",
	"FLYWHEEL_ACCOUNT_IDENTITY_CHECK",
	"FLYWHEEL_DONE_THREAD_RECONCILE_DRYRUN",
] as const;

describe("FLY-1393 flag truth", () => {
	it("rejects every SQLite-managed flag from persistent environments", () => {
		const managedEnvVars = FEATURE_FLAGS.flatMap((flag) =>
			STORE_MANAGED_FLAGS.has(flag.name) && flag.envVar ? [flag.envVar] : [],
		);
		expect(STORE_MANAGED_FLAGS.size).toBe(FEATURE_FLAGS.length);
		expect(managedEnvVars).toHaveLength(
			FEATURE_FLAGS.filter(({ scope }) => scope === "bridge_global").length,
		);
		for (const envVar of managedEnvVars) {
			expect(envVar).toBeTruthy();
			expect(validateFlagTruthEnvironment([`${envVar}=1`]), envVar).toEqual({
				ok: false,
				errors: [
					`${envVar}: 值已由 SQLite flag store 接管,删这行;改值走 stage/apply`,
				],
			});
		}
	});

	it("FLY-1981 tombstones consent controls but preserves launcher-owned mention plumbing", () => {
		for (const envVar of [
			"FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE",
			"FLYWHEEL_FOUNDER_CONSENT_ENABLED",
		]) {
			expect(RETIRED_FLAGS).toContainEqual({
				envVar,
				retiredBy: "FLY-1981",
			});
			expect(NON_FLAG_ALLOWLIST[envVar], envVar).toBeUndefined();
		}
		expect(
			RETIRED_FLAGS.some(
				(entry) => entry.envVar === "FLYWHEEL_LEAD_CORE_MENTION_GATED",
			),
		).toBe(false);
		expect(NON_FLAG_ALLOWLIST.FLYWHEEL_LEAD_CORE_MENTION_GATED).toMatch(
			/launcher.*projects\.json.*plumbing/i,
		);
	});

	it("FLY-2075 tombstones the removed alert channel copy control", () => {
		expect(RETIRED_FLAGS).toContainEqual({
			envVar: "FLYWHEEL_ALERT_COPY_TO_CHANNEL",
			retiredBy: "FLY-2075",
		});
		expect(NON_FLAG_ALLOWLIST.FLYWHEEL_ALERT_COPY_TO_CHANNEL).toBeUndefined();
	});

	it("FLY-1981 tombstones auto-QA and leaves deleted tuning envs out of every ledger", () => {
		expect(
			RETIRED_FLAGS.filter((entry) => entry.retiredBy === "FLY-1981"),
		).toHaveLength(11);
		expect(RETIRED_FLAGS).toContainEqual({
			envVar: "FLYWHEEL_AUTO_QA",
			retiredBy: "FLY-1981",
		});
		for (const envVar of [
			"FLYWHEEL_QA_RECONCILE_EVERY_N_TICKS",
			"FLYWHEEL_FOUNDER_MILESTONE_PATROL_TICKS",
			"FLYWHEEL_FOUNDER_MILESTONE_LOOKBACK_HOURS",
			"FLYWHEEL_FOUNDER_MILESTONE_GRACE_MS",
		]) {
			expect(RETIRED_FLAGS.some((entry) => entry.envVar === envVar)).toBe(
				false,
			);
			expect(NON_FLAG_ALLOWLIST[envVar], envVar).toBeUndefined();
		}
		expect(RETIRED_CONFIG_PATHS).toEqual([
			{ path: "qa", retiredBy: "FLY-1981" },
			{ path: "founder_milestone_report", retiredBy: "FLY-1981" },
		]);
	});

	it("FLY-1831 closes the eight direct-env residues with the exact 3+3+2 disposition", () => {
		const disposition = {
			deleted: [
				"FLYWHEEL_ALERT_ROUTING",
				"FLYWHEEL_ALERT_TICKETS",
				"FLYWHEEL_DETECTION_AI_CLASSIFY",
			],
			exempt: [
				"FLYWHEEL_CHROME_REAPER_MIGRATE_UNATTRIBUTED",
				"FLYWHEEL_QUOTA_QA_INJECTION",
				"FLYWHEEL_SYNC_BIN_ALLOW_TEMP_ROOT",
			],
			solidified: [
				"FLYWHEEL_DESIGN_HTML_GATE",
				"FLYWHEEL_INSTRUCTION_PATH_CHECK",
			],
		} as const;
		expect(Object.values(disposition).map((names) => names.length)).toEqual([
			3, 3, 2,
		]);
		expect(new Set(Object.values(disposition).flat()).size).toBe(8);

		for (const envVar of disposition.deleted) {
			expect(
				FEATURE_FLAGS.some((flag) => flag.envVar === envVar),
				envVar,
			).toBe(false);
			expect(
				FLAG_EXEMPTIONS.some((entry) => entry.name === envVar),
				envVar,
			).toBe(false);
			expect(NON_FLAG_ALLOWLIST[envVar], envVar).toBeUndefined();
			expect(
				RETIRED_FLAGS.find((entry) => entry.envVar === envVar),
				envVar,
			).toEqual({ envVar, retiredBy: "FLY-1831" });
		}
		for (const envVar of disposition.exempt) {
			expect(
				FEATURE_FLAGS.some((flag) => flag.envVar === envVar),
				envVar,
			).toBe(false);
			expect(NON_FLAG_ALLOWLIST[envVar], envVar).toBeUndefined();
			expect(
				FLAG_EXEMPTIONS.find((entry) => entry.name === envVar),
				envVar,
			).toMatchObject({
				kind: "env",
				persistentEnvAllowed: false,
				issue: "FLY-1831",
			});
			expect(
				RETIRED_FLAGS.some((entry) => entry.envVar === envVar),
				envVar,
			).toBe(false);
		}
		for (const envVar of disposition.solidified) {
			expect(
				FEATURE_FLAGS.some((flag) => flag.envVar === envVar),
				envVar,
			).toBe(false);
			expect(
				FLAG_EXEMPTIONS.some((entry) => entry.name === envVar),
				envVar,
			).toBe(false);
			expect(NON_FLAG_ALLOWLIST[envVar], envVar).toBeUndefined();
			expect(RETIRED_FLAGS, envVar).toContainEqual({
				envVar,
				retiredBy: "FLY-1981",
			});
		}
	});

	it("accepts only FLY-1455 exemptions allowed in persistent environments", () => {
		for (const exemption of FLAG_EXEMPTIONS.filter(
			(entry) => entry.kind === "env" && entry.persistentEnvAllowed,
		)) {
			expect(
				validateFlagTruthEnvironment([`${exemption.name}=0`]),
				exemption.name,
			).toEqual({ ok: true, errors: [] });
		}
	});

	it("rejects transient QA exemptions in persistent environments", () => {
		for (const exemption of FLAG_EXEMPTIONS.filter(
			(entry) => entry.kind === "env" && !entry.persistentEnvAllowed,
		)) {
			expect(
				validateFlagTruthEnvironment([`${exemption.name}=0`]),
				exemption.name,
			).toEqual({
				ok: false,
				errors: [
					`${exemption.name}: transient exemption must not appear in a persistent environment`,
				],
			});
		}
	});

	it("classifies the founder-review runner capability as context, not a feature flag", () => {
		expect(NON_FLAG_ALLOWLIST.FLYWHEEL_FOUNDER_REVIEW_REQUIRED).toMatch(
			/sealed workflow node capability/,
		);
		expect(
			FEATURE_FLAGS.some(
				(flag) => flag.envVar === "FLYWHEEL_FOUNDER_REVIEW_REQUIRED",
			),
		).toBe(false);
		expect(
			validateFlagTruthEnvironment(["FLYWHEEL_FOUNDER_REVIEW_REQUIRED=1"]),
		).toEqual({ ok: true, errors: [] });
	});

	it("FLY-1570 tombstones removed chase controls", () => {
		const retired = RETIRED_FLAGS.filter(
			(flag) => flag.retiredBy === "FLY-1570",
		);
		expect(retired).toHaveLength(40);
		for (const { envVar } of retired) {
			expect(
				FEATURE_FLAGS.some((flag) => flag.envVar === envVar),
				envVar,
			).toBe(false);
			expect(validateFlagTruthEnvironment([`${envVar}=1`]).ok, envVar).toBe(
				false,
			);
		}
	});

	it("keeps delivery-path receipt tuning outside the retired patrol controls", () => {
		for (const envVar of [
			"FLYWHEEL_RECEIPT_EXEC_PUSH_CAP",
			"FLYWHEEL_RECEIPT_EXEC_PUSH_WINDOW_MIN",
			"FLYWHEEL_RECEIPT_WAKE_T1_MS",
			"FLYWHEEL_RECEIPT_WINDOW_P0_MIN",
			"FLYWHEEL_RECEIPT_WINDOW_P1_MIN",
			"FLYWHEEL_RECEIPT_WINDOW_P2_MIN",
			"FLYWHEEL_RECEIPT_WINDOW_P3_MIN",
		]) {
			expect(NON_FLAG_ALLOWLIST[envVar], envVar).toBeDefined();
			expect(
				RETIRED_FLAGS.some((flag) => flag.envVar === envVar),
				envVar,
			).toBe(false);
		}
	});

	it("registers FLY-1867 policy writer timing controls as non-flag test tuning", () => {
		for (const envVar of [
			"FLY1867_POLICY_PRE_CAS_PAUSE_MS",
			"FLY1867_POLICY_LOCK_TIMEOUT_SECONDS",
		]) {
			expect(NON_FLAG_ALLOWLIST[envVar], envVar).toMatch(/test.*tuning/i);
			expect(
				FEATURE_FLAGS.some((flag) => flag.envVar === envVar),
				envVar,
			).toBe(false);
		}
	});

	it("classifies FLY-2211 kill-ledger inputs as non-flag plumbing", () => {
		for (const [envVar, reason] of [
			["FLYWHEEL_KILL_LEDGER_ROOT", /path.*override/i],
			["FLYWHEEL_KILL_LEDGER_NOW", /test-only.*clock/i],
			["FLYWHEEL_NODE_BIN", /node.*executable.*path/i],
		] as const) {
			expect(NON_FLAG_ALLOWLIST[envVar], envVar).toMatch(reason);
			expect(
				FEATURE_FLAGS.some((flag) => flag.envVar === envVar),
				envVar,
			).toBe(false);
		}
		expect(
			NON_FLAG_ALLOWLIST.FLYWHEEL_KILL_LEDGER_TEST_NO_MUTATE,
		).toBeUndefined();
	});

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

	it("FLY-1806 tombstones feature flags after solidifying their current behavior", () => {
		const registered = new Set(
			FEATURE_FLAGS.flatMap((flag) => (flag.envVar ? [flag.envVar] : [])),
		);
		const tombstones = new Map(
			RETIRED_FLAGS.map((flag) => [flag.envVar, flag.retiredBy]),
		);
		expect(FLY_1806_RETIRED_FLAGS).toHaveLength(31);

		for (const envVar of FLY_1806_RETIRED_FLAGS) {
			expect(registered.has(envVar), envVar).toBe(false);
			expect(tombstones.get(envVar), envVar).toBe("FLY-1806");
			expect(validateFlagTruthEnvironment([`${envVar}=0`]).ok, envVar).toBe(
				false,
			);
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

	it("FLY-2216 classifies resident Codex Lead health thresholds as numeric tuning", () => {
		for (const envVar of [
			"FLYWHEEL_CODEX_LEAD_RESIDENCY_CONSECUTIVE_FAILURES",
			"FLYWHEEL_CODEX_LEAD_RESIDENCY_HEARTBEAT_STALE_MS",
			"FLYWHEEL_CODEX_LEAD_RESIDENCY_POLL_STALE_MS",
			"FLYWHEEL_CODEX_LEAD_RESIDENCY_STARTUP_GRACE_MS",
			"FLYWHEEL_CODEX_LEAD_RESIDENCY_TURN_STALE_MS",
		]) {
			expect(NON_FLAG_ALLOWLIST[envVar], envVar).toMatch(/numeric tuning/i);
			expect(NON_FLAG_ALLOWLIST[envVar], envVar).toMatch(/FLY-2216/);
		}
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

	it("registers the FLY-2033 meeting-notes config path as a non-flag value", () => {
		expect(NON_FLAG_ALLOWLIST.FLYWHEEL_MEETING_NOTES_CONFIG).toMatch(
			/config value.*FLY-2033/i,
		);
		expect(
			validateFlagTruthEnvironment([
				"FLYWHEEL_MEETING_NOTES_CONFIG=/tmp/meeting-notes.yaml",
			]),
		).toEqual({ ok: true, errors: [] });
	});

	it("registers FLY-2147/FLY-2148 runner-memory plumbing without creating runtime switches", () => {
		expect(NON_FLAG_ALLOWLIST.FLYWHEEL_RUNNER_MEMORY_DIR).toMatch(
			/FLY-2147.*mount.*output.*not.*switch/i,
		);
		expect(NON_FLAG_ALLOWLIST.FLYWHEEL_RUNNER_MEMORY_SNAPSHOT).toMatch(
			/FLY-2148.*snapshot.*output.*not.*switch/i,
		);
		expect(NON_FLAG_ALLOWLIST.FLYWHEEL_RUNNER_MEMORY_ROOT).toMatch(
			/FLY-2147.*test-only.*path.*not.*switch/i,
		);
		for (const envVar of [
			"FLYWHEEL_RUNNER_MEMORY_DIR",
			"FLYWHEEL_RUNNER_MEMORY_SNAPSHOT",
			"FLYWHEEL_RUNNER_MEMORY_ROOT",
		]) {
			expect(
				FEATURE_FLAGS.some((flag) => flag.envVar === envVar),
				envVar,
			).toBe(false);
		}
		expect(
			validateFlagTruthEnvironment([
				"FLYWHEEL_RUNNER_MEMORY_DIR=/tmp/mounted-memory",
				'FLYWHEEL_RUNNER_MEMORY_SNAPSHOT={"lines":3}',
				"FLYWHEEL_RUNNER_MEMORY_ROOT=/tmp/test-memory-root",
			]),
		).toEqual({ ok: true, errors: [] });
	});

	it("registers the FLY-2190 host-tmux hermetic test inputs as non-flags", () => {
		for (const envVar of [
			"FLYWHEEL_HOST_TMUX_CENSUS_PLIST_DIR",
			"FLYWHEEL_HOST_TMUX_CENSUS_SOURCE_DIR",
		]) {
			expect(NON_FLAG_ALLOWLIST[envVar], envVar).toMatch(
				/test-only.*path.*FLY-2190/i,
			);
		}
		expect(NON_FLAG_ALLOWLIST.FLYWHEEL_HOST_TMUX_GATE_TEST_MODE).toMatch(
			/test-only.*seam.*FLY-2190/i,
		);
		expect(
			validateFlagTruthEnvironment([
				"FLYWHEEL_HOST_TMUX_CENSUS_PLIST_DIR=/tmp/launch-agents",
				"FLYWHEEL_HOST_TMUX_CENSUS_SOURCE_DIR=/tmp/sources",
				"FLYWHEEL_HOST_TMUX_GATE_TEST_MODE=1",
			]),
		).toEqual({ ok: true, errors: [] });
	});

	it("registers the FLY-2137 calendar sweep installer inputs as non-flags", () => {
		expect(NON_FLAG_ALLOWLIST.FLYWHEEL_REPO).toMatch(
			/plumbing.*repo.*FLY-2137/i,
		);
		expect(NON_FLAG_ALLOWLIST.FLYWHEEL_CALENDAR_SWEEP_LAUNCHCTL).toMatch(
			/test-only.*launchctl.*FLY-2137/i,
		);
		expect(NON_FLAG_ALLOWLIST.FLYWHEEL_CALENDAR_SWEEP_NODE).toMatch(
			/plumbing.*node.*FLY-2137/i,
		);
		for (const envVar of [
			"FLYWHEEL_CALENDAR_SWEEP_TEST_APPEND_AUDIT_AFTER_READ",
			"FLYWHEEL_CALENDAR_SWEEP_TEST_CRASH_AFTER_ALERT",
		]) {
			expect(NON_FLAG_ALLOWLIST[envVar], envVar).toMatch(
				/test-only.*seam.*FLY-2137/i,
			);
		}
		expect(
			validateFlagTruthEnvironment([
				"FLYWHEEL_REPO=/tmp/flywheel",
				"FLYWHEEL_CALENDAR_SWEEP_LAUNCHCTL=/tmp/launchctl",
				"FLYWHEEL_CALENDAR_SWEEP_NODE=/tmp/node",
				"FLYWHEEL_CALENDAR_SWEEP_TEST_APPEND_AUDIT_AFTER_READ={}",
				"FLYWHEEL_CALENDAR_SWEEP_TEST_CRASH_AFTER_ALERT=1",
			]),
		).toEqual({ ok: true, errors: [] });
	});

	/**
	 * FLY-1809 (from the FLY-1782 audit): these two were never on/off switches —
	 * one is a Discord channel id, the other a filesystem path. They are MOVED off
	 * the flag table into the non-flag config registry, NOT deleted (deleting a
	 * flag means inlining its default, which would hardcode the channel id / path)
	 * and NOT tombstoned (a tombstone asserts production no longer reads the var —
	 * both are still read). They therefore do not count toward the cleared-flag
	 * denominator.
	 */
	it("FLY-1809 moves the two config values off the flag table into NON_FLAG_ALLOWLIST", () => {
		const registeredEnv = new Set(
			FEATURE_FLAGS.flatMap((flag) => (flag.envVar ? [flag.envVar] : [])),
		);
		const registeredNames = new Set(FEATURE_FLAGS.map((flag) => flag.name));
		const tombstones = new Set(RETIRED_FLAGS.map((flag) => flag.envVar));

		for (const [envVar, flagName] of [
			["FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS", "lead_cross_dept_channel_ids"],
			["FLYWHEEL_DELIVERY_SECRET_PATH", "delivery_secret_path"],
		] as const) {
			// off the flag table, by env var AND by flag name
			expect(registeredEnv.has(envVar), envVar).toBe(false);
			expect(registeredNames.has(flagName), flagName).toBe(false);
			// not a tombstone — production still reads it
			expect(tombstones.has(envVar as never), envVar).toBe(false);
			// registered as a config value, with a reason
			expect(NON_FLAG_ALLOWLIST[envVar], envVar).toMatch(
				/config value|plumbing/i,
			);
			expect(NON_FLAG_ALLOWLIST[envVar], envVar).toMatch(/FLY-1809/);
			// a live `~/.flywheel/.env` carrying it still validates clean
			expect(validateFlagTruthEnvironment([`${envVar}=x`]), envVar).toEqual({
				ok: true,
				errors: [],
			});
		}
	});

	// The other half of "moved, not deleted" — that each value is still really
	// resolved FROM the environment — is sealed behaviorally, not by scanning
	// source text here. A lexical scan is the wrong instrument: a commented-out
	// `process.env.X` satisfies it, and a valid destructured read fails it.
	//   • FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS — already covered at its parsers
	//     (lead-actions config, codex-lead-runtime, gateway-main) and in the
	//     roundtable / mcp-argv suites.
	//   • FLYWHEEL_DELIVERY_SECRET_PATH — was NOT covered; every provider test
	//     passed `secretPath` explicitly. Sealed by "FLY-1809 resolves the secret
	//     path from FLYWHEEL_DELIVERY_SECRET_PATH" in
	//     packages/teamlead/src/__tests__/delivery-secret.test.ts.

	it("fails tombstones and unknown variables", () => {
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

	it("runtime validation catches missing or unwired liveness rows", () => {
		const active = () => ({ wired: true, effective_enabled: true });
		const valid = {
			schema_version: 2,
			components: {
				w1_process_liveness: { ...active(), ...W1_TRACKED_FIELDS },
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
			},
		};
		expect(validateLivenessManifest(valid)).toEqual({ ok: true, errors: [] });

		const withProbeForensics = {
			...valid,
			probe_forensics: {
				lookup_error: 1,
				probe_throw: 2,
				probe_unclear: 3,
				pending_sentinel: 4,
				last_at: "2026-08-23T13:42:04.000Z",
			},
		};
		expect(validateLivenessManifest(withProbeForensics)).toEqual({
			ok: true,
			errors: [],
		});
		const malformedProbe = structuredClone(withProbeForensics);
		malformedProbe.probe_forensics.probe_throw = -1;
		malformedProbe.probe_forensics.last_at = 42 as never;
		const malformedProbeResult = validateLivenessManifest(malformedProbe);
		expect(malformedProbeResult.ok).toBe(false);
		expect(malformedProbeResult.errors.join("\n")).toMatch(
			/probe_forensics.*probe_throw/,
		);
		expect(malformedProbeResult.errors.join("\n")).toMatch(
			/probe_forensics.*last_at/,
		);

		const wrong = structuredClone(valid);
		delete (wrong.components as Record<string, unknown>).w1_process_liveness;
		wrong.components.w2_delivery_loop.wired = false;
		delete (wrong.components.w3_external_drift as Record<string, unknown>)
			.observation;
		const result = validateLivenessManifest(wrong);
		expect(result.ok).toBe(false);
		expect(result.errors.join("\n")).toMatch(/w1_process_liveness/);
		expect(result.errors.join("\n")).toMatch(/w2_delivery_loop.*wired=true/);
		expect(result.errors.join("\n")).toMatch(
			/w3_external_drift.*observation=static_contract/,
		);
	});

	it("rejects a W-2 Lead row whose identity or freshness is missing or invalid", () => {
		const manifest = (leads: unknown[]) => ({
			schema_version: 2,
			components: {
				w1_process_liveness: {
					wired: true,
					effective_enabled: true,
					...W1_TRACKED_FIELDS,
				},
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
			},
		});

		for (const leads of [
			[{ lead_id: "lead-a" }],
			[{ lead_id: "", freshness: "stale" }],
			[{ lead_id: "lead-a", freshness: "unknown" }],
		]) {
			const result = validateLivenessManifest(manifest(leads));
			expect(result.ok).toBe(false);
			expect(result.errors.join("\n")).toMatch(/w2_delivery_loop\.leads/);
		}
	});

	it("FLY-1560 requires the W-1 tracker fields the probe judges health on", () => {
		const manifest = (w1: Record<string, unknown>) => ({
			schema_version: 2,
			components: {
				w1_process_liveness: w1,
				w2_delivery_loop: {
					wired: true,
					effective_enabled: true,
					leads: [{ lead_id: "lead-a", freshness: "fresh" }],
				},
				w3_external_drift: {
					wired: true,
					effective_enabled: true,
					observation: "static_contract",
				},
			},
		});
		const w1 = () => ({
			wired: true,
			effective_enabled: true,
			...W1_TRACKED_FIELDS,
		});

		// Every freshness the tracker can emit is structurally valid — the probe,
		// not the validator, decides which of them is healthy.
		for (const freshness of ["not_started", "fresh", "stale", "in_flight"]) {
			expect(
				validateLivenessManifest(manifest({ ...w1(), freshness })),
			).toEqual({ ok: true, errors: [] });
		}
		// A hung pass reports its age; null is only valid when nothing is in flight.
		expect(
			validateLivenessManifest(
				manifest({
					...w1(),
					freshness: "in_flight",
					in_flight_age_ms: 900_000,
				}),
			),
		).toEqual({ ok: true, errors: [] });

		for (const [field, badValue] of [
			["freshness", "unknown"],
			["freshness", undefined],
			["last_check_started_at", 12345],
			["last_check_completed_at", 12345],
			["in_flight_age_ms", "900000"],
			["switch", "optional"],
		] as const) {
			const row = { ...w1(), [field]: badValue };
			if (badValue === undefined)
				delete (row as Record<string, unknown>)[field];
			const result = validateLivenessManifest(manifest(row));
			expect(result.ok, `${field}=${String(badValue)}`).toBe(false);
			expect(result.errors.join("\n")).toMatch(
				new RegExp(`w1_process_liveness.*${field}`),
			);
		}

		// W-1 has no kill switch — an effective_enabled=false row is a contract break.
		const disabled = validateLivenessManifest(
			manifest({ ...w1(), effective_enabled: false }),
		);
		expect(disabled.ok).toBe(false);
		expect(disabled.errors.join("\n")).toMatch(
			/w1_process_liveness.*effective_enabled/,
		);
	});
});

describe("FLY-2131 Codex Lead model coordinates", () => {
	it("accounts for effort and context window as non-flag config values", () => {
		expect(NON_FLAG_ALLOWLIST.FLYWHEEL_LEAD_EFFORT).toMatch(/config value/i);
		expect(NON_FLAG_ALLOWLIST.FLYWHEEL_LEAD_MODEL_CONTEXT_WINDOW).toMatch(
			/numeric tuning/i,
		);
	});
});

/**
 * FLY-1560 (Codex R1 MEDIUM-2). The out-of-process liveness probe's numeric
 * knobs were renamed FLYWHEEL_WATCHDOG_* → FLYWHEEL_LIVENESS_* along with the
 * /health key. Deriving the expected set from the shipped script — instead of
 * hand-copying names here — is the whole point: a future rename that touches
 * only one side fails this test rather than shipping a knob `check-flag-truth`
 * calls "unknown" (false alarm) or a dead name it still calls valid.
 */
describe("FLY-1560 liveness probe env contract", () => {
	const probe = readFileSync(
		new URL("../../../../scripts/bridge-liveness-probe.sh", import.meta.url),
		"utf8",
	);
	const probeEnvNames = [
		...new Set(probe.match(/FLYWHEEL_LIVENESS_[A-Z_]+/g) ?? []),
	].sort();

	it("registers every FLYWHEEL_LIVENESS_* knob the shipped probe reads", () => {
		expect(probeEnvNames.length).toBeGreaterThanOrEqual(4);
		for (const envVar of probeEnvNames) {
			expect(NON_FLAG_ALLOWLIST[envVar], envVar).toBeDefined();
			expect(validateFlagTruthEnvironment([`${envVar}=5`]).ok, envVar).toBe(
				true,
			);
		}
	});

	it("tombstones the pre-rename names and the dead Lead-pane poll interval", () => {
		const tombstones = new Map(
			RETIRED_FLAGS.map((flag) => [flag.envVar, flag.retiredBy]),
		);
		for (const envVar of [
			"FLYWHEEL_WATCHDOG_DISABLED_REMINDER_MIN",
			"FLYWHEEL_WATCHDOG_MANIFEST_GRACE_MIN",
			"FLYWHEEL_WATCHDOG_MANIFEST_DEGRADED_MIN",
			"FLYWHEEL_WATCHDOG_STALLED_ESCALATE_MIN",
			// Its only reader, the Lead-pane poll loop, was deleted by this issue.
			"FLYWHEEL_LEAD_WATCHDOG_INTERVAL_MS",
		]) {
			expect(NON_FLAG_ALLOWLIST[envVar], envVar).toBeUndefined();
			expect(tombstones.get(envVar), envVar).toBe("FLY-1560");
			const result = validateFlagTruthEnvironment([`${envVar}=5`]);
			expect(result.ok, envVar).toBe(false);
			expect(result.errors.join("\n"), envVar).toMatch(/删这行/);
		}
	});
});
