import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { browserFacadeSchemaDigest } from "../lead-backends/codex/browser-capability-proxy.js";
import type { LeadArtifactStore } from "./artifacts.js";
import { createAutomaticOutboundTransport } from "./automatic-outbound.js";
import type { LeadOperationHandler } from "./broker.js";
import { BROWSER_MCP_VERSION } from "./browser-config.js";
import { startBrowserEgressProxy } from "./browser-egress-proxy.js";
import { startBrowserProvider } from "./browser-provider.js";
import { LEAD_CAPABILITY_CATALOG } from "./catalog.js";
import { startContext7Provider } from "./context7-provider.js";
import { startGbrainProvider } from "./gbrain-provider.js";
import {
	createLeadGithubClient,
	resolveLeadGithubToken,
} from "./github-client.js";
import { createArtifactTextHandler } from "./handlers/artifact-text.js";
import { createBridgeAttachmentHandlers } from "./handlers/bridge-attachments.js";
import { createBridgeDiscordHandlers } from "./handlers/bridge-discord.js";
import {
	createBridgeReadHandlers,
	createGithubBridgeHandlers,
	createInboxBatchAckHandlers,
	createInboxEventAckHandlers,
	createMemoryBridgeHandlers,
	createPatrolHandlers,
	createRunnerBridgeHandlers,
	createTerminalInputHandlers,
} from "./handlers/bridge-read.js";
import { createGithubReadProviderHandlers } from "./handlers/github-provider.js";
import { createLinearProviderSession } from "./handlers/linear-provider.js";
import { createReportDeliverHandlers } from "./handlers/report-deliver.js";
import { createReportPublishHandlers } from "./handlers/report-publish.js";
import { createReportVerifyHandlers } from "./handlers/report-verify.js";
import { createUpstreamWriteDenials } from "./handlers/upstream-write-denials.js";
import { createLeadCapabilityManifest } from "./manifest.js";
import { PINNED_NATIVE_CODEX_SKILLS } from "./native-skill-baseline.js";
import { resolveLeadCapabilities } from "./resolve.js";
import {
	type LeadRuleSourceRecord,
	prepareLeadManifestSources,
} from "./rule-sources.js";
import { createLeadCapabilityContext } from "./runtime-context.js";
import {
	type LeadCapabilityParentOptions,
	startLeadCapabilityParent,
} from "./runtime-parent.js";
import type { LeadSkillInventoryEntry } from "./skill-discovery.js";
import { startXiaohongshuProvider } from "./xiaohongshu-provider.js";

/** Sources and directories are prepared by the trusted launcher, not model inputs. */
export interface LeadRuntimeParentOptions extends LeadRuntimeProviderOptions {
	parent: Omit<
		LeadCapabilityParentOptions,
		| "manifest"
		| "handlers"
		| "secrets"
		| "closeProviders"
		| "outboundTransport"
		| "modelEnv"
		| "assertCurrent"
		| "permissionProfile"
	> & {
		permissionProfile: Omit<
			LeadCapabilityParentOptions["permissionProfile"],
			"proxyPort"
		>;
	};
	sources: {
		sourceRevision: string;
		records: readonly LeadRuleSourceRecord[];
		skillInventory: readonly LeadSkillInventoryEntry[];
	};
	adoptedMenuShapes: readonly string[];
	/** Re-check source pins, directory ownership and deployment throughout this activation. */
	assertPreparedCurrent(): Promise<void>;
}

/** Connect the real providers, manifest and existing parent without a credential-forwarding fallback. */
export async function startLeadRuntimeParent(
	options: LeadRuntimeParentOptions,
) {
	const env = Object.freeze({ ...options.env });
	const trusted = createLeadCapabilityContext(env);
	await options.assertPreparedCurrent();
	const sources = prepareLeadManifestSources(
		options.sources.records,
		options.secrets,
	);
	const initial = trusted.assertActivationCurrent();
	const identityDigest = initial.identity.identityDigest;
	const currentIdentity = () => {
		const row = trusted.assertActivationCurrent();
		if (row.identity.identityDigest !== identityDigest)
			throw new Error("runtime_identity_changed");
		return row;
	};
	const providers = await startLeadRuntimeProviders({ ...options, env });
	try {
		const current = async () => {
			await options.assertPreparedCurrent();
			currentIdentity();
			providers.assertCurrent();
		};
		await current();
		const resolved = resolveLeadCapabilities({
			row: currentIdentity(),
			integrationIds: providers.integrationIds,
			handlerOperationIds: [...providers.handlers.keys()],
			adoptedMenuShapes: options.adoptedMenuShapes,
		});
		if (!resolved || resolved.missingOperationIds.length)
			throw new Error("runtime_capabilities_incomplete");
		const localIntegrations = ["bridge", "discord", "linear", "github"].map(
			(id) => ({
				id,
				version: options.sources.sourceRevision,
				toolSchemaDigest: createHash("sha256")
					.update(
						JSON.stringify(
							resolved.operations
								.filter((row) => row.credentialConsumer === id)
								.map((row) => ({
									name: row.operationId,
									input: z.toJSONSchema(row.inputSchema),
									output: z.toJSONSchema(row.outputSchema),
								})),
						),
					)
					.digest("hex"),
			}),
		);
		const manifest = createLeadCapabilityManifest({
			...sources,
			sourceRevision: options.sources.sourceRevision,
			skillInventory: options.sources.skillInventory,
			projectName: initial.identity.projectName,
			leadId: initial.identity.leadId,
			identityDigest,
			backend: "codex-app-server",
			profile: "full-access",
			activationId: options.activationId,
			browserGeneration: providers.browserGeneration,
			operations: resolved.operations,
			integrations: [
				...localIntegrations,
				...providers.upstreamIntegrations,
				{
					id: "browser",
					version: BROWSER_MCP_VERSION,
					toolSchemaDigest: browserFacadeSchemaDigest(
						resolved.operations
							.filter((operation) =>
								operation.operationId.startsWith("browser."),
							)
							.map((operation) => operation.operationId.slice(8)),
					),
				},
			],
			nativeSkillBaseline: {
				codexVersion: PINNED_NATIVE_CODEX_SKILLS.codexVersion,
				...(PINNED_NATIVE_CODEX_SKILLS.origin
					? {
							origin: {
								root: PINNED_NATIVE_CODEX_SKILLS.origin.root,
								files: [...PINNED_NATIVE_CODEX_SKILLS.origin.files],
							},
						}
					: {}),
				sources: PINNED_NATIVE_CODEX_SKILLS.sources.map((source) => ({
					...source,
				})),
			},
		});
		const outboundTransport = createAutomaticOutboundTransport({
			env,
			activationId: options.activationId,
			journal: options.parent.journal,
			assertCurrent: current,
			fetchImpl: options.fetchImpl,
		});
		return await startLeadCapabilityParent({
			...options.parent,
			manifest,
			handlers: providers.handlers,
			secrets: providers.secrets,
			modelEnv: env,
			permissionProfile: {
				...options.parent.permissionProfile,
				proxyPort: providers.proxyPort,
			},
			assertCurrent: current,
			closeProviders: providers.close,
			outboundTransport,
		});
	} catch (error) {
		try {
			await providers.close();
		} catch {
			/* All cleanup attempted; retain startup failure. */
		}
		throw error;
	}
}

/** Trusted default-factory provider inputs; never obtained from model operation arguments. */
export interface LeadRuntimeProviderOptions {
	env: NodeJS.ProcessEnv;
	activationId: string;
	linearToken: string;
	context7ApiKey?: string;
	artifacts: LeadArtifactStore;
	secrets: readonly string[];
	fetchImpl?: typeof fetch;
	browser: Omit<
		Parameters<typeof startBrowserProvider>[0],
		"activationId" | "store" | "assertCurrent"
	>;
}

/** Assemble actual adapters once per activation. The outer factory owns sources/home/parent.
 * Child providers own their partial-start cleanup; this layer owns every completed child.
 */
export async function startLeadRuntimeProviders(
	options: LeadRuntimeProviderOptions,
) {
	const env = Object.freeze({ ...options.env });
	const trusted = createLeadCapabilityContext(env);
	const lifetime = new AbortController();
	const cleanup: Array<() => Promise<void>> = [];
	let closed = false,
		closing: Promise<void> | undefined;
	const close = () => {
		if (closing) return closing;
		closed = true;
		lifetime.abort();
		closing = (async () => {
			const errors: unknown[] = [];
			for (const dispose of [...cleanup].reverse()) {
				try {
					await dispose();
				} catch (error) {
					errors.push(error);
				}
			}
			if (errors.length) throw new Error("runtime_provider_cleanup_failed");
		})();
		return closing;
	};
	const current = () => {
		if (closed) throw new Error("runtime_providers_closed");
		trusted.assertActivationCurrent();
	};
	try {
		current();
		const githubToken = resolveLeadGithubToken(env);
		const secrets = Object.freeze([
			...new Set([
				...options.secrets,
				githubToken,
				options.linearToken,
				...(env.FLYWHEEL_API_TOKEN ? [env.FLYWHEEL_API_TOKEN] : []),
				...(options.context7ApiKey ? [options.context7ApiKey] : []),
			]),
		]);
		const common = {
			env,
			activationId: options.activationId,
			fetchImpl: options.fetchImpl,
			secrets,
		};
		const github = createLeadGithubClient({
			token: githubToken,
			fetchImpl: options.fetchImpl,
		});
		cleanup.push(github.close);
		const linear = createLinearProviderSession({
			...common,
			token: options.linearToken,
		});
		cleanup.push(linear.close);
		const handlers = new Map<string, LeadOperationHandler>([
			[
				"artifact.text.create",
				createArtifactTextHandler({
					projectName: env.FLYWHEEL_PROJECT_NAME!,
					leadId: env.FLYWHEEL_LEAD_ID!,
					activationId: options.activationId,
					store: options.artifacts,
					secrets,
					assertCurrent: current,
				}),
			],
		]);
		const add = (next: ReadonlyMap<string, LeadOperationHandler>) => {
			for (const [id, handler] of next) {
				if (handlers.has(id)) throw new Error("duplicate_runtime_handler");
				handlers.set(id, handler);
			}
		};
		for (const group of [
			createRunnerBridgeHandlers(common),
			createBridgeReadHandlers(common),
			createMemoryBridgeHandlers(common),
			createBridgeDiscordHandlers(common),
			createBridgeAttachmentHandlers({ ...common, store: options.artifacts }),
			createGithubReadProviderHandlers({ ...common, client: github.client }),
			createGithubBridgeHandlers(common),
			createTerminalInputHandlers(common),
			createInboxBatchAckHandlers(common),
			createInboxEventAckHandlers(common),
			createPatrolHandlers({
				...common,
				artifacts: options.artifacts,
				githubClient: github.client,
			}),
			createReportPublishHandlers({ ...common, store: options.artifacts }),
			createReportDeliverHandlers(common),
			createReportVerifyHandlers(common),
			linear.handlers,
			createUpstreamWriteDenials(common),
		])
			add(group);
		current();
		const gbrain = await startGbrainProvider({
			...common,
			artifacts: options.artifacts,
		});
		cleanup.push(gbrain.close);
		add(gbrain.handlers);
		current();
		const xiaohongshu = await startXiaohongshuProvider({
			...common,
			artifacts: options.artifacts,
		});
		cleanup.push(xiaohongshu.close);
		add(xiaohongshu.handlers);
		current();
		const context7 = await startContext7Provider({
			...common,
			apiKey: options.context7ApiKey,
		});
		cleanup.push(context7.close);
		add(context7.handlers);
		current();
		const browser = await startBrowserProvider({
			...options.browser,
			activationId: options.activationId,
			store: options.artifacts,
			assertCurrent: current,
		}).catch(async () => {
			// Native browser startup already attempts cleanup of its worker/profile/proxy.
			// Keep the model's restricted egress proxy without admitting any browser calls.
			current();
			const proxy = await startBrowserEgressProxy({
				policy: options.browser.egress,
				assertCurrent: current,
			});
			return {
				generation: randomUUID(),
				proxyPort: proxy.port,
				close: () => proxy.close(),
				handlers: new Map<string, LeadOperationHandler>(
					LEAD_CAPABILITY_CATALOG.filter(
						(row) => row.credentialConsumer === "browser",
					).map((row) => [
						row.operationId,
						{
							authorize: async () => {},
							execute: async () => ({
								status: "rejected",
								errorCode: "browser_unavailable",
							}),
						},
					]),
				),
			};
		});
		cleanup.push(browser.close);
		add(browser.handlers);
		current();
		const missing = LEAD_CAPABILITY_CATALOG.filter(
			(row) =>
				row.classification !== "reserved" &&
				!row.unconditionalDenial &&
				!handlers.has(row.operationId),
		);
		if (missing.length) throw new Error("runtime_handler_coverage_incomplete");
		for (const id of handlers.keys()) {
			const row = LEAD_CAPABILITY_CATALOG.find(
				(candidate) => candidate.operationId === id,
			);
			if (!row || row.classification === "reserved")
				throw new Error("invalid_runtime_handler");
		}
		const guarded = new Map<string, LeadOperationHandler>();
		for (const [id, handler] of handlers)
			guarded.set(id, {
				...handler,
				authorize: async (input, context) => {
					current();
					await handler.authorize?.(input, {
						...context,
						signal: AbortSignal.any([context.signal, lifetime.signal]),
					});
					current();
				},
				execute: async (input, context) => {
					current();
					const result = await handler.execute(input, {
						...context,
						signal: AbortSignal.any([context.signal, lifetime.signal]),
					});
					current();
					return result;
				},
				...(handler.reconcile
					? {
							reconcile: async (receipt, input, context) => {
								current();
								const result = await handler.reconcile!(receipt, input, {
									...context,
									signal: AbortSignal.any([context.signal, lifetime.signal]),
								});
								current();
								return result;
							},
						}
					: {}),
			});
		return {
			handlers: guarded,
			secrets,
			browserGeneration: browser.generation,
			proxyPort: browser.proxyPort,
			integrationIds: [
				"bridge",
				"discord",
				"linear",
				"github",
				"gbrain",
				"xiaohongshu-mcp",
				"context7",
				"browser",
			] as const,
			upstreamIntegrations: [
				gbrain.integration,
				xiaohongshu.integration,
				context7.integration,
			],
			assertCurrent: current,
			close,
		};
	} catch (error) {
		try {
			await close();
		} catch {
			/* All child cleanup was attempted; preserve startup cause. */
		}
		throw error;
	}
}
