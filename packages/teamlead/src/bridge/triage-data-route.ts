/**
 * FLY-21: GET /api/triage/data — combined triage endpoint.
 *
 * Returns Linear issues (slim, no descriptions) + active sessions + Runner
 * capacity in a single response. Reduces Simba's 3 sequential curl calls to 1.
 */

import { Router } from "express";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";
import { filterSessionsByLead } from "./lead-scope.js";
import {
	type LinearIssue,
	LinearUpstreamError,
	queryLinearIssues,
} from "./linear-query.js";
import { resolveLinearScope, resolveProjectNameParam } from "./linear-scope.js";
import type { IStartDispatcher } from "./retry-dispatcher.js";

export interface TriageDataResponse {
	issues: LinearIssue[];
	issueCount: number;
	truncated: boolean;
	sessions: Array<Omit<Session, "issue_id"> & { identifier?: string }>;
	sessionCount: number;
	capacity: {
		running: number;
		inflight: number;
		total: number;
		/** FLY-123 WS-D (P4): `null` = uncapped (resource-based admission). */
		max: number | null;
	};
}

function omitIssueId(
	session: Session,
): Omit<Session, "issue_id"> & { identifier?: string } {
	const { issue_id: _, issue_identifier, ...rest } = session;
	return { ...rest, identifier: issue_identifier };
}

export function createTriageDataRouter(
	store: StateStore,
	projects: ProjectEntry[],
	linearApiKey: string | undefined,
	startDispatcher?: IStartDispatcher,
): Router {
	const router = Router();

	router.get("/", async (req, res) => {
		if (!linearApiKey) {
			res.status(501).json({ error: "LINEAR_API_KEY not configured" });
			return;
		}

		const project = Array.isArray(req.query.project)
			? String(req.query.project[0])
			: (req.query.project as string | undefined);
		const stateParam = Array.isArray(req.query.state)
			? (req.query.state as string[]).join(",")
			: (req.query.state as string | undefined);
		// FLY-371: optional labels filter (mirrors /api/linear/issues), usable on
		// its own to let label-scoped COEs scope the triage view.
		const labelsParam = Array.isArray(req.query.labels)
			? (req.query.labels as string[]).join(",")
			: (req.query.labels as string | undefined);
		const limitRaw =
			req.query.limit !== undefined
				? parseInt(String(req.query.limit), 10)
				: 100;
		const limit = Number.isNaN(limitRaw)
			? 100
			: Math.min(Math.max(1, limitRaw), 250);
		const leadId = req.query.leadId as string | undefined;

		// FLY-371: resolve the Flywheel projectName → Linear binding. Fail-loud on
		// a bad/unknown projectName; absent ⇒ byte-compatible.
		const bound = resolveProjectNameParam(projects, req.query.projectName);
		if (!bound.ok) {
			res.status(bound.status).json({ error: bound.error });
			return;
		}
		// The validated, normalized projectName (used to scope sessions below).
		const projectNameStr = Array.isArray(req.query.projectName)
			? String(req.query.projectName[0])
			: (req.query.projectName as string | undefined);
		// Codex R2 LOW-3: drop blank label tokens before merging so an empty
		// `?labels=` does not suppress the binding label default.
		const explicitLabels = labelsParam
			? labelsParam
					.split(",")
					.map((l) => l.trim())
					.filter(Boolean)
			: undefined;
		const scope = resolveLinearScope(bound.binding, {
			project: project ?? undefined,
			labels: explicitLabels,
		});

		try {
			const slim = req.query.slim === "true" || req.query.slim === "1";

			// Run Linear query and local queries concurrently
			const [linearResult, activeSessions] = await Promise.all([
				queryLinearIssues(linearApiKey, {
					project: scope.project,
					states: stateParam
						? stateParam.split(",").map((s) => s.trim())
						: ["backlog", "unstarted", "started"],
					labels: scope.labels,
					limit,
					slim,
				}),
				Promise.resolve(store.getActiveSessions()),
			]);

			// FLY-371: when scoped by projectName, narrow visible sessions to that
			// project BEFORE the existing leadId filter — a label-scoped COE should
			// not see other Flywheel projects' sessions. Capacity (below) stays
			// computed from ALL active sessions: it is a machine-level admission
			// signal, not a per-project view.
			const projectScopedSessions = projectNameStr
				? activeSessions.filter((s) => s.project_name === projectNameStr)
				: activeSessions;

			// Apply lead scope filter to sessions
			const filteredSessions = filterSessionsByLead(
				projectScopedSessions,
				leadId,
				projects,
			);

			// Compute capacity (global — counts ALL active sessions, not the
			// project-scoped subset above).
			const running = activeSessions.filter(
				(s) => s.status === "running",
			).length;
			const inflight = startDispatcher?.getInflightCount() ?? 0;

			const response: TriageDataResponse = {
				issues: linearResult.issues,
				issueCount: linearResult.issues.length,
				truncated: linearResult.truncated,
				sessions: filteredSessions.map(omitIssueId),
				sessionCount: filteredSessions.length,
				capacity: {
					running,
					inflight,
					total: running + inflight,
					// FLY-123 WS-D (P4): uncapped — `null` = unbounded (never `max: 0`).
					max: null,
				},
			};

			res.json(response);
		} catch (err) {
			if (err instanceof LinearUpstreamError) {
				console.error(
					"[triage-data] Linear query failed:",
					(err as Error).message,
				);
				res.status(502).json({ error: "Linear API error" });
				return;
			}
			console.error("[triage-data] Unexpected error:", (err as Error).message);
			res.status(500).json({ error: "Internal error" });
		}
	});

	return router;
}
