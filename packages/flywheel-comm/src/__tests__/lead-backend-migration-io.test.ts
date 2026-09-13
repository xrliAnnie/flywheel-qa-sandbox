import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { planBackendMigration } from "../lead-backend-migration.js";
import { MIGRATION_STEPS } from "../lead-backend-migration-executor.js";
import {
	parseMigrationIntent,
	readCommittedMigrationIntent,
	readMigrationIntent,
	readMigrationIntentRecord,
	writeMigrationIntent,
} from "../lead-backend-migration-io.js";
import {
	commitMigrationVerification,
	retireCommittedMigrationIntent,
	saveMigrationReceipt,
} from "../lead-backend-migration-receipt.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const home = mkdtempSync(join(tmpdir(), "fly2459-intent-"));
	dirs.push(home);
	mkdirSync(join(home, ".flywheel"));
	const plan = planBackendMigration({
		registry: [
			{
				projectName: "flywheel",
				projectRoot: "/project",
				leads: [
					{
						agentId: "flywheel-product-lead",
						backend: "claude-code",
						canSpawnRunners: true,
					},
				],
			},
		],
		projectName: "flywheel",
		leadId: "flywheel-product-lead",
		toBackend: "codex-app-server",
		model: "gpt-6-astra",
		effort: "high",
		runnerActions: true,
		deploymentSha: "a".repeat(40),
		manifestSha: "b".repeat(64),
		plistSha: "c".repeat(64),
		createdAt: "2026-09-11T00:00:00.000Z",
	});
	return {
		home,
		plan,
		path: join(
			home,
			".flywheel/lead-backend-migrations/FLY-2459-honey-lemon.json",
		),
	};
}
it("durably creates an owner-only intent and replays identical bytes", () => {
	const { home, plan, path } = fixture();
	expect(writeMigrationIntent(home, path, plan)).toBe("created");
	expect(statSync(path).mode & 0o777).toBe(0o600);
	expect(
		statSync(join(home, ".flywheel/lead-backend-migrations")).mode & 0o777,
	).toBe(0o700);
	const bytes = readFileSync(path);
	expect(readMigrationIntent(home, path)).toEqual(plan);
	expect(writeMigrationIntent(home, path, plan)).toBe("unchanged");
	expect(readFileSync(path)).toEqual(bytes);
	expect(() =>
		writeMigrationIntent(home, path, {
			...plan,
			deploymentSha: "d".repeat(40),
		}),
	).toThrow("conflict");
	expect(readFileSync(path)).toEqual(bytes);
});
it("binds execution evidence to the exact validated intent bytes", () => {
	const { home, plan, path } = fixture();
	writeMigrationIntent(home, path, plan);
	const record = readMigrationIntentRecord(home, path);
	expect(record.plan).toEqual(plan);
	expect(record.intentSha).toBe(
		createHash("sha256").update(readFileSync(path)).digest("hex"),
	);
	writeFileSync(path, `${JSON.stringify(plan)}\n`, { mode: 0o600 });
	expect(readMigrationIntentRecord(home, path).intentSha).not.toBe(
		record.intentSha,
	);
	writeFileSync(path, JSON.stringify({ ...plan, phase: "unapproved" }));
	expect(() => readMigrationIntentRecord(home, path)).toThrow();
});
it.each([
	"extra",
	"target-extra",
	"identity",
	"phase",
	"hash",
	"previous-extra",
	"target-model",
])("rejects malformed intent %s", (kind) => {
	const { plan } = fixture();
	const raw = JSON.parse(JSON.stringify(plan));
	if (kind === "extra") raw.token = "secret";
	if (kind === "target-extra") raw.target.botUserId = "replacement";
	if (kind === "identity") raw.leadId = "other";
	if (kind === "phase") raw.phase = "activated";
	if (kind === "hash") raw.expected.rowSha = "bad";
	if (kind === "previous-extra") raw.previous.token = "secret";
	if (kind === "target-model") raw.target.model = "opus";
	expect(() => parseMigrationIntent(raw)).toThrow();
});
it("refuses a foreign output path without creating it", () => {
	const { home, plan } = fixture();
	const out = join(home, "arbitrary.json");
	expect(() => writeMigrationIntent(home, out, plan)).toThrow("path");
	expect(() => statSync(out)).toThrow();
});
it.each(["directory", "file"])("rejects a symlink at the intent %s", (kind) => {
	const { home, plan, path } = fixture();
	const directory = join(home, ".flywheel/lead-backend-migrations");
	if (kind === "directory") symlinkSync(home, directory);
	else {
		mkdirSync(directory, { mode: 0o700 });
		writeFileSync(join(home, "target"), "unchanged");
		symlinkSync(join(home, "target"), path);
	}
	expect(() => writeMigrationIntent(home, path, plan)).toThrow();
	if (kind === "file")
		expect(readFileSync(join(home, "target"), "utf8")).toBe("unchanged");
});
it("refuses a writable intent directory", () => {
	const { home, plan, path } = fixture();
	mkdirSync(join(home, ".flywheel/lead-backend-migrations"), { mode: 0o755 });
	expect(() => writeMigrationIntent(home, path, plan)).toThrow("permissions");
});

it("retires only a committed matching intent atomically and replays without overwrite", async () => {
	const { home, plan, path } = fixture();
	writeMigrationIntent(home, path, plan);
	const { intentSha } = readMigrationIntentRecord(home, path);
	const receipt = {
		version: 1 as const,
		intentSha,
		revision: 0,
		status: "deployed_unverified" as const,
		pending: null,
		completed: Object.fromEntries(
			MIGRATION_STEPS.map((s) => [s, "b".repeat(64)]),
		),
		failure: null,
	};
	await saveMigrationReceipt(home, receipt, null);
	await expect(retireCommittedMigrationIntent(home, intentSha)).rejects.toThrow(
		"committed",
	);
	expect(readMigrationIntent(home, path)).toEqual(plan);
	await commitMigrationVerification(home, intentSha, "c".repeat(64), async () =>
		"d".repeat(64),
	);
	await retireCommittedMigrationIntent(home, intentSha);
	expect(() => readFileSync(path)).toThrow();
	expect(readCommittedMigrationIntent(home)).toEqual({ plan, intentSha });
	await retireCommittedMigrationIntent(home, intentSha);
	expect(readCommittedMigrationIntent(home).intentSha).toBe(intentSha);
});
