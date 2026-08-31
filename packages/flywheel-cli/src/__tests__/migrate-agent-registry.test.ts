import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
	migrateAgentRegistry,
	verifyMigrationReceipt,
} from "../commands/migrate-agent-registry.js";

const BUNDLED_REGISTRY = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../../..",
	".flywheel/agents/registry.yaml",
);

function configWithAgent(agentName: string, agentFile: string): string {
	return `project: managed
linear:
  team_id: MANAGED
runners:
  default: claude
  available:
    claude: { type: claude }
teams:
  - name: default
    orchestrators:
      - { type: dag, runner: claude, budget_per_issue: 10 }
decision_layer:
  autonomy_level: advisor
  escalation_channel: discord
agents:
  ${agentName}:
    agent_file: ${agentFile}
    match:
      labels: [${agentName}]
default_agent: ${agentName}
`;
}

function commitAll(root: string): void {
	execFileSync("git", ["config", "user.email", "test@example.com"], {
		cwd: root,
	});
	execFileSync("git", ["config", "user.name", "test"], { cwd: root });
	execFileSync("git", ["add", "-A"], { cwd: root });
	execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: root });
}

describe("flywheel migrate-agent-registry", () => {
	let root: string;

	beforeEach(() => {
		root = join(
			tmpdir(),
			`fly-registry-migrate-${Date.now()}-${Math.random()}`,
		);
		mkdirSync(join(root, ".flywheel", "agents"), { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: root });
		writeFileSync(
			join(root, ".flywheel", "agents", "general-executor.md"),
			"# managed general\n",
		);
		writeFileSync(
			join(root, ".flywheel", "config.yaml"),
			configWithAgent("general", ".flywheel/agents/general-executor.md"),
		);
		commitAll(root);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("cuts config and files over to node registry and emits a verified receipt", () => {
		const result = migrateAgentRegistry({
			projectPath: root,
			bundledRegistryPath: BUNDLED_REGISTRY,
		});

		expect(result.moved).toEqual([
			expect.objectContaining({
				agent: "general",
				node: "general",
				to: ".flywheel/agents/nodes/general.md",
			}),
		]);
		expect(
			existsSync(join(root, ".flywheel", "agents", "nodes", "general.md")),
		).toBe(true);
		expect(
			existsSync(join(root, ".flywheel", "agents", "general-executor.md")),
		).toBe(false);

		const config = readFileSync(join(root, ".flywheel", "config.yaml"), "utf8");
		expect(config).toContain("node: general");
		expect(config).not.toContain("agent_file");
		const overlay = parse(
			readFileSync(join(root, ".flywheel", "agents", "registry.yaml"), "utf8"),
		);
		expect(overlay.nodes.general).toEqual({ file: "nodes/general.md" });
		expect(verifyMigrationReceipt(result.receiptPath)).toMatchObject({
			valid: true,
			project: "managed",
		});
	});

	it("requires an explicit mapping for a non-bundled agent before writing", () => {
		writeFileSync(
			join(root, ".flywheel", "config.yaml"),
			configWithAgent("helper", ".flywheel/agents/general-executor.md"),
		);
		commitAll(root);
		const before = readFileSync(join(root, ".flywheel", "config.yaml"), "utf8");

		expect(() =>
			migrateAgentRegistry({
				projectPath: root,
				bundledRegistryPath: BUNDLED_REGISTRY,
			}),
		).toThrow(/node map.*helper/i);
		expect(readFileSync(join(root, ".flywheel", "config.yaml"), "utf8")).toBe(
			before,
		);
		expect(existsSync(join(root, ".flywheel", "agents", "registry.yaml"))).toBe(
			false,
		);
	});

	it("supports an explicit project-local node contract", () => {
		writeFileSync(
			join(root, ".flywheel", "config.yaml"),
			configWithAgent("helper", ".flywheel/agents/general-executor.md"),
		);
		const mapPath = join(root, "node-map.json");
		writeFileSync(
			mapPath,
			JSON.stringify({
				helper: {
					node: "life_helper",
					label: "生活助理",
					department: "life",
				},
			}),
		);
		commitAll(root);

		migrateAgentRegistry({
			projectPath: root,
			bundledRegistryPath: BUNDLED_REGISTRY,
			nodeMap: mapPath,
		});

		const overlay = parse(
			readFileSync(join(root, ".flywheel", "agents", "registry.yaml"), "utf8"),
		);
		expect(overlay.nodes.life_helper).toEqual({
			file: "nodes/life_helper.md",
			label: "生活助理",
			department: "life",
		});
	});

	it("moves one implementation once when multiple aliases share a stable node", () => {
		const config = configWithAgent(
			"general",
			".flywheel/agents/general-executor.md",
		).replace(
			"default_agent: general",
			`  catch_all:
    agent_file: .flywheel/agents/general-executor.md
    match:
      labels: [catch-all]
default_agent: catch_all`,
		);
		writeFileSync(join(root, ".flywheel", "config.yaml"), config);
		const mapPath = join(root, "node-map.json");
		writeFileSync(mapPath, JSON.stringify({ catch_all: { node: "general" } }));
		commitAll(root);

		const result = migrateAgentRegistry({
			projectPath: root,
			bundledRegistryPath: BUNDLED_REGISTRY,
			nodeMap: mapPath,
		});

		expect(result.moved.map(({ agent }) => agent)).toEqual([
			"general",
			"catch_all",
		]);
		expect(
			readFileSync(join(root, ".flywheel", "config.yaml"), "utf8"),
		).toContain("node: general");
		expect(
			existsSync(join(root, ".flywheel", "agents", "general-executor.md")),
		).toBe(false);
		expect(
			existsSync(join(root, ".flywheel", "agents", "nodes", "general.md")),
		).toBe(true);
	});

	it("is idempotent after receipt verification", () => {
		const first = migrateAgentRegistry({
			projectPath: root,
			bundledRegistryPath: BUNDLED_REGISTRY,
		});
		const second = migrateAgentRegistry({
			projectPath: root,
			bundledRegistryPath: BUNDLED_REGISTRY,
			force: true,
		});
		expect(second.moved).toEqual([]);
		expect(second.receiptPath).toBe(first.receiptPath);
		expect(verifyMigrationReceipt(second.receiptPath).valid).toBe(true);
	});
});
