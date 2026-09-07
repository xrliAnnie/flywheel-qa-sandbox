import { describe, expect, it, vi } from "vitest";
import type {
	WorkflowGateOriginInspectionReceipt,
	WorkflowGateQuestionRecoveryCandidate,
} from "../../StateStore.js";
import { reconcileUnanswerableWorkflowGates } from "../unanswerable-workflow-gate-reconciler.js";

const HEAD = "a".repeat(40);

function candidate(
	questionId: string,
	recoveryCount = 0,
): WorkflowGateQuestionRecoveryCandidate {
	return {
		runId: `run-${questionId}`,
		projectName: "flywheel",
		issueId: `FLY-${questionId.length}`,
		questionId,
		gateNodeId: "founder_gate",
		attempt: 1,
		headSha: HEAD,
		sourceExecutionId: `exec-${questionId}`,
		cardMessageId: `card-${questionId}`,
		recoveryCount,
	};
}

function receipt(questionId: string): WorkflowGateOriginInspectionReceipt {
	return {
		schemaVersion: 1,
		outcome: "ok",
		projectName: "flywheel",
		issueId: `FLY-${questionId.length}`,
		runId: `run-${questionId}`,
		gateNodeId: "founder_gate",
		questionId,
		headSha: HEAD,
		prNumber: 42,
		targetRepoIdentity: "github.com/acme/flywheel",
		probeRepoSlug: "acme/flywheel",
		targetRepoPath: "/repo",
		worktreeBindingGeneration: "generation-1",
		observedAt: "2026-09-07T19:00:00.000Z",
		expiresAt: "2026-09-07T19:05:00.000Z",
		digest: "d".repeat(64),
	};
}

function inspection(input: {
	answerable?: boolean;
	source?: boolean;
	reasons?: string[];
}) {
	return {
		questionId: "unused",
		questionExists: true,
		terminalDisposed: input.reasons?.includes("terminal_disposed") ?? false,
		superseded: false,
		resolved: false,
		responseExists: input.reasons?.includes("response_exists") ?? false,
		founderSourceEventExists: input.source ?? false,
		answerable: input.answerable ?? false,
		unanswerableReasons: input.reasons ?? ["terminal_disposed"],
	};
}

function fixture(candidates: WorkflowGateQuestionRecoveryCandidate[]) {
	const listWorkflowGateQuestionRecoveryCandidates = vi
		.fn()
		.mockReturnValue(candidates);
	const recoverUnanswerableWorkflowGate = vi.fn((input) => ({
		ok: true as const,
		idempotentReplay: false,
		questionId: `replacement-${input.questionId}`,
	}));
	const recordWorkflowGateQuestionRecoveryAlert = vi.fn(() => ({
		ok: true as const,
		idempotentReplay: false,
	}));
	const inspectFounderShipGateQuestion = vi.fn();
	const close = vi.fn();
	const openDb = vi.fn(() => ({ inspectFounderShipGateQuestion, close }));
	const inspectOrigin = vi.fn(async (questionId: string) => ({
		ok: true as const,
		receipt: receipt(questionId),
	}));
	const store = {
		listWorkflowGateQuestionRecoveryCandidates,
		recoverUnanswerableWorkflowGate,
		recordWorkflowGateQuestionRecoveryAlert,
	};
	return {
		store,
		listWorkflowGateQuestionRecoveryCandidates,
		recoverUnanswerableWorkflowGate,
		recordWorkflowGateQuestionRecoveryAlert,
		inspectFounderShipGateQuestion,
		openDb,
		close,
		inspectOrigin,
	};
}

describe("unanswerable workflow gate reconciler", () => {
	it("returns before every recovery seam when the project kill switch is off", async () => {
		const f = fixture([candidate("broken")]);
		await expect(
			reconcileUnanswerableWorkflowGates({
				enabled: false,
				projectName: "flywheel",
				commDbPath: "/never-open",
				store: f.store,
				openDb: f.openDb,
				inspectOrigin: f.inspectOrigin,
				now: () => "2026-09-07T19:00:00.000Z",
			}),
		).resolves.toEqual({
			disabled: true,
			throttled: false,
			examined: 0,
			recovered: 0,
			skipped: 0,
			failed: 0,
			newQuestionIds: [],
		});
		expect(f.listWorkflowGateQuestionRecoveryCandidates).not.toHaveBeenCalled();
		expect(f.openDb).not.toHaveBeenCalled();
		expect(f.inspectOrigin).not.toHaveBeenCalled();
		expect(f.recoverUnanswerableWorkflowGate).not.toHaveBeenCalled();
	});

	it("recovers only an unanswerable source-less question", async () => {
		const f = fixture([
			candidate("broken"),
			candidate("healthy"),
			candidate("source-backed"),
		]);
		f.inspectFounderShipGateQuestion
			.mockReturnValueOnce(inspection({ reasons: ["response_exists"] }))
			.mockReturnValueOnce(inspection({ answerable: true, reasons: [] }))
			.mockReturnValueOnce(
				inspection({ source: true, reasons: ["terminal_disposed"] }),
			);

		await expect(
			reconcileUnanswerableWorkflowGates({
				enabled: true,
				projectName: "flywheel",
				commDbPath: "/comm.db",
				store: f.store,
				openDb: f.openDb,
				inspectOrigin: f.inspectOrigin,
				now: () => "2026-09-07T19:00:00.000Z",
			}),
		).resolves.toEqual({
			disabled: false,
			throttled: false,
			examined: 3,
			recovered: 1,
			skipped: 2,
			failed: 0,
			newQuestionIds: ["replacement-broken"],
		});
		expect(f.inspectOrigin).toHaveBeenCalledOnce();
		expect(f.inspectOrigin).toHaveBeenCalledWith("broken");
		expect(f.recoverUnanswerableWorkflowGate).toHaveBeenCalledOnce();
		expect(f.close).toHaveBeenCalledOnce();
	});

	it("uses a fresh commit timestamp after the asynchronous origin inspection", async () => {
		const f = fixture([candidate("broken")]);
		f.inspectFounderShipGateQuestion.mockReturnValue(
			inspection({ reasons: ["terminal_disposed"] }),
		);
		f.inspectOrigin.mockResolvedValue({
			ok: true,
			receipt: {
				...receipt("broken"),
				observedAt: "2026-09-07T19:00:00.100Z",
			},
		});
		const now = vi
			.fn()
			.mockReturnValueOnce("2026-09-07T19:00:00.000Z")
			.mockReturnValueOnce("2026-09-07T19:00:00.200Z");

		await reconcileUnanswerableWorkflowGates({
			enabled: true,
			projectName: "flywheel",
			commDbPath: "/comm.db",
			store: f.store,
			openDb: f.openDb,
			inspectOrigin: f.inspectOrigin,
			now,
		});

		expect(f.recoverUnanswerableWorkflowGate).toHaveBeenCalledWith(
			expect.objectContaining({ now: "2026-09-07T19:00:00.200Z" }),
		);
	});

	it.each(["defer", "hold"] as const)(
		"keeps the old gate untouched and records a stable alert when origin inspection returns %s",
		async (disposition) => {
			const f = fixture([candidate("broken")]);
			f.inspectFounderShipGateQuestion.mockReturnValue(
				inspection({ reasons: ["terminal_disposed"] }),
			);
			f.inspectOrigin.mockResolvedValue({
				ok: false,
				reason: "dynamic-provider-reason",
				disposition,
			});

			const result = await reconcileUnanswerableWorkflowGates({
				enabled: true,
				projectName: "flywheel",
				commDbPath: "/comm.db",
				store: f.store,
				openDb: f.openDb,
				inspectOrigin: f.inspectOrigin,
				now: () => "2026-09-07T19:00:00.000Z",
			});

			expect(result).toMatchObject({ recovered: 0, skipped: 1, failed: 0 });
			expect(f.recoverUnanswerableWorkflowGate).not.toHaveBeenCalled();
			expect(f.recordWorkflowGateQuestionRecoveryAlert).toHaveBeenCalledWith({
				kind: "origin_inspection_blocked",
				candidate: candidate("broken"),
				alertIdentity: expect.any(Object),
				now: "2026-09-07T19:00:00.000Z",
			});
			expect(
				f.recordWorkflowGateQuestionRecoveryAlert.mock.calls[0]?.[0],
			).not.toHaveProperty("reason");
		},
	);

	it("enforces the same-head cap and throttles a repeated pass", async () => {
		const f = fixture([candidate("broken", 3)]);
		f.inspectFounderShipGateQuestion.mockReturnValue(
			inspection({ reasons: ["terminal_disposed"] }),
		);
		const deps = {
			enabled: true,
			projectName: "flywheel",
			commDbPath: "/comm.db",
			store: f.store,
			openDb: f.openDb,
			inspectOrigin: f.inspectOrigin,
			now: () => "2026-09-07T19:00:00.000Z",
		};

		await expect(
			reconcileUnanswerableWorkflowGates(deps),
		).resolves.toMatchObject({
			throttled: false,
			skipped: 1,
		});
		expect(f.inspectOrigin).not.toHaveBeenCalled();
		expect(f.recordWorkflowGateQuestionRecoveryAlert).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "recovery_limit_reached" }),
		);
		await expect(reconcileUnanswerableWorkflowGates(deps)).resolves.toEqual({
			disabled: false,
			throttled: true,
			examined: 0,
			recovered: 0,
			skipped: 0,
			failed: 0,
			newQuestionIds: [],
		});
		expect(f.openDb).toHaveBeenCalledOnce();
	});
});
