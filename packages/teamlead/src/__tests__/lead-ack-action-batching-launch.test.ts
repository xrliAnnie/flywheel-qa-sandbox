import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { readLeadAckActionBatchingAtLaunch } from "../lead-ack-action-batching.js";

it("reads the shared project flag without migrating or writing the database", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2909-launch-read-"));
	const path = join(root, "flags.db");
	const db = new Database(path);
	try {
		db.exec(
			"CREATE TABLE flag_values(flag_name TEXT, scope TEXT, has_override INTEGER, raw_value TEXT)",
		);
		const read = (project = "flywheel") =>
			readLeadAckActionBatchingAtLaunch(project, path);
		expect(read()).toBe(false);
		db.prepare("INSERT INTO flag_values VALUES (?, ?, 1, ?)").run(
			"lead_ack_action_batching",
			"*",
			"0",
		);
		expect(read()).toBe(false);
		db.prepare("INSERT INTO flag_values VALUES (?, ?, 1, ?)").run(
			"lead_ack_action_batching",
			"flywheel",
			"1",
		);
		const before = readFileSync(path);
		expect(read()).toBe(true);
		expect(read("another-project")).toBe(false);
		const scripts = fileURLToPath(new URL("../../scripts", import.meta.url));
		const launch = (project: string) =>
			execFileSync(
				"bash",
				[
					"-c",
					'source "$1/lead-rules-bundle.sh"; lead_ack_action_batching_read_launch "$2"; printf "%s" "$_LEAD_ACK_ACTION_BATCHING_LAUNCH"',
					"fixture",
					scripts,
					project,
				],
				{
					encoding: "utf8",
					env: {
						...process.env,
						TEAMLEAD_DB_PATH: path,
						BASH_ENV: "/dev/null",
					},
				},
			);
		expect(launch("flywheel")).toBe("1");
		expect(launch("another-project")).toBe("0");
		expect(readFileSync(path)).toEqual(before);
		expect(
			db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(),
		).toEqual([{ name: "flag_values" }]);
		db.prepare(
			"UPDATE flag_values SET raw_value='0' WHERE scope='flywheel'",
		).run();
		expect(read()).toBe(false);
		expect(launch("flywheel")).toBe("0");
		db.prepare("DELETE FROM flag_values WHERE scope='flywheel'").run();
		db.prepare("UPDATE flag_values SET raw_value='1' WHERE scope='*'").run();
		expect(read()).toBe(true);
		db.prepare("DELETE FROM flag_values").run();
		expect(read()).toBe(false);
	} finally {
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});

it("selects full behavior for absent or malformed stores without creating a database", () => {
	const root = mkdtempSync(join(tmpdir(), "fly2909-launch-unavailable-"));
	const path = join(root, "flags.db");
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		expect(readLeadAckActionBatchingAtLaunch("flywheel", path)).toBe(false);
		expect(existsSync(path)).toBe(false);
		const db = new Database(path);
		db.exec(
			"CREATE TABLE flag_values(flag_name TEXT, scope TEXT, has_override INTEGER, raw_value TEXT)",
		);
		db.prepare("INSERT INTO flag_values VALUES (?, ?, 1, ?)").run(
			"lead_ack_action_batching",
			"flywheel",
			"invalid",
		);
		db.close();
		expect(readLeadAckActionBatchingAtLaunch("flywheel", path)).toBe(false);
		expect(warn).toHaveBeenCalled();
	} finally {
		warn.mockRestore();
		rmSync(root, { recursive: true, force: true });
	}
});
