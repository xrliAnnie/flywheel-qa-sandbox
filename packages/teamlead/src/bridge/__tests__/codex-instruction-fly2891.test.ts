import { CommDB } from "flywheel-comm/db";
import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../StateStore.js";
import {
	buildCodexInstruction,
	queueCodexCodeReviewInstructionResult,
} from "../codex-instruction.js";
import { CodexReviewEffects } from "../codex-review-effects.js";
import { commDbPathForProject } from "../commdb-path.js";

const EXEC = "11111111-2222-4333-8444-555555555555";
const DESIGN_ROUTE = {
	reviewerVendor: "codex" as const,
	reviewerModel: "gpt-6-astra",
	reviewerEffort: "xhigh" as const,
};
const CODE_ROUTE = { ...DESIGN_ROUTE, reviewerModel: "gpt-5.6-sol" };

describe("FLY-2891 Codex review instructions", () => {
	it("design: schema binds the approved turn, --model on every call, write-back per round", () => {
		const text = buildCodexInstruction(
			"design",
			"doc/plan.md",
			EXEC,
			{ requestId: "req-1", reviewedPlanBlobSha: "a".repeat(40) },
			DESIGN_ROUTE,
		);
		for (const fragment of [
			"reviewerModel:<model of the APPROVED round>",
			"reviewerEffort:<effort of the APPROVED round>",
			"codexTurnId:<turn of the APPROVED round>",
			"finalRound:<APPROVED round number within its thread>",
			"rounds:<total rounds across all threads>",
			"Pass --model gpt-6-astra --effort xhigh on EVERY codex-companion task call",
			"start a fresh thread (--fresh) with the right model",
			`Immediately after EACH Codex round, before editing any file, run: flywheel-comm review-round design --exec-id ${EXEC} --round <n> --verdict <APPROVED|CHANGES_REQUESTED> --thread <codexThreadId>`,
			"Run flywheel-comm stage set design_review --plan doc/plan.md BEFORE round 1 and read the printed reviewer model; re-run it after the final plan commit.",
			'requestId:"req-1"',
		])
			expect(text).toContain(fragment);
	});

	it("code without a route still requires the per-round write-back and model fields", () => {
		const text = buildCodexInstruction("code", undefined, EXEC);
		expect(text).toContain(
			`flywheel-comm review-round code --exec-id ${EXEC} --round <n>`,
		);
		expect(text).toContain("codexTurnId:<turn of the APPROVED round>");
		expect(text).not.toContain("--model");
		expect(text).not.toContain("server-selected reviewer model");
	});

	it("code with a route names the model on every companion call", () => {
		expect(
			buildCodexInstruction("code", undefined, EXEC, undefined, CODE_ROUTE),
		).toContain(
			"Pass --model gpt-5.6-sol --effort xhigh on EVERY codex-companion task call",
		);
	});

	it("the hold re-queue carries the route into the instruction", () => {
		const result = queueCodexCodeReviewInstructionResult(
			"flywheel-fly2891",
			EXEC,
			{
				instructionId: "fly2891-requeue-1",
				reviewRoute: CODE_ROUTE,
				logger: { log: vi.fn(), warn: vi.fn() },
			},
		);
		expect(result).toMatchObject({ queued: true });
		const db = new CommDB(commDbPathForProject("flywheel-fly2891"));
		try {
			expect(db.getMessageById("fly2891-requeue-1")?.content).toContain(
				"--model gpt-5.6-sol --effort xhigh",
			);
		} finally {
			db.close();
		}
	});

	it("effects resolve the code route for re-queues and degrade to no route on error", () => {
		const queueInstruction = vi.fn(() => ({ queued: true }));
		const session = {
			project_name: "flywheel",
			execution_id: EXEC,
		} as Session;
		const routed = new CodexReviewEffects({
			projects: [],
			queueInstruction,
			resolveReviewRoute: () => CODE_ROUTE,
		});
		routed.queueCodexInstruction({ session });
		expect(queueInstruction).toHaveBeenLastCalledWith("flywheel", EXEC, {
			reviewRoute: CODE_ROUTE,
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const broken = new CodexReviewEffects({
			projects: [],
			queueInstruction,
			resolveReviewRoute: () => {
				throw new Error("snapshot is corrupt");
			},
		});
		broken.queueCodexInstruction({ session });
		expect(queueInstruction).toHaveBeenLastCalledWith("flywheel", EXEC);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("snapshot is corrupt"),
		);
		warn.mockRestore();
	});
});
