import { expect, it } from "vitest";
import type { ShipJudgmentBinding } from "../contract.js";
import { canonicalDigest } from "../contract.js";
import {
	buildEvidenceLedger,
	evidenceLedgerSchema,
} from "../evidence-ledger.js";
import { evidenceMaterials } from "./evidence-fixture.js";

const AT = "2026-09-14T20:00:00.000Z";
function boundary(unicode = false) {
	const binding: ShipJudgmentBinding = {
		projectName: "flywheel",
		runId: "r",
		questionId: "q",
		issueId: "FLY-2560",
		cardMessageId: "123456789012345678",
		threadId: "123456789012345679",
		manifestRevision: Number.MAX_SAFE_INTEGER,
		targets: Array.from({ length: 50 }, (_, i) => ({
			repo_identity:
				String(i).padStart(3, "0") + (unicode ? "仓" : "r").repeat(197),
			repo_slug: "owner/repo",
			pr_number: Number.MAX_SAFE_INTEGER - i,
			head_sha: "a".repeat(40),
		})),
	};
	const materials = evidenceMaterials(binding, AT);
	materials.input = { status: "unavailable", reason: "x".repeat(64) };
	for (const [i, m] of materials.targets.entries()) {
		m.designApproval!.requestId = canonicalDigest(["design", i]);
		m.designApproval!.status = "superseded";
		delete m.planBlob;
		m.codeReview!.requestId = canonicalDigest(["code", i]);
		m.codeReview!.verdict = "unknown";
		m.diff!.digest = canonicalDigest(["diff", i]);
		m.diff!.complete = false;
		m.qaAuthority!.claimId = canonicalDigest(["qa", i]);
		m.qaAuthority!.verdict = "undetermined";
		m.qaAuthority!.reason = "qa_claim_inconsistent";
		m.qaReport = { id: canonicalDigest(["report", i]), observedAt: AT };
	}
	return { binding, materials };
}
it("fits a 50-target actual reducer output with full ASCII identities, missing fields and a saturated reference pool", () => {
	const { binding, materials } = boundary();
	const ledger = buildEvidenceLedger(materials, binding, {
		status: "undetermined",
		evaluationId: "e".repeat(200),
		modelSnapshotDigest: "d".repeat(64),
		alignment: "undetermined",
		coverage: "undetermined",
	});
	expect(ledger.targets).toHaveLength(50);
	expect(ledger.evidence).toHaveLength(64);
	expect(Buffer.byteLength(JSON.stringify(ledger))).toBeLessThanOrEqual(49152);
	expect(evidenceLedgerSchema.safeParse(ledger).success).toBe(true);
	for (const [i, t] of ledger.targets.entries())
		expect(t.r).toBe(binding.targets[i]!.repo_identity);
	console.info(
		"FLY-2560 admitted reducer boundary bytes=" +
			Buffer.byteLength(JSON.stringify(ledger)),
	);
});
it("rejects oversized Unicode identities explicitly without truncating or mutating them", () => {
	const { binding, materials } = boundary(true),
		original = JSON.stringify({ binding, materials });
	expect(() => buildEvidenceLedger(materials, binding)).toThrow(
		/ledger_budget/,
	);
	expect(JSON.stringify({ binding, materials })).toBe(original);
});
