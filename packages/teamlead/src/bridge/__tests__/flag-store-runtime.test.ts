import {
	resolveAllFlags,
	resolveSkillFrameworkMode,
	SKILL_FRAMEWORK_MODE_ENV,
} from "flywheel-config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../../StateStore.js";
import {
	enrichFlagViewsWithStore,
	initializeFlagStore,
	storeFlagRetirementScanEnabled,
	storeSkillFrameworkModeControl,
	storeWorkflowResumeEnabled,
	storeWorkflowReworkReentryEnabled,
	storeWorkflowTurnDivergenceAlertsEnabled,
} from "../flag-store-runtime.js";

describe("FLY-1778 flag store boot lifecycle and read-on-use", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
	});

	afterEach(() => store.close());

	it("reads every managed flag through a named wrapper and observes the next write", () => {
		const runtime = initializeFlagStore(store, {
			FLYWHEEL_FLAG_RETIREMENT_SCAN: "0",
			FLYWHEEL_WORKFLOW_REWORK_REENTRY: "",
			FLYWHEEL_SKILL_FRAMEWORK_MODE: "split",
			FLYWHEEL_WORKFLOW_RESUME: "1",
			FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS: "0",
		});
		expect(storeFlagRetirementScanEnabled(runtime)).toBe(false);
		expect(storeWorkflowReworkReentryEnabled(runtime)).toBe(true);
		expect(storeWorkflowResumeEnabled(runtime)).toBe(true);
		expect(storeWorkflowTurnDivergenceAlertsEnabled(runtime)).toBe(false);
		expect(storeSkillFrameworkModeControl(runtime)).toEqual({
			hasOverride: true,
			raw: "split",
		});

		const revision = store.getFlagValueRow("workflow_resume")!.revision;
		expect(
			store.applyFlagValueChange({
				name: "workflow_resume",
				rawTo: null,
				expectedRevision: revision,
				actor: "bridge-local-operator",
				reason: "prove read-on-use",
			}),
		).toMatchObject({ ok: true });
		expect(storeWorkflowResumeEnabled(runtime)).toBe(false);
	});

	it("fails loudly when a ready managed row disappears", () => {
		const runtime = initializeFlagStore(store, {});
		(
			store as unknown as { db: { raw: { exec(sql: string): void } } }
		).db.raw.exec("DELETE FROM flag_values WHERE flag_name='workflow_resume'");
		expect(() => storeWorkflowResumeEnabled(runtime)).toThrow(
			/missing managed flag row: workflow_resume/,
		);
	});

	it("fails boot if a protected legacy identity is manually injected", () => {
		(
			store as unknown as { db: { raw: { exec(sql: string): void } } }
		).db.raw.exec(`
			INSERT INTO flag_values (
				flag_name, has_override, raw_value, last_effective,
				value_last_changed, revision, updated_at, updated_by
			) VALUES ('codex_hard_gate_killswitch', 1, '0', 'false', NULL, 1, 1, 'test')
		`);
		expect(() => initializeFlagStore(store, {})).toThrow(
			/invalid flag_values identity: codex_hard_gate_killswitch/,
		);
	});

	it("snapshots boot bypass and preserves legacy parsing for the whole process", () => {
		const env: Record<string, string | undefined> = {
			FLYWHEEL_FLAG_STORE: "0",
			FLYWHEEL_WORKFLOW_RESUME: "0",
			FLYWHEEL_SKILL_FRAMEWORK_MODE: "split",
		};
		const runtime = initializeFlagStore(store, env, 100);
		env.FLYWHEEL_WORKFLOW_RESUME = "1";
		env.FLYWHEEL_SKILL_FRAMEWORK_MODE = "matt";
		expect(runtime.mode).toBe("bypass");
		expect(storeWorkflowResumeEnabled(runtime)).toBe(false);
		expect(storeSkillFrameworkModeControl(runtime)).toEqual({
			hasOverride: true,
			raw: "split",
		});
		expect(store.isFlagStoreBypassSeen()).toBe(true);
		expect(store.getFlagValueRow("workflow_resume")).toBeUndefined();
	});

	it("imports bypass-period env and clocks every managed value on recovery", () => {
		initializeFlagStore(store, { FLYWHEEL_WORKFLOW_RESUME: "0" }, 100);
		const staleRevision = store.getFlagValueRow("workflow_resume")!.revision;
		initializeFlagStore(
			store,
			{ FLYWHEEL_FLAG_STORE: "0", FLYWHEEL_WORKFLOW_RESUME: "1" },
			200,
		);
		const runtime = initializeFlagStore(
			store,
			{ FLYWHEEL_WORKFLOW_RESUME: "1" },
			300,
		);
		expect(runtime.mode).toBe("ready");
		expect(storeWorkflowResumeEnabled(runtime)).toBe(true);
		for (const name of [
			"flag_retirement_scan",
			"workflow_rework_reentry",
			"skill_framework_mode",
			"workflow_resume",
			"workflow_turn_divergence_alerts",
		]) {
			expect(store.getFlagValueRow(name)?.valueLastChanged, name).toBe(300);
			expect(store.listFlagValueChanges(name).at(-1)?.action, name).toBe(
				"bypass_recovery",
			);
		}
		expect(store.isFlagStoreBypassSeen()).toBe(false);
		const auditCount = store.listFlagValueChanges("workflow_resume").length;
		store.ensureFlagValueRows({ env: {}, now: 400 });
		expect(store.listFlagValueChanges("workflow_resume")).toHaveLength(
			auditCount,
		);
		expect(
			store.applyFlagValueChange({
				name: "workflow_resume",
				rawTo: null,
				expectedRevision: staleRevision,
				actor: "bridge-local-operator",
				reason: "stale pre-bypass token",
			}),
		).toMatchObject({ ok: false, reason: "stale_revision" });
	});

	it("recovery-seeds after a first-deployment bypass with a non-null clock", () => {
		initializeFlagStore(
			store,
			{ FLYWHEEL_FLAG_STORE: "0", FLYWHEEL_WORKFLOW_RESUME: "1" },
			100,
		);
		initializeFlagStore(store, { FLYWHEEL_WORKFLOW_RESUME: "1" }, 200);
		expect(store.getFlagValueRow("workflow_resume")).toMatchObject({
			hasOverride: true,
			raw: "1",
			lastEffective: "true",
			valueLastChanged: 200,
			revision: 1,
		});
		expect(store.listFlagValueChanges("workflow_resume")).toEqual([
			expect.objectContaining({ action: "bypass_recovery" }),
		]);
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
			name: "workflow_resume",
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
		expect(views.find(({ name }) => name === "workflow_resume")).toMatchObject({
			storeManaged: true,
			storeEffective: true,
			effective: true,
			displayEffective: true,
			valueLastChanged: 200,
			clockReadiness: "ready",
		});
		expect(
			views.find(({ name }) => name === "auto_qa_killswitch"),
		).toMatchObject({
			storeManaged: false,
			clockReadiness: "no_clock:unmanaged",
		});
	});

	it("keeps stale .env visible when it differs from the managed store", () => {
		const runtime = initializeFlagStore(store, {}, 100);
		store.applyFlagValueChange({
			name: "workflow_resume",
			rawTo: "1",
			expectedRevision: 1,
			actor: "bridge-local-operator",
			reason: "display divergence",
			now: 200,
		});
		const view = enrichFlagViewsWithStore(
			resolveAllFlags({
				env: {},
				envFile: {
					status: "readable",
					content: "FLYWHEEL_WORKFLOW_RESUME=0\n",
				},
			}),
			runtime,
		).find(({ name }) => name === "workflow_resume");
		expect(view).toMatchObject({
			storeEffective: true,
			bridgeEffective: true,
			fileEffective: false,
			displayEffective: true,
			divergence: "split_brain",
		});
	});

	it("labels bypass and degraded store views without presenting legacy env as authority", () => {
		const env = {
			FLYWHEEL_FLAG_STORE: "0",
			FLYWHEEL_WORKFLOW_RESUME: "1",
		};
		const bypass = initializeFlagStore(store, env, 100);
		env.FLYWHEEL_WORKFLOW_RESUME = "0";
		const bypassView = enrichFlagViewsWithStore(
			resolveAllFlags({ env }),
			bypass,
		).find(({ name }) => name === "workflow_resume");
		expect(bypassView).toMatchObject({
			storeManaged: true,
			storeEffective: true,
			displayEffective: true,
			valueLastChanged: null,
			clockReadiness: "no_clock:bypass",
		});

		const ready = initializeFlagStore(
			store,
			{ FLYWHEEL_WORKFLOW_RESUME: env.FLYWHEEL_WORKFLOW_RESUME },
			200,
		);
		(
			store as unknown as { db: { raw: { exec(sql: string): void } } }
		).db.raw.exec("DELETE FROM flag_values WHERE flag_name='workflow_resume'");
		const degraded = enrichFlagViewsWithStore(
			resolveAllFlags({ env }),
			ready,
		).find(({ name }) => name === "workflow_resume");
		expect(degraded).toMatchObject({
			storeManaged: true,
			clockReadiness: "no_clock:degraded",
		});
		expect(degraded?.displayEffective).toBeUndefined();
		expect(degraded?.error).toContain("missing managed flag row");
	});
});
