/**
 * FLY-3018: a fresh `/api/runs/start` without overrides routes every weighted
 * node by today's models.json split and bindings — also for an issue whose
 * older runs froze other arms — and the returned `alias (= exact)` receipt is
 * the model the start node is admitted and launched with.
 *
 * Real StateStore + real menu seeds + real runs router; the dispatcher is a
 * fake launcher that records the dispatch it receives and echoes that model as
 * the session's runner model (real provider evidence is QA's, plan §4.E).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { resetModelConfigCacheForTests } from "flywheel-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeFlagStore } from "../bridge/flag-store-runtime.js";
import type {
	IStartDispatcher,
	StartRequest,
} from "../bridge/retry-dispatcher.js";
import { createRunsRouter } from "../bridge/runs-route.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore, type WorkflowRunEventRow } from "../StateStore.js";
import { importWorkflowMenuSeeds } from "../workflow-menu.js";
import { parseWorkflowRunSnapshot } from "../workflow-run-snapshot.js";

const linearMock = { id: "", identifier: "" };
vi.mock("@linear/sdk", () => ({
	LinearClient: class {
		async issue(id: string) {
			return {
				id: linearMock.id,
				title: `Issue ${id}`,
				identifier: linearMock.identifier || id,
				url: `https://linear.app/x/${id}`,
				description: "FLY-3018 routing fixture",
				labels: async () => ({ nodes: [{ name: "Engineering" }] }),
			};
		}
	},
}));

const MASTER = "master-token-fly3018";
const CONFIG_BASE =
	"project: flywheel\nlinear:\n  team_id: FLY\nrunners:\n  default: claude\n  available:\n    claude:\n      type: claude\nteams:\n  - name: default\n    orchestrators:\n      - type: dag\n        runner: claude\ndecision_layer:\n  autonomy_level: advisor\n  escalation_channel: discord\npipeline:\n  dag: true\n  work_kind: true\n";
const DAG_ENV = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
} as const;

// Production records audited in the FLY-3018 plan.
const FLY_2405 = "f94cfb56-810f-429f-b1ef-dea21c320901";
const FLY_2909 = "e6755386-9508-485c-984e-b9224c868d8d";
const FLY_3017 = "678e8bab-2993-44fd-9c3d-f8af08ba9c0a";
/** Today's implement split still lands this issue on the Codex arm. */
const CODEX_IMPLEMENT = "00000000-0000-4000-8000-000003018001";

/** FLY-2405's 09-26 start: implement Astra 3 : Opus 1. */
const HISTORICAL_ASTRA_POLICY = {
	enabled: true,
	rule: "issue_node_weighted",
	nodes: {
		eng_design: [
			{ arm: "design_astra", model: "astra", weight: 1 },
			{ arm: "design_opus", model: "opus", weight: 1 },
		],
		implement: [
			{ arm: "impl_astra", model: "astra", weight: 3 },
			{ arm: "impl_opus", model: "opus", weight: 1 },
		],
		qa: [
			{ arm: "qa_sol56", model: "codex", weight: 3 },
			{ arm: "qa_opus", model: "opus", weight: 1 },
		],
	},
};
/** FLY-2909's 09-26 start: implement Astra 2 : Codex 1 : Opus 1. */
const HISTORICAL_POLICY = {
	enabled: true,
	rule: "issue_node_weighted",
	nodes: {
		eng_design: [
			{ arm: "design_astra", model: "astra", weight: 1 },
			{ arm: "design_opus", model: "opus", weight: 1 },
		],
		implement: [
			{ arm: "impl_astra", model: "astra", weight: 2 },
			{ arm: "impl_sol56", model: "codex", weight: 1 },
			{ arm: "impl_opus", model: "opus", weight: 1 },
		],
		qa: [
			{ arm: "qa_sol56", model: "codex", weight: 3 },
			{ arm: "qa_opus", model: "opus", weight: 1 },
		],
	},
};
/** models.json modelSplit live on 2026-09-28: implement Opus 3 : Codex 1. */
const CURRENT_POLICY = {
	enabled: true,
	rule: "issue_node_weighted",
	balance: { enabled: false },
	nodes: {
		eng_design: [
			{ arm: "design_astra", model: "astra", weight: 1 },
			{ arm: "design_opus", model: "opus", weight: 3 },
		],
		implement: [
			{ arm: "impl_opus", model: "opus", weight: 3 },
			{ arm: "impl_sol56", model: "codex", weight: 1 },
		],
		qa: [
			{ arm: "qa_sol56", model: "codex", weight: 3 },
			{ arm: "qa_opus", model: "opus", weight: 1 },
		],
	},
};

const savedEnv: Record<string, string | undefined> = {};
const cleanups: Array<() => void> = [];
let server: Server | undefined;

beforeEach(() => {
	for (const key of [
		...Object.keys(DAG_ENV),
		"HOME",
		"LINEAR_API_KEY",
		"FLYWHEEL_MODELS_CONFIG",
	]) {
		savedEnv[key] = process.env[key];
	}
	process.env.LINEAR_API_KEY = "test-linear-key";
	for (const [key, value] of Object.entries(DAG_ENV)) process.env[key] = value;
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	resetModelConfigCacheForTests();
	if (server) {
		await new Promise((resolve) => server?.close(resolve));
		server = undefined;
	}
	for (const cleanup of cleanups.splice(0)) cleanup();
});

async function startHarness() {
	const home = mkdtempSync(join(tmpdir(), "fly3018-home-"));
	process.env.HOME = home;
	const projectRoot = mkdtempSync(join(tmpdir(), "fly3018-proj-"));
	cleanups.push(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(projectRoot, { recursive: true, force: true });
	});
	const nodesDir = join(projectRoot, ".flywheel", "agents", "nodes");
	mkdirSync(nodesDir, { recursive: true });
	mkdirSync(join(projectRoot, ".flywheel", "menus"), { recursive: true });
	for (const node of [
		"eng_design",
		"implement",
		"qa",
		"general",
		"pm",
		"product_design",
		"proto",
		"engineer",
		"product_designer",
	]) {
		writeFileSync(join(nodesDir, `${node}.md`), `${node} menu agent.\n`);
	}
	writeFileSync(
		join(projectRoot, ".flywheel", "agents", "registry.yaml"),
		[
			"nodes:",
			"  eng_design: { file: nodes/eng_design.md, department: engineering }",
			"  implement: { file: nodes/implement.md, department: engineering }",
			"  qa: { file: nodes/qa.md, department: engineering }",
			"  general: { file: nodes/general.md }",
			"",
		].join("\n"),
	);
	writeFileSync(
		join(projectRoot, ".flywheel", "menus", "adoption.yaml"),
		"flywheel-eng-lead: [code, simple_code, generic]\n",
	);
	writeFileSync(join(projectRoot, ".flywheel", "config.yaml"), CONFIG_BASE);
	const modelsPath = join(projectRoot, "models.json");
	const writePolicy = (modelSplit: unknown) => {
		writeFileSync(modelsPath, JSON.stringify({ version: 1, modelSplit }));
		resetModelConfigCacheForTests();
	};
	process.env.FLYWHEEL_MODELS_CONFIG = modelsPath;
	writePolicy(CURRENT_POLICY);

	const store = await StateStore.create(":memory:");
	cleanups.push(() => store.close());
	initializeFlagStore(store, {});
	for (const name of ["pipeline_dag", "pipeline_work_kind"]) {
		const changed = store.applyScopedFlagValueChange({
			name,
			scope: "flywheel",
			op: "set",
			rawTo: "1",
			expectedChangeSeq: 0,
			actor: "fixture",
			reason: "FLY-3018 routing fixture",
		});
		if (!changed.ok) throw new Error(`failed to seed ${name}`);
	}
	importWorkflowMenuSeeds(store, process.env);
	for (const [taskCategory, templateId] of [
		["code", "tpl_code"],
		["simple_code", "tpl_simple_code"],
	]) {
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: taskCategory!,
			templateId: templateId!,
			updatedBy: "lead",
		});
	}

	const calls: StartRequest[] = [];
	const dispatcher = {
		getInflightCount: () => 0,
		validateAgentName: () => ({ ok: true }),
		start: async (req: StartRequest) => {
			calls.push(req);
			const executionId = req.generalizedExecution!.executionId;
			store.upsertSession({
				execution_id: executionId,
				issue_id: req.issueId,
				project_name: req.projectName,
				status: "running",
				session_role: req.sessionRole ?? "main",
				// The fake launcher reports the model it was handed.
				runner_model: req.generalizedExecution?.dispatch?.model,
			});
			const commit = req.generalizedExecution?.commitWorkflowLaunch?.();
			if (commit && !commit.ok) {
				throw new Error(`launch commit failed: ${commit.reason}`);
			}
			return { executionId, issueId: req.issueId };
		},
	} as unknown as IStartDispatcher;
	const projects = [
		{
			projectName: "flywheel",
			projectRoot,
			leads: [
				{
					agentId: "flywheel-eng-lead",
					chatChannel: "test",
					match: { labels: ["Engineering"] },
					department: "engineering",
					canSpawnRunners: true,
				},
			],
		},
	] as unknown as ProjectEntry[];
	const app = express();
	app.use(express.json());
	app.use(
		"/api/runs",
		createRunsRouter(
			dispatcher,
			store,
			projects,
			{ tryAdmit: () => ({ admit: true }) } as never,
			undefined,
			false,
			undefined,
			{ nodeStandbyResumeEnabled: () => false, masterToken: MASTER },
			() => ({ hasOverride: false, raw: null }),
			{ ghostGuardSessionWaitMs: 500 },
		),
	);
	server = createServer(app);
	const url = await new Promise<string>((resolve, reject) => {
		server!.on("error", reject);
		server!.listen(0, () => {
			const { port } = server!.address() as AddressInfo;
			resolve(`http://127.0.0.1:${port}`);
		});
	});

	const post = async (body: {
		issueKey: string;
		identifier: string;
		taskCategory: "code" | "simple_code";
		idempotencyKey: string;
	}) => {
		linearMock.id = body.issueKey;
		linearMock.identifier = body.identifier;
		const res = await fetch(`${url}/api/runs/start`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${MASTER}`,
			},
			body: JSON.stringify({
				issueId: body.identifier,
				projectName: "flywheel",
				leadId: "flywheel-eng-lead",
				taskCategory: body.taskCategory,
				idempotencyKey: body.idempotencyKey,
			}),
		});
		return {
			status: res.status,
			json: (await res.json()) as {
				success?: boolean;
				code?: string;
				reason?: string;
				executionId?: string;
				workflowRunId?: string;
				workflowNodeId?: string;
				resolved?: {
					nodeModels?: Record<
						string,
						{ model: string; effort?: string; overridden: boolean }
					>;
				};
			},
		};
	};
	const retire = (runId: string, executionId: string, issueId: string) => {
		store.upsertSession({
			execution_id: executionId,
			issue_id: issueId,
			project_name: "flywheel",
			status: "completed",
		});
		expect(
			store.terminateWorkflowRunByOperator({
				runId,
				reason: "FLY-3018 historical run",
				clientRequestId: `terminate-${runId}`,
				principal: "test",
				evidence: [],
				now: new Date().toISOString(),
			}),
		).toMatchObject({ ok: true, status: "terminated" });
	};
	const assignment = (runId: string, nodeId: string) =>
		store
			.listWorkflowRunEvents(runId)
			.find(
				(event) =>
					event.kind === "model_arm_assigned" && event.node_id === nodeId,
			)?.payload as { arm: string; modelAlias: string; model: string };
	const pinned = (runId: string, nodeId: string) =>
		parseWorkflowRunSnapshot(
			store.getWorkflowRun(runId)!.snapshot!,
		).resolved.nodes.find((node) => node.id === nodeId)!.dispatch!;
	return {
		store,
		calls,
		writePolicy,
		post,
		retire,
		assignment,
		pinned,
	};
}

type Harness = Awaited<ReturnType<typeof startHarness>>;

/** Receipt exact = admitted runtime model = launcher dispatch = session model. */
function expectStartNodeConsistent(
	h: Harness,
	started: Awaited<ReturnType<Harness["post"]>>["json"],
	expected: { alias: string; model: string },
) {
	const nodeId = started.workflowNodeId!;
	const executionId = started.executionId!;
	const receipt = started.resolved!.nodeModels![nodeId]!;
	expect(receipt.model).toBe(`${expected.alias} (= ${expected.model})`);
	const runtime = h.store.getWorkflowExecutionRuntime(executionId)!;
	expect(runtime.model).toBe(expected.model);
	expect(receipt.effort).toBe(runtime.effort ?? undefined);
	const launched = h.calls.find(
		(call) => call.generalizedExecution?.executionId === executionId,
	)!;
	expect(launched.generalizedExecution!.dispatch).toMatchObject({
		model: expected.model,
	});
	expect(h.store.getSession(executionId)?.runner_model).toBe(expected.model);
}

describe("FLY-3018 fresh starts route by today's models.json", () => {
	it("routes old issues with historical Codex implement runs to today's Opus arm", async () => {
		const h = await startHarness();
		const historical = new Map<string, string>();
		for (const [issueKey, identifier, policy, arm] of [
			[FLY_2405, "FLY-2405", HISTORICAL_ASTRA_POLICY, "impl_astra"],
			[FLY_2909, "FLY-2909", HISTORICAL_POLICY, "impl_sol56"],
		] as const) {
			h.writePolicy(policy);
			const old = await h.post({
				issueKey,
				identifier,
				taskCategory: "simple_code",
				idempotencyKey: `${identifier}-historical`,
			});
			expect(old.status, JSON.stringify(old.json)).toBe(200);
			expect(h.assignment(old.json.workflowRunId!, "implement").arm).toBe(arm);
			h.retire(old.json.workflowRunId!, old.json.executionId!, identifier);
			historical.set(
				old.json.workflowRunId!,
				JSON.stringify(h.store.listWorkflowRunEvents(old.json.workflowRunId!)),
			);
		}

		h.writePolicy(CURRENT_POLICY);
		for (const [issueKey, identifier] of [
			[FLY_2405, "FLY-2405"],
			[FLY_2909, "FLY-2909"],
		] as const) {
			const simple = await h.post({
				issueKey,
				identifier,
				taskCategory: "simple_code",
				idempotencyKey: `${identifier}-current-simple`,
			});
			expect(simple.status, JSON.stringify(simple.json)).toBe(200);
			expect(simple.json.workflowNodeId).toBe("implement");
			expectStartNodeConsistent(h, simple.json, {
				alias: "opus",
				model: "claude-opus-5-5",
			});
			expect(
				h.assignment(simple.json.workflowRunId!, "implement"),
			).toMatchObject({
				arm: "impl_opus",
				modelAlias: "opus",
				model: "claude-opus-5-5",
			});
			h.retire(
				simple.json.workflowRunId!,
				simple.json.executionId!,
				identifier,
			);

			// code starts at eng_design; implement is the planned, frozen choice.
			const code = await h.post({
				issueKey,
				identifier,
				taskCategory: "code",
				idempotencyKey: `${identifier}-current-code`,
			});
			expect(code.status, JSON.stringify(code.json)).toBe(200);
			const runId = code.json.workflowRunId!;
			expect(code.json.resolved!.nodeModels!.implement!.model).toBe(
				"opus (= claude-opus-5-5)",
			);
			expect(h.pinned(runId, "implement").model).toBe("claude-opus-5-5");
			for (const nodeId of ["eng_design", "qa"]) {
				const frozen = h.assignment(runId, nodeId);
				expect(code.json.resolved!.nodeModels![nodeId]!.model).toBe(
					`${frozen.modelAlias} (= ${frozen.model})`,
				);
				expect(h.pinned(runId, nodeId).model).toBe(frozen.model);
			}
			const start = h.assignment(runId, "eng_design");
			expectStartNodeConsistent(h, code.json, {
				alias: start.modelAlias,
				model: start.model,
			});
			h.retire(runId, code.json.executionId!, identifier);
		}
		for (const [runId, events] of historical) {
			expect(JSON.stringify(h.store.listWorkflowRunEvents(runId))).toBe(events);
		}
	});

	it("routes a new issue by today's split, including a legitimate Codex arm", async () => {
		const h = await startHarness();
		const opus = await h.post({
			issueKey: FLY_3017,
			identifier: "FLY-3017",
			taskCategory: "simple_code",
			idempotencyKey: "fly3017-current",
		});
		expect(opus.status, JSON.stringify(opus.json)).toBe(200);
		expectStartNodeConsistent(h, opus.json, {
			alias: "opus",
			model: "claude-opus-5-5",
		});
		const codex = await h.post({
			issueKey: CODEX_IMPLEMENT,
			identifier: "FLY-3019",
			taskCategory: "simple_code",
			idempotencyKey: "codex-arm-current",
		});
		expect(codex.status, JSON.stringify(codex.json)).toBe(200);
		expectStartNodeConsistent(h, codex.json, {
			alias: "codex",
			model: "gpt-5.6-sol",
		});
		// A cached start response replays byte-for-byte, with no new launch.
		const replay = await h.post({
			issueKey: CODEX_IMPLEMENT,
			identifier: "FLY-3019",
			taskCategory: "simple_code",
			idempotencyKey: "codex-arm-current",
		});
		expect(replay.status).toBe(200);
		expect(replay.json).toEqual(codex.json);
		expect(h.calls).toHaveLength(2);
	});

	it("refuses a run whose own frozen assignment is corrupt before admission, on every retry", async () => {
		const h = await startHarness();
		let corrupt = false;
		const listEvents = h.store.listWorkflowRunEvents.bind(h.store);
		vi.spyOn(h.store, "listWorkflowRunEvents").mockImplementation(
			(runId: string): WorkflowRunEventRow[] =>
				listEvents(runId).map((event) =>
					corrupt &&
					event.kind === "model_arm_assigned" &&
					event.node_id === "qa"
						? {
								...event,
								payload: {
									...(event.payload as object),
									model: "gpt-6-astra",
								},
							}
						: event,
				),
		);
		const materialize = h.store.materializeWorkflowRun.bind(h.store);
		vi.spyOn(h.store, "materializeWorkflowRun").mockImplementation((input) => {
			const run = materialize(input);
			corrupt = true;
			return run;
		});
		const request = {
			issueKey: FLY_2405,
			identifier: "FLY-2405",
			taskCategory: "simple_code" as const,
			idempotencyKey: "self-corrupt",
		};
		const first = await h.post(request);
		expect(first.status).toBe(409);
		expect(first.json).toMatchObject({
			success: false,
			code: "GENERALIZED_WORKFLOW_REJECTED",
			reason: "reserved workflow model assignment invalid",
		});
		const reservation = h.store.getWorkflowStartReservation("self-corrupt")!;
		expect(reservation).toBeDefined();
		expect(h.store.getWorkflowRun(reservation.run_id)?.status).toBe("active");
		expect(
			h.store.getWorkflowExecutionRuntime(reservation.execution_id),
		).toBeFalsy();
		expect(h.calls).toHaveLength(0);

		// Same key: the replay path refuses identically — no bypass, no new run.
		const retry = await h.post(request);
		expect(retry.status).toBe(409);
		expect(retry.json).toEqual(first.json);
		expect(h.store.getWorkflowStartReservation("self-corrupt")).toEqual(
			reservation,
		);
		expect(h.store.getActiveWorkflowRunForIssue("FLY-2405")?.run_id).toBe(
			reservation.run_id,
		);
		expect(h.calls).toHaveLength(0);

		// Once the record reads back consistent, the same reservation launches
		// its frozen choice and keeps the replay response shape (no receipt).
		corrupt = false;
		const healed = await h.post(request);
		expect(healed.status, JSON.stringify(healed.json)).toBe(200);
		expect(healed.json.workflowRunId).toBe(reservation.run_id);
		expect(healed.json.executionId).toBe(reservation.execution_id);
		expect(healed.json).not.toHaveProperty("resolved");
		expect(h.calls).toHaveLength(1);
		expect(
			h.store.getWorkflowExecutionRuntime(reservation.execution_id)?.model,
		).toBe(h.pinned(reservation.run_id, "implement").model);
	});

	it("refuses a duplicated same-kind assignment before admission, matching the launch reader", async () => {
		const h = await startHarness();
		let duplicate = false;
		const listEvents = h.store.listWorkflowRunEvents.bind(h.store);
		vi.spyOn(h.store, "listWorkflowRunEvents").mockImplementation(
			(runId: string): WorkflowRunEventRow[] =>
				listEvents(runId).flatMap((event) =>
					duplicate &&
					event.kind === "model_arm_assigned" &&
					event.node_id === "implement"
						? [event, { ...event, seq: event.seq + 1000 }]
						: [event],
				),
		);
		const materialize = h.store.materializeWorkflowRun.bind(h.store);
		vi.spyOn(h.store, "materializeWorkflowRun").mockImplementation((input) => {
			const run = materialize(input);
			duplicate = true;
			return run;
		});
		const request = {
			issueKey: FLY_2909,
			identifier: "FLY-2909",
			taskCategory: "simple_code" as const,
			idempotencyKey: "duplicate-assignment",
		};
		const first = await h.post(request);
		expect(first.status, JSON.stringify(first.json)).toBe(409);
		expect(first.json).toMatchObject({
			success: false,
			code: "GENERALIZED_WORKFLOW_REJECTED",
			reason: "reserved workflow model assignment invalid",
		});
		const retry = await h.post(request);
		expect(retry.status).toBe(409);
		expect(retry.json).toEqual(first.json);
		expect(h.calls).toHaveLength(0);
	});

	it("keeps an admitted start accepted when its record changes after admission", async () => {
		const h = await startHarness();
		let corrupt = false;
		const listEvents = h.store.listWorkflowRunEvents.bind(h.store);
		vi.spyOn(h.store, "listWorkflowRunEvents").mockImplementation(
			(runId: string): WorkflowRunEventRow[] =>
				listEvents(runId).map((event) =>
					corrupt && event.kind === "model_arm_assigned"
						? { ...event, payload: undefined }
						: event,
				),
		);
		const admit = h.store.admitGeneralizedWorkflowExecution.bind(h.store);
		vi.spyOn(h.store, "admitGeneralizedWorkflowExecution").mockImplementation(
			(input) => {
				const admitted = admit(input);
				corrupt = true;
				return admitted;
			},
		);
		const started = await h.post({
			issueKey: FLY_3017,
			identifier: "FLY-3017",
			taskCategory: "simple_code",
			idempotencyKey: "post-admission",
		});
		expect(started.status, JSON.stringify(started.json)).toBe(200);
		expect(started.json.success).toBe(true);
		expectStartNodeConsistent(h, started.json, {
			alias: "opus",
			model: "claude-opus-5-5",
		});
	});
});
