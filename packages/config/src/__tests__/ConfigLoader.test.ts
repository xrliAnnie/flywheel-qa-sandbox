import { describe, expect, it, vi, beforeEach } from "vitest";
import { ConfigLoader } from "../ConfigLoader.js";
import type { FlywheelConfig } from "../types.js";

// Minimal valid config for testing
const VALID_CONFIG_YAML = `
project: geoforge3d
linear:
  team_id: "TEAM-123"
  labels:
    - "flywheel"
runners:
  default: claude
  available:
    claude:
      type: claude
      model: sonnet
      max_budget_usd: 5.0
teams:
  - name: engineering
    orchestrators:
      - type: code
        runner: claude
        budget_per_issue: 5.0
decision_layer:
  autonomy_level: manual_only
  escalation_channel: "#flywheel-dev"
`;

const MINIMAL_CONFIG_YAML = `
project: test-project
linear:
  team_id: "TEAM-1"
runners:
  default: claude
  available:
    claude:
      type: claude
teams:
  - name: dev
    orchestrators:
      - type: code
        runner: claude
        budget_per_issue: 5.0
decision_layer:
  autonomy_level: observer
  escalation_channel: "#dev"
`;

const CONFIG_WITH_ALL_FIELDS = `
project: full-project
linear:
  team_id: "TEAM-FULL"
  labels:
    - "agent"
    - "auto"
runners:
  default: claude
  available:
    claude:
      type: claude
      model: sonnet
      max_budget_usd: 10.0
    codex:
      type: openai
      model: gpt-4o
agent_nodes:
  implement:
    tools:
      - Read
      - Edit
      - Write
      - Bash
    max_turns: 100
  fix:
    budget_usd: 3.0
    tools:
      - Read
      - Edit
      - Bash
teams:
  - name: engineering
    orchestrators:
      - type: code
        runner: claude
        budget_per_issue: 5.0
      - type: review
        runner: codex
        budget_per_issue: 2.0
decision_layer:
  autonomy_level: autonomous
  escalation_channel: "#flywheel"
  digest_interval: 3600
ci:
  max_rounds: 3
  retry_on:
    - "flaky"
    - "timeout"
reactions:
  changes-requested:
    action: send-to-agent
    retries: 2
    escalateAfter: "30m"
  approved-and-green:
    action: auto-merge
`;

describe("ConfigLoader", () => {
	let readFile: ReturnType<typeof vi.fn>;
	let loader: ConfigLoader;

	beforeEach(() => {
		readFile = vi.fn();
		loader = new ConfigLoader(readFile);
	});

	// ─── Happy path ─────────────────────────────────

	it("loads a valid config", async () => {
		readFile.mockResolvedValue(VALID_CONFIG_YAML);
		const config = await loader.load("/project/.flywheel/config.yaml");
		expect(config.project).toBe("geoforge3d");
		expect(config.linear.team_id).toBe("TEAM-123");
		expect(config.runners.default).toBe("claude");
		expect(config.runners.available.claude.type).toBe("claude");
		expect(config.teams).toHaveLength(1);
		expect(config.decision_layer.autonomy_level).toBe("manual_only");
	});

	it("loads minimal config with only required fields", async () => {
		readFile.mockResolvedValue(MINIMAL_CONFIG_YAML);
		const config = await loader.load("/project/.flywheel/config.yaml");
		expect(config.project).toBe("test-project");
		expect(config.linear.labels).toBeUndefined();
		expect(config.agent_nodes).toBeUndefined();
		expect(config.ci).toBeUndefined();
		expect(config.reactions).toBeUndefined();
	});

	it("loads config with all optional fields", async () => {
		readFile.mockResolvedValue(CONFIG_WITH_ALL_FIELDS);
		const config = await loader.load("/project/.flywheel/config.yaml");
		expect(config.agent_nodes?.implement?.max_turns).toBe(100);
		expect(config.agent_nodes?.fix?.budget_usd).toBe(3.0);
		expect(config.ci?.max_rounds).toBe(3);
		expect(config.reactions?.["changes-requested"]?.action).toBe(
			"send-to-agent",
		);
		expect(config.reactions?.["approved-and-green"]?.action).toBe(
			"auto-merge",
		);
		expect(config.decision_layer.digest_interval).toBe(3600);
	});

	it("passes the file path to the readFile function", async () => {
		readFile.mockResolvedValue(VALID_CONFIG_YAML);
		await loader.load("/my/path/config.yaml");
		expect(readFile).toHaveBeenCalledWith("/my/path/config.yaml");
	});

	// ─── Multiple runners ───────────────────────────

	it("handles multiple runners", async () => {
		readFile.mockResolvedValue(CONFIG_WITH_ALL_FIELDS);
		const config = await loader.load("/p/config.yaml");
		expect(Object.keys(config.runners.available)).toEqual([
			"claude",
			"codex",
		]);
		expect(config.runners.available.codex.type).toBe("openai");
		expect(config.runners.available.codex.model).toBe("gpt-4o");
	});

	// ─── Multiple teams/orchestrators ────────────────

	it("handles multiple orchestrators per team", async () => {
		readFile.mockResolvedValue(CONFIG_WITH_ALL_FIELDS);
		const config = await loader.load("/p/config.yaml");
		const eng = config.teams[0];
		expect(eng.orchestrators).toHaveLength(2);
		expect(eng.orchestrators[1].runner).toBe("codex");
	});

	// ─── Validation: missing required fields ─────────

	it("throws on missing project", async () => {
		const yaml = `
linear:
  team_id: "T"
runners:
  default: claude
  available:
    claude:
      type: claude
teams:
  - name: dev
    orchestrators:
      - type: code
        runner: claude
        budget_per_issue: 5
decision_layer:
  autonomy_level: observer
  escalation_channel: "#dev"
`;
		readFile.mockResolvedValue(yaml);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(/project/i);
	});

	it("throws on missing linear.team_id", async () => {
		const yaml = `
project: test
linear: {}
runners:
  default: claude
  available:
    claude:
      type: claude
teams:
  - name: dev
    orchestrators:
      - type: code
        runner: claude
        budget_per_issue: 5
decision_layer:
  autonomy_level: observer
  escalation_channel: "#dev"
`;
		readFile.mockResolvedValue(yaml);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(/team_id/i);
	});

	it("throws on missing runners.default", async () => {
		const yaml = `
project: test
linear:
  team_id: "T"
runners:
  available:
    claude:
      type: claude
teams:
  - name: dev
    orchestrators:
      - type: code
        runner: claude
        budget_per_issue: 5
decision_layer:
  autonomy_level: observer
  escalation_channel: "#dev"
`;
		readFile.mockResolvedValue(yaml);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/runners\.default/i,
		);
	});

	it("throws on empty teams array", async () => {
		const yaml = `
project: test
linear:
  team_id: "T"
runners:
  default: claude
  available:
    claude:
      type: claude
teams: []
decision_layer:
  autonomy_level: observer
  escalation_channel: "#dev"
`;
		readFile.mockResolvedValue(yaml);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(/teams/i);
	});

	it("throws on missing decision_layer", async () => {
		const yaml = `
project: test
linear:
  team_id: "T"
runners:
  default: claude
  available:
    claude:
      type: claude
teams:
  - name: dev
    orchestrators:
      - type: code
        runner: claude
        budget_per_issue: 5
`;
		readFile.mockResolvedValue(yaml);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/decision_layer/i,
		);
	});

	it("throws when default runner is not in available", async () => {
		const yaml = `
project: test
linear:
  team_id: "T"
runners:
  default: nonexistent
  available:
    claude:
      type: claude
teams:
  - name: dev
    orchestrators:
      - type: code
        runner: claude
        budget_per_issue: 5
decision_layer:
  autonomy_level: observer
  escalation_channel: "#dev"
`;
		readFile.mockResolvedValue(yaml);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/nonexistent.*not.*available/i,
		);
	});

	it("throws when orchestrator references unknown runner", async () => {
		const yaml = `
project: test
linear:
  team_id: "T"
runners:
  default: claude
  available:
    claude:
      type: claude
teams:
  - name: dev
    orchestrators:
      - type: code
        runner: unknown-runner
        budget_per_issue: 5
decision_layer:
  autonomy_level: observer
  escalation_channel: "#dev"
`;
		readFile.mockResolvedValue(yaml);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/unknown-runner.*not.*available/i,
		);
	});

	// ─── Validation: autonomy_level ─────────────────

	it("throws on invalid autonomy_level", async () => {
		const yaml = `
project: test
linear:
  team_id: "T"
runners:
  default: claude
  available:
    claude:
      type: claude
teams:
  - name: dev
    orchestrators:
      - type: code
        runner: claude
        budget_per_issue: 5
decision_layer:
  autonomy_level: turbo_mode
  escalation_channel: "#dev"
`;
		readFile.mockResolvedValue(yaml);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/autonomy_level.*turbo_mode/i,
		);
	});

	it("throws on missing escalation_channel", async () => {
		const yaml = `
project: test
linear:
  team_id: "T"
runners:
  default: claude
  available:
    claude:
      type: claude
teams:
  - name: dev
    orchestrators:
      - type: code
        runner: claude
        budget_per_issue: 5
decision_layer:
  autonomy_level: observer
`;
		readFile.mockResolvedValue(yaml);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/escalation_channel/i,
		);
	});

	// ─── Error handling ─────────────────────────────

	it("throws on invalid YAML", async () => {
		readFile.mockResolvedValue(":::invalid yaml{{{");
		await expect(loader.load("/p/config.yaml")).rejects.toThrow();
	});

	it("throws when file read fails", async () => {
		readFile.mockRejectedValue(new Error("ENOENT: file not found"));
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/file not found/i,
		);
	});

	// ─── Defaults ───────────────────────────────────

	it("applies CI defaults", async () => {
		readFile.mockResolvedValue(MINIMAL_CONFIG_YAML);
		const config = await loader.load("/p/config.yaml");
		// ci is optional and undefined when not specified
		expect(config.ci).toBeUndefined();
	});

	// ─── v0.2 config extensions ─────────────────────

	it("loads config without parallel/skills sections (backward compat)", async () => {
		readFile.mockResolvedValue(MINIMAL_CONFIG_YAML);
		const config = await loader.load("/p/config.yaml");
		expect(config.parallel).toBeUndefined();
		expect(config.skills).toBeUndefined();
	});

	it("loads config with parallel section", async () => {
		const yaml = MINIMAL_CONFIG_YAML + `
parallel:
  max_parallel: 5
  worktree_base_dir: /tmp/wt
  hook_port: 0
  session_timeout_minutes: 120
`;
		readFile.mockResolvedValue(yaml);
		const config = await loader.load("/p/config.yaml");
		expect(config.parallel?.max_parallel).toBe(5);
		expect(config.parallel?.worktree_base_dir).toBe("/tmp/wt");
		expect(config.parallel?.hook_port).toBe(0);
		expect(config.parallel?.session_timeout_minutes).toBe(120);
	});

	// ─── v0.6 agents config ────────────────────────

	it("loads config with agents section", async () => {
		const yaml = MINIMAL_CONFIG_YAML + `
agents:
  backend:
    agent_file: .claude/agents/backend-executor.md
    domain_file: .claude/domains/backend.md
    match:
      labels:
        - "backend"
        - "api"
      keywords:
        - "database"
        - "server"
  frontend:
    agent_file: .claude/agents/frontend-executor.md
    match:
      labels:
        - "frontend"
      keywords:
        - "ui"
        - "react"
default_agent: backend
`;
		readFile.mockResolvedValue(yaml);
		const config = await loader.load("/p/config.yaml");
		expect(Object.keys(config.agents!)).toEqual(["backend", "frontend"]);
		expect(config.agents!.backend.agent_file).toBe(".claude/agents/backend-executor.md");
		expect(config.agents!.backend.domain_file).toBe(".claude/domains/backend.md");
		expect(config.agents!.backend.match.labels).toEqual(["backend", "api"]);
		expect(config.agents!.frontend.domain_file).toBeUndefined();
		expect(config.default_agent).toBe("backend");
	});

	it("loads config without agents section (backward compat)", async () => {
		readFile.mockResolvedValue(MINIMAL_CONFIG_YAML);
		const config = await loader.load("/p/config.yaml");
		expect(config.agents).toBeUndefined();
		expect(config.default_agent).toBeUndefined();
	});

	it("throws when agent_file is missing", async () => {
		const yaml = MINIMAL_CONFIG_YAML + `
agents:
  backend:
    match:
      labels: ["backend"]
      keywords: ["db"]
`;
		readFile.mockResolvedValue(yaml);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/agents\.backend.*agent_file/i,
		);
	});

	it("throws when agent_file is absolute path", async () => {
		const yaml = MINIMAL_CONFIG_YAML + `
agents:
  backend:
    agent_file: /etc/passwd
    match:
      labels: ["backend"]
      keywords: ["db"]
`;
		readFile.mockResolvedValue(yaml);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/must be relative/i,
		);
	});

	it("throws when agent_file starts with ..", async () => {
		const yaml = MINIMAL_CONFIG_YAML + `
agents:
  backend:
    agent_file: "../../secret.md"
    match:
      labels: ["backend"]
      keywords: ["db"]
`;
		readFile.mockResolvedValue(yaml);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/must not escape repo/i,
		);
	});

	it("throws when agent_file has embedded .. segments", async () => {
		const yaml = MINIMAL_CONFIG_YAML + `
agents:
  backend:
    agent_file: "foo/../../etc/passwd"
    match:
      labels: ["backend"]
      keywords: ["db"]
`;
		readFile.mockResolvedValue(yaml);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/must not escape repo/i,
		);
	});

	it("throws when match field is missing", async () => {
		const yaml = MINIMAL_CONFIG_YAML + `
agents:
  backend:
    agent_file: .claude/agents/backend.md
`;
		readFile.mockResolvedValue(yaml);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/agents\.backend.*match/i,
		);
	});

	it("throws when match.labels is missing", async () => {
		const yaml = MINIMAL_CONFIG_YAML + `
agents:
  backend:
    agent_file: .claude/agents/backend.md
    match:
      keywords: ["db"]
`;
		readFile.mockResolvedValue(yaml);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/labels.*array/i,
		);
	});

	it("throws when match.keywords is missing", async () => {
		const yaml = MINIMAL_CONFIG_YAML + `
agents:
  backend:
    agent_file: .claude/agents/backend.md
    match:
      labels: ["backend"]
`;
		readFile.mockResolvedValue(yaml);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/keywords.*array/i,
		);
	});

	it("throws when match.labels contains non-string elements", async () => {
		const yaml = MINIMAL_CONFIG_YAML + `
agents:
  backend:
    agent_file: .claude/agents/backend.md
    match:
      labels: [123, true]
      keywords: ["db"]
`;
		readFile.mockResolvedValue(yaml);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/labels.*strings/i,
		);
	});

	it("throws when match.keywords contains non-string elements", async () => {
		const yaml = MINIMAL_CONFIG_YAML + `
agents:
  backend:
    agent_file: .claude/agents/backend.md
    match:
      labels: ["backend"]
      keywords: [42]
`;
		readFile.mockResolvedValue(yaml);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/keywords.*strings/i,
		);
	});

	it("throws when default_agent references nonexistent agent", async () => {
		const yaml = MINIMAL_CONFIG_YAML + `
agents:
  backend:
    agent_file: .claude/agents/backend.md
    match:
      labels: ["backend"]
      keywords: ["db"]
default_agent: nonexistent
`;
		readFile.mockResolvedValue(yaml);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/default_agent.*nonexistent.*not found/i,
		);
	});

	it("throws when default_agent is set without agents section", async () => {
		const yaml = MINIMAL_CONFIG_YAML + `
default_agent: backend
`;
		readFile.mockResolvedValue(yaml);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/default_agent.*requires an agents section/i,
		);
	});

	it("throws when agents is a YAML array instead of object", async () => {
		const yaml = MINIMAL_CONFIG_YAML + `
agents:
  - agent_file: .claude/agents/backend.md
    match:
      labels: ["backend"]
      keywords: ["db"]
`;
		readFile.mockResolvedValue(yaml);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/agents must be a YAML mapping/,
		);
	});

	it("loads config with skills section", async () => {
		const yaml = MINIMAL_CONFIG_YAML + `
skills:
  enabled: true
  test_command: "npm test"
  lint_command: "npm run lint"
  build_command: "npm run build"
  test_framework: "jest"
`;
		readFile.mockResolvedValue(yaml);
		const config = await loader.load("/p/config.yaml");
		expect(config.skills?.enabled).toBe(true);
		expect(config.skills?.test_command).toBe("npm test");
		expect(config.skills?.lint_command).toBe("npm run lint");
		expect(config.skills?.build_command).toBe("npm run build");
		expect(config.skills?.test_framework).toBe("jest");
	});
});
