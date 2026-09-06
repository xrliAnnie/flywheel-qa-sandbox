import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	WorkflowSessionlessGateCandidate,
	WorkflowSessionlessGateMailboxRetirement,
} from "../../StateStore.js";
import { reconcileSessionlessWorkflowGates } from "../sessionless-founder-gate-reconciler.js";

const roots: string[] = [];
const candidate: WorkflowSessionlessGateCandidate = {
	runId: "run-1",
	projectName: "flywheel",
	issueId: "FLY-2112",
	createdAt: "2026-09-06T07:00:00.000Z",
	questionId: "question-1",
	gateNodeId: "founder_gate",
	attempt: 1,
	headSha: "a".repeat(40),
	sourceExecutionId: "qa-1",
};
const retirement: WorkflowSessionlessGateMailboxRetirement = {
	runId: candidate.runId,
	questionId: candidate.questionId,
	gateNodeId: candidate.gateNodeId,
	sourceExecutionId: candidate.sourceExecutionId,
	projectName: candidate.projectName,
	issueId: candidate.issueId,
};

function commFixture(options: { response?: boolean } = {}): string {
	const root = mkdtempSync(join(tmpdir(), "fly2112-comm-"));
	roots.push(root);
	const dbPath = join(root, "comm.db");
	const db = new CommDB(dbPath);
	db.registerSession(
		"qa-1",
		"session",
		"flywheel",
		"FLY-2112",
		"flywheel-eng-lead",
		"codex",
	);
	const questionId = db.insertQuestion("qa-1", "flywheel-eng-lead", "ship?", {
		checkpoint: "founder_review",
		id: "question-1",
	});
	if (questionId !== "question-1") {
		throw new Error(`unexpected question id: ${questionId}`);
	}
	if (options.response) {
		db.insertResponse(questionId, "flywheel-eng-lead", "yes");
	}
	db.close();
	return dbPath;
}

function storeStub(input: {
	candidates?: WorkflowSessionlessGateCandidate[];
	retirements?: WorkflowSessionlessGateMailboxRetirement[];
}) {
	return {
		listSessionlessWorkflowGateCandidates: vi.fn(() => input.candidates ?? []),
		terminateSessionlessWorkflowGate: vi.fn(() => ({
			ok: true as const,
			idempotentReplay: false,
		})),
		listPendingSessionlessGateMailboxRetirements: vi.fn(
			() => input.retirements ?? [],
		),
		appendWorkflowRunEventChecked: vi.fn(() => ({
			seq: 1,
			deduped: false,
		})),
	};
}

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("sessionless founder-gate reconciler", () => {
	it("closes candidates, retires CommDB, and records an enriched outcome", async () => {
		const dbPath = commFixture();
		const store = storeStub({
			candidates: [candidate],
			retirements: [retirement],
		});

		await expect(
			reconcileSessionlessWorkflowGates({
				store,
				commDbPathForProject: () => dbPath,
				now: () => "2026-09-06T08:00:00.000Z",
			}),
		).resolves.toEqual({
			throttled: false,
			closeouts: 1,
			retired: 1,
			failed: 0,
		});
		expect(store.terminateSessionlessWorkflowGate).toHaveBeenCalledWith({
			runId: "run-1",
			questionId: "question-1",
			now: "2026-09-06T08:00:00.000Z",
		});
		expect(store.appendWorkflowRunEventChecked).toHaveBeenCalledWith({
			runId: "run-1",
			eventUid: "sessionless_gate_mailbox_retired:run-1:question-1",
			kind: "sessionless_gate_mailbox_retired",
			nodeId: "founder_gate",
			executionId: "qa-1",
			payload: {
				questionId: "question-1",
				outcome: "retired",
				reason: "superseded_run_sessionless",
				checkpoint: "founder_review",
				resolvedVia: null,
			},
		});
		const readonly = CommDB.openReadonly(dbPath);
		expect(readonly.getMessageById("question-1")).toMatchObject({
			relay_state: "terminal_disposed",
			resolved_via: "superseded_run_sessionless",
		});
		readonly.close();
	});

	it("records response_won without deleting the historical founder response", async () => {
		const dbPath = commFixture({ response: true });
		const store = storeStub({ retirements: [retirement] });

		const result = await reconcileSessionlessWorkflowGates({
			store,
			commDbPathForProject: () => dbPath,
			now: () => "2026-09-06T08:01:00.000Z",
		});

		expect(result).toMatchObject({ retired: 1, failed: 0 });
		expect(store.appendWorkflowRunEventChecked).toHaveBeenCalledWith(
			expect.objectContaining({
				payload: expect.objectContaining({ outcome: "response_won" }),
			}),
		);
		const readonly = CommDB.openReadonly(dbPath);
		expect(readonly.getResponse("question-1")?.content).toBe("yes");
		readonly.close();
	});

	it("retries durable mailbox work after a cross-database crash window", async () => {
		const dbPath = commFixture();
		const store = storeStub({
			candidates: [candidate],
			retirements: [retirement],
		});
		let observedAt = "2026-09-06T08:02:00.000Z";
		let opens = 0;
		const openDb = (path: string) => {
			opens += 1;
			if (opens === 1)
				throw new Error("simulated crash after StateStore commit");
			return new CommDB(path, false);
		};

		expect(
			await reconcileSessionlessWorkflowGates({
				store,
				commDbPathForProject: () => dbPath,
				openDb,
				now: () => observedAt,
			}),
		).toMatchObject({ closeouts: 1, retired: 0, failed: 1 });
		expect(store.appendWorkflowRunEventChecked).not.toHaveBeenCalled();

		observedAt = "2026-09-06T08:02:31.000Z";
		store.listSessionlessWorkflowGateCandidates.mockReturnValue([]);
		expect(
			await reconcileSessionlessWorkflowGates({
				store,
				commDbPathForProject: () => dbPath,
				openDb,
				now: () => observedAt,
			}),
		).toMatchObject({ closeouts: 0, retired: 1, failed: 0 });
		expect(store.appendWorkflowRunEventChecked).toHaveBeenCalledTimes(1);
	});

	it("isolates one retirement failure and continues the batch", async () => {
		const second = { ...retirement, runId: "run-2", questionId: "question-2" };
		const store = storeStub({ retirements: [retirement, second] });
		const close = vi.fn();
		const retire = vi.fn(({ questionId }: { questionId: string }) => {
			if (questionId === "question-1") throw new Error("database busy");
			return { kind: "missing" as const };
		});

		await expect(
			reconcileSessionlessWorkflowGates({
				store,
				commDbPathForProject: () => "ignored",
				openDb: () => ({
					retireGateForTerminalAuthority: retire,
					getMessageById: () => undefined,
					close,
				}),
				now: () => "2026-09-06T08:03:00.000Z",
			}),
		).resolves.toMatchObject({ retired: 1, failed: 1 });
		expect(retire).toHaveBeenCalledTimes(2);
		expect(store.appendWorkflowRunEventChecked).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledOnce();
	});

	it("contains a candidate scan failure and still drains durable mailbox work", async () => {
		const store = storeStub({ retirements: [retirement] });
		store.listSessionlessWorkflowGateCandidates.mockImplementation(() => {
			throw new Error("StateStore busy");
		});
		const close = vi.fn();

		await expect(
			reconcileSessionlessWorkflowGates({
				store,
				commDbPathForProject: () => "ignored",
				openDb: () => ({
					retireGateForTerminalAuthority: () => ({ kind: "missing" }),
					getMessageById: () => undefined,
					close,
				}),
				now: () => "2026-09-06T08:03:30.000Z",
			}),
		).resolves.toEqual({
			throttled: false,
			closeouts: 0,
			retired: 1,
			failed: 1,
		});
		expect(
			store.listPendingSessionlessGateMailboxRetirements,
		).toHaveBeenCalled();
		expect(close).toHaveBeenCalledOnce();
	});

	it("uses the existing tick with a 30-second self-throttle and an empty fast path", async () => {
		const store = storeStub({});
		let observedAt = "2026-09-06T08:04:00.000Z";
		const deps = {
			store,
			commDbPathForProject: vi.fn(() => "unused"),
			openDb: vi.fn(),
			now: () => observedAt,
		};

		expect(await reconcileSessionlessWorkflowGates(deps)).toEqual({
			throttled: false,
			closeouts: 0,
			retired: 0,
			failed: 0,
		});
		observedAt = "2026-09-06T08:04:29.999Z";
		expect(await reconcileSessionlessWorkflowGates(deps)).toEqual({
			throttled: true,
			closeouts: 0,
			retired: 0,
			failed: 0,
		});
		expect(store.listSessionlessWorkflowGateCandidates).toHaveBeenCalledOnce();
		expect(deps.openDb).not.toHaveBeenCalled();
	});
});
