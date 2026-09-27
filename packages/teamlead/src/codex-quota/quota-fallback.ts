/**
 * FLY-2900 §5 — fallback bodies for parked Codex quota standby executions.
 *
 *  - Codex new body: two non-quota relaunch failures under one permit.
 *  - Claude new body (`codex_quota_claude_fallback`): every registered Codex
 *    account has a fresh, identity-matched reading with a 100 % window, the
 *    earliest recovery is more than 30 minutes away, the same-vendor review
 *    rule allows it and the Claude model is available.
 *  - Waiting long is never a fallback trigger: after 12 hours the Lead hears.
 *
 * A dirty worktree is committed locally first (wip-checkpoint), then the
 * two-phase prepare allocates the new execution; the engine launches it and
 * phase two rides that launch commit.
 */

import { randomUUID } from "node:crypto";
import type { StateStore } from "../StateStore.js";
import type { CodexAccountQuotaStore } from "./codex-account-quota-store.js";
import type { CodexQuotaResumeLoopContext } from "./resume-loop.js";
import type { WipCheckpointResult } from "./wip-checkpoint.js";

/** §5.1: readings older than this cannot prove a walled pool. */
export const CODEX_POOL_READING_FRESH_MS = 20 * 60_000;
/** §5.1 / Lead Q1①: hand to Claude only when recovery is further than this. */
export const CODEX_CLAUDE_FALLBACK_MIN_WAIT_MS = 30 * 60_000;
/** §5.1 ③: a parked body this old without a permit pages the Lead once. */
export const CODEX_STANDBY_OVERDUE_MS = 12 * 60 * 60_000;

export interface CodexPoolMember {
	profile: string;
	accountKey: string;
}

export type CodexPoolExhaustion =
	| { exhausted: true; earliestResetMs: number; evidenceRef: string }
	| { exhausted: false; reason: string };

/**
 * §5.1 pure function (the account page shows the same verdict): walled only
 * when every registered account's fresh, identity-matched reading has a 100 %
 * window; the earliest recovery is the minimum over accounts of the latest
 * reset among their 100 % windows. Any unknown reset is not a verdict.
 */
export function evaluatePoolExhaustionFromReadings(
	readings: CodexAccountQuotaStore | null,
	pool: readonly CodexPoolMember[],
	nowMs: number,
): CodexPoolExhaustion {
	if (!readings) return { exhausted: false, reason: "readings_missing" };
	if (pool.length === 0) return { exhausted: false, reason: "pool_empty" };
	let earliest = Number.POSITIVE_INFINITY;
	const parts: string[] = [];
	for (const member of pool) {
		const reading = readings.accounts.find((a) => a.name === member.profile);
		if (!reading || reading.identityKey !== member.accountKey)
			return {
				exhausted: false,
				reason: `identity_unproven:${member.profile}`,
			};
		const observedMs =
			reading.observedAt === null ? Number.NaN : Date.parse(reading.observedAt);
		if (
			!Number.isFinite(observedMs) ||
			nowMs - observedMs > CODEX_POOL_READING_FRESH_MS ||
			observedMs > nowMs + 60_000
		)
			return { exhausted: false, reason: `reading_stale:${member.profile}` };
		const walled = [reading.fiveH, reading.weekly].filter(
			(window) => window?.usedPercent === 100,
		);
		if (walled.length === 0)
			return { exhausted: false, reason: `capacity_left:${member.profile}` };
		let latest = Number.NEGATIVE_INFINITY;
		for (const window of walled) {
			const resetMs =
				window?.resetAt == null ? Number.NaN : Date.parse(window.resetAt);
			if (!Number.isFinite(resetMs))
				return { exhausted: false, reason: `reset_unknown:${member.profile}` };
			latest = Math.max(latest, resetMs);
		}
		earliest = Math.min(earliest, latest);
		parts.push(`${member.profile}@${reading.observedAt}`);
	}
	return {
		exhausted: true,
		earliestResetMs: earliest,
		evidenceRef: `readings:${parts.sort().join(",")}`.slice(0, 480),
	};
}

export interface CodexQuotaFallbackDeps {
	store: StateStore;
	claudeFallbackEnabled(): boolean;
	/** Registered Codex accounts (profile + identity), or throws. */
	pool(): readonly CodexPoolMember[];
	/** The Claude dispatch a fallback body gets, or null when unavailable. */
	claudeDispatch(): { model: string; effort: string } | null;
	/** Commit the parked worktree through the fenced checkpoint transaction. */
	checkpoint(input: {
		executionId: string;
		entrySeq: number;
		worktree: string;
		issueId: string;
	}): WipCheckpointResult;
	now?: () => number;
	newExecutionId?: () => string;
	warn?: (message: string, detail: string) => void;
}

export function createCodexQuotaFallbackEvaluator(
	deps: CodexQuotaFallbackDeps,
): { tick(context: CodexQuotaResumeLoopContext): Promise<void> } {
	const now = deps.now ?? Date.now;
	const iso = () => new Date(now()).toISOString();
	const newExecutionId = deps.newExecutionId ?? (() => randomUUID());
	const warn =
		deps.warn ?? ((message, detail) => console.warn(message, detail));
	const { store } = deps;

	const blocked = (
		row: {
			execution_id: string;
			entry_seq: number;
			run_id: string;
			node_id: string;
			attempt: number;
		},
		code: string,
	) => {
		const prefix = `${row.execution_id}:${row.entry_seq}:fallback_blocked:`;
		const already = store.codexQuota
			.listResumeAudit(row.execution_id)
			.some(
				(audit) =>
					String(audit.event_uid).startsWith(prefix) &&
					audit.detail_code === code,
			);
		if (already) return;
		store.codexQuota.appendResumeAudit({
			executionId: row.execution_id,
			entrySeq: row.entry_seq,
			action: "fallback_blocked",
			at: iso(),
			runId: row.run_id,
			nodeId: row.node_id,
			attempt: row.attempt,
			detailCode: code,
		});
		if (code.startsWith("wip_checkpoint_"))
			store.codexQuota.enqueueOutbox({
				incidentId: `codex-standby:${row.execution_id}`,
				kind: "lead_diagnostic",
				eventId: `codex-standby-blocked:${row.execution_id}:${row.entry_seq}:${code}`,
				destination: "lead",
				payload: {
					reason: "fallback_blocked",
					detail: code,
					executionId: row.execution_id,
					runId: row.run_id,
					nodeId: row.node_id,
				},
			});
	};

	return {
		async tick(context) {
			const readings = context.readings;
			let pool: readonly CodexPoolMember[] = [];
			try {
				pool = deps.pool();
			} catch (error) {
				warn(
					"[Bridge] Codex pool unavailable for fallback evaluation",
					error instanceof Error ? error.message : String(error),
				);
			}
			for (const row of store.codexQuota.listStandby(["standby"])) {
				const runtime = store.getWorkflowExecutionRuntime(row.execution_id);
				const session = store.getSession(row.execution_id);
				if (!runtime || !session) continue;
				let plan:
					| {
							vendor: "codex" | "claude";
							model: string;
							effort: string;
							reason: "resume_attempts_exhausted" | "codex_quota_fallback";
							poolEvidenceRef: string | null;
					  }
					| undefined;
				if (row.mechanical_failures >= 2) {
					plan = {
						vendor: "codex",
						model: runtime.model,
						effort: runtime.effort ?? "high",
						reason: "resume_attempts_exhausted",
						poolEvidenceRef: null,
					};
				} else if (
					deps.claudeFallbackEnabled() &&
					!store.codexQuota.eligiblePermitFor(row.execution_id)
				) {
					const verdict = evaluatePoolExhaustionFromReadings(
						readings,
						pool,
						now(),
					);
					if (
						verdict.exhausted &&
						verdict.earliestResetMs > now() + CODEX_CLAUDE_FALLBACK_MIN_WAIT_MS
					) {
						const sameVendor = store.codexQuotaFallbackSameVendorViolation({
							runId: row.run_id,
							nodeId: row.node_id,
							vendor: "claude",
						});
						const claude = deps.claudeDispatch();
						if (sameVendor.violated) blocked(row, "same_vendor_review");
						else if (!claude) blocked(row, "claude_model_unavailable");
						else
							plan = {
								vendor: "claude",
								model: claude.model,
								effort: claude.effort,
								reason: "codex_quota_fallback",
								poolEvidenceRef: verdict.evidenceRef,
							};
					}
				}
				if (!plan) {
					if (
						now() - Date.parse(row.entered_at) > CODEX_STANDBY_OVERDUE_MS &&
						!store.codexQuota.eligiblePermitFor(row.execution_id)
					) {
						const prefix = `${row.execution_id}:${row.entry_seq}:standby_overdue:`;
						if (
							!store.codexQuota
								.listResumeAudit(row.execution_id)
								.some((audit) => String(audit.event_uid).startsWith(prefix))
						) {
							store.codexQuota.appendResumeAudit({
								executionId: row.execution_id,
								entrySeq: row.entry_seq,
								action: "standby_overdue",
								at: iso(),
								runId: row.run_id,
								nodeId: row.node_id,
								attempt: row.attempt,
								detailCode: "standby_over_12h",
							});
							store.codexQuota.enqueueOutbox({
								incidentId: `codex-standby:${row.execution_id}`,
								kind: "lead_diagnostic",
								eventId: `codex-standby-overdue:${row.execution_id}:${row.entry_seq}`,
								destination: "lead",
								payload: {
									reason: "standby_overdue",
									executionId: row.execution_id,
									runId: row.run_id,
									nodeId: row.node_id,
									enteredAt: row.entered_at,
								},
							});
						}
					}
					continue;
				}
				if (session.worktree_path) {
					const checkpoint = deps.checkpoint({
						executionId: row.execution_id,
						entrySeq: row.entry_seq,
						worktree: session.worktree_path,
						issueId: session.issue_identifier ?? session.issue_id,
					});
					if (checkpoint.kind === "refused") {
						blocked(row, `wip_checkpoint_${checkpoint.code}`.slice(0, 80));
						continue;
					}
				}
				const prepared = store.prepareCodexQuotaFallback({
					executionId: row.execution_id,
					vendor: plan.vendor,
					model: plan.model,
					effort: plan.effort,
					reason: plan.reason,
					newExecutionId: newExecutionId(),
					sameVendorEvidence:
						plan.vendor === "claude"
							? store.codexQuotaFallbackSameVendorViolation({
									runId: row.run_id,
									nodeId: row.node_id,
									vendor: "claude",
								}).evidence
							: { vendor: "codex", unchanged: true },
					poolEvidenceRef: plan.poolEvidenceRef,
					now: iso(),
				});
				if (!prepared.ok)
					warn(
						"[Bridge] Codex standby fallback not prepared",
						`${row.execution_id}: ${prepared.reason}`,
					);
			}
		},
	};
}
