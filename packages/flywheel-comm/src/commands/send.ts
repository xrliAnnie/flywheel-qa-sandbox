import { CommDB } from "../db.js";
import { wakeRunnerMailbox } from "../wake.js";

export interface SendArgs {
	fromAgent: string;
	/** Full execution id, or (FLY-3083) the Runner mailbox short name
	 *  "runner-<8hex>" — resolved against the sending Lead's sessions. */
	toAgent: string;
	content: string;
	dbPath: string;
}

/**
 * FLY-3083: what `send` did, surfaced so a Lead (`send --json`) can tell a
 * rollback-mode skip from a transport failure. `transportWrite` is a TRANSPORT
 * fact, never a consumption ack:
 *   ok      — CommDB row written AND the Runner transport write returned ok
 *   skipped — CommDB row written; no transport write by design
 *             (backend_commdb = rollback mode, Runner reads CommDB;
 *              no_transport   = vendor "none" backend, e.g. antigravity/kimi;
 *              no_session_lead = session row missing/without lead_id)
 *   error   — CommDB row written; the transport write failed (wakeError)
 */
export interface SendResult {
	instructionId: string;
	/** The resolved recipient (full execution id when a short name was given). */
	executionId: string;
	transportWrite: "ok" | "skipped" | "error";
	skippedReason?: "backend_commdb" | "no_session_lead" | "no_transport";
	wakeError?: string;
	/** @deprecated alias: transportWrite === "ok". NOT a consumption ack. */
	delivered: boolean;
}

/**
 * Send a Lead → Runner instruction.
 *
 * CommDB write is the durable record (audit + rollback substrate) and ALWAYS
 * happens first. In mailbox mode (default) we ALSO write the Runner's
 * claude-code Agent Team inbox so its stock `useInboxPoller` wakes an idle
 * Runner — FLY-168 fixes the transport gap where a sentinel-equipped idle
 * Runner never saw the CommDB-only instruction (the PostToolUse hook short-
 * circuits to a no-op when the mailbox sentinel is present).
 *
 * The mailbox write is BEST-EFFORT: failures are logged to stderr and never
 * block the CommDB write. CommDB is NOT an active mailbox-mode delivery
 * fallback (the sentinel keeps the hook inert) — it is the audit/rollback
 * record. On a mailbox-write failure the operational recovery is the loud
 * stderr log plus rollback / manual resend.
 *
 * Returns the CommDB message id. Async because the mailbox write is async;
 * stdout is reserved for the caller's id/JSON output, so all diagnostics here
 * go to stderr only.
 */
export async function send(args: SendArgs): Promise<string> {
	return (await sendDetailed(args)).instructionId;
}

/**
 * FLY-3083: `send` with the transport result exposed (see SendResult). A
 * short-name recipient that does not resolve to exactly one of the sending
 * Lead's sessions throws BEFORE anything is written.
 */
export async function sendDetailed(args: SendArgs): Promise<SendResult> {
	const db = new CommDB(args.dbPath);
	try {
		const execId = db.resolveExecutionId(args.toAgent, {
			leadId: args.fromAgent,
		});
		const id = db.insertInstruction(args.fromAgent, execId, args.content);
		const result = (
			transportWrite: SendResult["transportWrite"],
			extra: Pick<SendResult, "skippedReason" | "wakeError"> = {},
		): SendResult => ({
			instructionId: id,
			executionId: execId,
			transportWrite,
			...extra,
			delivered: transportWrite === "ok",
		});

		// FLY-626: a Lead/founder instruction to the runner is a RE-ENGAGEMENT —
		// it clears any self-declared park/busy marker so the stall watchdogs
		// resume normal monitoring. Without this, an indefinite `park` could
		// survive re-engagement and keep suppressing runner_idle_detected /
		// session_stuck for a runner that is no longer intentionally parked
		// (Codex code-review #1 — protects the FLY-369 "never silently hide a
		// genuinely stuck runner" posture). No-op when no marker exists.
		db.clearDeclaredState(execId);

		// FLY-191: wake logic extracted to wake.ts (shared with the approval
		// write-sites). Semantics unchanged from FLY-168: best-effort, CommDB
		// row is the durable record, diagnostics to stderr only.
		//
		// FLY-208 B: the Runner-visible wake text is prefixed with the CommDB
		// message id. The stock claude-code inbox poller is at-least-once
		// (markRead is fire-and-forget; the busy-path requeue has no dedup), so
		// the same instruction can be injected twice — the prefix lets the
		// Runner recognize a re-delivery and idempotent-skip per protocol. The
		// prefix is applied HERE (send-specific), NOT in wake.ts, which is
		// shared with the approval write-sites whose wake text must stay
		// undecorated. The CommDB row keeps the ORIGINAL content (audit without
		// transport decoration).
		//
		// FLY-1188: route the wake by the TARGET runner's registered transport
		// vendor (session row, written at spawn — dispatcher pre-registration
		// AND adapter self-registration both carry it) so a codex runner's
		// instruction reaches the codex mailbox — the process-wide env default
		// is locked to claude-code and misrouted every Lead `send` to a codex
		// runner (the /eleven "Lead couldn't wake turn-1" incident). Only a
		// NULL vendor (legacy row) keeps the env fallback; any other string —
		// including "" — flows through so an unknown vendor is a LOUD wake
		// error (never a silent claude fallback), surfaced via the stderr
		// path below.
		const targetVendor = db.getSession(execId)?.vendor;
		if (targetVendor === "none") {
			// No-transport backend (antigravity/kimi): there is NO mailbox to
			// wake. Loud skip — the CommDB row above stays the durable record,
			// and delivered_at is NEVER set (nothing was delivered). Writing
			// the env-default claude inbox here would fake delivery.
			console.error(
				`[flywheel-comm send] runner ${execId} uses a no-transport backend (vendor="none") — no mailbox wake is possible; instruction recorded in CommDB only`,
			);
			return result("skipped", { skippedReason: "no_transport" });
		}
		const wake = await wakeRunnerMailbox({
			db,
			execId,
			fromAgent: args.fromAgent,
			content: `[lead-instruction ${id}]\n${args.content}`,
			metadata: { flywheelId: id, execId },
			...(targetVendor != null && { backend: targetVendor }),
		});
		if (wake.ok) {
			// FLY-208 B: delivered_at = "transport write returned ok" (raw
			// write — wakeRunnerMailbox does not verify). Closes the audit gap
			// where a delivered-and-acted-on instruction was indistinguishable
			// from one that never left CommDB (read_at NULL + delivered_at
			// NULL, the incident signature). read_at intentionally NOT set: in
			// mailbox mode there is no reliable Runner-side ack point, and we
			// don't fake one. Reuses the FLY-109 column + helper — no second
			// marking scheme.
			db.markInstructionDelivered(id);
			return result("ok");
		}
		if (wake.skippedReason === "no_session_lead") {
			console.warn(
				`[flywheel-comm send] no session/lead_id for ${execId}; mailbox wake skipped (CommDB instruction written)`,
			);
		} else if (wake.error) {
			console.error(
				`[flywheel-comm send] mailbox wake failed for ${execId}: ${wake.error}`,
			);
			return result("error", { wakeError: wake.error });
		}
		if (wake.skippedReason) {
			return result("skipped", { skippedReason: wake.skippedReason });
		}
		// ok=false with neither a skip reason nor an error is not a shape
		// wakeRunnerMailbox produces; report it as a transport error rather
		// than pretend it was skipped by design.
		return result("error", {
			wakeError: "wake returned ok=false without a reason",
		});
	} finally {
		db.close();
	}
}
