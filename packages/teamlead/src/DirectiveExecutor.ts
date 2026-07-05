/**
 * DirectiveExecutor — Drains directives from FSM transitions.
 * GEO-158: audit-only scope. Extensible for future directive types.
 */

import { randomUUID } from "node:crypto";
import type { AuditDirective, Directive } from "flywheel-core";
import type { StateStore } from "./StateStore.js";

export interface DirectiveResult {
	type: string;
	success: boolean;
	error?: string;
}

export class DirectiveExecutor {
	constructor(private store: StateStore) {}

	/** Drain directives sequentially (audit order matters). */
	async drain(directives: Directive[]): Promise<DirectiveResult[]> {
		const results: DirectiveResult[] = [];
		for (const d of directives) {
			results.push(this.execute(d));
		}
		return results;
	}

	private execute(d: Directive): DirectiveResult {
		switch (d.type) {
			case "audit":
				return this.handleAudit(d);
			default:
				return {
					type: (d as { type: string }).type,
					success: false,
					error: `Unknown directive type: ${(d as { type: string }).type}`,
				};
		}
	}

	private handleAudit(d: AuditDirective): DirectiveResult {
		this.store.insertEvent({
			event_id: randomUUID(),
			execution_id: d.executionId,
			issue_id: d.issueId,
			project_name: d.projectName,
			event_type: "state_transition",
			payload: { from: d.fromState, to: d.toState, trigger: d.trigger },
			source: "fsm",
		});
		return { type: "audit", success: true };
	}
}
