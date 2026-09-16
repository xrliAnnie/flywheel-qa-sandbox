import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { LeadArtifactStore } from "./artifacts.js";
import { pinGbrainHost } from "./gbrain-host.js";
import { GbrainStdioTransport } from "./gbrain-transport.js";
import {
	createUpstreamReadAdapter,
	UPSTREAM_READ_BASELINES,
} from "./handlers/upstream-read.js";
import { createLeadCapabilityContext } from "./runtime-context.js";
import { assertUpstreamToolsPinned } from "./upstream-baseline.js";

/** Production uses the pinned host stdio/config lifecycle, never a replacement database. */
export async function startGbrainProvider(options: {
	env: NodeJS.ProcessEnv;
	activationId: string;
	artifacts: LeadArtifactStore;
	secrets: readonly string[];
}) {
	const env = Object.freeze({ ...options.env }),
		trusted = createLeadCapabilityContext(env);
	trusted.assertActivationCurrent();
	const pin = pinGbrainHost(),
		transport = new GbrainStdioTransport(pin);
	const client = new Client(
		{ name: "flywheel-lead", version: "2" },
		{ capabilities: {} },
	);
	let closed = false,
		closing: Promise<void> | undefined,
		adapter: ReturnType<typeof createUpstreamReadAdapter> | undefined;
	const lifetime = new AbortController();
	const close = () => {
		if (closing) return closing;
		closed = true;
		lifetime.abort();
		adapter?.close();
		closing = (async () => {
			try {
				await client.close();
			} finally {
				await transport.close();
			}
		})();
		return closing;
	};
	const current = () => {
		if (closed) throw new Error("gbrain_provider_unavailable");
		trusted.assertActivationCurrent();
		pin.assertCurrent();
		if (transport.evidence.migrationsApplied !== 0)
			throw new Error("gbrain_migration_observed");
	};
	try {
		current();
		await client.connect(transport, { timeout: 15000 });
		current();
		const tools = await client.listTools(undefined, {
			signal: lifetime.signal,
			timeout: 15000,
		});
		current();
		if (tools.nextCursor) throw new Error("baseline_drift");
		const baseline = assertUpstreamToolsPinned(UPSTREAM_READ_BASELINES.gbrain, {
			serverId: "gbrain",
			version: client.getServerVersion()?.version ?? "",
			tools: tools.tools,
		});
		adapter = createUpstreamReadAdapter({
			serverId: "gbrain",
			env,
			activationId: options.activationId,
			client,
			artifacts: options.artifacts,
			secrets: [...options.secrets, ...pin.secrets],
		});
		const handlers = new Map(
			[...adapter.handlers].map(([id, handler]) => [
				id,
				{
					authorize: async (...args: Parameters<typeof handler.authorize>) => {
						current();
						await handler.authorize(...args);
						current();
					},
					execute: async (...args: Parameters<typeof handler.execute>) => {
						try {
							current();
							const outcome = await handler.execute(...args);
							current();
							return outcome;
						} catch {
							return { status: "unknown" as const };
						}
					},
				},
			]),
		);
		return {
			handlers,
			integration: baseline.integration,
			close,
			evidence: () => ({ ...pin.evidence, ...transport.evidence }),
		};
	} catch (error) {
		await close();
		throw error instanceof Error &&
			["baseline_drift", "gbrain_migration_observed"].includes(error.message)
			? error
			: new Error("gbrain_provider_unavailable");
	}
}
