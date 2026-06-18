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

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

/**
 * FLY-208 A2: minimal structural view of the agent-team transport used by the
 * misroute patrol. `ClaudeCodeAdapter` satisfies it; tests can stub it.
 * Production code must reach mailbox files through this interface only (the
 * CI grep gate forbids direct claude path-helper calls outside the transport
 * package).
 */
export interface MisrouteMailboxMessage {
	/** Vendor-stable dedupe id (`${from}:${timestamp}` for claude-code). */
	id: string;
	from: string;
	content: string;
	/** Epoch ms of the original mailbox entry. */
	ts: number;
	read: boolean;
}

export interface MisroutePatrolTransport {
	readUnread(args: {
		leadName: string;
		agentName: string;
	}): Promise<MisrouteMailboxMessage[]>;
	ack(args: {
		leadName: string;
		agentName: string;
		messageIds: string[];
	}): Promise<void>;
}

export interface GatePollerConfig {
	pollIntervalMs: number;
	projects: ProjectEntry[];
	store: StateStore;
	runtimeRegistry: RuntimeRegistry;
	/** FLY-91: Enable per-issue chat thread hints in gate_question payloads. */
	chatThreadsEnabled?: boolean;
	/**
	 * FLY-208 A2: transport for the black-hole inbox patrol. Absent (commdb /
	 * rollback mode, or wiring failure) → patrol is a complete no-op.
	 */
	transport?: MisroutePatrolTransport;
	/**
	 * FLY-208 A2: root dir for backlog JSONL archives
	 * (`<dir>/<leadId>/<aggregateId>.jsonl`). Required for the patrol — the
	 * aggregate path MUST archive before bulk-ack (mailbox read-retention
	 * pruning can delete acked originals). transport set but archiveDir
	 * missing → patrol no-op + one warning.
	 */
	misrouteArchiveDir?: string;
	/** FLY-208 A2: patrol cadence in poll ticks (default 20 ≈ 60s at 3s). */
	patrolEveryNTicks?: number;
	/** FLY-208 A2: unread count above which the aggregate path kicks in (default 10). */
	backlogThreshold?: number;
	/** FLY-307 B: consecutive per-lead poll failures before the circuit opens (default 3). */
	circuitThreshold?: number;
	/** FLY-307 B: poll ticks a lead's circuit stays open before a probe (default 20 ≈ 60s at 3s). */
	circuitCooldownTicks?: number;
	/** FLY-307 A: poll ticks before retrying a failed stale-gate eviction write (default 20). */
	evictionRetryTicks?: number;
}

/** The black-hole recipient name (stock claude-code lead convention). */
const MISROUTE_AGENT_NAME = "team-lead";
const DEFAULT_PATROL_EVERY_N_TICKS = 20;
const DEFAULT_BACKLOG_THRESHOLD = 10;
// FLY-307 B: per-lead circuit breaker defaults.
const DEFAULT_CIRCUIT_THRESHOLD = 3;
const DEFAULT_CIRCUIT_COOLDOWN_TICKS = 20;
// FLY-307 A: backoff before retrying a failed stale-gate eviction write.
const DEFAULT_EVICTION_RETRY_TICKS = 20;

const MISROUTE_HINT =
	"Reply to the Runner via `flywheel-comm send` (NOT SendMessage). " +
	"The Runner may be on a pre-FLY-208 prompt that doesn't know the report-back protocol.";

function sha16(input: string): string {
	return createHash("sha256").update(input).digest("hex").slice(0, 16);
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
			// FLY-208 A2: patrol cadence — piggybacks on this existing tick
			// (zero new periodic timers, FLY-169/172 discipline). Misrouted
			// reports are a minutes-scale human-loop event; every Nth tick
			// (default 20 ≈ 60s at the production 3s interval) is plenty.
			this.tickCount++;
			const patrolDue =
				this.misroutePatrolEnabled() &&
				this.tickCount % this.patrolEveryNTicks() === 1;

			// FLY-161: iterate (project, lead) pairs directly instead of starting
			// from getActiveSessions(). This lets runner_question survive Runner
			// completion — a question whose source session has transitioned to
			// `completed` would have been dropped by the old active-session-first
			// loop. The session is still resolved per-question below for metadata,
			// but presence in the active set is no longer a prerequisite.
			for (const project of this.config.projects) {
				for (const lead of project.leads) {
					const leadKey = `${project.projectName}::${lead.agentId}`;
					// FLY-307 B: while a lead's circuit is open, skip BOTH the
					// question-relay duty AND the misroute patrol for that lead — the
					// patrol also touches sql.js StateStore (deliverMisrouteEvent), so
					// skipping only the relay would not fully isolate a poisoned WASM
					// heap. `tickCount` still advances once per poll (above).
					if (this.circuitEnabled() && this.circuitOpen(leadKey)) {
						continue;
					}
					const dbPath = defaultGetCommDbPath(project.projectName);
					let relayFailed = false;
					try {
						const pending = this.getPendingQuestions(dbPath, lead.agentId);
						for (const question of pending) {
							// FLY-307 A: short-circuit stale gates BEFORE the sql.js
							// getSession() touch — that WASM op is the exact churn this
							// fix removes. Only gate_questions (checkpoint != null) are
							// ever evicted; runner_questions fall through untouched.
							if (question.checkpoint != null) {
								if (this.evictedGateIds.has(question.id)) continue;
								const retryAt = this.evictionRetryAt.get(question.id);
								if (retryAt !== undefined) {
									// A prior eviction write failed. Suppress until the retry
									// tick, then retry the cleanup write WITHOUT a getSession()
									// touch (we already know it's a terminal stale gate).
									if (this.tickCount < retryAt) continue;
									this.evictTerminalGateQuestion(question, dbPath);
									continue;
								}
							}
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
						// FLY-307 B: a clean pass (no throw) closes the circuit.
						if (this.circuitEnabled()) this.recordCircuitSuccess(leadKey);
					} catch (err) {
						relayFailed = true;
						console.warn(
							`[GatePoller] Error polling ${lead.agentId}:`,
							err instanceof Error ? err.message : String(err),
						);
						// FLY-307 B: count the failed poll even if earlier questions in
						// this iteration were delivered (no reset-on-partial-delivery).
						if (this.circuitEnabled()) this.recordCircuitFailure(leadKey);
					}

					// FLY-208 A2: black-hole inbox patrol — fully isolated from
					// the question-relay main duty (own try/catch; any error is
					// a warn + skip, never a poll abort). FLY-307 B: a relay failure
					// (which may have just opened the circuit) skips the patrol for
					// this lead too — the patrol also touches sql.js StateStore, so
					// running it after the failure would not isolate a poisoned heap.
					if (patrolDue && !relayFailed) {
						try {
							await this.misroutePatrol(project, lead);
						} catch (err) {
							console.warn(
								`[GatePoller] misroute patrol error for ${lead.agentId}:`,
								err instanceof Error ? err.message : String(err),
							);
						}
					}
				}
			}
		} finally {
			this.polling = false;
		}
	}

	// ── FLY-208 A2: black-hole inbox patrol ─────────────────────────────────

	private tickCount = 0;
	private warnedMissingArchiveDir = false;

	// FLY-307 A: stale gate_question eviction bookkeeping (process-local).
	// `evictedGateIds` = cleanup write succeeded → skip permanently and silently.
	// `evictionRetryAt` = cleanup write failed → suppress getSession()/warnings
	// until tickCount reaches the stored tick, then retry the write.
	private readonly evictedGateIds = new Set<string>();
	private readonly evictionRetryAt = new Map<string, number>();

	// FLY-307 B: per-lead circuit breaker keyed `projectName::agentId`.
	private readonly circuitFailures = new Map<string, number>();
	private readonly circuitCooldownUntil = new Map<string, number>();

	private patrolEveryNTicks(): number {
		return this.config.patrolEveryNTicks ?? DEFAULT_PATROL_EVERY_N_TICKS;
	}

	private backlogThreshold(): number {
		return this.config.backlogThreshold ?? DEFAULT_BACKLOG_THRESHOLD;
	}

	// ── FLY-307 A: stale gate eviction ──────────────────────────────────────

	private evictionRetryTicks(): number {
		return this.config.evictionRetryTicks ?? DEFAULT_EVICTION_RETRY_TICKS;
	}

	/**
	 * Expire a gate_question whose source session is terminal so
	 * `getPendingQuestions` (filter `expires_at > now`) stops returning it —
	 * the same primitive `gate.ts` uses for timeout cleanup (`resolveGate(qid, 0)`).
	 *
	 * Defense in depth (Codex R1 #6): refuses any `runner_question`
	 * (checkpoint == null) as its first line — `resolveGate()` itself updates any
	 * `type='question'` row by id with no checkpoint guard, and FLY-161 requires
	 * runner_questions to survive session completion. Best-effort: a failed write
	 * is recorded in `evictionRetryAt` for a low-cadence retry rather than a write
	 * storm or a permanent in-memory ignore.
	 */
	private evictTerminalGateQuestion(
		question: PendingQuestion,
		dbPath: string,
	): void {
		if (question.checkpoint == null) return; // FLY-161 boundary
		if (this.evictedGateIds.has(question.id)) return;
		try {
			const db = new CommDB(dbPath);
			try {
				db.resolveGate(question.id, 0); // 0h TTL = expire NOW
			} finally {
				db.close();
			}
			this.evictedGateIds.add(question.id);
			this.evictionRetryAt.delete(question.id);
			console.warn(
				`[GatePoller] evicting stale gate_question qid=${question.id}: source session terminal`,
			);
		} catch (err) {
			this.evictionRetryAt.set(
				question.id,
				this.tickCount + this.evictionRetryTicks(),
			);
			console.warn(
				`[GatePoller] stale gate_question qid=${question.id} eviction write failed (retry in ${this.evictionRetryTicks()} ticks):`,
				err instanceof Error ? err.message : String(err),
			);
		}
	}

	// ── FLY-307 B: per-lead circuit breaker ─────────────────────────────────

	/** ON by default; `FLYWHEEL_GATEPOLLER_CIRCUIT=0` is the explicit bypass. */
	private circuitEnabled(): boolean {
		return process.env.FLYWHEEL_GATEPOLLER_CIRCUIT !== "0";
	}

	private circuitThreshold(): number {
		return this.config.circuitThreshold ?? DEFAULT_CIRCUIT_THRESHOLD;
	}

	private circuitCooldownTicks(): number {
		return this.config.circuitCooldownTicks ?? DEFAULT_CIRCUIT_COOLDOWN_TICKS;
	}

	private circuitOpen(leadKey: string): boolean {
		const until = this.circuitCooldownUntil.get(leadKey);
		return until !== undefined && this.tickCount < until;
	}

	private recordCircuitSuccess(leadKey: string): void {
		this.circuitFailures.delete(leadKey);
		this.circuitCooldownUntil.delete(leadKey);
	}

	private recordCircuitFailure(leadKey: string): void {
		const n = (this.circuitFailures.get(leadKey) ?? 0) + 1;
		this.circuitFailures.set(leadKey, n);
		if (n >= this.circuitThreshold()) {
			this.circuitCooldownUntil.set(
				leadKey,
				this.tickCount + this.circuitCooldownTicks(),
			);
			console.warn(
				`[GatePoller] circuit OPEN for ${leadKey} after ${n} consecutive poll failures; cooling down ${this.circuitCooldownTicks()} ticks`,
			);
		}
	}

	/**
	 * Patrol is ON by default when a transport is wired; `=0` is the explicit
	 * bypass (FLY-193 default-ON precedent). Env read per-poll so tests and
	 * live ops can flip it without a restart.
	 */
	private misroutePatrolEnabled(): boolean {
		if (!this.config.transport) return false;
		if (process.env.FLYWHEEL_MISROUTE_PATROL === "0") return false;
		if (!this.config.misrouteArchiveDir) {
			if (!this.warnedMissingArchiveDir) {
				this.warnedMissingArchiveDir = true;
				console.warn(
					"[GatePoller] misroute patrol disabled: transport wired but misrouteArchiveDir missing (archive-before-ack is mandatory)",
				);
			}
			return false;
		}
		return true;
	}

	/**
	 * Scan `teams/<leadId>/inboxes/team-lead.json` for unread entries — every
	 * one of them is a misrouted message (the recipient "team-lead" does not
	 * exist in Flywheel's lead-named teams; stock SendMessage auto-created the
	 * file and reported success to the sender).
	 *
	 * Semantics (Codex R1 #1/#2/#6):
	 *  - delivery dedupe (isLeadEventDelivered) is DECOUPLED from ack retry: an
	 *    already-delivered event skips re-delivery but its message id still
	 *    joins ackCandidates — otherwise an ack failure would strand the entry
	 *    unread forever behind the dedupe early-return.
	 *  - backlog (> threshold): archive the FULL batch as JSONL BEFORE ack
	 *    (mailbox read-retention pruning may delete acked originals), then one
	 *    aggregate advisory. Aggregate eventId is content-addressed from the
	 *    sorted message dedupe ids — stable across restarts and ack retries;
	 *    the archive filename reuses it so a retry overwrites idempotently.
	 *  - ack only after the advisory was delivered (now or previously);
	 *    delivery failure → recordDeliveryFailure, no ack, retried next patrol.
	 */
	private async misroutePatrol(
		project: ProjectEntry,
		lead: LeadConfig,
	): Promise<void> {
		const transport = this.config.transport;
		const archiveRoot = this.config.misrouteArchiveDir;
		if (!transport || !archiveRoot) return;
		// A lead actually NAMED "team-lead" would make this file its real
		// inbox, not a black hole.
		if (lead.agentId === MISROUTE_AGENT_NAME) return;

		const unread = (
			await transport.readUnread({
				leadName: lead.agentId,
				agentName: MISROUTE_AGENT_NAME,
			})
		).filter((m) => !m.read);
		if (unread.length === 0) return;

		const runtime = this.config.runtimeRegistry.getForLead(lead.agentId);
		const ackCandidates: string[] = [];

		if (unread.length > this.backlogThreshold()) {
			// Aggregate path.
			const sortedIds = unread.map((m) => m.id).sort();
			const aggId = `misroute_agg_${sha16(`${lead.agentId}|${sortedIds.join("|")}`)}`;

			// Archive BEFORE any ack — deterministic filename (= aggId) so an
			// ack-retry pass overwrites instead of duplicating.
			const leadDir = join(archiveRoot, lead.agentId);
			mkdirSync(leadDir, { recursive: true });
			const archivePath = join(leadDir, `${aggId}.jsonl`);
			writeFileSync(
				archivePath,
				`${unread.map((m) => JSON.stringify(m)).join("\n")}\n`,
			);

			const tsRange = unread.map((m) => m.ts).sort((a, b) => a - b);
			const senders = [...new Set(unread.map((m) => m.from))].sort();
			const payload: HookPayload = {
				event_type: "runner_misrouted_report",
				execution_id: "misroute-backlog",
				issue_id: "unknown",
				project_name: project.projectName,
				status: "misrouted_backlog",
				summary:
					`${unread.length} misrouted runner report(s) from [${senders.join(", ")}] ` +
					`between ${new Date(tsRange[0] ?? 0).toISOString()} and ${new Date(tsRange[tsRange.length - 1] ?? 0).toISOString()} — archived, not replayed.`,
				misroute_count: unread.length,
				misroute_archive_path: archivePath,
				misroute_hint: MISROUTE_HINT,
			};
			const delivered = await this.deliverMisrouteEvent(
				lead,
				aggId,
				payload,
				runtime,
			);
			if (delivered) ackCandidates.push(...unread.map((m) => m.id));
		} else {
			// Per-message path.
			for (const m of unread) {
				const eventId = `misroute_${sha16(`${m.id}:${lead.agentId}`)}`;
				const payload: HookPayload = {
					event_type: "runner_misrouted_report",
					execution_id: m.from,
					issue_id: "unknown",
					project_name: project.projectName,
					status: "misrouted_report",
					from_agent: m.from,
					misroute_from: m.from,
					misrouted_at: new Date(m.ts).toISOString(),
					summary: m.content.slice(0, 2000),
					misroute_hint: MISROUTE_HINT,
				};
				const delivered = await this.deliverMisrouteEvent(
					lead,
					eventId,
					payload,
					runtime,
				);
				if (delivered) ackCandidates.push(m.id);
			}
		}

		if (ackCandidates.length > 0) {
			try {
				await transport.ack({
					leadName: lead.agentId,
					agentName: MISROUTE_AGENT_NAME,
					messageIds: ackCandidates,
				});
			} catch (err) {
				// Retried next patrol: the events are already delivered, so the
				// dedupe skips re-delivery but the ids re-enter ackCandidates
				// (delivered-event-still-acks rule above).
				console.warn(
					`[GatePoller] misroute ack failed for ${lead.agentId} (will retry next patrol):`,
					err instanceof Error ? err.message : String(err),
				);
			}
		}
	}

	/**
	 * Deliver one misroute advisory with the relayToLead persistence pattern.
	 * Returns true when the Lead has the event (delivered now OR on a previous
	 * patrol) — the caller acks on either (ack-retry decoupled from delivery
	 * dedupe).
	 */
	private async deliverMisrouteEvent(
		lead: LeadConfig,
		eventId: string,
		payload: HookPayload,
		runtime: ReturnType<RuntimeRegistry["getForLead"]>,
	): Promise<boolean> {
		if (this.config.store.isLeadEventDelivered(lead.agentId, eventId)) {
			return true; // previously delivered — still an ack candidate
		}
		const seq = this.config.store.appendLeadEvent(
			lead.agentId,
			eventId,
			payload.event_type,
			JSON.stringify(payload),
			payload.execution_id,
		);
		if (!runtime) return false;
		const envelope: LeadEventEnvelope = {
			seq,
			event: payload,
			sessionKey: payload.execution_id,
			leadId: lead.agentId,
			timestamp: new Date().toISOString(),
		};
		const result = await runtime.deliver(envelope);
		if (result.delivered) {
			this.config.store.markLeadEventDelivered(seq);
			return true;
		}
		this.config.store.recordDeliveryFailure(
			seq,
			result.error ?? "deliver returned false",
		);
		return false;
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
				// FLY-307 A: a gate from a terminal session can never be answered
				// (the Runner is gone, and the active-session check already withholds
				// delivery), so it would otherwise be re-polled every tick until its
				// 48h TTL. Evict it from CommDB instead of log-skipping forever.
				this.evictTerminalGateQuestion(question, dbPath);
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
