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

import { resolvePhaseDispatch, type ThreeStagePhase } from "flywheel-config";
import { describe, expect, it } from "vitest";
import { buildRunnerSpawnFields } from "../run-dispatcher.js";

/** Phase dispatch shape: label layer bypassed + the full phase-table decision. */
function phaseSpawnFields(labels: string[], phase: ThreeStagePhase) {
	const dispatch = resolvePhaseDispatch(phase);
	return buildRunnerSpawnFields(
		"exec-887",
		undefined, // leadId — irrelevant to backend/model resolution here
		labels,
		undefined, // no project roles config
		true, // ignoreRunnerLabelSelection — the phase seam under test
		dispatch.model,
		undefined,
		dispatch.vendor,
		dispatch.effort,
	);
}

describe("FLY-887 R2 label-bypass matrix (phase dispatch seam)", () => {
	it("a `sonnet` model label cannot put a phase on Sonnet", () => {
		for (const phase of ["design", "implement", "qa"] as const) {
			const dispatch = resolvePhaseDispatch(phase);
			const f = phaseSpawnFields(["sonnet"], phase);
			expect(f.runnerModel).toBe(dispatch.model);
			expect(f.runnerBackend).toBe(
				dispatch.vendor === "codex" ? "codex-tmux" : "claude-tmux",
			);
		}
	});

	it("a `fable-1m` model label cannot override the phase model", () => {
		const f = phaseSpawnFields(["fable-1m"], "qa");
		expect(f.runnerModel).toBe(resolvePhaseDispatch("qa").model);
		expect(f.runnerBackend).toBe("claude-tmux");
	});

	it("a `claude` vendor label cannot move implement off its Codex phase row", () => {
		const f = phaseSpawnFields(["claude"], "implement");
		expect(f.runnerBackend).toBe("codex-tmux");
		expect(f.runnerModel).toBe(resolvePhaseDispatch("implement").model);
	});

	it("a no-transport vendor label (agy/kimi) cannot select a mailbox-less backend for a phase", () => {
		// park/wake keep-alive requires a mailbox — a no-transport backend would
		// strand the phase at its first park.
		for (const vendor of ["agy", "kimi"]) {
			const f = phaseSpawnFields([vendor], "implement");
			expect(f.runnerBackend).toBe("codex-tmux");
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
		expect(f.runnerModel).toBe("claude-sonnet-5");
	});
});
