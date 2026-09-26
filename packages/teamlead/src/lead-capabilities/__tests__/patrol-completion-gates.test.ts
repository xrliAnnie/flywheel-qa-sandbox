import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { runPatrolCompletionGates } from "../patrol-completion-gates.js";

const hash = (text: string | Buffer) =>
	createHash("sha256").update(text).digest("hex");
it("runs the three canonical gates against actual reports without upgrading candidates", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "patrol-gates-")));
	const rules = realpathSync(resolve("lead-rules-base/runbooks/patrol-v1.md"));
	const source = { path: rules, sha256: hash(readFileSync(rules)) };
	const reportPath = join(root, "report with spaces.md");
	const valid = `patrol_schema=2\nROOT_CAUSE_REVIEW status=not_applicable parent=FLY-2072 observed_at=2026-09-26T00:00:00.000Z token=project_scope\nMECHANISM_REVIEW result=none count=0\n${Array.from(
		{ length: 6 },
		(_, i) =>
			`## STEP ${i + 1}\nSTEP ${i + 1}: OK\n${i === 1 ? "pane_count=0" : i === 4 ? "disk_below_threshold=no" : ""}`,
	).join("\n")}\n## STEP DWELL\nSTEP DWELL: OK\n`;
	try {
		for (const [text, expected] of [
			[valid, [true, true, true]],
			[
				valid.replace("STEP 1: OK", "STEP 1: OK-CANDIDATE"),
				[false, true, false],
			],
			[
				valid.replace("disk_below_threshold=no", "disk_below_threshold=yes"),
				[true, false, true],
			],
			[valid.replace("STEP 1: OK", "STEP 1: FINDING"), [true, true, false]],
			[
				valid.replace(
					"STEP 1: OK",
					`STEP 1: FINDING\nFINDING id=${"a".repeat(64)} category=incident step=1 bridge_problem=no result=fixed evidence=receipt-1 owner=n/a next=n/a epic=n/a epic_marker=n/a`,
				),
				[true, true, true],
			],
		] as const) {
			writeFileSync(reportPath, text, { mode: 0o600 });
			const result = runPatrolCompletionGates({
				source,
				report: { path: reportPath, sha256: hash(text) },
				secrets: [],
				assertCurrent: () => {},
			});
			expect(result.gates.map((gate) => gate.passed)).toEqual(expected);
			expect(result.complete).toBe(expected.every(Boolean));
		}
		expect(() =>
			runPatrolCompletionGates({
				source: { ...source, sha256: "0".repeat(64) },
				report: { path: reportPath, sha256: hash(readFileSync(reportPath)) },
				secrets: [],
				assertCurrent: () => {},
			}),
		).toThrow();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
