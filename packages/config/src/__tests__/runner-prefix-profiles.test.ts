import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunnerPrefixRequest } from "../runner-prefix-profile.js";
import {
	compileRunnerPrefixProfile,
	parsePinnedRoleSkills,
	RUNNER_PREFIX_PROFILES_V1,
	RUNNER_PREFIX_REQUIRED_SKILLS,
} from "../runner-prefix-profiles.js";

const ROLES = [
	"design",
	"implement",
	"qa",
	"review-design",
	"review-code",
] as const;
const workflow = {
	runId: "run-2913",
	snapshotDigest: "a".repeat(64),
	templateId: "tpl_code",
};
function request(
	role: (typeof ROLES)[number],
	agentContent: string | null = null,
): RunnerPrefixRequest {
	const phase =
		role === "design" || role === "implement" || role === "qa"
			? role
			: "implement";
	return {
		selection: { mode: "role-v1", role, taskSetId: "engineering", workflow },
		context: {
			workflow,
			nodeId: phase,
			phase,
			agent:
				agentContent === null
					? null
					: { content: agentContent, digest: "b".repeat(64) },
		},
	};
}
const claudeConfigDir = "/Users/fixture/.claude";

describe("runner prefix role profiles v1 (FLY-2913)", () => {
	it("defines exactly the five engineering roles", () => {
		expect(Object.keys(RUNNER_PREFIX_PROFILES_V1).sort()).toEqual(
			[...ROLES].sort(),
		);
	});

	it.each(ROLES)(
		"%s never hides a contract-required skill or drops a required rule",
		(role) => {
			const profile = RUNNER_PREFIX_PROFILES_V1[role];
			for (const skill of RUNNER_PREFIX_REQUIRED_SKILLS[role]) {
				expect(profile.skillsNameOnly, `${role}:${skill}`).not.toContain(skill);
			}
			for (const rule of ["context7.md", "git-workflow.md"]) {
				expect(profile.rulesExclude, `${role}:${rule}`).not.toContain(rule);
			}
			// Observed calls in the seven-day window.
			expect(profile.skillsNameOnly).not.toContain("claude-api");
			expect(profile.skillsNameOnly).not.toContain("onboarding");
		},
	);

	it("only lists non-plugin skills: plugin skills ignore skillOverrides", () => {
		for (const role of ROLES) {
			for (const skill of RUNNER_PREFIX_PROFILES_V1[role].skillsNameOnly) {
				expect(skill, `${role}:${skill}`).not.toContain(":");
			}
		}
	});

	it("keeps authoring and Codex review skills for design and implement", () => {
		for (const role of ["design", "implement"] as const) {
			const off = RUNNER_PREFIX_PROFILES_V1[role].skillsNameOnly;
			for (const skill of [
				"codex-design-review",
				"codex-code-review",
				"codex:rescue",
				"codex:codex-cli-runtime",
			]) {
				expect(off, `${role}:${skill}`).not.toContain(skill);
			}
			expect(RUNNER_PREFIX_PROFILES_V1[role].rulesExclude).not.toContain(
				"codex-review.md",
			);
		}
	});

	it("keeps the PM skills brainstorm depends on only for design", () => {
		for (const skill of [
			"problem-definition",
			"competitive-analysis",
			"scoping-cutting",
		]) {
			expect(RUNNER_PREFIX_PROFILES_V1.design.skillsNameOnly).not.toContain(
				skill,
			);
			expect(RUNNER_PREFIX_PROFILES_V1.implement.skillsNameOnly).toContain(
				skill,
			);
		}
	});

	it("keeps browser and report skills for QA", () => {
		for (const skill of [
			"chrome-repair",
			"proofshot",
			"founder-html-delivery",
			"dataviz",
			"research",
		]) {
			expect(RUNNER_PREFIX_PROFILES_V1.qa.skillsNameOnly).not.toContain(skill);
		}
		expect(RUNNER_PREFIX_PROFILES_V1.qa.rulesExclude).not.toContain(
			"html-report-style.md",
		);
	});

	it("uses exact names with no duplicates or path syntax", () => {
		for (const role of ROLES) {
			const p = RUNNER_PREFIX_PROFILES_V1[role];
			for (const list of [p.skillsNameOnly, p.rulesExclude]) {
				expect(new Set(list).size).toBe(list.length);
				for (const item of list) expect(item).toMatch(/^[A-Za-z0-9:._-]+$/);
			}
			for (const rule of p.rulesExclude) expect(rule).toMatch(/\.md$/);
		}
	});

	it("parses pinned role frontmatter skills in every supported YAML form", () => {
		expect(
			parsePinnedRoleSkills(
				"---\nname: x\nskills: [implement, systematic-debugging]\n---\nbody\nskills: [ignored]\n",
			),
		).toEqual(["implement", "systematic-debugging"]);
		expect(
			parsePinnedRoleSkills(
				"---\nskills:\n  - research\n  - 'write-plan'\nmodel: sonnet\n---\n",
			),
		).toEqual(["research", "write-plan"]);
		expect(
			parsePinnedRoleSkills("---\nskills:\n- codex\n- simplify # why\n---\n"),
		).toEqual(["codex", "simplify"]);
		expect(parsePinnedRoleSkills("---\nskills: codex\n---\n")).toEqual([
			"codex",
		]);
		expect(
			parsePinnedRoleSkills('---\nskills: [a, "b"] # trailing\n---\n'),
		).toEqual(["a", "b"]);
		expect(parsePinnedRoleSkills("---\nskills: []\n---\n")).toEqual([]);
		expect(parsePinnedRoleSkills("no frontmatter")).toEqual([]);
		expect(parsePinnedRoleSkills("---\nname: x\n---\n")).toEqual([]);
	});

	it("reports an unparseable skills key instead of failing open", () => {
		for (const content of [
			"---\nskills:\n  a: b\n---\n",
			"---\nskills: {implement: true}\n---\n",
			"---\nskills: [implement\n---\n",
		]) {
			expect(parsePinnedRoleSkills(content), content).toBeNull();
		}
	});

	it("parses the real pinned engineering role files", () => {
		const nodes = fileURLToPath(
			new URL("../../../../.flywheel/agents/nodes/", import.meta.url),
		);
		const read = (name: string) =>
			parsePinnedRoleSkills(readFileSync(`${nodes}${name}.md`, "utf8"));
		expect(read("eng_design")).toEqual([
			"brainstorm",
			"research",
			"write-plan",
			"diagram-design",
			"codex-design-review",
		]);
		expect(read("implement")).toEqual([
			"implement",
			"systematic-debugging",
			"frontend-design",
			"proofshot",
			"codex-code-review",
		]);
		expect(read("qa")?.length).toBeGreaterThan(0);
	});

	it("skips every skill removal when the pinned skills cannot be parsed", () => {
		const compiled = compileRunnerPrefixProfile({
			request: request("implement", "---\nskills: {implement: true}\n---\n"),
			claudeConfigDir,
			skillArm: "superpowers",
		});
		expect(compiled.settings.skillOverrides).toEqual({});
		expect(compiled.stamp.hiddenSkillDescriptions).toEqual([]);
		expect(compiled.stamp.skillDescriptions).toBe(
			"kept-unparsed-pinned-skills",
		);
		expect(compiled.settings.claudeMdExcludes.length).toBeGreaterThan(0);
	});

	it("compiles into one per-launch settings source", () => {
		const compiled = compileRunnerPrefixProfile({
			request: request("implement"),
			claudeConfigDir,
			skillArm: "superpowers",
		});
		const p = RUNNER_PREFIX_PROFILES_V1.implement;
		expect(compiled.settings).toEqual({
			skillOverrides: Object.fromEntries(
				[...p.skillsNameOnly].sort().map((skill) => [skill, "name-only"]),
			),
			claudeMdExcludes: [...p.rulesExclude]
				.sort()
				.map((rule) => `${claudeConfigDir}/rules/${rule}`),
		});
		// v1 keeps every built-in tool: no `--tools` allow-list is emitted.
		expect(Object.keys(compiled).sort()).toEqual([
			"profileDigest",
			"settings",
			"stamp",
		]);
		expect(compiled.profileDigest).toMatch(/^[a-f0-9]{64}$/);
	});

	it("always keeps the pinned role's frontmatter skills (union)", () => {
		const offForImplement = RUNNER_PREFIX_PROFILES_V1.implement.skillsNameOnly;
		expect(offForImplement).toContain("problem-definition");
		const compiled = compileRunnerPrefixProfile({
			request: request(
				"implement",
				"---\nskills: [implement, problem-definition]\n---\nrole\n",
			),
			claudeConfigDir,
			skillArm: "superpowers",
		});
		expect(compiled.settings.skillOverrides).not.toHaveProperty(
			"problem-definition",
		);
		expect(compiled.stamp.pinnedSkills).toEqual([
			"implement",
			"problem-definition",
		]);
		expect(compiled.stamp.hiddenSkillDescriptions).not.toContain(
			"problem-definition",
		);
	});

	it("is deterministic and binds role, arm and pinned identity into the digest", () => {
		const base = {
			request: request("qa"),
			claudeConfigDir,
			skillArm: "superpowers",
		};
		const a = compileRunnerPrefixProfile(base);
		expect(compileRunnerPrefixProfile(base)).toEqual(a);
		expect(
			compileRunnerPrefixProfile({ ...base, skillArm: "matt" }).profileDigest,
		).not.toBe(a.profileDigest);
		expect(
			compileRunnerPrefixProfile({ ...base, request: request("design") })
				.profileDigest,
		).not.toBe(a.profileDigest);
		const other = request("qa");
		const moved = { ...workflow, snapshotDigest: "c".repeat(64) };
		other.selection = {
			...other.selection,
			workflow: moved,
		} as typeof other.selection;
		other.context = { ...other.context, workflow: moved };
		expect(
			compileRunnerPrefixProfile({ ...base, request: other }).profileDigest,
		).not.toBe(a.profileDigest);
	});

	it("records only identities and decisions in the stamp", () => {
		const compiled = compileRunnerPrefixProfile({
			request: request("review-code", "---\nskills: [x]\n---\nSECRET BODY"),
			claudeConfigDir,
			skillArm: "superpowers",
		});
		expect(compiled.stamp).toMatchObject({
			version: 1,
			mode: "role-v1",
			role: "review-code",
			taskSetId: "engineering",
			workflow,
			nodeId: "implement",
			skillArm: "superpowers",
			profileDigest: compiled.profileDigest,
			compilerVersion: 2,
		});
		expect(JSON.stringify(compiled.stamp)).not.toContain("SECRET BODY");
		expect(JSON.stringify(compiled.stamp)).not.toContain(claudeConfigDir);
	});

	it("rejects a relative or unsafe Claude config directory", () => {
		for (const bad of ["relative/home", "", "/tmp/../etc", "/a\0b"]) {
			expect(() =>
				compileRunnerPrefixProfile({
					request: request("design"),
					claudeConfigDir: bad,
					skillArm: "superpowers",
				}),
			).toThrow(/runner_prefix_profile/);
		}
	});

	it("rejects a selection whose pinned context disagrees", () => {
		const split = request("qa");
		split.context = {
			...split.context,
			workflow: { ...workflow, snapshotDigest: "d".repeat(64) },
		};
		expect(() =>
			compileRunnerPrefixProfile({
				request: split,
				claudeConfigDir,
				skillArm: "superpowers",
			}),
		).toThrow(/disagree/);
	});

	it("rejects a legacy selection or a role/selection mismatch", () => {
		const bad = request("design");
		(bad.selection as { role: string }).role = "lead";
		expect(() =>
			compileRunnerPrefixProfile({
				request: bad,
				claudeConfigDir,
				skillArm: "superpowers",
			}),
		).toThrow(/runner_prefix_profile/);
	});
});
