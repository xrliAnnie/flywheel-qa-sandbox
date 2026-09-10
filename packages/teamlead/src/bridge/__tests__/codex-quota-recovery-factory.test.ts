import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCodexQuotaRunRecovery } from "../../codex-quota/run-recovery.js";
import type { StateStore } from "../../StateStore.js";

const roots: string[] = [];
afterEach(async () => {
	vi.unstubAllGlobals();
	for (const root of roots) await rm(root, { recursive: true, force: true });
});
async function fixture() {
	const home = await realpath(await mkdtemp(join(tmpdir(), "quota-recover-")));
	roots.push(home);
	const raw = "school-credential";
	await writeFile(join(home, "auth.json"), raw);
	const rootKey = createHash("sha256").update(home).digest("hex");
	const incident = {
		incident_id: "incident",
		root_key: rootKey,
		generation: 1,
		installed_generation: 2,
		state: "committed",
		probe_result: "ok",
		installed_auth_digest: createHash("sha256").update(raw).digest("hex"),
	};
	const target: Record<string, unknown> = {
		target_kind: "runner",
		target_id: "old-run",
		run_id: "old-run",
		old_execution_id: "old",
		state: "waiting",
	};
	const waits: Record<string, unknown>[] = [];
	const quota = {
		listAdmissionWaits: () =>
			waits.filter((w) => ["waiting", "resuming"].includes(String(w.state))),
		setAdmissionWaitState: vi.fn((key, state) => {
			const w = waits.find((w) => w.start_key === key);
			if (w) w.state = state;
		}),
		getIncident: () => incident,
		getRoot: () => ({ generation: 2, profile: "school", accountKey: "school" }),
		listTargets: () => [target],
		updateTarget: vi.fn((_i, _k, _t, patch) => Object.assign(target, patch)),
		enqueueOutbox: vi.fn(),
		getRunnerBindings: () => [
			{
				generation: 2,
				credentialRootKey: rootKey,
				profile: "school",
				accountKey: "school",
				executionId: "new",
			},
		],
	};
	const store = {
		getCodexQuotaRecoveryPermit: () => incident,
		getCodexQuotaAdmissionWaitContext: (key: string) => {
			const waiter = waits.find((w) => w.start_key === key)!;
			return {
				waiter,
				request: JSON.parse(String(waiter.request_context)),
				stopped:
					store.getWorkflowRun(String(waiter.run_id))?.status !== "active",
			};
		},
		codexQuota: quota,
		observeCodexQuotaCanonicalCredential: vi.fn(),
		getCodexQuotaRecoveryContext: () => ({
			target,
			incident,
			run: {
				run_id: "old-run",
				issue_id: "FLY-1",
				project_name: "fixture",
				selected_by: "lead",
			},
			operatorStopped: false,
		}),
		getActiveWorkflowRunForIssue: () => undefined,
		getSession: () => ({ status: "running" }),
		getWorkflowRun: () => ({
			status: "active",
			project_name: "fixture",
			issue_id: "FLY-WAIT",
		}),
		getWorkflowStartReservation: () => ({
			run_id: "wait-run",
			execution_id: "new",
			idempotency_key: "wait-key",
		}),
		save: () => {},
	} as unknown as StateStore;
	const liveness = vi.fn(async (id: string) =>
		id === "old" ? ("dead" as const) : ("alive" as const),
	);
	const readiness = vi.fn(async () => true);
	const factory = createCodexQuotaRunRecovery({
		store,
		canonicalHome: home,
		identify: (raw) =>
			raw.startsWith("school-")
				? { accountKey: "school", profile: "school" }
				: { accountKey: "personal", profile: "personal" },
		bridgeUrl: "http://127.0.0.1:12345",
		apiToken: "fixture-secret",
		verifyLiveness: liveness,
		readiness,
	});
	return {
		factory,
		incident,
		target,
		quota,
		home,
		liveness,
		store,
		waits,
		readiness,
	};
}
it("requires current canonical bytes and committed generation before any restart", async () => {
	const f = await fixture();
	const fetcher = vi.fn();
	vi.stubGlobal("fetch", fetcher);
	expect(await f.factory.canRecover("incident")).toBe(true);
	await writeFile(join(f.home, "auth.json"), "manual-change");
	expect(await f.factory.canRecover("incident")).toBe(false);
	await f.factory.recover(f.incident);
	expect(fetcher).not.toHaveBeenCalled();
});
it("persists queued cursor and identical authenticated request until actual running binding and process", async () => {
	const f = await fixture();
	const fetcher = vi
		.fn()
		.mockResolvedValueOnce(
			new Response(JSON.stringify({ success: true }), { status: 200 }),
		)
		.mockResolvedValueOnce(
			new Response(JSON.stringify({ runId: "new-run", executionId: "new" }), {
				status: 202,
			}),
		)
		.mockResolvedValue(
			new Response(
				JSON.stringify({
					runId: "new-run",
					executionId: "new",
					status: "running",
				}),
				{ status: 200 },
			),
		);
	// Return a new Response per replay; its body stream is consumed exactly once.
	vi.stubGlobal("fetch", fetcher);
	await f.factory.recover(f.incident);
	expect(f.target.state).toBe("queued");
	await f.factory.recover(f.incident);
	expect(f.target.state).toBe("recovered");
	expect(fetcher.mock.calls[1]?.[1].body).toBe(fetcher.mock.calls[2]?.[1].body);
	expect(JSON.parse(fetcher.mock.calls[1]?.[1].body).quotaRecoveryId).toBe(
		"incident:runner:old-run",
	);
	expect(fetcher.mock.calls[0]?.[1].headers.Authorization).toBe(
		"Bearer fixture-secret",
	);
});
it("treats unknown old process liveness as waiting rather than dead", async () => {
	const f = await fixture();
	f.liveness.mockResolvedValue("unknown" as never);
	const fetcher = vi.fn();
	vi.stubGlobal("fetch", fetcher);
	await f.factory.recover(f.incident);
	expect(fetcher).not.toHaveBeenCalled();
});

it("same-account native refresh preserves the committed generation recovery permission", async () => {
	const f = await fixture();
	await writeFile(join(f.home, "auth.json"), "school-refreshed-credential");
	expect(await f.factory.canRecover("incident")).toBe(true);
	expect(f.incident.installed_generation).toBe(2);
	const originalProof = f.incident.installed_auth_digest;
	vi.stubGlobal(
		"fetch",
		vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ success: true }), { status: 200 }),
			)
			.mockResolvedValue(
				new Response(
					JSON.stringify({
						status: "running",
						runId: "new-run",
						executionId: "new",
					}),
					{ status: 200 },
				),
			),
	);
	await f.factory.recover(f.incident);
	expect(f.target.state).toBe("recovered");
	expect(f.incident.installed_auth_digest).toBe(originalProof);
	expect(f.store.observeCodexQuotaCanonicalCredential).toHaveBeenCalledWith(
		expect.objectContaining({ generation: 2, accountKey: "school" }),
	);
});

it("never reports recovery success when a new session drifts from the original worktree", async () => {
	const f = await fixture();
	vi.spyOn(f.store, "getSession").mockImplementation(
		(id) =>
			({
				status: "running",
				worktree_path: id === "old" ? "/fixture/original" : "/fixture/other",
				branch: "task",
			}) as never,
	);
	vi.stubGlobal(
		"fetch",
		vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ success: true }), { status: 200 }),
			)
			.mockResolvedValue(
				new Response(
					JSON.stringify({
						status: "running",
						runId: "new-run",
						executionId: "new",
					}),
					{ status: 200 },
				),
			),
	);
	await f.factory.recover(f.incident);
	expect(f.target.state).not.toBe("recovered");
	expect(f.quota.enqueueOutbox).toHaveBeenCalledWith(
		expect.objectContaining({
			payload: expect.objectContaining({
				reason: "recovery_continuity_mismatch",
			}),
		}),
	);
});

it("late old-generation target uses only the current generation committed proof", async () => {
	const f = await fixture();
	const original = { ...f.incident, installed_generation: 1 };
	const proof = {
		...f.incident,
		incident_id: "current-proof",
		generation: 1,
		installed_generation: 2,
	};
	vi.spyOn(f.store, "getCodexQuotaRecoveryPermit").mockReturnValue(proof);
	vi.spyOn(f.store, "getCodexQuotaRecoveryContext").mockReturnValue({
		target: f.target,
		incident: original,
		run: {
			run_id: "old-run",
			issue_id: "FLY-1",
			project_name: "fixture",
			selected_by: "lead",
		},
		operatorStopped: false,
	} as never);
	vi.stubGlobal(
		"fetch",
		vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ success: true }), { status: 200 }),
			)
			.mockResolvedValue(
				new Response(
					JSON.stringify({
						status: "running",
						runId: "new-run",
						executionId: "new",
					}),
					{ status: 200 },
				),
			),
	);
	await f.factory.recover(original);
	expect(f.target.state).toBe("recovered");
	expect(original.installed_generation).toBe(1);
	f.target.state = "waiting";
	vi.spyOn(f.store, "getCodexQuotaRecoveryPermit").mockReturnValue(undefined);
	expect(await f.factory.canRecover("incident")).toBe(false);
});
it("deduplicates the same recovery summary but reports a late target set separately", async () => {
	const f = await fixture();
	f.target.state = "recovered";
	await f.factory.recover(f.incident);
	const first = f.quota.enqueueOutbox.mock.calls.at(-1)?.[0].eventId;
	await f.factory.recover(f.incident);
	expect(f.quota.enqueueOutbox.mock.calls.at(-1)?.[0].eventId).toBe(first);
	vi.spyOn(f.quota, "listTargets").mockReturnValue([
		f.target,
		{
			target_kind: "runner",
			target_id: "late-run",
			run_id: "late-run",
			new_run_id: "late-new",
			state: "recovered",
		},
	]);
	await f.factory.recover(f.incident);
	expect(f.quota.enqueueOutbox.mock.calls.at(-1)?.[0].eventId).not.toBe(first);
});

it("automatically replays a standalone admission waiter with the same reservation until physically running", async () => {
	const f = await fixture();
	f.target.state = "recovered";
	f.waits.push({
		start_key: "wait-key",
		run_id: "wait-run",
		execution_id: "new",
		root_key: f.incident.root_key,
		generation: 1,
		state: "waiting",
		request_context: JSON.stringify({
			issueId: "FLY-WAIT",
			projectName: "fixture",
			idempotencyKey: "wait-key",
			taskCategory: "research",
		}),
	});
	const fetcher = vi
		.fn()
		.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					status: "queued",
					runId: "wait-run",
					executionId: "new",
				}),
				{ status: 202 },
			),
		)
		.mockImplementation(
			() =>
				new Response(
					JSON.stringify({
						success: true,
						workflowRunId: "wait-run",
						executionId: "new",
					}),
					{ status: 200 },
				),
		);
	vi.stubGlobal("fetch", fetcher);
	await f.factory.recover(f.incident);
	expect(f.waits[0]?.state).toBe("resuming");
	expect(fetcher).toHaveBeenCalledOnce();
	f.liveness.mockResolvedValue("unknown" as never);
	await f.factory.recover(f.incident);
	expect(f.waits[0]?.state).toBe("resuming");
	f.liveness.mockResolvedValue("alive" as never);
	await f.factory.recover(f.incident);
	expect(f.waits[0]?.state).toBe("released");
	expect(fetcher.mock.calls[0]?.[1].body).toBe(fetcher.mock.calls[1]?.[1].body);
	expect(JSON.parse(fetcher.mock.calls[0]?.[1].body).idempotencyKey).toBe(
		"wait-key",
	);
});
it.each(["held", "terminated"])(
	"abandons standalone waiter when source run is %s",
	async (status) => {
		const f = await fixture();
		f.target.state = "recovered";
		f.waits.push({
			start_key: "wait-key",
			run_id: "wait-run",
			execution_id: "new",
			root_key: f.incident.root_key,
			generation: 1,
			state: "waiting",
			request_context: JSON.stringify({
				issueId: "FLY-WAIT",
				projectName: "fixture",
				idempotencyKey: "wait-key",
			}),
		});
		vi.spyOn(f.store, "getWorkflowRun").mockReturnValue({
			status,
			project_name: "fixture",
			issue_id: "FLY-WAIT",
		} as never);
		const fetcher = vi.fn();
		vi.stubGlobal("fetch", fetcher);
		await f.factory.recover(f.incident);
		expect(f.waits[0]?.state).toBe("abandoned");
		expect(fetcher).not.toHaveBeenCalled();
	},
);

it("does not auto resume casualties or admission waiters while migration readiness fails", async () => {
	const f = await fixture();
	f.readiness.mockResolvedValue(false);
	const fetcher = vi.fn();
	vi.stubGlobal("fetch", fetcher);
	await f.factory.recover(f.incident);
	expect(fetcher).not.toHaveBeenCalled();
	expect(f.target.state).toBe("waiting");
});
it("reconstructs the saved legacy role and dispatch model without replacing its key", async () => {
	const f = await fixture();
	f.target.state = "recovered";
	f.waits.push({
		start_key: "wait-key",
		execution_id: "new",
		root_key: f.incident.root_key,
		generation: 1,
		state: "waiting",
		request_context: JSON.stringify({
			issueId: "FLY-WAIT",
			projectName: "fixture",
			idempotencyKey: "wait-key",
			role: "implement",
			dispatchModel: "high",
		}),
	});
	const fetcher = vi.fn().mockResolvedValue(
		new Response(JSON.stringify({ success: true, executionId: "new" }), {
			status: 200,
		}),
	);
	vi.stubGlobal("fetch", fetcher);
	await f.factory.recover(f.incident);
	expect(JSON.parse(fetcher.mock.calls[0]?.[1].body)).toMatchObject({
		sessionRole: "implement",
		model: "high",
		idempotencyKey: "wait-key",
	});
	expect(f.waits[0]?.state).toBe("released");
});
