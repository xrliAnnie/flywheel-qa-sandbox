import { describe, expect, it, vi } from "vitest";
import {
	recordWorkflowReviewRoute,
	resolveRequiredReviewModel,
	resolveWorkflowReviewRoute,
	resolveWorkflowReviewRouteForExecution,
} from "../workflow-review-routing.js";

describe("FLY-2788 workflow review routing", () => {
	it.each([
		["code", "claude", "claude-opus-5-5", "codex", "gpt-5.6-sol"],
		["code", "claude", "claude-fable-5-1", "codex", "gpt-5.6-sol"],
		["code", "codex", "gpt-5.6-sol", "claude", "claude-opus-5-5"],
		["code", "codex", "gpt-6-sol", "claude", "claude-opus-5-5"],
		["design", "codex", "gpt-6-astra", "claude", "claude-opus-5-5"],
		["design", "codex", "gpt-6-sol", "claude", "claude-opus-5-5"],
		["design", "claude", "claude-opus-5-5", "codex", "gpt-6-astra"],
		["design", "claude", "claude-fable-5-1", "codex", "gpt-6-astra"],
	] as const)(
		"routes %s %s author %s to %s/%s at xhigh",
		(reviewType, authorVendor, authorModel, reviewerVendor, reviewerModel) => {
			expect(
				resolveWorkflowReviewRoute({ reviewType, authorVendor, authorModel }),
			).toEqual({
				reviewerVendor,
				reviewerModel,
				reviewerEffort: "xhigh",
			});
		},
	);

	it("fails closed for an invalid actual author vendor", () => {
		expect(() =>
			resolveWorkflowReviewRoute({
				reviewType: "code",
				authorVendor: "other" as never,
				authorModel: "custom-model",
			}),
		).toThrow(/unsupported code review author vendor/);
	});

	it("uses the immutable workflow runtime model before session metadata", () => {
		const store = {
			getWorkflowRunNodeForExecution: () => ({ run_id: "run-1" }),
			getWorkflowRun: () => ({ snapshot: '{"modelRouting":{}}' }),
			getWorkflowExecutionRuntime: () => ({
				model: "gpt-6-sol",
				vendor: "codex",
			}),
			getSession: () => ({ runner_model: "gpt-5.6-sol" }),
		};
		expect(
			resolveWorkflowReviewRouteForExecution(store as never, "exec-1", "code"),
		).toMatchObject({
			authorModel: "gpt-6-sol",
			authorVendor: "codex",
			reviewerModel: "claude-opus-5-5",
		});
	});

	it("fails closed for a routed workflow execution without immutable runtime", () => {
		const store = {
			getWorkflowRunNodeForExecution: () => ({ run_id: "run-1" }),
			getWorkflowRun: () => ({ snapshot: '{"modelRouting":{}}' }),
			getWorkflowExecutionRuntime: () => undefined,
			getSession: () => ({ runner_model: "claude-opus-5-5" }),
		};
		expect(() =>
			resolveWorkflowReviewRouteForExecution(store as never, "exec-1", "code"),
		).toThrow(/immutable workflow runtime/i);
	});

	it("does not route an unrouted legacy session from mutable model metadata", () => {
		const store = {
			getWorkflowRunNodeForExecution: () => undefined,
			getWorkflowRun: () => undefined,
			getWorkflowExecutionRuntime: () => undefined,
			getSession: () => ({
				runner_model: "claude-opus-5-5",
				adapter_type: "claude-tmux",
			}),
		};
		expect(
			resolveWorkflowReviewRouteForExecution(store as never, "exec-1", "code"),
		).toBeUndefined();
	});

	it("records the author and exact reviewer route on the bound workflow run", () => {
		const appendWorkflowRunEventChecked = vi.fn();
		const store = {
			appendWorkflowRunEventChecked,
			getWorkflowRunNodeForExecution: () => ({
				run_id: "run-1",
				node_id: "implement",
			}),
			getWorkflowExecutionRuntime: () => ({ vendor: "claude" }),
			getSession: () => undefined,
		};
		recordWorkflowReviewRoute(store as never, {
			executionId: "exec-1",
			reviewType: "code",
			requestId: "review-1",
			route: {
				authorModel: "claude-opus-5-5",
				authorVendor: "claude",
				reviewerVendor: "codex",
				reviewerModel: "gpt-5.6-sol",
				reviewerEffort: "xhigh",
			},
		});
		expect(appendWorkflowRunEventChecked).toHaveBeenCalledWith({
			runId: "run-1",
			nodeId: "implement",
			executionId: "exec-1",
			eventUid: "review_model_routed:run-1:implement:code:review-1",
			kind: "review_model_routed",
			payload: {
				schemaVersion: 1,
				reviewType: "code",
				requestId: "review-1",
				authorModel: "claude-opus-5-5",
				authorVendor: "claude",
				reviewerVendor: "codex",
				reviewerModel: "gpt-5.6-sol",
				reviewerEffort: "xhigh",
			},
		});
	});

	describe("FLY-2891 resolveRequiredReviewModel", () => {
		const routed = (
			reviewType: string,
			requestId: string,
			reviewerModel: string,
			reviewerEffort = "xhigh",
			reviewerVendor = "codex",
			executionId = "exec-1",
		) => ({
			kind: "review_model_routed",
			execution_id: executionId,
			payload: {
				reviewType,
				requestId,
				reviewerVendor,
				reviewerModel,
				reviewerEffort,
			},
		});
		const storeWith = (events: unknown[], snapshot?: string) => ({
			getWorkflowRunNodeForExecution: () => ({ run_id: "run-1" }),
			getWorkflowRun: () => (snapshot ? { snapshot } : undefined),
			getWorkflowExecutionRuntime: () => ({
				model: "claude-opus-5-5",
				vendor: "claude",
			}),
			listWorkflowRunEvents: () => events,
		});

		it("binds design to the manifest request's routed event", () => {
			const store = storeWith([
				routed("design", "req-1", "gpt-6-astra", "xhigh"),
				routed("design", "req-2", "gpt-6-astra", "high"),
			]);
			expect(
				resolveRequiredReviewModel(store as never, "exec-1", "design", "req-1"),
			).toEqual({ reviewerModel: "gpt-6-astra", reviewerEffort: "xhigh" });
			expect(
				resolveRequiredReviewModel(store as never, "exec-1", "design", "nope"),
			).toEqual({ reviewerModel: "gpt-6-astra", reviewerEffort: "high" });
		});

		it("takes the latest routed code event of this execution only", () => {
			const store = storeWith([
				routed("code", "e1", "gpt-5.6-sol", "high"),
				routed("design", "r1", "gpt-6-astra"),
				routed("code", "e2", "gpt-5.6-sol", "xhigh"),
				routed("code", "e3", "gpt-6-sol", "low", "codex", "other-exec"),
			]);
			expect(
				resolveRequiredReviewModel(store as never, "exec-1", "code"),
			).toEqual({ reviewerModel: "gpt-5.6-sol", reviewerEffort: "xhigh" });
		});

		it("recomputes when nothing was recorded and ignores non-Codex routes", () => {
			expect(
				resolveRequiredReviewModel(
					storeWith([], '{"modelRouting":{}}') as never,
					"exec-1",
					"code",
				),
			).toEqual({ reviewerModel: "gpt-5.6-sol", reviewerEffort: "xhigh" });
			expect(
				resolveRequiredReviewModel(
					storeWith([
						routed("code", "e1", "claude-opus-5-5", "xhigh", "claude"),
					]) as never,
					"exec-1",
					"code",
				),
			).toBeUndefined();
			expect(
				resolveRequiredReviewModel(storeWith([]) as never, "exec-1", "code"),
			).toBeUndefined();
		});

		it("propagates a corrupt routed snapshot instead of reading it as no requirement", () => {
			expect(() =>
				resolveRequiredReviewModel(
					storeWith([], "{corrupt") as never,
					"exec-1",
					"design",
				),
			).toThrow(/snapshot is corrupt/);
		});
	});
});
