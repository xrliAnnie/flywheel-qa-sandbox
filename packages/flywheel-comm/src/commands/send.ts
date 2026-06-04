import { CommDB } from "../db.js";
import { wakeRunnerMailbox } from "../wake.js";

export interface SendArgs {
	fromAgent: string;
	toAgent: string;
	content: string;
	dbPath: string;
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
	const db = new CommDB(args.dbPath);
	try {
		const id = db.insertInstruction(args.fromAgent, args.toAgent, args.content);

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
		const wake = await wakeRunnerMailbox({
			db,
			execId: args.toAgent,
			fromAgent: args.fromAgent,
			content: `[lead-instruction ${id}]\n${args.content}`,
			metadata: { flywheelId: id, execId: args.toAgent },
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
		} else if (wake.skippedReason === "no_session_lead") {
			console.warn(
				`[flywheel-comm send] no session/lead_id for ${args.toAgent}; mailbox wake skipped (CommDB instruction written)`,
			);
		} else if (wake.error) {
			console.error(
				`[flywheel-comm send] mailbox wake failed for ${args.toAgent}: ${wake.error}`,
			);
		}

		return id;
	} finally {
		db.close();
	}
}
