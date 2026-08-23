import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CommDB } from "flywheel-comm/db";
import { verifyApproval } from "flywheel-comm/verify-approval";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainWorkflowSourceEvents } from "../bridge/founder-approval-projector.js";
import { createBridgeApp } from "../bridge/plugin.js";
import type { BridgeConfig } from "../bridge/types.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import { StateStore } from "../StateStore.js";
import { buildWorkflowRunSnapshotV2 } from "../workflow-run-snapshot.js";
import { insertHistoricalAutoQaRecord } from "./helpers/historical-qa.js";

const wakeRunnerMailbox = vi.hoisted(() =>
	vi.fn().mockResolvedValue({
		ok: true,
		backend: "claude-code",
		settlement: "on_delivery",
	}),
);
vi.mock("flywheel-comm/wake", () => ({ wakeRunnerMailbox }));

const PROJECT = "geoforge3d";
const TOKEN = "bridge-master-token";
const HEAD = "a".repeat(40);
const CHANGED_HEAD = "b".repeat(40);
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const projects: ProjectEntry[] = [
	{
		projectName: PROJECT,
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

function makeConfig(dbPath: string): BridgeConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		dbPath,
		apiToken: TOKEN,
		notificationChannel: "test-channel",
		defaultLeadAgentId: "product-lead",
		stuckThresholdMinutes: 15,
		stuckCheckIntervalMs: 300_000,
		orphanThresholdMinutes: 60,
	} as BridgeConfig;
}

function claimlessLandSnapshot(): string {
	return JSON.stringify(
		buildWorkflowRunSnapshotV2({
			template: { id: "tpl_fly1981_claimless", revision: 1 },
			canonicalRoot: REPO_ROOT,
			manifest: {
				schema_version: 2,
				nodes: [
					{
						id: "craft",
						type: "generic",
						role: "generic",
						vendor: "claude",
						model: "claude-opus-5",
						effort: "xhigh",
					},
					{ id: "decision", type: "gate" },
					{ id: "publish", type: "land", execution: "engine" },
				],
				edges: [
					{
						id: "crafted",
						from: "craft",
						to: "decision",
						condition: "node_done",
					},
					{
						id: "approved",
						from: "decision",
						to: "publish",
						condition: "founder_approved",
					},
				],
				loops: [],
				approval_gate: {
					node: "decision",
					predicate: "founder_approved",
				},
				terminal_node: { node: "publish" },
				ship_claims: ["founder_approved"],
			},
		}),
	);
}

function rawStore(store: StateStore): {
	run(sql: string, params?: unknown[]): void;
} {
	return (
		store as unknown as {
			db: { run(sql: string, params?: unknown[]): void };
		}
	).db;
}

function bindPr(store: StateStore, runId: string, executionId: string): void {
	rawStore(store).run(
		`INSERT INTO workflow_node_pr_binding
		   (run_id, node_id, attempt, pr_number, head_sha, target_repo_identity,
		    probe_repo_slug, target_repo_path, worktree_binding_generation,
		    receipt_id, bound_at)
		 VALUES (?, 'craft', 1, 1981, ?, '__main__', 'xrliAnnie/GeoForge3D',
		         '/tmp/geoforge3d', 'generation-1', ?,
		         '2026-08-22T19:00:00.000Z')`,
		[runId, HEAD, `${runId}:${executionId}`],
	);
}

describe("FLY-1981 founder action endpoint integration", () => {
	let root: string;
	let commRoot: string;
	let commPath: string;
	let statePath: string;
	let founderEnvPath: string;
	let store: StateStore;
	let server: http.Server | undefined;
	let baseUrl: string;

	async function startServer(): Promise<void> {
		const app = createBridgeApp(store, projects, makeConfig(statePath));
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((resolve) => server?.once("listening", resolve));
		const address = server.address();
		baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
	}

	async function closeServer(): Promise<void> {
		if (!server) return;
		await new Promise<void>((resolve, reject) => {
			server?.close((error) => (error ? reject(error) : resolve()));
		});
		server = undefined;
	}

	async function postApprove(executionId: string, bodyExtra?: object) {
		const response = await fetch(`${baseUrl}/api/actions/approve`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ execution_id: executionId, ...bodyExtra }),
		});
		return { response, body: await response.json() };
	}

	function openComm(): CommDB {
		return new CommDB(commPath);
	}

	function seedLegacy(executionId = "legacy-exec"): string {
		store.upsertSession({
			execution_id: executionId,
			issue_id: "FLY-1981",
			issue_identifier: "FLY-1981",
			project_name: PROJECT,
			status: "awaiting_review",
			pr_number: 1981,
			pr_head_sha: HEAD,
		});
		store.recordCodexReviewApproved({
			executionId,
			targetPrHeadSha: HEAD,
			issueId: "FLY-1981",
			projectName: PROJECT,
			verdictEventId: `codex-approved-${executionId}`,
		});
		insertHistoricalAutoQaRecord(store, {
			parentExecutionId: executionId,
			targetPrHeadSha: HEAD,
			issueId: "FLY-1981",
			projectName: PROJECT,
			status: "passed",
			verdictEventId: `qa-passed-${executionId}`,
		});
		const comm = openComm();
		try {
			comm.registerSession(
				executionId,
				"runner:window",
				PROJECT,
				"FLY-1981",
				"product-lead",
			);
			const questionId = comm.insertQuestion(
				executionId,
				"product-lead",
				"PR ready",
				{ checkpoint: "approve_to_ship" },
			);
			store.setReviewBinding(executionId, { questionId, prHeadSha: HEAD });
			return questionId;
		} finally {
			comm.close();
		}
	}

	function seedEngine(questionOwner = "engine-carrier"): {
		executionId: string;
		questionId: string;
		runId: string;
	} {
		const runId = "engine-run";
		const executionId = "engine-carrier";
		store.createWorkflowRun({
			runId,
			issueId: "FLY-1981",
			projectName: PROJECT,
			snapshotJson: claimlessLandSnapshot(),
			claimsReadEnrolled: true,
		});
		rawStore(store).run(
			"UPDATE workflow_run SET engine_owned = 1, gate_carrier_epoch = 1, current_node_id = 'craft' WHERE run_id = ?",
			[runId],
		);
		store.upsertSession({
			execution_id: executionId,
			issue_id: "FLY-1981",
			issue_identifier: "FLY-1981",
			project_name: PROJECT,
			status: "running",
		});
		store.upsertWorkflowRunNode({
			runId,
			nodeId: "craft",
			attempt: 1,
			state: "running",
			executionId,
		});
		bindPr(store, runId, executionId);
		const transitioned = store.commitWorkflowTransitionTx({
			runId,
			nodeId: "craft",
			attempt: 1,
			executionId,
			outcome: "node_done",
			subjectDigest: HEAD,
			now: "2026-08-22T19:01:00.000Z",
		});
		expect(transitioned).toMatchObject({ ok: true, gateOpened: true });
		const holder = store.getCurrentWorkflowGateHolder(runId, "decision")!;
		expect(
			store.advanceWorkflowGateHolderMaterialization({
				questionId: holder.question_id,
				stage: "card_bound",
				cardMessageId: "founder-card",
				now: "2026-08-22T19:02:00.000Z",
			}),
		).toMatchObject({ ok: true, state: "awaiting_review" });

		const comm = openComm();
		try {
			comm.registerSession(
				executionId,
				"runner:window",
				PROJECT,
				"FLY-1981",
				"product-lead",
			);
			comm.insertQuestion(
				questionOwner,
				"product-lead",
				"Approve engine land",
				{
					id: holder.question_id,
					checkpoint: "approve_to_ship",
				},
			);
		} finally {
			comm.close();
		}
		return { executionId, questionId: holder.question_id, runId };
	}

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "fly1981-actions-"));
		commRoot = join(root, "comm");
		commPath = join(commRoot, PROJECT, "comm.db");
		statePath = join(root, "teamlead.db");
		founderEnvPath = join(root, "founder.env");
		mkdirSync(join(commRoot, PROJECT), { recursive: true });
		writeFileSync(founderEnvPath, "DISCORD_OWNER_USER_ID=12345678901234567\n");
		process.env.FLYWHEEL_COMM_ROOT = commRoot;
		wakeRunnerMailbox.mockClear();
		store = await StateStore.create(statePath);
		await startServer();
	});

	afterEach(async () => {
		await closeServer();
		try {
			store.close();
		} catch {
			/* already closed by a verify-approval test */
		}
		delete process.env.FLYWHEEL_COMM_ROOT;
		rmSync(root, { recursive: true, force: true });
	});

	it("engine schema-v2 accepts a running carrier, atomically writes one source event, and activates publish only through the real projector", async () => {
		const fixture = seedEngine();

		const first = await postApprove(fixture.executionId);
		expect(first.response.status).toBe(200);
		expect(first.body).toMatchObject({ success: true, gateUnblocked: true });
		const duplicate = await postApprove(fixture.executionId);
		expect(duplicate.response.status).toBe(200);

		const comm = openComm();
		try {
			expect(comm.getResponse(fixture.questionId)).toMatchObject({
				from_agent: "bridge",
				content: JSON.stringify({ approved: true }),
			});
			expect(comm.listWorkflowSourceEvents()).toHaveLength(1);
		} finally {
			comm.close();
		}
		expect(store.getSession(fixture.executionId)?.status).toBe("running");
		expect(
			store.getCurrentWorkflowGateHolder(fixture.runId, "decision"),
		).toMatchObject({ state: "awaiting_review" });
		expect(
			store.getWorkflowRunNode(fixture.runId, "publish", 1),
		).toBeUndefined();
		expect(wakeRunnerMailbox).not.toHaveBeenCalled();

		expect(
			await drainWorkflowSourceEvents({
				projects: [PROJECT],
				openCommDb: () => openComm(),
				store,
			}),
		).toMatchObject({ applied: 1, deadlettered: 0 });
		expect(
			store.getCurrentWorkflowGateHolder(fixture.runId, "decision"),
		).toMatchObject({ state: "approved" });
		expect(store.getWorkflowRun(fixture.runId)).toMatchObject({
			status: "active",
			current_node_id: "publish",
		});
		expect(store.getWorkflowRunNode(fixture.runId, "publish", 1)).toMatchObject(
			{ state: "pending" },
		);
	});

	it("legacy endpoint writes exact Bridge authority, advances and wakes, and real verifyApproval is head-exact", async () => {
		const executionId = "legacy-exec";
		const questionId = seedLegacy(executionId);

		const approved = await postApprove(executionId);
		expect(approved.response.status).toBe(200);
		expect(store.getSession(executionId)).toMatchObject({
			status: "approved_to_ship",
			session_stage: "ship",
		});
		const comm = openComm();
		try {
			expect(comm.getResponse(questionId)).toMatchObject({
				from_agent: "bridge",
				content: JSON.stringify({ approved: true }),
			});
		} finally {
			comm.close();
		}
		expect(wakeRunnerMailbox).toHaveBeenCalledOnce();

		await closeServer();
		store.close();
		expect(
			verifyApproval({
				execId: executionId,
				prHead: HEAD,
				dbPath: commPath,
				stateDbPath: statePath,
				codexDotenvPath: founderEnvPath,
				ciProbe: () => ({ green: true, reason: "ci_green" }),
			}),
		).toMatchObject({
			approved: true,
			reason: "approved",
			questionId,
			responseFrom: "bridge",
		});
		expect(
			verifyApproval({
				execId: executionId,
				prHead: CHANGED_HEAD,
				dbPath: commPath,
				stateDbPath: statePath,
				codexDotenvPath: founderEnvPath,
				ciProbe: () => ({ green: true, reason: "ci_green" }),
			}),
		).toMatchObject({ approved: false, reason: "pr_head_sha_mismatch" });
	});

	it("rejects a Lead-shaped body before touching an otherwise valid legacy gate", async () => {
		const questionId = seedLegacy("lead-body-exec");
		const result = await postApprove("lead-body-exec", {
			leadId: "product-lead",
		});
		expect(result.response.status).toBe(403);
		expect(result.body).toMatchObject({ error: "lead_ack_rejected" });
		const comm = openComm();
		try {
			expect(comm.getResponse(questionId)).toBeUndefined();
		} finally {
			comm.close();
		}
	});

	it.each(["missing", "unbound", "resolved", "superseded", "disposed"])(
		"refuses a %s legacy binding without state advance",
		async (condition) => {
			const executionId = `legacy-${condition}`;
			const questionId = seedLegacy(executionId);
			const comm = openComm();
			try {
				if (condition === "resolved" || condition === "disposed") {
					comm.resolveGate(questionId);
				} else if (condition === "superseded") {
					comm.retireShipGate(questionId, { supersededBy: "replacement" });
				}
			} finally {
				comm.close();
			}
			if (condition === "missing") {
				store.setReviewBinding(executionId, {
					questionId: "00000000-dead-beef-0000-000000000000",
					prHeadSha: HEAD,
				});
			} else if (condition === "unbound") {
				store.setReviewBinding(executionId, {
					questionId: null,
					prHeadSha: HEAD,
				});
			}

			const result = await postApprove(executionId);
			expect(result.response.status).toBe(400);
			expect(store.getSession(executionId)?.status).toBe("awaiting_review");
		},
	);

	it("engine approval refuses a CommDB question owned by another execution", async () => {
		const fixture = seedEngine("wrong-owner");
		const result = await postApprove(fixture.executionId);
		expect(result.response.status).toBe(400);
		expect(
			store.getCurrentWorkflowGateHolder(fixture.runId, "decision"),
		).toMatchObject({ state: "awaiting_review" });
	});
});
