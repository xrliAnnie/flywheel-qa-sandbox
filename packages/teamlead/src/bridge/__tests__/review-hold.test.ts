import { describe, expect, it } from "vitest";
import { type AutoQaRecord, StateStore } from "../../StateStore.js";
import {
	type AutoQaHeldStore,
	founderApprovalHoldGuard,
	isQaHeld,
	type QaHeldSession,
	reviewHoldReason,
} from "../review-hold.js";

const SHA = "a".repeat(40);
const NESTED_HEAD = "b".repeat(40);
const PRIOR_NESTED_HEAD = "d".repeat(40);

function storeWith(record: AutoQaRecord | undefined): AutoQaHeldStore {
	return {
		getAutoQaRecord: (parent, sha) =>
			record &&
			record.parent_execution_id === parent &&
			record.target_pr_head_sha === sha
				? record
				: undefined,
	};
}

function rec(status: AutoQaRecord["status"]): AutoQaRecord {
	return {
		parent_execution_id: "main-1",
		target_pr_head_sha: SHA,
		issue_id: "FLY-1",
		project_name: "proj",
		status,
		started_at: "2026-06-28T00:00:00Z",
	};
}

const main: QaHeldSession = {
	execution_id: "main-1",
	session_role: "main",
	status: "awaiting_review",
	pr_head_sha: SHA,
	pr_number: 42,
};

async function allRepositoryHoldStore(
	options: {
		primarySnapshot?: boolean;
		primaryVersion?: number;
		nestedReviewHead?: string;
	} = {},
): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	store.createWorkflowRun({
		runId: "run-2395",
		issueId: "FLY-2395",
		projectName: "flywheel",
		claimsReadEnrolled: true,
	});
	store.upsertWorkflowRunNode({
		runId: "run-2395",
		nodeId: "main",
		attempt: 1,
		state: "done",
		executionId: "exec-2395",
	});
	store.upsertSession({
		execution_id: "exec-2395",
		issue_id: "FLY-2395",
		project_name: "flywheel",
		status: "awaiting_review",
		session_role: "main",
		pr_number: 41,
		pr_head_sha: SHA,
	});
	store.setReviewBinding("exec-2395", {
		questionId: "approve-2395",
		prHeadSha: SHA,
	});
	const db = (
		store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		}
	).db;
	db.run(
		`INSERT INTO workflow_node_pr_binding
		   (run_id, node_id, attempt, pr_number, head_sha,
		    target_repo_identity, probe_repo_slug, target_repo_path,
		    worktree_binding_generation, receipt_id, bound_at)
		 VALUES ('run-2395', 'main', 1, 41, ?, '__main__', 'owner/main', '.',
		         'generation-1', 'binding-1', '2026-09-06T00:00:00.000Z')`,
		[SHA],
	);
	store.recordCodexReviewApproved({
		executionId: "exec-2395",
		targetPrHeadSha: SHA,
		issueId: "FLY-2395",
		projectName: "flywheel",
	});
	if (options.nestedReviewHead) {
		store.recordCodexReviewApproved({
			executionId: "exec-2395",
			targetRepoIdentity: "owner/nested",
			targetPrHeadSha: options.nestedReviewHead,
			issueId: "FLY-2395",
			projectName: "flywheel",
		});
	}
	if (options.primarySnapshot !== false) {
		store.putShipRelevantPrSnapshot({
			execution_id: "exec-2395",
			repo_slug: "owner/main",
			pr_number: 41,
			pr_head_sha: SHA,
			role: "primary",
			base_ref: "main",
			base_oid: "c".repeat(40),
			classifier_version: options.primaryVersion ?? 2,
			ship_relevant: 0,
			file_count: 1,
			commit_shas: [SHA],
		});
	}
	return store;
}

function declareNestedPr(
	store: StateStore,
	options: { shipRelevant: 0 | 1; commitShas?: string[] },
): void {
	store.recordShipRelevantDeclarations({
		receiptId: "declaration-2395",
		runId: "run-2395",
		nodeId: "main",
		attempt: 1,
		executionId: "exec-2395",
		rows: [
			{
				repoIdentity: "owner/nested",
				prNumber: 77,
				probeRepoSlug: "owner/nested",
				frozenHeadSha: NESTED_HEAD,
				targetRepoPath: "nested",
			},
		],
	});
	store.putShipRelevantPrSnapshot({
		execution_id: "exec-2395",
		repo_slug: "owner/nested",
		pr_number: 77,
		pr_head_sha: NESTED_HEAD,
		role: "declared",
		base_ref: "main",
		base_oid: "e".repeat(40),
		classifier_version: 2,
		ship_relevant: options.shipRelevant,
		file_count: 2,
		commit_shas: options.commitShas ?? [NESTED_HEAD],
	});
}

describe("isQaHeld", () => {
	it("held while QA is running", () => {
		expect(isQaHeld(storeWith(rec("running")), main)).toBe(true);
	});

	it("held when QA failed (founder must NOT be surfaced for a failed change)", () => {
		expect(isQaHeld(storeWith(rec("failed")), main)).toBe(true);
	});

	it("held when QA is stuck (pipeline error → Lead handles, founder stays out)", () => {
		expect(isQaHeld(storeWith(rec("stuck")), main)).toBe(true);
	});

	it("RELEASED once QA passed (founder may be surfaced)", () => {
		expect(isQaHeld(storeWith(rec("passed")), main)).toBe(false);
	});

	it("not held when no record exists (auto-QA off / byte-compat)", () => {
		expect(isQaHeld(storeWith(undefined), main)).toBe(false);
	});

	it("never holds a QA session itself (role != main)", () => {
		expect(
			isQaHeld(storeWith(rec("running")), { ...main, session_role: "qa" }),
		).toBe(false);
	});

	it("never holds a non-awaiting_review session", () => {
		expect(
			isQaHeld(storeWith(rec("running")), { ...main, status: "running" }),
		).toBe(false);
	});

	it("not held without a pr_head_sha", () => {
		expect(
			isQaHeld(storeWith(rec("running")), { ...main, pr_head_sha: undefined }),
		).toBe(false);
	});

	it("record for a DIFFERENT head does not hold the current head", () => {
		const other = rec("running");
		other.target_pr_head_sha = "b".repeat(40);
		expect(isQaHeld(storeWith(other), main)).toBe(false);
	});

	it("undefined session is never held", () => {
		expect(isQaHeld(storeWith(rec("running")), undefined)).toBe(false);
	});
});

describe("founderApprovalHoldGuard (FLY-1041 Chunk 5)", () => {
	// A merge_block marker holds unconditionally in isReviewHeld — the cheapest
	// way to construct a held session without codex/QA scaffolding.
	const heldSession: QaHeldSession = {
		execution_id: "main-1",
		merge_block_reason: "merge_without_approval",
	};
	const guardStore = {
		getAutoQaRecord: () => undefined,
		isCodexCodeReviewApproved: () => true,
		resolveWorkflowRunForExecution: () => ({ kind: "none" as const }),
		resolveWorkflowNodePrBindingForSession: () => ({ kind: "none" as const }),
		projectCurrentShipRelevantCandidates: () => [],
		listNestedCodexReviewHeadsForRun: () => [],
		listNestedCodexReviewHeadsForExecution: () => [],
		getShipRelevantPrSnapshot: () => undefined,
		resolvePrimaryShipRelevantPrSnapshot: () => ({
			kind: "one" as const,
			snapshot: {
				execution_id: "main-1",
				repo_slug: "owner/main",
				pr_number: 42,
				pr_head_sha: SHA,
				role: "primary" as const,
				base_ref: "main",
				base_oid: "b".repeat(40),
				classifier_version: 2,
				ship_relevant: 0 as const,
				file_count: 1,
				commit_shas: [SHA],
				computed_at: new Date().toISOString(),
			},
		}),
	} as Parameters<typeof founderApprovalHoldGuard>[0];

	it("delegates to isReviewHeld (held session → true)", () => {
		expect(founderApprovalHoldGuard(guardStore, heldSession)).toBe(true);
	});

	it("un-held session → false", () => {
		expect(founderApprovalHoldGuard(guardStore, main)).toBe(false);
		expect(founderApprovalHoldGuard(guardStore, undefined)).toBe(false);
	});

	it("FLYWHEEL_ATTRIBUTION_HOLD_ALIGN=0 cannot bypass a live hold", () => {
		expect(
			Reflect.apply(founderApprovalHoldGuard, undefined, [
				guardStore,
				heldSession,
				{ FLYWHEEL_ATTRIBUTION_HOLD_ALIGN: "0" },
			]),
		).toBe(true);
	});
});

describe("FLY-2395 all-repository review hold", () => {
	it("holds a main docs-only PR when a nested review head is undeclared", async () => {
		const store = await allRepositoryHoldStore({
			nestedReviewHead: NESTED_HEAD,
		});

		expect(store.isCodexCodeReviewApproved("exec-2395", SHA)).toBe(true);
		expect(store.getSession("exec-2395")).toMatchObject({
			session_role: "main",
			status: "awaiting_review",
			pr_number: 41,
			pr_head_sha: SHA,
		});
		expect(store.getShipRelevantDiffSnapshot("exec-2395", SHA)).toBeUndefined();
		expect(reviewHoldReason(store, store.getSession("exec-2395"))).toBe(
			"qa_evidence_unknown",
		);
		store.close();
	});

	it("holds when a declared nested PR is ship-relevant", async () => {
		const store = await allRepositoryHoldStore({
			nestedReviewHead: NESTED_HEAD,
		});
		declareNestedPr(store, { shipRelevant: 1 });

		expect(reviewHoldReason(store, store.getSession("exec-2395"))).toBe(
			"qa_evidence_missing",
		);
		store.close();
	});

	it("releases when every declared PR is docs-only and prior reviewed heads are covered", async () => {
		const store = await allRepositoryHoldStore({
			nestedReviewHead: PRIOR_NESTED_HEAD,
		});
		declareNestedPr(store, {
			shipRelevant: 0,
			commitShas: [PRIOR_NESTED_HEAD, NESTED_HEAD],
		});

		expect(reviewHoldReason(store, store.getSession("exec-2395"))).toBeNull();
		store.close();
	});

	it("preserves the docs-only control when there are no declarations or nested reviews", async () => {
		const store = await allRepositoryHoldStore();
		expect(reviewHoldReason(store, store.getSession("exec-2395"))).toBeNull();
		store.close();
	});

	it("fails closed during a cold start with no v2 primary snapshot", async () => {
		const store = await allRepositoryHoldStore({ primarySnapshot: false });
		expect(reviewHoldReason(store, store.getSession("exec-2395"))).toBe(
			"qa_evidence_unknown",
		);
		store.close();
	});

	it("maps a superseded primary classifier version to missing QA evidence", async () => {
		const store = await allRepositoryHoldStore({ primaryVersion: 1 });
		expect(reviewHoldReason(store, store.getSession("exec-2395"))).toBe(
			"qa_evidence_missing",
		);
		store.close();
	});
});
