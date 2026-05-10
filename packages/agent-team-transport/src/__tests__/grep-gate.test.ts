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
		// Combined output should report PASS for all rules.
		const combined = stdout + stderr;
		expect(combined).toContain(
			"no-hardcoded-claude-teams-path: OK",
		);
		expect(combined).toContain("no-claude-code-internal-imports: OK");
		expect(combined).toContain("no-flywheel-teams-dir-env: OK");
		expect(combined).toContain("PASS — no violations.");
	}, 30_000);
});
