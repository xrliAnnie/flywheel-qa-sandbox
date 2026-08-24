/**
 * GEO-195: RuntimeRegistry — manages per-lead LeadRuntime instances.
 */

import type { LeadConfig, ProjectEntry } from "../ProjectConfig.js";
import { resolveLeadForIssue } from "../ProjectConfig.js";
import type {
	DeliveryResult,
	LeadEventEnvelope,
	LeadRuntime,
} from "./lead-runtime.js";

export type DeliveryInterceptor = (
	runtime: LeadRuntime,
	envelope: LeadEventEnvelope,
) => Promise<DeliveryResult>;

export interface DurableQueueReceipt {
	queued: true;
	deliveryId: string;
	seq: number;
	outcome?: "inserted" | "active" | "archived";
}

export interface LeadEventDispatchResult extends DeliveryResult {
	queued?: true;
}

export type LeadEventEnqueuer = (
	envelope: LeadEventEnvelope,
	content: string,
) => DurableQueueReceipt;

export interface LeadEventDispatcher {
	dispatchLeadEvent?: (
		envelope: LeadEventEnvelope,
	) => Promise<LeadEventDispatchResult>;
}

/** Compatibility belongs at one boundary; production registries always queue. */
export function dispatchLeadEventCompat(
	registry: LeadEventDispatcher,
	runtime: Pick<LeadRuntime, "deliver">,
	envelope: LeadEventEnvelope,
): Promise<LeadEventDispatchResult> {
	return registry.dispatchLeadEvent
		? registry.dispatchLeadEvent(envelope)
		: runtime.deliver(envelope);
}

export class RuntimeRegistry {
	private runtimes = new Map<string, LeadRuntime>();
	private wrappedRuntimes = new Map<string, LeadRuntime>();
	private deliveryInterceptor?: DeliveryInterceptor;
	private leadEventEnqueuer?: LeadEventEnqueuer;
	private leadInboxNudge?: (leadId: string, projectName?: string) => boolean;

	register(lead: LeadConfig, runtime: LeadRuntime): void {
		this.runtimes.set(lead.agentId, runtime);
		this.wrappedRuntimes.delete(lead.agentId);
	}

	getForLead(agentId: string): LeadRuntime | undefined {
		const runtime = this.runtimes.get(agentId);
		if (!runtime || !this.deliveryInterceptor) return runtime;
		const existing = this.wrappedRuntimes.get(agentId);
		if (existing) return existing;
		const interceptor = this.deliveryInterceptor;
		const wrapped: LeadRuntime = {
			type: runtime.type,
			deliver: (envelope) => interceptor(runtime, envelope),
			...(runtime.renderEnvelope
				? { renderEnvelope: (envelope) => runtime.renderEnvelope!(envelope) }
				: {}),
			sendBootstrap: (snapshot) => runtime.sendBootstrap(snapshot),
			health: () => runtime.health(),
			shutdown: () => runtime.shutdown(),
		};
		this.wrappedRuntimes.set(agentId, wrapped);
		return wrapped;
	}

	getRawForLead(agentId: string): LeadRuntime | undefined {
		return this.runtimes.get(agentId);
	}

	setDeliveryInterceptor(interceptor?: DeliveryInterceptor): void {
		this.deliveryInterceptor = interceptor;
		this.wrappedRuntimes.clear();
	}

	setLeadEventEnqueuer(enqueuer?: LeadEventEnqueuer): void {
		this.leadEventEnqueuer = enqueuer;
	}

	enqueueLeadEvent(envelope: LeadEventEnvelope): DurableQueueReceipt {
		if (!this.leadEventEnqueuer) {
			throw new Error("Lead event queue is not configured");
		}
		const runtime = this.runtimes.get(envelope.leadId);
		if (!runtime) {
			throw new Error(`No runtime registered for lead "${envelope.leadId}"`);
		}
		const content =
			runtime.renderEnvelope?.(envelope) ?? JSON.stringify(envelope.event);
		return this.leadEventEnqueuer(envelope, content);
	}

	async dispatchLeadEvent(
		envelope: LeadEventEnvelope,
	): Promise<LeadEventDispatchResult> {
		if (this.leadEventEnqueuer) {
			this.enqueueLeadEvent(envelope);
			return { delivered: false, queued: true };
		}
		const runtime = this.getForLead(envelope.leadId);
		if (!runtime) return { delivered: false, error: "no runtime registered" };
		return runtime.deliver(envelope);
	}

	setLeadInboxNudge(
		handler?: (leadId: string, projectName?: string) => boolean,
	): void {
		this.leadInboxNudge = handler;
	}

	nudgeLeadInbox(leadId: string, projectName?: string): boolean {
		return this.leadInboxNudge?.(leadId, projectName) ?? false;
	}

	resolve(
		projects: ProjectEntry[],
		projectName: string,
		labels: string[],
	): LeadRuntime {
		const { lead } = resolveLeadForIssue(projects, projectName, labels);
		const runtime = this.getForLead(lead.agentId);
		if (!runtime) {
			throw new Error(
				`No runtime registered for lead "${lead.agentId}" (project: ${projectName})`,
			);
		}
		return runtime;
	}

	/** Resolve lead AND return its agentId. */
	resolveWithLead(
		projects: ProjectEntry[],
		projectName: string,
		labels: string[],
	): { runtime: LeadRuntime; lead: LeadConfig } {
		const { lead } = resolveLeadForIssue(projects, projectName, labels);
		const runtime = this.getForLead(lead.agentId);
		if (!runtime) {
			throw new Error(
				`No runtime registered for lead "${lead.agentId}" (project: ${projectName})`,
			);
		}
		return { runtime, lead };
	}

	async shutdownAll(): Promise<void> {
		for (const rt of this.runtimes.values()) {
			await rt.shutdown();
		}
	}

	get size(): number {
		return this.runtimes.size;
	}
}
