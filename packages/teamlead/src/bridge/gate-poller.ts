/**
 * FLY-62: Gate Question Poller — scans CommDB for pending gate questions
 * and relays them to the appropriate Lead via Discord.
 */

import { CommDB } from "flywheel-comm/db";
import { readContentRef } from "flywheel-comm/utils";
import type { LeadConfig, ProjectEntry } from "../ProjectConfig.js";
import { resolveLeadForIssue } from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";
import type { HookPayload } from "./hook-payload.js";
import type { LeadEventEnvelope } from "./lead-runtime.js";
import { parseSessionLabels } from "./lead-scope.js";
import type { RuntimeRegistry } from "./runtime-registry.js";
import { defaultGetCommDbPath } from "./session-capture.js";

export interface GatePollerConfig {
	pollIntervalMs: number;
	projects: ProjectEntry[];
	store: StateStore;
	runtimeRegistry: RuntimeRegistry;
}

interface PendingGateQuestion {
	id: string;
	from_agent: string;
	content: string;
	created_at: string;
	checkpoint: string | null;
	content_type: string;
	content_ref: string | null;
}

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
			const activeSessions = this.config.store.getActiveSessions();

			// Group sessions by (project, lead) to avoid redundant CommDB queries
			const grouped = new Map<
				string,
				{
					lead: LeadConfig;
					dbPath: string;
					sessions: Session[];
				}
			>();
			for (const session of activeSessions) {
				const labels = parseSessionLabels(session);
				try {
					const { lead } = resolveLeadForIssue(
						this.config.projects,
						session.project_name,
						labels,
					);
					const key = `${session.project_name}:${lead.agentId}`;
					if (!grouped.has(key)) {
						grouped.set(key, {
							lead,
							dbPath: defaultGetCommDbPath(session.project_name),
							sessions: [],
						});
					}
					grouped.get(key)!.sessions.push(session);
				} catch {
					// No lead resolved for this session — skip
				}
			}

			for (const { lead, dbPath, sessions } of grouped.values()) {
				try {
					const pending = this.getPendingGateQuestions(dbPath, lead.agentId);
					const sessionByExecId = new Map(
						sessions.map((s) => [s.execution_id, s]),
					);
					for (const question of pending) {
						const session = sessionByExecId.get(question.from_agent);
						if (!session) continue; // orphan question
						await this.relayToLead(lead, session, question, dbPath);
					}
				} catch (err) {
					console.warn(
						`[GatePoller] Error polling ${lead.agentId}:`,
						err instanceof Error ? err.message : String(err),
					);
				}
			}
		} finally {
			this.polling = false;
		}
	}

	private getPendingGateQuestions(
		dbPath: string,
		leadId: string,
	): PendingGateQuestion[] {
		let db: CommDB;
		try {
			db = CommDB.openReadonly(dbPath);
		} catch {
			return []; // DB doesn't exist yet
		}
		try {
			return (db.getPendingQuestions(leadId) as PendingGateQuestion[]).filter(
				(q) => q.checkpoint != null,
			);
		} finally {
			db.close();
		}
	}

	private async relayToLead(
		lead: LeadConfig,
		session: Session,
		question: PendingGateQuestion,
		dbPath: string,
	): Promise<void> {
		const eventId = `gate_${question.id}`;

		// Check if already delivered
		if (this.config.store.isLeadEventDelivered(lead.agentId, eventId)) return;

		// Resolve content_ref if needed
		let fullContent = question.content;
		if (question.content_type === "ref" && question.content_ref) {
			fullContent = readContentRef(question.content_ref) ?? question.content;
		}

		const payload: HookPayload = {
			event_type: "gate_question",
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			issue_identifier: session.issue_identifier,
			project_name: session.project_name,
			status: "gate_pending",
			summary: fullContent,
			checkpoint: question.checkpoint ?? undefined,
			question_id: question.id,
			from_agent: question.from_agent,
			comm_db_path: dbPath,
			session_role: session.session_role ?? "main",
		};

		const seq = this.config.store.appendLeadEvent(
			lead.agentId,
			eventId,
			"gate_question",
			JSON.stringify(payload),
			session.execution_id,
		);

		// Post to Lead's control channel (for Claude Code consumption)
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

		// FLY-47: Chat relay removed — Lead receives gate_question via control channel
		// and relays to Annie in chatChannel using its own Discord identity.
	}
}
