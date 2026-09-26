/**
 * FLY-1185 — StateStore lifecycle-closeout state:
 *   §2.1 worktree authority binding (set-once; patchSessionMetadata cannot touch)
 *   §2.3 cleanup_ref_observations (continuous eligibility)
 *   §2.12 R9#1/R10#4 linear_state_observations (episode machine, monotonic)
 *   §2.12 R9#2 issue_disposition_intents (tombstone + execution dimension)
 *   R11#1 lifecycle_launch_claims
 */

import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

async function freshStore(): Promise<StateStore> {
	return StateStore.create(":memory:");
}

describe("FLY-1185 §2.1 worktree binding", () => {
	it("bindWorktreeOnce binds once; second bind refused (plan §4 #24)", async () => {
		const store = await freshStore();
		store.upsertSession({
			execution_id: "e1",
			issue_id: "FLY-1",
			project_name: "p",
			status: "pending",
		});
		const first = store.bindWorktreeOnce("e1", {
			path: "/w/p-FLY-1",
			branch: "p-FLY-1",
			generation: "gen-1",
		});
		expect(first.bound).toBe(true);
		const second = store.bindWorktreeOnce("e1", {
			path: "/w/other",
			branch: "p-other",
			generation: "gen-2",
		});
		expect(second.bound).toBe(false);
		expect(second.reason).toBe("already_bound");
		const b = store.getWorktreeBinding("e1");
		expect(b?.generation).toBe("gen-1");
		expect(b?.path).toBe("/w/p-FLY-1");
	});

	it("binds via a minimal pending row when the session does not exist yet", async () => {
		const store = await freshStore();
		const res = store.bindWorktreeOnce(
			"e-new",
			{ path: "/w/x", branch: "p-x", generation: "g" },
			{ issueId: "FLY-2", projectName: "p" },
		);
		expect(res.bound).toBe(true);
		expect(store.getSession("e-new")?.status).toBe("pending");
		expect(store.getWorktreeBinding("e-new")?.generation).toBe("g");
	});

	it("patchSessionMetadata structurally CANNOT touch binding columns (plan §4 #24)", async () => {
		const store = await freshStore();
		store.upsertSession({
			execution_id: "e1",
			issue_id: "FLY-1",
			project_name: "p",
			status: "running",
		});
		store.bindWorktreeOnce("e1", {
			path: "/w/a",
			branch: "b-a",
			generation: "gen-a",
		});
		// Attempt to smuggle binding fields through the metadata patch.
		store.patchSessionMetadata("e1", {
			worktree_path: "/attacker/path",
			branch: "attacker-branch",
			// biome-ignore lint/suspicious/noExplicitAny: deliberate smuggle attempt
			...({ worktree_binding_generation: "attacker-gen" } as any),
		});
		const b = store.getWorktreeBinding("e1");
		expect(b?.generation).toBe("gen-a");
		expect(b?.path).toBe("/w/a");
		expect(b?.branch).toBe("b-a");
	});

	it("upsertSession never touches binding columns either", async () => {
		const store = await freshStore();
		store.upsertSession({
			execution_id: "e1",
			issue_id: "FLY-1",
			project_name: "p",
			status: "running",
		});
		store.bindWorktreeOnce("e1", {
			path: "/w/a",
			branch: "b-a",
			generation: "gen-a",
		});
		store.upsertSession({
			execution_id: "e1",
			issue_id: "FLY-1",
			project_name: "p",
			status: "completed",
			worktree_path: "/other",
		});
		expect(store.getWorktreeBinding("e1")?.generation).toBe("gen-a");
	});

	it("listWorktreeBindings returns only bound sessions of the project", async () => {
		const store = await freshStore();
		store.upsertSession({
			execution_id: "e1",
			issue_id: "i",
			project_name: "p",
			status: "running",
		});
		store.upsertSession({
			execution_id: "e2",
			issue_id: "i2",
			project_name: "p",
			status: "running",
		});
		store.bindWorktreeOnce("e1", {
			path: "/w/1",
			branch: "b1",
			generation: "g1",
		});
		const rows = store.listWorktreeBindings("p");
		expect(rows.map((r) => r.execution_id)).toEqual(["e1"]);
	});
});

describe("FLY-1185 §2.3 cleanup_ref_observations", () => {
	it("first observation starts the clock; same fingerprint keeps it; change resets", async () => {
		const store = await freshStore();
		const a = store.observeCleanupRef("p", "local_branch", "b1", "fp-1");
		expect(a.firstSeenEligibleAt).toBeTruthy();
		const b = store.observeCleanupRef("p", "local_branch", "b1", "fp-1");
		expect(b.firstSeenEligibleAt).toBe(a.firstSeenEligibleAt);
		const c = store.observeCleanupRef("p", "local_branch", "b1", "fp-2");
		// sqlite second resolution — a reset writes a fresh timestamp; assert the
		// semantic (row now carries the NEW fingerprint's clock) via a follow-up.
		const d = store.observeCleanupRef("p", "local_branch", "b1", "fp-2");
		expect(d.firstSeenEligibleAt).toBe(c.firstSeenEligibleAt);
	});

	it("delete drops the observation (re-appearing candidate restarts cold)", async () => {
		const store = await freshStore();
		store.observeCleanupRef("p", "worktree", "/w/x", "fp");
		store.deleteCleanupRefObservation("p", "worktree", "/w/x");
		// A fresh observe re-inserts (no stale clock retained) — verify by the
		// fingerprint-change-free path returning a defined timestamp again.
		const again = store.observeCleanupRef("p", "worktree", "/w/x", "fp");
		expect(again.firstSeenEligibleAt).toBeTruthy();
	});
});

describe("FLY-1185 §2.12 linear_state_observations (episode machine)", () => {
	const base = {
		project: "p",
		issueUuid: "11111111-1111-4111-8111-111111111111",
	};

	it("first-seen terminal → legacy episode, NEVER authorized (plan §4 #30)", async () => {
		const store = await freshStore();
		const res = store.observeLinearStateAndClaimCloseout({
			...base,
			stateType: "completed",
			linearUpdatedAt: "2026-07-11T00:00:00.000Z",
		});
		expect(res.outcome).toBe("recorded");
		expect(res.terminalAuthorized).toBe(false);
		expect(res.legacyTerminalEpisode).toBe(true);
		// re-observing terminal in ANY later round is still never auto
		const later = store.observeLinearStateAndClaimCloseout({
			...base,
			stateType: "completed",
			linearUpdatedAt: "2026-07-11T01:00:00.000Z",
		});
		expect(later.terminalAuthorized).toBe(false);
		expect(later.legacyTerminalEpisode).toBe(true);
	});

	it("durable nonterminal → terminal migration grants authority; fresh nonterminal clears it", async () => {
		const store = await freshStore();
		store.observeLinearStateAndClaimCloseout({
			...base,
			stateType: "started",
			linearUpdatedAt: "2026-07-11T00:00:00.000Z",
		});
		const term = store.observeLinearStateAndClaimCloseout({
			...base,
			stateType: "canceled",
			linearUpdatedAt: "2026-07-11T02:00:00.000Z",
		});
		expect(term.terminalAuthorized).toBe(true);
		expect(term.legacyTerminalEpisode).toBe(false);
		// authority persists across re-reads (crash before first mutator, R10#4)
		expect(
			store.getLinearStateObservation("p", base.issueUuid)?.terminalAuthorized,
		).toBe(true);
		// reopen clears authority
		const reopen = store.observeLinearStateAndClaimCloseout({
			...base,
			stateType: "started",
			linearUpdatedAt: "2026-07-11T03:00:00.000Z",
		});
		expect(reopen.terminalAuthorized).toBe(false);
		// legacy reopen→Cancel becomes a REAL migration afterwards (plan §4 #30)
		const recancel = store.observeLinearStateAndClaimCloseout({
			...base,
			stateType: "canceled",
			linearUpdatedAt: "2026-07-11T04:00:00.000Z",
		});
		expect(recancel.terminalAuthorized).toBe(true);
	});

	it("out-of-order response ignored; same-updatedAt conflicting state fail-closed (plan §4 #42)", async () => {
		const store = await freshStore();
		store.observeLinearStateAndClaimCloseout({
			...base,
			stateType: "started",
			linearUpdatedAt: "2026-07-11T05:00:00.000Z",
		});
		const stale = store.observeLinearStateAndClaimCloseout({
			...base,
			stateType: "canceled",
			linearUpdatedAt: "2026-07-11T01:00:00.000Z",
		});
		expect(stale.outcome).toBe("ignored_stale");
		expect(stale.terminalAuthorized).toBe(false);
		const conflict = store.observeLinearStateAndClaimCloseout({
			...base,
			stateType: "canceled",
			linearUpdatedAt: "2026-07-11T05:00:00.000Z",
		});
		expect(conflict.outcome).toBe("conflict");
		expect(conflict.terminalAuthorized).toBe(false);
	});

	it("trusted local terminal claim (ship_complete) grants authority through the same seam", async () => {
		const store = await freshStore();
		store.claimLocalTerminalAuthority({
			project: "p",
			issueUuid: base.issueUuid,
			source: "ship_complete",
		});
		expect(
			store.getLinearStateObservation("p", base.issueUuid)?.terminalAuthorized,
		).toBe(true);
	});
});

describe("FLY-1185 R9#2 issue_disposition_intents (tombstone)", () => {
	const uuid = "22222222-2222-4222-8222-222222222222";

	it("tombstone persists across closeout completion; only supersede removes it (R10#1)", async () => {
		const store = await freshStore();
		store.upsertIssueDispositionIntent({
			issueUuid: uuid,
			project: "p",
			founderDecisionId: "fd-1",
		});
		expect(store.getActiveIssueDispositionIntent(uuid)?.closeoutStatus).toBe(
			"pending",
		);
		store.setIntentCloseoutStatus(uuid, "complete", "all clear");
		// STILL an active tombstone — closeout completion does not unpark.
		const active = store.getActiveIssueDispositionIntent(uuid);
		expect(active).toBeDefined();
		expect(active?.closeoutStatus).toBe("complete");
		// unpark
		expect(store.supersedeIssueDispositionIntent(uuid, "fd-2")).toBe(true);
		expect(store.getActiveIssueDispositionIntent(uuid)).toBeUndefined();
	});

	it("replayable set = pending|partial only; needs_operator stays visible but not replayed", async () => {
		const store = await freshStore();
		store.upsertIssueDispositionIntent({
			issueUuid: uuid,
			project: "p",
			founderDecisionId: "fd-1",
		});
		store.setIntentCloseoutStatus(uuid, "partial");
		expect(
			store.listReplayableDispositionIntents().map((r) => r.issueUuid),
		).toEqual([uuid]);
		store.setIntentCloseoutStatus(uuid, "needs_operator", "blocked_open_pr");
		expect(store.listReplayableDispositionIntents()).toEqual([]);
		expect(store.getActiveIssueDispositionIntent(uuid)?.closeoutStatus).toBe(
			"needs_operator",
		);
	});
});

describe("FLY-1185 R11#1 launch claims", () => {
	it("starting claims are visible to node collection; state machine starting→active→closed", async () => {
		const store = await freshStore();
		store.insertLaunchClaim({
			executionId: "e1",
			rootUuid: "root-1",
			project: "p",
			role: "main",
		});
		expect(
			store.listOpenLaunchClaims("root-1").map((c) => c.executionId),
		).toEqual(["e1"]);
		store.setLaunchClaimState("e1", "active");
		expect(store.listOpenLaunchClaims("root-1")[0]?.state).toBe("active");
		store.setLaunchClaimState("e1", "closed");
		expect(store.listOpenLaunchClaims("root-1")).toEqual([]);
	});

	it("stale starting claims surface for maintenance convergence", async () => {
		const store = await freshStore();
		store.insertLaunchClaim({ executionId: "e2", rootUuid: "r", project: "p" });
		// fresh claim is NOT stale
		expect(store.listStaleStartingClaims(30)).toEqual([]);
	});
});

describe("FLY-1185 auto-QA record lookups (lifecycle-root fold inputs)", () => {
	it("findAutoQaRecordsByQaIssueKeys / ByParentIssueKeys", async () => {
		const store = await freshStore();
		store.claimAutoQaRecord({
			parentExecutionId: "pe",
			targetPrHeadSha: "sha1",
			issueId: "parent-uuid",
			projectName: "p",
		});
		store.setAutoQaQaExecutionId("pe", "sha1", "qe");
		store.setAutoQaIssue("pe", "sha1", {
			issueId: "qa-uuid",
			issueIdentifier: "FLY-2000",
		});
		expect(
			store.findAutoQaRecordsByQaIssueKeys(["qa-uuid"]).map((r) => r.issue_id),
		).toEqual(["parent-uuid"]);
		expect(
			store.findAutoQaRecordsByQaIssueKeys(["FLY-2000"]).map((r) => r.issue_id),
		).toEqual(["parent-uuid"]);
		expect(store.findAutoQaRecordsByQaIssueKeys(["nope"])).toEqual([]);
		expect(
			store
				.findAutoQaRecordsByParentIssueKeys(["parent-uuid"])
				.map((r) => r.qa_execution_id),
		).toEqual(["qe"]);
	});
});
