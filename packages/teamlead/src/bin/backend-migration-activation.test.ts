import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const probes = vi.hoisted(() => ({
	old: "dead",
	other: "dead",
	command:
		"node /root/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js",
}));
vi.mock("flywheel-comm/lead-lease", async (original) => ({
	...(await original<any>()),
	processTupleStateWithStart: (pid: number) =>
		pid === 100 ? probes.old : pid === 200 ? "alive" : probes.other,
}));
vi.mock("./backend-migration-process.js", () => ({
	observeMigrationCarrier: async () => ({
		pid: 200,
		start: "new-start",
		command: probes.command,
	}),
}));

import {
	LeadLeaseStore,
	publishCarrierRuntimeAssertion,
} from "flywheel-comm/lead-lease";
import { observeMigrationActivation } from "./backend-migration-activation.js";

const dirs: string[] = [];
beforeEach(() => {
	probes.old = "dead";
	probes.other = "dead";
	probes.command =
		"node /root/packages/teamlead/dist/lead-backends/codex/codex-lead-tui-runtime.js";
});
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture() {
	const home = mkdtempSync(join(tmpdir(), "fly2459-active-"));
	dirs.push(home);
	const path = join(home, ".flywheel/lead-lease.db");
	new LeadLeaseStore(path).close();
	const db = new Database(path);
	db.prepare(
		"INSERT INTO lead_lease (lead_key,project,lead_id,identity_digest,generation,holder_pid,holder_start,acquired_at,acquired_by) VALUES (?,?,?,?,?,?,?,?,?)",
	).run(
		"flywheel-flywheel-product-lead",
		"flywheel",
		"flywheel-product-lead",
		"a".repeat(64),
		1,
		200,
		"new-start",
		"now",
		"test",
	);
	db.close();
	publishCarrierRuntimeAssertion({
		env: {
			FLYWHEEL_LEAD_CARRIER_ASSERTION_DIR: join(
				home,
				".flywheel/state/carrier-assertions",
			),
		},
		leadKey: "flywheel-flywheel-product-lead",
		identityDigest: "a".repeat(64),
		rawCarrierInstanceId: "test",
		pid: 200,
		lstart: "new-start",
	});
	return {
		home,
		root: "/root",
		uid: 501,
		identityDigest: "a".repeat(64),
		oldCarrier: { pid: 100, start: "old-start" },
		assertWindow: () => {},
	};
}
it("binds observed TUI, runtime identity and live lease to one carrier", async () => {
	expect(await observeMigrationActivation(fixture())).toMatch(/^[a-f0-9]{64}$/);
});
it.each(["alive", "sensor_error"])(
	"rejects old carrier state %s",
	async (state) => {
		probes.old = state;
		await expect(observeMigrationActivation(fixture())).rejects.toThrow();
	},
);
it("rejects a different live lease owner", async () => {
	const f = fixture();
	const db = new Database(join(f.home, ".flywheel/lead-lease.db"));
	db.exec("UPDATE lead_lease SET holder_pid=300, holder_start='other'");
	db.close();
	probes.other = "alive";
	await expect(observeMigrationActivation(f)).rejects.toThrow();
});
it("rejects a mismatched canonical identity or headless process", async () => {
	const f = fixture();
	await expect(
		observeMigrationActivation({ ...f, identityDigest: "b".repeat(64) }),
	).rejects.toThrow();
	probes.command = "node /root/headless.js";
	await expect(observeMigrationActivation(f)).rejects.toThrow();
});
it("accepts carrier authorization without inventing a lease row", async () => {
	const f = fixture();
	const db = new Database(join(f.home, ".flywheel/lead-lease.db"));
	db.exec("DELETE FROM lead_lease");
	db.close();
	expect(await observeMigrationActivation(f)).toMatch(/^[a-f0-9]{64}$/);
});

it("accepts the generic launcher's scripts/../dist runtime argv", async () => {
	probes.command =
		"node /root/packages/teamlead/scripts/../dist/lead-backends/codex/codex-lead-tui-runtime.js";
	expect(await observeMigrationActivation(fixture())).toMatch(/^[a-f0-9]{64}$/);
});
it.each([
	"node /foreign/packages/teamlead/scripts/../dist/lead-backends/codex/codex-lead-tui-runtime.js",
	"node /root/packages/teamlead/scripts/../dist/lead-backends/codex/codex-lead-tui-runtime.js --extra",
	"node /root/packages/teamlead/scripts/../dist/lead-backends/codex/codex-lead-runtime.js",
])("rejects a different generic runtime command: %s", async (command) => {
	probes.command = command;
	await expect(observeMigrationActivation(fixture())).rejects.toThrow(
		"migration activation identity unproven",
	);
});

it("observes the runtime argv from codex-lead.sh's actual TUI exec", async () => {
	const f = fixture();
	const launcher = readFileSync(
		new URL("../../scripts/codex-lead.sh", import.meta.url),
		"utf8",
	);
	const assignment = launcher
		.split("\n")
		.find((line) => line.trim().startsWith("TUI_RUNTIME_DIST="));
	const exec = launcher
		.split("\n")
		.find((line) => line.trim() === 'exec node "$TUI_RUNTIME_DIST"');
	expect(assignment).toBeTruthy();
	expect(exec).toBeTruthy();
	writeFileSync(
		join(f.home, "node"),
		'#!/bin/bash\nprintf node; printf " %s" "$@"\n',
		{ mode: 0o700 },
	);
	probes.command = execFileSync(
		"/bin/bash",
		[
			"-c",
			`SCRIPT_DIR="$1"; ${assignment}; ${exec}`,
			"test-codex-exec",
			"/root/packages/teamlead/scripts",
		],
		{ encoding: "utf8", env: { PATH: f.home } },
	);
	expect(await observeMigrationActivation(f)).toMatch(/^[a-f0-9]{64}$/);
});
