import { createHash } from "node:crypto";
import type { ClaudeReviewFinding } from "./claude-review-runner.js";

export type ReviewVerdict = "APPROVED" | "CHANGES_REQUESTED";
export type ReviewType = "design" | "code";

export interface ReviewFindingRulingSnapshot {
	rulingId: string;
	findingKey: string;
	reviewType: ReviewType;
	disposition: "overruled" | "follow_up";
	rationale: string;
	followUpIssue?: string;
	findingTitle?: string;
	createdAt: string;
	revokedAt?: string;
}

export interface DecoratedReviewFinding extends ClaudeReviewFinding {
	findingKey: string;
}

export interface SettledReviewFinding {
	finding: DecoratedReviewFinding;
	ruling: ReviewFindingRulingSnapshot;
}

export interface ReviewRulingDispute extends SettledReviewFinding {
	kind: "explicit" | "automatic";
}

export interface EffectiveReviewVerdict {
	reviewerVerdict: ReviewVerdict;
	effectiveVerdict: ReviewVerdict;
	findings: Array<ClaudeReviewFinding | DecoratedReviewFinding>;
	advisories: DecoratedReviewFinding[];
	settled: SettledReviewFinding[];
	disputes: ReviewRulingDispute[];
}

export interface ComputeEffectiveVerdictInput {
	reviewerVerdict: ReviewVerdict;
	findings: ClaudeReviewFinding[];
	reviewType: ReviewType;
	rulings: readonly ReviewFindingRulingSnapshot[];
	enabled: boolean;
}

/** MEDIUM/LOW are advisory; missing and unknown severities fail closed. */
export function isNonBlockingSeverity(severity: unknown): boolean {
	if (typeof severity !== "string") return false;
	const normalized = severity.trim().toUpperCase();
	return normalized === "MEDIUM" || normalized === "LOW";
}

/** Stable fallback when a reviewer does not emit a reusable finding id. */
export function findingFingerprint(
	file: unknown,
	title: unknown,
): `f:${string}` {
	const material = `${typeof file === "string" ? file : ""}\n${typeof title === "string" ? title : ""}`;
	return `f:${createHash("sha256").update(material).digest("hex").slice(0, 16)}`;
}

export function findingKey(finding: ClaudeReviewFinding): string {
	const candidate = typeof finding.id === "string" ? finding.id.trim() : "";
	const stableId =
		candidate.length > 0 &&
		candidate.length <= 128 &&
		// biome-ignore lint/suspicious/noControlCharactersInRegex: reviewer-owned ids must not cross privileged prompt and audit boundaries with controls
		!/[\u0000-\u001f\u007f]/u.test(candidate)
			? candidate
			: undefined;
	return stableId ?? findingFingerprint(finding.file, finding.title);
}

/**
 * Apply the cross-family ship-blocking policy without changing reviewer data.
 * A reviewer APPROVED verdict is never tightened. A CHANGES verdict is relaxed
 * only when it supplied findings and every blocking candidate is either
 * MEDIUM/LOW or covered by an active Lead ruling.
 */
export function computeEffectiveVerdict(
	input: ComputeEffectiveVerdictInput,
): EffectiveReviewVerdict {
	if (!input.enabled) {
		return {
			reviewerVerdict: input.reviewerVerdict,
			effectiveVerdict: input.reviewerVerdict,
			findings: input.findings,
			advisories: [],
			settled: [],
			disputes: [],
		};
	}

	const findings = input.findings.map((finding) => ({
		...finding,
		findingKey: findingKey(finding),
	}));
	const advisories: DecoratedReviewFinding[] = [];
	const settled: SettledReviewFinding[] = [];
	const disputes: ReviewRulingDispute[] = [];
	const blocking: DecoratedReviewFinding[] = [];

	for (const finding of findings) {
		const ruling = matchActiveRuling(finding, input.reviewType, input.rulings);
		if (ruling) {
			const entry = { finding, ruling };
			settled.push(entry);
			const explicit =
				typeof finding.disputesRuling === "string" &&
				finding.disputesRuling === ruling.findingKey;
			if (explicit || normalizedSeverity(finding.severity) === "HIGH") {
				disputes.push({
					...entry,
					kind: explicit ? "explicit" : "automatic",
				});
			}
			continue;
		}
		if (isNonBlockingSeverity(finding.severity)) advisories.push(finding);
		else blocking.push(finding);
	}

	const effectiveVerdict =
		input.reviewerVerdict === "APPROVED"
			? "APPROVED"
			: findings.length > 0 && blocking.length === 0
				? "APPROVED"
				: "CHANGES_REQUESTED";

	return {
		reviewerVerdict: input.reviewerVerdict,
		effectiveVerdict,
		findings,
		advisories,
		settled,
		disputes,
	};
}

function matchActiveRuling(
	finding: DecoratedReviewFinding,
	reviewType: ReviewType,
	rulings: readonly ReviewFindingRulingSnapshot[],
): ReviewFindingRulingSnapshot | undefined {
	const id = typeof finding.id === "string" ? finding.id.trim() : "";
	const disputesRuling =
		typeof finding.disputesRuling === "string"
			? finding.disputesRuling.trim()
			: "";
	const fingerprint = findingFingerprint(finding.file, finding.title);
	return rulings.find(
		(ruling) =>
			!ruling.revokedAt &&
			ruling.reviewType === reviewType &&
			(ruling.findingKey === id ||
				ruling.findingKey === disputesRuling ||
				ruling.findingKey === fingerprint),
	);
}

function normalizedSeverity(severity: unknown): string {
	return typeof severity === "string" ? severity.trim().toUpperCase() : "";
}
