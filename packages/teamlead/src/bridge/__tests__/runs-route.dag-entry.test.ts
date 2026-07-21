/**
 * FLY-1372: the pipeline.dag dispatch entry (问题⓪) — fresh-domain routing
 * matrix. Real StateStore (:memory:) + real config.yaml on disk (temp project
 * root) + mocked @linear/sdk (the route's dynamic import) + a fake dispatcher
 * that simulates the real convergence surface: it creates the session row AND
 * calls `generalizedExecution.commitWorkflowLaunch()` (without the commit the
 * route would wait for delivery and answer 202/500, hiding the 200 main path).
 *
 * Matrix rows (plan §3.1): #1 DAG entry 200 · #2/#2b flags · #3 no config key
 * · #4 no-three-stage label · #5 scoped auth · #6 qa role · #7 designBackend
 * 400 · #9b/#9c candidate missing · #10 param echo · #13 v2 untouched.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import {
	loadBundledWorkflowSeeds,
	workflowSeedContentHash,
} from "../../workflow-template.js";
import type { IStartDispatcher, StartRequest } from "../retry-dispatcher.js";
import { createRunsRouter } from "../runs-route.js";

// ── Linear pre-flight mock (route does a dynamic import) ──
const linearMock = { labels: [] as string[] };
vi.mock("@linear/sdk", () => ({
	LinearClient: class {
		async issue(id: string) {
			return {
				title: `Issue ${id}`,
				identifier: id,
				url: `https://linear.app/x/${id}`,
				labels: async () => ({
					nodes: linearMock.labels.map((name) => ({ name })),
				}),
			};
		}
	},
}));

const MASTER = "master-token-fly1372";
const SCOPED = "scoped-token-fly1372";

// ConfigLoader-valid minimal project config (it requires runners/teams/
// decision_layer to load at all — verified against the built loader).
const CONFIG_BASE =
	"project: flywheel\nlinear:\n  team_id: FLY\nrunners:\n  default: claude\n  available:\n    claude:\n      type: claude\nteams:\n  - name: default\n    orchestrators:\n      - type: dag\n        runner: claude\ndecision_layer:\n  autonomy_level: advisor\n  escalation_channel: discord\n";

const DAG_ENV = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
} as const;

const savedEnv: Record<string, string | undefined> = {};
const cleanups: Array<() => void> = [];
let server: Server | undefined;

function v2Seed() {
	const seed = {
		templateId: "tpl_fly1385_v2_entry",
		name: "FLY-1385 v2 entry",
		projectScope: "global",
		manifest: {
			schema_version: 2 as const,
			nodes: [
				{
					id: "research",
					type: "generic" as const,
					vendor: "codex" as const,
					model: "gpt-5.6-sol",
					effort: "low" as const,
					agent_file: "agents/generic.md",
				},
				{ id: "founder_gate", type: "gate" as const },
			],
			edges: [
				{
					id: "done",
					from: "research",
					to: "founder_gate",
					condition: "node_done" as const,
				},
			],
			loops: [],
			terminal_gate: {
				node: "founder_gate",
				predicate: "founder_approved" as const,
			},
			ship_claims: ["founder_approved" as const],
		},
	};
	return { ...seed, contentHash: workflowSeedContentHash(seed) };
}

beforeEach(() => {
	for (const key of [
		...Object.keys(DAG_ENV),
		"HOME",
		"LINEAR_API_KEY",
		"FLYWHEEL_THREE_STAGE",
	]) {
		savedEnv[key] = process.env[key];
	}
	process.env.LINEAR_API_KEY = "test-linear-key";
	linearMock.labels = [];
});

afterEach(async () => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (server) {
		await new Promise((resolve) => server?.close(resolve));
		server = undefined;
	}
	for (const cleanup of cleanups.splice(0)) cleanup();
});

interface Harness {
	url: string;
	store: StateStore;
	calls: StartRequest[];
	projectRoot: string;
}

async function startHarness(options: {
	env?: Partial<Record<keyof typeof DAG_ENV, string>>;
	configYaml?: string;
	seedBinding?: boolean;
	templateSchema?: 1 | 2;
}): Promise<Harness> {
	// Isolate HOME so launch-commit markers never touch the real ~/.flywheel.
	const home = mkdtempSync(join(tmpdir(), "fly1372-home-"));
	process.env.HOME = home;
	const projectRoot = mkdtempSync(join(tmpdir(), "fly1372-proj-"));
	cleanups.push(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(projectRoot, { recursive: true, force: true });
	});
	mkdirSync(join(projectRoot, ".flywheel"), { recursive: true });
	mkdirSync(join(projectRoot, "agents"), { recursive: true });
	writeFileSync(join(projectRoot, "agents", "generic.md"), "Do the work.\n");
	writeFileSync(
		join(projectRoot, ".flywheel", "config.yaml"),
		options.configYaml ?? `${CONFIG_BASE}pipeline:\n  dag: true\n`,
	);
	for (const [key, value] of Object.entries({ ...DAG_ENV, ...options.env })) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}

	const store = await StateStore.create(":memory:");
	cleanups.push(() => store.close());
	if (options.seedBinding !== false) {
		const seed =
			options.templateSchema === 2
				? v2Seed()
				: loadBundledWorkflowSeeds().find(
						(candidate) => candidate.templateId === "tpl_eng_heavy",
					)!;
		store.importWorkflowTemplateSeed(seed, process.env);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "*",
			templateId: seed.templateId,
			updatedBy: "lead",
		});
	}

	const calls: StartRequest[] = [];
	const dispatcher = {
		getInflightCount: () => 0,
		validateAgentName: () => ({ ok: true }),
		start: async (req: StartRequest) => {
			calls.push(req);
			const executionId =
				req.generalizedExecution?.executionId ?? `legacy-${calls.length}`;
			store.upsertSession({
				execution_id: executionId,
				issue_id: req.issueId,
				project_name: req.projectName,
				status: "running",
				session_role: req.sessionRole ?? "main",
			});
			if (req.generalizedExecution) {
				const commit = req.generalizedExecution.commitWorkflowLaunch?.();
				if (commit && !commit.ok) {
					throw new Error(`launch commit failed: ${commit.reason}`);
				}
			}
			return { executionId, issueId: req.issueId };
		},
	} as unknown as IStartDispatcher;

	const projects = [
		{ projectName: "flywheel", projectRoot, leads: [] },
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
			{ masterToken: MASTER, scopedToken: SCOPED },
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
	return { url, store, calls, projectRoot };
}

async function post(
	url: string,
	body: Record<string, unknown>,
	token = MASTER,
) {
	const res = await fetch(`${url}/api/runs/start`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({
			issueId: "FLY-802",
			projectName: "flywheel",
			...body,
		}),
	});
	return {
		status: res.status,
		json: (await res.json()) as Record<string, unknown>,
	};
}

describe("FLY-1372 DAG dispatch entry — fresh domain", () => {
	it("#1 flags ON + pipeline.dag + main + master → generalized engine-owned start, not legacy", async () => {
		const h = await startHarness({});
		const { status, json } = await post(h.url, {});
		expect(status).toBe(200);
		expect(json.generalized).toBe(true);
		expect(json.workflowRunId).toBeTruthy();
		const run = h.store.getWorkflowRun(json.workflowRunId as string)!;
		expect(run.engine_owned).toBe(1);
		expect(run.claims_read_enrolled).toBe(1);
		expect(run.entry_kind).toBe("pipeline_dag_v1");
		expect(
			h.store.getWorkflowStartReservationForRun(json.workflowRunId as string),
		).toBeTruthy();
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0]!.generalizedExecution?.engineOwned).toBe(true);
	});

	it("#2 workflow_template_dispatch OFF → legacy single-session path (canonical rollback lever)", async () => {
		const h = await startHarness({
			env: { FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: undefined },
		});
		const { status, json } = await post(h.url, {});
		expect(status).toBe(200);
		expect(json.generalized).toBeUndefined();
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0]!.generalizedExecution).toBeUndefined();
		expect(h.calls[0]!.sessionRole).toBe("main");
		expect(h.store.getActiveWorkflowRunForIssue("FLY-802")).toBeUndefined();
	});

	it.each([
		"FLYWHEEL_WORKFLOW_CLAIMS_WRITE",
		"FLYWHEEL_WORKFLOW_CLAIMS_READ",
	] as const)(
		"#2 %s OFF (dispatch still ON) → today's shipped fail-closed 409, unchanged",
		async (flag) => {
			// FLY-1307 truth table: an explicitly enabled but incomplete flag set
			// fails closed at selection — the DAG branch must not change that.
			const h = await startHarness({ env: { [flag]: undefined } });
			const { status, json } = await post(h.url, {});
			expect(status).toBe(409);
			expect(json.code).toBe("GENERALIZED_WORKFLOW_REJECTED");
			expect(h.calls).toHaveLength(0);
		},
	);

	it("#2b workflow_generalized_templates OFF does NOT block v1 DAG entry (not a v1 rollback lever)", async () => {
		const h = await startHarness({
			env: { FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: undefined },
		});
		const { status, json } = await post(h.url, {});
		expect(status).toBe(200);
		expect(json.generalized).toBe(true);
	});

	it("#3 no pipeline.dag key → legacy (byte-compat)", async () => {
		const h = await startHarness({
			configYaml:
				"project: flywheel\nlinear:\n  team_id: FLY\nrunners:\n  default: claude\n  available:\n    claude:\n      type: claude\n",
		});
		const { status, json } = await post(h.url, {});
		expect(status).toBe(200);
		expect(json.generalized).toBeUndefined();
		expect(h.calls[0]!.generalizedExecution).toBeUndefined();
	});

	it("#4 no-three-stage label exempts the issue from DAG entry → legacy single-session", async () => {
		const h = await startHarness({});
		linearMock.labels = ["no-three-stage"];
		const { status, json } = await post(h.url, {});
		expect(status).toBe(200);
		expect(json.generalized).toBeUndefined();
		expect(h.calls[0]!.sessionRole).toBe("main");
	});

	it("#5 scoped auth → legacy (no master-auth throw)", async () => {
		const h = await startHarness({});
		const { status, json } = await post(h.url, {}, SCOPED);
		expect(status).toBe(200);
		expect(json.generalized).toBeUndefined();
	});

	it("#6 sessionRole qa → legacy (auto-QA unaffected)", async () => {
		const h = await startHarness({});
		const { status, json } = await post(h.url, { sessionRole: "qa" });
		expect(status).toBe(200);
		expect(json.generalized).toBeUndefined();
		expect(h.calls[0]!.sessionRole).toBe("qa");
	});

	it("#7 explicit designBackend + DAG entry → 400 dag_dispatch (never silently ignored)", async () => {
		const h = await startHarness({});
		const { status, json } = await post(h.url, { designBackend: "codex" });
		expect(status).toBe(400);
		expect(json.code).toBe("DESIGN_BACKEND_NOT_APPLICABLE");
		expect(json.reason).toBe("dag_dispatch");
		expect(h.calls).toHaveLength(0);
	});

	it("#9b flags ON + enrolled + binding missing → 409 DAG_TEMPLATE_CANDIDATE_MISSING (never silent legacy)", async () => {
		const h = await startHarness({ seedBinding: false });
		const { status, json } = await post(h.url, {});
		expect(status).toBe(409);
		expect(json.code).toBe("DAG_TEMPLATE_CANDIDATE_MISSING");
		expect(h.calls).toHaveLength(0);
	});

	it("#9c flags OFF + enrolled + binding missing → legacy (candidate-missing 409 never outranks the flag rollback lever)", async () => {
		const h = await startHarness({
			seedBinding: false,
			env: { FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: undefined },
		});
		const { status, json } = await post(h.url, {});
		expect(status).toBe(200);
		expect(json.generalized).toBeUndefined();
	});

	it("#10 explicit model/agentName accepted, template-overridden, echoed; audit metadata persisted", async () => {
		const h = await startHarness({});
		const { status, json } = await post(h.url, {
			model: "opus",
			agentName: "engineer",
			ponytail: "on",
		});
		expect(status).toBe(200);
		expect(json.generalized).toBe(true);
		expect(json.templateAuthority).toEqual({
			overrode: ["model", "agentName"],
		});
		const executionId = json.executionId as string;
		const session = h.store.getSession(executionId)!;
		expect(session.dispatch_model).toBe("claude-opus-4-8");
		expect(session.agent_name).toBe("engineer");
		// ponytail rides the legacy-identical ponytailInput ladder, NOT the
		// template-authority override list.
		expect(h.calls[0]!.ponytailInput).toMatchObject({
			kind: "start_signal",
			signal: { runOverride: "on" },
		});
	});
});

describe("FLY-1385 schema-v2 entry compatibility", () => {
	it("starts a keyless master v2 request with a synthetic durable entry key", async () => {
		const h = await startHarness({
			templateSchema: 2,
			configYaml: `${CONFIG_BASE}pipeline:\n  dag: false\n`,
		});
		const { status, json } = await post(h.url, {});
		expect(status).toBe(200);
		expect(json.generalized).toBe(true);
		const run = h.store.getWorkflowRun(json.workflowRunId as string)!;
		expect(run).toMatchObject({ engine_owned: 1, entry_kind: "workflow_v2" });
		const reservation = h.store.getWorkflowStartReservationForRun(run.run_id)!;
		expect(reservation.idempotency_key).toMatch(/^wf2-auto-/);
		expect(json.templateAuthority).toBeUndefined();
	});

	it("routes a v2 binding through incumbent three-stage when dispatch is off", async () => {
		const h = await startHarness({
			templateSchema: 2,
			env: { FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: undefined },
			configYaml: `${CONFIG_BASE}pipeline:\n  three_stage: true\n`,
		});
		const { status, json } = await post(h.url, {});
		expect(status).toBe(200);
		expect(json.generalized).toBeUndefined();
		expect(h.calls[0]).toMatchObject({
			sessionRole: "design",
			shareParentBranch: true,
		});
		expect(h.store.getActiveWorkflowRunForIssue("FLY-802")).toBeUndefined();
	});

	it("treats a fresh no-three-stage request as candidate-free", async () => {
		const h = await startHarness({ seedBinding: false });
		linearMock.labels = ["no-three-stage"];
		const { status, json } = await post(h.url, {});
		expect(status).toBe(200);
		expect(json.generalized).toBeUndefined();
		expect(h.calls[0]!.sessionRole).toBe("main");
		expect(h.store.getActiveWorkflowRunForIssue("FLY-802")).toBeUndefined();
	});

	it("recovers a marked v2 run without pipeline.dag or DAG-only authority", async () => {
		const h = await startHarness({
			templateSchema: 2,
			configYaml: `${CONFIG_BASE}pipeline:\n  dag: false\n`,
		});
		const first = await post(h.url, {});
		expect(first.status).toBe(200);
		const second = await post(h.url, {});
		expect(second.status).toBe(200);
		expect(second.json.workflowRunId).toBe(first.json.workflowRunId);
		expect(second.json.templateAuthority).toBeUndefined();
	});

	it("narrowly recovers an unmarked stored v2 reservation and never lets opt-out bypass it", async () => {
		const h = await startHarness({
			templateSchema: 2,
			configYaml: `${CONFIG_BASE}pipeline:\n  dag: false\n`,
		});
		h.store.materializeWorkflowRun({
			runId: "unmarked-v2",
			issueId: "FLY-802",
			projectName: "flywheel",
			taskCategory: "*",
			claimsReadEnrolled: true,
			actor: "legacy-v2",
			canonicalRoot: h.projectRoot,
			startReservation: {
				idempotencyKey: "unmarked-v2-key",
				selectionDigest: "legacy-selection",
				nodeId: "research",
				attempt: 1,
				executionId: "unmarked-v2-exec",
				createdAt: "2026-07-20T00:00:00.000Z",
			},
			env: DAG_ENV,
		});
		linearMock.labels = ["no-three-stage"];
		const recovered = await post(h.url, {});
		expect(recovered.status).toBe(200);
		expect(recovered.json).toMatchObject({
			generalized: true,
			workflowRunId: "unmarked-v2",
			executionId: "unmarked-v2-exec",
		});
		expect(h.calls).toHaveLength(1);
	});

	it("holds an active v2 run when dispatch is disabled and rejects non-master recovery", async () => {
		const h = await startHarness({
			templateSchema: 2,
			configYaml: `${CONFIG_BASE}pipeline:\n  dag: false\n`,
		});
		const first = await post(h.url, {});
		expect(first.status).toBe(200);
		const scoped = await post(h.url, {}, SCOPED);
		expect(scoped.status).toBe(409);
		expect(scoped.json.code).toBe("WORKFLOW_RUN_ACTIVE");
		delete process.env.FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH;
		const held = await post(h.url, {});
		expect(held.status).toBe(409);
		expect(held.json.code).toBe("ACTIVE_WORKFLOW_RUN_RECOVERY_HELD");
		expect(h.calls).toHaveLength(1);
	});
});

describe("FLY-1385 operator run management", () => {
	it("requires master auth and idempotently holds then terminates a quiescent run", async () => {
		const h = await startHarness({});
		h.store.materializeWorkflowRun({
			runId: "operator-run",
			issueId: "FLY-OPERATOR",
			projectName: "flywheel",
			taskCategory: "*",
			claimsReadEnrolled: false,
			actor: "test",
		});
		const invoke = (action: "hold" | "terminate", token: string, id: string) =>
			fetch(`${h.url}/api/runs/operator-run/${action}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					reason: "operator recovery",
					clientRequestId: id,
				}),
			});

		expect((await invoke("hold", SCOPED, "deny")).status).toBe(403);
		const held = await invoke("hold", MASTER, "hold-1");
		expect(held.status).toBe(200);
		expect(await held.json()).toMatchObject({
			status: "held",
			idempotentReplay: false,
		});
		const replay = await invoke("hold", MASTER, "hold-1");
		expect(replay.status).toBe(200);
		expect(await replay.json()).toMatchObject({
			status: "held",
			idempotentReplay: true,
		});
		const terminated = await invoke("terminate", MASTER, "terminate-1");
		expect(terminated.status).toBe(200);
		expect(await terminated.json()).toMatchObject({ status: "terminated" });
		expect(h.store.getWorkflowRun("operator-run")?.status).toBe("terminated");
	});
});
