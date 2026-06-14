/**
 * FLY-247: run the hermetic bash test suites through vitest so they execute
 * in CI without touching .github/workflows (workflow-scope push limitation).
 *
 * Each suite sandboxes HOME and stubs launchctl/plutil/tmux via env seams —
 * they never touch the real system. See the suite headers for scenario maps.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// packages/teamlead/src/__tests__ → repo root
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

function runSuite(relPath: string): void {
	try {
		execFileSync("bash", [join(REPO_ROOT, relPath)], {
			stdio: "pipe",
			timeout: 300_000,
			encoding: "utf8",
			// Vitest exports C.UTF-8, which macOS perl rejects (locale panic
			// inside shasum). Normalize the child locale (code-review R2-LOW).
			env: { ...process.env, LANG: "C", LC_ALL: "C" },
		});
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string };
		throw new Error(
			`bash suite ${relPath} failed:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`,
		);
	}
}

describe("FLY-247 bash suites (hermetic)", () => {
	it("daemon plist model env + safe generation", () => {
		expect(() =>
			runSuite("scripts/__tests__/flywheel-daemon-plist-env.test.sh"),
		).not.toThrow();
	}, 120_000);

	it("daemon staged install verify + failure modes", () => {
		expect(() =>
			runSuite("scripts/__tests__/flywheel-daemon-install-verify.test.sh"),
		).not.toThrow();
	}, 120_000);

	it("claude-lead manifest fleet-field preserve", () => {
		expect(() =>
			runSuite(
				"packages/teamlead/scripts/__tests__/claude-lead-manifest-preserve.test.sh",
			),
		).not.toThrow();
	}, 120_000);

	it("flywheel-fleet plan/apply/rollback/recover", () => {
		expect(() =>
			runSuite("scripts/__tests__/flywheel-fleet.test.sh"),
		).not.toThrow();
	}, 120_000);

	it("flywheel-fleet report", () => {
		expect(() =>
			runSuite("scripts/__tests__/flywheel-fleet-report.test.sh"),
		).not.toThrow();
	}, 120_000);
});
