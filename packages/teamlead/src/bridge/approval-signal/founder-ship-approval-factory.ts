/**
 * FLY-799 — founder ship-approval factory.
 *
 * Produces the `tryFounderShipApproval` callback the deliverer's ship branch
 * calls, binding the composition-root deps (canonical founder id, StateStore,
 * onResponseWritten) and gating on:
 *   - the default-ON kill-switch `FLYWHEEL_FOUNDER_AUTO_APPROVE` (`=0` disables;
 *     read per-call so ops can flip without a Bridge restart);
 *   - a per-project denylist (turn one project off without stopping the fleet);
 *   - a resolvable canonical founder id (fail-closed when missing / split).
 * Any gate failing → the callback returns null → the deliverer falls back to the
 * byte-compatible WAKE-only behavior.
 */

import { deriveCanonicalFounderId } from "./canonical-founder-id.js";
import {
	tryFounderShipApproval as defaultHandler,
	type ShipApprovalHandlerArgs,
	type ShipApprovalHandlerDeps,
} from "./founder-ship-approval-handler.js";
import type { GateResponseDb } from "./write-gate-response.js";

/**
 * FLY-1041 Chunk 4: structural audit surface (the real StateStore satisfies
 * it). Every attribution decision is persisted as an idempotent
 * `founder_ship_attribution` session_event — the forensics trail the FLY-910
 * incident lacked.
 */
export interface AttributionAuditStore {
	insertEvent(event: {
		event_id: string;
		execution_id: string;
		issue_id: string;
		project_name: string;
		event_type: string;
		source: string;
		payload?: Record<string, unknown>;
	}): boolean;
}

export interface FounderShipApprovalFactoryConfig {
	discordOwnerUserId?: string;
	founderConsentUserId?: string;
	store: ShipApprovalHandlerDeps["store"];
	onResponseWritten?: ShipApprovalHandlerDeps["onResponseWritten"];
	/** Projects for which auto-approve is disabled (per-project kill). */
	denylistProjects?: ReadonlySet<string>;
	evaluateTextImpl?: ShipApprovalHandlerDeps["evaluateTextImpl"];
	writeGateResponseImpl?: ShipApprovalHandlerDeps["writeGateResponseImpl"];
	/** FLY-1041 Chunk 4: attribution audit target. Absent → no audit events. */
	auditStore?: AttributionAuditStore;
	/** FLY-1041 Chunk 5: shared founder-approval hold guard (plugin injects). */
	isHeld?: ShipApprovalHandlerDeps["isHeld"];
	/**
	 * FLY-799 image approval (default-OFF fast-follow): the production image
	 * evaluator (download + sha256 + multimodal classify). Absent → text-only.
	 * The `FLYWHEEL_FOUNDER_IMAGE_APPROVAL=1` flag (opt-in, read per-call) only
	 * takes effect when this is also wired.
	 */
	evaluateImageImpl?: ShipApprovalHandlerDeps["evaluateImageImpl"];
	/** Test seam. */
	handlerImpl?: typeof defaultHandler;
}

export interface FounderShipApprovalCallbackArgs {
	msg: ShipApprovalHandlerArgs["msg"];
	shipGates: {
		questionId: string;
		checkpoint: string | null;
		executionId: string;
		createdAtMs: number;
	}[];
	ctx: { issueId: string; threadId: string; projectName: string };
	db: GateResponseDb;
	/** FLY-1041 Chunk 7: deliverer-verified reply to THIS gate's ship card. */
	replyToCard?: boolean;
}

/** Default ON — only an explicit `=0` disables (kill-switch). */
function autoApproveEnabled(): boolean {
	return process.env.FLYWHEEL_FOUNDER_AUTO_APPROVE !== "0";
}

/** Default OFF — image approval is opt-in (`=1`), a 799 fast-follow. */
function imageApprovalEnabled(): boolean {
	return process.env.FLYWHEEL_FOUNDER_IMAGE_APPROVAL === "1";
}

export function makeFounderShipApprovalCallback(
	config: FounderShipApprovalFactoryConfig,
): (
	args: FounderShipApprovalCallbackArgs,
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

		// FLY-1041 Chunk 4: per-call audit sink. Event id = msgId + stage →
		// insertEvent's UNIQUE constraint makes re-processing the same founder
		// message (cursor retry) idempotent per stage. Audit must never break
		// attribution — swallow its own failures.
		const auditStore = config.auditStore;
		const auditSink = auditStore
			? (stage: string, payload?: Record<string, unknown>): void => {
					try {
						auditStore.insertEvent({
							event_id: `founder-ship-attribution-${args.msg.id}-${stage}`,
							execution_id: args.shipGates[0]?.executionId ?? "",
							issue_id: args.ctx.issueId,
							project_name: args.ctx.projectName,
							event_type: "founder_ship_attribution",
							source: "bridge.founder-ship-approval",
							payload: { stage, msgId: args.msg.id, ...(payload ?? {}) },
						});
					} catch (err) {
						console.warn(
							`[founder-ship-approval] attribution audit write failed (${stage}): ${(err as Error).message}`,
						);
					}
				}
			: undefined;

		return handler(
			{
				msg: args.msg,
				shipGates: args.shipGates,
				ctx: { issueId: args.ctx.issueId, threadId: args.ctx.threadId },
				replyToCard: args.replyToCard,
			},
			{
				canonicalFounderId,
				store: config.store,
				db: args.db,
				onResponseWritten: config.onResponseWritten,
				evaluateTextImpl: config.evaluateTextImpl,
				writeGateResponseImpl: config.writeGateResponseImpl,
				// FLY-799 image approval (default-off; only active with a wired
				// evaluator, which is the flip-on fast-follow).
				imageApproval: imageApprovalEnabled(),
				evaluateImageImpl: config.evaluateImageImpl,
				auditSink,
				isHeld: config.isHeld,
			},
		);
	};
}
