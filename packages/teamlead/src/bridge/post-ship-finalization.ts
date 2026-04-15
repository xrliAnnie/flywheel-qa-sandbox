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

import type { ProjectEntry } from "../ProjectConfig.js";
import { resolveLeadForIssue } from "../ProjectConfig.js";
import type { StateStore } from "../StateStore.js";
import {
	archiveChatThread,
	removeUserFromChatThread,
} from "./chat-thread-utils.js";
import { postMergeTmuxCleanup } from "./post-merge.js";
import { emitRunnerReadyToCloseNotification } from "./runner-ready-to-close-notifier.js";

/**
 * Shared predicate — aligns with event-route.ts postApproveShip semantics.
 *
 * Must return true BEFORE DES or event-route schedules `runPostShipFinalization`.
 * Note: `status === "completed"` alone is NOT sufficient — a Runner that
 * self-completes without going through approve/ship (e.g. `route=needs_review`)
 * should not trigger post-ship cleanup.
 */
export function isPostApproveShipComplete(args: {
	/** session.status BEFORE this event applied (from getSession before upsertSession). */
	existingStatus: string | undefined;
	route: string | undefined;
	landingStatus: { status?: string } | undefined;
}): boolean {
	if (args.existingStatus === "approved_to_ship") return true;
	if (args.route === "auto_approve" && args.landingStatus?.status === "merged")
		return true;
	return false;
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
			).catch((err) =>
				console.warn(
					`[post-ship] removeUserFromChatThread failed:`,
					(err as Error).message,
				),
			);
		}
		await archiveChatThread(thread.thread_id, botToken).catch((err) =>
			console.warn(
				`[post-ship] archiveChatThread failed:`,
				(err as Error).message,
			),
		);
	}
}
