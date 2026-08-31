import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { createWorkflowDecisionRouter } from "../bridge/workflow-decision-routes.js";
import { legacyLandEngineeringSeed } from "./fixtures/legacy-workflow-manifests.js";

function gitWorktree(): { path: string; head: string } {
	const path = realpathSync(mkdtempSync(join(tmpdir(), "fly1686-route-")));
	execFileSync("git", ["init", "-q", path]);
	execFileSync("git", ["-C", path, "config", "user.email", "test@example.com"]);
	execFileSync("git", ["-C", path, "config", "user.name", "Test"]);
	execFileSync("git", [
		"-C",
		path,
		"remote",
		"add",
		"origin",
		"https://github.com/xrliAnnie/flywheel.git",
	]);
	writeFileSync(join(path, "README.md"), "head\n");
	execFileSync("git", ["-C", path, "add", "README.md"]);
	execFileSync("git", ["-C", path, "commit", "-qm", "head"]);
	return {
		path,
		head: execFileSync("git", ["-C", path, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim(),
	};
}

describe("FLY-1686 workflow decision route", () => {
	it("attests the PR tip and submits a gate-entry binding for a PASS edge", async () => {
		const worktree = gitWorktree();
		const snapshot = {
			schema_version: 2,
			template: { id: "fixture", revision: 1 },
			manifest: legacyLandEngineeringSeed().manifest,
			manifest_digest: "manifest",
			resolved: { nodes: legacyLandEngineeringSeed().manifest.nodes },
			snapshot_digest: "snapshot",
		};
		const submit = vi
			.fn()
			.mockReturnValueOnce({ ok: false, reason: "land_head_unavailable" })
			.mockReturnValue({
				ok: true,
				claimId: 1,
				serverSeq: 1,
				leadEventSeq: 41,
				idempotentReplay: false,
			});
		const enqueueLeadEvent = vi.fn();
		const prProbe = vi
			.fn()
			.mockResolvedValueOnce({
				state: "OPEN",
				isDraft: false,
				isCrossRepository: false,
				headRefName: "flywheel-FLY-1686",
				headRefOid: "a".repeat(40),
			})
			.mockResolvedValue({
				state: "OPEN",
				isDraft: false,
				isCrossRepository: false,
				headRefName: "flywheel-FLY-1686",
				headRefOid: worktree.head,
			});
		let consumedAt: string | null = null;
		const qaSession = {
			execution_id: "qa-route",
			issue_id: "FLY-1686",
			project_name: "flywheel",
			status: "running",
			adapter_type: "claude-tmux",
			worktree_path: worktree.path,
		};
		const producerSession = {
			execution_id: "implement-route",
			issue_id: "FLY-1686",
			project_name: "flywheel",
			status: "completed",
			adapter_type: "codex-tmux",
			pr_number: 807,
			pr_head_sha: "b".repeat(40),
		};
		const store = {
			getWorkflowSubmissionCredentialByToken: () => ({
				id: 7,
				activation_id: "activation-qa-route",
				execution_id: "qa-route",
				run_id: "run-route",
				node_id: "qa",
				attempt: 1,
				family: "qa_verdict",
				expires_at: "2026-08-12T00:00:00.000Z",
				consumed_at: consumedAt,
			}),
			resolveCurrentWorkflowActivation: () => ({
				kind: "current",
				binding: { activation_id: "activation-qa-route" },
				run: { engine_owned: 1 },
				node: snapshot.resolved.nodes.find((node) => node.id === "qa"),
				snapshot,
			}),
			getSession: (executionId: string) =>
				executionId === "qa-route" ? qaSession : producerSession,
			getWorkflowExecutionRuntime: (executionId: string) => ({
				vendor: executionId === "qa-route" ? "claude" : "codex",
				model: "test-model",
			}),
			listWorkflowRunNodes: () => [
				{
					run_id: "run-route",
					node_id: "implement",
					attempt: 1,
					state: "done",
					execution_id: "implement-route",
				},
			],
			getWorktreeBinding: () => ({
				path: worktree.path,
				branch: "flywheel-FLY-1686",
				generation: "generation-qa",
			}),
			getLeadEventBySeq: () => ({
				seq: 41,
				lead_id: "flywheel-eng-lead",
				event_id: "workflow_claim:1",
				event_type: "workflow_claim_recorded",
				payload: JSON.stringify({
					event_type: "workflow_claim_recorded",
					execution_id: "qa-route",
					issue_id: "FLY-1686",
					project_name: "flywheel",
				}),
				session_key: "wf:run-route",
				created_at: "2026-08-11 20:00:00",
			}),
			submitWorkflowDecisionByCredential: submit,
			insertEvent: vi.fn(),
		};
		const app = express();
		app.use(express.json());
		app.use(
			"/api/workflow",
			createWorkflowDecisionRouter({
				store,
				prProbe,
				resolveAlertIdentity: () => ({
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				}),
				enqueueLeadEvent,
				now: () => "2026-08-11T20:00:00.000Z",
			} as never),
		);
		const server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		try {
			const rejected = await fetch(
				`http://127.0.0.1:${address.port}/api/workflow/decision`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						credential: "credential",
						client_request_id: "request-route",
						status: "pass",
					}),
				},
			);
			expect(rejected.status).toBe(409);
			expect(await rejected.json()).toMatchObject({
				ok: false,
				reason: "land_head_pr_not_at_tip",
				detail: {
					expectedHeadOid: worktree.head,
					expectedHeadRefName: "flywheel-FLY-1686",
					prNumber: 807,
					repoSlug: "xrliannie/flywheel",
					currentHeadOid: "a".repeat(40),
				},
			});
			expect(submit).not.toHaveBeenCalled();

			const unavailable = await fetch(
				`http://127.0.0.1:${address.port}/api/workflow/decision`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						credential: "credential",
						client_request_id: "request-route",
						status: "pass",
					}),
				},
			);
			expect(unavailable.status).toBe(409);
			expect(await unavailable.json()).toEqual({
				ok: false,
				reason: "land_head_unavailable",
			});

			const response = await fetch(
				`http://127.0.0.1:${address.port}/api/workflow/decision`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						credential: "credential",
						client_request_id: "request-route",
						status: "pass",
					}),
				},
			);
			expect(response.status).toBe(200);
			expect(prProbe).toHaveBeenCalledWith({
				prNumber: 807,
				probeRepoSlug: "xrliannie/flywheel",
			});
			expect(submit).toHaveBeenCalledWith(
				expect.objectContaining({
					gateEntryBinding: {
						kind: "worktree",
						prNumber: 807,
						headSha: worktree.head,
						targetRepoIdentity: "__main__",
						probeRepoSlug: "xrliannie/flywheel",
						targetRepoPath: worktree.path,
						worktreeBindingGeneration: "generation-qa",
						expectedProducerMirrorHead: "b".repeat(40),
					},
				}),
			);
			expect(enqueueLeadEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					seq: 41,
					eventId: "workflow_claim:1",
				}),
			);

			consumedAt = "2026-08-11T20:00:00.000Z";
			const probeCalls = prProbe.mock.calls.length;
			const replay = await fetch(
				`http://127.0.0.1:${address.port}/api/workflow/decision`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						credential: "credential",
						client_request_id: "request-route",
						status: "pass",
					}),
				},
			);
			expect(replay.status).toBe(200);
			expect(prProbe).toHaveBeenCalledTimes(probeCalls);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
