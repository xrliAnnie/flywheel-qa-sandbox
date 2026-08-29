import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ContextUsageRow {
	v: 1;
	ts: string;
	threadId: string;
	turnId: string;
	totalTokens: number;
	modelContextWindow: number | null;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
	if (typeof value !== "string" || !value)
		throw new Error(`${label} is required`);
	return value;
}

/** Byte-for-byte field contract shared with raya/packages/contracts metrics v1. */
export function parseContextUsage(
	ts: string,
	notification: unknown,
): ContextUsageRow {
	const event = record(notification, "token usage notification");
	const tokenUsage = record(event.tokenUsage, "tokenUsage");
	const total = record(tokenUsage.total, "tokenUsage.total");
	const totalTokens = total.totalTokens;
	if (
		typeof totalTokens !== "number" ||
		!Number.isInteger(totalTokens) ||
		totalTokens < 0
	) {
		throw new Error(
			"tokenUsage.total.totalTokens must be a non-negative integer",
		);
	}
	const modelContextWindow = tokenUsage.modelContextWindow;
	if (
		modelContextWindow !== null &&
		(typeof modelContextWindow !== "number" ||
			!Number.isInteger(modelContextWindow) ||
			modelContextWindow <= 0)
	) {
		throw new Error("tokenUsage.modelContextWindow must be positive or null");
	}
	return {
		v: 1,
		ts,
		threadId: text(event.threadId, "threadId"),
		turnId: text(event.turnId, "turnId"),
		totalTokens,
		modelContextWindow,
	};
}

export interface RecordContextUsageInput {
	activeThreadId: string;
	notification: unknown;
	usagePath: string;
	unavailablePath: string;
	now?: () => string;
	appendLine?: (path: string, line: string) => void;
	log?: (message: string) => void;
}

export function recordContextUsage(
	input: RecordContextUsageInput,
): "recorded" | "ignored" | "unavailable" {
	const now = input.now?.() ?? new Date().toISOString();
	const append =
		input.appendLine ??
		((path: string, line: string) => {
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, `${line}\n`, { encoding: "utf8", mode: 0o600 });
		});
	const unavailable = (
		reason: "parse_failed" | "append_failed",
		error: unknown,
	) => {
		const detail = error instanceof Error ? error.message : String(error);
		const row = {
			v: 1,
			ts: now,
			activeThreadId: input.activeThreadId,
			reason,
			detail,
		};
		try {
			append(input.unavailablePath, JSON.stringify(row));
		} catch (unavailableError) {
			input.log?.(
				`context usage unavailable (${reason}: ${detail}); unavailable ledger append failed: ${
					unavailableError instanceof Error
						? unavailableError.message
						: String(unavailableError)
				}`,
			);
		}
		return "unavailable" as const;
	};
	let row: ContextUsageRow;
	try {
		row = parseContextUsage(now, input.notification);
	} catch (error) {
		return unavailable("parse_failed", error);
	}
	if (row.threadId !== input.activeThreadId) return "ignored";
	try {
		append(input.usagePath, JSON.stringify(row));
		return "recorded";
	} catch (error) {
		return unavailable("append_failed", error);
	}
}
