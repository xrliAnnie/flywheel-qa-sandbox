import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { backupDatabase } from "../backup.js";
import { Kernel } from "../kernel.js";
import { migrateDatabase } from "../migrator.js";
import { makeTempDatabase, type TempDatabase } from "./helpers.js";

describe("WAL-safe backup hook", () => {
	let temp: TempDatabase | undefined;
	const kernels: Kernel[] = [];

	afterEach(() => {
		for (const kernel of kernels.splice(0)) {
			kernel.close();
		}
		temp?.cleanup();
		temp = undefined;
	});

	it("backs up uncheckpointed WAL content and validates the independent copy", async () => {
		temp = makeTempDatabase();
		const destination = `${temp.path}.backup`;
		migrateDatabase({ path: temp.path });
		const kernel = Kernel.open({ path: temp.path });
		kernels.push(kernel);
		kernel.write("seed WAL row", (tx) => {
			tx.run(
				`INSERT INTO events(event_uid, kind, cutover_epoch, created_at)
				 VALUES ('wal-event', 'test', 1, '2026-07-27T00:00:00.000Z')`,
			);
		});
		expect(statSync(`${temp.path}-wal`).size).toBeGreaterThan(0);

		await backupDatabase(temp.path, destination);

		const backup = new Database(destination, { readonly: true });
		try {
			expect(backup.pragma("integrity_check", { simple: true })).toBe("ok");
			expect(backup.pragma("foreign_key_check")).toEqual([]);
			expect(
				backup
					.prepare("SELECT event_uid FROM events WHERE event_uid='wal-event'")
					.pluck()
					.get(),
			).toBe("wal-event");
			expect(
				backup
					.prepare("SELECT id FROM schema_migrations ORDER BY id")
					.pluck()
					.all(),
			).toEqual([
				"0001-base-schema",
				"0002-obligations-rebuild",
				"0003-activations-processing-attempts",
				"0004-mailbox-index-family",
				"0005-agents-config-mailbox-rebuild",
			]);
		} finally {
			backup.close();
		}
		expect(statSync(destination).mode & 0o777).toBe(0o600);
		expect(
			readdirSync(temp.dir).filter((entry) =>
				entry.startsWith(`.${basename(destination)}.`),
			),
		).toEqual([]);
	});

	it("protects a pre-existing backup directory before creating temp files", async () => {
		temp = makeTempDatabase();
		const backupDir = `${temp.dir}/shared-backups`;
		const destination = `${backupDir}/snapshot.db`;
		mkdirSync(backupDir, { mode: 0o755 });
		chmodSync(backupDir, 0o755);
		migrateDatabase({ path: temp.path });

		await backupDatabase(temp.path, destination);

		expect(statSync(backupDir).mode & 0o777).toBe(0o700);
		expect(statSync(destination).mode & 0o777).toBe(0o600);
		expect(
			readdirSync(backupDir).filter((entry) =>
				entry.startsWith(`.${basename(destination)}.`),
			),
		).toEqual([]);
	});

	it("refuses to replace an existing destination", async () => {
		temp = makeTempDatabase();
		const destination = `${temp.path}.backup`;
		migrateDatabase({ path: temp.path });
		writeFileSync(destination, "do-not-replace", { mode: 0o600 });

		await expect(backupDatabase(temp.path, destination)).rejects.toMatchObject({
			code: "EEXIST",
		});
		expect(readFileSync(destination, "utf8")).toBe("do-not-replace");
	});

	it("cleans its private temp file when copy validation fails", async () => {
		temp = makeTempDatabase("not-v2.db");
		const destination = `${temp.path}.backup`;
		const invalidSource = new Database(temp.path);
		invalidSource.exec("CREATE TABLE unrelated(id TEXT)");
		invalidSource.close();

		await expect(backupDatabase(temp.path, destination)).rejects.toThrow();
		expect(existsSync(destination)).toBe(false);
		expect(
			readdirSync(temp.dir).filter((entry) =>
				entry.startsWith(`.${basename(destination)}.`),
			),
		).toEqual([]);
	});

	it("does not leak a private temp file when the source cannot open", async () => {
		temp = makeTempDatabase();
		const source = join(temp.dir, "missing.db");
		const destination = join(temp.dir, "snapshot.db");

		await expect(backupDatabase(source, destination)).rejects.toThrow();
		expect(
			readdirSync(temp.dir).filter((entry) =>
				entry.startsWith(`.${basename(destination)}.`),
			),
		).toEqual([]);
	});
});
