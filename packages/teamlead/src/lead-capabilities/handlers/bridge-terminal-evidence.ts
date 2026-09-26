import { z } from "zod";
import type { LeadOperationContext } from "../broker.js";
import { getLeadCapability } from "../catalog.js";

const supported = new Set([
	"discord.thread.reply",
	"discord.message.edit",
	"discord.message.react",
	"github.pr.ready",
	"github.pr.edit",
	"github.pr.comment",
	"github.pr.review",
	"github.run.rerun",
	"start_runner",
	"send_runner",
	"respond_runner",
]);
const replySchema = z
	.object({
		requestId: z.string().uuid(),
		status: z.enum(["succeeded", "rejected", "unknown"]),
		resourceRefs: z.array(z.string().regex(/^[a-zA-Z0-9_.:-]{1,256}$/)).max(1),
		data: z.unknown().optional(),
		errorCode: z.string().max(128).optional(),
	})
	.strict();

/** Consumes only the original HTTP result. Receipt settlement grants no output or I/O authority. */
export async function observeBridgeTerminalEvidence(
	response: Response,
	options: {
		operationId: string;
		raw: Record<string, unknown>;
		context: LeadOperationContext;
		secrets: readonly string[];
		repository?: string;
		receiptOnly: boolean;
	},
): Promise<Response> {
	const { operationId, raw, context } = options;
	if (
		options.receiptOnly ||
		!context.recordTerminalEvidence ||
		!supported.has(operationId) ||
		!response.ok ||
		!response.body
	)
		return response;
	const length = response.headers.get("content-length");
	if (length !== null && (!/^\d+$/.test(length) || Number(length) > 262144)) {
		void response.body.cancel().catch(() => {});
		throw new Error("bridge_terminal_body_limit");
	}
	const reader = response.body.getReader();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new Error("bridge_terminal_body_timeout"));
			void reader.cancel().catch(() => {});
		}, 2000);
	});
	let size = 0;
	const chunks: Uint8Array[] = [];
	try {
		while (true) {
			const item = await Promise.race([reader.read(), deadline]);
			if (item.done) break;
			size += item.value.byteLength;
			if (size > 262144) throw new Error("bridge_terminal_body_limit");
			chunks.push(item.value);
		}
	} finally {
		clearTimeout(timer);
		void reader.cancel().catch(() => {});
	}
	const bytes = Buffer.concat(chunks);
	// Invalid receipts still reach the existing guarded parser; they are never terminal proof.
	let providerRef: string | undefined;
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (options.secrets.some((secret) => text.includes(secret)))
			throw new Error("secret");
		const result = replySchema.parse(JSON.parse(text));
		if (
			result.requestId !== context.requestId ||
			result.status !== "succeeded" ||
			result.resourceRefs.length !== 1
		)
			throw new Error("correlation");
		const data = getLeadCapability(operationId)!.outputSchema.parse(
			result.data,
		);
		const ref = result.resourceRefs[0]!;
		let expected: string;
		if (operationId.startsWith("discord.")) {
			if (
				operationId === "discord.thread.reply"
					? data.threadId !== raw.threadId
					: data.messageId !== raw.messageId
			)
				throw new Error("target");
			expected = `discord-message:${data.messageId}`;
		} else {
			if (data.receiptId !== context.requestId) throw new Error("receipt");
			if (operationId.startsWith("github.")) {
				if (operationId === "github.run.rerun") {
					if (data.runId !== raw.runId) throw new Error("target");
					expected = `run:${raw.runId}`;
				} else if (
					operationId === "github.pr.ready" ||
					operationId === "github.pr.edit"
				) {
					if (
						(operationId === "github.pr.ready"
							? data.number
							: (data.pullRequest as { number: number }).number) !== raw.number
					)
						throw new Error("target");
					expected = `pr:${raw.number}`;
				} else {
					expected = String(data.commentId ?? data.reviewId);
					const link = new URL(data.url as string);
					if (
						!/^[1-9][0-9]{0,15}$/.test(expected) ||
						!Number.isSafeInteger(Number(expected)) ||
						!options.repository ||
						link.origin !== "https://github.com" ||
						link.username ||
						link.password ||
						![
							`/${options.repository}/pull/${raw.number}`,
							`/${options.repository}/issues/${raw.number}`,
						].some((path) => path.toLowerCase() === link.pathname.toLowerCase())
					)
						throw new Error("target");
				}
			} else {
				const output = data.result as Record<string, unknown>;
				if (operationId === "start_runner") {
					if (
						output.outcome !== "started" ||
						output.idempotencyKey !== raw.idempotencyKey ||
						!z.string().uuid().safeParse(output.executionId).success
					)
						throw new Error("target");
					expected = `runner-execution:${output.executionId}`;
				} else if (operationId === "send_runner") {
					if (output.executionId !== raw.executionId) throw new Error("target");
					expected = `runner-instruction:${output.instructionId}`;
				} else expected = `runner-response:${output.responseId}`;
			}
		}
		if (ref !== expected) throw new Error("reference");
		providerRef = ref;
	} catch {
		/* Ambiguous, invalid, and refused responses never release the target. */
	}
	if (providerRef)
		await context.recordTerminalEvidence({ status: "succeeded", providerRef });
	return new Response(bytes, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}
