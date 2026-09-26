import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { computeCodexHomeInventoryDigest } from "flywheel-claude-runner";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexProcessSnapshot } from "../host-process-snapshot.js";
import { createCodexQuotaHostCollector } from "../host-readiness.js";

const LSTART = "Thu Sep 18 01:00:00 2026";
interface ProcessRow {
	pid: number;
	ucomm: string;
	args: string;
	env?: string;
	lstart?: string;
}
/** FLY-2869: the three ps listings the collector joins (args, ucomm+argv+env, args). */
function processSnapshot(rows: ProcessRow[]): CodexProcessSnapshot {
	const all = rows.length
		? rows
		: [{ pid: 1, ucomm: "launchd", args: "/sbin/launchd" }];
	const args = all
		.map((row) => `${row.pid} ${row.lstart ?? LSTART} ${row.args}`)
		.join("\n");
	return {
		argsBefore: args,
		authoritative: all
			.map(
				(row) =>
					`${row.pid} ${row.lstart ?? LSTART} Ss   ${row.ucomm.padEnd(16)} ${row.env ? `${row.args} ${row.env}` : row.args}`,
			)
			.join("\n"),
		argsAfter: args,
	};
}
const codex = (env: string, extra: Partial<ProcessRow> = {}): ProcessRow => ({
	pid: 12,
	ucomm: "codex",
	args: "/bin/codex app-server",
	env,
	...extra,
});

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function receipt(homes: { home: string; ownership: string }[]) {
	return {
		schemaVersion: 1,
		buildSha: "a".repeat(40),
		inventoryDigest: computeCodexHomeInventoryDigest(
			homes as Array<{ home: string; ownership: "managed" | "independent" }>,
		),
		homes: homes.map((home) => ({
			...home,
			credentialShared: home.ownership === "managed",
			checkedAt: new Date().toISOString(),
		})),
	};
}
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "quota-host-"));
	roots.push(root);
	const homesRoot = join(root, "homes"),
		home = join(homesRoot, "agents", "project", "implement"),
		commRoot = join(root, "comm"),
		canonicalHome = join(root, "canonical");
	mkdirSync(home, { recursive: true });
	mkdirSync(canonicalHome);
	mkdirSync(join(commRoot, "project"), { recursive: true });
	const db = new Database(join(commRoot, "project", "comm.db"));
	db.exec(
		"CREATE TABLE sessions(execution_id TEXT,vendor TEXT,status TEXT,ended_at TEXT,phase_keep_alive INTEGER,tmux_window TEXT,started_at TEXT)",
	);
	db.close();
	const approvedManifestPath = join(root, "approved.json");
	writeFileSync(
		approvedManifestPath,
		JSON.stringify(receipt([{ home, ownership: "managed" }])),
	);
	let processes: ProcessRow[] = [];
	const options = {
		homesRoot,
		canonicalHome,
		commRoot,
		projectNames: ["project"],
		approvedManifestPath,
		leadTargets: [],
		leadAuthorityScript: join(root, "authority"),
		processSnapshot: async () => processSnapshot(processes),
		verifyDesktopCodex: async () => false,
	};
	return {
		root,
		home,
		options,
		setProcesses: (rows: ProcessRow[]) => {
			processes = rows;
		},
		activate: () => {
			const db = new Database(join(commRoot, "project", "comm.db"));
			db.prepare(
				"INSERT INTO sessions(execution_id,vendor,status,ended_at,phase_keep_alive) VALUES(?,?,?,?,?)",
			).run("exec", "codex", "running", null, 0);
			db.close();
			mkdirSync(join(home, ".flywheel-leases"));
			writeFileSync(join(home, ".flywheel-leases", "exec"), "a".repeat(32));
		},
	};
}
it("requires real process plus CommDB plus lease before marking keyed home active", async () => {
	const f = fixture();
	f.activate();
	f.setProcesses([codex(`CODEX_HOME=${f.home} FLYWHEEL_EXEC_ID=exec`)]);
	expect(await createCodexQuotaHostCollector(f.options)()).toMatchObject({
		complete: true,
		homes: [{ home: f.home, activity: "active", ownership: "managed" }],
	});
	f.setProcesses([]);
	expect((await createCodexQuotaHostCollector(f.options)()).complete).toBe(
		false,
	);
});
it("never trusts missing manifests or unowned live homes", async () => {
	const f = fixture();
	expect((await createCodexQuotaHostCollector(f.options)()).complete).toBe(
		true,
	);
	f.setProcesses([codex(`CODEX_HOME=${join(f.root, "unknown")}`)]);
	expect((await createCodexQuotaHostCollector(f.options)()).complete).toBe(
		false,
	);
	rmSync(f.options.approvedManifestPath);
	expect(await createCodexQuotaHostCollector(f.options)()).toMatchObject({
		complete: false,
		failureReasons: ["readiness_receipt_missing"],
	});
});
it("rejects unapproved lease homes even without a live CommDB row", async () => {
	const f = fixture();
	const orphan = join(f.options.homesRoot, "agents", "project", "unknown");
	mkdirSync(join(orphan, ".flywheel-leases"), { recursive: true });
	writeFileSync(join(orphan, ".flywheel-leases", "orphan"), "a".repeat(32));
	expect((await createCodexQuotaHostCollector(f.options)()).complete).toBe(
		false,
	);
});
it("separates independent refresh chains and excludes their accounts before probing", async () => {
	const f = fixture();
	writeFileSync(
		f.options.approvedManifestPath,
		JSON.stringify(receipt([{ home: f.home, ownership: "independent" }])),
	);
	f.setProcesses([codex(`CODEX_HOME=${f.home}`)]);
	let same = false;
	const collector = createCodexQuotaHostCollector({
		...f.options,
		credentialIdentity: async (home) => ({
			accountKey: home === f.home ? "independent-account" : "canonical-account",
			chainKey: home === f.home && !same ? "other-chain" : "canonical-chain",
		}),
	});
	expect(await collector()).toMatchObject({
		complete: true,
		activeUnsharedAccountKeys: ["independent-account"],
	});
	same = true;
	expect((await collector()).complete).toBe(false);
});
it("rejects deployment receipt inventory tampering", async () => {
	const f = fixture();
	const receipt = JSON.parse(
		readFileSync(f.options.approvedManifestPath, "utf8"),
	);
	receipt.inventoryDigest = "bad";
	writeFileSync(f.options.approvedManifestPath, JSON.stringify(receipt));
	expect(await createCodexQuotaHostCollector(f.options)()).toMatchObject({
		complete: false,
		failureReasons: ["readiness_receipt_invalid"],
	});
});
it("allows an approved legacy execution home using exact CommDB and process identity without inventing a keyed lease", async () => {
	const f = fixture();
	const home = join(f.options.homesRoot, "legacy");
	mkdirSync(home);
	writeFileSync(
		f.options.approvedManifestPath,
		JSON.stringify(receipt([{ home, ownership: "managed" }])),
	);
	const db = new Database(join(f.options.commRoot, "project", "comm.db"));
	db.prepare(
		"INSERT INTO sessions(execution_id,vendor,status,ended_at,phase_keep_alive) VALUES(?,?,?,?,?)",
	).run("legacy", "codex", "running", null, 0);
	db.close();
	f.setProcesses([codex(`CODEX_HOME=${home} FLYWHEEL_EXEC_ID=legacy`)]);
	expect(await createCodexQuotaHostCollector(f.options)()).toMatchObject({
		complete: true,
		homes: [{ home, activity: "active" }],
	});
});
it("checks Lead manifest authority again on every collection", async () => {
	const f = fixture();
	const script = f.options.leadAuthorityScript;
	writeFileSync(
		script,
		`#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ codexHome: f.home })}'\n`,
		{ mode: 0o700 },
	);
	f.setProcesses([codex(`CODEX_HOME=${f.home}`)]);
	const collect = createCodexQuotaHostCollector({
		...f.options,
		leadTargets: [{ projectName: "project", leadId: "lead" }],
	});
	expect((await collect()).complete).toBe(true);
	writeFileSync(script, "#!/bin/sh\nexit 1\n");
	expect((await collect()).complete).toBe(false);
});
it("reports direct canonical readers even when canonical is not an enrolled managed home", async () => {
	const f = fixture();
	f.setProcesses([codex(`CODEX_HOME=${f.options.canonicalHome}`)]);
	expect(await createCodexQuotaHostCollector(f.options)()).toMatchObject({
		complete: true,
		canonicalChainActive: true,
	});
	f.setProcesses([]);
	expect(await createCodexQuotaHostCollector(f.options)()).toMatchObject({
		complete: true,
		canonicalChainActive: false,
	});
});

it("uses strict resident evidence for a keyed active home without a lease", async () => {
	const f = fixture();
	writeFileSync(
		join(f.home, ".flywheel-agent-home.json"),
		JSON.stringify({ project: "project", role: "implement" }),
	);
	const db = new Database(join(f.options.commRoot, "project", "comm.db"));
	db.prepare(
		"INSERT INTO sessions(execution_id,vendor,status,ended_at,phase_keep_alive) VALUES(?,?,?,?,?)",
	).run("exec", "codex", "running", null, 0);
	db.close();
	f.setProcesses([codex(`CODEX_HOME=${f.home} FLYWHEEL_EXEC_ID=exec`)]);
	let verified = true;
	const collect = createCodexQuotaHostCollector({
		...f.options,
		residentEvidence: async (input) => {
			expect(input).toMatchObject({
				executionId: "exec",
				project: "project",
				role: "implement",
				process: { pid: 12, startIdentity: "Thu Sep 18 01:00:00 2026" },
			});
			return {
				verified,
				reason: verified ? "verified" : "socket_holder_mismatch",
			};
		},
	});
	expect(await collect()).toMatchObject({
		complete: true,
		registeredComplete: true,
		homes: [{ activity: "active" }],
	});
	verified = false;
	expect(await collect()).toMatchObject({
		complete: false,
		registeredComplete: false,
		homes: [{ activity: "unknown" }],
	});
});

it("preserves an unattributed desktop reader as global unknown", async () => {
	const f = fixture();
	f.setProcesses([
		{
			pid: 77,
			ucomm: "codex",
			args: "/Applications/ChatGPT.app/Contents/Resources/codex app-server",
		},
	]);
	expect(await createCodexQuotaHostCollector(f.options)()).toMatchObject({
		complete: false,
		registeredComplete: true,
		diagnostics: [{ reason: "process_home_unknown", scope: "global" }],
		unattributedReaders: [
			{
				pid: 77,
				startIdentity: LSTART,
				reason: "process_home_unknown",
			},
		],
	});
});

describe("FLY-2830 resident execution with its TUI client", () => {
	const SOCKET = "/sock/exec.sock";
	function residentFixture(executions = ["exec"]) {
		const f = fixture();
		writeFileSync(
			join(f.home, ".flywheel-agent-home.json"),
			JSON.stringify({ project: "project", role: "implement" }),
		);
		const db = new Database(join(f.options.commRoot, "project", "comm.db"));
		const insert = db.prepare(
			"INSERT INTO sessions(execution_id,vendor,status,ended_at,phase_keep_alive) VALUES(?,?,?,?,?)",
		);
		for (const id of executions) insert.run(id, "codex", "running", null, 0);
		db.close();
		return f;
	}
	const env = (home: string, exec = "exec") =>
		`CODEX_HOME=${home} FLYWHEEL_EXEC_ID=${exec}`;
	const daemon = (home: string): ProcessRow => ({
		pid: 60140,
		ucomm: "codex",
		args: `/bin/codex app-server --remote-control --listen unix://${SOCKET}`,
		env: env(home),
	});
	const client = (
		home: string,
		args = `/bin/codex resume --remote unix://${SOCKET} -C /wt`,
		exec = "exec",
	): ProcessRow => ({ pid: 18081, ucomm: "codex", args, env: env(home, exec) });
	function collector(
		f: ReturnType<typeof residentFixture>,
		daemonVerified = true,
	) {
		const calls: number[] = [];
		const collect = createCodexQuotaHostCollector({
			...f.options,
			daemonSocketPath: (executionId: string) => `/sock/${executionId}.sock`,
			residentEvidence: async (input) => {
				calls.push(input.process.pid);
				// Only the socket holder in the daemon group can ever verify.
				return input.process.pid === 60140 && daemonVerified
					? { verified: true, reason: "verified" }
					: {
							verified: false,
							reason:
								input.process.pid === 60140
									? "state_not_live"
									: "socket_holder_mismatch",
						};
			},
		});
		return { collect, calls };
	}

	it("counts the daemon plus its own TUI client as one active execution", async () => {
		const f = residentFixture();
		f.setProcesses([daemon(f.home), client(f.home)]);
		const result = await collector(f).collect();
		expect(result).toMatchObject({
			complete: true,
			registeredComplete: true,
			homes: [{ activity: "active" }],
		});
		expect(result.diagnostics.filter((d) => d.scope !== "info")).toEqual([]);
	});

	it("is independent of process enumeration order", async () => {
		const f = residentFixture();
		f.setProcesses([client(f.home), daemon(f.home)]);
		expect(await collector(f).collect()).toMatchObject({
			complete: true,
			homes: [{ activity: "active" }],
		});
	});

	it("keeps the home blocked when the daemon itself fails the evidence chain", async () => {
		const f = residentFixture();
		f.setProcesses([daemon(f.home), client(f.home)]);
		const result = await collector(f, false).collect();
		expect(result).toMatchObject({
			complete: false,
			homes: [{ activity: "unknown" }],
		});
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ reason: "state_not_live" }),
				expect.objectContaining({ reason: "resident_evidence_incomplete" }),
			]),
		);
	});

	it.each([
		[
			"points at another execution's socket",
			`/bin/codex resume --remote unix:///sock/other.sock -C /wt`,
		],
		[
			"repeats --remote",
			`/bin/codex resume --remote unix://${SOCKET} --remote unix://${SOCKET}`,
		],
		[
			"uses the --remote= form",
			`/bin/codex resume --remote=unix://${SOCKET} -C /wt`,
		],
		["has no --remote value", "/bin/codex resume --remote"],
		["is a different codex shape", `/bin/codex exec --remote unix://${SOCKET}`],
	])("blocks a same-execution process that %s", async (_name, args) => {
		const f = residentFixture();
		f.setProcesses([daemon(f.home), client(f.home, args)]);
		const result = await collector(f).collect();
		expect(result).toMatchObject({
			complete: false,
			homes: [{ activity: "unknown" }],
		});
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					reason: "resident_process_unbound",
					executionId: "exec",
					pid: 18081,
				}),
				expect.objectContaining({ reason: "resident_evidence_incomplete" }),
			]),
		);
	});

	it("blocks a client whose environment names a different execution", async () => {
		const f = residentFixture(["exec", "other"]);
		f.setProcesses([
			daemon(f.home),
			client(f.home, `/bin/codex resume --remote unix://${SOCKET}`, "other"),
		]);
		expect(await collector(f).collect()).toMatchObject({
			complete: false,
			homes: [{ activity: "unknown" }],
		});
	});

	it("blocks a client that has no daemon", async () => {
		const f = residentFixture();
		f.setProcesses([client(f.home)]);
		expect(await collector(f).collect()).toMatchObject({
			complete: false,
			homes: [{ activity: "unknown" }],
		});
	});
});
