/** FLY-1373 Bridge assembly for per-Lead inbox loops. */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeAdapter } from "flywheel-agent-team-transport";
import { CommDB } from "flywheel-comm/db";
import { MailboxQueue } from "flywheel-comm/mailbox-queue";
import { encodeSenderRef } from "flywheel-comm/sender-ref";
import { effectiveLeadBackend } from "../lead-backends/lead-backend.js";
import type { LeadConfig, ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import {
	ClaudeLeadDeliveryAdapter,
	CodexLeadDeliveryAdapter,
	type LeadDeliveryAdapter,
} from "./lead-delivery-adapter.js";
import type { DeliverySecretProvider } from "./lead-event-delivery.js";
import { enqueueLeadEvent as enqueueEvent } from "./lead-event-queue.js";
import { LeadInboxLoop } from "./lead-inbox-loop.js";
import type { LeadEventEnvelope } from "./lead-runtime.js";
import { matchesLead } from "./lead-scope.js";
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
}

export class LeadInboxRuntime {
	private readonly loops = new Map<string, LeadInboxLoop>();
	private readonly queues = new Map<string, MailboxQueue>();
	private readonly admissions: QuestionAdmission[] = [];
	private readonly runnerAdapters: RunnerMailboxDeliveryAdapter[] = [];
	private readonly projectByLead = new Map<string, ProjectEntry>();
	private readonly ownerEpoch: string;
	private cutoverPromise?: Promise<void>;

	constructor(private readonly opts: LeadInboxRuntimeOptions) {
		this.ownerEpoch = opts.ownerEpoch ?? randomUUID();
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
			const runnerLane = new RunnerMailboxLane({
				queue,
				ownerEpoch: this.ownerEpoch,
				deliver: (envelope) => runnerAdapter.deliver(envelope),
				resolveQuestion: (questionId) =>
					runnerAdapter.resolveQuestion(questionId),
			});
			for (const [leadIndex, lead] of project.leads.entries()) {
				if (this.projectByLead.has(lead.agentId)) {
					throw new Error(`duplicate Lead id across projects: ${lead.agentId}`);
				}
				this.projectByLead.set(lead.agentId, project);
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
					secretProvider,
				});
				const loop = new LeadInboxLoop({
					queue,
					leadId: lead.agentId,
					ownerEpoch: this.ownerEpoch,
					adapter: adapterForLead(project, lead),
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
						if (leadIndex === 0) await runnerLane.tick();
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
		this.nudge(envelope.leadId, project.projectName);
		return result;
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

	private key(projectName: string, leadId: string): string {
		return `${projectName}\u001f${leadId}`;
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
