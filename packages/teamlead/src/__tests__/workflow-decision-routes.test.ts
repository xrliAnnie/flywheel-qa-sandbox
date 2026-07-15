import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { ConfirmTokenStore } from "../bridge/fleet-admin.js";
import { createWorkflowDecisionRouter } from "../bridge/workflow-decision-routes.js";
import { StateStore } from "../StateStore.js";

const T0 = "2026-07-14T00:00:00.000Z";
const T1 = "2026-07-14T01:00:00.000Z";
const T2 = "2026-07-14T02:00:00.000Z";

function gitWorktree(): { path: string; head: string } {
	const path = mkdtempSync(join(tmpdir(), "fly1244-head-"));
	execFileSync("git", ["init", "-q", path]);
	execFileSync("git", ["-C", path, "config", "user.email", "test@example.com"]);
	execFileSync("git", ["-C", path, "config", "user.name", "Test"]);
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
	const onQaResult = vi.fn().mockResolvedValue(undefined);
	let serverNow = T0;
	const app = express();
	app.use(express.json());
	app.use(
		"/api/workflow",
		createWorkflowDecisionRouter({
			store,
			phaseOrchestrator: { current: { onQaResult } as never },
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
		onQaResult,
		baseUrl: `http://127.0.0.1:${address.port}/api/workflow`,
		setServerNow: (value: string) => {
			serverNow = value;
		},
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

describe("workflow decision routes", () => {
	it("derives identity + server head, commits one claim, then safely re-drives the phase orchestrator on replay", async () => {
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
			expect(f.onQaResult).toHaveBeenCalledWith(
				expect.objectContaining({ execution_id: "qa-exec" }),
				expect.objectContaining({
					status: "pass",
					prHeadSha: f.worktree.head,
					targetExecutionId: "impl-exec",
				}),
			);
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
			expect(f.onQaResult).toHaveBeenCalledTimes(2);
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

	it("retries the orchestrator drive after a response-loss failure even when the audit event already exists", async () => {
		const f = await fixture();
		try {
			f.onQaResult.mockRejectedValueOnce(new Error("transient drive failure"));
			const body = {
				credential: f.credential,
				client_request_id: "retry-drive",
				status: "pass",
			};
			const first = await fetch(`${f.baseUrl}/decision`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(first.status).toBe(500);

			const replay = await fetch(`${f.baseUrl}/decision`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			expect(replay.status).toBe(200);
			expect(await replay.json()).toMatchObject({
				ok: true,
				idempotentReplay: true,
			});
			expect(f.onQaResult).toHaveBeenCalledTimes(2);
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
				reQa: { tokens: new ConfirmTokenStore(), respawn },
			}),
		);
		const server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		const origin = `http://127.0.0.1:${address.port}`;
		const stage = async () => {
			const response = await fetch(`${origin}/api/workflow/re-qa/stage`, {
				method: "POST",
				headers: { "content-type": "application/json", origin },
				body: JSON.stringify({ execution_id: "legacy-qa" }),
			});
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
