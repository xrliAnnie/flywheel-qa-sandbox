/**
 * agent-team-transport CLI integration tests.
 *
 * Per plan v1.27.1 §2.0.4-bis (Codex r2 high #4): launcher integration MUST
 * be quote-safe across spaces/quotes/newlines/$VAR in CLAUDE_CONFIG_DIR /
 * lead-id / parent-session etc. We spawn the actual CLI binary in
 * subprocesses with adversarial values and verify bash can `source` the
 * output without word-splitting bugs.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(
	__dirname,
	"../../dist/bin/agent-team-transport-cli.js",
);

let tempDir: string;
const origConfigDir = process.env.CLAUDE_CONFIG_DIR;
const origStateDir = process.env.FLYWHEEL_STATE_DIR;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "cli-helper-test-"));
});

afterEach(async () => {
	if (origConfigDir === undefined) {
		delete process.env.CLAUDE_CONFIG_DIR;
	} else {
		process.env.CLAUDE_CONFIG_DIR = origConfigDir;
	}
	if (origStateDir === undefined) {
		delete process.env.FLYWHEEL_STATE_DIR;
	} else {
		process.env.FLYWHEEL_STATE_DIR = origStateDir;
	}
	await rm(tempDir, { recursive: true, force: true });
});

async function runCli(
	args: string[],
	env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string }> {
	const fullEnv = { ...process.env, ...env };
	const { stdout, stderr } = await execFileAsync("node", [CLI_PATH, ...args], {
		env: fullEnv,
	});
	return { stdout, stderr };
}

/**
 * Spawn `bash -c 'eval "$(cli-output)"; print-result'` and return what bash
 * sees. This validates that the CLI output is actually safely eval-able by
 * bash with adversarial values.
 *
 * Why `eval "$(...)"` not `source <(...)`: macOS bash 3.2 (GPL3 default)
 * doesn't propagate `declare -ag` from process substitution. `eval` runs
 * in the parent shell so plain `KEY=value` and `ARR=(...)` propagate. The
 * DOUBLE-quoted `"$(...)"` is safe vs word-splitting because it preserves
 * the entire CLI output as one string for eval.
 */
async function bashEvalAndInspect(
	cliArgs: string[],
	bashSnippet: string,
	env: Record<string, string> = {},
): Promise<string> {
	const fullEnv = { ...process.env, ...env };
	const cliCmd = `node ${CLI_PATH} ${cliArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`;
	const script = `set -euo pipefail; eval "$(${cliCmd})"; ${bashSnippet}`;
	const { stdout } = await execFileAsync("bash", ["-c", script], {
		env: fullEnv,
	});
	return stdout;
}

// ============================================================================
// Basic command output
// ============================================================================

describe("CLI helper — basic commands", () => {
	it("vendor returns 'claude-code' (default backend)", async () => {
		const { stdout } = await runCli(["vendor"]);
		expect(stdout.trim()).toBe("claude-code");
	});

	it("lead-env emits valid `export KEY=...` lines (eval-able on bash 3.2+)", async () => {
		const { stdout } = await runCli(["lead-env", "--lead-id", "cos-lead"], {
			CLAUDE_CONFIG_DIR: tempDir,
		});
		expect(stdout).toMatch(/export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=/);
		expect(stdout).toMatch(/export FLYWHEEL_AGENT_BACKEND=/);
		expect(stdout).toMatch(/export CLAUDE_CONFIG_DIR=/);
	});

	it("lead-args emits an `FLYWHEEL_AGENT_TEAM_ARGS=( ... )` array assignment", async () => {
		const { stdout } = await runCli(["lead-args", "--lead-id", "cos-lead"]);
		expect(stdout).toMatch(/FLYWHEEL_AGENT_TEAM_ARGS=\(/);
		expect(stdout).toContain("--agent-id");
		expect(stdout).toContain("cos-lead@cos-lead");
	});

	it("runner-args includes identity flags + caller ctx", async () => {
		const { stdout } = await runCli([
			"runner-args",
			"--lead-id",
			"cos-lead",
			"--runner",
			"runner-FLY-142-abc1",
			"--team",
			"cos-lead",
			"--color",
			"cyan",
			"--permission-mode",
			"bypassPermissions",
		]);
		expect(stdout).toContain("--agent-id");
		expect(stdout).toContain("runner-FLY-142-abc1@cos-lead");
		expect(stdout).toContain("--agent-color");
		expect(stdout).toContain("cyan");
		expect(stdout).toContain("--permission-mode");
		expect(stdout).toContain("bypassPermissions");
	});
});

// ============================================================================
// Quote safety (Codex r2 high #4)
// ============================================================================

describe("CLI helper — quote safety", () => {
	it("preserves spaces in CLAUDE_CONFIG_DIR through bash source", async () => {
		const dirWithSpaces = join(tempDir, "path with spaces");
		await writeFile(join(tempDir, ".keep"), "");

		// Bash should see the env var with spaces preserved.
		const result = await bashEvalAndInspect(
			["lead-env", "--lead-id", "cos-lead"],
			`echo "CLAUDE_CONFIG_DIR=[$CLAUDE_CONFIG_DIR]"`,
			{ CLAUDE_CONFIG_DIR: dirWithSpaces },
		);
		expect(result.trim()).toBe(`CLAUDE_CONFIG_DIR=[${dirWithSpaces}]`);
	});

	it("preserves spaces in lead-id through CLAUDE_ARGS array", async () => {
		const result = await bashEvalAndInspect(
			["lead-args", "--lead-id", "lead with spaces"],
			`echo "len=\${#FLYWHEEL_AGENT_TEAM_ARGS[@]}"; for a in "\${FLYWHEEL_AGENT_TEAM_ARGS[@]}"; do echo "[$a]"; done`,
		);
		// CLI doesn't sanitize names — Lead launcher is responsible for that.
		// We need to verify the spaces don't cause word-splitting (i.e. each
		// quoted value lands as ONE array element).
		expect(result).toContain("[--agent-id]");
		expect(result).toContain("[lead with spaces@lead with spaces]");
		expect(result).toContain("[--agent-name]");
		expect(result).toContain("[lead with spaces]");
		// Array length sanity: 6 elements total (3 flag/value pairs).
		expect(result).toContain("len=6");
	});

	it("preserves $VAR-like values in CLAUDE_ARGS", async () => {
		const result = await bashEvalAndInspect(
			[
				"runner-args",
				"--lead-id",
				"cos-lead",
				"--runner",
				"r",
				"--team",
				"t",
				"--parent-session",
				"$PWD/test_$RANDOM",
			],
			`for a in "\${FLYWHEEL_AGENT_TEAM_ARGS[@]}"; do echo "[$a]"; done`,
		);
		// `$PWD/test_$RANDOM` should appear LITERALLY (not expanded by bash).
		expect(result).toContain("[$PWD/test_$RANDOM]");
	});

	it("preserves single quotes in values", async () => {
		const result = await bashEvalAndInspect(
			[
				"runner-args",
				"--lead-id",
				"cos-lead",
				"--runner",
				"r",
				"--team",
				"t",
				"--parent-session",
				"sess'with'quotes",
			],
			`for a in "\${FLYWHEEL_AGENT_TEAM_ARGS[@]}"; do echo "[$a]"; done`,
		);
		expect(result).toContain("[sess'with'quotes]");
	});
});

// ============================================================================
// Backend switching (FLY-123: CodexAdapter is real — boot-throw removed)
// ============================================================================

describe("CLI helper — backend selection", () => {
	it("FLY-123: FLYWHEEL_AGENT_BACKEND=codex selects the codex adapter (plan 1.8)", async () => {
		const { stdout } = await runCli(["vendor"], {
			FLYWHEEL_AGENT_BACKEND: "codex",
		});
		expect(stdout.trim()).toBe("codex");
	});
});

// ============================================================================
// preflight
// ============================================================================

describe("CLI helper — preflight", () => {
	it("preflight subcommand returns JSON result with availabilitySignals", async () => {
		const { stdout } = await runCli(["preflight"]);
		const parsed = JSON.parse(stdout);
		expect(parsed.ok).toBe(true);
		expect(Array.isArray(parsed.availabilitySignals)).toBe(true);
		expect(parsed.availabilitySignals.length).toBeGreaterThan(0);
	});
});
