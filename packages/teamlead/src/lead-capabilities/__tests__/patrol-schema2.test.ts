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

const hash = (v: string | Buffer) =>
	createHash("sha256").update(v).digest("hex");
it.each(["existing", "created", "no_issue", "no_issue_comment"] as const)(
	"records explicit schema2 mechanism disposition %s through canonical closure",
	(variant) => {
		const mode = variant === "no_issue_comment" ? "no_issue" : variant;
		const noSource = variant === "no_issue";
		const root = realpathSync(mkdtempSync(join(tmpdir(), "patrol-schema2-")));
		const path = join(root, "report.md"),
			rules = realpathSync(resolve("lead-rules-base/runbooks/patrol-v1.md"));
		const initial =
			"patrol_schema=2\nROOT_CAUSE_REVIEW status=not_applicable parent=FLY-2072 observed_at=2026-09-26T00:00:00.000Z token=project_scope\nMECHANISM_REVIEW result=LEAD-JUDGMENT-REQUIRED\n" +
			Array.from(
				{ length: 6 },
				(_, i) =>
					`## STEP ${i + 1}\nSTEP ${i + 1}: OK\n${i === 1 ? "pane_count=0" : i === 4 ? "disk_below_threshold=no" : ""}`,
			).join("\n") +
			"\n## STEP DWELL\nSTEP DWELL: OK\n";
		writeFileSync(path, initial, { mode: 0o600 });
		const id = "a".repeat(64),
			classKey = "b".repeat(64),
			ref = "mechanism-1",
			uuid = "11111111-1111-4111-8111-111111111111";
		const disposition = {
			ref,
			findingId: id,
			mode,
			reason: noSource
				? "没有相关 Linear 源 issue，因为这是隔离演练的合成输入。"
				: "已有完整查重和回读记录，使用相同机制归类。",
			rootCause: "状态转移遗漏了失败后的恢复处理，导致任务持续等待。",
			counterexample: "输入失败状态后仍返回等待，预期应进入恢复分支。",
			issueIdentifier: noSource ? null : "FLY-123",
			issueUuid: noSource ? null : uuid,
			issueUrl: noSource ? null : "https://linear.app/demo/issue/FLY-123",
			receiptUuid: noSource ? null : uuid,
			verifiedAt: noSource ? null : "2026-09-15T00:00:00Z",
			dedupEvidence: noSource
				? null
				: {
						complete: true,
						includeArchived: true,
						fullDescriptions: true,
						beforeCount: mode === "created" ? 0 : 1,
						afterCount: 1,
						markerVerified: true,
						classKey,
						findingId: id,
						scopeVerified: true,
					},
			linear_record: noSource
				? "not_applicable"
				: mode === "no_issue"
					? "comment"
					: "issue",
		};
		const options = {
			source: { path: rules, sha256: hash(readFileSync(rules)) },
			report: {
				path,
				sha256: hash(initial),
				tickId: "1",
				evidenceHandle: "report",
			},
			secrets: [],
			assertCurrent() {},
		};
		const input = {
			tickId: "1",
			executionId: "exec",
			evidenceHandle: "report",
			step: 1,
			judgment: "unhealthy",
			mechanismReview: { result: "findings", count: 1 },
			mechanismDeclarations: [
				{ id, step: 1, classKey, rootCauseRef: ref, counterexampleRef: ref },
			],
			mechanismDispositions: [disposition],
			findings: [
				{
					id,
					category: "mechanism_defect",
					bridgeProblem: false,
					result: "advanced",
					evidence: "receipt-1",
					owner: "n/a",
					next: "n/a",
					epic: "n/a",
					epicMarker: "n/a",
					disposition: mode,
					repairIssue: mode === "no_issue" ? "n/a" : "FLY-123",
					repairReceipt: noSource ? "n/a" : uuid,
					dispositionRef: ref,
				},
			],
		};
		try {
			const invalidDisposition = noSource
				? {
						...disposition,
						reason: "Linear 不可用，暂时没有查重结果不能确定是否立单。",
					}
				: {
						...disposition,
						dedupEvidence: {
							...disposition.dedupEvidence!,
							classKey: "c".repeat(64),
						},
					};
			expect(
				applyPatrolJudgment({
					...options,
					input: { ...input, mechanismDispositions: [invalidDisposition] },
				}).complete,
			).toBe(false);
			writeFileSync(path, initial, { mode: 0o600 });
			const incidentWithDisposition = {
				...input,
				findings: input.findings.map((f) => ({ ...f, category: "incident" })),
			};
			expect(() =>
				applyPatrolJudgment({ ...options, input: incidentWithDisposition }),
			).toThrow();
			expect(readFileSync(path, "utf8")).toBe(initial);
			expect(
				applyPatrolJudgment({
					...options,
					input: { ...input, mechanismReview: undefined },
				}).complete,
			).toBe(false);
			const pending = readFileSync(path, "utf8");
			expect(pending).toContain(
				"MECHANISM_REVIEW result=LEAD-JUDGMENT-REQUIRED",
			);
			const current = {
				...options,
				report: { ...options.report, sha256: hash(pending) },
			};
			expect(applyPatrolJudgment({ ...current, input }).complete).toBe(true);
			const after = readFileSync(path, "utf8");
			expect(after).toContain(`MECHANISM_DEFECT id=${id}`);
			expect(after).toContain(`FINDING id=${id} category=mechanism_defect`);
			expect(() =>
				applyPatrolJudgment({
					...options,
					report: { ...options.report, sha256: hash(after) },
					input: { ...input, mechanismReview: { result: "none", count: 0 } },
				}),
			).toThrow();
			expect(readFileSync(path, "utf8")).toBe(after);
			expect(() =>
				applyPatrolJudgment({
					...options,
					report: { ...options.report, sha256: hash(after) },
					input: {
						...input,
						mechanismDeclarations: [
							{ ...input.mechanismDeclarations[0], classKey: "c".repeat(64) },
						],
					},
				}),
			).toThrow();
			expect(readFileSync(path, "utf8")).toBe(after);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	},
);
