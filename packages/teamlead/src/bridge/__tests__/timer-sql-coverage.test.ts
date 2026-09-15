import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { CommDB } from "flywheel-comm/db";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { installSqlTiming } from "flywheel-config";
import { expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
it("preserves native transaction aliases and iterator cleanup", () => {
	const db = new Database(":memory:");
	let now = 0;
	const warn = vi.fn();
	installSqlTiming(db, "native", { now: () => now, warn });
	db.function("slow", () => {
		now += 251;
		return 1;
	});
	try {
		const stmt = db.prepare("SELECT slow() AS n");
		const tx = db.transaction(() => stmt.get());
		expect(tx.default).toBe(tx);
		expect(tx.immediate()).toEqual({ n: 1 });
		expect(warn.mock.calls.map(([r]) => r.method)).toEqual([
			"get",
			"transaction",
		]);
		for (const variant of [tx.default, tx.deferred, tx.exclusive])
			expect(variant()).toEqual({ n: 1 });
		const iterator = stmt.iterate();
		expect(iterator.next().value).toEqual({ n: 1 });
		iterator.return();
		expect(db.inTransaction).toBe(false);
		expect(stmt.get()).toEqual({ n: 1 });
	} finally {
		db.close();
	}
});
it("includes actual SQLite lock waiting in a failed statement duration", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2563-lock-"));
	const path = join(root, "lock.db");
	const owner = new Database(path);
	const contender = new Database(path, { timeout: 300 });
	const warn = vi.fn();
	installSqlTiming(contender, "locked", { warn });
	try {
		owner.exec("CREATE TABLE item(value TEXT); BEGIN IMMEDIATE");
		expect(() =>
			contender.prepare("INSERT INTO item VALUES (?)").run("hidden-value"),
		).toThrow("locked");
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({
				method: "run",
				durationMs: expect.any(Number),
			}),
		);
		expect(warn.mock.calls[0][0].durationMs).toBeGreaterThan(250);
		expect(JSON.stringify(warn.mock.calls)).not.toContain("hidden-value");
	} finally {
		owner.close();
		contender.close();
		rmSync(root, { recursive: true, force: true });
	}
});
it("times StateStore and CommDB writable, readonly and maintenance work after a yield", async () => {
	const root = mkdtempSync(join(tmpdir(), "fly2563-sql-"));
	const store = await StateStore.create(join(root, "teamlead.db"));
	const comm = new CommDB(join(root, "comm.db"));
	const readonly = CommDB.openReadonly(join(root, "comm.db"));
	const queueReadonly = new MailboxQueue(join(root, "comm.db"), {
		readOnly: true,
	});
	const queueBorrowed = new MailboxQueue(
		(comm as unknown as { db: Database.Database }).db,
	);
	const maintenance = await StateStore.openForMaintenance(
		join(root, "teamlead.db"),
		{ readonly: true },
	);
	let now = 0;
	const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		const connections = [
			(store as unknown as { db: { raw: Database.Database } }).db.raw,
			(comm as unknown as { db: Database.Database }).db,
			(readonly as unknown as { db: Database.Database }).db,
			(maintenance as unknown as { db: { raw: Database.Database } }).db.raw,
			(queueReadonly as unknown as { db: Database.Database }).db,
			(queueBorrowed as unknown as { db: Database.Database }).db,
		];
		for (const db of connections) {
			db.function("slow_test", () => {
				now += 251;
				return 1;
			});
			await new Promise((resolve) => setImmediate(resolve));
			db.prepare("SELECT slow_test()").get();
		}
		const logs = warn.mock.calls
			.map(([message]) => String(message))
			.filter((message) => message.startsWith("[slow-sql]"));
		expect(logs).toHaveLength(6);
		expect(logs.join()).not.toContain("SELECT");
	} finally {
		clock.mockRestore();
		warn.mockRestore();
		maintenance.close();
		queueReadonly.close();
		queueBorrowed.close();
		readonly.close();
		comm.close();
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});
it("also instruments the publication reader that bypasses StateStore", async () => {
	const { readEpicReportPublications } = await import(
		"../report-epic-publications.js"
	);
	const root = mkdtempSync(join(tmpdir(), "fly2563-publication-sql-"));
	const path = join(root, "state.db");
	const db = new Database(path);
	db.exec("CREATE TABLE epic_page_publication(project_name TEXT, token TEXT)");
	db.close();
	let now = 0;
	const clock = vi.spyOn(performance, "now").mockImplementation(() => {
		now += 251;
		return now;
	});
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		expect(readEpicReportPublications(path)).toEqual([]);
		expect(
			warn.mock.calls.some(([line]) => String(line).includes('"method":"all"')),
		).toBe(true);
	} finally {
		clock.mockRestore();
		warn.mockRestore();
		rmSync(root, { recursive: true, force: true });
	}
});
