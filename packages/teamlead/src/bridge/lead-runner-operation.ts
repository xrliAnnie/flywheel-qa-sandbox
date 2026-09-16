import { deriveRunnerStartKey } from "flywheel-comm/runner-start";
import {
	createRunnerActions,
	type RunnerActionsOptions,
} from "../lead-backends/codex/runner-actions.js";
import {
	type HandlerOutcome,
	LeadCapabilityBroker,
	leadOperationInputDigest,
	type OperationResult,
} from "../lead-capabilities/broker.js";
import { getLeadCapability } from "../lead-capabilities/catalog.js";
import type { OperationReceiptStore } from "../lead-capabilities/receipts.js";

/** Bridge-only adapter over the original guarded runner actions and existing receipt table. */
export async function executeLeadRunnerOperation(options: {
	actions: RunnerActionsOptions;
	projectName: string;
	leadId: string;
	activationId: string;
	operationId: string;
	requestId: string;
	input: Record<string, unknown>;
	receipts: OperationReceiptStore;
	signal: AbortSignal;
	secrets: readonly string[];
	receiptOnly?: boolean;
	assertCurrent(): void;
}): Promise<OperationResult> {
	const key = {
		projectName: options.projectName,
		leadId: options.leadId,
		operationId: options.operationId,
		requestId: options.requestId,
	};
	const unknown = (): OperationResult => ({
		requestId: key.requestId,
		status: "unknown",
		resourceRefs: [],
	});
	const denied = () => new Error("runner_scope_denied");
	const timerController = new AbortController(),
		signal = AbortSignal.any([options.signal, timerController.signal]);
	const timer = setTimeout(() => timerController.abort(), 15000);
	let broker: LeadCapabilityBroker | undefined;
	const abort = () => {
		void broker?.close();
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		const definition = getLeadCapability(key.operationId);
		if (!definition || definition.parityId !== "P01") throw denied();
		const input = definition.inputSchema.parse(options.input);
		const current = () => {
			signal.throwIfAborted();
			options.assertCurrent();
			const row = options.actions.context.assertCurrent();
			if (
				row.identity.projectName !== key.projectName ||
				row.identity.leadId !== key.leadId ||
				row.lead.codexCapabilityBundleVersion !== 2
			)
				throw denied();
			signal.throwIfAborted();
			return row;
		};
		current();
		const actions = createRunnerActions({
			...options.actions,
			bridge: { ...options.actions.bridge, signal },
			context: { ...options.actions.context, assertCurrent: current },
		});
		const authorize = () => {
			current();
			actions.authorize(key.operationId, input);
			current();
		};
		const reconstruct = (): OperationResult => {
			authorize();
			const receipt = options.receipts.get(key);
			if (!receipt) return unknown();
			if (receipt.inputDigest !== leadOperationInputDigest(input))
				return {
					...unknown(),
					status: "rejected",
					errorCode: "input_digest_conflict",
				};
			if (receipt.state !== "succeeded")
				return {
					...unknown(),
					status: receipt.state === "rejected" ? "rejected" : "unknown",
				};
			const match =
				/^(runner-execution|runner-instruction|runner-response):([a-f0-9-]{36})$/i.exec(
					receipt.providerRef ?? "",
				);
			if (!match) return unknown();
			let result: Record<string, unknown>;
			if (
				key.operationId === "start_runner" &&
				match[1] === "runner-execution"
			) {
				actions.authorize("get_runner_status", { executionId: match[2] });
				const attribution = deriveRunnerStartKey({
					projectName: key.projectName,
					leadId: key.leadId,
					issueId: input.issueId as string,
					idempotencyKey: input.idempotencyKey as string,
				});
				result = {
					outcome: "started",
					executionId: match[2],
					idempotencyKey: input.idempotencyKey,
					source: attribution.source,
					sourceRef: attribution.sourceRef,
				};
			} else if (
				key.operationId === "send_runner" &&
				match[1] === "runner-instruction"
			)
				result = {
					outcome: "queued",
					instructionId: match[2],
					executionId: input.executionId,
				};
			else if (
				key.operationId === "respond_runner" &&
				match[1] === "runner-response"
			)
				result = { outcome: "queued", responseId: match[2] };
			else return unknown();
			const data = definition.outputSchema.parse({
				result,
				receiptId: key.requestId,
				observedAt: new Date(receipt.updatedAt).toISOString(),
			});
			if (options.secrets.some((s) => s && JSON.stringify(data).includes(s)))
				return unknown();
			current();
			return {
				requestId: key.requestId,
				status: "succeeded",
				resourceRefs: [receipt.providerRef!],
				data,
			};
		};
		if (options.receiptOnly)
			return definition.classification === "write" ? reconstruct() : unknown();
		broker = new LeadCapabilityBroker({
			...key,
			activationId: options.activationId,
			receipts: options.receipts,
			secrets: options.secrets,
			allowedOperationIds: () => new Set([key.operationId]),
			assertCurrent: async () => {
				current();
			},
			handlers: new Map([
				[
					key.operationId,
					{
						authorize: async () => {
							authorize();
						},
						execute: async (): Promise<HandlerOutcome> => {
							authorize();
							const result = await actions.execute(key.operationId, input);
							current();
							if (result.outcome === "refused") return { status: "rejected" };
							if (result.outcome === "unknown" || result.outcome === "pending")
								return { status: "unknown" };
							let providerRef: string | undefined;
							if (key.operationId === "start_runner")
								providerRef =
									typeof result.executionId === "string"
										? `runner-execution:${result.executionId}`
										: undefined;
							else if (key.operationId === "send_runner")
								providerRef =
									typeof result.instructionId === "string"
										? `runner-instruction:${result.instructionId}`
										: undefined;
							else if (key.operationId === "respond_runner")
								providerRef =
									typeof result.responseId === "string"
										? `runner-response:${result.responseId}`
										: undefined;
							if (definition.classification === "write" && !providerRef)
								return { status: "unknown" };
							return {
								status: "succeeded",
								...(providerRef ? { providerRef } : {}),
								data: definition.outputSchema.parse({
									result,
									receiptId: key.requestId,
									observedAt: new Date().toISOString(),
								}),
							};
						},
					},
				],
			]),
		});
		const result = await broker.execute({
			schemaVersion: 1,
			operationId: key.operationId,
			requestId: key.requestId,
			input,
		});
		if (result.status === "succeeded" && !result.data) return reconstruct();
		return result.status === "pending"
			? { ...result, status: "unknown" }
			: result;
	} catch {
		return {
			...unknown(),
			status: signal.aborted ? "unknown" : "rejected",
			errorCode: "runner_scope_denied",
		};
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		await broker?.close();
	}
}
