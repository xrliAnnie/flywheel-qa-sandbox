import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
	assertFly2139PolicyCaps,
	executeFly2006Inventory,
	executeFly2139PolicyApply,
	fly2139ActivationRequirements,
	validateFly2139ActivationReceipt,
} from "../../../../scripts/lib/fly-2006-retention-engine.mjs";
import {
	readSealedJson,
	writeSealedJson,
} from "../../../../scripts/lib/fly-2006-retention-evidence.mjs";
import {
	COMM_TABLE_CLASSIFICATION,
	RETENTION_MS,
	TEAMLEAD_TABLE_CLASSIFICATION,
} from "../../../../scripts/lib/fly-2006-retention-registry.mjs";
import {
	FLY2139_STANDING_POLICY,
	FLY2139_STANDING_POLICY_PATH,
	validateFly2139StandingPolicy,
} from "../../../../scripts/lib/fly-2139-standing-policy.mjs";

describe("FLY-2139 standing retention policy", () => {
	it("binds the approved two-database scope, registry targets, window, and caps", () => {
		expect(FLY2139_STANDING_POLICY_PATH).toMatch(
			/scripts\/lib\/fly-2139-standing-policy\.mjs$/,
		);
		expect(FLY2139_STANDING_POLICY).toEqual({
			schemaVersion: 1,
			issue: "FLY-2139",
			retentionMs: RETENTION_MS,
			globalRowCap: 500_000,
			perTableRowCap: 300_000,
			deleteTargets: {
				teamlead: [...TEAMLEAD_TABLE_CLASSIFICATION.deleteTarget],
				comm: [...COMM_TABLE_CLASSIFICATION.deleteTarget],
			},
		});
	});

	it("rejects field, cap, and registry-target drift under a strict schema", () => {
		const exact = structuredClone(FLY2139_STANDING_POLICY);
		expect(validateFly2139StandingPolicy(exact)).toEqual(
			FLY2139_STANDING_POLICY,
		);

		for (const changed of [
			{ ...exact, extra: true },
			{ ...exact, globalRowCap: 500_001 },
			{ ...exact, perTableRowCap: 299_999 },
			{
				...exact,
				deleteTargets: {
					...exact.deleteTargets,
					teamlead: exact.deleteTargets.teamlead.slice(1),
				},
			},
		]) {
			expect(() => validateFly2139StandingPolicy(changed)).toThrow(
				"standing_policy_invalid",
			);
		}
	});

	it("accepts only the canonical strict activation receipt and binds its digest", () => {
		const homeDir = mkdtempSync(join(tmpdir(), "fly2139-activation-"));
		try {
			const activationDir = join(homeDir, ".flywheel", "state", "log-janitor");
			mkdirSync(activationDir, { recursive: true, mode: 0o700 });
			const activationPath = join(
				activationDir,
				"db-retention-activation.json",
			);
			const receipt = {
				...fly2139ActivationRequirements(),
				approvedBy: "flywheel-eng-lead",
				approvedAt: "2026-08-29T06:00:00.000Z",
			};
			writeFileSync(activationPath, `${JSON.stringify(receipt)}\n`, {
				mode: 0o600,
			});
			chmodSync(activationPath, 0o600);

			const policyAudit = validateFly2139ActivationReceipt({
				activationReceiptPath: activationPath,
				homeDir,
			});
			expect(policyAudit).toMatchObject({
				issue: "FLY-2139",
				globalRowCap: 500_000,
				perTableRowCap: 300_000,
				activationReceiptSha256: createHash("sha256")
					.update(readFileSync(activationPath))
					.digest("hex"),
			});

			const alternatePath = join(homeDir, "same-bytes.json");
			writeFileSync(alternatePath, readFileSync(activationPath), {
				mode: 0o600,
			});
			expect(() =>
				validateFly2139ActivationReceipt({
					activationReceiptPath: alternatePath,
					homeDir,
				}),
			).toThrow("activation_receipt_path_not_canonical");

			for (const changed of [
				{ ...receipt, extra: true },
				{ ...receipt, globalRowCap: 499_999 },
				{ ...receipt, engineSha256: "0".repeat(64) },
			]) {
				writeFileSync(activationPath, `${JSON.stringify(changed)}\n`);
				chmodSync(activationPath, 0o600);
				expect(() =>
					validateFly2139ActivationReceipt({
						activationReceiptPath: activationPath,
						homeDir,
					}),
				).toThrow("activation_receipt_invalid");
			}

			rmSync(activationPath);
			symlinkSync(alternatePath, activationPath);
			expect(() =>
				validateFly2139ActivationReceipt({
					activationReceiptPath: activationPath,
					homeDir,
				}),
			).toThrow("activation_receipt_not_regular");
		} finally {
			rmSync(homeDir, { recursive: true, force: true });
		}
	});

	it("fails closed before apply when any table or run exceeds the approved caps", () => {
		expect(
			assertFly2139PolicyCaps({
				targets: {
					leadEvents: {
						database: "teamlead",
						table: "lead_events",
						candidateCount: 300_000,
					},
					mailbox: {
						database: "comm",
						table: "mailbox",
						candidateCount: 200_000,
					},
				},
			}),
		).toEqual({
			totalRows: 500_000,
			perTableRows: {
				"comm.mailbox": 200_000,
				"teamlead.lead_events": 300_000,
			},
		});
		expect(() =>
			assertFly2139PolicyCaps({
				targets: {
					leadEvents: {
						database: "teamlead",
						table: "lead_events",
						candidateCount: 300_001,
					},
				},
			}),
		).toThrow("policy_cap_exceeded:teamlead.lead_events");
		expect(() =>
			assertFly2139PolicyCaps({
				targets: {
					leadEvents: {
						database: "teamlead",
						table: "lead_events",
						candidateCount: 300_000,
					},
					mailbox: {
						database: "comm",
						table: "mailbox",
						candidateCount: 200_001,
					},
				},
			}),
		).toThrow("policy_cap_exceeded:global");
		expect(() =>
			assertFly2139PolicyCaps({
				targets: {
					sessions: {
						database: "teamlead",
						table: "sessions",
						candidateCount: 1,
					},
				},
			}),
		).toThrow("policy_target_not_allowed:teamlead.sessions");
	});

	it("reuses the frozen apply path and binds activation authority to its receipt", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2139-policy-apply-"));
		try {
			const teamleadPath = join(root, "teamlead.db");
			const commPath = join(root, "comm.db");
			const evidenceDir = join(root, "evidence");
			const teamlead = new Database(teamleadPath);
			teamlead.exec(`
				CREATE TABLE legacy_render_fallback(
					seq INTEGER PRIMARY KEY,
					fell_back_at TEXT NOT NULL
				);
				INSERT INTO legacy_render_fallback VALUES(
					1, '2000-01-01T00:00:00.000Z'
				);
			`);
			teamlead.close();
			new Database(commPath).close();

			const inventory = await executeFly2006Inventory({
				teamleadDbPath: teamleadPath,
				commDbPath: commPath,
				evidenceDir,
				allowFixturePaths: true,
				allowFixtureSchema: true,
			});
			expect(
				inventory.manifest.targets.legacyRenderFallback.candidateCount,
			).toBe(1);

			const activationPath = writeActivation(root);
			const result = await executeFly2139PolicyApply({
				manifestPath: inventory.manifestPath,
				activationReceiptPath: activationPath,
				homeDir: root,
				allowFixturePaths: true,
			});
			expect(result).toMatchObject({
				issue: "FLY-2139",
				status: "complete",
				deleted: { legacyRenderFallback: 1 },
				policyAudit: {
					actualRows: {
						totalRows: 1,
						perTableRows: { "teamlead.legacy_render_fallback": 1 },
					},
					activationReceiptSha256: createHash("sha256")
						.update(readFileSync(activationPath))
						.digest("hex"),
				},
			});
			const verified = new Database(teamleadPath, { readonly: true });
			expect(
				verified
					.prepare("SELECT count(*) AS count FROM legacy_render_fallback")
					.get(),
			).toEqual({ count: 0 });
			verified.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("seals a failure receipt and leaves rows untouched when a manifest exceeds caps", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2139-policy-cap-"));
		try {
			const teamleadPath = join(root, "teamlead.db");
			const commPath = join(root, "comm.db");
			const evidenceDir = join(root, "evidence");
			const teamlead = new Database(teamleadPath);
			teamlead.exec(`
				CREATE TABLE legacy_render_fallback(
					seq INTEGER PRIMARY KEY,
					fell_back_at TEXT NOT NULL
				);
				INSERT INTO legacy_render_fallback VALUES(
					1, '2000-01-01T00:00:00.000Z'
				);
			`);
			teamlead.close();
			new Database(commPath).close();
			const inventory = await executeFly2006Inventory({
				teamleadDbPath: teamleadPath,
				commDbPath: commPath,
				evidenceDir,
				allowFixturePaths: true,
				allowFixtureSchema: true,
			});
			rmSync(inventory.manifestPath);
			rmSync(`${inventory.manifestPath}.sha256`);
			writeSealedJson(inventory.manifestPath, {
				...inventory.manifest,
				targets: {
					...inventory.manifest.targets,
					legacyRenderFallback: {
						...inventory.manifest.targets.legacyRenderFallback,
						candidateCount: 300_001,
					},
				},
			});

			await expect(
				executeFly2139PolicyApply({
					manifestPath: inventory.manifestPath,
					activationReceiptPath: writeActivation(root),
					homeDir: root,
					allowFixturePaths: true,
				}),
			).rejects.toThrow("policy_cap_exceeded:teamlead.legacy_render_fallback");
			const failure = readSealedJson(
				join(evidenceDir, "policy-apply-failure.json"),
				"policy_apply_failure",
			);
			expect(failure).toMatchObject({
				issue: "FLY-2139",
				status: "failed",
				error: "policy_cap_exceeded:teamlead.legacy_render_fallback",
			});
			const verified = new Database(teamleadPath, { readonly: true });
			expect(
				verified
					.prepare("SELECT count(*) AS count FROM legacy_render_fallback")
					.get(),
			).toEqual({ count: 1 });
			verified.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

function writeActivation(homeDir: string): string {
	const activationDir = join(homeDir, ".flywheel", "state", "log-janitor");
	mkdirSync(activationDir, { recursive: true, mode: 0o700 });
	const activationPath = join(activationDir, "db-retention-activation.json");
	writeFileSync(
		activationPath,
		`${JSON.stringify({
			...fly2139ActivationRequirements(),
			approvedBy: "flywheel-eng-lead",
			approvedAt: "2026-08-29T06:00:00.000Z",
		})}\n`,
		{ mode: 0o600 },
	);
	chmodSync(activationPath, 0o600);
	return activationPath;
}
