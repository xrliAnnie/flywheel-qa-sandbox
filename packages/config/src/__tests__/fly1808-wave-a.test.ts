import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FLAG_EXEMPTIONS } from "../feature-flags/exemptions.js";
import { FEATURE_FLAGS } from "../feature-flags/registry.js";
import {
	RETIRED_FLAGS,
	validateFlagTruthEnvironment,
} from "../feature-flags/truth.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

const WAVE_A_DELETED_ROWS = [
	"founder_ux_gate",
	"founder_ux_gate_killswitch",
	"runner_autocontinue",
	"comm_bypass_bridge",
	"cmux_linked_view",
] as const;
const WAVE_A_RETIRED_FLAG_ENVS = [
	"FLYWHEEL_FOUNDER_UX_GATE_ENABLED",
	"FLYWHEEL_RUNNER_AUTOCONTINUE",
	"FLYWHEEL_COMM_BYPASS_BRIDGE",
	"FLYWHEEL_CMUX_LINKED_VIEW",
] as const;
const WAVE_A_RETIRED_COMPANION_ENVS = [
	"FLYWHEEL_AUTOCONTINUE_ARM_WINDOW_MS",
] as const;
const WAVE_B_DELETED_ROWS = [
	"workflow_template_dispatch",
	"workflow_generalized_templates",
	"workflow_claims_write",
	"workflow_claims_read",
	"workflow_gate_carrier",
] as const;
const WAVE_B_RETIRED_FLAG_ENVS = [
	"FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH",
	"FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES",
	"FLYWHEEL_WORKFLOW_CLAIMS_WRITE",
	"FLYWHEEL_WORKFLOW_CLAIMS_READ",
	"FLYWHEEL_WORKFLOW_GATE_CARRIER",
] as const;

function productionSource(path: string): string {
	return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

describe("FLY-1808 retirement guards", () => {
	it("removes the five Wave A rows and tombstones four flags plus one companion", () => {
		for (const name of WAVE_A_DELETED_ROWS) {
			expect(
				FEATURE_FLAGS.some((flag) => flag.name === name),
				name,
			).toBe(false);
		}
		for (const envVar of [
			...WAVE_A_RETIRED_FLAG_ENVS,
			...WAVE_A_RETIRED_COMPANION_ENVS,
		]) {
			expect(
				RETIRED_FLAGS.find((flag) => flag.envVar === envVar),
				envVar,
			).toEqual({ envVar, retiredBy: "FLY-1808" });
			expect(validateFlagTruthEnvironment([`${envVar}=1`]).ok, envVar).toBe(
				false,
			);
		}
	});

	it("removes and tombstones each of the five linked Wave B flags", () => {
		for (const name of WAVE_B_DELETED_ROWS) {
			expect(
				FEATURE_FLAGS.some((flag) => flag.name === name),
				name,
			).toBe(false);
		}
		for (const envVar of WAVE_B_RETIRED_FLAG_ENVS) {
			expect(
				RETIRED_FLAGS.find((flag) => flag.envVar === envVar),
				envVar,
			).toEqual({ envVar, retiredBy: "FLY-1808" });
			expect(validateFlagTruthEnvironment([`${envVar}=0`]).ok, envVar).toBe(
				false,
			);
		}
	});

	it("locks the exact FLY-1808 census at ten rows, nine flags, and one companion", () => {
		const rows = [...WAVE_A_DELETED_ROWS, ...WAVE_B_DELETED_ROWS];
		const flags = [...WAVE_A_RETIRED_FLAG_ENVS, ...WAVE_B_RETIRED_FLAG_ENVS];
		expect(rows).toHaveLength(10);
		expect(new Set(rows).size).toBe(10);
		expect(flags).toHaveLength(9);
		expect(new Set(flags).size).toBe(9);
		expect(WAVE_A_RETIRED_COMPANION_ENVS).toHaveLength(1);
	});

	it("removes every Wave B production read and its shared predicate module", () => {
		const source = [
			"packages/teamlead/src/StateStore.ts",
			"packages/teamlead/src/workflow-template.ts",
			"packages/teamlead/src/workflow-claims.ts",
			"packages/teamlead/src/workflow-template-selection.ts",
			"packages/teamlead/src/bridge/workflow-engine-dispatcher.ts",
			"packages/teamlead/src/bridge/runs-route.ts",
			"packages/teamlead/src/bridge/merge-ship-gate.ts",
			"packages/teamlead/src/bridge/external-merge-reconcile.ts",
			"packages/flywheel-comm/src/ship-eligibility.ts",
			"packages/flywheel-comm/src/commands/verify-approval.ts",
		]
			.map(productionSource)
			.join("\n");

		for (const envVar of WAVE_B_RETIRED_FLAG_ENVS) {
			expect(source, envVar).not.toContain(envVar);
		}
		expect(
			existsSync(
				resolve(
					REPO_ROOT,
					"packages/teamlead/src/workflow-template-dispatch.ts",
				),
			),
		).toBe(false);
	});

	it("moves the two non-rollout seams to explicit transient exemptions", () => {
		for (const { name, source } of [
			{
				name: "FLYWHEEL_LEAD_DRY_RUN",
				source:
					"packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts",
			},
			{
				name: "FLYWHEEL_DONE_THREAD_RECONCILE",
				source: "packages/teamlead/src/bridge/done-thread-reconcile.ts",
			},
		] as const) {
			expect(
				FEATURE_FLAGS.some((flag) => flag.envVar === name),
				name,
			).toBe(false);
			expect(
				RETIRED_FLAGS.some((flag) => flag.envVar === name),
				name,
			).toBe(false);
			expect(
				FLAG_EXEMPTIONS.find((entry) => entry.name === name),
			).toMatchObject({
				kind: "env",
				persistentEnvAllowed: false,
				owner: "flywheel-eng-lead",
				issue: "FLY-1808",
			});
			expect(productionSource(source), name).toContain(name);
		}
	});

	it("removes the cmux linked-view flag and its observation family", () => {
		const source = [
			"scripts/flywheel-cmux-sync.sh",
			"scripts/flywheel-cmux-autostart.sh",
			"scripts/lead-alert.sh",
			"packages/teamlead/src/LeadAlertNotifier.ts",
			"packages/teamlead/src/bridge/kind-contract.ts",
			"packages/teamlead/src/bridge/alert-kind-copy.ts",
			"packages/teamlead/src/bridge/infra-event-router.ts",
		]
			.map(productionSource)
			.join("\n");

		expect(source).not.toMatch(
			/FLYWHEEL_CMUX_LINKED_VIEW|CMUX_FLAG_STATE|check_cmux_flag_state|cmux_flag_state/,
		);
	});
});
