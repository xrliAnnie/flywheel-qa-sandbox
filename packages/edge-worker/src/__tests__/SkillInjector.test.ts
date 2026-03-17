import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type SkillContext, SkillInjector } from "../SkillInjector.js";

// ─── Helpers ─────────────────────────────────────

const SKILL_NAMES = [
	"flywheel-context",
	"linear-issue-context",
	"flywheel-git-workflow",
	"flywheel-escalation",
	"flywheel-tdd",
	"flywheel-land",
];

function makeCtx(overrides: Partial<SkillContext> = {}): SkillContext {
	return {
		issueId: "GEO-42",
		issueTitle: "Add user authentication",
		issueDescription: "Implement JWT-based auth for the API endpoints.",
		projectName: "geoforge3d",
		...overrides,
	};
}

// ─── Tests ───────────────────────────────────────

describe("SkillInjector", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-injector-"));
		// Init a git repo so gitRevParseGitDir works
		execFileSync("git", ["init", tmpDir]);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("creates .claude/skills/ directory structure", async () => {
		const injector = new SkillInjector();
		await injector.inject(tmpDir, makeCtx());

		const skillsDir = path.join(tmpDir, ".claude", "skills");
		expect(fs.existsSync(skillsDir)).toBe(true);

		for (const name of SKILL_NAMES) {
			expect(fs.existsSync(path.join(skillsDir, name))).toBe(true);
		}
	});

	it("writes all 5 skill files", async () => {
		const injector = new SkillInjector();
		await injector.inject(tmpDir, makeCtx());

		for (const name of SKILL_NAMES) {
			const skillPath = path.join(
				tmpDir,
				".claude",
				"skills",
				name,
				"SKILL.md",
			);
			expect(fs.existsSync(skillPath)).toBe(true);
			const content = fs.readFileSync(skillPath, "utf-8");
			expect(content.length).toBeGreaterThan(0);
		}
	});

	it("replaces {{issueId}} placeholder", async () => {
		const injector = new SkillInjector();
		await injector.inject(tmpDir, makeCtx());

		const content = fs.readFileSync(
			path.join(
				tmpDir,
				".claude",
				"skills",
				"linear-issue-context",
				"SKILL.md",
			),
			"utf-8",
		);
		expect(content).toContain("GEO-42");
		expect(content).not.toContain("{{issueId}}");
	});

	it("replaces {{issueTitle}} placeholder", async () => {
		const injector = new SkillInjector();
		await injector.inject(tmpDir, makeCtx());

		const content = fs.readFileSync(
			path.join(
				tmpDir,
				".claude",
				"skills",
				"linear-issue-context",
				"SKILL.md",
			),
			"utf-8",
		);
		expect(content).toContain("Add user authentication");
	});

	it("replaces {{testCommand}} placeholder", async () => {
		const injector = new SkillInjector();
		await injector.inject(tmpDir, makeCtx({ testCommand: "npm test" }));

		const content = fs.readFileSync(
			path.join(tmpDir, ".claude", "skills", "flywheel-tdd", "SKILL.md"),
			"utf-8",
		);
		expect(content).toContain("npm test");
	});

	it("no {{...}} remaining in output", async () => {
		const injector = new SkillInjector();
		await injector.inject(tmpDir, makeCtx());

		for (const name of SKILL_NAMES) {
			const content = fs.readFileSync(
				path.join(tmpDir, ".claude", "skills", name, "SKILL.md"),
				"utf-8",
			);
			expect(content).not.toMatch(/\{\{\w+\}\}/);
		}
	});

	it("uses defaults for omitted optional fields", async () => {
		const injector = new SkillInjector();
		// Only required fields — no testCommand etc.
		await injector.inject(tmpDir, makeCtx());

		const content = fs.readFileSync(
			path.join(tmpDir, ".claude", "skills", "flywheel-tdd", "SKILL.md"),
			"utf-8",
		);
		expect(content).toContain("pnpm test");
		expect(content).toContain("vitest");
	});

	it("overwrites existing skill files", async () => {
		const injector = new SkillInjector();
		await injector.inject(tmpDir, makeCtx({ issueId: "GEO-1" }));
		await injector.inject(tmpDir, makeCtx({ issueId: "GEO-2" }));

		const content = fs.readFileSync(
			path.join(
				tmpDir,
				".claude",
				"skills",
				"linear-issue-context",
				"SKILL.md",
			),
			"utf-8",
		);
		expect(content).toContain("GEO-2");
		expect(content).not.toContain("GEO-1");
	});

	it("each SKILL.md has YAML frontmatter", async () => {
		const injector = new SkillInjector();
		await injector.inject(tmpDir, makeCtx());

		for (const name of SKILL_NAMES) {
			const content = fs.readFileSync(
				path.join(tmpDir, ".claude", "skills", name, "SKILL.md"),
				"utf-8",
			);
			expect(content.startsWith("---\nname:")).toBe(true);
		}
	});

	it("idempotent — same input, same output", async () => {
		const injector = new SkillInjector();
		const ctx = makeCtx();

		await injector.inject(tmpDir, ctx);
		const firstPass: Record<string, string> = {};
		for (const name of SKILL_NAMES) {
			firstPass[name] = fs.readFileSync(
				path.join(tmpDir, ".claude", "skills", name, "SKILL.md"),
				"utf-8",
			);
		}

		await injector.inject(tmpDir, ctx);
		for (const name of SKILL_NAMES) {
			const content = fs.readFileSync(
				path.join(tmpDir, ".claude", "skills", name, "SKILL.md"),
				"utf-8",
			);
			expect(content).toBe(firstPass[name]);
		}
	});

	it("appends to info/exclude and git actually ignores the files", async () => {
		const injector = new SkillInjector();
		await injector.inject(tmpDir, makeCtx());

		// Verify exclude file exists at the path git reads
		const excludePath = execFileSync("git", [
			"-C",
			tmpDir,
			"rev-parse",
			"--git-path",
			"info/exclude",
		])
			.toString()
			.trim();
		const resolvedExclude = path.resolve(tmpDir, excludePath);
		const content = fs.readFileSync(resolvedExclude, "utf-8");
		expect(content).toContain(".claude/skills/");

		// Verify git actually ignores the skill files
		const status = execFileSync("git", [
			"-C",
			tmpDir,
			"status",
			"--short",
		]).toString();
		expect(status).not.toContain(".claude/skills/");
	});

	it("does not duplicate exclude entry on re-inject", async () => {
		const injector = new SkillInjector();
		await injector.inject(tmpDir, makeCtx());
		await injector.inject(tmpDir, makeCtx());

		const excludeFile = path.join(tmpDir, ".git", "info", "exclude");
		const content = fs.readFileSync(excludeFile, "utf-8");
		const matches = content.match(/\.claude\/skills\//g);
		expect(matches).toHaveLength(1);
	});

	it("works when .git is a file (worktree scenario) — git ignores skills", async () => {
		// Create a main repo and a worktree
		const mainRepo = fs.mkdtempSync(path.join(os.tmpdir(), "main-repo-"));
		execFileSync("git", ["init", mainRepo]);
		// Create an initial commit so worktree add works
		fs.writeFileSync(path.join(mainRepo, "README.md"), "# Test");
		execFileSync("git", ["-C", mainRepo, "add", "."]);
		execFileSync("git", ["-C", mainRepo, "commit", "-m", "init"]);

		const wtPath = path.join(os.tmpdir(), `wt-${Date.now()}`);
		execFileSync("git", [
			"-C",
			mainRepo,
			"worktree",
			"add",
			wtPath,
			"-b",
			"test-branch",
		]);

		try {
			// .git in worktree is a file, not a directory
			const gitFile = fs.readFileSync(path.join(wtPath, ".git"), "utf-8");
			expect(gitFile.startsWith("gitdir:")).toBe(true);

			const injector = new SkillInjector();
			await injector.inject(wtPath, makeCtx());

			// Verify exclude was written to the path git reads for this worktree
			const excludePath = execFileSync("git", [
				"-C",
				wtPath,
				"rev-parse",
				"--git-path",
				"info/exclude",
			])
				.toString()
				.trim();
			const resolvedExclude = path.resolve(wtPath, excludePath);
			const content = fs.readFileSync(resolvedExclude, "utf-8");
			expect(content).toContain(".claude/skills/");

			// Verify git actually ignores the skill files in the worktree
			const status = execFileSync("git", [
				"-C",
				wtPath,
				"status",
				"--short",
			]).toString();
			expect(status).not.toContain(".claude/skills/");
		} finally {
			execFileSync("git", [
				"-C",
				mainRepo,
				"worktree",
				"remove",
				wtPath,
				"--force",
			]);
			fs.rmSync(mainRepo, { recursive: true, force: true });
		}
	});
});
