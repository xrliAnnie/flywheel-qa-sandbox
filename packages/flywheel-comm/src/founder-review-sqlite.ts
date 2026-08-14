import Database from "better-sqlite3";
import { CommDB } from "./db.js";
import {
	createFounderReviewStateReader,
	type FounderReviewRoundLocator,
	type FounderReviewStateReader,
} from "./founder-review.js";

export interface CloseableFounderReviewStateReader {
	reader: FounderReviewStateReader;
	close(): void;
}

/** Read-only CLI adapter over the Bridge StateStore and project CommDB files. */
export function createReadonlySqliteFounderReviewStateReader(input: {
	stateDbPath: string;
	commDbPath: string;
}): CloseableFounderReviewStateReader {
	const stateDb = new Database(input.stateDbPath, { readonly: true });
	let commDb: CommDB | undefined;
	try {
		stateDb.pragma("busy_timeout = 5000");
		commDb = CommDB.openReadonly(input.commDbPath);
		const locator: FounderReviewRoundLocator = {
			listDeliveredRoundsForRun(runId) {
				return stateDb
					.prepare(
						`SELECT question_id AS questionId, run_id AS runId,
						        artifact_digest AS artifactDigest
						   FROM founder_review_card_binding
						  WHERE run_id = ? ORDER BY created_at, question_id`,
					)
					.all(runId) as Array<{
					questionId: string;
					runId: string;
					artifactDigest: string;
				}>;
			},
			getExecutionRunId(executionId) {
				const rows = stateDb
					.prepare(
						`SELECT run_id FROM workflow_execution_binding
						  WHERE execution_id = ? ORDER BY bound_at, activation_id`,
					)
					.all(executionId) as Array<{ run_id: string }>;
				return rows.length === 1 ? rows[0]?.run_id : undefined;
			},
		};
		return {
			reader: createFounderReviewStateReader({ db: commDb, locator }),
			close() {
				commDb?.close();
				stateDb.close();
			},
		};
	} catch (error) {
		commDb?.close();
		stateDb.close();
		throw error;
	}
}
