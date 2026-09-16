import {
	LeadCapabilityBroker,
	leadOperationInputDigest,
	type OperationResult,
} from "../lead-capabilities/broker.js";
import type { OperationReceiptStore } from "../lead-capabilities/receipts.js";

/** Reuses the broker's atomic UUID/digest state machine on Bridge-owned storage. */
export async function executeLeadBridgeWrite(options: {
	operationId:
		| "terminal.input"
		| "inbox.batch.ack"
		| "inbox.event.ack"
		| "memory.add";
	providerPrefix: "terminal" | "inbox-batch" | "inbox-event" | "memory";
	resultIdentity:
		| { executionId: string }
		| { batchId: string }
		| { eventId: string }
		| { opId: string };
	receiptOnly?: boolean;
	projectName: string;
	leadId: string;
	activationId: string;
	requestId: string;
	input: Record<string, unknown>;
	receipts: OperationReceiptStore;
	signal: AbortSignal;
	secrets: readonly string[];
	assertCurrent(): Promise<void>;
	authorize(): Promise<void>;
	effect(): Promise<void>;
	sideEffectsPossible(): boolean;
}): Promise<OperationResult> {
	if (options.receiptOnly) {
		options.signal.throwIfAborted();
		await options.assertCurrent();
		await options.authorize();
		options.signal.throwIfAborted();
		const prior = options.receipts.get({
			projectName: options.projectName,
			leadId: options.leadId,
			operationId: options.operationId,
			requestId: options.requestId,
		});
		if (!prior)
			return {
				requestId: options.requestId,
				status: "unknown",
				resourceRefs: [],
			};
		if (prior.inputDigest !== leadOperationInputDigest(options.input))
			return {
				requestId: options.requestId,
				status: "rejected",
				resourceRefs: [],
				errorCode: "input_digest_conflict",
			};
		if (
			prior.state === "succeeded" &&
			prior.providerRef === `${options.providerPrefix}:${options.requestId}`
		)
			return {
				requestId: options.requestId,
				status: "succeeded",
				resourceRefs: [prior.providerRef],
				data: {
					...options.resultIdentity,
					receiptId: options.requestId,
					observedAt: new Date(prior.updatedAt).toISOString(),
				},
			};
		return {
			requestId: options.requestId,
			status: prior.state === "rejected" ? "rejected" : "unknown",
			resourceRefs: [],
			...(prior.errorCode ? { errorCode: prior.errorCode } : {}),
		};
	}
	const broker = new LeadCapabilityBroker({
		projectName: options.projectName,
		leadId: options.leadId,
		activationId: options.activationId,
		receipts: options.receipts,
		secrets: options.secrets,
		allowedOperationIds: () => new Set([options.operationId]),
		assertCurrent: async () => {
			options.signal.throwIfAborted();
			await options.assertCurrent();
			options.signal.throwIfAborted();
		},
		handlers: new Map([
			[
				options.operationId,
				{
					authorize: () => options.authorize(),
					execute: async () => {
						try {
							await options.effect();
							return {
								status: "succeeded" as const,
								providerRef: `${options.providerPrefix}:${options.requestId}`,
								data: {
									...options.resultIdentity,
									receiptId: options.requestId,
									observedAt: new Date().toISOString(),
								},
							};
						} catch (error) {
							return {
								status: options.sideEffectsPossible()
									? ("unknown" as const)
									: ("rejected" as const),
								errorCode: error instanceof Error ? error.message : undefined,
							};
						}
					},
				},
			],
		]),
	});
	const abort = () => {
		void broker.close();
	};
	options.signal.addEventListener("abort", abort, { once: true });
	try {
		if (options.signal.aborted) abort();
		const result = await broker.execute({
			schemaVersion: 1,
			operationId: options.operationId,
			requestId: options.requestId,
			input: options.input,
		});
		if (result.status === "pending") return { ...result, status: "unknown" };
		// A replay returns scalar durable evidence; reconstruct only the same validated DTO.
		if (result.status === "succeeded" && !result.data) {
			const receipt = options.receipts.get({
				projectName: options.projectName,
				leadId: options.leadId,
				operationId: options.operationId,
				requestId: options.requestId,
			});
			if (
				!receipt ||
				receipt.state !== "succeeded" ||
				receipt.providerRef !== `${options.providerPrefix}:${options.requestId}`
			)
				return {
					requestId: options.requestId,
					status: "unknown",
					resourceRefs: [],
				};
			return {
				...result,
				data: {
					...options.resultIdentity,
					receiptId: options.requestId,
					observedAt: new Date(receipt.updatedAt).toISOString(),
				},
			};
		}
		return result;
	} finally {
		options.signal.removeEventListener("abort", abort);
		await broker.close();
	}
}
