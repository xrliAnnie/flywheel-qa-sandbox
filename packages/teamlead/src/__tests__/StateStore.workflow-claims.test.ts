import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";
import {
	isWorkflowClaimsReadEnabled,
	isWorkflowClaimsWriteEnabled,
	isWorkflowLegacyForced,
} from "../workflow-claims.js";

/**
 * FLY-1135 PR-1 — identity + transaction substrate for the workflow claims
 * ledger (plan §2.1/§2.2/§3.2).
 *
 * Everything here is DEFAULT-OFF substrate: no production path calls these
 * APIs yet (wiring lands in PR-2..4). The behaviors under test are the plan's
 * acceptance sentinels at the store level:
 *   - E3(a): same-payload replay of a consumed capability → idempotent success
 *   - E3(b): different payload / expired / revoked / stale attempt → fail-closed
 *   - E3(c): forged subject / no capability → fail-closed
 *   - E6:    same-vendor review claim → rejected (cross-vendor invariant)
 *   - §2.1:  gate resolution picks the highest attempt/server_seq for the
 *            CURRENT subject and NEVER falls back to an older attempt
 *   - append-only: claims / revocations / run events reject UPDATE and DELETE
 */

const H1 = "1".repeat(40);
const H2 = "2".repeat(40);

const T0 = "2026-07-13T00:00:00.000Z";
const T1H = "2026-07-13T01:00:00.000Z";
const T2H = "2026-07-13T02:00:00.000Z";
const T3H = "2026-07-13T03:00:00.000Z";

async function freshStore(): Promise<StateStore> {
	return StateStore.create(":memory:");
}

function seedRun(
	store: StateStore,
	runId = "run-1",
	opts: { enrolled?: boolean; issueId?: string } = {},
): string {
	// FLY-1232 module ②: one ACTIVE run per (project, issue) is a DB-level
	// invariant (partial unique index) — tests seeding a SECOND parallel run
	// must give it its own issue via opts.issueId.
	store.createWorkflowRun({
		runId,
		issueId: opts.issueId ?? "FLY-1135",
		projectName: "flywheel",
		claimsReadEnrolled: opts.enrolled ?? false,
	});
	return runId;
}

function issueQaCapability(
	store: StateStore,
	runId: string,
	attempt = 1,
	overrides: Record<string, unknown> = {},
) {
	const res = store.issueWorkflowDecisionCapability({
		runId,
		nodeId: "qa",
		executionId: `qa-exec-${attempt}`,
		attempt,
		allowedPredicateFamily: "qa_verdict",
		expiresAt: T1H,
		absoluteDeadlineAt: T2H,
		...overrides,
	});
	if (!res.ok) throw new Error(`issue failed: ${res.reason}`);
	return res;
}

function submitQaPass(
	store: StateStore,
	token: string,
	overrides: Record<string, unknown> = {},
) {
	return store.submitWorkflowDecisionClaim({
		token,
		clientRequestId: "req-1",
		predicate: "qa_passed",
		subjectKind: "git_head",
		subjectDigest: H1,
		issuerVendor: "claude",
		issuerModel: "opus",
		subjectProducerExecutionId: "impl-exec",
		subjectProducerVendor: "codex",
		claimExpiresAt: T1H,
		evidence: { report: "qa-report.md" },
		now: T0,
		...overrides,
	});
}

describe("workflow_run — typed enrollment marker (plan §3.2)", () => {
	it("persists the run with the EXPLICIT enrollment flag (never inferred)", async () => {
		const store = await freshStore();
		store.createWorkflowRun({
			runId: "run-enrolled",
			issueId: "FLY-1135",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		store.createWorkflowRun({
			runId: "run-legacy",
			issueId: "FLY-1136", // own issue — one active run per (project, issue)
			projectName: "flywheel",
			claimsReadEnrolled: false,
		});
		expect(store.getWorkflowRun("run-enrolled")?.claims_read_enrolled).toBe(1);
		expect(store.getWorkflowRun("run-legacy")?.claims_read_enrolled).toBe(0);
		expect(store.getWorkflowRun("missing")).toBeUndefined();
	});
});

describe("workflow_run_event — append-only per-run event ledger", () => {
	it("assigns a monotonic per-run seq starting at 1, independent across runs", async () => {
		const store = await freshStore();
		seedRun(store, "run-a");
		seedRun(store, "run-b", { issueId: "FLY-1136" });
		expect(
			store.appendWorkflowRunEvent({
				runId: "run-a",
				eventUid: "a-1",
				kind: "node_dispatched",
				nodeId: "design",
			}),
		).toEqual({ seq: 1, deduped: false });
		expect(
			store.appendWorkflowRunEvent({
				runId: "run-a",
				eventUid: "a-2",
				kind: "node_completed",
				nodeId: "design",
			}),
		).toEqual({ seq: 2, deduped: false });
		expect(
			store.appendWorkflowRunEvent({
				runId: "run-b",
				eventUid: "b-1",
				kind: "node_dispatched",
			}),
		).toEqual({ seq: 1, deduped: false });
	});

	it("dedupes by event_uid — replay returns the original seq without a new row", async () => {
		const store = await freshStore();
		seedRun(store, "run-a");
		store.appendWorkflowRunEvent({
			runId: "run-a",
			eventUid: "a-1",
			kind: "node_dispatched",
		});
		expect(
			store.appendWorkflowRunEvent({
				runId: "run-a",
				eventUid: "a-1",
				kind: "node_dispatched",
			}),
		).toEqual({ seq: 1, deduped: true });
		expect(store.listWorkflowRunEvents("run-a")).toHaveLength(1);
	});

	it("refuses events for an unknown run (fail-closed)", async () => {
		const store = await freshStore();
		expect(() =>
			store.appendWorkflowRunEvent({
				runId: "ghost",
				eventUid: "g-1",
				kind: "node_dispatched",
			}),
		).toThrow(/workflow run not found/);
	});
});

describe("workflow_run_node — attempt-keyed projection", () => {
	it("upserts keyed by (run, node, attempt)", async () => {
		const store = await freshStore();
		seedRun(store, "run-a");
		store.upsertWorkflowRunNode({
			runId: "run-a",
			nodeId: "qa",
			attempt: 1,
			state: "running",
			executionId: "exec-1",
		});
		store.upsertWorkflowRunNode({
			runId: "run-a",
			nodeId: "qa",
			attempt: 1,
			state: "done",
		});
		store.upsertWorkflowRunNode({
			runId: "run-a",
			nodeId: "qa",
			attempt: 2,
			state: "running",
		});
		expect(store.getWorkflowRunNode("run-a", "qa", 1)?.state).toBe("done");
		expect(store.getWorkflowRunNode("run-a", "qa", 1)?.execution_id).toBe(
			"exec-1",
		);
		expect(store.getWorkflowRunNode("run-a", "qa", 2)?.state).toBe("running");
	});
});

describe("workflow_decision_capability — one-shot node-attempt capability (plan §2.2)", () => {
	it("stores ONLY the sha256 token hash, never the plaintext", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const { capabilityId, token } = issueQaCapability(store, runId);
		const row = store.getWorkflowDecisionCapability(capabilityId);
		expect(row).toBeDefined();
		expect(row?.token_hash).not.toBe(token);
		expect(row?.token_hash).toBe(
			createHash("sha256").update(token).digest("hex"),
		);
	});

	it("refuses to issue a capability for an unknown run", async () => {
		const store = await freshStore();
		const res = store.issueWorkflowDecisionCapability({
			runId: "ghost",
			nodeId: "qa",
			executionId: "e",
			attempt: 1,
			allowedPredicateFamily: "qa_verdict",
			expiresAt: T1H,
			absoluteDeadlineAt: T2H,
		});
		expect(res).toEqual({ ok: false, reason: "run_not_found" });
	});

	it("issuing a NEW attempt revokes the prior unconsumed capability (old ticket dies)", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const c1 = issueQaCapability(store, runId, 1);
		issueQaCapability(store, runId, 2);
		const res = submitQaPass(store, c1.token);
		expect(res).toEqual({ ok: false, reason: "capability_revoked" });
	});

	it("refuses to issue for a STALE attempt while a newer capability is active", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		issueQaCapability(store, runId, 2);
		const res = store.issueWorkflowDecisionCapability({
			runId,
			nodeId: "qa",
			executionId: "e1",
			attempt: 1,
			allowedPredicateFamily: "qa_verdict",
			expiresAt: T1H,
			absoluteDeadlineAt: T2H,
		});
		expect(res).toEqual({ ok: false, reason: "stale_attempt" });
	});

	it("refuses to re-issue an attempt whose capability was already CONSUMED (one decision per attempt)", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const c1 = issueQaCapability(store, runId, 1);
		expect(submitQaPass(store, c1.token).ok).toBe(true);
		const res = store.issueWorkflowDecisionCapability({
			runId,
			nodeId: "qa",
			executionId: "e1b",
			attempt: 1,
			allowedPredicateFamily: "qa_verdict",
			expiresAt: T1H,
			absoluteDeadlineAt: T2H,
		});
		expect(res).toEqual({ ok: false, reason: "stale_attempt" });
	});

	it("heartbeat renewal extends expiry but NEVER beyond the absolute deadline", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const { capabilityId } = issueQaCapability(store, runId);
		const renewed = store.renewWorkflowDecisionCapability({
			capabilityId,
			requestedExpiresAt: T3H, // beyond the T2H absolute deadline
			now: T0,
		});
		expect(renewed).toEqual({ ok: true, expiresAt: T2H });
	});

	it("renewal of an expired capability is refused (a dead ticket cannot be revived)", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const { capabilityId } = issueQaCapability(store, runId);
		const res = store.renewWorkflowDecisionCapability({
			capabilityId,
			requestedExpiresAt: T2H,
			now: T2H, // past the T1H expiry
		});
		expect(res).toEqual({ ok: false, reason: "capability_expired" });
	});
});

describe("submitWorkflowDecisionClaim — the single-transaction submission (plan §2.2)", () => {
	it("happy path: writes the claim, consumes the capability, appends the run event — atomically visible", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const { capabilityId, token } = issueQaCapability(store, runId);

		const res = submitQaPass(store, token);
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(res.idempotentReplay).toBe(false);

		const claim = store.getWorkflowClaim(res.claimId);
		expect(claim?.predicate).toBe("qa_passed");
		expect(claim?.decision_kind).toBe("qa_verdict");
		expect(claim?.attempt).toBe(1);
		expect(claim?.node_id).toBe("qa");
		expect(claim?.subject_digest).toBe(H1);
		expect(claim?.issuer_kind).toBe("runner_node");
		expect(claim?.issuer_vendor).toBe("claude");
		expect(claim?.authority_id).toBe(String(capabilityId));

		const cap = store.getWorkflowDecisionCapability(capabilityId);
		expect(cap?.consumed_at).toBeTruthy();
		expect(cap?.consumed_claim_id).toBe(res.claimId);

		const events = store.listWorkflowRunEvents(runId);
		expect(events.some((e) => e.kind === "claim_written")).toBe(true);
	});

	it("E3(a): same-payload replay of a consumed capability → idempotent success, same claim, no new row", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const { token } = issueQaCapability(store, runId);
		const first = submitQaPass(store, token);
		expect(first.ok).toBe(true);
		if (!first.ok) return;

		const replay = submitQaPass(store, token);
		expect(replay.ok).toBe(true);
		if (!replay.ok) return;
		expect(replay.idempotentReplay).toBe(true);
		expect(replay.claimId).toBe(first.claimId);
		expect(store.countWorkflowClaims(runId)).toBe(1);
	});

	it("E3(b): replay with a DIFFERENT payload → fail-closed", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const { token } = issueQaCapability(store, runId);
		expect(submitQaPass(store, token).ok).toBe(true);
		const res = submitQaPass(store, token, { subjectDigest: H2 });
		expect(res).toEqual({ ok: false, reason: "replay_payload_mismatch" });
		expect(store.countWorkflowClaims(runId)).toBe(1);
	});

	it("E3(b): expired capability → fail-closed, and NOTHING is persisted", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const { token } = issueQaCapability(store, runId);
		const res = submitQaPass(store, token, { now: T2H });
		expect(res).toEqual({ ok: false, reason: "capability_expired" });
		expect(store.countWorkflowClaims(runId)).toBe(0);
		expect(
			store
				.listWorkflowRunEvents(runId)
				.filter((e) => e.kind === "claim_written"),
		).toHaveLength(0);
	});

	it("E3(c): unknown token → fail-closed", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		issueQaCapability(store, runId);
		const res = submitQaPass(store, "not-a-real-token");
		expect(res).toEqual({ ok: false, reason: "capability_not_found" });
	});

	it("predicate outside the capability's allowed family → fail-closed", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const { token } = issueQaCapability(store, runId);
		const res = submitQaPass(store, token, { predicate: "codex_approved" });
		expect(res).toEqual({ ok: false, reason: "predicate_not_allowed" });
	});

	it("expected_subject_digest pin mismatch → fail-closed", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const { token } = issueQaCapability(store, runId, 1, {
			expectedSubjectDigest: H2,
		});
		const res = submitQaPass(store, token);
		expect(res).toEqual({ ok: false, reason: "subject_mismatch" });
	});

	it("E6: same-vendor review claim → rejected (cross-vendor invariant, claim-layer second gate)", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const { token } = issueQaCapability(store, runId);
		const res = submitQaPass(store, token, {
			issuerVendor: "codex",
			subjectProducerVendor: "codex",
		});
		expect(res).toEqual({ ok: false, reason: "same_vendor_review" });
	});

	it("review-class claim without a subject producer → rejected", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const { token } = issueQaCapability(store, runId);
		const res = submitQaPass(store, token, {
			subjectProducerExecutionId: undefined,
			subjectProducerVendor: undefined,
		});
		expect(res).toEqual({ ok: false, reason: "missing_subject_producer" });
	});

	it("runner claims MUST carry an expiry (only explicit permanent system claims may omit it)", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const { token } = issueQaCapability(store, runId);
		const res = submitQaPass(store, token, { claimExpiresAt: undefined });
		expect(res).toEqual({ ok: false, reason: "missing_expiry" });
	});
});

describe("appendWorkflowSystemClaim — bridge_policy / founder_challenge claims (plan §2.1/§2.3)", () => {
	it("bridge_policy qa_exempt binds a snapshot digest (NOT a head) and resolves", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const res = store.appendWorkflowSystemClaim({
			issuerKind: "bridge_policy",
			runId,
			issueId: "FLY-1135",
			decisionKind: "qa_policy",
			predicate: "qa_exempt",
			subjectKind: "snapshot_digest",
			subjectDigest: "snap-abc",
			permanent: true,
			authorityId: "policy-qa-exempt-1",
		});
		expect(res.ok).toBe(true);

		const verdict = store.resolveWorkflowDecisionClaim({
			runId,
			decisionKind: "qa_policy",
			subjectKind: "snapshot_digest",
			subjectDigest: "snap-abc",
			now: T0,
		});
		expect(verdict.valid).toBe(true);
	});

	it("founder_approved comes ONLY from founder_challenge; qa_exempt ONLY from bridge_policy", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		expect(
			store.appendWorkflowSystemClaim({
				issuerKind: "founder_challenge",
				runId,
				issueId: "FLY-1135",
				decisionKind: "qa_policy",
				predicate: "qa_exempt",
				subjectKind: "snapshot_digest",
				subjectDigest: "snap-abc",
				permanent: true,
				authorityId: "challenge-1",
			}),
		).toEqual({ ok: false, reason: "predicate_not_allowed_for_issuer" });
		expect(
			store.appendWorkflowSystemClaim({
				issuerKind: "bridge_policy",
				runId,
				issueId: "FLY-1135",
				decisionKind: "founder_decision",
				predicate: "founder_approved",
				subjectKind: "git_head",
				subjectDigest: H1,
				expiresAt: T1H,
				authorityId: "policy-1",
			}),
		).toEqual({ ok: false, reason: "predicate_not_allowed_for_issuer" });
	});

	it("founder_approved must bind a git_head subject", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const res = store.appendWorkflowSystemClaim({
			issuerKind: "founder_challenge",
			runId,
			issueId: "FLY-1135",
			decisionKind: "founder_decision",
			predicate: "founder_approved",
			subjectKind: "snapshot_digest",
			subjectDigest: "snap-abc",
			expiresAt: T1H,
			authorityId: "challenge-1",
		});
		expect(res).toEqual({ ok: false, reason: "subject_kind_invalid" });
	});

	it("system claims require an expiry XOR an explicit permanent marker", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const res = store.appendWorkflowSystemClaim({
			issuerKind: "bridge_policy",
			runId,
			issueId: "FLY-1135",
			decisionKind: "qa_policy",
			predicate: "qa_exempt",
			subjectKind: "snapshot_digest",
			subjectDigest: "snap-abc",
			authorityId: "policy-1",
		});
		expect(res).toEqual({ ok: false, reason: "expiry_or_permanent_required" });
	});
});

describe("resolveWorkflowDecisionClaim — USE-time gate resolution (plan §2.1)", () => {
	it("E2: a PASS bound to H1 does NOT satisfy H2; a new-attempt PASS for H2 does", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const c1 = issueQaCapability(store, runId, 1);
		expect(submitQaPass(store, c1.token).ok).toBe(true); // PASS bound to H1

		// Head moved to H2 — the H1 pass must not carry over.
		const onH2 = store.resolveWorkflowDecisionClaim({
			runId,
			nodeId: "qa",
			decisionKind: "qa_verdict",
			subjectKind: "git_head",
			subjectDigest: H2,
			now: T0,
		});
		expect(onH2).toEqual({ valid: false, reason: "no_claim" });

		// Kickback → new attempt → PASS for H2 → gate opens for H2.
		const c2 = issueQaCapability(store, runId, 2);
		expect(
			submitQaPass(store, c2.token, {
				subjectDigest: H2,
				clientRequestId: "req-2",
			}).ok,
		).toBe(true);
		const verdict = store.resolveWorkflowDecisionClaim({
			runId,
			nodeId: "qa",
			decisionKind: "qa_verdict",
			subjectKind: "git_head",
			subjectDigest: H2,
			now: T0,
		});
		expect(verdict.valid).toBe(true);
	});

	it("NEVER falls back to an older attempt: latest attempt FAILED → refuse, even if an older attempt passed the same subject", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const c1 = issueQaCapability(store, runId, 1);
		expect(submitQaPass(store, c1.token).ok).toBe(true); // attempt 1: PASS for H1
		const c2 = issueQaCapability(store, runId, 2);
		expect(
			submitQaPass(store, c2.token, {
				predicate: "qa_failed",
				clientRequestId: "req-2",
			}).ok,
		).toBe(true); // attempt 2: FAIL for the SAME H1

		const verdict = store.resolveWorkflowDecisionClaim({
			runId,
			nodeId: "qa",
			decisionKind: "qa_verdict",
			subjectKind: "git_head",
			subjectDigest: H1,
			now: T0,
		});
		expect(verdict).toEqual({ valid: false, reason: "not_pass" });
	});

	it("a REVOKED latest claim refuses — and never falls back to the older attempt", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const c1 = issueQaCapability(store, runId, 1);
		expect(submitQaPass(store, c1.token).ok).toBe(true);
		const c2 = issueQaCapability(store, runId, 2);
		const second = submitQaPass(store, c2.token, { clientRequestId: "req-2" });
		expect(second.ok).toBe(true);
		if (!second.ok) return;

		store.revokeWorkflowClaim({
			claimId: second.claimId,
			reason: "founder kickback",
			actor: "bridge",
		});
		const verdict = store.resolveWorkflowDecisionClaim({
			runId,
			nodeId: "qa",
			decisionKind: "qa_verdict",
			subjectKind: "git_head",
			subjectDigest: H1,
			now: T0,
		});
		expect(verdict).toEqual({ valid: false, reason: "revoked" });
	});

	it("an EXPIRED claim refuses at USE time", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const { token } = issueQaCapability(store, runId);
		expect(submitQaPass(store, token).ok).toBe(true); // claim expires T1H
		const verdict = store.resolveWorkflowDecisionClaim({
			runId,
			nodeId: "qa",
			decisionKind: "qa_verdict",
			subjectKind: "git_head",
			subjectDigest: H1,
			now: T2H,
		});
		expect(verdict).toEqual({ valid: false, reason: "expired" });
	});
});

describe("append-only enforcement — the ledger cannot be rewritten", () => {
	it("UPDATE/DELETE on claims, revocations and run events are rejected at the DB layer", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1135-appendonly-"));
		const dbPath = join(dir, "state.db");
		const store = await StateStore.create(dbPath);
		const runId = seedRun(store);
		const { token } = issueQaCapability(store, runId);
		const submitted = submitQaPass(store, token);
		expect(submitted.ok).toBe(true);
		if (!submitted.ok) return;
		// A real revocation row must exist — BEFORE DELETE triggers fire per row,
		// so a DELETE against an empty table would pass vacuously.
		store.revokeWorkflowClaim({
			claimId: submitted.claimId,
			reason: "test",
			actor: "test",
		});
		store.close();

		const raw = new Database(dbPath);
		try {
			expect(() =>
				raw.prepare("UPDATE workflow_claims SET predicate = 'qa_failed'").run(),
			).toThrow(/append-only/);
			expect(() => raw.prepare("DELETE FROM workflow_claims").run()).toThrow(
				/append-only/,
			);
			expect(() =>
				raw.prepare("UPDATE workflow_run_event SET kind = 'x'").run(),
			).toThrow(/append-only/);
			expect(() => raw.prepare("DELETE FROM workflow_run_event").run()).toThrow(
				/append-only/,
			);
			expect(() =>
				raw.prepare("DELETE FROM workflow_claim_revocation").run(),
			).toThrow(/append-only/);
		} finally {
			raw.close();
		}
	});
});

describe("substrate hardening — fail-closed timestamps + identity derivation (research §B.6 / A13)", () => {
	it("issuance rejects a non-finite expires_at (fail-closed, nothing persisted)", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const res = store.issueWorkflowDecisionCapability({
			runId,
			nodeId: "qa",
			executionId: "e",
			attempt: 1,
			allowedPredicateFamily: "qa_verdict",
			expiresAt: "not-a-timestamp",
			absoluteDeadlineAt: T2H,
		});
		expect(res).toEqual({ ok: false, reason: "invalid_timestamp" });
		expect(store.getWorkflowDecisionCapability(1)).toBeUndefined();
	});

	it("issuance rejects a non-finite absolute_deadline_at", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const res = store.issueWorkflowDecisionCapability({
			runId,
			nodeId: "qa",
			executionId: "e",
			attempt: 1,
			allowedPredicateFamily: "qa_verdict",
			expiresAt: T1H,
			absoluteDeadlineAt: "garbage",
		});
		expect(res).toEqual({ ok: false, reason: "invalid_timestamp" });
	});

	it("issuance caps expires_at at the absolute deadline (≤ allowed, beyond refused)", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const beyond = store.issueWorkflowDecisionCapability({
			runId,
			nodeId: "qa",
			executionId: "e",
			attempt: 1,
			allowedPredicateFamily: "qa_verdict",
			expiresAt: T3H, // beyond the T2H absolute deadline
			absoluteDeadlineAt: T2H,
		});
		expect(beyond).toEqual({ ok: false, reason: "expiry_beyond_deadline" });
		// AT the deadline is fine (≤, not <)
		const atDeadline = store.issueWorkflowDecisionCapability({
			runId,
			nodeId: "qa",
			executionId: "e",
			attempt: 1,
			allowedPredicateFamily: "qa_verdict",
			expiresAt: T2H,
			absoluteDeadlineAt: T2H,
		});
		expect(atDeadline.ok).toBe(true);
	});

	it("renewal rejects non-finite timestamps (requested expiry and now)", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const { capabilityId } = issueQaCapability(store, runId);
		expect(
			store.renewWorkflowDecisionCapability({
				capabilityId,
				requestedExpiresAt: "garbage",
				now: T0,
			}),
		).toEqual({ ok: false, reason: "invalid_timestamp" });
		expect(
			store.renewWorkflowDecisionCapability({
				capabilityId,
				requestedExpiresAt: T1H,
				now: "garbage",
			}),
		).toEqual({ ok: false, reason: "invalid_timestamp" });
	});

	it("renewal of a CONSUMED capability is refused (A9 — a spent ticket cannot be revived)", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const { capabilityId, token } = issueQaCapability(store, runId);
		expect(submitQaPass(store, token).ok).toBe(true);
		const res = store.renewWorkflowDecisionCapability({
			capabilityId,
			requestedExpiresAt: T1H,
			now: T0,
		});
		expect(res).toEqual({ ok: false, reason: "capability_consumed" });
	});

	it("renewal of a REVOKED capability is refused (A9 — a superseded ticket stays dead)", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const c1 = issueQaCapability(store, runId, 1);
		issueQaCapability(store, runId, 2); // supersedes + revokes attempt 1
		const res = store.renewWorkflowDecisionCapability({
			capabilityId: c1.capabilityId,
			requestedExpiresAt: T1H,
			now: T0,
		});
		expect(res).toEqual({ ok: false, reason: "capability_revoked" });
	});

	it("submit rejects a non-finite claim expiry (fail-closed, zero residue)", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const { capabilityId, token } = issueQaCapability(store, runId);
		const res = submitQaPass(store, token, { claimExpiresAt: "garbage" });
		expect(res).toEqual({ ok: false, reason: "invalid_timestamp" });
		expect(store.countWorkflowClaims(runId)).toBe(0);
		expect(store.getWorkflowDecisionCapability(capabilityId)?.consumed_at).toBe(
			null,
		);
	});

	it("submit rejects a non-finite now (a malformed clock cannot bypass capability expiry)", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const { token } = issueQaCapability(store, runId);
		const res = submitQaPass(store, token, { now: "garbage" });
		expect(res).toEqual({ ok: false, reason: "invalid_timestamp" });
		expect(store.countWorkflowClaims(runId)).toBe(0);
	});

	it("resolve rejects a non-finite now instead of treating expired claims as live", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const { token } = issueQaCapability(store, runId);
		expect(submitQaPass(store, token).ok).toBe(true); // claim expires T1H
		const verdict = store.resolveWorkflowDecisionClaim({
			runId,
			nodeId: "qa",
			decisionKind: "qa_verdict",
			subjectKind: "git_head",
			subjectDigest: H1,
			now: "garbage",
		});
		expect(verdict).toEqual({ valid: false, reason: "invalid_timestamp" });
	});

	it("system claim rejects a non-finite expiry", async () => {
		const store = await freshStore();
		const runId = seedRun(store);
		const res = store.appendWorkflowSystemClaim({
			issuerKind: "bridge_policy",
			runId,
			issueId: "FLY-1135",
			decisionKind: "qa_policy",
			predicate: "qa_exempt",
			subjectKind: "snapshot_digest",
			subjectDigest: "snap-abc",
			expiresAt: "garbage",
			authorityId: "policy-1",
		});
		expect(res).toEqual({ ok: false, reason: "invalid_timestamp" });
	});

	it("system claim issue identity is derived from the RUN row — a mismatched caller issue_id is refused", async () => {
		const store = await freshStore();
		const runId = seedRun(store); // run row carries issue FLY-1135
		const mismatch = store.appendWorkflowSystemClaim({
			issuerKind: "bridge_policy",
			runId,
			issueId: "FLY-9999",
			decisionKind: "qa_policy",
			predicate: "qa_exempt",
			subjectKind: "snapshot_digest",
			subjectDigest: "snap-abc",
			permanent: true,
			authorityId: "policy-1",
		});
		expect(mismatch).toEqual({ ok: false, reason: "issue_mismatch" });
		expect(store.countWorkflowClaims(runId)).toBe(0);

		const ok = store.appendWorkflowSystemClaim({
			issuerKind: "bridge_policy",
			runId,
			issueId: "FLY-1135",
			decisionKind: "qa_policy",
			predicate: "qa_exempt",
			subjectKind: "snapshot_digest",
			subjectDigest: "snap-abc",
			permanent: true,
			authorityId: "policy-1",
		});
		expect(ok.ok).toBe(true);
		if (!ok.ok) return;
		expect(store.getWorkflowClaim(ok.claimId)?.issue_id).toBe("FLY-1135");
	});
});

describe("workflow flags — three independent DEFAULT-OFF switches (plan §3.2)", () => {
	it("write / read / emergency-legacy flags are default-off and independent", () => {
		expect(isWorkflowClaimsWriteEnabled({})).toBe(false);
		expect(isWorkflowClaimsReadEnabled({})).toBe(false);
		expect(isWorkflowLegacyForced({})).toBe(false);
		expect(
			isWorkflowClaimsWriteEnabled({ FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1" }),
		).toBe(true);
		expect(
			isWorkflowClaimsReadEnabled({ FLYWHEEL_WORKFLOW_CLAIMS_READ: "1" }),
		).toBe(true);
		expect(
			isWorkflowLegacyForced({ FLYWHEEL_WORKFLOW_FORCE_LEGACY: "1" }),
		).toBe(true);
		expect(
			isWorkflowClaimsWriteEnabled({ FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "0" }),
		).toBe(false);
		// enrollment / behavior is never inferred from other flags
		expect(
			isWorkflowClaimsReadEnabled({ FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1" }),
		).toBe(false);
	});
});
