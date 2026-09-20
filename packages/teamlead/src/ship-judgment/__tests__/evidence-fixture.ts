import type { ShipJudgmentBinding } from "../contract.js";
import {
	buildEvidenceLedger,
	type JudgmentMaterials,
} from "../evidence-ledger.js";

export function evidenceMaterials(
	binding: ShipJudgmentBinding,
	at: string,
): JudgmentMaterials {
	return {
		computedAt: at,
		input: { status: "ready", reason: "evidence_complete" },
		mechanical: {
			verdict: "pass",
			reason: "mechanical_checks_clear",
			digest: "e".repeat(64),
			checkedAt: at,
			scope: "main + targets + files",
			checkedRepos: binding.targets.length,
			openPrCount: 4,
			overlaps: [],
		},
		targets: binding.targets.map((target) => ({
			repoIdentity: target.repo_identity,
			prNumber: target.pr_number,
			headSha: target.head_sha,
			diffBaseSha: "b".repeat(40),
			designApproval: {
				requestId: "design-r1",
				executionId: "design-exec",
				path: "engineering/doc/plan.md",
				round: 1,
				status: "approved",
				respondedAt: at,
				expectedBlobSha: "c".repeat(40),
			},
			planBlob: { blobSha: "c".repeat(40), text: "approved plan" },
			codeReview: {
				requestId: "code-r5",
				round: 5,
				verdict: "APPROVED",
				respondedAt: at,
			},
			diff: {
				text: "+ fix",
				files: [{ path: "src/fix.ts", status: "M" }],
				complete: true,
				digest: "d".repeat(64),
			},
			qaAuthority: {
				verdict: "pass",
				reason: "evidence_complete",
				claimId: "1148",
				serverSeq: 1148,
				predicate: "qa_passed",
				issuedAt: at,
				revoked: false,
				summary: "QA passed",
			},
			qaReport: { id: "report-1148", observedAt: at },
		})),
	};
}
export function evidenceFixture(binding: ShipJudgmentBinding, at: string) {
	return buildEvidenceLedger(evidenceMaterials(binding, at), binding, {
		status: "evaluated",
		evaluationId: "evaluation",
		modelSnapshotDigest: "f".repeat(64),
		alignment: "pass",
		coverage: "pass",
	});
}
