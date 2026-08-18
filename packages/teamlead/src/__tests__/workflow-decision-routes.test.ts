import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { canonicalSubmissionDigest } from "flywheel-config";
import { describe, expect, it, vi } from "vitest";
import { ConfirmTokenStore } from "../bridge/fleet-admin.js";
import type { MaterializedHeadAuthority } from "../bridge/materialized-head-authority.js";
import {
	createWorkflowDecisionRouter,
	type WorkflowPrProbeResult,
} from "../bridge/workflow-decision-routes.js";
import { StateStore } from "../StateStore.js";
import { legacyWorkflowSeeds } from "./fixtures/legacy-workflow-manifests.js";

const WORKFLOW_ON = {
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
};

const T0 = "2026-07-14T00:00:00.000Z";
const T1 = "2026-07-14T01:00:00.000Z";
const T2 = "2026-07-14T02:00:00.000Z";
const nativeFetch = globalThis.fetch;

const fetch = async (
	input: Parameters<typeof globalThis.fetch>[0],
	init?: Parameters<typeof globalThis.fetch>[1],
): Promise<Response> => {
	try {
		return await nativeFetch(input, init);
	} catch (error) {
		const method = init?.method?.toUpperCase() ?? "GET";
		const target = input instanceof Request ? input.url : String(input);
		throw new Error(
			`workflow-decision test request failed: ${method} ${target}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
};

function gitWorktree(): { path: string; head: string } {
	const path = mkdtempSync(join(tmpdir(), "fly1244-head-"));
	execFileSync("git", ["init", "-q", path]);
	execFileSync("git", ["-C", path, "config", "user.email", "test@example.com"]);
	execFileSync("git", ["-C", path, "config", "user.name", "Test"]);
	execFileSync("git", [
		"-C",
		path,
		"remote",
		"add",
		"origin",
		"https://github.com/geoforge3d/flywheel.git",
	]);
	writeFileSync(join(path, "README.md"), "head\n");
	mkdirSync(join(path, "agents"));
	writeFileSync(
		join(path, "agents", "generic-executor.md"),
		"Execute the pinned workflow node.\n",
	);
	execFileSync("git", ["-C", path, "add", "README.md"]);
	execFileSync("git", ["-C", path, "commit", "-qm", "head"]);
	return {
		path,
		head: execFileSync("git", ["-C", path, "rev-parse", "HEAD"], {
			encoding: "utf8",
		}).trim(),
	};
}

async function reviewFixture(options: {
	materializedHeadAuthority?: MaterializedHeadAuthority;
	prProbe?: () => Promise<WorkflowPrProbeResult>;
}) {
	const store = await StateStore.create(":memory:");
	const worktree = gitWorktree();
	const materializedHead = "c".repeat(40);
	const seed = legacyWorkflowSeeds().find(
		(candidate) => candidate.templateId === "tpl_product_v1",
	)!;
	store.importWorkflowTemplateSeed(seed, WORKFLOW_ON);
	store.materializeWorkflowRun({
		runId: "run-review",
		issueId: "FLY-1307",
		projectName: "flywheel",
		taskCategory: "product",
		templateId: seed.templateId,
		claimsReadEnrolled: true,
		actor: "lead",
		canonicalRoot: worktree.path,
		env: WORKFLOW_ON,
		startReservation: {
			idempotencyKey: "review-start",
			selectionDigest: "review-selection",
			nodeId: "research",
			attempt: 1,
			executionId: "research-1",
			createdAt: T0,
		},
	});
	store.upsertWorkflowRunNode({
		runId: "run-review",
		nodeId: "research",
		attempt: 1,
		state: "running",
		executionId: "research-1",
	});
	const env = WORKFLOW_ON;
	const admit = (nodeId: string, executionId: string) =>
		store.admitGeneralizedWorkflowExecution({
			runId: "run-review",
			nodeId,
			executionId,
			attempt: 1,
			expiresAt: T1,
			absoluteDeadlineAt: T2,
			now: T0,
			env,
		});
	const researchAdmission = admit("research", "research-1");
	if (!researchAdmission.ok) {
		throw new Error(`research admission failed: ${researchAdmission.reason}`);
	}
	const researchCompletion = store.commitEnrolledCompletion({
		executionId: "research-1",
		route: "no_code",
		sourceEventId: "research-complete",
		completionSubmission: { decision: { route: "no_code" } },
		now: T0,
	});
	if (!researchCompletion.ok) {
		throw new Error(`research completion failed: ${researchCompletion.reason}`);
	}
	const produceExecution = store.getWorkflowRunNode(
		"run-review",
		"produce",
		1,
	)?.execution_id;
	if (!produceExecution) throw new Error("produce successor missing");
	store.upsertSession({
		execution_id: produceExecution,
		issue_id: "FLY-1307",
		project_name: "flywheel",
		status: "running",
		adapter_type: "codex-tmux",
		pr_number: 1307,
	});
	store.bindWorktreeOnce(produceExecution, {
		path: worktree.path,
		branch: "fly-1307",
		generation: "review-fixture",
	});
	const produceAdmission = admit("produce", produceExecution);
	if (!produceAdmission.ok || !produceAdmission.outputCredential) {
		throw new Error("produce admission failed");
	}
	const output = store.submitWorkflowNodeOutput({
		token: produceAdmission.outputCredential,
		clientRequestId: "produce-output",
		payload: '{"result":"ready"}',
		now: T0,
	});
	if (!output.ok) throw new Error(output.reason);
	const produceCompletion = store.commitEnrolledCompletion({
		executionId: produceExecution,
		route: "needs_review",
		sourceEventId: "produce-complete",
		completionSubmission: { decision: { route: "needs_review" } },
		subjectDigest: worktree.head,
		prBinding: {
			prNumber: 1307,
			headSha: worktree.head,
			targetRepoIdentity: "__main__",
			probeRepoSlug: "geoforge3d/flywheel",
			targetRepoPath: worktree.path,
			worktreeBindingGeneration: "review-fixture",
		},
		now: T0,
	});
	if (!produceCompletion.ok) {
		throw new Error(`produce completion failed: ${produceCompletion.reason}`);
	}
	const outputRow = store.getWorkflowNodeOutput(output.outputId);
	if (!outputRow) throw new Error("produce output missing");
	const materialization = store.allocateWorkflowMaterialization({
		runId: "run-review",
		nodeId: "produce",
		attempt: 1,
		outputId: output.outputId,
		outputDigest: outputRow.output_digest,
		repo: "geoforge3d/flywheel",
		ref: "refs/heads/fly-1307",
		baseHead: worktree.head,
	});
	store.adoptWorkflowMaterializationCommit({
		effectId: materialization.effect_id,
		treeHead: materializedHead,
		commitHead: materializedHead,
	});
	store.confirmWorkflowMaterializationPush({
		effectId: materialization.effect_id,
		remoteHead: materializedHead,
		reviewNodeId: "review",
	});
	const reviewExecution = store.getWorkflowRunNode(
		"run-review",
		"review",
		1,
	)?.execution_id;
	if (!reviewExecution) throw new Error("review successor missing");
	const reviewAdmission = admit("review", reviewExecution);
	if (!reviewAdmission.ok || !reviewAdmission.submissionCredential) {
		throw new Error("review admission failed");
	}
	store.upsertSession({
		execution_id: produceExecution,
		issue_id: "FLY-1307",
		project_name: "flywheel",
		status: "completed",
		adapter_type: "codex-tmux",
	});
	store.upsertSession({
		execution_id: reviewExecution,
		issue_id: "FLY-1307",
		project_name: "flywheel",
		status: "running",
		adapter_type: "claude-tmux",
	});
	const app = express();
	app.use(express.json());
	app.use(
		"/api/workflow",
		createWorkflowDecisionRouter({
			store,
			materializedHeadAuthority: options.materializedHeadAuthority,
			prProbe:
				options.prProbe ??
				(async () => ({
					state: "OPEN",
					isDraft: false,
					isCrossRepository: false,
					headRefName: "fly-1307",
					headRefOid: materializedHead,
				})),
			now: () => T0,
		}),
	);
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	return {
		store,
		worktree,
		materializedHead,
		outputId: output.outputId,
		credential: reviewAdmission.submissionCredential,
		reviewExecution,
		produceExecution,
		materialization: {
			effectId: materialization.effect_id,
			producerNodeId: "produce",
			repo: "geoforge3d/flywheel",
			ref: "refs/heads/fly-1307",
		},
		claimCountBeforeReview: store.countWorkflowClaims("run-review"),
		baseUrl: `http://127.0.0.1:${address.port}/api/workflow`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

async function fixture() {
	const store = await StateStore.create(":memory:");
	const worktree = gitWorktree();
	store.upsertSession({
		execution_id: "impl-exec",
		issue_id: "FLY-1244",
		project_name: "flywheel",
		status: "awaiting_review",
		session_role: "implement",
		chat_thread_role: "implement",
		adapter_type: "codex-tmux",
		worktree_path: worktree.path,
	});
	store.upsertSession({
		execution_id: "qa-exec",
		issue_id: "FLY-1244",
		project_name: "flywheel",
		status: "running",
		session_role: "qa",
		chat_thread_role: "qa",
		adapter_type: "claude-tmux",
		runner_model: "opus",
		worktree_path: worktree.path,
	});
	store.createWorkflowRun({
		runId: "run-1",
		issueId: "FLY-1244",
		projectName: "flywheel",
		claimsReadEnrolled: false,
	});
	store.upsertWorkflowRunNode({
		runId: "run-1",
		nodeId: "implement",
		attempt: 1,
		state: "completed",
		executionId: "impl-exec",
	});
	const admission = store.admitWorkflowExecution({
		runId: "run-1",
		nodeId: "qa",
		executionId: "qa-exec",
		attempt: 1,
		family: "qa_verdict",
		now: T0,
		expiresAt: T1,
		absoluteDeadlineAt: T2,
	});
	if (!admission.ok) throw new Error(admission.reason);
	let serverNow = T0;
	const app = express();
	app.use(express.json());
	app.use(
		"/api/workflow",
		createWorkflowDecisionRouter({
			store,
			now: () => serverNow,
		}),
	);
	const server = app.listen(0, "127.0.0.1");
	await new Promise<void>((resolve) => server.once("listening", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");
	return {
		store,
		worktree,
		credential: admission.credential,
		baseUrl: `http://127.0.0.1:${address.port}/api/workflow`,
		setServerNow: (value: string) => {
			serverNow = value;
		},
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

describe("schema-v1 workflow recovery decision routes", () => {
	it("reports the request target when a test-server fetch fails", async () => {
		await expect(fetch("http://127.0.0.1:1/unavailable")).rejects.toThrow(
			"workflow-decision test request failed: GET http://127.0.0.1:1/unavailable",
		);
	});

	it("derives identity + server head, commits one claim, and replays idempotently", async () => {
		const f = await fixture();
		try {
			const body = {
				credential: f.credential,
				client_request_id: "request-1",
				status: "pass",
				summary: "fresh-spawn checks passed",
				client_pr_head_sha: f.worktree.head,
				target_execution_id: "attacker-selected-target",
			};
			const first = await fetch(`${f.baseUrl}/decision`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(first.status).toBe(200);
			const accepted = (await first.json()) as Record<string, unknown>;
			expect(accepted).toMatchObject({ ok: true, idempotentReplay: false });
			const claim = f.store.getWorkflowClaim(Number(accepted.claimId));
			expect(claim).toMatchObject({
				predicate: "qa_passed",
				subject_digest: f.worktree.head,
				issuer_execution_id: "qa-exec",
				subject_producer_execution_id: "impl-exec",
			});
			// Simulate a lost HTTP response followed by a later retry. Server-owned
			// clock fields must not poison the request digest.
			f.setServerNow("2026-07-14T00:05:00.000Z");

			const replay = await fetch(`${f.baseUrl}/decision`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(await replay.json()).toMatchObject({
				ok: true,
				idempotentReplay: true,
				claimId: accepted.claimId,
			});
			expect(f.store.countWorkflowClaims("run-1")).toBe(1);
		} finally {
			await f.close();
		}
	});

	it("selects the implement producer for the current QA attempt after a keep-alive kickback", async () => {
		const f = await fixture();
		try {
			f.store.upsertWorkflowRunNode({
				runId: "run-1",
				nodeId: "implement",
				attempt: 2,
				state: "completed",
				executionId: "impl-exec",
			});
			f.store.upsertSession({
				execution_id: "qa-exec-2",
				issue_id: "FLY-1244",
				project_name: "flywheel",
				status: "running",
				session_role: "qa",
				chat_thread_role: "qa",
				adapter_type: "claude-tmux",
				runner_model: "opus",
				worktree_path: f.worktree.path,
			});
			const secondAdmission = f.store.admitWorkflowExecution({
				runId: "run-1",
				nodeId: "qa",
				executionId: "qa-exec-2",
				attempt: 2,
				family: "qa_verdict",
				now: T0,
				expiresAt: T1,
				absoluteDeadlineAt: T2,
			});
			expect(secondAdmission.ok).toBe(true);
			if (!secondAdmission.ok) return;
			const response = await fetch(`${f.baseUrl}/decision`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					credential: secondAdmission.credential,
					client_request_id: "kickback-pass",
					status: "pass",
				}),
			});
			expect(response.status).toBe(200);
			const accepted = await response.json();
			expect(accepted).toMatchObject({ ok: true });
			expect(f.store.getWorkflowClaim(accepted.claimId)).toMatchObject({
				subject_producer_execution_id: "impl-exec",
				attempt: 2,
			});
		} finally {
			await f.close();
		}
	});

	it("rejects caller-head drift before writing a claim", async () => {
		const f = await fixture();
		try {
			const response = await fetch(`${f.baseUrl}/decision`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					credential: f.credential,
					client_request_id: "request-drift",
					status: "pass",
					client_pr_head_sha: "f".repeat(40),
				}),
			});
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				ok: false,
				reason: "head_authority_mismatch",
				expectedPrHeadSha: f.worktree.head,
			});
			expect(f.store.countWorkflowClaims("run-1")).toBe(0);
		} finally {
			await f.close();
		}
	});

	it("exposes the same worktree-derived head authority on the loopback read route", async () => {
		const f = await fixture();
		try {
			const response = await fetch(`${f.baseUrl}/head-authority`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ execution_id: "qa-exec" }),
			});
			expect(await response.json()).toEqual({
				ok: true,
				executionId: "qa-exec",
				prHeadSha: f.worktree.head,
			});
		} finally {
			await f.close();
		}
	});

	it("resolves ship authority from the immutable approve-question binding", async () => {
		const f = await fixture();
		try {
			const db = (
				f.store as unknown as {
					db: { run(sql: string, params?: unknown[]): void };
				}
			).db;
			db.run(
				`INSERT INTO workflow_gate_holder
				   (run_id, gate_node_id, attempt, head_sha, source_execution_id,
				    question_id, state, materialization_stage, created_at, updated_at)
				 VALUES ('run-1', 'founder_gate', 1, ?, 'qa-exec', 'ship-q',
				         'approved', 'completed', ?, ?)`,
				[f.worktree.head, T0, T0],
			);
			db.run(
				`INSERT INTO workflow_ship_target_binding
				   (approve_question_id, run_id, target_repo_path,
				    target_repo_identity, probe_repo_slug, frozen_head_sha,
				    worktree_binding_generation)
				 VALUES ('ship-q', 'run-1', ?, '__main__',
				         'geoforge3d/flywheel', ?, 'generation-1')`,
				[realpathSync(f.worktree.path), f.worktree.head],
			);
			const response = await fetch(`${f.baseUrl}/head-authority`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					execution_id: "qa-exec",
					approve_question_id: "ship-q",
				}),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				ok: true,
				executionId: "qa-exec",
				approveQuestionId: "ship-q",
				targetRepoIdentity: "__main__",
				prHeadSha: f.worktree.head,
			});
		} finally {
			await f.close();
		}
	});

	it.each([
		["runner_ship", true, "runner_ship_binding_missing"],
		["engine_terminal", false, "not_required_for_engine_terminal_authority"],
	] as const)(
		"explains a missing %s ship target binding",
		async (authorityMode, required, reason) => {
			const f = await fixture();
			try {
				const db = (
					f.store as unknown as {
						db: { run(sql: string, params?: unknown[]): void };
					}
				).db;
				db.run(
					`INSERT INTO workflow_gate_holder
					   (run_id, gate_node_id, attempt, head_sha, source_execution_id,
					    question_id, authority_mode, subject_kind, carrier_binding_state,
					    state, materialization_stage, created_at, updated_at)
					 VALUES ('run-1', 'founder_gate', 1, ?, 'qa-exec', ?, ?, 'git_head',
					         'bound', 'awaiting_review', 'completed', ?, ?)`,
					[f.worktree.head, `${authorityMode}-q`, authorityMode, T0, T0],
				);
				const response = await fetch(`${f.baseUrl}/head-authority`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						execution_id: "qa-exec",
						approve_question_id: `${authorityMode}-q`,
					}),
				});
				expect(response.status).toBe(409);
				expect(await response.json()).toEqual({
					ok: false,
					reason: "ship_target_binding_unavailable",
					binding: { required, reason, authorityMode },
				});
			} finally {
				await f.close();
			}
		},
	);

	it("resolves a legacy approve question without requiring a workflow gate holder", async () => {
		const f = await fixture();
		try {
			f.store.setReviewBinding("qa-exec", {
				questionId: "legacy-ship-q",
				prHeadSha: f.worktree.head,
				shipTarget: {
					sourceRequestId: "review-request-legacy",
					targetRepoPath: realpathSync(f.worktree.path),
					targetRepoIdentity: "__main__",
					probeRepoSlug: "geoforge3d/flywheel",
					worktreeBindingGeneration: "legacy-generation",
				},
			});
			const response = await fetch(`${f.baseUrl}/head-authority`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					execution_id: "qa-exec",
					approve_question_id: "legacy-ship-q",
				}),
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				ok: true,
				executionId: "qa-exec",
				approveQuestionId: "legacy-ship-q",
				targetRepoIdentity: "__main__",
				prHeadSha: f.worktree.head,
			});
		} finally {
			await f.close();
		}
	});

	it("rejects a legacy target binding owned by another execution", async () => {
		const f = await fixture();
		try {
			f.store.setReviewBinding("impl-exec", {
				questionId: "foreign-ship-q",
				prHeadSha: f.worktree.head,
				shipTarget: {
					targetRepoPath: realpathSync(f.worktree.path),
					targetRepoIdentity: "__main__",
					probeRepoSlug: "geoforge3d/flywheel",
					worktreeBindingGeneration: "legacy-generation",
				},
			});
			const response = await fetch(`${f.baseUrl}/head-authority`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					execution_id: "qa-exec",
					approve_question_id: "foreign-ship-q",
				}),
			});
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				ok: false,
				reason: "ship_target_binding_mismatch",
			});
		} finally {
			await f.close();
		}
	});

	it("rejects nested ship authority before repository side effects", async () => {
		const f = await fixture();
		try {
			const db = (
				f.store as unknown as {
					db: { run(sql: string, params?: unknown[]): void };
				}
			).db;
			db.run(
				`INSERT INTO workflow_gate_holder
				   (run_id, gate_node_id, attempt, head_sha, source_execution_id,
				    question_id, state, materialization_stage, created_at, updated_at)
				 VALUES ('run-1', 'founder_gate', 1, ?, 'qa-exec', 'nested-q',
				         'approved', 'completed', ?, ?)`,
				[f.worktree.head, T0, T0],
			);
			db.run(
				`INSERT INTO workflow_ship_target_binding
				   (approve_question_id, run_id, target_repo_path,
				    target_repo_identity, probe_repo_slug, frozen_head_sha,
				    worktree_binding_generation)
				 VALUES ('nested-q', 'run-1', ?, 'geoforge3d/nested',
				         'geoforge3d/nested', ?, 'generation-1')`,
				[f.worktree.path, f.worktree.head],
			);
			const response = await fetch(`${f.baseUrl}/head-authority`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					execution_id: "qa-exec",
					approve_question_id: "nested-q",
				}),
			});
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				ok: false,
				reason: "nested_ship_unsupported",
			});
		} finally {
			await f.close();
		}
	});
});

describe("engine-owned review decision canonicalization", () => {
	it("derives review authority from the pinned node and advances the DAG", async () => {
		let f: Awaited<ReturnType<typeof reviewFixture>> | undefined;
		const authority: MaterializedHeadAuthority = {
			resolve: vi.fn(async () => {
				if (!f) throw new Error("fixture_not_ready");
				return {
					head: f.materializedHead,
					outputId: f.outputId,
					attempt: 1,
					...f.materialization,
				};
			}),
		};
		f = await reviewFixture({ materializedHeadAuthority: authority });
		try {
			const body = {
				credential: f.credential,
				client_request_id: "review-pass",
				status: "pass",
				client_pr_head_sha: f.materializedHead,
			};
			const first = await fetch(`${f.baseUrl}/decision`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(first.status).toBe(200);
			const accepted = await first.json();
			expect(accepted).toMatchObject({ ok: true, idempotentReplay: false });
			expect(f.store.getWorkflowClaim(accepted.claimId)).toMatchObject({
				predicate: "design_review_approved",
				issuer_execution_id: f.reviewExecution,
				subject_producer_execution_id: f.produceExecution,
				subject_digest: f.materializedHead,
			});
			expect(
				f.store.getWorkflowRunNode("run-review", "founder_gate", 1),
			).toMatchObject({ state: "review" });
			expect(
				f.store.getCurrentWorkflowNodePrBindingForHead(
					"run-review",
					f.materializedHead,
				),
			).toMatchObject({
				node_id: "review",
				worktree_binding_generation: `receipt-v1:${f.materialization.effectId}`,
			});
			const holder = f.store
				.listWorkflowRunEvents("run-review")
				.find((event) => event.kind === "gate_holder_created");
			const questionId = (holder?.payload as { questionId?: string })
				?.questionId;
			expect(questionId).toBeTruthy();
			const headAuthority = await fetch(`${f.baseUrl}/head-authority`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					execution_id: f.reviewExecution,
					approve_question_id: questionId,
				}),
			});
			expect(headAuthority.status).toBe(200);
			expect(await headAuthority.json()).toMatchObject({
				ok: true,
				prHeadSha: f.materializedHead,
			});

			const replay = await fetch(`${f.baseUrl}/decision`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(await replay.json()).toMatchObject({
				ok: true,
				idempotentReplay: true,
				claimId: accepted.claimId,
			});
			expect(f.store.countWorkflowClaims("run-review")).toBe(
				f.claimCountBeforeReview + 1,
			);
		} finally {
			await f.close();
		}
	});

	it("refuses approval-gate entry when the materialized receipt is not the live PR tip", async () => {
		let f: Awaited<ReturnType<typeof reviewFixture>> | undefined;
		const authority: MaterializedHeadAuthority = {
			resolve: async () => {
				if (!f) throw new Error("fixture_not_ready");
				return {
					head: f.materializedHead,
					outputId: f.outputId,
					attempt: 1,
					...f.materialization,
				};
			},
		};
		f = await reviewFixture({
			materializedHeadAuthority: authority,
			prProbe: async () => ({
				state: "OPEN",
				isDraft: false,
				isCrossRepository: false,
				headRefName: "fly-1307",
				headRefOid: "f".repeat(40),
			}),
		});
		try {
			const response = await fetch(`${f.baseUrl}/decision`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					credential: f.credential,
					client_request_id: "review-pr-behind-materialization",
					status: "pass",
					client_pr_head_sha: f.materializedHead,
				}),
			});
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				ok: false,
				reason: "land_head_materialized_pr_not_at_tip",
			});
			expect(f.store.countWorkflowClaims("run-review")).toBe(
				f.claimCountBeforeReview,
			);
		} finally {
			await f.close();
		}
	});

	it("fails closed when a receipt-backed ship target drifts after gate entry", async () => {
		let f: Awaited<ReturnType<typeof reviewFixture>> | undefined;
		let remoteHead = "";
		const authority: MaterializedHeadAuthority = {
			resolve: async () => {
				if (!f) throw new Error("fixture_not_ready");
				return {
					head: f.materializedHead,
					outputId: f.outputId,
					attempt: 1,
					...f.materialization,
				};
			},
		};
		f = await reviewFixture({
			materializedHeadAuthority: authority,
			prProbe: async () => ({
				state: "OPEN",
				isDraft: false,
				isCrossRepository: false,
				headRefName: "fly-1307",
				headRefOid: remoteHead,
			}),
		});
		remoteHead = f.materializedHead;
		try {
			const accepted = await fetch(`${f.baseUrl}/decision`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					credential: f.credential,
					client_request_id: "review-pass-before-remote-drift",
					status: "pass",
					client_pr_head_sha: f.materializedHead,
				}),
			});
			expect(accepted.status).toBe(200);
			const holder = f.store
				.listWorkflowRunEvents("run-review")
				.find((event) => event.kind === "gate_holder_created");
			const questionId = (holder?.payload as { questionId?: string })
				?.questionId;
			remoteHead = "f".repeat(40);
			const response = await fetch(`${f.baseUrl}/head-authority`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					execution_id: f.reviewExecution,
					approve_question_id: questionId,
				}),
			});
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				ok: false,
				reason: "ship_target_authority_drift",
			});
		} finally {
			await f.close();
		}
	});

	it("fails closed when materialized head authority is unavailable", async () => {
		const f = await reviewFixture({});
		try {
			const response = await fetch(`${f.baseUrl}/decision`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					credential: f.credential,
					client_request_id: "review-unavailable",
					status: "pass",
				}),
			});
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				ok: false,
				reason: "materialized_head_unavailable",
			});
			expect(f.store.countWorkflowClaims("run-review")).toBe(
				f.claimCountBeforeReview,
			);
		} finally {
			await f.close();
		}
	});

	it("rejects a forged client review head before consuming the credential", async () => {
		let f: Awaited<ReturnType<typeof reviewFixture>> | undefined;
		const authority: MaterializedHeadAuthority = {
			resolve: async () => {
				if (!f) throw new Error("fixture_not_ready");
				return {
					head: f.materializedHead,
					outputId: f.outputId,
					attempt: 1,
					...f.materialization,
				};
			},
		};
		f = await reviewFixture({ materializedHeadAuthority: authority });
		try {
			const response = await fetch(`${f.baseUrl}/decision`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					credential: f.credential,
					client_request_id: "review-forged-head",
					status: "pass",
					client_pr_head_sha: "f".repeat(40),
				}),
			});
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				ok: false,
				reason: "head_authority_mismatch",
				expectedPrHeadSha: f.materializedHead,
			});
			expect(f.store.countWorkflowClaims("run-review")).toBe(
				f.claimCountBeforeReview,
			);
		} finally {
			await f.close();
		}
	});

	it("records a review failure and follows the bounded producer loop", async () => {
		let f: Awaited<ReturnType<typeof reviewFixture>> | undefined;
		const authority: MaterializedHeadAuthority = {
			resolve: async () => {
				if (!f) throw new Error("fixture_not_ready");
				return {
					head: f.materializedHead,
					outputId: f.outputId,
					attempt: 1,
					...f.materialization,
				};
			},
		};
		f = await reviewFixture({ materializedHeadAuthority: authority });
		try {
			const response = await fetch(`${f.baseUrl}/decision`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					credential: f.credential,
					client_request_id: "review-fail",
					status: "fail",
					client_pr_head_sha: f.materializedHead,
				}),
			});
			expect(response.status).toBe(200);
			const accepted = await response.json();
			expect(f.store.getWorkflowClaim(accepted.claimId)).toMatchObject({
				predicate: "design_review_failed",
			});
			expect(
				f.store.getWorkflowRunNode("run-review", "produce", 2),
			).toMatchObject({ state: "pending", execution_id: expect.any(String) });
		} finally {
			await f.close();
		}
	});
});

describe("in-flight re-QA recovery", () => {
	it("stages a QA-only replacement, consumes confirmation, and converges repeats on the admitted attempt", async () => {
		const store = await StateStore.create(":memory:");
		const worktree = gitWorktree();
		store.upsertSession({
			execution_id: "legacy-qa",
			issue_id: "FLY-1244",
			project_name: "flywheel",
			status: "running",
			session_role: "qa",
			chat_thread_role: "qa",
			worktree_path: worktree.path,
		});
		store.createWorkflowRun({
			runId: "run-reqa",
			issueId: "FLY-1244",
			projectName: "flywheel",
			claimsReadEnrolled: false,
		});
		store.upsertWorkflowRunNode({
			runId: "run-reqa",
			nodeId: "qa",
			attempt: 1,
			state: "running",
			executionId: "legacy-qa",
		});
		const respawn = vi.fn(async (canonical) => {
			const admitted = store.admitWorkflowExecution({
				runId: canonical.runId,
				nodeId: "qa",
				executionId: "replacement-qa",
				attempt: canonical.targetAttempt,
				family: "qa_verdict",
				now: T0,
				expiresAt: T1,
				absoluteDeadlineAt: T2,
			});
			if (!admitted.ok) throw new Error(admitted.reason);
			return { executionId: "replacement-qa" };
		});
		const app = express();
		app.use(express.json());
		app.use(
			"/api/workflow",
			createWorkflowDecisionRouter({
				store,
				reQa: {
					tokens: new ConfirmTokenStore(),
					respawn,
				},
			}),
		);
		const server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		const origin = `http://127.0.0.1:${address.port}`;
		const stageResponse = () =>
			fetch(`${origin}/api/workflow/re-qa/stage`, {
				method: "POST",
				headers: { "content-type": "application/json", origin },
				body: JSON.stringify({ execution_id: "legacy-qa" }),
			});
		const stage = async () => {
			const response = await stageResponse();
			expect(response.status).toBe(200);
			return (await response.json()) as {
				canonical: Record<string, unknown>;
				confirmToken: string;
			};
		};
		const apply = (staged: Awaited<ReturnType<typeof stage>>) =>
			fetch(`${origin}/api/workflow/re-qa`, {
				method: "POST",
				headers: { "content-type": "application/json", origin },
				body: JSON.stringify(staged),
			});
		try {
			const staged = await stage();
			expect(staged.canonical).toMatchObject({
				runId: "run-reqa",
				sourceExecutionId: "legacy-qa",
				sourceAttempt: 1,
				targetAttempt: 2,
			});
			const first = await apply(staged);
			expect(await first.json()).toMatchObject({
				ok: true,
				idempotentReplay: false,
				executionId: "replacement-qa",
				targetAttempt: 2,
			});
			const replay = await apply(await stage());
			expect(await replay.json()).toMatchObject({
				ok: true,
				idempotentReplay: true,
				executionId: "replacement-qa",
			});
			expect(respawn).toHaveBeenCalledTimes(1);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("refuses to skip design/implement directly into QA", async () => {
		const store = await StateStore.create(":memory:");
		store.upsertSession({
			execution_id: "impl-running",
			issue_id: "FLY-1244",
			project_name: "flywheel",
			status: "running",
			session_role: "implement",
			chat_thread_role: "implement",
		});
		const app = express();
		app.use(express.json());
		app.use(
			"/api/workflow",
			createWorkflowDecisionRouter({
				store,
				reQa: {
					tokens: new ConfirmTokenStore(),
					respawn: vi.fn(),
				},
			}),
		);
		const server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		const origin = `http://127.0.0.1:${address.port}`;
		try {
			const response = await fetch(`${origin}/api/workflow/re-qa/stage`, {
				method: "POST",
				headers: { "content-type": "application/json", origin },
				body: JSON.stringify({ execution_id: "impl-running" }),
			});
			expect(response.status).toBe(409);
			expect(await response.json()).toMatchObject({
				ok: false,
				reason: "not_durable_qa_execution",
			});
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});

describe("Gate carrier rebind recovery", () => {
	it("exposes a loopback, same-origin, token-bound stage/apply path with receipt-first replay", async () => {
		const canonical = {
			requestId: `gate-carrier-rebind:${"1".repeat(64)}`,
			runId: "run-rebind",
			gateNodeId: "founder_gate",
			holderAttempt: 1,
			questionId: `workflow-gate:${"2".repeat(64)}`,
			candidateExecutionId: "implement-rebind",
			subjectDigest: "a".repeat(40),
		};
		const canonicalDigest = canonicalSubmissionDigest(canonical);
		let receipt:
			| {
					requestId: string;
					canonicalDigest: string;
					questionId: string;
					sourceExecutionId: string;
					reviewWindowStartedAt: string;
			  }
			| undefined;
		const store = {
			resolveWorkflowGateCarrierRebindCanonical: vi.fn(
				(questionId: string, candidateExecutionId: string) =>
					questionId === canonical.questionId &&
					candidateExecutionId === canonical.candidateExecutionId
						? canonical
						: undefined,
			),
			getWorkflowGateCarrierRebindReceipt: vi.fn(() => receipt),
			rebindWorkflowGateCarrier: vi.fn(() => {
				receipt = {
					requestId: canonical.requestId,
					canonicalDigest,
					questionId: canonical.questionId,
					sourceExecutionId: canonical.candidateExecutionId,
					reviewWindowStartedAt: T0,
				};
				return {
					ok: true as const,
					idempotentReplay: false,
					questionId: canonical.questionId,
					sourceExecutionId: canonical.candidateExecutionId,
					reviewWindowStartedAt: T0,
				};
			}),
		} as unknown as StateStore;
		const app = express();
		app.use(express.json());
		app.use(
			"/api/workflow",
			createWorkflowDecisionRouter({
				store,
				gateCarrierRebind: { tokens: new ConfirmTokenStore() },
				now: () => T0,
			}),
		);
		const server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		const origin = `http://127.0.0.1:${address.port}`;
		try {
			const crossOrigin = await fetch(
				`${origin}/api/workflow/gate-carrier-rebind/stage`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						origin: "https://attacker.example",
					},
					body: JSON.stringify({
						question_id: canonical.questionId,
						candidate_execution_id: canonical.candidateExecutionId,
					}),
				},
			);
			expect(crossOrigin.status).toBe(403);

			const stagedResponse = await fetch(
				`${origin}/api/workflow/gate-carrier-rebind/stage`,
				{
					method: "POST",
					headers: { "content-type": "application/json", origin },
					body: JSON.stringify({
						question_id: canonical.questionId,
						candidate_execution_id: canonical.candidateExecutionId,
					}),
				},
			);
			expect(stagedResponse.status).toBe(200);
			const staged = (await stagedResponse.json()) as {
				canonical: typeof canonical;
				confirmToken: string;
			};
			expect(staged.canonical).toEqual(canonical);

			const tampered = await fetch(
				`${origin}/api/workflow/gate-carrier-rebind`,
				{
					method: "POST",
					headers: { "content-type": "application/json", origin },
					body: JSON.stringify({
						...staged,
						canonical: {
							...staged.canonical,
							subjectDigest: "b".repeat(40),
						},
					}),
				},
			);
			expect(tampered.status).toBe(409);
			expect(await tampered.json()).toMatchObject({
				ok: false,
				reason: "rebind_state_changed",
			});
			expect(store.rebindWorkflowGateCarrier).not.toHaveBeenCalled();

			const apply = () =>
				fetch(`${origin}/api/workflow/gate-carrier-rebind`, {
					method: "POST",
					headers: { "content-type": "application/json", origin },
					body: JSON.stringify(staged),
				});
			const first = await apply();
			expect(first.status).toBe(200);
			expect(await first.json()).toMatchObject({
				ok: true,
				idempotentReplay: false,
				questionId: canonical.questionId,
				sourceExecutionId: canonical.candidateExecutionId,
				reviewWindowStartedAt: T0,
			});
			expect(store.rebindWorkflowGateCarrier).toHaveBeenCalledOnce();

			const replay = await apply();
			expect(replay.status).toBe(200);
			expect(await replay.json()).toMatchObject({
				ok: true,
				idempotentReplay: true,
				questionId: canonical.questionId,
				sourceExecutionId: canonical.candidateExecutionId,
				reviewWindowStartedAt: T0,
			});
			expect(store.rebindWorkflowGateCarrier).toHaveBeenCalledOnce();
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});

describe("generic workflow loop reentry", () => {
	it("stages one non-founder loop, commits it once, and receipt-first replays after the token is consumed", async () => {
		const store = await StateStore.create(":memory:");
		const seed = legacyWorkflowSeeds().find(
			(candidate) => candidate.templateId === "tpl_eng_heavy",
		)!;
		store.importWorkflowTemplateSeed(seed);
		store.materializeWorkflowRun({
			runId: "run-loop",
			issueId: "FLY-1441",
			projectName: "flywheel",
			taskCategory: "code",
			templateId: seed.templateId,
			claimsReadEnrolled: true,
			actor: "lead",
			env: WORKFLOW_ON,
			startReservation: {
				idempotencyKey: "loop-start",
				selectionDigest: "loop-selection",
				nodeId: "design",
				attempt: 1,
				executionId: "loop-design",
				createdAt: T0,
			},
		});
		store.upsertWorkflowRunNode({
			runId: "run-loop",
			nodeId: "design",
			attempt: 1,
			state: "running",
			executionId: "loop-design",
		});
		expect(
			store.commitWorkflowTransitionTx({
				runId: "run-loop",
				nodeId: "design",
				attempt: 1,
				executionId: "loop-design",
				outcome: "design_done",
				successorExecutionId: "loop-implement",
				now: T0,
			}),
		).toMatchObject({ ok: true });
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-loop",
				nodeId: "implement",
				attempt: 1,
				executionId: "loop-implement",
				expiresAt: T1,
				absoluteDeadlineAt: T2,
				now: T0,
				env: WORKFLOW_ON,
			}),
		).toMatchObject({ ok: true });
		expect(
			store.commitWorkflowTransitionTx({
				runId: "run-loop",
				nodeId: "implement",
				attempt: 1,
				executionId: "loop-implement",
				outcome: "implement_done",
				successorExecutionId: "loop-qa",
				now: T0,
			}),
		).toMatchObject({ ok: true });
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-loop",
				nodeId: "qa",
				attempt: 1,
				executionId: "loop-qa",
				expiresAt: T1,
				absoluteDeadlineAt: T2,
				now: T0,
				env: WORKFLOW_ON,
			}),
		).toMatchObject({ ok: true });

		const app = express();
		app.use(express.json());
		app.use(
			"/api/workflow",
			createWorkflowDecisionRouter({
				store,
				loopReentry: { tokens: new ConfirmTokenStore() },
				now: () => T0,
			}),
		);
		const server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		const origin = `http://127.0.0.1:${address.port}`;
		try {
			const stagedResponse = await fetch(
				`${origin}/api/workflow/loop-reentry/stage`,
				{
					method: "POST",
					headers: { "content-type": "application/json", origin },
					body: JSON.stringify({
						execution_id: "loop-qa",
						loop_id: "qa_retry",
					}),
				},
			);
			expect(stagedResponse.status).toBe(200);
			const staged = (await stagedResponse.json()) as {
				canonical: Record<string, unknown>;
				confirmToken: string;
			};
			expect(staged.canonical).toMatchObject({
				runId: "run-loop",
				loopId: "qa_retry",
				sourceExecutionId: "loop-qa",
				expectedIteration: 1,
			});
			const apply = () =>
				fetch(`${origin}/api/workflow/loop-reentry`, {
					method: "POST",
					headers: { "content-type": "application/json", origin },
					body: JSON.stringify(staged),
				});
			const first = await apply();
			expect(first.status).toBe(200);
			expect(await first.json()).toMatchObject({
				ok: true,
				idempotentReplay: false,
				receipt: {
					edgeId: "qa_retry",
					targetNodeId: "implement",
					targetAttempt: 2,
				},
			});
			const replay = await apply();
			expect(replay.status).toBe(200);
			expect(await replay.json()).toMatchObject({
				ok: true,
				idempotentReplay: true,
			});
			expect(store.getWorkflowRun("run-loop")?.current_node_id).toBe(
				"implement",
			);
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			store.close();
		}
	});
});
