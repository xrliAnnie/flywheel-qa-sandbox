import type Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { afterEach, describe, expect, it } from "vitest";
import type { DeliveryContractClassification } from "../bridge/delivery-contract/types.js";
import { StateStore } from "../StateStore.js";

const stores: StateStore[] = [];
const commDbs: CommDB[] = [];

afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const db of commDbs.splice(0)) db.close();
});

describe("FLY-2278 R4#2 operator-required symmetry", () => {
	it("keeps a terminal mailbox warning closed when a successor appears", async () => {
		const store = await StateStore.create(":memory:");
		stores.push(store);
		const commDb = new CommDB(":memory:");
		commDbs.push(commDb);
		commDb.registerSession(
			"original-execution",
			"flywheel-original",
			"flywheel",
			"FLY-2278",
		);
		commDb.registerSession(
			"replacement-execution",
			"flywheel-replacement",
			"flywheel",
			"FLY-2278",
		);
		commDb.insertInstructionWithId(
			"mail-r4-symmetry",
			"flywheel-eng-lead",
			"original-execution",
			"continue the bounded implementation",
		);
		const runId = "run-r4-symmetry";
		const rootId = "flywheel:FLY-2278:mailbox:mail-r4-symmetry";
		const attemptId = `${rootId}:g1:a1`;
		const openedAt = "2026-09-03T10:00:00.000Z";
		store.createWorkflowRun({
			runId,
			issueId: "FLY-2278",
			projectName: "flywheel",
			snapshotJson: "{}",
			claimsReadEnrolled: true,
		});
		store.upsertSession({
			execution_id: "original-execution",
			issue_id: "FLY-2278",
			project_name: "flywheel",
			status: "completed",
			heartbeat_at: "2026-09-03T09:00:00.000Z",
		});
		store.upsertWorkflowRunNode({
			runId,
			nodeId: "worker",
			attempt: 1,
			state: "completed",
			executionId: "original-execution",
		});
		store.projectWorkflowDeliveryAttempt({
			rootId,
			attemptId,
			family: "mailbox",
			contractRef: { table: "mailbox", pk: "mail-r4-symmetry" },
			mintedAt: "2026-09-03T09:40:00.000Z",
			sentAt: "2026-09-03T09:41:00.000Z",
		});
		const attempt = store
			.listLiveWorkflowDeliveryAttempts()
			.find((candidate) => candidate.attempt_id === attemptId)!;
		store.observeWorkflowDeliveryContract({
			attempt,
			classification: {
				stage: "sent",
				stageEnteredAt: "2026-09-03T09:41:00.000Z",
				terminal: "undeliverable",
				overdue: true,
				severe: false,
			} as DeliveryContractClassification,
			runId,
			projectName: "flywheel",
			issueId: "FLY-2278",
			now: openedAt,
			alertIdentity: {
				leadId: "flywheel-eng-lead",
				projectName: "flywheel",
				leadResolution: "resolved",
			},
		});
		const stateApi = store as unknown as {
			listOpenUndeliverableDeliveryEpisodes?: () => Array<{
				episode_id: string;
			}>;
		};
		const episode = stateApi.listOpenUndeliverableDeliveryEpisodes?.()[0];
		expect(episode).toBeDefined();
		const commRaw = (commDb as unknown as { db: Database.Database }).db;
		commRaw
			.prepare(
				`UPDATE mailbox
				    SET state = 'DEAD', dead_reason = 'recipient_terminal', dead_at = ?
				  WHERE id = ?`,
			)
			.run("2026-09-03T10:14:00.000Z", "mail-r4-symmetry");
		expect(
			store.holdWorkflowUndeliverable({
				episodeId: episode!.episode_id,
				recipientExecutionId: "original-execution",
				commEvidence: {
					recentOutboundInWindow: false,
					observedAtMs: Date.parse("2026-09-03T10:15:00.000Z"),
				},
				now: "2026-09-03T10:15:00.000Z",
				alertIdentity: {
					leadId: "flywheel-eng-lead",
					projectName: "flywheel",
					leadResolution: "resolved",
				},
				terminalMailboxReason: "delivery_undeliverable_no_recipient",
			}),
		).toEqual({ held: false, reason: "operator_required" });
		expect(store.getWorkflowRun(runId)?.status).toBe("active");

		store.upsertSession({
			execution_id: "replacement-execution",
			issue_id: "FLY-2278",
			project_name: "flywheel",
			status: "running",
			workflow_node_id: "worker",
		});
		store.upsertWorkflowRunNode({
			runId,
			nodeId: "worker",
			attempt: 2,
			state: "running",
			executionId: "replacement-execution",
		});
		const modulePath = "../bridge/delivery-operations.js";
		const { DeliveryOperations } = await import(/* @vite-ignore */ modulePath);
		const operations = new DeliveryOperations({
			store,
			commDb,
			projectName: "flywheel",
			resolveRecipient: () => "replacement-execution",
			resolveAlertIdentity: ({ projectName }: { projectName: string }) => ({
				leadId: "flywheel-eng-lead",
				projectName,
				leadResolution: "resolved" as const,
			}),
		});
		expect(operations.runPass("2026-09-03T10:16:00.000Z")).toMatchObject({
			rerouted: 0,
		});
		expect(
			stateApi
				.listOpenUndeliverableDeliveryEpisodes?.()
				.map((row) => row.episode_id),
		).not.toContain(episode!.episode_id);
		const raw = (store as unknown as { db: { raw: Database.Database } }).db.raw;
		expect(
			raw
				.prepare(
					"SELECT closed_reason FROM workflow_delivery_contract_episode WHERE episode_id = ?",
				)
				.get(episode!.episode_id),
		).toEqual({ closed_reason: "terminal:settled:source_terminal" });
		expect(
			store
				.listWorkflowRunEvents(runId)
				.some(({ kind }) => kind === "hold_resumed"),
		).toBe(false);
		expect(
			store.listWorkflowHolds(runId).filter(({ runLevel }) => runLevel),
		).toEqual([]);
		expect(store.getWorkflowRun(runId)?.status).toBe("active");
	});
});
