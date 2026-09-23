import { createHash } from "node:crypto";

export interface WorkflowUsageObservation {
	sourceRecordId: string;
	sourceOffset: number;
	sourceDigest: string;
	providerRequestId: string | null;
	nativeTurnId: string | null;
	observedModelId: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
	totalTokens: number;
	at: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined;
}

function timestamp(value: unknown): string | undefined {
	return typeof value === "string" && Number.isFinite(Date.parse(value))
		? value
		: undefined;
}

function parsed(line: string): Record<string, unknown> | undefined {
	try {
		return object(JSON.parse(line));
	} catch {
		return undefined;
	}
}

function source(input: {
	line: string;
	offset: number;
	providerRequestId: string | null;
	nativeTurnId: string | null;
	observedModelId: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
	at: string;
}): WorkflowUsageObservation {
	return {
		sourceRecordId: String(input.offset),
		sourceOffset: input.offset,
		sourceDigest: createHash("sha256").update(input.line).digest("hex"),
		providerRequestId: input.providerRequestId,
		nativeTurnId: input.nativeTurnId,
		observedModelId: input.observedModelId,
		inputTokens: input.inputTokens,
		outputTokens: input.outputTokens,
		cacheReadTokens: input.cacheReadTokens,
		cacheWriteTokens: input.cacheWriteTokens,
		reasoningTokens: input.reasoningTokens,
		totalTokens:
			input.inputTokens +
			input.outputTokens +
			input.cacheReadTokens +
			input.cacheWriteTokens,
		at: input.at,
	};
}

export function parseClaudeUsageLine(
	line: string,
	context: { offset: number; nativeTurnId?: string },
): WorkflowUsageObservation | null {
	const row = parsed(line);
	const message = object(row?.message);
	const usage = object(message?.usage);
	const requestId = row?.requestId;
	const model = message?.model;
	const at = timestamp(row?.timestamp);
	const inputTokens = count(usage?.input_tokens);
	const outputTokens = count(usage?.output_tokens);
	const cacheReadTokens = count(usage?.cache_read_input_tokens);
	const cacheWriteTokens = count(usage?.cache_creation_input_tokens);
	if (
		row?.type !== "assistant" ||
		typeof requestId !== "string" ||
		!requestId ||
		typeof model !== "string" ||
		!model ||
		!at ||
		inputTokens === undefined ||
		outputTokens === undefined ||
		cacheReadTokens === undefined ||
		cacheWriteTokens === undefined
	) {
		return null;
	}
	return source({
		line,
		offset: context.offset,
		providerRequestId: requestId,
		nativeTurnId: context.nativeTurnId ?? null,
		observedModelId: model,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		reasoningTokens: 0,
		at,
	});
}

export function parseCodexUsageLine(
	line: string,
	context: { offset: number; nativeTurnId?: string; model: string },
): WorkflowUsageObservation | null {
	const row = parsed(line);
	const payload = object(row?.payload);
	const info = object(payload?.info);
	const usage = object(info?.total_token_usage);
	const at = timestamp(row?.timestamp);
	const inputTokens = count(usage?.input_tokens);
	const outputTokens = count(usage?.output_tokens);
	const cacheReadTokens = count(usage?.cached_input_tokens);
	const reasoningTokens = count(usage?.reasoning_output_tokens);
	const nativeTotal = count(usage?.total_tokens);
	if (
		row?.type !== "event_msg" ||
		payload?.type !== "token_count" ||
		!at ||
		!context.model ||
		inputTokens === undefined ||
		outputTokens === undefined ||
		cacheReadTokens === undefined ||
		reasoningTokens === undefined ||
		nativeTotal === undefined ||
		nativeTotal !== inputTokens + outputTokens
	) {
		return null;
	}
	return {
		...source({
			line,
			offset: context.offset,
			providerRequestId: null,
			nativeTurnId: context.nativeTurnId ?? null,
			observedModelId: context.model,
			inputTokens,
			outputTokens,
			cacheReadTokens,
			cacheWriteTokens: 0,
			reasoningTokens,
			at,
		}),
		totalTokens: nativeTotal,
	};
}
