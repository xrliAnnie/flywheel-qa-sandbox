import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CommDB } from "../db.js";
import {
	InboxWriteValidationError,
	utf16LeDigest,
} from "../inbox-write-normalize.js";
import { LeadInboxQueue } from "../lead-inbox-queue.js";

/**
 * FLY-1586 A (§3.4) — the sanitation audit.
 *
 * Repairing the poison is only half of A. Repairing it SILENTLY would trade one
 * failure for a quieter one: the row would be delivered, nobody would know a
 * character had been substituted, and the next investigation would have the same
 * problem this incident had — no durable fact to reason from, 61 hours later.
 *
 * So every repair leaves an append-only record, written in the SAME transaction
 * as the row it describes. Either both land or neither does; an audit that can
 * go missing is not evidence.
 *
 * The digest is over UTF-16LE. Encoding to UTF-8 would itself substitute U+FFFD
 * for a lone surrogate, so the poison and its repair would hash identically —
 * useless for proving what was actually replaced.
 */

const TROPHY = "\u{1F3C6}";
const LONE_HIGH = "\uD83C";

describe("FLY-1586 A §3.4 — sanitation audit", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1586-audit-"));
		dbPath = join(dir, "comm.db");
		new CommDB(dbPath).close();
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const base = {
		toLead: "lead-a",
		source: "lead_event:56649",
		type: "session_completed",
		msgClass: "model" as const,
		priority: 2,
	};

	it("records a repair with the field, the count, and the ORIGINAL digest", () => {
		const q = new LeadInboxQueue(dbPath);
		try {
			const original = `Summary: won ${LONE_HIGH}`;
			q.enqueue({ ...base, id: "lead_event:lead-a:evt-1", content: original });

			const rows = q.listSanitationAudit();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.inbox_id).toBe("lead_event:lead-a:evt-1");
			expect(rows[0]?.field).toBe("content");
			expect(rows[0]?.replacements).toBe(1);
			// Proves WHAT was replaced, not merely that something was.
			expect(rows[0]?.original_digest).toBe(utf16LeDigest(original));
		} finally {
			q.close();
		}
	});

	it("writes NOTHING for well-formed content (reverse-compat sentinel)", () => {
		const q = new LeadInboxQueue(dbPath);
		try {
			q.enqueue({
				...base,
				id: "lead_event:lead-a:clean",
				content: `done ${TROPHY} 全部完成`,
			});
			// Acceptance #11: a healthy write must be byte-identical to before this
			// change AND must not produce an audit row. An audit that fires on
			// healthy traffic is noise, and noise is what gets ignored.
			expect(q.listSanitationAudit()).toHaveLength(0);
		} finally {
			q.close();
		}
	});

	it("counts multiple replacements in one value", () => {
		const q = new LeadInboxQueue(dbPath);
		try {
			q.enqueue({
				...base,
				id: "lead_event:lead-a:multi",
				content: `${LONE_HIGH}a${LONE_HIGH}b${LONE_HIGH}`,
			});
			expect(q.listSanitationAudit()[0]?.replacements).toBe(3);
		} finally {
			q.close();
		}
	});

	it("lands in the SAME transaction as the row it describes", () => {
		const q = new LeadInboxQueue(dbPath);
		try {
			q.enqueue({
				...base,
				id: "lead_event:lead-a:atomic",
				content: `x${LONE_HIGH}y`,
			});
		} finally {
			q.close();
		}
		// Read both through an independent connection: whatever is on disk is what
		// a later investigator would actually find.
		const raw = new Database(dbPath, { readonly: true });
		try {
			const row = raw
				.prepare("SELECT content FROM lead_inbox WHERE id = ?")
				.get("lead_event:lead-a:atomic") as { content: string } | undefined;
			const audit = raw
				.prepare(
					"SELECT COUNT(*) AS n FROM lead_inbox_sanitation_audit WHERE inbox_id = ?",
				)
				.get("lead_event:lead-a:atomic") as { n: number };
			expect(row).toBeDefined();
			expect(audit.n).toBe(1);
		} finally {
			raw.close();
		}
	});

	it("is append-only across the idempotent re-enqueue the reconciler performs", () => {
		const q = new LeadInboxQueue(dbPath);
		try {
			const input = {
				...base,
				id: "lead_event:lead-a:repeat",
				content: `x${LONE_HIGH}y`,
			};
			q.enqueue(input);
			q.enqueue(input);
			// The row is deduped by stable id, so the audit must not grow a second
			// entry for the same persisted row — otherwise every Bridge restart
			// would inflate the record of a single historical repair.
			expect(q.listSanitationAudit()).toHaveLength(1);
		} finally {
			q.close();
		}
	});

	it("covers the founder hub-root path too", () => {
		const q = new LeadInboxQueue(dbPath);
		try {
			q.enqueueHubRoot({
				id: "founder_msg:lead-a:m1",
				toLead: "lead-a",
				content: `ship it ${LONE_HIGH}`,
				refMessageId: "m1",
				now: "2026-07-31T22:00:00.000Z",
			});
			const rows = q.listSanitationAudit();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.inbox_id).toBe("founder_msg:lead-a:m1");
		} finally {
			q.close();
		}
	});
});

describe("FLY-1586 A §3.4 — the real CommDB facade (code review R1 HIGH-3)", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1586-audit-facade-"));
		dbPath = join(dir, "comm.db");
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("repairs a founder reply through CommDB without losing the row", () => {
		// Production reaches `LeadInboxQueue` via the EXISTING-CONNECTION
		// constructor branch, which returned before installing any schema. A
		// repaired founder reply therefore hit `recordSanitation()` on a fresh
		// CommDB, failed with `no such table`, and rolled back the canonical row —
		// the audit would have destroyed the very message it documents.
		//
		// Constructing the queue directly (as the tests above do) installs the
		// schema and hides this completely, which is exactly why it survived until
		// code review.
		const db = new CommDB(dbPath);
		try {
			db.enqueueFounderHubRoot({
				id: "founder_msg:lead-a:facade",
				toLead: "lead-a",
				content: `ship it ${LONE_HIGH}`,
				refMessageId: "facade-1",
				now: "2026-07-31T22:00:00.000Z",
			});
		} finally {
			db.close();
		}

		const q = new LeadInboxQueue(dbPath);
		try {
			expect(q.getById("founder_msg:lead-a:facade")?.content).toBe("ship it �");
			expect(q.listSanitationAudit()).toHaveLength(1);
		} finally {
			q.close();
		}
	});
});

describe("FLY-1586 — code review R2 MEDIUM closures", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1586-r2med-"));
		dbPath = join(dir, "comm.db");
		new CommDB(dbPath).close();
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const base = {
		toLead: "lead-a",
		source: "lead_event:1",
		type: "session_completed",
		msgClass: "model" as const,
		priority: 2,
	};

	it("MEDIUM-7: two DIFFERENT originals with the same repaired output are caught", () => {
		// `INSERT OR IGNORE` alone is not "append-only" — it is "first writer
		// silently wins". A lone HIGH and a lone LOW surrogate both repair to the
		// same string, so without a read-back the audit would keep the first digest
		// and could no longer say which raw input the second call supplied. That
		// defeats the only reason to store a digest at all.
		const q = new LeadInboxQueue(dbPath);
		try {
			q.enqueue({ ...base, id: "lead_event:lead-a:x", content: "a\uD83Cb" });
			expect(() =>
				q.enqueue({ ...base, id: "lead_event:lead-a:x", content: "a\uDFC6b" }),
			).toThrow(/conflicts with an existing record/);
		} finally {
			q.close();
		}
	});

	it("MEDIUM-8: a lone surrogate in an enum field is TYPED, not a generic error", () => {
		// Both values are persisted and read-back-compared, so malformed input here
		// is deterministic bad data and must reach B as the type it classifies on.
		const q = new LeadInboxQueue(dbPath);
		try {
			expect(() =>
				q.enqueue({
					...base,
					id: "lead_event:lead-a:bad-carrier",
					content: "clean",
					carrier: `inbox\uD83C` as "inbox",
				}),
			).toThrow(InboxWriteValidationError);
		} finally {
			q.close();
		}
	});
});
