import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSummaryRegistryCommand } from "../commands/summary-registry.js";

describe("flywheel-comm summary-registry", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	function fixture() {
		const dir = mkdtempSync(join(tmpdir(), "fly2030-summary-cli-"));
		dirs.push(dir);
		mkdirSync(join(dir, ".flywheel"));
		writeFileSync(
			join(dir, ".flywheel", "summary-config.json"),
			JSON.stringify({
				granularity: "per-lead",
				setBy: "founder",
				setAt: "2026-08-28T00:00:00.000Z",
			}),
		);
		const projectsPath = join(dir, "projects.json");
		const projects = JSON.stringify([
			{
				projectName: "flywheel",
				projectRoot: dir,
				leads: [
					{
						agentId: "eng-lead",
						chatChannel: "eng",
						match: { labels: ["Engineering"] },
					},
				],
			},
		]);
		writeFileSync(projectsPath, projects);
		const assignmentsPath = join(dir, "assignments.json");
		writeFileSync(
			assignmentsPath,
			JSON.stringify({
				assignments: [
					{
						projectName: "flywheel",
						leadId: "eng-lead",
						summaryRole: "producer",
					},
				],
			}),
		);
		return {
			dir,
			projects,
			projectsPath,
			assignmentsPath,
			receiptPath: join(dir, "receipt.json"),
		};
	}

	it("refuses registry mutation outside the shared config-write lock", () => {
		const f = fixture();
		const stderr: string[] = [];
		const rc = runSummaryRegistryCommand(
			[
				"migrate",
				"--projects-file",
				f.projectsPath,
				"--assignments-file",
				f.assignmentsPath,
				"--receipt-file",
				f.receiptPath,
				"--expected-sha256",
				createHash("sha256").update(f.projects).digest("hex"),
			],
			{
				homeDir: f.dir,
				env: {},
				stderr: (line) => stderr.push(line),
				validateTeamleadCandidate: () => undefined,
			},
		);

		expect(rc).toBe(1);
		expect(JSON.parse(stderr[0]!)).toMatchObject({
			code: "summary_registry_lock_required",
		});
	});

	it("migrates and verifies under the shared lock receipt", () => {
		const f = fixture();
		const stdout: string[] = [];
		const common = [
			"--projects-file",
			f.projectsPath,
			"--receipt-file",
			f.receiptPath,
		];
		const rc = runSummaryRegistryCommand(
			[
				"migrate",
				...common,
				"--assignments-file",
				f.assignmentsPath,
				"--expected-sha256",
				createHash("sha256").update(f.projects).digest("hex"),
			],
			{
				homeDir: f.dir,
				env: { FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD: "1" },
				stdout: (line) => stdout.push(line),
				validateTeamleadCandidate: () => undefined,
			},
		);
		expect(rc).toBe(0);
		expect(JSON.parse(stdout[0]!)).toMatchObject({ granularity: "per-lead" });

		stdout.length = 0;
		expect(
			runSummaryRegistryCommand(["verify-activation", ...common], {
				homeDir: f.dir,
				stdout: (line) => stdout.push(line),
				validateTeamleadCandidate: () => undefined,
			}),
		).toBe(0);
		expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: true });
	});

	it("uses the configured lightweight Node validator without pnpm/tsx", () => {
		const f = fixture();
		const common = [
			"--projects-file",
			f.projectsPath,
			"--receipt-file",
			f.receiptPath,
		];
		expect(
			runSummaryRegistryCommand(
				[
					"migrate",
					...common,
					"--assignments-file",
					f.assignmentsPath,
					"--expected-sha256",
					createHash("sha256").update(f.projects).digest("hex"),
				],
				{
					homeDir: f.dir,
					env: { FLYWHEEL_SUMMARY_CONFIG_LOCK_HELD: "1" },
					validateTeamleadCandidate: () => undefined,
				},
			),
		).toBe(0);

		const markerPath = join(f.dir, "validator-called");
		const validatorPath = join(f.dir, "validator.mjs");
		writeFileSync(
			validatorPath,
			`import { appendFileSync, readFileSync } from "node:fs";\nreadFileSync(process.argv[2], "utf8");\nappendFileSync(${JSON.stringify(markerPath)}, process.argv[2] + "\\n");\n`,
		);
		expect(
			runSummaryRegistryCommand(["verify-activation", ...common], {
				homeDir: f.dir,
				env: { FLYWHEEL_TEAMLEAD_PROJECTS_VALIDATOR: validatorPath },
			}),
		).toBe(0);
		expect(existsSync(markerPath)).toBe(true);
	});
});
