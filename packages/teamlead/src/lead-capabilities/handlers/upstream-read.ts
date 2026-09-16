import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import type { LeadArtifactStore } from "../artifacts.js";
import type { LeadOperationContext, LeadOperationHandler } from "../broker.js";
import { getLeadCapability } from "../catalog.js";
import { createLeadCapabilityContext } from "../runtime-context.js";
import { assertUpstreamToolsPinned } from "../upstream-baseline.js";
import { UPSTREAM_TOOL_ROWS } from "../upstream-inputs.js";
import { XiaohongshuTokenHandles } from "../xiaohongshu-tokens.js";
export const UPSTREAM_READ_BASELINES = Object.freeze({
	gbrain: {
		serverId: "gbrain" as const,
		version: "0.9.0",
		toolSchemaDigest:
			"e0835ffe366c98afdbbd96b6da6f30061e5f0b6cbde24a8a9e61e82df0fc84b2",
	},
	"xiaohongshu-mcp": {
		serverId: "xiaohongshu-mcp" as const,
		version: "2.0.0",
		toolSchemaDigest:
			"6136bc3de6c1ffa20fb3951e19ebc426d3d5a7e51b6a95bdd89ae1f0f08b605f",
	},
});
const reply = z.object({
	isError: z.boolean().optional(),
	content: z
		.array(
			z.union([
				z.object({ type: z.literal("text"), text: z.string().max(196608) }),
				z.object({
					type: z.literal("image"),
					mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
					data: z.string().max(196608),
				}),
			]),
		)
		.min(1)
		.max(32),
});
const denied = () => new Error("upstream_read_unavailable");
/** Read adapters own only token associations; the outer provider owns/ closes the SDK connection. */
export function createUpstreamReadAdapter(options: {
	serverId: "gbrain" | "xiaohongshu-mcp";
	env: NodeJS.ProcessEnv;
	activationId: string;
	client: Client;
	artifacts: LeadArtifactStore;
	secrets: readonly string[];
}) {
	const env = Object.freeze({ ...options.env }),
		trusted = createLeadCapabilityContext(env),
		secrets = Object.freeze([...options.secrets]);
	let closed = false;
	const tokens = new XiaohongshuTokenHandles(() => {
		if (closed) throw denied();
		trusted.assertActivationCurrent();
	});
	const secret = (text: string) =>
		secrets.some((value) => value.length > 0 && text.includes(value));
	async function current(context: LeadOperationContext) {
		if (
			closed ||
			context.projectName !== env.FLYWHEEL_PROJECT_NAME ||
			context.leadId !== env.FLYWHEEL_LEAD_ID ||
			context.activationId !== options.activationId
		)
			throw denied();
		context.signal.throwIfAborted();
		await context.assertCurrent();
		trusted.assertActivationCurrent();
		context.signal.throwIfAborted();
	}
	const handlers = new Map<string, LeadOperationHandler>();
	for (const row of UPSTREAM_TOOL_ROWS.filter(
		(row) => row.serverId === options.serverId && row.classification === "read",
	)) {
		const definition = getLeadCapability(row.operationId)!;
		const authorize = async (
			raw: Record<string, unknown>,
			context: LeadOperationContext,
		) => {
			row.input.parse(raw);
			if (secret(JSON.stringify(raw))) throw denied();
			await current(context);
		};
		handlers.set(row.operationId, {
			authorize,
			execute: async (raw, context) => {
				try {
					await authorize(raw, context);
					const signal = AbortSignal.any([
						context.signal,
						AbortSignal.timeout(15000),
					]);
					const input = { ...raw };
					if (typeof input.resourceHandle === "string") {
						input.xsec_token = tokens.resolve(
							input.resourceHandle,
							String(input.feed_id ?? input.user_id ?? ""),
						);
						delete input.resourceHandle;
					}
					const tools = await options.client.listTools(undefined, {
						signal,
						timeout: 15000,
					});
					await current(context);
					signal.throwIfAborted();
					if (tools.nextCursor) throw new Error("baseline_drift");
					assertUpstreamToolsPinned(UPSTREAM_READ_BASELINES[options.serverId], {
						serverId: options.serverId,
						version: options.client.getServerVersion()?.version ?? "",
						tools: tools.tools,
					});
					const result = await options.client.callTool(
						{ name: row.toolName, arguments: input },
						undefined,
						{ signal, timeout: 15000 },
					);
					await current(context);
					signal.throwIfAborted();
					const serialized = JSON.stringify(result);
					if (Buffer.byteLength(serialized) > 196608 || secret(serialized))
						throw denied();
					const parsed = reply.parse(result);
					if (parsed.isError) throw denied();
					const content = [];
					for (const block of parsed.content) {
						if (block.type === "text")
							content.push({
								type: "text",
								text:
									options.serverId === "xiaohongshu-mcp"
										? tokens.project(block.text)
										: block.text,
							});
						else {
							if (!/^[A-Za-z0-9+/]*={0,2}$/.test(block.data)) throw denied();
							const data = Buffer.from(block.data, "base64");
							if (data.toString("base64") !== block.data) throw denied();
							if (
								secrets.some(
									(value) =>
										value.length > 0 && data.includes(Buffer.from(value)),
								)
							)
								throw denied();
							const artifact = await options.artifacts.put(
								data,
								block.mimeType,
							);
							await current(context);
							signal.throwIfAborted();
							content.push({
								type: "image",
								artifactHandle: artifact.handle,
								artifactPath: artifact.relativePath,
								mimeType: artifact.mimeType,
							});
						}
					}
					await current(context);
					signal.throwIfAborted();
					return {
						status: "succeeded",
						data: definition.outputSchema.parse({
							result: { content },
							untrusted: true,
							receiptId: context.requestId,
							observedAt: new Date().toISOString(),
						}),
					};
				} catch (error) {
					return {
						status: "unknown",
						...(error instanceof Error && error.message === "baseline_drift"
							? { errorCode: "baseline_drift" }
							: {}),
					};
				}
			},
		});
	}
	return {
		handlers,
		close: () => {
			closed = true;
			tokens.close();
		},
	};
}
