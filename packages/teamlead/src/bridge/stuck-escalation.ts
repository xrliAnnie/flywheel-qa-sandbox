/**
 * FLY-195: Bridge wiring for the stuck-runner detector (plan §3.2 + §3.6).
 *
 * Assembles the pure detector (`StuckRunnerDetector`) with its production
 * dependencies:
 *   - `runner_stuck_escalation` emitter → owning Lead via the lead_events
 *     guardrail pipeline (same path as FLY-92 runner_idle_detected);
 *   - pending-gate predicate → CommDB unanswered questions (legitimately
 *     parked, plan §3.1.4);
 *   - Q7 fallback alerter → `runner_stuck_unhandled` Annie alert via
 *     LeadAlertNotifier (one per episode, Codex R1 MEDIUM-5);
 *   - disposition reads → StateStore `stuck_dispositions` (plan §3.4).
 *
 * The Bridge NEVER acts on the Runner from here — it detects, hands evidence
 * to the owning Lead, and pages Annie only when nobody disposed of the
 * episode. The only Bridge code that touches a stuck Runner's terminal is the
 * Lead-invoked restricted recovery-nudge endpoint (stuck-remanage-routes.ts).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { phaseMessageTag } from "flywheel-config";
import type { AlertPayload, AlertResult } from "../LeadAlertNotifier.js";
import type { LeadConfig, ProjectEntry } from "../ProjectConfig.js";
import { resolveLeadForIssue } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import { resolveChatThreadId } from "./chat-thread-utils.js";
import { isDoneButRunning as isDoneButRunningSession } from "./done-running-reconciler.js";
import { emitFounderStuckNotification } from "./founder-thread-notifier.js";
import type { HookPayload } from "./hook-payload.js";
import type { LeadEventEnvelope } from "./lead-runtime.js";
import { parseSessionLabels } from "./lead-scope.js";
import type { QuietSignals } from "./quiet-classifier.js";
import type { RuntimeRegistry } from "./runtime-registry.js";
import {
	type CommSignals,
	LEAD_GRACE_MS,
	type StuckEscalationPayload,
	StuckRunnerDetector,
	type StuckUnhandledPayload,
} from "./stuck-runner-detector.js";

// ── Env knobs (plan §3.7) ──

/** Master switch: `FLYWHEEL_STUCK_DETECT=0` disables detection entirely. */
export function stuckDetectionEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env.FLYWHEEL_STUCK_DETECT !== "0";
}

function parsePositiveIntEnv(
	raw: string | undefined,
	fallback: number,
): number {
	if (!raw) return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * FLY-253 (Codex R1 #6): like parsePositiveIntEnv but `0` is a VALID value
 * ("feature off"), not a fall-through to the default. Shared by the L1
 * activity window and the L2 latch TTL.
 */
export function parseNonNegativeIntEnv(
	raw: string | undefined,
	fallback: number,
): number {
	if (raw === undefined || raw === "") return fallback;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** `FLYWHEEL_STUCK_THRESHOLD_MS` — stagnation patience (default 10 min). */
export function stuckThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
	return parsePositiveIntEnv(env.FLYWHEEL_STUCK_THRESHOLD_MS, 600_000);
}

/** `FLYWHEEL_STUCK_LEAD_GRACE_MS` — Q7 fallback grace (default 5 min). */
export function stuckLeadGraceMs(env: NodeJS.ProcessEnv = process.env): number {
	return parsePositiveIntEnv(env.FLYWHEEL_STUCK_LEAD_GRACE_MS, LEAD_GRACE_MS);
}

/** FLY-628 default for {@link idleWatchdogPollMs} — ~1 hour. */
export const DEFAULT_IDLE_POLL_MS = 3_600_000; // ~1h

/**
 * FLY-628: `FLYWHEEL_IDLE_POLL_MS` — the RunnerIdleWatchdog poll cadence (the
 * "stall watchdog"). Band-aid (Annie, 2026-06-27): the watchdog used to capture
 * every running Runner's tmux pane every ~30s and wake the owning Lead on the
 * first waiting/idle/unknown read. For a parked / long-running Runner (a test
 * suite or a Codex review legitimately sits silent for minutes) that is a false
 * positive every cadence — each one reloads the Lead's whole context to answer,
 * burning tokens. The default is stretched to ~1h to stop the bleed.
 *
 * The same poll also drives the FLY-195 stuck detector, so genuine-stuck
 * detection is NOT removed (FLY-369) — only its cadence relaxes to ~1h
 * (worst-case ~1h to first detect, an accepted trade vs. the token waste). A
 * real smart recognizer (parked-aware / cheap probe / backoff) is the follow-up
 * rethink (FLY-626). Lives beside the stuck knobs because it is the timer that
 * drives both. Tunable without a redeploy via the env var.
 */
export function idleWatchdogPollMs(
	env: NodeJS.ProcessEnv = process.env,
): number {
	return parsePositiveIntEnv(env.FLYWHEEL_IDLE_POLL_MS, DEFAULT_IDLE_POLL_MS);
}

/**
 * FLY-253 L1: `FLYWHEEL_STUCK_COMM_ACTIVITY_MS` — how recently the runner
 * must have sent a CommDB message to be exempt from stuck candidacy.
 * Default 30 min; `0` disables the exemption (legacy behavior).
 */
export const STUCK_COMM_ACTIVITY_MS = 1_800_000;
export function stuckCommActivityMs(
	env: NodeJS.ProcessEnv = process.env,
): number {
	return parseNonNegativeIntEnv(
		env.FLYWHEEL_STUCK_COMM_ACTIVITY_MS,
		STUCK_COMM_ACTIVITY_MS,
	);
}

/**
 * FLY-253 L2: `FLYWHEEL_STUCK_LATCH_TTL_MS` — server-side TTL written into
 * execution-scoped `legitimate_wait` / `needs_founder` latches (as
 * `snooze_until_ms`). Default 72h; `0` = permanent latch (no expiry).
 * Parsed ONCE at the plugin/config layer and injected into the remanage
 * router as `latchTtlMs` (Codex R2 #5).
 */
export const STUCK_LATCH_TTL_MS = 259_200_000; // 72h
export function stuckLatchTtlMs(env: NodeJS.ProcessEnv = process.env): number {
	return parseNonNegativeIntEnv(
		env.FLYWHEEL_STUCK_LATCH_TTL_MS,
		STUCK_LATCH_TTL_MS,
	);
}

// ── Pending-gate predicate (plan §3.1.4 hard gate 2) ──

/**
 * True when the runner has an unanswered CommDB question (blocking gate,
 * `gate --no-block` parked review question, or `flywheel-comm ask`) — a
 * legitimately parked runner, never a stuck candidate.
 *
 * Missing comm.db ⇒ no questions ⇒ false. Real DB errors THROW so the
 * detector's fail-closed handling treats the session as parked.
 */
export function hasPendingGateFromCommDb(
	executionId: string,
	projectName: string,
): boolean {
	// Path traversal guard (same as tmux-lookup.ts / session-capture.ts).
	if (/[/\\]|\.\./.test(projectName)) return false;
	const dbPath = join(homedir(), ".flywheel", "comm", projectName, "comm.db");
	if (!existsSync(dbPath)) return false;

	let db: CommDB | undefined;
	try {
		db = CommDB.openReadonly(dbPath);
		return db.hasPendingQuestionsFrom(executionId);
	} finally {
		db?.close();
	}
}

/**
 * FLY-818 (Codex code review R1 #2): true if this execution has an unanswered
 * BLOCKING gate/question (`checkpoint IS NOT NULL`) — NOT a non-blocking
 * `flywheel-comm ask`. The auto-continue armer uses this so a runner that fired a
 * non-blocking ask still gets armed to self-continue (an ask must not stop the
 * loop). Mirrors {@link hasPendingGateFromCommDb} but with the checkpoint filter.
 */
export function hasPendingBlockingGateFromCommDb(
	executionId: string,
	projectName: string,
): boolean {
	if (/[/\\]|\.\./.test(projectName)) return false;
	const dbPath = join(homedir(), ".flywheel", "comm", projectName, "comm.db");
	if (!existsSync(dbPath)) return false;

	let db: CommDB | undefined;
	try {
		db = CommDB.openReadonly(dbPath);
		return db.hasPendingBlockingGateFrom(executionId);
	} finally {
		db?.close();
	}
}

/**
 * FLY-253: combined CommDB probe — BOTH liveness signals from ONE readonly
 * open per session per poll (Codex R1 #6: CommDB.db is private, so the
 * second query lives in a public CommDB method, not raw SQL here).
 *
 *   - hasPendingGate: unanswered question ⇒ legitimately parked (gate 2).
 *   - hasRecentOutbound: any message from this exec within the activity
 *     window ⇒ alive (gate 2.5, L1). `activityWindowMs = 0` SHORT-CIRCUITS
 *     to hard false BEFORE the query (Codex R2 #5: "off" must never depend
 *     on a query result). Window comparison happens entirely inside
 *     SQLite's UTC clock domain (CommDB.hasRecentMessagesFrom).
 *
 * Missing comm.db ⇒ both false (no questions, no activity). Real DB errors
 * THROW so the detector's fail-closed handling treats the session as parked.
 */
export function probeCommSignalsFromCommDb(
	executionId: string,
	projectName: string,
	activityWindowMs: number,
): CommSignals {
	// Path traversal guard (same as hasPendingGateFromCommDb).
	if (/[/\\]|\.\./.test(projectName)) {
		return { hasPendingGate: false, hasRecentOutbound: false };
	}
	const dbPath = join(homedir(), ".flywheel", "comm", projectName, "comm.db");
	if (!existsSync(dbPath)) {
		return { hasPendingGate: false, hasRecentOutbound: false };
	}

	let db: CommDB | undefined;
	try {
		db = CommDB.openReadonly(dbPath);
		const hasPendingGate = db.hasPendingQuestionsFrom(executionId);
		const hasRecentOutbound =
			activityWindowMs > 0 &&
			db.hasRecentMessagesFrom(executionId, Math.ceil(activityWindowMs / 1000));
		return { hasPendingGate, hasRecentOutbound };
	} finally {
		db?.close();
	}
}

/**
 * FLY-626: read the runner's CURRENTLY-EFFECTIVE self-declared marker kind
 * (`parked` / `long_task`) from CommDB, or null. Readonly + missing-table
 * tolerant (CommDB.getEffectiveDeclaredState). Missing comm.db ⇒ null.
 */
export function probeDeclaredStateFromCommDb(
	executionId: string,
	projectName: string,
	nowMs: number,
): "parked" | "long_task" | null {
	if (/[/\\]|\.\./.test(projectName)) return null;
	const dbPath = join(homedir(), ".flywheel", "comm", projectName, "comm.db");
	if (!existsSync(dbPath)) return null;
	let db: CommDB | undefined;
	try {
		db = CommDB.openReadonly(dbPath);
		return db.getEffectiveDeclaredState(executionId, nowMs)?.kind ?? null;
	} finally {
		db?.close();
	}
}

/**
 * FLY-626: build the cheap, stateless {@link QuietSignals} for a session — ONE
 * readonly comm.db probe per session (gate + recent-comm) plus the declared
 * marker. Used by the stall watchdogs to consult `classifyQuiet` BEFORE a
 * token-expensive Lead wake. `hasPendingReviewSignal` is left to the caller
 * (default false): the watchdogs only poll `running` sessions, and the
 * awaiting_review/approved_to_ship review-park is already covered by the
 * status check inside `classifyQuiet`.
 */
export function probeQuietSignals(
	session: {
		execution_id: string;
		project_name: string;
		status: string;
		// FLY-637 #1: fields the shared `isDoneButRunning` predicate reads. The
		// stall watchdogs already pass the full Session row, so these are present
		// in production; optional here so callers/tests can omit them (⇒ false).
		session_stage?: string | null;
		decision_route?: string | null;
		pr_number?: number | null;
	},
	opts: { activityWindowMs: number; nowMs: number },
): QuietSignals {
	const { execution_id, project_name, status } = session;
	const comm = probeCommSignalsFromCommDb(
		execution_id,
		project_name,
		opts.activityWindowMs,
	);
	const declaredKind = probeDeclaredStateFromCommDb(
		execution_id,
		project_name,
		opts.nowMs,
	);
	return {
		status,
		hasPendingGate: comm.hasPendingGate,
		hasRecentComm: comm.hasRecentOutbound,
		hasPendingReviewSignal: false,
		declaredKind,
		// FLY-637 #1: explicit FLY-324 done-but-running skip, via the shared
		// predicate (status=running & stage=completed & no route & no PR).
		isDoneButRunning: isDoneButRunningSession({
			status: session.status,
			session_stage: session.session_stage,
			decision_route: session.decision_route,
			pr_number: session.pr_number,
		}),
	};
}

// ── Escalation emitter (plan §3.2) ──

export interface StuckEscalationWiring {
	store: StateStore;
	projects: ProjectEntry[];
	runtimeRegistry: RuntimeRegistry;
	chatThreadsEnabled?: boolean;
	log?: (msg: string) => void;
}

/** Stable per-episode event id (Codex R1 LOW-7: episode-scoped, not too coarse). */
export function stuckEscalationEventId(
	executionId: string,
	fingerprint: string,
	episodeStartedAt: number,
): string {
	return `stuck_${executionId}_${fingerprint}_${episodeStartedAt}`;
}

/**
 * Emit a `runner_stuck_escalation` to the owning Lead. Mirrors the FLY-92
 * `runner_idle_detected` path: persist to lead_events first (guardrail retry
 * owns redelivery), then best-effort immediate delivery.
 *
 * Returns true once the event row is persisted; false when no owning Lead
 * resolves (detector rolls back + retries — config may be fixed later).
 */
export function createStuckEscalationEmitter(
	wiring: StuckEscalationWiring,
): (payload: StuckEscalationPayload) => Promise<boolean> {
	const log = wiring.log ?? ((msg: string) => console.log(msg));
	return async (payload: StuckEscalationPayload): Promise<boolean> => {
		const { session, evidence, episodeFingerprint, episodeStartedAt } = payload;
		const labels = parseSessionLabels(session);
		let lead: LeadConfig;
		try {
			({ lead } = resolveLeadForIssue(
				wiring.projects,
				session.project_name,
				labels,
			));
		} catch {
			return false;
		}

		const eventId = stuckEscalationEventId(
			session.execution_id,
			episodeFingerprint,
			episodeStartedAt,
		);
		if (wiring.store.isLeadEventDelivered(lead.agentId, eventId)) return true;

		const event: HookPayload = {
			event_type: "runner_stuck_escalation",
			execution_id: session.execution_id,
			issue_id: session.issue_id,
			issue_identifier: session.issue_identifier,
			project_name: session.project_name,
			status: session.status,
			session_role: session.session_role ?? "main",
			summary: `Runner output unchanged for ${evidence.stuck_minutes} min while status=running — candidate STUCK. Judge and re-manage (you decide; this is not a verdict).`,
			stuck_minutes: evidence.stuck_minutes,
			episode_fingerprint: episodeFingerprint,
			terminal_tail: evidence.tail,
			stream_error_signature: evidence.stream_error_signature,
			input_box_present: evidence.input_box_present,
			// FLY-1048 (A3): surface the signature KIND so the Lead sees WHAT is
			// looping (enoent_loop / not_logged_in / …), not just "stuck".
			error_signature: evidence.errorSignature,
			stage_context:
				"FLY-195 stuck-runner escalation: capture the terminal (runner_terminal_capture) and judge. " +
				"If genuinely stuck: ladder = mailbox wake first, wait, re-capture; still frozen at the input box → " +
				`POST /api/sessions/${session.execution_id}/recovery-nudge with this episode_fingerprint. ` +
				"If it is actually working/legitimately waiting: " +
				`POST /api/sessions/${session.execution_id}/stuck-disposition (false_positive | legitimate_wait | snooze | needs_founder). ` +
				"Restart/kill/ship stay founder-gated (FLY-175). See stuck-runner-remanage rules.",
		};
		if (wiring.chatThreadsEnabled) {
			event.chat_thread_id = resolveChatThreadId(
				wiring.store,
				session.issue_id,
				lead.chatChannel,
			);
		}

		const seq = wiring.store.appendLeadEvent(
			lead.agentId,
			eventId,
			"runner_stuck_escalation",
			JSON.stringify(event),
			session.execution_id,
		);

		// Persisted — guardrail retry (RETRYABLE_LEAD_EVENT_TYPES) owns redelivery.
		const runtime = wiring.runtimeRegistry.getForLead(lead.agentId);
		if (runtime) {
			const envelope: LeadEventEnvelope = {
				seq,
				event,
				sessionKey: session.execution_id,
				leadId: lead.agentId,
				timestamp: new Date().toISOString(),
			};
			const result = await runtime.deliver(envelope);
			if (result.delivered) {
				wiring.store.markLeadEventDelivered(seq);
			} else {
				wiring.store.recordDeliveryFailure(
					seq,
					result.error ?? "deliver returned false",
				);
			}
		}

		log(
			`[StuckEscalation] Emitted runner_stuck_escalation for ${session.execution_id} (episode ${episodeFingerprint}, ${evidence.stuck_minutes} min) → ${lead.agentId}`,
		);
		return true;
	};
}

// ── Q7 fallback alerter (plan §3.6) ──

/** Minimal LeadAlertNotifier surface the alerter needs (test-injectable). */
export interface UnhandledAlertSink {
	alert(payload: AlertPayload): Promise<AlertResult>;
}

/**
 * Stable Annie-alert event id (Codex R1 MEDIUM-5 format).
 *
 * FLY-253 (Codex R2 #3): `escalatedAt` is the GENERATION salt. The claims.db
 * and lead_events dedups are persistent, so a fingerprint-only id would
 * silently swallow a legitimate second Q7 for the same frozen frame after a
 * re-arm / TTL reminder cycle (the notifier reports duplicates as resolved
 * and the detector would mark annieAlerted). Granularity shift is
 * documented in the plan §6: per-generation paging is only reachable when
 * the Lead never wrote any disposition.
 */
export function stuckUnhandledEventId(
	executionId: string,
	fingerprint: string,
	escalatedAt: number,
): string {
	return `runner-stuck-unhandled:${executionId}:${fingerprint}:${escalatedAt}`;
}

/**
 * FLY-818 M3 founder page gate. Default ON with a kill-switch
 * (`FLYWHEEL_STUCK_FOUNDER_PAGE=0` disables) — flywheel-eng-lead's call (my ask
 * dd4bee23): a genuinely-stuck runner reaching the founder is FLY-818's CORE ask,
 * so a safety net that ships default-off "isn't done"; it only fires in the true-
 * stuck edge case (rare) and matches Annie's default-enable principle. The founder
 * page still additionally requires an owner id + store (see the alerter) — a
 * deployment without those degrades to the legacy byte-compat path, so default-on
 * never retry-storms an unconfigured Bridge. (Distinct from the ① autocontinue
 * half, which stays default-OFF via `FLYWHEEL_RUNNER_AUTOCONTINUE`.)
 */
export function stuckFounderPageEnabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return env.FLYWHEEL_STUCK_FOUNDER_PAGE !== "0";
}

/** Optional deps enabling the FLY-818 M3 issue-thread founder page. */
export interface StuckUnhandledAlerterOpts {
	/** Required for the founder page (ledger + chat-thread resolution). */
	store?: StateStore;
	/** Fallback bot token when the owning Lead has none (config.discordBotToken). */
	discordBotToken?: string;
	/** config.discordOwnerUserId — the founder to @-mention. No owner ⇒ no page. */
	discordOwnerUserId?: string;
	/** Discord POST seam (tests). */
	fetchImpl?: typeof fetch;
	env?: NodeJS.ProcessEnv;
	log?: (msg: string) => void;
}

/**
 * Page Annie about an episode no Lead disposed of within the grace window.
 * Body carries NO raw pane content (same privacy posture as LeadWatchdog).
 *
 * FLY-818 M3 (Annie's design — lead-instruction 7bb06c0f/0807c747): default-ON
 * (kill-switch `FLYWHEEL_STUCK_FOUNDER_PAGE=0`) and, with an owner id + store
 * configured, the founder is paged by an @founder message posted into the STUCK
 * RUNNER'S OWN [FLY-XX] issue chat_thread — NOT a DM, NOT the FLY-368 alert channel
 * (the rejected FLY-523 path). Reuses the FLY-605 issue-thread push
 * (`emitFounderStuckNotification`) with the owning Lead's bot. `annieAlerted` is
 * gated on a GENUINE posted page (Codex R2#2): only a confirmed post resolves the
 * episode; anything else (no thread yet, config gap, post failure) returns false so
 * the StuckDetector retries (at-least-once), and the durable `founder_page_ledger`
 * converges so a later duplicate never re-pages. Founder page disabled (kill-switch
 * / no owner / no store) ⇒ the pre-M3 semantics (`sent||queued||duplicate`) so those
 * deployments stay byte-identical.
 */
export function createStuckUnhandledAlerter(
	projects: ProjectEntry[],
	notifier: UnhandledAlertSink,
	opts: StuckUnhandledAlerterOpts = {},
): (payload: StuckUnhandledPayload) => Promise<boolean> {
	const logFn = opts.log ?? ((msg: string) => console.log(msg));
	const env = opts.env ?? process.env;
	return async (payload: StuckUnhandledPayload): Promise<boolean> => {
		const { session, episodeFingerprint, stuckMinutes, escalatedAt } = payload;
		const labels = parseSessionLabels(session);
		let lead: LeadConfig;
		try {
			({ lead } = resolveLeadForIssue(projects, session.project_name, labels));
		} catch (err) {
			logFn(
				`[StuckEscalation] cannot resolve owning Lead for unhandled alert (${session.execution_id}): ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			return false;
		}

		const issue = session.issue_identifier ?? session.issue_id;
		const eventId = stuckUnhandledEventId(
			session.execution_id,
			episodeFingerprint,
			escalatedAt,
		);
		// FLY-927 (W-B): a 529-stalled runner is its OWN ticket kind — the owner
		// bot ARCs it (same runnerStuck metadata contract as the generic stall).
		// A healthy 529 (still retrying) never reaches here (detector-side gate).
		const throttleStalled = payload.throttleStalled === true;
		const result = await notifier.alert({
			leadId: lead.agentId,
			projectName: session.project_name,
			eventId,
			eventType: throttleStalled
				? "runner_throttle_stalled"
				: "runner_stuck_unhandled",
			title: throttleStalled
				? `Runner stalled after throttle (529): ${issue}`
				: `Runner stuck UNHANDLED: ${issue}`,
			// FLY-253 §3.3 honesty fix: "may be down or stuck too" was a lie when
			// the Lead was merely busy for 5 minutes (LEARN-57: Asha had disposed
			// the previous episode 27s after its escalation).
			body: throttleStalled
				? `Runner for ${issue} (execution ${session.execution_id}) STALLED after a 529/overloaded throttle — terminal unchanged ~${stuckMinutes} min with throttle residue and NO live retry. ` +
					`The Bridge escalated to ${lead.agentId} but no disposition receipt arrived within the grace window. Auto-repair attempts the audited continue-nudge first. (FLY-927 W-B)`
				: `Runner for ${issue} (execution ${session.execution_id}) has had unchanged terminal output for ~${stuckMinutes} min while status=running. ` +
					`The Bridge escalated to ${lead.agentId} but no disposition receipt arrived within the grace window — the Lead may be busy, down, or stuck. ` +
					`Check the Lead first, then the runner's tmux window. (FLY-195 Q7 fallback)`,
			severity: "warning",
			sessionKey: session.execution_id,
			// FLY-368: structured fingerprint so the auto-repair bot can reuse the
			// runner recovery-nudge gates WITHOUT parsing it out of eventId (Codex
			// R1 HIGH-2). formatContent ignores metadata → Discord text unchanged.
			metadata: {
				runnerStuck: {
					executionId: session.execution_id,
					episodeFingerprint,
					escalatedAt,
				},
			},
		});

		// Legacy (pre-M3) resolution: the FLY-182-hardened notifier owns reliability
		// once it accepts the payload (sent, queued for drain, or deduped).
		const legacyResolved =
			result.sent === true ||
			result.queued === true ||
			result.skipped === "duplicate";

		// FLY-927 (Task 2.4, explicit behavior change — in Annie's morning brief):
		// with the ticket queue ON, the IMMEDIATE founder page is replaced by the
		// T2 "couldn't fix" page — the reconcile escalation pass pages the issue
		// thread only after 2 ARC attempts / 5 minutes without recovery. Fewer,
		// more accurate @Annie pings. FLYWHEEL_ALERT_TICKETS unset ⇒ the Q7
		// immediate page below, exactly as today.
		if (env.FLYWHEEL_ALERT_TICKETS === "1") {
			return legacyResolved;
		}

		// FLY-818 M3 issue-thread founder page. Disabled (kill-switch / no owner / no
		// store) ⇒ byte-identical legacy semantics. Gated on an owner id so a
		// default-on-but-unconfigured deployment degrades to legacy instead of
		// retry-storming on a structural config gap.
		if (
			!stuckFounderPageEnabled(env) ||
			!opts.store ||
			!opts.discordOwnerUserId
		) {
			return legacyResolved;
		}
		const store = opts.store;

		// Durable converge (Q3): this episode was already REALLY paged → resolve,
		// never re-page that thread (no spam).
		if (store.getFounderPaged(eventId) === true) return true;

		const thread = store.getChatThreadByIssue(
			session.issue_id,
			lead.chatChannel,
		);
		const outcome = await emitFounderStuckNotification(
			{
				executionId: session.execution_id,
				issueId: session.issue_id,
				issueIdentifier: session.issue_identifier ?? undefined,
				projectName: session.project_name,
				leadAgentId: lead.agentId,
				stuckMinutes,
				thread,
				botToken: lead.botToken ?? opts.discordBotToken,
				ownerUserId: opts.discordOwnerUserId,
				// FLY-892 (Step 3): tag which phase session is stuck; "" for main.
				phasePrefix: phaseMessageTag(
					session.chat_thread_role,
					session.runner_model,
				),
			},
			{ store, fetchImpl: opts.fetchImpl },
		);
		const paged = outcome.kind === "posted";
		store.recordFounderPaged(eventId, paged);
		if (!paged) {
			// Ops-visible: a genuinely-stuck runner could NOT reach the founder in its
			// issue thread. `no_chat_thread` is transient (the thread may appear
			// later); config gaps (no_bot_token/bad_owner_id) + post failures stay
			// loud rather than silently marking the episode handled. The detector
			// retries next poll (at-least-once) — the ledger stays false.
			logFn(
				`[StuckEscalation] M3 founder page NOT delivered for ${eventId} (kind=${outcome.kind}${
					outcome.skipReason ? `/${outcome.skipReason}` : ""
				}) — detector will retry`,
			);
		}
		return paged;
	};
}

// ── Detector factory ──

export interface BuildStuckDetectorOptions extends StuckEscalationWiring {
	notifier: UnhandledAlertSink;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
	/** FLY-818 M3 founder page: fallback bot token (config.discordBotToken). */
	discordBotToken?: string;
	/** FLY-818 M3 founder page: the founder to @-mention (config.discordOwnerUserId). */
	discordOwnerUserId?: string;
	/** FLY-818 M3 founder page: Discord POST seam (tests). */
	fetchImpl?: typeof fetch;
}

/**
 * Assemble the production StuckRunnerDetector. Returns null when disabled via
 * `FLYWHEEL_STUCK_DETECT=0` (plan §3.7 rollback switch).
 *
 * The `capture` dep is a fail-closed stub: in production the caller
 * (RunnerIdleWatchdog) always passes its own pre-captured outcome to
 * `checkSession`, so a blind second capture is never taken.
 */
export function buildStuckRunnerDetector(
	opts: BuildStuckDetectorOptions,
): StuckRunnerDetector | null {
	const env = opts.env ?? process.env;
	if (!stuckDetectionEnabled(env)) return null;
	const log = opts.log ?? ((msg: string) => console.log(msg));

	const activityWindowMs = stuckCommActivityMs(env);
	return new StuckRunnerDetector({
		capture: async () => ({
			ok: false,
			error: "no precaptured output provided (watchdog must pass capture)",
		}),
		// FLY-253 L1: both CommDB signals from one readonly open per session.
		probeCommSignals: (executionId, projectName) =>
			probeCommSignalsFromCommDb(executionId, projectName, activityWindowMs),
		// Decision-time status re-read (Codex PR R1 MEDIUM-2): never escalate
		// off the watchdog's poll-start snapshot.
		refreshSession: (executionId) => opts.store.getSession(executionId),
		emit: createStuckEscalationEmitter(opts),
		// FLY-253 L2: exact + execution-sentinel rows; precedence in detector.
		getDispositionRows: (executionId, fingerprint) =>
			opts.store.getStuckDispositionRows(executionId, fingerprint),
		consumeExpiredDispositions: (executionId, fingerprint, nowMs) =>
			opts.store.consumeExpiredStuckDispositions(
				executionId,
				fingerprint,
				nowMs,
			),
		// FLY-1048 PR-C (C4a): while the unified detection-escalation flow owns
		// an active episode for this exact (execId, fingerprint), the old
		// emitters (Lead escalation + Q7 fallback) stand down — the unified
		// ~30min reconcile owns Lead + founder paging. Env read at CALL time
		// (process.env is live) so a flag flip applies without a rebuild;
		// unset ⇒ constant false ⇒ pre-PR-C behavior byte-for-byte.
		// A CLEARING target is unified-owned as a WHOLE (Codex code R1 #6):
		// teardown churn mints new pane fingerprints every frame, so an
		// exact-fingerprint check alone would let the old flow page about a
		// half-torn-down corpse the unified flow deliberately muted.
		unifiedOwnsEpisode: (executionId, fingerprint) =>
			opts.store.hasActiveDetectionEscalationForEpisode(
				executionId,
				fingerprint,
			) || opts.store.hasClearingDetectionEscalationForTarget(executionId),
		alertUnhandled: createStuckUnhandledAlerter(opts.projects, opts.notifier, {
			store: opts.store,
			discordBotToken: opts.discordBotToken,
			discordOwnerUserId: opts.discordOwnerUserId,
			fetchImpl: opts.fetchImpl,
			env,
			log,
		}),
		thresholdMs: stuckThresholdMs(env),
		graceMs: stuckLeadGraceMs(env),
		now: opts.now,
		log,
	});
}
