import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
	alertSnapshotRefusal,
	withManagedSnapshots,
} from "../flywheel-snapshot-control.mjs";

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

test("the launcher reports a missing or wrong checkout-local export structurally", async () => {
	const source = fileURLToPath(
		new URL("../flywheel-snapshot-control.mjs", import.meta.url),
	);
	for (const wrongExport of [false, true]) {
		const root = await mkdtemp(join(tmpdir(), "fly2351-helper-missing-"));
		const helper = join(root, "scripts", "flywheel-snapshot-control.mjs");
		await mkdir(join(root, "scripts"), { recursive: true });
		await copyFile(source, helper);
		if (wrongExport) {
			await mkdir(join(root, "packages/flywheel-comm/dist/commands"), {
				recursive: true,
			});
			await writeFile(join(root, "package.json"), '{"type":"module"}\n');
			await writeFile(
				join(root, "packages/flywheel-comm/dist/commands/snapshot.js"),
				"export const wrong = true;\n",
			);
		}
		try {
			await assert.rejects(
				execFileAsync(process.execPath, [helper, "disk"]),
				(error) => {
					assert.deepEqual(JSON.parse(error.stderr.trim()), {
						ok: false,
						reason: "snapshot_helper_missing",
						retryable: false,
						unavailable: ["structural: snapshot_helper_missing"],
					});
					return true;
				},
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
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

test("runner callbacks receive a budget guard bound to their owner directory", async () => {
	const calls = [];
	const runCli = async (args) => {
		calls.push(args);
		return args[0] === "release"
			? { ok: true, status: "deleted" }
			: {
					ok: true,
					path: "/tmp/flywheel-snapshots/exec-1/teamlead.db",
				};
	};
	const withManagedSnapshotBudget = async (input, operation) => {
		calls.push(input);
		return operation();
	};

	const result = await withManagedSnapshots(
		{
			label: "test-analysis",
			sources: [
				{ name: "team", source: "/state/teamlead.db", kind: "teamlead" },
			],
			env: { FLYWHEEL_EXEC_ID: "exec-1" },
		},
		({ withBudget }) => withBudget(123, async () => "ok"),
		{ runCli, withManagedSnapshotBudget },
	);

	assert.equal(result, "ok");
	assert.deepEqual(calls.at(-2), {
		executionDirectory: "/tmp/flywheel-snapshots/exec-1",
		additionalBytes: 123,
	});
	assert.deepEqual(calls.at(-1), ["release"]);
});

test("a failed release cannot hide the original runner snapshot failure", async () => {
	const runCli = async (args) => {
		throw new Error(
			args[0] === "release" ? "release failed" : "acquire failed",
		);
	};

	await assert.rejects(
		withManagedSnapshots(
			{
				label: "test-analysis",
				sources: [
					{ name: "team", source: "/state/teamlead.db", kind: "teamlead" },
				],
				env: { FLYWHEEL_EXEC_ID: "exec-1" },
			},
			async () => {},
			{ runCli },
		),
		/acquire failed/,
	);
});

test("a Data-volume refusal invokes the bounded existing alert sink", () => {
	const calls = [];
	for (const reason of [
		"insufficient_data_volume",
		"data_volume_unavailable",
	]) {
		alertSnapshotRefusal({ ok: false, reason }, (args) => calls.push(args));
	}
	alertSnapshotRefusal(
		{ ok: false, reason: "invalid_snapshot_arguments" },
		(args) => calls.push(args),
	);

	assert.equal(calls.length, 2);
	assert.deepEqual(calls[0], [
		"snapshot-storage-refused",
		"Flywheel database snapshot refused",
		"reason=insufficient_data_volume volume=/System/Volumes/Data write_refused=yes",
	]);
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
	assert.match(
		source,
		/const evidenceDir = join\(input\.rehearsalDir, "evidence"\)/,
	);
	assert.doesNotMatch(
		source,
		/join\(input\.snapshotDirectory, "fly-2006-evidence"\)/,
	);
	assert.match(source, /input\.withBudget/);
	assert.doesNotMatch(source, /backupAndVerify/);
	assert.doesNotMatch(source, /copiesDir/);
});
