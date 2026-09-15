import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommDB } from "../db.js";
import { MailboxQueue } from "../mailbox-queue.js";

function countFds() {
	return readdirSync(
		process.platform === "linux" ? "/proc/self/fd" : "/dev/fd",
	).filter((name) => /^\d+$/.test(name)).length;
}

describe("mailbox constructor ownership", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "fly2563-mailbox-open-"));
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(root, { recursive: true, force: true });
	});
	it("closes an owned connection when schema installation fails", () => {
		const path = join(root, "comm.db");
		const seed = new Database(path);
		seed.exec("CREATE TABLE mailbox (broken TEXT)");
		seed.close();
		const baseline = countFds();
		expect(() => new MailboxQueue(path)).toThrow();
		expect(countFds()).toBeLessThanOrEqual(baseline);
	});
	it("does not close a borrowed connection when schema installation fails", () => {
		const db = new Database(join(root, "borrowed.db"));
		try {
			db.exec("CREATE TABLE mailbox (broken TEXT)");
			expect(() => new MailboxQueue(db)).toThrow();
			expect(db.open).toBe(true);
			expect(db.prepare("SELECT 1 AS n").get()).toEqual({ n: 1 });
		} finally {
			db.close();
		}
	});
	it.each([true, false])(
		"closes owned readOnly=%s connections when pragma setup fails",
		(readOnly) => {
			const path = join(root, "comm.db");
			new CommDB(path).close();
			const baseline = countFds();
			const error = new Error("injected pragma failure");
			const opened: Database.Database[] = [];
			vi.spyOn(Database.prototype, "pragma").mockImplementation(function (
				this: Database.Database,
			) {
				opened.push(this);
				throw error;
			});
			try {
				expect(() => new MailboxQueue(path, { readOnly })).toThrow(error);
				expect(countFds()).toBeLessThanOrEqual(baseline);
			} finally {
				for (const db of opened) if (db.open) db.close();
			}
		},
	);
});
