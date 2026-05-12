/**
 * GEO-267: /api/runs routes — start new Runner executions.
 *
 * POST /api/runs/start — start a Runner for an issue
 * GET  /api/runs/active — query active run counts
 *
 * FLY-127 R3 Layer 2: Server-side department scope enforcement. When a Lead
 * calls `/api/runs/start` for an issue outside its department, Bridge rejects
 * with a machine-readable diagnostic code (`DEPT_SCOPE_REJECT` + `reason`)
 * that the Lead translates into one short Chinese diagnostic line per its
 * Action Gate rule. Gated by `BRIDGE_DEPT_SCOPE_REJECT` env var (default on).
 */

import { Router } from "express";
import { DepartmentRegistry } from "../department-registry.js";
import { type ProjectEntry, resolveLeadForIssue } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import { validateAndRegisterChatThread } from "./chat-thread-register.js";
import type { IStartDispatcher } from "./retry-dispatcher.js";

/** Poll interval / max wait for Forum Post thread_id to appear on session. */
const THREAD_POLL_INTERVAL_MS = 500;
const THREAD_POLL_MAX_MS = 5000;

/**
 * FLY-127: Read the dept-scope reject feature flag.
 *
 * Default: enforcement ON. Set `BRIDGE_DEPT_SCOPE_REJECT=off` (or `false` /
 * `0`) to disable.
 *
 * **Toggling requires a Bridge restart.** Although the value is re-read from
 * `process.env` on every request, a running Node process does not pick up
 * external env-var mutations — `process.env` is a snapshot of the parent
 * shell at fork time. Re-reading per request guards against (hypothetical)
 * intra-process env mutation but does not enable no-restart rollback.
 *
 * For runtime no-restart toggle we'd need an admin endpoint or config-watch
 * mechanism. That is out of scope for FLY-127; tracked as a follow-up.
 */
function isDeptScopeRejectEnabled(): boolean {
	const v = process.env.BRIDGE_DEPT_SCOPE_REJECT;
	if (v === undefined) return true;
	const lower = v.toLowerCase();
	return lower !== "off" && lower !== "false" && lower !== "0";
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
	// FLY-127: registry is constructed once per router and re-read on each
	// request through the same `projects` reference. Bridge restart picks up
	// new project config; runtime toggles use the env-var flag instead.
	const departmentRegistry = new DepartmentRegistry(projects);

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

		// FLY-137 v1.27.2: optional Lead override `agentName` body field.
		// Semantics per Codex v1.27.0 Round 1 #2:
		//   - undefined / null / missing → normal dispatch (no override)
		//   - "" (empty string)          → reject with INVALID_AGENT_NAME
		//   - non-empty string           → validate; reject if unknown; else override
		// Final validation against the project's actual agents map happens via
		// `AgentDispatcher.dispatchByName(...)` inside Blueprint at dispatch time;
		// here we only sanity-check shape and reject empty strings.
		const rawAgentName = req.body.agentName;
		let agentName: string | undefined;
		if (rawAgentName === undefined || rawAgentName === null) {
			agentName = undefined;
		} else if (typeof rawAgentName !== "string") {
			res.status(400).json({
				success: false,
				code: "INVALID_AGENT_NAME",
				reason: "wrong_type",
				silent: false,
			});
			return;
		} else if (rawAgentName.length === 0) {
			res.status(400).json({
				success: false,
				code: "INVALID_AGENT_NAME",
				reason: "empty_string",
				silent: false,
			});
			return;
		} else {
			agentName = rawAgentName;
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
		// FLY-127: labels are needed by both the FLY-80 auto-resolve path AND the
		// new department-scope check. Fetch once, reuse for both.
		let issueLabelNames: string[] = [];
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

			// FLY-127: fetch labels regardless of whether leadId is provided.
			// Auto-resolve (FLY-80) and dept-scope check (FLY-127) both need them.
			try {
				const labels = await issue.labels();
				issueLabelNames = labels.nodes.map((l: { name: string }) => l.name);
			} catch (labelErr) {
				console.warn(
					`[runs/start] Could not fetch labels for ${issueIdentifier}:`,
					(labelErr as Error).message,
				);
				// Leave issueLabelNames empty — dept-scope check will treat as
				// `issue_no_department_label` and reject (when enforcement is on).
			}

			// FLY-80: Auto-resolve leadId from project config if not provided.
			// Without leadId, Blueprint skips approve gate instructions entirely.
			if (!leadId) {
				try {
					const { lead } = resolveLeadForIssue(
						projects,
						projectName,
						issueLabelNames,
					);
					leadId = lead.agentId;
					console.log(
						`[runs/start] Auto-resolved leadId to "${leadId}" for ${issueIdentifier}`,
					);
				} catch (resolveErr) {
					console.warn(
						`[runs/start] Could not auto-resolve leadId:`,
						(resolveErr as Error).message,
					);
				}
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

		// FLY-127 R3 Layer 2: Server-side department scope check.
		//
		// Runs only when:
		//   - the feature flag is on (BRIDGE_DEPT_SCOPE_REJECT != off)
		//   - leadId is known (either provided by caller or auto-resolved above)
		//
		// On reject, returns a machine-readable diagnostic that Lead daemons
		// translate into one short Chinese line per their Action Gate rule.
		// `silent: false` because Bridge is only called on explicit-intent paths
		// (Layer 1b filters passive cross-dept noise before any API call).
		if (isDeptScopeRejectEnabled() && leadId) {
			const decision = departmentRegistry.isLeadInScope(
				projectName,
				leadId,
				issueLabelNames,
			);
			if (!decision.allowed) {
				// Log the english `decision.message` for operator debugging — the
				// HTTP response intentionally carries machine-readable fields only
				// (no free-form prose for the Lead to echo or paraphrase).
				console.log(
					`[runs/start] FLY-127 dept-scope reject: project="${projectName}" ` +
						`lead="${leadId}" issue="${issueIdentifier}" ` +
						`reason=${decision.reason} ` +
						`canonicalLeadId="${decision.canonicalLeadId ?? "null"}" ` +
						`detail="${decision.message}"`,
				);
				// Codex R1: response shape is machine-only — `code` / `reason` /
				// `canonicalLeadId` / `silent`. The Lead translates `reason` into
				// the canonical Chinese diagnostic per its Action Gate rule. No
				// `message` field — preventing Leads from echoing arbitrary
				// english prose into Discord. `canonicalLeadId` always present
				// (string-or-null) for stable response shape across all reject
				// codes; null when the issue has no / multiple labels.
				res.status(403).json({
					success: false,
					code: "DEPT_SCOPE_REJECT",
					reason: decision.reason,
					canonicalLeadId: decision.canonicalLeadId ?? null,
					silent: false,
				});
				return;
			}
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

		// FLY-137 v1.27.2: normalize labels ONCE at the Bridge boundary + resolve
		// owningDept via DepartmentRegistry. Downstream consumers (StartRequest →
		// BlueprintContext → AgentDispatcher) receive lowercased labels; dispatcher
		// no longer re-lowercases per call.
		const normalizedIssueLabels = issueLabelNames.map((l) => l.toLowerCase());
		const owningDept = departmentRegistry.getDepartmentForIssue(
			projectName,
			normalizedIssueLabels,
		);

		// FLY-137 Phase 5: snapshot codex-skip label at run start (no mid-run
		// Linear refresh). Semantics: "label the issue before triggering;
		// if you forgot, cancel + retry." Bridge persists this on the session
		// row so event-route's stage_changed handler can check it without
		// touching Linear at transition time.
		const codexSkip = normalizedIssueLabels.includes("codex-skip");

		// FLY-137 v1.27.2 (Codex Track A #2): validate `agentName` SYNCHRONOUSLY
		// before kicking off any async work. Without this, InvalidAgentNameError
		// thrown deep inside Blueprint.run() gets swallowed by the .catch() chain
		// in RunDispatcher.start() and never surfaces as a 400 response.
		if (agentName !== undefined) {
			const validation = startDispatcher.validateAgentName(
				projectName,
				agentName,
			);
			if (!validation.ok) {
				if (validation.reason === "project_unknown") {
					res.status(404).json({
						success: false,
						message: `Project "${projectName}" is not registered with the Bridge runtime`,
					});
					return;
				}
				// unknown_agent → FLY-127-shape machine-only payload
				console.log(
					`[runs/start] FLY-137 INVALID_AGENT_NAME: project="${projectName}" provided="${agentName}" available=${JSON.stringify(validation.available)}`,
				);
				res.status(400).json({
					success: false,
					code: "INVALID_AGENT_NAME",
					reason: "unknown_agent",
					available: validation.available,
					silent: false,
				});
				return;
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
				// FLY-137 v1.27.2: dept-aware dispatch context
				agentName,
				issueLabels: normalizedIssueLabels,
				owningDept,
				// FLY-137 Phase 5: Codex auto-trigger snapshot
				codexSkip,
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

			// FLY-137 Phase 5: persist agent dispatch metadata + codex-skip
			// snapshot now that the session row exists. patchSessionMetadata
			// is a no-op (no rows) if Blueprint failed before emitStarted —
			// the FLY-80 ghost-start guard below covers that case.
			const persistedSession = store.getSession(result.executionId);
			if (persistedSession) {
				const matchMethod: string | undefined = agentName
					? "override"
					: undefined;
				store.patchSessionMetadata(result.executionId, {
					agent_name: agentName ?? undefined,
					agent_match_method: matchMethod,
					codex_skip: codexSkip ? 1 : 0,
				});
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
			// FLY-137 v1.27.2: InvalidAgentNameError thrown from AgentDispatcher
			// when Lead override `agentName` doesn't match any configured agent.
			// Map to FLY-127-shaped machine-only diagnostic.
			if (err instanceof Error && err.name === "InvalidAgentNameError") {
				const e = err as Error & {
					providedName?: string;
					available?: string[];
				};
				console.log(
					`[runs/start] FLY-137 INVALID_AGENT_NAME: provided="${e.providedName}" available=${JSON.stringify(e.available)}`,
				);
				res.status(400).json({
					success: false,
					code: "INVALID_AGENT_NAME",
					reason: "unknown_agent",
					available: e.available ?? [],
					silent: false,
				});
				return;
			}
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
