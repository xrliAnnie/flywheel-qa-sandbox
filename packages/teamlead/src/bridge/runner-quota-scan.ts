/**
 * FLY-696 M1/③ — runner-side quota scan (the wiring around
 * `detectRunnerQuotaCap`).
 *
 * This catches the edge where a Runner is the first process to hit the shared
 * cap while every Lead pane sits idle (plan §11 ③).
 *
 * For a real cap it emits a `usage_limit` alert carrying the SAME
 * `accountLimit` metadata the Lead path produces + the runner's identity, routed
 * through the shared alert sink → AutoRepairBot → durable pending → switch. The
 * §3.3 transient-529 short-circuit lives inside `detectRunnerQuotaCap` (injected
 * recognizer), so a transient throttle NEVER switches.
 *
 * The eventId is keyed by (execution_id, observedGeneration) so repeated polls
 * of the same cap dedup at the notifier, while a NEW cap after a switch (which
 * bumps the generation) alerts afresh.
 */

import { detectRunnerQuotaCap } from "../account-heal/runner-quota-detector.js";
import type { AlertPayload, AlertResult } from "../LeadAlertNotifier.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { resolveLeadForIssue } from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";
import { parseSessionLabels } from "./lead-scope.js";
import { isCaptureError } from "./session-capture.js";
import type { CaptureSessionFn } from "./tools.js";

export const DEFAULT_RUNNER_QUOTA_SCAN_INTERVAL_MS = 60 * 60_000;

export interface RunnerQuotaScanDeps {
	projects: ProjectEntry[];
	/** The shared alert sink (Hub when on, raw notifier otherwise). */
	alert: (payload: AlertPayload) => Promise<AlertResult>;
	/** The §3.3 recognizer — the SAME isTransientThrottlePane the Lead path uses. */
	isTransient: (pane: string) => boolean;
	now: () => number;
	/** Override the account-state path (tests); defaults to the store default. */
	storePath?: string;
	log?: (msg: string) => void;
}

/**
 * Build the per-session quota classifier. Returns a no-op-safe
 * async function: null cap (transient / no gauge / unprovisioned pool) → return;
 * unresolvable owning Lead → skip (cannot route); otherwise emit the alert.
 */
export function makeRunnerQuotaScan(
	deps: RunnerQuotaScanDeps,
): (session: Session, pane: string) => Promise<void> {
	return async (session: Session, pane: string): Promise<void> => {
		const cap = detectRunnerQuotaCap({
			pane,
			now: new Date(deps.now()),
			isTransient: deps.isTransient,
			...(deps.storePath !== undefined && { storePath: deps.storePath }),
		});
		if (!cap) return;

		let leadId: string;
		try {
			const { lead } = resolveLeadForIssue(
				deps.projects,
				session.project_name,
				parseSessionLabels(session),
			);
			leadId = lead.agentId;
		} catch (err) {
			// No owning Lead → nowhere to route the alert thread. Skip (the shared
			// account means lead-alert.sh still covers the core cap).
			deps.log?.(
				`[RunnerQuotaScan] cannot resolve owning Lead for ${session.execution_id}: ${
					err instanceof Error ? err.message : String(err)
				} — skipping`,
			);
			return;
		}

		const issue = session.issue_identifier ?? session.issue_id;
		const payload: AlertPayload = {
			leadId,
			projectName: session.project_name,
			// Stable per (runner, account generation) so repeated polls of the same
			// cap dedup; a post-switch cap (new generation) alerts afresh.
			eventId: `runner-quota:${session.execution_id}:${cap.observedGeneration}`,
			eventType: "usage_limit",
			title: `Runner usage cap: ${issue}`,
			body:
				`Runner ${session.execution_id} (${issue}) hit a real Claude ${cap.scope} usage cap ` +
				`on account ${cap.observedAccount} (reset ${cap.resetAt}). Rotating to the next ` +
				`account — new runs use it; this session waits for reset.`,
			severity: "warning",
			sessionKey: session.execution_id,
			metadata: { accountLimit: cap },
		};

		try {
			await deps.alert(payload);
		} catch (err) {
			deps.log?.(
				`[RunnerQuotaScan] alert emit failed for ${session.execution_id}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	};
}

export function makeRunnerQuotaScanPass(deps: {
	store: Pick<StateStore, "getActiveSessions">;
	captureSession: CaptureSessionFn;
	scan: (session: Session, pane: string) => void | Promise<void>;
	intervalMs?: number;
	now?: () => number;
	log?: (message: string) => void;
}): () => Promise<void> {
	const lastScannedAt = new Map<string, number>();
	return async () => {
		const sessions = deps.store
			.getActiveSessions()
			.filter((session) => session.status === "running");
		const active = new Set(sessions.map((session) => session.execution_id));
		for (const executionId of lastScannedAt.keys()) {
			if (!active.has(executionId)) lastScannedAt.delete(executionId);
		}
		for (const session of sessions) {
			const now = (deps.now ?? Date.now)();
			const last = lastScannedAt.get(session.execution_id);
			if (
				last !== undefined &&
				now - last < (deps.intervalMs ?? DEFAULT_RUNNER_QUOTA_SCAN_INTERVAL_MS)
			) {
				continue;
			}
			try {
				const capture = await deps.captureSession(
					session.execution_id,
					session.project_name,
					100,
				);
				if (isCaptureError(capture)) continue;
				lastScannedAt.set(session.execution_id, now);
				await deps.scan(session, capture.output);
			} catch (error) {
				deps.log?.(
					`[RunnerQuotaScan] scan failed for ${session.execution_id}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
		}
	};
}
