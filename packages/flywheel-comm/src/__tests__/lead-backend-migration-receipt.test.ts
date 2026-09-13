import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	MIGRATION_STEPS,
	type MigrationExecutionReceipt,
} from "../lead-backend-migration-executor.js";
import {
	commitMigrationVerification,
	loadMigrationReceipt,
	saveMigrationReceipt,
} from "../lead-backend-migration-receipt.js";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const home = mkdtempSync(join(tmpdir(), "fly2459-receipt-"));
	dirs.push(home);
	const dir = join(home, ".flywheel/lead-backend-migrations");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return { home, dir };
}
const initial = (): MigrationExecutionReceipt => ({
	version: 1,
	intentSha: "a".repeat(64),
	revision: 0,
	status: "executing",
	pending: "preflight",
	completed: {},
	failure: null,
});
it("persists a private receipt with revision CAS and reloads it after restart", async () => {
	const { home, dir } = fixture();
	expect(loadMigrationReceipt(home)).toBeNull();
	await saveMigrationReceipt(home, initial(), null);
	expect(loadMigrationReceipt(home)).toEqual(initial());
	expect(
		statSync(join(dir, "FLY-2459-honey-lemon.receipt.json")).mode & 0o777,
	).toBe(0o600);
	const next = { ...initial(), revision: 1 };
	const outcomes = await Promise.allSettled([
		saveMigrationReceipt(home, next, 0),
		saveMigrationReceipt(home, next, 0),
	]);
	expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
	expect(loadMigrationReceipt(home)?.revision).toBe(1);
});
it("refuses secret-shaped extra fields and invalid completed proofs", async () => {
	const { home } = fixture();
	await expect(
		saveMigrationReceipt(
			home,
			{ ...initial(), token: "secret" } as MigrationExecutionReceipt,
			null,
		),
	).rejects.toThrow();
	await expect(
		saveMigrationReceipt(
			home,
			{ ...initial(), completed: { stop: "unproven" } },
			null,
		),
	).rejects.toThrow();
	expect(loadMigrationReceipt(home)).toBeNull();
});
it("never follows a receipt symlink", async () => {
	const { home, dir } = fixture();
	symlinkSync(
		join(home, "outside"),
		join(dir, "FLY-2459-honey-lemon.receipt.json"),
	);
	await expect(saveMigrationReceipt(home, initial(), null)).rejects.toThrow();
});

it("persists preflight recovery intent and rejects success without restoration proof", async () => {
	const { home } = fixture();
	const receipt: MigrationExecutionReceipt = {
		...initial(),
		status: "held",
		pending: "activate",
		failure: "step_failed",
		completed: Object.fromEntries(
			[
				"preflight",
				"stop",
				"configure",
				"stage_manifest",
				"stage_plist",
				"seed",
			].map((step) => [step, "b".repeat(64)]),
		),
		recovery: {
			reason: "activation_preflight_failed",
			state: "pending",
			proofSha: null,
		},
	};
	await saveMigrationReceipt(home, receipt, null);
	expect(loadMigrationReceipt(home)).toEqual(receipt);
	await expect(
		saveMigrationReceipt(
			home,
			{ ...receipt, revision: 1, status: "failed", pending: null },
			0,
		),
	).rejects.toThrow();
	const restored: MigrationExecutionReceipt = {
		...receipt,
		revision: 1,
		status: "failed",
		pending: null,
		recovery: {
			reason: "activation_preflight_failed",
			state: "restored",
			proofSha: "c".repeat(64),
		},
	};
	await saveMigrationReceipt(home, restored, 0);
	expect(loadMigrationReceipt(home)).toEqual(restored);
});

it("commits only after live verification and rechecks on idempotent replay", async () => {
	const { home } = fixture();
	const deployed = {
		...initial(),
		status: "deployed_unverified" as const,
		pending: null,
		completed: Object.fromEntries(
			MIGRATION_STEPS.map((s) => [s, "b".repeat(64)]),
		),
	};
	await saveMigrationReceipt(home, deployed, null);
	let checks = 0;
	const verify = async () => {
		checks++;
		return "d".repeat(64);
	};
	const result = await commitMigrationVerification(
		home,
		deployed.intentSha,
		"c".repeat(64),
		verify,
	);
	expect(result.status).toBe("committed");
	expect(checks).toBe(2);
	const revision = result.revision;
	expect(
		(
			await commitMigrationVerification(
				home,
				deployed.intentSha,
				"c".repeat(64),
				verify,
			)
		).revision,
	).toBe(revision);
	expect(checks).toBe(3);
	await expect(
		commitMigrationVerification(
			home,
			deployed.intentSha,
			"e".repeat(64),
			verify,
		),
	).rejects.toThrow("conflict");
	await expect(
		commitMigrationVerification(
			home,
			deployed.intentSha,
			"c".repeat(64),
			async () => {
				throw Error("admission active");
			},
		),
	).rejects.toThrow("admission");
});
it("preserves verified state when the final live check fails and resumes without deployment effects", async () => {
	const { home } = fixture();
	const r = {
		...initial(),
		status: "deployed_unverified" as const,
		pending: null,
		completed: Object.fromEntries(
			MIGRATION_STEPS.map((s) => [s, "b".repeat(64)]),
		),
	};
	await saveMigrationReceipt(home, r, null);
	let n = 0;
	await expect(
		commitMigrationVerification(home, r.intentSha, "c".repeat(64), async () => {
			if (++n === 2) throw Error("window reopened");
			return "d".repeat(64);
		}),
	).rejects.toThrow("window reopened");
	expect(loadMigrationReceipt(home)?.status).toBe("verified");
	expect(
		(
			await commitMigrationVerification(
				home,
				r.intentSha,
				"c".repeat(64),
				async () => "d".repeat(64),
			)
		).status,
	).toBe("committed");
});
