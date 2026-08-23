import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { verifyApproval } from "flywheel-comm/verify-approval";
import { afterEach, describe, expect, it } from "vitest";
import { settleShipAttemptFailed } from "../bridge/post-ship-finalization.js";
import { StateStore } from "../StateStore.js";

const EXEC = "exec-fly1505";
const HEAD = "a".repeat(40);

describe("FLY-1505 approval preservation integration", () => {
	let tmp: string | undefined;

	afterEach(() => {
		if (tmp) rmSync(tmp, { recursive: true, force: true });
		tmp = undefined;
	});

	it("keeps a fully bound structured founder approval usable after a blocked ship attempt is deflected", async () => {
		tmp = mkdtempSync(join(tmpdir(), "fly1505-approval-"));
		const stateDbPath = join(tmp, "teamlead.db");
		const commDbPath = join(tmp, "comm.db");

		const comm = new CommDB(commDbPath);
		const questionId = comm.insertQuestion(
			EXEC,
			"flywheel-eng-lead",
			"PR ready",
			{ checkpoint: "approve_to_ship" },
		);
		comm.insertResponse(
			questionId,
			"bridge",
			JSON.stringify({ approved: true }),
		);
		comm.close();

		const store = await StateStore.create(stateDbPath);
		store.upsertSession({
			execution_id: EXEC,
			issue_id: "FLY-1505",
			project_name: "flywheel",
			status: "awaiting_review",
			pr_number: 715,
		});
		store.setReviewBinding(EXEC, { questionId, prHeadSha: HEAD });
		store.recordCodexReviewApproved({
			executionId: EXEC,
			targetPrHeadSha: HEAD,
			issueId: "FLY-1505",
			projectName: "flywheel",
			authorFamily: "claude",
			reviewerFamily: "codex",
		});
		expect(store.getCodexReviewRecord(EXEC, HEAD)).toMatchObject({
			author_family: "claude",
			reviewer_family: "codex",
		});
		store.persistTransition(EXEC, "approved_to_ship", {
			issue_id: "FLY-1505",
			project_name: "flywheel",
		});

		expect(
			settleShipAttemptFailed(store, EXEC, {
				attemptHeadSha: HEAD,
				currentHeadSha: HEAD,
				prNumber: 715,
				reviewQuestionId: questionId,
				currentReviewQuestionId: questionId,
				summary: "25-minute ship job still running",
			}),
		).toMatchObject({ outcome: "marked" });
		expect(store.getSession(EXEC)?.status).toBe("approved_to_ship");
		store.close();

		expect(
			verifyApproval({
				execId: EXEC,
				prHead: HEAD,
				dbPath: commDbPath,
				stateDbPath,
				codexDotenvPath: join(tmp, "missing.env"),
				ciProbe: () => ({ green: true, reason: "ci_green" }),
			}),
		).toMatchObject({
			approved: true,
			reason: "approved",
			questionId,
			exitCode: 0,
		});
	});
});
