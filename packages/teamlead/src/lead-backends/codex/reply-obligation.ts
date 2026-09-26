/**
 * FLY-2862 — does a Codex Lead journal entry owe its sender a reply?
 *
 * Decides how an EMPTY final answer closes (LeadInputRouter): an inbound that
 * owes nothing (a Bridge tick, a peer Lead's acknowledgement) closes as silent;
 * one that owes a reply (a founder message, any voice-room turn) is a failure the
 * voice side must hear about. Both signals are Bridge-authored and cannot be
 * forged by message text: the batch header is written before any body, and the
 * chat renderer escapes `<` in the body, so a body cannot open a channel tag.
 */
import { mailboxBatchSender } from "../../bridge/mailbox-batch-header.js";
import type { JournalEntry } from "./LeadJournal.js";

export type ReplyObligation = "owed" | "not_owed";

/** Opening tag flywheel-comm's renderDiscordChatContent gives a voice transcript. */
const VOICE_CHANNEL_TAG = /<channel source="voice"[\s>]/;

export function replyObligation(
	entry: Pick<JournalEntry, "source" | "payload">,
): ReplyObligation {
	if (entry.source !== "mailbox") return "not_owed";
	if (VOICE_CHANNEL_TAG.test(entry.payload)) return "owed";
	return mailboxBatchSender(entry.payload) === "founder" ? "owed" : "not_owed";
}
