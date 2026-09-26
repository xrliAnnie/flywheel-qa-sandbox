import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

let directory: string;
let path: string;
let store: StateStore;
const startedAt = "2026-09-26T00:00:00.000Z";
const deadline = "2026-09-26T00:01:00.000Z";

beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "review-retirement-"));
	path = join(directory, "state.db");
	store = await StateStore.create(path);
});
afterEach(() => {
	store.close();
	rmSync(directory, { recursive: true, force: true });
});
function insert(requestId = "request", executionId = "execution") {
	store.insertCodexReviewJob({
		requestId,
		executionId,
		projectName: "project",
		reviewType: "design",
		questionId: `question-${requestId}`,
		targetPath: "engineering/plan's draft.md",
	});
}
function start() {
	insert();
	expect(
		store.claimCodexReviewJobRunning("request", { expectedGeneration: 0 }),
	).toBe(true);
	expect(
		store.recordCodexReviewAttemptIntent({
			requestId: "request",
			attemptGeneration: 1,
			reviewerSessionUuid: "reviewer",
			ownerBootId: "boot",
			reviewerStartedAt: startedAt,
			configuredTimeoutMs: 60_000,
		}),
	).toBe(true);
}
function retire() {
	expect(
		store.retireCodexReviewJob({ requestId: "request", expectedGeneration: 1 }),
	).toBe(true);
}

describe("review attempt retirement persistence", () => {
	it("increments claims once and forbids stale completion, failure, session and parser writes", () => {
		start();
		retire();
		expect(store.claimCodexReviewJobRunning("request")).toBe(false);
		expect(
			store.claimCodexReviewJobRunning("request", {
				expectedGeneration: 1,
				explicitRetiredRetry: true,
			}),
		).toBe(false);
		expect(
			store.transitionCodexReviewRecovery({
				requestId: "request",
				attemptGeneration: 1,
				expectedState: "retired",
				state: "ready",
			}),
		).toBe(true);
		expect(
			store.claimCodexReviewJobRunning("request", {
				expectedGeneration: 1,
				explicitRetiredRetry: true,
			}),
		).toBe(true);
		expect(
			store.claimCodexReviewJobRunning("request", {
				expectedGeneration: 1,
				explicitRetiredRetry: true,
			}),
		).toBe(false);
		expect(
			store.completeCodexReviewJob("request", "APPROVED", "[]", undefined, 1),
		).toBe(false);
		expect(
			store.recordCodexReviewJobFailure({
				requestId: "request",
				reason: "quota",
				retryAt: deadline,
				expectedGeneration: 1,
			}).updated,
		).toBe(false);
		expect(store.setCodexReviewJobReviewerSession("request", "old", 1)).toBe(
			false,
		);
		expect(store.markCodexReviewJobTrailingBraceRepaired("request", 1)).toBe(
			false,
		);
		expect(store.getCodexReviewJob("request")).toMatchObject({
			status: "running",
			attempt_generation: 2,
		});
		expect(
			store.completeCodexReviewJob("request", "APPROVED", "[]", undefined, 2),
		).toBe(true);
		const done = store.getCodexReviewJob("request");
		expect(
			store.completeCodexReviewJob(
				"request",
				"CHANGES_REQUESTED",
				"bad",
				undefined,
				2,
			),
		).toBe(false);
		expect(
			store.recordCodexReviewJobFailure({
				requestId: "request",
				reason: "late",
				expectedGeneration: 2,
			}).updated,
		).toBe(false);
		expect(store.getCodexReviewJob("request")).toEqual(done);
	});

	it("retires atomically once while keeping follower gates and immutable notice payloads", async () => {
		start();
		store.insertCodexReviewReuseBinding({
			requestId: "follower",
			sourceRequestId: "request",
			executionId: "other-execution",
			questionId: "other-question",
		});
		const source = store.getCodexReviewJob("request")!;
		retire();
		expect(
			store.retireCodexReviewJob({
				requestId: "request",
				expectedGeneration: 1,
				noticeText: "overwrite",
			}),
		).toBe(false);
		expect(store.getCodexReviewJob("request")).toMatchObject({
			question_id: source.question_id,
			delivery_nonce: source.delivery_nonce,
			status: "failed",
			failure_reason: "bridge_restart_retired",
			attempt_generation: 1,
		});
		expect(store.getCodexReviewReuseBinding("follower")).toMatchObject({
			source_request_id: "request",
			question_id: "other-question",
			retry_required_reason: "bridge_restart_retired",
			source_attempt_generation: 1,
		});
		expect(
			store.getCodexReviewReuseBinding("follower")?.released_at,
		).toBeUndefined();
		expect(
			store.getCodexReviewReuseBinding("follower")?.responded_at,
		).toBeUndefined();
		const notices = store.listPendingReviewRecoveryNotices(10);
		expect(notices).toHaveLength(2);
		expect(notices.find((n) => n.request_id === "follower")).toMatchObject({
			question_id: "other-question",
			execution_id: "other-execution",
			project_name: "project",
			stage: "retired",
			source_request_id: "request",
		});
		expect(
			notices.every(
				(n) =>
					n.text.includes("request-review") && !n.text.includes("overwrite"),
			),
		).toBe(true);
		store.close();
		store = await StateStore.create(path);
		expect(store.listPendingReviewRecoveryNotices(10)).toEqual(notices);
		expect(store.listRedrivableCodexReviewJobs()).toEqual([]);
		expect(store.listScheduledCodexReviewJobs()).toEqual([]);
	});

	it("freezes intent and original deadline across restart and new attempts", async () => {
		start();
		expect(
			store.recordCodexReviewAttemptIntent({
				requestId: "request",
				attemptGeneration: 1,
				reviewerSessionUuid: "changed",
				ownerBootId: "new-boot",
				reviewerStartedAt: deadline,
				configuredTimeoutMs: 999_000,
			}),
		).toBe(false);
		expect(
			store.recordCodexReviewAttemptProcess({
				requestId: "request",
				attemptGeneration: 1,
				reviewerSessionUuid: "reviewer",
				ownerBootId: "wrong",
				pid: 123,
				processStartedAt: "identity",
			}),
		).toBe(false);
		expect(
			store.recordCodexReviewAttemptProcess({
				requestId: "request",
				attemptGeneration: 1,
				reviewerSessionUuid: "reviewer",
				ownerBootId: "boot",
				pid: 123,
				processStartedAt: "identity",
				pgid: 123,
			}),
		).toBe(true);
		retire();
		store.close();
		store = await StateStore.create(path);
		expect(store.getCodexReviewAttempt("request", 1)).toMatchObject({
			reviewer_session_uuid: "reviewer",
			owner_boot_id: "boot",
			reviewer_started_at: startedAt,
			configured_timeout_ms: 60_000,
			deadline_at: deadline,
			pid: 123,
			process_started_at: "identity",
			pgid: 123,
			recovery_state: "retired",
		});
		expect(
			store.recordCodexReviewAttemptProcess({
				requestId: "request",
				attemptGeneration: 1,
				reviewerSessionUuid: "reviewer",
				ownerBootId: "boot",
				pid: 456,
				processStartedAt: "changed",
			}),
		).toBe(false);
		store.transitionCodexReviewRecovery({
			requestId: "request",
			attemptGeneration: 1,
			expectedState: "retired",
			state: "ready",
		});
		store.claimCodexReviewJobRunning("request", {
			expectedGeneration: 1,
			explicitRetiredRetry: true,
		});
		expect(store.getCodexReviewAttempt("request", 1)).toMatchObject({
			deadline_at: deadline,
			pid: 123,
			recovery_state: "resolved",
		});
	});

	it("holds and acts retired notices atomically, then emits ready once without overwriting acted", () => {
		start();
		retire();
		const binding = {
			requestId: "request",
			attemptGeneration: 1,
			stage: "retired" as const,
			questionId: "question-request",
			executionId: "execution",
			projectName: "project",
		};
		expect(
			store.markReviewRecoveryNoticeActed({ ...binding, questionId: "wrong" }),
		).toBe(false);
		expect(
			store.transitionCodexReviewRecovery({
				requestId: "request",
				attemptGeneration: 1,
				expectedState: "retired",
				state: "held",
				nextProbeAt: deadline,
			}),
		).toBe(true);
		expect(
			store.listActionableReviewRecoveryNotices({
				executionId: "execution",
				projectName: "project",
			}),
		).toEqual([]);
		expect(store.markReviewRecoveryNoticeDelivered(binding)).toBe(true);
		expect(
			store.listActionableReviewRecoveryNotices({
				executionId: "execution",
				projectName: "project",
			}),
		).toEqual([]);
		expect(
			store.transitionCodexReviewRecovery({
				requestId: "request",
				attemptGeneration: 1,
				expectedState: "held",
				state: "ready",
			}),
		).toBe(true);
		expect(
			store.transitionCodexReviewRecovery({
				requestId: "request",
				attemptGeneration: 1,
				expectedState: "held",
				state: "ready",
			}),
		).toBe(false);
		expect(store.listPendingReviewRecoveryNotices(10)).toHaveLength(1);
		expect(
			store.listActionableReviewRecoveryNotices({
				executionId: "execution",
				projectName: "project",
			}),
		).toEqual([expect.objectContaining({ stage: "ready" })]);
	});

	it("fails legacy missing intent closed without manufacturing a new deadline", () => {
		insert();
		store.claimCodexReviewJobRunning("request");
		retire();
		expect(store.getCodexReviewAttempt("request", 1)).toMatchObject({
			recovery_state: "operator_required",
		});
		expect(store.getCodexReviewAttempt("request", 1)?.deadline_at).toBeNull();
		expect(
			store.claimCodexReviewJobRunning("request", {
				expectedGeneration: 1,
				explicitRetiredRetry: true,
			}),
		).toBe(false);
	});

	it("lists bounded due attempts with deadline priority and preserves scheduled probe backoff", () => {
		start();
		retire();
		store.transitionCodexReviewRecovery({
			requestId: "request",
			attemptGeneration: 1,
			expectedState: "retired",
			state: "held",
			nextProbeAt: "2026-09-26T00:00:40.000Z",
		});
		expect(
			store.listDueCodexReviewRecoveries({
				now: "2026-09-26T00:00:20.000Z",
				limit: 10,
			}),
		).toEqual([]);
		expect(
			store.listDueCodexReviewRecoveries({
				now: "2026-09-26T00:00:50.000Z",
				limit: 1,
			}),
		).toEqual([expect.objectContaining({ request_id: "request" })]);
		store.transitionCodexReviewRecovery({
			requestId: "request",
			attemptGeneration: 1,
			expectedState: "held",
			state: "held",
			nextProbeAt: "2026-09-26T00:10:00.000Z",
		});
		expect(
			store.listDueCodexReviewRecoveries({ now: deadline, limit: 1 }),
		).toHaveLength(1);
	});

	it("backs off observation errors without consuming the author's retired wake", () => {
		start();
		retire();
		expect(
			store.transitionCodexReviewRecovery({
				requestId: "request",
				attemptGeneration: 1,
				expectedState: "retired",
				state: "retired",
				nextProbeAt: "2026-09-26T00:00:40.000Z",
			}),
		).toBe(true);
		expect(
			store.listDueCodexReviewRecoveries({
				now: "2026-09-26T00:00:20.000Z",
				limit: 10,
			}),
		).toEqual([]);
		expect(
			store.listActionableReviewRecoveryNotices({
				executionId: "execution",
				projectName: "project",
			}),
		).toHaveLength(1);
	});

	it("rolls back retirement and follower flags if notice persistence fails", () => {
		start();
		store.insertCodexReviewReuseBinding({
			requestId: "follower",
			sourceRequestId: "request",
			executionId: "other",
			questionId: "follower-question",
		});
		const raw = new BetterSqlite3(path);
		raw.exec(
			"CREATE TRIGGER reject_review_notice BEFORE INSERT ON review_recovery_notice BEGIN SELECT RAISE(ABORT, 'notice failed'); END",
		);
		try {
			expect(() =>
				store.retireCodexReviewJob({
					requestId: "request",
					expectedGeneration: 1,
				}),
			).toThrow("notice failed");
			expect(store.getCodexReviewJob("request")).toMatchObject({
				status: "running",
				attempt_generation: 1,
			});
			expect(
				store.getCodexReviewAttempt("request", 1)?.recovery_state,
			).toBeNull();
			expect(
				store.getCodexReviewReuseBinding("follower")?.retry_required_reason,
			).toBeUndefined();
			expect(store.listPendingReviewRecoveryNotices()).toEqual([]);
		} finally {
			raw.close();
		}
	});

	it("serializes competing connections so only one explicit retry claims a generation", async () => {
		start();
		retire();
		store.transitionCodexReviewRecovery({
			requestId: "request",
			attemptGeneration: 1,
			expectedState: "retired",
			state: "ready",
		});
		const competitor = await StateStore.create(path);
		try {
			const results = await Promise.all(
				[store, competitor].map((connection) =>
					Promise.resolve().then(() =>
						connection.claimCodexReviewJobRunning("request", {
							expectedGeneration: 1,
							explicitRetiredRetry: true,
						}),
					),
				),
			);
			expect(results.filter(Boolean)).toHaveLength(1);
			expect(competitor.getCodexReviewJob("request")).toMatchObject({
				status: "running",
				attempt_generation: 2,
			});
		} finally {
			competitor.close();
		}
	});

	it("prioritizes expired original deadlines ahead of earlier next-probe timestamps", () => {
		start();
		retire();
		insert("later");
		store.claimCodexReviewJobRunning("later");
		store.recordCodexReviewAttemptIntent({
			requestId: "later",
			attemptGeneration: 1,
			reviewerSessionUuid: "later-session",
			ownerBootId: "boot",
			reviewerStartedAt: startedAt,
			configuredTimeoutMs: 120_000,
		});
		store.retireCodexReviewJob({ requestId: "later", expectedGeneration: 1 });
		store.transitionCodexReviewRecovery({
			requestId: "request",
			attemptGeneration: 1,
			expectedState: "retired",
			state: "held",
			nextProbeAt: "2026-09-26T00:10:00.000Z",
		});
		store.transitionCodexReviewRecovery({
			requestId: "later",
			attemptGeneration: 1,
			expectedState: "retired",
			state: "held",
			nextProbeAt: startedAt,
		});
		expect(
			store.listDueCodexReviewRecoveries({ now: deadline, limit: 1 }),
		).toEqual([expect.objectContaining({ request_id: "request" })]);
	});

	it("replaces a closed session fallback only under its owner fence and preserves the original deadline", () => {
		start();
		store.setCodexReviewJobReviewerSession("request", "reviewer", 1);
		store.recordCodexReviewAttemptProcess({
			requestId: "request",
			attemptGeneration: 1,
			reviewerSessionUuid: "reviewer",
			ownerBootId: "boot",
			pid: 123,
			processStartedAt: "identity",
			pgid: 123,
		});
		const replacement = {
			requestId: "request",
			attemptGeneration: 1,
			expectedSessionUuid: "reviewer",
			newSessionUuid: "fresh",
			ownerBootId: "boot",
		};
		expect(
			store.replaceCodexReviewAttemptSession({
				...replacement,
				expectedSessionUuid: "wrong",
			}),
		).toBe(false);
		expect(
			store.replaceCodexReviewAttemptSession({
				...replacement,
				ownerBootId: "wrong",
			}),
		).toBe(false);
		expect(store.replaceCodexReviewAttemptSession(replacement)).toBe(true);
		expect(store.getCodexReviewAttempt("request", 1)).toMatchObject({
			reviewer_session_uuid: "fresh",
			reviewer_started_at: startedAt,
			configured_timeout_ms: 60_000,
			deadline_at: deadline,
			pid: null,
			process_started_at: null,
			pgid: null,
		});
		expect(store.getCodexReviewJob("request")?.reviewer_session_uuid).toBe(
			"fresh",
		);
		retire();
		expect(
			store.replaceCodexReviewAttemptSession({
				...replacement,
				expectedSessionUuid: "fresh",
				newSessionUuid: "too-late",
			}),
		).toBe(false);
	});

	it("migrates sparse prior schemas idempotently without touching terminal results", async () => {
		store.close();
		rmSync(path);
		const legacy = new BetterSqlite3(path);
		legacy.exec(
			"CREATE TABLE codex_review_job(request_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL,status TEXT NOT NULL); INSERT INTO codex_review_job VALUES ('old','exec','done')",
		);
		legacy.close();
		for (let count = 0; count < 2; count++) {
			store = await StateStore.create(path);
			expect(store.getCodexReviewJob("old")).toMatchObject({
				status: "done",
				attempt_generation: 0,
			});
			expect(
				store.retireCodexReviewJob({ requestId: "old", expectedGeneration: 0 }),
			).toBe(false);
			expect(store.listPendingReviewRecoveryNotices(10)).toEqual([]);
			if (!count) store.close();
		}
	});
});

it("keeps follower notice generations distinct from its later own-lane attempt", () => {
	start();
	store.insertCodexReviewReuseBinding({
		requestId: "follower",
		sourceRequestId: "request",
		executionId: "other",
		questionId: "follower-question",
		targetRepoPath: "/tmp/follower",
	});
	retire();
	store.markReviewRecoveryNoticeActed({
		requestId: "follower",
		attemptGeneration: 1,
		stage: "retired",
		questionId: "follower-question",
		executionId: "other",
		projectName: "project",
	});
	store.releaseCodexReviewReuseBinding({
		requestId: "follower",
		reason: "explicit_retry",
		frozenHeadSha: "a".repeat(40),
	});
	expect(store.claimCodexReviewJobRunning("follower")).toBe(true);
	expect(store.getCodexReviewJob("follower")?.attempt_generation).toBe(2);
	store.recordCodexReviewAttemptIntent({
		requestId: "follower",
		attemptGeneration: 2,
		reviewerSessionUuid: "own-reviewer",
		ownerBootId: "boot2",
		reviewerStartedAt: startedAt,
		configuredTimeoutMs: 60_000,
	});
	store.retireCodexReviewJob({ requestId: "follower", expectedGeneration: 2 });
	expect(
		store.listActionableReviewRecoveryNotices({
			executionId: "other",
			projectName: "project",
		}),
	).toEqual([
		expect.objectContaining({
			request_id: "follower",
			source_request_id: "follower",
			attempt_generation: 2,
			stage: "retired",
			acted_at: null,
		}),
	]);
});

it("advances the persisted probe cursor past slow rows before their deadlines", () => {
	start();
	retire();
	insert("untouched");
	store.claimCodexReviewJobRunning("untouched");
	store.recordCodexReviewAttemptIntent({
		requestId: "untouched",
		attemptGeneration: 1,
		reviewerSessionUuid: "untouched-session",
		ownerBootId: "boot",
		reviewerStartedAt: startedAt,
		configuredTimeoutMs: 120_000,
	});
	store.retireCodexReviewJob({ requestId: "untouched", expectedGeneration: 1, retiredAt: startedAt });
	store.transitionCodexReviewRecovery({
		requestId: "request",
		attemptGeneration: 1,
		expectedState: "retired",
		state: "retired",
		nextProbeAt: "2026-09-26T00:00:05.000Z",
	});
	expect(
		store.listDueCodexReviewRecoveries({
			now: "2026-09-26T00:00:30.000Z",
			limit: 1,
		})[0]?.request_id,
	).toBe("untouched");
});
