/**
 * FLY-1099 §7.2 — founder-reply watchdog: the "founder 批准静默消失零告警"
 * incident can never repeat silently.
 *
 * Detectors (durable-source driven; FLY-220 episode discipline — an in-memory
 * latch only mutes WITHIN an episode; every eventId carries a durable episode
 * salt so claims.db's permanent dedup can never swallow a NEW episode):
 *   - pass-dead: the founder-reply deliver pass hasn't completed successfully
 *     for too long (consecutive failures OR wall-clock). The HANG variant is
 *     caught by `checkHang` running in the GatePoller interval callback's
 *     OUTERMOST layer — a hung pass keeps `polling` true forever, which is
 *     exactly what the outer clock check observes (Codex R1 #5).
 *     Deliberately SILENT while FLYWHEEL_FOUNDER_REPLY_DELIVER=0 (ops chose
 *     to stop ingest — an off switch is not a failure, Codex R3 #5).
 *   - cursor-pin: a founder_reply_retry row older than the pin threshold and
 *     not dead-lettered — some founder message has been blocking its thread.
 *   - unreachable-runner (Z2): a LIVE session whose CommDB registration row is
 *     gone (FLY-1049) — wake routing broken, needs a human re-register/close.
 *   (dead-letter alerts are emitted at the SOURCE — the same transaction that
 *    dead-letters writes a durable emit_alert intent; the drain delivers it —
 *    so this watchdog does not re-detect them. emit_alert-kind failed rows are
 *    excluded from every detector input — Codex R4 #3 anti-recursion.)
 */

import type { FounderReplyRetryRow } from "../StateStore.js";
import type { DrainAlertSink } from "./founder-action-drain.js";

export function founderReplyWatchdogEnabled(
	env: Record<string, string | undefined> = process.env,
): boolean {
	return env.FLYWHEEL_FOUNDER_REPLY_WATCHDOG !== "0";
}

const PASS_DEAD_CONSECUTIVE = 5;
const PASS_DEAD_STALL_MS = 15 * 60_000;
const PIN_THRESHOLD_MS = 10 * 60_000;

export interface FounderReplyWatchdogDeps {
	store: { listFounderReplyRetries(): FounderReplyRetryRow[] };
	alertSink?: DrainAlertSink;
	/**
	 * Per-thread alert routing, refreshed by the deliver pass (threadId →
	 * lead/project/issue). Unknown thread (e.g. right after a restart, before
	 * the first pass) → infra-owner fallback.
	 */
	resolveThreadRoute(
		threadId: string,
	): { leadId: string; projectName: string; issueId?: string } | undefined;
	/** Pass-level / fallback routing — the unified infra alert owner (§7.2). */
	infraRoute(): { leadId: string; projectName: string } | undefined;
	env?: Record<string, string | undefined>;
	nowMs?: () => number;
}

interface UnreachableEntry {
	firstSeenMs: number;
	issueId: string;
	projectName: string;
	questionId: string;
	alerted: boolean;
	seenThisSweep: boolean;
}

export class FounderReplyWatchdog {
	private lastSuccessMs: number;
	private consecutiveFailures = 0;
	private firstFailMs: number | undefined;
	private passDeadLatched = false;
	private readonly pinAlerted = new Set<string>();
	private readonly unreachable = new Map<string, UnreachableEntry>();

	constructor(private readonly deps: FounderReplyWatchdogDeps) {
		// Boot baseline = "success now": a fresh Bridge gets a full stall window
		// before the pass-dead detector can fire (no restart false-positives).
		this.lastSuccessMs = deps.nowMs?.() ?? Date.now();
	}

	private env(): Record<string, string | undefined> {
		return this.deps.env ?? process.env;
	}

	notePassSuccess(nowMs: number): void {
		this.lastSuccessMs = nowMs;
		this.consecutiveFailures = 0;
		this.firstFailMs = undefined;
		// FLY-220: recovery ends the episode — the NEXT stall is a new episode
		// with a new salt and may re-alert.
		this.passDeadLatched = false;
	}

	notePassFailure(nowMs: number): void {
		this.consecutiveFailures += 1;
		this.firstFailMs ??= nowMs;
	}

	// ── Z2 sweep (diff-based episodes, driven by the zombie pass) ──

	beginUnreachableSweep(): void {
		for (const entry of this.unreachable.values()) entry.seenThisSweep = false;
	}

	noteUnreachableRunner(args: {
		executionId: string;
		issueId: string;
		projectName: string;
		questionId: string;
	}): void {
		const existing = this.unreachable.get(args.executionId);
		if (existing) {
			existing.seenThisSweep = true;
			return;
		}
		this.unreachable.set(args.executionId, {
			firstSeenMs: this.deps.nowMs?.() ?? Date.now(),
			issueId: args.issueId,
			projectName: args.projectName,
			questionId: args.questionId,
			alerted: false,
			seenThisSweep: true,
		});
	}

	endUnreachableSweep(): void {
		// A condition that cleared (re-registered / gate resolved) ends the
		// episode; a later re-detection gets a fresh firstSeenMs → fresh eventId.
		for (const [execId, entry] of this.unreachable) {
			if (!entry.seenThisSweep) this.unreachable.delete(execId);
		}
	}

	private async emit(
		route: { leadId: string; projectName: string } | undefined,
		alert: {
			eventId: string;
			eventType: string;
			title: string;
			body: string;
		},
	): Promise<void> {
		const sink = this.deps.alertSink;
		const resolved = route ?? this.deps.infraRoute();
		if (!sink || !resolved) {
			console.error(
				`[founder-reply-watchdog] ${alert.eventType} (${alert.eventId}) — no alert sink/route: ${alert.title}`,
			);
			return;
		}
		try {
			await sink.alert({
				leadId: resolved.leadId,
				projectName: resolved.projectName,
				eventId: alert.eventId,
				eventType: alert.eventType,
				title: alert.title,
				body: alert.body,
				severity: "warning",
			});
		} catch (err) {
			console.warn(
				`[founder-reply-watchdog] alert emit failed (${alert.eventId}): ${(err as Error).message}`,
			);
		}
	}

	/**
	 * The cheap pass-dead clock check — called from the GatePoller interval
	 * callback's OUTERMOST layer (BEFORE the `polling` short-circuit), so a
	 * pass hung inside poll() is still observed. Fire-and-forget.
	 */
	checkHang(nowMs: number): void {
		if (!founderReplyWatchdogEnabled(this.env())) return;
		// Ops turned ingest off → an idle pass is intentional, not dead (R3 #5).
		if (this.env().FLYWHEEL_FOUNDER_REPLY_DELIVER === "0") {
			this.passDeadLatched = false;
			return;
		}
		const dead =
			this.consecutiveFailures >= PASS_DEAD_CONSECUTIVE ||
			nowMs - this.lastSuccessMs > PASS_DEAD_STALL_MS;
		if (!dead) return;
		if (this.passDeadLatched) return; // same episode — report once
		this.passDeadLatched = true;
		const salt = this.firstFailMs ?? this.lastSuccessMs;
		void this.emit(undefined, {
			eventId: `founder-reply-pass-dead-${salt}`,
			eventType: "founder_reply_pass_dead",
			title: "Founder-reply ingest pass DEAD",
			body:
				`The founder-reply deliver pass has not completed successfully since ${new Date(this.lastSuccessMs).toISOString()} ` +
				`(${this.consecutiveFailures} consecutive failures). Founder replies (incl. ship approvals) are NOT being ingested — ` +
				"check the Bridge log for founder-reply deliver errors / a hung pass.",
		});
	}

	/** Full detector tick — piggybacked on the founder-reply sub-cadence. */
	async tick(nowMs: number): Promise<void> {
		if (!founderReplyWatchdogEnabled(this.env())) return;
		this.checkHang(nowMs);

		// ── cursor-pin detector (durable retry table) ──
		let rows: FounderReplyRetryRow[] = [];
		try {
			rows = this.deps.store.listFounderReplyRetries();
		} catch {
			return; // store hiccup — next tick
		}
		const liveKeys = new Set<string>();
		for (const row of rows) {
			if (row.dead_lettered_at) continue; // disposed — its alert fired at source
			if (nowMs - row.first_seen_ms < PIN_THRESHOLD_MS) continue;
			const key = `${row.thread_id}:${row.msg_id}:${row.first_seen_ms}`;
			liveKeys.add(key);
			if (this.pinAlerted.has(key)) continue;
			this.pinAlerted.add(key);
			const route = this.deps.resolveThreadRoute(row.thread_id);
			await this.emit(route, {
				eventId: `founder-reply-pin-${row.thread_id}-${row.msg_id}-${row.first_seen_ms}`,
				eventType: "founder_reply_pinned",
				title: `Founder reply stuck ${Math.round((nowMs - row.first_seen_ms) / 60_000)}min — ${route?.issueId ?? row.thread_id}`,
				body:
					`Founder message ${row.msg_id} in thread ${row.thread_id} has failed ${row.attempts}× ` +
					`(last stage: ${row.last_stage ?? "?"}, error: ${row.last_error ?? "?"}). ` +
					"The thread's ingest cursor is pinned behind it — every later founder reply in this thread is waiting.",
			});
		}
		// Memory hygiene: forget latch keys whose rows are gone (a NEW episode
		// gets a new first_seen_ms → a new key anyway).
		for (const key of this.pinAlerted) {
			if (!liveKeys.has(key)) this.pinAlerted.delete(key);
		}

		// ── unreachable-runner detector (Z2 sweep results) ──
		for (const [execId, entry] of this.unreachable) {
			if (entry.alerted) continue;
			entry.alerted = true;
			// Route to the infra owner (no thread anchoring here); the body carries
			// the project/issue attribution.
			await this.emit(undefined, {
				eventId: `founder-reply-unreachable-${execId}-${entry.firstSeenMs}`,
				eventType: "founder_reply_unreachable_runner",
				title: `Runner unreachable — live session, no CommDB row (${entry.issueId})`,
				body:
					`[${entry.projectName}] Session ${execId} (${entry.issueId}) is ACTIVE in StateStore but its CommDB registration row is gone — ` +
					`founder replies to its gate ${entry.questionId} cannot be wake-delivered (no_session_lead) and will dead-letter. ` +
					"Needs a human: re-register the session or close it (FLY-1049 shape).",
			});
		}
	}
}
