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
			const question = db.getMessageById(args.toQuestionId);
			if (!question || question.type !== "question") {
				throw new Error(`Question not found: ${args.toQuestionId}`);
			}
			const intentKey = `founder-route:${args.leadId}:${args.msgId}:${args.toQuestionId}`;
			return db.routeFounderReply({
				msgId: args.msgId,
				leadId: args.leadId,
				toQuestionId: args.toQuestionId,
				now,
				provenance: authorization.provenance,
				intentKey,
				envelope: {
					id: `founder-route-wake:${args.leadId}:${args.msgId}:${args.toQuestionId}`,
					to: question.from_agent,
					content:
						"A founder reply was routed to your pending question. Run flywheel-comm check for the durable response.",
					metadata: {
						kind: "founder_reply_routed",
						origin: "founder",
						msgId: args.msgId,
						questionId: args.toQuestionId,
					},
				},
				queuedAtMs: nowDate.getTime(),
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
