import { CommDB, type RouteFounderReplyResult } from "../db.js";
import { isReservedApprovalAttribution } from "../founder-attribution.js";
import {
	authorizeLeadWrite,
	type LeadWriteAuthorizationDeps,
} from "../lead-lease.js";

export interface RouteFounderReplyArgs {
	msgId: string;
	leadId: string;
	dbPath: string;
	toQuestionId?: string;
	noRouteReason?: string;
	env?: NodeJS.ProcessEnv;
	authorizationDeps?: LeadWriteAuthorizationDeps;
	now?: () => Date;
}

/**
 * Lead-only handled action for a founder receipt root. Authorization, the
 * optional runner response, processed receipt(s), and durable wake intent are
 * bound to one invocation. New roots are scoped by Lead/project/issue; legacy
 * model-lane rows additionally preserve frozen-candidate checks.
 */
export function routeFounderReply(
	args: RouteFounderReplyArgs,
): RouteFounderReplyResult {
	if (isReservedApprovalAttribution(args.leadId)) {
		throw new Error(
			`flywheel-comm: "${args.leadId}" is a reserved founder-side attribution and cannot route founder replies`,
		);
	}
	const authorization = authorizeLeadWrite(
		{ claimedLeadId: args.leadId, env: args.env ?? process.env },
		args.authorizationDeps,
	);
	const nowDate = args.now?.() ?? new Date();
	const now = nowDate.toISOString();
	const db = new CommDB(args.dbPath, false);
	try {
		if (args.toQuestionId) {
			return db.routeFounderReply({
				msgId: args.msgId,
				leadId: args.leadId,
				toQuestionId: args.toQuestionId,
				now,
				provenance: authorization.provenance,
			});
		}
		return db.routeFounderReply({
			msgId: args.msgId,
			leadId: args.leadId,
			noRouteReason: args.noRouteReason,
			now,
			provenance: authorization.provenance,
		});
	} finally {
		db.close();
	}
}
