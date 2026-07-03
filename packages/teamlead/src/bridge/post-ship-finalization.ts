/**
 * FLY-102 Round 3: Shared post-approve-ship orchestrator.
 *
 * Replaces the two divergent post-merge cleanup paths that existed before
 * (DirectEventSink emitCompleted + event-route.ts postApproveShip branch)
 * with a single serialized flow:
 *
 *   1. postMergeTmuxCleanup   — close Runner tmux + audit
 *   2. emitRunnerReadyToCloseNotification — post "🏁 Runner 完工可关闭"
 *      into the per-issue chat thread (atomic dedupe via UNIQUE event_id)
 *   3. removeUserFromChatThread + archiveChatThread — clear Annie's sidebar
 *
 * Ordering is strict: archive MUST NOT run before the notifier, otherwise
 * the "🏁 可关闭" message would land in an archived thread that Discord
 * pushes below Annie's sidebar fold.
 *
 * Fire-and-forget at call sites. Every stage swallows & audits its own
 * errors — the orchestrator itself never throws.
 */

import { randomUUID } from "node:crypto";
import type { ProjectEntry } from "../ProjectConfig.js";
import { resolveLeadForIssue } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import {
	archiveChatThread,
	removeUserFromChatThread,
} from "./chat-thread-utils.js";
import { postMergeTmuxCleanup } from "./post-merge.js";
import { patchSessionParams } from "./proofshot-session.js";
import { emitRunnerReadyToCloseNotification } from "./runner-ready-to-close-notifier.js";
import type { WorktreeCleanupFn } from "./worktree-cleanup.js";

/**
 * Shared predicate — aligns with event-route.ts + DirectEventSink
 * postApproveShip semantics.
 *
 * Must return true BEFORE DES or event-route schedules `runPostShipFinalization`.
 * Note: `status === "completed"` alone is NOT sufficient — a Runner that
 * self-completes without actually shipping (e.g. `route=needs_review` and
 * the PR is still open) should not trigger post-ship cleanup.
 *
 * The three "yes" cases the orchestrator must accept:
 *   1. session was already in `approved_to_ship` (Annie / a Lead pressed
 *      `:cool:` first; Bridge's approveExecution flipped status; Runner
 *      then fired session_completed) — the canonical FLY-58 path.
 *   2. `route === "auto_approve"` with `landingStatus.status === "merged"`
 *      — auto-approve workflows where the PR self-merged via deploy
 *      action without an explicit Bridge approve.
 *   3. `route === "needs_review"` with `landingStatus.status === "merged"`
 *      — FLY-115 v1.24.5 (FLY-120). The Lead unblocked the
 *      `approve_to_ship` gate via `flywheel-comm respond` (production
 *      path; v1.24.4 test framework also uses this). Bridge's
 *      `approveExecution` was never called so `existingStatus` stayed at
 *      `running`; the Runner resumed, merged the PR, rewrote
 *      `land-status.json` to `status:"merged"`, and finally exited.
 *      Without this case `runPostShipFinalization` is skipped, the
 *      Runner tmux + chat thread are never torn down, and the Lead
 *      keeps pestering Annie about a PR already on main. Symmetric with
 *      the matching `status` mapping in `DirectEventSink.emitCompleted`
 *      / `event-route.ts:event_type=session_completed`.
 */
export function isPostApproveShipComplete(args: {
	/** session.status BEFORE this event applied (from getSession before upsertSession). */
	existingStatus: string | undefined;
	route: string | undefined;
	landingStatus: { status?: string } | undefined;
}): boolean {
	// FLY-208 5a (Codex design R2 #1): merge evidence is REQUIRED in every
	// branch. Previously `existingStatus === "approved_to_ship"` returned true
	// with landingStatus undefined or "ready_to_merge" — which would run tmux
	// teardown / ready-to-close notification / thread archive for the new
	// evidence-gap completion path (approved_to_ship session whose Runner
	// never rewrote the landing signal) even though nothing proves the PR
	// merged. Finalization for evidence-gap completions is deferred to
	// FLY-210 (PR-state freshness) or a manual close.
	if (args.landingStatus?.status !== "merged") return false;
	if (args.existingStatus === "approved_to_ship") return true;
	if (args.route === "auto_approve") return true;
	if (args.route === "needs_review") return true; // FLY-120
	return false;
}

/**
 * FLY-208 5a: persist the evidence-gap marker on a session completed WITHOUT
 * merge evidence (approved_to_ship + auto_approve/needs_review + landing not
 * "merged"). Stored inside the existing `session_params` JSON column —
 * `patchSessionMetadata` is a column whitelist, so an ad-hoc field would
 * silently no-op (Codex design R3 guardrail #1). Read-modify-write merge
 * preserves whatever else lives in session_params (e.g. proofshot runs).
 *
 * FLY-210 consumes this marker: when later merge proof arrives (PR-head
 * watcher / live PR query), it runs idempotent finalization WITHOUT a status
 * transition (completed is terminal).
 */
export function markEvidenceGapCompletion(
	store: StateStore,
	executionId: string,
	info: { route: string | undefined; landingStatus: string | undefined },
): void {
	patchSessionParams(store, executionId, (cur) => ({
		...cur,
		fly208_evidence_gap: {
			at: new Date().toISOString(),
			route: info.route ?? null,
			landing_status: info.landingStatus ?? null,
		},
	}));
}

export interface PostShipOpts {
	executionId: string;
	issueId: string;
	issueIdentifier?: string;
	projectName: string;
	/** Final status written by DES / event-route (for notifier display). */
	sessionStatus: string;
	/** Discord user ID to remove from chat thread (optional). */
	discordOwnerUserId?: string;
	/** Fallback if lead has no per-lead bot token. */
	fallbackBotToken?: string;
}

export interface PostShipDeps {
	store: StateStore;
	projects: ProjectEntry[];
	/**
	 * FLY-603 Layer A: optional worktree-cleanup closure, built at the Bridge
	 * composition root and threaded into all three finalization call sites so
	 * the HTTP /events router (which has no WorktreeManager) can clean too.
	 * Absent → no worktree cleanup (byte-compat for callers that don't wire it).
	 */
	removeCleanWorktree?: WorktreeCleanupFn;
	/**
	 * FLY-799: optional auto-Linear-Done closure. Because this whole orchestrator
	 * runs ONLY on confirmed merge evidence (isPostApproveShipComplete), calling
	 * it here is the structural ship-success gate — a shipped issue flips to Done.
	 * Best-effort (never throws). Absent → no Linear transition (byte-compat).
	 */
	markIssueDone?: (issueId: string, issueIdentifier?: string) => Promise<void>;
}

/**
 * Serialized post-ship orchestrator. Never throws.
 *
 * Codex Round 1 (post-Round 4 cycle): Atomic orchestrator-level claim.
 * Without a claim at this level, DES + event-route dual paths can both pass
 * the predicate and each call `runPostShipFinalization`. The notifier's own
 * UNIQUE claim makes the loser RETURN EARLY, but the loser's caller still
 * falls through to `removeUserFromChatThread` + `archiveChatThread` — racing
 * the winner's still-in-flight Discord POST. Result: thread archived before
 * the "🏁 可关闭" message lands, and teardown runs twice.
 *
 * Claim at this level ensures only one call performs tmux cleanup + notifier
 * + thread teardown as a single serialized pipeline.
 */
export async function runPostShipFinalization(
	opts: PostShipOpts,
	deps: PostShipDeps,
): Promise<void> {
	const { store, projects } = deps;

	// ── (0) ATOMIC ORCHESTRATOR CLAIM ──
	// Stable event_id → UNIQUE constraint collapses concurrent callers
	// (DES + event-route dual paths) to one winner for the full pipeline.
	const claimed = store.insertEvent({
		event_id: `post-ship-finalization-${opts.executionId}`,
		execution_id: opts.executionId,
		issue_id: opts.issueId,
		project_name: opts.projectName,
		event_type: "post_ship_finalization_claim",
		source: "bridge.post-ship-finalization",
		payload: { claimedAt: new Date().toISOString() },
	});
	if (!claimed) return;

	// ── (0.5) FLY-799 auto-Linear-Done — the ship is confirmed merged (the
	// predicate that gates this whole orchestrator required landingStatus=merged),
	// so flip the issue to Done. Best-effort: the closure never throws, and a
	// Linear failure must not block the tmux/thread teardown below. ──
	if (deps.markIssueDone) {
		await deps
			.markIssueDone(opts.issueId, opts.issueIdentifier)
			.catch((err) => {
				console.error(
					`[post-ship] markIssueDone failed:`,
					(err as Error).message,
				);
			});
	}

	// ── (1) tmux cleanup — idempotent; preserved contract { tmuxClosed, errors } ──
	const cleanup = await postMergeTmuxCleanup(
		{
			executionId: opts.executionId,
			issueId: opts.issueId,
			projectName: opts.projectName,
		},
		store,
	).catch((err) => {
		console.error(
			`[post-ship] postMergeTmuxCleanup failed:`,
			(err as Error).message,
		);
		return { tmuxClosed: false, errors: [(err as Error).message] };
	});

	// ── (1.5) FLY-603 Layer A worktree cleanup — AFTER tmux close (runner cwd is
	// the worktree), BEFORE notifier. The closure self-guards on positive tmux
	// close + clean tree + path-authority and never throws. ──
	if (deps.removeCleanWorktree) {
		await deps
			.removeCleanWorktree({
				executionId: opts.executionId,
				issueId: opts.issueId,
				issueIdentifier: opts.issueIdentifier,
				projectName: opts.projectName,
				tmuxClosed: cleanup.tmuxClosed,
				tmuxErrors: cleanup.errors,
			})
			.catch((err) => {
				console.error(
					`[post-ship] worktree cleanup failed:`,
					(err as Error).message,
				);
			});
	}

	// ── Resolve lead + thread ONCE, reused by notifier AND archiver ──
	let chatChannel: string | undefined;
	let botToken: string | undefined;
	try {
		const labels = store.getSessionLabels(opts.executionId);
		const { lead } = resolveLeadForIssue(projects, opts.projectName, labels);
		chatChannel = lead.chatChannel;
		botToken = lead.botToken ?? opts.fallbackBotToken;
	} catch (err) {
		console.warn(
			`[post-ship] resolveLeadForIssue failed:`,
			(err as Error).message,
		);
		botToken = opts.fallbackBotToken;
	}
	const thread = chatChannel
		? store.getChatThreadByIssue(opts.issueId, chatChannel)
		: undefined;

	// ── (2) notifier — atomic dedupe; MUST run BEFORE archive ──
	await emitRunnerReadyToCloseNotification(
		{
			executionId: opts.executionId,
			issueId: opts.issueId,
			issueIdentifier: opts.issueIdentifier,
			projectName: opts.projectName,
			sessionStatus: opts.sessionStatus,
			tmuxClosed: cleanup.tmuxClosed,
			errors: cleanup.errors?.length ? cleanup.errors : undefined,
			thread,
			botToken,
		},
		{ store },
	);

	// ── (3) thread teardown — only after notifier has landed ──
	if (thread && botToken) {
		if (opts.discordOwnerUserId) {
			await removeUserFromChatThread(
				thread.thread_id,
				opts.discordOwnerUserId,
				botToken,
			);
		}

		// FLY-292: deterministic archive — bounded retry + verify + 404→missing.
		// Never throws; returns a structured result we audit so the event log
		// can prove (or surface the failure of) the archive on every completion.
		const archiveResult = await archiveChatThread(thread.thread_id, botToken, {
			markDiscordMissing: (id) => store.markChatThreadMissing(id),
		});

		// FLY-369: record archived_at so the archive-on-Done sweeper does not
		// revisit a thread already archived by the ship path.
		if (archiveResult.archived) {
			store.markChatThreadArchived(thread.thread_id);
		}

		store.insertEvent({
			event_id: archiveResult.archived
				? `chat-thread-archived-${opts.executionId}`
				: `chat-thread-archive-failed-${randomUUID()}`,
			execution_id: opts.executionId,
			issue_id: opts.issueId,
			project_name: opts.projectName,
			event_type: archiveResult.archived
				? "chat_thread_archived"
				: "chat_thread_archive_failed",
			source: "bridge.post-ship-finalization",
			payload: {
				threadId: thread.thread_id,
				attempts: archiveResult.attempts,
				status: archiveResult.status ?? null,
				reason: archiveResult.reason,
				error: archiveResult.error ?? null,
			},
		});
	}
}
