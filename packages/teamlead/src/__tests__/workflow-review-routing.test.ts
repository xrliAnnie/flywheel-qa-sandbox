import { describe, expect, it, vi } from "vitest";
import {
	recordWorkflowReviewRoute,
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
});
