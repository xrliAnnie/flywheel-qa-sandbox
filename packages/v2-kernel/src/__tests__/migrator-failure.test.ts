import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openKernelDb } from "../connection.js";
import { OBLIGATIONS_REBUILD_DDL } from "../migrations/0002-obligations-rebuild.js";
import { MIGRATIONS, type Migration } from "../migrations/index.js";
import { runMigrations } from "../migrator.js";
import { makeTempDatabase, type TempDatabase } from "./helpers.js";

const MIGRATION_CHILD_PATH = fileURLToPath(
	new URL("../../test-fixtures/run-migrations.mjs", import.meta.url),
);

interface MigrationChild {
	process: ChildProcess;
	ready: Promise<void>;
	result: Promise<{ applied: string[] }>;
}

function startMigrationChild(path: string): MigrationChild {
	const child = fork(MIGRATION_CHILD_PATH, [path], {
		cwd: fileURLToPath(new URL("../..", import.meta.url)),
		silent: true,
	});
	let stderr = "";
	child.stderr?.on("data", (chunk) => {
		stderr += String(chunk);
	});

	let resolveReady: (() => void) | undefined;
	let resolveResult: ((value: { applied: string[] }) => void) | undefined;
	let rejectResult: ((error: Error) => void) | undefined;
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});
	const result = new Promise<{ applied: string[] }>((resolve, reject) => {
		resolveResult = resolve;
		rejectResult = reject;
	});
	child.on("message", (message: unknown) => {
		if (typeof message === "object" && message !== null && "type" in message) {
			if (message.type === "ready") {
				resolveReady?.();
			} else if (
				message.type === "result" &&
				"result" in message &&
				typeof message.result === "object" &&
				message.result !== null &&
				"applied" in message.result &&
				Array.isArray(message.result.applied)
			) {
				resolveResult?.({ applied: message.result.applied as string[] });
			} else if (message.type === "error" && "error" in message) {
				rejectResult?.(new Error(String(message.error)));
			}
		}
	});
	child.on("exit", (code) => {
		if (code !== 0) {
			rejectResult?.(
				new Error(`migration child exited ${String(code)}: ${stderr}`),
			);
		}
	});
	return { process: child, ready, result };
}

describe("migration failure safety", () => {
	let temp: TempDatabase | undefined;

	afterEach(() => {
		temp?.cleanup();
		temp = undefined;
	});

	it("rolls back DDL and bookkeeping together on a syntax failure", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		const broken: Migration = {
			id: "9000-broken",
			fkMode: "on",
			ddl: "CREATE TABLE should_rollback(id TEXT); CREATE TABLE broken(",
		};
		try {
			expect(() => runMigrations(db, [broken])).toThrow();
			expect(
				db
					.prepare(
						"SELECT count(*) FROM sqlite_master WHERE type='table' AND name='should_rollback'",
					)
					.pluck()
					.get(),
			).toBe(0);
			expect(
				db
					.prepare(
						"SELECT count(*) FROM schema_migrations WHERE id='9000-broken'",
					)
					.pluck()
					.get(),
			).toBe(0);
			expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
		} finally {
			db.close();
		}
	});

	it("rolls back an obligations rebuild when foreign_key_check finds legacy damage", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		try {
			runMigrations(db, MIGRATIONS.slice(0, 1));
			db.pragma("foreign_keys = OFF");
			db.prepare(
				`INSERT INTO obligations
				 (id, kind, target_task_id, depth, state, opened_at)
				 VALUES ('damaged', 'test', 'missing-task', 0, 'open', 'now')`,
			).run();
			db.pragma("foreign_keys = ON");

			expect(() => runMigrations(db, MIGRATIONS.slice(1, 2))).toThrow(
				/foreign_key_check/i,
			);
			expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
			expect(
				db
					.prepare("SELECT name FROM pragma_table_info('obligations')")
					.pluck()
					.all(),
			).not.toContain("target_kind");
			expect(
				db
					.prepare(
						"SELECT count(*) FROM schema_migrations WHERE id='0002-obligations-rebuild'",
					)
					.pluck()
					.get(),
			).toBe(0);
		} finally {
			db.close();
		}
	});

	it("restores the old table and triggers when final trigger creation fails", () => {
		temp = makeTempDatabase();
		const db = openKernelDb({ path: temp.path });
		const brokenRebuild: Migration = {
			id: "0002-obligations-rebuild-broken-trigger",
			fkMode: "rebuild",
			ddl: `${OBLIGATIONS_REBUILD_DDL}
CREATE TRIGGER deliberately_broken BEFORE INSERT ON obligations
BEGIN THIS IS NOT VALID SQL; END;`,
		};
		try {
			runMigrations(db, MIGRATIONS.slice(0, 1));
			expect(() => runMigrations(db, [brokenRebuild])).toThrow();
			expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
			expect(
				db
					.prepare("SELECT name FROM pragma_table_info('obligations')")
					.pluck()
					.all(),
			).not.toContain("target_kind");
			expect(
				db
					.prepare(
						`SELECT name FROM sqlite_master
						 WHERE type='trigger' AND name='obligations_tombstone_task_terminal'`,
					)
					.pluck()
					.get(),
			).toBe("obligations_tombstone_task_terminal");
			expect(
				db
					.prepare("SELECT count(*) FROM schema_migrations WHERE id=?")
					.pluck()
					.get(brokenRebuild.id),
			).toBe(0);
		} finally {
			db.close();
		}
	});

	it("applies each migration exactly once across two synchronized processes", async () => {
		temp = makeTempDatabase();
		const first = startMigrationChild(temp.path);
		const second = startMigrationChild(temp.path);
		await Promise.all([first.ready, second.ready]);
		first.process.send?.("go");
		second.process.send?.("go");

		const results = await Promise.all([first.result, second.result]);
		const appliedCounts = new Map<string, number>();
		for (const id of results.flatMap((result) => result.applied)) {
			appliedCounts.set(id, (appliedCounts.get(id) ?? 0) + 1);
		}
		expect(
			MIGRATIONS.map((migration) => [
				migration.id,
				appliedCounts.get(migration.id),
			]),
		).toEqual(MIGRATIONS.map((migration) => [migration.id, 1]));

		const verification = openKernelDb({ path: temp.path, readonly: true });
		try {
			expect(
				verification
					.prepare("SELECT id FROM schema_migrations ORDER BY id")
					.pluck()
					.all(),
			).toEqual(MIGRATIONS.map((migration) => migration.id));
			expect(verification.pragma("foreign_key_check")).toEqual([]);
		} finally {
			verification.close();
		}
	});
});
