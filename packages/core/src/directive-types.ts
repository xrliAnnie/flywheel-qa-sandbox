/**
 * Directive types — GEO-158: audit-only scope.
 * Union design for extensibility (future: notify, state_update, etc.)
 */

// GEO-158: audit-only. Union 设计为可扩展（后续加 notify 等）。
export type Directive = AuditDirective;

export interface AuditDirective {
	type: "audit";
	executionId: string;
	issueId: string;
	projectName: string;
	fromState: string;
	toState: string;
	trigger: string;
}
