import { InboxWriteValidationError } from "flywheel-comm/inbox-write-normalize";

/**
 * FLY-1586 B — typed boundary for per-row isolation during legacy cutover.
 *
 * ## Why a bare try/catch is the wrong tool here
 *
 * The reconciler's per-row body is not "parse some JSON". It performs StateStore
 * and CommDB reads and writes, owner-fenced queue operations, and a legacy
 * filesystem probe. Wrapping all of that in `catch { quarantine() }` would treat
 * `SQLITE_BUSY`, a disk blip, or a lost owner lease as deterministic poison and
 * permanently discard a REAL notification — trading one outage for silent
 * message loss, which is strictly worse because nobody would notice.
 *
 * ## The rule
 *
 * Quarantine ONLY errors we minted on purpose, at a known narrow site:
 *
 * | Error | Verdict | Why |
 * |---|---|---|
 * | `LegacyRowPoisonError` | quarantine | Minted around the exact `JSON.parse` call. Deterministic: it will fail identically forever. |
 * | `InboxWriteValidationError` (from A) | quarantine | A corrupt routing/identity key. Also deterministic. |
 * | `SQLITE_*` / I/O / owner fence / anything else | **rethrow** | Might succeed next tick. The existing retry path owns these. |
 *
 * The verdict is taken from the error TYPE, never from its message text. Text
 * matching is exactly how a transient failure gets mistaken for poison: a
 * `SQLITE_BUSY` whose message happens to mention JSON would be discarded.
 *
 * The default for anything unrecognised is **rethrow**. Wedging is loud and
 * recoverable; dropping a notification is silent and is not.
 */

export type LegacyRowPoisonReason =
	| "invalid_payload_json"
	/**
	 * R2 HIGH-3 — this id already holds a row that genuinely differs. It will
	 * differ identically on every future attempt, so it is deterministic; the
	 * previous code reported it as a lost owner lease, i.e. as transient, and the
	 * cutover retried it forever.
	 */
	| "terminal_conflict";

/** Deterministic bad row: it will fail the same way on every future attempt. */
export class LegacyRowPoisonError extends Error {
	readonly reason: LegacyRowPoisonReason;
	readonly seq: number;

	readonly detail: string | undefined;

	constructor(
		reason: LegacyRowPoisonReason,
		seq: number | string,
		detail?: string,
	) {
		// Deliberately carries NO payload excerpt. Node's own JSON errors quote
		// the offending input verbatim, so a malformed row containing something
		// like a founder `ship` instruction would otherwise ride this message into
		// logs and into any alert rendered from them — reintroducing the very
		// replay this issue exists to prevent.
		super(
			`legacy lead_event row seq=${seq} rejected: ${reason}${
				detail ? ` (${detail})` : ""
			}`,
		);
		this.name = "LegacyRowPoisonError";
		this.reason = reason;
		this.seq = typeof seq === "number" ? seq : -1;
		this.detail = detail;
	}
}

/**
 * Parse a journal row's payload, converting ONLY a `SyntaxError` into typed
 * poison.
 *
 * The narrowness is the point: this wrapper goes around the single
 * `JSON.parse(row.payload)` call and nothing else. Anything wider would start
 * absorbing failures that deserve a retry.
 */
export function parseLegacyEventPayload(payload: string, seq: number): unknown {
	try {
		return JSON.parse(payload);
	} catch (err) {
		if (err instanceof SyntaxError) {
			throw new LegacyRowPoisonError("invalid_payload_json", seq);
		}
		throw err;
	}
}

export type LegacyRowVerdict = "quarantine" | "rethrow";

/**
 * The single place that decides whether a row is deterministically bad.
 *
 * Keep it exhaustive-by-allowlist: add a type here only once you can argue the
 * row will fail identically forever.
 */
export function classifyLegacyRowError(err: unknown): LegacyRowVerdict {
	if (err instanceof LegacyRowPoisonError) return "quarantine";
	if (err instanceof InboxWriteValidationError) return "quarantine";
	return "rethrow";
}
