import {
	CodexLeadOutboundHandler,
	type CodexLeadOutboundHandlerOptions,
	type OutboundDedupStore,
} from "./CodexLeadOutboundHandler.js";
import {
	CodexOutboundSender,
	type CodexOutboundSenderOptions,
} from "./CodexOutboundSender.js";
import {
	type BuildLeadDiscordSendOptions,
	buildLeadDiscordSend,
} from "./leadDiscordSend.js";

/** Parent-only composition of existing outbox/dedup/send services. No new database or model HTTP proxy. */
export function createBrokerDiscordOutboundSender(options: {
	sender: Omit<CodexOutboundSenderOptions, "post">;
	store: OutboundDedupStore;
	resolveBotToken: BuildLeadDiscordSendOptions["resolveBotToken"];
	authorizeLeadChannel: NonNullable<
		CodexLeadOutboundHandlerOptions["authorizeLeadChannel"]
	>;
	fetchImpl?: typeof fetch;
	/** Parent journal entry captured for this sender, never taken from operation input. */
	deliveryContext?: string;
}): CodexOutboundSender {
	const deliveryContext = options.deliveryContext;
	const handler = new CodexLeadOutboundHandler({
		store: options.store,
		expectedApiToken: options.sender.apiToken,
		authorizeLeadChannel: options.authorizeLeadChannel,
		send: buildLeadDiscordSend({
			resolveBotToken: options.resolveBotToken,
			fetchImpl: options.fetchImpl,
		}),
	});
	return new CodexOutboundSender({
		...options.sender,
		post: async (request) => {
			const body = JSON.parse(request.body);
			if (
				deliveryContext !== undefined &&
				request.deliveryContext !== undefined &&
				deliveryContext !== request.deliveryContext
			)
				return {
					status: 403,
					body: JSON.stringify({
						status: "rejected",
						reason: "delivery_context_conflict",
					}),
				};
			if (
				body.probe !== true &&
				(!request.guard?.beforeSideEffect ||
					!request.guard.assertSideEffectCurrent ||
					!request.guard.signal)
			)
				return {
					status: 403,
					body: JSON.stringify({
						status: "rejected",
						reason: "outbound_guard_required",
					}),
				};
			const outcome = await handler.handle({
				body,
				providedToken: request.headers.authorization?.replace(/^Bearer /, ""),
				guard: request.guard,
				deliveryContext: request.deliveryContext ?? deliveryContext,
			});
			return { status: outcome.httpStatus, body: JSON.stringify(outcome) };
		},
	});
}
