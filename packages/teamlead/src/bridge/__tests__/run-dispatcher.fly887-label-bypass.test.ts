/**
 * FLY-887 R2 (Codex design R1 #1): the label-bypass matrix for three-stage
 * phase dispatch.
 *
 * `resolveRoleAdapter` puts the Linear label layer ABOVE `dispatchModel`
 * (a manual `sonnet`/`opus`/`fable-1m` model label or a `codex`/`agy`/`kimi`
 * vendor label wins over the dispatch param — role-adapter-resolver.test.ts
 * asserts that explicitly). For a PHASE session that would let an issue label
 * put design/implement/QA on Sonnet (or a no-transport vendor backend that can
 * never receive a park/wake mailbox) in violation of Annie's per-phase table.
 *
 * The fix: every phase dispatch passes `ignoreRunnerLabelSelection: true`
 * (the FLY-643 seam auto-QA already uses) + the phase-table `dispatchModel`.
 * This file pins the seam's behavior at the `buildRunnerSpawnFields` level:
 * with the flag set, NO label spelling can beat the phase model or move the
 * backend off claude-tmux.
 */

import { resolvePhaseModel } from "flywheel-config";
import { describe, expect, it } from "vitest";
import { buildRunnerSpawnFields } from "../run-dispatcher.js";

/** Phase dispatch shape: label layer bypassed + phase-table model. */
function phaseSpawnFields(labels: string[], phaseModel: string) {
	return buildRunnerSpawnFields(
		"exec-887",
		undefined, // leadId — irrelevant to backend/model resolution here
		labels,
		undefined, // no project roles config
		true, // ignoreRunnerLabelSelection — the phase seam under test
		phaseModel,
	);
}

describe("FLY-887 R2 label-bypass matrix (phase dispatch seam)", () => {
	const designModel = resolvePhaseModel("design");
	const implementModel = resolvePhaseModel("implement");
	const qaModel = resolvePhaseModel("qa");

	it("a `sonnet` model label cannot put a phase on Sonnet", () => {
		for (const phaseModel of [designModel, implementModel, qaModel]) {
			const f = phaseSpawnFields(["sonnet"], phaseModel);
			expect(f.runnerModel).toBe(phaseModel);
			expect(f.runnerBackend).toBe("claude-tmux");
		}
	});

	it("a `fable-1m` model label cannot override the phase model", () => {
		const f = phaseSpawnFields(["fable-1m"], qaModel);
		expect(f.runnerModel).toBe(qaModel);
		expect(f.runnerBackend).toBe("claude-tmux");
	});

	it("a `codex` vendor label cannot move a phase off claude-tmux", () => {
		const f = phaseSpawnFields(["codex"], implementModel);
		expect(f.runnerBackend).toBe("claude-tmux");
		expect(f.runnerModel).toBe(implementModel);
	});

	it("a no-transport vendor label (agy/kimi) cannot select a mailbox-less backend for a phase", () => {
		// park/wake keep-alive requires a mailbox — a no-transport backend would
		// strand the phase at its first park.
		for (const vendor of ["agy", "kimi"]) {
			const f = phaseSpawnFields([vendor], implementModel);
			expect(f.runnerBackend).toBe("claude-tmux");
			expect(f.runnerTransportMode).toBeUndefined();
		}
	});

	it("BYTE-COMPAT sentinel: the same labels WITHOUT the phase seam keep their existing power", () => {
		// Non-three-stage dispatch (flag unset, no dispatch model): the label
		// layer still resolves exactly as before — this seam changes phase
		// dispatch ONLY.
		const f = buildRunnerSpawnFields(
			"exec-main",
			undefined,
			["sonnet"],
			undefined,
			undefined,
			undefined,
		);
		expect(f.runnerModel).toBe("sonnet");
	});
});
