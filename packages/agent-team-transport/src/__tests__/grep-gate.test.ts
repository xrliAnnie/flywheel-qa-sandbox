/**
 * Grep gate test (Codex r5 low #1 + Phase 0 acceptance).
 *
 * Runs `node dist/bin/grep-gate.js` and asserts it exits 0 in the current
 * tree. If a developer accidentally hardcodes `~/.claude/teams/` in
 * non-allowlisted production source, this test fails CI before the PR
 * lands.
 */

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const GREP_GATE_PATH = resolve(__dirname, "../../dist/bin/grep-gate.js");

describe("grep-gate (vendor-neutrality CI gate)", () => {
	it("exits 0 when run on the current tree", async () => {
		const { stdout, stderr } = await execFileAsync("node", [GREP_GATE_PATH]);
		const combined = stdout + stderr;
		expect(combined).toContain("no-hardcoded-claude-teams-path: OK");
		expect(combined).toContain("no-claude-code-internal-imports: OK");
		expect(combined).toContain("no-flywheel-teams-dir-env: OK");
		expect(combined).toContain("PASS — no violations.");
		// Codex r2 LOW finding: gate must auto-resolve repo root rather than
		// passively trust the cwd, otherwise running from any package dir
		// silently scans nothing.
		expect(combined).toContain("Scanning from repo root:");
	}, 30_000);

	it("works the same when invoked from a non-repo-root cwd (Codex r2 LOW fix)", async () => {
		// Run from a subdirectory inside the repo — verifies the gate auto-
		// detects repo root via git rev-parse rather than passively trusting
		// cwd (Codex r2 found the test originally ran from package cwd which
		// silently scanned nothing).
		const subDir = resolve(__dirname, "..");
		const { stdout, stderr } = await execFileAsync("node", [GREP_GATE_PATH], {
			cwd: subDir,
		});
		const combined = stdout + stderr;
		expect(combined).toContain("Scanning from repo root:");
		expect(combined).toContain("PASS — no violations.");
	}, 30_000);

	it("DOES scan packages/*/bin/*.ts files (Codex r3 medium fix — git pathspec **/*.ts doesn't match direct files)", async () => {
		// Sanity check that the include globs actually resolve to bin/*.ts files.
		// If this regresses, the gate would silently scan nothing in bin/ and a
		// forbidden literal in a CLI helper would land in main.
		const { execFile: ef } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const efp = promisify(ef);
		const repoRoot = (
			await efp("git", ["rev-parse", "--show-toplevel"])
		).stdout.trim();

		const direct = await efp("git", ["ls-files", "--", "packages/*/bin/*.ts"], {
			cwd: repoRoot,
		});
		// Direct bin/*.ts files MUST resolve (we have at least cli + grep-gate).
		expect(direct.stdout.trim().length).toBeGreaterThan(0);
		expect(direct.stdout).toContain(
			"packages/agent-team-transport/bin/agent-team-transport-cli.ts",
		);
		expect(direct.stdout).toContain(
			"packages/agent-team-transport/bin/grep-gate.ts",
		);
	}, 30_000);
});
