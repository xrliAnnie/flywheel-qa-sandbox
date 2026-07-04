import { describe, expect, it } from "vitest";
import { resumeModeInstructions } from "../resume-mode.js";

/**
 * FLY-795 c4: Blueprint resume-mode. When teamlead computes a progressResume for
 * a re-dispatched dead runner, the Blueprint prompt tells it to CONTINUE from the
 * real progress.md cursor (not re-run explore/research/plan) and suppresses the
 * completed from-scratch onboard/brainstorm gates up to `effectiveStage`. The
 * founder ship-gate is always preserved. (Codex R1 #6, R2 #4 fail-closed.)
 */
describe("resumeModeInstructions (FLY-795)", () => {
	const base = {
		progressPath: "engineering/doc/FLY-795-x/progress.md",
		priorExecutionId: "old-exec",
		resumeKind: "terminate" as const,
	};

	it("emits a RESUME directive pointing at the progress.md path", () => {
		const r = resumeModeInstructions({ ...base, effectiveStage: "implement" });
		const text = r.lines.join("\n");
		expect(text).toMatch(/RESUME/);
		expect(text).toContain(base.progressPath);
		expect(text).toMatch(
			/do NOT re-run explore\/research\/plan|不要重跑|continue from/i,
		);
	});

	it("suppresses onboard/brainstorm from-scratch when a phase is complete (implement/qa)", () => {
		expect(
			resumeModeInstructions({ ...base, effectiveStage: "implement" })
				.suppressOnboardBrainstorm,
		).toBe(true);
		expect(
			resumeModeInstructions({ ...base, effectiveStage: "qa" })
				.suppressOnboardBrainstorm,
		).toBe(true);
	});

	it("does NOT suppress when still in the design phase (brainstorm not done)", () => {
		expect(
			resumeModeInstructions({ ...base, effectiveStage: "design" })
				.suppressOnboardBrainstorm,
		).toBe(false);
	});

	it("fail-closed: does NOT suppress when effectiveStage is undefined (StateStore/ledger mismatch)", () => {
		expect(resumeModeInstructions({ ...base }).suppressOnboardBrainstorm).toBe(
			false,
		);
	});

	it("HIGH-2: on mismatch (undefined effectiveStage) it withholds the skip-language and keeps gates", () => {
		const text = resumeModeInstructions({ ...base }).lines.join("\n");
		// still points at progress.md (weak reference layer is safe)
		expect(text).toContain(base.progressPath);
		// but must NOT tell the runner to skip explore/research/plan or re-brainstorm
		expect(text).not.toMatch(/do NOT re-run explore\/research\/plan/i);
		expect(text).not.toMatch(/do NOT re-brainstorm/i);
		// and must instruct re-verifying the stage + running mandatory gates
		expect(text).toMatch(/re-verify the current stage/i);
		expect(text).toMatch(/mandatory gate/i);
	});

	it("HIGH-2: on a confirmed phase (implement) it DOES emit the skip-language", () => {
		const text = resumeModeInstructions({
			...base,
			effectiveStage: "implement",
		}).lines.join("\n");
		expect(text).toMatch(/do NOT re-run explore\/research\/plan/i);
		expect(text).toMatch(/do NOT re-brainstorm/i);
	});

	it("always preserves the founder ship-gate (never auto-ship)", () => {
		const text = resumeModeInstructions({
			...base,
			effectiveStage: "qa",
		}).lines.join("\n");
		expect(text).toMatch(/ship-gate|approval|never auto-ship/i);
	});
});
