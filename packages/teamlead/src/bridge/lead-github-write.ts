import {
	LeadCapabilityBroker,
	leadOperationInputDigest,
	type OperationResult,
} from "../lead-capabilities/broker.js";
import { getLeadCapability } from "../lead-capabilities/catalog.js";
import type { OperationReceiptStore } from "../lead-capabilities/receipts.js";
import { assertLeadGithubPrBinding } from "./lead-github-binding.js";
import { createLeadGithubBoundHandlers } from "./lead-github-handlers.js";
/** Actual result-only execution in Bridge; UUID replay never repeats a recorded external write. */
export async function executeLeadGithubWrite(
	options: Omit<
		Parameters<typeof createLeadGithubBoundHandlers>[0],
		"client"
	> & {
		client?: Parameters<typeof createLeadGithubBoundHandlers>[0]["client"];
		operationId: string;
		requestId: string;
		input: Record<string, unknown>;
		receipts: OperationReceiptStore;
		secrets: readonly string[];
		signal: AbortSignal;
		receiptOnly?: boolean;
	},
): Promise<OperationResult> {
	const definition = getLeadCapability(options.operationId);
	if (!definition || definition.githubTier !== "B")
		throw new Error("github_scope_denied");
	const input = definition.inputSchema.parse(options.input);
	const current = async () => {
		options.signal.throwIfAborted();
		options.assertCurrent();
	};
	const key = {
		projectName: options.projectName,
		leadId: options.leadId,
		operationId: options.operationId,
		requestId: options.requestId,
	};
	if (options.receiptOnly) {
		await current();
		assertLeadGithubPrBinding({ ...options, prNumber: input.number as number });
		const prior = options.receipts.get(key);
		if (prior && prior.inputDigest !== leadOperationInputDigest(input))
			return {
				requestId: options.requestId,
				status: "rejected",
				resourceRefs: [],
				errorCode: "input_digest_conflict",
			};
		return {
			requestId: options.requestId,
			status:
				prior?.state === "succeeded"
					? "succeeded"
					: prior?.state === "rejected"
						? "rejected"
						: "unknown",
			resourceRefs:
				prior?.state === "succeeded" && prior.providerRef
					? [prior.providerRef]
					: [],
			...(prior?.errorCode ? { errorCode: prior.errorCode } : {}),
		};
	}
	if (!options.client) throw new Error("github_provider_unavailable");
	const broker = new LeadCapabilityBroker({
		...key,
		activationId: options.activationId,
		receipts: options.receipts,
		secrets: options.secrets,
		allowedOperationIds: () => new Set([options.operationId]),
		assertCurrent: current,
		handlers: createLeadGithubBoundHandlers({
			...options,
			client: options.client,
		}),
	});
	const abort = () => {
		void broker.close();
	};
	options.signal.addEventListener("abort", abort, { once: true });
	try {
		if (options.signal.aborted) abort();
		return await broker.execute({
			schemaVersion: 1,
			operationId: options.operationId,
			requestId: options.requestId,
			input,
		});
	} finally {
		options.signal.removeEventListener("abort", abort);
		await broker.close();
	}
}
