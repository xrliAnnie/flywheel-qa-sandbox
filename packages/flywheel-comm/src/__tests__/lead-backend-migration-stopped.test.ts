import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { assertMigrationWriterStopped } from "../lead-backend-migration-stopped.js";
import { LeadLeaseStore } from "../lead-lease.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const home = mkdtempSync(join(tmpdir(), "fly2459-stopped-"));
	dirs.push(home);
	const dbPath = join(home, "leases.db");
	const store = new LeadLeaseStore(dbPath);
	store.close();
	const db = new Database(dbPath);
	db.prepare(
		`INSERT INTO lead_lease (lead_key, project, lead_id, identity_digest, generation, holder_pid, holder_start, acquired_at, acquired_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		"flywheel/flywheel-product-lead",
		"flywheel",
		"flywheel-product-lead",
		"a".repeat(64),
		1,
		42,
		"old-start",
		"2026-09-11T00:00:00.000Z",
		"test",
	);
	db.close();
	return {
		dbPath,
		oldCarrier: { pid: 40, start: "carrier-start" },
		assertWindow: () => {},
		launchdState: () => "unloaded" as const,
		processState: (_pid: number, _start: string) => "dead" as const,
	};
}
it("requires both launchd unloaded and old carrier/lease tuples dead", () => {
	const f = fixture();
	const seen: number[] = [];
	expect(
		assertMigrationWriterStopped({
			...f,
			processState: (pid) => {
				seen.push(pid);
				return "dead";
			},
		}),
	).toMatch(/^[a-f0-9]{64}$/);
	expect(seen).toContain(40);
	expect(seen).toContain(42);
});
it.each(["loaded", "error"] as const)(
	"rejects launchd %s without treating errors as exit",
	(state) => {
		const f = fixture();
		expect(() =>
			assertMigrationWriterStopped({ ...f, launchdState: () => state }),
		).toThrow(/stopped/);
	},
);
it.each(["alive", "sensor_error"] as const)(
	"rejects a lease tuple that is %s",
	(state) => {
		const f = fixture();
		expect(() =>
			assertMigrationWriterStopped({
				...f,
				processState: (pid) => (pid === 42 ? state : "dead"),
			}),
		).toThrow(/stopped/);
	},
);
it("checks the supervisor lease and does not change its row", () => {
	const f = fixture();
	const db = new Database(f.dbPath);
	db.exec(
		"UPDATE lead_lease SET supervisor_pid=43,supervisor_start='supervisor-start'",
	);
	const before = db.prepare("SELECT * FROM lead_lease").all();
	try {
		expect(() =>
			assertMigrationWriterStopped({
				...f,
				processState: (pid) => (pid === 43 ? "alive" : "dead"),
			}),
		).toThrow(/stopped/);
		expect(db.prepare("SELECT * FROM lead_lease").all()).toEqual(before);
	} finally {
		db.close();
	}
});
it("accepts an absent lease row only with the existing unloaded/dead carrier proof", () => {
	const f = fixture();
	const db = new Database(f.dbPath);
	db.exec("DELETE FROM lead_lease");
	db.close();
	expect(assertMigrationWriterStopped(f)).toMatch(/^[a-f0-9]{64}$/);
	expect(() =>
		assertMigrationWriterStopped({ ...f, processState: () => "alive" }),
	).toThrow();
});
