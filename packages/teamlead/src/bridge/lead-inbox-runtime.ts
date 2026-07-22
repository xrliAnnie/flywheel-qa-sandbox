/** FLY-1373 Bridge assembly for per-Lead inbox loops. */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	ClaudeCodeAdapter,
	probeLegacyMailboxDelivery,
} from "flywheel-agent-team-transport";
import { LeadInboxQueue } from "flywheel-comm/lead-inbox-queue";
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
import { LegacyAckDrain } from "./legacy-ack-drain.js";
import { LegacyLeadEventReconciler } from "./legacy-lead-event-reconciler.js";
import { ProtocolIngress } from "./protocol-ingress.js";
import { QuestionAdmission } from "./question-admission.js";
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
	/** Test seam for the one-shot boot cutover. */
	runLegacyCutover?: () => void | Promise<void>;
	afterTickStartedForLead?: (
		projectName: string,
		leadId: string,
	) => Promise<void>;
}

export class LeadInboxRuntime {
	private readonly loops = new Map<string, LeadInboxLoop>();
	private readonly queues = new Map<string, LeadInboxQueue>();
	private readonly projectByLead = new Map<string, ProjectEntry>();
	private readonly ownerEpoch: string;
	private cutoverPromise?: Promise<void>;

	constructor(private readonly opts: LeadInboxRuntimeOptions) {
		this.ownerEpoch = opts.ownerEpoch ?? randomUUID();
		const adapterForLead = opts.adapterForLead ?? createProductionAdapter;
		const secretProvider =
			opts.secretProvider ??
			({
				getActive: () => {
					throw new Error("legacy ACK secret provider is not configured");
				},
			} satisfies DeliverySecretProvider);
		for (const project of opts.projects) {
			const queue = new LeadInboxQueue(
				opts.commDbPathForProject(project.projectName),
			);
			this.queues.set(project.projectName, queue);
			for (const lead of project.leads) {
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
				const protocol = new ProtocolIngress({
					queue,
					dbPath: opts.commDbPathForProject(project.projectName),
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
					admit: async () => {
						await this.ensureCutover(secretProvider);
						await admission.materializePending();
						protocol.materializePending(lead.agentId);
					},
					handleProtocol: (row) => protocol.handle(row),
					onProtocolQuarantine: (row, error) => {
						queue.enqueue({
							id: `protocol_alert:${lead.agentId}:${row.id}`,
							toLead: lead.agentId,
							source: `protocol_quarantine:${row.id}`,
							type: "protocol_quarantined",
							msgClass: "model",
							priority: 2,
							content:
								`[protocol_quarantined] ${row.type} (${row.id}) was rejected after repeated failures: ` +
								error.message,
						});
					},
					revalidateModel: (row) => admission.revalidate(row),
					markAuditDelivered: (row) => {
						const match = /^(?:lead_event|question):(\d+)$/.exec(row.source);
						if (!match) return;
						opts.store.markLeadEventDelivered(Number(match[1]));
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
		for (const queue of this.queues.values()) queue.close();
		this.loops.clear();
		this.queues.clear();
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
		queue: LeadInboxQueue;
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

	private ensureCutover(secretProvider: DeliverySecretProvider): Promise<void> {
		if (this.cutoverPromise) return this.cutoverPromise;
		const attempt = Promise.resolve().then(async () => {
			if (this.opts.runLegacyCutover) {
				await this.opts.runLegacyCutover();
				return;
			}
			const now = new Date().toISOString();
			for (const queue of this.queues.values()) {
				if (
					!queue.acquireOrRenewOwner({
						ownerEpoch: this.ownerEpoch,
						now,
						leaseTtlMs: 10_000,
					})
				) {
					throw new Error("owner lease unavailable during inbox cutover");
				}
			}
			new LegacyAckDrain({
				store: this.opts.store,
				commDbPaths: this.opts.projects.map(({ projectName }) =>
					this.opts.commDbPathForProject(projectName),
				),
				secretProvider,
			}).run();
			await new LegacyLeadEventReconciler({
				store: this.opts.store,
				registry: this.opts.registry,
				ownerEpoch: this.ownerEpoch,
				queueForLead: (leadId) => {
					const project = this.projectByLead.get(leadId);
					return project ? this.queues.get(project.projectName) : undefined;
				},
				probeLegacyDelivery: async ({ row, aliases, content }) => {
					const project = this.projectByLead.get(row.lead_id);
					const lead = project?.leads.find(
						(candidate) => candidate.agentId === row.lead_id,
					);
					if (!project || !lead) return { status: "none" };
					const backend = effectiveLeadBackend(
						lead.backend,
						process.env.FLYWHEEL_LEAD_BACKEND,
					).backend;
					if (backend === "codex-app-server") return { status: "none" };
					const transport = new ClaudeCodeAdapter();
					const inboxPath = transport.getInboxPath(lead.agentId, lead.agentId);
					return probeLegacyMailboxDelivery({
						inboxPath,
						sidecarPath: `${inboxPath}.flywheel.jsonl`,
						aliases,
						to: lead.agentId,
						content,
					});
				},
			}).run();
		});
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
