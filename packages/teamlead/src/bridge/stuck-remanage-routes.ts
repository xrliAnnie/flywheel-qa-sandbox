/**
 * FLY-195: Lead-facing remanage endpoints (plan §3.4 + §3.5).
 *
 * Two deliberately LIGHT endpoints — neither is in the FLY-175 reserved set
 * (plan §2.3: the restricted nudge is a non-reserved light action; restart /
 * kill / ship remain founder-gated):
 *
 * 1. `POST /api/sessions/:executionId/stuck-disposition` — the Lead's
 *    explicit disposition receipt for one stuck episode. Writing it is what
 *    makes the Lead's judgment AUTHORITATIVE for the Bridge Q7 fallback
 *    (Codex R1 HIGH-1).
 *
 * 2. `POST /api/sessions/:executionId/recovery-nudge` — the ONLY sanctioned
 *    way for a Lead to type into a stuck Runner's terminal. Hard-restricted
 *    (Codex R1 HIGH-2: a raw terminal-input primitive would be a
 *    founder-consent backdoor):
 *      - allowlist phrases only (exact `continue`);
 *      - ALL gates must pass at send time: status re-read === running, no
 *        pending CommDB gate, no pending-review gray zone, episode
 *        fingerprint still matches the live capture (output unchanged), and
 *        an idle input box is visibly present;
 *      - EVERY attempt (sent or refused) is audited to session_events.
 *    A successful nudge implicitly records the `handled_remanaged`
 *    disposition for the episode (plan §3.4).
 */

import { type RequestHandler, Router } from "express";
import type { ProjectEntry } from "../ProjectConfig.js";
import {
	EXPLICIT_STUCK_DISPOSITIONS,
	type StateStore,
	type StuckDisposition,
} from "../StateStore.js";
import { matchesLead } from "./lead-scope.js";
// FLY-368: the recovery-nudge gates + audit-before-send now live in a shared,
// audited operation reused by BOTH this route and the auto-repair bot. Gate-4's
// capture/fingerprint/input-box checks moved there too (their imports left this
// file with them).
import {
	attemptRunnerRecoveryNudge,
	NUDGE_ALLOWLIST as SHARED_NUDGE_ALLOWLIST,
} from "./runner-recovery-nudge.js";
import {
	hasPendingGateFromCommDb,
	STUCK_LATCH_TTL_MS,
} from "./stuck-escalation.js";
import {
	getTmuxTargetFromCommDb,
	sendKeysToWindow,
	type TmuxTarget,
} from "./tmux-lookup.js";
import type { CaptureSessionFn } from "./tools.js";

/** The ONLY phrases the recovery nudge may type (plan §3.5). Re-exported from
 * the shared operation so there is a single source of truth (FLY-368). */
export const NUDGE_ALLOWLIST: readonly string[] = SHARED_NUDGE_ALLOWLIST;

/** Episode fingerprints are 16 lowercase hex chars (see fingerprintOutput). */
const FINGERPRINT_RE = /^[0-9a-f]{16}$/;

const NOTE_MAX = 500;

export interface StuckRemanageRouterOptions {
	store: StateStore;
	projects: ProjectEntry[];
	captureSessionFn: CaptureSessionFn;
	/**
	 * Auth middleware applied to BOTH routes (Bridge passes
	 * tokenAuthMiddleware). Per-route on purpose: mounting it prefix-wide on
	 * /api/sessions would leak auth onto unrelated later-mounted layers.
	 */
	auth?: RequestHandler;
	/** Injectable for tests; defaults to the CommDB probe. */
	hasPendingGate?: (executionId: string, projectName: string) => boolean;
	/** Injectable for tests; defaults to tmux send-keys. */
	sendKeys?: (
		tmuxWindow: string,
		text: string,
	) => Promise<{ sent: boolean; error?: string }>;
	/** Injectable for tests; defaults to the CommDB tmux target lookup. */
	getTmuxTarget?: (
		executionId: string,
		projectName: string,
	) => TmuxTarget | undefined;
	now?: () => number;
	/**
	 * FLY-253 L2: server-side TTL (ms) written into execution-scoped
	 * `legitimate_wait` / `needs_founder` latches as `snooze_until_ms`.
	 * `0` = permanent (NULL). Parsed ONCE at the plugin/config layer from
	 * `FLYWHEEL_STUCK_LATCH_TTL_MS` and injected here (Codex R2 #5 — tests
	 * inject the value, never mutate global env). Default 72h.
	 */
	latchTtlMs?: number;
	/**
	 * FLY-253 (Codex R1 #1): notify the live detector that an execution was
	 * re-armed so its in-memory episode (already marked escalated/annieAlerted
	 * by the latch suppression) is reset too — a DB delete alone cannot reach
	 * it. Wired by plugin.ts via a late-bound holder (Codex R2 #4: the router
	 * mounts before the detector exists). Absent/null-holder ⇒ no-op (detector
	 * disabled); the DB row is still deleted.
	 */
	onRearm?: (executionId: string) => void;
}

export function createStuckRemanageRouter(
	opts: StuckRemanageRouterOptions,
): Router {
	const { store, projects, captureSessionFn } = opts;
	const hasPendingGate = opts.hasPendingGate ?? hasPendingGateFromCommDb;
	const sendKeys = opts.sendKeys ?? sendKeysToWindow;
	const getTmuxTarget = opts.getTmuxTarget ?? getTmuxTargetFromCommDb;
	const now = opts.now ?? (() => Date.now());
	const latchTtlMs = opts.latchTtlMs ?? STUCK_LATCH_TTL_MS;
	const auth: RequestHandler = opts.auth ?? ((_req, _res, next) => next());
	// Audit event_ids carry a monotonic uniquifier: two attempts in the same
	// millisecond must NOT collide on the session_events UNIQUE(event_id)
	// constraint — that would silently drop an audit row (Codex R1 HIGH-2:
	// EVERY nudge attempt is audited).
	let auditSeq = 0;
	const router = Router();

	// ── 1. Explicit disposition receipt (plan §3.4) ──
	router.post("/:executionId/stuck-disposition", auth, (req, res) => {
		const executionId = req.params.executionId as string;
		const body = (req.body ?? {}) as {
			leadId?: string;
			episode_fingerprint?: string;
			disposition?: string;
			snooze_until_ms?: number;
			note?: string;
		};

		const leadId = typeof body.leadId === "string" ? body.leadId.trim() : "";
		if (!leadId) {
			res.status(400).json({ error: "leadId is required in request body" });
			return;
		}

		// ── FLY-253: re_arm (latch operation, not a disposition) ──
		// Placed AFTER auth (route middleware) + leadId, and it runs its own
		// session-existence + lead-scope checks BEFORE acting (Codex R2 #4 /
		// R1 #8: the special-case must not bypass any safety check). No
		// fingerprint required — it clears the EXECUTION latch.
		if (body.disposition === "re_arm") {
			const session = store.getSession(executionId);
			if (!session) {
				res.status(404).json({ error: "Session not found" });
				return;
			}
			try {
				if (!matchesLead(session, leadId, projects)) {
					res.status(403).json({
						error: `Session ${executionId} is outside lead "${leadId}" scope`,
					});
					return;
				}
			} catch (err) {
				res.status(403).json({
					error: `Lead scope check failed: ${(err as Error).message}`,
				});
				return;
			}
			// Clears the sentinel AND all episode rows (Codex code R1 HIGH-1: an
			// effective exact receipt on the still-frozen fingerprint would
			// otherwise keep suppressing after re_arm).
			store.clearExecutionStuckReceipts(executionId);
			// Reach the live detector's in-memory episode (Codex R1 #1). The
			// late-bound holder is null when detection is disabled — DB rows are
			// already gone either way.
			try {
				opts.onRearm?.(executionId);
			} catch (err) {
				console.error(
					`[stuck-disposition] onRearm callback failed for ${executionId}: ${(err as Error).message}`,
				);
			}
			try {
				store.insertEvent({
					event_id: `stuck-disposition-${executionId}-rearm-${now()}-${++auditSeq}`,
					execution_id: executionId,
					issue_id: session.issue_id,
					project_name: session.project_name,
					event_type: "stuck_disposition_set",
					source: "bridge.stuck-remanage",
					payload: { leadId, disposition: "re_arm" },
				});
			} catch (err) {
				console.error(
					`[stuck-disposition] trace event write failed for ${executionId}: ${(err as Error).message}`,
				);
			}
			res.json({ ok: true, disposition: "re_arm" });
			return;
		}

		const fingerprint = body.episode_fingerprint;
		if (typeof fingerprint !== "string" || !FINGERPRINT_RE.test(fingerprint)) {
			res.status(400).json({
				error:
					"episode_fingerprint must be the 16-hex fingerprint from the runner_stuck_escalation event",
			});
			return;
		}
		const disposition = body.disposition as StuckDisposition;
		if (!EXPLICIT_STUCK_DISPOSITIONS.includes(disposition)) {
			res.status(400).json({
				error: `disposition must be one of: ${EXPLICIT_STUCK_DISPOSITIONS.join(", ")}, or re_arm (handled_remanaged is recorded implicitly by a successful recovery-nudge)`,
			});
			return;
		}
		let snoozeUntilMs: number | null = null;
		if (disposition === "snooze") {
			if (
				typeof body.snooze_until_ms !== "number" ||
				!Number.isFinite(body.snooze_until_ms) ||
				body.snooze_until_ms <= now()
			) {
				res.status(400).json({
					error: "snooze requires snooze_until_ms (epoch ms, in the future)",
				});
				return;
			}
			snoozeUntilMs = Math.floor(body.snooze_until_ms);
		}

		const session = store.getSession(executionId);
		if (!session) {
			res.status(404).json({ error: "Session not found" });
			return;
		}
		try {
			if (!matchesLead(session, leadId, projects)) {
				res.status(403).json({
					error: `Session ${executionId} is outside lead "${leadId}" scope`,
				});
				return;
			}
		} catch (err) {
			res.status(403).json({
				error: `Lead scope check failed: ${(err as Error).message}`,
			});
			return;
		}

		// ── FLY-253 L2: scope mapping (SERVER semantics, not client input) ──
		// legitimate_wait / needs_founder / snooze describe the RUNNER, not one
		// pane frame → execution-scoped sentinel row ('*'), so one receipt
		// latches every later episode (the LEARN-57 treadmill fix). The TTL'd
		// latches get a server-computed expiry (snooze keeps the Lead's own).
		// false_positive stays episode-scoped: "it is actually working" is a
		// frame-level judgment that self-resolves when output changes — an
		// execution-wide false_positive would mask a later true freeze.
		const isExecutionScoped =
			disposition === "legitimate_wait" ||
			disposition === "needs_founder" ||
			disposition === "snooze";
		const userNote = typeof body.note === "string" ? body.note : null;
		let rowFingerprint = fingerprint;
		let rowSnoozeUntilMs = snoozeUntilMs;
		let note: string | null;
		if (isExecutionScoped) {
			rowFingerprint = "*";
			if (disposition !== "snooze") {
				rowSnoozeUntilMs = latchTtlMs > 0 ? now() + latchTtlMs : null;
			} else if (latchTtlMs > 0 && rowSnoozeUntilMs != null) {
				// Codex code R1 MEDIUM-3: an execution-scoped snooze now mutes the
				// WHOLE runner, so the Lead-provided horizon is clamped to the same
				// bounded-blind-spot ceiling as the latches (a multi-year snooze
				// would otherwise be a near-permanent execution mute). latchTtlMs=0
				// means the operator allows permanent latches — no clamp then.
				rowSnoozeUntilMs = Math.min(rowSnoozeUntilMs, now() + latchTtlMs);
			}
			// Provenance FIRST, user note truncated to the remaining budget
			// (Codex R1 #8: a 500-char note must not squeeze out the fingerprint).
			const provenance = `(episode ${fingerprint})`;
			const budget = NOTE_MAX - provenance.length - 1;
			note = userNote
				? `${userNote.slice(0, Math.max(0, budget))} ${provenance}`
				: provenance;
		} else {
			note = userNote ? userNote.slice(0, NOTE_MAX) : null;
		}

		store.setStuckDisposition({
			execution_id: executionId,
			episode_fingerprint: rowFingerprint,
			disposition,
			snooze_until_ms: rowSnoozeUntilMs,
			noted_by: leadId,
			note,
		});
		// Trace row is secondary — the stuck_dispositions receipt above IS the
		// authoritative record, so a trace failure logs but does not fail the
		// request (the Lead's judgment is already durably persisted).
		try {
			store.insertEvent({
				event_id: `stuck-disposition-${executionId}-${fingerprint}-${now()}-${++auditSeq}`,
				execution_id: executionId,
				issue_id: session.issue_id,
				project_name: session.project_name,
				event_type: "stuck_disposition_set",
				source: "bridge.stuck-remanage",
				payload: {
					leadId,
					fingerprint,
					disposition,
					snoozeUntilMs: rowSnoozeUntilMs,
					note,
					scope: isExecutionScoped ? "execution" : "episode",
				},
			});
		} catch (err) {
			console.error(
				`[stuck-disposition] trace event write failed for ${executionId}: ${(err as Error).message}`,
			);
		}
		// Echo the EFFECTIVE expiry (Codex code R2 LOW: the snooze horizon may
		// have been clamped server-side — the Lead must not plan around a
		// snooze_until_ms that is not what was stored).
		res.json({
			ok: true,
			disposition,
			scope: isExecutionScoped ? "execution" : "episode",
			snooze_until_ms: rowSnoozeUntilMs,
		});
	});

	// ── 2. Restricted recovery nudge (plan §3.5) ──
	// FLY-368: the gates + audit-before-send now live in the shared, audited
	// `attemptRunnerRecoveryNudge` operation (reused by the auto-repair bot). This
	// route is a thin HTTP adapter over it — behavior is unchanged.
	router.post("/:executionId/recovery-nudge", auth, async (req, res) => {
		const body = (req.body ?? {}) as {
			leadId?: string;
			episode_fingerprint?: string;
			phrase?: string;
		};
		const outcome = await attemptRunnerRecoveryNudge(
			{
				actor: "lead",
				executionId: req.params.executionId as string,
				leadId: typeof body.leadId === "string" ? body.leadId : "",
				fingerprint: body.episode_fingerprint,
				phrase: body.phrase,
			},
			{
				store,
				projects,
				captureSessionFn,
				hasPendingGate,
				sendKeys,
				getTmuxTarget,
				now,
				nextAuditSeq: () => ++auditSeq,
			},
		);
		res.status(outcome.status).json(outcome.body);
	});

	return router;
}
