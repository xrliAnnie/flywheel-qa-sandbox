import { expect, it } from "vitest";
import {
	canonicalDigest,
	type ShipJudgmentBinding,
	targetSetDigest,
} from "../contract.js";
import {
	buildEvidenceLedger,
	evidenceLedgerDigest,
	evidenceLedgerSchema,
	type JudgmentMaterials,
	type TargetMaterials,
} from "../evidence-ledger.js";

const AT = "2026-09-14T20:00:00.000Z";
const head = "a".repeat(40),
	base = "b".repeat(40);
const binding: ShipJudgmentBinding = {
	projectName: "flywheel",
	runId: "r",
	questionId: "q",
	issueId: "FLY-2553",
	cardMessageId: "123456789012345678",
	threadId: "123456789012345679",
	manifestRevision: 0,
	targets: [
		{
			repo_identity: "__main__",
			repo_slug: "owner/repo",
			pr_number: 1194,
			head_sha: head,
		},
	],
};
function targetMaterials(): TargetMaterials {
	return {
		repoIdentity: "__main__",
		prNumber: 1194,
		headSha: head,
		diffBaseSha: base,
		designApproval: {
			requestId: "design-r1",
			executionId: "design-exec",
			path: "engineering/doc/plan.md",
			round: 1,
			status: "approved",
			respondedAt: AT,
		},
		planBlob: { blobSha: "c".repeat(40), text: "approved plan" },
		codeReview: {
			requestId: "code-r5",
			round: 5,
			verdict: "APPROVED",
			respondedAt: AT,
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
			issuedAt: AT,
			revoked: false,
			summary: "QA passed",
		},
	};
}
function materials(): JudgmentMaterials {
	return {
		targets: [targetMaterials()],
		computedAt: AT,
		input: { status: "ready", reason: "evidence_complete" },
		mechanical: {
			verdict: "pass",
			reason: "mechanical_checks_clear",
			digest: "e".repeat(64),
			checkedAt: AT,
			scope: "main + targets + files",
			checkedRepos: 1,
			openPrCount: 4,
			overlaps: [],
		},
	};
}

it("binds three independent verdicts and evidence IDs without requiring a model", () => {
	const ledger = buildEvidenceLedger(materials(), binding);
	expect([
		ledger.alignment.verdict,
		ledger.conflict.verdict,
		ledger.coverage.verdict,
	]).toEqual(["pass", "pass", "pass"]);
	expect(ledger.evidence.map((ref) => ref.id)).toEqual(
		expect.arrayContaining(["design-r1", "code-r5", "1148"]),
	);
	expect(
		ledger.evidence.find((ref) => ref.kind === "design_review")?.label,
	).toBe("blob_unverified");
	expect(ledger.semantic.status).toBe("not_run");
	expect(ledger.targetsDigest).toBe(
		targetSetDigest(
			[
				{
					repo_identity: "__main__",
					pr_number: 1194,
					head_sha: head,
					diff_base_sha: base,
				},
			],
			0,
		),
	);
});

it.each([
	["qaAuthority", "coverage", "qa_claim"],
	["designApproval", "alignment", "design_review"],
	["planBlob", "alignment", "plan_at_head"],
	["codeReview", "alignment", "code_review_at_head"],
	["diff", "alignment", "pr_diff"],
] as const)("missing %s affects only %s", (key, point, missing) => {
	const input = materials();
	delete input.targets[0]![key];
	const ledger = buildEvidenceLedger(input, binding);
	expect(ledger[point].verdict).toBe("undetermined");
	expect(ledger[point].missing).toEqual([missing]);
	expect(ledger.conflict.verdict).toBe("pass");
	expect(ledger[point === "alignment" ? "coverage" : "alignment"].verdict).toBe(
		"pass",
	);
});

it("requires an existing plan at head even when no manifest blob is available", () => {
	const input = materials();
	input.targets[0]!.planBlob!.text = "";
	expect(buildEvidenceLedger(input, binding).alignment.missing).toEqual([
		"plan_at_head",
	]);
	input.targets[0]!.planBlob!.text = "plan";
	input.targets[0]!.designApproval!.expectedBlobSha = "f".repeat(40);
	expect(buildEvidenceLedger(input, binding).alignment.missing).toEqual([
		"plan_at_head",
	]);
});

it("reports missing diff base and incomplete binary diffs explicitly", () => {
	const input = materials();
	input.targets[0]!.diffBaseSha = null;
	expect(buildEvidenceLedger(input, binding).alignment.missing).toEqual([
		"pr_diff",
	]);
	input.targets[0]!.diffBaseSha = base;
	input.targets[0]!.diff!.complete = false;
	expect(buildEvidenceLedger(input, binding).alignment).toMatchObject({
		verdict: "undetermined",
		reason: "diff_binary",
		missing: ["pr_diff"],
	});
});

it.each(["changes_requested", "superseded"] as const)(
	"preserves design %s",
	(status) => {
		const input = materials();
		input.targets[0]!.designApproval!.status = status;
		expect(buildEvidenceLedger(input, binding).alignment).toMatchObject({
			verdict: status === "changes_requested" ? "fail" : "undetermined",
			reason:
				status === "changes_requested"
					? "design_changes_requested"
					: "design_superseded",
		});
	},
);

it.each([
	"qa_failed",
	"qa_claim_revoked",
	"qa_claim_inconsistent",
	"qa_claim_stale_attempt",
	"qa_claim_wrong_issuer",
] as const)("preserves QA %s with its claim metadata", (reason) => {
	const input = materials();
	Object.assign(input.targets[0]!.qaAuthority!, { reason, verdict: "fail" });
	const ledger = buildEvidenceLedger(input, binding);
	expect(ledger.coverage).toMatchObject({ verdict: "fail", reason });
	expect(ledger.evidence[ledger.coverage.refs[0]!]?.id).toBe("1148");
});

it("aggregates targets with fail taking precedence over missing without borrowing another target's evidence", () => {
	const input = materials();
	const other = {
		...targetMaterials(),
		repoIdentity: "nested",
		prNumber: 1194,
	};
	delete other.qaAuthority;
	input.targets.push(other);
	const multi = {
		...binding,
		targets: [
			...binding.targets,
			{ ...binding.targets[0]!, repo_identity: "nested" },
		],
	};
	expect(buildEvidenceLedger(input, multi)).toMatchObject({
		alignment: { verdict: "pass" },
		conflict: { verdict: "pass" },
		coverage: { verdict: "undetermined" },
	});
	other.codeReview = { ...other.codeReview!, verdict: "CHANGES_REQUESTED" };
	delete input.targets[0]!.designApproval;
	expect(buildEvidenceLedger(input, multi).alignment.verdict).toBe("fail");
	input.targets.pop();
	expect(buildEvidenceLedger(input, multi).targets[1]!.c.missing).toContain(
		"qa_claim",
	);
});

it("ignores material for a different exact head", () => {
	const input = materials();
	input.targets[0]!.headSha = "f".repeat(40);
	const ledger = buildEvidenceLedger(input, binding);
	expect(ledger.alignment.verdict).toBe("undetermined");
	expect(ledger.coverage.verdict).toBe("undetermined");
});

it("semantic evaluation can only veto and never turn missing evidence into a pass", () => {
	const semantic = {
		status: "evaluated" as const,
		evaluationId: "eval",
		modelSnapshotDigest: "f".repeat(64),
		alignment: "fail" as const,
		coverage: "pass" as const,
	};
	expect(buildEvidenceLedger(materials(), binding, semantic)).toMatchObject({
		alignment: { verdict: "fail" },
		semantic: { alignmentVeto: true, coverageVeto: false },
	});
	expect(
		buildEvidenceLedger(materials(), binding, {
			...semantic,
			status: "undetermined",
		}),
	).toMatchObject({
		alignment: { verdict: "pass" },
		semantic: { status: "undetermined", alignmentVeto: false },
	});
	const input = materials();
	delete input.targets[0]!.qaAuthority;
	expect(buildEvidenceLedger(input, binding, semantic).coverage.verdict).toBe(
		"undetermined",
	);
});

it("presentation identity ignores observation clocks but includes evidence changes", () => {
	const ledger = buildEvidenceLedger(materials(), binding);
	const changed = structuredClone(ledger);
	changed.computedAt = "2026-09-14T21:00:00.000Z";
	changed.evidence.forEach((ref) => {
		ref.observedAt = changed.computedAt;
	});
	expect(evidenceLedgerDigest(changed)).toBe(evidenceLedgerDigest(ledger));
	changed.evidence[0]!.id = "another";
	expect(evidenceLedgerDigest(changed)).not.toBe(evidenceLedgerDigest(ledger));
});

it("validates reference bounds and target identity at the persisted boundary", () => {
	const ledger = buildEvidenceLedger(materials(), binding);
	expect(
		evidenceLedgerSchema.safeParse({ ...ledger, targets: [] }).success,
	).toBe(false);
	const invalid = structuredClone(ledger);
	invalid.alignment.refs = [63];
	expect(evidenceLedgerSchema.safeParse(invalid).success).toBe(false);
	expect(
		evidenceLedgerSchema.safeParse({
			...ledger,
			targetsDigest: canonicalDigest("wrong"),
		}).success,
	).toBe(false);
});
