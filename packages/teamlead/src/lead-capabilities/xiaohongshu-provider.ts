import type { LeadArtifactStore } from "./artifacts.js";
import {
	createUpstreamReadAdapter,
	UPSTREAM_READ_BASELINES,
} from "./handlers/upstream-read.js";
import {
	type LeadCapabilityRuntimeAuthorityOptions,
	resolveLeadCapabilityRuntimeAuthority,
} from "./runtime-authority.js";
import { openPinnedHttpMcpSession } from "./upstream-http-session.js";

/** Fixed loopback MCP service owns its cookie state; the parent owns session/token handles. */
export async function startXiaohongshuProvider(
	options: {
		activationId: string;
		artifacts: LeadArtifactStore;
		secrets: readonly string[];
		fetchImpl?: typeof fetch;
	} & LeadCapabilityRuntimeAuthorityOptions,
) {
	const env = Object.freeze({ ...options.env }),
		{ trusted } = resolveLeadCapabilityRuntimeAuthority({ ...options, env });
	const session = await openPinnedHttpMcpSession({
		baseline: UPSTREAM_READ_BASELINES["xiaohongshu-mcp"],
		assertCurrent: () => trusted.assertActivationCurrent(),
		fetchImpl: options.fetchImpl,
	});
	try {
		const adapter = createUpstreamReadAdapter({
			...options,
			serverId: "xiaohongshu-mcp",
			env,
			client: session.client,
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
