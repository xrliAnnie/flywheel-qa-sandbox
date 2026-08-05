import { createHash } from "node:crypto";

/**
 * FLY-1586 A — normalization at the authoritative enqueue boundary.
 *
 * ## The failure this closes
 *
 * `mailbox` writes are insert-then-verify: INSERT, read the row back, compare
 * field by field, throw on mismatch. SQLite cannot store an unpaired surrogate —
 * it substitutes U+FFFD. So when a value containing one is written, the read-back
 * differs from the value the caller passed, the comparator throws, and the whole
 * transaction rolls back. During boot-time cutover that aborted every hop, which
 * aborted `admit()`, which meant `claimProtocol` and `claimModelBatch` never ran.
 * One row (lead_events seq 56649) held 14 Leads across 7 projects for 61 hours.
 *
 * ## Two policies, on purpose
 *
 * | Fields | Policy | Why |
 * |---|---|---|
 * | id / to_lead / source / type / msg_class / carrier / routing_state / … | **REJECT** | Corruption in a routing or identity key is not a message anyone typed. Repairing it would persist a corrupted key and route by it. |
 * | `content` | **REPAIR + audit** | That IS someone's message. Dropping the row loses a real notification; repairing it silently loses the evidence. So: substitute exactly what SQLite would have, and record what happened. |
 *
 * ## The invariant, stated narrowly
 *
 * A protects **value drift at the authoritative enqueue insert/verify boundary**.
 * Later diagnostic mutations (`last_error` and friends) do not participate in the
 * comparator and are made well-formed by SQLite's own read-back. This does **not**
 * claim every TEXT column in `mailbox` is normalized.
 *
 * `String.prototype.isWellFormed()` / `toWellFormed()` are ES2024; this repo
 * targets ES2022, so they do not typecheck here.
 */

const HIGH_START = 0xd800;
const HIGH_END = 0xdbff;
const LOW_START = 0xdc00;
const LOW_END = 0xdfff;

/** Exactly what SQLite substitutes for an unpaired surrogate. */
const REPLACEMENT = "�";

/**
 * Thrown when a REJECT-policy field carries an unpaired surrogate.
 *
 * A distinct type — not a message string — because FLY-1586 B classifies rows on
 * the error TYPE: this one is deterministic poison (quarantine the row, alert,
 * carry on), whereas `SQLITE_BUSY` / I/O / owner-fence errors must keep throwing
 * so the existing retry path handles them. Classifying on message text is how a
 * transient failure gets mistaken for poison and a real notification is dropped.
 */
export class InboxWriteValidationError extends Error {
	readonly field: string;
	readonly reason: "lone_surrogate";

	constructor(field: string, reason: "lone_surrogate") {
		// Deliberately does NOT echo the offending value: the poison would then
		// travel into log lines and into any alert rendered from them.
		super(`lead inbox write rejected: ${field} contains a ${reason}`);
		this.name = "InboxWriteValidationError";
		this.field = field;
		this.reason = reason;
	}
}

/** True when `value` contains an unpaired (or reversed) surrogate. */
export function hasLoneSurrogate(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code >= HIGH_START && code <= HIGH_END) {
			const next = value.charCodeAt(i + 1);
			// NaN past the end fails both comparisons — a trailing high surrogate
			// is correctly reported as lone.
			if (!(next >= LOW_START && next <= LOW_END)) return true;
			i++; // consume the well-formed pair
		} else if (code >= LOW_START && code <= LOW_END) {
			// A low surrogate not consumed above had no high surrogate before it.
			return true;
		}
	}
	return false;
}

/**
 * REJECT policy. Returns `value` unchanged so call sites can write
 * `const id = assertNoLoneSurrogate("id", input.id)` and be sure the value they
 * INSERT is the one that was validated.
 */
export function assertNoLoneSurrogate(field: string, value: string): string {
	if (hasLoneSurrogate(value)) {
		throw new InboxWriteValidationError(field, "lone_surrogate");
	}
	return value;
}

/**
 * SHA-256 over the UTF-16LE bytes of `value`.
 *
 * UTF-16LE, not UTF-8, and that choice is load-bearing: encoding to UTF-8 would
 * itself substitute U+FFFD for a lone surrogate, so the poison and its repair
 * would hash identically — worthless as forensic evidence. UTF-16LE preserves
 * the raw code units, so the audit can prove exactly what was replaced.
 */
export function utf16LeDigest(value: string): string {
	return createHash("sha256")
		.update(Buffer.from(value, "utf16le"))
		.digest("hex");
}

export interface NormalizedContent {
	/** Byte-for-byte what SQLite will store — and therefore read back. */
	text: string;
	/** True when at least one substitution happened. */
	repaired: boolean;
	/** How many code units were replaced. */
	replacements: number;
	/** Digest of the ORIGINAL value, for the sanitation audit. */
	originalDigest: string;
}

/**
 * REPAIR policy for `content`.
 *
 * Substitutes each unpaired surrogate with U+FFFD — precisely what SQLite would
 * do — so that the value we INSERT already equals the value we will read back.
 * The comparator then has nothing to disagree about.
 *
 * ⚠️ Call sites MUST use `.text` for BOTH the INSERT and the `expected` object.
 * Normalizing only the INSERT leaves the comparator holding the original value,
 * it still throws, and the fix does nothing at all. That is the single easiest
 * way to get this change wrong.
 */
export function normalizeInboxContent(value: string): NormalizedContent {
	const originalDigest = utf16LeDigest(value);
	if (!hasLoneSurrogate(value)) {
		return { text: value, repaired: false, replacements: 0, originalDigest };
	}

	let out = "";
	let replacements = 0;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code >= HIGH_START && code <= HIGH_END) {
			const next = value.charCodeAt(i + 1);
			if (next >= LOW_START && next <= LOW_END) {
				// slice, not value[i] + value[i+1]: under noUncheckedIndexedAccess
				// index access is `string | undefined`.
				out += value.slice(i, i + 2);
				i++;
				continue;
			}
			out += REPLACEMENT;
			replacements++;
			continue;
		}
		if (code >= LOW_START && code <= LOW_END) {
			out += REPLACEMENT;
			replacements++;
			continue;
		}
		out += value.charAt(i);
	}
	return { text: out, repaired: true, replacements, originalDigest };
}
