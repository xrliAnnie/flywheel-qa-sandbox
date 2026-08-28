import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resolveAllFlags,
	resolveSkillFrameworkMode,
	SKILL_FRAMEWORK_MODE_ENV,
	STORE_MANAGED_FLAGS,
} from "flywheel-config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	enrichFlagViewsWithStore,
	initializeFlagStore,
	storeAlertSystemEnabled,
	storeFlagRetirementScanEnabled,
	storeLoopProfilerEnabled,
	storeShippedHuskForceEnabled,
	storeSkillFrameworkModeControl,
	storeWorkflowReworkReentryEnabled,
	storeWorkflowTurnDivergenceAlertsEnabled,
} from "../flag-store-runtime.js";

function rawFlagStoreDb(store: StateStore): {
	exec(sql: string): void;
	prepare(sql: string): { all(...params: unknown[]): unknown[] };
} {
	return (
		store as unknown as {
			db: {
				raw: {
					exec(sql: string): void;
					prepare(sql: string): { all(...params: unknown[]): unknown[] };
				};
			};
		}
	).db.raw;
}

describe("FLY-1778 flag store boot lifecycle and read-on-use", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => store.close());

	it("reads every managed flag through a named wrapper and observes the next write", () => {
		const runtime = initializeFlagStore(store, {
			FLYWHEEL_LOOP_PROFILER: "0",
			FLYWHEEL_SHIPPED_HUSK_FORCE: "0",
			FLYWHEEL_FLAG_RETIREMENT_SCAN: "0",
			FLYWHEEL_WORKFLOW_REWORK_REENTRY: "",
			FLYWHEEL_SKILL_FRAMEWORK_MODE: "split",
			FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS: "1",
		});
		expect(storeFlagRetirementScanEnabled(runtime)).toBe(false);
		expect(storeLoopProfilerEnabled(runtime)).toBe(false);
		expect(storeShippedHuskForceEnabled(runtime)).toBe(false);
		expect(storeWorkflowReworkReentryEnabled(runtime)).toBe(true);
		expect(storeWorkflowTurnDivergenceAlertsEnabled(runtime)).toBe(true);
		expect(storeSkillFrameworkModeControl(runtime)).toEqual({
			hasOverride: true,
			raw: "split",
		});

		const revision = store.getFlagValueRow(
			"workflow_turn_divergence_alerts",
		)!.revision;
		expect(
			store.applyFlagValueChange({
				name: "workflow_turn_divergence_alerts",
				rawTo: null,
				expectedRevision: revision,
				actor: "bridge-local-operator",
				reason: "prove read-on-use",
			}),
		).toMatchObject({ ok: true });
		expect(storeWorkflowTurnDivergenceAlertsEnabled(runtime)).toBe(false);

		for (const name of ["loop_profiler", "shipped_husk_force"] as const) {
			const managedRevision = store.getFlagValueRow(name)!.revision;
			expect(
				store.applyFlagValueChange({
					name,
					rawTo: "1",
					expectedRevision: managedRevision,
					actor: "bridge-local-operator",
					reason: "prove new managed read-on-use",
				}),
			).toMatchObject({ ok: true });
		}
		expect(storeLoopProfilerEnabled(runtime)).toBe(true);
		expect(storeShippedHuskForceEnabled(runtime)).toBe(true);
	});

	it("FLY-2076 keeps the alert system default-on and observes an off write without restart", () => {
		const runtime = initializeFlagStore(store, {});
		expect(storeAlertSystemEnabled(runtime)).toBe(true);

		const revision = store.getFlagValueRow("alert_system")!.revision;
		expect(
			store.applyFlagValueChange({
				name: "alert_system",
				rawTo: "0",
				expectedRevision: revision,
				actor: "bridge-local-operator",
				reason: "pause alert delivery for incident control",
			}),
		).toMatchObject({ ok: true });
		expect(storeAlertSystemEnabled(runtime)).toBe(false);
	});

	it("fails loudly when a ready managed row disappears", () => {
		const runtime = initializeFlagStore(store, {});
		(
			store as unknown as { db: { raw: { exec(sql: string): void } } }
		).db.raw.exec(
			"DELETE FROM flag_values WHERE flag_name='workflow_turn_divergence_alerts'",
		);
		expect(() => storeWorkflowTurnDivergenceAlertsEnabled(runtime)).toThrow(
			/missing managed flag row: workflow_turn_divergence_alerts/,
		);
	});

	it.each(["mailbox_queue", "future_unretired_flag"])(
		"fails boot if unretired identity %s is manually injected",
		(flagName) => {
			rawFlagStoreDb(store).exec(`
				INSERT INTO flag_values (
					flag_name, has_override, raw_value, last_effective,
					value_last_changed, revision, updated_at, updated_by
				) VALUES ('${flagName}', 1, '0', 'false', NULL, 1, 1, 'test')
			`);
			expect(() => initializeFlagStore(store, {})).toThrow(
				new RegExp(`invalid flag_values identity: ${flagName}`),
			);
		},
	);

	it("upgrades a file-backed workflow_resume row without changing its audit history", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1981-flag-store-upgrade-"));
		const dbPath = join(root, "teamlead.db");
		let reopened: StateStore | undefined;
		try {
			const legacy = await StateStore.create(dbPath);
			reopened = legacy;
			const legacyDb = rawFlagStoreDb(legacy);
			legacyDb.exec(`
				INSERT INTO flag_values (
					flag_name, has_override, raw_value, last_effective,
					value_last_changed, revision, updated_at, updated_by
				) VALUES ('workflow_resume', 1, '0', 'false', 111, 2, 222, 'legacy-operator');
				INSERT INTO flag_value_changelog (
					flag_name, action, from_present, from_raw, to_present, to_raw,
					from_effective, to_effective, changed_by, changed_at, reason
				) VALUES (
					'workflow_resume', 'set', 0, NULL, 1, '0',
					'true', 'false', 'legacy-operator', 222, 'legacy emergency override'
				);
			`);
			const historySql = `SELECT id, flag_name, action, from_present, from_raw,
				to_present, to_raw, from_effective, to_effective, changed_by,
				changed_at, reason FROM flag_value_changelog
				WHERE flag_name = 'workflow_resume' ORDER BY id`;
			const historyBefore = JSON.stringify(legacyDb.prepare(historySql).all());
			legacy.close();
			reopened = undefined;

			const firstBoot = await StateStore.create(dbPath);
			reopened = firstBoot;
			expect(() => initializeFlagStore(firstBoot, {}, 300)).not.toThrow();
			expect(firstBoot.getFlagValueRow("workflow_resume")).toBeUndefined();
			expect(
				JSON.stringify(rawFlagStoreDb(firstBoot).prepare(historySql).all()),
			).toBe(historyBefore);

			firstBoot.close();
			reopened = undefined;
			const secondBoot = await StateStore.create(dbPath);
			reopened = secondBoot;
			expect(() => initializeFlagStore(secondBoot, {}, 400)).not.toThrow();
			expect(secondBoot.getFlagValueRow("workflow_resume")).toBeUndefined();
			expect(
				JSON.stringify(rawFlagStoreDb(secondBoot).prepare(historySql).all()),
			).toBe(historyBefore);
			expect(
				secondBoot.applyFlagValueChange({
					name: "workflow_resume",
					rawTo: "1",
					expectedRevision: 2,
					actor: "bridge-local-operator",
					reason: "must stay retired",
				}),
			).toEqual({ ok: false, reason: "retired_flag" });
		} finally {
			reopened?.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("snapshots boot bypass and preserves legacy parsing for the whole process", () => {
		const env: Record<string, string | undefined> = {
			FLYWHEEL_FLAG_STORE: "0",
			FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS: "0",
			FLYWHEEL_SKILL_FRAMEWORK_MODE: "split",
		};
		const runtime = initializeFlagStore(store, env, 100);
		env.FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS = "1";
		env.FLYWHEEL_SKILL_FRAMEWORK_MODE = "matt";
		expect(runtime.mode).toBe("bypass");
		expect(storeWorkflowTurnDivergenceAlertsEnabled(runtime)).toBe(false);
		expect(storeSkillFrameworkModeControl(runtime)).toEqual({
			hasOverride: true,
			raw: "split",
		});
		expect(store.isFlagStoreBypassSeen()).toBe(true);
		expect(
			store.getFlagValueRow("workflow_turn_divergence_alerts"),
		).toBeUndefined();
	});

	it("imports bypass-period env and clocks every managed value on recovery", () => {
		initializeFlagStore(
			store,
			{ FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS: "0" },
			100,
		);
		const rowsBeforeBypass = new Map(
			[...STORE_MANAGED_FLAGS].map((name) => [
				name,
				store.getFlagValueRow(name),
			]),
		);
		const staleRevision = store.getFlagValueRow(
			"workflow_turn_divergence_alerts",
		)!.revision;
		initializeFlagStore(
			store,
			{
				FLYWHEEL_FLAG_STORE: "0",
				FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS: "1",
			},
			200,
		);
		const runtime = initializeFlagStore(
			store,
			{ FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS: "1" },
			300,
		);
		expect(runtime.mode).toBe("ready");
		expect(storeWorkflowTurnDivergenceAlertsEnabled(runtime)).toBe(true);
		for (const name of STORE_MANAGED_FLAGS) {
			const row = store.getFlagValueRow(name);
			if (name === "workflow_turn_divergence_alerts") {
				expect(row?.valueLastChanged, name).toBe(300);
			} else {
				expect(row, name).toEqual(rowsBeforeBypass.get(name));
			}
			expect(store.listFlagValueChanges(name).at(-1)?.action, name).toBe(
				"bypass_recovery",
			);
		}
		expect(store.isFlagStoreBypassSeen()).toBe(false);
		const auditCount = store.listFlagValueChanges(
			"workflow_turn_divergence_alerts",
		).length;
		store.ensureFlagValueRows({ env: {}, now: 400 });
		expect(
			store.listFlagValueChanges("workflow_turn_divergence_alerts"),
		).toHaveLength(auditCount);
		expect(
			store.applyFlagValueChange({
				name: "workflow_turn_divergence_alerts",
				rawTo: null,
				expectedRevision: staleRevision,
				actor: "bridge-local-operator",
				reason: "stale pre-bypass token",
			}),
		).toMatchObject({ ok: false, reason: "stale_revision" });
	});

	it("preserves a store override when bypass recovery has no legacy env authority", () => {
		initializeFlagStore(store, {}, 100);
		const initial = store.getFlagValueRow("skill_framework_mode")!;
		store.applyFlagValueChange({
			name: "skill_framework_mode",
			rawTo: "split",
			expectedRevision: initial.revision,
			actor: "bridge-local-operator",
			reason: "pre-bypass managed override",
			now: 200,
		});
		const beforeBypass = store.getFlagValueRow("skill_framework_mode");

		initializeFlagStore(store, { FLYWHEEL_FLAG_STORE: "0" }, 300);
		const runtime = initializeFlagStore(store, {}, 400);

		expect(runtime.mode).toBe("ready");
		expect(store.getFlagValueRow("skill_framework_mode")).toEqual(beforeBypass);
		expect(storeSkillFrameworkModeControl(runtime)).toEqual({
			hasOverride: true,
			raw: "split",
		});
		expect(
			store.listFlagValueChanges("skill_framework_mode").at(-1),
		).toMatchObject({
			action: "bypass_recovery",
			fromRaw: "split",
			toRaw: "split",
			fromEffective: "split",
			toEffective: "split",
		});
	});

	it("treats an empty legacy enum assignment as absent during recovery", () => {
		initializeFlagStore(store, {}, 100);
		const initial = store.getFlagValueRow("skill_framework_mode")!;
		store.applyFlagValueChange({
			name: "skill_framework_mode",
			rawTo: "split",
			expectedRevision: initial.revision,
			actor: "bridge-local-operator",
			reason: "pre-bypass managed override",
			now: 200,
		});
		const beforeBypass = store.getFlagValueRow("skill_framework_mode");

		initializeFlagStore(store, { FLYWHEEL_FLAG_STORE: "0" }, 300);
		const runtime = initializeFlagStore(
			store,
			{ FLYWHEEL_SKILL_FRAMEWORK_MODE: "" },
			400,
		);

		expect(runtime.mode).toBe("ready");
		expect(store.getFlagValueRow("skill_framework_mode")).toEqual(beforeBypass);
		expect(storeSkillFrameworkModeControl(runtime)).toEqual({
			hasOverride: true,
			raw: "split",
		});
		expect(
			store.listFlagValueChanges("skill_framework_mode").at(-1),
		).toMatchObject({
			action: "bypass_recovery",
			fromRaw: "split",
			toRaw: "split",
			fromEffective: "split",
			toEffective: "split",
		});
	});

	it("imports an empty legacy boolean assignment with its existing semantics", () => {
		initializeFlagStore(store, { FLYWHEEL_WORKFLOW_REWORK_REENTRY: "0" }, 100);
		initializeFlagStore(store, { FLYWHEEL_FLAG_STORE: "0" }, 200);

		const runtime = initializeFlagStore(
			store,
			{ FLYWHEEL_WORKFLOW_REWORK_REENTRY: "" },
			300,
		);

		expect(runtime.mode).toBe("ready");
		expect(store.getFlagValueRow("workflow_rework_reentry")).toMatchObject({
			hasOverride: true,
			raw: "",
			lastEffective: "true",
			valueLastChanged: 300,
			revision: 2,
		});
		expect(storeWorkflowReworkReentryEnabled(runtime)).toBe(true);
	});

	it("reconciles a default shift while recovering without a legacy env line", () => {
		initializeFlagStore(store, {}, 100);
		rawFlagStoreDb(store).exec(
			"UPDATE flag_values SET last_effective='false' WHERE flag_name='flag_retirement_scan'",
		);
		initializeFlagStore(store, { FLYWHEEL_FLAG_STORE: "0" }, 200);

		const runtime = initializeFlagStore(store, {}, 300);

		expect(runtime.mode).toBe("ready");
		expect(store.getFlagValueRow("flag_retirement_scan")).toMatchObject({
			hasOverride: false,
			raw: null,
			lastEffective: "true",
			valueLastChanged: 300,
			revision: 2,
			updatedBy: "flag-store-recovery",
		});
		expect(
			store.listFlagValueChanges("flag_retirement_scan").at(-1),
		).toMatchObject({
			action: "bypass_recovery",
			fromEffective: "false",
			toEffective: "true",
		});
	});

	it("recovery-seeds after a first-deployment bypass with a non-null clock", () => {
		initializeFlagStore(
			store,
			{
				FLYWHEEL_FLAG_STORE: "0",
				FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS: "1",
			},
			100,
		);
		initializeFlagStore(
			store,
			{ FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS: "1" },
			200,
		);
		expect(
			store.getFlagValueRow("workflow_turn_divergence_alerts"),
		).toMatchObject({
			hasOverride: true,
			raw: "1",
			lastEffective: "true",
			valueLastChanged: 200,
			revision: 1,
		});
		expect(
			store.listFlagValueChanges("workflow_turn_divergence_alerts"),
		).toEqual([expect.objectContaining({ action: "bypass_recovery" })]);
	});

	it("rolls back the entire recovery and keeps the fence on audit failure", () => {
		initializeFlagStore(store, { FLYWHEEL_FLAG_STORE: "0" }, 100);
		(
			store as unknown as { db: { raw: { exec(sql: string): void } } }
		).db.raw.exec(`
			CREATE TRIGGER reject_bypass_recovery
			BEFORE INSERT ON flag_value_changelog
			WHEN NEW.action = 'bypass_recovery'
			BEGIN SELECT RAISE(ABORT, 'forced recovery failure'); END
		`);
		expect(() => initializeFlagStore(store, {}, 200)).toThrow(
			/forced recovery failure/,
		);
		expect(store.isFlagStoreBypassSeen()).toBe(true);
		expect(store.getFlagValueRow("flag_retirement_scan")).toBeUndefined();
	});

	it("feeds the raw split control into the existing issue-aware resolver", () => {
		const runtime = initializeFlagStore(store, {
			FLYWHEEL_SKILL_FRAMEWORK_MODE: "split",
		});
		const control = storeSkillFrameworkModeControl(runtime);
		const env = control.hasOverride
			? { [SKILL_FRAMEWORK_MODE_ENV]: control.raw ?? undefined }
			: {};
		const first = resolveSkillFrameworkMode({ env, issueIdentifier: "FLY-1" });
		const second = resolveSkillFrameworkMode({ env, issueIdentifier: "FLY-2" });
		expect(first.via).toBe("hash");
		expect(second.via).toBe("hash");
	});

	it("enriches views with the authoritative store value and clock readiness", () => {
		const runtime = initializeFlagStore(store, {}, 100);
		store.applyFlagValueChange({
			name: "workflow_turn_divergence_alerts",
			rawTo: "1",
			expectedRevision: 1,
			actor: "bridge-local-operator",
			reason: "display proof",
			now: 200,
		});
		const views = enrichFlagViewsWithStore(
			resolveAllFlags({ env: {} }),
			runtime,
		);
		expect(
			views.find(({ name }) => name === "workflow_turn_divergence_alerts"),
		).toMatchObject({
			storeManaged: true,
			storeEffective: true,
			effective: true,
			displayEffective: true,
			valueLastChanged: 200,
			clockReadiness: "ready",
			valueClocks: [
				{
					scopeKey: "*",
					valueLastChanged: 200,
					firstRegisteredAt: 100,
					readiness: "ready",
				},
			],
		});
		expect(
			views.find(({ name }) => name === "founder_review_orphan_monitor"),
		).toMatchObject({
			storeManaged: false,
			clockReadiness: "no_clock:unmanaged",
		});
		expect(
			views.find(({ name }) => name === "founder_review_orphan_monitor")
				?.valueClocks,
		).toBeUndefined();
	});

	it("overlays project, star, config, and default values while exposing only scoped row truth", () => {
		const runtime = initializeFlagStore(store, {}, 100);
		expect(
			store.applyScopedFlagValueChange({
				name: "doc_flow",
				scope: "*",
				op: "set",
				rawTo: "0",
				expectedChangeSeq: 0,
				actor: "fixture",
				reason: "star off",
			}),
		).toMatchObject({ ok: true });
		expect(
			store.applyScopedFlagValueChange({
				name: "doc_flow",
				scope: "flywheel",
				op: "set",
				rawTo: "1",
				expectedChangeSeq: 0,
				actor: "fixture",
				reason: "flywheel on",
			}),
		).toMatchObject({ ok: true });

		const view = enrichFlagViewsWithStore(
			resolveAllFlags({
				env: {},
				projectConfigs: new Map([
					[
						"flywheel",
						{
							config: {
								doc_flow: {
									enabled: true,
									default_department: "engineering",
								},
							} as never,
						},
					],
					[
						"geoforge3d",
						{
							config: {
								doc_flow: {
									enabled: true,
									default_department: "engineering",
								},
							} as never,
						},
					],
				]),
			}),
			runtime,
			["flywheel", "geoforge3d", "new-project"],
		).find(({ name }) => name === "doc_flow");

		expect(view).toMatchObject({
			projectStoreManaged: true,
			storeManaged: false,
			clockReadiness: "ready",
			scopedStore: {
				rows: [
					{ scope: "*", raw: "0", value: false },
					{ scope: "flywheel", raw: "1", value: true },
				],
			},
		});
		expect(view?.valueClocks).toEqual([
			expect.objectContaining({ scopeKey: "*", readiness: "ready" }),
			expect.objectContaining({ scopeKey: "flywheel", readiness: "ready" }),
		]);
		expect(view?.effectiveByProject).toEqual([
			{
				projectName: "flywheel",
				value: true,
				isDefault: false,
				via: "project_row",
			},
			{
				projectName: "geoforge3d",
				value: false,
				isDefault: true,
				via: "star_row",
				runtimeConfigValue: true,
				runtimeDivergence: "config_pending_cutover",
			},
			{
				projectName: "new-project",
				value: false,
				isDefault: true,
				via: "star_row",
			},
		]);
	});

	it("leaves project config views byte-compatible during bypass and for non-whitelisted flags", () => {
		const configs = new Map([
			[
				"flywheel",
				{
					config: {
						doc_flow: {
							enabled: true,
							default_department: "engineering",
						},
						ponytail: { enabled: true },
					} as never,
				},
			],
		]);
		const base = resolveAllFlags({ env: {}, projectConfigs: configs });
		const bypass = enrichFlagViewsWithStore(
			base,
			initializeFlagStore(store, { FLYWHEEL_FLAG_STORE: "0" }, 100),
			["flywheel"],
		);
		const docFlow = bypass.find(({ name }) => name === "doc_flow");
		expect(docFlow?.effectiveByProject).toEqual(
			base.find(({ name }) => name === "doc_flow")?.effectiveByProject,
		);
		expect(docFlow?.projectStoreManaged).toBeUndefined();
		expect(docFlow?.scopedStore).toBeUndefined();
		const ponytail = bypass.find(({ name }) => name === "ponytail");
		expect(ponytail?.projectStoreManaged).toBeUndefined();
		expect(ponytail?.scopedStore).toBeUndefined();
	});

	it("degrades only the managed view whose value clock audit is malformed", () => {
		const runtime = initializeFlagStore(store, {}, 100);
		rawFlagStoreDb(store).exec(
			"DELETE FROM flag_value_changelog WHERE flag_name='workflow_turn_divergence_alerts'",
		);

		const views = enrichFlagViewsWithStore(
			resolveAllFlags({ env: {} }),
			runtime,
		);
		expect(
			views.find(({ name }) => name === "workflow_turn_divergence_alerts"),
		).toMatchObject({
			storeManaged: true,
			clockReadiness: "no_clock:degraded",
		});
		expect(
			views.find(({ name }) => name === "flag_retirement_scan"),
		).toMatchObject({
			storeManaged: true,
			clockReadiness: "ready",
		});
	});

	it.each([
		["missing", { status: "readable", content: "OTHER=1\n" }, false],
		[
			"stale",
			{
				status: "readable",
				content: "FLYWHEEL_SKILL_FRAMEWORK_MODE=bare\n",
			},
			true,
		],
		["unavailable", { status: "unavailable" }, undefined],
		[
			"invalid",
			{
				status: "readable",
				content: "FLYWHEEL_SKILL_FRAMEWORK_MODE=not-a-mode\n",
			},
			true,
		],
	] as const)(
		"treats the ready store as sole authority when legacy .env is %s",
		(_case, envFile, fileConfigured) => {
			const env = { FLYWHEEL_SKILL_FRAMEWORK_MODE: "split" };
			const runtime = initializeFlagStore(store, env, 100);
			const view = enrichFlagViewsWithStore(
				resolveAllFlags({ env, envFile }),
				runtime,
			).find(({ name }) => name === "skill_framework_mode");
			expect(view).toMatchObject({
				storeManaged: true,
				storeEffective: "split",
				bridgeEffective: "split",
				displayEffective: "split",
				clockReadiness: "ready",
			});
			expect(view?.fileEffective).toBeUndefined();
			expect(view?.fileConfigured).toBe(fileConfigured);
			expect(view?.divergence).toBeUndefined();
			expect(view?.error).toBeUndefined();
		},
	);

	it("projects a public store write when process and file env are both absent", () => {
		const runtime = initializeFlagStore(store, {}, 100);
		const row = store.getFlagValueRow("skill_framework_mode")!;
		store.applyFlagValueChange({
			name: "skill_framework_mode",
			rawTo: "split",
			expectedRevision: row.revision,
			actor: "bridge-local-operator",
			reason: "prove post-cleanup shape",
			now: 200,
		});
		const view = enrichFlagViewsWithStore(
			resolveAllFlags({
				env: {},
				envFile: { status: "readable", content: "OTHER=1\n" },
			}),
			runtime,
		).find(({ name }) => name === "skill_framework_mode");
		expect(view).toMatchObject({
			storeEffective: "split",
			displayEffective: "split",
			fileConfigured: false,
		});
		expect(view?.fileEffective).toBeUndefined();
		expect(view?.divergence).toBeUndefined();
		expect(view?.error).toBeUndefined();
	});

	it("keeps stale .env comparison visible during explicit store bypass", () => {
		const env = {
			FLYWHEEL_FLAG_STORE: "0",
			FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS: "1",
		};
		const runtime = initializeFlagStore(store, env, 100);
		const view = enrichFlagViewsWithStore(
			resolveAllFlags({
				env,
				envFile: {
					status: "readable",
					content: "FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS=0\n",
				},
			}),
			runtime,
		).find(({ name }) => name === "workflow_turn_divergence_alerts");
		expect(view).toMatchObject({
			storeEffective: true,
			bridgeEffective: true,
			fileEffective: false,
			displayEffective: true,
			divergence: "split_brain",
			clockReadiness: "no_clock:bypass",
		});
	});

	it("labels bypass and degraded store views without presenting legacy env as authority", () => {
		const env = {
			FLYWHEEL_FLAG_STORE: "0",
			FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS: "1",
		};
		const bypass = initializeFlagStore(store, env, 100);
		env.FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS = "0";
		const bypassView = enrichFlagViewsWithStore(
			resolveAllFlags({ env }),
			bypass,
		).find(({ name }) => name === "workflow_turn_divergence_alerts");
		expect(bypassView).toMatchObject({
			storeManaged: true,
			storeEffective: true,
			displayEffective: true,
			valueLastChanged: null,
			clockReadiness: "no_clock:bypass",
		});

		const ready = initializeFlagStore(
			store,
			{
				FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS:
					env.FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS,
			},
			200,
		);
		(
			store as unknown as { db: { raw: { exec(sql: string): void } } }
		).db.raw.exec(
			"DELETE FROM flag_values WHERE flag_name='workflow_turn_divergence_alerts'",
		);
		const degraded = enrichFlagViewsWithStore(
			resolveAllFlags({ env }),
			ready,
		).find(({ name }) => name === "workflow_turn_divergence_alerts");
		expect(degraded).toMatchObject({
			storeManaged: true,
			clockReadiness: "no_clock:degraded",
		});
		expect(degraded?.displayEffective).toBeUndefined();
		expect(degraded?.error).toContain("missing managed flag row");
	});
});
