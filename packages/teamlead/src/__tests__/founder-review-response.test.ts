import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import {
	computeFounderArtifactDigest,
	createFounderReviewQuestionContent,
} from "flywheel-comm/founder-review";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	classifyFounderReviewReply,
	tryFounderReviewReactionResponse,
	writeTrustedFounderReviewResponse,
} from "../bridge/founder-review-response.js";
import { StateStore } from "../StateStore.js";

const FOUNDER = "123456789012345678";
const ARTIFACTS = [{ path: "review.html", blobSha: "a".repeat(40) }];
const DIGEST = computeFounderArtifactDigest(ARTIFACTS);

describe("trusted founder_review response primitive", () => {
	let dir: string;
	let db: CommDB;
	let store: StateStore;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "fly1758-response-"));
		db = new CommDB(join(dir, "comm.db"));
		store = await StateStore.create(":memory:");
		store.createWorkflowRun({
			runId: "run-1",
			issueId: "FLY-1758",
			projectName: "flywheel",
			claimsReadEnrolled: false,
		});
		store.admitWorkflowExecution({
			runId: "run-1",
			nodeId: "produce",
			executionId: "exec-1",
			attempt: 1,
			family: "review_verdict",
			now: "2026-08-14T00:00:00.000Z",
			expiresAt: "2026-08-14T01:00:00.000Z",
			absoluteDeadlineAt: "2026-08-14T02:00:00.000Z",
		});
	});

	afterEach(() => {
		db.close();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	function open(questionId: string, round: number, delivered: boolean): void {
		db.insertQuestion(
			"exec-1",
			"flywheel-product-lead",
			createFounderReviewQuestionContent({
				round,
				evidence: {
					runId: "run-1",
					founderId: FOUNDER,
					hostedUrl: `https://reports.example/review/${round}`,
					artifacts: ARTIFACTS,
				},
			}),
			{ id: questionId, checkpoint: "founder_review" },
		);
		if (delivered) {
			store.bindFounderReviewCard({
				questionId,
				messageId: `card-${questionId}`,
				runId: "run-1",
				artifactDigest: DIGEST,
				createdAt: `2026-08-14T00:0${round}:00.000Z`,
			});
		}
	}

	it("rejects an old card after a newer round opens and writes feedback only to latest", () => {
		open("q-1", 1, true);
		open("q-2", 2, true);
		expect(
			writeTrustedFounderReviewResponse({
				store,
				db,
				questionId: "q-1",
				executionId: "exec-1",
				fromAgent: FOUNDER,
				founderId: FOUNDER,
				passed: true,
			}),
		).toEqual({ written: false, reason: "stale_round" });
		expect(db.getResponse("q-1")).toBeUndefined();

		expect(
			writeTrustedFounderReviewResponse({
				store,
				db,
				questionId: "q-2",
				executionId: "exec-1",
				fromAgent: FOUNDER,
				founderId: FOUNDER,
				passed: false,
				feedback: "第二节需要更具体",
			}),
		).toEqual({ written: true });
		expect(JSON.parse(db.getResponse("q-2")?.content ?? "{}")).toEqual({
			version: 1,
			passed: false,
			feedback: "第二节需要更具体",
			artifactDigest: DIGEST,
		});
	});

	it("rejects a round whose founder card was never delivered", () => {
		open("q-undelivered", 1, false);
		expect(
			writeTrustedFounderReviewResponse({
				store,
				db,
				questionId: "q-undelivered",
				executionId: "exec-1",
				fromAgent: FOUNDER,
				founderId: FOUNDER,
				passed: true,
			}),
		).toEqual({ written: false, reason: "card_binding_missing" });
	});

	it("accepts founder ✅ only on the latest immutable review card", async () => {
		open("q-1", 1, true);
		open("q-2", 2, true);
		const reactionFetcher = async ({
			messageId,
			emoji,
		}: {
			messageId: string;
			emoji: string;
		}) => ({
			status: 200,
			body: emoji === "✅" ? [{ id: FOUNDER, source: messageId }] : [],
		});
		expect(
			await tryFounderReviewReactionResponse({
				store,
				db,
				questionId: "q-1",
				executionId: "exec-1",
				threadId: "thread-1",
				founderId: FOUNDER,
				reactionFetcher,
			}),
		).toEqual({ written: false, reason: "stale_round" });
		expect(db.getResponse("q-1")).toBeUndefined();

		expect(
			await tryFounderReviewReactionResponse({
				store,
				db,
				questionId: "q-2",
				executionId: "exec-1",
				threadId: "thread-1",
				founderId: FOUNDER,
				reactionFetcher,
			}),
		).toEqual({ written: true });
		expect(JSON.parse(db.getResponse("q-2")?.content ?? "{}")).toMatchObject({
			passed: true,
			artifactDigest: DIGEST,
		});
	});

	it.each(["整体可以，但第二节要改", "approve?", "打回？", ""])(
		"keeps non-protocol card reply %j neutral",
		(text) => {
			expect(classifyFounderReviewReply(text).kind).toBe("neither");
		},
	);

	it("keeps conversational text out of the founder review verdict", () => {
		expect(classifyFounderReviewReply("ok what's next")).toEqual({
			kind: "neither",
		});
	});

	it.each(["approve", "APPROVE", "look good to me", "Look good to me!"])(
		"accepts only the fixed reply-to-card approval protocol: %j",
		(text) => {
			expect(classifyFounderReviewReply(text)).toEqual({ kind: "pass" });
		},
	);

	it.each(["都可以了", "可以了", "通过", "LGTM", "approved"])(
		"does not retain the old approval-word list: %j",
		(text) => {
			expect(classifyFounderReviewReply(text)).toEqual({ kind: "neither" });
		},
	);

	it.each(["打回", "打回。"])(
		"classifies explicit kickback %j without requiring feedback",
		(text) => {
			expect(classifyFounderReviewReply(text)).toEqual({ kind: "kickback" });
		},
	);

	it("keeps a page summary marker out of verdict classification", () => {
		const summary = "【页面意见汇总】FLY-1847\n\n## 第二节\n这里要补一张图 🖼️";
		expect(classifyFounderReviewReply(summary)).toEqual({
			kind: "neither",
		});
	});
});
