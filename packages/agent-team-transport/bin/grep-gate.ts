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

/**
 * Resolve repo root via `git rev-parse --show-toplevel`. The grep-gate must
 * run with cwd at repo root because all rule globs are repo-root-relative
 * (`packages/*\/src/**` etc) — running from a package dir would silently
 * scan nothing (Codex r2 LOW finding). We auto-detect rather than relying
 * on caller cwd so the script works the same whether run from repo root
 * (CI), a package dir (package script), or anywhere else.
 */
async function getRepoRoot(): Promise<string> {
	const { stdout } = await execFile("git", ["rev-parse", "--show-toplevel"]);
	return stdout.trim();
}

interface Rule {
	name: string;
	pattern: string; // grep -E pattern
	includeGlobs: string[]; // git ls-files patterns
	excludeGlobs: string[];
}

// Self-allowlist: this gate file MUST contain the literal patterns it scans
// for (since its job is to detect them). Excluding it from every rule
// prevents the gate from flagging itself.
const SELF_PATH = "packages/agent-team-transport/bin/grep-gate.ts";

const RULES: Rule[] = [
	{
		name: "no-hardcoded-claude-teams-path",
		pattern: "~/\\.claude/teams|\\.claude/teams",
		// Codex r1 low #5 + r3 medium: include packages/*/bin/*.ts so direct
		// bin files are scanned (the **/*.ts double-star glob doesn't match
		// direct children in git pathspecs — Codex r3 catch).
		includeGlobs: [
			"packages/*/src/**/*.ts",
			"packages/*/bin/*.ts",
			"packages/*/bin/**/*.ts",
			"packages/*/scripts/*.sh",
		],
		excludeGlobs: [
			"packages/agent-team-transport/src/claude/**",
			SELF_PATH,
			"**/*.test.ts",
			"**/__tests__/**",
		],
	},
	{
		name: "no-claude-code-internal-imports",
		pattern: "from ['\"]@anthropic-ai/claude-code|from ['\"].*claude-code/src/",
		includeGlobs: [
			"packages/*/src/**/*.ts",
			"packages/*/bin/*.ts",
			"packages/*/bin/**/*.ts",
		],
		excludeGlobs: [
			"packages/agent-team-transport/src/claude/**",
			"packages/agent-team-transport/src/claude/__tests__/**",
			SELF_PATH,
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
			"packages/*/bin/*.ts",
			"packages/*/bin/**/*.ts",
			"packages/*/scripts/*.sh",
		],
		excludeGlobs: [SELF_PATH, "**/*.test.ts", "**/__tests__/**"],
	},
];

async function runGitGrep(rule: Rule, repoRoot: string): Promise<string[]> {
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
		const { stdout } = await execFile("git", args, { cwd: repoRoot });
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
	const repoRoot = await getRepoRoot();
	console.log(`[grep-gate] Scanning from repo root: ${repoRoot}`);
	let totalViolations = 0;
	for (const rule of RULES) {
		const violations = await runGitGrep(rule, repoRoot);
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
