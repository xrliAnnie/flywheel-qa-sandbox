import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { SKILL_TEMPLATES } from "./skill-templates/index.js";

export interface SkillContext {
	issueId: string;
	issueTitle: string;
	issueDescription: string;
	projectName: string;
	testCommand?: string;
	lintCommand?: string;
	buildCommand?: string;
	testFramework?: string;
}

const EXCLUDE_ENTRY = ".claude/skills/";

/**
 * Injects SKILL.md files into a project's `.claude/skills/` directory
 * for consumption by Claude Code sessions.
 */
export class SkillInjector {
	async inject(projectRoot: string, ctx: SkillContext): Promise<void> {
		const values = buildValues(ctx);

		for (const [name, template] of Object.entries(SKILL_TEMPLATES)) {
			const skillDir = path.join(projectRoot, ".claude", "skills", name);
			await fs.promises.mkdir(skillDir, { recursive: true });
			const rendered = render(template, values);
			await fs.promises.writeFile(path.join(skillDir, "SKILL.md"), rendered);
		}

		await this.ensureGitExclude(projectRoot);
	}

	private async ensureGitExclude(projectRoot: string): Promise<void> {
		let excludeFile: string;
		try {
			excludeFile = await gitRevParseGitPath(projectRoot, "info/exclude");
		} catch {
			// Not a git repo — skip
			return;
		}

		const infoDir = path.dirname(excludeFile);

		await fs.promises.mkdir(infoDir, { recursive: true });

		let content = "";
		try {
			content = await fs.promises.readFile(excludeFile, "utf-8");
		} catch {
			// File doesn't exist yet — will create
		}

		if (!content.includes(EXCLUDE_ENTRY)) {
			const suffix = content.endsWith("\n") || content === "" ? "" : "\n";
			await fs.promises.writeFile(
				excludeFile,
				`${content}${suffix}${EXCLUDE_ENTRY}\n`,
			);
		}
	}
}

// ─── Helpers ─────────────────────────────────────

function buildValues(ctx: SkillContext): Record<string, string> {
	return {
		issueId: ctx.issueId,
		issueTitle: ctx.issueTitle,
		issueDescription: ctx.issueDescription,
		projectName: ctx.projectName,
		testCommand: ctx.testCommand ?? "pnpm test",
		lintCommand: ctx.lintCommand ?? "pnpm lint",
		buildCommand: ctx.buildCommand ?? "pnpm build",
		testFramework: ctx.testFramework ?? "vitest",
	};
}

function render(template: string, values: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
		return values[key] ?? match;
	});
}

// Uses execFile (array args, no shell) — safe from injection.
// --git-path returns the canonical path git actually reads, even in linked worktrees.
function gitRevParseGitPath(cwd: string, pathSpec: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			["-C", cwd, "rev-parse", "--git-path", pathSpec],
			(err, stdout) => {
				if (err) return reject(err);
				const result = stdout.trim();
				return resolve(path.resolve(cwd, result));
			},
		);
	});
}
