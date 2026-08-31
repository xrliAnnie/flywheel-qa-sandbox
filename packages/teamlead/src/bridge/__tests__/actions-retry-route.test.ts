/**
 * FLY-245 D2 — route-level wiring of the gateway pre-bound retry dispatch
 * (plan §5.2.1) through POST /api/actions/retry:
 *   - boundary validation: gateway_request_id + successor_execution_id are
 *     both-or-neither, format-checked at the system boundary;
 *   - first attempt: the intent WAL is committed BEFORE dispatch (a dispatcher
 *     crash leaves the durable binding — the §8 D2 ② window);
 *   - replay without started evidence: re-drives with the SAME successor id;
 *   - binding conflict: rejected without any dispatch;
 *   - legacy requests (no gateway fields): byte-compatible behavior.
 * (The started-evidence convergence verdicts themselves are unit-tested in
 * retry-dispatch-wal.test.ts / started-evidence.test.ts; real-machine
 * convergence is §8.1 QA8.)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	legacyWorkflowSeeds,
	pinLegacyWorkflowSeedAgents,
} from "../../__tests__/fixtures/legacy-workflow-manifests.js";
import { installSelfHostedWorkflowAgentProject } from "../../__tests__/fixtures/workflow-agent-project.js";
import { StateStore } from "../../StateStore.js";
import {
	compileWorkflowMenuSeed,
	loadWorkflowMenuLibrary,
} from "../../workflow-menu.js";
import { createActionRouter } from "../actions.js";
import type { IRetryDispatcher, RetryRequest } from "../retry-dispatcher.js";

const generalizedRecoveryMocks = vi.hoisted(() => ({
	waitForDelivery: vi.fn(),
}));

vi.mock("../generalized-launch-recovery.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../generalized-launch-recovery.js")>();
	return {
		...actual,
		waitForGeneralizedLaunchDelivery: generalizedRecoveryMocks.waitForDelivery,
	};
});

let store: StateStore;
let server: Server;
let baseUrl: string;
let dispatched: RetryRequest[];
let dispatchImpl: (req: RetryRequest) => Promise<{ newExecutionId: string }>;
let generalizedRoot: string | undefined;
let savedHome: string | undefined;

const WORKFLOW_ON = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
};
let savedWorkflowFlags: Record<keyof typeof WORKFLOW_ON, string | undefined>;

function bindPredecessorToGeneralizedWorkflow(): void {
	for (const [name, value] of Object.entries(WORKFLOW_ON)) {
		process.env[name] = value;
	}
	generalizedRoot = mkdtempSync(join(tmpdir(), "fly1336-actions-pending-"));
	process.env.HOME = generalizedRoot;
	installSelfHostedWorkflowAgentProject(generalizedRoot);
	const seed = pinLegacyWorkflowSeedAgents(
		legacyWorkflowSeeds().find(
			(candidate) => candidate.templateId === "tpl_product_v1",
		)!,
	);
	store.importWorkflowTemplateSeed(seed, WORKFLOW_ON);
	store.materializeWorkflowRun({
		runId: "retry-run-1",
		issueId: "issue-1",
		projectName: "fly245-d2-route-test",
		taskCategory: "product",
		templateId: seed.templateId,
		claimsReadEnrolled: true,
		actor: "test",
		canonicalRoot: generalizedRoot,
		env: WORKFLOW_ON,
		startReservation: {
			idempotencyKey: "retry-start-1",
			selectionDigest: "retry-selection-1",
			nodeId: "research",
			attempt: 1,
			executionId: "pred-1",
			createdAt: "2026-07-17T00:00:00.000Z",
		},
	});
	expect(
		store.admitGeneralizedWorkflowExecution({
			runId: "retry-run-1",
			nodeId: "research",
			executionId: "pred-1",
			attempt: 1,
			now: "2026-07-17T00:00:01.000Z",
			expiresAt: "2026-07-17T00:15:00.000Z",
			absoluteDeadlineAt: "2026-07-17T01:00:00.000Z",
			env: WORKFLOW_ON,
			idempotencyKey: "retry-start-1",
		}),
	).toMatchObject({ ok: true });
	// Engine-owned generalized retries consume a pre-reserved successor attempt.
	store.upsertWorkflowRunNode({
		runId: "retry-run-1",
		nodeId: "research",
		attempt: 2,
		state: "pending",
		executionId: "11111111-2222-3333-4444-555555555555",
	});
}

function bindPredecessorToPrdWorkflow(): void {
	for (const [name, value] of Object.entries(WORKFLOW_ON)) {
		process.env[name] = value;
	}
	generalizedRoot = mkdtempSync(join(tmpdir(), "fly1788-actions-prd-"));
	process.env.HOME = generalizedRoot;
	mkdirSync(join(generalizedRoot, ".flywheel", "agents", "nodes"), {
		recursive: true,
	});
	mkdirSync(join(generalizedRoot, ".flywheel", "menus"), { recursive: true });
	writeFileSync(
		join(generalizedRoot, ".flywheel", "agents", "nodes", "pm.md"),
		"Produce the pinned PRD.\n",
	);
	writeFileSync(
		join(generalizedRoot, ".flywheel", "agents", "registry.yaml"),
		"nodes:\n  pm: { file: nodes/pm.md, department: engineering }\n",
	);
	writeFileSync(
		join(generalizedRoot, ".flywheel", "config.yaml"),
		"project: fly245-d2-route-test\n",
	);
	writeFileSync(
		join(generalizedRoot, ".flywheel", "menus", "adoption.yaml"),
		"flywheel-eng-lead:\n  - prd\n",
	);
	const seed = compileWorkflowMenuSeed(
		loadWorkflowMenuLibrary().find((candidate) => candidate.shape === "prd")!,
	);
	store.importWorkflowTemplateSeed(seed, WORKFLOW_ON);
	store.materializeWorkflowRun({
		runId: "retry-run-1",
		issueId: "issue-1",
		projectName: "fly245-d2-route-test",
		taskCategory: "prd",
		templateId: seed.templateId,
		claimsReadEnrolled: true,
		actor: "test",
		canonicalRoot: generalizedRoot,
		env: WORKFLOW_ON,
		startReservation: {
			idempotencyKey: "retry-start-1",
			selectionDigest: "retry-selection-1",
			nodeId: "pm",
			attempt: 1,
			executionId: "pred-1",
			createdAt: "2026-08-16T00:00:00.000Z",
		},
	});
	expect(
		store.admitGeneralizedWorkflowExecution({
			runId: "retry-run-1",
			nodeId: "pm",
			executionId: "pred-1",
			attempt: 1,
			now: "2026-08-16T00:00:01.000Z",
			expiresAt: "2026-08-16T01:00:00.000Z",
			absoluteDeadlineAt: "2026-08-17T00:00:00.000Z",
			env: WORKFLOW_ON,
			idempotencyKey: "retry-start-1",
		}),
	).toMatchObject({ ok: true });
	store.upsertWorkflowRunNode({
		runId: "retry-run-1",
		nodeId: "pm",
		attempt: 2,
		state: "pending",
		executionId: "11111111-2222-3333-4444-555555555555",
	});
}

function makeStubDispatcher(): IRetryDispatcher {
	return {
		dispatch: vi.fn(async (req: RetryRequest) => {
			dispatched.push(req);
			const { newExecutionId } = await dispatchImpl(req);
			return { newExecutionId, oldExecutionId: req.oldExecutionId };
		}),
		getInflightIssues: () => new Set<string>(),
		hasInflightForRole: () => false,
		stopAccepting: () => {},
		drain: async () => {},
		teardownRuntimes: async () => {},
	};
}

async function postRetry(body: Record<string, unknown>) {
	const res = await fetch(`${baseUrl}/api/actions/retry`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return {
		status: res.status,
		json: (await res.json()) as Record<string, unknown>,
	};
}

beforeEach(async () => {
	savedHome = process.env.HOME;
	savedWorkflowFlags = Object.fromEntries(
		Object.keys(WORKFLOW_ON).map((name) => [name, process.env[name]]),
	) as Record<keyof typeof WORKFLOW_ON, string | undefined>;
	store = await StateStore.create(":memory:");
	store.upsertSession({
		execution_id: "pred-1",
		issue_id: "issue-1",
		project_name: "fly245-d2-route-test",
		status: "failed",
	});
	dispatched = [];
	generalizedRoot = undefined;
	generalizedRecoveryMocks.waitForDelivery
		.mockReset()
		.mockResolvedValue(undefined);
	dispatchImpl = async (req) => {
		const id = req.successorExecutionId ?? `gen-${dispatched.length}`;
		// Simulate Blueprint creating the successor row (waitForSession target).
		store.upsertSession({
			execution_id: id,
			issue_id: req.issueId,
			project_name: req.projectName,
			status: "running",
		});
		return { newExecutionId: id };
	};
	delete process.env.LINEAR_API_KEY;
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});

	const app = express();
	app.use(express.json());
	app.use(
		"/api/actions",
		createActionRouter(
			store,
			[],
			undefined,
			{ defaultLeadAgentId: "flywheel-eng-lead" } as never,
			makeStubDispatcher(),
		),
	);
	server = createServer(app);
	await new Promise<void>((res) => server.listen(0, res));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	await new Promise<void>((res, rej) =>
		server.close((e) => (e ? rej(e) : res())),
	);
	vi.restoreAllMocks();
	store.close();
	if (generalizedRoot) {
		rmSync(generalizedRoot, { recursive: true, force: true });
	}
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	for (const name of Object.keys(WORKFLOW_ON) as Array<
		keyof typeof WORKFLOW_ON
	>) {
		const saved = savedWorkflowFlags[name];
		if (saved === undefined) delete process.env[name];
		else process.env[name] = saved;
	}
});

describe("POST /api/actions/retry — D2 boundary validation", () => {
	it("400 when gateway_request_id is sent without successor_execution_id", async () => {
		const r = await postRetry({
			execution_id: "pred-1",
			gateway_request_id: "gwreq-12345",
		});
		expect(r.status).toBe(400);
		expect(dispatched).toHaveLength(0);
	});

	it("400 when successor_execution_id is sent without gateway_request_id", async () => {
		const r = await postRetry({
			execution_id: "pred-1",
			successor_execution_id: "11111111-2222-3333-4444-555555555555",
		});
		expect(r.status).toBe(400);
		expect(dispatched).toHaveLength(0);
	});

	it("400 on a malformed successor_execution_id (boundary format check)", async () => {
		const r = await postRetry({
			execution_id: "pred-1",
			gateway_request_id: "gwreq-12345",
			successor_execution_id: "../etc/passwd",
		});
		expect(r.status).toBe(400);
		expect(dispatched).toHaveLength(0);
	});

	it("400 on a non-string gateway_request_id", async () => {
		const r = await postRetry({
			execution_id: "pred-1",
			gateway_request_id: 42,
			successor_execution_id: "11111111-2222-3333-4444-555555555555",
		});
		expect(r.status).toBe(400);
		expect(dispatched).toHaveLength(0);
	});
});

describe("POST /api/actions/retry — D2 pre-bound dispatch flow", () => {
	const SUCC = "11111111-2222-3333-4444-555555555555";
	const gw = {
		gateway_request_id: "gwreq-12345",
		successor_execution_id: SUCC,
	};

	it("first attempt: WAL recorded, dispatcher receives the pre-bound id, lineage + dispatched persisted", async () => {
		const r = await postRetry({ execution_id: "pred-1", ...gw });
		expect(r.status).toBe(200);
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]?.successorExecutionId).toBe(SUCC);
		expect(store.getRetryDispatchIntent("gwreq-12345")?.state).toBe(
			"dispatched",
		);
		expect(store.getSession("pred-1")?.retry_successor).toBe(SUCC);
	});

	it("② crash window: dispatcher throws AFTER the intent commit → failure response, but the durable binding survives in state=intent", async () => {
		dispatchImpl = async () => {
			throw new Error("bridge crashed mid-dispatch");
		};
		const r = await postRetry({ execution_id: "pred-1", ...gw });
		expect(r.status).toBe(400);
		const intent = store.getRetryDispatchIntent("gwreq-12345");
		expect(intent?.successor_execution_id).toBe(SUCC);
		expect(intent?.state).toBe("intent"); // never marked dispatched
	});

	it("replay with intent + no started evidence: re-drives with the SAME successor id", async () => {
		// the binding exists from a previous (crashed) attempt
		store.recordRetryDispatchIntent("gwreq-12345", SUCC, "pred-1");
		// default evidence checker: no CommDB for this project → no_row → re-drive
		const r = await postRetry({ execution_id: "pred-1", ...gw });
		expect(r.status).toBe(200);
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]?.successorExecutionId).toBe(SUCC);
	});

	it("conflict: same request id with a different successor id → 400, dispatcher never called", async () => {
		store.recordRetryDispatchIntent("gwreq-12345", SUCC, "pred-1");
		const r = await postRetry({
			execution_id: "pred-1",
			gateway_request_id: "gwreq-12345",
			successor_execution_id: "99999999-8888-7777-6666-555555555555",
		});
		expect(r.status).toBe(400);
		expect(dispatched).toHaveLength(0);
		// binding unchanged
		expect(
			store.getRetryDispatchIntent("gwreq-12345")?.successor_execution_id,
		).toBe(SUCC);
	});

	it("legacy request (no gateway fields): dispatcher called WITHOUT a pre-bound id, no WAL row", async () => {
		const r = await postRetry({ execution_id: "pred-1" });
		expect(r.status).toBe(200);
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]?.successorExecutionId).toBeUndefined();
	});

	it("a legacy workflow binding without a v2 snapshot stays on legacy retry", async () => {
		store.createWorkflowRun({
			runId: "legacy-shadow-run",
			issueId: "issue-1",
			projectName: "fly245-d2-route-test",
			claimsReadEnrolled: false,
		});
		expect(
			store.admitWorkflowExecution({
				runId: "legacy-shadow-run",
				nodeId: "qa",
				executionId: "pred-1",
				attempt: 1,
				family: "qa_verdict",
				now: "2026-07-15T00:00:00.000Z",
				expiresAt: "2026-07-15T00:05:00.000Z",
				absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
			}),
		).toMatchObject({ ok: true });

		const result = await postRetry({ execution_id: "pred-1" });
		expect(result.status).toBe(200);
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]?.generalizedExecution).toBeUndefined();
	});

	// Codex R2 MED-6: a POST-dispatch bookkeeping failure must NOT be reported as
	// a clean failure (the gateway would map the 4xx to `not_dispatched` and allow
	// a SECOND successor). Once dispatch() returns, the Runner is starting → the
	// response stays success with the bound successor id.
	it("MED-6: a post-dispatch StateStore error STILL reports success (dispatch already started)", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(store, "setRetrySuccessor").mockImplementation(() => {
			throw new Error("state write blew up AFTER dispatch started");
		});
		const r = await postRetry({ execution_id: "pred-1", ...gw });
		expect(r.status).toBe(200); // NOT a 4xx → gateway will not terminalize
		expect(r.json.success).toBe(true);
		expect(dispatched).toHaveLength(1); // the dispatch DID happen
		expect(dispatched[0]?.successorExecutionId).toBe(SUCC);
	});

	it("returns 202 pending only after healthy lineage and WAL writes are durable", async () => {
		bindPredecessorToGeneralizedWorkflow();
		const admit = vi.spyOn(store, "admitGeneralizedWorkflowExecution");
		const r = await postRetry({ execution_id: "pred-1", ...gw });
		expect(r.status, JSON.stringify(r.json)).toBe(202);
		expect(r.json).toMatchObject({ success: true, pending: true });
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]?.generalizedExecution).toMatchObject({
			engineOwned: true,
			activationId: expect.any(String),
			launchGeneration: 1,
			capabilities: { founder_review_required: false },
			projectTurn: expect.any(Function),
		});
		dispatched[0]?.generalizedExecution?.prepareWorkflowIssueDelivery?.({
			sourceKind: "authoritative",
			body: "Retry issue body",
			anchorCommit: "a".repeat(40),
		});
		expect(
			store
				.listWorkflowRunEvents("retry-run-1")
				.some((event) => event.kind === "issue_delivery_prepared"),
		).toBe(true);
		expect(store.getSession("pred-1")?.retry_successor).toBe(SUCC);
		expect(store.getRetryDispatchIntent("gwreq-12345")?.state).toBe(
			"dispatched",
		);
		expect(store.getSession("pred-1")?.status).toBe("failed");
		const admission = admit.mock.calls[0]?.[0];
		expect(Date.parse(admission!.expiresAt) - Date.parse(admission!.now!)).toBe(
			60 * 60_000,
		);
		expect(
			Date.parse(admission!.absoluteDeadlineAt) - Date.parse(admission!.now!),
		).toBe(24 * 60 * 60_000);
	});

	it("FLY-1788: a tpl_prd retry carries activation authority and founder-review capability", async () => {
		bindPredecessorToPrdWorkflow();

		const r = await postRetry({ execution_id: "pred-1", ...gw });

		expect(r.status, JSON.stringify(r.json)).toBe(202);
		expect(dispatched).toHaveLength(1);
		const workflow = dispatched[0]?.generalizedExecution;
		expect(workflow).toMatchObject({
			engineOwned: true,
			executionId: SUCC,
			activationId: expect.any(String),
			runId: "retry-run-1",
			nodeId: "pm",
			attempt: 2,
			capabilities: { founder_review_required: true },
			projectTurn: expect.any(Function),
		});
		expect(
			workflow?.projectTurn?.({
				activationId: workflow.activationId!,
				issueId: "issue-1",
				executionId: SUCC,
				epoch: 1,
				sourceEventId: `turn:spawn:${SUCC}`,
				grantedAt: "2026-08-16T00:01:00.000Z",
			}),
		).toMatchObject({ ok: true });
	});

	it("FLY-1788: a pre-dispatch generic mint failure releases the launch owner", async () => {
		bindPredecessorToPrdWorkflow();
		dispatchImpl = async () => {
			throw new Error("activation mint failed before launch");
		};

		const r = await postRetry({ execution_id: "pred-1", ...gw });

		expect(r.status).toBe(400);
		expect(dispatched).toHaveLength(1);
		expect(store.getWorkflowLaunchOwner(SUCC)).toMatchObject({
			owner_generation: 1,
			released_generation: 1,
			released_reason: expect.stringContaining("dispatcher_start_failed"),
		});
	});

	it("still attempts the WAL write and returns accepted-pending when lineage persistence throws", async () => {
		bindPredecessorToGeneralizedWorkflow();
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(store, "setRetrySuccessor").mockImplementation(() => {
			throw new Error("lineage unavailable");
		});
		const mark = vi.spyOn(store, "markRetryDispatchDispatched");
		const r = await postRetry({ execution_id: "pred-1", ...gw });
		expect(r.status, JSON.stringify(r.json)).toBe(202);
		expect(r.json).toMatchObject({ success: true, pending: true });
		expect(mark).toHaveBeenCalledWith("gwreq-12345");
		expect(dispatched).toHaveLength(1);
	});

	it("returns accepted-pending without redispatch when the WAL dispatched write throws", async () => {
		bindPredecessorToGeneralizedWorkflow();
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(store, "markRetryDispatchDispatched").mockImplementation(() => {
			throw new Error("WAL unavailable");
		});
		const lineage = vi.spyOn(store, "setRetrySuccessor");
		const r = await postRetry({ execution_id: "pred-1", ...gw });
		expect(r.status, JSON.stringify(r.json)).toBe(202);
		expect(r.json).toMatchObject({ success: true, pending: true });
		expect(lineage).toHaveBeenCalledWith("pred-1", SUCC);
		expect(dispatched).toHaveLength(1);
	});

	it("uses a final durable read to return normal success at the delivery wait boundary", async () => {
		bindPredecessorToGeneralizedWorkflow();
		dispatchImpl = async (req) => {
			const id = req.successorExecutionId!;
			store.upsertSession({
				execution_id: id,
				issue_id: req.issueId,
				project_name: req.projectName,
				status: "running",
			});
			expect(req.generalizedExecution?.commitWorkflowLaunch?.()).toMatchObject({
				ok: true,
			});
			return { newExecutionId: id };
		};
		const r = await postRetry({ execution_id: "pred-1", ...gw });
		expect(r.status, JSON.stringify(r.json)).toBe(200);
		expect(r.json).toMatchObject({ success: true });
		expect(r.json.pending).toBeUndefined();
		expect(dispatched).toHaveLength(1);
	});

	it("MED-6: a PRE-dispatch failure still terminalizes cleanly (4xx, nothing started)", async () => {
		dispatchImpl = async () => {
			throw new Error("admission deferred — nothing started");
		};
		const r = await postRetry({ execution_id: "pred-1", ...gw });
		expect(r.status).toBe(400); // pre-dispatch → safe to terminalize
		expect(r.json.success).toBe(false);
	});
});

/**
 * Shared-worktree rows preserve their branch/role identity, while dispatch
 * models come only from the persisted request or the canonical DAG snapshot.
 */
describe("POST /api/actions/retry — shared-worktree row continuity", () => {
	it("rejects a design retry without a Lead before closing its preserved runner", async () => {
		store.upsertSession({
			execution_id: "phase-design-no-lead",
			issue_id: "issue-no-lead",
			project_name: "fly245-d2-route-test",
			status: "failed",
			chat_thread_role: "design",
		});
		const app = express();
		app.use(express.json());
		app.use(
			"/api/actions",
			createActionRouter(store, [], undefined, undefined, makeStubDispatcher()),
		);
		const noLeadServer = createServer(app);
		await new Promise<void>((resolve) => noLeadServer.listen(0, resolve));
		try {
			const url = `http://127.0.0.1:${(noLeadServer.address() as AddressInfo).port}`;
			const response = await fetch(`${url}/api/actions/retry`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ execution_id: "phase-design-no-lead" }),
			});
			const body = (await response.json()) as { message?: string };
			expect(response.status).toBe(400);
			expect(body.message).toMatch(
				/resolved Lead.*preserved runner left intact/i,
			);
			expect(dispatched).toHaveLength(0);
			expect(
				store
					.getEventsByExecution("phase-design-no-lead")
					.some((event) => event.event_type.startsWith("lead_close_runner")),
			).toBe(false);
		} finally {
			await new Promise<void>((resolve, reject) =>
				noLeadServer.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});

	it("preserves a locked codex design backend without synthesizing a model triple", async () => {
		store.upsertSession({
			execution_id: "phase-design-codex",
			issue_id: "issue-1259-codex",
			project_name: "fly245-d2-route-test",
			status: "failed",
			chat_thread_role: "design",
			design_backend: "codex",
		});

		const r = await postRetry({ execution_id: "phase-design-codex" });

		expect(r.status).toBe(200);
		expect(dispatched[0]?.designBackend).toBe("codex");
		expect(dispatched[0]?.dispatchVendor).toBeUndefined();
		expect(dispatched[0]?.dispatchModel).toBeUndefined();
		expect(dispatched[0]?.dispatchEffort).toBeUndefined();
	});

	it("preserves a locked claude design backend without synthesizing a model triple", async () => {
		store.upsertSession({
			execution_id: "phase-design-claude",
			issue_id: "issue-1259-claude",
			project_name: "fly245-d2-route-test",
			status: "failed",
			chat_thread_role: "design",
			design_backend: "claude",
		});

		const r = await postRetry({ execution_id: "phase-design-claude" });

		expect(r.status).toBe(200);
		expect(dispatched[0]?.designBackend).toBe("claude");
		expect(dispatched[0]?.dispatchVendor).toBeUndefined();
		expect(dispatched[0]?.dispatchModel).toBeUndefined();
		expect(dispatched[0]?.dispatchEffort).toBeUndefined();
	});

	it("a design row without a persisted backend does not consult hidden config", async () => {
		store.upsertSession({
			execution_id: "phase-design-legacy",
			issue_id: "issue-1259-legacy",
			project_name: "fly245-d2-route-test",
			status: "failed",
			chat_thread_role: "design",
		});

		const r = await postRetry({ execution_id: "phase-design-legacy" });

		expect(r.status).toBe(200);
		expect(dispatched[0]?.dispatchVendor).toBeUndefined();
		expect(dispatched[0]?.dispatchModel).toBeUndefined();
		expect(dispatched[0]?.dispatchEffort).toBeUndefined();
		expect(dispatched[0]?.designBackend).toBeUndefined();
	});

	it("a shared phase row retries with its persisted dispatch model", async () => {
		store.upsertSession({
			execution_id: "phase-impl-1",
			issue_id: "issue-887",
			project_name: "fly245-d2-route-test",
			status: "failed",
			chat_thread_role: "implement",
			dispatch_model: "claude-fable-5",
			issue_labels: JSON.stringify(["sonnet"]),
		});
		const r = await postRetry({ execution_id: "phase-impl-1" });
		expect(r.status).toBe(200);
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]?.dispatchModel).toBe("claude-fable-5");
		expect(dispatched[0]?.dispatchVendor).toBeUndefined();
		expect(dispatched[0]?.dispatchEffort).toBeUndefined();
		expect(dispatched[0]?.ignoreRunnerLabelSelection).toBeUndefined();
		// FLY-1224 (R1 #1, settles FLY-840): a phase-row retry keeps its
		// shared-branch identity + phase sessionRole.
		expect(dispatched[0]?.shareParentBranch).toBe(true);
		expect(dispatched[0]?.sessionRole).toBe("implement");
	});

	it("FLY-1224 (R2 #3): a POLLUTED row (chat_thread_role=implement, session_role=main) retries as a PHASE", async () => {
		// An old/polluted row can carry the durable phase marker while its
		// session_role drifted to main. The retry must follow the DURABLE marker
		// for role + vendor + branch identity — otherwise the codex runner starts
		// in a non-phase identity on an independent branch.
		store.upsertSession({
			execution_id: "phase-impl-drift",
			issue_id: "issue-887",
			project_name: "fly245-d2-route-test",
			status: "failed",
			chat_thread_role: "implement",
			session_role: "main",
		});
		const r = await postRetry({ execution_id: "phase-impl-drift" });
		expect(r.status).toBe(200);
		expect(dispatched[0]?.sessionRole).toBe("implement");
		expect(dispatched[0]?.dispatchVendor).toBeUndefined();
		expect(dispatched[0]?.shareParentBranch).toBe(true);
	});

	it("a historical phase row retains its persisted model without a hidden override", async () => {
		store.upsertSession({
			execution_id: "phase-qa-1",
			issue_id: "issue-887",
			project_name: "fly245-d2-route-test",
			status: "failed",
			chat_thread_role: "qa",
			dispatch_model: "claude-sonnet-5",
			issue_labels: JSON.stringify(["sonnet"]),
		});
		const r = await postRetry({ execution_id: "phase-qa-1" });
		expect(r.status).toBe(200);
		expect(dispatched[0]?.dispatchModel).toBe("claude-sonnet-5");
		expect(dispatched[0]?.dispatchVendor).toBeUndefined();
		expect(dispatched[0]?.dispatchEffort).toBeUndefined();
		expect(dispatched[0]?.ignoreRunnerLabelSelection).toBeUndefined();
	});

	it("a historical phase row with no persisted model does not invent one", async () => {
		store.upsertSession({
			execution_id: "phase-design-1",
			issue_id: "issue-887",
			project_name: "fly245-d2-route-test",
			status: "failed",
			chat_thread_role: "design",
		});
		const r = await postRetry({ execution_id: "phase-design-1" });
		expect(r.status).toBe(200);
		expect(dispatched[0]?.dispatchModel).toBeUndefined();
		expect(dispatched[0]?.ignoreRunnerLabelSelection).toBeUndefined();
	});

	it("BYTE-COMPAT sentinel: a main-row retry (auto-QA / single-session shape) is untouched", async () => {
		store.upsertSession({
			execution_id: "main-1",
			issue_id: "issue-main",
			project_name: "fly245-d2-route-test",
			status: "failed",
			chat_thread_role: "main",
			dispatch_model: "claude-sonnet-5",
			issue_labels: JSON.stringify(["sonnet"]),
		});
		const r = await postRetry({ execution_id: "main-1" });
		expect(r.status).toBe(200);
		// Exactly the pre-FLY-887 behavior: persisted dispatch model reused,
		// label layer NOT bypassed. FLY-1224: vendor/effort/shareParentBranch
		// stay undefined and sessionRole stays the persisted value (byte-compat).
		expect(dispatched[0]?.dispatchModel).toBe("claude-sonnet-5");
		expect(dispatched[0]?.ignoreRunnerLabelSelection).toBeUndefined();
		expect(dispatched[0]?.dispatchVendor).toBeUndefined();
		expect(dispatched[0]?.dispatchEffort).toBeUndefined();
		expect(dispatched[0]?.shareParentBranch).toBeUndefined();
		expect(dispatched[0]?.sessionRole).toBe("main");
	});
});
