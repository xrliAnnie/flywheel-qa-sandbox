import {
	CommDB,
	type HandleReceiptResult,
	type ReceiptHandleAction,
} from "../db.js";
import { isReservedApprovalAttribution } from "../founder-attribution.js";
import {
	authorizeLeadWrite,
	type LeadWriteAuthorization,
	type LeadWriteAuthorizationDeps,
} from "../lead-lease.js";

export interface HandleReceiptArgs {
	dbPath: string;
	requestId: string;
	receiptId: string;
	leadId: string;
	action: ReceiptHandleAction;
	targetQuestionId?: string;
	content?: string;
	reason?: string;
	env?: NodeJS.ProcessEnv;
	authorizationDeps?: LeadWriteAuthorizationDeps;
	authorize?: () => LeadWriteAuthorization;
	now?: () => Date;
}

/** Lead-only CLI seam for the category-agnostic receipt handle action. */
export function handleReceipt(args: HandleReceiptArgs): HandleReceiptResult {
	if (isReservedApprovalAttribution(args.leadId)) {
		throw new Error(`"${args.leadId}" cannot handle Lead receipts`);
	}
	const authorization =
		args.authorize?.() ??
		authorizeLeadWrite(
			{ claimedLeadId: args.leadId, env: args.env ?? process.env },
			args.authorizationDeps,
		);
	if (
		!authorization.provenance?.senderLeaseKey ||
		!authorization.provenance.senderGeneration
	) {
		throw new Error(
			"receipt handling requires a validated Lead lease generation",
		);
	}
	const nowDate = args.now?.() ?? new Date();
	const db = new CommDB(args.dbPath, false);
	try {
		if (args.action === "relay" || args.action === "respond") {
			const questionId = args.targetQuestionId?.trim();
			if (!questionId) {
				throw new Error(`${args.action} requires --to-question`);
			}
		}
		return db.handleReceipt({
			requestId: args.requestId,
			receiptId: args.receiptId,
			authenticatedLead: args.leadId,
			action: args.action,
			now: nowDate.toISOString(),
			provenance: authorization.provenance,
			...(args.targetQuestionId
				? { targetQuestionId: args.targetQuestionId }
				: {}),
			...(args.content ? { content: args.content } : {}),
			...(args.reason ? { reason: args.reason } : {}),
		});
	} finally {
		db.close();
	}
}
