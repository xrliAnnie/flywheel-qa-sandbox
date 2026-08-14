import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gate } from "../commands/gate.js";
import { CommDB } from "../db.js";
import {
	computeFounderArtifactDigest,
	createFounderReviewStateReader,
	type FounderReviewRoundLocator,
	resolveFounderReviewVerdictFromReader,
} from "../founder-review.js";
import { MailboxQueue } from "../mailbox-queue.js";

const FOUNDER_ID = "123456789012345678";
const ARTIFACTS = [
	{ path: "product/doc/FLY-1758/prd.html", blobSha: "a".repeat(40) },
];
const DIGEST = computeFounderArtifactDigest(ARTIFACTS);

describe("FounderReviewStateReader live + archive contract", () => {
	let dir: string;
	let dbPath: string;
	const runByExecution = new Map([["exec-1758", "run-1758"]]);
	const bindings: Array<{
		questionId: string;
		runId: string;
		artifactDigest: string;
	}> = [];
	let locator: FounderReviewRoundLocator;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly1758-reader-"));
		dbPath = join(dir, "comm.db");
		bindings.length = 0;
		locator = {
			listDeliveredRoundsForRun: (runId) =>
				bindings.filter((binding) => binding.runId === runId),
			getExecutionRunId: (executionId) => runByExecution.get(executionId),
		};
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	async function openRound(): Promise<string> {
		const result = await gate({
			checkpoint: "founder_review",
			lead: "flywheel-product-lead",
			execId: "exec-1758",
			message: "PRD-HTML ready",
			dbPath,
			timeoutMs: 172_800_000,
			timeoutBehavior: "fail-close",
			cleanupTtlHours: 24,
			noBlock: true,
			founderReviewEvidence: {
				runId: "run-1758",
				founderId: FOUNDER_ID,
				hostedUrl: "https://reports.example/FLY-1758/prd",
				artifacts: ARTIFACTS,
			},
		});
		return result.questionId as string;
	}

	function verdict(db: CommDB) {
		return resolveFounderReviewVerdictFromReader({
			reader: createFounderReviewStateReader({ db, locator }),
			runId: "run-1758",
			authoritativeArtifactDigest: DIGEST,
			founderId: FOUNDER_ID,
		});
	}

	it("keeps a delivered trusted pass authoritative after the family is archived", async () => {
		const questionId = await openRound();
		const db = new CommDB(dbPath);
		try {
			bindings.push({ questionId, runId: "run-1758", artifactDigest: DIGEST });
			expect(
				db.insertFounderReviewResponseIfGateOpen({
					questionId,
					fromAgent: FOUNDER_ID,
					founderId: FOUNDER_ID,
					expectedOwner: "exec-1758",
					passed: true,
				}),
			).toBe(true);
			expect(verdict(db)).toMatchObject({ status: "passed", questionId });
			db.consumeGateResponse(questionId, "exec-1758");
			db.resolveGate(questionId, 0);
		} finally {
			db.close();
		}

		const raw = new Database(dbPath);
		const queue = new MailboxQueue(raw);
		try {
			expect(
				queue.archiveFamily({
					id: questionId,
					now: "2030-01-01T00:00:00.000Z",
					retentionMs: 0,
				}),
			).toBe("archived");
		} finally {
			queue.close();
			raw.close();
		}

		const archivedDb = CommDB.openReadonly(dbPath);
		try {
			expect(archivedDb.getMessageById(questionId)).toBeUndefined();
			expect(verdict(archivedDb)).toMatchObject({
				status: "passed",
				questionId,
			});
		} finally {
			archivedDb.close();
		}
	});

	it("lets a newer live pending round block an older archived pass", async () => {
		const passedId = await openRound();
		let db = new CommDB(dbPath);
		bindings.push({
			questionId: passedId,
			runId: "run-1758",
			artifactDigest: DIGEST,
		});
		db.insertFounderReviewResponseIfGateOpen({
			questionId: passedId,
			fromAgent: FOUNDER_ID,
			founderId: FOUNDER_ID,
			expectedOwner: "exec-1758",
			passed: true,
		});
		db.consumeGateResponse(passedId, "exec-1758");
		db.resolveGate(passedId, 0);
		db.close();
		const raw = new Database(dbPath);
		const queue = new MailboxQueue(raw);
		queue.archiveFamily({
			id: passedId,
			now: "2030-01-01T00:00:00.000Z",
			retentionMs: 0,
		});
		queue.close();
		raw.close();

		const pendingId = await openRound();
		db = CommDB.openReadonly(dbPath);
		try {
			expect(verdict(db)).toEqual({
				status: "not_passed",
				questionId: pendingId,
				reason: "response_missing",
			});
		} finally {
			db.close();
		}
	});

	it("never authorizes a response whose review card was not delivered", async () => {
		const questionId = await openRound();
		const db = new CommDB(dbPath);
		try {
			db.insertFounderReviewResponseIfGateOpen({
				questionId,
				fromAgent: FOUNDER_ID,
				founderId: FOUNDER_ID,
				expectedOwner: "exec-1758",
				passed: true,
			});
			expect(verdict(db)).toEqual({
				status: "not_passed",
				questionId,
				reason: "response_missing",
			});
		} finally {
			db.close();
		}
	});
});
