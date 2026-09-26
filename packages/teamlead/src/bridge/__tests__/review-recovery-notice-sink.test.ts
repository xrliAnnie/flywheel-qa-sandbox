import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { readGateMarker, writeGateMarker } from "flywheel-comm/gate-marker";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type ReviewRecoveryNotice, StateStore } from "../../StateStore.js";
import { createReviewRecoveryNoticeSink } from "../review-recovery-notice-sink.js";

let dir: string;
let store: StateStore;
let db: CommDB;
let notice: ReviewRecoveryNotice;
let pid = 123;
const id = "review-recovery:R:1:retired";
const signal = () => new AbortController().signal;
function sink(path = join(dir, "comm.db")) {
	return createReviewRecoveryNoticeSink({
		store,
		commDbPathFor: () => path,
		resolveOwningLead: () => "engineering-lead",
		provenance: () => ({ writerPid: pid, writerStart: `bridge-${pid}` }),
		markerDir: join(dir, "markers"),
	});
}
beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "review-notice-sink-"));
	store = await StateStore.create(join(dir, "state.db"));
	db = new CommDB(join(dir, "comm.db"));
	pid = 123;
	store.upsertSession({
		execution_id: "author",
		issue_id: "FLY-test",
		project_name: "p",
		status: "running",
	});
	db.registerSession("author", "window", "p");
	const q = db.insertQuestion("author", "engineering-lead", "review", {
		checkpoint: "review_code",
	});
	store.insertCodexReviewJob({
		requestId: "R",
		executionId: "author",
		projectName: "p",
		questionId: q,
		reviewType: "code",
	});
	store.claimCodexReviewJobRunning("R");
	store.recordCodexReviewAttemptIntent({
		requestId: "R",
		attemptGeneration: 1,
		reviewerSessionUuid: "reviewer-uuid",
		ownerBootId: "old-boot",
		reviewerStartedAt: "2026-09-26T00:00:00.000Z",
		configuredTimeoutMs: 60_000,
	});
	store.retireCodexReviewJob({ requestId: "R", expectedGeneration: 1 });
	notice = store.listPendingReviewRecoveryNotices()[0]!;
	writeGateMarker(join(dir, "markers"), {
		questionId: q,
		executionId: "author",
		backend: "codex-tmux",
		vendor: "codex",
		checkpoint: "review_code",
	});
});
afterEach(() => {
	db.close();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

it("queues once across crash-before-source-stamp and Bridge provenance changes; ACK is not acted", async () => {
	await expect(sink().deliver(notice, signal())).resolves.toEqual({
		accepted: true,
	});
	pid = 456;
	await expect(sink().deliver(notice, signal())).resolves.toEqual({
		accepted: true,
	});
	const rows = db.listRunnerDeliveryProjectionRows().filter((r) => r.id === id);
	expect(rows).toHaveLength(1);
	expect(db.getMessageById(id)).toMatchObject({
		from_agent: "bridge",
		to_agent: "author",
		writer_pid: 123,
		writer_start: "bridge-123",
	});
	expect(store.listPendingReviewRecoveryNotices()).toHaveLength(1);
	db.markInstructionRead(id);
	expect(db.readActionableReviewRecovery("author", "p")).toMatchObject({ id });
	expect(db.getResponse(notice.question_id)).toBeUndefined();
	expect(
		readGateMarker(join(dir, "markers"), notice.question_id),
	).not.toHaveProperty("recoveryNoticeId");
	expect(
		readGateMarker(join(dir, "markers"), notice.question_id)?.answeredAt,
	).toBeUndefined();
});

it("leaves initial DB failure retryable and accepts the next pass", async () => {
	await expect(
		sink(join(dir, "missing", "comm.db")).deliver(notice, signal()),
	).rejects.toThrow();
	expect(store.listPendingReviewRecoveryNotices()).toHaveLength(1);
	await expect(sink().deliver(notice, signal())).resolves.toEqual({
		accepted: true,
	});
	expect(db.getMessageById(id)).toBeDefined();
});

it("rejects changed persisted binding and text without enqueue", async () => {
	for (const altered of [
		{ execution_id: "intruder" },
		{ project_name: "other" },
		{ text: "forged" },
		{ attempt_generation: 2 },
	]) {
		await expect(
			sink().deliver({ ...notice, ...altered }, signal()),
		).resolves.toEqual({ accepted: false });
	}
	expect(db.getMessageById(id)).toBeUndefined();
});

it("accepts a late final-gate notice without waking or answering another gate", async () => {
	const other = db.insertQuestion("author", "engineering-lead", "approval", {
		checkpoint: "approve",
	});
	db.insertResponse(notice.question_id, "engineering-lead", "APPROVED");
	await expect(sink().deliver(notice, signal())).resolves.toEqual({
		accepted: true,
	});
	expect(db.getMessageById(id)).toBeUndefined();
	expect(store.listPendingReviewRecoveryNotices()).toHaveLength(0);
	expect(db.getResponse(other)).toBeUndefined();
});

it("rejects a real gate owned by another author", async () => {
	const other = db.insertQuestion("intruder", "engineering-lead", "review", {
		checkpoint: "review_code",
	});
	store.insertCodexReviewJob({
		requestId: "wrong",
		executionId: "author",
		projectName: "p",
		questionId: other,
		reviewType: "code",
	});
	store.claimCodexReviewJobRunning("wrong");
	store.retireCodexReviewJob({ requestId: "wrong", expectedGeneration: 1 });
	const wrong = store
		.listPendingReviewRecoveryNotices()
		.find((n) => n.request_id === "wrong")!;
	await expect(sink().deliver(wrong, signal())).resolves.toEqual({
		accepted: false,
	});
	expect(
		db.getMessageById("review-recovery:wrong:1:operator_required"),
	).toBeUndefined();
});

it("forwards a terminal author's notice once to the owning Lead", async () => {
	store.upsertSession({
		execution_id: "author",
		issue_id: "FLY-test",
		project_name: "p",
		status: "completed",
	});
	db.updateSessionStatus("author", "completed");
	await sink().deliver(notice, signal());
	pid = 456;
	await sink().deliver(notice, signal());
	expect(db.getMessageById(id)).toBeUndefined();
	expect(db.getMessageById(`${id}:lead`)).toMatchObject({
		to_agent: "engineering-lead",
		from_agent: "bridge",
		writer_pid: 123,
	});
});

it("forwards a former workflow holder without waking the old body", async () => {
	store.createWorkflowRun({
		runId: "run",
		issueId: "FLY-test",
		projectName: "p",
	});
	store.upsertWorkflowRunNode({
		runId: "run",
		nodeId: "implement",
		attempt: 1,
		state: "done",
		executionId: "author",
	});
	store.upsertWorkflowRunNode({
		runId: "run",
		nodeId: "implement",
		attempt: 2,
		state: "running",
		executionId: "replacement",
	});
	await sink().deliver(notice, signal());
	expect(db.getMessageById(id)).toBeUndefined();
	expect(db.getMessageById(`${id}:lead`)).toBeDefined();
});

it("sends operator_required once with immutable identity, original budget and evidence needed", async () => {
	store.transitionCodexReviewRecovery({
		requestId: "R",
		attemptGeneration: 1,
		expectedState: "retired",
		state: "operator_required",
		noticeText: "identity_unknown",
	});
	const operator = store.listPendingReviewRecoveryNotices()[0]!;
	const operatorId = "review-recovery:R:1:operator_required";
	await sink().deliver(operator, signal());
	pid = 456;
	await sink().deliver(operator, signal());
	const forwarded = db.getMessageById(`${operatorId}:lead`)!;
	expect(forwarded.to_agent).toBe("engineering-lead");
	for (const evidence of [
		"R",
		notice.question_id,
		"reviewer-uuid",
		"60000",
		"2026-09-26T00:01:00.000Z",
		"identity_unknown",
		"Evidence required",
	])
		expect(forwarded.content).toContain(evidence);
	expect(db.getMessageById(operatorId)).toBeDefined();
});

it("synchronizes acted only from persisted source acceptance", async () => {
	await sink().deliver(notice, signal());
	sink().markActed({ ...notice, acted_at: new Date().toISOString() });
	expect(db.readActionableReviewRecovery("author", "p")).not.toBeNull();
	store.markReviewRecoveryNoticeActed({
		requestId: "R",
		attemptGeneration: 1,
		stage: "retired",
		questionId: notice.question_id,
		executionId: "author",
		projectName: "p",
	});
	sink().markActed(notice);
	expect(db.readActionableReviewRecovery("author", "p")).toBeNull();
});

it("does nothing for an aborted delivery", async () => {
	const abort = new AbortController();
	abort.abort();
	await expect(sink().deliver(notice, abort.signal)).resolves.toEqual({
		accepted: false,
	});
	expect(db.getMessageById(id)).toBeUndefined();
	expect(store.listPendingReviewRecoveryNotices()).toHaveLength(1);
});

it("still forwards operator evidence after a final gate without waking the author", async () => {
	store.transitionCodexReviewRecovery({
		requestId: "R",
		attemptGeneration: 1,
		expectedState: "retired",
		state: "operator_required",
		noticeText: "post_signal_unknown",
	});
	const operator = store.listPendingReviewRecoveryNotices()[0]!;
	db.insertResponse(notice.question_id, "engineering-lead", "APPROVED");
	await sink().deliver(operator, signal());
	expect(
		db.getMessageById("review-recovery:R:1:operator_required:lead"),
	).toBeDefined();
	expect(
		db.getMessageById("review-recovery:R:1:operator_required"),
	).toBeUndefined();
});

it("forwards a missing follower through its source session and keeps the source gate open", async () => {
	const q = db.insertQuestion(
		"missing-follower",
		"engineering-lead",
		"review",
		{ checkpoint: "review_code" },
	);
	store.insertCodexReviewJob({
		requestId: "source-follow",
		executionId: "author",
		projectName: "p",
		questionId: notice.question_id,
		reviewType: "code",
	});
	store.claimCodexReviewJobRunning("source-follow");
	store.recordCodexReviewAttemptIntent({
		requestId: "source-follow",
		attemptGeneration: 1,
		reviewerSessionUuid: "follower-reviewer",
		ownerBootId: "old-boot",
		reviewerStartedAt: "2026-09-26T00:00:00.000Z",
		configuredTimeoutMs: 60_000,
	});
	store.insertCodexReviewReuseBinding({
		requestId: "follower",
		sourceRequestId: "source-follow",
		executionId: "missing-follower",
		questionId: q,
	});
	store.retireCodexReviewJob({
		requestId: "source-follow",
		expectedGeneration: 1,
	});
	const follower = store
		.listPendingReviewRecoveryNotices()
		.find((n) => n.request_id === "follower")!;
	const routed: string[] = [];
	const delivery = createReviewRecoveryNoticeSink({
		store,
		commDbPathFor: () => join(dir, "comm.db"),
		resolveOwningLead: (session) => {
			routed.push(session.execution_id);
			return "engineering-lead";
		},
		provenance: () => ({ writerPid: 123, writerStart: "bridge-123" }),
	});
	await expect(delivery.deliver(follower, signal())).resolves.toEqual({
		accepted: true,
	});
	expect(routed).toEqual(["author"]);
	expect(
		db.getMessageById("review-recovery:follower:1:retired:lead"),
	).toBeDefined();
	expect(
		db.getMessageById("review-recovery:follower:1:retired"),
	).toBeUndefined();
	expect(db.getResponse(notice.question_id)).toBeUndefined();
});
it("withdraws an already queued author projection when the holder changes before replay", async () => {
	await sink().deliver(notice, signal());
	expect(db.readActionableReviewRecovery("author", "p")).not.toBeNull();
	store.createWorkflowRun({
		runId: "run",
		issueId: "FLY-test",
		projectName: "p",
	});
	store.upsertWorkflowRunNode({
		runId: "run",
		nodeId: "implement",
		attempt: 1,
		state: "done",
		executionId: "author",
	});
	store.upsertWorkflowRunNode({
		runId: "run",
		nodeId: "implement",
		attempt: 2,
		state: "running",
		executionId: "replacement",
	});
	await sink().deliver(notice, signal());
	expect(db.readActionableReviewRecovery("author", "p")).toBeNull();
	expect(db.getMessageById(`${id}:lead`)).toBeDefined();
	const queue = new MailboxQueue(join(dir, "comm.db"));
	try {
		expect(queue.getById(id)?.state).toBe("DEAD");
	} finally {
		queue.close();
	}
});
