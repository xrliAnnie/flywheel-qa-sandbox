/**
 * GEO-195: RuntimeRegistry — manages per-lead LeadRuntime instances.
 */

import type { LeadConfig, ProjectEntry } from "../ProjectConfig.js";
import { resolveLeadForIssue } from "../ProjectConfig.js";
import type { LeadRuntime } from "./lead-runtime.js";

export class RuntimeRegistry {
	private runtimes = new Map<string, LeadRuntime>();

	register(lead: LeadConfig, runtime: LeadRuntime): void {
		this.runtimes.set(lead.agentId, runtime);
	}

	getForLead(agentId: string): LeadRuntime | undefined {
		return this.runtimes.get(agentId);
	}

	resolve(
		projects: ProjectEntry[],
		projectName: string,
		labels: string[],
	): LeadRuntime {
		const { lead } = resolveLeadForIssue(projects, projectName, labels);
		const runtime = this.runtimes.get(lead.agentId);
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
		const runtime = this.runtimes.get(lead.agentId);
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
