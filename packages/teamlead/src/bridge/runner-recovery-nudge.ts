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
// FLY-1282 Part D: a Lead-actor successful nudge prepares a founder-visible
// disposition receipt (machine/auto-repair nudges never do).
import { formatDispositionReceipt } from "./disposition-receipt.js";
import { matchesLead } from "./lead-scope.js";
import {
	detectInputBoxPresent,
	fingerprintOutput,
} from "./pane-fingerprint.js";
import { isCaptureError } from "./session-capture.js";
import type { TmuxTarget } from "./tmux-lookup.js";
import type { CaptureSessionFn } from "./tools.js";

/** The ONLY phrases the recovery nudge may type. Exact match. */
export const NUDGE_ALLOWLIST: readonly string[] = ["continue"];
export const WAKE_POINTER_PHRASE = "你有 pending wake,跑 flywheel-comm inbox";
export const turnPointerPhrase = (executionId: string): string =>
	`TURN pending: run flywheel-comm turn --exec-id ${executionId}`;

/** Episode fingerprints are 16 lowercase hex chars (see fingerprintOutput). */
const FINGERPRINT_RE = /^[0-9a-f]{16}$/;

export interface RunnerNudgeDeps {
	store: StateStore;
	projects: ProjectEntry[];
	captureSessionFn: CaptureSessionFn;
	hasPendingGate: (executionId: string, projectName: string) => boolean;
	/** FLY-1392 wake-pointer-only causal and binding gates. */
	hasCausalResponse?: (
		executionId: string,
		projectName: string,
		questionId: string,
	) => boolean;
	isWakeBindingLive?: (executionId: string, projectName: string) => boolean;
	isTurnWakeBindingLive?: (
		executionId: string,
		projectName: string,
		wakeId: string,
	) => boolean;
	isDeclaredParked?: (executionId: string, projectName: string) => boolean;
	isEngineParked?: (executionId: string, projectName: string) => boolean;
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
	mode?: "recovery" | "wake_pointer" | "turn_pointer";
	/** Who initiated: "lead" (HTTP route) or "auto-repair-bot". Audited. */
	actor: string;
	executionId: string;
	leadId: string;
	fingerprint?: string;
	phrase?: string;
	causalQuestionId?: string;
	turnWakeId?: string;
}

export interface RunnerNudgeOutcome {
	status: number;
	body: {
		nudged: boolean;
		tmuxWindow?: string;
		warning?: string;
		error?: string;
		/**
		 * FLY-1282 Part D: the keystroke cannot roll back with the DB
		 * transaction — nudged:true + dispositionPersisted:false is the HONEST
		 * shape when the send succeeded but the disposition/receipt transaction
		 * failed (the Lead should re-nudge or write the disposition explicitly).
		 */
		dispositionPersisted?: boolean;
	};
}

export async function attemptRunnerRecoveryNudge(
	input: RunnerNudgeInput,
	deps: RunnerNudgeDeps,
): Promise<RunnerNudgeOutcome> {
	const { store, projects, captureSessionFn } = deps;
	const executionId = input.executionId;
	const leadId = (input.leadId ?? "").trim();
	const mode = input.mode ?? "recovery";
	const fingerprint = input.fingerprint;
	const phrase =
		mode === "wake_pointer"
			? WAKE_POINTER_PHRASE
			: mode === "turn_pointer"
				? turnPointerPhrase(executionId)
				: typeof input.phrase === "string"
					? input.phrase
					: "continue";

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
					mode,
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
	if (mode === "recovery" && !NUDGE_ALLOWLIST.includes(phrase)) {
		return refuse(
			400,
			`phrase not in allowlist (${NUDGE_ALLOWLIST.join(", ")}) — other instructions must go via mailbox; lifecycle actions are founder-gated (FLY-175)`,
		);
	}
	if (typeof fingerprint !== "string" || !FINGERPRINT_RE.test(fingerprint)) {
		return refuse(
			400,
			"episode_fingerprint must be the 16-hex fingerprint from the active detection episode",
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
	const wakePointerStatusAllowed =
		mode === "wake_pointer" &&
		(session.status === "awaiting_review" ||
			session.status === "approved_to_ship" ||
			session.status === "design_done" ||
			session.status === "ship_parked" ||
			(session.status === "running" &&
				(deps.isDeclaredParked?.(executionId, session.project_name) === true ||
					deps.isEngineParked?.(executionId, session.project_name) === true)));
	if (
		(mode === "recovery" && session.status !== "running") ||
		(mode === "wake_pointer" && !wakePointerStatusAllowed)
	) {
		return refuse(
			409,
			mode === "wake_pointer"
				? `status is "${session.status}" without a durable park — wake pointers require parked/ship_parked/design_done/awaiting_review`
				: `status is "${session.status}" — only running sessions can be nudged`,
			session,
		);
	}
	// Gate 2: pending-review gray zone.
	if (mode === "recovery" && session.decision_route === "needs_review") {
		return refuse(
			409,
			"session has a pending review signal (decision_route=needs_review)",
			session,
		);
	}
	if (mode === "wake_pointer") {
		const questionId = input.causalQuestionId?.trim();
		try {
			if (
				questionId &&
				!deps.hasCausalResponse?.(executionId, session.project_name, questionId)
			) {
				return refuse(
					409,
					"causal question has no terminal response — refusing wake pointer",
					session,
				);
			}
			if (!deps.isWakeBindingLive?.(executionId, session.project_name)) {
				return refuse(409, "runner wake binding is no longer live", session);
			}
		} catch (err) {
			return refuse(
				503,
				`wake-pointer causal probe failed (${(err as Error).message}) — refusing fail-closed`,
				session,
			);
		}
	}
	if (mode === "turn_pointer") {
		const wakeId = input.turnWakeId?.trim();
		if (!wakeId) {
			return refuse(400, "turnWakeId is required for a TURN pointer", session);
		}
		try {
			if (
				!deps.isTurnWakeBindingLive?.(executionId, session.project_name, wakeId)
			) {
				return refuse(
					409,
					"runner TURN wake binding is no longer live",
					session,
				);
			}
		} catch (err) {
			return refuse(
				503,
				`TURN-pointer binding probe failed (${(err as Error).message}) — refusing fail-closed`,
				session,
			);
		}
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
	if (target.tmuxWindow.endsWith(":pending")) {
		return refuse(
			409,
			"tmux window identity is still pending — refusing an ambiguous keystroke",
			session,
		);
	}
	if (
		mode === "wake_pointer" &&
		session.status === "running" &&
		deps.isDeclaredParked?.(executionId, session.project_name) !== true &&
		deps.isEngineParked?.(executionId, session.project_name) !== true
	) {
		return refuse(
			409,
			"durable park was fenced before send — refusing stale wake pointer",
			session,
		);
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
	// NOT report the (already sent) nudge as failed — the keystroke cannot be
	// rolled back with the DB transaction, so the boundary is HONESTLY
	// non-atomic: nudged:true + dispositionPersisted:false + loud log
	// (FLY-1282 Part D, Codex R18 #1 recovery contract).
	if (mode === "wake_pointer" || mode === "turn_pointer") {
		audit("sent", `wake pointer sent to ${target.tmuxWindow}`, session);
		return {
			status: 200,
			body: { nudged: true, tmuxWindow: target.tmuxWindow },
		};
	}

	let warning: string | undefined;
	let dispositionPersisted = true;
	const nudgeNote = `recovery-nudge "${phrase}" sent to ${target.tmuxWindow} (actor=${input.actor})`;
	try {
		if (input.actor === "lead") {
			// FLY-1282 Part D: a Lead-driven successful nudge IS a Lead
			// disposition — the stuck write, the unified case-c episode ack AND
			// the founder-visible receipt prepare commit in ONE transaction.
			// The auto-repair bot below stays receipt-free (a machine action is
			// not a Lead disposition).
			store.applyStuckDispositionWithReceipts({
				stuck: {
					execution_id: executionId,
					episode_fingerprint: fingerprint,
					disposition: "handled_remanaged",
					noted_by: leadId,
					note: nudgeNote,
				},
				episodes: [
					{
						targetKey: executionId,
						kind: "detection_stuck_confirmed",
						episodeFingerprint: fingerprint,
						disposition: "resolve",
					},
				],
				atMs: deps.now(),
				receipt: {
					actorLeadId: leadId,
					rawDisposition: "handled_remanaged",
					content: formatDispositionReceipt({
						actorLeadId: leadId,
						kind: "detection_stuck_confirmed",
						rawDisposition: "handled_remanaged",
						note: `已向 Runner 发送恢复指令「${phrase}」`,
					}),
					executionId,
					projectName: session.project_name,
				},
			});
		} else {
			store.setStuckDisposition({
				execution_id: executionId,
				episode_fingerprint: fingerprint,
				disposition: "handled_remanaged",
				noted_by: leadId,
				note: nudgeNote,
			});
		}
	} catch (err) {
		dispositionPersisted = false;
		warning = `nudge SENT but the handled_remanaged receipt could not be written (${(err as Error).message}) — write the disposition explicitly or Annie will be paged after the grace window`;
		console.error(`[recovery-nudge] ${executionId}: ${warning}`);
	}
	audit("sent", `nudge sent to ${target.tmuxWindow}`, session);
	return {
		status: 200,
		body: {
			nudged: true,
			tmuxWindow: target.tmuxWindow,
			dispositionPersisted,
			...(warning ? { warning } : {}),
		},
	};
}
