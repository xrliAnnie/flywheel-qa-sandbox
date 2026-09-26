import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CommDB } from "../db.js";

let db: CommDB;
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "review-recovery-"));
	db = new CommDB(join(dir, "comm.db"));
});
afterEach(() => {
	db.close();
	rmSync(dir, { recursive: true, force: true });
});
function notice() {
	db.registerSession("exec", "window", "flywheel");
	const questionId = db.insertQuestion("exec", "lead", "review", {
		checkpoint: "review_code",
	});
	return {
		requestId: "R",
		sourceRequestId: "source-R",
		questionId,
		executionId: "exec",
		projectName: "flywheel",
		generation: 1,
		stage: "retired" as const,
		checkpoint: "review_code" as const,
		text: "Reissue the retired review",
		actedAt: null,
	};
}
const provenance = { writerPid: 123, writerStart: "bridge-start" };
it("keeps ACKed recovery actionable across reopen without answering any gate", () => {
	const n = notice();
	const other = db.insertQuestion("exec", "lead", "other", {
		checkpoint: "brainstorm",
	});
	db.projectReviewRecoveryNotice(n, provenance);
	const id = "review-recovery:R:1:retired";
	db.markInstructionRead(id);
	db.close();
	db = new CommDB(join(dir, "comm.db"));
	expect(db.readActionableReviewRecovery("exec", "flywheel")).toMatchObject({
		id,
		text: n.text,
	});
	expect(db.getResponse(n.questionId)).toBeFalsy();
	expect(db.getResponse(other)).toBeFalsy();
	expect(db.hasPendingBlockingGateFrom("exec")).toBe(true);
	db.markReviewRecoveryNoticeActed(id, new Date().toISOString());
	expect(db.readActionableReviewRecovery("exec", "flywheel")).toBeNull();
});
it("preserves first provenance on replay and rejects changed binding", () => {
	const n = notice();
	db.projectReviewRecoveryNotice(n, provenance);
	expect(() =>
		db.projectReviewRecoveryNotice(n, {
			writerPid: 456,
			writerStart: "new-start",
		}),
	).not.toThrow();
	expect(() =>
		db.projectReviewRecoveryNotice({ ...n, questionId: "other" }, provenance),
	).toThrow();
});
it("rejects wrong execution, project, older generation and final gate", () => {
	const n = notice();
	db.projectReviewRecoveryNotice(n, provenance);
	expect(db.readActionableReviewRecovery("wrong", "flywheel")).toBeNull();
	expect(db.readActionableReviewRecovery("exec", "other")).toBeNull();
	db.projectReviewRecoveryNotice(
		{ ...n, generation: 2, actedAt: new Date().toISOString() },
		provenance,
	);
	expect(db.readActionableReviewRecovery("exec", "flywheel")).toBeNull();
	db.insertResponse(n.questionId, "lead", "APPROVED");
	db.projectReviewRecoveryNotice({ ...n, generation: 3 }, provenance);
	expect(db.readActionableReviewRecovery("exec", "flywheel")).toBeNull();
});
it("does not trust arbitrary mailbox instructions or missing Bridge identity", () => {
	const n = notice();
	db.insertInstructionAndClearDeclaredState(
		"arbitrary",
		"bridge",
		"exec",
		n.text,
		provenance,
	);
	expect(db.readActionableReviewRecovery("exec", "flywheel")).toBeNull();
	expect(() => db.projectReviewRecoveryNotice(n, {})).toThrow();
});

it("ignores a missing registered session", () => {
	const questionId = db.insertQuestion("absent", "lead", "review", {
		checkpoint: "review_code",
	});
	const n = notice();
	db.projectReviewRecoveryNotice(
		{ ...n, questionId, executionId: "absent" },
		provenance,
	);
	expect(db.readActionableReviewRecovery("absent", "flywheel")).toBeNull();
});
it("ignores a different registered project", () => {
	const n = notice();
	db.projectReviewRecoveryNotice({ ...n, projectName: "other" }, provenance);
	expect(db.readActionableReviewRecovery("exec", "other")).toBeNull();
});
it("ignores a final session", () => {
	const n = notice();
	db.projectReviewRecoveryNotice(n, provenance);
	db.registerSession("exec", "window", "flywheel");
	db.updateSessionStatus("exec", "completed");
	expect(db.readActionableReviewRecovery("exec", "flywheel")).toBeNull();
});

it("does not authorize a recovery turn after the original review gate expires", () => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2020-01-01T00:00:00Z"));
	let n: ReturnType<typeof notice>;
	try {
		n = notice();
	} finally {
		vi.useRealTimers();
	}
	db.projectReviewRecoveryNotice(n, provenance);
	expect(db.readActionableReviewRecovery("exec", "flywheel")).toBeNull();
});

it("revalidates the current workflow TURN after successful delivery and daemon reopen", () => {
	const n = {
		...notice(),
		workflow: {
			issueId: "FLY-test",
			runId: "run",
			nodeId: "implement",
			attempt: 1,
		},
	};
	const grant = (exec: string, attempt: number) =>
		db.grantTurn("FLY-test", exec, "implement", Date.now(), {
			project: "flywheel",
			sourceEventId: `grant-${exec}`,
			activation: {
				activationId: `activation-${exec}`,
				runId: "run",
				nodeId: "implement",
				attempt,
				context: {},
			},
		});
	grant("exec", 1);
	db.projectReviewRecoveryNotice(n, provenance);
	expect(db.readActionableReviewRecovery("exec", "flywheel")).not.toBeNull();
	db.markInstructionRead("review-recovery:R:1:retired");
	grant("replacement", 2);
	db.close();
	db = new CommDB(join(dir, "comm.db"));
	expect(db.readActionableReviewRecovery("exec", "flywheel")).toBeNull();
	expect(db.getResponse(n.questionId)).toBeUndefined();
});
