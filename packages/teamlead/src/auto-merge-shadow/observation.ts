import { createHash } from "node:crypto";
import type {
	RunShipRelevance,
	RunShipRelevancePrView,
} from "../bridge/run-ship-relevance.js";
import type { ShipRelevantPrSnapshot } from "../StateStore.js";
import type { StrengthTwoVerdict } from "../strength-two/judge.js";

export const SHADOW_BASIS_MAX_BYTES = 16_384;
export const SHADOW_STRING_MAX_BYTES = 64;
export const SHADOW_NESTED_REVIEW_MAX = 16;
export const SHADOW_IDENTITY_KEY_MAX_BYTES = 200;

const SHA40_LOWER = /^[0-9a-f]{40}$/;
const REPO_IDENTITY = /^[a-z0-9._-]+\/[a-z0-9._-]+$/;
const PRINTABLE_UNQUOTED_ASCII = /^[\x20-\x21\x23-\x5b\x5d-\x7e]*$/;

type SnapshotBasis = Pick<
	ShipRelevantPrSnapshot,
	| "pr_head_sha"
	| "computed_at"
	| "classifier_version"
	| "ship_relevant"
	| "file_count"
>;

export interface ShadowObservationFacts {
	verdictId: string;
	runId: string;
	questionId: string;
	gateExecutionId: string;
	repoIdentity: string;
	prNumber: number;
	headSha: string;
	observedAt: string;
	relevance: RunShipRelevance;
	declaredProjectedCount: number;
	snapshotsByCandidate: ReadonlyArray<{
		role: "primary" | "declared";
		repoSlug: string;
		prNumber: number;
		snapshot?: SnapshotBasis;
	}>;
	nestedReviews: ReadonlyArray<{ repoIdentity: string; headSha: string }>;
	strengthTwo: StrengthTwoVerdict;
	strengthTwoRowCount: number;
	strengthTwoOtherHeadRowCount: number;
}

export interface AutoMergeShadowObservationRow {
	verdict_id: string;
	run_id: string;
	question_id: string;
	gate_execution_id: string;
	repo_identity: string;
	pr_number: number;
	head_sha: string;
	observed_at: string;
	machine_class: RunShipRelevance["verdict"];
	machine_reason:
		| Exclude<RunShipRelevance, { verdict: "docs_only" }>["reason"]
		| null;
	machine_file_count: number | null;
	machine_candidate_count: number;
	machine_declared_projected_count: number;
	machine_primary_snapshot_age_ms: number | null;
	machine_declared_max_snapshot_age_ms: number | null;
	machine_basis_json: string;
	s2_ran_status: "satisfied" | "unsatisfied";
	s2_ran_reason: StrengthTwoVerdict["ran"]["reason"];
	s2_record_status: "satisfied" | "unsatisfied";
	s2_record_reason: StrengthTwoVerdict["record"]["reason"];
	s2_verdict: "satisfied" | "unsatisfied";
	s2_basis_record_id: string | null;
	s2_row_count: number;
	s2_other_head_row_count: number;
	shadow_version: 1;
}

function encodedDisplay(value: string): string {
	const bytes = Buffer.from(value, "utf8");
	if (
		bytes.length <= SHADOW_STRING_MAX_BYTES &&
		PRINTABLE_UNQUOTED_ASCII.test(value)
	) {
		return value;
	}
	return `${bytes.subarray(0, 48).toString("hex")}#${createHash("sha256")
		.update(bytes)
		.digest("hex")
		.slice(0, 16)}`;
}

function repoIdentityKey(value: string): string | null {
	const lowered = value.toLowerCase();
	return (lowered === "__main__" || REPO_IDENTITY.test(lowered)) &&
		Buffer.byteLength(lowered, "utf8") <= SHADOW_IDENTITY_KEY_MAX_BYTES
		? lowered
		: null;
}

function strictHead(value: string): string | null {
	return SHA40_LOWER.test(value) ? value : null;
}

function canonicalTimestamp(value: string): string | null {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function safeInteger(value: number): number | null {
	return Number.isSafeInteger(value) ? value : null;
}

function snapshotFor(
	facts: ShadowObservationFacts,
	candidate: RunShipRelevancePrView,
): SnapshotBasis | undefined {
	return facts.snapshotsByCandidate.find(
		(item) =>
			item.role === candidate.role &&
			item.repoSlug === candidate.repoSlug &&
			item.prNumber === candidate.prNumber,
	)?.snapshot;
}

function encodeCandidate(
	facts: ShadowObservationFacts,
	candidate: RunShipRelevancePrView,
): Record<string, unknown> {
	const snapshot = snapshotFor(facts, candidate);
	const identityKey = repoIdentityKey(candidate.repoIdentity);
	const expectedHead = strictHead(candidate.headSha);
	const snapshotHead = snapshot ? strictHead(snapshot.pr_head_sha) : null;
	const snapshotComputedAt = snapshot
		? canonicalTimestamp(snapshot.computed_at)
		: null;
	return {
		role: candidate.role,
		repoIdentityKey: identityKey,
		repoIdentity: encodedDisplay(candidate.repoIdentity),
		...(identityKey === null ? { repoIdentityKeyOmitted: true } : {}),
		repoSlug: encodedDisplay(candidate.repoSlug),
		prNumber: safeInteger(candidate.prNumber),
		expectedHead,
		...(expectedHead === null ? { expectedHeadInvalid: true } : {}),
		snapshotHead,
		...(snapshot && snapshotHead === null ? { snapshotHeadInvalid: true } : {}),
		snapshotComputedAt,
		...(snapshot && snapshotComputedAt === null
			? { snapshotComputedAtInvalid: true }
			: {}),
		classifierVersion: snapshot
			? safeInteger(snapshot.classifier_version)
			: null,
		shipRelevant:
			snapshot?.ship_relevant === 0 || snapshot?.ship_relevant === 1
				? snapshot.ship_relevant
				: null,
		fileCount: snapshot ? safeInteger(snapshot.file_count) : null,
		missingReason: candidate.missingReason ?? null,
	};
}

function encodeNestedReview(review: {
	repoIdentity: string;
	headSha: string;
}): Record<string, unknown> {
	const identityKey = repoIdentityKey(review.repoIdentity);
	const headSha = strictHead(review.headSha);
	return {
		repoIdentityKey: identityKey,
		repoIdentity: encodedDisplay(review.repoIdentity),
		...(identityKey === null ? { repoIdentityKeyOmitted: true } : {}),
		headSha,
		...(headSha === null ? { headShaInvalid: true } : {}),
	};
}

function basisJson(facts: ShadowObservationFacts): string {
	const entries = facts.nestedReviews
		.map(encodeNestedReview)
		.sort((left, right) =>
			`${left.repoIdentityKey ?? left.repoIdentity}\u0000${left.headSha ?? ""}`.localeCompare(
				`${right.repoIdentityKey ?? right.repoIdentity}\u0000${right.headSha ?? ""}`,
			),
		)
		.slice(0, SHADOW_NESTED_REVIEW_MAX);
	const nestedReviews = {
		originalCount: facts.nestedReviews.length,
		encodedCount: entries.length,
		truncated: facts.nestedReviews.length > entries.length,
		entries,
	};
	const basis = {
		schemaVersion: 1,
		prs: facts.relevance.prs.map((candidate) =>
			encodeCandidate(facts, candidate),
		),
		nestedReviews,
	};
	let encoded = JSON.stringify(basis);
	if (Buffer.byteLength(encoded, "utf8") <= SHADOW_BASIS_MAX_BYTES) {
		return encoded;
	}
	encoded = JSON.stringify({
		...basis,
		nestedReviews: {
			originalCount: facts.nestedReviews.length,
			encodedCount: 0,
			truncated: facts.nestedReviews.length > 0,
			dropped: true,
			entries: [],
		},
	});
	if (Buffer.byteLength(encoded, "utf8") > SHADOW_BASIS_MAX_BYTES) {
		throw new Error("auto_merge_shadow_basis_too_large");
	}
	return encoded;
}

function ageMs(observedAt: string, computedAt: string): number | null {
	const observed = Date.parse(observedAt);
	const computed = Date.parse(computedAt);
	return Number.isFinite(observed) && Number.isFinite(computed)
		? observed - computed
		: null;
}

export function buildShadowObservation(
	facts: ShadowObservationFacts,
): AutoMergeShadowObservationRow {
	const primaryAges = facts.snapshotsByCandidate
		.filter((item) => item.role === "primary" && item.snapshot)
		.map((item) => ageMs(facts.observedAt, item.snapshot!.computed_at))
		.filter((value): value is number => value !== null);
	const declaredAges = facts.snapshotsByCandidate
		.filter((item) => item.role === "declared" && item.snapshot)
		.map((item) => ageMs(facts.observedAt, item.snapshot!.computed_at))
		.filter((value): value is number => value !== null);
	return {
		verdict_id: facts.verdictId,
		run_id: facts.runId,
		question_id: facts.questionId,
		gate_execution_id: facts.gateExecutionId,
		repo_identity: facts.repoIdentity,
		pr_number: facts.prNumber,
		head_sha: facts.headSha,
		observed_at: facts.observedAt,
		machine_class: facts.relevance.verdict,
		machine_reason:
			facts.relevance.verdict === "docs_only" ? null : facts.relevance.reason,
		machine_file_count:
			facts.relevance.verdict === "docs_only"
				? facts.relevance.fileCount
				: null,
		machine_candidate_count: facts.relevance.prs.length,
		machine_declared_projected_count: facts.declaredProjectedCount,
		machine_primary_snapshot_age_ms: primaryAges[0] ?? null,
		machine_declared_max_snapshot_age_ms:
			declaredAges.length > 0 ? Math.max(...declaredAges) : null,
		machine_basis_json: basisJson(facts),
		s2_ran_status: facts.strengthTwo.ran.satisfied
			? "satisfied"
			: "unsatisfied",
		s2_ran_reason: facts.strengthTwo.ran.reason,
		s2_record_status: facts.strengthTwo.record.satisfied
			? "satisfied"
			: "unsatisfied",
		s2_record_reason: facts.strengthTwo.record.reason,
		s2_verdict: facts.strengthTwo.verdict,
		s2_basis_record_id: facts.strengthTwo.basisRecordId,
		s2_row_count: facts.strengthTwoRowCount,
		s2_other_head_row_count: facts.strengthTwoOtherHeadRowCount,
		shadow_version: 1,
	};
}
