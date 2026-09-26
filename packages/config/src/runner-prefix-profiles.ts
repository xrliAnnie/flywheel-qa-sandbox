import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type {
	RunnerPrefixRequest,
	RunnerPrefixRole,
} from "./runner-prefix-profile.js";

/**
 * FLY-2913 role-v1 fixed-prefix profiles.
 *
 * Two per-launch controls, both measured on CLI 2.1.283 with real first-turn
 * API usage (engineering/doc/FLY-2913-role-prefix/evidence):
 * - `skillOverrides: "name-only"` hides the DESCRIPTION of skills the role
 *   does not need; the name stays listed and the skill stays invocable, so no
 *   capability is removed. (`off` / `user-invocable-only` measured LARGER
 *   prompts; plugin skills and `Agent(name)` deny had no effect.)
 * - `claudeMdExcludes` drops user rule files that do not apply to the role.
 * Anything not listed keeps its full description or file. Shared ~/.claude
 * files, Lead and Codex configuration and the skill arm are never touched.
 * Reasons per item live in engineering/doc/FLY-2913-role-prefix.
 */
export interface RunnerPrefixRoleProfile {
	/** Exact non-plugin skill names listed name-only (description hidden). */
	skillsNameOnly: readonly string[];
	/** File names under <Claude config dir>/rules excluded with `claudeMdExcludes`. */
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

const COMMON_SKILLS_NAME_ONLY = [
	...PERSONAL_TOOLING,
	...LEAD_ONLY,
	...PM_STRATEGY,
	...HARNESS_CONFIG,
	...SYNCED_DOCUMENTS,
];

export const RUNNER_PREFIX_PROFILES_V1: Readonly<
	Record<RunnerPrefixRole, RunnerPrefixRoleProfile>
> = Object.freeze({
	design: {
		skillsNameOnly: [...COMMON_SKILLS_NAME_ONLY, "simplify", "code-review"],
		rulesExclude: [...PERSONAL_RULES],
	},
	implement: {
		skillsNameOnly: [...COMMON_SKILLS_NAME_ONLY, ...PM_BRAINSTORM_DEPENDENCIES],
		rulesExclude: [...PERSONAL_RULES],
	},
	qa: {
		skillsNameOnly: [
			...COMMON_SKILLS_NAME_ONLY,
			...PM_BRAINSTORM_DEPENDENCIES,
			"simplify",
			"code-review",
			"codex",
		],
		rulesExclude: [...PERSONAL_RULES, ...CODEX_AUTHOR_RULES],
	},
	"review-design": {
		skillsNameOnly: [
			...COMMON_SKILLS_NAME_ONLY,
			...PM_BRAINSTORM_DEPENDENCIES,
			...REVIEWER_NON_AUTHORING,
			"code-review",
		],
		rulesExclude: [
			...PERSONAL_RULES,
			...CODEX_AUTHOR_RULES,
			"html-report-style.md",
		],
	},
	"review-code": {
		skillsNameOnly: [
			...COMMON_SKILLS_NAME_ONLY,
			...PM_BRAINSTORM_DEPENDENCIES,
			...REVIEWER_NON_AUTHORING,
		],
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

const COMPILER_VERSION = 2;

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
	/** Set when pinned skills could not be parsed: every description is kept. */
	skillDescriptions?: "kept-unparsed-pinned-skills";
	/** Skills still listed and invocable, with their description hidden. */
	hiddenSkillDescriptions: string[];
	excludedRules: string[];
	profileDigest: string;
};

export interface CompiledRunnerPrefixProfile {
	/** One `--settings` source, merged before the skill arm and forced denies. */
	settings: {
		skillOverrides: Record<string, "name-only">;
		claudeMdExcludes: string[];
	};
	profileDigest: string;
	stamp: RunnerPrefixStamp;
}

function fail(reason: string): never {
	throw new Error(`runner_prefix_profile: ${reason}`);
}

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;

/**
 * Skills listed in the pinned role file's YAML frontmatter; body text ignored.
 * Supports `skills: [a, b]`, `skills: a` and block lists at any indentation,
 * with trailing comments. Returns null when a `skills` key exists but cannot
 * be parsed, so the caller keeps every skill instead of failing open.
 */
export function parsePinnedRoleSkills(content: string): string[] | null {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
	if (!match) return [];
	const lines = (match[1] ?? "").split(/\r?\n/);
	const clean = (value: string) =>
		value
			.replace(/\s+#.*$/, "")
			.trim()
			.replace(/^(['"])(.*)\1$/, "$2");
	const valid = (names: string[]) =>
		names.every((name) => SKILL_NAME.test(name)) ? names : null;
	for (let i = 0; i < lines.length; i++) {
		const key = /^skills:(.*)$/.exec(lines[i] ?? "");
		if (!key) continue;
		const rest = clean(key[1] ?? "");
		if (rest.startsWith("[")) {
			if (!rest.endsWith("]")) return null;
			const inner = rest.slice(1, -1).trim();
			return valid(inner ? inner.split(",").map(clean) : []);
		}
		if (rest) return valid([rest]);
		const skills: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			const line = lines[j] ?? "";
			if (!line.trim() || /^\s*#/.test(line)) continue;
			const item = /^\s*-\s+(.+)$/.exec(line);
			if (!item) {
				if (/^\s/.test(line)) return null; // nested mapping, not a list
				break;
			}
			skills.push(clean(item[1] ?? ""));
		}
		return valid(skills);
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
	/** The runner's Claude config dir (`CLAUDE_CONFIG_DIR` or `~/.claude`). */
	claudeConfigDir: string;
	skillArm: string;
}): CompiledRunnerPrefixProfile {
	const { request, claudeConfigDir, skillArm } = input;
	const { selection, context } = request;
	if (
		typeof claudeConfigDir !== "string" ||
		!isAbsolute(claudeConfigDir) ||
		claudeConfigDir.includes("\0") ||
		claudeConfigDir.split("/").some((part) => part === "." || part === "..")
	)
		fail("claudeConfigDir must be an absolute, normalized path");
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
	const parsed = context.agent
		? parsePinnedRoleSkills(context.agent.content)
		: [];
	const pinnedSkills = parsed ?? [];
	const keep = new Set([
		...pinnedSkills,
		...RUNNER_PREFIX_REQUIRED_SKILLS[selection.role],
	]);
	// Unknown pinned obligations: keep every description rather than guess.
	const skills =
		parsed === null
			? []
			: sorted(profile.skillsNameOnly.filter((skill) => !keep.has(skill)));
	const rules = sorted(profile.rulesExclude);
	const settings = {
		skillOverrides: Object.fromEntries(
			skills.map((skill) => [skill, "name-only" as const]),
		),
		claudeMdExcludes: rules.map((rule) => `${claudeConfigDir}/rules/${rule}`),
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
			...(parsed === null && {
				skillDescriptions: "kept-unparsed-pinned-skills" as const,
			}),
			hiddenSkillDescriptions: skills,
			excludedRules: rules,
			profileDigest,
		},
	};
}
