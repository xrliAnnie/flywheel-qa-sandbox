/**
 * FLY-871 R2/C8 — runner-side login-expired scan.
 *
 * Mirrors `makeRunnerQuotaScan` (same per-session capture, FLY-169 no new timer)
 * but detects AUTH expiry — a kicked-out runner sitting at a login prompt — via
 * the layered detector (`classifyDetection`), emitting a **`runner_login_expired`**
 * alert. This event type is DELIBERATELY distinct from the lead `login_expired`:
 * `AlertChannelHub.reconcile` resolves it by re-capturing the RUNNER's pane
 * (not a Lead pane), and the R3 rescue path keys its server-side validation on
 * this runner event's still-pending row (a lead-pane resolve would falsely clear
 * it while the runner is still dead).
 *
 * Scope discipline (avoid false positives on a runner whose WORK prints error
 * text): only the RECENT live region is classified (a logged-out runner's login
 * prompt is the last thing on screen); usage/rate caps are the quota scan's job
 * and are ignored here; and the fail-suspicious surfacing (47cff318① "无法归类按
 * 可疑上报") fires ONLY when the region is auth-adjacent, so a runner editing
 * error-handling code is not flagged. A CONFIRMED login_expired is `severe` and
 * feeds R3 rescue; an unconfirmed auth anomaly is `warning`, surfaced for review,
 * and NEVER auto-rescued (the rescue path checks the evidence prefix).
 */

import { readStore } from "../account-heal/account-store.js";
import {
	classifyDetection,
	type DetectionDeps,
} from "../account-heal/detection-classifier.js";
import type { AlertPayload, AlertResult } from "../LeadAlertNotifier.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { resolveLeadForIssue } from "../ProjectConfig.js";
import type { Session } from "../StateStore.js";
import { parseSessionLabels } from "./lead-scope.js";

/** Only the last N lines are classified (the live region, not the scrollback). */
const RECENT_LINES = 20;

/**
 * Auth-adjacent vocabulary gate for the fail-suspicious path: an UNRECOGNISED
 * anomaly is surfaced only when the region talks about auth/login (so a runner
 * printing generic coding errors is not reported). CONFIRMED login_expired is
 * not gated by this — its pattern tokens are already auth-specific.
 */
const AUTH_VOCAB =
	/\b(?:log[\s-]?in|auth(?:enticat\w*)?|credential|api key|unauthorized|re-?auth|sign[\s-]?in|not logged|session expired)\b|\/login\b/i;

export interface RunnerAuthScanDeps {
	/** The shared alert sink (Hub when on, raw notifier otherwise). */
	alert: (payload: AlertPayload) => Promise<AlertResult>;
	/**
	 * Resolve the owning Lead id for a session; null ⇒ skip (cannot route the
	 * alert thread). Production wires `defaultResolveLeadId(projects)`.
	 */
	resolveLeadId: (session: Session) => string | null;
	/** Layer-2 AI classifier (optional; undefined ⇒ pattern + fail-suspicious only). */
	aiClassify?: DetectionDeps["aiClassify"];
	/** Override the account-state path (tests); defaults to the store default. */
	storePath?: string;
	/**
	 * FLY-871 R2/C7: optional ledger hook — on a CONFIRMED logout, record the
	 * active account's auth health as stale in the account-state ledger. Default
	 * undefined ⇒ no write (unit tests unaffected); plugin.ts wires it to
	 * `recordAuthHealth`, gated on the same self-heal switch as this scan.
	 */
	recordAuthHealth?: (accountName: string) => void;
	log?: (msg: string) => void;
}

/** Production lead resolver: wrap `resolveLeadForIssue`; unresolvable ⇒ null. */
export function defaultResolveLeadId(
	projects: ProjectEntry[],
): (session: Session) => string | null {
	return (session: Session): string | null => {
		try {
			const { lead } = resolveLeadForIssue(
				projects,
				session.project_name,
				parseSessionLabels(session),
			);
			return lead.agentId;
		} catch {
			return null;
		}
	};
}

/**
 * Build the per-session auth scan the RunnerIdleWatchdog calls (composed with the
 * quota scan). No-op-safe: healthy / quota-only / non-auth-anomaly panes return
 * without emitting.
 */
export function makeRunnerAuthScan(
	deps: RunnerAuthScanDeps,
): (session: Session, pane: string) => Promise<void> {
	return async (session: Session, pane: string): Promise<void> => {
		const region = pane.split("\n").slice(-RECENT_LINES).join("\n");
		const result = await classifyDetection(region, {
			aiClassify: deps.aiClassify,
		});

		const confirmed = result.category === "login_expired";
		// fail-suspicious: surface an UNRECOGNISED anomaly, but only when it is
		// auth-adjacent (a coding-work error pane is not this scan's concern).
		const surfaceSuspicious =
			result.category === "suspicious" && AUTH_VOCAB.test(region);
		if (!confirmed && !surfaceSuspicious) return;

		const leadId = deps.resolveLeadId(session);
		if (leadId === null) {
			deps.log?.(
				`[RunnerAuthScan] cannot resolve owning Lead for ${session.execution_id} — skipping`,
			);
			return;
		}

		const store = readStore(deps.storePath);
		// FLY-871 R2/C7: a confirmed runner logout means the active account's live
		// auth is dead — record it in the ledger (the daily summary reads it).
		if (confirmed && store.activeAccount) {
			deps.recordAuthHealth?.(store.activeAccount);
		}
		const issue = session.issue_identifier ?? session.issue_id;
		const evidence = confirmed
			? "runner-pane:login_expired"
			: "runner-pane:suspicious";

		const payload: AlertPayload = {
			leadId,
			projectName: session.project_name,
			// Dedup per (runner, category): a persistent logout does not re-fire; a
			// fresh episode after rescue is a NEW execution_id, so it alerts afresh.
			eventId: `runner-login-expired:${session.execution_id}:${result.category}`,
			eventType: "runner_login_expired",
			title: confirmed
				? `Runner logged out: ${issue}`
				: `Runner auth anomaly (unrecognized): ${issue}`,
			body: confirmed
				? `Runner ${session.execution_id} (${issue}) appears LOGGED OUT (${
						result.evidence ?? "login_expired"
					}). Rescue = restart in place so it re-reads the fresh Keychain.`
				: `Runner ${session.execution_id} (${issue}) shows an UNRECOGNIZED auth-adjacent anomaly (${
						result.evidence ?? "?"
					}). NOT auto-rescued — surfaced for review (fail-suspicious).`,
			severity: confirmed ? "severe" : "warning",
			sessionKey: session.execution_id,
			metadata: {
				authLimit: {
					provider: "claude",
					observedAccount: store.activeAccount ?? "unknown",
					observedGeneration: store.generation,
					evidence,
					executionId: session.execution_id,
				},
			},
		};

		try {
			await deps.alert(payload);
		} catch (err) {
			deps.log?.(
				`[RunnerAuthScan] alert emit failed for ${session.execution_id}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	};
}
