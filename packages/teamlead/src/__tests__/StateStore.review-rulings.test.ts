import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { findingFingerprint } from "../bridge/review-verdict-policy.js";
import { StateStore } from "../StateStore.js";

const ISSUE_UUID = "11111111-1111-4111-8111-111111111111";

describe("StateStore — FLY-1278 review finding rulings", () => {
	let store: StateStore;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		register("e1", ISSUE_UUID, "FLY-1278");
	});

	it("records only a delivered finding and derives its audit snapshot server-side", () => {
		deliver("req-1", "e1", [
			{
				id: "metadata-lease",
				severity: "MEDIUM",
				file: "lease.ts",
				title: "Add a short lease",
			},
		]);
		const result = store.recordReviewFindingRuling({
			projectName: "proj",
			issue: "FLY-1278",
			findingKey: "metadata-lease",
			disposition: "follow_up",
			followUpIssue: "FLY-1274",
			rationale: "Authorization correctness wins; optimize separately.",
			ruledBy: "flywheel-eng-lead",
			executionId: "lead-exec",
		});

		expect(result.status).toBe("created");
		expect(result.ruling).toMatchObject({
			project_name: "proj",
			issue_id_canonical: ISSUE_UUID,
			issue_identifier: "FLY-1278",
			finding_key: "metadata-lease",
			source_request_id: "req-1",
			source_finding_index: 0,
			finding_title: "Add a short lease",
			finding_severity: "MEDIUM",
			review_type: "code",
			disposition: "follow_up",
			follow_up_issue: "FLY-1274",
		});
	});

	it("rejects an undelivered or unknown finding", () => {
		insertJob("req-pending", "e1", [{ id: "not-delivered" }], false);
		for (const findingKey of ["not-delivered", "missing"]) {
			const result = store.recordReviewFindingRuling({
				projectName: "proj",
				issue: ISSUE_UUID,
				findingKey,
				disposition: "overruled",
				rationale: "Not applicable.",
				ruledBy: "lead",
			});
			expect(result.status).toBe("finding_not_found");
		}
	});

	it("supports exact request-id + finding-index lookup when no stable id exists", () => {
		const finding = {
			severity: "LOW",
			file: "a.ts",
			title: "Naming suggestion",
		};
		deliver("req-1", "e1", [finding]);
		const result = store.recordReviewFindingRuling({
			projectName: "proj",
			issue: ISSUE_UUID,
			requestId: "req-1",
			findingIndex: 0,
			disposition: "overruled",
			rationale: "Current name follows the public API.",
			ruledBy: "lead",
		});

		expect(result.status).toBe("created");
		expect(result.ruling?.finding_key).toBe(
			findingFingerprint(finding.file, finding.title),
		);
	});

	it("is idempotent for the same semantic ruling and conflicts on changed intent", () => {
		deliver("req-1", "e1", [{ id: "same", severity: "HIGH", title: "Risk" }]);
		const input = {
			projectName: "proj",
			issue: "FLY-1278",
			findingKey: "same",
			disposition: "overruled" as const,
			rationale: "Lead accepts the risk with external evidence.",
			ruledBy: "lead",
		};
		const first = store.recordReviewFindingRuling(input);
		const replay = store.recordReviewFindingRuling(input);
		const conflict = store.recordReviewFindingRuling({
			...input,
			rationale: "A different governance intent.",
		});

		expect(first.status).toBe("created");
		expect(replay.status).toBe("idempotent");
		expect(replay.ruling?.ruling_id).toBe(first.ruling?.ruling_id);
		expect(conflict.status).toBe("conflict");
		expect(
			store.listActiveReviewFindingRulings("proj", ISSUE_UUID),
		).toHaveLength(1);
	});

	it("fails closed when one finding key spans design and code candidates", () => {
		deliver("req-code", "e1", [{ id: "same-key", title: "Code" }], "code");
		deliver("req-design", "e1", [{ id: "same-key", title: "Plan" }], "design");
		const result = store.recordReviewFindingRuling({
			projectName: "proj",
			issue: "FLY-1278",
			findingKey: "same-key",
			disposition: "overruled",
			rationale: "Ambiguous on purpose.",
			ruledBy: "lead",
		});
		expect(result.status).toBe("finding_ambiguous");
	});

	it("shares a ruling across UUID/identifier executions and survives cluster evolution", async () => {
		const legacy = await StateStore.create(":memory:");
		legacy.upsertSession({
			execution_id: "old",
			issue_id: "FLY-1278",
			project_name: "proj",
			status: "running",
		});
		insertDelivered(legacy, "req-old", "old", "FLY-1278", [
			{ id: "stable", severity: "MEDIUM", title: "Optimize" },
		]);
		const first = legacy.recordReviewFindingRuling({
			projectName: "proj",
			issue: "FLY-1278",
			findingKey: "stable",
			disposition: "follow_up",
			followUpIssue: "FLY-1274",
			rationale: "Later.",
			ruledBy: "lead",
		});
		expect(first.ruling?.issue_id_canonical).toBe("FLY-1278");

		legacy.upsertSession({
			execution_id: "new",
			issue_id: ISSUE_UUID,
			issue_identifier: "FLY-1278",
			project_name: "proj",
			status: "running",
		});
		insertDelivered(legacy, "req-new", "new", ISSUE_UUID, [
			{ id: "stable", severity: "MEDIUM", title: "Optimize" },
		]);
		const replay = legacy.recordReviewFindingRuling({
			projectName: "proj",
			issue: ISSUE_UUID,
			findingKey: "stable",
			disposition: "follow_up",
			followUpIssue: "FLY-1274",
			rationale: "Later.",
			ruledBy: "lead",
		});

		expect(replay.status).toBe("idempotent");
		expect(replay.ruling?.ruling_id).toBe(first.ruling?.ruling_id);
		expect(
			legacy.listActiveReviewFindingRulings("proj", ISSUE_UUID),
		).toHaveLength(1);
	});

	it("revokes without deleting audit history and makes the finding active again", () => {
		deliver("req-1", "e1", [{ id: "risk", severity: "HIGH", title: "Risk" }]);
		const created = store.recordReviewFindingRuling({
			projectName: "proj",
			issue: "FLY-1278",
			findingKey: "risk",
			disposition: "overruled",
			rationale: "Evidence says safe.",
			ruledBy: "lead",
		});
		const revoked = store.revokeReviewFindingRuling({
			projectName: "proj",
			rulingId: created.ruling?.ruling_id ?? "",
			revokedBy: "lead-2",
			reason: "New evidence invalidated the ruling.",
		});

		expect(revoked).toMatchObject({
			revoked_by: "lead-2",
			revoke_reason: "New evidence invalidated the ruling.",
		});
		expect(revoked?.revoked_at).toBeTruthy();
		expect(store.listActiveReviewFindingRulings("proj", ISSUE_UUID)).toEqual(
			[],
		);
	});

	it("never exposes or revokes a ruling through a different project scope", () => {
		deliver("req-1", "e1", [{ id: "risk", severity: "HIGH" }]);
		const created = store.recordReviewFindingRuling({
			projectName: "proj",
			issue: "FLY-1278",
			findingKey: "risk",
			disposition: "overruled",
			rationale: "Evidence says safe.",
			ruledBy: "lead",
		});
		const wrongProject = store.revokeReviewFindingRuling({
			projectName: "other-project",
			rulingId: created.ruling?.ruling_id ?? "",
			revokedBy: "other-lead",
			reason: "Cross-project attempt.",
		});

		expect(wrongProject).toBeNull();
		expect(
			store.listActiveReviewFindingRulings("proj", ISSUE_UUID),
		).toHaveLength(1);
	});

	it("tracks pending Discord notification delivery separately from authority", () => {
		deliver("req-1", "e1", [{ id: "notify", severity: "LOW" }]);
		const created = store.recordReviewFindingRuling({
			projectName: "proj",
			issue: "FLY-1278",
			findingKey: "notify",
			disposition: "overruled",
			rationale: "No action.",
			ruledBy: "lead",
		});

		expect(store.listPendingReviewRulingNotifications()).toHaveLength(1);
		store.markReviewFindingRulingNotified(created.ruling?.ruling_id ?? "");
		expect(store.listPendingReviewRulingNotifications()).toEqual([]);
		expect(
			store.listActiveReviewFindingRulings("proj", "FLY-1278")[0]?.notified_at,
		).toBeTruthy();
	});

	it("reopens an already-migrated database without schema drift", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fly1278-ruling-migration-"));
		const path = join(dir, "state.db");
		try {
			const first = await StateStore.create(path);
			first.close();
			const reopened = await StateStore.create(path);
			reopened.upsertSession({
				execution_id: "reopened",
				issue_id: "FLY-1278",
				project_name: "proj",
				status: "running",
			});
			insertDelivered(reopened, "req-reopened", "reopened", "FLY-1278", [
				{ id: "stable", severity: "MEDIUM" },
			]);
			expect(
				reopened.recordReviewFindingRuling({
					projectName: "proj",
					issue: "FLY-1278",
					findingKey: "stable",
					disposition: "overruled",
					rationale: "Migration stayed idempotent.",
					ruledBy: "lead",
				}).status,
			).toBe("created");
			reopened.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function register(execId: string, issueId: string, identifier?: string) {
		store.upsertSession({
			execution_id: execId,
			issue_id: issueId,
			...(identifier ? { issue_identifier: identifier } : {}),
			project_name: "proj",
			status: "running",
		});
	}

	function deliver(
		requestId: string,
		execId: string,
		findings: Record<string, unknown>[],
		reviewType: "design" | "code" = "code",
	) {
		insertJob(requestId, execId, findings, true, reviewType);
	}

	function insertJob(
		requestId: string,
		execId: string,
		findings: Record<string, unknown>[],
		delivered: boolean,
		reviewType: "design" | "code" = "code",
	) {
		insertDelivered(store, requestId, execId, ISSUE_UUID, findings, {
			delivered,
			reviewType,
		});
	}
});

function insertDelivered(
	store: StateStore,
	requestId: string,
	execId: string,
	issueId: string,
	findings: Record<string, unknown>[],
	opts: { delivered?: boolean; reviewType?: "design" | "code" } = {},
) {
	store.insertCodexReviewJob({
		requestId,
		executionId: execId,
		issueId,
		projectName: "proj",
		reviewType: opts.reviewType ?? "code",
		questionId: `q-${requestId}`,
	});
	store.claimCodexReviewJobRunning(requestId);
	store.completeCodexReviewJob(
		requestId,
		"CHANGES_REQUESTED",
		JSON.stringify(findings),
	);
	if (opts.delivered !== false) store.stampCodexReviewJobResponded(requestId);
}
