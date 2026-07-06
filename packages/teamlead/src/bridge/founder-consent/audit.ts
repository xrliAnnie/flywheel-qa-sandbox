/**
 * FLY-175 Track 2 — Bridge-side audit helpers.
 *
 * The audit STORE (schema + better-sqlite3 file) lives in `flywheel-comm`
 * (`FounderConsentAuditStore`) because two processes write it — Bridge and the
 * `flywheel-comm` CLI bypass path. This module is the teamlead-side surface:
 * a tiny opener + redaction for the read-only debug endpoint.
 */

import {
	type AuditDecision,
	type AuditDecisionSource,
	type FounderConsentAuditRow,
	FounderConsentAuditStore,
} from "flywheel-comm/db";

export type { AuditDecision, AuditDecisionSource, FounderConsentAuditRow };
export { FounderConsentAuditStore };

/** Open (or create) the audit store at the given path. */
export function openAuditStore(dbPath: string): FounderConsentAuditStore {
	return new FounderConsentAuditStore(dbPath);
}

/**
 * Columns redacted before returning audit rows over the debug HTTP endpoint.
 * `llm_raw_response` can contain verbatim founder chat content; the debug view
 * keeps the structured decision but drops the raw blob (plan §12.1 audit.test).
 */
const REDACTED_COLUMNS = new Set(["llm_raw_response"]);

export function redactAuditRow(
	row: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(row)) {
		out[k] = REDACTED_COLUMNS.has(k) ? (v == null ? null : "[redacted]") : v;
	}
	return out;
}
