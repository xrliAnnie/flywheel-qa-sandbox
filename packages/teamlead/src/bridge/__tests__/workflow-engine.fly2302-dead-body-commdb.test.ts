import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	legacyWorkflowSeeds,
	pinLegacyWorkflowSeedAgents,
} from "../../__tests__/fixtures/legacy-workflow-manifests.js";
import { StateStore } from "../../StateStore.js";
import { closeRunner } from "../close-runner.js";
import { commDbPathForProject } from "../commdb-path.js";
import { finalizeDeadTerminalCommDbSessionById } from "../commdb-session-prune.js";
import type { IStartDispatcher, StartRequest } from "../retry-dispatcher.js";
import { WorkflowEngineDispatcher } from "../workflow-engine-dispatcher.js";

const DEAD_EXECUTION_ID = "implement-dead";
const ISSUE_ID = "FLY-2302";
const PROJECT_NAME = "flywheel";
const HEAD = "a".repeat(40);
const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const WORKFLOW_ON = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
};

async function seedBlockedImplement(): Promise<StateStore> {
	const store = await StateStore.create(":memory:");
	const seed = pinLegacyWorkflowSeedAgents(
		legacyWorkflowSeeds().find(
			(candidate) => candidate.templateId === "tpl_eng_heavy",
		)!,
	);
	store.importWorkflowTemplateSeed(seed);
	store.materializeWorkflowRun({
		runId: "run-fly2302",
		issueId: ISSUE_ID,
		projectName: PROJECT_NAME,
		taskCategory: "code",
		templateId: seed.templateId,
		claimsReadEnrolled: true,
		actor: "lead",
		canonicalRoot: REPO_ROOT,
		env: WORKFLOW_ON,
		startReservation: {
			idempotencyKey: "fly2302-start",
			selectionDigest: "fly2302-selection",
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			createdAt: "2026-09-03T18:00:00.000Z",
		},
	});
	store.upsertWorkflowRunNode({
		runId: "run-fly2302",
		nodeId: "design",
		attempt: 1,
		state: "running",
		executionId: "design-1",
	});
	expect(
		store.commitWorkflowTransitionTx({
			nodeReuseEnabled: false,
			runId: "run-fly2302",
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			outcome: "design_done",
			successorExecutionId: DEAD_EXECUTION_ID,
			subjectDigest: HEAD,
			now: "2026-09-03T18:05:00.000Z",
		}),
	).toMatchObject({ ok: true });
	expect(
		store.admitGeneralizedWorkflowExecution({
			runId: "run-fly2302",
			nodeId: "implement",
			executionId: DEAD_EXECUTION_ID,
			attempt: 1,
			expiresAt: "2026-09-03T20:00:00.000Z",
			absoluteDeadlineAt: "2026-09-04T18:00:00.000Z",
			now: "2026-09-03T18:06:00.000Z",
			env: WORKFLOW_ON,
		}),
	).toMatchObject({ ok: true });
	store.applyWorkflowLedgerBatch({
		projectName: PROJECT_NAME,
		issueId: ISSUE_ID,
		runId: "run-fly2302",
		ops: [
			{
				op: "side_effect",
				node: "implement",
				attempt: 1,
				executionId: DEAD_EXECUTION_ID,
				to: "started",
			},
		],
	});
	store.upsertWorkflowRunNode({
		runId: "run-fly2302",
		nodeId: "implement",
		attempt: 1,
		state: "running",
		executionId: DEAD_EXECUTION_ID,
	});
	store.upsertSession({
		execution_id: DEAD_EXECUTION_ID,
		issue_id: ISSUE_ID,
		project_name: PROJECT_NAME,
		status: "running",
		workflow_node_id: "implement",
	});
	expect(
		store.recordEnrolledTerminalSignal({
			executionId: DEAD_EXECUTION_ID,
			sourceEventId: "fly2302-goal-blocked",
			signal: "failed",
			failureKind: "goal_blocked",
			lastError: "goal ended non-complete: blocked",
			source: "direct-event-sink",
			now: "2026-09-03T18:20:42.000Z",
		}),
	).toMatchObject({ ok: true, status: "blocked" });
	return store;
}

function fakeStartDispatcher(store: StateStore): {
	dispatcher: IStartDispatcher;
	requests: StartRequest[];
} {
	const requests: StartRequest[] = [];
	const dispatcher = {
		start: vi.fn(async (request: StartRequest) => {
			requests.push(request);
			const committed = request.generalizedExecution?.commitWorkflowLaunch?.();
			if (!committed?.ok) {
				throw new Error(committed?.reason ?? "launch_not_committed");
			}
			store.upsertSession({
				execution_id: request.generalizedExecution!.executionId,
				issue_id: request.issueId,
				project_name: request.projectName,
				status: "running",
				session_role: request.sessionRole,
				chat_thread_role: request.sessionRole,
			});
			return {
				executionId: request.generalizedExecution!.executionId,
				issueId: request.issueId,
			};
		}),
		getInflightCount: () => 0,
		validateAgentName: () => ({ ok: true as const }),
	} as IStartDispatcher;
	return { dispatcher, requests };
}

describe("FLY-2302 dead workflow body CommDB convergence", () => {
	let dir: string;
	let previousCommDir: string | undefined;
	let db: CommDB;
	let store: StateStore | undefined;
	let nowMs: number;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "fly2302-dead-body-"));
		previousCommDir = process.env.FLYWHEEL_COMM_DIR;
		process.env.FLYWHEEL_COMM_DIR = dir;
		mkdirSync(join(dir, PROJECT_NAME), { recursive: true });
		db = new CommDB(commDbPathForProject(PROJECT_NAME));
		nowMs = Date.now() + 6 * 60 * 60_000;
	});

	afterEach(() => {
		db.close();
		store?.close();
		if (previousCommDir === undefined) delete process.env.FLYWHEEL_COMM_DIR;
		else process.env.FLYWHEEL_COMM_DIR = previousCommDir;
		rmSync(dir, { recursive: true, force: true });
	});

	function seedCommDbDeadBody(): string {
		db.registerSession(
			DEAD_EXECUTION_ID,
			"runner-flywheel:@1",
			PROJECT_NAME,
			ISSUE_ID,
			"flywheel-eng-lead",
		);
		db.markSessionTerminalStatus(DEAD_EXECUTION_ID, "blocked");
		db.grantTurn(ISSUE_ID, DEAD_EXECUTION_ID, "implement", Date.now(), {
			project: PROJECT_NAME,
			sourceEventId: "fly2302-turn-dead",
		});
		const askId = db.insertQuestion(
			DEAD_EXECUTION_ID,
			"flywheel-eng-lead",
			"will this dead execution ever receive an answer?",
		);
		const rawDb = db as unknown as {
			db: { prepare(sql: string): { run(...params: string[]): void } };
		};
		rawDb.db
			.prepare(
				"UPDATE mailbox SET created_at = datetime('now', '-20 minutes') WHERE id = ?",
			)
			.run(askId);
		return askId;
	}

	function buildDispatcher(
		tmuxProbe: ReturnType<typeof vi.fn>,
		onFinalizeOutcome: ReturnType<typeof vi.fn>,
	): { dispatcher: WorkflowEngineDispatcher; requests: StartRequest[] } {
		const fake = fakeStartDispatcher(store!);
		const dispatcher = new WorkflowEngineDispatcher({
			store: store!,
			startDispatcher: fake.dispatcher,
			env: WORKFLOW_ON,
			now: () => new Date(nowMs),
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness: async () => "dead",
			captureDeadExecutionActivityBaseline: async () => ({
				commitMarker: { state: "absent" as const },
				commDbMessageCount: 0,
				tmuxTarget: "runner-flywheel:@1",
				tmuxOutputDigest: null,
				sessionCommitCount: 0,
			}),
			probeDeadExecutionActivity: async () => null,
			finalizeDeadExecutionCommDb: ({ projectName, executionId, issueId }) =>
				finalizeDeadTerminalCommDbSessionById(projectName, executionId, {
					includeCrashPreserve: true,
					probe: tmuxProbe,
					onFinalizeOutcome: (execId, project, outcome) => {
						onFinalizeOutcome(execId, project, outcome);
						store!.recordCommDbFinalizeOutcome({
							executionId: execId,
							issueId,
							projectName: project,
							ok: outcome.ok,
							error: outcome.error,
							runnerDeathProven: true,
							audit: {
								retiredGateCount: outcome.retiredGateCount,
								retiredAskCount: outcome.retiredAskCount,
								source: "bridge.workflow-engine.dead-rollback",
							},
						});
					},
				}),
		});
		return { dispatcher, requests: fake.requests };
	}

	it("finalizes the blocked registration after TURN transfer without rewriting StateStore", async () => {
		store = await seedBlockedImplement();
		seedCommDbDeadBody();
		const terminalBefore = store.getSession(DEAD_EXECUTION_ID)!;
		const terminalAtBefore = terminalBefore.terminal_at;
		const tmuxProbe = vi.fn(async () => "dead" as const);
		const onFinalizeOutcome = vi.fn();
		const { dispatcher } = buildDispatcher(tmuxProbe, onFinalizeOutcome);

		await dispatcher.reconcile();
		expect(
			store
				.listWorkflowRunEvents("run-fly2302")
				.some(
					(event) =>
						event.kind === "execution_dead_rolled_back" &&
						event.execution_id === DEAD_EXECUTION_ID,
				),
		).toBe(true);
		expect(
			store.getWorkflowDeadExecutionWatch(DEAD_EXECUTION_ID),
		).toBeDefined();
		expect(db.getSession(DEAD_EXECUTION_ID)).toBeDefined();
		expect(tmuxProbe).not.toHaveBeenCalled();

		await dispatcher.reconcile();
		expect(tmuxProbe).not.toHaveBeenCalled();
		expect(db.getSession(DEAD_EXECUTION_ID)).toBeDefined();
		for (let elapsedSeconds = 1; elapsedSeconds <= 10; elapsedSeconds++) {
			nowMs += 1_000;
			await dispatcher.reconcile();
			expect(tmuxProbe).not.toHaveBeenCalled();
			expect(db.getSession(DEAD_EXECUTION_ID)).toBeDefined();
		}

		const replacementId =
			store.getWorkflowDeadExecutionWatch(DEAD_EXECUTION_ID)!.new_execution_id;
		db.grantTurn(ISSUE_ID, replacementId, "implement", Date.now() + 1, {
			project: PROJECT_NAME,
			sourceEventId: "fly2302-turn-replacement",
		});
		nowMs += 1_000;
		await dispatcher.reconcile();

		expect(tmuxProbe).toHaveBeenCalledExactlyOnceWith("runner-flywheel:@1");
		expect(db.getSession(DEAD_EXECUTION_ID)).toBeUndefined();
		expect(onFinalizeOutcome).toHaveBeenCalledWith(
			DEAD_EXECUTION_ID,
			PROJECT_NAME,
			expect.objectContaining({ ok: true, retiredAskCount: 1 }),
		);
		const auditEvents = store.getEventsByType("commdb_ask_disposed");
		expect(auditEvents).toHaveLength(1);
		expect(auditEvents[0]).toMatchObject({
			execution_id: DEAD_EXECUTION_ID,
			issue_id: ISSUE_ID,
			project_name: PROJECT_NAME,
			payload: {
				retiredAskCount: 1,
				source: "bridge.workflow-engine.dead-rollback",
			},
		});
		expect(store.getSession(DEAD_EXECUTION_ID)).toMatchObject({
			status: "blocked",
			terminal_at: terminalAtBefore,
		});
		expect(
			store.getWorkflowDeadExecutionWatch(DEAD_EXECUTION_ID),
		).toMatchObject({
			state: "active",
		});

		expect(
			await closeRunner(
				{
					executionId: DEAD_EXECUTION_ID,
					issueId: ISSUE_ID,
					projectName: PROJECT_NAME,
					reason: "FLY-2302 compatibility proof",
					leadId: "bridge.lifecycle-closeout",
					executorType: "lifecycle",
					forcePreserved: true,
					skipLifecycleGuard: true,
				},
				store,
			),
		).toMatchObject({
			closed: true,
			alreadyGone: true,
			commDbFinalized: true,
		});
	});

	it("keeps a blocked registration while its crash-preserve pane is alive", async () => {
		store = await seedBlockedImplement();
		seedCommDbDeadBody();
		const tmuxProbe = vi.fn(async () => "alive" as const);
		const { dispatcher } = buildDispatcher(tmuxProbe, vi.fn());

		await dispatcher.reconcile();
		await dispatcher.reconcile();
		const replacementId =
			store.getWorkflowDeadExecutionWatch(DEAD_EXECUTION_ID)!.new_execution_id;
		db.grantTurn(ISSUE_ID, replacementId, "implement", Date.now() + 1, {
			project: PROJECT_NAME,
			sourceEventId: "fly2302-turn-live-pane",
		});
		await dispatcher.reconcile();
		expect(tmuxProbe).not.toHaveBeenCalled();
		nowMs += 1_000;
		await dispatcher.reconcile();

		expect(tmuxProbe).toHaveBeenCalledTimes(1);
		expect(db.getSession(DEAD_EXECUTION_ID)).toBeDefined();
		expect(store.getEventsByType("commdb_ask_disposed")).toEqual([]);
	});
});
