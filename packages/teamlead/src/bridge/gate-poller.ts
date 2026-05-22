/**
 * FLY-62 / FLY-161: Question Poller — scans CommDB for pending questions
 * and relays them to the appropriate Lead via the configured LeadRuntime.
 *
 * Despite the historical name `GatePoller`, this poller surfaces **both**
 * gate_question (checkpoint != NULL) and runner_question (checkpoint == NULL).
 *
 * Routing rules:
 *  - `gate_question` (FLY-62): requires the source session to be in
 *    {running, awaiting_review, approved_to_ship} AND
 *    `matchesLead(session, lead.agentId, projects)` — i.e. the session's
 *    label-derived Lead must equal the iteration Lead. Preserves pre-FLY-161
 *    behavior where source-session label routing wins.
 *  - `runner_question` (FLY-161): routes purely by `q.to_agent` (the Lead the
 *    Runner explicitly named when running `flywheel-comm ask --lead <id>`).
 *    No active-session check, no lead-scope check — the question survives
 *    Runner completion so Annie can still answer asks from finished sessions.
 *
 * Name not changed (FLY-161 §2.5) to avoid rename diff noise; both event
 * types continue to flow through this poller.
 */

import { CommDB } from "flywheel-comm/db";
import { readContentRef } from "flywheel-comm/utils";
import type { LeadConfig, ProjectEntry } from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";
import { resolveChatThreadId } from "./chat-thread-utils.js";
import type { HookPayload } from "./hook-payload.js";
import type { LeadEventEnvelope } from "./lead-runtime.js";
import { matchesLead } from "./lead-scope.js";
import type { RuntimeRegistry } from "./runtime-registry.js";
import { defaultGetCommDbPath } from "./session-capture.js";

export interface GatePollerConfig {
	pollIntervalMs: number;
	projects: ProjectEntry[];
	store: StateStore;
	runtimeRegistry: RuntimeRegistry;
	/** FLY-91: Enable per-issue chat thread hints in gate_question payloads. */
	chatThreadsEnabled?: boolean;
}

interface PendingQuestion {
	id: string;
	from_agent: string;
	content: string;
	created_at: string;
	checkpoint: string | null;
	content_type: string;
	content_ref: string | null;
}

const ACTIVE_SESSION_STATUSES = new Set([
	"running",
	"awaiting_review",
	"approved_to_ship",
]);

export class GatePoller {
	private timerHandle: ReturnType<typeof setInterval> | null = null;
	private polling = false;

	constructor(private config: GatePollerConfig) {}

	start(): void {
		if (this.timerHandle) return;
		this.timerHandle = setInterval(
			() => this.poll(),
			this.config.pollIntervalMs,
		);
		console.log(
			`[GatePoller] Started (interval: ${this.config.pollIntervalMs}ms)`,
		);
	}

	stop(): void {
		if (this.timerHandle) {
			clearInterval(this.timerHandle);
			this.timerHandle = null;
			console.log("[GatePoller] Stopped");
		}
	}

	private async poll(): Promise<void> {
		if (this.polling) return;
		this.polling = true;
		try {
			// FLY-161: iterate (project, lead) pairs directly instead of starting
			// from getActiveSessions(). This lets runner_question survive Runner
			// completion — a question whose source session has transitioned to
			// `completed` would have been dropped by the old active-session-first
			// loop. The session is still resolved per-question below for metadata,
			// but presence in the active set is no longer a prerequisite.
			for (const project of this.config.projects) {
				for (const lead of project.leads) {
					const dbPath = defaultGetCommDbPath(project.projectName);
					try {
						const pending = this.getPendingQuestions(dbPath, lead.agentId);
						for (const question of pending) {
							const session = this.config.store.getSession(question.from_agent);
							if (!session) {
								// Orphan question — from_agent references no known session.
								// Skip rather than throw; Lead can still pick it up manually
								// via `flywheel-comm pending`. (Codex R1 Issue 1.)
								console.warn(
									`[GatePoller] orphan question — no session for from_agent=${question.from_agent} (qid=${question.id}, lead=${lead.agentId})`,
								);
								continue;
							}
							await this.relayToLead(lead, session, question, dbPath);
						}
					} catch (err) {
						console.warn(
							`[GatePoller] Error polling ${lead.agentId}:`,
							err instanceof Error ? err.message : String(err),
						);
					}
				}
			}
		} finally {
			this.polling = false;
		}
	}

	private getPendingQuestions(
		dbPath: string,
		leadId: string,
	): PendingQuestion[] {
		let db: CommDB;
		try {
			db = CommDB.openReadonly(dbPath);
		} catch {
			return []; // DB doesn't exist yet
		}
		try {
			// FLY-161: return ALL pending questions for this lead — both
			// checkpoint != null (gate_question) and checkpoint == null
			// (runner_question). Branching happens in relayToLead.
			return db.getPendingQuestions(leadId) as PendingQuestion[];
		} finally {
			db.close();
		}
	}

	private async relayToLead(
		lead: LeadConfig,
		session: Session,
		question: PendingQuestion,
		dbPath: string,
	): Promise<void> {
		const isGate = question.checkpoint != null;

		if (isGate) {
			// FLY-62 + FLY-161 R2/R3: preserve pre-FLY-161 gate_question gating.
			// (a) Active-session check: a stale gate from a completed Runner must
			//     not re-notify the Lead. Source: pre-FLY-161 behavior implicit in
			//     the old "start from getActiveSessions()" loop.
			// (b) Lead-scope check: the source session's label-derived Lead must
			//     equal the iteration Lead. Stops a checkpoint with
			//     `to_agent=product-lead` but source session labelled `ops` from
			//     reaching product-lead. Preserves the label-routing precedence
			//     that the brainstorm session decided to keep for gate.
			if (!ACTIVE_SESSION_STATUSES.has(session.status)) {
				console.warn(
					`[GatePoller] skipping gate_question qid=${question.id}: source session ${session.execution_id} status=${session.status} (not active)`,
				);
				return;
			}
			let scoped: boolean;
			try {
				scoped = matchesLead(session, lead.agentId, this.config.projects);
			} catch (err) {
				console.warn(
					`[GatePoller] skipping gate_question qid=${question.id}: lead-scope verify error for session ${session.execution_id}: ${(err as Error).message}`,
				);
				return;
			}
			if (!scoped) {
				console.warn(
					`[GatePoller] skipping gate_question qid=${question.id}: source session ${session.execution_id} resolves to a different Lead (current iteration: ${lead.agentId})`,
				);
				return;
			}
		}

		const eventId = isGate ? `gate_${question.id}` : `runner_q_${question.id}`;
		const eventType = isGate ? "gate_question" : "runner_question";

		// Check if already delivered
		if (this.config.store.isLeadEventDelivered(lead.agentId, eventId)) return;

		// Resolve content_ref if needed
		let fullContent = question.content;
		if (question.content_type === "ref" && question.content_ref) {
			fullContent = readContentRef(question.content_ref) ?? question.content;
		}

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
			comm_db_path: dbPath,
			session_role: session.session_role ?? "main",
		};
		if (isGate) {
			payload.checkpoint = question.checkpoint ?? undefined;
		}

		// FLY-91 + FLY-161: Fill chat_thread_id for Lead thread routing.
		// Both branches use `lead.chatChannel` here — for gate_question the
		// matchesLead check above guarantees source session label resolution
		// equals this iteration Lead, so label-derived chat-thread and
		// target-Lead chat-thread are equivalent. For runner_question we route
		// strictly by `to_agent` (= this iteration Lead), so the target Lead's
		// chatChannel is the correct source.
		if (this.config.chatThreadsEnabled) {
			payload.chat_thread_id = resolveChatThreadId(
				this.config.store,
				session.issue_id,
				lead.chatChannel,
			);
		}

		const seq = this.config.store.appendLeadEvent(
			lead.agentId,
			eventId,
			eventType,
			JSON.stringify(payload),
			session.execution_id,
		);

		// Deliver to Lead via the runtime (CommDB instruction or mailbox).
		const runtime = this.config.runtimeRegistry.getForLead(lead.agentId);
		if (runtime) {
			const envelope: LeadEventEnvelope = {
				seq,
				event: payload,
				sessionKey: session.execution_id,
				leadId: lead.agentId,
				timestamp: new Date().toISOString(),
			};

			const result = await runtime.deliver(envelope);

			if (result.delivered) {
				this.config.store.markLeadEventDelivered(seq);
			} else {
				this.config.store.recordDeliveryFailure(
					seq,
					result.error ?? "deliver returned false",
				);
			}
		}

		// FLY-47/FLY-77: Chat relay removed. Lead receives the event via the
		// configured LeadRuntime (CommDB instruction or mailbox) and relays to
		// Annie in chatChannel using its own Discord identity.
	}
}
