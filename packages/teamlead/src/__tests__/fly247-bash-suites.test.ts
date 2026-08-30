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
	it("inject-linear-issue binds Lead identity and reports scope rejects", () => {
		expect(() =>
			runSuite("scripts/__tests__/inject-linear-issue-lead-id.test.sh"),
		).not.toThrow();
	}, 120_000);

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

	// FLY-360: wire the FLY-241 per-Lead model-override launch-plan suite into CI
	// (it lives under packages/teamlead/scripts/__tests__, so it was NOT covered
	// by this wrapper before). Includes the bracketed 1M-selector regression.
	it("fly241 per-Lead model-override launch plan (incl. 1M bracket id)", () => {
		expect(() =>
			runSuite(
				"packages/teamlead/scripts/__tests__/fly241-lead-model-override.test.sh",
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

	// FLY-247 inc2a batch engine suites (were missing from the wrapper → not in
	// CI). These cover the write-ahead journal, batch apply/restore, the
	// --changes-file CLI, baseline/env-pinned rejects, owner-claim + CAS
	// launching→running (Codex R2 HIGH-2), and crash recovery.
	it("flywheel-fleet-journal write-ahead journal", () => {
		expect(() =>
			runSuite("scripts/__tests__/flywheel-fleet-journal.test.sh"),
		).not.toThrow();
	}, 120_000);

	it("flywheel-fleet-batch primitives (write/restore/baseline)", () => {
		expect(() =>
			runSuite("scripts/__tests__/flywheel-fleet-batch.test.sh"),
		).not.toThrow();
	}, 120_000);

	it("flywheel-fleet --changes-file CLI", () => {
		expect(() =>
			runSuite("scripts/__tests__/flywheel-fleet-changes-file.test.sh"),
		).not.toThrow();
	}, 120_000);

	// FLY-709 P4.2: the single-Lead value-flags entry the console's copy-paste
	// command targets (canonical changes-file shape + backend fail-close).
	it("flywheel-fleet single-lead value flags (FLY-709 Path C)", () => {
		expect(() =>
			runSuite("scripts/__tests__/flywheel-fleet-lead-flags.test.sh"),
		).not.toThrow();
	}, 120_000);

	it("flywheel-fleet apply-batch orchestration (mid-fail/baseline/env-pinned)", () => {
		expect(() =>
			runSuite("scripts/__tests__/flywheel-fleet-apply-batch.test.sh"),
		).not.toThrow();
	}, 120_000);

	it("flywheel-fleet batch recovery reconciliation", () => {
		expect(() =>
			runSuite("scripts/__tests__/flywheel-fleet-recover.test.sh"),
		).not.toThrow();
	}, 120_000);
});
