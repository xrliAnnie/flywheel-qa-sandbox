import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
	command: "",
	source: true,
	plist: true,
	absent: false,
}));
vi.mock("./backend-migration-process.js", () => {
	class MigrationCarrierAbsentError extends Error {}
	return {
		MigrationCarrierAbsentError,
		observeMigrationCarrier: async () => {
			if (probe.absent) throw new MigrationCarrierAbsentError();
			return { pid: 200, start: "source-start", command: probe.command };
		},
	};
});
vi.mock("flywheel-comm/lead-lease", async (original) => ({
	...(await original<any>()),
	processTupleStateWithStart: () => "alive",
}));
vi.mock("flywheel-comm/lead-backend-migration-runtime", async (original) => ({
	...(await original<any>()),
	observeMigrationRegistry: () => ({
		state: probe.source ? "pre" : "post",
		proofSha: "e".repeat(64),
	}),
	observeMigrationArtifact: (_h: string, _e: unknown, kind: string) => ({
		state: "pre",
		proofSha:
			kind === "manifest"
				? "b".repeat(64)
				: probe.plist
					? "c".repeat(64)
					: "d".repeat(64),
	}),
}));

import { LeadLeaseStore } from "flywheel-comm/lead-lease";
import { deriveLeadSocketPath } from "../lead-address.js";
import { observeMigrationSource } from "./backend-migration-activation.js";

const dirs: string[] = [];
beforeEach(() => {
	probe.source = true;
	probe.plist = true;
	probe.absent = false;
});
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture() {
	const home = mkdtempSync("/tmp/f2459-");
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
		"source-start",
		"now",
		"test",
	);
	db.close();
	const socket = deriveLeadSocketPath(
		"flywheel/flywheel-product-lead",
		join(home, ".flywheel"),
	);
	probe.command = `/opt/homebrew/bin/tmux -D -S ${socket} -f ${home}/.flywheel/run/leads/flywheel-flywheel-product-lead/tmux.conf`;
	return {
		home,
		uid: 501,
		identityDigest: "a".repeat(64),
		plan: {
			expected: { manifestSha: "b".repeat(64), plistSha: "c".repeat(64) },
		} as any,
		target: { manifest: "target", plist: "target" },
		assertWindow: () => {},
		assertStopped: () => {},
	};
}
it("proves the source carrier with matching original artifacts and lease identity", async () => {
	const result = await observeMigrationSource(fixture());
	expect(result?.carrier.pid).toBe(200);
	expect(result?.proofSha).toMatch(/^[a-f0-9]{64}$/);
});
it.each(["registry", "plist"])(
	"does not treat partial restored %s as a running source",
	async (field) => {
		const f = fixture();
		if (field === "registry") probe.source = false;
		else probe.plist = false;
		expect(await observeMigrationSource(f)).toBeNull();
	},
);
it("rejects a live lease with another identity", async () => {
	const f = fixture(),
		db = new Database(join(f.home, ".flywheel/lead-lease.db"));
	db.exec("UPDATE lead_lease SET identity_digest='foreign'");
	db.close();
	await expect(observeMigrationSource(f)).rejects.toThrow();
});
it("returns not-restored after files recover but before the old job is installed", async () => {
	const f = fixture();
	probe.absent = true;
	expect(await observeMigrationSource(f)).toBeNull();
});

it.each(["socket", "config", "binary", "arguments", "wrapper"])(
	"rejects source carrier with mismatched %s",
	async (part) => {
		const f = fixture();
		if (part === "socket")
			probe.command = probe.command.replace(".sock", "-foreign.sock");
		if (part === "config")
			probe.command = probe.command.replace("/tmux.conf", "/foreign.conf");
		if (part === "binary")
			probe.command = probe.command.replace("/bin/tmux", "/bin/not-tmux");
		if (part === "arguments") probe.command += " extra";
		if (part === "wrapper")
			probe.command = `/bin/bash ${f.home}/.flywheel/bin/flywheel-lead-wrapper-v2.sh ${f.home}/.flywheel/manifests/flywheel-flywheel-product-lead.json`;
		await expect(observeMigrationSource(f)).rejects.toThrow(
			"migration source carrier mismatch",
		);
	},
);

it("observes the argv produced by the v2 wrapper's actual final exec", async () => {
	const f = fixture();
	const tmux = join(f.home, "tmux");
	writeFileSync(tmux, '#!/bin/bash\nprintf "%s" "$0"; printf " %s" "$@"\n', {
		mode: 0o700,
	});
	const wrapper = readFileSync(
		new URL("../../../../scripts/flywheel-lead-wrapper-v2.sh", import.meta.url),
		"utf8",
	);
	const exec = wrapper.trim().split("\n").at(-1);
	expect(exec).toMatch(/^exec env -i /);
	probe.command = execFileSync(
		"/bin/bash",
		[
			"-c",
			`SERVER_ENV=(); TMUX_BIN="$1"; SOCKET_PATH="$2"; TMUX_CONF="$3"; ${exec}`,
			"test-wrapper-exec",
			tmux,
			deriveLeadSocketPath(
				"flywheel/flywheel-product-lead",
				join(f.home, ".flywheel"),
			),
			join(
				f.home,
				".flywheel/run/leads/flywheel-flywheel-product-lead/tmux.conf",
			),
		],
		{ encoding: "utf8", env: { PATH: "/usr/bin:/bin" } },
	);
	expect((await observeMigrationSource(f))?.proofSha).toMatch(/^[a-f0-9]{64}$/);
});
