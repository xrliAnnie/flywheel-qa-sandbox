import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tryReconcileComplete } from "../bridge/complete-marker-reconciler.js";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";
import { buildWorkflowRunSnapshotV2 } from "../workflow-run-snapshot.js";

const projects: ProjectEntry[] = [
	{
		projectName: "flywheel",
		projectRoot: "/tmp/flywheel-fly1427",
		projectRepo: "xrliAnnie/flywheel",
		leads: [
			{
				agentId: "flywheel-eng-lead",
				forumChannel: "test-channel",
				chatChannel: "test-chat",
				match: { labels: ["engineering"] },
			},
		],
	},
];

const workflowEnv = {
	FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES: "1",
	FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_WRITE: "1",
	FLYWHEEL_WORKFLOW_CLAIMS_READ: "1",
};

function config(): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath: ":memory:",
		ingestToken: "ingest-secret",
		notificationChannel: "test-channel",
		defaultLeadAgentId: "flywheel-eng-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300000,
		orphanThresholdMinutes: 60,
	};
}

describe("FLY-1427 /events generalized terminal immunity", () => {
	let store: StateStore;
	let server: http.Server;
	let baseUrl: string;
	let root: string;

	beforeEach(async () => {
		store = await StateStore.create(":memory:");
		root = mkdtempSync(join(tmpdir(), "fly1427-event-route-"));
		mkdirSync(join(root, "agents"));
		writeFileSync(join(root, "agents", "generic.md"), "Execute safely.\n");
		const snapshot = buildWorkflowRunSnapshotV2({
			template: { id: "tpl-fly1427-event-route", revision: 1 },
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
		store.createWorkflowRun({
			runId: "run-fly1427-event-route",
			issueId: "FLY-1427",
			projectName: "flywheel",
			snapshotJson: JSON.stringify(snapshot),
			claimsReadEnrolled: false,
		});
		expect(
			store.admitGeneralizedWorkflowExecution({
				runId: "run-fly1427-event-route",
				nodeId: "execute",
				executionId: "exec-fly1427-event-route",
				attempt: 1,
				now: "2026-07-22T00:00:00.000Z",
				expiresAt: "2026-07-22T01:00:00.000Z",
				absoluteDeadlineAt: "2026-07-23T00:00:00.000Z",
				env: workflowEnv,
			}),
		).toMatchObject({ ok: true });
		store.upsertSession({
			execution_id: "exec-fly1427-event-route",
			issue_id: "FLY-1427",
			project_name: "flywheel",
			status: "terminated",
			workflow_node_id: "execute",
		});
		const app = createBridgeApp(store, projects, config());
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server.once("listening", resolve));
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		baseUrl = `http://127.0.0.1:${port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
		store.close();
		rmSync(root, { recursive: true, force: true });
	});

	async function postEvent(body: Record<string, unknown>) {
		return fetch(`${baseUrl}/events`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ingest-secret",
			},
			body: JSON.stringify(body),
		});
	}

	it("rejects a terminal session's flywheel-comm completion without advancing the engine", async () => {
		const response = await postEvent({
			event_id: "event-fly1427-comm",
			execution_id: "exec-fly1427-event-route",
			issue_id: "FLY-1427",
			project_name: "flywheel",
			event_type: "session_completed",
			source: "flywheel-comm",
			payload: { decision: { route: "needs_review" }, evidence: {} },
		});

		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error: "workflow_completion_rejected",
			reason: "transition_refused",
			detail: {
				transitionReason: "engine_invariant:writer_session_terminal",
			},
		});
		expect(store.getSession("exec-fly1427-event-route")?.status).toBe(
			"terminated",
		);
		expect(
			store.getWorkflowNodeCompletion("run-fly1427-event-route", "execute", 1),
		).toBeUndefined();
		expect(
			store.getWorkflowRunNode("run-fly1427-event-route", "execute", 1)?.state,
		).not.toBe("done");
	});

	it("converges an old fail-close marker through the real /events route without advancing the DAG", async () => {
		const markerDir = join(root, "complete-failed");
		const quarantineDir = join(root, "complete-failed-quarantine");
		mkdirSync(markerDir, { recursive: true });
		writeFileSync(
			join(markerDir, "exec-fly1427-event-route.json"),
			JSON.stringify({
				event_id: "event-fly1427-marker",
				execution_id: "exec-fly1427-event-route",
				issue_id: "FLY-1427",
				project_name: "flywheel",
				event_type: "session_completed",
				source: "flywheel-comm",
				payload: { decision: { route: "needs_review" }, evidence: {} },
			}),
			"utf8",
		);

		const result = await tryReconcileComplete("exec-fly1427-event-route", {
			store,
			bridgeBaseUrl: baseUrl,
			ingestToken: "ingest-secret",
			markerDir,
			quarantineDir,
			log: () => {},
		});

		expect(result).toEqual({
			kind: "held_for_lead",
			invariant: "writer_session_terminal",
			alertState: "accepted",
		});
		expect(existsSync(join(markerDir, "exec-fly1427-event-route.json"))).toBe(
			true,
		);
		expect(store.getSession("exec-fly1427-event-route")?.status).toBe(
			"terminated",
		);
		expect(
			store.getWorkflowNodeCompletion("run-fly1427-event-route", "execute", 1),
		).toBeUndefined();
		expect(
			store.getWorkflowRunNode("run-fly1427-event-route", "execute", 1)?.state,
		).not.toBe("done");
	});

	it.each(["session_completed", "session_failed"])(
		"records and replays %s teardown observability while preserving terminated",
		async (eventType) => {
			const body = {
				event_id: `event-fly1427-${eventType}`,
				execution_id: "exec-fly1427-event-route",
				issue_id: "FLY-1427",
				project_name: "flywheel",
				event_type: eventType,
				source: "orchestrator",
				payload:
					eventType === "session_failed"
						? { error: "runner stopped" }
						: { decision: { route: "needs_review" } },
			};
			const response = await postEvent(body);

			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				ok: true,
				generalized: true,
				teardown: "held_recorded",
				statusPreserved: true,
			});
			expect(store.getSession("exec-fly1427-event-route")?.status).toBe(
				"terminated",
			);

			const replay = await postEvent(body);
			expect(replay.status).toBe(200);
			expect(await replay.json()).toMatchObject({
				ok: true,
				generalized: true,
				teardown: "held_recorded",
				duplicate: true,
				statusPreserved: true,
			});
			expect(store.getSession("exec-fly1427-event-route")?.status).toBe(
				"terminated",
			);
		},
	);
});
