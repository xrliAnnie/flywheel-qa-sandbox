import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(
	HERE,
	"../../../../scripts/qa-fly-1262-management-dashboard.mjs",
);
const roots: string[] = [];

const REQUIRED_TESTS = [
	"serves one secret-free aggregate and a UI with no manual ingest or copied inventory",
	"auto-discovers added and removed Leads, registered flags, project crons, and unmatched crons with zero UI edits",
	"stages server old-to-new values, writes config/DB/flag/plist, rejects stale sources, and journals partial results",
	"ships a runnable live-readonly QA entrypoint that reports counts without mutation",
];

afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function verify(statuses: Array<"passed" | "skipped">) {
	const root = mkdtempSync(join(tmpdir(), "fly1262-qa-report-"));
	roots.push(root);
	const report = join(root, "report.json");
	writeFileSync(
		report,
		JSON.stringify({
			numTotalTests: statuses.length,
			numPassedTests: statuses.filter((status) => status === "passed").length,
			testResults: [
				{
					assertionResults: statuses.map((status, index) => ({
						title: REQUIRED_TESTS[index],
						fullName: `FLY-1262 PRD section 6 acceptance ${REQUIRED_TESTS[index]}`,
						status,
					})),
				},
			],
		}),
	);
	return spawnSync(process.execPath, [SCRIPT, "--verify-report", report], {
		encoding: "utf8",
	});
}

describe("FLY-1262 QA script result attestation", () => {
	it("prints four requirement PASS lines only for the four named passing tests", () => {
		const result = verify(["passed", "passed", "passed", "passed"]);
		expect(result.status).toBe(0);
		expect(result.stdout.match(/^PASS §6\.[1-4]:/gm)).toHaveLength(4);
	});

	it("fails closed when a required test is skipped", () => {
		const result = verify(["passed", "skipped", "passed", "passed"]);
		expect(result.status).not.toBe(0);
		expect(result.stdout).not.toContain("PASS §6.3");
		expect(result.stderr).toMatch(/skipped|did not pass/i);
	});

	it("fails closed when any required test is absent", () => {
		const result = verify(["passed", "passed", "passed"]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toMatch(/missing|exactly four/i);
	});
});
