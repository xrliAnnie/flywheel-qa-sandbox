import { createHash } from "node:crypto";
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
	preflight(
		questionId: string,
	): Promise<{ ok: true } | { ok: false; reason: string }>;
	postCard(input: {
		questionId: string;
		runId: string;
		issueId: string;
		projectName: string;
		headSha: string;
		sourceExecutionId: string;
		content: string;
		correlationMarker: string;
	}): Promise<
		| { messageId: string }
		| { kind: "posted"; messageId: string }
		| { kind: "posted_ambiguous" }
		| { kind: "no_effect"; reason?: string }
	>;
	scanCard?(input: {
		questionId: string;
		postedAt: string;
		correlationMarker: string;
		legacyTerms: string[];
	}): Promise<
		| { kind: "found"; messageId: string; frontier: string | null }
		| { kind: "none"; frontier: string | null }
		| { kind: "ambiguous"; frontier: string | null; reason?: string }
	>;
	reconcileNotBeforeMs?: number;
	reconcileQuietIntervalMs?: number;
	maxPostIntents?: number;
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

function gateCorrelationMarker(questionId: string): string {
	return `gate:${createHash("sha256").update(questionId).digest("hex").slice(0, 12)}`;
}

function normalizedPostResult(
	result:
		| { messageId: string }
		| { kind: "posted"; messageId: string }
		| { kind: "posted_ambiguous" }
		| { kind: "no_effect"; reason?: string },
):
	| { kind: "posted"; messageId: string }
	| { kind: "posted_ambiguous" }
	| { kind: "no_effect" } {
	if ("messageId" in result) {
		return result.messageId
			? { kind: "posted", messageId: result.messageId }
			: { kind: "posted_ambiguous" };
	}
	return result.kind === "no_effect"
		? { kind: "no_effect" }
		: { kind: "posted_ambiguous" };
}

function ensureFounderCardAudit(input: {
	store: StateStore;
	holder: WorkflowGateHolderRow;
	issueId: string;
	projectName: string;
	threadId: string;
	messageId: string;
}): boolean {
	const matching = input.store
		.getEventsByExecution(input.holder.source_execution_id)
		.filter((event) => {
			if (event.event_type !== "founder_thread_notified") return false;
			const payload = event.payload as Record<string, unknown> | undefined;
			return payload?.questionId === input.holder.question_id;
		});
	if (matching.length > 1) return false;
	if (matching.length === 1) {
		const payload = matching[0]!.payload as Record<string, unknown> | undefined;
		return (
			payload?.gateMessageId === undefined ||
			payload.gateMessageId === input.messageId
		);
	}
	input.store.insertEvent({
		event_id: `founder-thread-notified-workflow-gate-${createHash("sha256")
			.update(input.holder.question_id)
			.digest("hex")
			.slice(0, 16)}`,
		execution_id: input.holder.source_execution_id,
		issue_id: input.issueId,
		project_name: input.projectName,
		event_type: "founder_thread_notified",
		source: "bridge.gate-materializer",
		payload: {
			questionId: input.holder.question_id,
			checkpoint: "approve_to_ship",
			threadId: input.threadId,
			gateMessageId: input.messageId,
			status: "converged",
		},
	});
	return true;
}

/**
 * Converge one first-class workflow gate through CommDB and the founder card.
 * Every stage is durable. Card delivery uses a persisted intent plus bounded,
 * fail-closed Discord reconciliation so an ambiguous 2xx is never blind-retried.
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
		holder.authority_mode === "runner_ship" &&
		holder.carrier_binding_state !== "bound"
	) {
		return { ok: false, reason: "workflow_gate_carrier_unbound" };
	}
	const run = deps.store.getWorkflowRun(holder.run_id);
	if (!run) return { ok: false, reason: "workflow_gate_run_not_found" };
	if (
		holder.materialization_stage === "completed" &&
		holder.state === "awaiting_review" &&
		holder.card_message_id
	) {
		if (
			!ensureFounderCardAudit({
				store: deps.store,
				holder,
				issueId: run.issue_id,
				projectName: run.project_name,
				threadId: deps.threadId,
				messageId: holder.card_message_id,
			})
		) {
			return { ok: false, reason: "workflow_gate_card_audit_conflict" };
		}
		return {
			ok: true,
			idempotentReplay: true,
			state: "awaiting_review",
			questionId,
			cardMessageId: holder.card_message_id,
		};
	}
	const now = deps.now ?? (() => new Date().toISOString());
	const content = `🚀 ${run.issue_id} is ready to ship\nHead: ${holder.head_sha}\nApprove only this exact head.\nApproval is recognized only from the founder's ✅ reaction on this card or an exact reply-to-card: approve / look good to me.\n打回:请 reply-to 本卡回复「打回」,或用 design: / implement: / qa:(也认全角冒号,或 设计:/实现:/测试:)起头指定返工对象;请说清楚要改什么。\n提问、讨论和其它 thread 自由发言只转给 Lead,不会写入 verdict,本轮保持开放。`;

	if (
		STAGE_ORDER[holder.materialization_stage] < STAGE_ORDER.card_posted &&
		holder.card_post_intent_seq < (deps.maxPostIntents ?? 3) &&
		holder.card_post_legacy_unknown === 0 &&
		(holder.card_post_outcome === null ||
			holder.card_post_outcome === "no_effect")
	) {
		const preflight = await deps.preflight(questionId);
		if (!preflight.ok) return preflight;
		holder = current(deps.store, questionId);
		if (!holder) {
			return { ok: false, reason: "workflow_gate_holder_not_found" };
		}
	}
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
		const observedNow = now();
		const marker = gateCorrelationMarker(questionId);
		const reconcileAt = new Date(
			Date.parse(observedNow) + (deps.reconcileNotBeforeMs ?? 60_000),
		).toISOString();
		const intent = deps.store.claimWorkflowGateCardPostIntent({
			questionId,
			correlationMarker: marker,
			now: observedNow,
			reconcileNotBefore: reconcileAt,
			maxAttempts: deps.maxPostIntents ?? 3,
		});
		if (!intent.ok) return { ok: false, reason: intent.reason };

		if (intent.created) {
			let posted:
				| { kind: "posted"; messageId: string }
				| { kind: "posted_ambiguous" }
				| { kind: "no_effect" };
			try {
				posted = normalizedPostResult(
					await deps.postCard({
						questionId,
						runId: holder.run_id,
						issueId: run.issue_id,
						projectName: run.project_name,
						headSha: holder.head_sha,
						sourceExecutionId: holder.source_execution_id,
						content,
						correlationMarker: intent.correlationMarker,
					}),
				);
			} catch {
				// A network exception can happen after Discord accepted the bytes.
				posted = { kind: "posted_ambiguous" };
			}
			if (posted.kind === "posted") {
				deps.store.advanceWorkflowGateHolderMaterialization({
					questionId,
					stage: "card_posted",
					cardMessageId: posted.messageId,
					now: now(),
				});
				holder = current(deps.store, questionId)!;
			} else {
				deps.store.markWorkflowGateCardPostOutcome({
					questionId,
					sequence: intent.sequence,
					outcome: posted.kind === "no_effect" ? "no_effect" : "ambiguous",
				});
				return {
					ok: false,
					reason:
						posted.kind === "no_effect"
							? "workflow_gate_card_post_no_effect"
							: "workflow_gate_card_post_ambiguous",
				};
			}
		} else {
			if (Date.parse(observedNow) < Date.parse(intent.reconcileNotBefore)) {
				return { ok: false, reason: "workflow_gate_card_reconcile_wait" };
			}
			if (!deps.scanCard) {
				return { ok: false, reason: "workflow_gate_card_reconciler_missing" };
			}
			const scan = await deps.scanCard({
				questionId,
				postedAt: intent.postedAt,
				correlationMarker: intent.correlationMarker,
				legacyTerms: intent.legacyUnknown
					? [run.issue_id, holder.head_sha]
					: [],
			});
			if (scan.kind === "ambiguous") {
				return { ok: false, reason: "workflow_gate_card_reconcile_ambiguous" };
			}
			if (scan.kind === "found") {
				deps.store.advanceWorkflowGateHolderMaterialization({
					questionId,
					stage: "card_posted",
					cardMessageId: scan.messageId,
					now: now(),
				});
				deps.store.insertEvent({
					event_id: `workflow-gate-card-reconciled-${createHash("sha256")
						.update(questionId)
						.digest("hex")
						.slice(0, 16)}`,
					execution_id: holder.source_execution_id,
					issue_id: run.issue_id,
					project_name: run.project_name,
					event_type: "workflow_gate_card_reconciled",
					source: "bridge.gate-materializer",
					payload: {
						questionId,
						gateMessageId: scan.messageId,
						legacyUnknown: intent.legacyUnknown,
					},
				});
				holder = current(deps.store, questionId)!;
			} else {
				const zero = deps.store.recordWorkflowGateCardZeroScan({
					questionId,
					sequence: intent.sequence,
					at: observedNow,
					frontier: scan.frontier,
				});
				if (!zero.ok) return { ok: false, reason: zero.reason };
				const quietElapsed =
					!zero.first &&
					Date.parse(observedNow) - Date.parse(zero.priorAt!) >=
						(deps.reconcileQuietIntervalMs ?? 30_000);
				if (zero.first || !zero.frontierStable || !quietElapsed) {
					return {
						ok: false,
						reason: "workflow_gate_card_zero_scan_unconfirmed",
					};
				}
				const marked = deps.store.markWorkflowGateCardPostOutcome({
					questionId,
					sequence: intent.sequence,
					outcome: "no_effect",
				});
				return marked.ok
					? { ok: false, reason: "workflow_gate_card_retry_authorized" }
					: { ok: false, reason: marked.reason };
			}
		}
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
	if (
		!ensureFounderCardAudit({
			store: deps.store,
			holder,
			issueId: run.issue_id,
			projectName: run.project_name,
			threadId: deps.threadId,
			messageId: holder.card_message_id,
		})
	) {
		return { ok: false, reason: "workflow_gate_card_audit_conflict" };
	}
	return {
		ok: true,
		idempotentReplay: false,
		state: "awaiting_review",
		questionId,
		cardMessageId: holder.card_message_id,
	};
}
