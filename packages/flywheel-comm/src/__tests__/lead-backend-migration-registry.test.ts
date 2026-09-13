import { spawnSync } from "node:child_process";
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
import { afterEach, expect, it } from "vitest";
import { planBackendMigration } from "../lead-backend-migration.js";
import {
	preserveMigrationArtifacts,
	replaceMigrationArtifact,
} from "../lead-backend-migration-artifacts.js";
import {
	migrateRegistryFieldsLocked,
	observeMigrationRegistry,
	restoreMigrationFilesLocked,
} from "../lead-backend-migration-registry.js";
import { compileSummaryAssignments } from "../summary-assignment.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function fixture() {
	const home = mkdtempSync(join(tmpdir(), "fly2459-registry-"));
	dirs.push(home);
	const state = join(home, ".flywheel");
	mkdirSync(join(state, "state/summary-registry"), { recursive: true });
	mkdirSync(join(state, "lead-backend-migrations"), { mode: 0o700 });
	const selection = {
		state: "selected" as const,
		granularity: "per-lead" as const,
		setBy: "founder",
		setAt: "2026-09-11T00:00:00.000Z",
	};
	writeFileSync(join(state, "summary-config.json"), JSON.stringify(selection));
	const registry = [
		{
			projectName: "flywheel",
			projectRoot: "/project",
			leads: [
				{
					agentId: "flywheel-product-lead",
					backend: "claude-code",
					canSpawnRunners: true,
					summaryRole: "producer",
					chatChannel: "10000000000000001",
					match: { labels: ["Product"] },
				},
			],
		},
	];
	const path = join(state, "projects.json");
	const bytes = JSON.stringify(registry);
	writeFileSync(path, bytes, { mode: 0o600 });
	const projection = compileSummaryAssignments(registry, selection);
	const receiptPath = join(
		state,
		"state/summary-registry/migration-receipt.json",
	);
	writeFileSync(
		receiptPath,
		JSON.stringify({
			schemaVersion: 1,
			postImageSha256: createHash("sha256").update(bytes).digest("hex"),
			assignments: projection.leads.map(
				({ projectName, leadId, summaryRole }) => ({
					projectName,
					leadId,
					summaryRole,
				}),
			),
			projectAggregators: projection.projectAggregators,
			granularity: "per-lead",
			summaryAssignmentDigest: projection.digest,
			migratedAt: selection.setAt,
		}),
		{ mode: 0o600 },
	);
	const plan = planBackendMigration({
		registry,
		projectName: "flywheel",
		leadId: "flywheel-product-lead",
		toBackend: "codex-app-server",
		model: "gpt-6-astra",
		effort: "high",
		runnerActions: true,
		deploymentSha: "a".repeat(40),
		manifestSha: "b".repeat(64),
		plistSha: "c".repeat(64),
		createdAt: selection.setAt,
	});
	const deps = {
		assertWindowAndStopped: () => {},
		validateCandidate: (_path: string) => {},
		configLockHeld: true,
	};
	return { home, path, receiptPath, plan, deps };
}
it("atomically applies fields, leaves summary receipt bytes intact and conditionally restores", () => {
	const f = fixture(),
		before = readFileSync(f.path),
		receipt = readFileSync(f.receiptPath);
	expect(
		migrateRegistryFieldsLocked(f.home, f.plan, "apply", f.deps).status,
	).toBe("written");
	expect(JSON.parse(readFileSync(f.path, "utf8"))[0].leads[0].model).toBe(
		"gpt-6-astra",
	);
	const post = readFileSync(f.path);
	expect(
		migrateRegistryFieldsLocked(f.home, f.plan, "apply", f.deps).status,
	).toBe("unchanged");
	expect(readFileSync(f.path)).toEqual(post);
	expect(readFileSync(f.receiptPath)).toEqual(receipt);
	migrateRegistryFieldsLocked(f.home, f.plan, "rollback", f.deps);
	expect(JSON.parse(readFileSync(f.path, "utf8"))).toEqual(
		JSON.parse(before.toString()),
	);
	expect(readFileSync(f.receiptPath)).toEqual(receipt);
});
it.each(["lock", "owner", "summary", "target"])(
	"rejects missing %s proof before writing",
	(kind) => {
		const f = fixture();
		if (kind === "lock") f.deps.configLockHeld = false;
		if (kind === "owner")
			f.deps.assertWindowAndStopped = () => {
				throw new Error("old owner still live");
			};
		if (kind === "summary") {
			const r = JSON.parse(readFileSync(f.receiptPath, "utf8"));
			r.summaryAssignmentDigest = "f".repeat(64);
			writeFileSync(f.receiptPath, JSON.stringify(r));
		}
		if (kind === "target") {
			const r = JSON.parse(readFileSync(f.path, "utf8"));
			r[0].leads[0].model = "changed";
			writeFileSync(f.path, JSON.stringify(r));
		}
		const before = readFileSync(f.path);
		expect(() =>
			migrateRegistryFieldsLocked(f.home, f.plan, "apply", f.deps),
		).toThrow();
		expect(readFileSync(f.path)).toEqual(before);
	},
);

it("writes only a candidate accepted by the compiled TeamLead validator", () => {
	const f = fixture();
	f.deps.validateCandidate = (path: string) => {
		const result = spawnSync(
			process.execPath,
			[join(process.cwd(), "../teamlead/dist/bin/validate-projects.js"), path],
			{ encoding: "utf8", timeout: 10000 },
		);
		if (result.error || result.status !== 0)
			throw new Error(result.stderr || "validator failed");
	};
	expect(
		migrateRegistryFieldsLocked(f.home, f.plan, "apply", f.deps).status,
	).toBe("written");
});
it("rechecks old-owner absence immediately before the rename", () => {
	const f = fixture(),
		before = readFileSync(f.path);
	let checks = 0;
	f.deps.assertWindowAndStopped = () => {
		if (++checks === 2) throw new Error("writer reappeared");
	};
	expect(() =>
		migrateRegistryFieldsLocked(f.home, f.plan, "apply", f.deps),
	).toThrow("writer reappeared");
	expect(readFileSync(f.path)).toEqual(before);
});

it("resumes source-file restoration after a partial rollback without touching the cursor", () => {
	const f = fixture();
	const state = join(f.home, ".flywheel");
	mkdirSync(join(state, "manifests"));
	mkdirSync(join(f.home, "Library/LaunchAgents"), { recursive: true });
	const manifest = join(state, "manifests/flywheel-flywheel-product-lead.json");
	const plist = join(
		f.home,
		"Library/LaunchAgents/com.flywheel.lead.flywheel-flywheel-product-lead.plist",
	);
	const cursor = join(state, "inbound-cursor.json");
	writeFileSync(manifest, "source-manifest", { mode: 0o600 });
	writeFileSync(plist, "source-plist", { mode: 0o600 });
	writeFileSync(cursor, "advanced-cursor", { mode: 0o600 });
	f.plan.expected.manifestSha = createHash("sha256")
		.update("source-manifest")
		.digest("hex");
	f.plan.expected.plistSha = createHash("sha256")
		.update("source-plist")
		.digest("hex");
	preserveMigrationArtifacts(f.home, f.plan.expected);
	migrateRegistryFieldsLocked(f.home, f.plan, "apply", f.deps);
	const target = { manifest: "target-manifest", plist: "target-plist" };
	replaceMigrationArtifact(
		f.home,
		f.plan.expected,
		"manifest",
		target.manifest,
		"apply",
		() => {},
	);
	replaceMigrationArtifact(
		f.home,
		f.plan.expected,
		"plist",
		target.plist,
		"apply",
		() => {},
	);
	let interrupt = true;
	const configured = readFileSync(f.path);
	writeFileSync(plist, "foreign-plist");
	expect(() =>
		restoreMigrationFilesLocked(f.home, f.plan, target, f.deps),
	).toThrow("artifact live conflict");
	expect(readFileSync(f.path)).toEqual(configured);
	expect(readFileSync(manifest, "utf8")).toBe("target-manifest");
	writeFileSync(plist, target.plist);
	f.deps.assertWindowAndStopped = () => {
		if (interrupt && readFileSync(manifest, "utf8") === "source-manifest")
			throw new Error("interrupted between files");
	};
	expect(() =>
		restoreMigrationFilesLocked(f.home, f.plan, target, f.deps),
	).toThrow("interrupted between files");
	expect(readFileSync(manifest, "utf8")).toBe("source-manifest");
	expect(readFileSync(plist, "utf8")).toBe("target-plist");
	interrupt = false;
	restoreMigrationFilesLocked(f.home, f.plan, target, f.deps);
	expect(readFileSync(plist, "utf8")).toBe("source-plist");
	expect(readFileSync(cursor, "utf8")).toBe("advanced-cursor");
	expect(JSON.parse(readFileSync(f.path, "utf8"))[0].leads[0].backend).toBe(
		"claude-code",
	);
});
it("observes registry pre/post and rejects a foreign target without mutation", () => {
	const f = fixture();
	expect(observeMigrationRegistry(f.home, f.plan).state).toBe("pre");
	migrateRegistryFieldsLocked(f.home, f.plan, "apply", f.deps);
	expect(observeMigrationRegistry(f.home, f.plan).state).toBe("post");
	const raw = JSON.parse(readFileSync(f.path, "utf8"));
	raw[0].leads[0].model = "foreign";
	writeFileSync(f.path, JSON.stringify(raw));
	const before = readFileSync(f.path);
	expect(() => observeMigrationRegistry(f.home, f.plan)).toThrow(
		"stale target row",
	);
	expect(readFileSync(f.path)).toEqual(before);
});
