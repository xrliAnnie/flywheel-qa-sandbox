import {
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { STORE_MANAGED_FLAGS } from "flywheel-config";
import { afterEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

function rawDb(store: StateStore): BetterSqlite3.Database {
	return (store as unknown as { db: { raw: BetterSqlite3.Database } }).db.raw;
}

describe("StateStore FLY-2100 scoped flag values", () => {
	const stores: StateStore[] = [];
	const dirs: string[] = [];

	afterEach(() => {
		for (const store of stores.splice(0)) store.close();
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	async function memoryStore(): Promise<StateStore> {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		return store;
	}

	it("migrates six legacy rows to '*' with a composite PK and one fixed backup", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2100-flags-"));
		dirs.push(dir);
		const dbPath = join(dir, "teamlead.db");
		const legacy = new BetterSqlite3(dbPath);
		legacy.exec(`
			CREATE TABLE flag_values (
				flag_name TEXT PRIMARY KEY,
				has_override INTEGER NOT NULL CHECK (has_override IN (0, 1)),
				raw_value TEXT,
				last_effective TEXT NOT NULL,
				value_last_changed INTEGER,
				revision INTEGER NOT NULL CHECK (revision > 0),
				updated_at INTEGER NOT NULL,
				updated_by TEXT NOT NULL CHECK (length(updated_by) > 0),
				CHECK ((has_override = 1 AND raw_value IS NOT NULL) OR
					(has_override = 0 AND raw_value IS NULL))
			);
			CREATE TABLE flag_value_changelog (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				flag_name TEXT NOT NULL,
				action TEXT NOT NULL,
				from_present INTEGER,
				from_raw TEXT,
				to_present INTEGER NOT NULL,
				to_raw TEXT,
				from_effective TEXT,
				to_effective TEXT NOT NULL,
				changed_by TEXT NOT NULL,
				changed_at INTEGER NOT NULL,
				reason TEXT NOT NULL
			);
		`);
		const insert = legacy.prepare(
			`INSERT INTO flag_values (
				flag_name, has_override, raw_value, last_effective,
				value_last_changed, revision, updated_at, updated_by
			) VALUES (?, 0, NULL, 'false', NULL, 1, 10, 'legacy')`,
		);
		for (const name of STORE_MANAGED_FLAGS) insert.run(name);
		legacy
			.prepare(
				`INSERT INTO flag_value_changelog (
					flag_name, action, from_present, from_raw, to_present, to_raw,
					from_effective, to_effective, changed_by, changed_at, reason
				) VALUES ('loop_profiler', 'seed', NULL, NULL, 0, NULL, NULL,
					'false', 'legacy', 10, 'legacy seed')`,
			)
			.run();
		legacy.close();

		const store = await StateStore.create(dbPath);
		stores.push(store);
		const db = rawDb(store);
		const columns = db.pragma("table_info(flag_values)") as Array<{
			name: string;
			pk: number;
		}>;
		expect(
			columns
				.filter(({ pk }) => pk > 0)
				.sort((left, right) => left.pk - right.pk)
				.map(({ name }) => name),
		).toEqual(["flag_name", "scope"]);
		expect(db.prepare("SELECT DISTINCT scope FROM flag_values").all()).toEqual([
			{ scope: "*" },
		]);
		expect(
			db.prepare("SELECT COUNT(*) AS count FROM flag_values").get(),
		).toEqual({ count: STORE_MANAGED_FLAGS.size });
		expect(store.listFlagValueChanges("loop_profiler")).toEqual([
			expect.objectContaining({ scope: "*", reason: "legacy seed" }),
		]);

		const backupPath = `${dbPath}.pre-fly2100.bak`;
		expect(existsSync(backupPath)).toBe(true);
		const backupBefore = statSync(backupPath);
		const backup = new BetterSqlite3(backupPath, { readonly: true });
		expect(
			(backup.pragma("table_info(flag_values)") as Array<{ name: string }>).map(
				({ name }) => name,
			),
		).not.toContain("scope");
		backup.close();

		store.close();
		stores.splice(stores.indexOf(store), 1);
		const reopened = await StateStore.create(dbPath);
		stores.push(reopened);
		const backupAfter = statSync(backupPath);
		expect(backupAfter.size).toBe(backupBefore.size);
		expect(backupAfter.mtimeMs).toBe(backupBefore.mtimeMs);
	});

	it("reuses the same backup when a failed migration is retried", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly2100-flags-fail-"));
		dirs.push(dir);
		const dbPath = join(dir, "teamlead.db");
		const store = await StateStore.create(dbPath);
		stores.push(store);
		const db = rawDb(store);
		db.exec(`
			DROP TABLE flag_values;
			CREATE TABLE flag_values (
				flag_name TEXT PRIMARY KEY,
				has_override INTEGER NOT NULL,
				raw_value TEXT,
				last_effective TEXT NOT NULL,
				value_last_changed INTEGER,
				revision INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			INSERT INTO flag_values VALUES (
				'loop_profiler', 0, NULL, 'true', NULL, 1, 10
			);
		`);

		expect(() => store.migrate()).toThrow(/updated_by/);
		const backupPath = `${dbPath}.pre-fly2100.bak`;
		expect(existsSync(backupPath)).toBe(true);
		const before = statSync(backupPath);
		expect(() => store.migrate()).toThrow(/updated_by/);
		const after = statSync(backupPath);
		expect(after.size).toBe(before.size);
		expect(after.mtimeMs).toBe(before.mtimeMs);
		expect(
			readdirSync(dir).filter((name) => name.includes("pre-fly2100")),
		).toEqual(["teamlead.db.pre-fly2100.bak"]);
	});

	it("sets and clears scoped rows while preserving scope in the append-only audit", async () => {
		const store = await memoryStore();
		expect(store.getFlagValueChangeSeq("doc_flow", "flywheel")).toBe(0);
		expect(
			store.applyScopedFlagValueChange({
				name: "doc_flow",
				scope: "flywheel",
				op: "set",
				rawTo: "1",
				expectedChangeSeq: 0,
				actor: "bridge-local-operator",
				reason: "enable docs for flywheel",
				now: 100,
			}),
		).toMatchObject({ ok: true, deleted: false });
		expect(store.getFlagValueRow("doc_flow", "flywheel")).toMatchObject({
			flagName: "doc_flow",
			scope: "flywheel",
			hasOverride: true,
			raw: "1",
			lastEffective: "true",
			revision: 1,
		});
		expect(store.listScopedFlagValueRows()).toEqual([
			expect.objectContaining({ flagName: "doc_flow", scope: "flywheel" }),
		]);

		const setSeq = store.getFlagValueChangeSeq("doc_flow", "flywheel");
		expect(setSeq).toBeGreaterThan(0);
		expect(
			store.applyScopedFlagValueChange({
				name: "doc_flow",
				scope: "flywheel",
				op: "clear",
				rawTo: null,
				expectedChangeSeq: setSeq,
				actor: "bridge-local-operator",
				reason: "inherit again",
				now: 200,
			}),
		).toMatchObject({ ok: true, deleted: true });
		expect(store.getFlagValueRow("doc_flow", "flywheel")).toBeUndefined();
		expect(store.listFlagValueChanges("doc_flow", "flywheel")).toEqual([
			expect.objectContaining({
				scope: "flywheel",
				action: "set",
				toPresent: true,
				toRaw: "1",
				toEffective: "true",
			}),
			expect.objectContaining({
				scope: "flywheel",
				action: "clear",
				toPresent: false,
				toRaw: null,
				toEffective: "inherit",
			}),
		]);
	});

	it("uses changelog sequence CAS so delete and recreate cannot cause ABA", async () => {
		const store = await memoryStore();
		const set = (scope: string, expectedChangeSeq: number) =>
			store.applyScopedFlagValueChange({
				name: "doc_flow",
				scope,
				op: "set",
				rawTo: "1",
				expectedChangeSeq,
				actor: "bridge-local-operator",
				reason: "CAS test",
			});
		const clear = (scope: string, expectedChangeSeq: number) =>
			store.applyScopedFlagValueChange({
				name: "doc_flow",
				scope,
				op: "clear",
				rawTo: null,
				expectedChangeSeq,
				actor: "bridge-local-operator",
				reason: "CAS test",
			});

		expect(set("flywheel", 0)).toMatchObject({ ok: true });
		const reviewedExisting = store.getFlagValueChangeSeq(
			"doc_flow",
			"flywheel",
		);
		expect(clear("flywheel", reviewedExisting)).toMatchObject({ ok: true });
		const afterDelete = store.getFlagValueChangeSeq("doc_flow", "flywheel");
		expect(set("flywheel", afterDelete)).toMatchObject({ ok: true });
		expect(set("flywheel", reviewedExisting)).toEqual({
			ok: false,
			reason: "stale_change_seq",
			currentChangeSeq: store.getFlagValueChangeSeq("doc_flow", "flywheel"),
		});

		const reviewedMissing = store.getFlagValueChangeSeq(
			"doc_flow",
			"new-project",
		);
		expect(reviewedMissing).toBe(0);
		expect(set("new-project", reviewedMissing)).toMatchObject({ ok: true });
		const inserted = store.getFlagValueChangeSeq("doc_flow", "new-project");
		expect(clear("new-project", inserted)).toMatchObject({ ok: true });
		expect(set("new-project", reviewedMissing)).toEqual({
			ok: false,
			reason: "stale_change_seq",
			currentChangeSeq: store.getFlagValueChangeSeq("doc_flow", "new-project"),
		});
	});

	it("rejects invalid flag/scope identities and a clear of a missing row", async () => {
		const store = await memoryStore();
		expect(
			store.applyScopedFlagValueChange({
				name: "mailbox_queue",
				scope: "flywheel",
				op: "set",
				rawTo: "1",
				expectedChangeSeq: 0,
				actor: "bridge-local-operator",
				reason: "must fail",
			}),
		).toEqual({ ok: false, reason: "not_project_store_managed" });
		expect(
			store.applyScopedFlagValueChange({
				name: "doc_flow",
				scope: "",
				op: "set",
				rawTo: "1",
				expectedChangeSeq: 0,
				actor: "bridge-local-operator",
				reason: "must fail",
			}),
		).toEqual({ ok: false, reason: "invalid_scope" });
		expect(
			store.applyScopedFlagValueChange({
				name: "doc_flow",
				scope: "flywheel",
				op: "clear",
				rawTo: null,
				expectedChangeSeq: 0,
				actor: "bridge-local-operator",
				reason: "nothing to clear",
			}),
		).toEqual({ ok: false, reason: "missing_row" });

		rawDb(store)
			.prepare(
				`INSERT INTO flag_values (
					flag_name, scope, has_override, raw_value, last_effective,
					value_last_changed, revision, updated_at, updated_by
				) VALUES ('mailbox_queue', 'flywheel', 1, '1', 'true', NULL, 1, 1, 'test')`,
			)
			.run();
		expect(() => store.ensureFlagValueRows({ env: {} })).toThrow(
			/invalid flag_values identity: mailbox_queue.*flywheel/,
		);
	});
});
