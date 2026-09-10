import { createHash } from "node:crypto";
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
import { afterEach, expect, it } from "vitest";
import { createCodexQuotaHostCollector } from "../host-readiness.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function receipt(homes: { home: string; ownership: string }[]) {
	return {
		schemaVersion: 1,
		buildSha: "a".repeat(40),
		inventoryDigest: createHash("sha256")
			.update(JSON.stringify(homes))
			.digest("hex"),
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
		"CREATE TABLE sessions(execution_id TEXT,vendor TEXT,status TEXT,ended_at TEXT,phase_keep_alive INTEGER)",
	);
	db.close();
	const approvedManifestPath = join(root, "approved.json");
	writeFileSync(
		approvedManifestPath,
		JSON.stringify(receipt([{ home, ownership: "managed" }])),
	);
	let processes = "1 /sbin/launchd";
	const options = {
		homesRoot,
		canonicalHome,
		commRoot,
		projectNames: ["project"],
		approvedManifestPath,
		leadTargets: [],
		leadAuthorityScript: join(root, "authority"),
		processSnapshot: async () => processes,
	};
	return {
		root,
		home,
		options,
		setProcesses: (text: string) => {
			processes = text;
		},
		activate: () => {
			const db = new Database(join(commRoot, "project", "comm.db"));
			db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(
				"exec",
				"codex",
				"running",
				null,
				0,
			);
			db.close();
			mkdirSync(join(home, ".flywheel-leases"));
			writeFileSync(join(home, ".flywheel-leases", "exec"), "a".repeat(32));
		},
	};
}
it("requires real process plus CommDB plus lease before marking keyed home active", async () => {
	const f = fixture();
	f.activate();
	f.setProcesses(
		`12 /bin/codex app-server CODEX_HOME=${f.home} FLYWHEEL_EXEC_ID=exec`,
	);
	expect(await createCodexQuotaHostCollector(f.options)()).toMatchObject({
		complete: true,
		homes: [{ home: f.home, activity: "active", ownership: "managed" }],
	});
	f.setProcesses("");
	expect((await createCodexQuotaHostCollector(f.options)()).complete).toBe(
		false,
	);
});
it("never trusts missing manifests or unowned live homes", async () => {
	const f = fixture();
	expect((await createCodexQuotaHostCollector(f.options)()).complete).toBe(
		true,
	);
	f.setProcesses(
		`12 /bin/codex app-server CODEX_HOME=${join(f.root, "unknown")}`,
	);
	expect((await createCodexQuotaHostCollector(f.options)()).complete).toBe(
		false,
	);
	rmSync(f.options.approvedManifestPath);
	expect((await createCodexQuotaHostCollector(f.options)()).complete).toBe(
		false,
	);
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
	f.setProcesses(`12 /bin/codex app-server CODEX_HOME=${f.home}`);
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
	expect((await createCodexQuotaHostCollector(f.options)()).complete).toBe(
		false,
	);
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
	db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?)").run(
		"legacy",
		"codex",
		"running",
		null,
		0,
	);
	db.close();
	f.setProcesses(
		`12 /bin/codex app-server CODEX_HOME=${home} FLYWHEEL_EXEC_ID=legacy`,
	);
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
	f.setProcesses(`12 /bin/codex app-server CODEX_HOME=${f.home}`);
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
	f.setProcesses(
		`12 /bin/codex app-server CODEX_HOME=${f.options.canonicalHome}`,
	);
	expect(await createCodexQuotaHostCollector(f.options)()).toMatchObject({
		complete: true,
		canonicalChainActive: true,
	});
	f.setProcesses("1 /sbin/launchd");
	expect(await createCodexQuotaHostCollector(f.options)()).toMatchObject({
		complete: true,
		canonicalChainActive: false,
	});
});
