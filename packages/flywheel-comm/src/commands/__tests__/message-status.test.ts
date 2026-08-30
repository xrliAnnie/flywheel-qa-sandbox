import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MailboxQueue } from "../../mailbox-queue.js";
import { encodeSenderRef } from "../../sender-ref.js";
import { messageStatus } from "../message-status.js";

const CREATED_AT = "2026-08-01T00:00:00.000Z";

describe("message-status", () => {
	let root: string;
	let dbPath: string;
	let stdout: string[];
	let stderr: string[];

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fly1795-message-status-"));
		dbPath = join(root, "comm.db");
		stdout = [];
		stderr = [];
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const io = () => ({
		stdout: (line: string) => stdout.push(line),
		stderr: (line: string) => stderr.push(line),
	});

	function enqueue(queue: MailboxQueue, id: string): void {
		queue.enqueue({
			id,
			deliveryId: `delivery:${id}`,
			fromAgent: "lead-a",
			toAgent: "exec-a",
			recipientKind: "runner",
			type: "instruction",
			content: id,
			createdAt: CREATED_AT,
			senderRef: encodeSenderRef(),
		});
	}

	function fileSnapshot(): Record<string, string | null> {
		return Object.fromEntries(
			[dbPath, `${dbPath}-wal`].map((path) => {
				const bytes = existsSync(path) ? readFileSync(path) : undefined;
				return [
					path,
					bytes && bytes.length > 0 ? bytes.toString("base64") : null,
				];
			}),
		);
	}

	it("reports live frozen and DEAD evidence from raw mailbox columns", () => {
		const queue = new MailboxQueue(dbPath);
		enqueue(queue, "frozen");
		enqueue(queue, "dead");
		const raw = new Database(dbPath);
		raw
			.prepare(
				`UPDATE mailbox SET state='LEASED', last_error='delivery_unconfirmed:2',
			 delivered_at='2026-08-01T00:01:00.000Z',
			 notified_at='2026-08-01T00:02:00.000Z' WHERE id='frozen'`,
			)
			.run();
		raw.close();
		queue.markDead("dead", "2026-08-01T00:03:00.000Z", "test_dead");
		queue.close();

		const before = fileSnapshot();
		expect(
			messageStatus(["delivery:frozen", "--db", dbPath, "--json"], io()),
		).toBe(0);
		expect(JSON.parse(stdout.pop()!)).toEqual({
			location: "live",
			message_id: "delivery:frozen",
			state: "LEASED",
			dead_reason: null,
			last_error: "delivery_unconfirmed:2",
			stamps: {
				created_at: CREATED_AT,
				delivered_at: "2026-08-01T00:01:00.000Z",
				notified_at: "2026-08-01T00:02:00.000Z",
				settled_at: null,
			},
		});
		expect(messageStatus(["dead", "--db", dbPath], io())).toBe(0);
		const deadStatus = stdout.pop();
		expect(deadStatus).toContain("live DEAD");
		expect(deadStatus).toContain("dead_reason=test_dead");
		expect(stdout.pop()).toBeUndefined();
		expect(stderr).toEqual([]);
		expect(fileSnapshot()).toEqual(before);
	});

	it("reports archived DEAD evidence and absent ids with distinct exits", () => {
		const queue = new MailboxQueue(dbPath);
		enqueue(queue, "archived");
		queue.markDead("archived", "2026-08-01T00:03:00.000Z", "archived_dead");
		expect(
			queue.archiveDueFamilies({ now: "2026-08-05T00:00:00.000Z" }),
		).toMatchObject({ archivedMessages: 1 });
		queue.close();

		expect(
			messageStatus(["delivery:archived", "--db", dbPath, "--json"], io()),
		).toBe(0);
		expect(JSON.parse(stdout.pop()!)).toEqual({
			location: "archived",
			message_id: "delivery:archived",
			state: "DEAD",
			dead_reason: "archived_dead",
			last_error: "archived_dead",
			stamps: {
				created_at: CREATED_AT,
				delivered_at: null,
				notified_at: null,
				settled_at: "2026-08-01T00:03:00.000Z",
			},
		});

		expect(messageStatus(["missing", "--db", dbPath, "--json"], io())).toBe(1);
		expect(JSON.parse(stdout.pop()!)).toEqual({
			location: "absent",
			message_id: "missing",
			state: null,
			dead_reason: null,
			last_error: null,
			stamps: {
				created_at: null,
				delivered_at: null,
				notified_at: null,
				settled_at: null,
			},
		});
	});

	it("returns a nonzero error for a missing database", () => {
		expect(messageStatus(["id", "--db", dbPath], io())).toBe(2);
		expect(stderr.join("\n")).toContain("message-status:");
	});

	it("reports a torn identity in human and JSON modes with its own exit", () => {
		const queue = new MailboxQueue(dbPath);
		enqueue(queue, "torn");
		queue.close();
		const raw = new Database(dbPath);
		raw.exec("DROP TRIGGER mailbox_delete_requires_archive");
		raw.prepare("DELETE FROM mailbox WHERE id='torn'").run();
		raw.close();

		expect(messageStatus(["delivery:torn", "--db", dbPath], io())).toBe(3);
		expect(stdout.pop()).toBe("torn delivery:torn");
		expect(
			messageStatus(["delivery:torn", "--db", dbPath, "--json"], io()),
		).toBe(3);
		expect(JSON.parse(stdout.pop()!)).toEqual({
			location: "torn",
			message_id: "delivery:torn",
			state: null,
			dead_reason: null,
			last_error: null,
			stamps: {
				created_at: null,
				delivered_at: null,
				notified_at: null,
				settled_at: null,
			},
		});
		expect(stderr).toEqual([]);
	});

	it("keeps usage failures on exit 2", () => {
		expect(messageStatus([], io())).toBe(2);
		expect(stderr.join("\n")).toContain("exactly one <message-id> is required");
	});
});
