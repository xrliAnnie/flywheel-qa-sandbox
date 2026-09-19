import { z } from "zod";
import {
	canonicalDigest,
	type OpinionCandidate,
	type PointVerdict,
	type ShipJudgmentBinding,
	targetSetDigest,
} from "./contract.js";
import type { FrozenDiff } from "./git-input.js";

export const LEGACY_EVIDENCE_POLICY_VERSION = "ship-judgment-evidence-v1";
export const EVIDENCE_POLICY_VERSION = "ship-judgment-evidence-v2";
export const EVIDENCE_LEDGER_MIGRATION = "fly-2560-evidence-ledger-v1";
const verdict = z.enum(["pass", "fail", "undetermined"]);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(200);
const missingKind = z.enum([
	"design_review",
	"code_review_at_head",
	"pr_diff",
	"plan_at_head",
	"reviewed_plan_blob",
	"qa_claim",
	"qa_report",
	"mechanical_snapshot",
	"merge_probe",
	"input",
]);
const reasonCode = z.enum([
	"evidence_complete",
	"design_changes_requested",
	"design_superseded",
	"code_changes_requested",
	"diff_binary",
	"qa_failed",
	"qa_claim_revoked",
	"qa_claim_inconsistent",
	"qa_claim_stale_attempt",
	"qa_claim_wrong_issuer",
	"overlapping_files",
	"merge_conflict",
	"evidence_missing",
]);
const evidenceRef = z
	.object({
		kind: z.enum([
			"design_review",
			"code_review",
			"diff",
			"qa_claim",
			"qa_report",
			"merge_probe",
			"snapshot",
		]),
		id: z.string().min(1).max(64),
		label: z.string().min(1).max(40),
		observedAt: z.string().datetime(),
	})
	.strict();
const point = z
	.object({
		verdict,
		reason: reasonCode,
		missing: z.array(missingKind).max(8),
		refs: z.array(z.number().int().nonnegative().max(63)).max(4),
	})
	.strict();
const target = z
	.object({
		r: id,
		p: z.number().int().positive().safe(),
		h: sha,
		b: sha.nullable(),
		a: point,
		c: point,
	})
	.strict();

/** Same identity algorithm as frozen packets; a genuinely absent diff base stays null. */
export function evidenceTargetDigest(
	targets: { r: string; p: number; h: string; b: string | null }[],
	manifestRevision: number,
): string {
	const mapped = targets.map((t) => ({
		repo_identity: t.r,
		pr_number: t.p,
		head_sha: t.h,
		diff_base_sha: t.b,
	}));
	if (mapped.every((t) => t.diff_base_sha !== null))
		return targetSetDigest(
			mapped as Parameters<typeof targetSetDigest>[0],
			manifestRevision,
		);
	const keys = mapped.map((t) =>
		JSON.stringify([t.repo_identity, t.pr_number]),
	);
	if (new Set(keys).size !== keys.length) throw new Error("duplicate_target");
	// Match canonicalJson's alphabetic property order used by targetSetDigest.
	const sortKey = (t: (typeof mapped)[number]) =>
		JSON.stringify({
			diff_base_sha: t.diff_base_sha,
			head_sha: t.head_sha,
			pr_number: t.pr_number,
			repo_identity: t.repo_identity,
		});
	mapped.sort((a, b) =>
		sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0,
	);
	return canonicalDigest({
		targets: mapped,
		manifest_revision: manifestRevision,
	});
}

const currentEvidenceLedgerObject = z
	.object({
		version: z.literal(2),
		policyVersion: z.literal(EVIDENCE_POLICY_VERSION),
		evidence: z.array(evidenceRef).max(64),
		targets: z.array(target).min(1).max(50),
		targetsDigest: digest,
		manifestRevision: z.number().int().nonnegative().safe(),
		alignment: point,
		conflict: point,
		coverage: point,
		semantic: z
			.object({
				status: z.enum(["not_run", "undetermined", "evaluated"]),
				evaluationId: id.nullable(),
				modelSnapshotDigest: digest.nullable(),
				alignmentVeto: z.boolean(),
				coverageVeto: z.boolean(),
			})
			.strict()
			.refine((s) =>
				s.status === "not_run"
					? s.evaluationId === null && s.modelSnapshotDigest === null
					: s.evaluationId !== null && s.modelSnapshotDigest !== null,
			)
			.refine(
				(s) =>
					s.status === "evaluated" || (!s.alignmentVeto && !s.coverageVeto),
			),
		input: z
			.object({
				status: z.enum(["ready", "unavailable"]),
				reason: z.string().min(1).max(64),
			})
			.strict(),
		computedAt: z.string().datetime(),
	})
	.strict();

function validateEvidenceLedger(
	v: Omit<
		z.infer<typeof currentEvidenceLedgerObject>,
		"version" | "policyVersion"
	> & { version: number; policyVersion: string },
	ctx: z.RefinementCtx,
): void {
	if (Buffer.byteLength(JSON.stringify(v)) > 49_152)
		ctx.addIssue({ code: "custom", message: "ledger_budget" });
	const points = [
		v.alignment,
		v.conflict,
		v.coverage,
		...v.targets.flatMap((t) => [t.a, t.c]),
	];
	if (points.some((p) => p.refs.some((ref) => ref >= v.evidence.length)))
		ctx.addIssue({ code: "custom", message: "invalid_evidence_reference" });
	try {
		if (evidenceTargetDigest(v.targets, v.manifestRevision) !== v.targetsDigest)
			ctx.addIssue({
				code: "custom",
				message: "evidence_target_digest_mismatch",
			});
	} catch {
		ctx.addIssue({ code: "custom", message: "invalid_evidence_targets" });
	}
}

const currentEvidenceLedgerSchema = currentEvidenceLedgerObject.superRefine(
	validateEvidenceLedger,
);
export const legacyEvidenceLedgerSchema = currentEvidenceLedgerObject
	.extend({
		version: z.literal(1),
		policyVersion: z.literal(LEGACY_EVIDENCE_POLICY_VERSION),
	})
	.superRefine(validateEvidenceLedger);
/** New writes are v2; v1 remains parseable for history and never authorizes auto. */
export const evidenceLedgerSchema = z.union([
	currentEvidenceLedgerSchema,
	legacyEvidenceLedgerSchema,
]);
export type EvidenceLedger = z.infer<typeof evidenceLedgerSchema>;
export type EvidencePoint = z.infer<typeof point>;
export type EvidenceReason = z.infer<typeof reasonCode>;
export interface DesignApproval {
	requestId: string;
	executionId: string;
	path: string;
	round: number;
	respondedAt: string;
	status: "approved" | "changes_requested" | "superseded";
	expectedBlobSha?: string;
}
export interface CodeReviewAtHead {
	requestId: string;
	round: number;
	verdict: string;
	respondedAt: string;
}
export interface QaAuthority {
	verdict: PointVerdict;
	reason: EvidenceReason;
	claimId?: string;
	serverSeq?: number;
	predicate?: string;
	issuedAt?: string;
	revoked?: boolean;
	summary?: string;
}
export interface TargetMaterials {
	repoIdentity: string;
	prNumber: number;
	headSha: string;
	diffBaseSha: string | null;
	designApproval?: DesignApproval;
	planBlob?: { blobSha: string; text: string };
	codeReview?: CodeReviewAtHead;
	qaAuthority?: QaAuthority;
	diff?: FrozenDiff;
	qaReport?: { id: string; observedAt: string };
}
export interface JudgmentMaterials {
	targets: TargetMaterials[];
	mechanical: OpinionCandidate["mechanical"];
	input: EvidenceLedger["input"];
	computedAt: string;
}
export interface SemanticEvidence {
	status: "undetermined" | "evaluated";
	evaluationId: string;
	modelSnapshotDigest: string;
	alignment: PointVerdict;
	coverage: PointVerdict;
}
const unique = <T>(values: T[]) => [...new Set(values)];
const cleanPoint = (): EvidencePoint => ({
	verdict: "pass",
	reason: "evidence_complete",
	missing: [],
	refs: [],
});
function missing(
	p: EvidencePoint,
	kind: z.infer<typeof missingKind>,
	reason: EvidenceReason = "evidence_missing",
) {
	p.missing = unique([...p.missing, kind]);
	if (p.verdict !== "fail") {
		p.verdict = "undetermined";
		p.reason = reason;
	}
}
function fail(p: EvidencePoint, reason: EvidenceReason) {
	p.verdict = "fail";
	p.reason = reason;
}
function aggregate(points: EvidencePoint[]): EvidencePoint {
	const representative =
		points.find((p) => p.verdict === "fail") ??
		points.find((p) => p.verdict === "undetermined") ??
		cleanPoint();
	return {
		verdict: representative.verdict,
		reason: representative.reason,
		missing: unique(points.flatMap((p) => p.missing)),
		refs: unique(points.flatMap((p) => p.refs)).slice(0, 4),
	};
}

/** Pure deterministic authority reduction. Transport/model failures cannot erase independent evidence. */
export function buildEvidenceLedger(
	materials: JudgmentMaterials,
	binding: ShipJudgmentBinding,
	semantic?: SemanticEvidence,
): EvidenceLedger {
	const evidence: EvidenceLedger["evidence"] = [];
	const ref = (
		p: EvidencePoint,
		kind: EvidenceLedger["evidence"][number]["kind"],
		rawId: string,
		label: string,
		observedAt: string,
	) => {
		const value = {
			kind,
			id: rawId.length <= 64 ? rawId : canonicalDigest(rawId),
			label: label.slice(0, 40),
			observedAt,
		};
		let index = evidence.findIndex(
			(r) =>
				r.kind === kind &&
				r.id === value.id &&
				r.label === value.label &&
				r.observedAt === observedAt,
		);
		if (index < 0 && evidence.length < 64) {
			index = evidence.length;
			evidence.push(value);
		}
		if (index >= 0 && p.refs.length < 4 && !p.refs.includes(index))
			p.refs.push(index);
	};
	const targets = binding.targets.map((t) => {
		const matches = materials.targets.filter(
			(m) =>
				m.repoIdentity === t.repo_identity &&
				m.prNumber === t.pr_number &&
				m.headSha.toLowerCase() === t.head_sha.toLowerCase(),
		);
		const m = matches.length === 1 ? matches[0] : undefined;
		const a = cleanPoint(),
			c = cleanPoint(),
			design = m?.designApproval;
		if (!design) missing(a, "design_review");
		else {
			ref(
				a,
				"design_review",
				design.requestId,
				design.status,
				design.respondedAt,
			);
			if (design.status === "changes_requested")
				fail(a, "design_changes_requested");
			else if (design.status !== "approved")
				missing(a, "design_review", "design_superseded");
			else if (!design.expectedBlobSha) missing(a, "reviewed_plan_blob");
		}
		if (
			!m?.planBlob?.text.trim() ||
			(design?.expectedBlobSha &&
				design.expectedBlobSha.toLowerCase() !==
					m.planBlob.blobSha.toLowerCase())
		)
			missing(a, "plan_at_head");
		if (!m?.codeReview) missing(a, "code_review_at_head");
		else {
			ref(
				a,
				"code_review",
				m.codeReview.requestId,
				`${m.codeReview.verdict}@${t.head_sha.slice(0, 8)}`,
				m.codeReview.respondedAt,
			);
			if (m.codeReview.verdict === "CHANGES_REQUESTED")
				fail(a, "code_changes_requested");
			else if (m.codeReview.verdict !== "APPROVED")
				missing(a, "code_review_at_head");
		}
		if (!m?.diffBaseSha || !m.diff) missing(a, "pr_diff");
		else {
			ref(
				a,
				"diff",
				m.diff.digest,
				`${m.diff.files.length} files`,
				materials.computedAt,
			);
			if (!m.diff.complete) missing(a, "pr_diff", "diff_binary");
		}
		const qa = m?.qaAuthority;
		if (!qa) missing(c, "qa_claim");
		else {
			if (qa.claimId && qa.issuedAt)
				ref(c, "qa_claim", qa.claimId, qa.predicate ?? qa.reason, qa.issuedAt);
			if (qa.verdict === "fail") fail(c, qa.reason);
			else if (qa.verdict !== "pass") missing(c, "qa_claim", qa.reason);
		}
		if (m?.qaReport)
			ref(c, "qa_report", m.qaReport.id, "QA report", m.qaReport.observedAt);
		else missing(c, "qa_report");
		if (materials.input.status === "unavailable") {
			missing(a, "input");
			missing(c, "input");
		}
		return {
			r: t.repo_identity,
			p: t.pr_number,
			h: t.head_sha.toLowerCase(),
			b: m?.diffBaseSha?.toLowerCase() ?? null,
			a,
			c,
		};
	});
	const conflict = cleanPoint(),
		mechanical = materials.mechanical;
	if (mechanical.verdict === "pass")
		ref(
			conflict,
			"merge_probe",
			mechanical.digest,
			"mechanical_checks_clear",
			mechanical.checkedAt,
		);
	else if (mechanical.verdict === "fail") {
		fail(
			conflict,
			mechanical.overlaps.length ? "overlapping_files" : "merge_conflict",
		);
		ref(
			conflict,
			"merge_probe",
			mechanical.digest,
			conflict.reason,
			mechanical.checkedAt,
		);
	} else
		missing(
			conflict,
			mechanical.reason.includes("merge_probe")
				? "merge_probe"
				: "mechanical_snapshot",
		);
	const ledger: EvidenceLedger = {
		version: 2,
		policyVersion: EVIDENCE_POLICY_VERSION,
		evidence,
		targets,
		targetsDigest: evidenceTargetDigest(targets, binding.manifestRevision),
		manifestRevision: binding.manifestRevision,
		alignment: aggregate(targets.map((t) => t.a)),
		conflict,
		coverage: aggregate(targets.map((t) => t.c)),
		semantic: {
			status: "not_run",
			evaluationId: null,
			modelSnapshotDigest: null,
			alignmentVeto: false,
			coverageVeto: false,
		},
		input: materials.input,
		computedAt: materials.computedAt,
	};
	return applySemanticEvidence(ledger, semantic);
}

export function applySemanticEvidence(
	source: EvidenceLedger,
	semantic?: SemanticEvidence,
): EvidenceLedger {
	const ledger = structuredClone(source);
	// Reconstruct deterministic points so recombination never retains a stale veto.
	ledger.alignment = aggregate(ledger.targets.map((t) => t.a));
	ledger.coverage = aggregate(ledger.targets.map((t) => t.c));
	ledger.semantic = semantic
		? {
				status: semantic.status,
				evaluationId: semantic.evaluationId,
				modelSnapshotDigest: semantic.modelSnapshotDigest,
				alignmentVeto:
					semantic.status === "evaluated" && semantic.alignment === "fail",
				coverageVeto:
					semantic.status === "evaluated" && semantic.coverage === "fail",
			}
		: {
				status: "not_run",
				evaluationId: null,
				modelSnapshotDigest: null,
				alignmentVeto: false,
				coverageVeto: false,
			};
	if (ledger.semantic.alignmentVeto) ledger.alignment.verdict = "fail";
	if (ledger.semantic.coverageVeto) ledger.coverage.verdict = "fail";
	if (!semantic || semantic.status !== "evaluated") {
		missing(ledger.alignment, "input");
		missing(ledger.coverage, "input");
	}
	return evidenceLedgerSchema.parse(ledger);
}

export function evidenceLedgerDigest(ledger: EvidenceLedger): string {
	const {
		computedAt: _computedAt,
		evidence,
		...rest
	} = evidenceLedgerSchema.parse(ledger);
	return canonicalDigest({
		...rest,
		evidence: evidence.map(({ observedAt: _observedAt, ...ref }) => ref),
	});
}
