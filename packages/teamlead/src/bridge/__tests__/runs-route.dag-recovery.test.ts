/**
 * FLY-1372: the pipeline.dag RECOVERY domain — keyless re-drive of a
 * materialized-but-unresponded run, rollback-window holds, marker provenance
 * (unmarked runs untouched), and the crash/lease convergence contract.
 *
 * Rows (plan §3.1): #8b replay converge · #8c successor active 409 · #12
 * flags-off HELD · #12b rebind-immune recovery · #12c reservation missing ·
 * #12e-lite recovery precedes current-candidate resolution · #14 unmarked run
 * never intercepted · #10c changed-param replay · crash-cut (no-commit 202 →
 * in-lease typed 409 → store-clock lease expiry converges).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { legacyWorkflowSeeds } from "../../__tests__/fixtures/legacy-workflow-manifests.js";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import type { IStartDispatcher, StartRequest } from "../retry-dispatcher.js";

// Bound the ghost-guard / delivery waits BEFORE the route module loads (the
// deadline is captured in a module-level const at import time).
vi.hoisted(() => {
	process.env.FLYWHEEL_GHOST_GUARD_WAIT_MS = "500";
});

import { createRunsRouter } from "../runs-route.js";

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

const MASTER = "master-token-fly1372r";
const SCOPED = "scoped-token-fly1372r";
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

interface Harness {
	url: string;
	store: StateStore;
	calls: StartRequest[];
	/** Per-request dispatcher behavior; mutate between requests. */
	behavior: { createSession: boolean; commitLaunch: boolean };
	/** Raw second connection for test-only clock surgery (lease expiry). */
	dbPath: string;
}

async function startHarness(): Promise<Harness> {
	const home = mkdtempSync(join(tmpdir(), "fly1372r-home-"));
	process.env.HOME = home;
	const projectRoot = mkdtempSync(join(tmpdir(), "fly1372r-proj-"));
	cleanups.push(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(projectRoot, { recursive: true, force: true });
	});
	mkdirSync(join(projectRoot, ".flywheel"), { recursive: true });
	writeFileSync(
		join(projectRoot, ".flywheel", "config.yaml"),
		`${CONFIG_BASE}pipeline:\n  dag: true\n`,
	);
	for (const [key, value] of Object.entries(DAG_ENV)) {
		process.env[key] = value;
	}

	const stateDir = mkdtempSync(join(tmpdir(), "fly1372r-db-"));
	const dbPath = join(stateDir, "state.db");
	const store = await StateStore.create(dbPath);
	cleanups.push(() => {
		store.close();
		rmSync(stateDir, { recursive: true, force: true });
	});
	const seed = legacyWorkflowSeeds().find(
		(candidate) => candidate.templateId === "tpl_eng_heavy",
	)!;
	store.importWorkflowTemplateSeed(seed);
	const lightSeed = legacyWorkflowSeeds().find(
		(candidate) => candidate.templateId === "tpl_eng_light",
	)!;
	store.importWorkflowTemplateSeed(lightSeed);
	store.bindWorkflowCategory({
		project: "flywheel",
		taskCategory: "*",
		templateId: seed.templateId,
		updatedBy: "lead",
	});

	const behavior = { createSession: true, commitLaunch: true };
	const calls: StartRequest[] = [];
	const dispatcher = {
		getInflightCount: () => 0,
		validateAgentName: () => ({ ok: true }),
		start: async (req: StartRequest) => {
			calls.push(req);
			const executionId =
				req.generalizedExecution?.executionId ?? `legacy-${calls.length}`;
			if (behavior.createSession) {
				store.upsertSession({
					execution_id: executionId,
					issue_id: req.issueId,
					project_name: req.projectName,
					status: "running",
					session_role: req.sessionRole ?? "main",
				});
			}
			if (req.generalizedExecution && behavior.commitLaunch) {
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
	return { url, store, calls, behavior, dbPath };
}

async function post(
	url: string,
	body: Record<string, unknown> = {},
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

describe("FLY-1372 DAG recovery domain", () => {
	it("#8b keyless retry after a successful start replays the same run/execution/response", async () => {
		const h = await startHarness();
		const first = await post(h.url);
		expect(first.status).toBe(200);
		const retry = await post(h.url);
		expect(retry.status).toBe(200);
		expect(retry.json).toEqual(first.json);
		expect(h.calls).toHaveLength(1); // no second spawn
		const runs = h.store.getActiveWorkflowRunForIssue("FLY-802");
		expect(runs?.run_id).toBe(first.json.workflowRunId);
	});

	it("#10c keyless retry with a CHANGED model param still replays the original cached response; audit metadata not overwritten", async () => {
		const h = await startHarness();
		const first = await post(h.url, { model: "opus" });
		expect(first.status).toBe(200);
		const session = h.store.getSession(first.json.executionId as string)!;
		expect(session.dispatch_model).toBe("claude-opus-5");
		const retry = await post(h.url, { model: "haiku" });
		expect(retry.status).toBe(200);
		expect(retry.json).toEqual(first.json);
		expect(
			h.store.getSession(first.json.executionId as string)!.dispatch_model,
		).toBe("claude-opus-5");
	});

	it("#8c a live SUCCESSOR phase (execution ≠ start reservation) → 409 already-active, no second run", async () => {
		const h = await startHarness();
		const first = await post(h.url);
		expect(first.status).toBe(200);
		// Engine advanced: start session done, implement successor now running.
		h.store.upsertSession({
			execution_id: first.json.executionId as string,
			issue_id: "FLY-802",
			project_name: "flywheel",
			status: "completed",
			session_role: "design",
		});
		h.store.upsertSession({
			execution_id: "successor-impl",
			issue_id: "FLY-802",
			project_name: "flywheel",
			status: "running",
			session_role: "implement",
		});
		const retry = await post(h.url);
		expect(retry.status).toBe(409);
		expect(String(retry.json.message)).toContain("active DAG phase");
		expect(h.calls).toHaveLength(1);
	});

	it("#12 marked run + flags/config off → 409 ACTIVE_DAG_RUN_RECOVERY_HELD (keyless AND explicit key), zero legacy start", async () => {
		const h = await startHarness();
		const first = await post(h.url);
		expect(first.status).toBe(200);
		delete process.env.FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH;
		for (const body of [{}, { idempotencyKey: "some-explicit-key" }] as const) {
			const retry = await post(h.url, body);
			expect(retry.status).toBe(409);
			expect(retry.json.code).toBe("ACTIVE_DAG_RUN_RECOVERY_HELD");
		}
		expect(h.calls).toHaveLength(1);
	});

	it("#12b recovery ignores the CURRENT binding — rebinding the category to another template does not break keyless convergence", async () => {
		const h = await startHarness();
		const first = await post(h.url);
		expect(first.status).toBe(200);
		h.store.bindWorkflowCategory({
			project: "flywheel",
			taskCategory: "*",
			templateId: "tpl_eng_light",
			updatedBy: "lead",
		});
		const retry = await post(h.url);
		expect(retry.status).toBe(200);
		expect(retry.json).toEqual(first.json);
	});

	it("#12e recovery precedes current-candidate resolution — a nonexistent explicit templateId cannot strand the run", async () => {
		const h = await startHarness();
		const first = await post(h.url);
		expect(first.status).toBe(200);
		// The candidate resolver would throw on this; recovery must not reach it.
		const retry = await post(h.url, { templateId: "tpl_does_not_exist" });
		expect(retry.status).toBe(200);
		expect(retry.json).toEqual(first.json);
	});

	it("R2#1a: active marked run + master qa-role (different explicit key) → 409 DAG_RUN_ACTIVE, zero additional starts", async () => {
		const h = await startHarness();
		const first = await post(h.url);
		expect(first.status).toBe(200);
		const qa = await post(h.url, {
			sessionRole: "qa",
			idempotencyKey: "some-other-key",
		});
		expect(qa.status).toBe(409);
		expect(qa.json.code).toBe("DAG_RUN_ACTIVE");
		expect(h.calls).toHaveLength(1);
	});

	it("R2#1b: active marked run + scoped-auth main → 409 DAG_RUN_ACTIVE, zero additional starts", async () => {
		const h = await startHarness();
		const first = await post(h.url);
		expect(first.status).toBe(200);
		const scoped = await post(h.url, {}, SCOPED);
		expect(scoped.status).toBe(409);
		expect(scoped.json.code).toBe("DAG_RUN_ACTIVE");
		expect(h.calls).toHaveLength(1);
	});

	it("#12c marked active run WITHOUT a start reservation → 409 DAG_RUN_STATE_CORRUPT", async () => {
		const h = await startHarness();
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
		const retry = await post(h.url);
		expect(retry.status).toBe(409);
		expect(retry.json.code).toBe("DAG_RUN_STATE_CORRUPT");
	});

	it("#14 an unmarked schema-v1 engine run fails closed and cannot leak into legacy", async () => {
		const h = await startHarness();
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
		// The W8 compatibility classifier intentionally recognizes only unmarked
		// schema-v2 reservations. Unmarked v1 is ambiguous, so every policy state
		// fails closed rather than opening a legacy runner beside it.
		const withFlags = await post(h.url);
		expect(withFlags.status).toBe(409);
		expect(withFlags.json.code).toBe("ACTIVE_ENGINE_RUN_UNCLASSIFIED");
		delete process.env.FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH;
		const rolledBack = await post(h.url);
		expect(rolledBack.status).toBe(409);
		expect(rolledBack.json.code).toBe("ACTIVE_ENGINE_RUN_UNCLASSIFIED");
		expect(h.calls).toHaveLength(0);
	});

	it("crash-cut A (Codex code R1 #2): session alive but delivery uncommitted → 202; in-lease keyless retry → typed 409 HELD (a session row is NOT launch evidence); lease expiry → route converges 200, one session", async () => {
		const h = await startHarness();
		h.behavior.commitLaunch = false; // crash between spawn and launch commit
		const first = await post(h.url);
		expect(first.status).toBe(202);
		expect(first.json.code).toBe("LAUNCH_PENDING");
		// 202 carries the same advisory echo shape as the 200 (plan #10b).
		expect(first.json.templateAuthority).toEqual({ overrode: [] });

		// In-lease retry: the owner state machine holds — never a silent
		// forever-202 loop that ignores the launch protocol.
		h.behavior.commitLaunch = true;
		const held = await post(h.url);
		expect(held.status).toBe(409);
		expect(held.json.code).toBe("GENERALIZED_LAUNCH_HELD");

		// Advance the store clock (test-only lease surgery via a second raw
		// connection) → the route reacquires a new generation and converges.
		const surgeon = new BetterSqlite3(h.dbPath);
		surgeon
			.prepare("UPDATE workflow_launch_owner SET lease_expires_at = ?")
			.run("2000-01-01T00:00:00.000Z");
		surgeon.close();
		const converged = await post(h.url);
		expect(converged.status).toBe(200);
		expect(converged.json.generalized).toBe(true);
		expect(converged.json.executionId).toBe(first.json.executionId);
		// Same execution re-driven — one session row, no duplicate runner id.
		expect(h.store.getSession(first.json.executionId as string)).toBeTruthy();
	});

	it("#1 (Codex code R1 #1): a DIFFERENT explicit key on an active marked run → 409 DAG_RUN_KEY_MISMATCH, never legacy beside the run", async () => {
		const h = await startHarness();
		const first = await post(h.url);
		expect(first.status).toBe(200);
		const mismatch = await post(h.url, { idempotencyKey: "some-other-key" });
		expect(mismatch.status).toBe(409);
		expect(mismatch.json.code).toBe("DAG_RUN_KEY_MISMATCH");
		expect(h.calls).toHaveLength(1); // zero additional starts
	});

	it("crash-cut B: crash before the session exists → in-lease keyless retry gets typed 409 GENERALIZED_LAUNCH_HELD; store clock past the 60min lease converges to a new generation", async () => {
		const h = await startHarness();
		h.behavior.createSession = false;
		h.behavior.commitLaunch = false; // hard crash right after dispatch
		const first = await post(h.url);
		expect(first.status).toBe(500);
		expect(first.json.code).toBe("GENERALIZED_START_NOT_LIVE");

		h.behavior.createSession = true;
		h.behavior.commitLaunch = true;
		const retry = await post(h.url);
		expect(retry.status).toBe(409);
		expect(retry.json.code).toBe("GENERALIZED_LAUNCH_HELD");
		expect(h.calls).toHaveLength(1); // held, not double-spawned

		// Lease expiry: the launch-owner state machine hands a NEW generation to a
		// new owner once the lease is past (store-level clock, plan §2.4).
		const run = h.store.getActiveWorkflowRunForIssue("FLY-802")!;
		const reservation = h.store.getWorkflowStartReservationForRun(run.run_id)!;
		const future = new Date(Date.now() + 61 * 60_000);
		const reacquired = h.store.recoverOrAcquireWorkflowLaunch({
			executionId: reservation.execution_id,
			ownerId: "recovery-owner",
			now: future.toISOString(),
			leaseExpiresAt: new Date(future.getTime() + 60 * 60_000).toISOString(),
			markerPath: join(
				process.env.HOME!,
				".flywheel",
				"state",
				"launch-commits",
				reservation.execution_id,
			),
		});
		expect(reacquired.status).toBe("acquired");
	});
});
