import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import {
	assertMigrationAdmissionWindow,
	assertMigrationOutsideWindow,
} from "../lead-backend-migration-window.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "fly2459-window-"));
	dirs.push(dir);
	const path = join(dir, "state.db");
	const db = new Database(path);
	db.exec(
		"CREATE TABLE admission_pause (id INTEGER PRIMARY KEY,lease_id TEXT,paused_until TEXT,set_by TEXT,reason TEXT,set_at TEXT)",
	);
	const leaseId = "12345678-1234-4234-8234-123456789012";
	db.prepare("INSERT INTO admission_pause VALUES(1,?,?,?,?,?)").run(
		leaseId,
		"2026-09-11T01:00:00.000Z",
		"bridge-admission-api",
		"restart-services:updater:pid=123:started=2026-09-11T00:00:00Z",
		"2026-09-11T00:00:00.000Z",
	);
	db.close();
	return {
		path,
		input: { leaseId, restartPid: 123, now: "2026-09-11T00:30:00.000Z" },
		assertOwner: () => {},
	};
}
it("reads the owned active admission lease without mutating its database", () => {
	const f = fixture();
	expect(
		assertMigrationAdmissionWindow(f.path, f.input, f.assertOwner),
	).toMatch(/^[a-f0-9]{64}$/);
});
it.each(["owner", "lease", "expired", "foreign_reason", "missing"])(
	"rejects %s window evidence",
	(kind) => {
		const f = fixture();
		if (kind === "owner")
			f.assertOwner = () => {
				throw new Error("not authorized restart owner");
			};
		const db = new Database(f.path);
		if (kind === "lease")
			db.exec("UPDATE admission_pause SET lease_id='other'");
		if (kind === "expired")
			db.exec(
				"UPDATE admission_pause SET paused_until='2026-09-11T00:00:00.000Z'",
			);
		if (kind === "foreign_reason")
			db.exec("UPDATE admission_pause SET reason='manual'");
		if (kind === "missing") db.exec("DELETE FROM admission_pause");
		db.close();
		expect(() =>
			assertMigrationAdmissionWindow(f.path, f.input, f.assertOwner),
		).toThrow();
	},
);

it("outside verifier refuses an owned or stale restart lock before reading admission", async () => {
	const request = vi.fn();
	await expect(
		assertMigrationOutsideWindow({
			restartLockExists: () => true,
			bridgeUrl: "http://127.0.0.1:3000",
			token: "fixture",
			request,
		}),
	).rejects.toThrow("restart window");
	expect(request).not.toHaveBeenCalled();
});
it("outside verifier accepts only explicit inactive admission and rechecks the lock", async () => {
	const request = vi.fn(
		async () =>
			new Response(
				JSON.stringify({ ok: true, admissionPause: { active: false } }),
			),
	);
	await expect(
		assertMigrationOutsideWindow({
			restartLockExists: () => false,
			bridgeUrl: "http://127.0.0.1:3000",
			token: "fixture",
			request,
		}),
	).resolves.toMatch(/^[a-f0-9]{64}$/);
	expect(request.mock.calls[0]?.[0]).toBe(
		"http://127.0.0.1:3000/api/admission/pause",
	);
	for (const body of [
		{ ok: true, admissionPause: { active: true } },
		{ ok: true },
		{ ok: false, admissionPause: { active: false } },
	]) {
		await expect(
			assertMigrationOutsideWindow({
				restartLockExists: () => false,
				bridgeUrl: "http://127.0.0.1:3000",
				token: "fixture",
				request: async () => new Response(JSON.stringify(body)),
			}),
		).rejects.toThrow("admission");
	}
	let checks = 0;
	await expect(
		assertMigrationOutsideWindow({
			restartLockExists: () => ++checks > 1,
			bridgeUrl: "http://127.0.0.1:3000",
			token: "fixture",
			request,
		}),
	).rejects.toThrow("restart window");
});
