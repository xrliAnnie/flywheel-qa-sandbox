import { describe, expect, it } from "vitest";
import type { RunShipRelevance } from "../bridge/run-ship-relevance.js";
import {
	buildShadowObservation,
	SHADOW_BASIS_MAX_BYTES,
	SHADOW_NESTED_REVIEW_MAX,
	type ShadowObservationFacts,
} from "./observation.js";

const HEAD = "a".repeat(40);
const OBSERVED_AT = "2026-09-08T12:00:30.000Z";

function facts(
	relevance: RunShipRelevance,
	overrides: Partial<ShadowObservationFacts> = {},
): ShadowObservationFacts {
	return {
		verdictId: "verdict-1",
		runId: "run-1",
		questionId: "question-1",
		gateExecutionId: "implement-1",
		repoIdentity: "__main__",
		prNumber: 1063,
		headSha: HEAD,
		observedAt: OBSERVED_AT,
		relevance,
		declaredProjectedCount: 0,
		snapshotsByCandidate: [
			{
				role: "primary",
				repoSlug: "xrliAnnie/flywheel",
				prNumber: 1063,
				snapshot: {
					pr_head_sha: HEAD,
					computed_at: "2026-09-08T12:00:00.000Z",
					classifier_version: 1,
					ship_relevant: 0,
					file_count: 2,
				},
			},
		],
		nestedReviews: [],
		strengthTwo: {
			ran: { satisfied: false, reason: "no_ledger_row" },
			record: { satisfied: false, reason: "no_ledger_row" },
			verdict: "unsatisfied",
			basisRecordId: null,
		},
		strengthTwoRowCount: 0,
		strengthTwoOtherHeadRowCount: 0,
		...overrides,
	};
}

describe("buildShadowObservation", () => {
	it("freezes a docs-only classification and both strength-two halves", () => {
		const row = buildShadowObservation(
			facts({
				verdict: "docs_only",
				fileCount: 2,
				prs: [
					{
						role: "primary",
						repoIdentity: "__main__",
						repoSlug: "xrliAnnie/flywheel",
						prNumber: 1063,
						headSha: HEAD,
						shipRelevant: 0,
						fileCount: 2,
					},
				],
			}),
		);

		expect(row).toMatchObject({
			verdict_id: "verdict-1",
			machine_class: "docs_only",
			machine_reason: null,
			machine_file_count: 2,
			machine_candidate_count: 1,
			machine_declared_projected_count: 0,
			machine_primary_snapshot_age_ms: 30_000,
			machine_declared_max_snapshot_age_ms: null,
			s2_ran_status: "unsatisfied",
			s2_ran_reason: "no_ledger_row",
			s2_record_status: "unsatisfied",
			s2_record_reason: "no_ledger_row",
			s2_verdict: "unsatisfied",
			s2_basis_record_id: null,
			s2_row_count: 0,
			s2_other_head_row_count: 0,
			shadow_version: 1,
		});
		const basis = JSON.parse(row.machine_basis_json) as {
			prs: Array<Record<string, unknown>>;
		};
		expect(basis.prs).toEqual([
			expect.objectContaining({
				role: "primary",
				repoIdentityKey: "__main__",
				expectedHead: HEAD,
				snapshotHead: HEAD,
			}),
		]);
	});

	it("records declaration overflow without inventing candidates", () => {
		const row = buildShadowObservation(
			facts(
				{ verdict: "unknown", reason: "declaration_overflow", prs: [] },
				{ declaredProjectedCount: 9, snapshotsByCandidate: [] },
			),
		);

		expect(row).toMatchObject({
			machine_class: "unknown",
			machine_reason: "declaration_overflow",
			machine_file_count: null,
			machine_candidate_count: 0,
			machine_declared_projected_count: 9,
		});
	});

	it("bounds hostile strings and truncates nested evidence deterministically", () => {
		const hostileSlug = `${'\u0000\\"雪'.repeat(256)}tail`;
		const nestedReviews = Array.from({ length: 64 }, (_, index) => ({
			repoIdentity: `owner/repo-${String(index).padStart(2, "0")}`,
			headSha: index.toString(16).padStart(40, "0"),
		}));
		const row = buildShadowObservation(
			facts(
				{
					verdict: "unknown",
					reason: "primary_snapshot_version_mismatch",
					prs: [
						{
							role: "primary",
							repoIdentity: "OWNER/REPO",
							repoSlug: hostileSlug,
							prNumber: 1063,
							headSha: HEAD.toUpperCase(),
							missingReason: "primary_snapshot_version_mismatch",
						},
					],
				},
				{
					nestedReviews,
					snapshotsByCandidate: [
						{
							role: "primary",
							repoSlug: hostileSlug,
							prNumber: 1063,
							snapshot: {
								pr_head_sha: HEAD.toUpperCase(),
								computed_at: "not-a-time",
								classifier_version: 1,
								ship_relevant: 0,
								file_count: 2,
							},
						},
					],
				},
			),
		);
		const basis = JSON.parse(row.machine_basis_json) as {
			prs: Array<Record<string, unknown>>;
			nestedReviews: {
				originalCount: number;
				encodedCount: number;
				truncated: boolean;
				entries: unknown[];
			};
		};

		expect(
			Buffer.byteLength(row.machine_basis_json, "utf8"),
		).toBeLessThanOrEqual(SHADOW_BASIS_MAX_BYTES);
		expect(basis.prs[0]).toMatchObject({
			repoIdentityKey: "owner/repo",
			expectedHead: null,
			expectedHeadInvalid: true,
			snapshotHead: null,
			snapshotHeadInvalid: true,
			snapshotComputedAt: null,
			snapshotComputedAtInvalid: true,
		});
		expect(basis.nestedReviews).toMatchObject({
			originalCount: 64,
			encodedCount: SHADOW_NESTED_REVIEW_MAX,
			truncated: true,
		});
		expect(basis.nestedReviews.entries).toHaveLength(SHADOW_NESTED_REVIEW_MAX);
	});
});
