/**
 * FLY-574 — run the hermetic bash test suites for the companion single-process
 * remediation scripts through vitest so they execute in CI.
 *
 * Both suites sandbox everything: launchctl + tmux are stubbed via env seams and
 * all plist / start.sh / access.json fixtures live under a mktemp dir. They never
 * touch the real launchd domain, the real LaunchAgents dir, the real
 * personal-assistant repo, or a real access.json. See each suite header for the
 * scenario map.
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
			timeout: 120_000,
			encoding: "utf8",
			env: { ...process.env, LANG: "C", LC_ALL: "C" },
		});
	} catch (err) {
		const e = err as { stdout?: string; stderr?: string };
		throw new Error(
			`bash suite ${relPath} failed:\n${e.stdout ?? ""}\n${e.stderr ?? ""}`,
		);
	}
}

describe("FLY-574 companion single-process bash suites (hermetic)", () => {
	it("decommission-legacy-companion-daemon: bootout + plist archive + start.sh fail-close + verify", () => {
		expect(() =>
			runSuite(
				"packages/teamlead/scripts/__tests__/decommission-legacy-companion-daemon.test.sh",
			),
		).not.toThrow();
	}, 120_000);

	it("add-roundtable-allowfrom: atomic + backed-up + idempotent + fail-closed allowFrom edit", () => {
		expect(() =>
			runSuite(
				"packages/teamlead/scripts/__tests__/add-roundtable-allowfrom.test.sh",
			),
		).not.toThrow();
	}, 120_000);
});
