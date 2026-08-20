import type { CheckpointsConfig } from "flywheel-config";
import type {
	AdapterExecutionContext,
	AdapterExecutionResult,
	IAdapter,
} from "flywheel-core";
import type { DagNode } from "flywheel-dag-resolver";
import { describe, expect, it, vi } from "vitest";
import type { BlueprintContext, ShellRunner } from "../Blueprint.js";
import { Blueprint } from "../Blueprint.js";
import type { GitResultChecker } from "../GitResultChecker.js";
import { PreHydrator } from "../PreHydrator.js";

function harness(checkpoints?: CheckpointsConfig) {
	const adapter: IAdapter = {
		type: "mock",
		supportsStreaming: false,
		checkEnvironment: async () => ({ healthy: true, message: "mock" }),
		execute: vi.fn(
			async (): Promise<AdapterExecutionResult> => ({
				success: true,
				sessionId: "session",
				durationMs: 1,
			}),
		),
	};
	const hydrator = new PreHydrator(async (id) => ({
		title: `Issue ${id}`,
		description: "Bounded generalized task",
		descriptionSource: "authoritative",
		labels: ["sonnet"],
	}));
	const git = {
		assertCleanTree: vi.fn(async () => {}),
		captureBaseline: vi.fn(async () => "base"),
		check: vi.fn(async () => ({
			hasNewCommits: false,
			commitCount: 0,
			filesChanged: 0,
			commitMessages: [],
		})),
	} as unknown as GitResultChecker;
	const shell = {
		execFile: vi.fn(async () => ({ stdout: "", exitCode: 0 })),
	} as ShellRunner;
	return {
		adapter,
		blueprint: new Blueprint(
			hydrator,
			git,
			() => adapter,
			shell,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			checkpoints,
		),
	};
}

const node: DagNode = { id: "FLY-1281", blockedBy: [] };
const generalized: BlueprintContext = {
	teamName: "eng",
	runnerName: "codex",
	projectName: "flywheel",
	executionId: "exec-1",
	generalizedExecutionContext: {
		runId: "run-1",
		nodeId: "research",
		attempt: 1,
		snapshotDigest: "snapshot-digest",
	},
	workflowCapabilities: {
		shared_branch_writer: false,
		creates_pr: false,
		can_ship: false,
		can_land: false,
		produces_output: true,
		completion_route: "no_code",
	},
	workflowAgentContent: "Research the issue and produce one JSON artifact.",
	workflowOutputCredential: "output-ticket",
};

describe("Blueprint generalized workflow capability contract", () => {
	it("prepares the exact hydrated issue body and launch anchor before dispatch", async () => {
		const { blueprint, adapter } = harness();
		const prepareWorkflowIssueDelivery = vi.fn();

		await blueprint.run(node, "/tmp/fly1707-delivery", {
			...generalized,
			prepareWorkflowIssueDelivery,
		});

		expect(prepareWorkflowIssueDelivery).toHaveBeenCalledWith({
			sourceKind: "authoritative",
			body: "Bounded generalized task",
			anchorCommit: "base",
		});
		expect(adapter.execute).toHaveBeenCalledOnce();
	});

	it("uses pinned agent/capabilities, injects the output ticket, and suppresses write/ship", async () => {
		const { blueprint, adapter } = harness();
		await blueprint.run(node, "/tmp/fly1281-generalized", {
			...generalized,
			leadId: "flywheel-product-lead",
			workflowCapabilities: {
				...generalized.workflowCapabilities,
				founder_review_required: true,
			},
		});
		const call = (adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as AdapterExecutionContext;
		const prompt = call.appendSystemPrompt ?? "";
		expect(prompt).toContain(
			"Research the issue and produce one JSON artifact.",
		);
		expect(prompt).toContain("workflow-output --payload-file");
		expect(prompt).toContain("complete --route no_code");
		expect(prompt).toContain("do not modify the shared branch");
		expect(prompt).toContain("Do not request ship approval");
		expect(prompt).toContain("FOUNDER REVIEW ROUND (BLOCKING, REPEATABLE)");
		expect(prompt).toContain("gate founder_review");
		expect(prompt).toContain("--publish-only");
		expect(prompt).toContain("【页面意见汇总】FLY-1281");
		expect(prompt).toContain(
			"Questions, page-summary pastes, and all other thread speech go to Lead",
		);
		expect(prompt).toContain("写完点复制贴回，我才收得到");
		expect(prompt).not.toContain("Any reply other than an exact pass phrase");
		expect(prompt).toContain("Do not run complete");
		expect(prompt).not.toContain("BRAINSTORM GATE");
		expect(call.workflowOutputCredential).toBe("output-ticket");
		expect(call.founderReviewRequired).toBe(true);
	});

	it("renders the pinned completion route and a decision-only verdict contract", async () => {
		const designHarness = harness();
		await designHarness.blueprint.run(node, "/tmp/fly1307-design", {
			...generalized,
			generalizedExecutionContext: {
				...generalized.generalizedExecutionContext!,
				nodeId: "design",
			},
			workflowCapabilities: {
				...generalized.workflowCapabilities,
				shared_branch_writer: true,
				produces_output: false,
				completion_route: "phase_design_complete",
			},
			leadId: "flywheel-eng-lead",
			workflowOutputCredential: undefined,
		});
		const designCall = (
			designHarness.adapter.execute as ReturnType<typeof vi.fn>
		).mock.calls[0]![0] as AdapterExecutionContext;
		expect(designCall.appendSystemPrompt).toContain(
			"complete --route phase_design_complete",
		);
		expect(designCall.appendSystemPrompt).toContain(
			"Founder design HTML (MANDATORY)",
		);
		expect(designCall.appendSystemPrompt).toContain(
			"INTERACTIVE COMMENT LAYER (MANDATORY",
		);
		expect(designCall.appendSystemPrompt).toContain(
			"DIAGRAMS AND LANGUAGE (MANDATORY",
		);
		expect(designCall.appendSystemPrompt).toContain(
			"plain-language explanation",
		);
		expect(designCall.appendSystemPrompt).toContain("--publish-only");
		expect(designCall.appendSystemPrompt).toContain("--lead flywheel-eng-lead");

		const reviewHarness = harness();
		await reviewHarness.blueprint.run(node, "/tmp/fly1307-review", {
			...generalized,
			generalizedExecutionContext: {
				...generalized.generalizedExecutionContext!,
				nodeId: "review",
			},
			workflowCapabilities: {
				...generalized.workflowCapabilities,
				produces_output: false,
				completion_route: "needs_review",
				pass_enters_approval_gate: true,
				gate_entry_authority_kind: "materialization_receipt",
			},
			workflowOutputCredential: undefined,
			workflowSubmissionCredential: "review-ticket",
			workflowSubmissionExpected: true,
		});
		const reviewCall = (
			reviewHarness.adapter.execute as ReturnType<typeof vi.fn>
		).mock.calls[0]![0] as AdapterExecutionContext;
		expect(reviewCall.appendSystemPrompt).toContain("qa-result");
		expect(reviewCall.appendSystemPrompt).toContain("--status pass|fail");
		expect(reviewCall.appendSystemPrompt).toContain("Do not run `complete`");
		expect(reviewCall.workflowSubmissionCredential).toBe("review-ticket");
		expect(reviewCall.workflowSubmissionExpected).toBe(true);
		expect(reviewCall.appendSystemPrompt).toContain("env -u");
		expect(reviewCall.appendSystemPrompt).toContain("replay_payload_mismatch");
		expect(reviewCall.appendSystemPrompt).toContain(
			"server-attested materialized head",
		);
		expect(reviewCall.appendSystemPrompt).not.toContain("your worktree HEAD");
		expect(reviewCall.appendSystemPrompt).toContain(
			"do not create, amend, or push another commit",
		);
	});

	it("adds gate-entry immutability only for structurally direct worktree verdicts", async () => {
		const direct = harness();
		await direct.blueprint.run(node, "/tmp/fly1686-direct-qa", {
			...generalized,
			generalizedExecutionContext: {
				...generalized.generalizedExecutionContext!,
				nodeId: "verifier",
			},
			workflowCapabilities: {
				...generalized.workflowCapabilities,
				produces_output: false,
				completion_route: "needs_review",
				pass_enters_approval_gate: true,
				gate_entry_authority_kind: "worktree",
			},
			workflowOutputCredential: undefined,
			workflowSubmissionCredential: "qa-ticket",
			workflowSubmissionExpected: true,
		});
		const directPrompt = (direct.adapter.execute as ReturnType<typeof vi.fn>)
			.mock.calls[0]![0].appendSystemPrompt as string;
		expect(directPrompt).toContain("binds your worktree HEAD at verdict time");

		const indirect = harness();
		await indirect.blueprint.run(node, "/tmp/fly1686-indirect-qa", {
			...generalized,
			generalizedExecutionContext: {
				...generalized.generalizedExecutionContext!,
				nodeId: "intermediate-verifier",
			},
			workflowCapabilities: {
				...generalized.workflowCapabilities,
				produces_output: false,
				completion_route: "needs_review",
			},
			workflowOutputCredential: undefined,
			workflowSubmissionCredential: "review-ticket",
			workflowSubmissionExpected: true,
		});
		const indirectPrompt = (
			indirect.adapter.execute as ReturnType<typeof vi.fn>
		).mock.calls[0]![0].appendSystemPrompt as string;
		expect(indirectPrompt).not.toContain("exact version eligible to ship");
		expect(indirectPrompt).not.toContain(
			"do not create, amend, or push another commit",
		);
	});

	it("binds the HTML gate to design-node completion, independent of workflow topology", async () => {
		const illegalDesign = harness();
		await expect(
			illegalDesign.blueprint.run(node, "/tmp/fly1404-two-node-design", {
				...generalized,
				leadId: "flywheel-eng-lead",
				generalizedExecutionContext: {
					...generalized.generalizedExecutionContext!,
					nodeId: "design-in-two-node-workflow",
				},
				workflowCapabilities: {
					...generalized.workflowCapabilities,
					produces_output: false,
					completion_route: "phase_design_complete",
				},
			}),
		).rejects.toThrow(/design-node.*shared branch writer/i);

		const noDesign = harness();
		await noDesign.blueprint.run(node, "/tmp/fly1404-no-design", generalized);
		const noDesignCall = (noDesign.adapter.execute as ReturnType<typeof vi.fn>)
			.mock.calls[0]![0] as AdapterExecutionContext;
		expect(noDesignCall.appendSystemPrompt).not.toContain(
			"Founder design HTML (MANDATORY)",
		);
		expect(noDesignCall.appendSystemPrompt).not.toContain(
			"INTERACTIVE COMMENT LAYER",
		);
		expect(noDesignCall.appendSystemPrompt).not.toContain(
			"DIAGRAMS AND LANGUAGE",
		);
	});

	it("fails closed when pinned generalized inputs are incomplete or unsupported", async () => {
		const first = harness();
		await expect(
			first.blueprint.run(node, "/tmp/fly1281-generalized", {
				...generalized,
				workflowAgentContent: "",
			}),
		).rejects.toThrow(/missing pinned capabilities or agent content/i);

		const second = harness();
		await expect(
			second.blueprint.run(node, "/tmp/fly1281-generalized", {
				...generalized,
				workflowCapabilities: {
					...generalized.workflowCapabilities,
					completion_route: "future_route",
				},
			}),
		).rejects.toThrow(/unsupported generalized completion route/i);
	});

	// FLY-1281 QA regression: capability isolation must hold on the PRODUCTION
	// shape. The pre-existing assertion above runs with NO checkpointConfig, so
	// its `not.toContain("BRAINSTORM GATE")` passes vacuously — the gate text is
	// only ever injected when checkpoints are enabled. The flywheel project runs
	// with brainstorm + approve_to_ship enabled, and the checkpoint loop in
	// Blueprint only skips those for `isQaRunner` — a generalized no-write /
	// no-ship node still gets them, so its prompt says both "Do not request ship
	// approval" AND "APPROVE GATE (MANDATORY)" / MERGE AUTHORITY / verify-approval.
	it("suppresses brainstorm/approve_to_ship gates for a generalized node when checkpoints are enabled", async () => {
		const checkpoints = {
			brainstorm: { enabled: true },
			approve_to_ship: { enabled: true },
			question: { enabled: true },
		} as unknown as CheckpointsConfig;
		const { blueprint, adapter } = harness(checkpoints);
		await blueprint.run(node, "/tmp/fly1281-generalized-cp", {
			...generalized,
			leadId: "flywheel-eng-lead",
		} as BlueprintContext);
		const call = (adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as AdapterExecutionContext;
		const prompt = call.appendSystemPrompt ?? "";

		// The capability contract this node was pinned with.
		expect(prompt).toContain("Do not request ship approval");
		expect(prompt).toContain("complete --route no_code");

		// ...must not be contradicted by legacy ship/merge instructions.
		expect(prompt).not.toContain("APPROVE GATE");
		expect(prompt).not.toContain("complete --route needs_review");
		expect(prompt).not.toContain("MERGE AUTHORITY");
		expect(prompt).not.toContain("verify-approval");
		expect(prompt).not.toContain("BRAINSTORM GATE");
		expect(prompt).not.toContain("Verify CI passes");
		expect(prompt).not.toContain("fix and push again");
		expect(prompt).not.toContain("COMPLETION REPORTING");
		expect(prompt).not.toContain("stage set completed");
		expect(prompt).not.toContain("approve_to_ship");

		// Generalized nodes can still ask their Lead through the bounded question
		// checkpoint; capability isolation must not suppress that safe gate.
		expect(prompt).toContain("QUESTION GATE");
	});

	it("does not leak the legacy DAG workflow landing or approve epilogue into an epoch-1 generalized implement node", async () => {
		const checkpoints = {
			brainstorm: { enabled: true },
			approve_to_ship: { enabled: true },
			question: { enabled: true },
		} as unknown as CheckpointsConfig;
		const { blueprint, adapter } = harness(checkpoints);
		await blueprint.run(node, "/tmp/fly1441-generalized-implement", {
			...generalized,
			leadId: "flywheel-eng-lead",
			shareParentBranch: true,
			sessionRole: "implement",
			generalizedExecutionContext: {
				...generalized.generalizedExecutionContext!,
				nodeId: "implement",
				gateCarrierEpoch: 1,
			},
			workflowCapabilities: {
				...generalized.workflowCapabilities,
				shared_branch_writer: true,
				creates_pr: true,
				can_ship: true,
				can_land: true,
				produces_output: false,
				completion_route: "needs_review",
			},
			workflowOutputCredential: undefined,
		});
		const call = (adapter.execute as ReturnType<typeof vi.fn>).mock
			.calls[0]![0] as AdapterExecutionContext;
		const prompt = call.appendSystemPrompt ?? "";

		expect(prompt).toContain("complete --route needs_review");
		expect(prompt).not.toContain("APPROVE GATE");
		expect(prompt).not.toContain("flywheel-land");
		expect(prompt).not.toContain("Landing signal path");
		expect(prompt).not.toContain("DAG workflow keep-alive (implement phase)");
		expect(prompt).toContain("TURN WAIT LAW (all runner vendors)");
		expect(prompt).toContain("not-yours` is a normal wait state");
	});
});
