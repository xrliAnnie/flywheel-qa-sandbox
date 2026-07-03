/**
 * FLY-799 — founder REACTION ship-approval factory.
 *
 * Produces the per-gate reaction callback the gate-poller's reaction pass calls,
 * binding the composition-root deps (canonical founder id, StateStore, reaction
 * fetcher, binding reader, onResponseWritten) and gating on the SAME rules as the
 * text factory:
 *   - default-ON kill-switch `FLYWHEEL_FOUNDER_AUTO_APPROVE` (`=0` disables;
 *     read per-call so ops can flip without a restart);
 *   - a per-project denylist;
 *   - a resolvable canonical founder id (fail-closed when missing / split).
 * Any gate failing → null → the pass skips this gate and re-checks next tick.
 */

import { deriveCanonicalFounderId } from "./canonical-founder-id.js";
import {
	tryFounderReactionApproval as defaultHandler,
	type ReactionApprovalHandlerDeps,
} from "./founder-reaction-approval-handler.js";
import type { GateResponseDb } from "./write-gate-response.js";

export interface FounderReactionApprovalFactoryConfig {
	discordOwnerUserId?: string;
	founderConsentUserId?: string;
	store: ReactionApprovalHandlerDeps["store"];
	readBindingImpl: ReactionApprovalHandlerDeps["readBindingImpl"];
	onResponseWritten?: ReactionApprovalHandlerDeps["onResponseWritten"];
	/** Projects for which auto-approve is disabled (per-project kill). */
	denylistProjects?: ReadonlySet<string>;
	evaluateReactionImpl?: ReactionApprovalHandlerDeps["evaluateReactionImpl"];
	writeGateResponseImpl?: ReactionApprovalHandlerDeps["writeGateResponseImpl"];
	/** Test seam. */
	handlerImpl?: typeof defaultHandler;
}

export interface FounderReactionApprovalCallbackArgs {
	gate: {
		questionId: string;
		executionId: string;
		checkpoint: string | null;
		createdAtMs: number;
	};
	ctx: { issueId: string; threadId: string; projectName: string };
	db: GateResponseDb;
	/** Per-lead Discord reactions fetcher (bot token differs per lead). */
	reactionFetcherImpl: ReactionApprovalHandlerDeps["reactionFetcherImpl"];
}

/** Default ON — only an explicit `=0` disables (kill-switch). */
function autoApproveEnabled(): boolean {
	return process.env.FLYWHEEL_FOUNDER_AUTO_APPROVE !== "0";
}

export function makeFounderReactionApprovalCallback(
	config: FounderReactionApprovalFactoryConfig,
): (
	args: FounderReactionApprovalCallbackArgs,
) => Promise<{ handled: string[]; retrySafe: boolean } | null> {
	const handler = config.handlerImpl ?? defaultHandler;
	return async (args) => {
		if (!autoApproveEnabled()) return null; // kill-switch
		if (config.denylistProjects?.has(args.ctx.projectName)) return null;
		const canonicalFounderId = deriveCanonicalFounderId(
			config.discordOwnerUserId,
			config.founderConsentUserId,
		);
		if (!canonicalFounderId) return null; // fail-closed

		return handler(
			{
				gate: args.gate,
				ctx: { issueId: args.ctx.issueId, threadId: args.ctx.threadId },
			},
			{
				canonicalFounderId,
				store: config.store,
				db: args.db,
				reactionFetcherImpl: args.reactionFetcherImpl,
				readBindingImpl: config.readBindingImpl,
				onResponseWritten: config.onResponseWritten,
				evaluateReactionImpl: config.evaluateReactionImpl,
				writeGateResponseImpl: config.writeGateResponseImpl,
			},
		);
	};
}
