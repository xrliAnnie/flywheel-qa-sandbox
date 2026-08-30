import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigLoader } from "../ConfigLoader.js";

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
		expect(config.reactions?.["approved-and-green"]?.action).toBe("auto-merge");
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
		expect(Object.keys(config.runners.available)).toEqual(["claude", "codex"]);
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
		const yaml = `${MINIMAL_CONFIG_YAML}
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

	// ─── registry-backed agents config (FLY-2121) ───────────────────────────────

	it("loads node-only agent authoring rules", async () => {
		readFile.mockResolvedValue(`${MINIMAL_CONFIG_YAML}
agents:
  backend:
    node: engineer
    domain_file: .claude/domains/backend.md
    match:
      labels: [backend, api]
      keywords: [database]
default_agent: backend
`);
		const config = await loader.load("/p/config.yaml");
		expect(config.agents?.backend).toEqual({
			node: "engineer",
			domain_file: ".claude/domains/backend.md",
			match: { labels: ["backend", "api"], keywords: ["database"] },
		});
		expect(config.default_agent).toBe("backend");
	});

	it("loads config without agents section", async () => {
		readFile.mockResolvedValue(MINIMAL_CONFIG_YAML);
		const config = await loader.load("/p/config.yaml");
		expect(config.agents).toBeUndefined();
		expect(config.default_agent).toBeUndefined();
	});

	describe("FLY-1335 empty match.labels warning", () => {
		afterEach(() => vi.restoreAllMocks());

		it("warns when an empty-label agent is not default_agent", async () => {
			const warnSpy = vi
				.spyOn(console, "warn")
				.mockImplementation(() => undefined);
			readFile.mockResolvedValue(`${MINIMAL_CONFIG_YAML}
agents:
  general:
    node: general
    match: { labels: [] }
`);
			await loader.load("/p/config.yaml");
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringMatching(
					/agents\.general\.match\.labels is empty.*not a wildcard/i,
				),
			);
		});

		it("does not warn when the empty-label agent is default_agent", async () => {
			const warnSpy = vi
				.spyOn(console, "warn")
				.mockImplementation(() => undefined);
			readFile.mockResolvedValue(`${MINIMAL_CONFIG_YAML}
agents:
  general:
    node: general
    match: { labels: [] }
default_agent: general
`);
			await loader.load("/p/config.yaml");
			expect(
				warnSpy.mock.calls.filter(([message]) =>
					String(message).includes("match.labels is empty"),
				),
			).toEqual([]);
		});
	});

	it("rejects missing identity, malformed match, and mixed-format keys", async () => {
		for (const [agentBody, expected] of [
			["match: { labels: [backend] }", /exactly one of node or agent_file/i],
			["node: engineer", /missing required field "match"/i],
			[
				"node: engineer\n    match: { labels: backend }",
				/match\.labels must be an array/i,
			],
			[
				"node: engineer\n    department: engineering\n    match: { labels: [backend] }",
				/department is not allowed/i,
			],
		] as const) {
			readFile.mockResolvedValue(`${MINIMAL_CONFIG_YAML}
agents:
  backend:
    ${agentBody}
`);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(expected);
		}
	});

	it("rejects invalid domain paths", async () => {
		readFile.mockResolvedValue(`${MINIMAL_CONFIG_YAML}
agents:
  backend:
    node: engineer
    domain_file: ../../secret.md
    match: { labels: [backend] }
`);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/domain_file.*must not escape repo/i,
		);
	});

	it("rejects reserved generic agent name", async () => {
		readFile.mockResolvedValue(`${MINIMAL_CONFIG_YAML}
agents:
  generic:
    node: general
    match: { labels: [chore] }
`);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/"generic" is reserved/i,
		);
	});

	it("rejects default_agent references outside agents", async () => {
		readFile.mockResolvedValue(`${MINIMAL_CONFIG_YAML}
agents:
  backend:
    node: engineer
    match: { labels: [backend] }
default_agent: missing
`);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/default_agent.*missing.*not found/i,
		);
	});

	it("rejects default_agent without agents and non-mapping agents", async () => {
		readFile.mockResolvedValue(`${MINIMAL_CONFIG_YAML}
default_agent: backend
`);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/requires an agents section/i,
		);
		readFile.mockResolvedValue(`${MINIMAL_CONFIG_YAML}
agents:
  - node: engineer
    match: { labels: [backend] }
`);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/agents must be a YAML mapping/i,
		);
	});

	it("loads config with skills section", async () => {
		const yaml = `${MINIMAL_CONFIG_YAML}
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

	// ─── FLY-47: Checkpoints validation ──────────────

	describe("checkpoints validation", () => {
		const withCheckpoints = (checkpointsYaml: string) => `
${MINIMAL_CONFIG_YAML}
${checkpointsYaml}
`;

		it("accepts valid checkpoints config (timeout_ms ≥ floor)", async () => {
			readFile.mockResolvedValue(
				withCheckpoints(`
checkpoints:
  brainstorm:
    timeout_ms: 172800000
    timeout_behavior: fail-close
    cleanup_ttl_hours: 24
    stage: brainstorm
  question:
    timeout_behavior: fail-open
`),
			);
			const config = await loader.load("/p/config.yaml");
			expect(config.checkpoints?.brainstorm?.timeout_ms).toBe(172800000);
			expect(config.checkpoints?.question?.timeout_behavior).toBe("fail-open");
		});

		// FLY-159: timeout_ms floor at 4h (MIN_GATE_TIMEOUT_MS = 14_400_000ms).
		// Below-floor values are warn+raised (not throw) for boot continuity.
		it("warns + raises timeout_ms below 4h floor (was 30min, now 4h)", async () => {
			const warnSpy = vi
				.spyOn(console, "warn")
				.mockImplementation(() => undefined);
			readFile.mockResolvedValue(
				withCheckpoints(`
checkpoints:
  brainstorm:
    timeout_ms: 1800000
`),
			);
			const config = await loader.load("/p/config.yaml");
			expect(config.checkpoints?.brainstorm?.timeout_ms).toBe(14_400_000);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringMatching(
					/checkpoints\.brainstorm\.timeout_ms=1800000ms is below floor/,
				),
			);
			warnSpy.mockRestore();
		});

		it("warns + raises timeout_ms = 1h (Designer-style misconfig)", async () => {
			const warnSpy = vi
				.spyOn(console, "warn")
				.mockImplementation(() => undefined);
			readFile.mockResolvedValue(
				withCheckpoints(`
checkpoints:
  brainstorm:
    timeout_ms: 3600000
`),
			);
			const config = await loader.load("/p/config.yaml");
			expect(config.checkpoints?.brainstorm?.timeout_ms).toBe(14_400_000);
			expect(warnSpy).toHaveBeenCalledTimes(1);
			warnSpy.mockRestore();
		});

		it("passes timeout_ms = 4h (exact floor) unchanged + no warn", async () => {
			const warnSpy = vi
				.spyOn(console, "warn")
				.mockImplementation(() => undefined);
			readFile.mockResolvedValue(
				withCheckpoints(`
checkpoints:
  brainstorm:
    timeout_ms: 14400000
`),
			);
			const config = await loader.load("/p/config.yaml");
			expect(config.checkpoints?.brainstorm?.timeout_ms).toBe(14_400_000);
			expect(warnSpy).not.toHaveBeenCalled();
			warnSpy.mockRestore();
		});

		it("passes timeout_ms = 12h (Designer real value) unchanged + no warn", async () => {
			const warnSpy = vi
				.spyOn(console, "warn")
				.mockImplementation(() => undefined);
			readFile.mockResolvedValue(
				withCheckpoints(`
checkpoints:
  brainstorm:
    timeout_ms: 43200000
`),
			);
			const config = await loader.load("/p/config.yaml");
			expect(config.checkpoints?.brainstorm?.timeout_ms).toBe(43_200_000);
			expect(warnSpy).not.toHaveBeenCalled();
			warnSpy.mockRestore();
		});

		it("accepts config without checkpoints", async () => {
			readFile.mockResolvedValue(MINIMAL_CONFIG_YAML);
			const config = await loader.load("/p/config.yaml");
			expect(config.checkpoints).toBeUndefined();
		});

		it("rejects array checkpoints", async () => {
			readFile.mockResolvedValue(
				withCheckpoints(`
checkpoints:
  - brainstorm
  - question
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/checkpoints must be a YAML mapping/,
			);
		});

		it("rejects invalid timeout_behavior", async () => {
			readFile.mockResolvedValue(
				withCheckpoints(`
checkpoints:
  brainstorm:
    timeout_behavior: explode
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/timeout_behavior/,
			);
		});

		it("rejects negative timeout_ms", async () => {
			readFile.mockResolvedValue(
				withCheckpoints(`
checkpoints:
  brainstorm:
    timeout_ms: -100
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/timeout_ms.*positive/,
			);
		});

		it("rejects negative cleanup_ttl_hours", async () => {
			readFile.mockResolvedValue(
				withCheckpoints(`
checkpoints:
  brainstorm:
    cleanup_ttl_hours: 0
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/cleanup_ttl_hours.*positive/,
			);
		});

		it("rejects a residual enabled key regardless of its value", async () => {
			readFile.mockResolvedValue(
				withCheckpoints(`
checkpoints:
  brainstorm:
    enabled: "yes"
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/checkpoints\.brainstorm\.enabled was retired \(FLY-2103\)/,
			);
		});
	});

	// FLY-1356: skill_framework validation (split-participation opt-out lever)
	describe("skill_framework validation", () => {
		const withSkillFramework = (yaml: string) => `
${MINIMAL_CONFIG_YAML}
${yaml}
`;

		it("accepts absent skill_framework", async () => {
			readFile.mockResolvedValue(MINIMAL_CONFIG_YAML);
			const config = await loader.load("/p/config.yaml");
			expect(config.project).toBe("test-project");
		});

		it("rejects residual split: false", async () => {
			readFile.mockResolvedValue(
				withSkillFramework(`
skill_framework:
  split: false
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/skill_framework\.split was retired \(FLY-2103\)/,
			);
		});

		it("rejects residual split: true", async () => {
			readFile.mockResolvedValue(
				withSkillFramework(`
skill_framework:
  split: true
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/skill_framework\.split was retired \(FLY-2103\)/,
			);
		});

		it("rejects non-mapping skill_framework", async () => {
			readFile.mockResolvedValue(
				withSkillFramework(`
skill_framework: "no"
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/skill_framework\.split was retired \(FLY-2103\)/,
			);
		});

		it("rejects non-boolean split (fail loud at load, never coerce)", async () => {
			readFile.mockResolvedValue(
				withSkillFramework(`
skill_framework:
  split: "false"
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/skill_framework\.split was retired \(FLY-2103\)/,
			);
		});
	});

	// FLY-205: doc_flow validation
	describe("doc_flow validation", () => {
		const withDocFlow = (docFlowYaml: string) => `
${MINIMAL_CONFIG_YAML}
${docFlowYaml}
`;

		it("accepts doc_flow path metadata without an enable flag", async () => {
			readFile.mockResolvedValue(
				withDocFlow(`
doc_flow:
  default_department: content
`),
			);
			const config = await loader.load("/p/config.yaml");
			expect(config.doc_flow?.default_department).toBe("content");
		});

		it("accepts absent doc_flow (feature off, backward compatible)", async () => {
			readFile.mockResolvedValue(MINIMAL_CONFIG_YAML);
			const config = await loader.load("/p/config.yaml");
			expect(config.doc_flow).toBeUndefined();
		});

		it("rejects a metadata block without default_department", async () => {
			readFile.mockResolvedValue(
				withDocFlow(`
doc_flow: {}
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/default_department is required when doc_flow is present/,
			);
		});

		it("rejects default_department with illegal characters (path safety)", async () => {
			readFile.mockResolvedValue(
				withDocFlow(`
doc_flow:
  default_department: "../escape"
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/default_department must be a non-empty lowercase directory name/,
			);
		});

		it("rejects malformed default_department", async () => {
			readFile.mockResolvedValue(
				withDocFlow(`
doc_flow:
  default_department: "Has Spaces"
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/default_department must be a non-empty lowercase directory name/,
			);
		});

		it("rejects non-mapping doc_flow", async () => {
			readFile.mockResolvedValue(
				withDocFlow(`
doc_flow: "yes"
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/doc_flow must be a YAML mapping/,
			);
		});

		it("rejects the retired doc_flow.enabled key", async () => {
			readFile.mockResolvedValue(
				withDocFlow(`
doc_flow:
  enabled: "yes"
  default_department: content
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/doc_flow\.enabled was retired \(FLY-2103\)/,
			);
		});

		it("rejects residual enabled=false too", async () => {
			readFile.mockResolvedValue(
				withDocFlow(`
doc_flow:
  enabled: false
  default_department: product
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/doc_flow\.enabled was retired \(FLY-2103\)/,
			);
		});
	});

	// FLY-615: ponytail validation
	describe("ponytail validation", () => {
		const withPonytail = (ponytailYaml: string) => `
${MINIMAL_CONFIG_YAML}
${ponytailYaml}
`;

		it("rejects residual ponytail enabled true", async () => {
			readFile.mockResolvedValue(
				withPonytail(`
ponytail:
  enabled: true
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/ponytail\.enabled was retired \(FLY-2103\)/,
			);
		});

		it("accepts absent ponytail", async () => {
			readFile.mockResolvedValue(MINIMAL_CONFIG_YAML);
			const config = await loader.load("/p/config.yaml");
			expect(config.project).toBe("test-project");
		});

		it("rejects residual ponytail enabled false", async () => {
			readFile.mockResolvedValue(
				withPonytail(`
ponytail:
  enabled: false
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/ponytail\.enabled was retired \(FLY-2103\)/,
			);
		});

		it("rejects non-boolean ponytail.enabled", async () => {
			readFile.mockResolvedValue(
				withPonytail(`
ponytail:
  enabled: "yes"
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/ponytail\.enabled was retired \(FLY-2103\)/,
			);
		});

		it("rejects non-mapping ponytail", async () => {
			readFile.mockResolvedValue(
				withPonytail(`
ponytail: "on"
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/ponytail\.enabled was retired \(FLY-2103\)/,
			);
		});
	});

	describe("FLY-1808 retired founder UX config", () => {
		it.each([
			"founder_ux_gate:\n  mode: enforce",
			'founder_ux_gate: "legacy malformed value"',
		])(
			"ignores stale config without affecting project load: %s",
			async (stale) => {
				readFile.mockResolvedValue(`${MINIMAL_CONFIG_YAML}\n${stale}\n`);
				const config = await loader.load("/p/config.yaml");
				expect(config.project).toBe("test-project");
			},
		);
	});

	describe("FLY-1981 retired config blocks", () => {
		const withFmr = (fmrYaml: string) => `
${MINIMAL_CONFIG_YAML}
${fmrYaml}
`;

		it("accepts configs with both retired blocks absent", async () => {
			readFile.mockResolvedValue(MINIMAL_CONFIG_YAML);
			const config = await loader.load("/p/config.yaml");
			expect(config.project).toBe("test-project");
		});

		it("rejects founder_milestone_report even with the former valid shape", async () => {
			readFile.mockResolvedValue(
				withFmr(`
founder_milestone_report:
  enabled: true
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/founder_milestone_report is retired by FLY-1981/,
			);
		});

		it("rejects founder_milestone_report alternate children", async () => {
			readFile.mockResolvedValue(
				withFmr(`
founder_milestone_report:
  enabled: true
  milestones: [failed, blocked]
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/founder_milestone_report is retired by FLY-1981/,
			);
		});

		it("rejects ship_ready in v1 (covered by FLY-605, not 725 — must fail loudly)", async () => {
			readFile.mockResolvedValue(
				withFmr(`
founder_milestone_report:
  enabled: true
  milestones: [failed, ship_ready]
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/founder_milestone_report is retired by FLY-1981/,
			);
		});

		it("rejects completed in v1 (routine completions → FLY-727 digest, not real-time)", async () => {
			readFile.mockResolvedValue(
				withFmr(`
founder_milestone_report:
  enabled: true
  milestones: [failed, completed]
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/founder_milestone_report is retired by FLY-1981/,
			);
		});

		it("rejects an unknown milestone value", async () => {
			readFile.mockResolvedValue(
				withFmr(`
founder_milestone_report:
  enabled: true
  milestones: [merged]
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/founder_milestone_report is retired by FLY-1981/,
			);
		});

		it("rejects a non-boolean enabled", async () => {
			readFile.mockResolvedValue(
				withFmr(`
founder_milestone_report:
  enabled: "yes"
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/founder_milestone_report is retired by FLY-1981/,
			);
		});

		it("rejects a non-mapping founder_milestone_report", async () => {
			readFile.mockResolvedValue(
				withFmr(`
founder_milestone_report: "on"
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/founder_milestone_report is retired by FLY-1981/,
			);
		});

		it("rejects milestones that is not an array", async () => {
			readFile.mockResolvedValue(
				withFmr(`
founder_milestone_report:
  enabled: true
  milestones: completed
`),
			);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/founder_milestone_report is retired by FLY-1981/,
			);
		});

		it.each([
			"qa:\n  auto: true",
			"qa:\n  future_child: false",
			'qa: "legacy scalar"',
		])("rejects any stale qa block shape: %s", async (qaYaml) => {
			readFile.mockResolvedValue(`${MINIMAL_CONFIG_YAML}\n${qaYaml}\n`);
			await expect(loader.load("/p/config.yaml")).rejects.toThrow(
				/qa is retired by FLY-1981/,
			);
		});
	});
});

describe("ConfigLoader — pipeline DAG routing", () => {
	let readFile: ReturnType<typeof vi.fn>;
	let loader: ConfigLoader;

	beforeEach(() => {
		readFile = vi.fn();
		loader = new ConfigLoader(readFile);
	});

	it("accepts configs without the retired pipeline block", async () => {
		readFile.mockResolvedValue(MINIMAL_CONFIG_YAML);
		const config = await loader.load("/p/config.yaml");
		expect(config.project).toBe("test-project");
	});

	it("rejects a scalar residual pipeline block", async () => {
		readFile.mockResolvedValue(`${MINIMAL_CONFIG_YAML}\npipeline: nope\n`);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/pipeline\.dag was retired \(FLY-2103\)/,
		);
	});

	it("rejects residual pipeline.dag: true", async () => {
		readFile.mockResolvedValue(
			`${MINIMAL_CONFIG_YAML}\npipeline:\n  dag: true\n`,
		);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/pipeline\.dag was retired \(FLY-2103\)/,
		);
	});

	it("rejects residual pipeline.dag: false", async () => {
		readFile.mockResolvedValue(
			`${MINIMAL_CONFIG_YAML}\npipeline:\n  dag: false\n`,
		);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/pipeline\.dag was retired \(FLY-2103\)/,
		);
	});

	it("rejects residual pipeline.work_kind", async () => {
		readFile.mockResolvedValue(
			`${MINIMAL_CONFIG_YAML}\npipeline:\n  work_kind: false\n`,
		);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/pipeline\.work_kind was retired \(FLY-2103\)/,
		);
	});

	it("rejects malformed pipeline.dag as retired", async () => {
		readFile.mockResolvedValue(
			`${MINIMAL_CONFIG_YAML}\npipeline:\n  dag: "yes"\n`,
		);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/pipeline\.dag was retired \(FLY-2103\)/,
		);
	});

	it.each([true, false])("rejects pipeline.work_kind: %s", async (workKind) => {
		readFile.mockResolvedValue(
			`${MINIMAL_CONFIG_YAML}\npipeline:\n  dag: true\n  work_kind: ${workKind}\n`,
		);
		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/pipeline\.work_kind was retired \(FLY-2103\)/,
		);
	});

	it("rejects malformed pipeline.work_kind as retired", async () => {
		readFile.mockResolvedValue(
			`${MINIMAL_CONFIG_YAML}\npipeline:\n  dag: true\n  work_kind: "yes"\n`,
		);

		await expect(loader.load("/p/config.yaml")).rejects.toThrow(
			/pipeline\.work_kind was retired \(FLY-2103\)/,
		);
	});
});
