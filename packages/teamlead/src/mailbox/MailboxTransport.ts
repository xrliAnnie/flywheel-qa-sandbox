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
	 * **Codex r1 PR 1.3 HIGH #1**: ALWAYS calls `verifyLastWrite`, including
	 * on the idempotent-skip path. The adapter's `idempotent: true` does NOT
	 * guarantee a finalized main-file entry exists — `ClaudeMailboxCodec`
	 * returns idempotent for both finalized AND recent (<60s) pending
	 * sidecar records, the latter meaning the original writer is still in
	 * flight (or died before finalizing). If we skip verify, a concurrent
	 * retry on a pending-but-not-yet-finalized id would incorrectly report
	 * success even though no inbox entry exists. Always verifying catches
	 * that gap — for a real finalized hit, verify passes; for a pending hit
	 * where main is still empty, verify throws `verify_mismatch` (caller can
	 * retry or fall back).
	 */
	async writeVerified(args: WriteVerifiedArgs): Promise<WriteVerifiedResult> {
		const writeResult = await this.transport.write({
			leadName: args.leadName,
			recipient: args.recipient,
			payload: args.payload,
		});

		// Verify regardless of idempotent flag — see HIGH #1 contract above.
		// Adapter throws `MailboxWriteError` with code `verify_mismatch` if
		// the main file's last entry doesn't match expected payload.
		await this.transport.verifyLastWrite({
			leadName: args.leadName,
			recipient: args.recipient,
			expected: args.payload,
		});

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
