import type { LeadOperationHandler } from "./broker.js";
import {
	CONTEXT7_BASELINE,
	createContext7Handlers,
} from "./handlers/context7.js";
import { createLeadCapabilityContext } from "./runtime-context.js";
import { openPinnedHttpMcpSession } from "./upstream-http-session.js";

const denied = () => new Error("context7_provider_unavailable");
/** Parent-owned SDK session. Endpoint, routing and credentials are never model input. */
export async function startContext7Provider(options: {
	env: NodeJS.ProcessEnv;
	activationId: string;
	apiKey?: string;
	secrets: readonly string[];
	fetchImpl?: typeof fetch;
}) {
	const env = Object.freeze({ ...options.env }),
		trusted = createLeadCapabilityContext(env),
		key = options.apiKey;
	if (
		key !== undefined &&
		(!key.trim() || key.length > 8192 || /[\r\n]/.test(key))
	)
		throw denied();
	const session = await openPinnedHttpMcpSession({
		baseline: CONTEXT7_BASELINE,
		headers: key ? { authorization: `Bearer ${key}` } : {},
		assertCurrent: () => trusted.assertActivationCurrent(),
		fetchImpl: options.fetchImpl,
	});
	let closed = false;
	const close = () => {
		closed = true;
		return session.close();
	};
	try {
		const underlying = createContext7Handlers({
			env,
			activationId: options.activationId,
			client: session.client,
			secrets: [...options.secrets, ...(key ? [key] : [])],
		});
		const handlers = new Map<string, LeadOperationHandler>();
		for (const [id, handler] of underlying)
			handlers.set(id, {
				authorize: async (raw, context) => {
					session.current();
					await handler.authorize(raw, context);
					session.current();
				},
				execute: async (raw, context) => {
					if (closed) return { status: "unknown" };
					const result = await handler.execute(raw, context);
					return closed ? { status: "unknown" } : result;
				},
			});
		return { handlers, integration: session.integration, close };
	} catch (error) {
		await close();
		throw error;
	}
}
