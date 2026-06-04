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
import type { AlertPayload, AlertResult } from "../LeadAlertNotifier.js";
import type { LeadConfig, ProjectEntry } from "../ProjectConfig.js";
import { resolveLeadForIssue } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import { resolveChatThreadId } from "./chat-thread-utils.js";
import type { HookPayload } from "./hook-payload.js";
import type { LeadEventEnvelope } from "./lead-runtime.js";
import { parseSessionLabels } from "./lead-scope.js";
import type { RuntimeRegistry } from "./runtime-registry.js";
import {
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

/** `FLYWHEEL_STUCK_THRESHOLD_MS` — stagnation patience (default 10 min). */
export function stuckThresholdMs(env: NodeJS.ProcessEnv = process.env): number {
	return parsePositiveIntEnv(env.FLYWHEEL_STUCK_THRESHOLD_MS, 600_000);
}

/** `FLYWHEEL_STUCK_LEAD_GRACE_MS` — Q7 fallback grace (default 5 min). */
export function stuckLeadGraceMs(env: NodeJS.ProcessEnv = process.env): number {
	return parsePositiveIntEnv(env.FLYWHEEL_STUCK_LEAD_GRACE_MS, LEAD_GRACE_MS);
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

/** Stable Annie-alert event id (Codex R1 MEDIUM-5 format). */
export function stuckUnhandledEventId(
	executionId: string,
	fingerprint: string,
): string {
	return `runner-stuck-unhandled:${executionId}:${fingerprint}`;
}

/**
 * Page Annie about an episode no Lead disposed of within the grace window.
 * Body carries NO raw pane content (same privacy posture as LeadWatchdog).
 *
 * Returns true once the notifier accepted the payload (sent, queued for
 * drain, or deduped as duplicate) — the FLY-182-hardened notifier owns
 * reliability from there. Throws/false ⇒ detector retries next poll.
 */
export function createStuckUnhandledAlerter(
	projects: ProjectEntry[],
	notifier: UnhandledAlertSink,
	log?: (msg: string) => void,
): (payload: StuckUnhandledPayload) => Promise<boolean> {
	const logFn = log ?? ((msg: string) => console.log(msg));
	return async (payload: StuckUnhandledPayload): Promise<boolean> => {
		const { session, episodeFingerprint, stuckMinutes } = payload;
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
		const result = await notifier.alert({
			leadId: lead.agentId,
			projectName: session.project_name,
			eventId: stuckUnhandledEventId(session.execution_id, episodeFingerprint),
			eventType: "runner_stuck_unhandled",
			title: `Runner stuck UNHANDLED: ${issue}`,
			body:
				`Runner for ${issue} (execution ${session.execution_id}) has had unchanged terminal output for ~${stuckMinutes} min while status=running. ` +
				`The Bridge escalated to ${lead.agentId} but no disposition receipt arrived within the grace window — the Lead may be down or stuck too. ` +
				`Check the Lead first, then the runner's tmux window. (FLY-195 Q7 fallback)`,
			severity: "warning",
			sessionKey: session.execution_id,
		});
		return (
			result.sent === true ||
			result.queued === true ||
			result.skipped === "duplicate"
		);
	};
}

// ── Detector factory ──

export interface BuildStuckDetectorOptions extends StuckEscalationWiring {
	notifier: UnhandledAlertSink;
	env?: NodeJS.ProcessEnv;
	now?: () => number;
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

	return new StuckRunnerDetector({
		capture: async () => ({
			ok: false,
			error: "no precaptured output provided (watchdog must pass capture)",
		}),
		hasPendingGate: (executionId, projectName) =>
			hasPendingGateFromCommDb(executionId, projectName),
		// Decision-time status re-read (Codex PR R1 MEDIUM-2): never escalate
		// off the watchdog's poll-start snapshot.
		refreshSession: (executionId) => opts.store.getSession(executionId),
		emit: createStuckEscalationEmitter(opts),
		getDisposition: (executionId, fingerprint) =>
			opts.store.getStuckDisposition(executionId, fingerprint),
		alertUnhandled: createStuckUnhandledAlerter(
			opts.projects,
			opts.notifier,
			log,
		),
		thresholdMs: stuckThresholdMs(env),
		graceMs: stuckLeadGraceMs(env),
		now: opts.now,
		log,
	});
}
