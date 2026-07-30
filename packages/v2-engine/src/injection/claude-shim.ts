import {
	MailboxWriteError,
	writeMailboxEntry,
} from "flywheel-agent-team-transport";
import type { InjectionShim } from "../types.js";
import { encodeInjectionEnvelope } from "./envelope.js";
import {
	type ClaudeInjectionSessionRef,
	parseClaudeSessionRef,
} from "./session-ref.js";

export type { ClaudeInjectionSessionRef };

/**
 * Same ceiling `ClaudeCodeAdapter` enforces in `validatePayloadSize`. Writing
 * through `writeMailboxEntry` reuses the adapter's storage path but not its
 * guard, and nothing upstream caps `MailboxEnvelope.payload`, so an oversized
 * message would land in a stock inbox file that the vendor's poller re-reads
 * in full every second.
 */
const MAX_MAILBOX_CONTENT_BYTES = 1_000_000;

export class ClaudeInjectionShim implements InjectionShim {
	async hint(sessionRef: string): Promise<void> {
		parseClaudeSessionRef(sessionRef);
	}

	async deliver(
		sessionRef: string,
		message: Parameters<InjectionShim["deliver"]>[1],
	): Promise<void> {
		const target = parseClaudeSessionRef(sessionRef);
		const content = encodeInjectionEnvelope(message);
		const size = Buffer.byteLength(content, "utf-8");
		if (size > MAX_MAILBOX_CONTENT_BYTES) {
			throw new MailboxWriteError(
				`Payload size ${size} bytes exceeds adapter cap ${MAX_MAILBOX_CONTENT_BYTES} for recipient ${target.toAgent}`,
				"unknown",
				target.toAgent,
				false,
			);
		}
		// FLY-1503 item 10: key the sidecar on message *and* attempt.
		// Inbox and sidecar paths are per-agent and shared by every activation and
		// generation, so keying on messageUid alone meant that once a message was
		// finalized, redelivering it to a replacement terminal was skipped and
		// reported as idempotent success -- the new terminal silently never received
		// it. Keying on attemptUid alone is not enough either: it would let two
		// distinct messages that share an attempt collapse into one. The pair keeps
		// both invariants -- distinct messages always land, a new generation gets
		// through, and a genuine replay of the same delivery attempt still dedupes.
		const deliveryId = `${message.messageUid}:${message.attemptUid}`;
		await writeMailboxEntry({
			inboxPath: target.inboxPath,
			sidecarPath: target.sidecarPath,
			flywheelId: deliveryId,
			payload: {
				from: "flywheel-v2",
				to: target.toAgent,
				content,
				metadata: { flywheelId: deliveryId },
			},
		});
	}
}
