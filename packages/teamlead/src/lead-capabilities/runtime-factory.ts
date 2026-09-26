import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { browserFacadeSchemaDigest } from "../lead-backends/codex/browser-capability-proxy.js";
import type { VoiceBackgroundBrowserMode } from "../ProjectConfig.js";
import { createParentXhsAuthorityClient } from "../xiaohongshu-write/parent-client-policy.js";
import type { LeadArtifactStore } from "./artifacts.js";
import type { LeadCapabilityAuthority } from "./authority.js";
import { createAutomaticOutboundTransport } from "./automatic-outbound.js";
import type { LeadOperationHandler } from "./broker.js";
import { BROWSER_MCP_VERSION } from "./browser-config.js";
import { startBrowserEgressProxy } from "./browser-egress-proxy.js";
import { startBrowserProvider } from "./browser-provider.js";
import {
	LEAD_CAPABILITY_CATALOG,
	type LeadCapabilityDefinition,
} from "./catalog.js";
import { startContext7Provider } from "./context7-provider.js";
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
import { createBridgeVoiceHandlers } from "./handlers/bridge-voice.js";
import { createContext7Handlers } from "./handlers/context7.js";
import { createGithubReadProviderHandlers } from "./handlers/github-provider.js";
import {
	createLinearProviderHandlers,
	createLinearProviderSession,
} from "./handlers/linear-provider.js";
import { createReportDeliverHandlers } from "./handlers/report-deliver.js";
import { createReportPublishHandlers } from "./handlers/report-publish.js";
import { createReportVerifyHandlers } from "./handlers/report-verify.js";
import { createUpstreamWriteDenials } from "./handlers/upstream-write-denials.js";
import { createXhsAuthorityReadHandlers } from "./handlers/xiaohongshu-authority-read.js";
import { createXhsWriteHandlers } from "./handlers/xiaohongshu-write.js";
import { createXhsWriteManagementHandlers } from "./handlers/xiaohongshu-write-management.js";
import { createLeadCapabilityManifest } from "./manifest.js";
import { resolvePinnedNativeSkillBaseline } from "./native-skill-baseline.js";
import { resolveLeadCapabilities } from "./resolve.js";
import {
	type LeadRuleSourceRecord,
	prepareLeadManifestSources,
} from "./rule-sources.js";
import { resolveLeadCapabilityRuntimeAuthority } from "./runtime-authority.js";
import type { createLeadCapabilityContext } from "./runtime-context.js";
import {
	type LeadCapabilityParentOptions,
	startLeadCapabilityParent,
} from "./runtime-parent.js";
import type { LeadSkillInventoryEntry } from "./skill-discovery.js";
import { createLeadTargetLockClient } from "./target-lock-client.js";
import { UPSTREAM_TOOL_ROWS } from "./upstream-inputs.js";
import { startXiaohongshuProvider } from "./xiaohongshu-provider.js";

/** Integrations a voice parent may run without (plan v12 §14.1). Core ones never are. */
export type OptionalIntegrationId =
	| "browser"
	| "context7"
	| "github"
	| "linear"
	| "xiaohongshu-mcp";
/** The only public reasons; raw provider errors stay in local evidence. */
export type IntegrationUnavailableReason =
	| "credential_missing"
	| "host_config_unverified"
	| "baseline_drift"
	| "provider_start_failed";
export interface UnavailableIntegration {
	id: OptionalIntegrationId;
	reason: IntegrationUnavailableReason;
}

/** Maps a provider startup error code to its public reason. */
export function integrationUnavailableReason(
	error: unknown,
): IntegrationUnavailableReason {
	const code = error instanceof Error ? error.message : "";
	if (code === "baseline_drift") return "baseline_drift";
	return "provider_start_failed";
}

/**
 * Every checked operation is reserved, unconditionally denied, handled, or owned
 * by an unavailable integration; code that forgets a handler still fails closed.
 * The checked set is the catalog minus trusted exclusions (browser off).
 */
export function assertRuntimeHandlerCoverage(input: {
	handlers: ReadonlyMap<string, unknown>;
	omitted: ReadonlySet<string>;
	browserMode?: VoiceBackgroundBrowserMode;
}): void {
	const missing = LEAD_CAPABILITY_CATALOG.filter(
		(row) =>
			row.classification !== "reserved" &&
			!(input.browserMode === "off" && row.credentialConsumer === "browser") &&
			!row.unconditionalDenial &&
			!input.handlers.has(row.operationId) &&
			!input.omitted.has(row.operationId),
	);
	if (missing.length) throw new Error("runtime_handler_coverage_incomplete");
	for (const id of input.handlers.keys()) {
		const row = LEAD_CAPABILITY_CATALOG.find(
			(candidate) => candidate.operationId === id,
		);
		if (!row || row.classification === "reserved" || input.omitted.has(id))
			throw new Error("invalid_runtime_handler");
	}
}

/** Stand-in dependency: learning a group's operation ids must never touch it. */
function unavailableDependency<T>(): T {
	return new Proxy(
		{},
		{
			get() {
				throw new Error("integration_unavailable");
			},
		},
	) as T;
}

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
		| "targetLocks"
		| "egressProbeSeen"
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
	/** Voice sessions resolve the Lead-union inventory without Codex-carrier eligibility. */
	operations?: readonly LeadCapabilityDefinition[];
	/** Re-check source pins, directory ownership and deployment throughout this activation. */
	assertPreparedCurrent(): Promise<void>;
}

/** Connect the real providers, manifest and existing parent without a credential-forwarding fallback. */
export async function startLeadRuntimeParent(
	options: LeadRuntimeParentOptions,
) {
	const env = Object.freeze({ ...options.env });
	const { trusted } = resolveLeadCapabilityRuntimeAuthority({
		...options,
		env,
	});
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
		const resolved = options.operations
			? {
					// An unavailable integration's operations, its unconditional denials
					// included, are not published at all (review R2#3).
					operations: options.operations.filter(
						(operation) =>
							operation.classification !== "reserved" &&
							!providers.omittedOperationIds.has(operation.operationId) &&
							(!!operation.unconditionalDenial ||
								providers.handlers.has(operation.operationId)),
					),
					// An operation may be missing only because its integration is
					// recorded unavailable (omit_integration); anything else fails.
					missingOperationIds: options.operations
						.filter(
							(operation) =>
								!operation.unconditionalDenial &&
								!providers.handlers.has(operation.operationId) &&
								!providers.omittedOperationIds.has(operation.operationId),
						)
						.map((operation) => operation.operationId),
				}
			: resolveLeadCapabilities({
					row: currentIdentity(),
					integrationIds: providers.integrationIds,
					handlerOperationIds: [...providers.handlers.keys()],
					adoptedMenuShapes: options.adoptedMenuShapes,
				});
		if (!resolved || resolved.missingOperationIds.length)
			throw new Error("runtime_capabilities_incomplete");
		const nativeSkillBaseline = resolvePinnedNativeSkillBaseline(
			options.parent.codexVersion ?? "",
		);
		const unavailableIds = new Set<string>(
			(providers.unavailableIntegrations ?? []).map((row) => row.id),
		);
		const localIntegrations = ["bridge", "discord", "linear", "github"]
			.filter((id) => !unavailableIds.has(id))
			.map((id) => ({
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
			}));
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
			browserMode: options.browserMode,
			operations: resolved.operations,
			integrations: [
				...localIntegrations,
				...providers.upstreamIntegrations,
				...(options.browserMode === "off" || unavailableIds.has("browser")
					? []
					: [
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
						]),
			],
			...(providers.unavailableIntegrations
				? { unavailableIntegrations: providers.unavailableIntegrations }
				: {}),
			nativeSkillBaseline: {
				codexVersion: nativeSkillBaseline.codexVersion,
				...(nativeSkillBaseline.origin
					? {
							origin: {
								root: nativeSkillBaseline.origin.root,
								files: [...nativeSkillBaseline.origin.files],
							},
						}
					: {}),
				sources: nativeSkillBaseline.sources.map((source) => ({
					...source,
				})),
			},
		});
		const outboundTransport = createAutomaticOutboundTransport({
			env,
			activationId: options.activationId,
			authority: options.authority,
			assertActivationCurrent: trusted.assertActivationCurrent,
			journal: options.parent.journal,
			assertCurrent: current,
			fetchImpl: options.fetchImpl,
		});
		const targetLocks = createLeadTargetLockClient({
			env,
			activationId: options.activationId,
			authority: options.authority,
			assertActivationCurrent: trusted.assertActivationCurrent,
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
			egressProbeSeen: providers.egressProbeSeen,
			assertCurrent: current,
			closeProviders: providers.close,
			outboundTransport,
			targetLocks,
			...(options.authority?.kind === "voice_session"
				? {
						voiceDenials: {
							leadName: initial.lead.agentId,
							record: (input: { requestId: string; operationId: string }) =>
								targetLocks.recordFounderDenial!(input),
						},
					}
				: {}),
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
	/** Trusted voice input; absent preserves resident isolated browser behavior. */
	browserMode?: VoiceBackgroundBrowserMode;
	env: NodeJS.ProcessEnv;
	activationId: string;
	authority?: LeadCapabilityAuthority;
	assertActivationCurrent?: ReturnType<
		typeof createLeadCapabilityContext
	>["assertActivationCurrent"];
	/** Absent only under omit_integration, where Linear is then recorded unavailable. */
	linearToken?: string;
	context7ApiKey?: string;
	/**
	 * Trusted launcher choice (plan v12 §14.1). Absent = fail_closed: any provider
	 * failure fails the activation (resident, unchanged). omit_integration: an
	 * optional integration that cannot start is left out with a recorded reason.
	 */
	integrationFailurePolicy?: "fail_closed" | "omit_integration";
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
 * Under omit_integration an optional integration that cannot start is recorded
 * unavailable (with its group's operations) and the others stay up (plan v12 §14.1).
 */
export async function startLeadRuntimeProviders(
	options: LeadRuntimeProviderOptions,
) {
	const env = Object.freeze({ ...options.env });
	const { authority, trusted } = resolveLeadCapabilityRuntimeAuthority({
		...options,
		env,
	});
	const omitMode = options.integrationFailurePolicy === "omit_integration";
	const unavailable = new Map<
		OptionalIntegrationId,
		IntegrationUnavailableReason
	>();
	const omitted = new Set<string>();
	const markUnavailable = (
		id: OptionalIntegrationId,
		reason: IntegrationUnavailableReason,
		operationIds: Iterable<string>,
	) => {
		unavailable.set(id, reason);
		for (const operationId of operationIds) omitted.add(operationId);
	};
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
	/** fail_closed rethrows; omit_integration records the integration and continues. */
	const optional = async <T>(
		id: OptionalIntegrationId,
		start: () => T | Promise<T>,
		operationIds: () => Iterable<string>,
		reason: (error: unknown) => IntegrationUnavailableReason = (error) =>
			integrationUnavailableReason(error),
	): Promise<T | undefined> => {
		if (!omitMode) return start();
		try {
			return await start();
		} catch (error) {
			// A revoked activation is never an unavailable integration.
			current();
			markUnavailable(id, reason(error), operationIds());
			return undefined;
		}
	};
	try {
		current();
		let githubToken: string | undefined;
		let githubCredentialMissing = false;
		try {
			githubToken = resolveLeadGithubToken(env);
		} catch (error) {
			if (!omitMode) throw error;
			githubCredentialMissing = true;
		}
		if (!omitMode && !options.linearToken)
			throw new Error("runtime_linear_unavailable");
		const linearToken = options.linearToken || undefined;
		const secrets = Object.freeze([
			...new Set([
				...options.secrets,
				...(githubToken ? [githubToken] : []),
				...(linearToken ? [linearToken] : []),
				...(env.FLYWHEEL_API_TOKEN ? [env.FLYWHEEL_API_TOKEN] : []),
				...(options.context7ApiKey ? [options.context7ApiKey] : []),
			]),
		]);
		const common = {
			env,
			activationId: options.activationId,
			authority,
			assertActivationCurrent: trusted.assertActivationCurrent,
			fetchImpl: options.fetchImpl,
			secrets,
		};
		let authorityClient: ReturnType<
			typeof createParentXhsAuthorityClient
		> | null = null;
		try {
			authorityClient = createParentXhsAuthorityClient({
				policyPath: "/Library/Application Support/Flywheel/Xhs/policy.json",
				env,
				activationId: options.activationId,
			});
		} catch {
			// Absent or unverifiable root policy leaves all six writes denied.
			// A disabled write gate still permits authority read transport; writes
			// remain gated by the authority's preparation/execution checks.
		}
		const writeHandlers = new Map(createUpstreamWriteDenials(common));
		for (const [id, handler] of createXhsWriteHandlers({
			...common,
			client: authorityClient,
		}))
			writeHandlers.set(id, handler);
		// Groups that use the GitHub client require "github" (read provider and
		// patrol snapshots alike); without it both are left out together.
		const githubGroups = (
			client: ReturnType<typeof createLeadGithubClient>["client"],
		) => [
			createGithubReadProviderHandlers({ ...common, client }),
			createPatrolHandlers({
				...common,
				artifacts: options.artifacts,
				githubClient: client,
			}),
		];
		const githubOperations = () =>
			githubGroups(unavailableDependency()).flatMap((group) => [
				...group.keys(),
			]);
		if (githubCredentialMissing)
			markUnavailable("github", "credential_missing", githubOperations());
		const github =
			githubToken === undefined
				? undefined
				: await optional(
						"github",
						() =>
							createLeadGithubClient({
								token: githubToken,
								fetchImpl: options.fetchImpl,
							}),
						githubOperations,
					);
		if (github) cleanup.push(github.close);
		const linearOperations = () =>
			createLinearProviderHandlers({
				...common,
				client: unavailableDependency(),
			}).keys();
		const linear = linearToken
			? await optional(
					"linear",
					() =>
						createLinearProviderSession({
							...common,
							token: linearToken,
						}),
					linearOperations,
				)
			: undefined;
		if (!linearToken)
			markUnavailable("linear", "credential_missing", linearOperations());
		if (linear) cleanup.push(linear.close);
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
		// Every handler group declares the optional integrations it requires and is
		// assembled only after all providers started, in this fixed order (the
		// resident fail_closed assembly order, so its manifest bytes are unchanged).
		const slots: Array<{
			requires: readonly OptionalIntegrationId[];
			handlers: ReadonlyMap<string, LeadOperationHandler>;
		}> = [];
		const slot = (
			handlers: ReadonlyMap<string, LeadOperationHandler>,
			...requires: OptionalIntegrationId[]
		) => slots.push({ requires, handlers });
		/** Upstream writes and denials belong to the integration they write to. */
		const writesFor = (consumer: "xiaohongshu-mcp" | "other") =>
			new Map(
				[...writeHandlers].filter(([id]) => {
					const owner = LEAD_CAPABILITY_CATALOG.find(
						(row) => row.operationId === id,
					)?.credentialConsumer;
					return consumer === "other"
						? owner !== "xiaohongshu-mcp"
						: owner === consumer;
				}),
			);
		const [githubRead, patrol] = github ? githubGroups(github.client) : [];
		slot(createRunnerBridgeHandlers(common));
		slot(createBridgeReadHandlers(common));
		slot(createMemoryBridgeHandlers(common));
		slot(createBridgeDiscordHandlers(common));
		slot(createBridgeVoiceHandlers(common));
		slot(
			createBridgeAttachmentHandlers({ ...common, store: options.artifacts }),
		);
		if (githubRead) slot(githubRead, "github");
		slot(createGithubBridgeHandlers(common), "github");
		slot(createTerminalInputHandlers(common));
		slot(createInboxBatchAckHandlers(common));
		slot(createInboxEventAckHandlers(common));
		if (patrol) slot(patrol, "github");
		slot(createReportPublishHandlers({ ...common, store: options.artifacts }));
		slot(createReportDeliverHandlers(common));
		slot(createReportVerifyHandlers(common));
		if (linear) slot(linear.handlers, "linear");
		slot(writesFor("other"));
		slot(writesFor("xiaohongshu-mcp"), "xiaohongshu-mcp");
		slot(
			createXhsWriteManagementHandlers({
				...common,
				client: authorityClient,
				artifacts: options.artifacts,
			}),
			"xiaohongshu-mcp",
		);
		current();
		const upstreamReads = (serverId: "xiaohongshu-mcp") =>
			UPSTREAM_TOOL_ROWS.filter(
				(row) => row.serverId === serverId && row.classification === "read",
			).map((row) => row.operationId);
		const xhsAuthorityReads = () =>
			createXhsAuthorityReadHandlers({
				...common,
				client: authorityClient,
			});
		const xiaohongshu = await optional(
			"xiaohongshu-mcp",
			() =>
				startXiaohongshuProvider({
					...common,
					artifacts: options.artifacts,
				}),
			() => [
				...upstreamReads("xiaohongshu-mcp"),
				...xhsAuthorityReads().keys(),
			],
		);
		if (xiaohongshu) {
			cleanup.push(xiaohongshu.close);
			const xhsReads = new Map(xiaohongshu.handlers);
			for (const [id, handler] of xhsAuthorityReads())
				xhsReads.set(id, handler);
			slot(xhsReads, "xiaohongshu-mcp");
		}
		current();
		const context7 = await optional(
			"context7",
			() =>
				startContext7Provider({
					...common,
					apiKey: options.context7ApiKey,
				}),
			() =>
				createContext7Handlers({
					...common,
					client: unavailableDependency(),
				}).keys(),
		);
		if (context7) {
			cleanup.push(context7.close);
			slot(context7.handlers, "context7");
		}
		current();
		const browser =
			options.browserMode === "off"
				? await (async () => {
						const proxy = await startBrowserEgressProxy({
							policy: options.browser.egress,
							assertCurrent: current,
						});
						return {
							generation: undefined,
							proxyPort: proxy.port,
							egressProbeSeen: proxy.probeSeen,
							close: () => proxy.close(),
							handlers: new Map<string, LeadOperationHandler>(),
						};
					})()
				: await startBrowserProvider({
						...options.browser,
						mode: options.browserMode ?? "isolated",
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
						const browserOperations = LEAD_CAPABILITY_CATALOG.filter(
							(row) => row.credentialConsumer === "browser",
						);
						if (omitMode) {
							// Voice: the browser is absent (as with off), not a denying facade.
							markUnavailable(
								"browser",
								"provider_start_failed",
								browserOperations.map((row) => row.operationId),
							);
							return {
								generation: undefined,
								proxyPort: proxy.port,
								egressProbeSeen: proxy.probeSeen,
								close: () => proxy.close(),
								handlers: new Map<string, LeadOperationHandler>(),
							};
						}
						return {
							generation: randomUUID(),
							proxyPort: proxy.port,
							egressProbeSeen: proxy.probeSeen,
							close: () => proxy.close(),
							handlers: new Map<string, LeadOperationHandler>(
								browserOperations.map((row) => [
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
		slot(browser.handlers, "browser");
		current();
		for (const group of slots) {
			if (group.requires.some((id) => unavailable.has(id)))
				for (const id of group.handlers.keys()) omitted.add(id);
			else add(group.handlers);
		}
		// Whatever belongs to an unavailable integration is omitted as a whole; a
		// group that forgot to declare it now fails the coverage check below.
		for (const row of LEAD_CAPABILITY_CATALOG)
			if (unavailable.has(row.credentialConsumer as OptionalIntegrationId))
				omitted.add(row.operationId);
		assertRuntimeHandlerCoverage({
			handlers,
			omitted,
			browserMode: options.browserMode,
		});
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
			/** The model's egress proxy answers the isolation chain probe (FLY-2886). */
			egressProbeSeen: browser.egressProbeSeen,
			integrationIds: (
				[
					"bridge",
					"discord",
					"linear",
					"github",
					"xiaohongshu-mcp",
					"context7",
					...(options.browserMode === "off" ? [] : ["browser"]),
				] as const
			).filter((id) => !unavailable.has(id as OptionalIntegrationId)),
			upstreamIntegrations: [xiaohongshu, context7].flatMap((provider) =>
				provider ? [provider.integration] : [],
			),
			/** Present only under omit_integration; sorted by id. */
			unavailableIntegrations: omitMode
				? [...unavailable]
						.map(([id, reason]) => ({ id, reason }))
						.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
				: undefined,
			omittedOperationIds: omitted as ReadonlySet<string>,
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
