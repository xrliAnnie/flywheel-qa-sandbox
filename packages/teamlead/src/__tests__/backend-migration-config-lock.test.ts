import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { withMigrationConfigLock } from "../bin/backend-migration-config-lock.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const home = mkdtempSync(join(tmpdir(), "migration-lock-"));
	dirs.push(home);
	mkdirSync(join(home, ".flywheel"));
	return { home, root: resolve("../.."), assertWindow: () => {} };
}
it("runs a synchronous file transaction under the existing flock and releases it", async () => {
	const f = fixture(),
		path = join(f.home, ".flywheel/projects.json");
	await withMigrationConfigLock(f, (assertHeld) => {
		assertHeld();
		writeFileSync(path, "first");
	});
	await withMigrationConfigLock(f, (assertHeld) => {
		assertHeld();
		expect(readFileSync(path, "utf8")).toBe("first");
		writeFileSync(path, "second");
	});
	expect(readFileSync(path, "utf8")).toBe("second");
});
it("releases the lock when the file transaction rejects", async () => {
	const f = fixture();
	await expect(
		withMigrationConfigLock(f, () => {
			throw Error("CAS conflict");
		}),
	).rejects.toThrow("CAS conflict");
	let called = false;
	await withMigrationConfigLock(f, () => {
		called = true;
	});
	expect(called).toBe(true);
});
it("does not enter the transaction with a revoked window", async () => {
	const f = fixture();
	f.assertWindow = () => {
		throw Error("revoked");
	};
	let called = false;
	await expect(
		withMigrationConfigLock(f, () => {
			called = true;
		}),
	).rejects.toThrow("revoked");
	expect(called).toBe(false);
});
it("excludes another existing-helper writer throughout the transaction", async () => {
	const { spawnSync } = await import("node:child_process");
	const f = fixture();
	await withMigrationConfigLock(f, (assertHeld) => {
		assertHeld();
		const competitor = spawnSync(
			"python3",
			[
				join(f.root, "scripts/flywheel-config-lock.py"),
				process.execPath,
				"-e",
				"process.exit(0)",
			],
			{
				env: {
					...process.env,
					CONFIG_LOCK_FILE: join(f.home, ".flywheel/projects.json.cfglock"),
					CONFIG_LOCK_DEADLINE: "0",
				},
				encoding: "utf8",
				timeout: 3000,
			},
		);
		expect(competitor.error).toBeUndefined();
		expect(competitor.status).toBe(75);
		assertHeld();
	});
});
