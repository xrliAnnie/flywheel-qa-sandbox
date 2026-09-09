import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLeadRegistryCommand } from "../commands/lead-registry.js";
import { digestLeadRegistryRow } from "../lead-registry-cos-context.js";
import { compileSummaryAssignments } from "../summary-assignment.js";

const sha256 = (value: string) =>
	createHash("sha256").update(value).digest("hex");

describe("flywheel-comm lead-registry import-cos-context", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0))
			rmSync(root, { recursive: true, force: true });
	});

	function fixture() {
		const homeDir = mkdtempSync(join(tmpdir(), "fly2445-cos-cli-"));
		roots.push(homeDir);
		const flywheelDir = join(homeDir, ".flywheel");
		const receiptDir = join(flywheelDir, "state", "summary-registry");
		mkdirSync(receiptDir, { recursive: true });
		writeFileSync(
			join(flywheelDir, "summary-config.json"),
			JSON.stringify({
				granularity: "per-lead",
				setBy: "founder",
				setAt: "2026-09-08T00:00:00.000Z",
			}),
		);
		const registry = Array.from({ length: 14 }, (_, index) => {
			const projectRoot = join(homeDir, `project-${index}`);
			mkdirSync(join(projectRoot, "team"), { recursive: true });
			writeFileSync(join(homeDir, `identity-${index}.md`), "identity");
			writeFileSync(join(homeDir, `memory-${index}.md`), "memory");
			return {
				projectName: `project-${index}`,
				projectRoot,
				leads: [
					{
						agentId: `lead-${index}`,
						summaryRole: "producer",
						chatChannel: `${10000000000000001n + BigInt(index)}`,
						match: { labels: [`lead-${index}`] },
						botTokenEnv: `LEAD_${index}_BOT_TOKEN`,
						botUserId: `${20000000000000001n + BigInt(index)}`,
					},
				],
			};
		});
		const projectsPath = join(flywheelDir, "projects.json");
		const projectsText = `${JSON.stringify(registry, null, 2)}\n`;
		writeFileSync(projectsPath, projectsText, { mode: 0o600 });
		const selection = {
			state: "selected" as const,
			granularity: "per-lead" as const,
			setBy: "founder",
			setAt: "2026-09-08T00:00:00.000Z",
		};
		const projection = compileSummaryAssignments(registry, selection);
		const receiptPath = join(receiptDir, "migration-receipt.json");
		const receiptText = `${JSON.stringify({ schemaVersion: 1, postImageSha256: sha256(projectsText), assignments: projection.leads.map((row) => ({ projectName: row.projectName, leadId: row.leadId, summaryRole: row.summaryRole })), projectAggregators: projection.projectAggregators, granularity: "per-lead", summaryAssignmentDigest: projection.digest, migratedAt: "2026-09-08T00:00:00.000Z" }, null, 2)}\n`;
		writeFileSync(receiptPath, receiptText, { mode: 0o600 });
		const inputPath = join(homeDir, "cos-context-import.json");
		writeFileSync(
			inputPath,
			`${JSON.stringify({ schemaVersion: 1, rows: registry.map((project, index) => ({ projectName: project.projectName, leadId: project.leads[0]!.agentId, botUserId: project.leads[0]!.botUserId, expectedLeadSha256: digestLeadRegistryRow(project.leads[0]), cosContext: { displayName: `Lead ${index}`, aliases: [`alias-${index}`], workingSubdirectory: "team", identityPath: join(homeDir, `identity-${index}.md`), memoryPaths: [join(homeDir, `memory-${index}.md`)], writableRoots: [join(project.projectRoot, "team")] } })) }, null, 2)}\n`,
			{ mode: 0o600 },
		);
		const args = [
			"import-cos-context",
			"--input",
			inputPath,
			"--expected-projects-sha",
			sha256(projectsText),
			"--expected-receipt-sha",
			sha256(receiptText),
			"--projects-file",
			projectsPath,
			"--receipt-file",
			receiptPath,
			"--summary-config-home",
			homeDir,
		];
		return {
			homeDir,
			projectsPath,
			receiptPath,
			inputPath,
			args,
			projectsText,
			receiptText,
		};
	}

	it("atomically updates both registry images under the shared lock", () => {
		const f = fixture();
		const stdout: string[] = [];
		expect(
			runLeadRegistryCommand(f.args, {
				homeDir: f.homeDir,
				env: { FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD: "1" },
				stdout: (line) => stdout.push(line),
				validateTeamleadCandidate: () => undefined,
				now: () => "2026-09-08T03:00:00.000Z",
			}),
		).toBe(0);
		expect(
			JSON.parse(readFileSync(f.projectsPath, "utf8"))[8].leads[0].cosContext
				.displayName,
		).toBe("Lead 8");
		expect(JSON.parse(stdout[0]!)).toMatchObject({
			ok: true,
			operation: "cos-context-import",
			updatedLeadKeys: expect.arrayContaining(["project-8/lead-8"]),
		});
		expect(existsSync(`${f.receiptPath}.lead-registry-intent.json`)).toBe(
			false,
		);
	});

	it("rejects a stale caller CAS before writing either registry", () => {
		const f = fixture();
		const stderr: string[] = [];
		const args = f.args.map((value, index) =>
			index > 0 && f.args[index - 1] === "--expected-projects-sha"
				? "0".repeat(64)
				: value,
		);
		expect(
			runLeadRegistryCommand(args, {
				homeDir: f.homeDir,
				env: { FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD: "1" },
				stderr: (line) => stderr.push(line),
				validateTeamleadCandidate: () => undefined,
			}),
		).toBe(78);
		expect(JSON.parse(stderr[0]!)).toMatchObject({
			code: "lead_registry_source_stale",
		});
		expect(readFileSync(f.projectsPath, "utf8")).toBe(f.projectsText);
		expect(readFileSync(f.receiptPath, "utf8")).toBe(f.receiptText);
	});

	it("requires the one-time import manifest to be owner-only", () => {
		const f = fixture();
		chmodSync(f.inputPath, 0o644);
		const stderr: string[] = [];
		expect(
			runLeadRegistryCommand([...f.args, "--dry-run"], {
				homeDir: f.homeDir,
				stderr: (line) => stderr.push(line),
				validateTeamleadCandidate: () => undefined,
			}),
		).toBe(78);
		expect(JSON.parse(stderr[0]!)).toMatchObject({
			code: "lead_registry_source_invalid",
		});
	});
});
