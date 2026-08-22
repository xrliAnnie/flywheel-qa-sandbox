import { describe, expect, it, vi } from "vitest";
import type {
	StateStore,
	WorkflowGateHolderRow,
	WorkflowNodePrBindingRow,
	WorkflowShipTargetBindingRow,
} from "../../StateStore.js";
import { createWorkflowGateOriginPreflight } from "../gate-origin-preflight.js";

const HEAD = "a".repeat(40);

function fixture() {
	const holders = new Map<string, WorkflowGateHolderRow>();
	const runs = new Map<
		string,
		{ run_id: string; project_name: string; issue_id: string; status: string }
	>();
	const sessions = new Map<string, { merge_block_reason: string | null }>();
	const shipBindings = new Map<string, WorkflowShipTargetBindingRow>();
	const nodeBindings = new Map<string, WorkflowNodePrBindingRow>();

	const add = (
		questionId: string,
		projectName = "flywheel",
		authorityMode: "land" | "runner_ship" | "engine_terminal" | null = "land",
	) => {
		const runId = `run-${questionId}`;
		const sourceExecutionId = `exec-${questionId}`;
		holders.set(questionId, {
			run_id: runId,
			gate_node_id: "founder_gate",
			attempt: 1,
			head_sha: HEAD,
			source_execution_id: sourceExecutionId,
			question_id: questionId,
			authority_mode: authorityMode,
			subject_kind: "git_head",
			carrier_binding_state: "bound",
			approval_origin: null,
			card_message_id: null,
			card_post_intent_seq: 0,
			card_post_intent_at: null,
			card_post_correlation_marker: null,
			card_post_reconcile_not_before: null,
			card_post_outcome: null,
			card_post_first_zero_at: null,
			card_post_first_zero_frontier: null,
			card_post_legacy_unknown: 0,
			state: "materializing",
			materialization_stage: "question_intent",
			superseded_reason: null,
			card_void_state: null,
			card_void_attempts: 0,
			card_void_transient_attempts: 0,
			card_void_next_at: null,
			superseded_from_state: null,
			card_watch_next_at: null,
			card_watch_expires_at: null,
			origin_probe_attempts: 0,
			origin_probe_next_at: null,
			origin_probe_last_reason: null,
			origin_probe_verified_at: null,
			created_at: "2026-08-21T19:00:00.000Z",
			updated_at: "2026-08-21T19:00:00.000Z",
		} as WorkflowGateHolderRow);
		runs.set(runId, {
			run_id: runId,
			project_name: projectName,
			issue_id: "FLY-1757",
			status: "active",
		});
		sessions.set(sourceExecutionId, { merge_block_reason: null });
		shipBindings.set(questionId, {
			approve_question_id: questionId,
			run_id: runId,
			source_request_id: null,
			target_repo_path: "/trusted/repo",
			target_repo_identity: "github.com/acme/flywheel",
			probe_repo_slug: "acme/flywheel",
			frozen_head_sha: HEAD,
			worktree_binding_generation: "binding-1",
			superseded_at: null,
		});
		nodeBindings.set(runId, {
			run_id: runId,
			node_id: "implement",
			attempt: 1,
			pr_number: 42,
			head_sha: HEAD,
			target_repo_identity: "github.com/acme/flywheel",
			probe_repo_slug: "acme/flywheel",
			target_repo_path: "/trusted/repo",
			worktree_binding_generation: "binding-1",
			receipt_id: "receipt-1",
			bound_at: "2026-08-21T18:00:00.000Z",
		});
	};
	add("question-1");

	const deferWorkflowGateOriginProbe = vi.fn(() => ({
		ok: true as const,
		attempts: 1,
		nextAt: "2026-08-21T19:01:30.000Z",
	}));
	const markWorkflowGateOriginProbeVerified = vi.fn(() => ({
		ok: true as const,
	}));
	const stopWorkflowGateOriginProbe = vi.fn(() => ({ ok: true as const }));
	const holdWorkflowGateOriginProbeTerminal = vi.fn(() => ({
		ok: true as const,
		idempotentReplay: false,
	}));
	const store = {
		getCurrentWorkflowGateHolderByQuestionId: (questionId: string) =>
			holders.get(questionId),
		getWorkflowRun: (runId: string) => runs.get(runId),
		getSession: (executionId: string) => sessions.get(executionId),
		getWorkflowShipTargetBinding: (questionId: string) =>
			shipBindings.get(questionId),
		getCurrentWorkflowNodePrBindingForHead: (runId: string) =>
			nodeBindings.get(runId),
		deferWorkflowGateOriginProbe,
		markWorkflowGateOriginProbeVerified,
		stopWorkflowGateOriginProbe,
		holdWorkflowGateOriginProbeTerminal,
	} as unknown as StateStore;
	const prProbe = vi.fn(async () => ({
		state: "OPEN",
		isDraft: false,
		isCrossRepository: false,
		headRefName: "feature",
		headRefOid: HEAD,
	}));

	return {
		add,
		holders,
		runs,
		sessions,
		shipBindings,
		nodeBindings,
		store,
		prProbe,
		deferWorkflowGateOriginProbe,
		markWorkflowGateOriginProbeVerified,
		stopWorkflowGateOriginProbe,
		holdWorkflowGateOriginProbeTerminal,
	};
}

describe("workflow gate origin preflight", () => {
	it("passes only the exact current OPEN PR head", async () => {
		const f = fixture();
		const preflight = createWorkflowGateOriginPreflight({
			store: f.store,
			prProbe: f.prProbe,
			now: () => "2026-08-21T19:01:00.000Z",
		});

		await expect(preflight("question-1")).resolves.toEqual({ ok: true });
		expect(f.prProbe).toHaveBeenCalledWith({
			prNumber: 42,
			probeRepoSlug: "acme/flywheel",
		});
		expect(f.markWorkflowGateOriginProbeVerified).toHaveBeenCalledWith({
			questionId: "question-1",
			now: "2026-08-21T19:01:00.000Z",
		});
	});

	it("persists transient head drift and MERGED without holding the run", async () => {
		const f = fixture();
		f.prProbe
			.mockResolvedValueOnce({
				state: "OPEN",
				isDraft: false,
				isCrossRepository: false,
				headRefName: "feature",
				headRefOid: "b".repeat(40),
			})
			.mockResolvedValueOnce({
				state: "MERGED",
				isDraft: false,
				isCrossRepository: false,
				headRefName: "feature",
				headRefOid: HEAD,
			});
		const preflight = createWorkflowGateOriginPreflight({
			store: f.store,
			prProbe: f.prProbe,
			now: () => "2026-08-21T19:01:00.000Z",
		});

		await expect(preflight("question-1")).resolves.toMatchObject({
			ok: false,
			reason: "workflow_gate_origin_probe_head_mismatch",
		});
		await expect(preflight("question-1")).resolves.toMatchObject({
			ok: false,
			reason: "workflow_gate_origin_probe_pr_merged",
		});
		expect(f.deferWorkflowGateOriginProbe).toHaveBeenCalledTimes(2);
		expect(f.holdWorkflowGateOriginProbeTerminal).not.toHaveBeenCalled();
	});

	it("persists malformed provider output as a transient failure", async () => {
		const f = fixture();
		f.prProbe.mockResolvedValueOnce({
			state: "OPEN",
			isDraft: false,
			isCrossRepository: false,
			headRefName: "feature",
			headRefOid: undefined,
		});
		const preflight = createWorkflowGateOriginPreflight({
			store: f.store,
			prProbe: f.prProbe,
			now: () => "2026-08-21T19:01:00.000Z",
		});

		await expect(preflight("question-1")).resolves.toMatchObject({
			ok: false,
			reason: "workflow_gate_origin_probe_payload_invalid",
		});
		expect(f.deferWorkflowGateOriginProbe).toHaveBeenCalledOnce();
	});

	it("holds CLOSED and durable binding invariant failures once", async () => {
		const f = fixture();
		f.prProbe.mockResolvedValueOnce({
			state: "CLOSED",
			isDraft: false,
			isCrossRepository: false,
			headRefName: "feature",
			headRefOid: HEAD,
		});
		const preflight = createWorkflowGateOriginPreflight({
			store: f.store,
			prProbe: f.prProbe,
			now: () => "2026-08-21T19:01:00.000Z",
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
		});

		await expect(preflight("question-1")).resolves.toMatchObject({
			ok: false,
			reason: "workflow_gate_origin_probe_pr_closed",
		});
		f.shipBindings.delete("question-1");
		await expect(preflight("question-1")).resolves.toMatchObject({
			ok: false,
			reason: "workflow_gate_origin_probe_binding_missing",
		});
		expect(f.holdWorkflowGateOriginProbeTerminal).toHaveBeenCalledTimes(2);
	});

	it("defers a missing node binding and ignores provenance-only divergence", async () => {
		const f = fixture();
		const binding = f.nodeBindings.get("run-question-1")!;
		f.nodeBindings.delete("run-question-1");
		const preflight = createWorkflowGateOriginPreflight({
			store: f.store,
			prProbe: f.prProbe,
			now: () => "2026-08-21T19:01:00.000Z",
		});

		await expect(preflight("question-1")).resolves.toMatchObject({
			ok: false,
			reason: "workflow_gate_origin_probe_pr_binding_missing",
		});
		expect(f.holdWorkflowGateOriginProbeTerminal).not.toHaveBeenCalled();
		f.nodeBindings.set("run-question-1", {
			...binding,
			target_repo_path: "/other/provenance/path",
			worktree_binding_generation: "receipt-v1:other-producer",
		});
		await expect(preflight("question-1")).resolves.toEqual({ ok: true });
		expect(f.prProbe).toHaveBeenCalledOnce();
	});

	it("guards not-before, held runs, and merge-block before any raw probe", async () => {
		const f = fixture();
		const holder = f.holders.get("question-1") as WorkflowGateHolderRow & {
			origin_probe_next_at: string | null;
		};
		holder.origin_probe_next_at = "2026-08-21T19:02:00.000Z";
		const preflight = createWorkflowGateOriginPreflight({
			store: f.store,
			prProbe: f.prProbe,
			now: () => "2026-08-21T19:01:00.000Z",
		});

		await expect(preflight("question-1")).resolves.toMatchObject({
			ok: false,
			reason: "workflow_gate_origin_probe_deferred",
		});
		holder.origin_probe_next_at = null;
		(f.runs.get(holder.run_id) as { status: string }).status = "held";
		await expect(preflight("question-1")).resolves.toMatchObject({
			ok: false,
			reason: "workflow_gate_origin_probe_run_not_active",
		});
		(f.runs.get(holder.run_id) as { status: string }).status = "active";
		(
			f.sessions.get(holder.source_execution_id) as {
				merge_block_reason: string | null;
			}
		).merge_block_reason = "merge_without_approval";
		await expect(preflight("question-1")).resolves.toMatchObject({
			ok: false,
			reason: "workflow_gate_origin_probe_merge_blocked",
		});
		expect(f.stopWorkflowGateOriginProbe).toHaveBeenCalledOnce();
		expect(f.prProbe).not.toHaveBeenCalled();
	});

	it("caps raw probes at six per project per minute", async () => {
		const f = fixture();
		for (let index = 2; index <= 8; index += 1) {
			f.add(`question-${index}`, index === 8 ? "other" : "flywheel");
		}
		const preflight = createWorkflowGateOriginPreflight({
			store: f.store,
			prProbe: f.prProbe,
			now: () => "2026-08-21T19:01:00.000Z",
		});

		for (let index = 1; index <= 6; index += 1) {
			await expect(preflight(`question-${index}`)).resolves.toEqual({
				ok: true,
			});
		}
		await expect(preflight("question-7")).resolves.toMatchObject({
			ok: false,
			reason: "workflow_gate_origin_probe_project_budget",
		});
		await expect(preflight("question-8")).resolves.toEqual({ ok: true });
		expect(f.prProbe).toHaveBeenCalledTimes(7);
	});

	it("skips non-ship engine gates and legacy holders without a binding", async () => {
		const f = fixture();
		f.add("engine", "flywheel", "engine_terminal");
		f.add("legacy", "flywheel", null);
		f.shipBindings.delete("legacy");
		(
			f.sessions.get("exec-engine") as { merge_block_reason: string | null }
		).merge_block_reason = "unrelated_merge_block";
		f.holders.get("engine")!.origin_probe_next_at = "2026-08-21T19:02:00.000Z";
		const preflight = createWorkflowGateOriginPreflight({
			store: f.store,
			prProbe: f.prProbe,
			now: () => "2026-08-21T19:01:00.000Z",
		});

		await expect(preflight("engine")).resolves.toEqual({ ok: true });
		await expect(preflight("legacy")).resolves.toEqual({ ok: true });
		expect(f.stopWorkflowGateOriginProbe).not.toHaveBeenCalled();
		expect(f.prProbe).not.toHaveBeenCalled();
	});
});
