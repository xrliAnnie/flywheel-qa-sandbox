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
		await writeMailboxEntry({
			inboxPath: target.inboxPath,
			sidecarPath: target.sidecarPath,
			flywheelId: message.messageUid,
			payload: {
				from: "flywheel-v2",
				to: target.toAgent,
				content,
				metadata: { flywheelId: message.messageUid },
			},
		});
	}
}
