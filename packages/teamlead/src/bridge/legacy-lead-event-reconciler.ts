/** FLY-1373 boot reconciliation for pre-cutover undelivered lead_events. */

import type { LeadEventRow } from "../StateStore.js";
import type { LeadEventEnvelope } from "./lead-runtime.js";
import { parseLegacyEventPayload } from "./legacy-row-errors.js";

export const REDRIVABLE_LEAD_EVENT_PRIORITY = 2 as const;

export function sqliteTimestampToIso(value: string): string {
	const normalized = value.includes("T")
		? value
		: `${value.replace(" ", "T")}Z`;
	const parsed = new Date(normalized);
	return Number.isFinite(parsed.getTime())
		? parsed.toISOString()
		: "1970-01-01T00:00:00.000Z";
}

/**
 * Rebuild the canonical delivery envelope from the journal row, never from a
 * caller's newer in-memory payload. That makes append→crash→retry byte-stable.
 */
export function leadEventEnvelopeFromJournalRow(
	row: LeadEventRow,
	priority?: LeadEventEnvelope["priority"],
): LeadEventEnvelope {
	return {
		seq: row.seq,
		eventId: row.event_id,
		// FLY-1586 B: typed poison ONLY around this exact parse. Anything wider
		// starts absorbing failures that deserve a retry.
		event: parseLegacyEventPayload(
			row.payload,
			row.seq,
		) as LeadEventEnvelope["event"],
		sessionKey: row.session_key ?? "",
		leadId: row.lead_id,
		timestamp: sqliteTimestampToIso(row.created_at),
		...(priority !== undefined ? { priority } : {}),
	};
}
