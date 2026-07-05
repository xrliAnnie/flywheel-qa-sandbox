/**
 * GEO-259: Lead Scope Filter — shared utility for filtering sessions by Lead scope.
 *
 * Design goals:
 * - No StateStore dependency (reads session.issue_labels directly, pure function)
 * - No silent catch (matchesLead throws on verify errors; filterSessionsByLead logs warnings)
 * - Clear error taxonomy: label parsing = format compat; unknown project = verify error
 */

import type { ProjectEntry } from "../ProjectConfig.js";
import { resolveLeadForIssue } from "../ProjectConfig.js";
import type { Session } from "../StateStore.js";

/**
 * Parse issue_labels from a session object.
 * Accepts JSON string[] (standard) or CSV (legacy compatibility).
 * This is format normalization, NOT a verify error path.
 *
 * Contract:
 * - JSON.parse succeeds AND result is string[] → return parsed array
 * - JSON.parse succeeds but result is NOT string[] → fall through to CSV
 * - JSON.parse fails → fall through to CSV
 */
export function parseSessionLabels(session: Session): string[] {
	if (!session.issue_labels) return [];
	try {
		const parsed: unknown = JSON.parse(session.issue_labels);
		if (
			Array.isArray(parsed) &&
			parsed.every((item): item is string => typeof item === "string")
		) {
			return parsed;
		}
	} catch {
		// JSON parse failed — fall through to CSV
	}
	// CSV fallback (legacy compatibility)
	return session.issue_labels
		.split(",")
		.map((l) => l.trim())
		.filter(Boolean);
}

/**
 * Check if a session belongs to a specific Lead's scope
 * (project + label routing match).
 *
 * Returns false for out-of-scope sessions.
 * Throws on verify errors (unknown project, missing config) — callers must handle.
 */
export function matchesLead(
	session: Session,
	leadId: string,
	projects: ProjectEntry[],
): boolean {
	const labels = parseSessionLabels(session);
	const { lead } = resolveLeadForIssue(projects, session.project_name, labels);
	return lead.agentId === leadId;
}

/**
 * Filter a session array to only those matching a Lead's scope.
 * If leadId is undefined, returns all sessions (no-op).
 * Verify errors → warn + exclude (not silently dropped).
 */
export function filterSessionsByLead(
	sessions: Session[],
	leadId: string | undefined,
	projects: ProjectEntry[],
): Session[] {
	if (!leadId) return sessions;
	return sessions.filter((s) => {
		try {
			return matchesLead(s, leadId, projects);
		} catch (err) {
			console.warn(
				`[lead-scope] Cannot resolve lead for session ${s.execution_id} ` +
					`(project: ${s.project_name}): ${(err as Error).message}`,
			);
			return false;
		}
	});
}
