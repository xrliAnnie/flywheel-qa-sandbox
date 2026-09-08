import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { withManagedSnapshots } from "../flywheel-snapshot-control.mjs";

const execFileAsync = promisify(execFile);

test("the trusted disk launcher ignores executable overrides through source and symlink", async () => {
	const helper = fileURLToPath(
		new URL("../flywheel-snapshot-control.mjs", import.meta.url),
	);
	const directory = await mkdtemp(join(tmpdir(), "fly2351-launcher-"));
	const linked = join(directory, "flywheel-patrol-snapshot");
	await symlink(helper, linked);
	try {
		for (const entrypoint of [helper, linked]) {
			const { stdout } = await execFileAsync(
				process.execPath,
				[entrypoint, "disk"],
				{ env: { ...process.env, FLYWHEEL_COMM_CLI: "/untrusted/cli.js" } },
			);
			assert.equal(JSON.parse(stdout).disk.volume, "/System/Volumes/Data");
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("runner snapshots use the CLI and release in finally", async () => {
	const calls = [];
	const runCli = async (args) => {
		calls.push(args);
		if (args[0] === "release") return { ok: true, status: "deleted" };
		const kind = args[args.indexOf("--kind") + 1];
		return {
			ok: true,
			path: `/tmp/flywheel-snapshots/exec-1/${kind}.db`,
		};
	};

	await assert.rejects(
		withManagedSnapshots(
			{
				label: "test-analysis",
				sources: [
					{ name: "team", source: "/state/teamlead.db", kind: "teamlead" },
					{
						name: "comm",
						source: "/state/comm.db",
						kind: "comm",
						project: "flywheel",
					},
				],
				env: { FLYWHEEL_EXEC_ID: "exec-1" },
			},
			async ({ paths, directory }) => {
				assert.equal(paths.team, `${directory}/teamlead.db`);
				assert.equal(paths.comm, `${directory}/comm.db`);
				throw new Error("analysis failed");
			},
			{ runCli },
		),
		/analysis failed/,
	);
	assert.deepEqual(calls.at(-1), ["release"]);
});

test("the retro report consumes a managed snapshot without making another copy", async () => {
	const source = await readFile(
		new URL("../fly2396-retro-report.mjs", import.meta.url),
		"utf8",
	);
	assert.match(source, /withManagedSnapshots/);
	assert.doesNotMatch(source, /mkdtempSync/);
	assert.doesNotMatch(source, /\.backup/);
});

test("the retention rehearsal keeps database copies inside managed storage", async () => {
	const source = await readFile(
		new URL("../fly-2006-retention-rehearsal.mjs", import.meta.url),
		"utf8",
	);
	assert.match(source, /withManagedSnapshots/);
	assert.doesNotMatch(source, /backupAndVerify/);
	assert.doesNotMatch(source, /copiesDir/);
});
