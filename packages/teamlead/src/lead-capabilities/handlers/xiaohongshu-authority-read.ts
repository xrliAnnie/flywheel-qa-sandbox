import { authorityResponseSchemas } from "../../xiaohongshu-write/authority-client.js";
import {
	type LoginReadOperation,
	loginReadOperation,
} from "../../xiaohongshu-write/login-contract.js";
import {
	type PublicReadOperation,
	publicReadOperation,
} from "../../xiaohongshu-write/provider-read-contract.js";
import type { LeadOperationHandler } from "../broker.js";
import { getLeadCapability } from "../catalog.js";
import { createLeadCapabilityContext } from "../runtime-context.js";

/** Authority handles already carry private resource provenance. Never re-project
 * them through the legacy MCP token map, or fall back after an authority error. */
export function createXhsAuthorityReadHandlers(options: {
	env: NodeJS.ProcessEnv;
	activationId: string;
	client: {
		call(
			action: PublicReadOperation | LoginReadOperation,
			input: unknown,
			signal?: AbortSignal,
		): Promise<unknown>;
	} | null;
	secrets: readonly string[];
}): ReadonlyMap<string, LeadOperationHandler> {
	const client = options.client;
	if (!client) return new Map();
	const env = Object.freeze({ ...options.env }),
		activationId = options.activationId;
	const secrets = [...options.secrets];
	const trusted = createLeadCapabilityContext(env);
	const handlers = new Map<string, LeadOperationHandler>();
	for (const action of [
		...publicReadOperation.options,
		...loginReadOperation.options,
	]) {
		const operationId = `xiaohongshu.${action}`;
		const definition = getLeadCapability(operationId)!;
		const authorize: LeadOperationHandler["authorize"] = async (
			raw,
			context,
		) => {
			definition.inputSchema.parse(raw);
			if (
				context.projectName !== env.FLYWHEEL_PROJECT_NAME ||
				context.leadId !== env.FLYWHEEL_LEAD_ID ||
				context.activationId !== activationId
			)
				throw Error("upstream_scope_denied");
			context.signal.throwIfAborted();
			await context.assertCurrent();
			trusted.assertActivationCurrent();
			context.signal.throwIfAborted();
		};
		const handler: LeadOperationHandler = {
			authorize,
			execute: async (raw, context) => {
				try {
					await authorize(raw, context);
					const projected = authorityResponseSchemas[action].parse(
						await client.call(
							action,
							definition.inputSchema.parse(raw),
							context.signal,
						),
					);
					await authorize(raw, context);
					const qr =
						action === "get_login_qrcode"
							? authorityResponseSchemas.get_login_qrcode.parse(projected)
							: null;
					const text =
						"text" in projected
							? projected.text
							: JSON.stringify(
									qr
										? {
												loggedIn: qr.loggedIn,
												expiresAt: qr.expiresAt,
											}
										: projected,
								);
					const content: (
						| { type: "text"; text: string }
						| { type: "image"; mimeType: "image/png"; data: string }
					)[] = [{ type: "text", text }];
					if (qr && !qr.loggedIn) {
						if (qr.expiresAt <= Date.now()) throw Error();
						content.push({
							type: "image",
							mimeType: "image/png",
							data: qr.image.slice("data:image/png;base64,".length),
						});
					}
					const exposed = JSON.stringify(content);
					if (
						secrets.some(
							(secret) => secret.length > 0 && exposed.includes(secret),
						)
					)
						throw Error();
					return {
						status: "succeeded",
						data: definition.outputSchema.parse({
							result: { content },
							untrusted: true,
							receiptId: context.requestId,
							observedAt: new Date().toISOString(),
						}),
					};
				} catch {
					return { status: "unknown" };
				}
			},
		};
		handlers.set(operationId, handler);
	}
	return handlers;
}
