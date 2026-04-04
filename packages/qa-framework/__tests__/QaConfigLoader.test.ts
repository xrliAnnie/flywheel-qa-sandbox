import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { QaConfigLoader } from "../src/config/QaConfigLoader.js";

function makeLoader(content: string): QaConfigLoader {
	return new QaConfigLoader(async () => content);
}

const validConfig = {
	project: { name: "TestProject", description: "A test project" },
	qa: {
		doc_root: "doc/qa",
		test_report_dir: "doc/qa/test-reports",
		context_file: "doc/qa/qa-context.md",
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
		max_concurrent_agents: 2,
		artifact_retention_days: 30,
		agent_types: [
			{
				name: "qa-parallel",
				step_templates: [
					{ key: "onboard", name: "Onboard", order: 1, prerequisite: null },
					{
						key: "analyze_plan",
						name: "Analyze + Plan",
						order: 2,
						prerequisite: "onboard",
					},
					{
						key: "research",
						name: "Research",
						order: 3,
						prerequisite: "analyze_plan",
					},
					{
						key: "write_execute",
						name: "Write + Execute",
						order: 4,
						prerequisite: "research",
					},
					{
						key: "finalize",
						name: "Finalize",
						order: 5,
						prerequisite: "write_execute",
					},
				],
			},
		],
	},
};

describe("QaConfigLoader", () => {
	it("loads a valid config", async () => {
		const loader = makeLoader(stringify(validConfig));
		const config = await loader.load("qa-config.yaml");

		expect(config.project.name).toBe("TestProject");
		expect(config.domains).toHaveLength(1);
		expect(config.domains[0].name).toBe("backend");
		expect(config.orchestrator.agent_types).toHaveLength(1);
		expect(config.orchestrator.agent_types[0].step_templates).toHaveLength(5);
	});

	it("applies defaults for optional fields", async () => {
		const loader = makeLoader(stringify(validConfig));
		const config = await loader.load("qa-config.yaml");

		expect(config.orchestrator.max_concurrent_agents).toBe(2);
		expect(config.orchestrator.artifact_retention_days).toBe(30);
		// plan defaults
		expect(config.plan?.source ?? "worktree").toBe("worktree");
	});

	it("loads config with plan.source = branch_fetch", async () => {
		const withPlan = {
			...validConfig,
			plan: { source: "branch_fetch", fetch_strategy: "checkout_file" },
		};
		const loader = makeLoader(stringify(withPlan));
		const config = await loader.load("qa-config.yaml");

		expect(config.plan?.source).toBe("branch_fetch");
		expect(config.plan?.fetch_strategy).toBe("checkout_file");
	});

	it("loads config with multiple domains", async () => {
		const multiDomain = {
			...validConfig,
			domains: [
				...validConfig.domains,
				{
					name: "frontend",
					dir: "./frontend",
					test_skill: "frontend-test",
					config_file: ".claude/skills/frontend-test/config.md",
					cleanup_script: "scripts/cleanup-frontend.sh",
				},
			],
		};
		const loader = makeLoader(stringify(multiDomain));
		const config = await loader.load("qa-config.yaml");

		expect(config.domains).toHaveLength(2);
		expect(config.domains[1].cleanup_script).toBe(
			"scripts/cleanup-frontend.sh",
		);
	});

	it("loads config with env_refs", async () => {
		const withEnv = {
			...validConfig,
			env_refs: { api_token: "API_TOKEN", gcloud_project: "GCP_PROJECT" },
		};
		const loader = makeLoader(stringify(withEnv));
		const config = await loader.load("qa-config.yaml");

		expect(config.env_refs).toEqual({
			api_token: "API_TOKEN",
			gcloud_project: "GCP_PROJECT",
		});
	});

	it("loads config with api section", async () => {
		const withApi = {
			...validConfig,
			api: {
				openapi_spec: "api-gateway/openapi-spec.yaml",
				base_url: "https://api.example.com",
			},
		};
		const loader = makeLoader(stringify(withApi));
		const config = await loader.load("qa-config.yaml");

		expect(config.api?.openapi_spec).toBe("api-gateway/openapi-spec.yaml");
		expect(config.api?.base_url).toBe("https://api.example.com");
	});

	it("rejects config missing project.name", async () => {
		const bad = { ...validConfig, project: { description: "test" } };
		const loader = makeLoader(stringify(bad));

		await expect(loader.load("qa-config.yaml")).rejects.toThrow();
	});

	it("rejects config with empty domains", async () => {
		const bad = { ...validConfig, domains: [] };
		const loader = makeLoader(stringify(bad));

		await expect(loader.load("qa-config.yaml")).rejects.toThrow();
	});

	it("rejects config with empty step_templates", async () => {
		const bad = {
			...validConfig,
			orchestrator: {
				...validConfig.orchestrator,
				agent_types: [{ name: "qa-parallel", step_templates: [] }],
			},
		};
		const loader = makeLoader(stringify(bad));

		await expect(loader.load("qa-config.yaml")).rejects.toThrow();
	});

	it("rejects config with invalid plan.source", async () => {
		const bad = {
			...validConfig,
			plan: { source: "invalid_source" },
		};
		const loader = makeLoader(stringify(bad));

		await expect(loader.load("qa-config.yaml")).rejects.toThrow();
	});

	it("validates step_template prerequisite references", async () => {
		const loader = makeLoader(stringify(validConfig));
		const config = await loader.load("qa-config.yaml");

		const steps = config.orchestrator.agent_types[0].step_templates;
		// First step has null prerequisite
		expect(steps[0].prerequisite).toBeNull();
		// Each subsequent step references the previous step's key
		for (let i = 1; i < steps.length; i++) {
			const prereqKey = steps[i].prerequisite;
			expect(prereqKey).toBe(steps[i - 1].key);
		}
	});

	it("rejects path traversal in domain.dir", async () => {
		const bad = {
			...validConfig,
			domains: [
				{
					...validConfig.domains[0],
					dir: "../../.ssh",
				},
			],
		};
		const loader = makeLoader(stringify(bad));
		await expect(loader.load("qa-config.yaml")).rejects.toThrow(
			"repo-relative",
		);
	});

	it("rejects absolute path in config_file", async () => {
		const bad = {
			...validConfig,
			domains: [
				{
					...validConfig.domains[0],
					config_file: "/etc/passwd",
				},
			],
		};
		const loader = makeLoader(stringify(bad));
		await expect(loader.load("qa-config.yaml")).rejects.toThrow(
			"repo-relative",
		);
	});

	it("rejects agent type name with shell injection characters", async () => {
		const bad = {
			...validConfig,
			orchestrator: {
				...validConfig.orchestrator,
				agent_types: [
					{
						name: "qa; touch /tmp/pwned; #",
						step_templates:
							validConfig.orchestrator.agent_types[0].step_templates,
					},
				],
			},
		};
		const loader = makeLoader(stringify(bad));
		await expect(loader.load("qa-config.yaml")).rejects.toThrow();
	});

	it("reads file via injected readFile function", async () => {
		let readPath = "";
		const loader = new QaConfigLoader(async (path) => {
			readPath = path;
			return stringify(validConfig);
		});

		await loader.load("/custom/path/qa-config.yaml");
		expect(readPath).toBe("/custom/path/qa-config.yaml");
	});
});
