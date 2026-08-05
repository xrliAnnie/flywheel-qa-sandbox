/**
 * FLY-1373 question admission: raw CommDB questions are not delivery authority.
 * This pass preserves the old scope/hold checks, then materializes one durable
 * model row. Dispatch revalidation catches answers, supersession, and hold drift.
 */

import type { Message } from "flywheel-comm/db";
import { CommDB } from "flywheel-comm/db";
import type { MailboxQueue, MailboxRow } from "flywheel-comm/mailbox-queue";
import { readContentRef } from "flywheel-comm/utils";
import type { LeadConfig, ProjectEntry } from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";
import { reviewHoldReason } from "./auto-qa-held.js";
import { resolveChatThreadId } from "./chat-thread-utils.js";
import type { HookPayload } from "./hook-payload.js";
import type { LeadEventEnvelope } from "./lead-runtime.js";
import { matchesLead } from "./lead-scope.js";
import type { RuntimeRegistry } from "./runtime-registry.js";

const ACTIVE_GATE_SESSION_STATUSES = new Set([
	"running",
	"awaiting_review",
	"approved_to_ship",
]);

export interface QuestionAdmissionOptions {
	queue: MailboxQueue;
	dbPath: string;
	lead: LeadConfig;
	projects: ProjectEntry[];
	store: StateStore;
	runtimeRegistry: RuntimeRegistry;
	chatThreadsEnabled?: boolean;
}

export class QuestionAdmission {
	private db?: CommDB;

	constructor(private readonly opts: QuestionAdmissionOptions) {}

	/**
	 * FLY-1601: one cached connection for this admission's lifetime. The old
	 * code built a FRESH CommDB — whose constructor replays the entire
	 * migration suite — on EVERY materializePending() (once per tick per Lead)
	 * and every revalidate(). CPU-profiled on the wedged 2026-08-02 Bridge:
	 * the #1 hotspot was exec → applyReceiptFoundationMigrations → CommDB ←
	 * materializePending ← admit ← timers. Sixteen Leads × 1s active interval
	 * × synchronous migration exec against a contended comm.db (5s
	 * busy_timeout) pinned the event loop so hard that /health timed out for
	 * 20s+ while the process stayed alive — the "passed health at boot, died
	 * under adoption load" signature.
	 */
	private commDb(): CommDB {
		this.db ??= new CommDB(this.opts.dbPath, false);
		return this.db;
	}

	/** Release the cached connection (tests / runtime teardown). */
	close(): void {
		this.db?.close();
		this.db = undefined;
	}

	async revalidate(
		row: MailboxRow,
	): Promise<
		{ deliver: true } | { deliver: false; disposition: string; retry?: boolean }
	> {
		if (
			row.type !== "question" ||
			row.recipient_kind !== "lead" ||
			row.delivery_id !== `question:${row.to_agent}:${row.id}`
		) {
			return { deliver: true };
		}
		const db = this.commDb();
		const question = db.getMessageById(row.id);
		if (!question) {
			return {
				deliver: false,
				disposition: "revoked_missing",
				retry: row.source_kind !== "question_orphan" && row.source_ref === null,
			};
		}
		if (question.superseded_at) {
			return { deliver: false, disposition: "revoked_superseded" };
		}
		if (
			!db
				.getPendingQuestions(this.opts.lead.agentId)
				.some(({ id }) => id === question.id)
		) {
			return { deliver: false, disposition: "revoked_answered" };
		}
		const eligible = this.eligibility(question);
		if (!eligible.ok) {
			return {
				deliver: false,
				disposition: eligible.disposition,
				retry: row.source_ref === null,
			};
		}
		if (row.source_ref !== null) return { deliver: true };
		this.materialize(row, question, eligible.session);
		return { deliver: true };
	}

	private materialize(
		row: MailboxRow,
		question: Message,
		session: Session,
	): void {
		const isGate = question.checkpoint != null;
		const eventId = isGate ? `gate_${question.id}` : `runner_q_${question.id}`;
		const eventType = isGate ? "gate_question" : "runner_question";
		const fullContent =
			question.content_type === "ref" && question.content_ref
				? (readContentRef(question.content_ref) ?? question.content)
				: question.content;
		const payload: HookPayload = {
			event_type: eventType,
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			issue_identifier: session.issue_identifier,
			project_name: session.project_name,
			status: isGate ? "gate_pending" : "runner_question",
			summary: fullContent,
			question_id: question.id,
			from_agent: question.from_agent,
			comm_db_path: this.opts.dbPath,
			session_role: session.session_role ?? "main",
			...(isGate ? { checkpoint: question.checkpoint ?? undefined } : {}),
		};
		if (this.opts.chatThreadsEnabled) {
			payload.chat_thread_id = resolveChatThreadId(
				this.opts.store,
				session.issue_id,
				this.opts.lead.chatChannel,
			);
		}
		const seq = this.opts.store.appendLeadEvent(
			this.opts.lead.agentId,
			eventId,
			eventType,
			JSON.stringify(payload),
			session.execution_id,
		);
		const envelope: LeadEventEnvelope = {
			seq,
			eventId,
			event: payload,
			sessionKey: session.execution_id,
			leadId: this.opts.lead.agentId,
			timestamp: row.created_at,
		};
		const runtime = this.opts.runtimeRegistry.getRawForLead(
			this.opts.lead.agentId,
		);
		const content =
			runtime?.renderEnvelope?.(envelope) ?? JSON.stringify(payload);
		this.opts.queue.materializeForDelivery({
			id: row.id,
			ownerEpoch: row.claimed_by!,
			batchId: row.batch_id!,
			sourceKind: "question",
			sourceRef: String(seq),
			deliveryContent: content,
		});
	}

	private eligibility(
		question: Message,
	): { ok: true; session: Session } | { ok: false; disposition: string } {
		if (question.superseded_at) {
			return { ok: false, disposition: "revoked_superseded" };
		}
		const session = this.opts.store.getSession(question.from_agent);
		if (!session) return { ok: false, disposition: "revoked_orphan" };
		const ownership =
			typeof this.opts.store.workflowGatePresentationDisposition === "function"
				? this.opts.store.workflowGatePresentationDisposition({
						executionId: question.from_agent,
						checkpoint: question.checkpoint,
						questionId: question.id,
					})
				: { allow: true as const, reason: "legacy" as const };
		if (!ownership.allow) {
			return {
				ok: false,
				disposition: `revoked_workflow_gate_${ownership.reason}`,
			};
		}
		if (question.checkpoint != null) {
			if (!ACTIVE_GATE_SESSION_STATUSES.has(session.status)) {
				return { ok: false, disposition: "revoked_terminal_session" };
			}
			try {
				if (!matchesLead(session, this.opts.lead.agentId, this.opts.projects)) {
					return { ok: false, disposition: "revoked_lead_scope" };
				}
			} catch {
				return { ok: false, disposition: "revoked_lead_scope" };
			}
			if (
				question.checkpoint === "approve_to_ship" &&
				reviewHoldReason(this.opts.store, session) !== null
			) {
				return { ok: false, disposition: "revoked_qa_hold" };
			}
		}
		return { ok: true, session };
	}
}
