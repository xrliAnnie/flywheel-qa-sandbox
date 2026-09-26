import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type Database from "better-sqlite3";
import express from "express";
import { CommDB } from "flywheel-comm/db";
import { WORKFLOW_TRANSITIONS, WorkflowFSM } from "flywheel-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplyTransitionOpts } from "../../applyTransition.js";
import { DirectEventSink } from "../../DirectEventSink.js";
import { DirectiveExecutor } from "../../DirectiveExecutor.js";
import { StateStore } from "../../StateStore.js";
import { workflowSeedContentHash } from "../../workflow-template.js";
import {
	applyQuarantineFallback,
	tryReconcileComplete,
} from "../complete-marker-reconciler.js";
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
	let sink: DirectEventSink;
	let transitionOpts: ApplyTransitionOpts;

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
		transitionOpts = {
			store,
			fsm: new WorkflowFSM(WORKFLOW_TRANSITIONS),
			executor: new DirectiveExecutor(store),
		};
		sink = new DirectEventSink(store, config, []);
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
				undefined,
				transitionOpts,
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
			nodes: store!.listWorkflowRunNodes(RUN, "produce"),
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

	function admitReusedActor() {
		store!.upsertWorkflowRunNode({
			runId: RUN,
			nodeId: "produce",
			attempt: 2,
			executionId: EXEC,
			state: "pending",
		});
		expect(
			store!.admitGeneralizedWorkflowExecution({
				runId: RUN,
				nodeId: "produce",
				attempt: 2,
				executionId: EXEC,
				activationId: "reused-activation",
				activationMode: "wake",
				env: flags,
				now: new Date().toISOString(),
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
				absoluteDeadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
			}),
		).toMatchObject({ ok: true });
		expect(store!.listWorkflowActivationsForActor(EXEC)).toHaveLength(2);
		expect(store!.getGeneralizedWorkflowNodeForExecution(EXEC)).toBeUndefined();
		expect(store!.isEnrolledWorkflowCarrier(EXEC)).toBe(true);
	}

	function marker(payload: Record<string, unknown>) {
		const markerDir = join(root, "markers");
		mkdirSync(markerDir, { recursive: true });
		writeFileSync(
			join(markerDir, `${EXEC}.json`),
			JSON.stringify({
				event_id: "marker-failure",
				execution_id: EXEC,
				issue_id: ISSUE,
				project_name: PROJECT,
				event_type: "session_completed",
				source: "flywheel-comm",
				payload,
			}),
		);
		return {
			store: store!,
			bridgeBaseUrl: url.replace(/\/events$/, ""),
			ingestToken: "failure-ingest",
			markerDir,
			quarantineDir: join(root, "quarantine"),
			log: () => {},
		};
	}

	it.each([false, true])(
		"keeps enrolled stage completion informational, including replay (reused=%s)",
		async (reused) => {
			if (reused) admitReusedActor();
			const before = state();
			for (let replay = 0; replay < 2; replay++) {
				const response = await fetch(url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: "Bearer failure-ingest",
					},
					body: JSON.stringify({
						event_id: "enrolled-stage",
						execution_id: EXEC,
						issue_id: ISSUE,
						project_name: PROJECT,
						event_type: "stage_changed",
						source: "flywheel-comm",
						payload: { stage: "completed" },
					}),
				});
				expect(response.status).toBe(200);
				await response.text();
				expect(store!.getSession(EXEC)).toMatchObject({
					status: "running",
					session_stage: "completed",
				});
			}
			expect(state().run).toEqual(before.run);
			expect(state().nodes).toEqual(before.nodes);
			expect(state().completion).toBeUndefined();
		},
	);

	it.each(["completed", "failed"] as const)(
		"does not project an ambiguous raw %s signal through either legacy sink",
		async (signal) => {
			admitReusedActor();
			const before = state();
			const env = { executionId: EXEC, issueId: ISSUE, projectName: PROJECT };
			if (signal === "completed")
				await sink.emitCompleted(env, {
					success: true,
					decision: { route: "blocked", reasoning: "raw exit" },
				});
			else await sink.emitFailed(env, "raw failure");
			expect(state()).toEqual(before);
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer failure-ingest",
				},
				body: JSON.stringify({
					event_id: `raw-${signal}`,
					execution_id: EXEC,
					issue_id: ISSUE,
					project_name: PROJECT,
					event_type: `session_${signal}`,
					source: "orchestrator",
					payload: { decision: { route: "blocked" }, error: "raw failure" },
				}),
			});
			expect(response.status).toBe(409);
			await response.text();
			expect(state()).toEqual(before);
		},
	);

	it.each([false, true])(
		"does not force an enrolled dead carrier terminal after marker quarantine (reused=%s)",
		(reused) => {
			if (reused) admitReusedActor();
			const before = state();
			applyQuarantineFallback({
				store: store!,
				transitionOpts,
				executionId: EXEC,
				issueId: ISSUE,
				projectName: PROJECT,
				tmuxAlive: false,
				routeStatus: "completed",
				quarantinePath: join(root, "quarantined.json"),
				log: () => {},
			});
			expect(state()).toEqual(before);
		},
	);

	it("does not treat a reused actor marker without activation authority as legacy", async () => {
		admitReusedActor();
		store!.forceStatus(
			EXEC,
			"blocked",
			new Date().toISOString(),
			"old projection without receipt",
		);
		const before = state();
		const deps = marker({ decision: { route: "blocked" }, summary: REASON });
		const outcome = await tryReconcileComplete(EXEC, deps);
		expect(outcome.kind).toBe("quarantined");
		expect(state()).toEqual(before);
	});

	it.each([false, true])(
		"settles a blocked marker only through its durable failure receipt (stale merged evidence=%s)",
		async (merged) => {
			const payload = {
				decision: { route: "blocked" },
				summary: REASON,
				...(merged
					? { evidence: { landingStatus: { status: "merged" } } }
					: {}),
				workflowActivation: {
					activationId: ACTIVATION,
					runId: RUN,
					nodeId: "produce",
					attempt: 1,
					turnEpoch: epoch,
				},
			};
			const deps = marker(payload);
			expect(await tryReconcileComplete(EXEC, deps)).toEqual({
				kind: "reconciled",
				status: "node_failed",
			});
			expect(existsSync(join(deps.markerDir, `${EXEC}.json`))).toBe(false);
			expect(store!.getSession(EXEC)?.status).toBe("failed");
			expect(
				store!.getWorkflowNodeCompletion(RUN, "produce", 1),
			).toBeUndefined();
			expect(
				store!
					.listWorkflowRunEvents(RUN)
					.filter((event) => event.kind === "run_recovery_required"),
			).toHaveLength(1);
			const before = state();
			expect(await tryReconcileComplete(EXEC, marker(payload))).toEqual({
				kind: "duplicate_terminal",
				status: "node_failed",
			});
			expect(state()).toEqual(before);
			for (const changedPayload of [
				{ ...payload, summary: "Changed failure reason" },
				{
					...payload,
					evidence: {
						diagnostic: "Changed business evidence with the same reason",
					},
				},
			]) {
				const changed = await tryReconcileComplete(
					EXEC,
					marker(changedPayload),
				);
				expect(changed.kind).toBe("quarantined");
				if (changed.kind === "quarantined")
					expect(existsSync(changed.quarantinePath)).toBe(true);
				expect(state()).toEqual(before);
			}
		},
	);

	it("keeps a blocked marker when HTTP accepts without a durable failure receipt", async () => {
		const deps = marker({
			decision: { route: "blocked" },
			summary: REASON,
			workflowActivation: {
				activationId: ACTIVATION,
				runId: RUN,
				nodeId: "produce",
				attempt: 1,
				turnEpoch: epoch,
			},
		});
		const before = state();
		expect(
			await tryReconcileComplete(EXEC, {
				...deps,
				fetchFn: async () =>
					new Response(
						JSON.stringify({
							ok: true,
							generalized: true,
							failureRecorded: true,
						}),
						{ status: 200 },
					),
			}),
		).toMatchObject({ kind: "transient_failed" });
		expect(existsSync(join(deps.markerDir, `${EXEC}.json`))).toBe(true);
		expect(state()).toEqual(before);
	});

	it("quarantines a marker whose supplied tuple conflicts with its exact activation", async () => {
		const deps = marker({
			decision: { route: "blocked" },
			summary: REASON,
			workflowActivation: {
				activationId: ACTIVATION,
				runId: "wrong-run",
				nodeId: "produce",
				attempt: 1,
				turnEpoch: epoch,
			},
		});
		const before = state();
		expect(await tryReconcileComplete(EXEC, deps)).toMatchObject({
			kind: "quarantined",
		});
		expect(state()).toEqual(before);
	});

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
		const bodyText = await response.text();
		let body: Record<string, unknown>;
		try {
			body = JSON.parse(bodyText);
		} catch {
			body = { nonJson: true };
		}
		return { status: response.status, body };
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

	it("rejects reuse of an already recorded event identity without a failure receipt", async () => {
		store!.insertEvent({
			event_id: "collision",
			execution_id: EXEC,
			issue_id: ISSUE,
			project_name: PROJECT,
			event_type: "session_failed",
			source: "prior-source",
			payload: { reason: "different event" },
		});
		const before = state();
		expect(await post({ eventId: "collision" })).toMatchObject({
			status: 409,
			body: { reason: "failure_receipt_conflict" },
		});
		expect(state()).toEqual(before);
	});

	it("rejects a live TURN transfer even while the StateStore projection still has the old epoch", async () => {
		comm!.grantTurn(ISSUE, "replacement-owner", "produce", Date.now(), {
			project: PROJECT,
			sourceEventId: "other-turn",
		});
		const before = state();
		expect(await post()).toMatchObject({
			status: 409,
			body: { reason: "activation_turn_conflict" },
		});
		expect(state()).toEqual(before);
	});

	it("requires exact activation and a nonempty failure reason", async () => {
		const before = state();
		expect(
			await post({ payload: { workflowActivation: undefined } }),
		).toMatchObject({ status: 409 });
		expect(await post({ payload: { summary: "  " } })).toMatchObject({
			status: 409,
		});
		expect(state()).toEqual(before);
	});

	it("rolls back failure projections and drain consumption when the final audit insert fails", async () => {
		const id = comm!.insertInstruction(
			"test-lead",
			EXEC,
			"Drain before injected failure",
		);
		const pending = await post();
		expect(pending).toMatchObject({
			status: 409,
			body: { reason: "consume_pending_mail" },
		});
		comm!.markInstructionRead(id);
		const db = (store as unknown as { db: { raw: Database.Database } }).db.raw;
		db.exec(
			"CREATE TRIGGER reject_failure BEFORE INSERT ON session_events WHEN NEW.source = 'workflow-generalized-failure' BEGIN SELECT RAISE(ABORT, 'injected_failure_commit'); END",
		);
		const before = state();
		const receipt = { drainReceipt: { challengeId: pending.body.challengeId } };
		expect(await post({ payload: receipt })).toMatchObject({ status: 500 });
		expect(state()).toEqual(before);
		expect(
			db
				.prepare(
					"SELECT state FROM workflow_completion_drain_challenge WHERE challenge_id = ?",
				)
				.get(pending.body.challengeId),
		).toEqual({ state: "issued" });
		db.exec("DROP TRIGGER reject_failure");
		expect(await post({ payload: receipt })).toMatchObject({ status: 200 });
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
