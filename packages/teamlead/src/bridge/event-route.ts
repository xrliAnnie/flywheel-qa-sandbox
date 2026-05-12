import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { Router } from "express";
import { CommDB } from "flywheel-comm/db";
import type { CipherWriter, SnapshotInputDto } from "flywheel-edge-worker";
import { extractDimensions, generatePatternKeys } from "flywheel-edge-worker";
import {
	type ApplyTransitionOpts,
	applyTransition,
} from "../applyTransition.js";
import { type ProjectEntry, resolveLeadForIssue } from "../ProjectConfig.js";
import type { Session, StateStore } from "../StateStore.js";
import type { EventFilter } from "./EventFilter.js";
import type { ForumPostCreator } from "./ForumPostCreator.js";
import type { ForumTagUpdater } from "./ForumTagUpdater.js";
import { buildSessionKey, type HookPayload } from "./hook-payload.js";
import type { LeadEventEnvelope } from "./lead-runtime.js";
import {
	isPostApproveShipComplete,
	runPostShipFinalization,
} from "./post-ship-finalization.js";
import type { RuntimeRegistry } from "./runtime-registry.js";
import { STAGE_ORDER, VALID_STAGES } from "./stage-utils.js";
import { validateThreadExists } from "./thread-validator.js";
import { type BridgeConfig, sqliteDatetime } from "./types.js";

interface IngestEvent {
	event_id: string;
	execution_id: string;
	issue_id: string;
	project_name: string;
	event_type: string;
	payload?: Record<string, unknown>;
	source?: string;
}

/** Coerce a value to string or undefined — prevents non-string payload fields from crashing upsertSession. */
function asString(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

/**
 * GEO-202: Resolve issue_identifier from payload, falling back to issue_id.
 * Prevents null issue_identifier in sessions when the event payload
 * omits issueIdentifier (e.g., fire-and-forget session_started lost,
 * or emitter didn't include it).
 *
 * Returns undefined (not the fallback) when payload has a valid identifier,
 * so that SQL COALESCE(excluded, existing) can preserve a better existing value.
 * The fallback is only used when the payload has NO identifier at all.
 */
function resolveIdentifier(
	payload: Record<string, unknown>,
	fallbackIssueId: string,
): string {
	const fromPayload = asString(payload.issueIdentifier);
	return fromPayload && fromPayload.length > 0 ? fromPayload : fallbackIssueId;
}

/** Coerce a value to number or undefined. */
function asNumber(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function formatNotification(session: Session, eventType: string): string {
	const id = session.issue_identifier ?? session.issue_id;
	switch (eventType) {
		case "session_completed":
			if (session.decision_route === "auto_approve") {
				if (session.status === "approved") {
					return `[Already Merged] ${id}: ${session.issue_title ?? ""}. PR was already merged.`;
				}
				return `[Review Required] ${id}: ${session.issue_title ?? ""}. ${session.commit_count ?? 0} commits. Awaiting CEO approval.`;
			}
			if (session.decision_route === "needs_review") {
				return `[Review Required] ${id}: ${session.issue_title ?? ""}. ${session.commit_count ?? 0} commits, +${session.lines_added ?? 0}/-${session.lines_removed ?? 0} lines. Please review.`;
			}
			if (session.decision_route === "blocked") {
				return `[Blocked] ${id}: ${session.issue_title ?? ""}. Reason: ${session.decision_reasoning ?? "unknown"}`;
			}
			return `[Completed] ${id}: ${session.issue_title ?? ""}`;
		case "session_failed":
			return `[Failed] ${id}: ${session.issue_title ?? ""}. Error: ${session.last_error ?? "unknown"}`;
		case "session_started":
			return `[Started] ${id}: ${session.issue_title ?? ""}`;
		default:
			return `[${eventType}] ${id}`;
	}
}

// ---------------------------------------------------------------------------
// FLY-137 Phase 5: Codex auto-trigger helpers.
//
// On `stage_changed` to `design_review` or `pr_created`, Bridge either:
//   (a) writes a skip.json marker under the Runner's worktree codex dir
//       (when codex-skip label was snapshotted at run start), so the
//       Runner's `await-codex-gate` bypass-exits 0 immediately; OR
//   (b) writes a CommDB instruction telling the Runner to run
//       `/codex-design-review <plan>` or `/codex-code-review`, then call
//       `flywheel-comm await-codex-gate <type>` before advancing stages.
//
// Bridge ONLY writes skip.json — Runner/Codex writes the result JSON
// (design-review.json / code-review.json). This keeps the gate from
// being self-authorizing.
// ---------------------------------------------------------------------------

function commDbPathForProject(projectName: string): string {
	return join(homedir(), ".flywheel", "comm", projectName, "comm.db");
}

/**
 * Resolve the Runner worktree path for the session. Falls back to
 * `${HOME}/Dev/<projectName>/worktrees/<execId>` only if session is
 * missing — normally Blueprint patches `worktree_path` after worktree
 * creation, so the stored value should be present by the time
 * design_review or pr_created fires.
 */
function resolveWorktreeForCodex(
	session: Session | undefined,
	projectName: string,
	executionId: string,
): string {
	if (session?.worktree_path && session.worktree_path.length > 0) {
		return session.worktree_path;
	}
	// Defensive fallback. Logged by caller.
	return join(homedir(), "Dev", projectName, "worktrees", executionId);
}

/**
 * Atomically write a JSON payload into the codex dir under
 * `<worktree>/.flywheel/runs/<execId>/codex/<file>`. Writes to a tmp
 * file then `rename()` (POSIX atomic). Returns the resolved absolute
 * path on success; throws on error (caller handles).
 */
function writeCodexJsonAtomic(
	worktree: string,
	executionId: string,
	fileName: string,
	payload: unknown,
): string {
	const dir = resolvePath(worktree, ".flywheel", "runs", executionId, "codex");
	mkdirSync(dir, { recursive: true });
	const finalPath = join(dir, fileName);
	const tmpPath = `${finalPath}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
	renameSync(tmpPath, finalPath);
	return finalPath;
}

function isSafePlanPath(planPath: string): boolean {
	if (typeof planPath !== "string" || planPath.length === 0) return false;
	if (isAbsolute(planPath)) return false;
	if (planPath.split("/").some((seg) => seg === "..")) return false;
	return true;
}

/**
 * Resolve the review type from a stage transition target.
 * - `design_review` → "design"
 * - `pr_created`    → "code"
 * - anything else   → null (no auto-trigger)
 */
function codexReviewTypeFor(stage: string): "design" | "code" | null {
	if (stage === "design_review") return "design";
	if (stage === "pr_created") return "code";
	return null;
}

/**
 * Build the Runner-targeted instruction text for design/code review.
 */
function buildCodexInstruction(
	reviewType: "design" | "code",
	planPath: string | undefined,
	executionId: string,
): string {
	if (reviewType === "design") {
		const target =
			planPath ?? "<MISSING — re-run stage set design_review --plan <path>>";
		return [
			`[FLY-137] Codex design review required for exec=${executionId}.`,
			`Run: /codex-design-review ${target}`,
			`Iterate on findings until Codex returns APPROVED. Write the approved`,
			`result to .flywheel/runs/${executionId}/codex/design-review.json with`,
			`schema {executionId, reviewType:"design", status:"APPROVED",`,
			`reviewedTarget:"${target}", timestamp:<ISO-8601>, rounds:<int>,`,
			`codexThreadId:<string>}.`,
			`Then call \`flywheel-comm await-codex-gate design --exec-id ${executionId}\``,
			`before \`flywheel-comm stage set implement\`. The gate command is`,
			`fail-closed; it will block until the result file or a skip marker`,
			`appears.`,
		].join(" ");
	}
	return [
		`[FLY-137] Codex code review required for exec=${executionId}.`,
		`Run: /codex-code-review`,
		`Iterate on findings until Codex returns APPROVED. Write the approved`,
		`result to .flywheel/runs/${executionId}/codex/code-review.json with`,
		`schema {executionId, reviewType:"code", status:"APPROVED",`,
		`reviewedTarget:"<pr-url>", timestamp:<ISO-8601>, rounds:<int>,`,
		`codexThreadId:<string>}.`,
		`Then call \`flywheel-comm await-codex-gate code --exec-id ${executionId}\``,
		`before \`flywheel-comm stage set approve\`. The gate command is`,
		`fail-closed; it will block until the result file or a skip marker`,
		`appears.`,
	].join(" ");
}

/**
 * Handle stage_changed → design_review / pr_created. Reads session
 * state (codex_skip + worktree_path + plan_path) and either writes
 * skip.json or writes a CommDB instruction to the Runner inbox.
 * Failures are logged + non-fatal; the parent stage transition still
 * succeeds.
 */
function handleCodexAutoTrigger(
	store: StateStore,
	event: IngestEvent,
	stage: string,
	payloadPlanPath: string | undefined,
): void {
	const reviewType = codexReviewTypeFor(stage);
	if (!reviewType) return;

	const session = store.getSession(event.execution_id);
	const worktree = resolveWorktreeForCodex(
		session,
		event.project_name,
		event.execution_id,
	);

	// Persist plan_path from the payload (if provided + safe). Even on
	// the skip path we still record it for audit/diagnostics.
	if (reviewType === "design" && payloadPlanPath !== undefined) {
		if (!isSafePlanPath(payloadPlanPath)) {
			console.warn(
				`[codex-trigger] unsafe plan_path rejected for ${event.execution_id}: ${payloadPlanPath}`,
			);
		} else {
			store.patchSessionMetadata(event.execution_id, {
				plan_path: payloadPlanPath,
			});
		}
	}

	const refreshedSession = store.getSession(event.execution_id);
	const codexSkip = !!refreshedSession?.codex_skip;
	const persistedPlanPath = refreshedSession?.plan_path;

	if (codexSkip) {
		try {
			const skipPath = writeCodexJsonAtomic(
				worktree,
				event.execution_id,
				"skip.json",
				{
					executionId: event.execution_id,
					reviewType,
					reason: "codex-skip-label",
					timestamp: new Date().toISOString(),
				},
			);
			console.log(
				`[codex-trigger] skip ${reviewType} review for ${event.execution_id} (codex-skip label) → ${skipPath}`,
			);
		} catch (err) {
			console.warn(
				`[codex-trigger] failed to write skip.json for ${event.execution_id}: ${(err as Error).message}`,
			);
		}
		return;
	}

	// Missing plan_path on design_review → fail-closed instruction so
	// Runner re-issues stage with --plan; await-codex-gate will time
	// out (no skip.json, no result) → Runner reports to Lead.
	if (reviewType === "design" && !persistedPlanPath) {
		try {
			const dbPath = commDbPathForProject(event.project_name);
			mkdirSync(dirname(dbPath), { recursive: true });
			const commDb = new CommDB(dbPath);
			try {
				commDb.insertInstruction(
					"bridge",
					event.execution_id,
					[
						`[FLY-137] ERROR: stage_changed to design_review requires --plan <relative-path>.`,
						`Re-run: \`flywheel-comm stage set design_review --plan <path>\`.`,
						`Codex design review was NOT triggered. Do not proceed to implement`,
						`until --plan is provided. The await-codex-gate will time out`,
						`without a skip marker or result file (fail-closed).`,
					].join(" "),
				);
				console.log(
					`[codex-trigger] missing plan_path — instruction sent to re-trigger for ${event.execution_id}`,
				);
			} finally {
				commDb.close();
			}
		} catch (err) {
			console.warn(
				`[codex-trigger] failed to write missing-plan instruction for ${event.execution_id}: ${(err as Error).message}`,
			);
		}
		return;
	}

	// Happy path: write the Codex review instruction to the Runner inbox.
	try {
		const dbPath = commDbPathForProject(event.project_name);
		mkdirSync(dirname(dbPath), { recursive: true });
		const commDb = new CommDB(dbPath);
		try {
			const content = buildCodexInstruction(
				reviewType,
				persistedPlanPath,
				event.execution_id,
			);
			commDb.insertInstruction("bridge", event.execution_id, content);
			console.log(
				`[codex-trigger] queued ${reviewType} review instruction for ${event.execution_id}`,
			);
		} finally {
			commDb.close();
		}
	} catch (err) {
		console.warn(
			`[codex-trigger] failed to write instruction for ${event.execution_id}: ${(err as Error).message}`,
		);
	}
}

export function createEventRouter(
	store: StateStore,
	projects: ProjectEntry[],
	config: BridgeConfig,
	cipherWriter?: CipherWriter,
	transitionOpts?: ApplyTransitionOpts,
	eventFilter?: EventFilter,
	forumTagUpdater?: ForumTagUpdater,
	registry?: RuntimeRegistry,
	forumPostCreator?: ForumPostCreator,
): Router {
	const router = Router();

	// Dedicated heartbeat route — lightweight, no session_events write, no lead notification
	router.post("/heartbeat", (req, res) => {
		const body = req.body as { execution_id?: string } | undefined;
		if (
			!body ||
			typeof body.execution_id !== "string" ||
			body.execution_id.length === 0
		) {
			res.status(400).json({ error: "missing or invalid field: execution_id" });
			return;
		}
		store.updateHeartbeat(body.execution_id);
		res.json({ ok: true });
	});

	router.post("/", async (req, res) => {
		const event = req.body as IngestEvent | undefined;
		if (!event || typeof event !== "object") {
			res.status(400).json({ error: "expected JSON object" });
			return;
		}

		// Validate required fields
		const required = [
			"event_id",
			"execution_id",
			"issue_id",
			"project_name",
			"event_type",
		] as const;
		for (const field of required) {
			if (typeof event[field] !== "string" || event[field].length === 0) {
				res.status(400).json({ error: `missing or invalid field: ${field}` });
				return;
			}
		}

		// Store event (idempotent)
		const isNew = store.insertEvent({
			event_id: event.event_id,
			execution_id: event.execution_id,
			issue_id: event.issue_id,
			project_name: event.project_name,
			event_type: event.event_type,
			payload: event.payload,
			source: typeof event.source === "string" ? event.source : "orchestrator",
		});

		if (!isNew) {
			res.json({ ok: true, duplicate: true });
			return;
		}

		// Update session read model
		const now = sqliteDatetime();
		const payload = event.payload ?? {};
		let transitionRejected = false;

		try {
			const ctx = {
				executionId: event.execution_id,
				issueId: event.issue_id,
				projectName: event.project_name,
				trigger: event.event_type,
			};

			if (event.event_type === "session_started") {
				// GEO-152: store issue labels for multi-lead routing
				const eventLabels = Array.isArray(payload.labels)
					? (payload.labels as string[])
					: [];
				const issueLabelsJson =
					eventLabels.length > 0 ? JSON.stringify(eventLabels) : undefined;
				// FLY-59: Read session role from event payload
				const eventSessionRole = asString(payload.sessionRole) ?? "main";

				if (transitionOpts) {
					const result = applyTransition(
						transitionOpts,
						event.execution_id,
						"running",
						ctx,
						{
							started_at: now,
							last_activity_at: now,
							heartbeat_at: now,
							issue_identifier: resolveIdentifier(payload, event.issue_id),
							issue_title: asString(payload.issueTitle),
							issue_labels: issueLabelsJson,
							session_stage: "started",
							stage_updated_at: now,
							session_role: eventSessionRole,
						},
					);
					if (!result.ok) {
						console.warn(
							`[event-route] FSM rejected ${event.event_type}: ${result.error}`,
						);
						transitionRejected = true;
					}
				} else {
					store.upsertSession({
						execution_id: event.execution_id,
						issue_id: event.issue_id,
						project_name: event.project_name,
						status: "running",
						started_at: now,
						last_activity_at: now,
						heartbeat_at: now,
						issue_identifier: resolveIdentifier(payload, event.issue_id),
						issue_title: asString(payload.issueTitle),
						issue_labels: issueLabelsJson,
						session_stage: "started",
						stage_updated_at: now,
						session_role: eventSessionRole,
					});
				}

				if (!transitionRejected) {
					// Inherit existing thread for this issue — but only if another session
					// is still active (e.g., QA alongside main). If all prior sessions are
					// terminal, the new execution gets its own Forum post.
					const existingThread = store.getThreadByIssue(event.issue_id);
					if (existingThread) {
						// FLY-80: Only reuse thread if another active session owns it.
						// A terminated/completed session's thread should not be inherited —
						// each new execution lifecycle gets a fresh Forum post.
						// Exclude current execution from the search — we want to know
						// if a *different* active session exists for thread sharing.
						const activeSession = store.getLatestSessionByIssueAndStatuses(
							event.issue_id,
							["running", "awaiting_review", "approved_to_ship"],
							event.execution_id,
						);
						const hasOtherActiveSession = !!activeSession;

						if (hasOtherActiveSession) {
							// GEO-200: Validate thread still exists in Discord before inheriting
							const { lead: valLead } = resolveLeadForIssue(
								projects,
								event.project_name,
								eventLabels,
							);
							const botToken = valLead.botToken ?? config.discordBotToken;
							let threadValid = true;
							if (botToken) {
								threadValid = await validateThreadExists(
									existingThread.thread_id,
									botToken,
									{
										markDiscordMissing: (id) => store.markDiscordMissing(id),
									},
								);
							}
							if (threadValid) {
								store.setSessionThreadId(
									event.execution_id,
									existingThread.thread_id,
								);
								store.clearArchived(existingThread.thread_id);
							} else {
								console.warn(
									`[event-route] Thread ${existingThread.thread_id} missing from Discord, will create new`,
								);
							}
						} else {
							console.log(
								`[event-route] No active session owns thread ${existingThread.thread_id} for ${event.issue_id}, creating new Forum post`,
							);
						}
					}

					// ForumPostCreator: fire-and-forget (preserves EventFilter notification semantics)
					if (
						!store.getSession(event.execution_id)?.thread_id &&
						forumPostCreator
					) {
						const { lead: fpLead } = resolveLeadForIssue(
							projects,
							event.project_name,
							eventLabels,
						);
						// GEO-275: skip Forum Post creation for leads without forumChannel (e.g., PM lead)
						if (fpLead.forumChannel) {
							// Resolve issue title: prefer event payload, fall back to session history
							const resolvedTitle =
								asString(payload.issueTitle) ??
								store.getSessionByIssue(event.issue_id)?.issue_title ??
								undefined;
							forumPostCreator
								.ensureForumPost({
									forumChannelId: fpLead.forumChannel,
									issueId: event.issue_id,
									issueIdentifier: resolveIdentifier(payload, event.issue_id),
									issueTitle: resolvedTitle,
									executionId: event.execution_id,
									status: "running",
									// GEO-252: per-lead token. Note: labels may be overwritten on
									// session_completed/failed, but thread ownership is consistent
									// because ForumPostCreator only runs once (session_started).
									discordBotToken: fpLead.botToken ?? config.discordBotToken,
									statusTagMap: fpLead.statusTagMap,
								})
								.catch((err) => {
									console.warn(
										`[event-route] ForumPostCreator failed for ${event.issue_id}:`,
										(err as Error).message,
									);
								});
						}
					}
				}
			} else if (event.event_type === "worktree_ready") {
				// FLY-137: Blueprint reports the resolved worktree path
				// immediately after `WorktreeManager.create()` returns. We
				// persist it on the session row so the Codex auto-trigger
				// handlers (stage_changed=design_review / pr_created) and
				// the `codex-skip` snapshot can write skip.json + review
				// markers inside the Runner's actual cwd. Without this,
				// downstream handlers fall back to a derived path the
				// Runner cannot see and the await-codex-gate hangs until
				// timeout.
				//
				// Codex R2 #1 fix: `emitStarted` is fire-and-forget while
				// `emitWorktreeReady` is reliable (postEventReliable +
				// retries). The worktree_ready POST can therefore land at
				// Bridge BEFORE session_started's POST (especially if
				// started's first attempt failed and silently gave up).
				// `patchSessionMetadata` no-ops on missing rows, which
				// would silently lose worktree_path. Defend by upserting
				// a minimal running session when the row is absent — the
				// later session_started POST will UPSERT and refresh the
				// fields it cares about (started_at, labels, etc.) via
				// COALESCE.
				const worktreePath =
					typeof payload.worktreePath === "string" &&
					payload.worktreePath.length > 0
						? payload.worktreePath
						: undefined;
				if (worktreePath) {
					const existing = store.getSession(event.execution_id);
					if (!existing) {
						// Codex R3 #1 fix: when the row is created by
						// worktree_ready (race condition with the fire-and-
						// forget session_started POST), keep status as
						// `pending` so the later session_started can apply
						// the FSM-legal `pending → running` transition
						// (running → running is rejected by WorkflowFSM and
						// would skip labels/title/thread initialization).
						store.upsertSession({
							execution_id: event.execution_id,
							issue_id: event.issue_id,
							project_name: event.project_name,
							status: "pending",
							worktree_path: worktreePath,
						});
					} else {
						store.patchSessionMetadata(event.execution_id, {
							worktree_path: worktreePath,
						});
					}
				} else {
					console.warn(
						`[event-route] worktree_ready event for ${event.execution_id} missing worktreePath payload`,
					);
				}
			} else if (event.event_type === "session_completed") {
				const decision = payload.decision as
					| Record<string, unknown>
					| undefined;
				const evidence = payload.evidence as
					| Record<string, unknown>
					| undefined;
				const route = asString(decision?.route);
				const landingStatus = evidence?.landingStatus as
					| { status?: string }
					| undefined;

				// FLY-58: If session is approved_to_ship, Runner finished shipping
				// → go straight to completed (no Decision Layer needed).
				// Looked up BEFORE the strict-route guard so the natural-completion
				// path (Annie :cool: → Runner ships → session_completed with
				// decision.route = undefined) is preserved. Mirrors the
				// `else status = "completed"` fallback in
				// DirectEventSink.emitCompleted (DirectEventSink.ts:273-274) and is
				// pinned by DirectEventSink.test.ts:822-841.
				const existingSession = store.getSession(event.execution_id);
				const isPostApproveShip =
					existingSession?.status === "approved_to_ship";

				// FLY-108 Decision 4: strict route guard. A payload with a foreign or
				// missing route is almost always an emitter bug (GEO-362 Variant A) —
				// fail loudly instead of silently falling through to "completed".
				// Codex R2 (FLY-115 v1.24.5): exempt `approved_to_ship` sessions so
				// the natural-completion path keeps working — DirectEventSink already
				// allows this via its `else status = "completed"` branch, and the
				// HTTP /events sink must have parity (otherwise a Runner that ships
				// after Annie :cool: gets dropped here and the Lead never sees the
				// terminal completion).
				const VALID_ROUTES = new Set([
					"auto_approve",
					"needs_review",
					"blocked",
				]);
				if (!isPostApproveShip && (!route || !VALID_ROUTES.has(route))) {
					console.warn(
						`[event-route] session_completed ${event.execution_id} has invalid route ` +
							`(${route ?? "undefined"}) — skipping FSM update. ` +
							`Expected one of ${[...VALID_ROUTES].join(", ")}. ` +
							`Likely Runner emitter bug or deprecated code path.`,
					);
					res.json({ ok: true, warning: "invalid route skipped" });
					return;
				}

				// FLY-108: status mapping. Mirrors DirectEventSink.emitCompleted
				// (DirectEventSink.ts:258-274) — explicit failure routes win over
				// the post-approve-ship natural-completion fallback so a ship that
				// fails (`route="blocked"`) ends in `blocked`, not `completed`.
				//
				// Codex R3 (FLY-115 v1.24.5): pre-R3 code put the
				// `if (isPostApproveShip)` branch first, which incorrectly mapped
				// `approved_to_ship + route="blocked"` to `completed` and then
				// ran post-ship cleanup on a failed ship. Order is now:
				//   1. route="needs_review" (with merged → completed shortcut)
				//   2. route="auto_approve" (with merged → completed shortcut)
				//   3. route="blocked" → blocked
				//   4. route=undefined → only reachable when isPostApproveShip is
				//      true (guard above rejects undefined route otherwise) →
				//      completed (natural-completion path).
				//
				// Pinned by:
				//   - DirectEventSink.test.ts:798-820 (blocked → no finalization)
				//   - DirectEventSink.test.ts:822-841 (undefined → completed)
				//   - event-route-dual-session-completed Scenario D (undefined HTTP)
				//   - event-route-dual-session-completed Scenario E (blocked HTTP)
				let status: string;
				if (route === "needs_review") {
					// FLY-115 v1.24.5 (FLY-120): mirror the auto_approve+merged
					// short-circuit so a Runner that self-merges after Lead
					// unblocks `approve_to_ship` (e.g. via flywheel-comm respond)
					// reaches "completed" instead of being stuck in
					// "awaiting_review" with a PR already on main. Sister fix
					// in DirectEventSink.emitCompleted; both paths must agree
					// because emitCompleted is in-process while this is the
					// HTTP /events sink.
					if (landingStatus?.status === "merged") {
						status = "completed";
					} else {
						status = "awaiting_review";
					}
				} else if (route === "auto_approve") {
					if (landingStatus?.status === "merged") {
						// FLY-58: auto_approve + merged → completed (not approved)
						status = "completed";
					} else {
						status = "awaiting_review";
					}
				} else if (route === "blocked") {
					// Ship failed (or otherwise blocked). Even for sessions that
					// were previously `approved_to_ship`, an explicit blocked route
					// means the ship did not complete — must NOT finalize.
					// Sister branch: DirectEventSink.ts:273.
					status = "blocked";
				} else {
					// route is undefined here — only reachable when
					// isPostApproveShip is true (the strict route guard above
					// rejects undefined route otherwise). Natural-completion
					// path: Annie :cool: → Runner ships → session_completed with
					// no decision route. Sister branch:
					// DirectEventSink.ts:274 (`else status = "completed"`).
					status = "completed";
				}

				// FLY-59: Read session role from completed event payload
				const completedSessionRole = asString(payload.sessionRole) ?? "main";

				if (transitionOpts) {
					const result = applyTransition(
						transitionOpts,
						event.execution_id,
						status,
						ctx,
						{
							last_activity_at: now,
							// GEO-202: coerce "" → undefined so COALESCE preserves existing non-null value
							issue_identifier: asString(payload.issueIdentifier) || undefined,
							issue_title: asString(payload.issueTitle),
							session_role: completedSessionRole,
						},
					);
					if (!result.ok) {
						// FLY-108: upgrade to error + carry pre-state / target / route for triage
						const preState = existingSession?.status ?? "<none>";
						console.error(
							`[event-route] FSM rejected ${event.event_type} ${event.execution_id}: ` +
								`pre-state=${preState} → target=${status} (route=${route}): ${result.error}`,
						);
						transitionRejected = true;
					} else {
						// Metadata via patchSessionMetadata only on successful transition
						const prNumber = asNumber(
							(evidence?.landingStatus as Record<string, unknown> | undefined)
								?.prNumber,
						);
						store.patchSessionMetadata(event.execution_id, {
							decision_route: route,
							decision_reasoning: asString(decision?.reasoning),
							commit_count: asNumber(evidence?.commitCount),
							files_changed: asNumber(evidence?.filesChangedCount),
							lines_added: asNumber(evidence?.linesAdded),
							lines_removed: asNumber(evidence?.linesRemoved),
							summary: asString(payload.summary),
							diff_summary: asString(evidence?.diffSummary),
							commit_messages: Array.isArray(evidence?.commitMessages)
								? (evidence.commitMessages as string[]).join("\n")
								: undefined,
							changed_file_paths: Array.isArray(evidence?.changedFilePaths)
								? (evidence.changedFilePaths as string[]).join("\n")
								: undefined,
							pr_number: prNumber,
						});

						// GEO-292: Auto-infer stage from landing status (only advance, never regress)
						if (prNumber) {
							const landingStatusObj = evidence?.landingStatus as
								| Record<string, unknown>
								| undefined;
							const landingStatusValue = asString(landingStatusObj?.status);
							const inferredStage =
								landingStatusValue === "merged" ? "ship" : "pr_created";
							const currentSession = store.getSession(event.execution_id);
							const currentOrder =
								STAGE_ORDER[currentSession?.session_stage ?? ""] ?? -1;
							const inferredOrder = STAGE_ORDER[inferredStage] ?? -1;
							if (inferredOrder > currentOrder) {
								store.patchSessionMetadata(event.execution_id, {
									session_stage: inferredStage,
									stage_updated_at: now,
								});
							}
						}
					}
				} else {
					const legacyPrNumber = asNumber(
						(evidence?.landingStatus as Record<string, unknown> | undefined)
							?.prNumber,
					);
					store.upsertSession({
						execution_id: event.execution_id,
						issue_id: event.issue_id,
						project_name: event.project_name,
						status,
						last_activity_at: now,
						decision_route: route,
						decision_reasoning: asString(decision?.reasoning),
						commit_count: asNumber(evidence?.commitCount),
						files_changed: asNumber(evidence?.filesChangedCount),
						lines_added: asNumber(evidence?.linesAdded),
						lines_removed: asNumber(evidence?.linesRemoved),
						summary: asString(payload.summary),
						diff_summary: asString(evidence?.diffSummary),
						commit_messages: Array.isArray(evidence?.commitMessages)
							? (evidence.commitMessages as string[]).join("\n")
							: undefined,
						changed_file_paths: Array.isArray(evidence?.changedFilePaths)
							? (evidence.changedFilePaths as string[]).join("\n")
							: undefined,
						// GEO-202: coerce "" → undefined so COALESCE preserves existing non-null value
						issue_identifier: asString(payload.issueIdentifier) || undefined,
						issue_title: asString(payload.issueTitle),
						pr_number: legacyPrNumber,
						session_role: completedSessionRole,
					});

					// GEO-292: Auto-infer stage for legacy path (only advance, never regress)
					if (legacyPrNumber) {
						const landingStatusObj = evidence?.landingStatus as
							| Record<string, unknown>
							| undefined;
						const landingStatusValue = asString(landingStatusObj?.status);
						const legacyStage =
							landingStatusValue === "merged" ? "ship" : "pr_created";
						const currentSession = store.getSession(event.execution_id);
						const currentOrder =
							STAGE_ORDER[currentSession?.session_stage ?? ""] ?? -1;
						const inferredOrder = STAGE_ORDER[legacyStage] ?? -1;
						if (inferredOrder > currentOrder) {
							store.patchSessionMetadata(event.execution_id, {
								session_stage: legacyStage,
								stage_updated_at: now,
							});
						}
					}
				}

				// GEO-152: store labels on completed events (not just started)
				if (!transitionRejected) {
					const payloadLabels = Array.isArray(payload.labels)
						? (payload.labels as string[])
						: undefined;
					if (payloadLabels && payloadLabels.length > 0) {
						store.patchSessionMetadata(event.execution_id, {
							issue_labels: JSON.stringify(payloadLabels),
						});
					}
				}

				// FLY-102: Post-approve-ship finalization (tmux → notifier → archive).
				// Must match DES's gate: covers both "approved_to_ship" branch AND
				// auto_approve+merged branch (Codex Round 1 fix).
				if (
					!transitionRejected &&
					status === "completed" &&
					isPostApproveShipComplete({
						existingStatus: existingSession?.status,
						route,
						landingStatus,
					})
				) {
					runPostShipFinalization(
						{
							executionId: event.execution_id,
							issueId: event.issue_id,
							issueIdentifier: asString(payload.issueIdentifier) || undefined,
							projectName: event.project_name,
							sessionStatus: status,
							discordOwnerUserId: config.chatThreadsEnabled
								? config.discordOwnerUserId
								: undefined,
							fallbackBotToken: config.discordBotToken,
						},
						{ store, projects },
					).catch((err) => {
						console.error(
							`[event-route] runPostShipFinalization failed for ${event.execution_id}:`,
							(err as Error).message,
						);
					});
				}

				// Auto-approve disabled by policy (v1.0 Phase 2)
				// CEO must approve via Slack before merge. No auto-merge flow.

				// CIPHER Phase A: save snapshot for awaiting_review sessions
				// Skip if FSM rejected the transition (out-of-order/duplicate events)
				if (
					cipherWriter &&
					status === "awaiting_review" &&
					!transitionRejected
				) {
					// FLY-108 Decision 6: Runner-driven `session_completed` omits
					// labels/projectId (Runner has no Linear SDK access). Backfill
					// from StateStore so the CIPHER snapshot contract holds.
					// Explicit payload.labels (Array.isArray) wins over backfill —
					// `labels: []` on an emitter means "no labels", not "look it up".
					let labels = Array.isArray(payload.labels)
						? (payload.labels as string[])
						: null;
					if (!labels) {
						// getSessionLabels() returns [] when unstored — StateStore.ts:1113-1123.
						labels = store.getSessionLabels(event.execution_id);
					}

					const changedFilePaths = Array.isArray(evidence?.changedFilePaths)
						? (evidence.changedFilePaths as string[])
						: null;
					// projectId: Runner payload may omit; saveSnapshot below already
					// uses `projectId ?? ""` fallback, so degraded empty is fine.
					const projectId = asString(payload.projectId);

					// `labels` is now always an array (possibly empty). Skip only
					// when changedFilePaths is missing (no diff → nothing to snapshot).
					if (!changedFilePaths) {
						console.warn(
							`[CIPHER] Skipping snapshot for ${event.execution_id}: missing changedFilePaths`,
						);
					} else {
						const snapshotInput: SnapshotInputDto = {
							labels,
							exitReason: asString(payload.exitReason) || "completed",
							changedFilePaths,
							commitCount: asNumber(evidence?.commitCount) ?? 0,
							filesChangedCount: asNumber(evidence?.filesChangedCount) ?? 0,
							linesAdded: asNumber(evidence?.linesAdded) ?? 0,
							linesRemoved: asNumber(evidence?.linesRemoved) ?? 0,
							consecutiveFailures: asNumber(payload.consecutiveFailures) ?? 0,
						};
						const dimensions = extractDimensions(snapshotInput);
						const patternKeys = generatePatternKeys(dimensions);

						try {
							await cipherWriter.saveSnapshot({
								executionId: event.execution_id,
								issueId: event.issue_id,
								issueIdentifier: resolveIdentifier(payload, event.issue_id),
								issueTitle: asString(payload.issueTitle) ?? "",
								projectId: projectId ?? "",
								issueLabels: labels,
								dimensions,
								patternKeys,
								systemRoute: asString(decision?.route) ?? "",
								systemConfidence: asNumber(decision?.confidence) ?? 0,
								decisionSource: asString(decision?.decisionSource) ?? "",
								decisionReasoning: asString(decision?.reasoning),
								commitCount: snapshotInput.commitCount,
								filesChanged: snapshotInput.filesChangedCount,
								linesAdded: snapshotInput.linesAdded,
								linesRemoved: snapshotInput.linesRemoved,
								diffSummary: asString(evidence?.diffSummary),
								commitMessages: Array.isArray(evidence?.commitMessages)
									? (evidence.commitMessages as string[])
									: [],
								changedFilePaths,
								exitReason: snapshotInput.exitReason,
								durationMs: asNumber(evidence?.durationMs) ?? 0,
								consecutiveFailures: snapshotInput.consecutiveFailures,
							});
						} catch (err) {
							console.error(
								`[CIPHER] saveSnapshot failed for ${event.execution_id}:`,
								err,
							);
						}
					}
				}
			} else if (event.event_type === "session_failed") {
				// FLY-59: Read session role from failed event payload
				const failedSessionRole = asString(payload.sessionRole) ?? "main";

				if (transitionOpts) {
					const result = applyTransition(
						transitionOpts,
						event.execution_id,
						"failed",
						ctx,
						{
							last_activity_at: now,
							last_error: asString(payload.error),
							// GEO-202: coerce "" → undefined so COALESCE preserves existing non-null value
							issue_identifier: asString(payload.issueIdentifier) || undefined,
							issue_title: asString(payload.issueTitle),
							session_role: failedSessionRole,
						},
					);
					if (!result.ok) {
						console.warn(
							`[event-route] FSM rejected ${event.event_type}: ${result.error}`,
						);
						transitionRejected = true;
					}
				} else {
					store.upsertSession({
						execution_id: event.execution_id,
						issue_id: event.issue_id,
						project_name: event.project_name,
						status: "failed",
						last_activity_at: now,
						last_error: asString(payload.error),
						// GEO-202: coerce "" → undefined so COALESCE preserves existing non-null value
						issue_identifier: asString(payload.issueIdentifier) || undefined,
						issue_title: asString(payload.issueTitle),
						session_role: failedSessionRole,
					});
				}

				// GEO-152: store labels on failed events (not just started)
				if (!transitionRejected) {
					const payloadLabels = Array.isArray(payload.labels)
						? (payload.labels as string[])
						: undefined;
					if (payloadLabels && payloadLabels.length > 0) {
						store.patchSessionMetadata(event.execution_id, {
							issue_labels: JSON.stringify(payloadLabels),
						});
					}
				}
			} else if (event.event_type === "stage_changed") {
				// GEO-292: Runner-reported pipeline stage change
				const stage = asString(payload.stage);
				if (stage && VALID_STAGES.has(stage)) {
					store.patchSessionMetadata(event.execution_id, {
						session_stage: stage,
						stage_updated_at: now,
						last_activity_at: now,
					});

					// FLY-137 Phase 5: Codex auto-trigger fires on design_review
					// and pr_created. Honors codex-skip label snapshot (writes
					// skip.json), enforces plan_path requirement for design_review
					// (fail-closed via missing-plan instruction), otherwise queues
					// a CommDB instruction to the Runner inbox.
					if (stage === "design_review" || stage === "pr_created") {
						const planPath = asString(payload.plan_path);
						handleCodexAutoTrigger(store, event, stage, planPath);
					}

					// FLY-60 W2: post-merge re-finalize path. When stage=completed
					// and the payload carries `landing_status.status="merged"`, the
					// Runner has finished shipping and rewritten land-status.json
					// to merged after PR merge. Earlier `session_completed` event
					// (DirectEventSink) may have mapped status to `awaiting_review`
					// because landingStatus was still "ready_to_merge" at that time.
					// We re-evaluate the predicate with the now-merged landing
					// status and fire `runPostShipFinalization` to drive the
					// kill-Runner-tmux + chat-thread-cleanup chain.
					//
					// Scope (per plan §12.3): Run-#4-repair only — requires prior
					// `session_completed` to have written `decision_route`. The
					// "session=running, no prior session_completed" case is out of
					// scope (would need stage payload to carry route).
					if (stage === "completed") {
						const landingStatus = payload.landing_status as
							| {
									status?: string;
									prNumber?: number;
									mergeCommitSha?: string;
							  }
							| undefined;
						const sessionAtStage = store.getSession(event.execution_id);
						const stageRoute = asString(sessionAtStage?.decision_route);
						if (
							landingStatus?.status === "merged" &&
							isPostApproveShipComplete({
								existingStatus: sessionAtStage?.status,
								route: stageRoute,
								landingStatus,
							})
						) {
							// (i) FSM transition FIRST via canonical applyTransition;
							// pr_number patched via sessionFields so write is tied to
							// the validated transition (codex R4 M2). merge_commit_sha
							// is NOT a StateStore.Session column — it stays in the
							// payload for downstream stage_context consumption only.
							let transitionApplied = false;
							if (transitionOpts) {
								const sessionFields: Partial<{
									pr_number: number;
									last_activity_at: string;
								}> = { last_activity_at: now };
								if (landingStatus.prNumber !== undefined) {
									sessionFields.pr_number = landingStatus.prNumber;
								}
								const w2Result = applyTransition(
									transitionOpts,
									event.execution_id,
									"completed",
									ctx,
									sessionFields,
								);
								if (!w2Result.ok) {
									console.warn(
										`[event-route W2] FSM rejected ${sessionAtStage?.status}→completed for ${event.execution_id}: ${w2Result.error}`,
									);
									transitionRejected = true;
								} else {
									transitionApplied = true;
								}
							} else {
								// Defensive: production plugin.ts always passes
								// transitionOpts. If somehow absent, refuse to fire
								// finalization (no legacy fallback for stage_changed
								// handler). codex R5 M1.
								transitionRejected = true;
								console.warn(
									`[event-route W2] missing transitionOpts; refusing post-ship finalization for ${event.execution_id}`,
								);
							}

							// (ii) Fire orchestrator with the EXACT PostShipOpts shape
							// used at the session_completed branch (line ~567). Do NOT
							// pass landingStatus/decisionRoute/prNumber as fields — they
							// are not part of PostShipOpts and TS would reject.
							if (transitionApplied) {
								runPostShipFinalization(
									{
										executionId: event.execution_id,
										issueId: event.issue_id,
										issueIdentifier:
											sessionAtStage?.issue_identifier ??
											resolveIdentifier(payload, event.issue_id),
										projectName: event.project_name,
										sessionStatus: "completed",
										discordOwnerUserId: config.chatThreadsEnabled
											? config.discordOwnerUserId
											: undefined,
										fallbackBotToken: config.discordBotToken,
									},
									{ store, projects },
								).catch((err) => {
									console.error(
										`[event-route W2] runPostShipFinalization failed for ${event.execution_id}:`,
										(err as Error).message,
									);
								});
							}
						}
					}

					// NOTE: stage_changed values OTHER than "completed" remain
					// informational only — they do NOT trigger FSM transitions or
					// orchestrators. The FSM status change for non-merged
					// completion still flows through `session_completed`.
				}
			}
		} catch (err) {
			console.error(
				`[event-route] Session update failed for ${event.execution_id}:`,
				err,
			);
			// Event is already stored — return success with a warning rather than 500
			// so retries don't get stuck on duplicate detection
			res.json({ ok: true, warning: "event stored but session update failed" });
			return;
		}

		// Skip notification when FSM rejected the transition
		if (transitionRejected) {
			res.json({
				ok: true,
				warning:
					"FSM rejected transition — event stored but session not updated",
			});
			return;
		}

		// GEO-202: Backfill null issue_identifier after upsert.
		// This handles the case where session_started was lost (fire-and-forget)
		// and session_completed/failed creates the session without an identifier.
		{
			const postSession = store.getSession(event.execution_id);
			if (postSession && !postSession.issue_identifier) {
				store.patchSessionMetadata(event.execution_id, {
					issue_identifier: event.issue_id,
				});
			}
		}

		// Best-effort notification push via RuntimeRegistry (GEO-195)
		const session = store.getSession(event.execution_id);
		if (session && registry) {
			try {
				// GEO-152: fallback to payload labels when session labels are empty
				const storedLabels = store.getSessionLabels(event.execution_id);
				const labels =
					storedLabels.length > 0
						? storedLabels
						: Array.isArray(payload.labels)
							? (payload.labels as string[])
							: [];
				const { runtime, lead } = registry.resolveWithLead(
					projects,
					event.project_name,
					labels,
				);
				const existingThread = store.getThreadByIssue(event.issue_id);
				const forumChannel = existingThread?.channel ?? lead.forumChannel;
				const sessionKey = buildSessionKey(session);
				const hookPayload: HookPayload = {
					event_type: event.event_type,
					execution_id: event.execution_id,
					issue_id: event.issue_id,
					issue_identifier: session.issue_identifier,
					issue_title: session.issue_title,
					project_name: event.project_name,
					status: session.status,
					decision_route: session.decision_route,
					commit_count: session.commit_count,
					lines_added: session.lines_added,
					lines_removed: session.lines_removed,
					summary: session.summary,
					last_error: session.last_error,
					thread_id: session.thread_id,
					forum_channel: forumChannel,
					chat_channel: lead.chatChannel,
					issue_labels: labels,
					pr_number: session.pr_number,
					session_role: session.session_role ?? "main",
				};

				// FLY-47: Add stage_context for stage_changed events to prevent Lead misinterpretation
				if (event.event_type === "stage_changed") {
					const stage = asString(payload.stage);
					if (stage === "completed") {
						hookPayload.stage_context = session.pr_number
							? `Runner completed work. PR #${session.pr_number} is OPEN and needs review/merge — do NOT tell Annie the PR is merged.`
							: "Runner completed work. No PR detected — verify status before reporting to Annie.";
					}
				}

				// FLY-47: Classify event — priority hints + Forum gating
				let updateForum = true; // default: update Forum when no filter
				if (eventFilter) {
					const filterResult = eventFilter.classify(
						event.event_type,
						hookPayload,
					);
					hookPayload.filter_priority = filterResult.priority;
					hookPayload.notification_context = filterResult.reason;
					updateForum = filterResult.updateForum;
				}

				// Forum tag update — only for status-changing events
				let tagResult: HookPayload["forum_tag_update_result"];
				if (updateForum && forumTagUpdater) {
					tagResult = await forumTagUpdater.updateTag({
						threadId: session.thread_id,
						status: session.status ?? "",
						eventType: event.event_type,
						discordBotToken: lead.botToken ?? config.discordBotToken,
						statusTagMap: lead.statusTagMap,
					});
				}
				hookPayload.forum_tag_update_result = tagResult;

				// FLY-47: Always deliver ALL events to Lead — Lead decides routing
				// (mirrors Agent Team pattern: all teammate messages reach the lead)
				const seq = store.appendLeadEvent(
					lead.agentId,
					event.event_id,
					event.event_type,
					JSON.stringify(hookPayload),
					sessionKey,
				);
				const envelope: LeadEventEnvelope = {
					seq,
					event: hookPayload,
					sessionKey,
					leadId: lead.agentId,
					timestamp: new Date().toISOString(),
				};
				// FLY-80: Only mark delivered on success. On failure, leave undelivered
				// so inbox-mcp can pick it up on next poll (CommDB is the reliable store).
				runtime
					.deliver(envelope)
					.then(() => store.markLeadEventDelivered(seq))
					.catch((err) => {
						console.warn(
							`[event-route] Delivery failed for seq=${seq} to ${lead.agentId}:`,
							(err as Error).message,
						);
					});
			} catch (err) {
				console.warn(
					`[event-route] Unknown project "${event.project_name}" — skipping notification:`,
					(err as Error).message,
				);
			}
		}

		res.json({ ok: true });
	});

	return router;
}

// Export for testing
export { formatNotification };
