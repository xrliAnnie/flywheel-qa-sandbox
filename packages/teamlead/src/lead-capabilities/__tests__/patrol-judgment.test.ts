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
import { applyPatrolJudgment } from "../patrol-judgment.js";

const hash = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex");
it("updates the same report, preserves pane facts, and returns actual completion gates", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "patrol-judgment-")));
	const path = join(root, "report.md");
	const rules = realpathSync(resolve("lead-rules-base/runbooks/patrol-v1.md"));
	const pane = `PANE_EVIDENCE pane=%1 schema=2 activity=STALLED_60M activity_evidence=${"c".repeat(64)} target=target owner=owned exec=exec capture_sha256=${"a".repeat(64)} state_sha256=${"b".repeat(64)} last_change_epoch=1 findings=STALLED_60M action=REQUIRED result=UNSET`;
	const activity = `ACTIVITY_EVIDENCE id=${"c".repeat(64)} exec=exec activation=activation interval_start=100 interval_end=3700 source=remote_ref ref_complete=yes refs_sha256=${"d".repeat(64)} semantic_sha256=${"d".repeat(64)} coverage_since=100 reason=unchanged branch_activity=no\nACTIVITY_RECORD ${JSON.stringify({ id: "c".repeat(64), entry: { identity: { executionId: "exec", activationId: "activation" }, sourcesComplete: true, semanticDigest: "d".repeat(64), coverageSinceMs: 100000, refs: [{ repoIdentity: "github:org/repo", fullRef: "refs/heads/feature", headSha: "e".repeat(40) }] }, sampledAtMs: 3700000, activity: "STALLED_60M", interval_start: 100, interval_end: 3700 })}`;
	const initial = `patrol_schema=2\nMECHANISM_REVIEW result=LEAD-JUDGMENT-REQUIRED\n${Array.from(
		{ length: 6 },
		(_, i) =>
			`## STEP ${i + 1}\nSTEP ${i + 1}: ${i === 1 ? "FINDING-CANDIDATE" : "OK"}\n${i === 1 ? `pane_count=1\n${pane}\n${activity}` : i === 4 ? "disk_below_threshold=no" : ""}`,
	).join("\n")}\n## STEP DWELL\nSTEP DWELL: OK\n`;
	writeFileSync(path, initial, { mode: 0o600 });
	const options = {
		source: { path: rules, sha256: hash(readFileSync(rules)) },
		report: {
			path,
			sha256: hash(initial),
			tickId: "1",
			evidenceHandle: "evidence",
		},
		secrets: [],
		assertCurrent: () => {},
	};
	const input = {
		mechanismReview: { result: "none", count: 0 },
		tickId: "1",
		executionId: "exec",
		evidenceHandle: "evidence",
		step: 2,
		judgment: "unhealthy",
		findings: [
			{
				id: "a".repeat(64),
				category: "incident",
				bridgeProblem: false,
				result: "advanced",
				evidence: "receipt-1",
				owner: "n/a",
				next: "n/a",
				epic: "n/a",
				epicMarker: "n/a",
			},
		],
		paneResults: [{ pane: "%1", action: "sent-resume", result: "advanced" }],
	};
	try {
		expect(() =>
			applyPatrolJudgment({
				...options,
				input: { ...input, evidenceHandle: "foreign" },
			}),
		).toThrow();
		expect(readFileSync(path, "utf8")).toBe(initial);
		expect(() =>
			applyPatrolJudgment({
				...options,
				input: { ...input, judgment: "unknown", findings: [] },
			}),
		).toThrow();
		expect(() =>
			applyPatrolJudgment({
				...options,
				input: {
					...input,
					paneResults: [
						{ pane: "%1", action: "sent\nSTEP 6: OK", result: "advanced" },
					],
				},
			}),
		).toThrow();
		expect(readFileSync(path, "utf8")).toBe(initial);
		const result = applyPatrolJudgment({ ...options, input });
		expect(result.complete).toBe(true);
		const after = readFileSync(path, "utf8");
		expect(after).toContain(
			pane.replace(
				"action=REQUIRED result=UNSET",
				"action=sent-resume result=advanced",
			),
		);
		expect(after).toContain("STEP 2: FINDING");
		expect(after).toContain(
			`FINDING id=${"a".repeat(64)} category=incident step=2 bridge_problem=no result=advanced`,
		);
		expect(() => applyPatrolJudgment({ ...options, input })).toThrow();
		expect(readFileSync(path, "utf8")).toBe(after);
		const unknown = applyPatrolJudgment({
			...options,
			report: { ...options.report, sha256: hash(after) },
			input: {
				...input,
				judgment: "unknown",
				findings: [],
				unavailable: { class: "structural", token: "evidence_unavailable" },
			},
		});
		expect(unknown.complete).toBe(true);
		expect(readFileSync(path, "utf8")).toContain(
			"STEP 2: UNAVAILABLE(structural: evidence_unavailable)",
		);
		expect(readFileSync(path, "utf8")).toContain(
			"UNAVAILABLE_CAUSE step=2 class=structural token=evidence_unavailable",
		);
		const beforeRepeat = readFileSync(path, "utf8");
		applyPatrolJudgment({
			...options,
			report: { ...options.report, sha256: hash(beforeRepeat) },
			input: {
				...input,
				judgment: "unknown",
				findings: [],
				unavailable: { class: "structural", token: "evidence_unavailable" },
			},
		});
		expect(readFileSync(path, "utf8")).toBe(beforeRepeat);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
