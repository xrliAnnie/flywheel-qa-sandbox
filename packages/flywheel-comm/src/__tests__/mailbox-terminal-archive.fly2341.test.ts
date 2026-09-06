import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { canonicalJsonString } from "flywheel-config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommDB } from "../db.js";
import {
	assertUtcIsoTimestamp,
	MAILBOX_IDENTITY_ARCHIVE_RETENTION_MS,
	MAILBOX_RETENTION_MS,
	MAX_IDENTITY_ARCHIVE_DURATION_MS,
	MailboxQueue,
} from "../mailbox-queue.js";
import { MAILBOX_SCHEMA } from "../mailbox-schema.js";
import { encodeSenderRef } from "../sender-ref.js";

const NOW = "2026-09-04T20:00:00.000Z";
const OLD = "2026-08-20T00:00:00.000Z";
const roots: string[] = [];

function input(id: string) {
	return {
		id,
		deliveryId: `delivery:${id}`,
		fromAgent: "lead-a",
		toAgent: "runner-a",
		recipientKind: "runner" as const,
		type: "instruction",
		content: id,
		createdAt: OLD,
		senderRef: encodeSenderRef(),
	};
}

function archiveInstruction(
	queue: MailboxQueue,
	id: string,
	options: { compact?: boolean } = {},
): void {
	queue.enqueue(input(id));
	queue.ack(id, OLD);
	expect(queue.archiveFamily({ id, now: NOW })).toBe("archived");
	if (options.compact !== false) {
		const clock = vi.spyOn(performance, "now").mockReturnValue(0);
		try {
			expect(queue.compactArchivedIdentities({ now: NOW, limit: 1 })).toBe(1);
		} finally {
			clock.mockRestore();
		}
	}
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("FLY-2341 mailbox terminal cold archive", () => {
	it("accepts existing UTC timestamps with microsecond precision", () => {
		expect(() =>
			assertUtcIsoTimestamp("2026-08-12T23:24:34.014362Z", "terminalAt"),
		).not.toThrow();
	});

	it("uses partial time indexes for both eligible and legacy candidates", () => {
		const db = new Database(":memory:");
		db.exec(MAILBOX_SCHEMA);
		const eligible = db
			.prepare(`EXPLAIN QUERY PLAN
				SELECT id FROM mailbox_identity
				WHERE archived_at IS NOT NULL AND terminal_at <= ?
				ORDER BY terminal_at,id LIMIT ?`)
			.all(NOW, 25) as Array<{ detail: string }>;
		const legacy = db
			.prepare(`EXPLAIN QUERY PLAN
				SELECT id FROM mailbox_identity
				WHERE archived_at IS NOT NULL AND terminal_at IS NULL
				ORDER BY id LIMIT ?`)
			.all(25) as Array<{ detail: string }>;
		expect(eligible.map(({ detail }) => detail).join("\n")).toContain(
			"mailbox_identity_terminal_archive",
		);
		expect(legacy.map(({ detail }) => detail).join("\n")).toContain(
			"mailbox_identity_terminal_backfill",
		);
		db.close();
	});

	it("keeps family archive at 72 hours and cold compaction at seven days", () => {
		expect(MAILBOX_RETENTION_MS).toBe(72 * 60 * 60_000);
		expect(MAILBOX_IDENTITY_ARCHIVE_RETENTION_MS).toBe(7 * 24 * 60 * 60_000);
		const queue = new MailboxQueue(":memory:");
		try {
			queue.enqueue(input("boundary"));
			queue.ack("boundary", OLD);
			expect(
				queue.archiveFamily({
					id: "boundary",
					now: "2026-08-22T23:59:59.999Z",
				}),
			).toBe("not_due");
			expect(
				queue.archiveFamily({
					id: "boundary",
					now: "2026-08-23T00:00:00.000Z",
				}),
			).toBe("archived");
			expect(
				queue.compactArchivedIdentities({
					now: "2026-08-26T23:59:59.999Z",
				}),
			).toBe(0);
			expect(
				queue.compactArchivedIdentities({
					now: "2026-08-27T00:00:00.000Z",
				}),
			).toBe(1);
		} finally {
			queue.close();
		}
	});

	it("moves archived identity and logs to one immutable cold row", () => {
		const db = new Database(":memory:");
		db.exec(MAILBOX_SCHEMA);
		const queue = new MailboxQueue(db);
		try {
			archiveInstruction(queue, "cold", { compact: false });
			expect(
				db.prepare("SELECT count(*) AS n FROM mailbox_identity").get(),
			).toEqual({ n: 1 });
			expect(db.prepare("SELECT count(*) AS n FROM mailbox_log").get()).toEqual(
				{
					n: 1,
				},
			);

			expect(queue.compactArchivedIdentities({ now: NOW, limit: 1 })).toBe(1);
			expect(
				db.prepare("SELECT count(*) AS n FROM mailbox_identity").get(),
			).toEqual({ n: 0 });
			expect(db.prepare("SELECT count(*) AS n FROM mailbox_log").get()).toEqual(
				{
					n: 0,
				},
			);
			const cold = db
				.prepare(`SELECT id,delivery_id,terminal_at,mailbox_json,logs_json
					FROM mailbox_terminal_archive WHERE id='cold'`)
				.get() as Record<string, unknown>;
			expect(cold).toMatchObject({
				id: "cold",
				delivery_id: "delivery:cold",
				terminal_at: OLD,
			});
			expect(JSON.parse(String(cold.mailbox_json))).toMatchObject({
				id: "cold",
				state: "ACKED",
			});
			expect(JSON.parse(String(cold.logs_json))).toHaveLength(1);
			expect(() =>
				db
					.prepare("DELETE FROM mailbox_terminal_archive WHERE id='cold'")
					.run(),
			).toThrow(/immutable/);
		} finally {
			queue.close();
			db.close();
		}
	});

	it("preserves exact-id idempotency, settlement, lane, and carrier after compaction", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			archiveInstruction(queue, "fallback");
			expect(queue.enqueue(input("fallback"))).toEqual({ outcome: "archived" });
			expect(queue.inspectDeliveryState("delivery:fallback")).toMatchObject({
				kind: "archived_terminal",
				state: "ACKED",
				settledAt: OLD,
			});
			expect(queue.getIdentityCarrier("fallback")).toBe("inbox");
			expect(
				queue.claimDiscordLane({ ...input("fallback"), carrier: "inbox" }),
			).toEqual({ lane: "archived" });
			expect(queue.archiveFamily({ id: "fallback", now: NOW })).toBe(
				"idempotent",
			);
		} finally {
			queue.close();
		}
	});

	it("keeps legacy identity-only history honest and bounded", () => {
		vi.spyOn(performance, "now").mockReturnValue(0);
		const db = new Database(":memory:");
		db.exec(MAILBOX_SCHEMA);
		const queue = new MailboxQueue(db);
		try {
			const insert = db.prepare(`INSERT INTO mailbox_identity
				(id,delivery_id,insert_projection_hash,archived_at)
				VALUES(?,?,?,?)`);
			for (const id of ["legacy-a", "legacy-b", "legacy-c"]) {
				insert.run(id, `delivery:${id}`, `hash:${id}`, OLD);
			}
			expect(queue.compactArchivedIdentities({ now: NOW, limit: 2 })).toBe(2);
			expect(
				db.prepare("SELECT count(*) AS n FROM mailbox_identity").get(),
			).toEqual({ n: 1 });
			expect(
				db
					.prepare(
						"SELECT count(*) AS n FROM mailbox_terminal_archive WHERE mailbox_json IS NULL",
					)
					.get(),
			).toEqual({ n: 2 });
			expect(queue.inspectDeliveryState("legacy-a")).toEqual({
				kind: "torn_identity",
			});
			expect(queue.getIdentityCarrier("legacy-a")).toBe("unknown_archived");
		} finally {
			queue.close();
			db.close();
		}
	});

	it("stops the identity loop at its hard wall-time budget", () => {
		const queue = new MailboxQueue(":memory:");
		try {
			archiveInstruction(queue, "budget-a", { compact: false });
			archiveInstruction(queue, "budget-b", { compact: false });
			const clock = vi
				.spyOn(performance, "now")
				.mockReturnValueOnce(0)
				.mockReturnValueOnce(0)
				.mockReturnValue(MAX_IDENTITY_ARCHIVE_DURATION_MS + 1);
			try {
				expect(queue.compactArchivedIdentities({ now: NOW, limit: 25 })).toBe(
					1,
				);
			} finally {
				clock.mockRestore();
			}
		} finally {
			queue.close();
		}
	});

	it("keeps event-id replay receipts and their identities hot", () => {
		const db = new Database(":memory:");
		db.exec(MAILBOX_SCHEMA);
		const queue = new MailboxQueue(db);
		try {
			queue.enqueue(input("receipt-owner"));
			queue.ack("receipt-owner", OLD);
			db.prepare(`INSERT INTO mailbox_log
				(event_id,message_id,event,at,row_json)
				VALUES('resume-receipt','receipt-owner','progress',?,?)`).run(
				OLD,
				JSON.stringify({ sourceId: "receipt-owner", requeued: 1 }),
			);
			expect(queue.archiveFamily({ id: "receipt-owner", now: NOW })).toBe(
				"archived",
			);
			expect(queue.compactArchivedIdentities({ now: NOW, limit: 1 })).toBe(0);
			expect(
				db
					.prepare(
						"SELECT archived_at FROM mailbox_identity WHERE id='receipt-owner'",
					)
					.get(),
			).toEqual({ archived_at: NOW });
			expect(
				db
					.prepare(
						"SELECT row_json FROM mailbox_log WHERE event_id='resume-receipt'",
					)
					.get(),
			).toBeDefined();
		} finally {
			queue.close();
			db.close();
		}
	});

	it("restores a complete row without consuming cold evidence", () => {
		const db = new Database(":memory:");
		db.exec(MAILBOX_SCHEMA);
		const queue = new MailboxQueue(db);
		try {
			archiveInstruction(queue, "restore");
			expect(queue.restoreTerminalIdentity("delivery:restore")).toBe(
				"restored",
			);
			expect(queue.getById("restore")).toMatchObject({
				id: "restore",
				state: "ACKED",
			});
			expect(queue.restoreTerminalIdentity("restore")).toBe("idempotent");
			expect(
				db.prepare("SELECT count(*) AS n FROM mailbox_terminal_archive").get(),
			).toEqual({ n: 1 });
			expect(() =>
				db.prepare("DELETE FROM mailbox_identity WHERE id='restore'").run(),
			).toThrow(/permanent/);
		} finally {
			queue.close();
			db.close();
		}
	});

	it("fails closed before restoring a missing content reference", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2341-restore-content-"));
		roots.push(root);
		const contentRef = join(root, "refs", "content.txt");
		mkdirSync(join(root, "refs"));
		writeFileSync(contentRef, "archived content");
		const queue = new MailboxQueue(join(root, "comm.db"));
		try {
			queue.enqueue({ ...input("content-ref"), contentRef });
			queue.ack("content-ref", OLD);
			expect(queue.archiveFamily({ id: "content-ref", now: NOW })).toBe(
				"archived",
			);
			expect(queue.compactArchivedIdentities({ now: NOW, limit: 1 })).toBe(1);
			unlinkSync(contentRef);

			expect(() => queue.restoreTerminalIdentity("content-ref")).toThrow(
				/content_ref unavailable/,
			);
			expect(queue.getById("content-ref")).toBeUndefined();
		} finally {
			queue.close();
		}
	});

	it("rejects archive columns outside the current hot schema", () => {
		const db = new Database(":memory:");
		db.exec(MAILBOX_SCHEMA);
		const queue = new MailboxQueue(db);
		try {
			archiveInstruction(queue, "schema-mismatch");
			db.exec("DROP TRIGGER mailbox_terminal_archive_no_update");
			const cold = db
				.prepare(
					"SELECT * FROM mailbox_terminal_archive WHERE id='schema-mismatch'",
				)
				.get() as Record<string, unknown>;
			cold.mailbox_json = canonicalJsonString({
				...JSON.parse(String(cold.mailbox_json)),
				unexpected_column: "unsafe",
			});
			const { payload_sha256: _oldDigest, ...payload } = cold;
			cold.payload_sha256 = createHash("sha256")
				.update(canonicalJsonString(payload))
				.digest("hex");
			db.prepare(
				"UPDATE mailbox_terminal_archive SET mailbox_json=?,payload_sha256=? WHERE id='schema-mismatch'",
			).run(cold.mailbox_json, cold.payload_sha256);

			expect(() => queue.restoreTerminalIdentity("schema-mismatch")).toThrow(
				/archive schema mismatch/,
			);
			expect(queue.getById("schema-mismatch")).toBeUndefined();
		} finally {
			queue.close();
			db.close();
		}
	});

	it("recompacts a restored row without blocking an unrelated identity", () => {
		vi.spyOn(performance, "now").mockReturnValue(0);
		const db = new Database(":memory:");
		db.exec(MAILBOX_SCHEMA);
		const queue = new MailboxQueue(db);
		try {
			archiveInstruction(queue, "alpha");
			expect(queue.restoreTerminalIdentity("alpha")).toBe("restored");
			expect(queue.archiveFamily({ id: "alpha", now: NOW })).toBe("archived");
			archiveInstruction(queue, "gamma", { compact: false });

			expect(queue.compactArchivedIdentities({ now: NOW, limit: 2 })).toBe(2);
			expect(
				db.prepare("SELECT id FROM mailbox_identity ORDER BY id").all(),
			).toEqual([]);
		} finally {
			queue.close();
			db.close();
		}
	});

	it("isolates one conflicting identity while compacting the rest of the batch", () => {
		const db = new Database(":memory:");
		db.exec(MAILBOX_SCHEMA);
		const queue = new MailboxQueue(db);
		try {
			archiveInstruction(queue, "alpha");
			expect(queue.restoreTerminalIdentity("alpha")).toBe("restored");
			expect(queue.archiveFamily({ id: "alpha", now: NOW })).toBe("archived");
			archiveInstruction(queue, "gamma", { compact: false });
			db.exec("DROP TRIGGER mailbox_terminal_archive_no_update");
			db.prepare(
				"UPDATE mailbox_terminal_archive SET payload_sha256=? WHERE id='alpha'",
			).run("0".repeat(64));
			const failures: string[] = [];

			expect(
				queue.compactArchivedIdentities({
					now: NOW,
					limit: 2,
					onIdentityError: (id) => failures.push(id),
				}),
			).toBe(1);
			expect(failures).toEqual(["alpha"]);
			expect(
				db.prepare("SELECT id FROM mailbox_identity ORDER BY id").all(),
			).toEqual([{ id: "alpha" }]);
		} finally {
			queue.close();
			db.close();
		}
	});

	it("advances the ready cursor past a full persistent failure cohort", () => {
		const db = new Database(":memory:");
		db.exec(MAILBOX_SCHEMA);
		const queue = new MailboxQueue(db);
		try {
			for (let index = 0; index < 25; index++) {
				const id = `bad-${String(index).padStart(2, "0")}`;
				archiveInstruction(queue, id, { compact: false });
				db.prepare(`INSERT INTO mailbox_terminal_archive
					(id,delivery_id,insert_projection_hash,terminal_at,archived_at,
					 mailbox_json,logs_json,payload_sha256)
					VALUES(?,?,?,?,?,NULL,'[]',?)`).run(
					id,
					`delivery:${id}`,
					createHash("sha256")
						.update(canonicalJsonString(input(id)))
						.digest("hex"),
					OLD,
					NOW,
					"0".repeat(64),
				);
			}
			archiveInstruction(queue, "good", { compact: false });
			const failures: string[] = [];
			const clock = vi.spyOn(performance, "now").mockReturnValue(0);

			try {
				expect(
					queue.compactArchivedIdentities({
						now: NOW,
						limit: 25,
						onIdentityError: (id) => failures.push(id),
					}),
				).toBe(0);
				expect(failures).toHaveLength(25);
				expect(
					queue.compactArchivedIdentities({
						now: NOW,
						limit: 25,
						onIdentityError: (id) => failures.push(id),
					}),
				).toBe(1);
				expect(
					db.prepare("SELECT id FROM mailbox_identity WHERE id='good'").get(),
				).toBeUndefined();
			} finally {
				clock.mockRestore();
			}
		} finally {
			queue.close();
			db.close();
		}
	});

	it("serves an archived founder-review family after hot logs are compacted", () => {
		vi.spyOn(performance, "now").mockReturnValue(0);
		const root = mkdtempSync(join(tmpdir(), "fly2341-founder-family-"));
		roots.push(root);
		const path = join(root, "comm.db");
		const db = new Database(path);
		db.exec(MAILBOX_SCHEMA);
		const queue = new MailboxQueue(db);
		queue.enqueue({
			...input("question"),
			type: "question",
			checkpoint: "founder_review",
			content: "approve?",
		});
		queue.enqueue({
			...input("response"),
			fromAgent: "founder",
			type: "response",
			refId: "question",
			content: "approved",
		});
		queue.ack("question", OLD);
		queue.ack("response", OLD);
		expect(queue.archiveFamily({ id: "question", now: NOW })).toBe("archived");
		expect(queue.compactArchivedIdentities({ now: NOW, limit: 2 })).toBe(2);
		queue.close();
		db.close();

		const comm = new CommDB(path, false, false);
		try {
			expect(comm.getFounderReviewFamily("question")).toMatchObject({
				source: "archived",
				question: { id: "question", content: "approve?" },
				response: { fromAgent: "founder", content: "approved" },
			});
		} finally {
			comm.close();
		}
	});

	it.each([
		[OLD, "2026-08-20T01:00:00.000Z"],
		["2026-08-20T01:00:00.000Z", OLD],
	])(
		"serves a founder-review family split across hot and cold storage (%s, %s)",
		(questionAt, responseAt) => {
			const db = new Database(":memory:");
			db.exec(MAILBOX_SCHEMA);
			const queue = new MailboxQueue(db);
			try {
				queue.enqueue({
					...input("split-question"),
					type: "question",
					checkpoint: "founder_review",
					content: "approve?",
				});
				queue.enqueue({
					...input("split-response"),
					fromAgent: "founder",
					type: "response",
					refId: "split-question",
					content: "approved",
				});
				queue.ack("split-question", questionAt);
				queue.ack("split-response", responseAt);
				expect(queue.archiveFamily({ id: "split-question", now: NOW })).toBe(
					"archived",
				);
				expect(queue.compactArchivedIdentities({ now: NOW, limit: 1 })).toBe(1);

				expect(
					queue
						.getArchivedFamilySnapshots("split-question")
						.map((row) => JSON.parse(row).id)
						.sort(),
				).toEqual(["split-question", "split-response"]);
			} finally {
				queue.close();
				db.close();
			}
		},
	);
});
