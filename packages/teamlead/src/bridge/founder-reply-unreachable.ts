/**
 * FLY-1099 §7.2 — founder-reply unreachable reconciliation. The
 * "founder 批准静默消失零告警" incident can never repeat silently.
 *
 * Retained detector:
 *   - unreachable-runner (Z2): a LIVE session whose CommDB registration row is
 *     gone (FLY-1049) — wake routing broken, needs a human re-register/close.
 *   (dead-letter alerts are emitted at the SOURCE — the same transaction that
 *    dead-letters writes a durable emit_alert intent; the drain delivers it —
 *    so this reconcile does not re-detect them. emit_alert-kind failed rows are
 *    excluded from every detector input — Codex R4 #3 anti-recursion.)
 */

import type { DrainAlertSink } from "./founder-action-drain.js";

export interface FounderReplyUnreachableDeps {
	alertSink?: DrainAlertSink;
	/** The unified infra alert owner (§7.2). */
	infraRoute(): { leadId: string; projectName: string } | undefined;
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

export class FounderReplyUnreachableReconcile {
	private readonly unreachable = new Map<string, UnreachableEntry>();

	constructor(private readonly deps: FounderReplyUnreachableDeps) {}

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
				`[founder-reply-unreachable] ${alert.eventType} (${alert.eventId}) — no alert sink/route: ${alert.title}`,
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
				`[founder-reply-unreachable] alert emit failed (${alert.eventId}): ${(err as Error).message}`,
			);
		}
	}

	/** Reconcile tick — piggybacked on the founder-reply sub-cadence. */
	async tick(): Promise<void> {
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
