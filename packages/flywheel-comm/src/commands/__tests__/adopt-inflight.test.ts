import { createHash } from "node:crypto";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CommDB } from "../../db.js";
import { MailboxQueue } from "../../mailbox-queue.js";
import { encodeSenderRef } from "../../sender-ref.js";
import { adoptInflight } from "../adopt-inflight.js";

const roots: string[] = [];

function root(): string {
	const path = mkdtempSync(join(tmpdir(), "fly1708-adopt-cli-"));
	roots.push(path);
	return path;
}

function digest(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(args: string[]) {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const exitCode = adoptInflight(args, {
		stdout: (line) => stdout.push(line),
		stderr: (line) => stderr.push(line),
	});
	return { exitCode, stdout, stderr };
}

afterEach(() => {
	for (const path of roots.splice(0))
		rmSync(path, { recursive: true, force: true });
});

describe("flywheel-comm adopt-inflight", () => {
	it("rejects invalid arguments with exit 2", () => {
		expect(run(["--kind", "lead"]).exitCode).toBe(2);
		expect(run(["--recipient", "lead-a", "--kind", "bridge"]).exitCode).toBe(2);
	});

	it("does not create a missing database", () => {
		const dbPath = join(root(), "missing", "comm.db");
		const result = run([
			"--db",
			dbPath,
			"--recipient",
			"lead-a",
			"--kind",
			"lead",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stderr.join("\n")).toMatch(/WARNING.*missing/i);
		expect(existsSync(dbPath)).toBe(false);
		expect(existsSync(dirname(dbPath))).toBe(false);
	});

	it("does not open or mutate a rollback-journal legacy database", () => {
		const dbPath = join(root(), "legacy.db");
		const legacy = new Database(dbPath);
		legacy.exec("CREATE TABLE legacy_only (id INTEGER PRIMARY KEY)");
		legacy.close();
		const before = digest(dbPath);
		const filesBefore = readdirSync(dirname(dbPath)).sort();

		const result = run([
			"--db",
			dbPath,
			"--recipient",
			"lead-a",
			"--kind",
			"lead",
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr.join("\n")).toMatch(/WARNING.*legacy/i);
		expect(digest(dbPath)).toBe(before);
		expect(readdirSync(dirname(dbPath)).sort()).toEqual(filesBefore);
	});

	it("leaves main and WAL content unchanged when a live WAL database has the wrong generation", () => {
		const dbPath = join(root(), "wrong-generation.db");
		const writer = new Database(dbPath);
		writer.pragma("journal_mode = WAL");
		writer.pragma("wal_autocheckpoint = 0");
		writer.exec(
			"CREATE TABLE mailbox_migration_meta (singleton INTEGER PRIMARY KEY, schema_generation TEXT NOT NULL)",
		);
		writer
			.prepare(
				"INSERT INTO mailbox_migration_meta (singleton, schema_generation) VALUES (1, 'old')",
			)
			.run();
		const walPath = `${dbPath}-wal`;
		const beforeMain = digest(dbPath);
		const beforeWal = digest(walPath);

		const result = run([
			"--db",
			dbPath,
			"--recipient",
			"lead-a",
			"--kind",
			"lead",
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr.join("\n")).toMatch(/WARNING.*generation/i);
		expect(digest(dbPath)).toBe(beforeMain);
		expect(digest(walPath)).toBe(beforeWal);
		writer.close();
	});

	it("adopts with no schema ensure side effects", () => {
		const dbPath = join(root(), "comm.db");
		const commDb = new CommDB(dbPath);
		commDb.close();
		const queue = new MailboxQueue(dbPath);
		queue.enqueue({
			id: "m1",
			fromAgent: "runner-a",
			toAgent: "lead-a",
			recipientKind: "lead",
			type: "question",
			content: "hello",
			createdAt: "2026-08-11T22:00:00.000Z",
			senderRef: encodeSenderRef(),
		});
		queue.close();
		const db = new Database(dbPath);
		db.exec("DROP INDEX mailbox_lease_expiry");
		db.prepare(
			"UPDATE mailbox SET state = 'LEASED', batch_id = 'batch-1' WHERE id = 'm1'",
		).run();
		db.close();

		const result = run([
			"--db",
			dbPath,
			"--recipient",
			"lead-a",
			"--kind",
			"lead",
		]);

		expect(result).toMatchObject({
			exitCode: 0,
			stdout: ["adopted: 1"],
			stderr: [],
		});
		const inspected = new Database(dbPath);
		expect(
			inspected
				.prepare(
					"SELECT state, lease_retry_count, batch_id, last_error FROM mailbox WHERE id = 'm1'",
				)
				.get(),
		).toEqual({
			state: "QUEUED",
			lease_retry_count: 1,
			batch_id: null,
			last_error: "recipient_reborn",
		});
		expect(
			inspected
				.prepare(
					"SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'mailbox_lease_expiry'",
				)
				.get(),
		).toBeUndefined();
		inspected.close();
	});
});
