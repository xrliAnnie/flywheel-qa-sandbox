import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";

const execFileAsync = promisify(execFile);

const validConfig = {
	project: { name: "TestProject", description: "A test project" },
	qa: {
		doc_root: "doc/qa",
		test_report_dir: "doc/qa/test-reports",
	},
	domains: [
		{
			name: "backend",
			dir: ".",
			test_skill: "backend-test",
			config_file: ".claude/skills/backend-test/test-suite.md",
		},
	],
	orchestrator: {
		db_path: "~/.flywheel/orchestrator/qa.db",
		max_concurrent_agents: 3,
		artifact_retention_days: 14,
		agent_types: [
			{
				name: "qa-parallel",
				step_templates: [
					{ key: "onboard", name: "Onboard", order: 1, prerequisite: null },
					{
						key: "analyze",
						name: "Analyze",
						order: 2,
						prerequisite: "onboard",
					},
				],
			},
		],
	},
};

describe("shell-export", () => {
	let tmpDir: string;

	async function runShellExport(config: unknown): Promise<string> {
		tmpDir = await mkdtemp(join(tmpdir(), "qa-shell-export-"));
		const configPath = join(tmpDir, "qa-config.yaml");
		await writeFile(configPath, stringify(config));

		const scriptPath = join(
			__dirname,
			"..",
			"dist",
			"config",
			"shell-export.js",
		);
		const { stdout } = await execFileAsync("node", [scriptPath, configPath]);
		return stdout;
	}

	it("exports project metadata", async () => {
		const output = await runShellExport(validConfig);

		expect(output).toContain("export QA_PROJECT_NAME='TestProject'");
		expect(output).toContain("export QA_PROJECT_DESC='A test project'");
	});

	it("exports QA paths", async () => {
		const output = await runShellExport(validConfig);

		expect(output).toContain("export QA_DOC_ROOT='doc/qa'");
		expect(output).toContain("export QA_REPORT_DIR='doc/qa/test-reports'");
	});

	it("exports domain configuration", async () => {
		const output = await runShellExport(validConfig);

		expect(output).toContain("export QA_DOMAIN_COUNT=1");
		expect(output).toContain("export QA_DOMAIN_0_NAME='backend'");
		expect(output).toContain("export QA_DOMAIN_0_SKILL='backend-test'");
	});

	it("exports orchestrator config", async () => {
		const output = await runShellExport(validConfig);

		expect(output).toContain("export QA_ORCH_MAX_AGENTS=3");
		expect(output).toContain("export QA_ORCH_RETENTION_DAYS=14");
	});

	it("exports agent type step templates", async () => {
		const output = await runShellExport(validConfig);

		expect(output).toContain("export QA_AGENT_TYPE_qa_parallel_STEP_COUNT=2");
		expect(output).toContain(
			"export QA_AGENT_TYPE_qa_parallel_STEP_0_KEY='onboard'",
		);
		expect(output).toContain(
			"export QA_AGENT_TYPE_qa_parallel_STEP_0_NAME='Onboard'",
		);
		expect(output).toContain("export QA_AGENT_TYPE_qa_parallel_STEP_0_ORDER=1");
		expect(output).toContain(
			"export QA_AGENT_TYPE_qa_parallel_STEP_0_PREREQ=''",
		);
		expect(output).toContain(
			"export QA_AGENT_TYPE_qa_parallel_STEP_1_KEY='analyze'",
		);
		expect(output).toContain(
			"export QA_AGENT_TYPE_qa_parallel_STEP_1_PREREQ='onboard'",
		);
	});

	it("exports plan source defaults", async () => {
		const output = await runShellExport(validConfig);

		expect(output).toContain("export QA_PLAN_SOURCE='worktree'");
		expect(output).toContain("export QA_PLAN_FETCH_STRATEGY='checkout_file'");
	});

	it("handles single quotes in project name", async () => {
		const config = {
			...validConfig,
			project: { name: "Annie's Project", description: "It's great" },
		};
		const output = await runShellExport(config);

		expect(output).toContain("export QA_PROJECT_NAME='Annie'\\''s Project'");
	});

	it("fails with no arguments", async () => {
		const scriptPath = join(
			__dirname,
			"..",
			"dist",
			"config",
			"shell-export.js",
		);
		await expect(execFileAsync("node", [scriptPath])).rejects.toThrow();
	});

	// Cleanup
	afterEach(async () => {
		if (tmpDir) {
			await rm(tmpDir, { recursive: true, force: true });
		}
	});
});
