import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type {
	RunnerPrefixRequest,
	RunnerPrefixRole,
} from "./runner-prefix-profile.js";

/**
 * FLY-2913 role-v1 fixed-prefix profiles.
 *
 * Every entry is an explicit REMOVAL decided from the role contracts, the
 * seven-day call evidence and the pinned role files; anything not listed stays
 * loaded, so a newly installed skill/agent/rule is never silently dropped.
 * Only per-launch settings are produced: shared ~/.claude files, Lead and Codex
 * configuration are never touched, and the skill arm's plugins are left alone.
 * Reasons per item live in engineering/doc/FLY-2913-role-prefix.
 */
export interface RunnerPrefixRoleProfile {
	/** Exact skill names hidden with `skillOverrides: off`. */
	skillsOff: readonly string[];
	/** Exact subagent names denied with `permissions.deny: Agent(name)`. */
	agentsDeny: readonly string[];
	/** File names under ~/.claude/rules excluded with `claudeMdExcludes`. */
	rulesExclude: readonly string[];
}

// Personal-assistant / media / account tooling that no engineering role uses.
const PERSONAL_TOOLING = [
	"codex-image",
	"gemini-image",
	"gemini-video",
	"notion",
	"video-watch",
	"writing-engine",
	"xiaohongshu-learning",
	"deep-research",
	"computer-bootstrap",
	"cleanup",
	"codex-relogin",
	"gws",
	"learn-permissions",
	"loop-codex",
] as const;
// Lead/orchestration actions a bounded runner must not take (ship, spin,
// issue creation, alternate reviewers outside the injected review route).
const LEAD_ONLY = [
	"create-issue",
	"ship-pr",
	"spin",
	"flywheel-land",
	"setup-discord-lead",
	"setup-flywheel-hooks",
	"orchestrator",
	"retro",
	"peer-review",
	"gemini-code-review",
	"gemini-design-review",
] as const;
const PM_STRATEGY = [
	"defining-product-vision",
	"dogfooding",
	"prioritizing-roadmap",
	"working-backwards",
] as const;
// brainstorm.md references these for product/UI work, so design keeps them.
const PM_BRAINSTORM_DEPENDENCIES = [
	"problem-definition",
	"competitive-analysis",
	"scoping-cutting",
] as const;
// Harness self-configuration skills; runners never reconfigure Claude Code.
const HARNESS_CONFIG = [
	"keybindings-help",
	"update-config",
	"schedule",
	"fewer-permission-prompts",
	"workflow-authoring",
	"init",
] as const;
// claude.ai synced office/document skills; no engineering role uses them.
const SYNCED_DOCUMENTS = [
	"docs",
	"docx",
	"pptx",
	"xlsx",
	"pdf",
	"import-memory",
	"morning",
	"google-workspace",
	"skill-creator",
] as const;
// Off-stack plugin skills (Go, ClickHouse, Postgres) and plugin self-learning.
const PLUGIN_OFF_DOMAIN = [
	"everything-claude-code:go-build",
	"everything-claude-code:go-review",
	"everything-claude-code:go-test",
	"everything-claude-code:golang-patterns",
	"everything-claude-code:golang-testing",
	"everything-claude-code:clickhouse-io",
	"everything-claude-code:postgres-patterns",
	"everything-claude-code:instinct-export",
	"everything-claude-code:instinct-import",
	"everything-claude-code:instinct-status",
	"everything-claude-code:evolve",
	"everything-claude-code:skill-create",
	"everything-claude-code:continuous-learning",
	"everything-claude-code:continuous-learning-v2",
] as const;
// Reviewers judge an existing plan/diff; they do not author, ship or deliver.
const REVIEWER_NON_AUTHORING = [
	"brainstorm",
	"research",
	"write-plan",
	"implement",
	"mermaid",
	"codex",
	"codex-design-review",
	"codex-code-review",
	"proofshot",
	"chrome-repair",
	"founder-html-delivery",
	"dataviz",
	"run",
	"simplify",
	"compound",
] as const;

// Lead identities and QA slot Leads are never valid runner subagents.
const LEAD_AGENTS = [
	"anna-interviewer-lead",
	"belle-lead",
	"claude-infra-bot-lead",
	"cos-lead",
	"flywheel-cos-lead",
	"flywheel-eng-lead",
	"flywheel-product-lead",
	"flywheel-test-1",
	"flywheel-test-2",
	"flywheel-test-3",
	"flywheel-test-4",
	"flywheel-test-6",
	"joycon-lead",
	"mufasa-lead",
	"ops-lead",
	"product-lead",
	"rafiki-lead",
	"reflection-lead",
	"sub-lead",
	"tidal-echo-content-lead",
	"tidal-echo-cos-lead",
] as const;
// Personas outside this engineering stack; zero calls in the seven-day window.
const OFF_DOMAIN_AGENTS = [
	"Content-Writer",
	"Data-Engineer",
	"Data-Scientist",
	"Mobile-Developer",
	"Orchestrator",
	"Product-Manager",
	"everything-claude-code:go-build-resolver",
	"everything-claude-code:go-reviewer",
	"everything-claude-code:database-reviewer",
] as const;

// Personal tooling rules; none applies to an engineering runner.
const PERSONAL_RULES = [
	"video-generation.md",
	"image-generation.md",
	"summarize-toolchain.md",
	"deep-research.md",
	"gemini-cli.md",
	"gog.md",
] as const;
// Codex CLI profile switching and PR/plan-triggered Codex reviews apply only
// to roles that author PRs or plans (design, implement).
const CODEX_AUTHOR_RULES = [
	"codex-multi-account.md",
	"codex-review.md",
] as const;

const COMMON_SKILLS_OFF = [
	...PERSONAL_TOOLING,
	...LEAD_ONLY,
	...PM_STRATEGY,
	...HARNESS_CONFIG,
	...SYNCED_DOCUMENTS,
	...PLUGIN_OFF_DOMAIN,
];
const COMMON_AGENTS_DENY = [...LEAD_AGENTS, ...OFF_DOMAIN_AGENTS];

export const RUNNER_PREFIX_PROFILES_V1: Readonly<
	Record<RunnerPrefixRole, RunnerPrefixRoleProfile>
> = Object.freeze({
	design: {
		skillsOff: [...COMMON_SKILLS_OFF, "simplify", "code-review"],
		// Keeps UX-Designer: design may turn UI mockups into specs.
		agentsDeny: [...COMMON_AGENTS_DENY],
		rulesExclude: [...PERSONAL_RULES],
	},
	implement: {
		skillsOff: [...COMMON_SKILLS_OFF, ...PM_BRAINSTORM_DEPENDENCIES],
		agentsDeny: [...COMMON_AGENTS_DENY, "UX-Designer"],
		rulesExclude: [...PERSONAL_RULES],
	},
	qa: {
		skillsOff: [
			...COMMON_SKILLS_OFF,
			...PM_BRAINSTORM_DEPENDENCIES,
			"simplify",
			"code-review",
			"codex",
		],
		agentsDeny: [...COMMON_AGENTS_DENY, "UX-Designer"],
		rulesExclude: [...PERSONAL_RULES, ...CODEX_AUTHOR_RULES],
	},
	"review-design": {
		skillsOff: [
			...COMMON_SKILLS_OFF,
			...PM_BRAINSTORM_DEPENDENCIES,
			...REVIEWER_NON_AUTHORING,
			"code-review",
		],
		agentsDeny: [...COMMON_AGENTS_DENY, "UX-Designer"],
		rulesExclude: [
			...PERSONAL_RULES,
			...CODEX_AUTHOR_RULES,
			"html-report-style.md",
		],
	},
	"review-code": {
		skillsOff: [
			...COMMON_SKILLS_OFF,
			...PM_BRAINSTORM_DEPENDENCIES,
			...REVIEWER_NON_AUTHORING,
		],
		agentsDeny: [...COMMON_AGENTS_DENY, "UX-Designer"],
		rulesExclude: [
			...PERSONAL_RULES,
			...CODEX_AUTHOR_RULES,
			"html-report-style.md",
		],
	},
});

/** Contract-required skills per role; never removable (checked by tests). */
export const RUNNER_PREFIX_REQUIRED_SKILLS: Readonly<
	Record<RunnerPrefixRole, readonly string[]>
> = Object.freeze({
	design: [
		"onboarding",
		"brainstorm",
		"research",
		"write-plan",
		"codex-design-review",
		"founder-html-delivery",
		"mermaid",
		"claude-api",
	],
	implement: [
		"onboarding",
		"implement",
		"codex-code-review",
		"codex:rescue",
		"codex:codex-cli-runtime",
		"proofshot",
		"simplify",
		"code-review",
		"security-review",
		"everything-claude-code:security-review",
		"claude-api",
	],
	qa: [
		"onboarding",
		"proofshot",
		"research",
		"chrome-repair",
		"founder-html-delivery",
		"dataviz",
		"claude-api",
	],
	"review-design": ["claude-api", "security-review"],
	"review-code": [
		"claude-api",
		"code-review",
		"security-review",
		"everything-claude-code:security-review",
	],
});

const COMPILER_VERSION = 1;

export type RunnerPrefixStamp = {
	version: 1;
	compilerVersion: number;
	mode: "role-v1";
	role: RunnerPrefixRole;
	taskSetId: "engineering";
	workflow: { runId: string; snapshotDigest: string; templateId: string };
	nodeId: string;
	skillArm: string;
	pinnedSkills: string[];
	removed: { skills: string[]; agents: string[]; rules: string[] };
	profileDigest: string;
};

export interface CompiledRunnerPrefixProfile {
	/** One `--settings` source, merged before the skill arm and forced denies. */
	settings: {
		skillOverrides: Record<string, "off">;
		claudeMdExcludes: string[];
		permissions: { deny: string[] };
	};
	profileDigest: string;
	stamp: RunnerPrefixStamp;
}

function fail(reason: string): never {
	throw new Error(`runner_prefix_profile: ${reason}`);
}

/** Skills listed in the pinned role file's YAML frontmatter; body text ignored. */
export function parsePinnedRoleSkills(content: string): string[] {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
	if (!match) return [];
	const lines = (match[1] ?? "").split(/\r?\n/);
	const clean = (value: string) => value.trim().replace(/^['"]|['"]$/g, "");
	for (let i = 0; i < lines.length; i++) {
		const inline = /^skills:\s*\[(.*)\]\s*$/.exec(lines[i] ?? "");
		if (inline) return (inline[1] ?? "").split(",").map(clean).filter(Boolean);
		if (/^skills:\s*$/.test(lines[i] ?? "")) {
			const skills: string[] = [];
			for (let j = i + 1; j < lines.length; j++) {
				const item = /^\s+-\s+(.+)$/.exec(lines[j] ?? "");
				if (!item) break;
				skills.push(clean(item[1] ?? ""));
			}
			return skills.filter(Boolean);
		}
	}
	return [];
}

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

/**
 * Pure compiler: role-v1 selection + pinned context → one settings source and
 * a secret-free stamp. The pinned role's frontmatter skills are always kept.
 */
export function compileRunnerPrefixProfile(input: {
	request: RunnerPrefixRequest;
	home: string;
	skillArm: string;
}): CompiledRunnerPrefixProfile {
	const { request, home, skillArm } = input;
	const { selection, context } = request;
	if (
		typeof home !== "string" ||
		!isAbsolute(home) ||
		home.includes("\0") ||
		home.split("/").some((part) => part === "." || part === "..")
	)
		fail("home must be an absolute, normalized path");
	if (
		selection?.mode !== "role-v1" ||
		!(selection.role in RUNNER_PREFIX_PROFILES_V1)
	)
		fail("compile requires a role-v1 selection");
	if (
		context.workflow.runId !== selection.workflow.runId ||
		context.workflow.snapshotDigest !== selection.workflow.snapshotDigest
	)
		fail("selection and pinned context disagree");
	if (typeof skillArm !== "string" || !/^[a-z-]{1,40}$/.test(skillArm))
		fail("invalid skill arm");
	const profile = RUNNER_PREFIX_PROFILES_V1[selection.role];
	const pinnedSkills = context.agent
		? parsePinnedRoleSkills(context.agent.content)
		: [];
	const keep = new Set([
		...pinnedSkills,
		...RUNNER_PREFIX_REQUIRED_SKILLS[selection.role],
	]);
	const skills = sorted(profile.skillsOff.filter((skill) => !keep.has(skill)));
	const agents = sorted(profile.agentsDeny);
	const rules = sorted(profile.rulesExclude);
	const settings = {
		skillOverrides: Object.fromEntries(
			skills.map((skill) => [skill, "off" as const]),
		),
		claudeMdExcludes: rules.map((rule) => `${home}/.claude/rules/${rule}`),
		permissions: { deny: agents.map((agent) => `Agent(${agent})`) },
	};
	const workflow = {
		runId: selection.workflow.runId,
		snapshotDigest: selection.workflow.snapshotDigest,
		templateId: selection.workflow.templateId,
	};
	const profileDigest = createHash("sha256")
		.update(
			JSON.stringify({
				compilerVersion: COMPILER_VERSION,
				role: selection.role,
				taskSetId: selection.taskSetId,
				workflow,
				nodeId: context.nodeId,
				skillArm,
				skills,
				agents,
				rules,
			}),
		)
		.digest("hex");
	return {
		settings,
		profileDigest,
		stamp: {
			version: 1,
			compilerVersion: COMPILER_VERSION,
			mode: "role-v1",
			role: selection.role,
			taskSetId: selection.taskSetId,
			workflow,
			nodeId: context.nodeId,
			skillArm,
			pinnedSkills,
			removed: { skills, agents, rules },
			profileDigest,
		},
	};
}
