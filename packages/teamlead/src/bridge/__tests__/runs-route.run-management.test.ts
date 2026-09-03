import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { ConfirmTokenStore } from "../fleet-admin.js";
import { createRunsRouter } from "../runs-route.js";

const HEAD = "a".repeat(40);

const fakeDispatcher = {
	getInflightCount: () => 0,
} as Parameters<typeof createRunsRouter>[0];

const fakeAdmission = {
	tryAdmit: () => ({ admit: false, reason: "load", detail: "unused" }),
} as Parameters<typeof createRunsRouter>[3];

let server: Server | undefined;

afterEach(async () => {
	if (!server) return;
	await new Promise<void>((resolve) => server?.close(() => resolve()));
	server = undefined;
});

async function startApp(
	store: StateStore,
	auth: Parameters<typeof createRunsRouter>[7] = {
		masterToken: "master-secret",
		scopedToken: "scoped-secret",
	},
): Promise<string> {
	const app = express();
	app.use(express.json());
	app.use(
		"/api/runs",
		createRunsRouter(
			fakeDispatcher,
			store,
			[],
			fakeAdmission,
			undefined,
			false,
			undefined,
			auth,
		),
	);
	server = createServer(app);
	await new Promise<void>((resolve, reject) => {
		server?.once("error", reject);
		server?.listen(0, "127.0.0.1", resolve);
	});
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}`;
}

function managementStore(result: ReturnType<typeof vi.fn>) {
	return {
		getWorkflowRun: (runId: string) =>
			runId === "run-1"
				? { run_id: runId, project_name: "flywheel", status: "active" }
				: undefined,
		listRunAttributedExecutions: () => [],
		holdWorkflowRunByOperator: result,
		terminateWorkflowRunByOperator: result,
		openOperatorRework: result,
	} as unknown as StateStore;
}

async function post(
	baseUrl: string,
	action: "hold" | "terminate",
	token = "master-secret",
) {
	return fetch(`${baseUrl}/api/runs/run-1/${action}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({
			reason: "  operator recovery  ",
			clientRequestId: `request-${action}`,
		}),
	});
}

describe("runs-route run management", () => {
	it("mounts the canonical hold door with master, loopback, path, digest, and replay fences", async () => {
		const store = await StateStore.create(":memory:");
		store.createWorkflowRun({
			runId: "run-1",
			issueId: "FLY-2278",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		(
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db.run("UPDATE workflow_run SET status = 'held' WHERE run_id = ?", [
			"run-1",
		]);
		store.appendWorkflowRunEvent({
			runId: "run-1",
			eventUid: "hold:canonical-door",
			kind: "run_held_by_operator",
			payload: { reason: "operator recovery required" },
		});
		const baseUrl = await startApp(store, {
			masterToken: "master-secret",
			scopedToken: "scoped-secret",
			confirmTokens: new ConfirmTokenStore(),
		});
		const url = `${baseUrl}/api/runs/run-1`;
		expect((await fetch(`${url}/holds`)).status).toBe(401);
		expect(
			(
				await fetch(`${url}/holds`, {
					headers: { authorization: "Bearer wrong-secret" },
				})
			).status,
		).toBe(401);
		const target = new URL(`${url}/holds`);
		const foreignHostStatus = await new Promise<number>((resolve, reject) => {
			const request = httpRequest(
				{
					hostname: target.hostname,
					port: target.port,
					path: target.pathname,
					headers: {
						authorization: "Bearer master-secret",
						host: "example.invalid",
					},
				},
				(response) => {
					response.resume();
					response.on("end", () => resolve(response.statusCode ?? 0));
				},
			);
			request.on("error", reject);
			request.end();
		});
		expect(foreignHostStatus).toBe(403);
		const listed = await fetch(`${url}/holds`, {
			headers: { authorization: "Bearer master-secret" },
		});
		expect(listed.status).toBe(200);
		expect(await listed.json()).toMatchObject({
			ok: true,
			holds: [
				{
					shape: "run_held_by_operator",
					holdEventUid: "hold:canonical-door",
					resumable: true,
				},
			],
		});
		const canonical = {
			runId: "run-1",
			shape: "run_held_by_operator",
			holdEventUid: "hold:canonical-door",
			reason: "operator confirmed recovery",
			principal: "master" as const,
			clientRequestId: "resume:canonical-door",
		};
		const mismatch = await fetch(`${url}/resume/stage`, {
			method: "POST",
			headers: {
				authorization: "Bearer master-secret",
				"content-type": "application/json",
			},
			body: JSON.stringify({ ...canonical, runId: "run-other" }),
		});
		expect(mismatch.status).toBe(400);
		expect(await mismatch.json()).toMatchObject({ reason: "run_id_mismatch" });
		const staged = await fetch(`${url}/resume/stage`, {
			method: "POST",
			headers: {
				authorization: "Bearer master-secret",
				"content-type": "application/json",
			},
			body: JSON.stringify(canonical),
		});
		expect(staged.status).toBe(200);
		const stagedPayload = (await staged.json()) as {
			canonical: typeof canonical;
			confirmToken: string;
		};
		const stageBody = {
			canonical: stagedPayload.canonical,
			confirmToken: stagedPayload.confirmToken,
		};
		const apply = () =>
			fetch(`${url}/resume`, {
				method: "POST",
				headers: {
					authorization: "Bearer master-secret",
					"content-type": "application/json",
				},
				body: JSON.stringify(stageBody),
			});
		const applied = await apply();
		expect(applied.status).toBe(200);
		expect(await applied.json()).toMatchObject({ idempotentReplay: false });
		const replayed = await apply();
		expect(replayed.status).toBe(200);
		expect(await replayed.json()).toMatchObject({ idempotentReplay: true });
		const conflict = await fetch(`${url}/resume`, {
			method: "POST",
			headers: {
				authorization: "Bearer master-secret",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				...stageBody,
				canonical: { ...stageBody.canonical, reason: "digest drift" },
			}),
		});
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toMatchObject({ reason: "request_conflict" });
		store.close();
	});

	it("serves the versioned read-only diagnostic only to loopback master callers", async () => {
		const store = await StateStore.create(":memory:");
		store.createWorkflowRun({
			runId: "run-1",
			issueId: "FLY-1434",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		const baseUrl = await startApp(store);

		const missing = await fetch(`${baseUrl}/api/runs/run-1/diagnostic`);
		expect(missing.status).toBe(401);
		expect(await missing.json()).toMatchObject({
			code: "MASTER_AUTH_REQUIRED",
		});

		const scoped = await fetch(`${baseUrl}/api/runs/run-1/diagnostic`, {
			headers: { authorization: "Bearer scoped-secret" },
		});
		expect(scoped.status).toBe(403);

		const target = new URL(`${baseUrl}/api/runs/run-1/diagnostic`);
		const foreignHost = await new Promise<{
			status: number;
			body: Record<string, unknown>;
		}>((resolve, reject) => {
			const request = httpRequest(
				{
					hostname: target.hostname,
					port: target.port,
					path: target.pathname,
					headers: {
						authorization: "Bearer master-secret",
						host: "example.invalid",
					},
				},
				(response) => {
					let body = "";
					response.setEncoding("utf8");
					response.on("data", (chunk) => {
						body += chunk;
					});
					response.on("end", () =>
						resolve({
							status: response.statusCode ?? 0,
							body: JSON.parse(body) as Record<string, unknown>,
						}),
					);
				},
			);
			request.on("error", reject);
			request.end();
		});
		expect(foreignHost.status).toBe(403);
		expect(foreignHost.body).toMatchObject({
			code: "LOOPBACK_REQUIRED",
		});

		const diagnostic = await fetch(`${baseUrl}/api/runs/run-1/diagnostic`, {
			headers: { authorization: "Bearer master-secret" },
		});
		expect(diagnostic.status).toBe(200);
		expect(await diagnostic.json()).toMatchObject({
			schema_version: 1,
			run: { run_id: "run-1", issue_id: "FLY-1434", status: "active" },
			nodes: [],
			pr_manifest: null,
			declared_prs: [],
			quiescence: { live_executions: 0, quiescent: true },
		});
		store.close();
	});

	it("fails closed when diagnostic master authentication is not configured", async () => {
		const store = await StateStore.create(":memory:");
		store.createWorkflowRun({
			runId: "run-1",
			issueId: "FLY-1434",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		const baseUrl = await startApp(store, {});
		const response = await fetch(`${baseUrl}/api/runs/run-1/diagnostic`);
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			code: "MASTER_AUTH_NOT_CONFIGURED",
		});
		store.close();
	});

	it.each(["hold", "terminate"] as const)(
		"authorizes and audits a quiescent %s request",
		async (action) => {
			const change = vi.fn(() => ({
				ok: true as const,
				status: action === "hold" ? ("held" as const) : ("terminated" as const),
				idempotentReplay: false,
			}));
			const baseUrl = await startApp(managementStore(change));

			const response = await post(baseUrl, action);

			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				success: true,
				runId: "run-1",
				status: action === "hold" ? "held" : "terminated",
			});
			expect(change).toHaveBeenCalledWith(
				expect.objectContaining({
					runId: "run-1",
					reason: "operator recovery",
					clientRequestId: `request-${action}`,
					principal: "master",
					evidence: [],
				}),
			);
		},
	);

	it("force-cancel skips liveness probes and returns the collector's durable response", async () => {
		const change = vi.fn(() => ({
			ok: true as const,
			status: "terminated",
			idempotentReplay: false,
			collection: {
				receiptKey: "episode:run-1:0",
				state: "frozen" as const,
				targetExecutionIds: ["exec-live"],
				outcomes: [],
			},
		}));
		const probeRunLiveness = vi.fn(async () => {
			throw new Error("probe unavailable");
		});
		const responseBody = {
			success: true,
			runId: "run-1",
			status: "terminated",
			receiptKey: "episode:run-1:0",
			inProgress: false,
			snapshot: {
				targetExecutionIds: ["exec-live"],
				outcomes: [{ executionId: "exec-live", closed: true }],
			},
		};
		const collectWorkflowRun = vi.fn(async () => ({
			receipt_key: "episode:run-1:0",
			run_id: "run-1",
			state: "responded" as const,
			owner_id: "collector",
			owner_generation: 1,
			lease_expires_at: "2026-08-15T08:01:00.000Z",
			targetExecutionIds: ["exec-live"],
			outcomes: [],
			response: responseBody,
			updated_at: "2026-08-15T08:00:00.000Z",
		}));
		const store = managementStore(change);
		store.listRunAttributedExecutions = vi.fn(() => ["exec-live"]);
		const baseUrl = await startApp(store, {
			masterToken: "master-secret",
			scopedToken: "scoped-secret",
			probeRunLiveness,
			collectWorkflowRun,
		});

		const response = await fetch(`${baseUrl}/api/runs/run-1/terminate`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer master-secret",
			},
			body: JSON.stringify({
				reason: "force cancel",
				clientRequestId: "force-1",
				collectExecutions: true,
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(responseBody);
		expect(probeRunLiveness).not.toHaveBeenCalled();
		expect(change).toHaveBeenCalledWith(
			expect.objectContaining({ collectExecutions: true, evidence: [] }),
		);
		expect(collectWorkflowRun).toHaveBeenCalledWith("episode:run-1:0");
	});

	it("returns the documented 202 snapshot while force-cancel collection is open", async () => {
		const change = vi.fn(() => ({
			ok: true as const,
			status: "terminated" as const,
			idempotentReplay: false,
			collection: {
				receiptKey: "episode:run-1:0",
				state: "frozen" as const,
				targetExecutionIds: ["exec-live"],
				outcomes: [],
			},
		}));
		const store = managementStore(change);
		const baseUrl = await startApp(store, {
			masterToken: "master-secret",
			scopedToken: "scoped-secret",
			collectWorkflowRun: async () => ({
				receipt_key: "episode:run-1:0",
				run_id: "run-1",
				state: "collecting",
				owner_id: "collector",
				owner_generation: 1,
				lease_expires_at: "2026-08-15T08:01:00.000Z",
				targetExecutionIds: ["exec-live"],
				outcomes: [],
				updated_at: "2026-08-15T08:00:00.000Z",
			}),
		});

		const response = await fetch(`${baseUrl}/api/runs/run-1/terminate`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer master-secret",
			},
			body: JSON.stringify({
				reason: "force cancel",
				clientRequestId: "force-open",
				collectExecutions: true,
			}),
		});

		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({
			success: true,
			runId: "run-1",
			status: "terminated",
			inProgress: true,
			snapshot: {
				receiptKey: "episode:run-1:0",
				state: "collecting",
				targetExecutionIds: ["exec-live"],
				outcomes: [],
			},
		});
	});

	it("proves an exact nested PR merge before sending invariant-bound termination", async () => {
		const change = vi.fn(() => ({
			ok: true as const,
			status: "terminated" as const,
			idempotentReplay: false,
		}));
		const store = managementStore(change);
		vi.spyOn(store, "getWorkflowRun").mockReturnValue({
			run_id: "run-1",
			issue_id: "FLY-1434",
			project_name: "flywheel",
			status: "held",
		} as never);
		const digest = "d".repeat(64);
		store.getWorkflowRunDiagnostic = vi.fn(() => ({
			ok: true,
			dto: {
				latest_hold: { reason: "nested_land_unsupported" },
				pr_manifest: null,
				single_closeout_target: {
					probe_repo_slug: "geoforge3d/nested",
					pr_number: 1434,
					frozen_head_sha: HEAD,
					target_repo_identity: "geoforge3d/nested",
				},
				closeout_invariant_digest: digest,
			},
		})) as never;
		const probeMergedPr = vi.fn(async () => ({
			probeRepoSlug: "geoforge3d/nested",
			prNumber: 1434,
			headSha: HEAD,
			state: "MERGED" as const,
		}));
		const baseUrl = await startApp(store, {
			masterToken: "master-secret",
			scopedToken: "scoped-secret",
			probeMergedPr,
		});

		const response = await fetch(`${baseUrl}/api/runs/run-1/terminate`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer master-secret",
			},
			body: JSON.stringify({
				reason: "nested PR merged; close manually",
				clientRequestId: "nested-closeout",
				closeoutInvariantDigest: digest,
			}),
		});

		expect(response.status).toBe(200);
		expect(probeMergedPr).toHaveBeenCalledWith({
			probeRepoSlug: "geoforge3d/nested",
			prNumber: 1434,
		});
		expect(change).toHaveBeenCalledWith(
			expect.objectContaining({
				closeoutInvariantDigest: digest,
				closeoutKind: "nested_manual",
				mergeProof: {
					probeRepoSlug: "geoforge3d/nested",
					prNumber: 1434,
					headSha: HEAD,
					state: "MERGED",
				},
			}),
		);
	});

	it("rejects a scoped token before reading run state", async () => {
		const change = vi.fn();
		const store = managementStore(change);
		const getRun = vi.spyOn(store, "getWorkflowRun");
		const baseUrl = await startApp(store);

		const response = await post(baseUrl, "hold", "scoped-secret");

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			code: "MASTER_AUTH_REQUIRED",
		});
		expect(getRun).not.toHaveBeenCalled();
		expect(change).not.toHaveBeenCalled();
	});

	it.skip("maps a quiescence refusal to a typed conflict", async () => {
		const change = vi.fn(() => ({
			ok: false as const,
			reason: "run_has_live_executions",
			executionIds: ["exec-live"],
		}));
		const baseUrl = await startApp(managementStore(change));

		const response = await post(baseUrl, "hold");

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			success: false,
			code: "RUN_HAS_LIVE_EXECUTIONS",
			reason: "run_has_live_executions",
			executionIds: ["exec-live"],
		});
	});

	it("opens a master-authorized operator rework request on the canonical route", async () => {
		const open = vi.fn(() => ({
			ok: true as const,
			requestId: "rework:operator-1",
			targetNodeId: "implement",
			targetAttempt: 2,
			preferredActorExecutionId: "implement-exec",
			idempotentReplay: false,
		}));
		const baseUrl = await startApp(managementStore(open));
		const escalationAck = {
			holdEventUid: "hold-run-1",
			holdReceiptDigest: "a".repeat(64),
			decision: "continue",
		};

		const response = await fetch(`${baseUrl}/api/runs/run-1/rework`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer master-secret",
			},
			body: JSON.stringify({
				targetNodeId: "implement",
				feedback: "repair the blocked implementation",
				clientRequestId: "request-rework",
				escalationAck,
			}),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			runId: "run-1",
			requestId: "rework:operator-1",
			targetNodeId: "implement",
			targetAttempt: 2,
			preferredActorExecutionId: "implement-exec",
			idempotentReplay: false,
		});
		expect(open).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run-1",
				targetNodeId: "implement",
				feedback: "repair the blocked implementation",
				clientRequestId: "request-rework",
				principal: "master",
				evidence: [],
				escalationAck,
			}),
		);
	});

	it("does not expose a dashboard action alias for workflow rework", async () => {
		const open = vi.fn();
		const baseUrl = await startApp(managementStore(open));

		const response = await fetch(`${baseUrl}/actions/run-1/rework`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});

		expect(response.status).toBe(404);
		expect(open).not.toHaveBeenCalled();
	});

	it("rejects a malformed loop-limit escalation acknowledgement at the route boundary", async () => {
		const open = vi.fn();
		const baseUrl = await startApp(managementStore(open));

		const response = await fetch(`${baseUrl}/api/runs/run-1/rework`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer master-secret",
			},
			body: JSON.stringify({
				targetNodeId: "implement",
				feedback: "continue",
				clientRequestId: "bad-ack",
				escalationAck: {
					holdEventUid: "hold-run-1",
					holdReceiptDigest: "not-a-digest",
					decision: "continue",
				},
			}),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			success: false,
			code: "INVALID_REWORK_REQUEST",
		});
		expect(open).not.toHaveBeenCalled();
	});

	it("opens a bounded PR manifest through the master-authorized route", async () => {
		const store = await StateStore.create(":memory:");
		store.createWorkflowRun({
			runId: "run-1",
			issueId: "FLY-1434",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		const baseUrl = await startApp(store);

		const invalid = await fetch(`${baseUrl}/api/runs/run-1/pr-manifest`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer master-secret",
			},
			body: JSON.stringify({ expectedCount: 51 }),
		});
		expect(invalid.status).toBe(400);
		expect(await invalid.json()).toMatchObject({
			code: "MANIFEST_EXPECTED_COUNT_INVALID",
		});

		const opened = await fetch(`${baseUrl}/api/runs/run-1/pr-manifest`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer master-secret",
			},
			body: JSON.stringify({ expectedCount: 2 }),
		});
		expect(opened.status).toBe(200);
		expect(await opened.json()).toEqual({
			success: true,
			runId: "run-1",
			expectedCount: 2,
			currentRevision: 0,
			sealed: false,
			idempotentReplay: false,
		});
		store.close();
	});

	it("records a declared merge only after exact server-side GitHub proof", async () => {
		const store = await StateStore.create(":memory:");
		store.createWorkflowRun({
			runId: "run-1",
			issueId: "FLY-1434",
			projectName: "flywheel",
			claimsReadEnrolled: true,
		});
		store.openWorkflowPrManifest({ runId: "run-1", expectedCount: 1 });
		store.upsertWorkflowRunNode({
			runId: "run-1",
			nodeId: "implement",
			attempt: 1,
			state: "done",
			executionId: "implement-1",
		});
		const db = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		db.run(
			`INSERT INTO workflow_node_pr_binding
			   (run_id, node_id, attempt, pr_number, head_sha, target_repo_identity,
			    probe_repo_slug, target_repo_path, worktree_binding_generation,
			    receipt_id, bound_at)
			 VALUES ('run-1', 'implement', 1, 687, ?, '__main__',
			         'geoforge3d/flywheel', '/tmp/flywheel', 'generation-1',
			         'receipt-1', '2026-07-23T00:00:00.000Z')`,
			[HEAD],
		);
		expect(
			store.sealWorkflowPrManifestFromBindings({ runId: "run-1" }).ok,
		).toBe(true);
		const probeMergedPr = vi.fn(async () => ({
			probeRepoSlug: "geoforge3d/flywheel",
			prNumber: 687,
			headSha: "b".repeat(40),
			state: "MERGED" as const,
		}));
		const baseUrl = await startApp(store, {
			masterToken: "master-secret",
			scopedToken: "scoped-secret",
			probeMergedPr,
		});
		const postReceipt = () =>
			fetch(`${baseUrl}/api/runs/run-1/pr-manifest/merge-receipt`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer master-secret",
				},
				body: JSON.stringify({
					repoIdentity: "__main__",
					prNumber: 687,
					headSha: HEAD,
				}),
			});

		const mismatch = await postReceipt();
		expect(mismatch.status).toBe(409);
		expect(await mismatch.json()).toMatchObject({
			code: "PR_MERGE_PROOF_UNAVAILABLE",
		});
		expect(store.listCurrentWorkflowDeclaredPrs("run-1")[0]?.state).toBe(
			"declared",
		);

		probeMergedPr.mockResolvedValueOnce({
			probeRepoSlug: "geoforge3d/flywheel",
			prNumber: 687,
			headSha: HEAD,
			state: "MERGED",
		});
		const accepted = await postReceipt();
		expect(accepted.status).toBe(200);
		expect(await accepted.json()).toMatchObject({
			success: true,
			allMerged: true,
			flagOffRequired: false,
		});
		expect(store.listCurrentWorkflowDeclaredPrs("run-1")[0]?.state).toBe(
			"merged",
		);
		store.close();
	});
});
