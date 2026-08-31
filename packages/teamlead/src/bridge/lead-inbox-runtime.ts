/** FLY-1373 Bridge assembly for per-Lead inbox loops. */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAdapter } from "flywheel-agent-team-transport";
import { CommDB } from "flywheel-comm/db";
import {
	type CanonicalLeadIdentity,
	compileLeadIdentityRegistry,
} from "flywheel-comm/lead-identity";
import {
	LeadLeaseStore,
	type ProcessTupleState,
	processTupleStateWithStart,
} from "flywheel-comm/lead-lease";
import {
	MailboxQueue,
	type MailboxRecipientState,
	type MailboxSettlement,
} from "flywheel-comm/mailbox-queue";
import { encodeSenderRef } from "flywheel-comm/sender-ref";
import type { AlertPayload } from "../LeadAlertNotifier.js";
import { effectiveLeadBackend } from "../lead-backends/lead-backend.js";
import {
	type LeadConfig,
	type ProjectEntry,
	resolveLeadForIssue,
} from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import { isCurrentDesignReviewManifestInstruction } from "./design-review-manifest.js";
import { formatInfraAlertMailboxContent } from "./infra-alert-mailbox.js";
import {
	ClaudeLeadDeliveryAdapter,
	CodexLeadDeliveryAdapter,
	type LeadDeliveryAdapter,
} from "./lead-delivery-adapter.js";
import type { DeliverySecretProvider } from "./lead-event-delivery.js";
import { enqueueLeadEvent as enqueueEvent } from "./lead-event-queue.js";
import { LeadInboxLoop } from "./lead-inbox-loop.js";
import {
	type LeadLeaseReader,
	readLeadRecipientState,
} from "./lead-recipient-liveness.js";
import type { LeadEventEnvelope } from "./lead-runtime.js";
import { matchesLead } from "./lead-scope.js";
import {
	leadEventEnvelopeFromJournalRow,
	REDRIVABLE_LEAD_EVENT_PRIORITY,
} from "./legacy-lead-event-reconciler.js";
import { resolveMailboxQueueConfig } from "./mailbox-queue-config.js";
import { ProtocolIngress } from "./protocol-ingress.js";
import { QuestionAdmission } from "./question-admission.js";
import {
	ProductionRunnerMailboxDeliveryAdapter,
	type RunnerMailboxDeliveryAdapter,
	RunnerMailboxLane,
} from "./runner-mailbox-lane.js";
import type {
	DurableQueueReceipt,
	RuntimeRegistry,
} from "./runtime-registry.js";

export interface InfraAlertQueueReceipt {
	queued: true;
	deliveryId: string;
	seq?: number;
}

export interface LeadInboxRuntimeOptions {
	projects: ProjectEntry[];
	store: StateStore;
	registry: RuntimeRegistry;
	commDbPathForProject: (projectName: string) => string;
	chatThreadsEnabled?: boolean;
	secretProvider?: DeliverySecretProvider;
	ownerEpoch?: string;
	adapterForLead?: (
		project: ProjectEntry,
		lead: LeadConfig,
	) => LeadDeliveryAdapter;
	runnerAdapterForProject?: (
		project: ProjectEntry,
		dbPath: string,
	) => RunnerMailboxDeliveryAdapter;
	/** Test seam for the one-shot boot cutover. */
	runLegacyCutover?: () => void | Promise<void>;
	afterTickStartedForLead?: (
		projectName: string,
		leadId: string,
	) => Promise<void>;
	/** Production passes the canonical lease DB path; tests may inject a reader. */
	leadLeaseDbPath?: string;
	leadLeaseReader?: LeadLeaseReader;
	/**
	 * Destructive retired-recipient sweeps use the current fleet authority. The
	 * normal file-backed provider is live; an explicitly env-pinned deployment
	 * is intentionally static for that process. Throwing/empty providers fail closed.
	 */
	currentLeadRecipientsForProject?: (projectName: string) => readonly string[];
	processLeadTupleState?: (pid: number, start: string) => ProcessTupleState;
	/**
	 * FLY-1586 R2 HIGH-5 — direct sink for quarantine alerts.
	 *
	 * MUST NOT route through `mailbox`: an alert about the inbox being wedged,
	 * delivered via the inbox, is stuck inside the thing it is reporting. That
	 * circularity is why the original outage went 61 hours unnoticed.
	 *
	 * Failure here must never fail `ensureCutover` — gating boot admission on
	 * Discord availability would just relocate the fleet-wide wedge to a new
	 * trigger. Undelivered alerts stay `pending_alert`, visible via
	 * `listPendingQuarantineAlerts()`, and are retried.
	 */
	onQuarantineAlert?: (input: {
		seq: number;
		leadId: string;
		projectName: string;
		reason: string;
	}) => Promise<void>;
	onModelTransportStall?: (input: {
		projectName: string;
		leadId: string;
		error: string;
		at: string;
	}) => Promise<void>;
	onModelTransportRecovered?: (input: {
		projectName: string;
		leadId: string;
		at: string;
	}) => Promise<void>;
	onModelTransportExhausted?: (input: {
		projectName: string;
		leadId: string;
		deliveryIds: string[];
		error: string;
		attempt: number;
		at: string;
	}) => Promise<void>;
	onDiscordUndeliverable?: (input: {
		projectName: string;
		leadId: string;
		deliveryIds: string[];
		reason: string;
		attempt: number;
		at: string;
	}) => Promise<void>;
	onDiscordDeliveryStall?: (input: {
		projectName: string;
		leadId: string;
		batchId: string;
		deliveryIds: string[];
		error: string;
		at: string;
	}) => Promise<void>;
	onDeadLetterAlert?: (input: {
		eventId: string;
		leadId: string;
		projectName: string;
		recipient: string;
		sourceKind: "lead_unacked" | "runner_unroutable";
		deadCount: number;
		summary: string;
		/** The existing reclaim fence elapsed after an attempt with no receipt. */
		replayAfterAmbiguousAttempt: boolean;
	}) => Promise<void>;
}

export class LeadInboxRuntime {
	private readonly loops = new Map<string, LeadInboxLoop>();
	private readonly queues = new Map<string, MailboxQueue>();
	private readonly admissions: QuestionAdmission[] = [];
	private readonly runnerAdapters: RunnerMailboxDeliveryAdapter[] = [];
	private readonly projectByLead = new Map<string, ProjectEntry>();
	private readonly identityByLead = new Map<string, CanonicalLeadIdentity>();
	private readonly ownerEpoch: string;
	private readonly leadLeaseReader: LeadLeaseReader;
	private readonly processLeadTupleState: (
		pid: number,
		start: string,
	) => ProcessTupleState;
	private readonly retiredLeadScanCursor = new Map<string, string>();
	private readonly lastDeadAlertReconcileAtMs = new Map<string, number>();
	private readonly lastArchiveAttemptAtMs = new Map<string, number>();
	private retiredLeadReconcileRunning = false;
	private cutoverPromise?: Promise<void>;

	constructor(private readonly opts: LeadInboxRuntimeOptions) {
		this.ownerEpoch = opts.ownerEpoch ?? randomUUID();
		const identities = compileLeadIdentityRegistry(opts.projects);
		for (const identity of identities) {
			this.identityByLead.set(identity.leadId, identity);
		}
		const identityByProjectLead = new Map(
			identities.map((identity) => [
				this.key(identity.projectName, identity.leadId),
				identity,
			]),
		);
		this.leadLeaseReader =
			opts.leadLeaseReader ?? openLeadLeaseReader(opts.leadLeaseDbPath);
		this.processLeadTupleState =
			opts.processLeadTupleState ?? processTupleStateWithStart;
		const adapterForLead = opts.adapterForLead ?? createProductionAdapter;
		const runnerAdapterForProject =
			opts.runnerAdapterForProject ??
			((_project, dbPath) =>
				new ProductionRunnerMailboxDeliveryAdapter(dbPath));
		const secretProvider =
			opts.secretProvider ??
			({
				getActive: () => {
					throw new Error("legacy ACK secret provider is not configured");
				},
			} satisfies DeliverySecretProvider);
		for (const project of opts.projects) {
			const dbPath = opts.commDbPathForProject(project.projectName);
			let queue: MailboxQueue;
			try {
				const commDb = new CommDB(dbPath);
				commDb.close();
				queue = new MailboxQueue(dbPath);
			} catch (error) {
				if (error instanceof Error) {
					error.message = `LeadInboxRuntime init failed for project=${project.projectName} db=${dbPath}: ${error.message}`;
				}
				throw error;
			}
			this.queues.set(project.projectName, queue);
			const runnerAdapter = runnerAdapterForProject(project, dbPath);
			this.runnerAdapters.push(runnerAdapter);
			const resolveOwningLead = (executionId: string): string | undefined => {
				const recipient = opts.store.resolveRunnerRecipientState(executionId);
				if (!recipient.projectName) return undefined;
				let labels: string[] = [];
				if (recipient.issueLabels) {
					try {
						const parsed = JSON.parse(recipient.issueLabels) as unknown;
						labels = Array.isArray(parsed)
							? parsed.filter(
									(value): value is string => typeof value === "string",
								)
							: [];
					} catch {
						labels = recipient.issueLabels
							.split(",")
							.map((value) => value.trim())
							.filter(Boolean);
					}
				}
				try {
					return resolveLeadForIssue(
						opts.projects,
						recipient.projectName,
						labels,
					).lead.agentId;
				} catch {
					return undefined;
				}
			};
			const runnerLane = new RunnerMailboxLane({
				queue,
				ownerEpoch: this.ownerEpoch,
				deliver: (envelope) => runnerAdapter.deliver(envelope),
				resolveQuestion: (questionId) =>
					runnerAdapter.resolveQuestion(questionId),
				queueConfig: resolveMailboxQueueConfig,
				recipientState: (executionId) =>
					opts.store.resolveRunnerRecipientState(executionId).state,
				isTerminalDeliveryObligation: (row) =>
					isCurrentDesignReviewManifestInstruction(opts.store, row),
				resolveOwningLead,
				probeFactsByRecipient: () => this.runnerProbeFacts(project.projectName),
			});
			for (const [leadIndex, lead] of project.leads.entries()) {
				if (this.projectByLead.has(lead.agentId)) {
					throw new Error(`duplicate Lead id across projects: ${lead.agentId}`);
				}
				this.projectByLead.set(lead.agentId, project);
				const identity = identityByProjectLead.get(
					this.key(project.projectName, lead.agentId),
				);
				if (!identity) {
					throw new Error(
						`canonical Lead identity missing: ${project.projectName}/${lead.agentId}`,
					);
				}
				const admission = new QuestionAdmission({
					queue,
					dbPath: opts.commDbPathForProject(project.projectName),
					lead,
					projects: opts.projects,
					store: opts.store,
					runtimeRegistry: opts.registry,
					chatThreadsEnabled: opts.chatThreadsEnabled,
				});
				this.admissions.push(admission);
				const protocol = new ProtocolIngress({
					store: opts.store,
					queue,
					secretProvider,
				});
				const loop = new LeadInboxLoop({
					queue,
					leadId: lead.agentId,
					ownerEpoch: this.ownerEpoch,
					adapter: adapterForLead(project, lead),
					queueConfig: resolveMailboxQueueConfig,
					recipientState: () =>
						readLeadRecipientState({
							leadKey: identity.leadKey,
							leaseReader: this.leadLeaseReader,
							processTupleState: this.processLeadTupleState,
						}),
					ackInstruction:
						effectiveLeadBackend(
							lead.backend,
							process.env.FLYWHEEL_LEAD_BACKEND,
						).backend === "codex-app-server"
							? "lead_actions.ack_batch"
							: "flywheel_inbox_ack_batch",
					hasLiveSession: () =>
						opts.store.getActiveSessions().some((session) => {
							try {
								return matchesLead(session, lead.agentId, opts.projects);
							} catch {
								return false;
							}
						}),
					hasAdditionalWork:
						leadIndex === 0
							? () => queue.countRunnerDeliverable() > 0
							: undefined,
					admit: async () => {
						await this.ensureCutover();
						const runtime = opts.registry.getRawForLead(lead.agentId);
						if (runtime) {
							for (const row of opts.store.listUndeliveredLeadInboxEvents({
								leadId: lead.agentId,
								projectName: project.projectName,
							})) {
								try {
									const envelope = leadEventEnvelopeFromJournalRow(
										row,
										REDRIVABLE_LEAD_EVENT_PRIORITY,
									);
									this.enqueueLeadEvent(
										envelope,
										runtime.renderEnvelope?.(envelope) ??
											JSON.stringify(envelope.event),
									);
								} catch (error) {
									if (row.event_type !== "workflow_claim_recorded") throw error;
									console.warn(
										"[lead-inbox-runtime] lead event redrive failed",
										{
											leadId: lead.agentId,
											projectName: project.projectName,
											seq: row.seq,
											eventType: row.event_type,
											errorName:
												error instanceof Error ? error.name : typeof error,
										},
									);
								}
							}
						}
						if (leadIndex === 0) {
							await runnerLane.tick();
							const queueConfig = resolveMailboxQueueConfig();
							const maintenanceAtMs = Date.now();
							const lastDeadAlertReconcileAtMs =
								this.lastDeadAlertReconcileAtMs.get(project.projectName);
							if (
								lastDeadAlertReconcileAtMs === undefined ||
								maintenanceAtMs - lastDeadAlertReconcileAtMs >=
									queueConfig.deadLetterScanIntervalMs
							) {
								this.reconcileDeadLetterAlertIntents({
									project,
									queue,
									resolveOwningLead,
									windowMs: queueConfig.deadLetterWindowMs,
								});
								this.lastDeadAlertReconcileAtMs.set(
									project.projectName,
									maintenanceAtMs,
								);
							}
							await this.drainDeadLetterAlerts(queueConfig.deadLetterWindowMs);
							const lastArchiveAttemptAtMs = this.lastArchiveAttemptAtMs.get(
								project.projectName,
							);
							if (
								lastArchiveAttemptAtMs === undefined ||
								maintenanceAtMs - lastArchiveAttemptAtMs >=
									queueConfig.archiveIntervalMs
							) {
								// Attempt-level throttle: even a failed maintenance pass waits for
								// the next interval instead of turning into a one-second error loop.
								this.lastArchiveAttemptAtMs.set(
									project.projectName,
									maintenanceAtMs,
								);
								const archiveAt = new Date(maintenanceAtMs).toISOString();
								try {
									queue.archiveDueFamilies({
										now: archiveAt,
										maxFamilies: 5,
									});
									queue.drainContentRefGc({ now: archiveAt, limit: 1 });
								} catch (error) {
									console.warn(
										`[lead-inbox-runtime] mailbox archive maintenance failed for project=${project.projectName}: ${error instanceof Error ? error.message : String(error)}`,
									);
								}
							}
						}
					},
					handleProtocol: (row) => protocol.handle(row),
					onProtocolQuarantine: (row, error) => {
						queue.enqueue({
							id: `protocol_alert:${lead.agentId}:${row.id}`,
							fromAgent: "bridge",
							toAgent: lead.agentId,
							recipientKind: "lead",
							sourceKind: "protocol_quarantine",
							sourceRef: row.id,
							type: "protocol_quarantined",
							msgClass: "model",
							priority: 2,
							content:
								`[protocol_quarantined] ${row.type} (${row.id}) was rejected after repeated failures: ` +
								error.message,
							senderRef: encodeSenderRef(),
						});
					},
					revalidateModel: (row) => admission.revalidate(row),
					markAuditDelivered: (row) => {
						if (
							(row.source_kind !== "lead_event" &&
								row.source_kind !== "question") ||
							!row.source_ref
						)
							return;
						const seq = Number(row.source_ref);
						if (Number.isSafeInteger(seq) && seq > 0)
							opts.store.markLeadEventDelivered(seq);
					},
					...(opts.onModelTransportStall
						? {
								onModelTransportStall: (input) =>
									opts.onModelTransportStall?.({
										...input,
										projectName: project.projectName,
									}),
							}
						: {}),
					...(opts.onModelTransportRecovered
						? {
								onModelTransportRecovered: (input) =>
									opts.onModelTransportRecovered?.({
										...input,
										projectName: project.projectName,
									}),
							}
						: {}),
					...(opts.onModelTransportExhausted
						? {
								onModelTransportExhausted: (input) =>
									opts.onModelTransportExhausted?.({
										...input,
										projectName: project.projectName,
									}),
							}
						: {}),
					...(opts.onDiscordUndeliverable
						? {
								onDiscordUndeliverable: (input) =>
									opts.onDiscordUndeliverable?.({
										...input,
										projectName: project.projectName,
									}),
							}
						: {}),
					...(opts.onDiscordDeliveryStall
						? {
								onDiscordDeliveryStall: (input) =>
									opts.onDiscordDeliveryStall?.({
										...input,
										projectName: project.projectName,
									}),
							}
						: {}),
					logger: console,
					afterTickStarted: opts.afterTickStartedForLead
						? () =>
								opts.afterTickStartedForLead?.(
									project.projectName,
									lead.agentId,
								) ?? Promise.resolve()
						: undefined,
				});
				this.loops.set(this.key(project.projectName, lead.agentId), loop);
			}
		}
	}

	start(): void {
		for (const loop of this.loops.values()) loop.start();
	}

	close(): void {
		for (const loop of this.loops.values()) loop.stop();
		for (const admission of this.admissions) admission.close();
		for (const adapter of this.runnerAdapters) adapter.close();
		for (const queue of this.queues.values()) queue.close();
		this.leadLeaseReader.close?.();
		this.loops.clear();
		this.queues.clear();
		this.admissions.length = 0;
		this.runnerAdapters.length = 0;
	}

	enqueueLeadEvent(
		envelope: LeadEventEnvelope,
		content: string,
	): DurableQueueReceipt {
		const project = this.projectByLead.get(envelope.leadId);
		if (!project) throw new Error(`unknown Lead queue: ${envelope.leadId}`);
		const queue = this.queues.get(project.projectName);
		if (!queue)
			throw new Error(`queue closed for project: ${project.projectName}`);
		const result = enqueueEvent({ queue, envelope, content });
		if (result.outcome === "inserted") {
			this.nudge(envelope.leadId, project.projectName);
		}
		return result;
	}

	/** FLY-1764 Flow 2: one durable alert letter to the actionable owner. */
	enqueueInfraAlert(
		ownerLeadId: string,
		payload: AlertPayload,
	): InfraAlertQueueReceipt {
		const project = this.projectByLead.get(ownerLeadId);
		if (!project) throw new Error(`unknown infra alert owner: ${ownerLeadId}`);
		const queue = this.queues.get(project.projectName);
		if (!queue)
			throw new Error(`queue closed for project: ${project.projectName}`);
		const deliveryId = [
			"infra_alert",
			ownerLeadId,
			payload.eventType,
			payload.eventId,
		].join(":");
		const settlement = queue.inspectDeliveryState(deliveryId);
		if (settlement.kind === "archived_terminal") {
			return { queued: true, deliveryId };
		}
		// Mailbox identity compares the whole producer projection. Reuse the first
		// row's timestamp on an in-process retry so the same alert is idempotent.
		const existing = queue.getById(deliveryId);
		const result = queue.enqueue({
			id: deliveryId,
			deliveryId,
			fromAgent: "bridge",
			toAgent: ownerLeadId,
			recipientKind: "lead",
			sourceKind: "infra_alert",
			sourceRef: payload.eventId,
			type: payload.eventType,
			msgClass: "model",
			priority:
				payload.severity === "severe"
					? 3
					: payload.severity === "warning"
						? 2
						: 1,
			content: formatInfraAlertMailboxContent(payload),
			createdAt: existing?.created_at,
			senderRef: encodeSenderRef(),
			collapseKey: `infra_alert:${payload.eventType}:${payload.episodeId ?? payload.eventId}`,
		});
		this.nudge(ownerLeadId, project.projectName);
		return {
			queued: true,
			deliveryId,
			...(result.outcome === "archived" ? {} : { seq: result.row.seq }),
		};
	}

	getLeadEventSettlement(
		projectName: string,
		deliveryId: string,
	): MailboxSettlement {
		const queue = this.queues.get(projectName);
		if (!queue) throw new Error(`queue closed for project: ${projectName}`);
		return queue.inspectDeliveryState(deliveryId);
	}

	getLeadRecipientState(leadId: string): MailboxRecipientState {
		const identity = this.identityByLead.get(leadId);
		if (!identity) return "unknown";
		return readLeadRecipientState({
			leadKey: identity.leadKey,
			leaseReader: this.leadLeaseReader,
			processTupleState: this.processLeadTupleState,
		});
	}

	nudge(leadId: string, projectName?: string): boolean {
		const project = projectName
			? this.opts.projects.find(({ projectName: name }) => name === projectName)
			: this.projectByLead.get(leadId);
		if (!project) return false;
		const loop = this.loops.get(this.key(project.projectName, leadId));
		if (!loop) return false;
		loop.nudge();
		return true;
	}

	healthTargets(): Array<{
		projectName: string;
		leadId: string;
		queue: MailboxQueue;
	}> {
		return [...this.projectByLead.entries()].map(([leadId, project]) => {
			const queue = this.queues.get(project.projectName);
			if (!queue) {
				throw new Error(`queue closed for project: ${project.projectName}`);
			}
			return { projectName: project.projectName, leadId, queue };
		});
	}

	receiptOwnerEpoch(): string {
		return this.ownerEpoch;
	}

	reconcileRetiredLeadMailboxes(input?: {
		maxRecipientsPerProject?: number;
		maxRowsPerRecipient?: number;
	}): { dead: number; remaining: boolean } {
		if (this.retiredLeadReconcileRunning) {
			return { dead: 0, remaining: true };
		}
		this.retiredLeadReconcileRunning = true;
		try {
			const maxRecipients = input?.maxRecipientsPerProject ?? 20;
			const maxRows = input?.maxRowsPerRecipient ?? 100;
			let dead = 0;
			let remaining = false;
			for (const project of this.opts.projects) {
				let liveToAgents: readonly string[];
				try {
					liveToAgents = this.opts.currentLeadRecipientsForProject
						? this.opts.currentLeadRecipientsForProject(project.projectName)
						: project.leads.map(({ agentId }) => agentId);
				} catch {
					// A stale/unreadable roster can never authorize destructive cleanup.
					remaining = true;
					continue;
				}
				liveToAgents = [
					...new Set(liveToAgents.map((value) => value.trim()).filter(Boolean)),
				];
				// An empty/failed roster is not authority to retire everyone.
				if (liveToAgents.length === 0) {
					remaining = true;
					continue;
				}
				const queue = this.queues.get(project.projectName);
				if (!queue) continue;
				const now = new Date().toISOString();
				if (
					!queue.acquireOrRenewOwner({
						ownerEpoch: this.ownerEpoch,
						now,
						leaseTtlMs: 10_000,
					})
				) {
					remaining = true;
					continue;
				}
				const cursor =
					this.retiredLeadScanCursor.get(project.projectName) ?? "";
				const recipients = queue.listRetiredLeadRecipients({
					liveToAgents,
					afterToAgent: cursor,
					limit: maxRecipients,
				});
				if (recipients.length < maxRecipients && cursor) {
					const selected = new Set(recipients);
					for (const recipient of queue.listRetiredLeadRecipients({
						liveToAgents,
						afterToAgent: "",
						limit: maxRecipients,
					})) {
						if (selected.has(recipient)) continue;
						recipients.push(recipient);
						selected.add(recipient);
						if (recipients.length >= maxRecipients) break;
					}
				}
				for (const recipient of recipients) {
					const swept = queue.sweepRecipientTerminal({
						recipientKind: "lead",
						toAgent: recipient,
						ownerEpoch: this.ownerEpoch,
						now,
						maxRows,
					});
					dead += swept.dead;
					remaining ||= swept.remaining;
				}
				const last = recipients.at(-1);
				if (last) this.retiredLeadScanCursor.set(project.projectName, last);
				remaining ||= recipients.length === maxRecipients;
			}
			return { dead, remaining };
		} finally {
			this.retiredLeadReconcileRunning = false;
		}
	}

	private key(projectName: string, leadId: string): string {
		return `${projectName}\u001f${leadId}`;
	}

	private runnerProbeFacts(projectName: string): ReadonlyMap<string, string> {
		const now = Date.now();
		return new Map(
			this.opts.store
				.getActiveSessions()
				.filter((session) => session.project_name === projectName)
				.map((session) => {
					const state = this.opts.store.resolveRunnerRecipientState(
						session.execution_id,
					).state;
					const heartbeat = session.heartbeat_at
						? Date.parse(
								session.heartbeat_at.endsWith("Z")
									? session.heartbeat_at
									: `${session.heartbeat_at.replace(" ", "T")}Z`,
							)
						: Number.NaN;
					const age = Number.isFinite(heartbeat)
						? `${Math.max(0, Math.floor((now - heartbeat) / 60_000))}m`
						: "未知";
					const stateLabel =
						state === "terminal_or_missing" ? "terminal" : state;
					return [
						session.execution_id,
						`StateStore 视图=${stateLabel} / 最近心跳=${age}（注意：此为登记视图非 pane 直读，处置前仍须人工验活）`,
					] as const;
				}),
		);
	}

	/**
	 * Best-effort. A failure here leaves the marker `pending_alert` for the next
	 * pass — the row stays skipped either way, because the marker (not the alert)
	 * is what settles it. Deliberately swallows sink errors: an unreachable alert
	 * channel must not be able to hold the fleet.
	 */
	/** Public entry so the late-bound sink can trigger a catch-up pass. */
	async drainQuarantineAlertsNow(): Promise<void> {
		await this.drainQuarantineAlerts();
	}

	async drainDeadLetterAlertsNow(): Promise<void> {
		await this.drainDeadLetterAlerts(
			resolveMailboxQueueConfig().deadLetterWindowMs,
		);
	}

	private reconcileDeadLetterAlertIntents(input: {
		project: ProjectEntry;
		queue: MailboxQueue;
		resolveOwningLead: (executionId: string) => string | undefined;
		windowMs: number;
	}): void {
		const now = new Date().toISOString();
		for (const candidate of input.queue.listUncoveredLeadDeadLetters({
			sinceCursor: this.opts.store.listDeadLetterAlertCursors(),
			limit: 100,
			maxRowsPerRecipient: 20,
			maxSummaryBytes: 4_096,
			resolveOwningLead: input.resolveOwningLead,
			probeFactsByRecipient: this.runnerProbeFacts(input.project.projectName),
		})) {
			const destinationLead =
				candidate.sourceKind === "lead_unacked" &&
				this.projectByLead.has(candidate.recipient)
					? candidate.recipient
					: input.project.leads[0]?.agentId;
			if (!destinationLead) continue;
			const eventId = `dead_letter_alert:${candidate.sourceKind}:${encodeURIComponent(candidate.recipient)}:${candidate.throughDeadSeq}`;
			this.opts.store.createDeadLetterAlertIntent({
				id: eventId,
				sourceKind: candidate.sourceKind,
				recipient: candidate.recipient,
				throughDeadSeq: candidate.throughDeadSeq,
				leadId: destinationLead,
				projectName: input.project.projectName,
				deadCount: candidate.deadCount,
				summary: candidate.summary,
				now,
				windowMs: input.windowMs,
			});
		}
	}

	private async drainDeadLetterAlerts(windowMs: number): Promise<void> {
		const sink = this.opts.onDeadLetterAlert;
		if (!sink) return;
		for (const row of this.opts.store.listDueDeadLetterAlerts(
			new Date().toISOString(),
		)) {
			const eventId = row.id;
			// Capture this BEFORE claimDeadLetterAlert updates attempted_at. Only a
			// previously attempted row has waited the durable ambiguous-attempt fence
			// and may bypass attempt-only notifier dedup.
			const replayAfterAmbiguousAttempt = row.attempted_at !== null;
			if (this.opts.store.settleDeadLetterAlertFromReceipt(row.id, eventId)) {
				continue;
			}
			const claimToken = randomUUID();
			const now = new Date().toISOString();
			if (
				!this.opts.store.claimDeadLetterAlert({
					id: row.id,
					claimToken,
					now,
					windowMs,
				})
			) {
				continue;
			}
			try {
				if (this.opts.store.settleDeadLetterAlertFromReceipt(row.id, eventId)) {
					continue;
				}
				await sink({
					eventId,
					leadId: row.lead_id,
					projectName: row.project_name,
					recipient: row.recipient,
					sourceKind: row.source_kind,
					deadCount: row.dead_count,
					summary: row.summary,
					replayAfterAmbiguousAttempt,
				});
				if (
					!this.opts.store.settleDeadLetterAlertFromReceipt(row.id, eventId)
				) {
					throw new Error(
						"dead-letter alert sink returned without a delivery receipt",
					);
				}
			} catch (error) {
				this.opts.store.recordDeadLetterAlertFailure(
					row.id,
					claimToken,
					(error as Error).message,
				);
			}
		}
	}

	private async drainQuarantineAlerts(): Promise<void> {
		const sink = this.opts.onQuarantineAlert;
		if (!sink) return;
		for (const row of this.opts.store.listPendingQuarantineAlerts()) {
			try {
				const project = this.projectByLead.get(row.lead_id);
				await sink({
					seq: row.seq,
					leadId: row.lead_id,
					projectName: project?.projectName ?? "",
					reason: row.reason,
				});
				this.opts.store.markQuarantineAlertAccepted(
					row.seq,
					new Date().toISOString(),
				);
			} catch (err) {
				this.opts.store.recordQuarantineAlertFailure(
					row.seq,
					(err as Error).name,
					5,
				);
			}
		}
	}

	private ensureCutover(): Promise<void> {
		if (this.cutoverPromise) return this.cutoverPromise;
		const attempt = Promise.resolve(this.opts.runLegacyCutover?.());
		this.cutoverPromise = attempt;
		void attempt.catch(() => {
			if (this.cutoverPromise === attempt) this.cutoverPromise = undefined;
		});
		return attempt;
	}
}

function openLeadLeaseReader(dbPath: string | undefined): LeadLeaseReader {
	if (!dbPath) return { getLease: () => undefined };
	try {
		return new LeadLeaseStore(dbPath);
	} catch (error) {
		console.warn(
			`[LeadInboxRuntime] Lead lease reader unavailable; recipient liveness will fail open: ${error instanceof Error ? error.message : String(error)}`,
		);
		return { getLease: () => undefined };
	}
}

export function resolveCodexLeadStateDir(
	projectName: string,
	leadId: string,
	root = join(homedir(), ".flywheel", "state", "codex-lead"),
): string {
	const legacy = join(root, leadId);
	if (existsSync(legacy)) return legacy;
	const safe = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_");
	const identityHex = Buffer.from(
		`${projectName}\u001f${leadId}`,
		"utf8",
	).toString("hex");
	return join(root, `${safe(projectName)}__${safe(leadId)}-${identityHex}`);
}

function createProductionAdapter(
	project: ProjectEntry,
	lead: LeadConfig,
): LeadDeliveryAdapter {
	const backend = effectiveLeadBackend(
		lead.backend,
		process.env.FLYWHEEL_LEAD_BACKEND,
	).backend;
	if (backend === "codex-app-server") {
		const authSecret = lead.botToken ?? process.env.DISCORD_BOT_TOKEN;
		if (!authSecret?.trim()) {
			throw new Error(
				`Codex Lead inbox authentication secret is missing for ${lead.agentId}`,
			);
		}
		return new CodexLeadDeliveryAdapter({
			stateDir: resolveCodexLeadStateDir(project.projectName, lead.agentId),
			leadId: lead.agentId,
			authSecret,
		});
	}
	const transport = new ClaudeCodeAdapter();
	const inboxPath = transport.getInboxPath(lead.agentId, lead.agentId);
	return new ClaudeLeadDeliveryAdapter({
		inboxPath,
		sidecarPath: `${inboxPath}.flywheel.jsonl`,
	});
}
