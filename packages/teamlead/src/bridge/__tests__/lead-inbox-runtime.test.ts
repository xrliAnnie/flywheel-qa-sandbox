import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CommDB } from "flywheel-comm/db";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { encodeSenderRef } from "flywheel-comm/sender-ref";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AlertPayload,
	LeadAlertNotifier,
} from "../../LeadAlertNotifier.js";
import { resolveCodexLeadInboxSocketPath } from "../../lead-backends/codex/CodexLeadInboxSocket.js";
import type { ProjectEntry } from "../../ProjectConfig.js";
import { StateStore } from "../../StateStore.js";
import { LeadDeliveryUnavailableError } from "../lead-delivery-adapter.js";
import {
	LeadInboxRuntime,
	resolveCodexLeadStateDir,
} from "../lead-inbox-runtime.js";
import type { LeadRuntime } from "../lead-runtime.js";
import { RuntimeRegistry } from "../runtime-registry.js";

const runtimes: LeadInboxRuntime[] = [];
afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.close();
	vi.unstubAllEnvs();
});

function runtimeStoreStub(
	recipientState: "alive" | "terminal_or_missing" = "terminal_or_missing",
) {
	return {
		getActiveSessions: () => [],
		resolveRunnerRecipientState: () => ({
			state: recipientState,
		}),
		listDeadLetterAlertCursors: () => [],
		createDeadLetterAlertIntent: vi.fn(),
		listDueDeadLetterAlerts: () => [],
		listUndeliveredLeadInboxEvents: () => [],
		getMailboxLedgerByEventId: () => undefined,
		upsertAlertMailboxLedger: vi.fn(
			(input: {
				eventId: string;
				deliveryId: string;
				toAgent: string;
				requestedOwner: string;
				routeClass: string;
			}) => ({
				disposition: "inserted",
				deliveryProjection: input,
			}),
		),
	};
}

const projects: ProjectEntry[] = [
	{
		projectName: "project-a",
		projectRoot: "/tmp/project-a",
		leads: [
			{
				agentId: "lead-a",
				summaryRole: "producer",
				chatChannel: "chat-a",
				match: { labels: ["Engineering"] },
			},
		],
	},
];

function projectsWithDutyLead(): ProjectEntry[] {
	return [
		{
			...projects[0]!,
			leads: [
				...projects[0]!.leads,
				{
					agentId: "claude-infra-bot-lead",
					summaryRole: "recipient",
					chatChannel: "chat-alerts",
					match: { labels: ["Infra"] },
				},
			],
		},
	];
}

describe("LeadInboxRuntime", () => {
	it("periodically archives terminal mailbox families with audit evidence", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2136-runtime-archive-"));
		const dbPath = join(root, "project-a.db");
		const runtime = new LeadInboxRuntime({
			projects,
			store: runtimeStoreStub() as never,
			registry: new RuntimeRegistry(),
			commDbPathForProject: () => dbPath,
			ownerEpoch: "owner-fly2136-archive",
			runLegacyCutover: () => {},
			adapterForLead: () => ({ deliverBatch: vi.fn() }),
			runnerAdapterForProject: () => ({
				deliver: vi.fn(),
				resolveQuestion: () => undefined,
				close: vi.fn(),
			}),
		});
		runtimes.push(runtime);
		const queue = new MailboxQueue(dbPath);
		const archiveDueFamilies = vi.spyOn(
			MailboxQueue.prototype,
			"archiveDueFamilies",
		);
		const compactArchivedIdentities = vi.spyOn(
			MailboxQueue.prototype,
			"compactArchivedIdentities",
		);
		const drainContentRefGc = vi.spyOn(
			MailboxQueue.prototype,
			"drainContentRefGc",
		);
		try {
			queue.enqueue({
				id: "fly2136-archive-me",
				fromAgent: "lead-a",
				toAgent: "runner-a",
				recipientKind: "runner",
				type: "instruction",
				content: "terminal family",
				createdAt: "2026-08-01T00:00:00.000Z",
				senderRef: encodeSenderRef(),
			});
			queue.ack("fly2136-archive-me", "2026-08-01T00:00:00.000Z");

			runtime.start();
			await vi.waitFor(
				() => expect(queue.getById("fly2136-archive-me")).toBeUndefined(),
				{ timeout: 1_500 },
			);
			expect(archiveDueFamilies).toHaveBeenCalledWith({
				now: expect.any(String),
				maxFamilies: 5,
			});
			expect(compactArchivedIdentities).toHaveBeenCalledWith({
				now: expect.any(String),
				limit: 25,
				onIdentityError: expect.any(Function),
			});
			expect(drainContentRefGc).toHaveBeenCalledWith({
				now: expect.any(String),
				limit: 1,
			});

			const verify = new Database(dbPath, { readonly: true });
			try {
				expect(
					verify
						.prepare(
							"SELECT terminal_at,subject_id FROM mailbox_terminal_archive WHERE id=?",
						)
						.get("fly2136-archive-me"),
				).toEqual({
					terminal_at: "2026-08-01T00:00:00.000Z",
					subject_id: "fly2136-archive-me",
				});
				expect(
					verify.prepare("SELECT count(*) AS n FROM mailbox_identity").get(),
				).toEqual({ n: 0 });
			} finally {
				verify.close();
			}
		} finally {
			drainContentRefGc.mockRestore();
			compactArchivedIdentities.mockRestore();
			archiveDueFamilies.mockRestore();
			queue.close();
		}
	});

	it("can disable only the new cold compactor at runtime", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2341-runtime-disabled-"));
		const runtime = new LeadInboxRuntime({
			projects,
			store: runtimeStoreStub() as never,
			registry: new RuntimeRegistry(),
			commDbPathForProject: () => join(root, "project-a.db"),
			ownerEpoch: "owner-fly2341-disabled",
			archiveEnabled: () => false,
			runLegacyCutover: () => {},
			adapterForLead: () => ({ deliverBatch: vi.fn() }),
			runnerAdapterForProject: () => ({
				deliver: vi.fn(),
				resolveQuestion: () => undefined,
				close: vi.fn(),
			}),
		});
		runtimes.push(runtime);
		const familyArchive = vi.spyOn(
			MailboxQueue.prototype,
			"archiveDueFamilies",
		);
		const coldCompact = vi.spyOn(
			MailboxQueue.prototype,
			"compactArchivedIdentities",
		);
		try {
			runtime.start();
			await vi.waitFor(() => expect(familyArchive).toHaveBeenCalledTimes(1));
			expect(coldCompact).not.toHaveBeenCalled();
		} finally {
			coldCompact.mockRestore();
			familyArchive.mockRestore();
		}
	});

	it("throttles a persistently failing archive attempt", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2136-archive-failure-"));
		const runtime = new LeadInboxRuntime({
			projects,
			store: runtimeStoreStub() as never,
			registry: new RuntimeRegistry(),
			commDbPathForProject: () => join(root, "project-a.db"),
			ownerEpoch: "owner-fly2136-archive-failure",
			runLegacyCutover: () => {},
			adapterForLead: () => ({ deliverBatch: vi.fn() }),
			runnerAdapterForProject: () => ({
				deliver: vi.fn(),
				resolveQuestion: () => undefined,
				close: vi.fn(),
			}),
		});
		runtimes.push(runtime);
		const archive = vi
			.spyOn(MailboxQueue.prototype, "archiveDueFamilies")
			.mockImplementation(() => {
				throw new Error("persistent archive failure");
			});
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			runtime.start();
			await vi.waitFor(() => expect(archive).toHaveBeenCalledTimes(1));
			runtime.nudge("lead-a", "project-a");
			await new Promise<void>((resolve) => setTimeout(resolve, 100));
			expect(archive).toHaveBeenCalledTimes(1);
			expect(warning).toHaveBeenCalledWith(
				expect.stringContaining("persistent archive failure"),
			);
		} finally {
			warning.mockRestore();
			archive.mockRestore();
		}
	});

	it("throttles dead-letter reconciliation while leaving alert draining live", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2136-alert-throttle-"));
		const dbPath = join(root, "project-a.db");
		const store = runtimeStoreStub();
		const runtime = new LeadInboxRuntime({
			projects,
			store: store as never,
			registry: new RuntimeRegistry(),
			commDbPathForProject: () => dbPath,
			ownerEpoch: "owner-fly2136-alert-throttle",
			runLegacyCutover: () => {},
			adapterForLead: () => ({ deliverBatch: vi.fn() }),
			runnerAdapterForProject: () => ({
				deliver: vi.fn(),
				resolveQuestion: () => undefined,
				close: vi.fn(),
			}),
		});
		runtimes.push(runtime);
		const queue = new MailboxQueue(dbPath);
		try {
			queue.enqueue({
				id: "fly2136-dead-lead",
				fromAgent: "runner-a",
				toAgent: "retired-lead",
				recipientKind: "lead",
				type: "question",
				content: "unacknowledged",
				senderRef: encodeSenderRef(),
			});
			queue.markDead(
				"fly2136-dead-lead",
				new Date().toISOString(),
				"lease_expired_unacked",
			);

			runtime.start();
			await vi.waitFor(() =>
				expect(store.createDeadLetterAlertIntent).toHaveBeenCalledTimes(1),
			);
			runtime.nudge("lead-a", "project-a");
			await new Promise<void>((resolve) => setTimeout(resolve, 100));
			expect(store.createDeadLetterAlertIntent).toHaveBeenCalledTimes(1);
		} finally {
			queue.close();
		}
	});

	it("FLY-2018: admit redrives a committed replacement event and duplicate scans stay quiet", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2018-redrive-"));
		const dbPath = join(root, "project-a.db");
		const store = await StateStore.create(":memory:");
		const payload = {
			event_type: "workflow_replacement_eligibility",
			execution_id: "exec-1",
			issue_id: "FLY-2018",
			project_name: "project-a",
			workflow_event_id: "workflow-replacement-eligibility:run:node:1:exec-1:1",
			next_check_at: "2026-08-24T00:14:00.000Z",
			next_check_disposition: "replacement_candidate",
			blind_replacements: 0,
			max_blind_replacements: 3,
		};
		store.appendLeadEvent(
			"lead-a",
			payload.workflow_event_id,
			payload.event_type,
			JSON.stringify(payload),
			"wf:run",
		);
		const registry = new RuntimeRegistry();
		registry.register(projects[0]!.leads[0]!, {
			type: "commdb",
			renderEnvelope: (envelope) => JSON.stringify(envelope.event),
			deliver: async () => ({ delivered: false }),
			sendBootstrap: async () => {},
			health: () => ({ healthy: true }),
			shutdown: async () => {},
		});
		let ticks = 0;
		const runtime = new LeadInboxRuntime({
			projects,
			store,
			registry,
			commDbPathForProject: () => dbPath,
			ownerEpoch: "owner-fly2018",
			runLegacyCutover: () => {},
			afterTickStartedForLead: async () => {
				ticks += 1;
			},
			adapterForLead: () => ({
				async deliverBatch() {
					throw new LeadDeliveryUnavailableError("lead", "offline");
				},
			}),
		});
		runtimes.push(runtime);
		runtime.start();
		const deliveryId = `lead_event:lead-a:${payload.workflow_event_id}`;
		await vi.waitFor(() =>
			expect(
				runtime.getLeadEventSettlement("project-a", deliveryId).kind,
			).not.toBe("missing"),
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
		expect(ticks).toBeLessThan(6);
		expect(store.getLeadEventBySeq(1)?.delivered_at).toBeUndefined();
		store.close();
	});

	it("FLY-2152: admit redrives an owner/project-scoped workflow claim event", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2152-claim-redrive-"));
		const dbPath = join(root, "project-a.db");
		const store = await StateStore.create(":memory:");
		const claimPayload = {
			event_type: "workflow_claim_recorded",
			execution_id: "qa-exec",
			issue_id: "FLY-2152",
			project_name: "project-a",
			workflow_run_id: "run-2152",
			workflow_node_id: "qa",
			workflow_attempt: 1,
			workflow_claim_id: 554,
			workflow_decision_kind: "qa_verdict",
			workflow_predicate: "qa_failed",
			workflow_issued_at: "2026-08-29T06:43:00.000Z",
			summary: "QA verdict recorded",
		};
		const claimSeq = store.appendLeadEvent(
			"lead-a",
			"workflow_claim:554",
			"workflow_claim_recorded",
			JSON.stringify(claimPayload),
			"wf:run-2152",
		);
		const wrongProjectSeq = store.appendLeadEvent(
			"lead-a",
			"workflow_claim:555",
			"workflow_claim_recorded",
			JSON.stringify({ ...claimPayload, project_name: "project-b" }),
			"wf:run-2152",
		);
		const registry = new RuntimeRegistry();
		registry.register(projects[0]!.leads[0]!, {
			type: "commdb",
			renderEnvelope: (envelope) => JSON.stringify(envelope.event),
			deliver: async () => ({ delivered: true }),
			sendBootstrap: async () => {},
			health: () => ({ healthy: true }),
			shutdown: async () => {},
		});
		const deliverBatch = vi.fn(async (batch) => ({
			batchId: batch.batchId,
			memberIds: batch.members.map((member) => member.deliveryId),
			status: "accepted_new" as const,
		}));
		const runtime = new LeadInboxRuntime({
			projects,
			store,
			registry,
			commDbPathForProject: () => dbPath,
			ownerEpoch: "owner-fly2152",
			runLegacyCutover: () => {},
			adapterForLead: () => ({ deliverBatch }),
		});
		runtimes.push(runtime);
		runtime.start();
		await vi.waitFor(() =>
			expect(store.getLeadEventBySeq(claimSeq)?.delivered_at).toEqual(
				expect.any(String),
			),
		);
		expect(
			store.getLeadEventBySeq(wrongProjectSeq)?.delivered_at,
		).toBeUndefined();
		expect(deliverBatch).toHaveBeenCalledTimes(1);
		expect(deliverBatch.mock.calls[0]?.[0].modelPayload).toContain(
			'"workflow_claim_id":554',
		);
		store.close();
	});

	it("FLY-2152: one failed claim redrive does not block later rows", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2152-redrive-isolation-"));
		const dbPath = join(root, "project-a.db");
		const store = await StateStore.create(":memory:");
		const claimPayload = {
			event_type: "workflow_claim_recorded",
			execution_id: "qa-exec",
			issue_id: "FLY-2152",
			project_name: "project-a",
			workflow_run_id: "run-2152",
			workflow_node_id: "qa",
			workflow_attempt: 1,
			workflow_decision_kind: "qa_verdict",
			workflow_predicate: "qa_failed",
			workflow_issued_at: "2026-08-29T06:43:00.000Z",
			summary: "QA verdict recorded",
		};
		const poisonSeq = store.appendLeadEvent(
			"lead-a",
			"workflow_claim:poison",
			"workflow_claim_recorded",
			JSON.stringify({ ...claimPayload, workflow_claim_id: 555 }),
			"wf:run-2152",
		);
		const healthySeq = store.appendLeadEvent(
			"lead-a",
			"workflow_claim:healthy",
			"workflow_claim_recorded",
			JSON.stringify({ ...claimPayload, workflow_claim_id: 556 }),
			"wf:run-2152",
		);
		const registry = new RuntimeRegistry();
		registry.register(projects[0]!.leads[0]!, {
			type: "commdb",
			renderEnvelope: (envelope) => {
				if (envelope.seq === poisonSeq) throw new Error("poison render");
				return JSON.stringify(envelope.event);
			},
			deliver: async () => ({ delivered: true }),
			sendBootstrap: async () => {},
			health: () => ({ healthy: true }),
			shutdown: async () => {},
		});
		const deliverBatch = vi.fn(async (batch) => ({
			batchId: batch.batchId,
			memberIds: batch.members.map((member) => member.deliveryId),
			status: "accepted_new" as const,
		}));
		const runtime = new LeadInboxRuntime({
			projects,
			store,
			registry,
			commDbPathForProject: () => dbPath,
			ownerEpoch: "owner-fly2152-isolation",
			runLegacyCutover: () => {},
			adapterForLead: () => ({ deliverBatch }),
		});
		runtimes.push(runtime);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			runtime.start();
			await vi.waitFor(
				() =>
					expect(store.getLeadEventBySeq(healthySeq)?.delivered_at).toEqual(
						expect.any(String),
					),
				{ timeout: 2_000 },
			);
			expect(store.getLeadEventBySeq(poisonSeq)?.delivered_at).toBeUndefined();
			expect(warn).toHaveBeenCalledWith(
				"[lead-inbox-runtime] lead event redrive failed",
				{
					leadId: "lead-a",
					projectName: "project-a",
					seq: poisonSeq,
					eventType: "workflow_claim_recorded",
					errorName: "Error",
				},
			);
		} finally {
			warn.mockRestore();
			store.close();
		}
	});

	it("keeps post-boot Lead mail live when the current roster recognizes the recipient", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1773-current-roster-"));
		const dbPath = join(root, "project-a.db");
		const runtime = new LeadInboxRuntime({
			projects,
			store: runtimeStoreStub() as never,
			registry: new RuntimeRegistry(),
			commDbPathForProject: () => dbPath,
			ownerEpoch: "owner-current-roster",
			currentLeadRecipientsForProject: () => ["lead-a", "lead-new"],
		});
		runtimes.push(runtime);
		const queue = new MailboxQueue(dbPath);
		try {
			queue.enqueue({
				id: "founder-to-new-lead",
				fromAgent: "founder",
				toAgent: "lead-new",
				recipientKind: "lead",
				type: "instruction",
				content: "must survive the stale boot snapshot",
				senderRef: encodeSenderRef(),
			});

			expect(runtime.reconcileRetiredLeadMailboxes()).toEqual({
				dead: 0,
				remaining: false,
			});
			expect(queue.getById("founder-to-new-lead")).toMatchObject({
				state: "QUEUED",
			});
		} finally {
			queue.close();
		}
	});

	it("fails closed when the current Lead roster cannot be read", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1773-roster-fail-closed-"));
		const dbPath = join(root, "project-a.db");
		const runtime = new LeadInboxRuntime({
			projects,
			store: runtimeStoreStub() as never,
			registry: new RuntimeRegistry(),
			commDbPathForProject: () => dbPath,
			ownerEpoch: "owner-roster-fail-closed",
			currentLeadRecipientsForProject: () => {
				throw new Error("fleet config temporarily unreadable");
			},
		});
		runtimes.push(runtime);
		const queue = new MailboxQueue(dbPath);
		try {
			queue.enqueue({
				id: "unknown-during-config-failure",
				fromAgent: "founder",
				toAgent: "lead-maybe-live",
				recipientKind: "lead",
				type: "instruction",
				content: "do not destroy without roster authority",
				senderRef: encodeSenderRef(),
			});

			expect(runtime.reconcileRetiredLeadMailboxes()).toEqual({
				dead: 0,
				remaining: true,
			});
			expect(queue.getById("unknown-during-config-failure")).toMatchObject({
				state: "QUEUED",
			});
		} finally {
			queue.close();
		}
	});

	it("fails open for liveness when the canonical lease store cannot open", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1773-lease-open-"));
		const blocker = join(root, "not-a-directory");
		writeFileSync(blocker, "occupied");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		let runtime: LeadInboxRuntime | undefined;
		try {
			expect(() => {
				runtime = new LeadInboxRuntime({
					projects,
					store: runtimeStoreStub() as never,
					registry: new RuntimeRegistry(),
					commDbPathForProject: () => join(root, "project-a.db"),
					leadLeaseDbPath: join(blocker, "lead-lease.db"),
				});
			}).not.toThrow();
			expect(warning).toHaveBeenCalledWith(
				expect.stringContaining("Lead lease reader unavailable"),
			);
		} finally {
			runtime?.close();
			warning.mockRestore();
		}
	});

	it("round-robins retired Lead sweeps even when the first backlog keeps growing", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1773-retired-sweep-"));
		const dbPath = join(root, "project-a.db");
		const closeLeaseReader = vi.fn();
		const runtime = new LeadInboxRuntime({
			projects,
			store: runtimeStoreStub() as never,
			registry: new RuntimeRegistry(),
			commDbPathForProject: () => dbPath,
			ownerEpoch: "owner-retired-sweep",
			leadLeaseReader: { getLease: () => undefined, close: closeLeaseReader },
		});
		runtimes.push(runtime);
		const queue = new MailboxQueue(dbPath);
		try {
			for (const id of ["retired-a-1", "retired-a-2"]) {
				queue.enqueue({
					id,
					fromAgent: "runner-a",
					toAgent: "retired-a",
					recipientKind: "lead",
					type: "question",
					content: id,
					senderRef: encodeSenderRef(),
				});
			}
			queue.enqueue({
				id: "retired-b-1",
				fromAgent: "runner-b",
				toAgent: "retired-b",
				recipientKind: "lead",
				type: "question",
				content: "retired-b-1",
				senderRef: encodeSenderRef(),
			});

			expect(
				runtime.reconcileRetiredLeadMailboxes({
					maxRecipientsPerProject: 1,
					maxRowsPerRecipient: 1,
				}),
			).toMatchObject({ dead: 1, remaining: true });
			queue.enqueue({
				id: "retired-a-new",
				fromAgent: "runner-a",
				toAgent: "retired-a",
				recipientKind: "lead",
				type: "question",
				content: "keeps growing",
				senderRef: encodeSenderRef(),
			});
			runtime.reconcileRetiredLeadMailboxes({
				maxRecipientsPerProject: 1,
				maxRowsPerRecipient: 1,
			});
			expect(queue.getById("retired-b-1")).toMatchObject({
				state: "DEAD",
				dead_reason: "recipient_terminal",
			});
		} finally {
			queue.close();
		}
		runtime.close();
		runtimes.splice(runtimes.indexOf(runtime), 1);
		expect(closeLeaseReader).toHaveBeenCalledOnce();
	});

	it("writes one infra alert to the owner mailbox and nudges it immediately", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1764-owner-alert-"));
		const dbPath = join(root, "project-a.db");
		const runtime = new LeadInboxRuntime({
			projects,
			store: runtimeStoreStub() as never,
			registry: new RuntimeRegistry(),
			commDbPathForProject: () => dbPath,
		});
		runtimes.push(runtime);
		const nudge = vi.spyOn(runtime, "nudge");
		const alert: AlertPayload = {
			leadId: "swap",
			projectName: "machine",
			eventId: "swap-pressure:episode-1764",
			eventType: "swap_pressure_high",
			title: "Memory pressure",
			body: "pressure-hold is active",
			severity: "severe",
			episodeId: "episode-1764",
		};

		const first = runtime.enqueueInfraAlert("lead-a", alert);
		const replay = runtime.enqueueInfraAlert("lead-a", alert);

		expect(first).toMatchObject({
			queued: true,
			deliveryId:
				"infra_alert:lead-a:swap_pressure_high:swap-pressure:episode-1764",
		});
		expect(replay).toEqual(first);
		expect(nudge).toHaveBeenCalledTimes(2);
		expect(nudge).toHaveBeenLastCalledWith("lead-a", "project-a");
		const queue = new MailboxQueue(dbPath);
		try {
			const row = queue.getById(first.deliveryId);
			expect(row).toMatchObject({
				from_agent: "bridge",
				to_agent: "lead-a",
				recipient_kind: "lead",
				source_kind: "infra_alert",
				source_ref: "swap-pressure:episode-1764",
				type: "swap_pressure_high",
				msg_class: "model",
				priority: 3,
				collapse_key: "infra_alert:swap_pressure_high:episode-1764",
				state: "QUEUED",
			});
			expect(row?.content).toContain("Memory pressure");
			expect(row?.content).toContain("pressure-hold is active");
			const snapshot = new Database(dbPath, { readonly: true });
			try {
				expect(
					snapshot.prepare("SELECT COUNT(*) AS count FROM mailbox").get(),
				).toEqual({ count: 1 });
			} finally {
				snapshot.close();
			}
		} finally {
			queue.close();
		}
	});

	it("reroutes an unowned alert to duty before writing the recipient mailbox", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2386-duty-reroute-"));
		const dbPath = join(root, "project-a.db");
		const store = await StateStore.create(":memory:");
		const dutyProjects = [
			{
				...projects[0]!,
				leads: [
					...projects[0]!.leads,
					{
						agentId: "claude-infra-bot-lead",
						summaryRole: "recipient",
						chatChannel: "chat-alerts",
						match: { labels: ["Infra"] },
					},
				],
			},
		] as ProjectEntry[];
		const runtime = new LeadInboxRuntime({
			projects: dutyProjects,
			store,
			registry: new RuntimeRegistry(),
			commDbPathForProject: () => dbPath,
			isDutyConfigured: () => true,
		});
		runtimes.push(runtime);
		const result = runtime.enqueueInfraAlert("lead-a", {
			leadId: "lead-a",
			projectName: "project-a",
			eventId: "bridge-exit-1",
			eventType: "bridge_abnormal_exit",
			title: "Bridge exited",
			body: "unexpected exit",
			severity: "severe",
		});
		const directDuty = runtime.enqueueInfraAlert("claude-infra-bot-lead", {
			leadId: "lead-a",
			projectName: "project-a",
			sessionKey: "duty-direct",
			eventId: "bridge-exit-duty",
			eventType: "bridge_abnormal_exit",
			title: "Bridge exited",
			body: "already assigned to duty",
			severity: "warning",
		});

		expect(result).toMatchObject({ queued: true });
		expect(runtime.reroutedCount).toBe(1);
		expect(runtime.isLeadQueueOpen("claude-infra-bot-lead")).toBe(true);
		expect(runtime.isLeadQueueOpen("missing-lead")).toBe(false);
		const queue = new MailboxQueue(dbPath);
		try {
			expect(queue.getById(result.deliveryId)).toEqual(
				expect.objectContaining({ to_agent: "claude-infra-bot-lead" }),
			);
			expect(queue.getById(directDuty.deliveryId)).toEqual(
				expect.objectContaining({ to_agent: "claude-infra-bot-lead" }),
			);
			const snapshot = new Database(dbPath, { readonly: true });
			try {
				expect(
					snapshot
						.prepare(
							"SELECT COUNT(*) AS count FROM mailbox WHERE to_agent='lead-a' AND source_kind='infra_alert'",
						)
						.get(),
				).toEqual({ count: 0 });
			} finally {
				snapshot.close();
			}
		} finally {
			queue.close();
		}
		expect(store.getMailboxLedgerByEventId("bridge-exit-1")).toEqual(
			expect.objectContaining({
				to_agent: "claude-infra-bot-lead",
				requested_owner: "lead-a",
				route_class: "duty_reroute",
				ticket_status: "NEW",
			}),
		);
		expect(store.getMailboxLedgerByEventId("bridge-exit-duty")).toEqual(
			expect.objectContaining({
				to_agent: "claude-infra-bot-lead",
				requested_owner: "claude-infra-bot-lead",
				route_class: "duty",
				ticket_status: "NEW",
			}),
		);
		store.close();
	});

	it("keeps direct-owner alerts and duty-unconfigured fallbacks in the requested Lead inbox", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2386-owner-tiers-"));
		const dbPath = join(root, "project-a.db");
		const store = await StateStore.create(":memory:");
		const dutyProjects = [
			{
				...projects[0]!,
				leads: [
					...projects[0]!.leads,
					{
						agentId: "claude-infra-bot-lead",
						summaryRole: "recipient",
						chatChannel: "chat-alerts",
						match: { labels: ["Infra"] },
					},
				],
			},
		] as ProjectEntry[];
		const runtime = new LeadInboxRuntime({
			projects: dutyProjects,
			store,
			registry: new RuntimeRegistry(),
			commDbPathForProject: () => dbPath,
			isDutyConfigured: () => false,
		});
		runtimes.push(runtime);

		const direct = runtime.enqueueInfraAlert("lead-a", {
			leadId: "lead-a",
			projectName: "project-a",
			eventId: "review-failed-1",
			eventType: "review_job_failed",
			title: "Review failed",
			body: "review owner action required",
			severity: "warning",
		});
		const fallback = runtime.enqueueInfraAlert("lead-a", {
			leadId: "lead-a",
			projectName: "project-a",
			eventId: "bridge-exit-2",
			eventType: "bridge_abnormal_exit",
			title: "Bridge exited",
			body: "duty unavailable",
			severity: "severe",
		});

		const queue = new MailboxQueue(dbPath);
		try {
			expect(queue.getById(direct.deliveryId)?.to_agent).toBe("lead-a");
			expect(queue.getById(fallback.deliveryId)?.to_agent).toBe("lead-a");
		} finally {
			queue.close();
		}
		expect(store.getMailboxLedgerByEventId("review-failed-1")).toEqual(
			expect.objectContaining({
				route_class: "direct_owner",
				ticket_status: "ESCALATED",
				owner_ref: "lead:lead-a",
				handoff_delivery_id: direct.deliveryId,
			}),
		);
		expect(store.getMailboxLedgerByEventId("bridge-exit-2")).toEqual(
			expect.objectContaining({
				route_class: "duty_fallback",
				ticket_status: "ESCALATED",
				owner_ref: "lead:lead-a",
				handoff_delivery_id: fallback.deliveryId,
			}),
		);
		store.close();
	});

	it("reseeds a changed recipient only when the canonical mailbox identity is absent", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2386-absent-reseed-"));
		const dbPath = join(root, "project-a.db");
		const store = await StateStore.create(":memory:");
		const dutyProjects = [
			{
				...projects[0]!,
				leads: [
					...projects[0]!.leads,
					{
						agentId: "claude-infra-bot-lead",
						summaryRole: "recipient",
						chatChannel: "chat-alerts",
						match: { labels: ["Infra"] },
					},
				],
			},
		] as ProjectEntry[];
		store.upsertAlertMailboxLedger(
			{
				correlationKey: "project-a|lead-a|bridge_abnormal_exit|",
				eventId: "bridge-exit-reseed",
				deliveryId:
					"infra_alert:claude-infra-bot-lead:bridge_abnormal_exit:bridge-exit-reseed",
				toAgent: "claude-infra-bot-lead",
				requestedOwner: "lead-a",
				routeClass: "duty_reroute",
				leadId: "lead-a",
				projectName: "project-a",
				eventType: "bridge_abnormal_exit",
			},
			{ allowReseed: false },
		);
		const runtime = new LeadInboxRuntime({
			projects: dutyProjects,
			store,
			registry: new RuntimeRegistry(),
			commDbPathForProject: () => dbPath,
			isDutyConfigured: () => false,
		});
		runtimes.push(runtime);

		const result = runtime.enqueueInfraAlert("lead-a", {
			leadId: "lead-a",
			projectName: "project-a",
			eventId: "bridge-exit-reseed",
			eventType: "bridge_abnormal_exit",
			title: "Bridge exited",
			body: "retry after pre-enqueue crash",
			severity: "severe",
		});

		expect(result.deliveryId).toBe(
			"infra_alert:lead-a:bridge_abnormal_exit:bridge-exit-reseed",
		);
		expect(store.getMailboxLedgerByEventId("bridge-exit-reseed")).toEqual(
			expect.objectContaining({
				to_agent: "lead-a",
				route_class: "duty_fallback",
			}),
		);
		store.close();
	});

	it("falls back once to the requested Lead when the duty enqueue throws", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2386-duty-enqueue-fallback-"));
		const dbPath = join(root, "project-a.db");
		const store = await StateStore.create(":memory:");
		const dutyProjects = [
			{
				...projects[0]!,
				leads: [
					...projects[0]!.leads,
					{
						agentId: "claude-infra-bot-lead",
						summaryRole: "recipient",
						chatChannel: "chat-alerts",
						match: { labels: ["Infra"] },
					},
				],
			},
		] as ProjectEntry[];
		const runtime = new LeadInboxRuntime({
			projects: dutyProjects,
			store,
			registry: new RuntimeRegistry(),
			commDbPathForProject: () => dbPath,
			isDutyConfigured: () => true,
		});
		runtimes.push(runtime);
		const realEnqueue = MailboxQueue.prototype.enqueue;
		const enqueue = vi
			.spyOn(MailboxQueue.prototype, "enqueue")
			.mockImplementation(function (input) {
				if (input.toAgent === "claude-infra-bot-lead") {
					throw new Error("duty queue unavailable");
				}
				return realEnqueue.call(this, input);
			});

		try {
			const result = runtime.enqueueInfraAlert("lead-a", {
				leadId: "lead-a",
				projectName: "project-a",
				eventId: "bridge-exit-enqueue-fallback",
				eventType: "bridge_abnormal_exit",
				title: "Bridge exited",
				body: "duty queue write failed",
				severity: "severe",
			});
			expect(result.deliveryId).toBe(
				"infra_alert:lead-a:bridge_abnormal_exit:bridge-exit-enqueue-fallback",
			);
			expect(
				store.getMailboxLedgerByEventId(result.deliveryId.split(":").at(-1)!),
			).toEqual(
				expect.objectContaining({
					to_agent: "lead-a",
					route_class: "duty_fallback",
					ticket_status: "ESCALATED",
				}),
			);
			expect(enqueue).toHaveBeenCalledTimes(2);
		} finally {
			enqueue.mockRestore();
			store.close();
		}
	});

	it("attempts duty and requested owner exactly once when both enqueues throw", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2386-bounded-fallback-"));
		const dbPath = join(root, "project-a.db");
		const store = await StateStore.create(":memory:");
		const runtime = new LeadInboxRuntime({
			projects: projectsWithDutyLead(),
			store,
			registry: new RuntimeRegistry(),
			commDbPathForProject: () => dbPath,
			isDutyConfigured: () => true,
		});
		runtimes.push(runtime);
		const recipients: string[] = [];
		const enqueue = vi
			.spyOn(MailboxQueue.prototype, "enqueue")
			.mockImplementation((input) => {
				recipients.push(input.toAgent);
				throw new Error(`queue unavailable: ${input.toAgent}`);
			});

		try {
			expect(() =>
				runtime.enqueueInfraAlert("lead-a", {
					leadId: "lead-a",
					projectName: "project-a",
					eventId: "bridge-exit-both-unavailable",
					eventType: "bridge_abnormal_exit",
					title: "Bridge exited",
					body: "both queues unavailable",
					severity: "severe",
				}),
			).toThrowError("queue unavailable: lead-a");
			expect(recipients).toEqual(["claude-infra-bot-lead", "lead-a"]);
			expect(
				store.getMailboxLedgerByEventId("bridge-exit-both-unavailable"),
			).toEqual(
				expect.objectContaining({
					to_agent: "lead-a",
					route_class: "duty_fallback",
					ticket_status: "ESCALATED",
				}),
			);
		} finally {
			enqueue.mockRestore();
			store.close();
		}
	});

	it("fails open to mailbox delivery when the ledger write fails and alerts once", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2386-ledger-fail-open-"));
		const dbPath = join(root, "project-a.db");
		const store = {
			...runtimeStoreStub(),
			upsertAlertMailboxLedger: vi.fn(() => {
				throw new Error("ledger unavailable");
			}),
		};
		const onLedgerWriteFailure = vi.fn(() => {
			throw new Error("meta alert unavailable");
		});
		const runtime = new LeadInboxRuntime({
			projects,
			store: store as never,
			registry: new RuntimeRegistry(),
			commDbPathForProject: () => dbPath,
			isDutyConfigured: () => false,
			onLedgerWriteFailure,
		});
		runtimes.push(runtime);

		for (const suffix of ["one", "two"]) {
			expect(
				runtime.enqueueInfraAlert("lead-a", {
					leadId: "lead-a",
					projectName: "project-a",
					eventId: `ledger-failure-${suffix}`,
					eventType: "bridge_abnormal_exit",
					title: "Bridge exited",
					body: "ledger failed",
					severity: "warning",
				}),
			).toMatchObject({ queued: true });
		}
		expect(runtime.ledgerWriteErrors).toBe(2);
		expect(onLedgerWriteFailure).toHaveBeenCalledOnce();
		const snapshot = new Database(dbPath, { readonly: true });
		try {
			expect(
				snapshot
					.prepare(
						"SELECT COUNT(*) AS count FROM mailbox WHERE source_kind='infra_alert'",
					)
					.get(),
			).toEqual({ count: 2 });
		} finally {
			snapshot.close();
		}
	});

	it("records the disposition before attempting mailbox delivery", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2386-ledger-before-mailbox-"));
		const dbPath = join(root, "project-a.db");
		const order: string[] = [];
		const baseStore = runtimeStoreStub();
		const store = {
			...baseStore,
			upsertAlertMailboxLedger: vi.fn((input) => {
				order.push("ledger");
				return baseStore.upsertAlertMailboxLedger(input);
			}),
		};
		const runtime = new LeadInboxRuntime({
			projects,
			store: store as never,
			registry: new RuntimeRegistry(),
			commDbPathForProject: () => dbPath,
			isDutyConfigured: () => false,
		});
		runtimes.push(runtime);
		const realEnqueue = MailboxQueue.prototype.enqueue;
		const enqueue = vi
			.spyOn(MailboxQueue.prototype, "enqueue")
			.mockImplementation(function (input) {
				order.push("mailbox");
				return realEnqueue.call(this, input);
			});
		try {
			runtime.enqueueInfraAlert("lead-a", {
				leadId: "lead-a",
				projectName: "project-a",
				eventId: "ordered-alert",
				eventType: "bridge_abnormal_exit",
				title: "Bridge exited",
				body: "order proof",
				severity: "warning",
			});
			expect(order).toEqual(["ledger", "mailbox"]);
		} finally {
			enqueue.mockRestore();
		}
	});

	it("keeps the canonical live recipient when duty availability changes", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2386-canonical-recipient-"));
		const dbPath = join(root, "project-a.db");
		const store = await StateStore.create(":memory:");
		const dutyProjects = projectsWithDutyLead();
		const alert: AlertPayload = {
			leadId: "lead-a",
			projectName: "project-a",
			eventId: "bridge-exit-canonical-duty",
			eventType: "bridge_abnormal_exit",
			title: "Bridge exited",
			body: "availability changed",
			severity: "severe",
		};
		const dutyRuntime = new LeadInboxRuntime({
			projects: dutyProjects,
			store,
			registry: new RuntimeRegistry(),
			commDbPathForProject: () => dbPath,
			isDutyConfigured: () => true,
		});
		const first = dutyRuntime.enqueueInfraAlert("lead-a", alert);
		dutyRuntime.close();
		const ownerRuntime = new LeadInboxRuntime({
			projects: dutyProjects,
			store,
			registry: new RuntimeRegistry(),
			commDbPathForProject: () => dbPath,
			isDutyConfigured: () => false,
		});
		runtimes.push(ownerRuntime);

		expect(ownerRuntime.enqueueInfraAlert("lead-a", alert)).toEqual(first);
		const fallbackAlert: AlertPayload = {
			...alert,
			eventId: "bridge-exit-canonical-owner",
		};
		const fallback = ownerRuntime.enqueueInfraAlert("lead-a", fallbackAlert);
		ownerRuntime.close();
		runtimes.splice(runtimes.indexOf(ownerRuntime), 1);
		const restoredDutyRuntime = new LeadInboxRuntime({
			projects: dutyProjects,
			store,
			registry: new RuntimeRegistry(),
			commDbPathForProject: () => dbPath,
			isDutyConfigured: () => true,
		});
		runtimes.push(restoredDutyRuntime);
		expect(
			restoredDutyRuntime.enqueueInfraAlert("lead-a", fallbackAlert),
		).toEqual(fallback);
		const snapshot = new Database(dbPath, { readonly: true });
		try {
			expect(
				snapshot
					.prepare(
						"SELECT to_agent,COUNT(*) AS count FROM mailbox GROUP BY to_agent",
					)
					.all(),
			).toEqual([
				{ to_agent: "claude-infra-bot-lead", count: 1 },
				{ to_agent: "lead-a", count: 1 },
			]);
		} finally {
			snapshot.close();
			store.close();
		}
	});

	it("writes the canonical ledger before skipping an archived delivery", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly2386-archived-canonical-"));
		const dbPath = join(root, "project-a.db");
		const store = await StateStore.create(":memory:");
		const deliveryId =
			"infra_alert:claude-infra-bot-lead:bridge_abnormal_exit:archived-canonical";
		store.upsertAlertMailboxLedger(
			{
				correlationKey: "project-a|lead-a|bridge_abnormal_exit|",
				eventId: "archived-canonical",
				deliveryId,
				toAgent: "claude-infra-bot-lead",
				requestedOwner: "lead-a",
				routeClass: "duty_reroute",
				leadId: "lead-a",
				projectName: "project-a",
				eventType: "bridge_abnormal_exit",
			},
			{ allowReseed: false },
		);
		const ledgerWrite = vi.spyOn(store, "upsertAlertMailboxLedger");
		const runtime = new LeadInboxRuntime({
			projects: projectsWithDutyLead(),
			store,
			registry: new RuntimeRegistry(),
			commDbPathForProject: () => dbPath,
			isDutyConfigured: () => false,
		});
		runtimes.push(runtime);
		const inspect = vi
			.spyOn(MailboxQueue.prototype, "inspectDeliveryState")
			.mockReturnValue({
				kind: "archived_terminal",
				state: "ACKED",
				settledAt: "2026-09-06T00:00:00.000Z",
				deadReason: null,
				lastError: null,
				createdAt: "2026-09-05T00:00:00.000Z",
				deliveredAt: "2026-09-05T00:01:00.000Z",
				notifiedAt: null,
			});
		const enqueue = vi.spyOn(MailboxQueue.prototype, "enqueue");
		try {
			expect(
				runtime.enqueueInfraAlert("lead-a", {
					leadId: "lead-a",
					projectName: "project-a",
					eventId: "archived-canonical",
					eventType: "bridge_abnormal_exit",
					title: "Bridge exited",
					body: "archived canonical replay",
					severity: "warning",
				}),
			).toEqual({ queued: true, deliveryId });
			expect(ledgerWrite).toHaveBeenCalledOnce();
			expect(enqueue).not.toHaveBeenCalled();
		} finally {
			inspect.mockRestore();
			enqueue.mockRestore();
			store.close();
		}
	});

	it.each(["torn", "throws"] as const)(
		"fails closed when canonical settlement inspection %s",
		async (failure) => {
			const root = mkdtempSync(join(tmpdir(), `fly2386-${failure}-canonical-`));
			const dbPath = join(root, "project-a.db");
			const store = await StateStore.create(":memory:");
			const deliveryId = `infra_alert:claude-infra-bot-lead:bridge_abnormal_exit:${failure}-canonical`;
			store.upsertAlertMailboxLedger(
				{
					correlationKey: "project-a|lead-a|bridge_abnormal_exit|",
					eventId: `${failure}-canonical`,
					deliveryId,
					toAgent: "claude-infra-bot-lead",
					requestedOwner: "lead-a",
					routeClass: "duty_reroute",
					leadId: "lead-a",
					projectName: "project-a",
					eventType: "bridge_abnormal_exit",
				},
				{ allowReseed: false },
			);
			const runtime = new LeadInboxRuntime({
				projects: projectsWithDutyLead(),
				store,
				registry: new RuntimeRegistry(),
				commDbPathForProject: () => dbPath,
				isDutyConfigured: () => false,
			});
			runtimes.push(runtime);
			const inspect = vi.spyOn(MailboxQueue.prototype, "inspectDeliveryState");
			if (failure === "torn") {
				inspect.mockReturnValue({ kind: "torn_identity" });
			} else {
				inspect.mockImplementation(() => {
					throw new Error("settlement unavailable");
				});
			}
			const enqueue = vi.spyOn(MailboxQueue.prototype, "enqueue");
			try {
				expect(
					runtime.enqueueInfraAlert("lead-a", {
						leadId: "lead-a",
						projectName: "project-a",
						eventId: `${failure}-canonical`,
						eventType: "bridge_abnormal_exit",
						title: "Bridge exited",
						body: "settlement failed",
						severity: "warning",
					}),
				).toEqual({ queued: false, deliveryId, reason: "settlement_torn" });
				expect(enqueue).not.toHaveBeenCalled();
				expect(store.getMailboxLedgerByEventId(`${failure}-canonical`)).toEqual(
					expect.objectContaining({
						to_agent: "claude-infra-bot-lead",
						route_class: "duty_reroute",
					}),
				);
			} finally {
				inspect.mockRestore();
				enqueue.mockRestore();
				store.close();
			}
		},
	);

	it("delivers an idempotent named handoff letter with the SQL-issued id", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2386-handoff-letter-"));
		const dbPath = join(root, "project-a.db");
		const runtime = new LeadInboxRuntime({
			projects,
			store: runtimeStoreStub() as never,
			registry: new RuntimeRegistry(),
			commDbPathForProject: () => dbPath,
		});
		runtimes.push(runtime);
		const input = {
			deliveryId: "alert_handoff:mailbox:key:event-1:lead-a:g1",
			lane: "mailbox" as const,
			correlationKey: "project-a|lead-b|bridge_abnormal_exit|",
			eventId: "event-1",
			kind: "bridge_abnormal_exit",
			reason: "no_entry" as const,
			note: "Inspect the Bridge exit.",
			ref: "alert-ticket lookup --event-id event-1",
		};

		const first = runtime.enqueueAlertHandoff("lead-a", input);
		const replay = runtime.enqueueAlertHandoff("lead-a", input);
		const next = runtime.enqueueAlertHandoff("lead-a", {
			...input,
			deliveryId: "alert_handoff:mailbox:key:event-1:lead-a:g2",
		});

		expect(replay).toEqual(first);
		expect(next.deliveryId).not.toBe(first.deliveryId);
		const snapshot = new Database(dbPath, { readonly: true });
		try {
			expect(
				snapshot
					.prepare(
						"SELECT delivery_id,to_agent,source_kind,type,collapse_key,content FROM mailbox WHERE delivery_id=?",
					)
					.get(input.deliveryId),
			).toEqual({
				delivery_id: input.deliveryId,
				to_agent: "lead-a",
				source_kind: "infra_alert",
				type: "bridge_abnormal_exit",
				collapse_key: input.deliveryId,
				content: expect.stringContaining("[alert_handoff]"),
			});
			expect(
				snapshot.prepare("SELECT COUNT(*) AS count FROM mailbox").get(),
			).toEqual({ count: 2 });
		} finally {
			snapshot.close();
		}
	});

	it("exposes the owning queue's typed settlement view for patrol recovery", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1687-runtime-settlement-"));
		const registry = new RuntimeRegistry();
		registry.register(projects[0]!.leads[0]!, {
			type: "test",
			deliver: vi.fn(),
			renderEnvelope: () => "[patrol_tick] body",
			sendBootstrap: vi.fn(),
			health: vi.fn(),
			shutdown: vi.fn(),
		} as unknown as LeadRuntime);
		const runtime = new LeadInboxRuntime({
			projects,
			store: runtimeStoreStub() as never,
			registry,
			commDbPathForProject: (name) => join(root, `${name}.db`),
		});
		runtimes.push(runtime);
		const receipt = runtime.enqueueLeadEvent(
			{
				seq: 1,
				eventId: "patrol_tick:project-a:lead-a:after-genesis",
				event: {
					event_type: "patrol_tick",
					execution_id: "patrol:project-a:lead-a",
					issue_id: "",
				},
				sessionKey: "patrol:project-a:lead-a",
				leadId: "lead-a",
				timestamp: "2026-08-13T12:00:00.000Z",
			},
			"[patrol_tick] body",
		);
		expect(
			runtime.getLeadEventSettlement("project-a", receipt.deliveryId),
		).toMatchObject({ kind: "live", state: "QUEUED" });
	});

	it("reads a handoff settlement from the target Lead's project", () => {
		const root = mkdtempSync(join(tmpdir(), "fly2386-handoff-settlement-"));
		const multiProject: ProjectEntry[] = [
			...projects,
			{
				projectName: "project-b",
				projectRoot: "/tmp/project-b",
				leads: [
					{
						agentId: "lead-b",
						summaryRole: "recipient",
						chatChannel: "chat-b",
						match: { labels: ["Machine"] },
					},
				],
			},
		];
		const runtime = new LeadInboxRuntime({
			projects: multiProject,
			store: runtimeStoreStub() as never,
			registry: new RuntimeRegistry(),
			commDbPathForProject: (name) => join(root, `${name}.db`),
		});
		runtimes.push(runtime);
		const deliveryId = "alert_handoff:mailbox:key:event-1:lead-b:g1";
		runtime.enqueueAlertHandoff("lead-b", {
			deliveryId,
			lane: "mailbox",
			correlationKey: "project-a|lead-a|bridge_abnormal_exit|",
			eventId: "event-1",
			kind: "bridge_abnormal_exit",
			reason: "contact_book",
			ref: "alert-ticket lookup --event-id event-1",
		});

		expect(runtime.readHandoffSettlement("lead-b", deliveryId)).toMatchObject({
			kind: "live",
			state: "QUEUED",
		});
		expect(runtime.readHandoffSettlement("missing-lead", deliveryId)).toEqual({
			kind: "unknown_lead",
		});
	});
	it("names the project and CommDB when project initialization fails", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1649-runtime-open-"));
		const dbPath = join(root, "project-a.db");
		const legacy = new Database(dbPath);
		legacy.exec("CREATE TABLE legacy_only (id TEXT PRIMARY KEY)");
		legacy.close();

		expect(
			() =>
				new LeadInboxRuntime({
					projects,
					store: { getActiveSessions: () => [] } as never,
					registry: new RuntimeRegistry(),
					commDbPathForProject: () => dbPath,
				}),
		).toThrowError(
			`LeadInboxRuntime init failed for project=project-a db=${dbPath}: Legacy or partial CommDB at ${dbPath}; run the FLY-1572 mailbox migration before opening it`,
		);
	});

	it("connects the registry producer seam to a live per-Lead loop", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1373-runtime-"));
		const registry = new RuntimeRegistry();
		registry.register(projects[0]!.leads[0]!, {
			type: "test",
			deliver: vi.fn(),
			renderEnvelope: () => "rendered",
			sendBootstrap: vi.fn(),
			health: vi.fn(),
			shutdown: vi.fn(),
		} as unknown as LeadRuntime);
		const delivered = vi.fn(async (batch) => ({
			batchId: batch.batchId,
			memberIds: batch.members.map(
				(member: { deliveryId: string }) => member.deliveryId,
			),
			status: "accepted_new" as const,
		}));
		const store = {
			...runtimeStoreStub(),
			markLeadEventDelivered: vi.fn(),
		};
		const runtime = new LeadInboxRuntime({
			projects,
			store: store as never,
			registry,
			commDbPathForProject: (project) => join(root, `${project}.db`),
			ownerEpoch: "owner-1",
			adapterForLead: () => ({ deliverBatch: delivered }),
			runLegacyCutover: vi.fn(),
		});
		runtimes.push(runtime);
		registry.setLeadEventEnqueuer((envelope, content) =>
			runtime.enqueueLeadEvent(envelope, content),
		);
		registry.setLeadInboxNudge((leadId, projectName) =>
			runtime.nudge(leadId, projectName),
		);
		runtime.start();
		registry.enqueueLeadEvent({
			seq: 9,
			eventId: "event-9",
			event: { event_type: "session_completed" },
			sessionKey: "exec-9",
			leadId: "lead-a",
			timestamp: new Date().toISOString(),
		});
		await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1));
		expect(store.markLeadEventDelivered).toHaveBeenCalledWith(9);
		expect(registry.nudgeLeadInbox("lead-a", "project-a")).toBe(true);
	});

	it("forwards model transport stall context to the production wiring seam", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1574-runtime-stall-"));
		const stalled = vi.fn(async () => undefined);
		const runtime = new LeadInboxRuntime({
			projects,
			store: {
				...runtimeStoreStub(),
				markLeadEventDelivered: vi.fn(),
			} as never,
			registry: new RuntimeRegistry(),
			commDbPathForProject: (project) => join(root, `${project}.db`),
			ownerEpoch: "owner-1",
			adapterForLead: () => ({
				async deliverBatch() {
					throw new LeadDeliveryUnavailableError("lead", "socket unavailable");
				},
			}),
			onModelTransportStall: stalled,
		});
		runtimes.push(runtime);
		runtime.enqueueLeadEvent(
			{
				seq: 10,
				eventId: "event-10",
				event: { event_type: "session_completed" },
				sessionKey: "exec-10",
				leadId: "lead-a",
				timestamp: "2026-08-10T21:30:00.000Z",
			},
			"payload",
		);
		runtime.start();
		await vi.waitFor(() =>
			expect(stalled).toHaveBeenCalledWith(
				expect.objectContaining({
					projectName: "project-a",
					leadId: "lead-a",
					error: "socket unavailable",
				}),
			),
		);
	});

	it("forwards terminal transport exhaustion before a row dies", async () => {
		vi.stubEnv("FLYWHEEL_MAILBOX_UNAVAILABLE_RETRY_MAX", "1");
		const root = mkdtempSync(join(tmpdir(), "fly1750-runtime-exhausted-"));
		const dbPath = join(root, "project-a.db");
		const exhausted = vi.fn(async () => {
			const snapshot = new MailboxQueue(dbPath);
			try {
				expect(snapshot.getById("lead_event:lead-a:event-11")?.state).toBe(
					"LEASED",
				);
			} finally {
				snapshot.close();
			}
		});
		const runtime = new LeadInboxRuntime({
			projects,
			store: {
				...runtimeStoreStub(),
				markLeadEventDelivered: vi.fn(),
			} as never,
			registry: new RuntimeRegistry(),
			commDbPathForProject: () => dbPath,
			ownerEpoch: "owner-1",
			adapterForLead: () => ({
				async deliverBatch() {
					throw new LeadDeliveryUnavailableError("lead", "socket unavailable");
				},
			}),
			onModelTransportExhausted: exhausted,
		});
		runtimes.push(runtime);
		runtime.enqueueLeadEvent(
			{
				seq: 11,
				eventId: "event-11",
				event: { event_type: "session_completed" },
				sessionKey: "exec-11",
				leadId: "lead-a",
				timestamp: "2026-08-13T21:00:00.000Z",
			},
			"payload",
		);
		runtime.start();
		await vi.waitFor(() => expect(exhausted).toHaveBeenCalledOnce());
		expect(exhausted).toHaveBeenCalledWith(
			expect.objectContaining({
				projectName: "project-a",
				leadId: "lead-a",
				deliveryIds: ["lead_event:lead-a:event-11"],
				attempt: 1,
				error: "socket unavailable",
			}),
		);
		const result = new MailboxQueue(dbPath);
		try {
			expect(result.getById("lead_event:lead-a:event-11")).toMatchObject({
				state: "DEAD",
				dead_reason: "transport_unavailable_exhausted",
			});
		} finally {
			result.close();
		}
	});

	it("forwards Discord quarantine evidence before marking the row DEAD", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1574-runtime-quarantine-"));
		const dbPath = join(root, "project-a.db");
		const queue = new MailboxQueue(dbPath);
		queue.enqueue({
			id: "chat:lead-a:bad",
			fromAgent: "founder",
			toAgent: "lead-a",
			recipientKind: "lead",
			type: "discord_chat",
			content: "malformed",
			senderRef: encodeSenderRef(),
		});
		queue.close();
		const undeliverable = vi.fn(async () => {
			const snapshot = new MailboxQueue(dbPath);
			try {
				expect(snapshot.getById("chat:lead-a:bad")?.state).toBe("LEASED");
			} finally {
				snapshot.close();
			}
		});
		const runtime = new LeadInboxRuntime({
			projects,
			store: runtimeStoreStub() as never,
			registry: new RuntimeRegistry(),
			commDbPathForProject: () => dbPath,
			ownerEpoch: "owner-1",
			adapterForLead: () => ({
				async deliverBatch() {
					throw new Error("adapter must not receive malformed Discord");
				},
			}),
			onDiscordUndeliverable: undeliverable,
		});
		runtimes.push(runtime);
		runtime.start();
		await vi.waitFor(() => expect(undeliverable).toHaveBeenCalledOnce());
		const result = new MailboxQueue(dbPath);
		try {
			expect(result.getById("chat:lead-a:bad")).toMatchObject({
				state: "DEAD",
				dead_reason: expect.stringContaining("discord_undeliverable"),
			});
		} finally {
			result.close();
		}
	});

	it("prefers an existing legacy Codex state dir, otherwise uses injective identity", () => {
		const root = mkdtempSync(join(tmpdir(), "fly1373-state-dir-"));
		mkdirSync(join(root, "lead-a"));
		expect(resolveCodexLeadStateDir("project-a", "lead-a", root)).toBe(
			join(root, "lead-a"),
		);
		const generated = resolveCodexLeadStateDir("project/x", "lead y", root);
		expect(generated).toContain("project_x__lead_y-");
		expect(generated).toContain(
			Buffer.from("project/x\u001flead y").toString("hex"),
		);
	});

	it("resolves the Bridge inbox socket to the slot Lead listening path", () => {
		const slotLeadRoot = join(tmpdir(), "flywheel-test-slot-7", "q", "7");
		const identityHex = Buffer.from("project-a\u001flead-a").toString("hex");
		const leadListeningStateDir = join(
			slotLeadRoot,
			"state",
			"codex-lead",
			`project-a__lead-a-${identityHex}`,
		);
		vi.stubEnv(
			"FLYWHEEL_CODEX_LEAD_STATE_DIRS",
			JSON.stringify({
				"project-a": { "lead-a": leadListeningStateDir },
			}),
		);

		const bridgeStateDir = resolveCodexLeadStateDir("project-a", "lead-a");
		expect(bridgeStateDir).toBe(leadListeningStateDir);
		expect(resolveCodexLeadInboxSocketPath(bridgeStateDir)).toBe(
			join(leadListeningStateDir, "lead-inbox.sock"),
		);

		vi.stubEnv(
			"FLYWHEEL_CODEX_LEAD_STATE_DIRS",
			JSON.stringify({ "project-a": {} }),
		);
		expect(() => resolveCodexLeadStateDir("project-a", "lead-a")).toThrow(
			"has no absolute path for project-a/lead-a",
		);
	});

	it("runs one project-level Runner lane on the existing Lead cadence", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1572-runner-runtime-"));
		const dbPath = join(root, "project-a.db");
		const db = new CommDB(dbPath);
		db.registerSession(
			"exec-1",
			"session:window",
			"project-a",
			"FLY-1572",
			"lead-a",
			"claude-code",
		);
		db.insertInstruction("lead-a", "exec-1", "continue");
		db.close();
		const registry = new RuntimeRegistry();
		registry.register(projects[0]!.leads[0]!, {
			type: "test",
			deliver: vi.fn(),
			renderEnvelope: () => "rendered",
			sendBootstrap: vi.fn(),
			health: vi.fn(),
			shutdown: vi.fn(),
		} as unknown as LeadRuntime);
		const deliver = vi.fn(async () => ({ status: "delivered" as const }));
		const runtime = new LeadInboxRuntime({
			projects,
			store: runtimeStoreStub("alive") as never,
			registry,
			commDbPathForProject: () => dbPath,
			ownerEpoch: "owner-1",
			adapterForLead: () => ({
				deliverBatch: vi.fn(async (batch) => ({
					batchId: batch.batchId,
					memberIds: batch.members.map((member) => member.deliveryId),
					status: "accepted_new" as const,
				})),
			}),
			runnerAdapterForProject: () => ({
				deliver,
				resolveQuestion: () => undefined,
				close: vi.fn(),
			}),
		});
		runtimes.push(runtime);
		runtime.start();
		await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
		expect(deliver.mock.calls[0]?.[0]).toMatchObject({
			executionId: "exec-1",
			fromAgent: "lead-a",
			content: expect.stringContaining("continue"),
		});
	});

	it("clears a rejected cutover promise so a later doorbell retries it", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1373-runtime-retry-"));
		const registry = new RuntimeRegistry();
		registry.register(projects[0]!.leads[0]!, {
			type: "test",
			deliver: vi.fn(),
			renderEnvelope: () => "rendered",
			sendBootstrap: vi.fn(),
			health: vi.fn(),
			shutdown: vi.fn(),
		} as unknown as LeadRuntime);
		const cutover = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error("transient cutover failure"))
			.mockResolvedValue(undefined);
		const runtime = new LeadInboxRuntime({
			projects,
			store: runtimeStoreStub() as never,
			registry,
			commDbPathForProject: (project) => join(root, `${project}.db`),
			ownerEpoch: "owner-1",
			adapterForLead: () => ({
				deliverBatch: vi.fn(async () => {
					throw new Error("unexpected delivery");
				}),
			}),
			runLegacyCutover: cutover,
		});
		runtimes.push(runtime);
		runtime.start();
		await vi.waitFor(() => expect(cutover).toHaveBeenCalledTimes(1));
		runtime.nudge("lead-a", "project-a");
		await vi.waitFor(() => expect(cutover).toHaveBeenCalledTimes(2));
	});

	it("routes a retired Lead dead-letter through the live primary Lead", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1573-alert-runtime-"));
		const dbPath = join(root, "project-a.db");
		const commDb = new CommDB(dbPath);
		commDb.close();
		const queue = new MailboxQueue(dbPath);
		queue.enqueue({
			id: "dead-lead-message",
			fromAgent: "runner-a",
			toAgent: "retired-lead",
			recipientKind: "lead",
			type: "question",
			content: "unacknowledged",
			senderRef: encodeSenderRef(),
		});
		queue.markDead(
			"dead-lead-message",
			new Date().toISOString(),
			"lease_expired_unacked",
		);
		queue.close();
		const store = await StateStore.create(":memory:");
		const sink = vi.fn(async (input: { eventId: string }) => {
			store.recordAlertDeliveryReceipt(
				input.eventId,
				"sent",
				new Date().toISOString(),
			);
		});
		const runtime = new LeadInboxRuntime({
			projects,
			store,
			registry: new RuntimeRegistry(),
			commDbPathForProject: () => dbPath,
			ownerEpoch: "owner-alert",
			adapterForLead: () => ({
				deliverBatch: vi.fn(async () => {
					throw new Error("unexpected mailbox delivery");
				}),
			}),
			runnerAdapterForProject: () => ({
				deliver: vi.fn(),
				resolveQuestion: () => undefined,
				close: vi.fn(),
			}),
			onDeadLetterAlert: sink,
		});
		runtimes.push(runtime);
		runtime.start();
		await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1));
		const eventId = sink.mock.calls[0]?.[0].eventId as string;
		expect(sink).toHaveBeenCalledWith(
			expect.objectContaining({
				leadId: "lead-a",
				recipient: "retired-lead",
				replayAfterAmbiguousAttempt: false,
			}),
		);
		expect(store.getDeadLetterAlert(eventId)).toMatchObject({
			state: "accepted",
			recipient: "retired-lead",
			source_kind: "lead_unacked",
		});
		runtime.close();
		runtimes.splice(runtimes.indexOf(runtime), 1);
		store.close();
	});

	it("routes an ownerless Runner dead-letter alert to the project's primary Lead", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1573-runner-alert-runtime-"));
		const dbPath = join(root, "project-a.db");
		const commDb = new CommDB(dbPath);
		commDb.close();
		const queue = new MailboxQueue(dbPath);
		queue.enqueue({
			id: "dead-ownerless-runner-message",
			fromAgent: "lead-a",
			toAgent: "missing-execution",
			recipientKind: "runner",
			type: "instruction",
			content: "unacknowledged",
			senderRef: encodeSenderRef(),
		});
		queue.markDead(
			"dead-ownerless-runner-message",
			new Date().toISOString(),
			"recipient_terminal",
		);
		queue.close();
		const store = await StateStore.create(":memory:");
		const sink = vi.fn(
			async (input: {
				eventId: string;
				leadId: string;
				projectName: string;
			}) => {
				store.recordAlertDeliveryReceipt(
					input.eventId,
					"sent",
					new Date().toISOString(),
				);
			},
		);
		const runtime = new LeadInboxRuntime({
			projects,
			store,
			registry: new RuntimeRegistry(),
			commDbPathForProject: () => dbPath,
			ownerEpoch: "owner-runner-alert",
			adapterForLead: () => ({ deliverBatch: vi.fn() }),
			runnerAdapterForProject: () => ({
				deliver: vi.fn(),
				resolveQuestion: () => undefined,
				close: vi.fn(),
			}),
			onDeadLetterAlert: sink,
		});
		runtimes.push(runtime);
		runtime.start();
		await vi.waitFor(() => expect(sink).toHaveBeenCalledTimes(1));
		expect(sink).toHaveBeenCalledWith(
			expect.objectContaining({
				leadId: "lead-a",
				projectName: "project-a",
				recipient: "missing-execution",
				sourceKind: "runner_unroutable",
			}),
		);
		runtime.close();
		runtimes.splice(runtimes.indexOf(runtime), 1);
		store.close();
	});

	it("replays a claimed/no-receipt dead-letter after the existing reclaim fence and unblocks later windows", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1573-alert-claim-seam-"));
		const dbPath = join(root, "project-a.db");
		const db = new CommDB(dbPath);
		db.close();
		const store = await StateStore.create(":memory:");
		const windowMs = 30 * 60_000;
		const eventId = "dead_letter_alert:runner_unroutable:runner-a:40";
		store.createDeadLetterAlertIntent({
			id: eventId,
			sourceKind: "runner_unroutable",
			recipient: "runner-a",
			throughDeadSeq: 40,
			leadId: "lead-a",
			projectName: "project-a",
			deadCount: 3,
			summary: "three dead messages",
			now: "2026-08-10T10:00:00.000Z",
			windowMs,
		});
		store.claimDeadLetterAlert({
			id: eventId,
			claimToken: "claim-before-crash",
			now: "2026-08-10T10:01:00.000Z",
			windowMs,
		});
		store.recordDeadLetterAlertFailure(eventId, "claim-before-crash", "Crash");
		store.tryClaimLeadEvent("lead-a", eventId, "mailbox_dead_letter", "{}");

		const fetchFn = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => "",
		});
		const claimsReader = vi.fn(async () => new Set([eventId]));
		const claimsClaimer = vi.fn(async () => false);
		const alertProjects: ProjectEntry[] = [
			{
				...projects[0]!,
				leads: [
					{
						...projects[0]!.leads[0]!,
						alertChannel: "alert-channel",
						botToken: "test-token",
					},
				],
			},
		];
		const notifier = new LeadAlertNotifier({
			store,
			projects: alertProjects,
			fetchFn,
			queueDir: join(root, "alert-queue"),
			deadLetterDir: join(root, "alert-deadletter"),
			claimsReader,
			claimsClaimer,
		});
		const sink = vi.fn(
			async (input: {
				eventId: string;
				replayAfterAmbiguousAttempt: boolean;
			}) => {
				await notifier.alert(
					{
						leadId: "lead-a",
						projectName: "project-a",
						eventId: input.eventId,
						eventType: "mailbox_dead_letter",
						title: "dead letters",
						body: "decide replay, discard, or reassign",
						severity: "warning",
					},
					{
						replayAfterAmbiguousAttempt: input.replayAfterAmbiguousAttempt,
					},
				);
			},
		);
		const runtime = new LeadInboxRuntime({
			projects: alertProjects,
			store,
			registry: new RuntimeRegistry(),
			commDbPathForProject: () => dbPath,
			adapterForLead: () => ({ deliverBatch: vi.fn() }),
			runnerAdapterForProject: () => ({
				deliver: vi.fn(),
				resolveQuestion: () => undefined,
				close: vi.fn(),
			}),
			onDeadLetterAlert: sink,
		});
		runtimes.push(runtime);

		await runtime.drainDeadLetterAlertsNow();

		expect(sink).toHaveBeenCalledWith(
			expect.objectContaining({
				eventId,
				replayAfterAmbiguousAttempt: true,
			}),
		);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(claimsReader).not.toHaveBeenCalled();
		expect(claimsClaimer).not.toHaveBeenCalled();
		expect(store.getAlertDeliveryReceipt(eventId)).toMatchObject({
			outcome: "sent",
		});
		const settled = store.getDeadLetterAlert(eventId);
		expect(settled?.state).toBe("accepted");
		const acceptedAt = settled?.accepted_at;
		expect(acceptedAt).toBeTruthy();
		expect(
			store.createDeadLetterAlertIntent({
				id: "dead_letter_alert:runner_unroutable:runner-a:41",
				sourceKind: "runner_unroutable",
				recipient: "runner-a",
				throughDeadSeq: 41,
				leadId: "lead-a",
				projectName: "project-a",
				deadCount: 1,
				summary: "one later dead message",
				now: new Date(Date.parse(acceptedAt!) + windowMs).toISOString(),
				windowMs,
			}),
		).toBe("created");
		runtime.close();
		runtimes.splice(runtimes.indexOf(runtime), 1);
		store.close();
	});

	it("settles from the notifier receipt after a post-receipt crash without posting twice", async () => {
		const root = mkdtempSync(join(tmpdir(), "fly1573-alert-receipt-"));
		const dbPath = join(root, "project-a.db");
		const db = new CommDB(dbPath);
		db.close();
		const store = await StateStore.create(":memory:");
		const now = new Date().toISOString();
		const eventId = "dead_letter_alert:lead_unacked:lead-a:99";
		store.createDeadLetterAlertIntent({
			id: eventId,
			sourceKind: "lead_unacked",
			recipient: "lead-a",
			throughDeadSeq: 99,
			leadId: "lead-a",
			projectName: "project-a",
			deadCount: 1,
			summary: "one dead message",
			now,
			windowMs: 30 * 60_000,
		});
		const sink = vi.fn(async (input: { eventId: string }) => {
			store.recordAlertDeliveryReceipt(input.eventId, "sent", now);
			throw new Error("crash after receipt write");
		});
		const runtime = new LeadInboxRuntime({
			projects,
			store,
			registry: new RuntimeRegistry(),
			commDbPathForProject: () => dbPath,
			adapterForLead: () => ({ deliverBatch: vi.fn() }),
			runnerAdapterForProject: () => ({
				deliver: vi.fn(),
				resolveQuestion: () => undefined,
				close: vi.fn(),
			}),
			onDeadLetterAlert: sink,
		});
		runtimes.push(runtime);
		await runtime.drainDeadLetterAlertsNow();
		expect(store.getDeadLetterAlert(eventId)?.state).toBe("pending");
		await runtime.drainDeadLetterAlertsNow();
		expect(store.getDeadLetterAlert(eventId)?.state).toBe("accepted");
		expect(sink).toHaveBeenCalledTimes(1);
		runtime.close();
		runtimes.splice(runtimes.indexOf(runtime), 1);
		store.close();
	});
});
