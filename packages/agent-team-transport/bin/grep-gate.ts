#!/usr/bin/env node
/**
 * CI grep gate (plan v1.27.1 §2.0 Phase 0 测试 Gate).
 *
 * Enforces vendor neutrality discipline:
 * - Production source MUST NOT hardcode `~/.claude/teams/` literal — go
 *   through `transport.getInboxPath(...)` instead
 * - Production source MUST NOT import claude-code internals — only the
 *   `agent-team-transport/src/claude/**` adapter is allowed
 * - `FLYWHEEL_TEAMS_DIR` env var is fully banned (Codex r1 high #5 + r2 #6)
 *
 * Scope: production source only — `packages/*\/src/**` + `packages/teamlead/scripts/*.sh`.
 * Excludes test files (`**\/*.test.*`, `**\/__tests__/**`) and docs (`doc/**`).
 *
 * Allowlist:
 * - `packages/agent-team-transport/src/claude/**` — claude-specific code lives here
 * - `packages/agent-team-transport/src/claude/__tests__/**` — fixture imports for round-trip
 *
 * Exit code: 0 if clean, 1 if any violation found.
 */

import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

interface Rule {
	name: string;
	pattern: string; // grep -E pattern
	includeGlobs: string[]; // git ls-files patterns
	excludeGlobs: string[];
}

const RULES: Rule[] = [
	{
		name: "no-hardcoded-claude-teams-path",
		pattern: "~/\\.claude/teams|\\.claude/teams",
		// Codex r1 low #5: include packages/*/bin/**/*.ts so CLI helpers are
		// also covered by the vendor-neutrality guard.
		includeGlobs: [
			"packages/*/src/**/*.ts",
			"packages/*/bin/**/*.ts",
			"packages/*/scripts/*.sh",
		],
		excludeGlobs: [
			"packages/agent-team-transport/src/claude/**",
			"**/*.test.ts",
			"**/__tests__/**",
		],
	},
	{
		name: "no-claude-code-internal-imports",
		pattern: "from ['\"]@anthropic-ai/claude-code|from ['\"].*claude-code/src/",
		includeGlobs: ["packages/*/src/**/*.ts", "packages/*/bin/**/*.ts"],
		excludeGlobs: [
			"packages/agent-team-transport/src/claude/**",
			"packages/agent-team-transport/src/claude/__tests__/**",
			"**/*.test.ts",
			"**/__tests__/**",
		],
	},
	{
		name: "no-flywheel-teams-dir-env",
		// Banned per Codex r1 high #5 + r2 medium #6 — use CLAUDE_CONFIG_DIR.
		pattern: "FLYWHEEL_TEAMS_DIR",
		includeGlobs: [
			"packages/*/src/**/*.ts",
			"packages/*/bin/**/*.ts",
			"packages/*/scripts/*.sh",
		],
		excludeGlobs: ["**/*.test.ts", "**/__tests__/**"],
	},
];

async function runGitGrep(rule: Rule): Promise<string[]> {
	const args = [
		"grep",
		"-l",
		"-E",
		rule.pattern,
		"--",
		...rule.includeGlobs,
		...rule.excludeGlobs.map((g) => `:(exclude)${g}`),
	];
	try {
		const { stdout } = await execFile("git", args);
		return stdout
			.split("\n")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
	} catch (error) {
		// git grep returns exit 1 when no matches — that's the success case.
		const code = (error as { code?: number }).code;
		if (code === 1) return [];
		throw error;
	}
}

async function main(): Promise<void> {
	let totalViolations = 0;
	for (const rule of RULES) {
		const violations = await runGitGrep(rule);
		if (violations.length > 0) {
			console.error(
				`\n[grep-gate] ${rule.name}: ${violations.length} violation(s)`,
			);
			console.error(`  pattern: ${rule.pattern}`);
			for (const file of violations) {
				console.error(`    ${file}`);
			}
			totalViolations += violations.length;
		} else {
			console.log(`[grep-gate] ${rule.name}: OK`);
		}
	}
	if (totalViolations > 0) {
		console.error(
			`\n[grep-gate] FAIL — ${totalViolations} violation(s) total. ` +
				`See plan v1.27.1 §2.0 Phase 0 测试 Gate for allowlist scope.`,
		);
		process.exit(1);
	}
	console.log("\n[grep-gate] PASS — no violations.");
}

main().catch((err) => {
	console.error(`[grep-gate] internal error: ${(err as Error).message}`);
	process.exit(2);
});
