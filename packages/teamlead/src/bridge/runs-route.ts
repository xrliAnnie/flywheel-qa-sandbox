/**
 * GEO-267: /api/runs routes — start new Runner executions.
 *
 * POST /api/runs/start — start a Runner for an issue
 * GET  /api/runs/active — query active run counts
 */

import { Router } from "express";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import type { IStartDispatcher } from "./retry-dispatcher.js";

/** Poll interval / max wait for Forum Post thread_id to appear on session. */
const THREAD_POLL_INTERVAL_MS = 500;
const THREAD_POLL_MAX_MS = 5000;

export function createRunsRouter(
	startDispatcher: IStartDispatcher,
	store: StateStore,
	projects: ProjectEntry[],
	maxConcurrentRunners: number,
	discordGuildId?: string,
): Router {
	const router = Router();

	router.post("/start", async (req, res) => {
		// GEO-267: LINEAR_API_KEY is required for issue hydration (PreHydrator).
		// Without it, Runner gets stub metadata → degraded agent routing.
		if (!process.env.LINEAR_API_KEY) {
			res.status(503).json({
				success: false,
				message:
					"LINEAR_API_KEY not configured — cannot hydrate issue data for Runner",
			});
			return;
		}

		const { issueId, projectName, leadId } = req.body;

		// Input validation
		if (!issueId || typeof issueId !== "string") {
			res.status(400).json({
				success: false,
				message: "issueId is required",
			});
			return;
		}
		if (!projectName || typeof projectName !== "string") {
			res.status(400).json({
				success: false,
				message: "projectName is required",
			});
			return;
		}

		// Check: no active session for this issue
		const activeSessions = store.getActiveSessions();
		const alreadyActive = activeSessions.find(
			(s) =>
				s.issue_id === issueId &&
				["running", "awaiting_review"].includes(s.status),
		);
		if (alreadyActive) {
			res.status(409).json({
				success: false,
				message: `Issue ${issueId} already has an active session (${alreadyActive.execution_id}, status: ${alreadyActive.status})`,
			});
			return;
		}

		// Concurrency cap: StateStore running + inflight reservations
		const runningInStore = activeSessions.filter(
			(s) => s.status === "running",
		).length;
		const inflightCount = startDispatcher.getInflightCount();
		const totalActive = runningInStore + inflightCount;
		if (totalActive >= maxConcurrentRunners) {
			res.status(429).json({
				success: false,
				message: `Max concurrent runners reached (${maxConcurrentRunners}). Running: ${runningInStore}, inflight: ${inflightCount}`,
			});
			return;
		}

		// Lead scope validation — project membership check
		if (leadId) {
			const project = projects.find((p) => p.projectName === projectName);
			if (project) {
				const leadExists = project.leads.some((l) => l.agentId === leadId);
				if (!leadExists) {
					res.status(403).json({
						success: false,
						message: `Lead "${leadId}" is not configured for project "${projectName}"`,
					});
					return;
				}
			}
		}

		// Pre-flight: verify issue exists in Linear before dispatching.
		// This prevents fire-and-forget from silently using stub metadata
		// when the issue doesn't exist or Linear API is unreachable.
		try {
			const { LinearClient } = await import("@linear/sdk");
			const client = new LinearClient({
				apiKey: process.env.LINEAR_API_KEY!,
			});
			const issue = await client.issue(issueId);
			if (!issue) {
				res.status(404).json({
					success: false,
					message: `Issue ${issueId} not found in Linear`,
				});
				return;
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(
				`[runs/start] Linear pre-flight failed for ${issueId}:`,
				msg,
			);
			res.status(502).json({
				success: false,
				message: `Cannot verify issue ${issueId} in Linear: ${msg}`,
			});
			return;
		}

		try {
			const result = await startDispatcher.start({
				issueId,
				projectName,
				leadId,
			});

			// FLY-24: Poll for Forum Post thread_id (created async by Blueprint → emitStarted → ensureForumPost)
			let threadId: string | undefined;
			const deadline = Date.now() + THREAD_POLL_MAX_MS;
			while (Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, THREAD_POLL_INTERVAL_MS));
				const session = store.getSession(result.executionId);
				if (session?.thread_id) {
					threadId = session.thread_id;
					break;
				}
			}

			const forumLink =
				threadId && discordGuildId
					? `https://discord.com/channels/${discordGuildId}/${threadId}`
					: undefined;

			res.json({
				success: true,
				executionId: result.executionId,
				issueId: result.issueId,
				threadId,
				forumLink,
				message: `Runner started for ${issueId}`,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (
				message.includes("Max concurrent") ||
				message.includes("max concurrent")
			) {
				res.status(429).json({ success: false, message });
			} else if (message.includes("already in progress")) {
				res.status(409).json({ success: false, message });
			} else if (message.includes("No runtime for project")) {
				res.status(404).json({ success: false, message });
			} else {
				console.error("[runs/start] Unexpected error:", message);
				res.status(500).json({ success: false, message });
			}
		}
	});

	router.get("/active", (_req, res) => {
		const running = store
			.getActiveSessions()
			.filter((s) => s.status === "running").length;
		const inflight = startDispatcher.getInflightCount();
		res.json({
			running,
			inflight,
			total: running + inflight,
			max: maxConcurrentRunners,
		});
	});

	return router;
}
