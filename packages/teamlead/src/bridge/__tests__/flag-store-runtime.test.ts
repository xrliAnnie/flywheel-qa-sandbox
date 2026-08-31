import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAllFlags, resolveSkillFrameworkMode } from "flywheel-config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	enrichFlagViewsWithStore,
	initializeFlagStore,
	readScopedBoolean,
	storeAlertSystemEnabled,
	storeCmuxRebindDisabled,
	storeCmuxWatcherRebuildDisabled,
	storeDocFlowEnabled,
	storeFlagRetirementScanEnabled,
	storeLoopProfilerEnabled,
	storePipelineDagEnabled,
	storePipelineWorkKindEnabled,
	storePonytailEnabled,
	storeProofshotEnabled,
	storeReviewQuotaAutoRetryEnabled,
	storeShippedHuskForceEnabled,
	storeSkillFrameworkModeControl,
	storeSkillFrameworkSplitParticipation,
	storeSummaryAbsorptionCadenceMs,
	storeWorkflowNodeReuseEnabled,
	storeWorkflowReworkReentryEnabled,
	storeWorkflowTurnDivergenceAlertsEnabled,
	storeXiaohongshuLearningEnabled,
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
		expect(storeWorkflowNodeReuseEnabled(runtime)).toBe(false);
		expect(storeWorkflowTurnDivergenceAlertsEnabled(runtime)).toBe(true);
		expect(storeSkillFrameworkModeControl(runtime)).toEqual({
			hasOverride: true,
			raw: "split",
		});

		const reuseRevision = store.getFlagValueRow(
			"workflow_node_reuse",
		)!.revision;
		expect(
			store.applyFlagValueChange({
				name: "workflow_node_reuse",
				rawTo: "1",
				expectedRevision: reuseRevision,
				actor: "bridge-local-operator",
				reason: "prove QA node reuse reads at call time",
			}),
		).toMatchObject({ ok: true });
		expect(storeWorkflowNodeReuseEnabled(runtime)).toBe(true);

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

	it("FLY-2207 observes the opt-in watcher rebuild disable without restart", () => {
		const runtime = initializeFlagStore(store, {});
		expect(storeCmuxWatcherRebuildDisabled(runtime)).toBe(false);

		const revision = store.getFlagValueRow(
			"cmux_watcher_rebuild_disabled",
		)!.revision;
		expect(
			store.applyFlagValueChange({
				name: "cmux_watcher_rebuild_disabled",
				rawTo: "1",
				expectedRevision: revision,
				actor: "bridge-local-operator",
				reason: "pause watcher rebuilds during incident control",
			}),
		).toMatchObject({ ok: true });
		expect(storeCmuxWatcherRebuildDisabled(runtime)).toBe(true);
	});

	it("FLY-2207 observes the opt-in viewer rebind disable without restart", () => {
		const runtime = initializeFlagStore(store, {});
		expect(storeCmuxRebindDisabled(runtime)).toBe(false);

		const revision = store.getFlagValueRow("cmux_rebind_disabled")!.revision;
		expect(
			store.applyFlagValueChange({
				name: "cmux_rebind_disabled",
				rawTo: "1",
				expectedRevision: revision,
				actor: "bridge-local-operator",
				reason: "pause viewer reconstruction during incident control",
			}),
		).toMatchObject({ ok: true });
		expect(storeCmuxRebindDisabled(runtime)).toBe(true);
	});

	it("FLY-2177 keeps quota retry default-on and observes an off write without restart", () => {
		const runtime = initializeFlagStore(store, {});
		expect(storeReviewQuotaAutoRetryEnabled(runtime)).toBe(true);

		const revision = store.getFlagValueRow("review_quota_auto_retry")!.revision;
		expect(
			store.applyFlagValueChange({
				name: "review_quota_auto_retry",
				rawTo: "0",
				expectedRevision: revision,
				actor: "bridge-local-operator",
				reason: "pause reviewer quota recovery during incident control",
			}),
		).toMatchObject({ ok: true });
		expect(storeReviewQuotaAutoRetryEnabled(runtime)).toBe(false);
	});

	it("resolves all seven project flags from project row, star row, then registry default", () => {
		const runtime = initializeFlagStore(store, {});
		expect(storeDocFlowEnabled(runtime, "flywheel")).toBe(false);
		expect(storePipelineDagEnabled(runtime, "flywheel")).toBe(true);
		expect(storePipelineWorkKindEnabled(runtime, "flywheel")).toBe(false);
		expect(storeProofshotEnabled(runtime, "flywheel")).toBe(false);
		expect(storeXiaohongshuLearningEnabled(runtime, "flywheel")).toBe(false);
		expect(storePonytailEnabled(runtime, "flywheel")).toBe(false);
		expect(storeSkillFrameworkSplitParticipation(runtime, "flywheel")).toBe(
			true,
		);

		expect(
			store.applyScopedFlagValueChange({
				name: "doc_flow",
				scope: "*",
				op: "set",
				rawTo: "1",
				expectedChangeSeq: 0,
				actor: "fixture",
				reason: "star on",
			}),
		).toMatchObject({ ok: true });
		expect(storeDocFlowEnabled(runtime, "geoforge3d")).toBe(true);
		expect(
			store.applyScopedFlagValueChange({
				name: "doc_flow",
				scope: "flywheel",
				op: "set",
				rawTo: "0",
				expectedChangeSeq: 0,
				actor: "fixture",
				reason: "project off",
			}),
		).toMatchObject({ ok: true });
		expect(storeDocFlowEnabled(runtime, "flywheel")).toBe(false);
		expect(storeDocFlowEnabled(runtime, "geoforge3d")).toBe(true);
	});

	it("rejects unmanaged project identities and propagates store failures", () => {
		const runtime = initializeFlagStore(store, {});
		expect(() =>
			readScopedBoolean(runtime, "checkpoint_enabled", "flywheel"),
		).toThrow(/flag is not project-store-managed: checkpoint_enabled/);
		const getRow = store.getFlagValueRow.bind(store);
		store.getFlagValueRow = (() => {
			throw new Error("scoped store unavailable");
		}) as typeof store.getFlagValueRow;
		expect(() => storeDocFlowEnabled(runtime, "flywheel")).toThrow(
			/scoped store unavailable/,
		);
		store.getFlagValueRow = getRow;
	});

	it("reads the summary absorption cadence at call time after a store write", () => {
		const runtime = initializeFlagStore(store, {});
		expect(storeSummaryAbsorptionCadenceMs(runtime)).toBe(21_600_000);
		const revision = store.getFlagValueRow(
			"summary_absorption_cadence_ms",
		)!.revision;
		expect(
			store.applyFlagValueChange({
				name: "summary_absorption_cadence_ms",
				rawTo: "60000",
				expectedRevision: revision,
				actor: "bridge-local-operator",
				reason: "exercise hot cadence",
			}),
		).toMatchObject({ ok: true });
		expect(storeSummaryAbsorptionCadenceMs(runtime)).toBe(60_000);
	});

	it("falls back to the cadence default when the bootstrap seed is invalid without weakening writes", () => {
		const warnings: string[] = [];
		const runtime = initializeFlagStore(
			store,
			{ FLYWHEEL_SUMMARY_ABSORPTION_CADENCE_MS: "6h" },
			100,
			(message) => warnings.push(message),
		);

		expect(
			store.getFlagValueRow("summary_absorption_cadence_ms"),
		).toMatchObject({
			hasOverride: false,
			raw: null,
			lastEffective: "21600000",
		});
		expect(storeSummaryAbsorptionCadenceMs(runtime)).toBe(21_600_000);
		expect(warnings).toEqual([
			expect.stringMatching(
				/FLYWHEEL_SUMMARY_ABSORPTION_CADENCE_MS.*invalid bootstrap seed.*registry default/i,
			),
		]);

		const revision = store.getFlagValueRow(
			"summary_absorption_cadence_ms",
		)!.revision;
		expect(() =>
			store.applyFlagValueChange({
				name: "summary_absorption_cadence_ms",
				rawTo: "6h",
				expectedRevision: revision,
				actor: "bridge-local-operator",
				reason: "prove management validation stays strict",
			}),
		).toThrow(/summary absorption cadence/i);
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

	it.each(["manual_unlisted_flag", "future_unretired_flag"])(
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

	it("ignores the retired store flag and stays DB-authoritative", () => {
		const runtime = initializeFlagStore(
			store,
			{
				FLYWHEEL_FLAG_STORE: "0",
				FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS: "1",
			},
			100,
		);

		expect(runtime.mode).toBe("ready");
		expect(storeWorkflowTurnDivergenceAlertsEnabled(runtime)).toBe(true);
		expect(
			store.getFlagValueRow("workflow_turn_divergence_alerts"),
		).toMatchObject({ hasOverride: true, raw: "1", revision: 1 });
	});

	it("feeds the raw split control into the existing issue-aware resolver", () => {
		const runtime = initializeFlagStore(store, {
			FLYWHEEL_SKILL_FRAMEWORK_MODE: "split",
		});
		const control = storeSkillFrameworkModeControl(runtime);
		const raw = control.hasOverride ? (control.raw ?? undefined) : undefined;
		const first = resolveSkillFrameworkMode({ raw, issueIdentifier: "FLY-1" });
		const second = resolveSkillFrameworkMode({ raw, issueIdentifier: "FLY-2" });
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
		expect(views.some(({ name }) => name === "checkpoint_enabled")).toBe(false);
	});

	it("overlays project, star, and default values while exposing only scoped row truth", () => {
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
			resolveAllFlags({ env: {} }),
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
			},
			{
				projectName: "new-project",
				value: false,
				isDefault: true,
				via: "star_row",
			},
		]);
	});

	it("treats a rowless project flag as a healthy registry default", () => {
		const base = resolveAllFlags({ env: {} });
		const views = enrichFlagViewsWithStore(
			base,
			initializeFlagStore(store, { FLYWHEEL_FLAG_STORE: "0" }, 100),
			["flywheel"],
		);
		const docFlow = views.find(({ name }) => name === "doc_flow");
		expect(docFlow?.effectiveByProject).toEqual([
			{
				projectName: "flywheel",
				value: false,
				isDefault: true,
				via: "default",
			},
		]);
		expect(docFlow?.projectStoreManaged).toBe(true);
		expect(docFlow?.clockReadiness).toBe("ready");
		expect(docFlow?.scopedStore).toEqual({ rows: [] });
		expect(docFlow?.valueClocks).toEqual([]);
		expect(docFlow?.error).toBeUndefined();
		const ponytail = views.find(({ name }) => name === "ponytail");
		expect(ponytail?.projectStoreManaged).toBe(true);
		expect(ponytail?.effectiveByProject?.[0]).toMatchObject({
			value: false,
			via: "default",
		});
		const split = views.find(
			({ name }) => name === "skill_framework_split_participation",
		);
		expect(split?.effectiveByProject?.[0]).toMatchObject({
			value: true,
			via: "default",
		});
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

	it("labels degraded store views without presenting legacy env as authority", () => {
		const env = {
			FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS: "1",
		};
		const ready = initializeFlagStore(store, env, 200);
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
