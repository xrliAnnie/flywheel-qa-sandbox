import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const cli = join(repoRoot, "packages/raya-cos/dist/cli.js");

function run(args, cwd = repoRoot) {
	return execFileSync(process.execPath, [cli, ...args], {
		cwd,
		encoding: "utf8",
	}).trim();
}

test("built Raya CoS CLI is present", () => {
	assert.equal(
		existsSync(cli),
		true,
		`${cli} is missing; build the package first`,
	);
});

test("daily-report-date runs through the built executable", () => {
	assert.equal(
		run([
			"daily-report-date",
			"--now",
			"2026-09-09T01:00:00Z",
			"--timezone",
			"America/Los_Angeles",
			"--time",
			"18:00",
		]),
		"2026-09-08",
	);
});

test("migration plan and status stay read-only in an empty workspace", () => {
	const workspace = mkdtempSync(join(tmpdir(), "raya-cos-dist-"));
	try {
		const migration = JSON.parse(
			run(["daily-report-migration-plan"], workspace),
		);
		assert.equal(migration.kind, "daily_report_migration");
		assert.deepEqual(migration.entries, []);
		assert.equal(existsSync(join(workspace, "state")), false);
		assert.deepEqual(JSON.parse(run(["status"], workspace)), {
			schemaVersion: 2,
			operations: [],
		});
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("status rejects unknown flags", () => {
	const result = spawnSync(
		process.execPath,
		[cli, "status", "--ignored", "yes"],
		{
			cwd: repoRoot,
			encoding: "utf8",
		},
	);
	assert.notEqual(result.status, 0);
});

test("prepare rejects input outside its workspace", () => {
	const workspace = mkdtempSync(join(tmpdir(), "raya-cos-dist-"));
	const outside = mkdtempSync(join(tmpdir(), "raya-cos-outside-"));
	try {
		const result = spawnSync(
			process.execPath,
			[cli, "prepare", "--input", join(outside, "input.json")],
			{ cwd: workspace, encoding: "utf8" },
		);
		assert.notEqual(result.status, 0);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});
