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

export class RuntimeRegistry {
	private runtimes = new Map<string, LeadRuntime>();
	private wrappedRuntimes = new Map<string, LeadRuntime>();
	private deliveryInterceptor?: DeliveryInterceptor;

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
