import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { CodexReviewEffects } from "../codex-review-effects.js";
import { CodexReviewHoldCoordinator } from "../codex-review-hold.js";
import { CodexReviewIngest } from "../codex-review-ingest.js";

const SHA = "a".repeat(40);

describe("neutral Codex review services", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "main-1",
			issue_id: "FLY-1981",
			project_name: "flywheel",
			status: "awaiting_review",
			session_role: "main",
			adapter_type: "claude",
		});
		store.setReviewBinding("main-1", {
			questionId: "review-q",
			prHeadSha: SHA,
		});
	});

	afterEach(() => store.close());

	it("live and restart paths queue a missing exact-head review once", async () => {
		const queueCodexInstruction = vi.fn(async () => ({ queued: true }));
		const alertMissingHead = vi.fn(async () => {});
		const service = new CodexReviewHoldCoordinator({
			store,
			queueCodexInstruction,
			alertMissingHead,
		});
		const session = store.getSession("main-1");
		if (!session) throw new Error("missing fixture session");

		expect(await service.onSessionAwaitingReview(session)).toBe("held");
		expect(await service.onSessionAwaitingReview(session)).toBe("held");
		await service.reconcileCodexHolds();

		expect(queueCodexInstruction).toHaveBeenCalledTimes(1);
		expect(queueCodexInstruction).toHaveBeenCalledWith({ session });
		expect(alertMissingHead).not.toHaveBeenCalled();
	});

	it("stops holding as soon as exact-head Codex evidence exists", async () => {
		store.recordCodexReviewApproved({
			executionId: "main-1",
			targetPrHeadSha: SHA,
			issueId: "FLY-1981",
			projectName: "flywheel",
			authorFamily: "claude",
			reviewerFamily: "codex",
		});
		const queueCodexInstruction = vi.fn();
		const service = new CodexReviewHoldCoordinator({
			store,
			queueCodexInstruction,
			alertMissingHead: vi.fn(),
		});
		const session = store.getSession("main-1");
		if (!session) throw new Error("missing fixture session");

		expect(await service.onSessionAwaitingReview(session)).toBe("ready");
		expect(queueCodexInstruction).not.toHaveBeenCalled();
	});

	it("sanctioned codex_skip never alerts for a missing exact head", async () => {
		store.patchSessionMetadata("main-1", {
			codex_skip: 1,
			pr_head_sha: null,
		});
		const queueCodexInstruction = vi.fn();
		const alertMissingHead = vi.fn();
		const service = new CodexReviewHoldCoordinator({
			store,
			queueCodexInstruction,
			alertMissingHead,
		});
		const session = store.getSession("main-1");
		if (!session) throw new Error("missing fixture session");

		expect(await service.onSessionAwaitingReview(session)).toBe("ready");
		expect(queueCodexInstruction).not.toHaveBeenCalled();
		expect(alertMissingHead).not.toHaveBeenCalled();
	});

	it("ingests approved code evidence without any auto-QA redrive dependency", async () => {
		const ingest = new CodexReviewIngest({ store });

		await ingest.onCodexReviewResult({
			event_id: "codex-verdict-1",
			execution_id: "main-1",
			issue_id: "FLY-1981",
			project_name: "flywheel",
			event_type: "codex_review_result",
			payload: {
				reviewType: "code",
				status: "APPROVED",
				prHeadSha: SHA,
				targetExecutionId: "main-1",
			},
		});

		expect(store.isCodexCodeReviewApproved("main-1", SHA)).toBe(true);
	});

	describe("FLY-2891 reviewer model on routed executions", () => {
		const routeCode = (model = "gpt-5.6-sol", effort = "xhigh") => {
			vi.spyOn(store, "getWorkflowRunNodeForExecution").mockReturnValue({
				run_id: "run-1",
				node_id: "implement",
			} as never);
			vi.spyOn(store, "listWorkflowRunEvents").mockReturnValue([
				{
					run_id: "run-1",
					seq: 1,
					event_uid: "review_model_routed:run-1:implement:code:e1",
					kind: "review_model_routed",
					node_id: "implement",
					edge_id: null,
					execution_id: "main-1",
					payload: {
						reviewType: "code",
						requestId: "e1",
						reviewerVendor: "codex",
						reviewerModel: model,
						reviewerEffort: effort,
					},
					at: "2026-09-25T10:00:00.000Z",
				},
			]);
		};
		const verdict = (payload: Record<string, unknown>) => ({
			event_id: `codex-verdict-${Math.random()}`,
			execution_id: "main-1",
			issue_id: "FLY-1981",
			project_name: "flywheel",
			event_type: "codex_review_result",
			payload: {
				reviewType: "code",
				status: "APPROVED",
				prHeadSha: SHA,
				targetExecutionId: "main-1",
				...payload,
			},
		});
		afterEach(() => vi.restoreAllMocks());

		it("does not record a legacy (model-less) approval on a routed execution and keeps the hold", async () => {
			routeCode();
			const warn = vi.fn();
			const ingest = new CodexReviewIngest({
				store,
				logger: { log: vi.fn(), warn },
			});
			await ingest.onCodexReviewResult(verdict({}));
			expect(store.isCodexCodeReviewApproved("main-1", SHA)).toBe(false);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining("gate predates FLY-2891"),
			);
		});

		it("does not record a wrong-model approval", async () => {
			routeCode();
			const ingest = new CodexReviewIngest({ store });
			await ingest.onCodexReviewResult(
				verdict({ reviewerModel: "gpt-6-astra", reviewerEffort: "xhigh" }),
			);
			expect(store.isCodexCodeReviewApproved("main-1", SHA)).toBe(false);
			await ingest.onCodexReviewResult(
				verdict({ reviewerModel: "gpt-5.6-sol", reviewerEffort: "high" }),
			);
			expect(store.isCodexCodeReviewApproved("main-1", SHA)).toBe(false);
		});

		it("records a matching-model approval", async () => {
			routeCode();
			const ingest = new CodexReviewIngest({ store });
			await ingest.onCodexReviewResult(
				verdict({ reviewerModel: "gpt-5.6-sol", reviewerEffort: "xhigh" }),
			);
			expect(store.isCodexCodeReviewApproved("main-1", SHA)).toBe(true);
		});

		it("fails closed when the route cannot be resolved", async () => {
			vi.spyOn(store, "getWorkflowRunNodeForExecution").mockReturnValue({
				run_id: "run-1",
				node_id: "implement",
			} as never);
			vi.spyOn(store, "listWorkflowRunEvents").mockReturnValue([]);
			vi.spyOn(store, "getWorkflowRun").mockReturnValue({
				snapshot: "{corrupt",
			} as never);
			const ingest = new CodexReviewIngest({ store });
			await ingest.onCodexReviewResult(
				verdict({ reviewerModel: "gpt-5.6-sol", reviewerEffort: "xhigh" }),
			);
			expect(store.isCodexCodeReviewApproved("main-1", SHA)).toBe(false);
		});
	});

	it("owns the neutral instruction queue and missing-head Lead alert effects", async () => {
		const queueInstruction = vi.fn(() => ({ queued: true }));
		const alert = vi.fn(async () => ({ sent: true }));
		const effects = new CodexReviewEffects({
			projects: [
				{
					projectName: "flywheel",
					projectRoot: "/tmp/flywheel",
					leads: [
						{
							agentId: "flywheel-eng-lead",
							chatChannel: "chat",
							match: { labels: [] },
						},
					],
				},
			],
			leadAlertNotifier: { alert: alert as never },
			queueInstruction,
		});
		const session = store.getSession("main-1");
		if (!session) throw new Error("missing fixture session");

		expect(effects.queueCodexInstruction({ session })).toEqual({
			queued: true,
		});
		await effects.alertCodexGateBlocked({ session });

		expect(queueInstruction).toHaveBeenCalledWith("flywheel", "main-1");
		expect(alert).toHaveBeenCalledWith(
			expect.objectContaining({
				eventId: "codex-gate-missing-head:main-1",
				eventType: "codex_gate_blocked",
				leadId: "flywheel-eng-lead",
			}),
		);
	});
});
