import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { StateStore } from "../StateStore.js";

async function freshStore(): Promise<StateStore> {
	return StateStore.create(":memory:");
}

const BASE = {
	threadId: "thread-1448",
	msgId: "msg-1448",
	questionId: "question-a",
	projectName: "flywheel",
	leadId: "flywheel-eng-lead",
	executionId: "exec-a",
	disposedAtMs: 1_000,
	deadlineAtMs: 181_000,
} as const;

describe("StateStore founder decision convergence", () => {
	it("creates one durable intent per thread/message/question without resetting it", async () => {
		const store = await freshStore();

		expect(store.ensureFounderDecisionConvergence(BASE)).toMatchObject({
			created: true,
			row: {
				classification: "none",
				resolved_at_ms: null,
				alerted_at_ms: null,
				alert_claimed_at_ms: null,
			},
		});
		expect(
			store.ensureFounderDecisionConvergence({
				...BASE,
				deadlineAtMs: 999_000,
			}),
		).toMatchObject({
			created: false,
			row: { deadline_at_ms: 181_000 },
		});
	});

	it("classifies and resolves each candidate question independently", async () => {
		const store = await freshStore();
		store.ensureFounderDecisionConvergence(BASE);
		store.ensureFounderDecisionConvergence({
			...BASE,
			questionId: "question-b",
			executionId: "exec-b",
		});

		store.classifyFounderDecisionConvergence({
			threadId: BASE.threadId,
			msgId: BASE.msgId,
			questionId: BASE.questionId,
			classification: "approve",
			cardReferenceValid: true,
		});
		store.resolveFounderDecisionConvergence({
			threadId: BASE.threadId,
			msgId: BASE.msgId,
			questionId: BASE.questionId,
			resolution: "response",
			resolvedAtMs: 2_000,
		});

		expect(store.listFounderDecisionConvergence()).toEqual([
			expect.objectContaining({
				question_id: "question-a",
				classification: "approve",
				card_reference_valid: 1,
				resolution: "response",
			}),
			expect.objectContaining({
				question_id: "question-b",
				classification: "none",
				resolution: null,
			}),
		]);
	});

	it("claims one overdue definite decision for alerting but never claims unclear chat", async () => {
		const store = await freshStore();
		for (const [questionId, classification] of [
			["question-a", "reject"],
			["question-b", "unclear"],
		] as const) {
			store.ensureFounderDecisionConvergence({
				...BASE,
				questionId,
				executionId: `exec-${questionId}`,
			});
			store.classifyFounderDecisionConvergence({
				threadId: BASE.threadId,
				msgId: BASE.msgId,
				questionId,
				classification,
				cardReferenceValid: false,
			});
		}

		expect(store.claimOverdueFounderDecisionAlerts(181_001)).toEqual([
			expect.objectContaining({
				question_id: "question-a",
				classification: "reject",
				alerted_at_ms: null,
				alert_claimed_at_ms: 181_001,
			}),
		]);
		expect(store.claimOverdueFounderDecisionAlerts(181_002)).toEqual([]);
		expect(
			store
				.listFounderDecisionConvergence()
				.find((row) => row.question_id === "question-b")?.alerted_at_ms,
		).toBeNull();
	});

	it("reclaims an overdue alert after a process dies with the durable claim", async () => {
		const dir = mkdtempSync(join(tmpdir(), "founder-convergence-"));
		const dbPath = join(dir, "state.db");
		let store = await StateStore.create(dbPath);
		try {
			store.ensureFounderDecisionConvergence(BASE);
			store.classifyFounderDecisionConvergence({
				threadId: BASE.threadId,
				msgId: BASE.msgId,
				questionId: BASE.questionId,
				classification: "approve",
				cardReferenceValid: true,
			});
			expect(store.claimOverdueFounderDecisionAlerts(181_001)).toHaveLength(1);

			store.close();
			store = await StateStore.create(dbPath);
			expect(store.claimOverdueFounderDecisionAlerts(481_001)).toEqual([
				expect.objectContaining({
					question_id: BASE.questionId,
					resolved_at_ms: null,
					alerted_at_ms: null,
					alert_claimed_at_ms: 481_001,
				}),
			]);
			expect(
				store.markFounderDecisionAlertDelivered({
					threadId: BASE.threadId,
					msgId: BASE.msgId,
					questionId: BASE.questionId,
					expectedAlertClaimedAtMs: 481_001,
					alertedAtMs: 481_002,
				}),
			).toBe(true);

			store.close();
			store = await StateStore.create(dbPath);
			expect(store.claimOverdueFounderDecisionAlerts(781_002)).toEqual([]);
			expect(store.listFounderDecisionConvergence()).toEqual([
				expect.objectContaining({
					alerted_at_ms: 481_002,
					alert_claimed_at_ms: null,
				}),
			]);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("migrates an ambiguous legacy alerted stamp into a reclaimable lease", async () => {
		const dir = mkdtempSync(join(tmpdir(), "founder-convergence-migrate-"));
		const dbPath = join(dir, "state.db");
		const legacy = new Database(dbPath);
		legacy.exec(`
			CREATE TABLE founder_decision_convergence (
				thread_id TEXT NOT NULL,
				msg_id TEXT NOT NULL,
				question_id TEXT NOT NULL,
				project_name TEXT NOT NULL,
				lead_id TEXT NOT NULL,
				execution_id TEXT NOT NULL,
				classification TEXT NOT NULL,
				card_reference_valid INTEGER NOT NULL,
				disposed_at_ms INTEGER NOT NULL,
				deadline_at_ms INTEGER NOT NULL,
				resolved_at_ms INTEGER,
				resolution TEXT,
				alerted_at_ms INTEGER,
				PRIMARY KEY (thread_id, msg_id, question_id)
			);
			INSERT INTO founder_decision_convergence
				(thread_id, msg_id, question_id, project_name, lead_id,
				 execution_id, classification, card_reference_valid,
				 disposed_at_ms, deadline_at_ms, alerted_at_ms)
			VALUES
				('thread-1448', 'msg-1448', 'question-a', 'flywheel',
				 'flywheel-eng-lead', 'exec-a', 'approve', 1,
				 1000, 181000, 181001);
		`);
		legacy.close();

		const store = await StateStore.create(dbPath);
		try {
			expect(store.listFounderDecisionConvergence()).toEqual([
				expect.objectContaining({
					alerted_at_ms: null,
					alert_claimed_at_ms: 181_001,
				}),
			]);
			expect(store.claimOverdueFounderDecisionAlerts(481_001)).toHaveLength(1);
		} finally {
			store.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
