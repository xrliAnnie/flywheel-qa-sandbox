/**
 * FLY-799 — founder REACTION ship-approval factory.
 *
 * Produces the per-gate reaction callback the gate-poller's reaction pass calls,
 * binding the composition-root deps (canonical founder id, StateStore, reaction
 * fetcher, binding reader, onResponseWritten) and gating on the SAME rules as the
 * text factory:
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
	gateAuthorityView?: ReactionApprovalHandlerDeps["gateAuthorityView"];
	readBindingImpl: ReactionApprovalHandlerDeps["readBindingImpl"];
	onResponseWritten?: ReactionApprovalHandlerDeps["onResponseWritten"];
	/** Projects for which auto-approve is disabled (per-project kill). */
	denylistProjects?: ReadonlySet<string>;
	evaluateReactionImpl?: ReactionApprovalHandlerDeps["evaluateReactionImpl"];
	writeGateResponseImpl?: ReactionApprovalHandlerDeps["writeGateResponseImpl"];
	/**
	 * FLY-1041 Chunk 4/5: attribution audit target (see the text factory).
	 * The reaction pass re-polls every ~15s, so the event id is keyed on the
	 * gate question (stable) → one audit row per (gate, stage), not per poll.
	 */
	auditStore?: {
		insertEvent(event: {
			event_id: string;
			execution_id: string;
			issue_id: string;
			project_name: string;
			event_type: string;
			source: string;
			payload?: Record<string, unknown>;
		}): boolean;
	};
	/** FLY-1041 Chunk 5: shared founder-approval hold guard (plugin injects). */
	isHeld?: ReactionApprovalHandlerDeps["isHeld"];
	/** FLY-1238 shared guard + canonical project-root resolver. */
	mergedGateGuard?: ReactionApprovalHandlerDeps["mergedGateGuard"];
	projectRootFor?: (projectName: string) => string | undefined;
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

export function makeFounderReactionApprovalCallback(
	config: FounderReactionApprovalFactoryConfig,
): (
	args: FounderReactionApprovalCallbackArgs,
) => Promise<{ handled: string[]; retrySafe: boolean } | null> {
	const handler = config.handlerImpl ?? defaultHandler;
	return async (args) => {
		if (config.denylistProjects?.has(args.ctx.projectName)) return null;
		const canonicalFounderId = deriveCanonicalFounderId(
			config.discordOwnerUserId,
			config.founderConsentUserId,
		);
		if (!canonicalFounderId) return null; // fail-closed

		const auditStore = config.auditStore;
		const auditSink = auditStore
			? (stage: string, payload?: Record<string, unknown>): void => {
					try {
						auditStore.insertEvent({
							event_id: `founder-ship-attribution-reaction-${args.gate.questionId}-${stage}`,
							execution_id: args.gate.executionId,
							issue_id: args.ctx.issueId,
							project_name: args.ctx.projectName,
							event_type: "founder_ship_attribution",
							source: "bridge.founder-reaction-approval",
							payload: {
								stage,
								questionId: args.gate.questionId,
								...(payload ?? {}),
							},
						});
					} catch (err) {
						console.warn(
							`[founder-reaction-approval] attribution audit write failed (${stage}): ${(err as Error).message}`,
						);
					}
				}
			: undefined;

		return handler(
			{
				gate: args.gate,
				ctx: {
					issueId: args.ctx.issueId,
					threadId: args.ctx.threadId,
					projectName: args.ctx.projectName,
					projectRoot: config.projectRootFor?.(args.ctx.projectName),
				},
			},
			{
				canonicalFounderId,
				store: config.store,
				gateAuthorityView: config.gateAuthorityView,
				db: args.db,
				reactionFetcherImpl: args.reactionFetcherImpl,
				readBindingImpl: config.readBindingImpl,
				onResponseWritten: config.onResponseWritten,
				evaluateReactionImpl: config.evaluateReactionImpl,
				writeGateResponseImpl: config.writeGateResponseImpl,
				auditSink,
				isHeld: config.isHeld,
				mergedGateGuard: config.mergedGateGuard,
			},
		);
	};
}
