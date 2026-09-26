import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import express from "express";
import { CommDB } from "flywheel-comm/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../../StateStore.js";
import { workflowSeedContentHash } from "../../workflow-template.js";
import { commDbPathForProject, createEventRouter } from "../event-route.js";
import { tokenAuthMiddleware } from "../plugin.js";
import type { BridgeConfig } from "../types.js";

const EXEC = "failure-exec";
const RUN = "failure-run";
const ISSUE = "FLY-2922-FAILURE";
const PROJECT = "completion-failure-fixture";
const ACTIVATION = "failure-activation";
const REASON = "Required implementation dependency is unavailable";
const flags = {
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};

describe("FLY-2922 enrolled blocked completion", () => {
	let root: string;
	let store: StateStore | undefined;
	let comm: CommDB | undefined;
	let server: Server | undefined;
	let url: string;
	let epoch: number;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "workflow-completion-failure-"));
		vi.stubEnv("FLYWHEEL_COMM_DIR", join(root, "comm"));
		mkdirSync(join(root, "agents"));
		mkdirSync(join(root, ".flywheel"));
		writeFileSync(join(root, "agents", "generic.md"), "Execute the task.\n");
		writeFileSync(
			join(root, ".flywheel", "config.yaml"),
			`project: ${PROJECT}\nlinear:\n  team_id: TEST\nrunners:\n  default: claude\n  available:\n    claude:\n      type: claude\nteams:\n  - name: default\n    orchestrators:\n      - type: dag\n        runner: claude\ndecision_layer:\n  autonomy_level: advisor\n  escalation_channel: discord\ncheckpoints:\n  founder_review:\n    timeout_ms: 172800000\n    timeout_behavior: fail-close\n`,
		);
		store = await StateStore.create(join(root, "teamlead.db"));
		const seed = {
			templateId: "tpl_completion_failure_test",
			name: "Completion failure fixture",
			projectScope: "global",
			manifest: {
				schema_version: 2 as const,
				nodes: [
					{
						id: "produce",
						type: "generic" as const,
						vendor: "codex" as const,
						model: "gpt-5.6-sol",
						effort: "low" as const,
						agent_file: "agents/generic.md",
						founder_review: true,
					},
					{ id: "founder_gate", type: "gate" as const },
				],
				edges: [
					{
						id: "done",
						from: "produce",
						to: "founder_gate",
						condition: "node_done" as const,
					},
				],
				loops: [],
				terminal_gate: {
					node: "founder_gate",
					predicate: "founder_approved" as const,
				},
				ship_claims: ["founder_approved" as const],
			},
		};
		store.importWorkflowTemplateSeed({
			...seed,
			contentHash: workflowSeedContentHash(seed),
		});
		const now = new Date().toISOString();
		store.materializeWorkflowRun({
			runId: RUN,
			issueId: ISSUE,
			projectName: PROJECT,
			templateId: seed.templateId,
			claimsReadEnrolled: true,
			actor: "test",
			canonicalRoot: root,
			startReservation: {
				idempotencyKey: "failure-start",
				selectionDigest: "failure-selection",
				nodeId: "produce",
				attempt: 1,
				executionId: EXEC,
				createdAt: now,
			},
		});
		const admitted = store.admitGeneralizedWorkflowExecution({
			runId: RUN,
			nodeId: "produce",
			executionId: EXEC,
			attempt: 1,
			activationId: ACTIVATION,
			now,
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			absoluteDeadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
			env: flags,
		});
		expect(
			admitted,
			"fixture must admit the real current workflow writer",
		).toMatchObject({ ok: true });
		store.upsertSession({
			execution_id: EXEC,
			issue_id: ISSUE,
			project_name: PROJECT,
			status: "running",
			workflow_node_id: "produce",
		});
		const commPath = commDbPathForProject(PROJECT);
		mkdirSync(dirname(commPath), { recursive: true });
		comm = new CommDB(commPath);
		comm.registerSession(
			EXEC,
			"fixture-window",
			PROJECT,
			ISSUE,
			"test-lead",
			"codex",
		);
		epoch = comm.grantTurn(ISSUE, EXEC, "produce", Date.now(), {
			project: PROJECT,
			sourceEventId: "failure-turn",
			activation: {
				activationId: ACTIVATION,
				runId: RUN,
				nodeId: "produce",
				attempt: 1,
				context: {},
			},
		});
		expect(
			store.recordWorkflowActivationTurn({
				activationId: ACTIVATION,
				executionId: EXEC,
				issueId: ISSUE,
				epoch,
				sourceEventId: "failure-turn",
				grantedAt: now,
			}),
		).toMatchObject({ ok: true });
		expect(comm.resolveRunnerWorkflowActivation(EXEC).state).toBe("active");
		expect(store.getWorkflowRun(RUN)).toMatchObject({
			engine_owned: 1,
			status: "active",
			current_node_id: "produce",
		});
		const config: BridgeConfig = {
			host: "127.0.0.1",
			port: 0,
			dbPath: ":memory:",
			ingestToken: "failure-ingest",
			notificationChannel: "test-channel",
			defaultLeadAgentId: "test-lead",
			stuckThresholdMinutes: 15,
			stuckCheckIntervalMs: 300_000,
			orphanThresholdMinutes: 60,
		};
		const app = express();
		app.use(express.json());
		app.use(
			"/events",
			tokenAuthMiddleware(config.ingestToken),
			createEventRouter(
				store,
				[
					{
						projectName: PROJECT,
						projectRoot: root,
						projectRepo: "test/completion-failure",
						leads: [
							{
								agentId: "test-lead",
								forumChannel: "test-channel",
								chatChannel: "test-chat",
								match: { labels: [] },
							},
						],
					},
				],
				config,
			),
		);
		await new Promise<void>((resolve, reject) => {
			server = app.listen(0, "127.0.0.1", resolve);
			server.once("error", reject);
		});
		const address = server!.address();
		if (!address || typeof address === "string")
			throw new Error("fixture HTTP server has no port");
		url = `http://127.0.0.1:${address.port}/events`;
	}, 60_000);

	afterEach(async () => {
		if (server) {
			const closing = new Promise<void>((resolve, reject) =>
				server!.close((error) => (error ? reject(error) : resolve())),
			);
			server.closeIdleConnections();
			await closing;
		}
		server = undefined;
		comm?.close();
		comm = undefined;
		store?.close();
		store = undefined;
		vi.unstubAllEnvs();
		if (root) rmSync(root, { recursive: true, force: true });
	});

	function state() {
		const db = (store as unknown as { db: { raw: Database.Database } }).db.raw;
		return {
			run: store!.getWorkflowRun(RUN),
			nodes: store!.listWorkflowRunNodes(RUN),
			session: store!.getSession(EXEC),
			events: store!.listWorkflowRunEvents(RUN),
			audit: store!.getEventsByExecution(EXEC),
			effects: store!.listWorkflowSideEffects(RUN),
			completion: store!.getWorkflowNodeCompletion(RUN, "produce", 1),
			gateHolders: db
				.prepare("SELECT * FROM workflow_gate_holder WHERE run_id = ?")
				.all(RUN),
			founderCards: db
				.prepare("SELECT * FROM founder_review_card_binding WHERE run_id = ?")
				.all(RUN),
		};
	}

	async function post(
		options: {
			token?: string;
			eventId?: string;
			payload?: Record<string, unknown>;
		} = {},
	) {
		const response = await fetch(url, {
			method: "POST",
			signal: AbortSignal.timeout(15_000),
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${options.token ?? "failure-ingest"}`,
			},
			body: JSON.stringify({
				event_id: options.eventId ?? "blocked-report",
				execution_id: EXEC,
				issue_id: ISSUE,
				project_name: PROJECT,
				event_type: "session_completed",
				source: "flywheel-comm",
				payload: {
					decision: { route: "blocked" },
					summary: REASON,
					workflowActivation: {
						activationId: ACTIVATION,
						runId: RUN,
						nodeId: "produce",
						attempt: 1,
						turnEpoch: epoch,
					},
					...options.payload,
				},
			}),
		});
		return { status: response.status, body: await response.json() };
	}

	it("fails the current node and session, holds its run, and never creates success evidence", async () => {
		const before = state();
		const result = await post();
		expect(
			result,
			"blocked is a failure report; missing HEAD/artifact/founder approval must not gate it",
		).toMatchObject({
			status: 200,
			body: { ok: true, generalized: true, duplicate: false },
		});
		const after = state();
		expect(after.run).toMatchObject({
			run_id: RUN,
			status: "held",
			current_node_id: "produce",
		});
		expect(after.session).toMatchObject({
			status: "failed",
			terminal_at: expect.any(String),
		});
		expect(
			after.nodes.find((node) => node.node_id === "produce"),
		).toMatchObject({ attempt: 1, execution_id: EXEC, state: "failed" });
		expect(
			after.nodes.map((node) => [
				node.node_id,
				node.attempt,
				node.execution_id,
			]),
		).toEqual(
			before.nodes.map((node) => [
				node.node_id,
				node.attempt,
				node.execution_id,
			]),
		);
		expect(after.completion).toBeUndefined();
		expect(after.effects).toEqual(before.effects);
		expect(after.gateHolders).toEqual([]);
		expect(after.founderCards).toEqual([]);
		expect(
			after.audit.filter((event) => event.event_type === "session_completed"),
		).toEqual([]);
		const failures = after.events.filter(
			(event) => event.kind === "run_recovery_required",
		);
		expect(failures).toHaveLength(1);
		expect(failures[0]).toMatchObject({
			node_id: "produce",
			execution_id: EXEC,
		});
		expect(JSON.stringify(failures[0]!.payload)).toContain("blocked-report");
		// Durable receipt and projections survive reopening the temporary real database.
		store!.close();
		store = await StateStore.create(join(root, "teamlead.db"));
		expect(state()).toEqual(after);
	});

	it("replays the same failure without another episode and rejects changed content", async () => {
		expect(await post()).toMatchObject({ status: 200 });
		const before = state();
		expect(await post()).toMatchObject({
			status: 200,
			body: { duplicate: true },
		});
		expect(state()).toEqual(before);
		expect(
			await post({
				payload: { summary: "Different reason for the same event" },
			}),
		).toMatchObject({ status: 409 });
		expect(state()).toEqual(before);
	});

	it("ignores invalid success-only PR evidence on an enrolled failure report", async () => {
		expect(
			await post({
				payload: { evidence: { declaredPrs: "invalid-success-evidence" } },
			}),
		).toMatchObject({ status: 200 });
		expect(store!.getWorkflowRun(RUN)?.status).toBe("held");
	});

	it("rejects the wrong ingest bearer without any workflow mutation", async () => {
		const before = state();
		expect(await post({ token: "wrong-ingest" })).toMatchObject({
			status: 401,
		});
		expect(state()).toEqual(before);
	});

	it("rejects a stale activation TURN epoch without any workflow mutation", async () => {
		const before = state();
		expect(
			await post({
				payload: {
					workflowActivation: {
						activationId: ACTIVATION,
						runId: RUN,
						nodeId: "produce",
						attempt: 1,
						turnEpoch: epoch + 1,
					},
				},
			}),
		).toMatchObject({
			status: 409,
			body: {
				error: "workflow_completion_rejected",
				reason: "activation_turn_conflict",
			},
		});
		expect(state()).toEqual(before);
	});

	it("requires and consumes the server-issued drain receipt before failing the node", async () => {
		const mailId = comm!.insertInstruction(
			"test-lead",
			EXEC,
			"Read before reporting failure",
		);
		const before = state();
		const pending = await post();
		expect(pending).toMatchObject({
			status: 409,
			body: {
				reason: "consume_pending_mail",
				mailbox: [mailId],
				challengeId: expect.any(String),
			},
		});
		expect(store!.getSession(EXEC)?.status).toBe("running");
		expect(store!.getWorkflowRun(RUN)?.status).toBe("active");
		expect(state().completion).toBeUndefined();
		expect(
			await post({
				payload: { drainReceipt: { challengeId: pending.body.challengeId } },
			}),
		).toMatchObject({
			status: 409,
			body: { reason: "drain_receipt_rejected" },
		});
		comm!.markInstructionRead(mailId);
		expect(
			await post({
				payload: { drainReceipt: { challengeId: pending.body.challengeId } },
			}),
		).toMatchObject({ status: 200 });
		expect(store!.getSession(EXEC)?.status).toBe("failed");
		expect(store!.getWorkflowRun(RUN)?.status).toBe("held");
		expect(state().effects).toEqual(before.effects);
	});
});
