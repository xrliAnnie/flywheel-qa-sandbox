import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import {
	computeFounderArtifactDigest,
	createFounderReviewQuestionContent,
	inspectFounderReviewArtifactsAtCommit,
} from "flywheel-comm/founder-review";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyTransitionOpts } from "../applyTransition.js";
import { EventFilter } from "../bridge/EventFilter.js";
import {
	commDbPathForProject,
	formatNotification,
} from "../bridge/event-route.js";
import type { LeadEventEnvelope } from "../bridge/lead-runtime.js";
import { createBridgeApp } from "../bridge/plugin.js";
import { RuntimeRegistry } from "../bridge/runtime-registry.js";
import type { TurnBeltReconciler } from "../bridge/turn-belt-reconcile.js";
import type { BridgeConfig } from "../bridge/types.js";
import { DirectiveExecutor } from "../DirectiveExecutor.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { Session } from "../StateStore.js";
import { StateStore } from "../StateStore.js";
import { buildWorkflowRunSnapshotV2 } from "../workflow-run-snapshot.js";

const testProjects: ProjectEntry[] = [
	{
		projectName: "geoforge3d",
		projectRoot: "/tmp/geoforge3d",
		projectRepo: "xrliAnnie/GeoForge3D",
		leads: [
			{
				agentId: "product-lead",
				forumChannel: "test-channel",
				chatChannel: "test-chat",
				match: { labels: ["Product"] },
			},
		],
	},
];

function makeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		ingestToken: "ingest-secret",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "product-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
		...overrides,
	};
}

function makeEvent(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		event_id: `evt-${Math.random().toString(36).slice(2)}`,
		execution_id: "exec-1",
		issue_id: "issue-1",
		project_name: "geoforge3d",
		event_type: "session_started",
		payload: { issueIdentifier: "GEO-95", issueTitle: "Test issue" },
		...overrides,
	};
}

const headAuthorityRepos: string[] = [];
afterEach(() => {
	for (const repo of headAuthorityRepos.splice(0)) {
		rmSync(repo, { recursive: true, force: true });
	}
});

function attachGitHeadAuthority(
	store: StateStore,
	executionId = "exec-1",
): string {
	const repo = mkdtempSync(join(tmpdir(), "flywheel-event-head-"));
	headAuthorityRepos.push(repo);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
	git("init", "-q");
	writeFileSync(join(repo, "fixture.txt"), "fixture\n");
	git("add", "fixture.txt");
	git(
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.com",
		"commit",
		"-qm",
		"fixture",
	);
	const session = store.getSession(executionId);
	store.upsertSession({
		execution_id: executionId,
		issue_id: session?.issue_id ?? "issue-1",
		project_name: session?.project_name ?? "geoforge3d",
		status: session?.status ?? "running",
		worktree_path: repo,
	});
	const head = git("rev-parse", "HEAD");
	store.setReviewBinding(executionId, {
		questionId: session?.review_question_id ?? null,
		prHeadSha: head,
	});
	return head;
}

function bindGeneralizedExecution(
	store: StateStore,
	executionId: string,
): void {
	const root = mkdtempSync(join(tmpdir(), "flywheel-event-route-v2-"));
	mkdirSync(join(root, "agents"));
	writeFileSync(join(root, "agents", "generic.md"), "Execute.\n");
	const snapshot = buildWorkflowRunSnapshotV2({
		template: { id: "test", revision: 1 },
		canonicalRoot: root,
		manifest: {
			schema_version: 2,
			nodes: [
				{
					id: "execute",
					type: "generic",
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "low",
					agent_file: "agents/generic.md",
				},
				{ id: "founder_gate", type: "gate" },
			],
			edges: [
				{
					id: "done",
					from: "execute",
					to: "founder_gate",
					condition: "node_done",
				},
			],
			loops: [],
			terminal_gate: {
				node: "founder_gate",
				predicate: "founder_approved",
			},
			ship_claims: ["founder_approved"],
		},
	});
	rmSync(root, { recursive: true, force: true });
	store.createWorkflowRun({
		runId: `run-${executionId}`,
		issueId: "issue-1",
		projectName: "geoforge3d",
		snapshotJson: JSON.stringify(snapshot),
		claimsReadEnrolled: false,
	});
	const admission = store.admitGeneralizedWorkflowExecution({
		runId: `run-${executionId}`,
		nodeId: "execute",
		executionId,
		attempt: 1,
		now: "2026-07-15T00:00:00.000Z",
		expiresAt: "2026-07-15T00:05:00.000Z",
		absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
		env: {
			FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
			FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
			FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
			FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
		},
	});
	expect(admission).toMatchObject({ ok: true });
}

function bindGeneralizedDesignExecution(
	store: StateStore,
	executionId: string,
): void {
	const snapshot = buildWorkflowRunSnapshotV2({
		template: { id: "test-design", revision: 1 },
		canonicalRoot: "/tmp",
		manifest: {
			schema_version: 2,
			nodes: [
				{
					id: "design",
					type: "design",
					vendor: "claude",
					model: "claude-fable-5",
					effort: "high",
				},
				{
					id: "implement",
					type: "implement",
					vendor: "codex",
					model: "gpt-5.6-sol",
					effort: "xhigh",
				},
				{
					id: "qa",
					type: "qa",
					vendor: "claude",
					model: "claude-opus-5",
					effort: "high",
				},
				{ id: "founder_gate", type: "gate" },
			],
			edges: [
				{
					id: "design_done",
					from: "design",
					to: "implement",
					condition: "design_done",
				},
				{
					id: "implement_done",
					from: "implement",
					to: "qa",
					condition: "implement_done",
				},
				{
					id: "qa_pass",
					from: "qa",
					to: "founder_gate",
					condition: "qa_pass",
				},
			],
			loops: [
				{
					id: "qa_retry",
					from: "qa",
					to: "implement",
					loop_when: "qa_fail",
					exit_when: "qa_pass",
					max_iterations: 3,
					on_limit: "escalate",
				},
			],
			terminal_gate: {
				node: "founder_gate",
				predicate: "founder_approved",
			},
			ship_claims: ["qa_passed", "founder_approved"],
		},
	});
	store.createWorkflowRun({
		runId: `run-${executionId}`,
		issueId: "issue-1",
		projectName: "geoforge3d",
		snapshotJson: JSON.stringify(snapshot),
		claimsReadEnrolled: false,
	});
	const admission = store.admitGeneralizedWorkflowExecution({
		runId: `run-${executionId}`,
		nodeId: "design",
		executionId,
		attempt: 1,
		now: "2026-07-15T00:00:00.000Z",
		expiresAt: "2026-07-15T00:05:00.000Z",
		absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
		env: {
			FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
			FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
			FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
			FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
		},
	});
	if (!admission.ok) throw new Error(JSON.stringify(admission));
}

describe("Event route", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let turnBeltReconciler: { current: TurnBeltReconciler | undefined };

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		const config = makeConfig();
		turnBeltReconciler = { current: undefined };
		const app = createBridgeApp(
			store,
			testProjects,
			config,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ turnBeltReconciler },
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
		// FLY-827: these tests predate the Codex hard gate and verify notification /
		// lifecycle behavior orthogonal to codex. Run gate-OFF (byte-compat) so an
		// awaiting_review completion isn't held by the new codex/isReviewHeld branch.
		process.env.FLYWHEEL_CODEX_HARD_GATE = "0";
		// FLY-869: bypass the new merge/QA ship gates — these tests exercise the FSM
		// mapping, not the approval gate (covered by ship-eligibility + new integration tests).
		process.env.FLYWHEEL_MERGE_APPROVAL_GATE = "0";
		process.env.FLYWHEEL_QA_DONE_GATE = "0";
		// FLY-1385: this block exercises legacy event semantics. The retired
		// FORCE_LEGACY switch can no longer mask a host-level claims-read setting.
		process.env.FLYWHEEL_WORKFLOW_CLAIMS_READ = "0";
	});

	afterEach(async () => {
		delete process.env.FLYWHEEL_CODEX_HARD_GATE;
		delete process.env.FLYWHEEL_MERGE_APPROVAL_GATE;
		delete process.env.FLYWHEEL_QA_DONE_GATE;
		delete process.env.FLYWHEEL_WORKFLOW_CLAIMS_READ;
		delete process.env.FLYWHEEL_DESIGN_HTML_GATE;
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
	});

	it("POST /events with valid session_started creates session", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeEvent()),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);

		const session = store.getSession("exec-1");
		expect(session).toBeDefined();
		expect(session!.status).toBe("running");
		expect(session!.issue_identifier).toBe("GEO-95");
	});

	it("FLY-1709 R1: session_started preserves a pre-registered started_at", async () => {
		const originalStartedAt = "2026-08-01 12:00:00.123";
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "pending",
			started_at: originalStartedAt,
		});

		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeEvent()),
		});

		expect(res.status).toBe(200);
		expect(store.getSession("exec-1")?.started_at).toBe(originalStartedAt);
	});

	it("derives generalized workflow_node_id before storing the lifecycle event", async () => {
		bindGeneralizedExecution(store, "exec-1");
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_id: "generalized-started",
					payload: {
						issueIdentifier: "GEO-95",
						workflowNodeId: "payload-forgery",
					},
				}),
			),
		});
		expect(res.status).toBe(200);
		expect(store.getSession("exec-1")?.workflow_node_id).toBe("execute");
		expect(
			store
				.getEventsByExecution("exec-1")
				.some((event) => event.event_id === "generalized-started"),
		).toBe(true);
	});

	it("rejects a generalized set-once conflict before event idempotency consumes the id", async () => {
		bindGeneralizedExecution(store, "exec-1");
		store.upsertSession({
			execution_id: "exec-1",
			issue_id: "issue-1",
			project_name: "geoforge3d",
			status: "pending",
			workflow_node_id: "other",
		});
		const post = () =>
			fetch(`${baseUrl}/events`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer ingest-secret",
				},
				body: JSON.stringify(makeEvent({ event_id: "generalized-conflict" })),
			});
		expect((await post()).status).toBe(409);
		expect((await post()).status).toBe(409);
		expect(
			store
				.getEventsByExecution("exec-1")
				.some((event) => event.event_id === "generalized-conflict"),
		).toBe(false);
	});

	it("rejects engine-owned qa_result on /events before persisting it", async () => {
		bindGeneralizedExecution(store, "exec-1");
		const db = (
			store as unknown as {
				db: { run(sql: string, params?: unknown[]): void };
			}
		).db;
		db.run("UPDATE workflow_run SET engine_owned = 1 WHERE run_id = ?", [
			"run-exec-1",
		]);
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_id: "misrouted-engine-qa-result",
					event_type: "qa_result",
					payload: {
						status: "pass",
						targetExecutionId: "impl-1",
						qaExecutionId: "exec-1",
					},
				}),
			),
		});

		expect(res.status).toBe(409);
		expect(await res.json()).toMatchObject({
			ok: false,
			reason: "workflow_submission_required",
		});
		expect(
			store
				.getEventsByExecution("exec-1")
				.some((event) => event.event_id === "misrouted-engine-qa-result"),
		).toBe(false);
	});

	it("preserves shadow qa_result delivery on /events", async () => {
		store.createWorkflowRun({
			runId: "shadow-run",
			issueId: "issue-1",
			projectName: "geoforge3d",
			claimsReadEnrolled: true,
		});
		const admission = store.admitWorkflowExecution({
			runId: "shadow-run",
			nodeId: "qa",
			executionId: "shadow-qa",
			attempt: 2,
			family: "qa_verdict",
			now: "2026-07-15T00:00:00.000Z",
			expiresAt: "2026-07-15T00:05:00.000Z",
			absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
		});
		expect(admission).toMatchObject({ ok: true });

		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_id: "shadow-round-two-qa-result",
					execution_id: "shadow-qa",
					event_type: "qa_result",
					payload: {
						status: "pass",
						targetExecutionId: "impl-1",
						qaExecutionId: "shadow-qa",
					},
				}),
			),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true });
		expect(
			store
				.getEventsByExecution("shadow-qa")
				.some((event) => event.event_id === "shadow-round-two-qa-result"),
		).toBe(true);
	});

	it("commits explicit generalized completion before audit and suppresses legacy issue completion", async () => {
		bindGeneralizedExecution(store, "exec-1");
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_id: "explicit-complete-1",
					event_type: "session_completed",
					source: "flywheel-comm",
					payload: { decision: { route: "needs_review" } },
				}),
			),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			ok: true,
			generalized: true,
			completionDisposition: "terminal_no_gate",
		});
		expect(store.getSession("exec-1")).toMatchObject({
			status: "completed",
			workflow_node_id: "execute",
		});
		const lifecycle = store
			.getEventsByExecution("exec-1")
			.filter((event) => event.event_type === "session_completed");
		expect(lifecycle).toHaveLength(1);
		expect(lifecycle[0]?.event_id).toMatch(/^wfca:/);
	});

	it("returns named engine invariant refusals as diagnostic 409 responses", async () => {
		bindGeneralizedExecution(store, "exec-1");
		const commit = vi.spyOn(store, "commitEnrolledCompletion").mockReturnValue({
			ok: false,
			reason: "transition_refused",
			detail: {
				transitionReason:
					"engine_invariant:workflow_rework_verification_advance_cas_failed",
				alertPending: true,
			},
		});

		const response = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_id: "engine-invariant-completion",
					event_type: "session_completed",
					source: "flywheel-comm",
					payload: { decision: { route: "needs_review" } },
				}),
			),
		});

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error: "workflow_completion_rejected",
			reason: "transition_refused",
			detail: {
				transitionReason:
					"engine_invariant:workflow_rework_verification_advance_cas_failed",
				alertPending: true,
			},
		});
		expect(commit.mock.calls[0]?.[0].alertIdentity).toMatchObject({
			leadId: "product-lead",
			projectName: "geoforge3d",
		});
	});

	it("rejects invalid PR evidence for generalized nodes without founder review", async () => {
		bindGeneralizedExecution(store, "exec-1");
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_id: "generalized-invalid-pr-evidence",
					event_type: "session_completed",
					source: "flywheel-comm",
					payload: {
						decision: { route: "needs_review" },
						evidence: {
							landingStatus: {
								status: "ready_to_merge",
								prNumber: "not-a-pr-number",
							},
						},
					},
				}),
			),
		});

		expect(res.status).toBe(422);
		expect(await res.json()).toMatchObject({
			error: "workflow_pr_binding_rejected",
			reason: "invalid_pr_number",
		});
		expect(
			store.getWorkflowNodeCompletion("run-exec-1", "execute", 1),
		).toBeUndefined();
	});

	it("rejects a forged generalized completion until the current artifact has founder_review pass", async () => {
		const repo = mkdtempSync(join(tmpdir(), "fly1758-event-authority-"));
		const commRoot = mkdtempSync(join(tmpdir(), "fly1758-event-comm-"));
		const originalProjectRoot = testProjects[0]!.projectRoot;
		const originalCommDir = process.env.FLYWHEEL_COMM_DIR;
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
		try {
			git("init", "-q");
			git("remote", "add", "origin", "https://github.com/example/fly1758.git");
			mkdirSync(join(repo, "agents"));
			mkdirSync(join(repo, ".flywheel"));
			mkdirSync(join(repo, "product", "doc", "FLY-1758"), { recursive: true });
			writeFileSync(join(repo, "agents", "generic.md"), "Execute.\n");
			writeFileSync(
				join(repo, ".flywheel", "config.yaml"),
				"project: geoforge3d\nlinear:\n  team_id: GEO\nrunners:\n  default: claude\n  available:\n    claude:\n      type: claude\nteams:\n  - name: default\n    orchestrators:\n      - type: dag\n        runner: claude\ndecision_layer:\n  autonomy_level: advisor\n  escalation_channel: discord\ncheckpoints:\n  founder_review:\n    enabled: true\n    timeout_ms: 172800000\n    timeout_behavior: fail-close\n",
			);
			writeFileSync(
				join(repo, "product", "doc", "FLY-1758", "prd.html"),
				"<main data-comments>PRD v1</main>\n",
			);
			git("add", ".");
			git(
				"-c",
				"user.name=Test",
				"-c",
				"user.email=test@example.com",
				"commit",
				"-qm",
				"fixture",
			);
			const head = git("rev-parse", "HEAD");
			const snapshot = buildWorkflowRunSnapshotV2({
				template: { id: "prd", revision: 1 },
				canonicalRoot: repo,
				manifest: {
					schema_version: 2,
					nodes: [
						{
							id: "produce",
							type: "generic",
							vendor: "codex",
							model: "gpt-5.6-sol",
							effort: "low",
							agent_file: "agents/generic.md",
							founder_review: true,
						},
						{ id: "founder_gate", type: "gate" },
					],
					edges: [
						{
							id: "done",
							from: "produce",
							to: "founder_gate",
							condition: "node_done",
						},
					],
					loops: [],
					terminal_gate: {
						node: "founder_gate",
						predicate: "founder_approved",
					},
					ship_claims: ["founder_approved"],
				},
			});
			store.createWorkflowRun({
				runId: "run-exec-1",
				issueId: "issue-1",
				projectName: "geoforge3d",
				snapshotJson: JSON.stringify(snapshot),
				claimsReadEnrolled: false,
			});
			expect(
				store.admitGeneralizedWorkflowExecution({
					runId: "run-exec-1",
					nodeId: "produce",
					executionId: "exec-1",
					attempt: 1,
					now: "2026-08-14T00:00:00.000Z",
					expiresAt: "2026-08-14T00:05:00.000Z",
					absoluteDeadlineAt: "2026-08-14T01:00:00.000Z",
					env: {
						FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
						FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
						FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
						FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
					},
				}),
			).toMatchObject({ ok: true });
			store.bindWorktreeOnce(
				"exec-1",
				{ path: repo, branch: "feature", generation: "founder-review-test" },
				{ issueId: "issue-1", projectName: "geoforge3d" },
			);
			testProjects[0]!.projectRoot = repo;
			process.env.FLYWHEEL_COMM_DIR = commRoot;

			const complete = (eventId: string) =>
				fetch(`${baseUrl}/events`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: "Bearer ingest-secret",
					},
					body: JSON.stringify(
						makeEvent({
							event_id: eventId,
							event_type: "session_completed",
							source: "flywheel-comm",
							payload: { decision: { route: "needs_review" } },
						}),
					),
				});
			const forged = await complete("founder-review-bypass");
			expect(forged.status).toBe(409);
			expect(await forged.json()).toMatchObject({
				error: "founder_review_required",
				reason: "missing",
			});
			expect(
				store.getWorkflowNodeCompletion("run-exec-1", "produce", 1),
			).toBeUndefined();

			const paths = ["product/doc/FLY-1758/prd.html"];
			const artifactDigest = computeFounderArtifactDigest(
				inspectFounderReviewArtifactsAtCommit({ repoRoot: repo, head, paths }),
			);
			const commDbPath = commDbPathForProject("geoforge3d");
			const commDb = new CommDB(commDbPath);
			try {
				const questionId = commDb.insertQuestion(
					"exec-1",
					"product-lead",
					createFounderReviewQuestionContent({
						round: 1,
						evidence: {
							runId: "run-exec-1",
							founderId: "123456789012345678",
							hostedUrl: "https://reports.example/FLY-1758/prd",
							artifacts: inspectFounderReviewArtifactsAtCommit({
								repoRoot: repo,
								head,
								paths,
							}),
						},
					}),
					{ checkpoint: "founder_review" },
				);
				store.bindFounderReviewCard({
					questionId,
					messageId: "founder-card-1",
					runId: "run-exec-1",
					artifactDigest,
					createdAt: "2026-08-14T00:10:00.000Z",
				});
				expect(
					commDb.insertFounderReviewResponseIfGateOpen({
						questionId,
						fromAgent: "bridge",
						founderId: undefined,
						expectedOwner: "exec-1",
						passed: true,
					}),
				).toBe(true);
			} finally {
				commDb.close();
			}

			const accepted = await complete("founder-review-pass");
			expect(accepted.status).toBe(200);
			expect(await accepted.json()).toMatchObject({
				ok: true,
				generalized: true,
			});
		} finally {
			testProjects[0]!.projectRoot = originalProjectRoot;
			if (originalCommDir === undefined) delete process.env.FLYWHEEL_COMM_DIR;
			else process.env.FLYWHEEL_COMM_DIR = originalCommDir;
			rmSync(repo, { recursive: true, force: true });
			rmSync(commRoot, { recursive: true, force: true });
		}
	});

	it("books re-entry completion against the explicit activation and TURN epoch", async () => {
		bindGeneralizedExecution(store, "exec-1");
		expect(
			store.commitEnrolledCompletion({
				executionId: "exec-1",
				route: "needs_review",
				sourceEventId: "attempt-1-complete",
				completionSubmission: { decision: { route: "needs_review" }, round: 1 },
			}),
		).toMatchObject({ ok: true });
		store.upsertWorkflowRunNode({
			runId: "run-exec-1",
			nodeId: "execute",
			attempt: 2,
			state: "pending",
			executionId: "exec-1",
		});
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-exec-1",
				nodeId: "execute",
				executionId: "exec-1",
				attempt: 2,
				activationId: "activation-2",
				activationMode: "wake",
				reworkRequestId: "request-1",
				now: "2026-07-15T00:02:00.000Z",
				expiresAt: "2026-07-15T00:05:00.000Z",
				absoluteDeadlineAt: "2026-07-15T01:00:00.000Z",
				env: {
					FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
					FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
					FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
					FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
				},
			}),
		).toMatchObject({ ok: true });
		expect(
			store.recordWorkflowActivationTurn({
				activationId: "activation-2",
				executionId: "exec-1",
				issueId: "issue-1",
				epoch: 2,
				sourceEventId: "turn:activation-2:epoch-2",
				grantedAt: "2026-07-15T00:02:00.000Z",
			}),
		).toMatchObject({ ok: true });

		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_id: "explicit-complete-attempt-2",
					event_type: "session_completed",
					source: "flywheel-comm",
					payload: {
						decision: { route: "needs_review" },
						round: 2,
						workflowActivation: {
							activationId: "activation-2",
							runId: "run-exec-1",
							nodeId: "execute",
							attempt: 2,
							turnEpoch: 2,
						},
					},
				}),
			),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			ok: true,
			generalized: true,
			duplicate: false,
		});
		expect(
			store.getWorkflowNodeCompletion("run-exec-1", "execute", 2),
		).toMatchObject({
			activation_id: "activation-2",
			execution_id: "exec-1",
		});
	});

	// PR #748 release condition: generic gained implement's capabilities, so its
	// completion_route is now "needs_review". A generic node that finishes WITHOUT
	// producing a PR (pure research, a question answered, local-only edits) must
	// NOT park in awaiting_review waiting for an approval that can never come —
	// that is a zombie: it looks exactly like a real pending item, nags nobody,
	// and so nobody notices it. A false positive (an empty ship card) is louder
	// and safer than a false negative (a silent zombie).
	it("PR #748: a generic completion with NO PR evidence reaches a terminal state, never a zombie awaiting_review", async () => {
		bindGeneralizedExecution(store, "exec-1");
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_id: "generic-complete-no-pr",
					event_type: "session_completed",
					source: "flywheel-comm",
					payload: {
						decision: { route: "needs_review" },
						// No `evidence.landingStatus`, no PR number: nothing to ship.
						evidence: { commitMessages: [] },
						summary: "Investigated the question; no code change needed.",
					},
				}),
			),
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		expect(session?.status).not.toBe("awaiting_review");
		expect(["completed", "blocked"]).toContain(session?.status);
	});

	it("settles a stale generalized completion after the node execution was replaced", async () => {
		bindGeneralizedExecution(store, "exec-1");
		store.upsertWorkflowRunNode({
			runId: "run-exec-1",
			nodeId: "execute",
			attempt: 1,
			state: "pending",
			executionId: "exec-retry",
		});
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_id: "stale-completion-1",
					event_type: "session_completed",
					source: "flywheel-comm",
					payload: { decision: { route: "needs_review" } },
				}),
			),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			ok: true,
			generalized: true,
			settled: "stale_execution_superseded",
		});
		expect(
			store.getWorkflowNodeCompletion("run-exec-1", "execute", 1),
		).toBeUndefined();
	});

	it("settles and escalates a changed terminal resubmission after a newer attempt exists", async () => {
		bindGeneralizedExecution(store, "exec-1");
		const originalActivation =
			store.listWorkflowActivationsForActor("exec-1")[0];
		expect(originalActivation).toBeDefined();
		expect(
			store.recordWorkflowActivationTurn({
				activationId: originalActivation!.activation_id,
				executionId: "exec-1",
				issueId: "issue-1",
				epoch: 1,
				sourceEventId: "turn:terminal-stale:epoch-1",
				grantedAt: "2026-07-15T00:00:30.000Z",
			}),
		).toEqual({ ok: true, idempotentReplay: false });
		const postCompletion = (eventId: string, changed: boolean) =>
			fetch(`${baseUrl}/events`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer ingest-secret",
				},
				body: JSON.stringify(
					makeEvent({
						event_id: eventId,
						event_type: "session_completed",
						source: "flywheel-comm",
						payload: {
							decision: { route: "needs_review" },
							evidence: changed
								? { commitMessages: ["fix after QA feedback"] }
								: { commitMessages: ["initial completion"] },
							...(changed
								? {
										workflowActivation: {
											activationId: originalActivation!.activation_id,
											runId: "run-exec-1",
											nodeId: "execute",
											attempt: 1,
											turnEpoch: 1,
										},
									}
								: {}),
						},
					}),
				),
			});
		expect((await postCompletion("terminal-original", false)).status).toBe(200);
		store.upsertWorkflowRunNode({
			runId: "run-exec-1",
			nodeId: "execute",
			attempt: 2,
			state: "pending",
			executionId: "exec-2",
		});

		const response = await postCompletion("terminal-stale-fix", true);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			generalized: true,
			settled: "stale_resubmission_escalated",
		});
		expect(store.listWorkflowAlertOutbox()).toHaveLength(1);
		expect(
			store
				.listWorkflowRunEvents("run-exec-1")
				.filter((event) => event.kind === "stale_completion_resubmission"),
		).toHaveLength(1);
	});

	it("rejects design-node completion before lifecycle state advances when HTML evidence is missing", async () => {
		const started = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_id: "design-started",
					payload: {
						issueIdentifier: "GEO-95",
						sessionRole: "design",
					},
				}),
			),
		});
		expect(started.status).toBe(200);

		const completed = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_id: "design-complete-missing-html",
					event_type: "session_completed",
					source: "flywheel-comm",
					payload: { decision: { route: "phase_design_complete" } },
				}),
			),
		});
		expect(completed.status).toBe(409);
		expect(await completed.json()).toMatchObject({
			error: "design_html_evidence_missing",
		});
		expect(store.getSession("exec-1")?.status).toBe("running");
		expect(
			store
				.getEventsByExecution("exec-1")
				.some((event) => event.event_id === "design-complete-missing-html"),
		).toBe(false);
	});

	it("accepts attested design HTML and leaves non-design completion topology unaffected", async () => {
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_id: "design-started-valid",
					payload: {
						issueIdentifier: "GEO-95",
						sessionRole: "design",
					},
				}),
			),
		});
		const headSha = "0123456789abcdef0123456789abcdef01234567";
		const completed = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_id: "design-complete-valid-html",
					event_type: "session_completed",
					source: "flywheel-comm",
					payload: {
						decision: { route: "phase_design_complete" },
						evidence: { headSha },
						designHtmlEvidence: {
							version: 1,
							issueIdentifier: "GEO-95",
							paths: ["engineering/doc/GEO-95-design/founder.html"],
							headSha,
						},
					},
				}),
			),
		});
		expect(completed.status).toBe(200);
		expect(store.getSession("exec-1")?.status).toBe("design_done");
	});

	it("rejects a design HTML attestation bound to a different head before lifecycle state advances", async () => {
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_id: "design-started-head-mismatch",
					payload: {
						issueIdentifier: "GEO-95",
						sessionRole: "design",
					},
				}),
			),
		});
		const completed = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_id: "design-complete-head-mismatch",
					event_type: "session_completed",
					source: "flywheel-comm",
					payload: {
						decision: { route: "phase_design_complete" },
						evidence: { headSha: "a".repeat(40) },
						designHtmlEvidence: {
							version: 1,
							issueIdentifier: "GEO-95",
							paths: ["engineering/doc/GEO-95-design/founder.html"],
							headSha: "b".repeat(40),
						},
					},
				}),
			),
		});

		expect(completed.status).toBe(409);
		expect(await completed.json()).toMatchObject({
			error: "design_html_evidence_missing",
			reason: "attested head SHA does not match completion evidence",
		});
		expect(store.getSession("exec-1")?.status).toBe("running");
		expect(
			store
				.getEventsByExecution("exec-1")
				.some((event) => event.event_id === "design-complete-head-mismatch"),
		).toBe(false);
	});

	it("rejects enrolled DAG design completion before receipt, edge traversal, or successor effects", async () => {
		bindGeneralizedDesignExecution(store, "exec-1");
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_id: "dag-design-started",
					payload: {
						issueIdentifier: "GEO-95",
						sessionRole: "design",
					},
				}),
			),
		});
		const completed = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_id: "dag-design-complete-missing-html",
					event_type: "session_completed",
					source: "flywheel-comm",
					payload: { decision: { route: "phase_design_complete" } },
				}),
			),
		});
		expect(completed.status).toBe(409);
		expect(store.getWorkflowNodeCompletion("run-exec-1", "design", 1)).toBe(
			undefined,
		);
		expect(
			store
				.listWorkflowRunEvents("run-exec-1")
				.some((event) =>
					["node_completed", "edge_traversed"].includes(event.kind),
				),
		).toBe(false);
		expect(store.getSession("exec-1")?.status).toBe("running");
	});

	it("records generalized teardown without a receipt and settles the HTTP signal", async () => {
		bindGeneralizedExecution(store, "exec-1");
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_id: "teardown-complete-1",
					event_type: "session_completed",
					source: "direct-event-sink",
					payload: { decision: { route: "needs_review" } },
				}),
			),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			ok: true,
			generalized: true,
			teardown: "held_recorded",
		});
		expect(store.getSession("exec-1")).toMatchObject({
			status: "completed",
			workflow_node_id: "execute",
		});
		expect(
			store
				.getEventsByExecution("exec-1")
				.some((event) => event.event_id === "teardown-complete-1"),
		).toBe(true);
		expect(
			store
				.listWorkflowRunEvents("run-exec-1")
				.filter((event) => event.kind === "generalized_teardown_recorded"),
		).toHaveLength(1);
	});

	it("alerts a typed generalized worktree takeover refusal before settling the HTTP signal", async () => {
		bindGeneralizedExecution(store, "exec-1");
		const alertWorktreeTakeoverFailure = vi.fn(async () => {});
		turnBeltReconciler.current = {
			alertWorktreeTakeoverFailure,
		} as unknown as TurnBeltReconciler;

		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_id: "takeover-failed-1",
					event_type: "session_failed",
					payload: {
						error: "worktree takeover refused",
						failure: {
							failureKind: "worktree_takeover_failed",
							failureReason: "worktree_takeover_failed: dirty",
						},
					},
				}),
			),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			ok: true,
			generalized: true,
			teardown: "held_recorded",
		});
		expect(alertWorktreeTakeoverFailure).toHaveBeenCalledWith(
			expect.objectContaining({ execution_id: "exec-1" }),
			"worktree_takeover_failed: dirty",
		);
	});

	// FLY-728: the loopback /events session_started handler persists the resolved
	// runner model as runner_model (mirrors the DirectEventSink production path).
	it("POST /events session_started persists payload.runnerModel as runner_model", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					payload: {
						issueIdentifier: "GEO-95",
						issueTitle: "Test issue",
						runnerModel: "claude-fable-5",
					},
				}),
			),
		});
		expect(res.status).toBe(200);
		expect(store.getSession("exec-1")!.runner_model).toBe("claude-fable-5");
	});

	it("POST /events session_started without runnerModel leaves runner_model unset", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeEvent()),
		});
		expect(res.status).toBe(200);
		expect(store.getSession("exec-1")!.runner_model ?? null).toBeNull();
	});

	it("FLY-1259: raw-upsert started events persist and lock designBackend", async () => {
		const postStarted = (eventId: string, designBackend: string) =>
			fetch(`${baseUrl}/events`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer ingest-secret",
				},
				body: JSON.stringify(
					makeEvent({
						event_id: eventId,
						payload: {
							issueIdentifier: "GEO-95",
							sessionRole: "design",
							chatThreadRole: "design",
							designBackend,
						},
					}),
				),
			});

		expect((await postStarted("evt-design-1", "claude")).status).toBe(200);
		expect((await postStarted("evt-design-2", "codex")).status).toBe(200);
		expect(store.getSession("exec-1")?.design_backend).toBe("claude");
	});

	it("FLY-1259: invalid started-event designBackend is ignored", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					payload: {
						issueIdentifier: "GEO-95",
						designBackend: "fable",
					},
				}),
			),
		});

		expect(res.status).toBe(200);
		expect(store.getSession("exec-1")?.design_backend).toBeUndefined();
	});

	it("FLY-1356: started events persist skill_framework_mode/_via behind closed-enum guards", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					payload: {
						issueIdentifier: "GEO-95",
						skillFrameworkMode: "bare",
						skillFrameworkModeVia: "hash",
					},
				}),
			),
		});
		expect(res.status).toBe(200);
		const session = store.getSession("exec-1")!;
		expect(session.skill_framework_mode).toBe("bare");
		expect(session.skill_framework_mode_via).toBe("hash");
	});

	it("FLY-1609: started events persist D attribution with effective on:arm", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					payload: {
						issueIdentifier: "GEO-95",
						skillFrameworkMode: "bare-ponytail",
						skillFrameworkModeVia: "hash",
						ponytailCondition: "on:arm",
					},
				}),
			),
		});
		expect(res.status).toBe(200);
		const session = store.getSession("exec-1")!;
		expect(session.skill_framework_mode).toBe("bare-ponytail");
		expect(session.skill_framework_mode_via).toBe("hash");
		expect(session.ponytail_condition).toBe("on:arm");
	});

	it("FLY-1356 (R1#7): garbage skill-framework values on the untrusted wire are REJECTED", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					payload: {
						issueIdentifier: "GEO-95",
						skillFrameworkMode: "rm -rf /",
						skillFrameworkModeVia: "made-up",
					},
				}),
			),
		});
		expect(res.status).toBe(200);
		const session = store.getSession("exec-1")!;
		expect(session.skill_framework_mode).toBeUndefined();
		expect(session.skill_framework_mode_via ?? undefined).toBeUndefined();
	});

	it("POST /events with session_completed (needs_review) sets awaiting_review", async () => {
		// First create session
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeEvent()),
		});

		// Then complete it
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_id: "evt-completed",
					event_type: "session_completed",
					payload: {
						decision: { route: "needs_review", reasoning: "has changes" },
						evidence: {
							commitCount: 3,
							filesChangedCount: 6,
							linesAdded: 120,
							linesRemoved: 45,
						},
						summary: "Refactored auth",
					},
				}),
			),
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		expect(session!.status).toBe("awaiting_review");
		expect(session!.commit_count).toBe(3);
	});

	it("POST /events with session_failed records error", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_type: "session_failed",
					payload: { error: "deployment timeout" },
				}),
			),
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		expect(session!.status).toBe("failed");
		expect(session!.last_error).toBe("deployment timeout");
	});

	it("FLY-1279: HTTP session_failed persists goal_blocked as blocked with its real reason", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_type: "session_failed",
					payload: {
						error: "legacy error",
						failure: {
							failureKind: "goal_blocked",
							failureReason: "goal ended non-complete: blocked",
						},
					},
				}),
			),
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		expect(session?.status).toBe("blocked");
		expect(session?.last_error).toBe("goal ended non-complete: blocked");
	});

	it("POST /events with duplicate event_id returns ok + duplicate", async () => {
		const event = makeEvent({ event_id: "dup-1" });

		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(event),
		});

		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(event),
		});
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.duplicate).toBe(true);
	});

	it("POST /events with missing fields returns 400", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify({ event_id: "e1" }),
		});
		expect(res.status).toBe(400);
	});

	it("POST /events with invalid auth returns 401", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer wrong-token",
			},
			body: JSON.stringify(makeEvent()),
		});
		expect(res.status).toBe(401);
	});

	it("POST /events with auto_approve + landingStatus merged → completed (FLY-58)", async () => {
		attachGitHeadAuthority(store);
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_type: "session_completed",
					payload: {
						decision: { route: "auto_approve" },
						evidence: {
							commitCount: 2,
							landingStatus: { status: "merged", mergedAt: "2025-01-01" },
						},
					},
				}),
			),
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		// FLY-58: auto_approve + already merged → completed (not approved)
		expect(session!.status).toBe("completed");
		expect(session!.decision_route).toBe("auto_approve");
	});

	it("POST /events with auto_approve + non-merged → awaiting_review (policy)", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_type: "session_completed",
					payload: {
						decision: { route: "auto_approve" },
						evidence: { commitCount: 1 },
					},
				}),
			),
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		// Policy: no auto-merge — awaiting CEO approval
		expect(session!.status).toBe("awaiting_review");
		expect(session!.decision_route).toBe("auto_approve");
	});

	// FLY-163: forum thread inheritance tests removed — conversation_threads
	// table dropped, session.thread_id TS field removed.
});

/** Helper: create a mock RuntimeRegistry for testProjects. */
function createMockRegistry() {
	const envelopes: LeadEventEnvelope[] = [];
	const mockRuntime = {
		type: "commdb" as const,
		deliver: vi.fn(async (env: LeadEventEnvelope) => {
			envelopes.push(env);
			return { delivered: true };
		}),
		sendBootstrap: vi.fn(async () => {}),
		health: vi.fn(async () => ({
			status: "healthy" as const,
			lastDeliveryAt: null,
			lastDeliveredSeq: 0,
		})),
		shutdown: vi.fn(async () => {}),
	};
	const registry = new RuntimeRegistry();
	for (const project of testProjects) {
		for (const lead of project.leads) {
			registry.register(lead, mockRuntime);
		}
	}
	return { registry, mockRuntime, envelopes };
}

describe("Event route — structured hook payload", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let capturedEnvelopes: LeadEventEnvelope[];

	beforeEach(async () => {
		const mock = createMockRegistry();
		capturedEnvelopes = mock.envelopes;

		store = await StateStore.create(":memory:");
		const config = makeConfig();
		const app = createBridgeApp(
			store,
			testProjects,
			config,
			undefined, // broadcaster
			undefined, // transitionOpts
			undefined, // retryDispatcher
			undefined, // cipherWriter
			undefined, // eventFilter
			undefined, // forumTagUpdater
			mock.registry,
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
		// FLY-827: these tests predate the Codex hard gate and verify notification /
		// lifecycle behavior orthogonal to codex. Run gate-OFF (byte-compat) so an
		// awaiting_review completion isn't held by the new codex/isReviewHeld branch.
		process.env.FLYWHEEL_CODEX_HARD_GATE = "0";
		// FLY-869: bypass the new merge/QA ship gates — these tests exercise the FSM
		// mapping, not the approval gate (covered by ship-eligibility + new integration tests).
		process.env.FLYWHEEL_MERGE_APPROVAL_GATE = "0";
		process.env.FLYWHEEL_QA_DONE_GATE = "0";
		// FLY-1385: keep this legacy FSM suite independent of the host rollout.
		process.env.FLYWHEEL_WORKFLOW_CLAIMS_READ = "0";
	});

	afterEach(async () => {
		delete process.env.FLYWHEEL_CODEX_HARD_GATE;
		delete process.env.FLYWHEEL_MERGE_APPROVAL_GATE;
		delete process.env.FLYWHEEL_QA_DONE_GATE;
		delete process.env.FLYWHEEL_WORKFLOW_CLAIMS_READ;
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
	});

	it("sends structured JSON payload with sessionKey", async () => {
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeEvent()),
		});

		// Wait briefly for async notification
		await new Promise((r) => setTimeout(r, 100));

		expect(capturedEnvelopes.length).toBeGreaterThanOrEqual(1);
		const env = capturedEnvelopes[0]!;
		expect(env.leadId).toBe("product-lead");
		expect(env.sessionKey).toBe("flywheel:GEO-95");

		expect(env.event.event_type).toBe("session_started");
		expect(env.event.execution_id).toBe("exec-1");
		expect(env.event.issue_identifier).toBe("GEO-95");
		// FLY-163: forum_channel field removed from HookPayload
	});

	it("FLY-1259: sends the persisted effective design backend to the Lead", async () => {
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					payload: {
						issueIdentifier: "GEO-95",
						sessionRole: "design",
						chatThreadRole: "design",
						designBackend: "codex",
					},
				}),
			),
		});

		await new Promise((r) => setTimeout(r, 100));

		expect(capturedEnvelopes[0]?.event).toMatchObject({
			event_type: "session_started",
			session_role: "design",
			design_backend: "codex",
		});
	});

	// FLY-163: thread_id payload inheritance test removed.
});

describe("formatNotification", () => {
	const baseSession: Session = {
		execution_id: "e1",
		issue_id: "i1",
		project_name: "p",
		status: "awaiting_review",
		issue_identifier: "GEO-95",
		issue_title: "Refactor auth",
		commit_count: 3,
		lines_added: 120,
		lines_removed: 45,
		decision_route: "needs_review",
		decision_reasoning: "has changes",
	};

	it("needs_review notification", () => {
		const msg = formatNotification(baseSession, "session_completed");
		expect(msg).toContain("[Review Required]");
		expect(msg).toContain("GEO-95");
		expect(msg).toContain("3 commits");
	});

	it("auto_approve notification (already merged / backward compat)", () => {
		const msg = formatNotification(
			{ ...baseSession, decision_route: "auto_approve", status: "approved" },
			"session_completed",
		);
		expect(msg).toContain("[Already Merged]");
	});

	it("auto_approve notification (awaiting review / policy)", () => {
		const msg = formatNotification(
			{
				...baseSession,
				decision_route: "auto_approve",
				status: "awaiting_review",
			},
			"session_completed",
		);
		expect(msg).toContain("[Review Required]");
		expect(msg).toContain("CEO approval");
	});

	it("blocked notification", () => {
		const msg = formatNotification(
			{ ...baseSession, decision_route: "blocked" },
			"session_completed",
		);
		expect(msg).toContain("[Blocked]");
	});

	it("failed notification", () => {
		const msg = formatNotification(
			{ ...baseSession, last_error: "timeout" },
			"session_failed",
		);
		expect(msg).toContain("[Failed]");
		expect(msg).toContain("timeout");
	});

	it("started notification", () => {
		const msg = formatNotification(baseSession, "session_started");
		expect(msg).toContain("[Started]");
	});
});

describe("Event route — EventFilter integration", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let capturedEnvelopes: LeadEventEnvelope[];
	// FLY-163: tagMap fixture removed — forum tag mapping path deleted.

	beforeEach(async () => {
		const mock = createMockRegistry();
		capturedEnvelopes = mock.envelopes;

		store = await StateStore.create(":memory:");
		const config = makeConfig({
			discordBotToken: "bot-token",
		});
		const eventFilter = new EventFilter();
		const app = createBridgeApp(
			store,
			testProjects,
			config,
			undefined, // broadcaster
			undefined, // transitionOpts
			undefined, // retryDispatcher
			undefined, // cipherWriter
			eventFilter,
			undefined, // _unusedForumTagUpdater (FLY-163)
			mock.registry,
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
		// FLY-827: these tests predate the Codex hard gate and verify notification /
		// lifecycle behavior orthogonal to codex. Run gate-OFF (byte-compat) so an
		// awaiting_review completion isn't held by the new codex/isReviewHeld branch.
		process.env.FLYWHEEL_CODEX_HARD_GATE = "0";
		// FLY-869: bypass the new merge/QA ship gates — these tests exercise the FSM
		// mapping, not the approval gate (covered by ship-eligibility + new integration tests).
		process.env.FLYWHEEL_MERGE_APPROVAL_GATE = "0";
		process.env.FLYWHEEL_QA_DONE_GATE = "0";
		process.env.FLYWHEEL_WORKFLOW_CLAIMS_READ = "0";
	});

	afterEach(async () => {
		delete process.env.FLYWHEEL_CODEX_HARD_GATE;
		delete process.env.FLYWHEEL_MERGE_APPROVAL_GATE;
		delete process.env.FLYWHEEL_QA_DONE_GATE;
		delete process.env.FLYWHEEL_WORKFLOW_CLAIMS_READ;
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
	});

	async function postEvent(overrides: Record<string, unknown> = {}) {
		return fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeEvent(overrides)),
		});
	}

	it("session_completed + needs_review → runtime.deliver called (high priority)", async () => {
		// Start session first
		await postEvent();
		const head = "a".repeat(40);
		store.patchSessionMetadata("exec-1", {
			pr_head_sha: head,
			pr_number: 42,
		});
		store.putShipRelevantDiffSnapshot({
			execution_id: "exec-1",
			pr_head_sha: head,
			repo: "xrliAnnie/GeoForge3D",
			pr_number: 42,
			base_ref: "main",
			base_oid: "b".repeat(40),
			classifier_version: 1,
			ship_relevant: 0,
			file_count: 1,
			sample_paths: ["engineering/doc/GEO-95/plan.md"],
		});
		// Complete with needs_review
		await postEvent({
			event_id: "evt-c1",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review", reasoning: "has changes" },
				evidence: {
					commitCount: 1,
					headSha: head,
					landingStatus: { status: "open", prNumber: 42 },
				},
				summary: "did stuff",
			},
		});
		await new Promise((r) => setTimeout(r, 150));

		// Should have 2 notifications: session_started (no thread → notify) + session_completed
		expect(capturedEnvelopes.length).toBe(2);
		const completedPayload = capturedEnvelopes[1]!.event;
		expect(completedPayload.filter_priority).toBe("high");
		expect(completedPayload.notification_context).toContain("Chat");
	});

	it("session_started → runtime.deliver called (FLY-163: chat-only Chat announcement)", async () => {
		await postEvent();
		await new Promise((r) => setTimeout(r, 150));

		expect(capturedEnvelopes.length).toBe(1);
		expect(capturedEnvelopes[0]!.event.filter_priority).toBe("high");
		expect(capturedEnvelopes[0]!.event.notification_context).toContain("Chat");
	});

	it("session_failed → runtime.deliver called (high priority)", async () => {
		await postEvent({
			event_type: "session_failed",
			payload: { error: "timeout" },
		});
		await new Promise((r) => setTimeout(r, 150));

		expect(capturedEnvelopes.length).toBe(1);
		expect(capturedEnvelopes[0]!.event.filter_priority).toBe("high");
	});

	// FLY-163: "enriched payload includes forum_tag_update_result" test removed.
});

// FLY-163: PM lead tests (formerly "no-forum lead", GEO-275)
describe("Event route — PM lead routed via chat_channel (FLY-163)", () => {
	const noForumProjects: ProjectEntry[] = [
		{
			projectName: "geoforge3d",
			projectRoot: "/tmp/geoforge3d",
			projectRepo: "xrliAnnie/GeoForge3D",
			leads: [
				{
					agentId: "pm-lead",
					chatChannel: "core-channel",
					match: { labels: ["PM"] },
					canSpawnRunners: false,
				},
			],
		},
	];

	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let capturedEnvelopes: LeadEventEnvelope[];

	beforeEach(async () => {
		capturedEnvelopes = [];
		const mockRuntime = {
			type: "commdb" as const,
			deliver: vi.fn(async (env: LeadEventEnvelope) => {
				capturedEnvelopes.push(env);
				return { delivered: true };
			}),
			sendBootstrap: vi.fn(async () => {}),
			health: vi.fn(async () => ({
				status: "healthy" as const,
				lastDeliveryAt: null,
				lastDeliveredSeq: 0,
			})),
			shutdown: vi.fn(async () => {}),
		};
		const registry = new RuntimeRegistry();
		for (const project of noForumProjects) {
			for (const lead of project.leads) {
				registry.register(lead, mockRuntime);
			}
		}

		store = await StateStore.create(":memory:");
		const config = makeConfig({ discordBotToken: "bot-token" });
		const eventFilter = new EventFilter();
		const app = createBridgeApp(
			store,
			noForumProjects,
			config,
			undefined, // broadcaster
			undefined, // transitionOpts
			undefined, // retryDispatcher
			undefined, // cipherWriter
			eventFilter,
			undefined, // _unusedForumTagUpdater (FLY-163)
			registry,
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
		// FLY-827: these tests predate the Codex hard gate and verify notification /
		// lifecycle behavior orthogonal to codex. Run gate-OFF (byte-compat) so an
		// awaiting_review completion isn't held by the new codex/isReviewHeld branch.
		process.env.FLYWHEEL_CODEX_HARD_GATE = "0";
		// FLY-869: bypass the new merge/QA ship gates — these tests exercise the FSM
		// mapping, not the approval gate (covered by ship-eligibility + new integration tests).
		process.env.FLYWHEEL_MERGE_APPROVAL_GATE = "0";
		process.env.FLYWHEEL_QA_DONE_GATE = "0";
	});

	afterEach(async () => {
		delete process.env.FLYWHEEL_CODEX_HARD_GATE;
		delete process.env.FLYWHEEL_MERGE_APPROVAL_GATE;
		delete process.env.FLYWHEEL_QA_DONE_GATE;
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
	});

	it("session_started event delivers to runtime for PM lead via chat_channel", async () => {
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify({
				event_id: "evt-nf-1",
				execution_id: "exec-nf",
				issue_id: "issue-nf",
				issue_identifier: "GEO-300",
				project_name: "geoforge3d",
				event_type: "session_started",
				payload: {
					issueIdentifier: "GEO-300",
					issueTitle: "PM triage task",
					issueLabels: ["PM"],
				},
			}),
		});
		await new Promise((r) => setTimeout(r, 150));

		// Event should still be delivered (not skipped)
		expect(capturedEnvelopes.length).toBeGreaterThanOrEqual(1);
		const payload = capturedEnvelopes[0]!.event;
		expect(payload.event_type).toBe("session_started");
		// FLY-163: forum_channel field removed; chat_channel routes notification.
		expect(payload.chat_channel).toBe("core-channel");
	});
});

// FLY-163: GEO-200 thread validation describe removed — forum thread concept gone.

// GEO-292: session_stage + pr_number tracking
describe("Event route — GEO-292 stage tracking", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let a5CommRoot: string; // FLY-1329 (A5): isolated CommDB declared-state root

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		const config = makeConfig();
		// FLY-1329 (A5): isolate the CommDB declared-state root so the FLY-324 live
		// handler's parked-veto read never touches ~/.flywheel/comm in tests.
		a5CommRoot = mkdtempSync(join(tmpdir(), "fly1329-a5-comm-"));
		process.env.FLYWHEEL_COMM_DIR = a5CommRoot;
		// FLY-60 W2: pass transitionOpts so stage_changed=completed can fire
		// the canonical applyTransition path. Without it, the W2 branch's
		// defensive code refuses finalization (matches plugin.ts production).
		const fsm = new WorkflowFSM(WORKFLOW_TRANSITIONS);
		const executor = new DirectiveExecutor(store);
		const transitionOpts: ApplyTransitionOpts = { store, fsm, executor };
		const app = createBridgeApp(
			store,
			testProjects,
			config,
			undefined, // broadcaster
			transitionOpts,
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
		// FLY-827: these tests predate the Codex hard gate and verify notification /
		// lifecycle behavior orthogonal to codex. Run gate-OFF (byte-compat) so an
		// awaiting_review completion isn't held by the new codex/isReviewHeld branch.
		process.env.FLYWHEEL_CODEX_HARD_GATE = "0";
		// FLY-869: bypass the new merge/QA ship gates — these tests exercise the FSM
		// mapping, not the approval gate (covered by ship-eligibility + new integration tests).
		process.env.FLYWHEEL_MERGE_APPROVAL_GATE = "0";
		process.env.FLYWHEEL_QA_DONE_GATE = "0";
		process.env.FLYWHEEL_WORKFLOW_CLAIMS_READ = "0";
	});

	afterEach(async () => {
		delete process.env.FLYWHEEL_CODEX_HARD_GATE;
		delete process.env.FLYWHEEL_MERGE_APPROVAL_GATE;
		delete process.env.FLYWHEEL_QA_DONE_GATE;
		delete process.env.FLYWHEEL_WORKFLOW_CLAIMS_READ;
		delete process.env.FLYWHEEL_COMM_DIR;
		if (a5CommRoot) rmSync(a5CommRoot, { recursive: true, force: true });
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
	});

	async function postEvent(overrides: Record<string, unknown> = {}) {
		return fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeEvent(overrides)),
		});
	}

	it("session_started sets session_stage='started'", async () => {
		const res = await postEvent();
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		expect(session!.session_stage).toBe("started");
		expect(session!.stage_updated_at).toBeDefined();
		// SQLite datetime format
		expect(session!.stage_updated_at).toMatch(
			/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/,
		);
	});

	it("FLY-1259: transition-wired started events persist and lock designBackend", async () => {
		const first = await postEvent({
			event_id: "evt-transition-design-1",
			payload: {
				issueIdentifier: "GEO-95",
				sessionRole: "design",
				chatThreadRole: "design",
				designBackend: "codex",
			},
		});
		expect(first.status).toBe(200);
		expect(store.getSession("exec-1")?.design_backend).toBe("codex");

		// Re-enter the valid pending → running edge so the opposite replay reaches
		// persistTransition instead of being rejected as a running → running no-op.
		store.forceStatus("exec-1", "pending", "2026-07-14 18:00:00");
		const replay = await postEvent({
			event_id: "evt-transition-design-2",
			payload: {
				issueIdentifier: "GEO-95",
				sessionRole: "design",
				chatThreadRole: "design",
				designBackend: "claude",
			},
		});
		expect(replay.status).toBe(200);
		expect(store.getSession("exec-1")?.design_backend).toBe("codex");
	});

	it("stage_changed with valid stage sets session_stage", async () => {
		// Create session first
		await postEvent();

		const res = await postEvent({
			event_id: "evt-stage-1",
			event_type: "stage_changed",
			payload: { stage: "implement" },
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		expect(session!.session_stage).toBe("implement");
	});

	it("stage_changed with invalid stage is ignored", async () => {
		// Create session first
		await postEvent();

		const res = await postEvent({
			event_id: "evt-stage-invalid",
			event_type: "stage_changed",
			payload: { stage: "nonexistent_stage" },
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		// Should still be "started" from session_started
		expect(session!.session_stage).toBe("started");
	});

	it("stage_changed updates stage_updated_at", async () => {
		await postEvent();

		const beforeSession = store.getSession("exec-1");
		const _beforeTimestamp = beforeSession!.stage_updated_at;

		// Small delay to ensure different timestamp
		await new Promise((r) => setTimeout(r, 50));

		await postEvent({
			event_id: "evt-stage-time",
			event_type: "stage_changed",
			payload: { stage: "plan" },
		});

		const afterSession = store.getSession("exec-1");
		expect(afterSession!.stage_updated_at).toBeDefined();
		expect(afterSession!.session_stage).toBe("plan");
	});

	it("stage_changed allows stage regression (Runner can go backwards)", async () => {
		await postEvent();

		// Set to a later stage
		await postEvent({
			event_id: "evt-stage-forward",
			event_type: "stage_changed",
			payload: { stage: "code_review" },
		});
		expect(store.getSession("exec-1")!.session_stage).toBe("code_review");

		// Go backwards — stage_changed does NOT enforce ordering
		await postEvent({
			event_id: "evt-stage-backward",
			event_type: "stage_changed",
			payload: { stage: "brainstorm" },
		});
		expect(store.getSession("exec-1")!.session_stage).toBe("brainstorm");
	});

	// FLY-324: a no-PR / no-code / QA Runner that finishes via
	// `flywheel-comm stage set completed` only emits a stage_changed event.
	// Before FLY-324 that left the FSM stuck at `running` (close_runner rejects
	// it, tmux + worktree linger, idle detection false-positives session_stuck).
	// The stage_changed=completed handler now transitions running→completed.
	it("FLY-324: stage_changed=completed transitions a still-running session to completed", async () => {
		await postEvent(); // session_started → running

		const res = await postEvent({
			event_id: "evt-fly324-done",
			event_type: "stage_changed",
			payload: { stage: "completed" },
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		expect(session!.status).toBe("completed");
		expect(session!.session_stage).toBe("completed");
	});

	it("FLY-324: stage_changed=completed does NOT clobber an awaiting_review session", async () => {
		await postEvent(); // running

		// Dev Runner created a PR and requested review → awaiting_review.
		await postEvent({
			event_id: "evt-fly324-nr",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review" },
				evidence: { commitCount: 1 },
			},
		});
		expect(store.getSession("exec-1")!.status).toBe("awaiting_review");

		// A late stage_changed=completed (no merged landing) must NOT pull the
		// session back to completed — decision_route is set, so it is not a
		// done-but-running zombie. Guard: only status===running is swept.
		const res = await postEvent({
			event_id: "evt-fly324-late",
			event_type: "stage_changed",
			payload: { stage: "completed" },
		});
		expect(res.status).toBe(200);
		expect(store.getSession("exec-1")!.status).toBe("awaiting_review");
	});

	// FLY-1329 (A5, Codex R1 HIGH-3): the boot sweep's parked-veto must also guard
	// this LIVE running→completed path. A runner that declared itself parked is
	// asserting it is alive and waiting; a stage=completed report that contradicts
	// that must NOT force-complete it. The isolated CommDB (set in beforeEach)
	// carries the declaration.
	it("FLY-324 + FLY-1329 A5: stage_changed=completed does NOT force-complete a runner that declared itself parked", async () => {
		await postEvent(); // running

		const dbPath = commDbPathForProject("geoforge3d");
		mkdirSync(dirname(dbPath), { recursive: true });
		const declaredDb = new CommDB(dbPath);
		declaredDb.upsertDeclaredState(
			"exec-1",
			"parked",
			"DAG workflow implement parked awaiting QA",
			Date.now(),
			null, // no expiry
		);
		declaredDb.close();

		const res = await postEvent({
			event_id: "evt-a5-parked",
			event_type: "stage_changed",
			payload: { stage: "completed" },
		});
		expect(res.status).toBe(200);
		// Veto: the parked runner survives, NOT force-completed.
		expect(store.getSession("exec-1")!.status).toBe("running");
	});

	// Codex R2 HIGH: an UNREADABLE comm.db (exists but throws on read) is the
	// absence of evidence, not proof of "not parked". The live force-complete is
	// destructive, so it must FAIL CLOSED (veto), exactly like the boot sweep.
	it("FLY-1329 A5: a corrupt/unreadable comm.db fails CLOSED — the running row is NOT force-completed", async () => {
		await postEvent(); // running

		const dbPath = commDbPathForProject("geoforge3d");
		mkdirSync(dirname(dbPath), { recursive: true });
		// Garbage bytes: the file exists (so we do not early-return "not parked"),
		// but opening/reading it as SQLite throws.
		writeFileSync(dbPath, "this is not a sqlite database file at all");

		const res = await postEvent({
			event_id: "evt-a5-corrupt",
			event_type: "stage_changed",
			payload: { stage: "completed" },
		});
		expect(res.status).toBe(200);
		// Fail closed: unresolved parked state vetoes the destructive completion.
		expect(store.getSession("exec-1")!.status).toBe("running");
	});

	// Codex R2 HIGH: the veto must look up the AUTHORITATIVE session project, not
	// the event envelope's project_name. A mismatched event.project_name would look
	// up the wrong (absent) comm.db and silently miss the veto — force-completing a
	// parked runner. The declaration lives under the session's real project.
	it("FLY-1329 A5: the veto uses the session's project, not a mismatched event.project_name", async () => {
		await postEvent(); // running — session persisted under project geoforge3d

		const dbPath = commDbPathForProject("geoforge3d");
		mkdirSync(dirname(dbPath), { recursive: true });
		const declaredDb = new CommDB(dbPath);
		declaredDb.upsertDeclaredState(
			"exec-1",
			"parked",
			"parked under the real session project",
			Date.now(),
			null,
		);
		declaredDb.close();

		// The event carries a WRONG project_name. Pre-fix, the handler looked this
		// up (absent db → no veto → force-complete). Post-fix, it uses the resolved
		// session's project (geoforge3d) and finds the declaration.
		const res = await postEvent({
			event_id: "evt-a5-projmismatch",
			event_type: "stage_changed",
			project_name: "some-other-wrong-project",
			payload: { stage: "completed" },
		});
		expect(res.status).toBe(200);
		expect(store.getSession("exec-1")!.status).toBe("running");
	});

	// Design-review #3: a stage_changed=completed that carries a PR number in its
	// landing_status must NOT be force-completed (a PR exists → it owes review),
	// even if pr_number was not yet persisted and decision_route is unset.
	it("FLY-324: stage_changed=completed with a landing PR number is NOT swept to completed", async () => {
		await postEvent(); // running

		const res = await postEvent({
			event_id: "evt-fly324-haspr",
			event_type: "stage_changed",
			payload: {
				stage: "completed",
				landing_status: { status: "ready_to_merge", prNumber: 321 },
			},
		});
		expect(res.status).toBe(200);
		// Stays running — a PR session is not no-PR done; review path owns it.
		expect(store.getSession("exec-1")!.status).toBe("running");
	});

	// Design-review #2: stage_changed=completed before any session row exists is a
	// no-op (patchSessionMetadata is UPDATE-only; isDoneButRunning({}) is false),
	// so FLY-324 never fabricates a transition for a non-existent session.
	it("FLY-324: stage_changed=completed with no prior session row is a no-op", async () => {
		const res = await postEvent({
			execution_id: "exec-norow",
			event_id: "evt-fly324-norow",
			event_type: "stage_changed",
			payload: { stage: "completed" },
		});
		expect(res.status).toBe(200);
		expect(store.getSession("exec-norow")).toBeUndefined();
	});

	it("session_completed extracts pr_number from landingStatus.prNumber", async () => {
		await postEvent();

		const res = await postEvent({
			event_id: "evt-completed-pr",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review" },
				evidence: {
					commitCount: 5,
					landingStatus: { status: "open", prNumber: 42 },
				},
			},
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		expect(session!.pr_number).toBe(42);
	});

	it("session_completed without landingStatus has null pr_number", async () => {
		await postEvent();

		await postEvent({
			event_id: "evt-completed-no-ls",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review" },
				evidence: { commitCount: 1 },
			},
		});

		const session = store.getSession("exec-1");
		expect(session!.pr_number).toBeUndefined();
	});

	it("session_completed with merged status infers session_stage='ship'", async () => {
		await postEvent();

		await postEvent({
			event_id: "evt-completed-merged",
			event_type: "session_completed",
			payload: {
				decision: { route: "auto_approve" },
				evidence: {
					commitCount: 3,
					landingStatus: {
						status: "merged",
						prNumber: 100,
						mergedAt: "2026-03-30",
					},
				},
			},
		});

		const session = store.getSession("exec-1");
		expect(session!.session_stage).toBe("ship");
		expect(session!.pr_number).toBe(100);
	});

	it("session_completed with prNumber infers session_stage='pr_created'", async () => {
		await postEvent();

		await postEvent({
			event_id: "evt-completed-pr-created",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review" },
				evidence: {
					commitCount: 2,
					landingStatus: { status: "open", prNumber: 55 },
				},
			},
		});

		const session = store.getSession("exec-1");
		expect(session!.session_stage).toBe("pr_created");
	});

	it("session_completed auto-infer does NOT regress stage in legacy path (no FSM)", async () => {
		// Legacy path now uses STAGE_ORDER guard — same as FSM path.
		await postEvent();

		// Set stage to "ship" via stage_changed
		await postEvent({
			event_id: "evt-stage-ship",
			event_type: "stage_changed",
			payload: { stage: "ship" },
		});
		expect(store.getSession("exec-1")!.session_stage).toBe("ship");

		// session_completed with prNumber (open) infers "pr_created"
		// Legacy path guards with STAGE_ORDER — ship (9) > pr_created (8), so no regression
		await postEvent({
			event_id: "evt-completed-legacy",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review" },
				evidence: {
					commitCount: 1,
					landingStatus: { status: "open", prNumber: 77 },
				},
			},
		});

		const session = store.getSession("exec-1");
		// Legacy path: STAGE_ORDER prevents regression from ship to pr_created
		expect(session!.session_stage).toBe("ship");
		expect(session!.pr_number).toBe(77);
	});

	it("session_completed with merged doesn't regress from ship (merged infers ship)", async () => {
		await postEvent();

		// Set to ship via stage_changed
		await postEvent({
			event_id: "evt-stage-ship-2",
			event_type: "stage_changed",
			payload: { stage: "ship" },
		});

		// session_completed with merged also infers "ship" — no regression issue
		await postEvent({
			event_id: "evt-completed-merged-2",
			event_type: "session_completed",
			payload: {
				decision: { route: "auto_approve" },
				evidence: {
					commitCount: 1,
					landingStatus: {
						status: "merged",
						prNumber: 88,
						mergedAt: "2026-03-30",
					},
				},
			},
		});

		const session = store.getSession("exec-1");
		expect(session!.session_stage).toBe("ship");
		expect(session!.pr_number).toBe(88);
	});

	it("session_completed without prNumber does not overwrite existing stage", async () => {
		await postEvent();

		// Advance to code_review
		await postEvent({
			event_id: "evt-stage-cr",
			event_type: "stage_changed",
			payload: { stage: "code_review" },
		});
		expect(store.getSession("exec-1")!.session_stage).toBe("code_review");

		// session_completed without landingStatus/prNumber → no inferred stage
		// legacyStage is undefined → upsertSession COALESCE preserves existing
		await postEvent({
			event_id: "evt-completed-no-pr",
			event_type: "session_completed",
			payload: {
				decision: { route: "needs_review" },
				evidence: { commitCount: 1 },
			},
		});

		const session = store.getSession("exec-1");
		expect(session!.session_stage).toBe("code_review"); // preserved
		expect(session!.pr_number).toBeUndefined();
	});

	// FLY-60 W2: post-merge re-finalize from stage_changed=completed +
	// landing_status.status=merged. Run-#4-repair scope: requires prior
	// session_completed (with route=needs_review/auto_approve) to have
	// already written decision_route to StateStore. The stage_changed
	// event then carries fresh landing_status proving merge.
	describe("FLY-60 W2: stage_changed=completed + merge proof", () => {
		it("fires runPostShipFinalization + flips status when awaiting_review + decision_route present + landing_status.status=merged", async () => {
			// (1) session_started
			await postEvent();
			// (2) earlier session_completed with route=needs_review +
			//     landingStatus.status="ready_to_merge" → status=awaiting_review
			//     and decision_route=needs_review persisted
			await postEvent({
				event_id: "evt-pre-completed",
				event_type: "session_completed",
				payload: {
					decision: { route: "needs_review" },
					evidence: {
						commitCount: 1,
						landingStatus: { status: "ready_to_merge", prNumber: 9 },
					},
				},
			});
			expect(store.getSession("exec-1")!.status).toBe("awaiting_review");
			expect(store.getSession("exec-1")!.decision_route).toBe("needs_review");
			attachGitHeadAuthority(store);

			// (3) Runner rewrote land-status.json after PR merge and emits
			//     stage_changed=completed with landing_status proving merge.
			const res = await postEvent({
				event_id: "evt-stage-completed-merged",
				event_type: "stage_changed",
				payload: {
					stage: "completed",
					landing_status: {
						status: "merged",
						prNumber: 9,
						mergeCommitSha: "abc123",
					},
				},
			});
			expect(res.status).toBe(200);

			// W2 assertion: status flipped to completed via canonical FSM path
			const session = store.getSession("exec-1");
			expect(session!.status).toBe("completed");
			expect(session!.session_stage).toBe("completed");
			// pr_number was patched via sessionFields, not before transition
			expect(session!.pr_number).toBe(9);
		});

		it("no-op when stage_changed=completed has no landing_status (back-compat)", async () => {
			await postEvent();
			await postEvent({
				event_id: "evt-pre-completed",
				event_type: "session_completed",
				payload: {
					decision: { route: "needs_review" },
					evidence: {
						commitCount: 1,
						landingStatus: { status: "ready_to_merge", prNumber: 11 },
					},
				},
			});
			expect(store.getSession("exec-1")!.status).toBe("awaiting_review");

			await postEvent({
				event_id: "evt-stage-completed-no-ls",
				event_type: "stage_changed",
				payload: { stage: "completed" }, // no landing_status
			});

			// Status unchanged
			expect(store.getSession("exec-1")!.status).toBe("awaiting_review");
		});

		it("no-op when stage_changed=completed has landing_status.status != merged", async () => {
			await postEvent();
			await postEvent({
				event_id: "evt-pre-completed",
				event_type: "session_completed",
				payload: {
					decision: { route: "needs_review" },
					evidence: {
						commitCount: 1,
						landingStatus: { status: "ready_to_merge", prNumber: 12 },
					},
				},
			});
			expect(store.getSession("exec-1")!.status).toBe("awaiting_review");

			await postEvent({
				event_id: "evt-stage-completed-not-merged",
				event_type: "stage_changed",
				payload: {
					stage: "completed",
					landing_status: { status: "ready_to_merge", prNumber: 12 },
				},
			});

			expect(store.getSession("exec-1")!.status).toBe("awaiting_review");
		});

		// Negative-boundary regression test (codex R6 M1):
		//   running + merged + decision_route UNSET → predicate returns false,
		//   no FSM transition, no orchestrator fire. Tests that W2 fails-closed
		//   for the running-only-no-route case which is explicit out of scope
		//   (would need stage payload to carry route).
		it("no-op when running + merged + decision_route UNSET (boundary regression)", async () => {
			await postEvent(); // session_started → status=running, no decision_route yet

			expect(store.getSession("exec-1")!.status).toBe("running");
			expect(store.getSession("exec-1")!.decision_route).toBeUndefined();

			// stage_changed with merge proof BUT no prior session_completed
			// → predicate sees route=undefined → returns false → no W2 action
			await postEvent({
				event_id: "evt-stage-completed-no-route",
				event_type: "stage_changed",
				payload: {
					stage: "completed",
					landing_status: {
						status: "merged",
						prNumber: 50,
						mergeCommitSha: "deadbeef",
					},
				},
			});

			// Status stays running; W2 did NOT fire orchestrator.
			expect(store.getSession("exec-1")!.status).toBe("running");
			// session_stage still updated (stage tracking is informational)
			expect(store.getSession("exec-1")!.session_stage).toBe("completed");
		});

		// Idempotency: stage_changed=completed (W2 path) followed by a later
		// session_completed → both predicate-match, but
		// runPostShipFinalization atomically claims event_id, so cleanup
		// only runs once.
		it("idempotency: W2 then session_completed both fire predicate but cleanup only once", async () => {
			await postEvent();
			await postEvent({
				event_id: "evt-pre-completed",
				event_type: "session_completed",
				payload: {
					decision: { route: "needs_review" },
					evidence: {
						commitCount: 1,
						landingStatus: { status: "ready_to_merge", prNumber: 77 },
					},
				},
			});
			expect(store.getSession("exec-1")!.status).toBe("awaiting_review");
			attachGitHeadAuthority(store);

			// W2 fires (stage_changed=completed + merged) → status=completed
			const res1 = await postEvent({
				event_id: "evt-stage-completed-merged",
				event_type: "stage_changed",
				payload: {
					stage: "completed",
					landing_status: {
						status: "merged",
						prNumber: 77,
						mergeCommitSha: "feedface",
					},
				},
			});
			expect(res1.status).toBe(200);
			expect(store.getSession("exec-1")!.status).toBe("completed");

			// Later session_completed arrives (e.g., Blueprint emitTerminal
			// fired after Runner finally exited). Should be safe to apply
			// (FSM `completed` is terminal, transition is no-op or rejected).
			const res2 = await postEvent({
				event_id: "evt-late-session-completed",
				event_type: "session_completed",
				payload: {
					decision: { route: "needs_review" },
					evidence: {
						commitCount: 1,
						landingStatus: {
							status: "merged",
							prNumber: 77,
							mergeCommitSha: "feedface",
						},
					},
				},
			});
			expect(res2.status).toBe(200);
			expect(store.getSession("exec-1")!.status).toBe("completed");
		});
	});

	// FLY-137 Codex R3 #1: worktree_ready can race ahead of
	// session_started (started is fire-and-forget non-retrying;
	// worktree_ready is reliable+retried). Upserting the row as
	// `running` in worktree_ready would make the later
	// `session_started → running` FSM transition illegal
	// (`running → running` is not in WORKFLOW_TRANSITIONS) and the
	// started handler would skip labels/identifier/thread init.
	describe("FLY-137: worktree_ready before session_started", () => {
		it("upserts row as pending so session_started's FSM transition is legal", async () => {
			// 1) worktree_ready arrives first (no prior row).
			const lateExecId = "exec-race-wt-first";
			expect(store.getSession(lateExecId)).toBeUndefined();
			const r1 = await fetch(`${baseUrl}/events`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer ingest-secret",
				},
				body: JSON.stringify({
					event_id: "evt-wt-race-1",
					execution_id: lateExecId,
					issue_id: "issue-race",
					project_name: "geoforge3d",
					event_type: "worktree_ready",
					payload: { worktreePath: "/tmp/race-wt" },
				}),
			});
			expect(r1.status).toBe(200);

			const seeded = store.getSession(lateExecId);
			expect(seeded?.status).toBe("pending");
			expect(seeded?.worktree_path).toBe("/tmp/race-wt");

			// 2) session_started lands second — must succeed via
			//    `pending → running` (legal in WORKFLOW_TRANSITIONS).
			//    Labels + identifier + stage must populate.
			const r2 = await fetch(`${baseUrl}/events`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer ingest-secret",
				},
				body: JSON.stringify({
					event_id: "evt-started-race",
					execution_id: lateExecId,
					issue_id: "issue-race",
					project_name: "geoforge3d",
					event_type: "session_started",
					payload: {
						issueIdentifier: "GEO-RACE",
						issueTitle: "race",
						labels: ["Product", "backend"],
					},
				}),
			});
			expect(r2.status).toBe(200);

			const after = store.getSession(lateExecId);
			expect(after?.status).toBe("running");
			expect(after?.issue_identifier).toBe("GEO-RACE");
			expect(after?.issue_title).toBe("race");
			expect(after?.session_stage).toBe("started");
			// worktree_path preserved from the earlier upsert.
			expect(after?.worktree_path).toBe("/tmp/race-wt");
		});
	});
});

// GEO-202: issue_identifier must never be null in sessions
describe("Event route — issue_identifier fallback (GEO-202)", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		const config = makeConfig();
		const app = createBridgeApp(store, testProjects, config);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
		// FLY-827: these tests predate the Codex hard gate and verify notification /
		// lifecycle behavior orthogonal to codex. Run gate-OFF (byte-compat) so an
		// awaiting_review completion isn't held by the new codex/isReviewHeld branch.
		process.env.FLYWHEEL_CODEX_HARD_GATE = "0";
		// FLY-869: bypass the new merge/QA ship gates — these tests exercise the FSM
		// mapping, not the approval gate (covered by ship-eligibility + new integration tests).
		process.env.FLYWHEEL_MERGE_APPROVAL_GATE = "0";
		process.env.FLYWHEEL_QA_DONE_GATE = "0";
	});

	afterEach(async () => {
		delete process.env.FLYWHEEL_CODEX_HARD_GATE;
		delete process.env.FLYWHEEL_MERGE_APPROVAL_GATE;
		delete process.env.FLYWHEEL_QA_DONE_GATE;
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
	});

	it("session_started without issueIdentifier in payload falls back to issue_id", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					payload: { issueTitle: "Test issue" }, // no issueIdentifier
				}),
			),
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		expect(session).toBeDefined();
		expect(session!.issue_identifier).toBe("issue-1"); // fallback to issue_id
	});

	it("session_started with empty string issueIdentifier falls back to issue_id", async () => {
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					payload: { issueIdentifier: "", issueTitle: "Test issue" },
				}),
			),
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		expect(session).toBeDefined();
		expect(session!.issue_identifier).toBe("issue-1"); // fallback to issue_id
	});

	it("session_completed without prior session_started still gets identifier", async () => {
		// Simulate fire-and-forget session_started being lost
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_type: "session_completed",
					payload: {
						decision: { route: "needs_review" },
						evidence: { commitCount: 1 },
						// no issueIdentifier in payload
					},
				}),
			),
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		expect(session).toBeDefined();
		expect(session!.issue_identifier).toBe("issue-1"); // fallback to issue_id
	});

	it("session_failed without issueIdentifier falls back to issue_id", async () => {
		// Create a running session first
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeEvent()),
		});

		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_id: "evt-failed",
					event_type: "session_failed",
					payload: {
						error: "timeout",
						// no issueIdentifier
					},
				}),
			),
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		expect(session).toBeDefined();
		// session_started set it to GEO-95, session_failed should preserve it
		expect(session!.issue_identifier).toBe("GEO-95");
	});

	it("session_completed with empty string issueIdentifier preserves existing identifier", async () => {
		// Create a running session with good identifier (GEO-95 from makeEvent default)
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(makeEvent()),
		});

		// session_completed with empty string issueIdentifier should NOT overwrite
		const res = await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(
				makeEvent({
					event_id: "evt-completed",
					event_type: "session_completed",
					payload: {
						issueIdentifier: "", // empty string — must not overwrite GEO-95
						decision: { route: "needs_review" },
						evidence: { commitCount: 1 },
					},
				}),
			),
		});
		expect(res.status).toBe(200);

		const session = store.getSession("exec-1");
		expect(session).toBeDefined();
		// Empty string should be treated as missing → COALESCE preserves GEO-95
		expect(session!.issue_identifier).toBe("GEO-95");
	});
});

// ── FLY-208 7a: stage_context honesty (no reverse assertions from stale snapshots) ──
//
// Production incident: stage_changed(completed) said "PR #16 is OPEN ... do
// NOT tell Annie the PR is merged" 31 seconds AFTER the merge, and "No PR
// detected" 53 seconds after PR creation — both inferred solely from
// session.pr_number existence. Now: the event's own landing_status proves a
// merge; everything else is labeled a timestamped snapshot with a verify
// instruction. Live PR querying is FLY-210.
describe("Event route — stage_context honesty (FLY-208 7a)", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let capturedEnvelopes: LeadEventEnvelope[];

	beforeEach(async () => {
		const mock = createMockRegistry();
		capturedEnvelopes = mock.envelopes;
		store = await StateStore.create(":memory:");
		const config = makeConfig();
		const app = createBridgeApp(
			store,
			testProjects,
			config,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			mock.registry,
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const addr = server.address();
		const port = typeof addr === "object" && addr ? addr.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
		// FLY-827: these tests predate the Codex hard gate and verify notification /
		// lifecycle behavior orthogonal to codex. Run gate-OFF (byte-compat) so an
		// awaiting_review completion isn't held by the new codex/isReviewHeld branch.
		process.env.FLYWHEEL_CODEX_HARD_GATE = "0";
		// FLY-869: bypass the new merge/QA ship gates — these tests exercise the FSM
		// mapping, not the approval gate (covered by ship-eligibility + new integration tests).
		process.env.FLYWHEEL_MERGE_APPROVAL_GATE = "0";
		process.env.FLYWHEEL_QA_DONE_GATE = "0";
	});

	afterEach(async () => {
		delete process.env.FLYWHEEL_CODEX_HARD_GATE;
		delete process.env.FLYWHEEL_MERGE_APPROVAL_GATE;
		delete process.env.FLYWHEEL_QA_DONE_GATE;
		await new Promise<void>((resolve, reject) => {
			server.close((err) => (err ? reject(err) : resolve()));
		});
		store.close();
	});

	async function post(body: Record<string, unknown>): Promise<void> {
		await fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(body),
		});
		await new Promise((r) => setTimeout(r, 100));
	}

	function lastStageContext(): string | undefined {
		const stageEnvs = capturedEnvelopes.filter(
			(e) => e.event.event_type === "stage_changed",
		);
		return stageEnvs[stageEnvs.length - 1]?.event.stage_context;
	}

	it("merged landing in the event → states the merge (with sha), no hedging needed", async () => {
		await post(makeEvent());
		store.patchSessionMetadata("exec-1", { pr_number: 16 });
		await post(
			makeEvent({
				event_type: "stage_changed",
				payload: {
					stage: "completed",
					landing_status: { status: "merged", mergeCommitSha: "a6c5d4c7" },
				},
			}),
		);
		const ctx = lastStageContext();
		expect(ctx).toContain("PR #16 was merged by the Runner");
		expect(ctx).toContain("a6c5d4c7");
		expect(ctx).not.toContain("do NOT tell Annie");
	});

	it("PR known but landing not merged → timestamped snapshot + verify instruction, NO reverse assertion", async () => {
		await post(makeEvent({ execution_id: "exec-7a2" }));
		store.patchSessionMetadata("exec-7a2", { pr_number: 16 });
		await post(
			makeEvent({
				execution_id: "exec-7a2",
				event_type: "stage_changed",
				payload: {
					stage: "completed",
					landing_status: { status: "ready_to_merge", prNumber: 16 },
				},
			}),
		);
		const ctx = lastStageContext();
		expect(ctx).toContain("status snapshot at");
		expect(ctx).toContain("gh pr view 16");
		// The incident's reverse assertions are gone:
		expect(ctx).not.toContain("is OPEN");
		expect(ctx).not.toContain("do NOT tell Annie");
	});

	it("no PR recorded → hedged wording (just-created PR may not be ingested yet)", async () => {
		await post(makeEvent({ execution_id: "exec-7a3" }));
		await post(
			makeEvent({
				execution_id: "exec-7a3",
				event_type: "stage_changed",
				payload: { stage: "completed" },
			}),
		);
		const ctx = lastStageContext();
		expect(ctx).toContain("No PR recorded as of");
		expect(ctx).toContain("may not be ingested yet");
		expect(ctx).not.toContain("No PR detected");
	});
});
