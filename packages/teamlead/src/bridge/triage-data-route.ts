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
		max: number;
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
	maxConcurrentRunners: number,
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
		const limitRaw =
			req.query.limit !== undefined
				? parseInt(String(req.query.limit), 10)
				: 100;
		const limit = Number.isNaN(limitRaw)
			? 100
			: Math.min(Math.max(1, limitRaw), 250);
		const leadId = req.query.leadId as string | undefined;

		try {
			const slim = req.query.slim === "true" || req.query.slim === "1";

			// Run Linear query and local queries concurrently
			const [linearResult, activeSessions] = await Promise.all([
				queryLinearIssues(linearApiKey, {
					project: project ?? undefined,
					states: stateParam
						? stateParam.split(",").map((s) => s.trim())
						: ["backlog", "unstarted", "started"],
					limit,
					slim,
				}),
				Promise.resolve(store.getActiveSessions()),
			]);

			// Apply lead scope filter to sessions
			const filteredSessions = filterSessionsByLead(
				activeSessions,
				leadId,
				projects,
			);

			// Compute capacity
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
					max: maxConcurrentRunners,
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
