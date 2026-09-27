import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type BetterSqlite3 from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventFilter } from "../bridge/EventFilter.js";
import { commDbPathForProject } from "../bridge/event-route.js";
import { initializeFlagStore } from "../bridge/flag-store-runtime.js";
import type { LeadEventEnvelope } from "../bridge/lead-runtime.js";
import { createBridgeApp } from "../bridge/plugin.js";
import { RuntimeRegistry } from "../bridge/runtime-registry.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";
import { buildWorkflowRunSnapshotV2 } from "../workflow-run-snapshot.js";
import {
	legacyWorkflowSeed,
	pinLegacyWorkflowSeedAgents,
} from "./fixtures/legacy-workflow-manifests.js";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const EXEC = "route-notice-exec";
const ISSUE = "route-notice-issue";
const PROJECT = "quiet-route-fixture";
const LEAD = "fixture-lead";

describe("FLY-2912 validated HTTP notification producers", () => {
	let store: StateStore;
	let raw: BetterSqlite3.Database;
	let server: Server;
	let baseUrl: string;
	let directory: string;
	let delivered: LeadEventEnvelope[];

	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "fly2912-route-"));
		store = await StateStore.create(join(directory, "state.db"));
		raw = (store as unknown as { db: { raw: BetterSqlite3.Database } }).db.raw;
		initializeFlagStore(store, { FLYWHEEL_LEAD_TOKEN_SAVINGS: "1" });
		delivered = [];
		const registry = new RuntimeRegistry();
		const lead = {
			agentId: LEAD,
			chatChannel: "fixture-channel",
			match: { labels: ["Fixture"] },
		};
		registry.register(lead, {
			type: "commdb",
			deliver: vi.fn(async (event: LeadEventEnvelope) => {
				delivered.push(event);
				return { delivered: true };
			}),
			sendBootstrap: vi.fn(async () => {}),
			health: vi.fn(async () => ({
				status: "healthy" as const,
				lastDeliveryAt: null,
				lastDeliveredSeq: 0,
			})),
			shutdown: vi.fn(async () => {}),
		});
		const projects: ProjectEntry[] = [
			{ projectName: PROJECT, projectRoot: directory, leads: [lead] },
		];
		const config: BridgeConfig = {
			host: "127.0.0.1",
			port: 0,
			dbPath: join(directory, "state.db"),
			ingestToken: "fixture-secret",
			notificationChannel: "fixture-channel",
			defaultLeadAgentId: LEAD,
			stuckThresholdMinutes: 15,
			stuckCheckIntervalMs: 300000,
			orphanThresholdMinutes: 60,
		};
		const app = createBridgeApp(
			store,
			projects,
			config,
			undefined,
			undefined,
			undefined,
			undefined,
			new EventFilter(),
			undefined,
			registry,
		);
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("fixture server address missing");
		baseUrl = `http://127.0.0.1:${address.port}`;
		store.upsertSession({
			execution_id: EXEC,
			issue_id: ISSUE,
			project_name: PROJECT,
			status: "running",
			worktree_path: directory,
			issue_labels: JSON.stringify(["Fixture"]),
			adapter_type: "codex-tmux",
			doc_tier: "full",
			codex_skip: 0,
		});
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
		store.close();
		rmSync(directory, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	async function post(
		eventId: string,
		payload: Record<string, unknown>,
		eventType = "stage_changed",
	) {
		return fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer fixture-secret",
			},
			body: JSON.stringify({
				event_id: eventId,
				execution_id: EXEC,
				issue_id: ISSUE,
				project_name: PROJECT,
				event_type: eventType,
				source: "flywheel-comm",
				payload,
			}),
		});
	}

	function journal(eventId: string) {
		return raw
			.prepare("SELECT * FROM lead_events WHERE event_id=?")
			.get(eventId) as
			| {
					delivery_disposition: string;
					notification_policy_version: string | null;
					notification_reason: string | null;
					notification_proof_ref: string | null;
					payload: string;
					delivered_at: string | null;
					acked_at: string | null;
			  }
			| undefined;
	}

	function bindCodexNode(nodeId: "design" | "implement") {
		const seed = pinLegacyWorkflowSeedAgents(
			legacyWorkflowSeed("tpl_eng_heavy"),
		);
		const snapshot = buildWorkflowRunSnapshotV2({
			template: { id: "quiet-route", revision: 1 },
			canonicalRoot: REPO_ROOT,
			manifest: {
				...seed.manifest,
				nodes: seed.manifest.nodes
					.filter((node) => nodeId !== "implement" || node.id !== "design")
					.map((node) =>
						node.id === nodeId
							? { ...node, vendor: "codex" as const, model: "gpt-6-sol" }
							: node,
					),
				edges: seed.manifest.edges.filter(
					(edge) =>
						nodeId !== "implement" ||
						(edge.from !== "design" && edge.to !== "design"),
				),
			},
		});
		store.createWorkflowRun({
			runId: "route-run",
			issueId: ISSUE,
			projectName: PROJECT,
			snapshotJson: JSON.stringify(snapshot),
			claimsReadEnrolled: false,
		});
		const admission = store.admitGeneralizedWorkflowExecution({
			runId: "route-run",
			nodeId,
			executionId: EXEC,
			attempt: 1,
			now: "2026-09-26T01:00:00.000Z",
			expiresAt: "2026-09-26T02:00:00.000Z",
			absoluteDeadlineAt: "2026-09-26T04:00:00.000Z",
			env: {
				FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
				FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
				FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
				FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
			},
		});
		expect(admission).toMatchObject({ ok: true });
		// createWorkflowRun is the shadow-run helper; freeze the production
		// engine-owned bit after real admission has recorded this activation.
		raw
			.prepare("UPDATE workflow_run SET engine_owned=1 WHERE run_id=?")
			.run("route-run");
		return store.getWorkflowActivationForAttempt({
			executionId: EXEC,
			runId: "route-run",
			nodeId,
			attempt: 1,
		})!;
	}

	it.each(["onboard", "brainstorm", "research", "plan", "implement", "test"])(
		"persists %s before writing an undelivered v2 audit row",
		async (stage) => {
			expect((await post(`routine-${stage}`, { stage })).status).toBe(200);
			expect(store.latestStageEvent(EXEC)?.event_id).toBe(`routine-${stage}`);
			expect(store.getSession(EXEC)?.session_stage).toBe(stage);
			expect(journal(`routine-${stage}`)).toMatchObject({
				delivery_disposition: "audit_only",
				notification_policy_version: "notification-v2",
				notification_proof_ref: `stage-event:routine-${stage}`,
				delivered_at: null,
				acked_at: null,
			});
			expect(delivered).toHaveLength(0);
		},
	);

	it.each([
		["question", { question: "Which branch should I use?" }],
		["founder", { founder_message: "Please stop" }],
		["failure", { failureKind: "goal_blocked" }],
		["unknown-empty-object", { unknown_extension: {} }],
		["invalid-action-shape", { needs_action: [] }],
		[
			"arbitrary-summary",
			{ summary: "FYI, please choose the deployment target" },
		],
		["spoof-proof", { evidence: { version: 2, action: { state: "none" } } }],
	] as const)(
		"keeps %s carried only by raw ingress immediate",
		async (name, extra) => {
			expect(
				(await post(`raw-${name}`, { stage: "test", ...extra })).status,
			).toBe(200);
			expect(journal(`raw-${name}`)?.delivery_disposition).toBe("model");
			expect(delivered.some((event) => event.eventId === `raw-${name}`)).toBe(
				true,
			);
		},
	);

	it("does not treat running as a resolution of an inherited decision", async () => {
		store.upsertSession({
			execution_id: EXEC,
			issue_id: ISSUE,
			project_name: PROJECT,
			status: "running",
			decision_route: "needs_review",
		});
		expect(
			(await post("unresolved-decision", { stage: "implement" })).status,
		).toBe(200);
		expect(journal("unresolved-decision")).toMatchObject({
			delivery_disposition: "model",
			notification_reason: "action_pending",
		});
		expect(delivered).toHaveLength(1);
	});

	it.each([
		["design_review", "design"],
		["code_review", "implement"],
		["pr_created", "implement"],
	] as const)(
		"audits Codex %s before a gate or reviewer exists",
		async (stage, nodeId) => {
			const activation = bindCodexNode(nodeId);
			expect(
				raw.prepare("SELECT count(*) AS n FROM codex_review_job").get(),
			).toEqual({ n: 0 });
			expect((await post(`owned-${stage}`, { stage })).status).toBe(200);
			expect(journal(`owned-${stage}`)).toMatchObject({
				delivery_disposition: "audit_only",
				notification_reason: "routine_stage_owned",
			});
			expect(
				store.getWorkflowActivation(activation.activation_id)?.execution_id,
			).toBe(EXEC);
			const proof = store
				.getEventsByExecution(EXEC)
				.find((event) => event.event_id === `owned-${stage}:proof`);
			expect(proof?.payload).toMatchObject({
				ownerRef: expect.stringContaining(`:${activation.activation_id}:`),
				workflow: {
					runId: "route-run",
					nodeId,
					attempt: 1,
					activationId: activation.activation_id,
				},
			});
			expect(
				raw.prepare("SELECT count(*) AS n FROM codex_review_job").get(),
			).toEqual({ n: 0 });
			expect(delivered).toHaveLength(0);
		},
	);

	it("retains a review notification when its frozen Codex responsibility is unknown", async () => {
		expect(
			(await post("unowned-review", { stage: "code_review" })).status,
		).toBe(200);
		expect(journal("unowned-review")?.delivery_disposition).toBe("model");
	});

	it.each([
		"skip",
		"unknown-doc-tier",
		"not-engine-owned",
		"completed-attempt",
		"tampered-snapshot",
	] as const)(
		"does not borrow Codex responsibility from %s",
		async (condition) => {
			bindCodexNode("implement");
			if (condition === "skip")
				store.patchSessionMetadata(EXEC, { codex_skip: 1 });
			if (condition === "unknown-doc-tier")
				store.patchSessionMetadata(EXEC, { doc_tier: "unrecognized" });
			if (condition === "not-engine-owned")
				raw
					.prepare("UPDATE workflow_run SET engine_owned=0 WHERE run_id=?")
					.run("route-run");
			if (condition === "completed-attempt")
				raw
					.prepare(
						"UPDATE workflow_run_node SET state='completed' WHERE execution_id=?",
					)
					.run(EXEC);
			if (condition === "tampered-snapshot") {
				const snapshot = JSON.parse(
					store.getWorkflowRun("route-run")!.snapshot!,
				);
				snapshot.resolved.nodes[0].capabilities.needs_review_evidence = false;
				raw
					.prepare("UPDATE workflow_run SET snapshot=? WHERE run_id=?")
					.run(JSON.stringify(snapshot), "route-run");
			}
			expect(
				(await post(`unknown-owner-${condition}`, { stage: "code_review" }))
					.status,
			).toBe(200);
			expect(journal(`unknown-owner-${condition}`)?.delivery_disposition).toBe(
				"model",
			);
		},
	);

	it("preserves an actionable projection even when the raw stage is routine", async () => {
		store.upsertSession({
			execution_id: EXEC,
			issue_id: ISSUE,
			project_name: PROJECT,
			status: "running",
			summary: "Please choose the release window",
		});
		expect((await post("projection-question", { stage: "test" })).status).toBe(
			200,
		);
		expect(journal("projection-question")?.delivery_disposition).toBe("model");
		expect(delivered).toHaveLength(1);
	});

	it.each([
		"matching",
		"missing-question",
		"stale-head",
		"other-execution",
	] as const)("requires a %s durable reviewer binding", async (condition) => {
		const questionId = "existing-review-question";
		const head = "a".repeat(40);
		const dbPath = commDbPathForProject(PROJECT);
		mkdirSync(dirname(dbPath), { recursive: true });
		const comm = new CommDB(dbPath);
		try {
			if (condition !== "missing-question")
				comm.insertQuestion(EXEC, LEAD, "Review this exact head", {
					id: questionId,
					checkpoint: "review_code",
				});
		} finally {
			comm.close();
		}
		store.setReviewBinding(EXEC, { questionId, prHeadSha: head });
		store.insertCodexReviewJob({
			requestId: "existing-review-request",
			executionId: condition === "other-execution" ? "other-exec" : EXEC,
			issueId: ISSUE,
			projectName: PROJECT,
			reviewType: "code",
			questionId,
			frozenHeadSha: condition === "stale-head" ? "b".repeat(40) : head,
		});
		expect(
			(await post(`request-${condition}`, { stage: "code_review" })).status,
		).toBe(200);
		expect(journal(`request-${condition}`)?.delivery_disposition).toBe(
			condition === "matching" ? "audit_only" : "model",
		);
	});

	it("keeps HTTP startup immediate even with forged internal proof", async () => {
		expect(
			(
				await post(
					"http-start",
					{
						issueIdentifier: "FLY-2912",
						runnerBackend: "codex-tmux",
						evidence: { kind: "startup", handoff: "initial_notice" },
					},
					"session_started",
				)
			).status,
		).toBe(200);
		expect(journal("http-start")?.delivery_disposition).toBe("model");
		expect(store.getSession(EXEC)?.status).toBe("running");
	});

	it.each(["lead_token_savings", "lead_stage_changed_audit"])(
		"%s OFF restores new stages and preserves prior audit",
		async (name) => {
			expect((await post("frozen-stage", { stage: "test" })).status).toBe(200);
			const first = journal("frozen-stage");
			expect(
				store.applyScopedFlagValueChange({
					name,
					scope: PROJECT,
					op: "set",
					rawTo: "0",
					expectedChangeSeq: store.getFlagValueChangeSeq(name, PROJECT),
					actor: "fixture-lead",
					reason: "rollback",
				}).ok,
			).toBe(true);
			expect((await post("frozen-stage", { stage: "test" })).status).toBe(200);
			expect(journal("frozen-stage")).toEqual(first);
			expect((await post("new-off-stage", { stage: "test" })).status).toBe(200);
			expect(journal("new-off-stage")?.delivery_disposition).toBe("model");
			expect(delivered.map((event) => event.eventId)).toEqual([
				"new-off-stage",
			]);
		},
	);

	it("rejects invalid stages before they enter either journal", async () => {
		expect((await post("invalid-stage", { stage: "made-up" })).status).toBe(
			400,
		);
		expect(store.latestStageEvent(EXEC)).toBeUndefined();
		expect(journal("invalid-stage")).toBeUndefined();
	});

	it("rejects the reserved internal proof event type before persistence", async () => {
		const response = await post(
			"forged-proof:proof",
			{ version: 2, kind: "stage", proof: { action: { state: "none" } } },
			"lead_notification_proof",
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			reason: "reserved_internal_event_type",
		});
		expect(
			store
				.getEventsByExecution(EXEC)
				.find((event) => event.event_id === "forged-proof:proof"),
		).toBeUndefined();
		expect(journal("forged-proof:proof")).toBeUndefined();
		expect(delivered).toHaveLength(0);
	});
});
