import { expect, it, vi } from "vitest";
import { installSqlTiming } from "../sql-timing.js";
function fixture() {
	let time = 0;
	const warn = vi.fn();
	const iterator = {
		next() {
			time += 251;
			return { value: 1, done: false };
		},
		return() {
			time += 251;
			return { done: true };
		},
		[Symbol.iterator]() {
			return this;
		},
	};
	const statement = {
		run(secret?: string) {
			expect(this).toBe(statement);
			time += Number(secret === "boundary" ? 250 : 251);
			if (secret === "throw") throw new Error("original");
			return { changes: 1 };
		},
		get() {
			time += 251;
			return 1;
		},
		all() {
			time += 251;
			return [1];
		},
		bind() {
			return this;
		},
		iterate() {
			return iterator;
		},
	};
	const db = {
		prepare(_sql: string) {
			expect(this).toBe(db);
			return statement;
		},
		exec(_sql: string) {
			time += 251;
			return this;
		},
		pragma(_sql: string) {
			time += 251;
			return 2;
		},
		transaction(fn: (...args: unknown[]) => unknown) {
			const tx = function (this: unknown, ...args: unknown[]) {
				time += 251;
				return fn.apply(this, args);
			};
			return Object.assign(tx, {
				default: tx,
				immediate: tx,
				deferred: tx,
				exclusive: tx,
			});
		},
	};
	return { db, statement, iterator, warn, now: () => time };
}
it("logs only over250ms with stable SQL identities and no bound values", () => {
	const f = fixture();
	installSqlTiming(f.db, "test", { now: f.now, warn: f.warn });
	const stmt = f.db.prepare("INSERT INTO events VALUES (?)");
	stmt.run("boundary");
	expect(f.warn).not.toHaveBeenCalled();
	stmt.run("credential-do-not-log");
	stmt.get();
	stmt.all();
	expect(f.warn).toHaveBeenCalledTimes(3);
	expect(new Set(f.warn.mock.calls.map(([record]) => record.sqlId)).size).toBe(
		1,
	);
	expect(JSON.stringify(f.warn.mock.calls)).not.toContain(
		"credential-do-not-log",
	);
	expect(JSON.stringify(f.warn.mock.calls)).not.toContain("INSERT");
	expect(f.warn.mock.calls[0][0]).toMatchObject({
		databaseKind: "test",
		method: "run",
		durationMs: 251,
	});
});
it("preserves statement identity/chaining, iterator cleanup, transactions and repeated installation", () => {
	const f = fixture();
	installSqlTiming(f.db, "test", { now: f.now, warn: f.warn });
	installSqlTiming(f.db, "test", { now: f.now, warn: f.warn });
	const stmt = f.db.prepare("SELECT ?");
	expect(stmt).toBe(f.statement);
	expect(stmt.bind()).toBe(stmt);
	const iterator = stmt.iterate();
	expect(iterator[Symbol.iterator]()).toBe(iterator);
	iterator.next();
	iterator.return();
	expect(f.warn).toHaveBeenCalledTimes(2);
	const receiver = { tag: "receiver" };
	const tx = f.db.transaction(function (this: unknown) {
		expect(this).toBe(receiver);
		stmt.run();
		return 7;
	});
	expect(tx.default).toBe(tx);
	expect(tx.immediate.call(receiver)).toBe(7);
	expect(
		f.warn.mock.calls.filter(([r]) => r.method === "transaction"),
	).toHaveLength(1);
	expect(f.db.exec("SELECT 1")).toBe(f.db);
	expect(f.db.pragma("busy_timeout")).toBe(2);
});
it("retains the original SQL error even when the observer throws", () => {
	const f = fixture();
	installSqlTiming(f.db, "test", {
		now: f.now,
		warn: () => {
			throw new Error("logger");
		},
	});
	expect(() => f.db.prepare("SELECT ?").run("throw")).toThrow("original");
	expect(() => f.db.prepare("SELECT ?").run()).not.toThrow();
});
