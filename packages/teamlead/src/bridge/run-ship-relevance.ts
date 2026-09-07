import type {
	ShipRelevantDeclaredPrRow,
	ShipRelevantDiffSnapshot,
	ShipRelevantPrSnapshot,
	WorkflowNodePrBindingRow,
} from "../StateStore.js";
import {
	MAX_DOCS_ONLY_FILES,
	SHIP_RELEVANT_CLASSIFIER_VERSION,
	SHIP_RELEVANT_SNAPSHOT_MAX_AGE_MS,
} from "./ship-relevant-diff.js";

export const MAX_DECLARED_PRS_PER_RUN = 8;

export interface PrClassification {
	repoSlug: string;
	prNumber: number;
	headSha: string;
	shipRelevant: 0 | 1;
	fileCount: number;
	commitShas: ReadonlySet<string>;
}

export type RunShipRelevanceUnknownReason =
	| "primary_snapshot_missing"
	| "primary_snapshot_stale"
	| "primary_snapshot_version_mismatch"
	| "declared_snapshot_missing"
	| "declared_snapshot_stale"
	| "declared_snapshot_version_mismatch"
	| "nested_review_uncovered"
	| "declaration_overflow"
	| "scope_unresolved";

export interface RunShipRelevanceCandidate {
	repoIdentity: string;
	repoSlug: string;
	prNumber: number;
	headSha: string;
	classification?: PrClassification;
	missingReason?: RunShipRelevanceUnknownReason;
}

export interface RunShipRelevanceFacts {
	primary: RunShipRelevanceCandidate;
	declared: RunShipRelevanceCandidate[];
	nestedReviews: Array<{ repoIdentity: string; headSha: string }>;
}

export interface RunShipRelevanceStore {
	resolveWorkflowRunForExecution(
		executionId: string,
	):
		| { kind: "none" }
		| { kind: "one"; runId: string }
		| { kind: "many"; runIds: string[] };
	resolveWorkflowNodePrBindingForSession(
		executionId: string,
		headSha: string,
	):
		| { kind: "none" }
		| { kind: "one"; binding: WorkflowNodePrBindingRow }
		| { kind: "many"; bindings: WorkflowNodePrBindingRow[] };
	projectCurrentShipRelevantCandidates(
		runId: string,
	): ShipRelevantDeclaredPrRow[];
	listNestedCodexReviewHeadsForRun(
		runId: string,
	): Array<{ repoIdentity: string; headSha: string }>;
	listNestedCodexReviewHeadsForExecution(
		executionId: string,
	): Array<{ repoIdentity: string; headSha: string }>;
	getShipRelevantPrSnapshot(
		executionId: string,
		repoSlug: string,
		prNumber: number,
	): ShipRelevantPrSnapshot | undefined;
	resolvePrimaryShipRelevantPrSnapshot(
		executionId: string,
		prNumber: number,
	):
		| { kind: "none" }
		| { kind: "one"; snapshot: ShipRelevantPrSnapshot }
		| { kind: "many"; snapshots: ShipRelevantPrSnapshot[] };
}

export interface RunShipRelevanceSession {
	execution_id: string;
	pr_number?: number;
	pr_head_sha?: string;
}

export interface RunShipRelevancePrView {
	role: "primary" | "declared";
	repoIdentity: string;
	repoSlug: string;
	prNumber: number;
	headSha: string;
	shipRelevant?: 0 | 1;
	fileCount?: number;
	missingReason?: RunShipRelevanceUnknownReason;
}

export type RunShipRelevance =
	| {
			verdict: "docs_only";
			fileCount: number;
			prs: RunShipRelevancePrView[];
	  }
	| {
			verdict: "ship_relevant";
			reason:
				| "primary_ship_relevant"
				| "declared_ship_relevant"
				| "file_budget_exceeded";
			prs: RunShipRelevancePrView[];
	  }
	| {
			verdict: "unknown";
			reason: RunShipRelevanceUnknownReason;
			prs: RunShipRelevancePrView[];
	  };

function view(
	candidate: RunShipRelevanceCandidate,
	role: "primary" | "declared",
): RunShipRelevancePrView {
	return {
		role,
		repoIdentity: candidate.repoIdentity,
		repoSlug: candidate.repoSlug,
		prNumber: candidate.prNumber,
		headSha: candidate.headSha,
		...(candidate.classification
			? {
					shipRelevant: candidate.classification.shipRelevant,
					fileCount: candidate.classification.fileCount,
				}
			: {}),
		...(candidate.missingReason
			? { missingReason: candidate.missingReason }
			: {}),
	};
}

export function resolveRunShipRelevanceCore(
	facts: RunShipRelevanceFacts,
): RunShipRelevance {
	const prs = [
		view(facts.primary, "primary"),
		...facts.declared.map((candidate) => view(candidate, "declared")),
	];
	if (facts.primary.classification?.shipRelevant === 1) {
		return { verdict: "ship_relevant", reason: "primary_ship_relevant", prs };
	}
	if (
		facts.declared.some(
			(candidate) => candidate.classification?.shipRelevant === 1,
		)
	) {
		return { verdict: "ship_relevant", reason: "declared_ship_relevant", prs };
	}
	if (!facts.primary.classification) {
		return {
			verdict: "unknown",
			reason: facts.primary.missingReason ?? "primary_snapshot_missing",
			prs,
		};
	}
	const unresolvedDeclared = facts.declared.find(
		(candidate) => !candidate.classification,
	);
	if (unresolvedDeclared) {
		return {
			verdict: "unknown",
			reason: unresolvedDeclared.missingReason ?? "declared_snapshot_missing",
			prs,
		};
	}

	const coveredCandidates = [facts.primary, ...facts.declared];
	for (const review of facts.nestedReviews) {
		const reviewIdentity = review.repoIdentity.toLowerCase();
		const reviewHead = review.headSha.toLowerCase();
		const covered = coveredCandidates.some((candidate) => {
			if (candidate.repoIdentity.toLowerCase() !== reviewIdentity) return false;
			if (candidate.headSha.toLowerCase() === reviewHead) return true;
			for (const commitSha of candidate.classification!.commitShas) {
				if (commitSha.toLowerCase() === reviewHead) return true;
			}
			return false;
		});
		if (!covered) {
			return { verdict: "unknown", reason: "nested_review_uncovered", prs };
		}
	}

	const fileCount = coveredCandidates.reduce(
		(sum, candidate) => sum + candidate.classification!.fileCount,
		0,
	);
	if (fileCount > MAX_DOCS_ONLY_FILES) {
		return { verdict: "ship_relevant", reason: "file_budget_exceeded", prs };
	}
	return { verdict: "docs_only", fileCount, prs };
}

function unresolvedScope(session: RunShipRelevanceSession): RunShipRelevance {
	return {
		verdict: "unknown",
		reason: "scope_unresolved",
		prs: [
			{
				role: "primary",
				repoIdentity: "__main__",
				repoSlug: "",
				prNumber: session.pr_number ?? 0,
				headSha: session.pr_head_sha?.toLowerCase() ?? "",
				missingReason: "scope_unresolved",
			},
		],
	};
}

function classificationFromSnapshot(input: {
	snapshot: ShipRelevantPrSnapshot | undefined;
	expected: Omit<RunShipRelevanceCandidate, "classification" | "missingReason">;
	role: "primary" | "declared";
	nowMs: number;
}): RunShipRelevanceCandidate {
	const prefix = input.role === "primary" ? "primary" : "declared";
	const missing = `${prefix}_snapshot_missing` as RunShipRelevanceUnknownReason;
	const snapshot = input.snapshot;
	if (
		!snapshot ||
		snapshot.role !== input.role ||
		snapshot.repo_slug.toLowerCase() !==
			input.expected.repoSlug.toLowerCase() ||
		snapshot.pr_number !== input.expected.prNumber ||
		snapshot.pr_head_sha.toLowerCase() !==
			input.expected.headSha.toLowerCase() ||
		!Number.isSafeInteger(snapshot.file_count) ||
		snapshot.file_count < 0 ||
		!Array.isArray(snapshot.commit_shas) ||
		!snapshot.commit_shas.every((sha) => /^[0-9a-f]{40}$/i.test(sha))
	) {
		return { ...input.expected, missingReason: missing };
	}
	if (snapshot.classifier_version !== SHIP_RELEVANT_CLASSIFIER_VERSION) {
		return {
			...input.expected,
			missingReason:
				`${prefix}_snapshot_version_mismatch` as RunShipRelevanceUnknownReason,
		};
	}
	const computedAt = Date.parse(snapshot.computed_at);
	const ageMs = input.nowMs - computedAt;
	if (
		!Number.isFinite(computedAt) ||
		ageMs < -SHIP_RELEVANT_SNAPSHOT_MAX_AGE_MS ||
		ageMs > SHIP_RELEVANT_SNAPSHOT_MAX_AGE_MS
	) {
		return {
			...input.expected,
			missingReason:
				`${prefix}_snapshot_stale` as RunShipRelevanceUnknownReason,
		};
	}
	return {
		...input.expected,
		classification: {
			repoSlug: snapshot.repo_slug,
			prNumber: snapshot.pr_number,
			headSha: snapshot.pr_head_sha,
			shipRelevant: snapshot.ship_relevant,
			fileCount: snapshot.file_count,
			commitShas: new Set(snapshot.commit_shas.map((sha) => sha.toLowerCase())),
		},
	};
}

export function resolveRunShipRelevance(
	store: RunShipRelevanceStore,
	session: RunShipRelevanceSession,
	now = new Date(),
): RunShipRelevance {
	if (
		!session.execution_id ||
		!Number.isSafeInteger(session.pr_number) ||
		(session.pr_number ?? 0) <= 0 ||
		!/^[0-9a-f]{40}$/i.test(session.pr_head_sha ?? "") ||
		!Number.isFinite(now.getTime())
	) {
		return unresolvedScope(session);
	}
	const executionId = session.execution_id;
	const prNumber = session.pr_number!;
	const headSha = session.pr_head_sha!.toLowerCase();
	try {
		const run = store.resolveWorkflowRunForExecution(executionId);
		if (run.kind === "many") return unresolvedScope(session);
		if (run.kind === "none") {
			const primarySnapshot = store.resolvePrimaryShipRelevantPrSnapshot(
				executionId,
				prNumber,
			);
			if (primarySnapshot.kind === "many") return unresolvedScope(session);
			const snapshot =
				primarySnapshot.kind === "one" ? primarySnapshot.snapshot : undefined;
			const primary = classificationFromSnapshot({
				snapshot,
				expected: {
					repoIdentity: "__main__",
					repoSlug: snapshot?.repo_slug ?? "",
					prNumber,
					headSha,
				},
				role: "primary",
				nowMs: now.getTime(),
			});
			return resolveRunShipRelevanceCore({
				primary,
				declared: [],
				nestedReviews:
					store.listNestedCodexReviewHeadsForExecution(executionId),
			});
		}

		const binding = store.resolveWorkflowNodePrBindingForSession(
			executionId,
			headSha,
		);
		if (binding.kind !== "one" || binding.binding.run_id !== run.runId) {
			return unresolvedScope(session);
		}
		const declaredRows = store.projectCurrentShipRelevantCandidates(run.runId);
		if (declaredRows.length > MAX_DECLARED_PRS_PER_RUN) {
			return {
				verdict: "unknown",
				reason: "declaration_overflow",
				prs: [],
			};
		}
		const primaryExpected = {
			repoIdentity: binding.binding.target_repo_identity,
			repoSlug: binding.binding.probe_repo_slug,
			prNumber: binding.binding.pr_number,
			headSha: binding.binding.head_sha.toLowerCase(),
		};
		if (primaryExpected.prNumber !== prNumber) return unresolvedScope(session);
		const primary = classificationFromSnapshot({
			snapshot: store.getShipRelevantPrSnapshot(
				executionId,
				primaryExpected.repoSlug,
				primaryExpected.prNumber,
			),
			expected: primaryExpected,
			role: "primary",
			nowMs: now.getTime(),
		});
		const declared = declaredRows.map((row) =>
			classificationFromSnapshot({
				snapshot: store.getShipRelevantPrSnapshot(
					executionId,
					row.probe_repo_slug,
					row.pr_number,
				),
				expected: {
					repoIdentity: row.repo_identity,
					repoSlug: row.probe_repo_slug,
					prNumber: row.pr_number,
					headSha: row.frozen_head_sha.toLowerCase(),
				},
				role: "declared",
				nowMs: now.getTime(),
			}),
		);
		return resolveRunShipRelevanceCore({
			primary,
			declared,
			nestedReviews: store.listNestedCodexReviewHeadsForRun(run.runId),
		});
	} catch {
		return unresolvedScope(session);
	}
}

export type CounterfactualRunShipRelevance = RunShipRelevance & {
	mode: "counterfactual";
	basis: {
		primaryExecutionId: string;
		primaryComputedAt: string;
		snapshotVersion: number;
	} | null;
};

export function resolveRunShipRelevanceCounterfactual(input: {
	primarySnapshots: ShipRelevantDiffSnapshot[];
	nestedReviews: Array<{ repoIdentity: string; headSha: string }>;
	declared?: RunShipRelevanceCandidate[];
}): CounterfactualRunShipRelevance {
	const primarySnapshot = [...input.primarySnapshots]
		.sort((a, b) => {
			const aTime = Date.parse(a.computed_at);
			const bTime = Date.parse(b.computed_at);
			const timeOrder =
				(Number.isFinite(aTime) ? aTime : Number.NEGATIVE_INFINITY) -
				(Number.isFinite(bTime) ? bTime : Number.NEGATIVE_INFINITY);
			if (timeOrder !== 0) return timeOrder;
			return a.execution_id.localeCompare(b.execution_id);
		})
		.at(-1);
	const primary: RunShipRelevanceCandidate = primarySnapshot
		? {
				repoIdentity: "__main__",
				repoSlug: primarySnapshot.repo,
				prNumber: primarySnapshot.pr_number,
				headSha: primarySnapshot.pr_head_sha.toLowerCase(),
				classification: {
					repoSlug: primarySnapshot.repo,
					prNumber: primarySnapshot.pr_number,
					headSha: primarySnapshot.pr_head_sha.toLowerCase(),
					shipRelevant: primarySnapshot.ship_relevant,
					fileCount: primarySnapshot.file_count,
					commitShas: new Set<string>(),
				},
			}
		: {
				repoIdentity: "__main__",
				repoSlug: "",
				prNumber: 0,
				headSha: "",
				missingReason: "primary_snapshot_missing",
			};
	const result = resolveRunShipRelevanceCore({
		primary,
		declared: input.declared ?? [],
		nestedReviews: input.nestedReviews,
	});
	return {
		...result,
		mode: "counterfactual",
		basis: primarySnapshot
			? {
					primaryExecutionId: primarySnapshot.execution_id,
					primaryComputedAt: primarySnapshot.computed_at,
					snapshotVersion: primarySnapshot.classifier_version,
				}
			: null,
	};
}
