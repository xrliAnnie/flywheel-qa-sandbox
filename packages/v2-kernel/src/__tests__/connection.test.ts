import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openKernelDb } from "../connection.js";
import { makeTempDatabase, type TempDatabase } from "./helpers.js";

describe("connection factory", () => {
	let temp: TempDatabase | undefined;

	afterEach(() => {
		temp?.cleanup();
		temp = undefined;
	});

	it("owns permissions and every required SQLite pragma", () => {
		temp = makeTempDatabase();
		const parent = join(temp.dir, "private");
		mkdirSync(parent, { mode: 0o755 });
		const path = join(parent, "flywheel-v2.db");
		const db = openKernelDb({
			path,
			busyTimeoutMs: 246,
			synchronousMode: "FULL",
		});
		try {
			expect(statSync(parent).mode & 0o777).toBe(0o700);
			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
			expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
			expect(db.pragma("busy_timeout", { simple: true })).toBe(246);
			expect(db.pragma("synchronous", { simple: true })).toBe(2);
		} finally {
			db.close();
		}
	});

	it("supports NORMAL durability only when explicitly selected", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({
			path: temp.path,
			synchronousMode: "NORMAL",
		});
		try {
			expect(db.pragma("synchronous", { simple: true })).toBe(1);
		} finally {
			db.close();
		}
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects invalid busy timeout %s",
		(busyTimeoutMs) => {
			temp = makeTempDatabase();
			expect(() =>
				openKernelDb({ path: temp?.path ?? "", busyTimeoutMs }),
			).toThrow(/busyTimeoutMs/);
		},
	);
});
