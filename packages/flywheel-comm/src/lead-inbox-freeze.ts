/**
 * FLY-1586 F — stock freeze by `seq` watermark.
 *
 * ## Why the fix is more dangerous than the bug
 *
 * Once the poison row stops aborting the cutover, delivery resumes and flushes
 * the whole backlog. That backlog holds 40 undelivered `founder_msg` rows that
 * were already acted on — including `answer="ship"` for FLY-1569, whose PR
 * merged two minutes later. Restoring delivery therefore REPLAYS a founder
 * instruction that has already been executed.
 *
 * ## The shape: a one-time data marking, not a runtime gate
 *
 * `lead_inbox.seq` is `INTEGER PRIMARY KEY AUTOINCREMENT` — strictly monotonic,
 * never reused. So: take `max(seq)` as a watermark, mark the undelivered rows at
 * or below it, and every existing delivery query skips them on its own, because
 * they all already filter `consumed_at IS NULL`. New rows get higher seq and
 * flow untouched.
 *
 * Two earlier designs were prototyped and rejected (plan §1b.16):
 *
 *  - A runtime "no epoch ⇒ refuse to claim" gate coupled EVERY `LeadInboxQueue`
 *    consumer to this issue — a permanent cost for a one-time cleanup.
 *  - Installing that epoch during owner acquisition removed the coupling but made
 *    the gate practically unreachable. A safety mechanism that exists and can
 *    never fire is worse than none: it makes people believe there is a guard.
 *
 * The watermark needs neither. Zero consumer coupling, zero query changes.
 *
 * ## `seq`, never a timestamp
 *
 * `created_at` is NOT insertion time — the legacy reconciler writes the SOURCE
 * EVENT's historical timestamp into it, so a row inserted seconds ago can carry
 * a timestamp from days earlier. It is also mixed-format across writers, which
 * is exactly how FLY-1589 went blind (two timestamp formats in one column plus
 * naive string comparison). The watermark is clock-free on purpose.
 *
 * ## The marking stays truthful
 *
 * A frozen row gets `consumed_at` and `disposition = 'frozen_fly1586'`.
 * `delivered_at` is deliberately left NULL: the row was NOT delivered, and
 * nothing here may imply it was. "Was this delivered?" must keep answering
 * honestly — the inability to answer that is what made the original incident
 * unresolvable 61 hours later.
 */

/** Marks a row parked by this incident. Also the export filter. */
export const FREEZE_DISPOSITION = "frozen_fly1586";

export interface FreezeStockResult {
	/** `max(seq)` at freeze time. Rows at or below it were candidates. */
	watermark: number;
	/** How many rows this call froze (0 on a re-run — it is idempotent). */
	frozen: number;
}

export interface FrozenStockRow {
	seq: number;
	id: string;
	to_lead: string;
	source: string;
	type: string;
	biz_class: string;
	created_at: string;
	ref_message_id: string | null;
}

/**
 * Derive the business class from the columns that actually carry it.
 *
 * ⚠️ `msg_class` is NOT this, and getting it wrong is not a no-op. Its schema
 * CHECK allows only `'protocol' | 'model'`, so a filter written as
 * `WHERE msg_class = 'founder_msg'` matches zero rows — forever, silently. In a
 * freeze filter that is **fail-OPEN**: every founder message sails through.
 * (Recorded as a defect in plan §1b.16; the Lead flagged the same trap
 * independently in instruction 22839940.)
 *
 * `source` is preferred over the id prefix because `enqueueHubRoot` writes
 * `source` itself, whereas the id is minted by the caller.
 */
export function bizClassOf(row: {
	id: string;
	source: string;
	type: string;
}): string {
	if (row.source === "founder_reply" || row.type === "founder_reply") {
		return "founder_msg";
	}
	if (row.source.startsWith("question:")) return "question";
	if (row.source.startsWith("lead_event:")) return "lead_event";
	if (row.source === "discord_chat") return "chat";
	if (row.type === "ack_receipt") return "ack";
	if (row.id.startsWith("protocol_alert:")) return "protocol_alert";
	return "other";
}

/**
 * Which rows are stock.
 *
 * - `carrier = 'inbox'` — the external lane is a different transport and was
 *   never wedged; touching it would only widen the blast radius.
 * - `msg_class = 'model'` — protocol rows are ACK receipts. An ACK records that
 *   something already happened; settling one late is safe, whereas discarding it
 *   would leave escalation state permanently wrong.
 * - `delivered_at IS NULL` — a row that already went out is not stock we are
 *   holding back, and re-marking it would corrupt its history.
 * - `consumed_at IS NULL` — makes the operation idempotent for free.
 */
export const FREEZE_CANDIDATE_PREDICATE = `carrier = 'inbox'
			 AND msg_class = 'model'
			 AND delivered_at IS NULL
			 AND consumed_at IS NULL
			 AND seq <= ?`;

/**
 * FLY-1586 A §3.4 — append-only record of every content repair.
 *
 * A separate table, not a column on `lead_inbox`: the "do not change the schema"
 * constraint is about `lead_inbox` itself, and an append-only log of historical
 * events does not belong on the row it describes anyway (one row can be repaired
 * once, but the record must survive independently of the row's later lifecycle).
 */
export const SANITATION_AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS lead_inbox_sanitation_audit (
  inbox_id        TEXT PRIMARY KEY,
  to_lead         TEXT NOT NULL,
  field           TEXT NOT NULL,
  replacements    INTEGER NOT NULL,
  original_digest TEXT NOT NULL,
  repaired_at     TEXT NOT NULL
);
`;

export interface SanitationAuditRow {
	inbox_id: string;
	to_lead: string;
	field: string;
	replacements: number;
	original_digest: string;
	repaired_at: string;
}

/** Deterministic — a random id would let each process install its own. */
export const FREEZE_INSTALL_ID = "FLY-1586.v1";

/**
 * FLY-1586 F — durable record that the one-time freeze already ran.
 *
 * Without this the operation is not one-shot: `MAX(seq)` is recomputed on every
 * call, so wiring it into boot would freeze whatever arrived since the last boot
 * — turning a one-time cleanup into a permanent message shredder. The stored
 * watermark is the authority; re-entry reuses it and never recomputes.
 */
export const FREEZE_INSTALL_SCHEMA = `
CREATE TABLE IF NOT EXISTS lead_inbox_freeze_install (
  install_id   TEXT PRIMARY KEY,
  watermark    INTEGER NOT NULL,
  frozen_count INTEGER NOT NULL,
  installed_at TEXT NOT NULL
);
`;

export interface FreezeInstallRow {
	install_id: string;
	watermark: number;
	frozen_count: number;
	installed_at: string;
}

/**
 * FLY-1586 BLOCKER-2 (code review R1) — fence pre-watermark resend roots.
 *
 * The freeze targets UNDELIVERED rows, but `advanceDueUnprocessedReceipts()`
 * picks roots that were already delivered and are still unprocessed, and mints a
 * fresh `msg_class='model'` child whose content STARTS WITH the original payload.
 * For a pre-incident founder row that is the founder's instruction, re-delivered
 * above the watermark where the freeze cannot see it. `LeadReceiptPatrol` runs
 * this in production.
 *
 * Clearing `next_unprocessed_at` removes them from the candidate set without
 * asserting anything untrue: it does not claim the row was processed, delivered,
 * or disposed — only that we will not auto-chase a pre-incident receipt. The
 * follow-up triage issue decides what to do with them.
 */
export const FREEZE_RESEND_ROOT_PREDICATE = `carrier = 'inbox'
			 AND resend_of IS NULL
			 AND next_unprocessed_at IS NOT NULL
			 AND processed_at IS NULL
			 AND disposed_at IS NULL
			 AND seq <= ?`;

/**
 * FLY-1586 BLOCKER (code review R2) — the durable fenced-root set.
 *
 * My first fence just nulled `next_unprocessed_at` on pre-watermark roots. That
 * was undone the moment receipt activation ran: it re-stamps the timer with
 * `COALESCE(next_unprocessed_at, ?)`, so the fence lasted until the next
 * activation and the patrol then minted a post-watermark child starting with the
 * old founder instruction.
 *
 * A cleared column is not a fence — it is a value someone else will fill in. The
 * fence has to be its own durable fact.
 *
 * Membership is EXPLICIT IDs captured once at install, deliberately not a
 * predicate re-evaluated at each use: a predicate evaluated later can match rows
 * that did not exist when the boundary was drawn.
 */
export const FENCED_ROOT_SCHEMA = `
CREATE TABLE IF NOT EXISTS lead_inbox_fenced_root (
  inbox_id  TEXT PRIMARY KEY,
  fenced_at TEXT NOT NULL
);
`;

/**
 * Rows enrolled into the fence at install.
 *
 * Note what is NOT here: any condition on `next_unprocessed_at`. Whether the
 * timer happens to be set right now is irrelevant — activation can set it later,
 * and that was precisely the bug. Eligibility is about what the row IS, not
 * about a timer's current value.
 *
 * The `seq <= ?` bound is what makes enumerating by predicate safe here: it is a
 * strictly monotonic primary key, so the set cannot grow after the watermark is
 * taken. Rows created later are, by construction, outside it.
 */
export const FENCED_ROOT_CANDIDATE_PREDICATE = `carrier = 'inbox'
			 AND resend_of IS NULL
			 AND delivered_at IS NOT NULL
			 AND processed_at IS NULL
			 AND disposed_at IS NULL
			 AND receipt_exempt_reason IS NULL
			 AND seq <= ?`;

/** Applied wherever a receipt selector could revive a pre-watermark root. */
export const NOT_FENCED = (alias: string): string =>
	`NOT EXISTS (SELECT 1 FROM lead_inbox_fenced_root fr WHERE fr.inbox_id = ${alias}.id)`;
