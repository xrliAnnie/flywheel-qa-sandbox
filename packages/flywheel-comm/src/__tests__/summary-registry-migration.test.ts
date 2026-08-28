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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	migrateSummaryRegistry,
	type SummaryRegistryError,
	verifySummaryRegistryActivation,
} from "../summary-registry-migration.js";

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

describe("FLY-2030 summary registry data-first fence", () => {
	let dir: string;
	let projectsPath: string;
	let assignmentsPath: string;
	let receiptPath: string;
	let original: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly2030-summary-registry-"));
		projectsPath = join(dir, "projects.json");
		assignmentsPath = join(dir, "assignments.json");
		receiptPath = join(dir, "summary-migration-receipt.json");
		mkdirSync(join(dir, ".flywheel"));
		writeFileSync(
			join(dir, ".flywheel", "summary-config.json"),
			JSON.stringify({
				granularity: "per-lead",
				setBy: "founder",
				setAt: "2026-08-28T00:00:00.000Z",
			}),
		);
		original = `${JSON.stringify(
			[
				{
					projectName: "flywheel",
					projectRoot: dir,
					leads: [
						{ agentId: "eng-lead", chatChannel: "eng" },
						{ agentId: "cos-lead", chatChannel: "cos" },
					],
				},
				{
					projectName: "raya",
					projectRoot: join(dir, "raya"),
					leads: [{ agentId: "raya-lead", chatChannel: "raya" }],
				},
			],
			null,
			2,
		)}\n`;
		writeFileSync(projectsPath, original, { mode: 0o600 });
		writeFileSync(
			assignmentsPath,
			JSON.stringify({
				assignments: [
					{
						projectName: "flywheel",
						leadId: "eng-lead",
						summaryRole: "producer",
					},
					{
						projectName: "flywheel",
						leadId: "cos-lead",
						summaryRole: "aggregator",
					},
					{
						projectName: "raya",
						leadId: "raya-lead",
						summaryRole: "recipient",
					},
				],
			}),
		);
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const validateTeamleadCandidate = () => undefined;

	it("atomically assigns every row and records projection-bound evidence", () => {
		const result = migrateSummaryRegistry(
			{
				projectsPath,
				assignmentsPath,
				receiptPath,
				expectedSha256: sha256(original),
				homeDir: dir,
			},
			{
				validateTeamleadCandidate,
				now: () => "2026-08-28T01:00:00.000Z",
			},
		);

		const migrated = JSON.parse(readFileSync(projectsPath, "utf8"));
		expect(
			migrated[0].leads.map(
				(lead: { summaryRole: string }) => lead.summaryRole,
			),
		).toEqual(["producer", "aggregator"]);
		expect(migrated[1].leads[0].summaryRole).toBe("recipient");
		expect(result.assignments).toHaveLength(3);
		expect(result.summaryAssignmentDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.parse(readFileSync(receiptPath, "utf8"))).toMatchObject({
			schemaVersion: 1,
			postImageSha256: result.postImageSha256,
			summaryAssignmentDigest: result.summaryAssignmentDigest,
			granularity: "per-lead",
			migratedAt: "2026-08-28T01:00:00.000Z",
		});
	});

	it("rejects a stale expected SHA with zero mutation", () => {
		expect(() =>
			migrateSummaryRegistry(
				{
					projectsPath,
					assignmentsPath,
					receiptPath,
					expectedSha256: "0".repeat(64),
					homeDir: dir,
				},
				{ validateTeamleadCandidate },
			),
		).toThrowError(
			expect.objectContaining<Partial<SummaryRegistryError>>({
				code: "summary_registry_stale",
			}),
		);
		expect(readFileSync(projectsPath, "utf8")).toBe(original);
	});

	it("keeps the old bytes when candidate validation or writing is interrupted", () => {
		expect(() =>
			migrateSummaryRegistry(
				{
					projectsPath,
					assignmentsPath,
					receiptPath,
					expectedSha256: sha256(original),
					homeDir: dir,
				},
				{
					validateTeamleadCandidate,
					beforeRename: () => {
						throw new Error("simulated interruption");
					},
				},
			),
		).toThrow(/simulated interruption/);
		expect(readFileSync(projectsPath, "utf8")).toBe(original);
	});

	it("rejects a manifest that omits any registry row", () => {
		const manifest = JSON.parse(readFileSync(assignmentsPath, "utf8"));
		manifest.assignments.pop();
		writeFileSync(assignmentsPath, JSON.stringify(manifest));
		expect(() =>
			migrateSummaryRegistry(
				{
					projectsPath,
					assignmentsPath,
					receiptPath,
					expectedSha256: sha256(original),
					homeDir: dir,
				},
				{ validateTeamleadCandidate },
			),
		).toThrow(/must assign every registry Lead exactly once/);
		expect(readFileSync(projectsPath, "utf8")).toBe(original);
	});

	it("activation rejects absent/stale evidence and accepts unrelated registry edits", () => {
		expect(() =>
			verifySummaryRegistryActivation(
				{ projectsPath, receiptPath, homeDir: dir },
				{ validateTeamleadCandidate },
			),
		).toThrowError(
			expect.objectContaining<Partial<SummaryRegistryError>>({
				code: "summary_registry_receipt_missing",
			}),
		);

		migrateSummaryRegistry(
			{
				projectsPath,
				assignmentsPath,
				receiptPath,
				expectedSha256: sha256(original),
				homeDir: dir,
			},
			{ validateTeamleadCandidate },
		);
		const unrelated = JSON.parse(readFileSync(projectsPath, "utf8"));
		unrelated[0].leads[0].model = "claude-fable-5";
		writeFileSync(projectsPath, JSON.stringify(unrelated));
		expect(
			verifySummaryRegistryActivation(
				{ projectsPath, receiptPath, homeDir: dir },
				{ validateTeamleadCandidate },
			).summaryAssignmentDigest,
		).toMatch(/^[a-f0-9]{64}$/);
	});

	it("activation rejects role, aggregator, and mode drift", () => {
		migrateSummaryRegistry(
			{
				projectsPath,
				assignmentsPath,
				receiptPath,
				expectedSha256: sha256(original),
				homeDir: dir,
			},
			{ validateTeamleadCandidate },
		);
		const migrated = JSON.parse(readFileSync(projectsPath, "utf8"));
		migrated[0].leads[0].summaryRole = "exempt";
		writeFileSync(projectsPath, JSON.stringify(migrated));
		expect(() =>
			verifySummaryRegistryActivation(
				{ projectsPath, receiptPath, homeDir: dir },
				{ validateTeamleadCandidate },
			),
		).toThrowError(
			expect.objectContaining<Partial<SummaryRegistryError>>({
				code: "summary_registry_projection_mismatch",
			}),
		);

		migrated[0].leads[0].summaryRole = "producer";
		migrated[0].summaryAggregatorLeadId = "eng-lead";
		writeFileSync(projectsPath, JSON.stringify(migrated));
		writeFileSync(
			join(dir, ".flywheel", "summary-config.json"),
			JSON.stringify({
				granularity: "per-project",
				setBy: "founder",
				setAt: "2026-08-28T02:00:00.000Z",
			}),
		);
		expect(() =>
			verifySummaryRegistryActivation(
				{ projectsPath, receiptPath, homeDir: dir },
				{ validateTeamleadCandidate },
			),
		).toThrow();
	});

	it("activation rejects a receipt whose assignment evidence was tampered", () => {
		migrateSummaryRegistry(
			{
				projectsPath,
				assignmentsPath,
				receiptPath,
				expectedSha256: sha256(original),
				homeDir: dir,
			},
			{ validateTeamleadCandidate },
		);
		const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
		receipt.assignments[0].summaryRole = "exempt";
		writeFileSync(receiptPath, JSON.stringify(receipt));

		expect(() =>
			verifySummaryRegistryActivation(
				{ projectsPath, receiptPath, homeDir: dir },
				{ validateTeamleadCandidate },
			),
		).toThrowError(
			expect.objectContaining<Partial<SummaryRegistryError>>({
				code: "summary_registry_receipt_invalid",
			}),
		);
	});
});
