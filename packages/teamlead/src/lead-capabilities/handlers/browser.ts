import { z } from "zod";
import type { LeadArtifactStore } from "../artifacts.js";
import type { LeadOperationContext, LeadOperationHandler } from "../broker.js";
import { projectBrowserOutput } from "../browser-output.js";
import { BROWSER_TOOL_SCHEMAS } from "../browser-schemas.js";
import type { BrowserWorker } from "../browser-worker.js";
import { getLeadCapability } from "../catalog.js";
export function createBrowserHandlers(options: {
	activationId: string;
	generation: string;
	worker: Pick<BrowserWorker, "call">;
	workerArtifactRoot: string;
	store: LeadArtifactStore;
	assertCurrent(): void;
}): ReadonlyMap<string, LeadOperationHandler> {
	const generation = z.string().uuid().parse(options.generation),
		handlers = new Map<string, LeadOperationHandler>();
	for (const name of Object.keys(BROWSER_TOOL_SCHEMAS)) {
		const operation = getLeadCapability(`browser.${name}`)!;
		const check = async (
			raw: Record<string, unknown>,
			ctx: LeadOperationContext,
		) => {
			const input = operation.inputSchema.safeParse(raw);
			if (
				!input.success ||
				input.data.generation !== generation ||
				ctx.activationId !== options.activationId ||
				ctx.signal.aborted
			)
				throw new Error("browser_scope_denied");
			await ctx.assertCurrent();
			options.assertCurrent();
			if (ctx.signal.aborted) throw new Error("browser_scope_denied");
			return input.data;
		};
		handlers.set(operation.operationId, {
			authorize: async (raw, ctx) => {
				await check(raw, ctx);
			},
			execute: async (raw, ctx) => {
				try {
					const input = await check(raw, ctx);
					const output = await options.worker.call(
						generation,
						name,
						input.arguments,
						ctx.signal,
					);
					// Record only a validated provider success before checking whether its
					// output may still be delivered. This cannot start another operation.
					const terminal = z
						.object({
							isError: z.literal(false).optional(),
							content: z
								.array(
									z
										.object({
											type: z.literal("text"),
											text: z.string().max(262144),
										})
										.strict(),
								)
								.max(64),
							structuredContent: z.unknown().optional(),
							_meta: z.unknown().optional(),
						})
						.strict()
						.safeParse(output.result);
					if (
						operation.classification === "write" &&
						terminal.success &&
						Buffer.byteLength(JSON.stringify(output.result)) <= 4 * 1024 * 1024
					)
						await ctx.recordTerminalEvidence?.({
							status: "succeeded",
							providerRef: `browser:${generation}:${ctx.requestId}`,
						});
					await ctx.assertCurrent();
					options.assertCurrent();
					const data = await projectBrowserOutput(name, output, options);
					if (data.isError) return { status: "unknown" };
					return {
						status: "succeeded",
						providerRef: `browser:${generation}:${ctx.requestId}`,
						data,
					};
				} catch (error) {
					if (
						error instanceof Error &&
						[
							"browser_tool_denied",
							"browser_egress_denied",
							"browser_scope_denied",
						].includes(error.message)
					)
						return { status: "rejected", errorCode: error.message };
					return { status: "unknown" };
				}
			},
		});
	}
	return handlers;
}
