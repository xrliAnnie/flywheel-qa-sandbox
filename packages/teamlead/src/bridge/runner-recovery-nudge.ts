/**
 * FLY-368: shared, AUDITED runner recovery-nudge operation.
 *
 * Extracted from `stuck-remanage-routes.ts` (FLY-195 §3.5) so BOTH the Lead-facing
 * HTTP route AND the auto-repair bot drive recovery through the SAME safety
 * contract — the audit moves WITH the gates (Codex design R2 MEDIUM-8). A raw
 * "type into a terminal" primitive must never exist on a second path; the gates +
 * audit-before-send + fail-closed-on-audit-failure are the only sanctioned way to
 * put a keystroke into a stuck Runner.
 *
 * Gates (ALL re-checked at call time):
 *   0. phrase ∈ allowlist (exact `continue`);
 *   1. status === "running";
 *   2. decision_route !== "needs_review" (FLY-191 pending-review gray zone);
 *   3. no pending CommDB gate question (fail CLOSED on probe error);
 *   4. live capture fingerprint still matches (output unchanged) AND an idle
 *      input box is present;
 *   5. a tmux target exists.
 * EVERY attempt (sent or refused) is audited to session_events; a successful
 * nudge records the implicit `handled_remanaged` disposition (suppresses Q7).
 */

import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import { matchesLead } from "./lead-scope.js";
import { isCaptureError } from "./session-capture.js";
import { detectInputBoxPresent, fingerprintOutput } from "./stuck-candidate.js";
import type { TmuxTarget } from "./tmux-lookup.js";
import type { CaptureSessionFn } from "./tools.js";

/** The ONLY phrases the recovery nudge may type. Exact match. */
export const NUDGE_ALLOWLIST: readonly string[] = ["continue"];

/** Episode fingerprints are 16 lowercase hex chars (see fingerprintOutput). */
const FINGERPRINT_RE = /^[0-9a-f]{16}$/;

export interface RunnerNudgeDeps {
	store: StateStore;
	projects: ProjectEntry[];
	captureSessionFn: CaptureSessionFn;
	hasPendingGate: (executionId: string, projectName: string) => boolean;
	sendKeys: (
		tmuxWindow: string,
		text: string,
	) => Promise<{ sent: boolean; error?: string }>;
	getTmuxTarget: (
		executionId: string,
		projectName: string,
	) => TmuxTarget | undefined;
	now: () => number;
	/** Monotonic uniquifier for audit event_ids (collision-free within a process). */
	nextAuditSeq: () => number;
}

export interface RunnerNudgeInput {
	/** Who initiated: "lead" (HTTP route) or "auto-repair-bot". Audited. */
	actor: string;
	executionId: string;
	leadId: string;
	fingerprint?: string;
	phrase?: string;
}

export interface RunnerNudgeOutcome {
	status: number;
	body: {
		nudged: boolean;
		tmuxWindow?: string;
		warning?: string;
		error?: string;
	};
}

export async function attemptRunnerRecoveryNudge(
	input: RunnerNudgeInput,
	deps: RunnerNudgeDeps,
): Promise<RunnerNudgeOutcome> {
	const { store, projects, captureSessionFn } = deps;
	const executionId = input.executionId;
	const leadId = (input.leadId ?? "").trim();
	const fingerprint = input.fingerprint;
	const phrase = typeof input.phrase === "string" ? input.phrase : "continue";

	const audit = (
		result: "attempt" | "sent" | "refused",
		reason: string,
		session?: { issue_id: string; project_name: string },
	): boolean => {
		try {
			store.insertEvent({
				event_id: `recovery-nudge-${executionId}-${deps.now()}-${deps.nextAuditSeq()}`,
				execution_id: executionId,
				issue_id: session?.issue_id ?? "unknown",
				project_name: session?.project_name ?? "unknown",
				event_type: "runner_recovery_nudge",
				severity: result === "refused" ? "warning" : "info",
				source: "bridge.stuck-remanage",
				payload: {
					leadId,
					actor: input.actor,
					fingerprint,
					phrase,
					result,
					reason,
				},
			});
			return true;
		} catch (err) {
			console.error(
				`[recovery-nudge] audit write failed for ${executionId}: ${(err as Error).message}`,
			);
			return false;
		}
	};

	const refuse = (
		status: number,
		reason: string,
		session?: { issue_id: string; project_name: string },
	): RunnerNudgeOutcome => {
		const audited = audit("refused", reason, session);
		if (!audited) {
			return {
				status: 503,
				body: {
					nudged: false,
					error: `${reason} [audit store unavailable — refusal not persisted; fail-closed]`,
				},
			};
		}
		return { status, body: { nudged: false, error: reason } };
	};

	if (!leadId) return refuse(400, "leadId is required in request body");
	// Gate 0: allowlist phrase.
	if (!NUDGE_ALLOWLIST.includes(phrase)) {
		return refuse(
			400,
			`phrase not in allowlist (${NUDGE_ALLOWLIST.join(", ")}) — other instructions must go via mailbox; lifecycle actions are founder-gated (FLY-175)`,
		);
	}
	if (typeof fingerprint !== "string" || !FINGERPRINT_RE.test(fingerprint)) {
		return refuse(
			400,
			"episode_fingerprint must be the 16-hex fingerprint from the runner_stuck_escalation event",
		);
	}

	const session = store.getSession(executionId);
	if (!session) return refuse(404, "Session not found");
	try {
		if (!matchesLead(session, leadId, projects)) {
			return refuse(
				403,
				`Session ${executionId} is outside lead "${leadId}" scope`,
				session,
			);
		}
	} catch (err) {
		return refuse(
			403,
			`Lead scope check failed: ${(err as Error).message}`,
			session,
		);
	}

	// Gate 1: status re-read.
	if (session.status !== "running") {
		return refuse(
			409,
			`status is "${session.status}" — only running sessions can be nudged`,
			session,
		);
	}
	// Gate 2: pending-review gray zone.
	if (session.decision_route === "needs_review") {
		return refuse(
			409,
			"session has a pending review signal (decision_route=needs_review)",
			session,
		);
	}
	// Gate 3: pending CommDB gate question. Fail CLOSED on probe error.
	try {
		if (deps.hasPendingGate(executionId, session.project_name)) {
			return refuse(
				409,
				"runner has an unanswered gate/question — answer it instead of nudging",
				session,
			);
		}
	} catch (err) {
		return refuse(
			503,
			`pending-gate probe failed (${(err as Error).message}) — refusing fail-closed`,
			session,
		);
	}
	// Gate 4: live capture must still show THIS episode AND an idle input box.
	const capture = await captureSessionFn(
		executionId,
		session.project_name,
		100,
	);
	if (isCaptureError(capture)) {
		return refuse(
			503,
			`terminal capture failed (${capture.error}) — refusing fail-closed`,
			session,
		);
	}
	const liveFingerprint = fingerprintOutput(capture.output);
	if (liveFingerprint !== fingerprint) {
		return refuse(
			409,
			"episode fingerprint no longer matches the live terminal (output changed — the runner may have resumed); re-judge from a fresh capture",
			session,
		);
	}
	if (!detectInputBoxPresent(capture.output)) {
		return refuse(
			409,
			"no idle input box visible at the bottom of the terminal — not the stuck-at-prompt shape this nudge is for",
			session,
		);
	}

	// Gate 5: resolve the tmux window.
	const target = deps.getTmuxTarget(executionId, session.project_name);
	if (!target) {
		return refuse(409, "no tmux target found for this execution", session);
	}

	// Audit the attempt BEFORE the keystroke. Audit store down → no keystroke.
	if (
		!audit("attempt", `sending "${phrase}" to ${target.tmuxWindow}`, session)
	) {
		return {
			status: 503,
			body: {
				nudged: false,
				error:
					"audit store unavailable — refusing fail-closed (no keystroke sent)",
			},
		};
	}

	const sendResult = await deps.sendKeys(target.tmuxWindow, phrase);
	if (!sendResult.sent) {
		return refuse(
			502,
			`tmux send failed: ${sendResult.error ?? "unknown"}`,
			session,
		);
	}

	// Implicit handled_remanaged disposition (suppresses Q7). A write failure must
	// NOT report the (already sent) nudge as failed — surface a warning instead.
	let warning: string | undefined;
	try {
		store.setStuckDisposition({
			execution_id: executionId,
			episode_fingerprint: fingerprint,
			disposition: "handled_remanaged",
			noted_by: leadId,
			note: `recovery-nudge "${phrase}" sent to ${target.tmuxWindow} (actor=${input.actor})`,
		});
	} catch (err) {
		warning = `nudge SENT but the handled_remanaged receipt could not be written (${(err as Error).message}) — write the disposition explicitly or Annie will be paged after the grace window`;
		console.error(`[recovery-nudge] ${executionId}: ${warning}`);
	}
	audit("sent", `nudge sent to ${target.tmuxWindow}`, session);
	return {
		status: 200,
		body: {
			nudged: true,
			tmuxWindow: target.tmuxWindow,
			...(warning ? { warning } : {}),
		},
	};
}
