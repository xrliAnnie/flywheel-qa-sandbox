import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	assertNoLoneSurrogate,
	hasLoneSurrogate,
	InboxWriteValidationError,
	normalizeInboxContent,
	utf16LeDigest,
} from "../inbox-write-normalize.js";

/**
 * FLY-1586 A — authoritative enqueue-boundary normalization.
 *
 * Two policies, deliberately different:
 *
 *  - REJECT (fail-closed) for identity / routing / enum fields. A lone surrogate
 *    in `id` or `msg_class` is not a message someone typed — it is corruption,
 *    and silently repairing it would let a corrupted routing key persist.
 *  - REPAIR (+ audit) for `content`. That IS someone's message; dropping it
 *    would lose a real notification. Repair leaves a durable audit row so the
 *    substitution is never silent.
 */

const TROPHY = "\u{1F3C6}";
const LONE_HIGH = "\uD83C";
const LONE_LOW = "\uDFC6";
const REPLACEMENT = "�";

describe("hasLoneSurrogate", () => {
	it("is false for well-formed text", () => {
		expect(hasLoneSurrogate("")).toBe(false);
		expect(hasLoneSurrogate("plain ascii")).toBe(false);
		expect(hasLoneSurrogate(`emoji ${TROPHY} ok`)).toBe(false);
		expect(hasLoneSurrogate("中文也没问题")).toBe(false);
	});

	it("is true for an unpaired high or low surrogate", () => {
		expect(hasLoneSurrogate(LONE_HIGH)).toBe(true);
		expect(hasLoneSurrogate(LONE_LOW)).toBe(true);
		expect(hasLoneSurrogate(`head${LONE_HIGH}tail`)).toBe(true);
		expect(hasLoneSurrogate(`tail-high-at-end${LONE_HIGH}`)).toBe(true);
		expect(hasLoneSurrogate(`${LONE_LOW}low-at-start`)).toBe(true);
	});

	it("is true for a REVERSED pair (low then high) — not a valid pair", () => {
		expect(hasLoneSurrogate(LONE_LOW + LONE_HIGH)).toBe(true);
	});
});

describe("assertNoLoneSurrogate — REJECT policy", () => {
	it("passes well-formed values through and returns them", () => {
		expect(assertNoLoneSurrogate("id", "lead_event:lead-a:evt-1")).toBe(
			"lead_event:lead-a:evt-1",
		);
		expect(assertNoLoneSurrogate("content", `ok ${TROPHY}`)).toBe(
			`ok ${TROPHY}`,
		);
	});

	it("throws InboxWriteValidationError naming the field", () => {
		expect(() =>
			assertNoLoneSurrogate("routing_state", `x${LONE_HIGH}`),
		).toThrow(InboxWriteValidationError);
		try {
			assertNoLoneSurrogate("routing_state", `x${LONE_HIGH}`);
			expect.unreachable("should have thrown");
		} catch (err) {
			const e = err as InboxWriteValidationError;
			expect(e.field).toBe("routing_state");
			expect(e.reason).toBe("lone_surrogate");
			// The message must NOT echo the raw value — it would carry the poison
			// into a log line and, worse, into any alert rendered from it.
			expect(e.message).not.toContain(LONE_HIGH);
		}
	});

	it("is distinguishable from a generic Error so B can classify it", () => {
		// B's per-row isolation must tell "deterministic poison" (quarantine)
		// apart from "transient failure" (retry). That decision is made on the
		// error TYPE, never on the message text.
		const err = new InboxWriteValidationError("msg_class", "lone_surrogate");
		expect(err).toBeInstanceOf(Error);
		expect(err).toBeInstanceOf(InboxWriteValidationError);
		expect(err.name).toBe("InboxWriteValidationError");
	});
});

describe("normalizeInboxContent — REPAIR policy", () => {
	it("leaves well-formed content byte-identical and reports no repair", () => {
		const input = `hello ${TROPHY} 世界`;
		const out = normalizeInboxContent(input);
		expect(out.text).toBe(input);
		expect(out.repaired).toBe(false);
		expect(out.replacements).toBe(0);
	});

	it("handles empty content (enqueue permits it)", () => {
		const out = normalizeInboxContent("");
		expect(out).toMatchObject({ text: "", repaired: false, replacements: 0 });
	});

	it("replaces a lone high surrogate with U+FFFD — the seq 56649 shape", () => {
		const input = `Summary: ${LONE_HIGH}`;
		const out = normalizeInboxContent(input);
		expect(out.repaired).toBe(true);
		expect(out.replacements).toBe(1);
		expect(out.text).toBe(`Summary: ${REPLACEMENT}`);
		expect(hasLoneSurrogate(out.text)).toBe(false);
	});

	it("replaces a lone low surrogate", () => {
		const out = normalizeInboxContent(`${LONE_LOW}tail`);
		expect(out.text).toBe(`${REPLACEMENT}tail`);
		expect(out.replacements).toBe(1);
	});

	it("counts multiple replacements and never touches valid pairs", () => {
		const input = `${LONE_HIGH}${TROPHY}${LONE_LOW}${TROPHY}`;
		const out = normalizeInboxContent(input);
		expect(out.replacements).toBe(2);
		expect(out.text).toBe(`${REPLACEMENT}${TROPHY}${REPLACEMENT}${TROPHY}`);
		expect(hasLoneSurrogate(out.text)).toBe(false);
	});

	it("produces exactly what SQLite would have stored", () => {
		// This is the whole point of A: the value we WRITE must already equal the
		// value we will READ BACK. SQLite substitutes U+FFFD for lone surrogates,
		// so we do the substitution ourselves, up front, once.
		const out = normalizeInboxContent(`x${LONE_HIGH}y`);
		expect(out.text).toBe(`x${REPLACEMENT}y`);
	});

	it("is idempotent — normalizing twice changes nothing further", () => {
		const once = normalizeInboxContent(`a${LONE_HIGH}b`);
		const twice = normalizeInboxContent(once.text);
		expect(twice.text).toBe(once.text);
		expect(twice.repaired).toBe(false);
	});

	it("carries a digest of the ORIGINAL value for forensics", () => {
		const input = `a${LONE_HIGH}b`;
		const out = normalizeInboxContent(input);
		expect(out.originalDigest).toBe(utf16LeDigest(input));
		// Digest must distinguish the original from the repaired form, otherwise
		// the audit cannot prove what was actually substituted.
		expect(out.originalDigest).not.toBe(utf16LeDigest(out.text));
	});
});

describe("utf16LeDigest", () => {
	it("is SHA-256 over UTF-16LE bytes", () => {
		const value = "abc";
		const expected = createHash("sha256")
			.update(Buffer.from(value, "utf16le"))
			.digest("hex");
		expect(utf16LeDigest(value)).toBe(expected);
	});

	it("survives lone surrogates that UTF-8 encoding would mangle", () => {
		// Encoding the poison as UTF-8 would itself substitute U+FFFD, so the
		// digest would be identical for the poison and its repair — useless as
		// forensic evidence. UTF-16LE preserves the raw code units.
		const poison = `a${LONE_HIGH}b`;
		const repaired = `a${REPLACEMENT}b`;
		expect(utf16LeDigest(poison)).not.toBe(utf16LeDigest(repaired));
	});

	it("is stable and lowercase hex of the expected length", () => {
		const d = utf16LeDigest("stable");
		expect(d).toMatch(/^[0-9a-f]{64}$/);
		expect(d).toBe(utf16LeDigest("stable"));
	});
});
