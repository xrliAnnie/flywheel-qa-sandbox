import { CommDB } from "flywheel-comm/db";
import type {
	StateStore,
	WorkflowGateHolderRow,
	WorkflowGateMaterializationStage,
} from "../StateStore.js";
import {
	readCurrentGateMessageBinding,
	writeGateMessageBinding,
} from "./approval-signal/gate-message-binding-store.js";

const STAGE_ORDER: Record<WorkflowGateMaterializationStage, number> = {
	question_intent: 0,
	question_written: 1,
	session_bound: 2,
	card_posted: 3,
	card_bound: 4,
	completed: 5,
};

export interface GateMaterializerDeps {
	store: StateStore;
	commDbPath: string;
	leadId: string;
	threadId: string;
	postCard(input: {
		questionId: string;
		runId: string;
		issueId: string;
		projectName: string;
		headSha: string;
		sourceExecutionId: string;
		content: string;
	}): Promise<{ messageId: string }>;
	now?: () => string;
}

export type GateMaterializationResult =
	| {
			ok: true;
			idempotentReplay: boolean;
			state: "awaiting_review";
			questionId: string;
			cardMessageId: string;
	  }
	| { ok: false; reason: string };

function current(
	store: StateStore,
	questionId: string,
): WorkflowGateHolderRow | undefined {
	return store.getCurrentWorkflowGateHolderByQuestionId(questionId);
}

/**
 * Converge one first-class workflow gate through CommDB and the founder card.
 * Every stage is durable. Card delivery is deliberately at-least-once; only
 * the message id recorded on the current holder is authoritative.
 */
export async function materializeWorkflowGateHolder(
	deps: GateMaterializerDeps,
	questionId: string,
): Promise<GateMaterializationResult> {
	let holder = current(deps.store, questionId);
	if (!holder) return { ok: false, reason: "workflow_gate_holder_not_found" };
	if (holder.state === "approved") {
		return { ok: false, reason: "workflow_gate_holder_already_approved" };
	}
	if (
		holder.materialization_stage === "completed" &&
		holder.state === "awaiting_review" &&
		holder.card_message_id
	) {
		return {
			ok: true,
			idempotentReplay: true,
			state: "awaiting_review",
			questionId,
			cardMessageId: holder.card_message_id,
		};
	}
	const run = deps.store.getWorkflowRun(holder.run_id);
	if (!run) return { ok: false, reason: "workflow_gate_run_not_found" };
	const now = deps.now ?? (() => new Date().toISOString());
	const content = `🚀 ${run.issue_id} is ready to ship\nHead: ${holder.head_sha}\nApprove only this exact head.`;

	if (
		STAGE_ORDER[holder.materialization_stage] < STAGE_ORDER.question_written
	) {
		const comm = new CommDB(deps.commDbPath);
		try {
			comm.insertQuestion(holder.source_execution_id, deps.leadId, content, {
				id: holder.question_id,
				checkpoint: "approve_to_ship",
			});
		} finally {
			comm.close();
		}
		deps.store.advanceWorkflowGateHolderMaterialization({
			questionId,
			stage: "question_written",
			now: now(),
		});
		holder = current(deps.store, questionId)!;
	}
	if (STAGE_ORDER[holder.materialization_stage] < STAGE_ORDER.session_bound) {
		// The holder itself is the durable binding; source_execution_id is only
		// provenance and may already be physically torn down.
		deps.store.advanceWorkflowGateHolderMaterialization({
			questionId,
			stage: "session_bound",
			now: now(),
		});
		holder = current(deps.store, questionId)!;
	}
	if (STAGE_ORDER[holder.materialization_stage] < STAGE_ORDER.card_posted) {
		const posted = await deps.postCard({
			questionId,
			runId: holder.run_id,
			issueId: run.issue_id,
			projectName: run.project_name,
			headSha: holder.head_sha,
			sourceExecutionId: holder.source_execution_id,
			content,
		});
		if (!posted.messageId) {
			return { ok: false, reason: "workflow_gate_card_missing_message_id" };
		}
		deps.store.advanceWorkflowGateHolderMaterialization({
			questionId,
			stage: "card_posted",
			cardMessageId: posted.messageId,
			now: now(),
		});
		holder = current(deps.store, questionId)!;
	}
	if (
		STAGE_ORDER[holder.materialization_stage] < STAGE_ORDER.card_bound &&
		holder.card_message_id
	) {
		writeGateMessageBinding(
			deps.store,
			{
				questionId,
				executionId: holder.source_execution_id,
				issueId: run.issue_id,
				prHeadSha: holder.head_sha,
				threadId: deps.threadId,
				gateMessageId: holder.card_message_id,
				checkpoint: "approve_to_ship",
				postedAt: holder.updated_at,
			},
			run.project_name,
		);
		const binding = readCurrentGateMessageBinding(
			deps.store,
			holder.source_execution_id,
			questionId,
			holder.head_sha,
		);
		if (
			binding?.gateMessageId !== holder.card_message_id ||
			binding.threadId !== deps.threadId
		) {
			return { ok: false, reason: "workflow_gate_card_binding_conflict" };
		}
		deps.store.advanceWorkflowGateHolderMaterialization({
			questionId,
			stage: "card_bound",
			cardMessageId: holder.card_message_id,
			now: now(),
		});
		holder = current(deps.store, questionId)!;
	}
	if (STAGE_ORDER[holder.materialization_stage] < STAGE_ORDER.completed) {
		deps.store.advanceWorkflowGateHolderMaterialization({
			questionId,
			stage: "completed",
			now: now(),
		});
		holder = current(deps.store, questionId)!;
	}
	if (!holder.card_message_id || holder.state !== "awaiting_review") {
		return { ok: false, reason: "workflow_gate_materialization_incomplete" };
	}
	return {
		ok: true,
		idempotentReplay: false,
		state: "awaiting_review",
		questionId,
		cardMessageId: holder.card_message_id,
	};
}
