import type { LeadArtifactStore } from "./artifacts.js";
import {
	createUpstreamReadAdapter,
	UPSTREAM_READ_BASELINES,
} from "./handlers/upstream-read.js";
import { createLeadCapabilityContext } from "./runtime-context.js";
import { openPinnedHttpMcpSession } from "./upstream-http-session.js";

/** Fixed loopback MCP service owns its cookie state; the parent owns session/token handles. */
export async function startXiaohongshuProvider(options: {
	env: NodeJS.ProcessEnv;
	activationId: string;
	artifacts: LeadArtifactStore;
	secrets: readonly string[];
	fetchImpl?: typeof fetch;
}) {
	const env = Object.freeze({ ...options.env }),
		trusted = createLeadCapabilityContext(env);
	const session = await openPinnedHttpMcpSession({
		baseline: UPSTREAM_READ_BASELINES["xiaohongshu-mcp"],
		assertCurrent: () => trusted.assertActivationCurrent(),
		fetchImpl: options.fetchImpl,
	});
	try {
		const adapter = createUpstreamReadAdapter({
			serverId: "xiaohongshu-mcp",
			env,
			activationId: options.activationId,
			client: session.client,
			artifacts: options.artifacts,
			secrets: options.secrets,
		});
		return {
			handlers: adapter.handlers,
			integration: session.integration,
			close: () => {
				adapter.close();
				return session.close();
			},
		};
	} catch (error) {
		await session.close();
		throw error;
	}
}
