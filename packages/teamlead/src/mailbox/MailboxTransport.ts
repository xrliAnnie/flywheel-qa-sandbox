/**
 * MailboxTransport — high-level wrapper around `IMailboxWriter` +
 * `IMailboxReader` from the vendor-neutral `agent-team-transport` package.
 *
 * Per plan v1.27.1 §B-1 (PR 1.3 — no-behavior-flip):
 *
 * Adds two semantic guarantees over the raw adapter:
 *   1. **writeVerified**: write + immediate read-after-write check that the
 *      last entry matches the expected payload. Throws `MailboxWriteError`
 *      with code `verify_mismatch` on inconsistency. Implements §2.7 of
 *      the plan (Codex r1 finding #9 — `writeToMailbox()` swallows errors
 *      silently, so wrappers can't reliably retry).
 *   2. **readUnreadFromInbox**: thin wrapper around
 *      `transport.readUnread(...)` so the call site uses MailboxTransport
 *      as the single mailbox interface (no direct `transport.readUnread`
 *      calls needed in Bridge daemon code in PR 1.4).
 *
 * **PR 1.3 scope (no-behavior-flip)**: this class exists but no Bridge code
 * calls it yet. PR 1.4 cutover will switch `actions.ts` and
 * `event-route.ts` ordinary-DM paths to use `mailboxTransport.writeVerified`
 * instead of `flywheel-comm send` subprocess.
 *
 * Default `FLYWHEEL_COMM_BACKEND=commdb` stays through PR 1.3 — wake bug
 * NOT fixed yet.
 */

import {
	type IAgentTeamTransport,
	type MailboxMessage,
	type MailboxPayload,
	MailboxWriteError,
} from "flywheel-agent-team-transport";

export interface WriteVerifiedArgs {
	leadName: string;
	recipient: string;
	payload: MailboxPayload;
}

export interface WriteVerifiedResult {
	flywheelId?: string;
	idempotent: boolean;
	wroteAt: number;
}

export class MailboxTransport {
	constructor(private readonly transport: IAgentTeamTransport) {}

	/**
	 * Write a message + verify the last entry matches what we wrote.
	 *
	 * Throws `MailboxWriteError` (code `verify_mismatch` or whatever the
	 * adapter raised). Caller should catch and decide whether to retry,
	 * fall back to CommDB write (Phase D dual-write), or alert.
	 *
	 * Idempotent on retry if the caller passes `payload.metadata.flywheelId`
	 * (sidecar dedupe per §2.0.6 — caller-provided stable key).
	 *
	 * **Codex r1 → r2 PR 1.3 HIGH #1 contract** (final after R2 fix):
	 *
	 * Skip-verify is conditioned on BOTH `idempotent: true` AND
	 * `finalized: true`:
	 *
	 * - `idempotent: true, finalized: true` → durable prior write exists in
	 *   main (even if no longer last entry — newer messages may have been
	 *   appended). Caller's intent satisfied; skip verify (R1 always-verify
	 *   would have falsely failed because verifyLastWrite checks LAST entry).
	 * - `idempotent: true, finalized: false` → recent <60s pending sidecar;
	 *   main may still be empty (in-flight writer or crashed). Verify will
	 *   throw `verify_mismatch` if main empty — caller retries or falls back.
	 *   This catches the R1 HIGH #1 gap where pending was indistinguishable.
	 * - `idempotent: false` → we just wrote it. Always verify (caught silent
	 *   partial-write per Codex r1 #9 from PR #177 plan review).
	 * - `idempotent: true, finalized: undefined` → adapter doesn't track
	 *   finalization. Verify defensively (treat as `false`).
	 */
	async writeVerified(args: WriteVerifiedArgs): Promise<WriteVerifiedResult> {
		const writeResult = await this.transport.write({
			leadName: args.leadName,
			recipient: args.recipient,
			payload: args.payload,
		});

		// Skip verify ONLY for confirmed-finalized idempotent hits — see
		// HIGH #1 contract above.
		const safeToSkipVerify =
			writeResult.idempotent && writeResult.finalized === true;
		if (!safeToSkipVerify) {
			// Adapter throws `MailboxWriteError` with code `verify_mismatch`
			// if the main file's last entry doesn't match expected payload.
			await this.transport.verifyLastWrite({
				leadName: args.leadName,
				recipient: args.recipient,
				expected: args.payload,
			});
		}

		return {
			flywheelId: writeResult.flywheelId,
			idempotent: writeResult.idempotent,
			wroteAt: writeResult.wroteAt,
		};
	}

	/**
	 * Read all unread messages for the given agent inbox.
	 *
	 * Vendor-neutral: claude-code returns entries with stock
	 * `{from, text, timestamp, read}` shape mapped into `MailboxMessage`;
	 * future Codex adapter would return its own decoded shape via the
	 * same interface.
	 */
	async readUnreadFromInbox(args: {
		leadName: string;
		agentName: string;
	}): Promise<MailboxMessage[]> {
		return this.transport.readUnread(args);
	}

	/**
	 * Mark a set of messages as `read=true` (consumed). Vendor-neutral —
	 * claude-code flips `read=true` in the main file; Codex would track
	 * via its own ack mechanism.
	 */
	async ackMessages(args: {
		leadName: string;
		agentName: string;
		messageIds: string[];
	}): Promise<void> {
		await this.transport.ack(args);
	}

	/** Re-export typed error so call sites can `instanceof` check. */
	static isWriteError(err: unknown): err is MailboxWriteError {
		return err instanceof MailboxWriteError;
	}
}
