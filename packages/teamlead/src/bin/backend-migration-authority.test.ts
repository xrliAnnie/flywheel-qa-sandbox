import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ sha: "a".repeat(40), owner: true }));
vi.mock("node:child_process", () => ({ execFileSync: () => probe.sha }));
vi.mock("flywheel-comm/lead-backend-migration-runtime", async (original) => ({
	...(await original<any>()),
	assertMigrationRestartOwner: () => {
		if (!probe.owner) throw Error("wrong owner");
		return "owner-proof";
	},
}));

import { createMigrationWindowGuard } from "./backend-migration-authority.js";

const dirs: string[] = [];
beforeEach(() => {
	probe.sha = "a".repeat(40);
	probe.owner = true;
});
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture() {
	const home = mkdtempSync(join(tmpdir(), "fly2459-authority-"));
	dirs.push(home);
	mkdirSync(join(home, ".flywheel"));
	const dbPath = join(home, ".flywheel/teamlead.db"),
		db = new Database(dbPath);
	db.exec(
		"CREATE TABLE admission_pause (id INTEGER PRIMARY KEY, lease_id TEXT, paused_until TEXT, set_by TEXT, reason TEXT, set_at TEXT)",
	);
	const leaseId = "12345678-1234-4234-8234-123456789abc",
		at = new Date(Date.now() - 1000).toISOString();
	db.prepare("INSERT INTO admission_pause VALUES (1,?,?,?,?,?)").run(
		leaseId,
		new Date(Date.now() + 60000).toISOString(),
		"bridge-admission-api",
		`restart-services:updater:pid=123:started=${at}`,
		at,
	);
	db.close();
	const trusted = { home, root: "/root" };
	const context = JSON.stringify({
		...trusted,
		restartPid: 123,
		restartStart: "start",
		lockDev: 1,
		lockIno: 2,
		leaseId,
		restartScript: "/root/scripts/restart-services.sh",
		updaterScript: "/root/scripts/update-flywheel.sh",
	});
	return { trusted, context, dbPath };
}
it("accepts the current target HEAD and live owned pause without a deployed-sha marker", () => {
	const f = fixture();
	expect(() =>
		createMigrationWindowGuard(
			f.context,
			f.trusted,
			"a".repeat(40),
			f.dbPath,
		)(),
	).not.toThrow();
});
it("rechecks checkout identity on every guarded action", () => {
	const f = fixture(),
		guard = createMigrationWindowGuard(
			f.context,
			f.trusted,
			"a".repeat(40),
			f.dbPath,
		);
	guard();
	probe.sha = "b".repeat(40);
	expect(guard).toThrow("deployment HEAD");
});
it("rejects loss of owner or admission lease", () => {
	const f = fixture(),
		guard = createMigrationWindowGuard(
			f.context,
			f.trusted,
			"a".repeat(40),
			f.dbPath,
		);
	probe.owner = false;
	expect(guard).toThrow("wrong owner");
	probe.owner = true;
	const db = new Database(f.dbPath);
	db.exec("DELETE FROM admission_pause");
	db.close();
	expect(guard).toThrow("admission pause");
});
