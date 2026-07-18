import { FEATURE_FLAGS, type FlagView, resolveFlag } from "flywheel-config";
import { describe, expect, it } from "vitest";
import {
	buildDagFlagPanel,
	type DagControlName,
} from "../bridge/dag-flag-panel.js";

const NAMES: DagControlName[] = [
	"workflow_force_legacy",
	"workflow_claims_write",
	"workflow_claims_read",
	"workflow_generalized_templates",
	"workflow_template_dispatch",
];

function flags(values: Record<DagControlName, boolean>): FlagView[] {
	return NAMES.map((name) => {
		const spec = FEATURE_FLAGS.find((flag) => flag.name === name);
		if (!spec?.envVar) throw new Error(`missing ${name}`);
		const raw = values[name] ? "1" : "0";
		return resolveFlag(spec, {
			env: { [spec.envVar]: raw },
			envFile: { status: "readable", content: `${spec.envVar}=${raw}\n` },
		});
	});
}

function state(mask: number): Record<DagControlName, boolean> {
	return Object.fromEntries(
		NAMES.map((name, index) => [name, Boolean(mask & (1 << index))]),
	) as Record<DagControlName, boolean>;
}

function commandChanges(command: string): Array<[DagControlName, boolean]> {
	if (!command) return [];
	return command.split(" && ").map((part) => {
		const match = part.match(/--name (\S+) --to (on|off)$/);
		if (!match) throw new Error(`bad command: ${part}`);
		return [match[1] as DagControlName, match[2] === "on"];
	});
}

describe("DAG flag panel view model", () => {
	it("reports dispatch and ship-reader facts independently", () => {
		const off = buildDagFlagPanel(flags(state(0)));
		expect(off.v1Dispatch).toMatchObject({
			state: "off",
			missing: [
				"workflow_template_dispatch",
				"workflow_claims_write",
				"workflow_claims_read",
			],
		});
		expect(off.shipReader).toBe("blocked_fail_closed");

		const legacy = state(0);
		legacy.workflow_force_legacy = true;
		expect(buildDagFlagPanel(flags(legacy)).shipReader).toBe("forced_legacy");
		const claims = state(0);
		claims.workflow_claims_read = true;
		expect(buildDagFlagPanel(flags(claims)).shipReader).toBe("claims");
	});

	it("degrades aggregates and disables every preset when any member source diverges", () => {
		const views = flags(state(0));
		const claims = views.find((flag) => flag.name === "workflow_claims_read");
		if (!claims) throw new Error("missing claims");
		claims.displayEffective = undefined;
		claims.divergence = "split_brain";
		const panel = buildDagFlagPanel(views);
		expect(panel.v1Dispatch.state).toBe("degraded");
		expect(panel.shipReader).toBe("degraded");
		expect(panel.degradedFlags).toContain("workflow_claims_read");
		expect(panel.presets.enableV1.enabled).toBe(false);
		expect(panel.presets.enableV2.enabled).toBe(false);
		expect(panel.presets.disable.enabled).toBe(false);
	});

	it("builds fail-stop enable/disable commands in the locked safe order", () => {
		const off = buildDagFlagPanel(flags(state(0)));
		expect(off.presets.enableV2.phase1Command).toBe(
			"flywheel-comm feature-flags apply --name workflow_force_legacy --to on && " +
				"flywheel-comm feature-flags apply --name workflow_claims_write --to on && " +
				"flywheel-comm feature-flags apply --name workflow_claims_read --to on && " +
				"flywheel-comm feature-flags apply --name workflow_generalized_templates --to on && " +
				"flywheel-comm feature-flags apply --name workflow_template_dispatch --to on",
		);

		const allOn = state(31);
		allOn.workflow_force_legacy = false;
		expect(buildDagFlagPanel(flags(allOn)).presets.disable.phase1Command).toBe(
			"flywheel-comm feature-flags apply --name workflow_force_legacy --to on && " +
				"flywheel-comm feature-flags apply --name workflow_template_dispatch --to off && " +
				"flywheel-comm feature-flags apply --name workflow_claims_write --to off && " +
				"flywheel-comm feature-flags apply --name workflow_claims_read --to off && " +
				"flywheel-comm feature-flags apply --name workflow_generalized_templates --to off",
		);
	});

	it("repairs an unsafe template-on initial state before enabling prerequisites", () => {
		const unsafe = state(0);
		unsafe.workflow_template_dispatch = true;
		const cmd = buildDagFlagPanel(flags(unsafe)).presets.enableV2.phase1Command;
		expect(commandChanges(cmd)[0]).toEqual([
			"workflow_template_dispatch",
			false,
		]);
	});

	it("every enable prefix keeps template dispatch prerequisites complete across all 32 initial states", () => {
		for (let mask = 0; mask < 32; mask += 1) {
			for (const target of ["enableV1", "enableV2"] as const) {
				const current = state(mask);
				const command = buildDagFlagPanel(flags(current)).presets[target]
					.phase1Command;
				for (const [name, value] of commandChanges(command)) {
					current[name] = value;
					if (!current.workflow_template_dispatch) continue;
					expect(current.workflow_claims_write, `${mask}/${target}`).toBe(true);
					expect(current.workflow_claims_read, `${mask}/${target}`).toBe(true);
					if (target === "enableV2") {
						expect(
							current.workflow_generalized_templates,
							`${mask}/${target}`,
						).toBe(true);
					}
				}
			}
		}
	});

	it("offers phase two only after refresh confirms claims reader under forced legacy", () => {
		const ready = state(31);
		expect(buildDagFlagPanel(flags(ready)).presets.enableV2.phase2Command).toBe(
			"flywheel-comm feature-flags apply --name workflow_force_legacy --to off",
		);
		ready.workflow_claims_read = false;
		expect(
			buildDagFlagPanel(flags(ready)).presets.enableV2.phase2Command,
		).toBeUndefined();
	});

	it("failure injection covers every command position from all 32 initial states", () => {
		for (let mask = 0; mask < 32; mask += 1) {
			for (const target of ["enableV1", "enableV2"] as const) {
				const initial = state(mask);
				const command = buildDagFlagPanel(flags(initial)).presets[target]
					.phase1Command;
				const changes = commandChanges(command);
				expect(command).not.toMatch(/[;\n]/);
				expect(command.match(/ && /g)?.length ?? 0).toBe(
					Math.max(0, changes.length - 1),
				);
				for (let failedAt = 0; failedAt < changes.length; failedAt += 1) {
					const after = { ...initial };
					const attempted: number[] = [];
					for (const [index, [name, value]] of changes.entries()) {
						attempted.push(index);
						if (index === failedAt) break; // `&&` stops on this non-zero apply.
						after[name] = value;
					}
					expect(attempted).toEqual(
						Array.from({ length: failedAt + 1 }, (_, index) => index),
					);
					expect(attempted.some((index) => index > failedAt)).toBe(false);
					if (after.workflow_template_dispatch) {
						const prerequisitesReady =
							after.workflow_claims_write &&
							after.workflow_claims_read &&
							(target === "enableV1" || after.workflow_generalized_templates);
						if (!prerequisitesReady) {
							// A failed first repair can only preserve the already-unsafe
							// initial state; it must never create a new unsafe state.
							expect(failedAt, `${mask}/${target}`).toBe(0);
							expect(after).toEqual(initial);
						}
					}
					const targetReady =
						after.workflow_template_dispatch &&
						after.workflow_claims_write &&
						after.workflow_claims_read &&
						(target === "enableV1" || after.workflow_generalized_templates);
					if (!targetReady && !after.workflow_force_legacy) {
						// The only pre-legacy prefix allowed is the repair-first template-off
						// normalization required for an already-unsafe initial state.
						expect(
							changes
								.slice(0, failedAt)
								.every(([name]) => name === "workflow_template_dispatch"),
							`${mask}/${target}/${failedAt}`,
						).toBe(true);
					}
				}
			}

			const initial = state(mask);
			const changes = commandChanges(
				buildDagFlagPanel(flags(initial)).presets.disable.phase1Command,
			);
			for (let failedAt = 0; failedAt < changes.length; failedAt += 1) {
				const after = { ...initial };
				for (const [index, [name, value]] of changes.entries()) {
					if (index === failedAt) break;
					after[name] = value;
				}
				if (failedAt > 0 || initial.workflow_force_legacy) {
					expect(
						after.workflow_force_legacy,
						`${mask}/disable/${failedAt}`,
					).toBe(true);
				}
			}
		}
	});
});
