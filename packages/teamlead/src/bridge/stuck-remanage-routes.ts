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
import { isCaptureError } from "./session-capture.js";
import { detectInputBoxPresent, fingerprintOutput } from "./stuck-candidate.js";
import { hasPendingGateFromCommDb } from "./stuck-escalation.js";
import {
	getTmuxTargetFromCommDb,
	sendKeysToWindow,
	type TmuxTarget,
} from "./tmux-lookup.js";
import type { CaptureSessionFn } from "./tools.js";

/** The ONLY phrases the recovery nudge may type (plan §3.5). Exact match. */
export const NUDGE_ALLOWLIST: readonly string[] = ["continue"];

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
}

export function createStuckRemanageRouter(
	opts: StuckRemanageRouterOptions,
): Router {
	const { store, projects, captureSessionFn } = opts;
	const hasPendingGate = opts.hasPendingGate ?? hasPendingGateFromCommDb;
	const sendKeys = opts.sendKeys ?? sendKeysToWindow;
	const getTmuxTarget = opts.getTmuxTarget ?? getTmuxTargetFromCommDb;
	const now = opts.now ?? (() => Date.now());
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
				error: `disposition must be one of: ${EXPLICIT_STUCK_DISPOSITIONS.join(", ")} (handled_remanaged is recorded implicitly by a successful recovery-nudge)`,
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

		const note =
			typeof body.note === "string" ? body.note.slice(0, NOTE_MAX) : null;
		store.setStuckDisposition({
			execution_id: executionId,
			episode_fingerprint: fingerprint,
			disposition,
			snooze_until_ms: snoozeUntilMs,
			noted_by: leadId,
			note,
		});
		store.insertEvent({
			event_id: `stuck-disposition-${executionId}-${fingerprint}-${now()}-${++auditSeq}`,
			execution_id: executionId,
			issue_id: session.issue_id,
			project_name: session.project_name,
			event_type: "stuck_disposition_set",
			source: "bridge.stuck-remanage",
			payload: { leadId, fingerprint, disposition, snoozeUntilMs, note },
		});
		res.json({ ok: true, disposition });
	});

	// ── 2. Restricted recovery nudge (plan §3.5) ──
	router.post("/:executionId/recovery-nudge", auth, async (req, res) => {
		const executionId = req.params.executionId as string;
		const body = (req.body ?? {}) as {
			leadId?: string;
			episode_fingerprint?: string;
			phrase?: string;
		};
		const leadId = typeof body.leadId === "string" ? body.leadId.trim() : "";
		const fingerprint = body.episode_fingerprint;
		const phrase = typeof body.phrase === "string" ? body.phrase : "continue";

		/** Audit EVERY attempt — sent or refused (Codex R1 HIGH-2). */
		const audit = (
			result: "sent" | "refused",
			reason: string,
			session?: { issue_id: string; project_name: string },
		) => {
			try {
				store.insertEvent({
					event_id: `recovery-nudge-${executionId}-${now()}-${++auditSeq}`,
					execution_id: executionId,
					issue_id: session?.issue_id ?? "unknown",
					project_name: session?.project_name ?? "unknown",
					event_type: "runner_recovery_nudge",
					severity: result === "refused" ? "warning" : "info",
					source: "bridge.stuck-remanage",
					payload: { leadId, fingerprint, phrase, result, reason },
				});
			} catch (err) {
				console.error(
					`[recovery-nudge] audit write failed for ${executionId}: ${(err as Error).message}`,
				);
			}
		};

		const refuse = (
			status: number,
			reason: string,
			session?: { issue_id: string; project_name: string },
		) => {
			audit("refused", reason, session);
			res.status(status).json({ nudged: false, error: reason });
		};

		if (!leadId) {
			refuse(400, "leadId is required in request body");
			return;
		}
		// Gate 0: allowlist phrase — exact match, nothing else ever reaches tmux.
		if (!NUDGE_ALLOWLIST.includes(phrase)) {
			refuse(
				400,
				`phrase not in allowlist (${NUDGE_ALLOWLIST.join(", ")}) — other instructions must go via mailbox; lifecycle actions are founder-gated (FLY-175)`,
			);
			return;
		}
		if (typeof fingerprint !== "string" || !FINGERPRINT_RE.test(fingerprint)) {
			refuse(
				400,
				"episode_fingerprint must be the 16-hex fingerprint from the runner_stuck_escalation event",
			);
			return;
		}

		const session = store.getSession(executionId);
		if (!session) {
			refuse(404, "Session not found");
			return;
		}
		try {
			if (!matchesLead(session, leadId, projects)) {
				refuse(
					403,
					`Session ${executionId} is outside lead "${leadId}" scope`,
					session,
				);
				return;
			}
		} catch (err) {
			refuse(
				403,
				`Lead scope check failed: ${(err as Error).message}`,
				session,
			);
			return;
		}

		// Gate 1: status re-read at send time — only a RUNNING session may be
		// nudged. awaiting_review / approved_to_ship are FLY-191 idle-reachable
		// review states; nudging there could type into a parked reviewee.
		if (session.status !== "running") {
			refuse(
				409,
				`status is "${session.status}" — only running sessions can be nudged`,
				session,
			);
			return;
		}
		// Gate 2: pending-review gray zone (needs_review emitted, row not flipped).
		if (session.decision_route === "needs_review") {
			refuse(
				409,
				"session has a pending review signal (decision_route=needs_review)",
				session,
			);
			return;
		}
		// Gate 3: pending CommDB gate question — legitimately parked; a nudge
		// could be (mis)read as a gate answer. Fail CLOSED on probe error.
		try {
			if (hasPendingGate(executionId, session.project_name)) {
				refuse(
					409,
					"runner has an unanswered gate/question — answer it instead of nudging",
					session,
				);
				return;
			}
		} catch (err) {
			refuse(
				503,
				`pending-gate probe failed (${(err as Error).message}) — refusing fail-closed`,
				session,
			);
			return;
		}
		// Gate 4: live capture must still show THIS episode (fingerprint match ⇒
		// output unchanged since escalation) AND an idle input box.
		const capture = await captureSessionFn(
			executionId,
			session.project_name,
			100,
		);
		if (isCaptureError(capture)) {
			refuse(
				503,
				`terminal capture failed (${capture.error}) — refusing fail-closed`,
				session,
			);
			return;
		}
		const liveFingerprint = fingerprintOutput(capture.output);
		if (liveFingerprint !== fingerprint) {
			refuse(
				409,
				"episode fingerprint no longer matches the live terminal (output changed — the runner may have resumed); re-judge from a fresh capture",
				session,
			);
			return;
		}
		if (!detectInputBoxPresent(capture.output)) {
			refuse(
				409,
				"no idle input box visible at the bottom of the terminal — not the stuck-at-prompt shape this nudge is for",
				session,
			);
			return;
		}

		// All gates passed — resolve the tmux window and send the phrase.
		const target = getTmuxTarget(executionId, session.project_name);
		if (!target) {
			refuse(409, "no tmux target found for this execution", session);
			return;
		}
		const sendResult = await sendKeys(target.tmuxWindow, phrase);
		if (!sendResult.sent) {
			refuse(
				502,
				`tmux send failed: ${sendResult.error ?? "unknown"}`,
				session,
			);
			return;
		}

		// Implicit disposition (plan §3.4): a successful nudge IS the Lead's
		// handled_remanaged receipt — suppresses the Q7 Annie fallback.
		store.setStuckDisposition({
			execution_id: executionId,
			episode_fingerprint: fingerprint,
			disposition: "handled_remanaged",
			noted_by: leadId,
			note: `recovery-nudge "${phrase}" sent to ${target.tmuxWindow}`,
		});
		audit("sent", `nudge sent to ${target.tmuxWindow}`, session);
		res.json({ nudged: true, tmuxWindow: target.tmuxWindow });
	});

	return router;
}
