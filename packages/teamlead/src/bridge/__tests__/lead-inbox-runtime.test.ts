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
		listUndeliveredWorkflowReplacementLeadEvents: () => [],
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
			expect(drainContentRefGc).toHaveBeenCalledWith({
				now: expect.any(String),
				limit: 1,
			});

			const verify = new Database(dbPath, { readonly: true });
			try {
				expect(
					verify
						.prepare(
							"SELECT event, subject_id FROM mailbox_log WHERE message_id = ?",
						)
						.get("fly2136-archive-me"),
				).toEqual({ event: "archived", subject_id: "fly2136-archive-me" });
				expect(
					verify
						.prepare("SELECT archived_at FROM mailbox_identity WHERE id = ?")
						.get("fly2136-archive-me"),
				).toEqual({ archived_at: expect.any(String) });
			} finally {
				verify.close();
			}
		} finally {
			drainContentRefGc.mockRestore();
			archiveDueFamilies.mockRestore();
			queue.close();
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
