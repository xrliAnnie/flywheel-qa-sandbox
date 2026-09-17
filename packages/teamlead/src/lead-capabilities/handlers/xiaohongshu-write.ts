import { authorityResponseSchemas } from "../../xiaohongshu-write/authority-client.js";
import { WRITE_OPERATIONS } from "../../xiaohongshu-write/contracts.js";
import type { HandlerOutcome, LeadOperationHandler } from "../broker.js";
import { createLeadCapabilityContext } from "../runtime-context.js";
import { UPSTREAM_TOOL_ROWS } from "../upstream-inputs.js";
import { xhsWriteReceiptInput } from "../xiaohongshu-write-input.js";

const unavailable: HandlerOutcome = {
	status: "unknown",
	errorCode: "provider_unknown",
};
/** The parent supplies a root-policy-verified client. A missing client never
 * falls back to raw MCP, and reconciliation only reads an existing attempt. */
export function createXhsWriteHandlers(options: {
	env: NodeJS.ProcessEnv;
	activationId: string;
	client: {
		call(
			action: "execute" | "status",
			input: unknown,
			signal?: AbortSignal,
		): Promise<unknown>;
	} | null;
	now?: () => number;
}): ReadonlyMap<string, LeadOperationHandler> {
	const env = Object.freeze({ ...options.env });
	const trusted = createLeadCapabilityContext(env);
	const activationId = options.activationId,
		client = options.client,
		now = options.now ?? Date.now;
	const absent = (): HandlerOutcome => ({
		status: "rejected",
		errorCode: "founder_write_gate_absent",
	});
	const outcome = (
		attempt: { attemptId: string; state: string } | null,
		receiptId: string,
	): HandlerOutcome => {
		if (!attempt) return { ...unavailable };
		if (attempt.state === "succeeded" || attempt.state === "succeeded-noop")
			return {
				status: "succeeded",
				providerRef: attempt.attemptId,
				data: {
					result: { attemptId: attempt.attemptId, state: attempt.state },
					untrusted: true,
					receiptId,
					observedAt: new Date(now()).toISOString(),
				},
			};
		if (attempt.state === "failed")
			return {
				status: "rejected",
				providerRef: attempt.attemptId,
				errorCode: "provider_rejected",
			};
		return { ...unavailable, providerRef: attempt.attemptId };
	};
	return new Map(
		WRITE_OPERATIONS.map((operationId) => {
			const legacy = UPSTREAM_TOOL_ROWS.find(
				(row) => row.operationId === operationId,
			)!;
			const parse = (raw: Record<string, unknown>) => {
				const receipt = xhsWriteReceiptInput.safeParse(raw);
				if (receipt.success) return receipt.data;
				legacy.input.parse(raw);
				return null;
			};
			const authorize: LeadOperationHandler["authorize"] = async (
				raw,
				context,
			) => {
				parse(raw);
				context.signal.throwIfAborted();
				if (
					context.projectName !== env.FLYWHEEL_PROJECT_NAME ||
					context.leadId !== env.FLYWHEEL_LEAD_ID ||
					context.activationId !== activationId
				)
					throw Error("upstream_scope_denied");
				await context.assertCurrent();
				trusted.assertActivationCurrent();
				context.signal.throwIfAborted();
			};
			const handler: LeadOperationHandler = {
				authorize,
				execute: async (raw, context) => {
					await authorize(raw, context);
					const receipt = parse(raw);
					if (!receipt || !client) return absent();
					try {
						const response = authorityResponseSchemas.execute.parse(
							await client.call(
								"execute",
								{
									proposalId: receipt.proposalId,
									receiptId: receipt.receiptId,
									contentDigest: receipt.expectedContentDigest,
									operationId,
									executeRequestId: context.requestId,
								},
								context.signal,
							),
						);
						if (response.kind === "denied")
							return { status: "rejected", errorCode: "provider_rejected" };
						return outcome(response, receipt.receiptId);
					} catch {
						return { ...unavailable };
					}
				},
				reconcile: async (_prior, raw, context) => {
					await authorize(raw, context);
					const receipt = parse(raw);
					if (!receipt || !client) return { ...unavailable };
					try {
						const response = authorityResponseSchemas.status.parse(
							await client.call(
								"status",
								{
									proposalId: receipt.proposalId,
									receiptId: receipt.receiptId,
									contentDigest: receipt.expectedContentDigest,
									operationId,
								},
								context.signal,
							),
						);
						if (
							response.proposalId !== receipt.proposalId ||
							response.contentDigest !== receipt.expectedContentDigest
						)
							return { ...unavailable };
						return outcome(response.attempt, receipt.receiptId);
					} catch {
						return { ...unavailable };
					}
				},
			};
			return [operationId, handler];
		}),
	);
}
