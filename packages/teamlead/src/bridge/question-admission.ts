/**
 * FLY-1373 question admission: raw CommDB questions are not delivery authority.
 * This pass preserves the old scope/hold checks, then materializes one durable
 * model row. Dispatch revalidation catches answers, supersession, and hold drift.
 */

import type { Message } from "flywheel-comm/db";
import { CommDB } from "flywheel-comm/db";
import type {
	LeadInboxQueue,
	LeadInboxRow,
} from "flywheel-comm/lead-inbox-queue";
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
	queue: LeadInboxQueue;
	dbPath: string;
	lead: LeadConfig;
	projects: ProjectEntry[];
	store: StateStore;
	runtimeRegistry: RuntimeRegistry;
	chatThreadsEnabled?: boolean;
	now?: () => Date;
}

export class QuestionAdmission {
	private readonly now: () => Date;
	private db?: CommDB;

	constructor(private readonly opts: QuestionAdmissionOptions) {
		this.now = opts.now ?? (() => new Date());
	}

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

	async materializePending(): Promise<number> {
		const db = this.commDb();
		let admitted = 0;
		for (const question of db.getPendingQuestions(this.opts.lead.agentId)) {
			if (this.admitQuestion(db, question)) admitted++;
		}
		return admitted;
	}

	async revalidate(
		row: LeadInboxRow,
	): Promise<{ deliver: true } | { deliver: false; disposition: string }> {
		// Only QuestionAdmission owns question revalidation. Other model lanes also
		// carry stable external references (for example a founder Discord message
		// id); interpreting those as CommDB question ids revokes a real delivery.
		if (
			!row.ref_message_id ||
			!row.source.startsWith("question:") ||
			(row.type !== "runner_question" && row.type !== "gate_question")
		) {
			return { deliver: true };
		}
		const db = this.commDb();
		const question = db.getMessageById(row.ref_message_id);
		if (!question) {
			return { deliver: false, disposition: "revoked_missing" };
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
		return eligible.ok
			? { deliver: true }
			: { deliver: false, disposition: eligible.disposition };
	}

	private admitQuestion(db: CommDB, question: Message): boolean {
		const eligible = this.eligibility(question);
		if (!eligible.ok) return false;
		const session = eligible.session;
		const isGate = question.checkpoint != null;
		const eventId = isGate ? `gate_${question.id}` : `runner_q_${question.id}`;
		const eventType = isGate ? "gate_question" : "runner_question";
		if (this.opts.store.isLeadEventDelivered(this.opts.lead.agentId, eventId)) {
			return false;
		}
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
			timestamp: this.now().toISOString(),
		};
		const runtime = this.opts.runtimeRegistry.getRawForLead(
			this.opts.lead.agentId,
		);
		const content =
			runtime?.renderEnvelope?.(envelope) ?? JSON.stringify(payload);
		this.opts.queue.enqueue({
			id: `question:${this.opts.lead.agentId}:${question.id}`,
			toLead: this.opts.lead.agentId,
			source: `question:${seq}`,
			type: eventType,
			msgClass: "model",
			priority: question.kind === "report" ? 2 : 1,
			content,
			refMessageId: question.id,
			legacyAlias: `${this.opts.lead.agentId}-${seq}-${session.execution_id}`,
			deadlineAt: question.deadline_at,
			createdAt: commTimestampToUtcIso(question.created_at),
		});
		if (!db.markQuestionProtected(question.id, String(seq))) {
			throw new Error(`question ${question.id} could not be protected`);
		}
		return true;
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

function commTimestampToUtcIso(value: string): string {
	const normalized = value.includes("T")
		? value
		: `${value.replace(" ", "T")}Z`;
	const timestamp = new Date(normalized);
	if (!Number.isFinite(timestamp.getTime())) {
		throw new Error(`invalid CommDB created_at timestamp: ${value}`);
	}
	return timestamp.toISOString();
}
