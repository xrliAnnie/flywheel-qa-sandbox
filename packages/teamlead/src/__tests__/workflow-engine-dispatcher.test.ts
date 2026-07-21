import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	type MaterializedHeadAuthority,
	receiptBackedMaterializedHeadAuthority,
} from "../bridge/materialized-head-authority.js";
import type {
	IStartDispatcher,
	StartRequest,
} from "../bridge/retry-dispatcher.js";
import { WorkflowDocsMaterializer } from "../bridge/workflow-docs-materializer.js";
import { WorkflowEngineDispatcher } from "../bridge/workflow-engine-dispatcher.js";
import {
	StateStore,
	type WorkflowDeadExecutionWatchRow,
} from "../StateStore.js";
import { loadBundledWorkflowSeeds } from "../workflow-template.js";

const generalizedRecoveryMocks = vi.hoisted(() => ({
	waitForDelivery: vi.fn(),
}));

vi.mock("../bridge/generalized-launch-recovery.js", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../bridge/generalized-launch-recovery.js")
		>();
	generalizedRecoveryMocks.waitForDelivery.mockImplementation(
		actual.waitForGeneralizedLaunchDelivery,
	);
	return {
		...actual,
		waitForGeneralizedLaunchDelivery: generalizedRecoveryMocks.waitForDelivery,
	};
});

const HEAD = "a".repeat(40);
const WORKFLOW_ON = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
};

async function storeWithIntent(target: "design" | "implement" | "qa") {
	const store = await StateStore.create(":memory:");
	const seed = loadBundledWorkflowSeeds().find(
		(candidate) => candidate.templateId === "tpl_eng_heavy",
	)!;
	store.importWorkflowTemplateSeed(seed);
	store.materializeWorkflowRun({
		runId: "run-1",
		issueId: "FLY-1307",
		projectName: "flywheel",
		taskCategory: "code",
		templateId: seed.templateId,
		claimsReadEnrolled: true,
		actor: "lead",
		env: WORKFLOW_ON,
		...(target === "design" ? { entryKind: "pipeline_dag_v1" as const } : {}),
		startReservation: {
			idempotencyKey: "engine-start",
			selectionDigest: "selection",
			nodeId: "design",
			attempt: 1,
			executionId: "design-1",
			createdAt: "2026-07-16T00:00:00.000Z",
		},
	});
	if (target === "design") {
		return store;
	}
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "design",
		attempt: 1,
		state: "running",
		executionId: "design-1",
	});
	store.upsertSession({
		execution_id: "design-1",
		issue_id: "FLY-1307",
		project_name: "flywheel",
		status: "design_done",
		issue_identifier: "FLY-1307",
		issue_title: "DAG template engine",
		design_backend: "claude",
		doc_tier: "full",
		issue_url: "https://linear.app/flywheel/FLY-1307",
		worktree_path: "/unused/design",
	});
	store.commitWorkflowTransitionTx({
		runId: "run-1",
		nodeId: "design",
		attempt: 1,
		executionId: "design-1",
		outcome: "design_done",
		successorExecutionId: "implement-1",
		now: "2026-07-16T00:05:00.000Z",
	});
	if (target === "qa") {
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "awaiting_review",
			issue_identifier: "FLY-1307",
			issue_title: "DAG template engine",
			design_backend: "claude",
			doc_tier: "full",
			issue_url: "https://linear.app/flywheel/FLY-1307",
			worktree_path: "/unused/implement",
		});
		store.applyWorkflowShadowBatch({
			projectName: "flywheel",
			issueId: "FLY-1307",
			runId: "run-1",
			ops: [
				{
					op: "side_effect",
					node: "implement",
					attempt: 1,
					executionId: "implement-1",
					to: "started",
				},
			],
		});
		store.commitWorkflowTransitionTx({
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
			executionId: "implement-1",
			outcome: "implement_done",
			successorExecutionId: "qa-1",
			now: "2026-07-16T00:10:00.000Z",
		});
	}
	return store;
}

function failRunningDesign(store: StateStore, lastError: string): void {
	expect(
		store.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "design",
			executionId: "design-1",
			attempt: 1,
			now: "2026-07-16T00:01:00.000Z",
			expiresAt: "2026-07-16T01:01:00.000Z",
			absoluteDeadlineAt: "2026-07-17T00:01:00.000Z",
			env: WORKFLOW_ON,
		}),
	).toMatchObject({ ok: true });
	store.applyWorkflowShadowBatch({
		projectName: "flywheel",
		issueId: "FLY-1307",
		runId: "run-1",
		ops: [
			{
				op: "side_effect",
				node: "design",
				attempt: 1,
				executionId: "design-1",
				to: "started",
			},
		],
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "design",
		attempt: 1,
		state: "running",
		executionId: "design-1",
	});
	store.upsertSession({
		execution_id: "design-1",
		issue_id: "FLY-1307",
		project_name: "flywheel",
		status: "failed",
		last_error: lastError,
	});
}

async function storeWithProductOutputIntent() {
	const store = await StateStore.create(":memory:");
	const canonicalRoot = mkdtempSync(join(tmpdir(), "fly1307-product-agent-"));
	mkdirSync(join(canonicalRoot, "agents"));
	writeFileSync(
		join(canonicalRoot, "agents", "generic-executor.md"),
		"Execute the pinned node.\n",
	);
	const seed = loadBundledWorkflowSeeds().find(
		(candidate) => candidate.templateId === "tpl_product_v1",
	)!;
	const env = {
		...WORKFLOW_ON,
	};
	store.importWorkflowTemplateSeed(seed, env);
	store.materializeWorkflowRun({
		runId: "product-run",
		issueId: "FLY-1307",
		projectName: "flywheel",
		taskCategory: "product",
		templateId: seed.templateId,
		claimsReadEnrolled: true,
		actor: "lead",
		canonicalRoot,
		env,
		startReservation: {
			idempotencyKey: "product-start",
			selectionDigest: "product-selection",
			nodeId: "research",
			attempt: 1,
			executionId: "research-1",
			createdAt: "2026-07-16T00:00:00.000Z",
		},
	});
	store.upsertWorkflowRunNode({
		runId: "product-run",
		nodeId: "research",
		attempt: 1,
		state: "running",
		executionId: "research-1",
	});
	store.upsertSession({
		execution_id: "research-1",
		issue_id: "FLY-1307",
		project_name: "flywheel",
		status: "completed",
	});
	store.commitWorkflowTransitionTx({
		runId: "product-run",
		nodeId: "research",
		attempt: 1,
		executionId: "research-1",
		outcome: "node_done",
		successorExecutionId: "produce-1",
		now: "2026-07-16T00:05:00.000Z",
	});
	return { store, canonicalRoot, env };
}

function fakeStartDispatcher(store: StateStore) {
	const requests: StartRequest[] = [];
	const start = vi.fn(async (request: StartRequest) => {
		requests.push(request);
		const committed = request.generalizedExecution?.commitWorkflowLaunch?.();
		if (!committed?.ok) throw new Error(committed?.reason ?? "not_committed");
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
	});
	const dispatcher = {
		start,
		getInflightCount: () => 0,
		validateAgentName: () => ({ ok: true as const }),
	} as IStartDispatcher;
	return { dispatcher, requests, start };
}

describe("WorkflowEngineDispatcher", () => {
	it.each([
		["v1", "FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH"],
		["v1", "FLYWHEEL_WORKFLOW_CLAIMS_WRITE"],
		["v1", "FLYWHEEL_WORKFLOW_CLAIMS_READ"],
		["v2", "FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH"],
		["v2", "FLYWHEEL_WORKFLOW_CLAIMS_WRITE"],
		["v2", "FLYWHEEL_WORKFLOW_CLAIMS_READ"],
		["v2", "FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES"],
	] as const)(
		"holds an existing %s engine successor without mutating it when %s is removed",
		async (schema, missing) => {
			const fixture =
				schema === "v1"
					? {
							store: await storeWithIntent("implement"),
							canonicalRoot: undefined,
						}
					: await storeWithProductOutputIntent();
			const { store } = fixture;
			const intent = store.listNonTerminalWorkflowSideEffects()[0]!;
			store.upsertSession({
				execution_id: intent.execution_id,
				issue_id: "FLY-1307",
				project_name: "flywheel",
				status: "running",
			});
			const env = { ...WORKFLOW_ON };
			delete env[missing];
			const start = vi.fn();
			const dispatcher = new WorkflowEngineDispatcher({
				store,
				startDispatcher: {
					start,
					getInflightCount: () => 0,
					validateAgentName: () => ({ ok: true as const }),
				} as unknown as IStartDispatcher,
				env,
			});

			expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
			expect(start).not.toHaveBeenCalled();
			expect(store.listNonTerminalWorkflowSideEffects()[0]).toMatchObject({
				state: "intent_recorded",
			});
			store.close();
			if (fixture.canonicalRoot) {
				rmSync(fixture.canonicalRoot, { recursive: true, force: true });
			}
		},
	);

	it("reuses one launch owner so a transient start failure retries without a 60-minute self-fence", async () => {
		const store = await storeWithIntent("implement");
		let attempts = 0;
		const start = vi.fn(async (request: StartRequest) => {
			attempts += 1;
			if (attempts === 1) throw new Error("transient spawn failure");
			const committed = request.generalizedExecution?.commitWorkflowLaunch?.();
			if (!committed?.ok) throw new Error(committed?.reason ?? "not_committed");
			store.upsertSession({
				execution_id: request.generalizedExecution!.executionId,
				issue_id: request.issueId,
				project_name: request.projectName,
				status: "running",
				session_role: request.sessionRole,
			});
			return {
				executionId: request.generalizedExecution!.executionId,
				issueId: request.issueId,
			};
		});
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: {
				start,
				getInflightCount: () => 0,
				validateAgentName: () => ({ ok: true as const }),
			} as IStartDispatcher,
			env: WORKFLOW_ON,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1307-stable-owner-")),
			now: () => new Date("2026-07-16T00:06:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(start).toHaveBeenCalledTimes(2);
		store.close();
	});

	// FLY-1385 QA: the retry ladder's spacing, not just its cap.
	//
	// The backoff reads workflow_side_effect_ledger.created_at, which SQLite fills
	// with `datetime('now')` — a UTC instant rendered as "YYYY-MM-DD HH:MM:SS" with
	// no zone marker. Date.parse treats that shape as LOCAL time, so on a host west
	// of UTC every launch looks like it happened hours in the future and the elapsed
	// time goes negative, blocking the retry for the length of the UTC offset. CI
	// runs in UTC where the offset is zero, so the pin below is what makes this
	// assertion mean anything off the developer's machine.
	//
	// Anchor every clock to the real wall clock: created_at is written by SQLite at
	// insert time and ignores the injected `now`.
	it("spaces replacement launches by the 1/5-minute retry ladder in a non-UTC zone", async () => {
		const originalTz = process.env.TZ;
		// The production Bridge host runs in this zone.
		process.env.TZ = "America/Los_Angeles";
		try {
			const store = await storeWithIntent("implement");
			const fake = fakeStartDispatcher(store);
			const launchedAt = Date.now();
			let now = new Date(launchedAt);
			const dispatcher = new WorkflowEngineDispatcher({
				store,
				startDispatcher: fake.dispatcher,
				stateRoot: mkdtempSync(join(tmpdir(), "fly1385-backoff-")),
				env: WORKFLOW_ON,
				now: () => now,
				resolvePredecessorHead: async () => HEAD,
				probeLaunchLiveness: async () => "dead",
			});
			const at = (ms: number) => {
				now = new Date(launchedAt + ms);
			};
			const killCurrent = () => {
				const node = store.getWorkflowRunNode("run-1", "implement", 1)!;
				store.upsertSession({
					execution_id: node.execution_id!,
					issue_id: "FLY-1307",
					project_name: "flywheel",
					status: "failed",
					workflow_node_id: "implement",
				});
			};

			expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
			expect(fake.requests).toHaveLength(1);

			// Tier 1 = 1 minute after launch 1.
			killCurrent();
			at(30_000);
			await dispatcher.reconcile();
			expect(fake.requests).toHaveLength(1);

			at(61_000);
			await dispatcher.reconcile();
			expect(fake.requests).toHaveLength(2);

			// Tier 2 = 5 minutes, proving the ladder steps forward instead of
			// reusing the first delay.
			killCurrent();
			at(61_000 + 120_000);
			await dispatcher.reconcile();
			expect(fake.requests).toHaveLength(2);

			at(61_000 + 302_000);
			await dispatcher.reconcile();
			expect(fake.requests).toHaveLength(3);

			// Every wait was a hold, never a silent drop: the node still belongs to a
			// live replacement and the run is untouched.
			expect(store.getWorkflowRun("run-1")?.status).toBe("active");
			expect(store.getWorkflowRunNode("run-1", "implement", 1)).toMatchObject({
				state: "running",
				execution_id: fake.requests[2]?.successorExecutionId,
			});
			store.close();
		} finally {
			if (originalTz === undefined) delete process.env.TZ;
			else process.env.TZ = originalTz;
		}
	});

	it("attaches rejection containment to initial and periodic reconciles", async () => {
		vi.useFakeTimers();
		const store = {
			listNonTerminalWorkflowSideEffects: () => [],
		} as unknown as StateStore;
		const startDispatcher = {
			start: vi.fn(),
			getInflightCount: () => 0,
			validateAgentName: () => ({ ok: true as const }),
		} as unknown as IStartDispatcher;
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher,
		});
		const catchRejection = vi.fn(() => Promise.resolve());
		vi.spyOn(dispatcher, "reconcile").mockReturnValue({
			catch: catchRejection,
		} as unknown as Promise<{ started: number; held: number }>);

		try {
			dispatcher.start(1_000);
			expect(catchRejection).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(catchRejection).toHaveBeenCalledTimes(2);
		} finally {
			dispatcher.stop();
			vi.useRealTimers();
		}
	});

	it("contains top-level store read failures", async () => {
		const store = {
			listNonTerminalWorkflowSideEffects: () => {
				throw new Error("database unavailable");
			},
		} as unknown as StateStore;
		const log = vi.fn();
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: {
				start: vi.fn(),
				getInflightCount: () => 0,
				validateAgentName: () => ({ ok: true as const }),
			} as unknown as IStartDispatcher,
			log,
		});

		await expect(dispatcher.reconcile()).resolves.toEqual({
			started: 0,
			held: 0,
		});
		expect(log).toHaveBeenCalledWith(
			"workflow engine reconcile failed: database unavailable",
		);
	});

	it("consumes a durable successor intent exactly once with pinned dispatch", async () => {
		const store = await storeWithIntent("implement");
		const fake = fakeStartDispatcher(store);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1307-engine-dispatch-")),
			env: WORKFLOW_ON,
			resolvePredecessorHead: async () => HEAD,
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(fake.requests[0]).toMatchObject({
			issueId: "FLY-1307",
			projectName: "flywheel",
			successorExecutionId: "implement-1",
			sessionRole: "implement",
			shareParentBranch: true,
			startPoint: HEAD,
			ignoreRunnerLabelSelection: true,
			issueIdentifier: "FLY-1307",
			issueTitle: "DAG template engine",
			designBackend: "claude",
			generalizedExecution: {
				executionId: "implement-1",
				nodeId: "implement",
				dispatch: {
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "xhigh",
				},
			},
		});
		expect(store.listWorkflowSideEffects("run-1")[0]?.state).toBe("started");
		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 0 });
		expect(fake.start).toHaveBeenCalledTimes(1);
		store.close();
	});

	it("closes a delivery wait-boundary race with one final durable owner read", async () => {
		const store = await storeWithIntent("implement");
		const fake = fakeStartDispatcher(store);
		generalizedRecoveryMocks.waitForDelivery.mockResolvedValueOnce(undefined);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1336-engine-boundary-")),
			env: WORKFLOW_ON,
			resolvePredecessorHead: async () => HEAD,
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(fake.start).toHaveBeenCalledOnce();
		expect(store.listWorkflowSideEffects("run-1")[0]?.state).toBe("started");
		store.close();
	});

	it("keeps a foreign live launch owner held without dispatch", async () => {
		const store = await storeWithIntent("implement");
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-1",
				nodeId: "implement",
				executionId: "implement-1",
				attempt: 1,
				now: "2026-07-16T00:06:00.000Z",
				expiresAt: "2026-07-16T00:20:00.000Z",
				absoluteDeadlineAt: "2026-07-16T01:00:00.000Z",
				env: WORKFLOW_ON,
			}),
		).toMatchObject({ ok: true });
		const stateRoot = mkdtempSync(join(tmpdir(), "fly1336-engine-busy-"));
		expect(
			store.recoverOrAcquireWorkflowLaunch({
				executionId: "implement-1",
				ownerId: "foreign-live-owner",
				now: "2026-07-16T00:06:00.000Z",
				leaseExpiresAt: "2026-07-16T00:30:00.000Z",
				markerPath: join(stateRoot, "implement-1"),
			}).status,
		).toBe("acquired");
		const start = vi.fn();
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: {
				start,
				getInflightCount: () => 0,
				validateAgentName: () => ({ ok: true as const }),
			} as IStartDispatcher,
			stateRoot,
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-16T00:07:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
		expect(start).not.toHaveBeenCalled();
		store.close();
	});

	it("does not repair a committed launch without positive dead evidence", async () => {
		const store = await storeWithIntent("implement");
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-1",
				nodeId: "implement",
				executionId: "implement-1",
				attempt: 1,
				now: "2026-07-16T00:06:00.000Z",
				expiresAt: "2026-07-16T00:20:00.000Z",
				absoluteDeadlineAt: "2026-07-16T01:00:00.000Z",
				env: WORKFLOW_ON,
			}),
		).toMatchObject({ ok: true });
		const stateRoot = mkdtempSync(join(tmpdir(), "fly1336-engine-unknown-"));
		const launch = store.recoverOrAcquireWorkflowLaunch({
			executionId: "implement-1",
			ownerId: "completed-owner",
			now: "2026-07-16T00:06:00.000Z",
			leaseExpiresAt: "2026-07-16T00:30:00.000Z",
			markerPath: join(stateRoot, "implement-1"),
		});
		if (launch.status !== "acquired") throw new Error("launch not acquired");
		expect(
			store.fencedCommitWorkflowLaunch({
				executionId: "implement-1",
				ownerId: "completed-owner",
				generation: launch.generation,
				deliveryAttempt: launch.deliveryAttempt,
				markerPath: join(stateRoot, "implement-1"),
				now: "2026-07-16T00:06:30.000Z",
			}),
		).toMatchObject({ ok: true });
		const start = vi.fn();
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: {
				start,
				getInflightCount: () => 0,
				validateAgentName: () => ({ ok: true as const }),
			} as IStartDispatcher,
			stateRoot,
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-16T00:07:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness: async () => "unknown",
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
		expect(start).not.toHaveBeenCalled();
		store.close();
	});

	it("preserves Lead routing and QA-fix context on an engine loop dispatch", async () => {
		const store = await storeWithIntent("qa");
		store.applyWorkflowShadowBatch({
			projectName: "flywheel",
			issueId: "FLY-1307",
			runId: "run-1",
			ops: [
				{
					op: "side_effect",
					node: "qa",
					attempt: 1,
					executionId: "qa-1",
					to: "started",
				},
			],
		});
		store.upsertWorkflowRunNode({
			runId: "run-1",
			nodeId: "qa",
			attempt: 1,
			state: "running",
			executionId: "qa-1",
		});
		store.upsertSession({
			execution_id: "qa-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "completed",
			issue_identifier: "FLY-1307",
			issue_title: "DAG template engine",
			design_backend: "claude",
			doc_tier: "full",
			issue_url: "https://linear.app/flywheel/FLY-1307",
		});
		store.insertEvent({
			event_id: "workflow-decision:qa-1:fail",
			execution_id: "qa-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			event_type: "workflow_decision",
			source: "bridge.workflow-decision",
			payload: { status: "fail", summary: "two acceptance tests failed" },
		});
		expect(
			store.commitWorkflowTransitionTx({
				runId: "run-1",
				nodeId: "qa",
				attempt: 1,
				executionId: "qa-1",
				outcome: "qa_fail",
				successorExecutionId: "implement-fix-1",
				now: "2026-07-16T00:15:00.000Z",
			}),
		).toMatchObject({ ok: true, loopIteration: 1 });

		const fake = fakeStartDispatcher(store);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1307-engine-fix-")),
			env: WORKFLOW_ON,
			resolvePredecessorHead: async () => HEAD,
			resolveLeadId: () => "flywheel-eng-lead",
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(fake.requests[0]).toMatchObject({
			leadId: "flywheel-eng-lead",
			sessionRole: "implement",
			phaseFixContext: {
				round: 1,
				qaSummary: "two acceptance tests failed",
			},
		});
		store.close();
	});

	it("delivers a scoped decision credential to an engine-produced QA node", async () => {
		const store = await storeWithIntent("qa");
		const fake = fakeStartDispatcher(store);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1307-engine-qa-")),
			env: WORKFLOW_ON,
			resolvePredecessorHead: async () => HEAD,
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(fake.requests[0]).toMatchObject({
			sessionRole: "qa",
			generalizedExecution: {
				executionId: "qa-1",
				submissionCredential: expect.any(String),
			},
		});
		store.close();
	});

	it("rotates a lost QA decision credential after admission response loss", async () => {
		const store = await storeWithIntent("qa");
		const admitted = store.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "qa",
			executionId: "qa-1",
			attempt: 1,
			now: "2026-07-16T00:11:00.000Z",
			expiresAt: "2026-07-16T01:11:00.000Z",
			absoluteDeadlineAt: "2026-07-17T00:11:00.000Z",
			env: WORKFLOW_ON,
		});
		expect(admitted).toMatchObject({
			ok: true,
			idempotentReplay: false,
			submissionCredential: expect.any(String),
		});

		const fake = fakeStartDispatcher(store);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1307-engine-recover-")),
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-16T00:12:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(
			fake.requests[0]?.generalizedExecution?.submissionCredential,
		).toEqual(expect.any(String));
		expect(
			fake.requests[0]?.generalizedExecution?.submissionCredential,
		).not.toBe(admitted.ok ? admitted.submissionCredential : undefined);
		store.close();
	});

	it("repairs a committed launch only after the prior runner is proven dead", async () => {
		const store = await storeWithIntent("qa");
		const stateRoot = mkdtempSync(join(tmpdir(), "fly1307-engine-dead-"));
		const markerPath = join(stateRoot, "qa-1");
		const admitted = store.admitGeneralizedWorkflowExecution({
			runId: "run-1",
			nodeId: "qa",
			executionId: "qa-1",
			attempt: 1,
			now: "2026-07-16T00:11:00.000Z",
			expiresAt: "2026-07-16T01:11:00.000Z",
			absoluteDeadlineAt: "2026-07-17T00:11:00.000Z",
			env: WORKFLOW_ON,
		});
		expect(admitted).toMatchObject({
			ok: true,
			submissionCredential: expect.any(String),
		});
		const launch = store.recoverOrAcquireWorkflowLaunch({
			executionId: "qa-1",
			ownerId: "dead-owner",
			now: "2026-07-16T00:11:00.000Z",
			leaseExpiresAt: "2026-07-16T01:11:00.000Z",
			markerPath,
		});
		if (launch.status !== "acquired") throw new Error("launch not acquired");
		expect(
			store.fencedCommitWorkflowLaunch({
				executionId: "qa-1",
				ownerId: "dead-owner",
				generation: launch.generation,
				deliveryAttempt: launch.deliveryAttempt,
				markerPath,
				now: "2026-07-16T00:11:30.000Z",
			}),
		).toMatchObject({ ok: true });

		const fake = fakeStartDispatcher(store);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot,
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-16T00:12:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness: async () => "dead",
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(fake.start).toHaveBeenCalledTimes(1);
		expect(
			fake.requests[0]?.generalizedExecution?.submissionCredential,
		).toEqual(expect.any(String));
		expect(
			fake.requests[0]?.generalizedExecution?.submissionCredential,
		).not.toBe(admitted.ok ? admitted.submissionCredential : undefined);
		expect(store.getWorkflowLaunchOwner("qa-1")).toMatchObject({
			delivery_state: "delivered",
			delivery_attempt: 1,
		});
		store.close();
	});

	it("adopts a completed node receipt without relaunching or regressing its projection", async () => {
		const store = await storeWithIntent("implement");
		store.upsertWorkflowRunNode({
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
			state: "done",
			executionId: "implement-1",
			endedAt: "2026-07-16T00:06:00.000Z",
		});
		const fake = fakeStartDispatcher(store);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1307-engine-adopt-")),
			env: WORKFLOW_ON,
			resolvePredecessorHead: async () => HEAD,
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(fake.start).not.toHaveBeenCalled();
		expect(store.listWorkflowSideEffects("run-1")[0]?.state).toBe("started");
		expect(store.getWorkflowRunNode("run-1", "implement", 1)?.state).toBe(
			"done",
		);
		store.close();
	});

	it("replaces a started execution whose terminal session and liveness prove it dead", async () => {
		const store = await storeWithIntent("implement");
		const fake = fakeStartDispatcher(store);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-dead-sweep-")),
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-22T00:00:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness: async () => "dead",
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(fake.requests).toHaveLength(1);
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "failed",
			workflow_node_id: "implement",
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(fake.requests).toHaveLength(2);
		expect(fake.requests[1]?.successorExecutionId).not.toBe("implement-1");
		expect(store.getWorkflowRunNode("run-1", "implement", 1)).toMatchObject({
			state: "running",
			execution_id: fake.requests[1]?.successorExecutionId,
		});
		expect(store.listWorkflowSideEffects("run-1")).toHaveLength(2);
		store.close();
	});

	it("observes the dead-exec sweep kill switch on every tick without a restart", async () => {
		const store = await storeWithIntent("implement");
		const fake = fakeStartDispatcher(store);
		const env = {
			...WORKFLOW_ON,
			FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP: "0",
		};
		const probeLaunchLiveness = vi.fn(async () => "dead" as const);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-live-sweep-flag-")),
			env,
			now: () => new Date("2026-07-22T00:00:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness,
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "failed",
			workflow_node_id: "implement",
		});

		// OFF is observed at call time: no probe and no replacement mutation.
		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 0 });
		expect(probeLaunchLiveness).not.toHaveBeenCalled();
		expect(fake.requests).toHaveLength(1);
		expect(store.getWorkflowRunNode("run-1", "implement", 1)).toMatchObject({
			state: "running",
			execution_id: "implement-1",
		});

		// The same dispatcher sees the direct-console mutation on its next tick.
		env.FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP = "1";
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(probeLaunchLiveness).toHaveBeenCalledOnce();
		expect(fake.requests).toHaveLength(2);
		expect(fake.requests[1]?.successorExecutionId).not.toBe("implement-1");
		store.close();
	});

	it("keeps the dead execution in place when its tripwire baseline cannot be captured", async () => {
		const store = await storeWithIntent("implement");
		const fake = fakeStartDispatcher(store);
		const log = vi.fn();
		const captureDeadExecutionActivityBaseline = vi.fn(async () => {
			throw new Error("commdb_unreadable");
		});
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-baseline-fail-safe-")),
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-22T00:00:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness: async () => "dead",
			captureDeadExecutionActivityBaseline,
			log,
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "failed",
			workflow_node_id: "implement",
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 0 });
		expect(captureDeadExecutionActivityBaseline).toHaveBeenCalledOnce();
		expect(fake.requests).toHaveLength(1);
		expect(store.getWorkflowRunNode("run-1", "implement", 1)).toMatchObject({
			state: "running",
			execution_id: "implement-1",
		});
		expect(store.getWorkflowDeadExecutionWatch("implement-1")).toBeUndefined();
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining(
				"dead-exec activity baseline held for implement-1: commdb_unreadable",
			),
		);
		store.close();
	});

	it("rotates a bounded tripwire patrol so watches after the first page are not starved", async () => {
		const store = await storeWithIntent("design");
		const fake = fakeStartDispatcher(store);
		const watches: WorkflowDeadExecutionWatchRow[] = Array.from(
			{ length: 201 },
			(_, index) => ({
				dead_execution_id: `dead-${String(index).padStart(3, "0")}`,
				run_id: "run-1",
				node_id: "design",
				attempt: 1,
				new_execution_id: `new-${index}`,
				project_name: "flywheel",
				issue_id: "FLY-1307",
				observed_at: "2026-07-22T00:00:00.000Z",
				baseline: {
					commitMarker: { state: "unknown" },
					commDbMessageCount: null,
					tmuxTarget: null,
					tmuxOutputDigest: null,
					sessionCommitCount: null,
				},
				state: "active",
				tripped_at: null,
				evidence: null,
			}),
		);
		vi.spyOn(
			store,
			"listActiveWorkflowDeadExecutionWatches",
		).mockImplementation((...args: unknown[]) => {
			const limit = typeof args[0] === "number" ? args[0] : 200;
			const after = args[1] as
				| { observedAt: string; deadExecutionId: string }
				| undefined;
			const start = after
				? watches.findIndex(
						(watch) =>
							watch.observed_at > after.observedAt ||
							(watch.observed_at === after.observedAt &&
								watch.dead_execution_id > after.deadExecutionId),
					)
				: 0;
			return start < 0 ? [] : watches.slice(start, start + limit);
		});
		const probeDeadExecutionActivity = vi.fn(async () => null);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-tripwire-patrol-")),
			env: {
				...WORKFLOW_ON,
				FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP: "0",
			},
			resolvePredecessorHead: async () => HEAD,
			probeDeadExecutionActivity,
		});

		await dispatcher.reconcile();
		expect(probeDeadExecutionActivity).toHaveBeenCalledTimes(200);
		await dispatcher.reconcile();
		expect(probeDeadExecutionActivity).toHaveBeenCalledTimes(201);
		expect(probeDeadExecutionActivity.mock.calls.at(-1)?.[0]).toMatchObject({
			dead_execution_id: "dead-200",
		});
		store.close();
	});

	it("keeps a durable tripwire and loudly reports activity from a replaced execution after restart", async () => {
		const store = await storeWithIntent("implement");
		const fake = fakeStartDispatcher(store);
		const baseline = {
			commitMarker: { state: "present" as const, mtimeMs: 100 },
			commDbMessageCount: 4,
			tmuxTarget: "runner-flywheel:@17",
			tmuxOutputDigest: "before",
			sessionCommitCount: 1,
		};
		const first = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-tripwire-first-")),
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-22T00:00:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness: async () => "dead",
			captureDeadExecutionActivityBaseline: async () => baseline,
			probeDeadExecutionActivity: async () => null,
		});
		expect(await first.reconcile()).toEqual({ started: 1, held: 0 });
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "failed",
			workflow_node_id: "implement",
		});
		expect(await first.reconcile()).toEqual({ started: 1, held: 0 });
		expect(store.getWorkflowDeadExecutionWatch("implement-1")).toMatchObject({
			state: "active",
			dead_execution_id: "implement-1",
			baseline,
		});

		// A fresh dispatcher proves the watch is durable, not in-memory state.
		const restarted = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-tripwire-restart-")),
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-22T00:01:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
			probeDeadExecutionActivity: async () => ({
				kind: "commdb_write" as const,
				detail: "message count advanced from 4 to 5",
			}),
			resolveRunAlertIdentity: (projectName) => ({
				leadId: "flywheel-eng-lead",
				projectName,
				leadResolution: "resolved",
			}),
		});
		await restarted.reconcile();
		expect(store.getWorkflowDeadExecutionWatch("implement-1")).toMatchObject({
			state: "tripped",
			evidence: {
				kind: "commdb_write",
				detail: "message count advanced from 4 to 5",
			},
		});
		const tripwireAlerts = store.listWorkflowAlertOutbox();
		expect(tripwireAlerts).toHaveLength(2);
		expect(tripwireAlerts.map((row) => row.payload.eventType).sort()).toEqual([
			"workflow_engine_escalation",
			"workflow_engine_issue_alert",
		]);
		for (const row of tripwireAlerts) {
			expect(row).toEqual(
				expect.objectContaining({
					state: "pending",
					payload: expect.objectContaining({
						severity: "severe",
						sessionKey: "wf:run-1",
						metadata: {
							workflowEngine: expect.objectContaining({
								disposition: "dead_execution_activity_after_replacement",
								executionId: "implement-1",
							}),
						},
					}),
				}),
			);
		}
		await restarted.reconcile();
		expect(store.listWorkflowAlertOutbox()).toHaveLength(2);
		store.close();
	});

	it("logs tmux-only activity without paging or consuming the durable watch", async () => {
		const store = await storeWithIntent("implement");
		const fake = fakeStartDispatcher(store);
		const first = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-tmux-weak-first-")),
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-22T00:00:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness: async () => "dead",
			captureDeadExecutionActivityBaseline: async () => ({
				commitMarker: { state: "absent" as const },
				commDbMessageCount: 0,
				tmuxTarget: "runner-flywheel:@17",
				tmuxOutputDigest: "before",
				sessionCommitCount: 0,
			}),
			probeDeadExecutionActivity: async () => null,
		});
		expect(await first.reconcile()).toEqual({ started: 1, held: 0 });
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "failed",
			workflow_node_id: "implement",
		});
		expect(await first.reconcile()).toEqual({ started: 1, held: 0 });

		const log = vi.fn();
		const restarted = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-tmux-weak-restart-")),
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-22T00:01:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
			probeDeadExecutionActivity: async () => ({
				kind: "tmux_output" as const,
				detail: "tmux output changed on reused runner-flywheel:@17",
			}),
			log,
		});
		await restarted.reconcile();

		expect(store.getWorkflowDeadExecutionWatch("implement-1")).toMatchObject({
			state: "active",
			evidence: null,
		});
		expect(store.listWorkflowAlertOutbox()).toHaveLength(0);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining(
				"dead-exec tripwire tmux-only activity logged for implement-1",
			),
		);
		store.close();
	});

	it("prunes a 24-hour dead-execution watch before the tripwire patrol probes it", async () => {
		const store = await storeWithIntent("implement");
		const fake = fakeStartDispatcher(store);
		const first = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-watch-ttl-first-")),
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-22T00:00:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness: async () => "dead",
			captureDeadExecutionActivityBaseline: async () => ({
				commitMarker: { state: "absent" as const },
				commDbMessageCount: 0,
				tmuxTarget: null,
				tmuxOutputDigest: null,
				sessionCommitCount: 0,
			}),
			probeDeadExecutionActivity: async () => null,
		});
		expect(await first.reconcile()).toEqual({ started: 1, held: 0 });
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "failed",
			workflow_node_id: "implement",
		});
		expect(await first.reconcile()).toEqual({ started: 1, held: 0 });
		expect(store.getWorkflowDeadExecutionWatch("implement-1")).toBeDefined();

		const probeDeadExecutionActivity = vi.fn(async () => ({
			kind: "commdb_write" as const,
			detail: "must not be probed after expiry",
		}));
		const restarted = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-watch-ttl-restart-")),
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-23T00:00:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
			probeDeadExecutionActivity,
		});
		await restarted.reconcile();

		expect(probeDeadExecutionActivity).not.toHaveBeenCalled();
		expect(store.getWorkflowDeadExecutionWatch("implement-1")).toBeUndefined();
		expect(store.listWorkflowAlertOutbox()).toHaveLength(0);
		store.close();
	});

	it("alerts when the same node needs a second dead-execution replacement", async () => {
		const store = await storeWithIntent("implement");
		const fake = fakeStartDispatcher(store);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-repeat-death-")),
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-22T00:00:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness: async () => "dead",
			captureDeadExecutionActivityBaseline: async () => ({
				commitMarker: { state: "absent" as const },
				commDbMessageCount: 0,
				tmuxTarget: null,
				tmuxOutputDigest: null,
				sessionCommitCount: 0,
			}),
			probeDeadExecutionActivity: async () => null,
			resolveRunAlertIdentity: (projectName) => ({
				leadId: "flywheel-eng-lead",
				projectName,
				leadResolution: "resolved",
			}),
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "failed",
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(store.listWorkflowAlertOutbox()).toHaveLength(0);

		const replacementId = fake.requests[1]!.successorExecutionId!;
		store.upsertSession({
			execution_id: replacementId,
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "failed",
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(fake.requests).toHaveLength(3);
		const repeatedAlerts = store.listWorkflowAlertOutbox();
		expect(repeatedAlerts).toHaveLength(2);
		expect(repeatedAlerts.map((row) => row.payload.eventType).sort()).toEqual([
			"workflow_engine_escalation",
			"workflow_engine_issue_alert",
		]);
		for (const row of repeatedAlerts) {
			expect(row.payload.metadata.workflowEngine).toMatchObject({
				disposition: "repeated_dead_execution_pattern",
				nodeId: "implement",
			});
		}
		store.close();
	});

	it("keeps an unknown-liveness terminal execution in place and alerts on the third probe", async () => {
		const store = await storeWithIntent("implement");
		const fake = fakeStartDispatcher(store);
		let now = new Date("2026-07-22T00:00:00.000Z");
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-unknown-probe-")),
			env: WORKFLOW_ON,
			now: () => now,
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness: async () => "unknown",
			resolveRunAlertIdentity: (projectName) => ({
				leadId: "flywheel-eng-lead",
				projectName,
				leadResolution: "resolved",
			}),
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "failed",
		});
		now = new Date("2026-07-22T00:02:00.000Z");

		await dispatcher.reconcile();
		await dispatcher.reconcile();
		expect(store.listWorkflowAlertOutbox()).toHaveLength(0);
		await dispatcher.reconcile();

		expect(fake.requests).toHaveLength(1);
		expect(store.getWorkflowRunNode("run-1", "implement", 1)).toMatchObject({
			state: "running",
			execution_id: "implement-1",
		});
		expect(store.listWorkflowAlertOutbox()).toEqual([
			expect.objectContaining({
				state: "pending",
				payload: expect.objectContaining({
					eventType: "workflow_engine_escalation",
					metadata: {
						workflowEngine: expect.objectContaining({
							disposition: "probe_unknown",
						}),
					},
				}),
			}),
		]);
		store.close();
	});

	it("holds quota/auth deaths immediately and delivers the durable escalation", async () => {
		const store = await storeWithIntent("implement");
		const fake = fakeStartDispatcher(store);
		const alert = vi.fn(async () => ({ sent: true as const }));
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-quota-hold-")),
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-22T00:00:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness: async () => "dead",
			alertSink: { current: { alert } },
			resolveRunAlertIdentity: (projectName) => ({
				leadId: "flywheel-eng-lead",
				projectName,
				leadResolution: "resolved",
			}),
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "failed",
			last_error: "billing quota exhausted; authentication required",
		});

		await dispatcher.reconcile();
		expect(store.getWorkflowRun("run-1")?.status).toBe("held");
		expect(fake.requests).toHaveLength(1);
		expect(store.listWorkflowAlertOutbox()).toEqual([
			expect.objectContaining({
				state: "pending",
				payload: expect.objectContaining({
					eventType: "workflow_engine_escalation",
					leadId: "flywheel-eng-lead",
				}),
			}),
		]);
		await dispatcher.reconcile();
		expect(alert).toHaveBeenCalledWith(
			expect.objectContaining({
				eventId: expect.stringMatching(/:1$/),
				sessionKey: "wf:run-1",
			}),
		);
		expect(store.listWorkflowAlertOutbox()[0]?.state).toBe("sent");
		store.close();
	});

	it("uses only the approved design Fable to GPT-5.6 fallback and reports it", async () => {
		const store = await storeWithIntent("design");
		failRunningDesign(store, "Fable provider is temporarily unavailable");
		const fake = fakeStartDispatcher(store);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-design-fallback-")),
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-22T00:00:00.000Z"),
			probeLaunchLiveness: async () => "dead",
			resolvePredecessorHead: async () => HEAD,
			resolveRunAlertIdentity: (projectName) => ({
				leadId: "flywheel-eng-lead",
				projectName,
				leadResolution: "resolved",
			}),
		});
		await dispatcher.reconcile();
		expect(store.getWorkflowRun("run-1")?.status).toBe("active");
		expect(fake.requests).toHaveLength(1);
		expect(fake.requests[0]?.generalizedExecution?.dispatch).toEqual({
			vendor: "codex",
			model: "gpt-5.6-sol",
			effort: "xhigh",
		});
		const fallbackRuntime = store.getWorkflowExecutionRuntime(
			fake.requests[0]!.successorExecutionId!,
		);
		expect(fallbackRuntime).toMatchObject({
			vendor: "codex",
			model: "gpt-5.6-sol",
		});
		expect(store.listWorkflowAlertOutbox()[0]).toMatchObject({
			state: "pending",
			payload: {
				metadata: {
					workflowEngine: { disposition: "design_fallback" },
				},
			},
		});
		store.close();
	});

	it("holds a design Fable quota/auth death instead of treating it as provider unavailability", async () => {
		const store = await storeWithIntent("design");
		failRunningDesign(
			store,
			"Fable usage limit reached; quota exhausted; authentication required",
		);
		const fake = fakeStartDispatcher(store);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-design-quota-hold-")),
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-22T00:00:00.000Z"),
			probeLaunchLiveness: async () => "dead",
			resolvePredecessorHead: async () => HEAD,
			resolveRunAlertIdentity: (projectName) => ({
				leadId: "flywheel-eng-lead",
				projectName,
				leadResolution: "resolved",
			}),
		});

		await dispatcher.reconcile();
		expect(store.getWorkflowRun("run-1")?.status).toBe("held");
		expect(fake.requests).toHaveLength(0);
		expect(store.listWorkflowAlertOutbox()[0]).toMatchObject({
			state: "pending",
			payload: {
				metadata: {
					workflowEngine: { disposition: "held" },
				},
			},
		});
		store.close();
	});

	it("does not adopt a terminal session as an in-flight dispatch without a receipt", async () => {
		const store = await storeWithIntent("implement");
		store.upsertSession({
			execution_id: "implement-1",
			issue_id: "FLY-1307",
			project_name: "flywheel",
			status: "failed",
			workflow_node_id: "implement",
		});
		const fake = fakeStartDispatcher(store);
		const log = vi.fn();
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1385-terminal-intent-")),
			env: WORKFLOW_ON,
			now: () => new Date("2026-07-22T00:00:00.000Z"),
			resolvePredecessorHead: async () => HEAD,
			probeLaunchLiveness: async () => "alive",
			log,
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 0, held: 1 });
		expect(fake.start).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledWith(
			"workflow engine dispatch held for implement-1: engine_execution_dead",
		);
		expect(store.listWorkflowSideEffects("run-1")[0]?.state).toBe(
			"intent_recorded",
		);
		store.close();
	});

	it("does not regress a node that completes before startDispatcher returns", async () => {
		const store = await storeWithIntent("implement");
		const start = vi.fn(async (request: StartRequest) => {
			const committed = request.generalizedExecution?.commitWorkflowLaunch?.();
			if (!committed?.ok) throw new Error(committed?.reason ?? "not_committed");
			store.upsertSession({
				execution_id: request.generalizedExecution!.executionId,
				issue_id: request.issueId,
				project_name: request.projectName,
				status: "running",
				session_role: request.sessionRole,
			});
			expect(
				store.commitEnrolledCompletion({
					executionId: request.generalizedExecution!.executionId,
					route: "needs_review",
					sourceEventId: "complete-before-start-return",
					completionSubmission: {
						decision: { route: "needs_review" },
					},
				}),
			).toMatchObject({ ok: true });
			return {
				executionId: request.generalizedExecution!.executionId,
				issueId: request.issueId,
			};
		});
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: {
				start,
				getInflightCount: () => 0,
				validateAgentName: () => ({ ok: true as const }),
			} as IStartDispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1307-complete-race-")),
			env: WORKFLOW_ON,
			resolvePredecessorHead: async () => HEAD,
		});

		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(start).toHaveBeenCalledOnce();
		expect(store.getWorkflowRunNode("run-1", "implement", 1)?.state).toBe(
			"done",
		);
		store.close();
	});

	it("holds an output-backed review until durable materialization authority resolves, then launches at that head", async () => {
		const { store, canonicalRoot, env } = await storeWithProductOutputIntent();
		const produce = fakeStartDispatcher(store);
		const produceDispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: produce.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1307-product-produce-")),
			env,
		});
		expect(await produceDispatcher.reconcile()).toEqual({
			started: 1,
			held: 0,
		});
		const outputToken =
			produce.requests[0]?.generalizedExecution?.outputCredential;
		expect(outputToken).toEqual(expect.any(String));
		expect(
			store.submitWorkflowNodeOutput({
				token: outputToken!,
				clientRequestId: "product-output-1",
				payload: JSON.stringify({
					kind: "docs_v1",
					operations: [
						{ op: "write", path: "product/doc/prd.md", content: "PRD\n" },
					],
				}),
			}),
		).toMatchObject({ ok: true });
		store.commitWorkflowTransitionTx({
			runId: "product-run",
			nodeId: "produce",
			attempt: 1,
			executionId: "produce-1",
			outcome: "node_done",
			successorExecutionId: "review-1",
			now: "2026-07-16T00:10:00.000Z",
		});

		const review = fakeStartDispatcher(store);
		const unavailable: MaterializedHeadAuthority = {
			resolve: vi.fn(async () => {
				throw new Error("materialized_head_unavailable");
			}),
		};
		const held = new WorkflowEngineDispatcher({
			store,
			startDispatcher: review.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1307-product-review-")),
			env,
			materializedHeadAuthority: unavailable,
		});
		expect(await held.reconcile()).toEqual({ started: 0, held: 1 });
		expect(review.start).not.toHaveBeenCalled();

		let remoteHead: string | undefined;
		const materializer = new WorkflowDocsMaterializer({
			store,
			projects: [
				{
					projectName: "flywheel",
					projectRoot: canonicalRoot,
					projectRepo: "xrliAnnie/flywheel",
					leads: [],
				},
			],
			withRepoLock: async (_root, fn) => fn(),
			git: {
				resolveBaseHead: async () => "b".repeat(40),
				prepareOrAdoptCommit: async () => ({
					treeHead: "c".repeat(40),
					commitHead: HEAD,
				}),
				readRemoteHead: async () => remoteHead,
				pushCommit: async () => {
					remoteHead = HEAD;
				},
			},
		});
		expect(await materializer.reconcile()).toEqual({
			materialized: 1,
			held: 0,
		});
		const authority = receiptBackedMaterializedHeadAuthority(store);
		const ready = new WorkflowEngineDispatcher({
			store,
			startDispatcher: review.dispatcher,
			stateRoot: mkdtempSync(join(tmpdir(), "fly1307-product-review-ready-")),
			env,
			materializedHeadAuthority: authority,
		});
		expect(await ready.reconcile()).toEqual({ started: 1, held: 0 });
		expect(review.requests[0]).toMatchObject({
			successorExecutionId: "review-1",
			sessionRole: "main",
			startPoint: HEAD,
		});
		store.close();
		rmSync(canonicalRoot, { recursive: true, force: true });
	});

	it("rotates a lost output credential under the committed delivery-repair fence", async () => {
		const { store, canonicalRoot, env } = await storeWithProductOutputIntent();
		const stateRoot = mkdtempSync(join(tmpdir(), "fly1307-output-repair-"));
		const markerPath = join(stateRoot, "produce-1");
		const admitted = store.admitGeneralizedWorkflowExecution({
			runId: "product-run",
			nodeId: "produce",
			executionId: "produce-1",
			attempt: 1,
			now: "2026-07-16T00:06:00.000Z",
			expiresAt: "2026-07-16T01:06:00.000Z",
			absoluteDeadlineAt: "2026-07-17T00:06:00.000Z",
			env,
		});
		expect(admitted).toMatchObject({
			ok: true,
			outputCredential: expect.any(String),
		});
		const launch = store.recoverOrAcquireWorkflowLaunch({
			executionId: "produce-1",
			ownerId: "dead-produce-owner",
			now: "2026-07-16T00:06:00.000Z",
			leaseExpiresAt: "2026-07-16T01:06:00.000Z",
			markerPath,
		});
		if (launch.status !== "acquired") throw new Error("launch not acquired");
		expect(
			store.fencedCommitWorkflowLaunch({
				executionId: "produce-1",
				ownerId: "dead-produce-owner",
				generation: launch.generation,
				deliveryAttempt: launch.deliveryAttempt,
				markerPath,
				now: "2026-07-16T00:06:30.000Z",
			}),
		).toMatchObject({ ok: true });
		const fake = fakeStartDispatcher(store);
		const dispatcher = new WorkflowEngineDispatcher({
			store,
			startDispatcher: fake.dispatcher,
			stateRoot,
			env,
			now: () => new Date("2026-07-16T00:07:00.000Z"),
			probeLaunchLiveness: async () => "dead",
		});
		expect(await dispatcher.reconcile()).toEqual({ started: 1, held: 0 });
		expect(fake.requests[0]?.generalizedExecution?.outputCredential).toEqual(
			expect.any(String),
		);
		expect(fake.requests[0]?.generalizedExecution?.outputCredential).not.toBe(
			admitted.ok ? admitted.outputCredential : undefined,
		);
		store.close();
		rmSync(canonicalRoot, { recursive: true, force: true });
	});
});
