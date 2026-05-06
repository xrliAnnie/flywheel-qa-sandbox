/**
 * GEO-267: /api/runs routes — start new Runner executions.
 *
 * POST /api/runs/start — start a Runner for an issue
 * GET  /api/runs/active — query active run counts
 */

import { Router } from "express";
import {
	DepartmentRegistry,
	type ScopeDecision,
} from "../department-registry.js";
import type { ProjectEntry } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import { validateAndRegisterChatThread } from "./chat-thread-register.js";
import type { IStartDispatcher } from "./retry-dispatcher.js";

/** Poll interval / max wait for Forum Post thread_id to appear on session. */
const THREAD_POLL_INTERVAL_MS = 500;
const THREAD_POLL_MAX_MS = 5000;

/**
 * FLY-127: Structured rejection log for spawn-scope denials.
 * One line per rejection at warn level so Annie / on-call can grep by reason.
 */
function logRejection(
	decision: ScopeDecision,
	ctx: {
		projectName: string;
		issueIdentifier: string | undefined;
		leadId: string | undefined;
		issueLabels: string[];
	},
): void {
	console.warn(
		`[runs/start FLY-127 reject] reason=${decision.reason} ` +
			`projectName=${ctx.projectName} ` +
			`leadId=${ctx.leadId ?? "<none>"} ` +
			`issueIdentifier=${ctx.issueIdentifier ?? "<none>"} ` +
			`issueLabels=${JSON.stringify(ctx.issueLabels)} ` +
			`canonicalLeadId=${decision.canonicalLeadId ?? "<none>"} ` +
			`matchedLeadIds=${JSON.stringify(decision.matchedLeadIds ?? [])}`,
	);
}

export function createRunsRouter(
	startDispatcher: IStartDispatcher,
	store: StateStore,
	projects: ProjectEntry[],
	maxConcurrentRunners: number,
	discordGuildId?: string,
	chatThreadsEnabled?: boolean,
): Router {
	const router = Router();
	// FLY-127: Single registry instance per router; safe to capture because
	// `projects` is loaded once at boot. Bridge restart picks up config edits.
	const registry = new DepartmentRegistry(projects);

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

		const { issueId, projectName, sessionRole } = req.body;
		let leadId = req.body.leadId as string | undefined;

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

		// FLY-59: Per-role dedup — same issue can have main + qa concurrently
		const role =
			(typeof sessionRole === "string" ? sessionRole : undefined) ?? "main";
		const activeSessions = store.getActiveSessions();
		const alreadyActive = activeSessions.find(
			(s) =>
				s.issue_id === issueId &&
				(s.session_role ?? "main") === role &&
				["running", "awaiting_review"].includes(s.status),
		);
		if (alreadyActive) {
			res.status(409).json({
				success: false,
				message: `Issue ${issueId} already has an active session for role "${role}" (${alreadyActive.execution_id}, status: ${alreadyActive.status})`,
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
		// Also captures title/identifier for session metadata patching (FLY-24 Bug 1).
		let issueTitle: string | undefined;
		let issueIdentifier: string | undefined;
		let issueLabels: string[] = [];
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
			issueTitle = issue.title;
			issueIdentifier = issue.identifier;

			// FLY-127: Always hydrate labels (was: only on auto-resolve).
			// Department scope enforcement requires them for every spawn path.
			// Fail-closed on label fetch error → 502 below.
			try {
				const labelConn = await issue.labels();
				issueLabels = labelConn.nodes.map((l: { name: string }) => l.name);
			} catch (labelErr) {
				const msg =
					labelErr instanceof Error ? labelErr.message : String(labelErr);
				console.error(
					`[runs/start FLY-127] label hydration failed for ${issueIdentifier}:`,
					msg,
				);
				res.status(502).json({
					success: false,
					message: `Cannot fetch labels for ${issueIdentifier} from Linear: ${msg}`,
					reason: "linear_labels_unavailable",
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

		// FLY-127: Department scope enforcement (server-side authority).
		// When leadId omitted, registry resolves canonically (NOT
		// resolveLeadForIssue's leads[0] fallback). When leadId provided,
		// registry verifies the issue is in that lead's scope.
		if (!leadId) {
			const resolution = registry.resolveCanonicalLead(
				projectName,
				issueLabels,
			);
			if (!resolution.ok) {
				logRejection(resolution.decision, {
					projectName,
					issueIdentifier,
					leadId: undefined,
					issueLabels,
				});
				res.status(403).json({
					success: false,
					message: resolution.decision.message,
					reason: resolution.decision.reason,
					issueIdentifier,
					issueLabels,
					matchedLeadIds: resolution.decision.matchedLeadIds,
				});
				return;
			}
			leadId = resolution.lead.agentId;
			console.log(
				`[runs/start FLY-127] Auto-resolved leadId to "${leadId}" for ${issueIdentifier}`,
			);
		}

		const decision = registry.isLeadInScope(projectName, leadId, issueLabels);
		if (!decision.allowed) {
			logRejection(decision, {
				projectName,
				issueIdentifier,
				leadId,
				issueLabels,
			});
			res.status(403).json({
				success: false,
				message: decision.message,
				reason: decision.reason,
				issueIdentifier,
				leadId,
				issueLabels,
				canonicalLeadId: decision.canonicalLeadId,
				matchedLeadIds: decision.matchedLeadIds,
			});
			return;
		}

		// FLY-91 Round 2: Pre-register chat thread if Lead already created one.
		// Must happen AFTER leadId resolution, BEFORE dispatch (so ensureChatThread() skips).
		if (chatThreadsEnabled) {
			const chatThreadId = req.body.chatThreadId as string | undefined;
			const chatChannelId = req.body.chatChannelId as string | undefined;

			// Pair validation: both or neither
			if (
				(chatThreadId && !chatChannelId) ||
				(!chatThreadId && chatChannelId)
			) {
				res.status(400).json({
					success: false,
					message:
						"chatThreadId and chatChannelId must both be provided or both omitted",
				});
				return;
			}

			if (chatThreadId && chatChannelId) {
				if (!leadId) {
					res.status(400).json({
						success: false,
						message: "leadId is required when chatThreadId is provided",
					});
					return;
				}
				const regResult = await validateAndRegisterChatThread(
					{
						threadId: chatThreadId,
						channelId: chatChannelId,
						issueId,
						leadId,
						projectName,
					},
					store,
					projects,
				);
				if (!regResult.ok) {
					res.status(regResult.status).json({
						success: false,
						message: regResult.error,
					});
					return;
				}
			}
		}

		try {
			// FLY-24: Pass pre-fetched title/identifier so Blueprint's EventEnvelope
			// uses real metadata (PreHydrator may fail Linear API and fall back to stub title).
			const result = await startDispatcher.start({
				issueId,
				projectName,
				leadId,
				issueTitle,
				issueIdentifier,
				sessionRole: role,
			});

			// FLY-24 + FLY-91: Poll for Forum thread_id AND chatThreadId.
			// Both are created by emitStarted() which is fire-and-forget from Blueprint.
			// Forum post is fire-and-forget inside emitStarted, chat thread is awaited —
			// but either could finish first, so poll until both are found (or timeout).
			let threadId: string | undefined;
			let chatThreadId: string | undefined;
			const chatChannel = (() => {
				if (!chatThreadsEnabled || !leadId) return undefined;
				const proj = projects.find((p) => p.projectName === projectName);
				return proj?.leads.find((l) => l.agentId === leadId)?.chatChannel;
			})();

			const deadline = Date.now() + THREAD_POLL_MAX_MS;
			while (Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, THREAD_POLL_INTERVAL_MS));
				const session = store.getSession(result.executionId);
				if (!threadId && session?.thread_id) threadId = session.thread_id;
				if (!chatThreadId && chatChannel) {
					chatThreadId = store.getChatThreadByIssue(
						issueId,
						chatChannel,
					)?.thread_id;
				}
				// Exit when both are resolved (or chat threads disabled)
				if (threadId && (chatThreadId || !chatChannel)) break;
			}

			// FLY-80: Verify session was actually registered (detect ghost starts).
			// If Blueprint.run() failed before emitStarted(), no session exists.
			const finalSession = store.getSession(result.executionId);
			if (!finalSession) {
				res.status(500).json({
					success: false,
					message: `Runner failed to start — session not registered after ${THREAD_POLL_MAX_MS}ms. Check Bridge logs for errors.`,
				});
				return;
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
				chatThreadId,
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
