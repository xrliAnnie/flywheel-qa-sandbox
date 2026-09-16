import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import type { LeadOperationContext, LeadOperationHandler } from "../broker.js";
import { getLeadCapability } from "../catalog.js";
import { createLeadCapabilityContext } from "../runtime-context.js";
import { assertUpstreamToolsPinned } from "../upstream-baseline.js";

/** Explicit baseline update requires a newly observed/approved schema artifact. */
export const CONTEXT7_BASELINE = Object.freeze({
	serverId: "context7" as const,
	version: "4.1.0",
	toolSchemaDigest:
		"1b81b0be105b1c92fc49161e70b4e9140509ea9762723fc79d85326ce7454282",
});
const denied = () => new Error("docs_scope_denied");
const reply = z.object({
	isError: z.boolean().optional(),
	content: z
		.array(z.object({ type: z.literal("text"), text: z.string().max(131072) }))
		.min(1)
		.max(32),
});
/** Trusted parent SDK client must be connected by the fixed endpoint provider. */
export function createContext7Handlers(options: {
	env: NodeJS.ProcessEnv;
	activationId: string;
	client: Client;
	secrets: readonly string[];
}): ReadonlyMap<string, LeadOperationHandler> {
	const env = Object.freeze({ ...options.env }),
		trusted = createLeadCapabilityContext(env),
		secrets = Object.freeze([...options.secrets]);
	const containsSecret = (text: string) =>
		secrets.some((secret) => secret.length > 0 && text.includes(secret));
	async function current(context: LeadOperationContext) {
		context.signal.throwIfAborted();
		if (
			context.projectName !== env.FLYWHEEL_PROJECT_NAME ||
			context.leadId !== env.FLYWHEEL_LEAD_ID ||
			context.activationId !== options.activationId
		)
			throw denied();
		await context.assertCurrent();
		trusted.assertActivationCurrent();
		context.signal.throwIfAborted();
	}
	return new Map(
		(
			[
				["docs.library.resolve", "resolve-library-id"],
				["docs.lookup", "query-docs"],
			] as const
		).map(([operationId, name]) => {
			const definition = getLeadCapability(operationId)!;
			const authorize = async (
				raw: Record<string, unknown>,
				context: LeadOperationContext,
			) => {
				definition.inputSchema.parse(raw);
				if (containsSecret(JSON.stringify(raw))) throw denied();
				await current(context);
			};
			return [
				operationId,
				{
					authorize,
					execute: async (raw, context) => {
						let authorized = false;
						try {
							await authorize(raw, context);
							authorized = true;
							const signal = AbortSignal.any([
								context.signal,
								AbortSignal.timeout(15000),
							]);
							const tools = await options.client.listTools(undefined, {
								signal,
								timeout: 15000,
							});
							await current(context);
							signal.throwIfAborted();
							if (tools.nextCursor) throw new Error("baseline_drift");
							assertUpstreamToolsPinned(CONTEXT7_BASELINE, {
								serverId: "context7",
								version: options.client.getServerVersion()?.version ?? "",
								tools: tools.tools,
							});
							const result = await options.client.callTool(
								{ name, arguments: raw },
								undefined,
								{ signal, timeout: 15000 },
							);
							await current(context);
							signal.throwIfAborted();
							if (
								Buffer.byteLength(JSON.stringify(result)) > 196608 ||
								containsSecret(JSON.stringify(result))
							)
								throw denied();
							const parsed = reply.parse(result);
							if (parsed.isError) throw denied();
							const text = parsed.content.map((block) => block.text).join("\n");
							if (Buffer.byteLength(text) > 131072) throw denied();
							return {
								status: "succeeded" as const,
								data: definition.outputSchema.parse({
									text,
									untrusted: true,
									receiptId: context.requestId,
									observedAt: new Date().toISOString(),
								}),
							};
						} catch (error) {
							if (!authorized)
								return {
									status: "rejected",
									errorCode: "context7_scope_denied",
								};
							return {
								status: "unknown" as const,
								...(error instanceof Error && error.message === "baseline_drift"
									? { errorCode: "baseline_drift" }
									: {}),
							};
						}
					},
				} satisfies LeadOperationHandler,
			];
		}),
	);
}
