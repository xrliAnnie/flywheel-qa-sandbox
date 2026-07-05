/**
 * FLY-127: DepartmentRegistry — server-side spawn scope authorization.
 *
 * Wraps `ProjectEntry[]` with semantic queries so the Bridge can hard-enforce
 * "Lead → 1 department" and "Linear issue → 1 department" invariants without
 * leaking label-vs-department logic into individual routes.
 *
 * Used by:
 *   - `bridge/runs-route.ts` (spawn authorization on `/api/runs/start`)
 *
 * Future callers (out of scope for FLY-127, see follow-up FLY for lifecycle
 * authorization migration):
 *   - `/api/sessions/:executionId/close-tmux`
 *   - `/api/sessions/:executionId/close-runner`
 *   - v1.27 Discord channel router
 *
 * The registry is tolerant of un-normalized input (hand-written test fixtures
 * that don't run through `loadProjects()`): `canSpawnRunners` defaults to
 * `true` when the field is undefined (FLY-163 — explicit `false` opt-out for
 * PM/triage Leads). Production code paths still normalize once at config load
 * to avoid recomputation per call.
 */

import {
	type LeadConfig,
	type ProjectEntry,
	resolveLeadDepartment,
} from "./ProjectConfig.js";

export type ScopeReason =
	| "ok"
	| "lead_unknown"
	| "project_unknown"
	| "lead_cannot_spawn"
	| "label_mismatch"
	| "issue_no_department_label"
	| "issue_multiple_department_labels";

export interface ScopeDecision {
	allowed: boolean;
	reason: ScopeReason;
	/** Human-readable english message. Lead daemons translate to Chinese. */
	message: string;
	/** Set when the issue's labels deterministically resolve to one spawning lead. */
	canonicalLeadId?: string;
	/** Set on `issue_multiple_department_labels` for debug output. */
	matchedLeadIds?: string[];
}

export type IssueClassification =
	| { kind: "none" }
	| { kind: "one"; leadId: string; deptLabel: string }
	| { kind: "many"; leadIds: string[]; deptLabels: string[] };

/**
 * Returns the effective `canSpawnRunners` for a lead, defending against
 * un-normalized input (hand-written test fixtures).
 *   - explicit boolean → use it
 *   - undefined        → default to `true` (FLY-163: PM/triage Leads must
 *                        explicitly set `canSpawnRunners: false`)
 */
function effectiveCanSpawn(lead: LeadConfig): boolean {
	if (typeof lead.canSpawnRunners === "boolean") {
		return lead.canSpawnRunners;
	}
	return true;
}

export class DepartmentRegistry {
	constructor(private readonly projects: ProjectEntry[]) {}

	/**
	 * Strict classification of an issue's department membership against
	 * the project's spawning leads only. Case-insensitive label match.
	 */
	classifyIssue(
		projectName: string,
		issueLabels: string[],
	): IssueClassification {
		const project = this.projects.find((p) => p.projectName === projectName);
		if (!project) return { kind: "none" };

		const lowerLabels = new Set(issueLabels.map((l) => l.toLowerCase()));
		const matches: { leadId: string; deptLabel: string }[] = [];

		for (const lead of project.leads) {
			if (!effectiveCanSpawn(lead)) continue;
			// Spawning leads are validated to have exactly 1 label by loadProjects(),
			// but defend against unvalidated test fixtures: take the first label
			// that intersects.
			for (const label of lead.match.labels) {
				if (lowerLabels.has(label.toLowerCase())) {
					matches.push({ leadId: lead.agentId, deptLabel: label });
					break;
				}
			}
		}

		if (matches.length === 0) return { kind: "none" };
		if (matches.length === 1) {
			const m = matches[0]!;
			return { kind: "one", leadId: m.leadId, deptLabel: m.deptLabel };
		}
		return {
			kind: "many",
			leadIds: matches.map((m) => m.leadId),
			deptLabels: matches.map((m) => m.deptLabel),
		};
	}

	/** True iff the named lead is configured to spawn Runners. Fail-closed on unknowns. */
	canSpawnRunners(projectName: string, leadId: string): boolean {
		const project = this.projects.find((p) => p.projectName === projectName);
		if (!project) return false;
		const lead = project.leads.find((l) => l.agentId === leadId);
		if (!lead) return false;
		return effectiveCanSpawn(lead);
	}

	/**
	 * FLY-137 v1.27.2: resolve a Lead's department.
	 * Returns `undefined` if the project / lead is unknown OR if both
	 * `lead.department` and `lead.match.labels[0]` are absent.
	 * Project-scoped because leadId is only unique within a project.
	 */
	getLeadDepartment(projectName: string, leadId: string): string | undefined {
		const project = this.projects.find((p) => p.projectName === projectName);
		if (!project) return undefined;
		const lead = project.leads.find((l) => l.agentId === leadId);
		if (!lead) return undefined;
		return resolveLeadDepartment(lead);
	}

	/**
	 * FLY-137 v1.27.2: resolve the owning department for an issue given its
	 * Linear labels. Used by `runs-route.ts` to compute `owningDept` for
	 * `AgentDispatcher.dispatch({ owningDept })`.
	 *
	 * Returns:
	 *   - the dept string when exactly one Lead's labels match (classifyIssue "one")
	 *   - `"multiple"` when 2+ Leads match (FLY-127 ambiguous case; runs-route
	 *     usually rejects this at Bridge layer, but dispatcher must still handle
	 *     deterministically for retry/feature-off paths)
	 *   - `undefined` when no Lead matches OR the project is unknown
	 */
	getDepartmentForIssue(
		projectName: string,
		issueLabels: string[],
	): string | "multiple" | undefined {
		const cls = this.classifyIssue(projectName, issueLabels);
		if (cls.kind === "none") return undefined;
		if (cls.kind === "one") {
			return this.getLeadDepartment(projectName, cls.leadId) ?? undefined;
		}
		return "multiple";
	}

	/**
	 * Convenience wrapper for the `leadId`-omitted path in `/api/runs/start`.
	 * Returns the unique spawning lead OR a ScopeDecision describing why no
	 * canonical lead exists.
	 */
	resolveCanonicalLead(
		projectName: string,
		issueLabels: string[],
	): { ok: true; lead: LeadConfig } | { ok: false; decision: ScopeDecision } {
		const project = this.projects.find((p) => p.projectName === projectName);
		if (!project) {
			return {
				ok: false,
				decision: {
					allowed: false,
					reason: "project_unknown",
					message: `Project "${projectName}" is not configured`,
				},
			};
		}

		const cls = this.classifyIssue(projectName, issueLabels);
		if (cls.kind === "one") {
			const lead = project.leads.find((l) => l.agentId === cls.leadId);
			if (lead) return { ok: true, lead };
			// Should never happen — classifyIssue uses project.leads — but fail-closed.
			return {
				ok: false,
				decision: {
					allowed: false,
					reason: "lead_unknown",
					message: `Canonical lead "${cls.leadId}" disappeared from project config`,
				},
			};
		}

		if (cls.kind === "many") {
			return {
				ok: false,
				decision: {
					allowed: false,
					reason: "issue_multiple_department_labels",
					message:
						`Issue has multiple department labels (${cls.deptLabels.join(", ")}); ` +
						`cannot determine canonical lead. Annie must reduce to one department label.`,
					matchedLeadIds: cls.leadIds,
				},
			};
		}

		return {
			ok: false,
			decision: {
				allowed: false,
				reason: "issue_no_department_label",
				message:
					`Issue has no department label matching any spawning lead in project "${projectName}". ` +
					`Add a department label (e.g. Product / Operations) before starting a Runner.`,
			},
		};
	}

	/**
	 * **Spawn authorization**, not generic department membership.
	 * `lead_cannot_spawn` precedes label checks, so a non-spawning lead is
	 * "out of scope" for `/api/runs/start` even if its `match.labels` overlap
	 * the issue. Future generic membership callers (channel routing in v1.27)
	 * should compose `classifyIssue` + `canSpawnRunners` instead of reusing
	 * this method. (Codex R2 #4)
	 *
	 * Decision precedence:
	 *   1. project_unknown
	 *   2. lead_unknown
	 *   3. lead_cannot_spawn
	 *   4. issue_no_department_label
	 *   5. issue_multiple_department_labels
	 *   6. label_mismatch
	 *   7. ok
	 */
	isLeadInScope(
		projectName: string,
		leadId: string,
		issueLabels: string[],
	): ScopeDecision {
		const project = this.projects.find((p) => p.projectName === projectName);
		if (!project) {
			return {
				allowed: false,
				reason: "project_unknown",
				message: `Project "${projectName}" is not configured`,
			};
		}

		const lead = project.leads.find((l) => l.agentId === leadId);
		if (!lead) {
			return {
				allowed: false,
				reason: "lead_unknown",
				message: `Lead "${leadId}" is not configured for project "${projectName}"`,
			};
		}

		if (!effectiveCanSpawn(lead)) {
			return {
				allowed: false,
				reason: "lead_cannot_spawn",
				message: `Lead "${leadId}" is not authorized to spawn Runners (canSpawnRunners=false)`,
			};
		}

		const cls = this.classifyIssue(projectName, issueLabels);
		if (cls.kind === "none") {
			return {
				allowed: false,
				reason: "issue_no_department_label",
				message:
					`Issue has no department label matching any spawning lead in project "${projectName}". ` +
					`Add a department label (e.g. Product / Operations) before starting a Runner.`,
			};
		}

		if (cls.kind === "many") {
			return {
				allowed: false,
				reason: "issue_multiple_department_labels",
				message:
					`Issue has multiple department labels (${cls.deptLabels.join(", ")}); ` +
					`Annie must reduce to one department label before any lead can spawn.`,
				matchedLeadIds: cls.leadIds,
			};
		}

		if (cls.leadId !== leadId) {
			return {
				allowed: false,
				reason: "label_mismatch",
				message:
					`Issue belongs to "${cls.leadId}" (label "${cls.deptLabel}"); ` +
					`lead "${leadId}" is out of scope.`,
				canonicalLeadId: cls.leadId,
			};
		}

		return {
			allowed: true,
			reason: "ok",
			message: "ok",
			canonicalLeadId: cls.leadId,
		};
	}
}
