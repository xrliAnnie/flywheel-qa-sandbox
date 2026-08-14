import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import {
	computeFounderArtifactDigest,
	createFounderReviewQuestionContent,
	resolveFounderReviewVerdictFromReader,
} from "flywheel-comm/founder-review";
import { createReadonlySqliteFounderReviewStateReader } from "flywheel-comm/founder-review-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStateStoreFounderReviewStateReader } from "../bridge/founder-review-state.js";
import { StateStore } from "../StateStore.js";

const FOUNDER_ID = "123456789012345678";
const ARTIFACTS = [
	{ path: "product/doc/FLY-1758/prd.html", blobSha: "a".repeat(40) },
];
const DIGEST = computeFounderArtifactDigest(ARTIFACTS);

describe("founder review StateStore and readonly SQLite adapters", () => {
	let dir: string;
	let stateDbPath: string;
	let commDbPath: string;
	let store: StateStore;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "fly1758-adapters-"));
		stateDbPath = join(dir, "state.db");
		commDbPath = join(dir, "comm.db");
		store = await StateStore.create(stateDbPath);
		store.createWorkflowRun({
			runId: "run-1758",
			issueId: "FLY-1758",
			projectName: "flywheel",
			claimsReadEnrolled: false,
		});
		expect(
			store.admitWorkflowExecution({
				runId: "run-1758",
				nodeId: "produce",
				executionId: "exec-1758",
				attempt: 1,
				family: "review_verdict",
				now: "2026-08-14T00:00:00.000Z",
				expiresAt: "2026-08-14T01:00:00.000Z",
				absoluteDeadlineAt: "2026-08-14T02:00:00.000Z",
			}),
		).toMatchObject({ ok: true });
	});

	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns the same pass, cross-run isolation, and digest drift verdict", async () => {
		const commDb = new CommDB(commDbPath);
		const questionId = commDb.insertQuestion(
			"exec-1758",
			"flywheel-product-lead",
			createFounderReviewQuestionContent({
				round: 1,
				evidence: {
					runId: "run-1758",
					founderId: FOUNDER_ID,
					hostedUrl: "https://reports.example/FLY-1758/prd",
					artifacts: ARTIFACTS,
				},
			}),
			{ checkpoint: "founder_review" },
		);
		store.bindFounderReviewCard({
			questionId,
			messageId: "discord-card-1758",
			runId: "run-1758",
			artifactDigest: DIGEST,
			createdAt: "2026-08-14T00:10:00.000Z",
		});
		try {
			commDb.insertFounderReviewResponseIfGateOpen({
				questionId,
				fromAgent: FOUNDER_ID,
				founderId: FOUNDER_ID,
				expectedOwner: "exec-1758",
				passed: true,
			});
			const stateStoreReader = createStateStoreFounderReviewStateReader({
				store,
				commDb,
			});
			const sqlite = createReadonlySqliteFounderReviewStateReader({
				stateDbPath,
				commDbPath,
			});
			try {
				for (const reader of [stateStoreReader, sqlite.reader]) {
					expect(
						resolveFounderReviewVerdictFromReader({
							reader,
							runId: "run-1758",
							authoritativeArtifactDigest: DIGEST,
							founderId: FOUNDER_ID,
						}),
					).toMatchObject({ status: "passed", questionId });
					expect(
						resolveFounderReviewVerdictFromReader({
							reader,
							runId: "other-run",
							authoritativeArtifactDigest: DIGEST,
							founderId: FOUNDER_ID,
						}),
					).toMatchObject({ status: "missing" });
					expect(
						resolveFounderReviewVerdictFromReader({
							reader,
							runId: "run-1758",
							authoritativeArtifactDigest: "b".repeat(64),
							founderId: FOUNDER_ID,
						}),
					).toMatchObject({ status: "stale_artifact", questionId });
				}
			} finally {
				sqlite.close();
			}
		} finally {
			commDb.close();
		}
	});
});
