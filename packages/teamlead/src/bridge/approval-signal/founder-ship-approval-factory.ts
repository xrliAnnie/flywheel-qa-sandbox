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

export interface FounderShipApprovalFactoryConfig {
	discordOwnerUserId?: string;
	founderConsentUserId?: string;
	store: ShipApprovalHandlerDeps["store"];
	onResponseWritten?: ShipApprovalHandlerDeps["onResponseWritten"];
	/** Projects for which auto-approve is disabled (per-project kill). */
	denylistProjects?: ReadonlySet<string>;
	evaluateTextImpl?: ShipApprovalHandlerDeps["evaluateTextImpl"];
	writeGateResponseImpl?: ShipApprovalHandlerDeps["writeGateResponseImpl"];
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

		return handler(
			{
				msg: args.msg,
				shipGates: args.shipGates,
				ctx: { issueId: args.ctx.issueId, threadId: args.ctx.threadId },
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
			},
		);
	};
}
