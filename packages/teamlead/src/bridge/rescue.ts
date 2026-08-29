/**
 * FLY-871 R3/C9 — infra self-heal rescue orchestration.
 *
 * Restarts a session that Bridge has classified as logged-out so it re-reads the
 * fresh Keychain and self-heals — the automation of Annie's manual "捞号". This
 * module is PURE orchestration + structural guards; every destructive / stateful
 * op (launchctl kickstart, tmux capture/send, session close, successor dispatch,
 * Discord post, audit) is an INJECTED seam, so the whole thing is unit-testable
 * without touching real processes, and the real-machine drill is the §8 QA gate.
 *
 * Structural guardrails (NOT just prompt text — founder-only-authority R3):
 *   1. A rescue runs ONLY against a session with a STILL-PENDING, CONFIRMED
 *      login_expired / runner_login_expired alert row (`findPending*Alert`).
 *      A healthy session, a resolved alert, or a low-confidence "suspicious"
 *      anomaly (evidence prefix != login_expired) can NEVER be rescued.
 *   2. Actions are limited to restart-in-place (lead kickstart / runner
 *      rescue-retry-with-resume) — never terminate-without-restart, never a
 *      healthy session. "重启不戳框": the rescue RESTARTS the session; the only
 *      key it ever sends is Enter to the known, fixture-validated resume-menu.
 *   3. Evidence-first: every rescue posts to the Alerts thread BEFORE and AFTER.
 *   4. One retry, then escalate to the founder (@Annie) with the stuck evidence —
 *      never an unbounded loop.
 *   5. Every step audits (same sink as the account-switch route).
 */

export type RescueRoute = "lead" | "runner";

export interface RescueOutcome {
	ok: boolean;
	/** "lead:<id>" | "runner:<execId>" */
	target: string;
	/** failure reason (absent on success). */
	reason?: string;
	/** true when the founder was paged (rescue exhausted its one retry). */
	escalated?: boolean;
}

export interface RescueAuditEntry {
	target: string;
	phase: "start" | "done" | "failed" | "refused";
	detail: string;
}

/**
 * Post rescue evidence. `threadKey` (= the alert's correlationKey) routes the
 * post into THAT incident's Alerts thread (guardrail 3 — evidence lives under the
 * alert, not the root channel; the runtime falls back to the root channel only if
 * the thread can't be resolved). `mention: true` @-pings the founder FOR REAL via
 * allowed_mentions on an escalation — a literal "@Annie" in the text never pings.
 */
export type PostEvidenceFn = (
	detail: string,
	opts?: { threadKey?: string; mention?: boolean },
) => Promise<void>;

/**
 * Resolve the incident alert thread after a rescue makes the session healthy
 * again (successful restart, or a revalidation that shows it already recovered).
 * Keeps the post-switch sweep + reconcile from re-hitting a session that is no
 * longer stuck. Idempotent; optional (tests / callers may omit it).
 */
export type ResolveAlertFn = (correlationKey: string) => Promise<void>;

/** The minimal still-pending alert shape the rescue guard reads. */
export interface PendingAlert {
	correlationKey: string;
	/** "login_expired" (lead) | "runner_login_expired" (runner). */
	eventType: string;
	sessionKey: string | null;
	leadId: string;
	projectName: string;
	/** authLimit.evidence, e.g. "runner-pane:login_expired" | "runner-pane:suspicious". */
	evidence?: string;
}

/**
 * Only a CONFIRMED login_expired is rescuable — a low-confidence "suspicious"
 * anomaly (evidence ends in `:suspicious`) is surfaced for a human, never
 * auto-restarted (guardrail 1).
 */
function isConfirmed(alert: PendingAlert): boolean {
	return alert.evidence == null || !alert.evidence.endsWith(":suspicious");
}

/** Find a pending, confirmed lead `login_expired` alert. undefined ⇒ not rescuable. */
export function findPendingLeadAlert(
	rows: PendingAlert[],
	leadId: string,
	projectName: string,
): PendingAlert | undefined {
	return rows.find(
		(r) =>
			r.eventType === "login_expired" &&
			r.leadId === leadId &&
			r.projectName === projectName &&
			isConfirmed(r),
	);
}

/** Find a pending, confirmed `runner_login_expired` alert for an execution. */
export function findPendingRunnerAlert(
	rows: PendingAlert[],
	executionId: string,
): PendingAlert | undefined {
	return rows.find(
		(r) =>
			r.eventType === "runner_login_expired" &&
			r.sessionKey === executionId &&
			isConfirmed(r),
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Lead rescue — launchctl kickstart + resume-menu Enter unstick.
// ─────────────────────────────────────────────────────────────────────────────

export interface RescueLeadDeps {
	/** Snapshot of the still-pending alert rows (= listActiveAlertThreads mapped). */
	pendingAlerts: () => PendingAlert[];
	/** `launchctl kickstart -k gui/$UID/com.flywheel.lead.<project>-<leadId>`. */
	kickstart: (projectName: string, leadId: string) => Promise<boolean>;
	/** Capture the Lead's tmux pane (null ⇒ no window / cannot tell). */
	capturePane: (projectName: string, leadId: string) => Promise<string | null>;
	/** Send a single Enter to the Lead window (only ever for the resume menu). */
	sendEnter: (projectName: string, leadId: string) => Promise<void>;
	/** = LeadWatchdog.isSafeResumeMenuForEnter — the fixture-validated recogniser. */
	isResumeMenu: (pane: string) => boolean;
	/** Post evidence into the incident's Alerts thread (before + after). */
	postEvidence: PostEvidenceFn;
	/** Resolve the incident thread on a successful kickstart (idempotent). */
	resolveAlert?: ResolveAlertFn;
	audit: (e: RescueAuditEntry) => void;
	/** Injectable sleep (tests pass a no-op). */
	waitMs?: (ms: number) => Promise<void>;
}

async function attemptLeadRescue(
	input: { projectName: string; leadId: string },
	deps: RescueLeadDeps,
): Promise<{ ok: boolean; reason?: string }> {
	const ok = await deps.kickstart(input.projectName, input.leadId);
	if (!ok) return { ok: false, reason: "kickstart_failed" };

	// Post-restart the Lead may sit at the "Resume from summary?" confirm box
	// (a known, fixture-validated menu) — send Enter to unstick. Never any other key.
	await deps.waitMs?.(2000);
	const pane = await deps.capturePane(input.projectName, input.leadId);
	if (pane != null && deps.isResumeMenu(pane)) {
		await deps.sendEnter(input.projectName, input.leadId);
		await deps.waitMs?.(1000);
	}
	// Verify recovery — success requires POSITIVE evidence (Codex R2 HIGH). A
	// `null` re-capture means "no window / cannot tell" (the seam's contract): the
	// Lead may still be logged out, so this is NOT a success — treating it as one
	// would let `rescueLead` resolve the alert and drop a still-dead Lead off the
	// sweep + reconcile. Only a re-capture that is present AND no longer the
	// resume menu counts as recovered.
	const after = await deps.capturePane(input.projectName, input.leadId);
	if (after == null) {
		return { ok: false, reason: "verify_capture_failed" };
	}
	if (deps.isResumeMenu(after)) {
		return { ok: false, reason: "stuck_resume_menu" };
	}
	return { ok: true };
}

export async function rescueLead(
	input: { projectName: string; leadId: string },
	deps: RescueLeadDeps,
): Promise<RescueOutcome> {
	const target = `lead:${input.leadId}`;
	const alert = findPendingLeadAlert(
		deps.pendingAlerts(),
		input.leadId,
		input.projectName,
	);
	if (!alert) {
		deps.audit({
			target,
			phase: "refused",
			detail: "no pending confirmed login_expired alert",
		});
		return { ok: false, target, reason: "no_pending_login_expired_alert" };
	}

	const thread = { threadKey: alert.correlationKey };
	deps.audit({
		target,
		phase: "start",
		detail: `alert ${alert.correlationKey}`,
	});
	await deps.postEvidence(
		`🔧 Rescuing Lead ${input.leadId}: launchctl kickstart (pending login_expired ${alert.correlationKey}).`,
		thread,
	);

	// One rescue attempt + one retry, then escalate (guardrail 4).
	let last: { ok: boolean; reason?: string } = { ok: false };
	for (let attempt = 1; attempt <= 2; attempt++) {
		last = await attemptLeadRescue(input, deps);
		if (last.ok) {
			deps.audit({
				target,
				phase: "done",
				detail: `kickstart ok (attempt ${attempt})`,
			});
			await deps.postEvidence(
				`✅ Lead ${input.leadId} rescued (kickstart + verify).`,
				thread,
			);
			await deps.resolveAlert?.(alert.correlationKey);
			return { ok: true, target };
		}
	}
	deps.audit({ target, phase: "failed", detail: `${last.reason} after retry` });
	await deps.postEvidence(
		`⚠️ Lead ${input.leadId} rescue failed (${last.reason}) after one retry — @Annie, evidence in thread.`,
		{ ...thread, mention: true },
	);
	return { ok: false, target, reason: last.reason, escalated: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Runner rescue — close the dead running session + dispatch a resumed successor.
// The existing `retry` action structurally CANNOT touch a still-`running`
// session, so this is a dedicated path (plan C9). ResumeKind reuses "restart"
// (identical resume behavior); the login_expired_rescue REASON is audited.
// ─────────────────────────────────────────────────────────────────────────────

export interface RescueRunnerDeps {
	pendingAlerts: () => PendingAlert[];
	/**
	 * FLY-871 (Lead ②) — LIVE revalidation immediately before the destructive
	 * close+dispatch. The stored alert row that `findPendingRunnerAlert` matched
	 * proves a logout was CONFIRMED when the alert fired, but the runner may have
	 * self-recovered (re-read the Keychain) or been fixed by a human in the interim.
	 * This seam re-captures the runner's live pane and re-classifies it, so the
	 * rescue closes the session ONLY if it is STILL confirmed logged-out — a
	 * recovered runner is never restarted. Optional: undefined ⇒ proceed on the
	 * alert row alone (unit tests / callers with no live pane). Resolves to
	 * `{ confirmed, category }` (`confirmed:false` ⇒ report-only refusal); a THROW
	 * means "cannot tell" ⇒ the rescue refuses AND escalates (never close on
	 * uncertainty).
	 */
	revalidate?: (
		executionId: string,
	) => Promise<{ confirmed: boolean; category?: string }>;
	/**
	 * Atomically close the dead running session with the login_expired_rescue
	 * reason and dispatch an idempotent successor resumed from $FLYWHEEL_PROGRESS_PATH
	 * (FLY-795). Returns the successor's execution id, or null on failure. Injected
	 * so the risky session-lifecycle op stays isolated + testable.
	 */
	closeAndDispatchSuccessor: (executionId: string) => Promise<string | null>;
	/** Post evidence into the incident's Alerts thread (before + after). */
	postEvidence: PostEvidenceFn;
	/** Resolve the incident thread when the runner is healthy again (idempotent). */
	resolveAlert?: ResolveAlertFn;
	audit: (e: RescueAuditEntry) => void;
}

export async function rescueRunner(
	input: { executionId: string },
	deps: RescueRunnerDeps,
): Promise<RescueOutcome> {
	const target = `runner:${input.executionId}`;
	const alert = findPendingRunnerAlert(deps.pendingAlerts(), input.executionId);
	if (!alert) {
		deps.audit({
			target,
			phase: "refused",
			detail: "no pending confirmed runner_login_expired alert",
		});
		return {
			ok: false,
			target,
			reason: "no_pending_runner_login_expired_alert",
		};
	}

	const thread = { threadKey: alert.correlationKey };

	// FLY-871 (Lead ②): LIVE revalidation before the destructive close+dispatch.
	// The alert row proves a logout was confirmed when it FIRED; re-check the live
	// pane so a runner that self-recovered (re-read the Keychain) or was fixed by a
	// human in the interim is NEVER closed. A throw = "cannot tell" ⇒ refuse AND
	// escalate (never close on uncertainty); `confirmed:false` (recovered) ⇒
	// report-only refusal, not an escalation.
	if (deps.revalidate) {
		let live: { confirmed: boolean; category?: string };
		try {
			live = await deps.revalidate(input.executionId);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			deps.audit({
				target,
				phase: "failed",
				detail: `revalidation error: ${msg}`,
			});
			await deps.postEvidence(
				`⚠️ Runner ${input.executionId} rescue: could not revalidate the live pane (${msg}) — refusing to close on uncertainty. @Annie.`,
				{ ...thread, mention: true },
			);
			return {
				ok: false,
				target,
				reason: "revalidation_error",
				escalated: true,
			};
		}
		if (!live.confirmed) {
			deps.audit({
				target,
				phase: "refused",
				detail: `revalidation not confirmed (category=${live.category ?? "?"})`,
			});
			await deps.postEvidence(
				`ℹ️ Runner ${input.executionId} appears RECOVERED on re-check (category=${live.category ?? "?"}) — not rescuing (report-only).`,
				thread,
			);
			// The runner is healthy again ⇒ clear the stale alert so the sweep +
			// reconcile stop tracking it.
			await deps.resolveAlert?.(alert.correlationKey);
			return { ok: false, target, reason: "revalidation_not_confirmed" };
		}
	}

	deps.audit({
		target,
		phase: "start",
		detail: `alert ${alert.correlationKey}`,
	});
	await deps.postEvidence(
		`🔧 Rescuing Runner ${input.executionId}: close (login_expired_rescue) + resumed successor (pending ${alert.correlationKey}).`,
		thread,
	);

	// One attempt + one retry (the successor dispatch is idempotency-keyed, so a
	// retry converges to a single successor rather than spawning duplicates).
	let successor: string | null = null;
	for (let attempt = 1; attempt <= 2; attempt++) {
		successor = await deps.closeAndDispatchSuccessor(input.executionId);
		if (successor) break;
	}
	if (!successor) {
		deps.audit({
			target,
			phase: "failed",
			detail: "close/dispatch failed after retry",
		});
		await deps.postEvidence(
			`⚠️ Runner ${input.executionId} rescue failed after one retry — @Annie, evidence in thread.`,
			{ ...thread, mention: true },
		);
		return {
			ok: false,
			target,
			reason: "close_dispatch_failed",
			escalated: true,
		};
	}
	deps.audit({ target, phase: "done", detail: `successor ${successor}` });
	await deps.postEvidence(
		`✅ Runner ${input.executionId} rescued → resumed successor ${successor}.`,
		thread,
	);
	// AFTER the "✅" post lands in the thread: the old (kicked-out) execution is
	// closed + a resumed successor dispatched ⇒ resolve THIS execId's alert so the
	// sweep + reconcile don't re-hit a terminated session.
	await deps.resolveAlert?.(alert.correlationKey);
	return { ok: true, target };
}

// ─────────────────────────────────────────────────────────────────────────────
// Post-switch rescue sweep (Annie, lead-instruction 4945ebf9): on a SUCCESSFUL
// account switch, rescue EVERY session stuck at a login prompt within the incident
// window — not just the one that fired the triggering alert. Restart-not-poke-box;
// one attempt per session; a failure escalates that session to @Annie.
// ─────────────────────────────────────────────────────────────────────────────

export interface RescueSweepDeps {
	pendingAlerts: () => PendingAlert[];
	rescueLead: (input: {
		projectName: string;
		leadId: string;
	}) => Promise<RescueOutcome>;
	rescueRunner: (input: { executionId: string }) => Promise<RescueOutcome>;
	log?: (msg: string) => void;
}

/**
 * Sweep all still-pending confirmed login_expired / runner_login_expired alerts
 * and rescue each. Returns every outcome (callers surface the failures). Each
 * rescue is independently try/caught so one failure never aborts the sweep.
 */
export async function postSwitchRescueSweep(
	deps: RescueSweepDeps,
): Promise<RescueOutcome[]> {
	const rows = deps.pendingAlerts();
	const outcomes: RescueOutcome[] = [];
	for (const row of rows) {
		try {
			if (row.eventType === "login_expired" && isConfirmed(row)) {
				outcomes.push(
					await deps.rescueLead({
						projectName: row.projectName,
						leadId: row.leadId,
					}),
				);
			} else if (
				row.eventType === "runner_login_expired" &&
				row.sessionKey != null &&
				isConfirmed(row)
			) {
				outcomes.push(await deps.rescueRunner({ executionId: row.sessionKey }));
			}
		} catch (err) {
			deps.log?.(
				`[rescue-sweep] ${row.correlationKey} threw: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			outcomes.push({
				ok: false,
				target: row.sessionKey
					? `runner:${row.sessionKey}`
					: `lead:${row.leadId}`,
				reason: "sweep_exception",
				escalated: true,
			});
		}
	}
	return outcomes;
}
