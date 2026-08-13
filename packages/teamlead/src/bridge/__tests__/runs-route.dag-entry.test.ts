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

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { legacyWorkflowSeeds } from "../../__tests__/fixtures/legacy-workflow-manifests.js";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import { importWorkflowMenuSeeds } from "../../workflow-menu.js";
import { workflowSeedContentHash } from "../../workflow-template.js";
import type { IStartDispatcher, StartRequest } from "../retry-dispatcher.js";

// Keep the launch-delivery negative path bounded. runs-route captures this
// deadline when its module loads, so the test value must be installed first.
const ghostGuardEnv = vi.hoisted(() => {
	const previous = process.env.FLYWHEEL_GHOST_GUARD_WAIT_MS;
	process.env.FLYWHEEL_GHOST_GUARD_WAIT_MS = "500";
	return { previous };
});

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

interface Fly1436StagingFixture {
	name: string;
	generalizedTemplates: boolean;
	configWorkKind: boolean;
	bindingCategory: string;
	taskCategory?: string;
	expectedStatus: number;
	expectedCode?: string;
	expectedEntryKind?: string;
}

const FLY1436_STAGING_FIXTURES = JSON.parse(
	readFileSync(
		new URL("./fixtures/fly1436-work-kind-cutover.json", import.meta.url),
		"utf8",
	),
) as Fly1436StagingFixture[];

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
					id: "generic",
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
					from: "generic",
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
	for (const key of [...Object.keys(DAG_ENV), "HOME", "LINEAR_API_KEY"]) {
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

afterAll(() => {
	if (ghostGuardEnv.previous === undefined) {
		delete process.env.FLYWHEEL_GHOST_GUARD_WAIT_MS;
	} else {
		process.env.FLYWHEEL_GHOST_GUARD_WAIT_MS = ghostGuardEnv.previous;
	}
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
	bindingCategory?: string;
	templateSchema?: 1 | 2;
	menuMode?: boolean;
	bindingTemplateId?: string;
	launchBehavior?: { commit: boolean };
	afterSessionPersisted?: (input: {
		executionId: string;
		store: StateStore;
	}) => void;
}): Promise<Harness> {
	if (options.menuMode) linearMock.labels = ["Engineering"];
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
	if (options.menuMode) {
		mkdirSync(join(projectRoot, ".flywheel", "menus"), { recursive: true });
		mkdirSync(join(projectRoot, ".flywheel", "agents"), { recursive: true });
		writeFileSync(
			join(projectRoot, ".flywheel", "agents", "engineer.md"),
			"Engineer menu agent.\n",
		);
		writeFileSync(
			join(projectRoot, ".flywheel", "agents", "qa.md"),
			"QA menu agent.\n",
		);
		writeFileSync(
			join(projectRoot, ".flywheel", "agents", "generic.md"),
			"Generic menu agent.\n",
		);
		writeFileSync(
			join(projectRoot, ".flywheel", "menus", "ic-roster.yaml"),
			[
				"design: .flywheel/agents/engineer.md",
				"implement: .flywheel/agents/engineer.md",
				"qa: .flywheel/agents/qa.md",
				"generic: .flywheel/agents/generic.md",
				"",
			].join("\n"),
		);
		writeFileSync(
			join(projectRoot, ".flywheel", "menus", "adoption.yaml"),
			"flywheel-eng-lead: [code, generic]\n",
		);
	}
	writeFileSync(
		join(projectRoot, ".flywheel", "config.yaml"),
		options.configYaml ??
			`${CONFIG_BASE}pipeline:\n  dag: true\n${options.menuMode ? "  work_kind: true\n" : ""}`,
	);
	for (const [key, value] of Object.entries({ ...DAG_ENV, ...options.env })) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}

	const store = await StateStore.create(":memory:");
	cleanups.push(() => store.close());
	if (options.seedBinding !== false) {
		if (options.menuMode) importWorkflowMenuSeeds(store, process.env);
		const seed = options.menuMode
			? { templateId: options.bindingTemplateId ?? "tpl_code" }
			: options.templateSchema === 2
				? v2Seed()
				: legacyWorkflowSeeds().find(
						(candidate) => candidate.templateId === "tpl_eng_heavy",
					)!;
		if (!options.menuMode) store.importWorkflowTemplateSeed(seed, process.env);
		store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory:
				options.bindingCategory ?? (options.menuMode ? "code" : "*"),
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
				req.generalizedExecution?.executionId ??
				req.successorExecutionId ??
				`legacy-${calls.length}`;
			store.upsertSession({
				execution_id: executionId,
				issue_id: req.issueId,
				project_name: req.projectName,
				status: "running",
				session_role: req.sessionRole ?? "main",
			});
			options.afterSessionPersisted?.({ executionId, store });
			if (
				req.generalizedExecution &&
				options.launchBehavior?.commit !== false
			) {
				const commit = req.generalizedExecution.commitWorkflowLaunch?.();
				if (commit && !commit.ok) {
					throw new Error(`launch commit failed: ${commit.reason}`);
				}
			}
			return { executionId, issueId: req.issueId };
		},
	} as unknown as IStartDispatcher;

	const projects = [
		{
			projectName: "flywheel",
			projectRoot,
			leads: options.menuMode
				? [
						{
							agentId: "flywheel-eng-lead",
							chatChannel: "test",
							match: { labels: ["Engineering"] },
							department: "engineering",
							canSpawnRunners: true,
						},
					]
				: [],
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

describe("Authenticated fresh-start controls", () => {
	it("FLY-1718: authenticated freshStart is minted by runs-route and reaches generalized dispatch", async () => {
		const h = await startHarness({});
		const { status } = await post(h.url, {
			freshStart: true,
			freshStartReason: "founder requested a clean redesign",
		});
		expect(status).toBe(200);
		expect(h.calls[0]?.freshStart).toEqual({
			authority: "authenticated_runs_route",
			actor: "master",
			reason: "founder requested a clean redesign",
		});
	});

	it("FLY-1718: scoped Lead auth may request freshStart but tokenless callers may not", async () => {
		const scoped = await startHarness({});
		const scopedResult = await post(
			scoped.url,
			{ freshStart: true, freshStartReason: "approved redo" },
			SCOPED,
		);
		expect(scopedResult.status).toBe(200);
		expect(scoped.calls[0]?.freshStart?.actor).toBe("scoped");

		if (server) {
			await new Promise((resolve) => server?.close(resolve));
			server = undefined;
		}
		const tokenless = await startHarness({});
		const denied = await post(
			tokenless.url,
			{ freshStart: true, freshStartReason: "untrusted redo" },
			"not-a-valid-token",
		);
		expect(denied.status).toBe(403);
		expect(denied.json.code).toBe("FRESH_START_AUTH_REQUIRED");
		expect(tokenless.calls).toHaveLength(0);
	});

	it("FLY-1718: freshStart requires an explicit bounded reason", async () => {
		const h = await startHarness({});
		const missing = await post(h.url, { freshStart: true });
		expect(missing.status).toBe(400);
		expect(missing.json).toMatchObject({
			code: "INVALID_FRESH_START",
			reason: "reason_required",
		});
		expect(h.calls).toHaveLength(0);
	});
});

describe("FLY-1436 staging cutover fixture", () => {
	it.each(FLY1436_STAGING_FIXTURES)("$name", async (fixture) => {
		const h = await startHarness({
			templateSchema: 2,
			bindingCategory: fixture.bindingCategory,
			env: {
				FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: fixture.generalizedTemplates
					? "1"
					: undefined,
			},
			configYaml: `${CONFIG_BASE}pipeline:\n  dag: true\n${
				fixture.configWorkKind ? "  work_kind: true\n" : ""
			}`,
		});
		const { status, json } = await post(
			h.url,
			fixture.taskCategory ? { taskCategory: fixture.taskCategory } : {},
		);
		expect(status).toBe(fixture.expectedStatus);
		if (fixture.expectedCode) {
			expect(json.code).toBe(fixture.expectedCode);
			expect(h.calls).toHaveLength(0);
		}
		if (fixture.expectedEntryKind) {
			expect(json.generalized).toBe(true);
			const run = h.store.getWorkflowRun(json.workflowRunId as string);
			expect(run?.entry_kind).toBe(fixture.expectedEntryKind);
		}
	});
});

describe("FLY-1385 schema-v2 entry compatibility", () => {
	it("holds an in-lease keyless tpl_code re-drive and converges after lease expiry", async () => {
		const launchBehavior = { commit: false };
		const h = await startHarness({ menuMode: true, launchBehavior });
		const request = {
			leadId: "flywheel-eng-lead",
			taskCategory: "code",
		};

		const first = await post(h.url, request);
		expect(first.status).toBe(202);
		expect(first.json).toMatchObject({
			code: "LAUNCH_PENDING",
			workflowNodeId: "design",
		});
		const run = h.store.getWorkflowRun(first.json.workflowRunId as string)!;
		expect(run).toMatchObject({ engine_owned: 1, entry_kind: "workflow_v2" });

		const held = await post(h.url, request);
		expect(held.status).toBe(409);
		expect(held.json.code).toBe("GENERALIZED_LAUNCH_HELD");
		expect(h.calls).toHaveLength(1);

		const internal = h.store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		};
		internal.db.run("UPDATE workflow_launch_owner SET lease_expires_at = ?", [
			"2000-01-01T00:00:00.000Z",
		]);
		launchBehavior.commit = true;

		const converged = await post(h.url, request);
		expect(converged.status).toBe(200);
		expect(converged.json).toMatchObject({
			generalized: true,
			executionId: first.json.executionId,
			workflowRunId: first.json.workflowRunId,
		});
		expect(h.calls).toHaveLength(2);
		expect(
			h.calls.map((call) => call.generalizedExecution?.launchGeneration),
		).toEqual([1, 2]);
	});

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

	it("treats a fresh no-three-stage request as candidate-free", async () => {
		const h = await startHarness({ seedBinding: false });
		linearMock.labels = ["no-three-stage"];
		const { status, json } = await post(h.url, {});
		expect(status).toBe(200);
		expect(json.generalized).toBeUndefined();
		expect(h.calls[0]!.sessionRole).toBe("main");
		expect(h.store.getActiveWorkflowRunForIssue("FLY-802")).toBeUndefined();
	});

	it("recovers a marked v2 run without re-validating work-kind input", async () => {
		const h = await startHarness({
			templateSchema: 2,
			bindingCategory: "generic",
			configYaml: `${CONFIG_BASE}pipeline:\n  dag: true\n  work_kind: true\n`,
		});
		const first = await post(h.url, { taskCategory: "generic" });
		expect(first.status).toBe(200);
		const second = await post(h.url, { taskCategory: 42 });
		expect(second.status).toBe(200);
		expect(second.json.workflowRunId).toBe(first.json.workflowRunId);
		expect(second.json.templateAuthority).toBeUndefined();
	});

	it("recovers an active run from its pinned snapshot after the selected template is retired", async () => {
		const h = await startHarness({
			templateSchema: 2,
			bindingCategory: "generic",
			configYaml: `${CONFIG_BASE}pipeline:\n  dag: true\n  work_kind: true\n`,
		});
		const first = await post(h.url, {
			taskCategory: "generic",
			idempotencyKey: "retired-recovery",
		});
		expect(first.status).toBe(200);
		const internal = h.store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		};
		internal.db.run(
			"UPDATE workflow_template SET retired_at = ? WHERE template_id = ?",
			["2026-07-21T00:00:00.000Z", "tpl_fly1385_v2_entry"],
		);
		internal.db.run("DROP TRIGGER workflow_start_response_no_delete");
		internal.db.run(
			"DELETE FROM workflow_start_response WHERE idempotency_key = ?",
			["retired-recovery"],
		);

		const recovered = await post(h.url, {
			taskCategory: "generic",
			idempotencyKey: "retired-recovery",
		});
		expect(recovered.status).toBe(200);
		expect(recovered.json).toEqual(first.json);
		expect(h.calls).toHaveLength(1);
		expect(h.store.listWorkflowRouteDecisions()).toMatchObject([
			{
				status: "launched",
				route: "workflow_v2",
				idempotency_key: "retired-recovery",
			},
		]);
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
				nodeId: "generic",
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

describe("FLY-1372 retired schema-v1 recovery fail-closed invariants", () => {
	it("#12c marked active run WITHOUT a start reservation → 409 DAG_RUN_STATE_CORRUPT", async () => {
		const h = await startHarness({});
		h.store.materializeWorkflowRun({
			runId: "run-corrupt",
			issueId: "FLY-802",
			projectName: "flywheel",
			taskCategory: "*",
			claimsReadEnrolled: true,
			actor: "master",
			entryKind: "pipeline_dag_v1",
			env: { ...DAG_ENV },
		});
		const retry = await post(h.url, {});
		expect(retry.status).toBe(409);
		expect(retry.json.code).toBe("DAG_RUN_STATE_CORRUPT");
	});

	it("#14 an unmarked schema-v1 engine run fails closed and cannot leak into legacy", async () => {
		const h = await startHarness({});
		// Same shape existing v2/explicit-v1 runs have: start reservation set
		// (engine_owned=1) but NO entry_kind marker.
		h.store.materializeWorkflowRun({
			runId: "run-unmarked",
			issueId: "FLY-802",
			projectName: "flywheel",
			taskCategory: "*",
			claimsReadEnrolled: true,
			actor: "master",
			env: { ...DAG_ENV },
			startReservation: {
				idempotencyKey: "explicit-legacy-key",
				selectionDigest: "digest-x",
				nodeId: "design",
				attempt: 1,
				executionId: "exec-unmarked",
				createdAt: "2026-07-18T00:00:00.000Z",
			},
		});
		// The compatibility classifier intentionally recognizes only unmarked
		// schema-v2 reservations. Unmarked v1 is ambiguous, so every policy state
		// fails closed rather than opening a legacy runner beside it.
		const withFlags = await post(h.url, {});
		expect(withFlags.status).toBe(409);
		expect(withFlags.json.code).toBe("ACTIVE_ENGINE_RUN_UNCLASSIFIED");
		delete process.env.FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH;
		const rolledBack = await post(h.url, {});
		expect(rolledBack.status).toBe(409);
		expect(rolledBack.json.code).toBe("ACTIVE_ENGINE_RUN_UNCLASSIFIED");
		expect(h.calls).toHaveLength(0);
	});
});

describe("FLY-1407 work-kind entry gate", () => {
	it("rejects malformed routing overrides at the HTTP route with a durable reminder", async () => {
		const h = await startHarness({
			templateSchema: 2,
			configYaml: `${CONFIG_BASE}pipeline:\n  dag: true\n  work_kind: true\n`,
		});
		const { status, json } = await post(h.url, {
			routingOverrides: "no-three-stage",
		});
		expect(status).toBe(400);
		expect(json).toMatchObject({
			code: "INVALID_ROUTING_OVERRIDE",
			reason: "not_array",
			allowed: ["no-three-stage"],
			silent: false,
		});
		expect(h.calls).toHaveLength(0);
		expect(h.store.listWorkflowRouteDecisions()).toMatchObject([
			{
				status: "rejected",
				route: "rejected",
				error_code: "INVALID_ROUTING_OVERRIDE",
			},
		]);
	});

	it.each([
		[42, "not_string"],
		["coding", "unknown_category"],
	] as const)(
		"rejects invalid taskCategory %j with the stable reason %s",
		async (taskCategory, reason) => {
			const h = await startHarness({
				templateSchema: 2,
				bindingCategory: "generic",
				configYaml: `${CONFIG_BASE}pipeline:\n  dag: true\n  work_kind: true\n`,
			});
			const { status, json } = await post(h.url, { taskCategory });
			expect(status).toBe(400);
			expect(json).toMatchObject({
				code: "INVALID_TASK_CATEGORY",
				reason,
			});
			expect(h.calls).toHaveLength(0);
		},
	);

	it.each([
		[42, "not_string"],
		["medium", "unknown_tier"],
	] as const)(
		"rejects invalid tier %j with the stable reason %s",
		async (tier, reason) => {
			const h = await startHarness({
				templateSchema: 2,
				bindingCategory: "generic",
				configYaml: `${CONFIG_BASE}pipeline:\n  dag: true\n  work_kind: true\n`,
			});
			const { status, json } = await post(h.url, {
				taskCategory: "generic",
				tier,
			});
			expect(status).toBe(400);
			expect(json).toMatchObject({ code: "INVALID_TIER", reason });
			expect(h.calls).toHaveLength(0);
		},
	);

	it("rejects an explicit tier when the exact template has no tier presets", async () => {
		const h = await startHarness({
			templateSchema: 2,
			bindingCategory: "generic",
			configYaml: `${CONFIG_BASE}pipeline:\n  dag: true\n  work_kind: true\n`,
		});
		const { status, json } = await post(h.url, {
			taskCategory: "generic",
			tier: "light",
		});
		expect(status).toBe(409);
		expect(json.code).toBe("TIER_NOT_SUPPORTED");
		expect(h.calls).toHaveLength(0);
	});

	it("fails closed when the dispatch flag flips after v2 entry classification", async () => {
		const h = await startHarness({
			templateSchema: 2,
			bindingCategory: "generic",
			configYaml: `${CONFIG_BASE}pipeline:\n  dag: true\n  work_kind: true\n`,
		});
		const original = h.store.getWorkflowCategoryBinding.bind(h.store);
		let reads = 0;
		h.store.getWorkflowCategoryBinding = ((project, category) => {
			const result = original(project, category);
			reads += 1;
			if (reads === 1) delete process.env.FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH;
			return result;
		}) as typeof h.store.getWorkflowCategoryBinding;
		const { status, json } = await post(h.url, {
			taskCategory: "generic",
		});
		expect(status).toBe(409);
		expect(json.code).toBe("WORK_KIND_ENTRY_NOT_MATERIALIZED");
		expect(h.calls).toHaveLength(0);
		expect(h.store.getActiveWorkflowRunForIssue("FLY-802")).toBeUndefined();
	});

	it("rebuilds the same work-kind 200 after launch committed but response cache was lost", async () => {
		const h = await startHarness({
			templateSchema: 2,
			bindingCategory: "generic",
			configYaml: `${CONFIG_BASE}pipeline:\n  dag: true\n  work_kind: true\n`,
		});
		const first = await post(h.url, {
			taskCategory: "generic",
			idempotencyKey: "work-kind-crash-window",
		});
		expect(first.status).toBe(200);
		const internal = h.store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		};
		internal.db.run("DROP TRIGGER workflow_start_response_no_delete");
		internal.db.run(
			"DELETE FROM workflow_start_response WHERE idempotency_key = ?",
			["work-kind-crash-window"],
		);
		const replay = await post(h.url, {
			taskCategory: "generic",
			idempotencyKey: "work-kind-crash-window",
		});
		expect(replay.status).toBe(200);
		expect(replay.json).toEqual(first.json);
		expect(replay.json.workKind).toEqual({
			category: "generic",
			source: "task_category",
		});
		expect(h.calls).toHaveLength(1);
		expect(h.store.listWorkflowRouteDecisions()).toHaveLength(1);
		expect(h.store.getWorkflowStartResponse("work-kind-crash-window")).toEqual(
			first.json,
		);
	});

	it("rejects a cached start response after its workflow run completed", async () => {
		const h = await startHarness({
			templateSchema: 2,
			bindingCategory: "generic",
			configYaml: `${CONFIG_BASE}pipeline:\n  dag: true\n  work_kind: true\n`,
		});
		const first = await post(h.url, {
			taskCategory: "generic",
			idempotencyKey: "completed-run-replay",
		});
		expect(first.status).toBe(200);
		const internal = h.store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		};
		internal.db.run(
			"UPDATE workflow_run SET status = 'completed' WHERE run_id = ?",
			[first.json.workflowRunId],
		);

		const replay = await post(h.url, {
			taskCategory: "generic",
			idempotencyKey: "completed-run-replay",
		});

		expect(replay.status).toBe(409);
		expect(replay.json).toEqual({
			success: false,
			code: "RUN_NOT_REWORKABLE_VIA_START",
			runId: first.json.workflowRunId,
			runStatus: "completed",
			hint: "use /api/runs/:runId/rework",
		});
		expect(h.calls).toHaveLength(1);
	});

	it("rejects a cached start response after the active run advances past its start attempt", async () => {
		const h = await startHarness({
			templateSchema: 2,
			bindingCategory: "generic",
			configYaml: `${CONFIG_BASE}pipeline:\n  dag: true\n  work_kind: true\n`,
		});
		const first = await post(h.url, {
			taskCategory: "generic",
			idempotencyKey: "stale-node-replay",
		});
		expect(first.status).toBe(200);
		const internal = h.store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		};
		internal.db.run(
			"UPDATE workflow_run SET current_node_id = 'founder_gate' WHERE run_id = ?",
			[first.json.workflowRunId],
		);

		const replay = await post(h.url, {
			taskCategory: "generic",
			idempotencyKey: "stale-node-replay",
		});

		expect(replay.status).toBe(409);
		expect(replay.json).toMatchObject({
			success: false,
			code: "STALE_START_RESPONSE",
			runId: first.json.workflowRunId,
			executionId: first.json.executionId,
		});
		expect(h.calls).toHaveLength(1);
	});

	it("routes an absent category to generic single-session fallback before candidate lookup", async () => {
		const h = await startHarness({
			templateSchema: 2,
			configYaml: `${CONFIG_BASE}pipeline:\n  dag: true\n  work_kind: true\n`,
		});
		const bindingLookup = vi.spyOn(h.store, "getWorkflowCategoryBinding");
		const { status, json } = await post(h.url, {});
		expect(status).toBe(200);
		expect(json.workKind).toEqual({
			category: null,
			source: "default_fallback",
			fallback: "generic",
		});
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0]!.sessionRole).toBe("main");
		expect(h.calls[0]!.routeSummary).toBe(
			"🧭 **Route**: `generic` · source `default_fallback`",
		);
		expect(h.store.getActiveWorkflowRunForIssue("FLY-802")).toBeUndefined();
		expect(bindingLookup).not.toHaveBeenCalled();
		expect(h.store.listWorkflowRouteDecisions()).toMatchObject([
			{
				status: "launched",
				route: "generic_fallback",
				category_source: "default_fallback",
			},
		]);
	});

	it("rolls back the legacy launch claim when the route decision digest conflicts", async () => {
		const h = await startHarness({
			templateSchema: 2,
			configYaml: `${CONFIG_BASE}pipeline:\n  dag: true\n  work_kind: true\n`,
		});
		const claimLegacyEntry = h.store.claimLegacyWorkflowEntry.bind(h.store);
		let executionId: string | undefined;
		h.store.claimLegacyWorkflowEntry = ((input) => {
			const claimed = claimLegacyEntry(input);
			if (claimed.ok) {
				executionId = input.executionId;
				h.store.claimWorkflowRouteDecision({
					project: input.projectName,
					issueId: input.issueId,
					executionId: input.executionId,
					route: "generic_fallback",
					routeDigest: "fault-injected-conflicting-digest",
					categorySource: "default_fallback",
				});
			}
			return claimed;
		}) as typeof h.store.claimLegacyWorkflowEntry;

		const { status, json } = await post(h.url, {});
		expect(status).toBe(409);
		expect(json.code).toBe("WORK_KIND_ROUTE_DECISION_CONFLICT");
		expect(h.calls).toHaveLength(0);
		expect(executionId).toBeTruthy();
		expect(h.store.getLaunchClaim(executionId!)?.state).toBe("cancelled");
		expect(h.store.listWorkflowRouteDecisions()).toMatchObject([
			{
				execution_id: executionId,
				status: "decided",
				route_digest: "fault-injected-conflicting-digest",
			},
		]);
	});

	it("returns a typed conflict when a persisted legacy session lacks durable launch evidence", async () => {
		const h = await startHarness({
			templateSchema: 2,
			configYaml: `${CONFIG_BASE}pipeline:\n  dag: true\n  work_kind: true\n`,
			afterSessionPersisted: ({ executionId, store }) => {
				store.setLaunchClaimState(executionId, "cancelled");
			},
		});
		const { status, json } = await post(h.url, {});
		expect(status).toBe(409);
		expect(json.code).toBe("WORK_KIND_ROUTE_LAUNCH_EVIDENCE_MISSING");
		expect(h.calls).toHaveLength(1);
		const executionId = h.calls[0]!.successorExecutionId!;
		expect(h.store.getSession(executionId)?.status).toBe("running");
		expect(h.store.getLaunchClaim(executionId)?.state).toBe("cancelled");
		expect(h.store.listWorkflowRouteDecisions()).toMatchObject([
			{
				execution_id: executionId,
				status: "decided",
				route: "generic_fallback",
			},
		]);
	});

	it("keeps malformed taskCategory byte-compatible when the main flag is off", async () => {
		const h = await startHarness({
			templateSchema: 2,
			env: { FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: undefined },
			configYaml: `${CONFIG_BASE}pipeline:\n  dag: true\n  work_kind: true\n`,
		});
		const { status, json } = await post(h.url, { taskCategory: 42 });
		expect(status).toBe(200);
		expect(json.generalized).toBeUndefined();
		expect(json.workKind).toBeUndefined();
		expect(h.calls).toHaveLength(1);
	});

	it("fails loudly on malformed work_kind only while the main flag is on", async () => {
		const h = await startHarness({
			templateSchema: 2,
			configYaml: `${CONFIG_BASE}pipeline:\n  dag: true\n  work_kind: "yes"\n`,
		});
		const { status, json } = await post(h.url, { taskCategory: "generic" });
		expect(status).toBe(400);
		expect(json).toMatchObject({
			success: false,
			code: "INVALID_WORK_KIND_CONFIG",
			reason: "work_kind_not_boolean",
		});
		expect(h.calls).toHaveLength(0);
	});

	it("canonicalizes a valid category, requires an exact binding, and echoes provenance", async () => {
		const h = await startHarness({
			templateSchema: 2,
			bindingCategory: "generic",
			configYaml: `${CONFIG_BASE}pipeline:\n  dag: true\n  work_kind: true\n`,
		});
		const { status, json } = await post(h.url, {
			taskCategory: " GeNeRiC ",
		});
		expect(status).toBe(200);
		expect(json.generalized).toBe(true);
		expect(json.workKind).toEqual({
			category: "generic",
			source: "task_category",
		});
		expect(h.calls[0]!.routeSummary).toBe(
			"🧭 **Route**: `generic` → `workflow_v2` · source `task_category`",
		);
		const run = h.store.getWorkflowRun(json.workflowRunId as string)!;
		expect(run).toMatchObject({
			task_category: "generic",
			category_source: "task_category",
		});
		expect(h.store.listWorkflowRouteDecisions()).toMatchObject([
			{
				status: "launched",
				route: "workflow_v2",
				task_category: "generic",
				category_source: "task_category",
			},
		]);
		const summary = await fetch(
			`${h.url}/api/runs/route-decisions/summary?project=flywheel`,
			{ headers: { authorization: `Bearer ${MASTER}` } },
		);
		expect(summary.status).toBe(200);
		expect(await summary.json()).toMatchObject({
			success: true,
			consumer: "product_lead_periodic_review",
		});
		const denied = await fetch(`${h.url}/api/runs/route-decisions/summary`, {
			headers: { authorization: `Bearer ${SCOPED}` },
		});
		expect(denied.status).toBe(403);
	});

	it("rejects a wildcard-only binding in the active work-kind domain", async () => {
		const h = await startHarness({
			templateSchema: 2,
			configYaml: `${CONFIG_BASE}pipeline:\n  dag: true\n  work_kind: true\n`,
		});
		const { status, json } = await post(h.url, {
			taskCategory: "generic",
		});
		expect(status).toBe(409);
		expect(json.code).toBe("WORK_KIND_BINDING_MISSING");
		expect(h.calls).toHaveLength(0);
		expect(h.store.getActiveWorkflowRunForIssue("FLY-802")).toBeUndefined();
	});

	it("lets a direct template override bypass exact binding and records null category provenance", async () => {
		const h = await startHarness({
			templateSchema: 2,
			configYaml: `${CONFIG_BASE}pipeline:\n  dag: true\n  work_kind: true\n`,
		});
		const { status, json } = await post(h.url, {
			templateId: "tpl_fly1385_v2_entry",
			selectionReason: "explicit bounded generic flow",
		});
		expect(status).toBe(200);
		expect(json.workKind).toEqual({
			category: null,
			source: "template_override",
		});
		expect(h.store.getWorkflowRun(json.workflowRunId as string)).toMatchObject({
			task_category: null,
			category_source: "template_override",
		});
		expect(h.store.listWorkflowRouteDecisions()[0]).toMatchObject({
			status: "launched",
			task_category: null,
			category_source: "template_override",
		});
	});

	it("rejects a retired direct template and writes one reminder outbox row", async () => {
		const h = await startHarness({
			templateSchema: 2,
			configYaml: `${CONFIG_BASE}pipeline:\n  dag: true\n  work_kind: true\n`,
		});
		const internal = h.store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		};
		internal.db.run(
			"UPDATE workflow_template SET retired_at = ? WHERE template_id = ?",
			["2026-07-21T00:00:00.000Z", "tpl_fly1385_v2_entry"],
		);
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const { status, json } = await post(h.url, {
				templateId: "tpl_fly1385_v2_entry",
				selectionReason: "explicit bounded generic flow",
			});
			expect(status).toBe(409);
			expect(json.code).toBe("TEMPLATE_NOT_FRESH_ELIGIBLE");
		}
		expect(h.store.listWorkflowRouteDecisions()).toHaveLength(1);
		expect(h.calls).toHaveLength(0);
	});

	it("ignores a residual no-three-stage label and routes by this dispatch's category", async () => {
		const h = await startHarness({
			templateSchema: 2,
			bindingCategory: "generic",
			configYaml: `${CONFIG_BASE}pipeline:\n  dag: true\n  work_kind: true\n`,
		});
		linearMock.labels = ["no-three-stage"];
		const { status, json } = await post(h.url, {
			taskCategory: "generic",
		});
		expect(status).toBe(200);
		expect(json.generalized).toBe(true);
		expect(h.store.getActiveWorkflowRunForIssue("FLY-802")).toBeTruthy();
		expect(h.store.listWorkflowRouteDecisions()[0]).toMatchObject({
			label_documentation_intent: 1,
		});
	});

	it("short-circuits an explicit no-three-stage override before selection", async () => {
		const h = await startHarness({
			templateSchema: 2,
			configYaml: `${CONFIG_BASE}pipeline:\n  dag: true\n  work_kind: true\n`,
		});
		const { status, json } = await post(h.url, {
			routingOverrides: ["no-three-stage"],
		});
		expect(status).toBe(200);
		expect(json.generalized).toBeUndefined();
		expect(json.workKind).toMatchObject({ override: "no-three-stage" });
		expect(h.calls).toHaveLength(1);
		expect(h.calls[0]!.sessionRole).toBe("main");
		expect(h.calls[0]!.routeSummary).toBe(
			"🧭 **Route**: `generic` · override `no-three-stage`",
		);
		expect(h.store.getActiveWorkflowRunForIssue("FLY-802")).toBeUndefined();
		expect(h.store.listWorkflowRouteDecisions()).toMatchObject([
			{
				status: "launched",
				route: "bypass_override",
				routing_override: "no-three-stage",
				selection_reason: "dispatch_override:no-three-stage",
			},
		]);
	});

	it("requires explicit conflict confirmation by rejecting override plus category", async () => {
		const h = await startHarness({
			templateSchema: 2,
			bindingCategory: "generic",
			configYaml: `${CONFIG_BASE}pipeline:\n  dag: true\n  work_kind: true\n`,
		});
		const { status, json } = await post(h.url, {
			taskCategory: "generic",
			routingOverrides: ["no-three-stage"],
		});
		expect(status).toBe(400);
		expect(json.code).toBe("ROUTING_CONFLICT_CONFIRM_REQUIRED");
		expect(h.calls).toHaveLength(0);
	});
});

describe("FLY-1436 menu start contract", () => {
	it("applies a valid node model/effort override and returns alias/version receipts", async () => {
		const h = await startHarness({ menuMode: true });
		const { status, json } = await post(h.url, {
			leadId: "flywheel-eng-lead",
			taskCategory: "code",
			overrides: {
				design: { model: "codex", effort: "max" },
			},
		});
		expect(status).toBe(200);
		expect(json).toMatchObject({
			success: true,
			generalized: true,
			workflowNodeId: "design",
			resolved: {
				nodeModels: {
					design: {
						model: "codex (= gpt-5.6-sol)",
						effort: "max",
						overridden: true,
					},
					implement: {
						model: "codex (= gpt-5.6-sol)",
						effort: "xhigh",
						overridden: false,
					},
					qa: {
						model: "opus (= claude-opus-5)",
						effort: "high",
						overridden: false,
					},
				},
			},
		});
		expect(h.calls[0]!.generalizedExecution?.dispatch).toEqual({
			vendor: "codex",
			model: "gpt-5.6-sol",
			effort: "max",
		});
	});

	it.each([
		[
			{ overrides: { missing: { model: "fable" } } },
			"MENU_NODE_NOT_FOUND",
			["design", "implement", "qa"],
		],
		[
			{ overrides: { design: { model: "opus" } } },
			"MODEL_NOT_ALLOWED_FOR_NODE",
			["fable", "codex"],
		],
		[
			{ overrides: { design: { model: "fable", effort: "ultra" } } },
			"EFFORT_NOT_ALLOWED_FOR_MODEL",
			["low", "medium", "high", "xhigh", "max"],
		],
	] as const)(
		"rejects invalid menu override %# with HTTP 400 and the legal set",
		async (extra, code, legal) => {
			const h = await startHarness({ menuMode: true });
			const { status, json } = await post(h.url, {
				leadId: "flywheel-eng-lead",
				taskCategory: "code",
				...extra,
			});
			expect(status).toBe(400);
			expect(json).toMatchObject({ success: false, code, legal });
			expect(h.calls).toHaveLength(0);
		},
	);

	it("rejects a missing category instead of silently falling back", async () => {
		const h = await startHarness({ menuMode: true });
		const { status, json } = await post(h.url, {
			leadId: "flywheel-eng-lead",
		});
		expect(status).toBe(400);
		expect(json).toMatchObject({
			success: false,
			code: "TASK_CATEGORY_REQUIRED",
			legal: ["code", "generic"],
		});
		expect(h.calls).toHaveLength(0);
	});

	it("rejects a menu not adopted by the dispatching Lead", async () => {
		const h = await startHarness({ menuMode: true });
		const { status, json } = await post(h.url, {
			leadId: "flywheel-eng-lead",
			taskCategory: "prd",
		});
		expect(status).toBe(400);
		expect(json).toMatchObject({
			success: false,
			code: "MENU_NOT_ADOPTED_FOR_LEAD",
			legal: ["code", "generic"],
		});
		expect(h.calls).toHaveLength(0);
	});

	it("rejects a registry binding whose template id disagrees with the menu SSOT", async () => {
		const h = await startHarness({
			menuMode: true,
			bindingTemplateId: "tpl_prd",
		});
		const { status, json } = await post(h.url, {
			leadId: "flywheel-eng-lead",
			taskCategory: "code",
		});
		expect(status).toBe(400);
		expect(json).toMatchObject({
			success: false,
			code: "MENU_BINDING_MISMATCH",
			legal: ["tpl_code"],
			available: [{ taskCategory: "code", templateId: "tpl_prd" }],
		});
		expect(h.calls).toHaveLength(0);
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
