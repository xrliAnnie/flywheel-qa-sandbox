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
import {
	type InboundCursorStore,
	InMemoryInboundCursorStore,
} from "../lead-backends/codex/InboundCursorStore.js";
import type { LeadConfig, ProjectEntry } from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";
import { isQaHeld } from "./auto-qa-held.js";
import { resolveChatThreadId } from "./chat-thread-utils.js";
import {
	isDiscordSnowflake,
	parseSqliteUtcMs,
} from "./founder-notify-utils.js";
import {
	emitFounderReplyDeliveryForThread,
	type FounderReplyThreadCtx,
	type PendingQuestionForThread,
} from "./founder-reply-deliverer.js";
import { emitFounderThreadNotification } from "./founder-thread-notifier.js";
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
	/**
	 * FLY-513: optional global-codex drift probe run on the SAME poll tick (zero
	 * new periodic timer, FLY-169/172 discipline). Invoked OUTSIDE the
	 * per-project/per-lead loops, fully error-isolated; MUST be cheap and MUST
	 * NOT touch StateStore/CommDB (Codex design R2 LOW-2). Detects a global `codex`
	 * that drifted into a Lead CODEX_HOME while the Bridge is running — the churn
	 * window the boot check alone cannot cover. Absent → complete no-op.
	 */
	onHealthTick?: () => void | Promise<void>;
	/** FLY-513: cadence for `onHealthTick` in poll ticks (default 20 ≈ 60s at 3s). */
	healthCheckEveryNTicks?: number;

	// ── FLY-605: bidirectional in-thread founder relay fallback ──
	/** Global Discord bot token fallback (lead.botToken takes precedence). */
	discordBotToken?: string;
	/** Founder Discord user id (DISCORD_OWNER_USER_ID) — @mention + author match. */
	discordOwnerUserId?: string;
	/** Test seam for Discord HTTP (passed to notifier/deliverer). */
	fetchImpl?: typeof fetch;
	/** Part A grace before the in-thread fallback fires (default 10min). */
	founderThreadNotifyGraceMs?: number;
	/** Part A transient-retry TIME budget (default 45min); not a fast tick count. */
	founderThreadRetryBudgetMs?: number;
	/** Part B grace before auto-delivering a founder reply (default 10min). */
	founderReplyDeliverGraceMs?: number;
	/** Part B slow sub-cadence in poll ticks (default 20 ≈ 60s at 3s). */
	founderReplyDeliverEveryNTicks?: number;
	/** Part B thread-read cursor store (default in-memory). */
	cursorStore?: InboundCursorStore;
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
		// FLY-639: guard the timer callback so an async poll() that somehow rejects
		// can never become an unhandled rejection that exits the Bridge. poll()'s
		// internals are already wrapped (per-lead + founder-reply try/catch), this
		// is belt-and-suspenders for any scaffolding throw above those.
		this.timerHandle = setInterval(() => {
			void this.poll().catch((err) => {
				console.error(
					"[GatePoller] unexpected poll rejection (contained, Bridge stays up):",
					err instanceof Error ? err.message : String(err),
				);
			});
		}, this.config.pollIntervalMs);
		console.log(
			`[GatePoller] Started (interval: ${this.config.pollIntervalMs}ms)`,
		);
	}

	/**
	 * FLY-639: best-effort StateStore self-heal hook. A poll error may be a sql.js
	 * corruption ("no such table" / "null function …"); ask the store to rebuild
	 * itself from the last persisted image so the next lead/cycle is healthy. The
	 * store's own throttle ensures one corruption episode triggers at most one
	 * rebuild even though several leads in a tick may each land here.
	 */
	private maybeRecoverStore(err: unknown): void {
		if (typeof this.config.store.recoverFromCorruption === "function") {
			this.config.store.recoverFromCorruption(err);
		}
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

			// FLY-513: global-codex drift probe — piggybacks this same tick (zero
			// new periodic timer). Runs OUTSIDE the (project,lead) loops, fully
			// isolated (its own catch), and must not touch StateStore/CommDB. The
			// alert debounce lives in the callback's MetaAlertNotifier, so a
			// stuck-bad state pages at most once per debounce window.
			// Codex code-review R1 LOW: `(tickCount - 1) % n === 0` fires on tick 1
			// then every n — and unlike `tickCount % n === 1` it also works for n=1
			// (every tick), so a clamped/low cadence never silently disables the probe.
			if (
				this.config.onHealthTick &&
				(this.tickCount - 1) % this.healthCheckEveryNTicks() === 0
			) {
				void Promise.resolve()
					.then(() => this.config.onHealthTick?.())
					.catch((err) =>
						console.warn(
							`[GatePoller] FLY-513 codex-health probe error (non-fatal): ${(err as Error).message}`,
						),
					);
			}

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
							// FLY-579: QA-held — do NOT surface the parent's approve_to_ship
							// gate to the Lead/founder until QA is green. Skip BOTH the relay
							// and the founder-thread fallback, and do NOT evict (the question
							// must survive so it can be surfaced once QA passes; verify-approval
							// remains bound to it). Same isQaHeld predicate as event-route +
							// HeartbeatService so the three surfaces cannot drift.
							if (
								question.checkpoint === "approve_to_ship" &&
								isQaHeld(this.config.store, session)
							) {
								continue;
							}
							// FLY-605 Part A (Codex R2 #3): relayToLead and the founder-thread
							// fallback get SEPARATE try/catch so a Lead-runtime throw from the
							// relay never prevents the post-grace fallback for this question.
							try {
								await this.relayToLead(lead, session, question, dbPath);
							} catch (relayErr) {
								relayFailed = true;
								console.warn(
									`[GatePoller] relayToLead threw for ${lead.agentId} (qid=${question.id}):`,
									relayErr instanceof Error
										? relayErr.message
										: String(relayErr),
								);
								// FLY-639 (Codex code R1 HIGH): relayToLead touches StateStore (isLeadEventDelivered / appendLeadEvent / markLeadEventDelivered / recordDeliveryFailure) — self-heal on corruption (relayFailed already set keeps FLY-307 circuit semantics).
								this.maybeRecoverStore(relayErr);
							}
							try {
								await this.maybeEmitFounderThreadFallback(
									lead,
									session,
									question,
									dbPath,
								);
							} catch (fbErr) {
								console.warn(
									`[GatePoller] founder-thread fallback error for ${lead.agentId} (qid=${question.id}):`,
									fbErr instanceof Error ? fbErr.message : String(fbErr),
								);
								// FLY-639 (Codex code R1 HIGH): maybeEmitFounderThreadFallback touches StateStore (getEventsByExecution / getChatThreadByIssue / emitFounderThreadNotification) — self-heal on corruption.
								this.maybeRecoverStore(fbErr);
							}
						}
						// FLY-307 B: a clean pass closes the circuit; a relay throw counts as
						// a failure (preserves the pre-FLY-605 break-on-throw circuit semantics
						// while letting the founder-thread fallback still run — Codex R2 #3).
						if (this.circuitEnabled()) {
							if (relayFailed) this.recordCircuitFailure(leadKey);
							else this.recordCircuitSuccess(leadKey);
						}
					} catch (err) {
						relayFailed = true;
						console.warn(
							`[GatePoller] Error polling ${lead.agentId}:`,
							err instanceof Error ? err.message : String(err),
						);
						// FLY-307 B: count the failed poll even if earlier questions in
						// this iteration were delivered (no reset-on-partial-delivery).
						if (this.circuitEnabled()) this.recordCircuitFailure(leadKey);
						// FLY-639: a sql.js corruption thrown by getSession/getPendingQuestions
						// here is contained by this catch (no Bridge crash). Attempt a
						// best-effort StateStore self-heal so the next lead/cycle is healthy.
						// Complementary to the FLY-307 circuit: circuit isolates the poisoned
						// path, recover repairs the underlying store.
						this.maybeRecoverStore(err);
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
							// FLY-639 (Codex code R1 HIGH): misroutePatrol → deliverMisrouteEvent touches StateStore (isLeadEventDelivered / appendLeadEvent / markLeadEventDelivered / recordDeliveryFailure) — self-heal on corruption.
							this.maybeRecoverStore(err);
						}
					}
				}
			}

			// FLY-605 Part B: founder-reply inbound auto-delivery on a slow
			// sub-cadence (~60s). Piggybacks this tick (zero new timer); fully
			// isolated — its errors never abort the poll loop.
			if (
				this.founderReplyDeliverEnabled() &&
				this.tickCount % this.founderReplyDeliverEveryNTicks() === 1
			) {
				try {
					await this.founderReplyDeliverPass();
				} catch (err) {
					console.warn(
						"[GatePoller] founder-reply deliver pass error:",
						err instanceof Error ? err.message : String(err),
					);
					// FLY-639: this pass also touches StateStore (getSession /
					// getChatThreadByIssue / appendLeadEvent) — self-heal on corruption.
					this.maybeRecoverStore(err);
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

	// FLY-513: cadence for the optional global-codex drift probe (default 20 ≈ 60s).
	private healthCheckEveryNTicks(): number {
		return this.config.healthCheckEveryNTicks ?? DEFAULT_PATROL_EVERY_N_TICKS;
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

	// ── FLY-605 Part A: in-thread founder fallback (outbound runner→founder) ──

	/**
	 * qid → terminal (posted / permanent / skipped / retry-budget-exhausted):
	 * never notify again this process. Durable cross-restart dedup is the
	 * `founder-thread-notify-<qid>` session_events marker.
	 */
	/**
	 * FLY-605 (Codex code-review #3): in-process processed-through cursor used
	 * for Part B when no file-backed cursor is wired (e.g. commdb/rollback path).
	 * Without it, every sub-cadence would re-scan from the oldest pending question.
	 */
	private readonly defaultReplyCursor = new InMemoryInboundCursorStore();
	private readonly founderNotifyDone = new Set<string>();
	/** qid → transient-failure retry state (TIME budget, not a fast tick count). */
	private readonly founderNotifyRetry = new Map<
		string,
		{ firstFailedAtMs: number; nextAttemptAtMs: number; attempts: number }
	>();

	private founderThreadNotifyEnabled(): boolean {
		return process.env.FLYWHEEL_FOUNDER_THREAD_NOTIFY !== "0";
	}

	private founderThreadGraceMs(): number {
		return this.config.founderThreadNotifyGraceMs ?? 10 * 60_000;
	}

	private founderThreadRetryBudgetMs(): number {
		return this.config.founderThreadRetryBudgetMs ?? 45 * 60_000;
	}

	private writeFounderThreadMarker(
		question: PendingQuestion,
		session: Session,
		reason: string,
	): void {
		this.config.store.insertEvent({
			event_id: `founder-thread-notify-${question.id}`,
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			project_name: session.project_name,
			event_type: "founder_thread_notify_done",
			severity: reason === "transient_budget_exhausted" ? "warning" : "info",
			source: "bridge.gate-poller",
			payload: { questionId: question.id, reason },
		});
		this.founderNotifyDone.add(question.id);
		this.founderNotifyRetry.delete(question.id);
	}

	private async maybeEmitFounderThreadFallback(
		lead: LeadConfig,
		session: Session,
		question: PendingQuestion,
		_dbPath: string,
	): Promise<void> {
		if (!this.founderThreadNotifyEnabled()) return;
		if (!this.config.chatThreadsEnabled) return;
		const cp = question.checkpoint;
		if (cp !== "brainstorm" && cp !== "approve_to_ship") return; // v1 scope

		// Same liveness + scope gate as the gate-question relay path.
		if (!ACTIVE_SESSION_STATUSES.has(session.status)) return;
		try {
			if (!matchesLead(session, lead.agentId, this.config.projects)) return;
		} catch {
			return;
		}

		// Grace: the gate must have sat unanswered ≥ grace (= "the Lead dropped it").
		const createdMs = parseSqliteUtcMs(question.created_at);
		if (createdMs === null) return;
		const now = Date.now();
		if (now - createdMs < this.founderThreadGraceMs()) return;

		// Dedup: terminal in-process, or a durable marker survived a restart.
		if (this.founderNotifyDone.has(question.id)) return;
		const marker = `founder-thread-notify-${question.id}`;
		if (
			this.config.store
				.getEventsByExecution(session.execution_id)
				.some((e) => e.event_id === marker)
		) {
			this.founderNotifyDone.add(question.id);
			return;
		}

		// Transient backoff: respect the per-qid nextAttemptAt window.
		const retry = this.founderNotifyRetry.get(question.id);
		if (retry && now < retry.nextAttemptAtMs) return;

		const thread = this.config.store.getChatThreadByIssue(
			session.issue_id,
			lead.chatChannel,
		);
		const botToken = lead.botToken ?? this.config.discordBotToken;
		const ownerUserId = this.config.discordOwnerUserId;

		let summary = question.content;
		if (question.content_type === "ref" && question.content_ref) {
			summary = readContentRef(question.content_ref) ?? question.content;
		}

		const result = await emitFounderThreadNotification(
			{
				questionId: question.id,
				checkpoint: cp,
				executionId: session.execution_id,
				issueId: session.issue_id,
				issueIdentifier: session.issue_identifier,
				projectName: session.project_name,
				summary,
				ageMinutes: Math.round((now - createdMs) / 60_000),
				thread,
				botToken,
				ownerUserId,
			},
			{ store: this.config.store, fetchImpl: this.config.fetchImpl },
		);

		if (result.kind === "transient_failed") {
			// TIME budget (Codex R1 #4): keep retrying until the budget elapses or
			// the gate is answered (drops out of pending). Honor Retry-After.
			const prev = retry ?? {
				firstFailedAtMs: now,
				nextAttemptAtMs: now,
				attempts: 0,
			};
			const attempts = prev.attempts + 1;
			if (now - prev.firstFailedAtMs >= this.founderThreadRetryBudgetMs()) {
				this.writeFounderThreadMarker(
					question,
					session,
					"transient_budget_exhausted",
				);
				return;
			}
			const backoff = Math.min(
				result.retryAfterMs ?? 30_000 * 2 ** (attempts - 1),
				5 * 60_000,
			);
			this.founderNotifyRetry.set(question.id, {
				firstFailedAtMs: prev.firstFailedAtMs,
				nextAttemptAtMs: now + backoff,
				attempts,
			});
			return;
		}

		// posted / permanent_failed / skipped → terminal: durable marker + done.
		this.writeFounderThreadMarker(question, session, result.kind);
	}

	// ── FLY-605 Part B: founder-reply inbound delivery (founder→runner) ──

	private founderReplyDeliverEnabled(): boolean {
		return process.env.FLYWHEEL_FOUNDER_REPLY_DELIVER !== "0";
	}

	private founderReplyDeliverGraceMs(): number {
		return this.config.founderReplyDeliverGraceMs ?? 10 * 60_000;
	}

	private founderReplyDeliverEveryNTicks(): number {
		return (
			this.config.founderReplyDeliverEveryNTicks ?? DEFAULT_PATROL_EVERY_N_TICKS
		);
	}

	/**
	 * Per (project, lead): take the past-grace pending questions, group them by
	 * issue thread, and let `emitFounderReplyDeliveryForThread` read each thread
	 * once and auto-deliver / WAKE / hand off as appropriate.
	 */
	private async founderReplyDeliverPass(): Promise<void> {
		if (!this.config.chatThreadsEnabled) return;
		const ownerUserId = this.config.discordOwnerUserId;
		if (!isDiscordSnowflake(ownerUserId)) return;
		const graceMs = this.founderReplyDeliverGraceMs();
		const now = Date.now();

		for (const project of this.config.projects) {
			for (const lead of project.leads) {
				const botToken = lead.botToken ?? this.config.discordBotToken;
				if (!botToken) continue;
				const dbPath = defaultGetCommDbPath(project.projectName);

				let pending: PendingQuestion[];
				try {
					const db = CommDB.openReadonly(dbPath);
					try {
						pending = db.getPendingQuestions(lead.agentId) as PendingQuestion[];
					} finally {
						db.close();
					}
				} catch {
					continue; // CommDB not present yet
				}

				// Group past-grace pending questions by issue thread.
				const byThread = new Map<
					string,
					{ ctx: FounderReplyThreadCtx; questions: PendingQuestionForThread[] }
				>();
				for (const q of pending) {
					const createdMs = parseSqliteUtcMs(q.created_at);
					if (createdMs === null || now - createdMs < graceMs) continue;
					const session = this.config.store.getSession(q.from_agent);
					if (!session) continue;
					const thread = this.config.store.getChatThreadByIssue(
						session.issue_id,
						lead.chatChannel,
					);
					if (!thread?.thread_id) continue;
					let group = byThread.get(thread.thread_id);
					if (!group) {
						group = {
							ctx: {
								issueId: session.issue_id,
								projectName: project.projectName,
								threadId: thread.thread_id,
								botToken,
								ownerUserId: ownerUserId as string,
								graceMs,
								commDbPath: dbPath,
								leadId: lead.agentId,
							},
							questions: [],
						};
						byThread.set(thread.thread_id, group);
					}
					group.questions.push({
						questionId: q.id,
						checkpoint: q.checkpoint,
						executionId: q.from_agent,
						createdAtMs: createdMs,
					});
				}

				const deliverAmbiguousToLead = this.makeAmbiguousHandoff(
					lead,
					project.projectName,
				);
				for (const { ctx, questions } of byThread.values()) {
					try {
						await emitFounderReplyDeliveryForThread(ctx, questions, {
							store: this.config.store,
							fetchImpl: this.config.fetchImpl,
							cursorStore: this.config.cursorStore ?? this.defaultReplyCursor,
							deliverAmbiguousToLead,
						});
					} catch (err) {
						console.warn(
							`[GatePoller] founder-reply deliver error (thread=${ctx.threadId}):`,
							err instanceof Error ? err.message : String(err),
						);
						// FLY-639 (Codex code R1 HIGH): per-thread founder-reply delivery touches StateStore (isLeadEventDelivered / appendLeadEvent / markLeadEventDelivered / flush / recordDeliveryFailure) — self-heal on corruption.
						this.maybeRecoverStore(err);
					}
				}
			}
		}
	}

	/**
	 * Durable ambiguous-message handoff to the Lead via the SAME LeadRuntime path
	 * GatePoller uses for gate questions (Codex R3 #2). Returns true only when the
	 * event is durably accepted + delivered; on failure the deliverer stops the
	 * cursor before that message so the manual-relay handoff is never lost.
	 */
	private makeAmbiguousHandoff(
		lead: LeadConfig,
		projectName: string,
	): (eventId: string, payload: Record<string, unknown>) => Promise<boolean> {
		return async (eventId, payload) => {
			if (this.config.store.isLeadEventDelivered(lead.agentId, eventId)) {
				// FLY-605 (Codex code-review R2 #1): a prior pass may have set the
				// in-memory delivered mark and then had flush() throw (the deliverer
				// caught the thread error and did NOT advance the cursor that pass).
				// Re-flush here so the "already delivered in memory" short-circuit can
				// never let the cursor advance past a marker that never reached disk.
				// A flush() failure propagates → emitFounderReplyDeliveryForThread
				// throws → the per-thread catch leaves the cursor un-advanced → retry.
				this.config.store.flush();
				return true;
			}
			const issueId = String(payload.issueId ?? "");
			const answer = String(payload.answer ?? "");
			const hookPayload: HookPayload = {
				event_type: "founder_reply_ambiguous",
				execution_id: "",
				issue_id: issueId,
				project_name: projectName,
				status: "founder_reply_ambiguous",
				summary:
					"🧵 Annie 在该 issue thread 回复了，但有多个 open question、Bridge 无法确定她答的是哪个 —— " +
					`请人工 relay 给对应 runner。回复内容：${answer}`,
				chat_thread_id: String(payload.threadId ?? ""),
			};
			const seq = this.config.store.appendLeadEvent(
				lead.agentId,
				eventId,
				"founder_reply_ambiguous",
				JSON.stringify(hookPayload),
				issueId,
			);
			const runtime = this.config.runtimeRegistry.getForLead(lead.agentId);
			if (!runtime) return false;
			const result = await runtime.deliver({
				seq,
				event: hookPayload,
				sessionKey: issueId,
				leadId: lead.agentId,
				timestamp: new Date().toISOString(),
			});
			if (result.delivered) {
				this.config.store.markLeadEventDelivered(seq);
				// FLY-605 (Codex code-review #2): force the lead_events append +
				// delivered mark to disk BEFORE we return true — the deliverer
				// advances (and immediately persists) the thread cursor on success,
				// and appendLeadEvent/markLeadEventDelivered do NOT auto-save. Without
				// this flush a crash after the cursor write could drop the manual-relay
				// handoff while the cursor permanently skips the founder message.
				this.config.store.flush();
				return true;
			}
			this.config.store.recordDeliveryFailure(
				seq,
				result.error ?? "deliver returned false",
			);
			return false;
		};
	}
}
