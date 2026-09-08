import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { evidenceRunRecord } from "flywheel-comm/evidence-run";
import { describe, expect, it, vi } from "vitest";
import {
	createStrengthTwoEvidenceRouter,
	type StrengthTwoEvidenceRouterDeps,
} from "../bridge/strength-two-evidence-route.js";
import { StateStore } from "../StateStore.js";

const HEAD = "a".repeat(40);
const NOW = "2026-09-07T03:00:00.000Z";

function driftRole(
	store: StateStore,
	roleColumn: "session_role" | "chat_thread_role",
): void {
	if (roleColumn === "session_role") {
		store.upsertSession({
			execution_id: "qa-strength-two-route",
			issue_id: "FLY-2397",
			project_name: "flywheel",
			status: "running",
			session_role: "main",
		});
		return;
	}
	store.patchSessionMetadata("qa-strength-two-route", {
		chat_thread_role: "main",
	});
}

describe("strength-two evidence route — durable QA race", () => {
	it.each(["session_role", "chat_thread_role"] as const)(
		"rechecks %s in the authoritative insert transaction after probes finish",
		async (roleColumn) => {
			const store = await StateStore.create(":memory:");
			store.createWorkflowRun({
				runId: "run-strength-two-route",
				issueId: "FLY-2397",
				projectName: "flywheel",
				claimsReadEnrolled: false,
			});
			const admission = store.admitWorkflowExecution({
				runId: "run-strength-two-route",
				nodeId: "qa",
				executionId: "qa-strength-two-route",
				attempt: 1,
				family: "qa_verdict",
				expiresAt: "2026-09-07T04:00:00.000Z",
				absoluteDeadlineAt: "2026-09-07T05:00:00.000Z",
				now: NOW,
			});
			if (!admission.ok) throw new Error(admission.reason);
			store.upsertSession({
				execution_id: "qa-strength-two-route",
				issue_id: "FLY-2397",
				project_name: "flywheel",
				status: "running",
				workflow_node_id: "qa",
				session_role: "qa",
				chat_thread_role: "qa",
				worktree_path: "/tmp/flywheel-FLY-2397",
			});

			let releaseProbe!: () => void;
			const probeBlocked = new Promise<void>((resolve) => {
				releaseProbe = resolve;
			});
			let announceProbe!: () => void;
			const probeStarted = new Promise<void>((resolve) => {
				announceProbe = resolve;
			});
			const probeSite = vi.fn(async () => {
				announceProbe();
				await probeBlocked;
				return {
					ok: true as const,
					httpStatus: 200 as const,
					healthOk: true as const,
					shuttingDown: false as const,
					buildMode: "built" as const,
					buildSha: HEAD,
					artifactBuildSha: HEAD,
				};
			});
			const probeRecord = vi.fn(async () => ({
				kind: "hosted_report" as const,
				outcome: "ok" as const,
				evidence: {
					httpStatus: 200 as const,
					digest: "b".repeat(64),
					bytes: 128,
				},
			}));

			const app = express();
			app.use(express.json());
			app.use(
				"/api/workflow",
				createStrengthTwoEvidenceRouter({
					store,
					vercelProjectName: "fw-reports-test",
					resolveSiteBridgePort: () => 19_872,
					probeSite,
					probeRecord,
					resolveHeadAuthority: async () => ({
						executionId: "qa-strength-two-route",
						prHeadSha: HEAD,
						worktreePath: "/tmp/flywheel-FLY-2397",
					}),
					now: () => NOW,
				}),
			);

			const server = app.listen(0, "127.0.0.1");
			await new Promise<void>((resolve) => server.once("listening", resolve));
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("no port");
			const origin = `http://127.0.0.1:${address.port}`;
			const responsePromise = fetch(`${origin}/api/workflow/evidence-run`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					origin,
				},
				body: JSON.stringify({
					credential: admission.credential,
					record_id: "33333333-3333-4333-8333-333333333333",
					recorder_execution_id: "qa-strength-two-route",
					head: HEAD,
					site: "slot_529:2",
					lane: "generalized_e2e_stub",
					driver_exit_code: 0,
					record_url: `https://fw-reports-test.vercel.app/r/${"b".repeat(32)}/`,
					rerun_spec: {
						schemaVersion: 1,
						lane: "generalized_e2e_stub",
						deploy: {},
						driver: { issue: "FLY-2397", timeoutMs: 600000 },
					},
				}),
			});
			await probeStarted;
			driftRole(store, roleColumn);
			releaseProbe();

			const response = await responsePromise;
			const body = await response.json();
			expect(response.status).toBe(422);
			expect(body).toEqual({
				ok: false,
				reason: "evidence_run_rejected:recorder_not_durable_qa",
			});
			expect(
				store.listStrengthTwoRecordsForRun("run-strength-two-route"),
			).toEqual([]);
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			store.close();
		},
	);
});

const BASE_BODY = {
	record_id: "44444444-4444-4444-8444-444444444444",
	recorder_execution_id: "qa-strength-two-http",
	head: HEAD,
	site: "slot_529:2",
	lane: "generalized_e2e_stub",
	driver_exit_code: 0,
	record_url: `https://fw-reports-test.vercel.app/r/${"b".repeat(32)}/`,
	rerun_spec: {
		schemaVersion: 1,
		lane: "generalized_e2e_stub",
		deploy: {},
		driver: { issue: "FLY-2397", timeoutMs: 600000 },
	},
};

async function httpFixture(
	overrides: Partial<StrengthTwoEvidenceRouterDeps> = {},
) {
	const store = await StateStore.create(":memory:");
	store.createWorkflowRun({
		runId: "run-strength-two-http",
		issueId: "FLY-2397",
		projectName: "flywheel",
		claimsReadEnrolled: false,
	});
	const admission = store.admitWorkflowExecution({
		runId: "run-strength-two-http",
		nodeId: "qa",
		executionId: "qa-strength-two-http",
		attempt: 1,
		family: "qa_verdict",
		expiresAt: "2026-09-07T04:00:00.000Z",
		absoluteDeadlineAt: "2026-09-07T05:00:00.000Z",
		now: NOW,
	});
	if (!admission.ok) throw new Error(admission.reason);
	store.upsertSession({
		execution_id: "qa-strength-two-http",
		issue_id: "FLY-2397",
		project_name: "flywheel",
		status: "running",
		workflow_node_id: "qa",
		session_role: "qa",
		chat_thread_role: "qa",
		worktree_path: "/tmp/flywheel-FLY-2397",
	});
	const probeSite = vi.fn(async () => ({
		ok: true as const,
		httpStatus: 200 as const,
		healthOk: true as const,
		shuttingDown: false as const,
		buildMode: "built" as const,
		buildSha: HEAD,
		artifactBuildSha: HEAD,
	}));
	const probeRecord = vi.fn(async () => ({
		kind: "hosted_report" as const,
		outcome: "ok" as const,
		evidence: {
			httpStatus: 200 as const,
			digest: "b".repeat(64),
			bytes: 128,
		},
	}));
	const app = express();
	app.use(express.json());
	app.use(
		"/api/workflow",
		createStrengthTwoEvidenceRouter({
			store,
			vercelProjectName: "fw-reports-test",
			resolveSiteBridgePort: () => 19_872,
			probeSite,
			probeRecord,
			resolveHeadAuthority: async () => ({
				executionId: "qa-strength-two-http",
				prHeadSha: HEAD,
				worktreePath: "/tmp/flywheel-FLY-2397",
			}),
			now: () => NOW,
			...overrides,
		}),
	);
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	const origin = `http://127.0.0.1:${address.port}`;
	return {
		store,
		admission,
		origin,
		probeSite,
		probeRecord,
		post: async (body: Record<string, unknown>) => {
			const response = await fetch(`${origin}/api/workflow/evidence-run`, {
				method: "POST",
				headers: { "content-type": "application/json", origin },
				body: JSON.stringify({ credential: admission.credential, ...body }),
			});
			return { status: response.status, body: await response.json() };
		},
		close: async () => {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			store.close();
		},
	};
}

describe("strength-two evidence route — fail-closed boundary", () => {
	it("accepts the exact wire body emitted by the CLI client", async () => {
		const fx = await httpFixture();
		const dir = mkdtempSync(join(tmpdir(), "strength-two-cli-route-"));
		const rerunSpecPath = join(dir, "rerun.json");
		writeFileSync(rerunSpecPath, JSON.stringify(BASE_BODY.rerun_spec));
		try {
			expect(
				await evidenceRunRecord({
					execId: "qa-strength-two-http",
					head: HEAD,
					site: "slot_529:2",
					lane: "generalized_e2e_stub",
					driverExitCode: 0,
					recordUrl: BASE_BODY.record_url,
					rerunSpecPath,
					recordId: "77777777-7777-4777-8777-777777777777",
					stateDir: join(dir, "state"),
					env: {
						FLYWHEEL_BRIDGE_URL: fx.origin,
						FLYWHEEL_INGEST_TOKEN: "ingest-secret",
					},
					credentialResolver: () => fx.admission.credential,
					sleepImpl: async () => undefined,
					stdout: () => undefined,
					stderr: () => undefined,
				}),
			).toBe(0);
			expect(
				fx.store.listStrengthTwoRecordsForRun("run-strength-two-http"),
			).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			await fx.close();
		}
	});

	it("records and returns the two evidence halves independently", async () => {
		const fx = await httpFixture({
			probeRecord: async () => ({
				kind: "hosted_report",
				outcome: "http_error",
				httpStatus: 404,
				detail: "not found",
			}),
		});
		const response = await fx.post(BASE_BODY);
		expect(response).toMatchObject({
			status: 200,
			body: {
				ok: true,
				status: "inserted",
				record: {
					verdict: "unsatisfied",
					ran: { status: "satisfied", reason: "ok" },
					record: {
						status: "unsatisfied",
						reason: "url_http_error",
					},
				},
			},
		});
		expect(
			fx.store.listStrengthTwoRecordsForRun("run-strength-two-http"),
		).toHaveLength(1);
		await fx.close();
	});

	it("replays before role eligibility and conflicts without probing", async () => {
		const fx = await httpFixture();
		expect((await fx.post(BASE_BODY)).status).toBe(200);
		const calls = [
			fx.probeSite.mock.calls.length,
			fx.probeRecord.mock.calls.length,
		];
		fx.store.patchSessionMetadata("qa-strength-two-http", {
			chat_thread_role: "main",
		});
		expect(await fx.post(BASE_BODY)).toMatchObject({
			status: 200,
			body: { ok: true, status: "replayed" },
		});
		expect(
			await fx.post({
				...BASE_BODY,
				record_url: `https://fw-reports-test.vercel.app/r/${"c".repeat(32)}/`,
			}),
		).toEqual({
			status: 409,
			body: { ok: false, reason: "record_conflict" },
		});
		expect([
			fx.probeSite.mock.calls.length,
			fx.probeRecord.mock.calls.length,
		]).toEqual(calls);
		await fx.close();
	});

	it.each([
		[{ record_id: "not-a-uuid" }, "record_id_invalid"],
		[{ head: HEAD.toUpperCase() }, "head_invalid"],
		[{ site: "other:2" }, "site_kind_unsupported"],
		[{ site: "slot_529:0" }, "site_invalid"],
		[{ lane: "made_up" }, "lane_invalid"],
		[{ driver_exit_code: undefined }, "driver_exit_code_required"],
		[
			{
				lane: "manual_test_deploy",
				rerun_spec: {
					schemaVersion: 1,
					lane: "manual_test_deploy",
					deploy: { generalized: true },
				},
			},
			"driver_exit_code_forbidden",
		],
		[
			{ record_url: "https://example.com/proof" },
			"record_url_kind_unsupported",
		],
		[
			{
				rerun_spec: {
					...BASE_BODY.rerun_spec,
					lane: "generalized_e2e_real",
				},
			},
			"rerun_spec_invalid:lane_mismatch",
		],
	])("rejects malformed caller facts %#", async (change, reason) => {
		const fx = await httpFixture();
		const response = await fx.post({ ...BASE_BODY, ...change });
		expect(response).toEqual({
			status: 422,
			body: { ok: false, reason: `evidence_run_rejected:${reason}` },
		});
		expect(fx.probeSite).not.toHaveBeenCalled();
		expect(fx.probeRecord).not.toHaveBeenCalled();
		await fx.close();
	});

	it("rejects authority and structural probe failures before writing", async () => {
		const mismatch = await httpFixture({
			resolveHeadAuthority: async () => ({
				executionId: "qa-strength-two-http",
				prHeadSha: "c".repeat(40),
				worktreePath: "/tmp/flywheel-FLY-2397",
			}),
		});
		expect((await mismatch.post(BASE_BODY)).body).toMatchObject({
			reason: "evidence_run_rejected:head_authority_mismatch",
		});
		expect(mismatch.probeSite).not.toHaveBeenCalled();
		expect(
			mismatch.store.listStrengthTwoRecordsForRun("run-strength-two-http"),
		).toEqual([]);
		await mismatch.close();

		const unresolved = await httpFixture({
			resolveSiteBridgePort: () => undefined,
		});
		expect(await unresolved.post(BASE_BODY)).toEqual({
			status: 422,
			body: { ok: false, reason: "evidence_run_rejected:slot_port_unresolved" },
		});
		expect(unresolved.probeSite).not.toHaveBeenCalled();
		await unresolved.close();
	});

	it("fails closed on an invalid injected clock before probing expiry", async () => {
		const fx = await httpFixture({ now: () => "not-an-iso-timestamp" });
		expect(await fx.post(BASE_BODY)).toEqual({
			status: 422,
			body: {
				ok: false,
				reason: "evidence_run_rejected:recorder_credential_expired",
			},
		});
		expect(fx.probeSite).not.toHaveBeenCalled();
		expect(fx.probeRecord).not.toHaveBeenCalled();
		await fx.close();
	});

	it("maps a thrown probe invariant to 500 with zero rows", async () => {
		const fx = await httpFixture({
			probeRecord: async () => {
				throw new Error("corrupt registry");
			},
		});
		expect(await fx.post(BASE_BODY)).toEqual({
			status: 500,
			body: { ok: false, reason: "probe_infrastructure_failure:record" },
		});
		expect(
			fx.store.listStrengthTwoRecordsForRun("run-strength-two-http"),
		).toEqual([]);
		await fx.close();
	});

	it("caps concurrent probe work and releases capacity in finally", async () => {
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let announce!: () => void;
		const started = new Promise<void>((resolve) => {
			announce = resolve;
		});
		const fx = await httpFixture({
			maxInFlight: 1,
			probeSite: async () => {
				announce();
				await blocked;
				return {
					ok: true,
					httpStatus: 200,
					healthOk: true,
					shuttingDown: false,
					buildMode: "built",
					buildSha: HEAD,
					artifactBuildSha: HEAD,
				};
			},
		});
		const first = fx.post(BASE_BODY);
		await started;
		expect(
			await fx.post({
				...BASE_BODY,
				record_id: "55555555-5555-4555-8555-555555555555",
			}),
		).toEqual({ status: 429, body: { ok: false, reason: "busy" } });
		release();
		expect((await first).status).toBe(200);
		expect(
			(
				await fx.post({
					...BASE_BODY,
					record_id: "66666666-6666-4666-8666-666666666666",
				})
			).status,
		).toBe(200);
		await fx.close();
	});
});
