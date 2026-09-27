import { describe, expect, it, vi } from "vitest";
import type { StartRequest } from "../retry-dispatcher.js";
import type { WorkflowActorSession } from "../workflow-actor-session.js";
import {
	relaunchSameWorkflowExecution,
	type SameExecutionRelaunchDeps,
} from "../workflow-same-execution-relaunch.js";

const session = {
	execution_id: "exec-1",
	issue_id: "FLY-2900",
	project_name: "flywheel",
	worktree_path: "/wt/link",
	issue_identifier: "FLY-2900",
	chat_thread_role: "implement",
} as unknown as WorkflowActorSession;

function deps(
	overrides: Partial<SameExecutionRelaunchDeps> = {},
	onStart?: (request: StartRequest) => void,
): SameExecutionRelaunchDeps & { requests: StartRequest[] } {
	const requests: StartRequest[] = [];
	return {
		requests,
		startDispatcher: {
			start: vi.fn(async (request: StartRequest) => {
				requests.push(request);
				onStart?.(request);
				return {};
			}),
		},
		getRuntime: () => ({
			vendor: "codex",
			model: "gpt-5.6-sol",
			effort: "high",
			node_id: "implement",
		}),
		resolveCurrentActivation: () => ({
			kind: "current",
			run: { project_name: "flywheel" },
		}),
		manifestPath: (vendor, id) => `/state/${vendor}/${id}/session.json`,
		readManifest: () => ({
			threadId: "thread-1",
			resolvedModel: "gpt-5.6-sol",
			cwd: "/wt/real",
			lastObservedHead: "aaa",
		}),
		realpath: () => "/wt/real",
		gitIdentity: async () => ({ head: "aaa", dirty: false }),
		frozenLeadId: () => "flywheel-eng-lead",
		identityTimeoutMs: 50,
		...overrides,
	};
}

const baseLifecycle = () => ({
	generation: 1,
	resumeVerificationStatus: () => "accepted" as const,
});

describe("FLY-2900 relaunchSameWorkflowExecution — the shared FLY-2808 identity discipline", () => {
	const refusals: [string, Partial<SameExecutionRelaunchDeps>, string][] = [
		[
			"no dispatcher",
			{ startDispatcher: undefined },
			"start_dispatcher_unavailable",
		],
		[
			"no runtime",
			{ getRuntime: () => undefined },
			"resume_runtime_unavailable",
		],
		[
			"no current activation",
			{ resolveCurrentActivation: () => ({ kind: "ambiguous" }) },
			"resume_runtime_unavailable",
		],
		[
			"an unreadable manifest",
			{
				readManifest: () => {
					throw new Error("ENOENT");
				},
			},
			"resume_manifest_unavailable",
		],
		[
			"a manifest without a thread",
			{
				readManifest: () => ({ resolvedModel: "gpt-5.6-sol", cwd: "/wt/real" }),
			},
			"resume_session_identity_missing",
		],
		[
			"a model drift",
			{
				readManifest: () => ({
					threadId: "thread-1",
					resolvedModel: "other",
					cwd: "/wt/real",
				}),
			},
			"resume_model_mismatch",
		],
		[
			"a moved worktree",
			{
				realpath: (path) =>
					path === "/wt/link" ? "/wt/elsewhere" : "/wt/real",
			},
			"resume_worktree_mismatch",
		],
		[
			"an unreadable git identity",
			{
				gitIdentity: async () => {
					throw new Error("git");
				},
			},
			"resume_git_identity_unavailable",
		],
		[
			"an unreadable frozen Lead",
			{
				frozenLeadId: () => {
					throw new Error("commdb");
				},
			},
			"resume_lead_identity_unavailable",
		],
	];
	for (const [name, override, error] of refusals) {
		it(`refuses ${name} before any launch`, async () => {
			const d = deps(override);
			const result = await relaunchSameWorkflowExecution(d, {
				session,
				expectedHeadSha: "aaa",
				lifecycle: baseLifecycle,
			});
			expect(result).toMatchObject({
				ok: false,
				error,
				cleanupRequired: false,
			});
			expect(d.requests).toHaveLength(0);
		});
	}

	it("launches the exact session and resolves on identity, caller hook first", async () => {
		const order: string[] = [];
		const d = deps(
			{ gitIdentity: async () => ({ head: "bbb", dirty: true }) },
			(request) => {
				queueMicrotask(() =>
					request.processLifecycle!.onIdentityVerified!({
						sessionId: "thread-1",
						model: "gpt-5.6-sol",
						cwd: "/wt/real",
						verifiedAt: "t",
					}),
				);
			},
		);
		const result = await relaunchSameWorkflowExecution(d, {
			session,
			expectedHeadSha: "aaa",
			lifecycle: (identity) => {
				expect(identity).toMatchObject({
					expectedSessionId: "thread-1",
					currentHead: "bbb",
					dirty: true,
				});
				return {
					...baseLifecycle(),
					onIdentityVerified: () => order.push("caller"),
				};
			},
		});
		expect(result).toMatchObject({
			ok: true,
			observedSessionId: "thread-1",
			observedModel: "gpt-5.6-sol",
		});
		expect(order).toEqual(["caller"]);
		const request = d.requests[0]!;
		expect(request).toMatchObject({
			successorExecutionId: "exec-1",
			leadId: "flywheel-eng-lead",
			startPoint: "bbb",
			previousSession: { threadId: "thread-1" },
			processLifecycle: {
				mode: "resume",
				nodeId: "implement",
				expectedSessionId: "thread-1",
				expectedModel: "gpt-5.6-sol",
				expectedCwd: "/wt/real",
			},
		});
		expect(request.processLifecycle!.headDriftNotice).toContain(
			"moved from aaa to bbb and currently has uncommitted changes",
		);
	});

	it("keeps a genuine spawn failure mechanical", async () => {
		const d = deps({
			startDispatcher: {
				start: async () => {
					throw new Error("spawn ENOENT");
				},
			},
		});
		const result = await relaunchSameWorkflowExecution(d, {
			session,
			expectedHeadSha: "aaa",
			lifecycle: baseLifecycle,
		});
		expect(result).toMatchObject({
			ok: false,
			error: "spawn ENOENT",
			cleanupRequired: false,
		});
		expect(result).not.toHaveProperty("admissionBrake");
	});

	it("does not classify a post-start identity error as an admission brake", async () => {
		const d = deps({}, (request) => {
			queueMicrotask(() =>
				request.processLifecycle!.onIdentityVerificationFailed!(
					"RunDispatcher is shutting down",
				),
			);
		});
		const result = await relaunchSameWorkflowExecution(d, {
			session,
			expectedHeadSha: "aaa",
			lifecycle: baseLifecycle,
		});
		expect(result).toMatchObject({ ok: false, cleanupRequired: true });
		expect(result).not.toHaveProperty("admissionBrake");
	});

	it("times out an unverified identity and asks for cleanup", async () => {
		const d = deps();
		const result = await relaunchSameWorkflowExecution(d, {
			session,
			expectedHeadSha: "aaa",
			lifecycle: baseLifecycle,
		});
		expect(result).toMatchObject({
			ok: false,
			error: "resume_identity_timeout",
			cleanupRequired: true,
			evidence: { expectedSessionId: "thread-1", expectedModel: "gpt-5.6-sol" },
		});
	});

	it("reports a proven pre-commit launch failure with its physical evidence", async () => {
		const d = deps({
			startDispatcher: {
				start: async () => ({
					launchOutcome: Promise.resolve({
						status: "precommit_failed" as const,
						failure: {
							reason: "worktree_takeover_failed",
							physicalEvidence: "absent",
						},
					} as never),
				}),
			},
			identityTimeoutMs: 5_000,
		});
		const result = await relaunchSameWorkflowExecution(d, {
			session,
			expectedHeadSha: "aaa",
			lifecycle: baseLifecycle,
		});
		expect(result).toMatchObject({
			ok: false,
			error: "worktree_takeover_failed",
			cleanupRequired: false,
		});
	});

	it("surfaces an adapter identity failure through the caller hook and the result", async () => {
		const failed = vi.fn();
		const d = deps({ identityTimeoutMs: 5_000 }, (request) => {
			queueMicrotask(() =>
				request.processLifecycle!.onIdentityVerificationFailed!(
					"Codex resume observed model mismatch",
				),
			);
		});
		const result = await relaunchSameWorkflowExecution(d, {
			session,
			expectedHeadSha: "aaa",
			lifecycle: () => ({
				...baseLifecycle(),
				onIdentityVerificationFailed: failed,
			}),
		});
		expect(failed).toHaveBeenCalledWith("Codex resume observed model mismatch");
		expect(result).toMatchObject({
			ok: false,
			error: "Codex resume observed model mismatch",
			cleanupRequired: true,
		});
	});
});
