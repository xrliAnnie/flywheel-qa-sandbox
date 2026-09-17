import { createArtifactIngressHandler } from "./artifact-ingress.js";
import type { XhsFrozenArtifactStore } from "./artifacts.js";
import {
	type AttachmentLimit,
	resolveAttachmentLimit,
} from "./attachment-probe.js";
import type { AuthorityConfig } from "./authority-config.js";
import { XhsAuthorityRegistry } from "./authority-registry.js";
import { canonical } from "./canonical.js";
import { createPinnedDispatchScope } from "./dispatch-scope.js";
import { XhsWriteExecutor } from "./executor.js";
import { createWriteIngressHandler } from "./ingress.js";
import {
	loginProjectionSchema,
	loginReadOperation,
	loginStatusSchema,
} from "./login-contract.js";
import { createNotificationIngressHandler } from "./notification-ingress.js";
import { XhsWritePreparation } from "./preparation.js";
import { createProviderAuthorityHandler } from "./provider-authority.js";
import type { XhsProviderClient } from "./provider-client.js";
import { XhsReadResources } from "./read-resources.js";
import type { WriteIdentity, XhsWriteStore } from "./store.js";

type PreparationOptions = ConstructorParameters<typeof XhsWritePreparation>[0];
type Config = ConstructorParameters<typeof XhsAuthorityRegistry>[0] &
	Pick<AuthorityConfig, "enabled" | "serviceUid" | "keyId" | "peerHelper">;
/** Authority process composition. Config/secrets must come from the validated
 * root loader; target, media and token adapters remain private to this process. */
export function createAuthorityHandlers(options: {
	config: Config;
	store: XhsWriteStore;
	key: Buffer;
	assertCurrent: () => void;
	provider: Pick<
		XhsProviderClient,
		"account" | "prepare" | "commit" | "readFeeds" | "read" | "loginQR"
	>;
	artifacts: Pick<XhsFrozenArtifactStore, "read" | "import">;
	transport: PreparationOptions["transport"];
	attachmentLimit: AttachmentLimit;
	now?: () => number;
}) {
	const config = structuredClone(options.config);
	let closed = false;
	const current = () => {
		if (closed) throw Error("authority_closed");
		options.assertCurrent();
	};
	const resources = new Map<string, XhsReadResources>();
	const resource = (
		identity: WriteIdentity,
		activationId: string,
		create = false,
	) => {
		current();
		const key = canonical([
			identity.requesterUid,
			identity.projectId,
			identity.leadId,
			identity.authorityPolicyVersion,
			identity.founderConfigVersion,
			identity.providerInstanceId,
			identity.accountUserId,
			identity.accountEpoch,
			identity.providerGeneration,
			activationId,
		]);
		let value = resources.get(key);
		if (!value && create) {
			if (resources.size >= 64) {
				const oldest = resources.keys().next().value!;
				resources.get(oldest)!.close();
				resources.delete(oldest);
			}
			const pinnedIdentity = Object.freeze({ ...identity });
			value = new XhsReadResources({
				identity: pinnedIdentity,
				activationId,
				provider: options.provider,
				assertCurrent: () => {
					current();
					registry.assertAccountEpoch(pinnedIdentity);
				},
				upstream: {
					binarySha256: config.provider.providerBinary.sha256,
					toolSchemaDigest: config.provider.toolSchemaDigest,
					guardProtocol: 1,
				},
			});
			resources.set(key, value);
		} else if (value && create) {
			resources.delete(key);
			resources.set(key, value);
		}
		if (!value) throw Error("target_unbound");
		return value;
	};
	const registry = new XhsAuthorityRegistry(config, options.provider);
	const preparation = new XhsWritePreparation({
		store: options.store,
		registry,
		artifacts: options.artifacts,
		target: async (policy, handle, activationId) =>
			resource(policy, activationId).target(policy, handle, activationId),
		transport: options.transport,
		upstream: {
			binarySha256: config.provider.providerBinary.sha256,
			toolSchemaDigest: config.provider.toolSchemaDigest,
			guardProtocol: 1,
		},
		attachmentLimit: options.attachmentLimit,
		now: options.now,
	});
	const scope: Parameters<typeof createWriteIngressHandler>[0]["scope"] =
		async (peer, selection, signal, purpose = "write") => {
			current();
			signal.throwIfAborted();
			const resolve =
				purpose === "read"
					? registry.observeAccount.bind(registry)
					: registry.proveAccount.bind(registry);
			const policy = await resolve(
				peer,
				{ projectId: selection.projectId, leadId: selection.leadId },
				signal,
			);
			current();
			signal.throwIfAborted();
			const identity: WriteIdentity = {
				requesterUid: policy.requesterUid,
				projectId: policy.projectId,
				leadId: policy.leadId,
				authorityPolicyVersion: policy.authorityPolicyVersion,
				founderConfigVersion: policy.founderConfigVersion,
				providerInstanceId: policy.providerInstanceId,
				accountUserId: policy.accountUserId,
				accountEpoch: policy.accountEpoch,
				providerGeneration: policy.providerGeneration,
			};
			return { identity, activationId: selection.activationId };
		};
	const ingress = createWriteIngressHandler({
		modelUid: config.modelUid,
		peerHelper: config.peerHelper,
		store: options.store,
		now: options.now,
		readLogin: async (context, action, signal) => {
			current();
			signal.throwIfAborted();
			const operation = loginReadOperation.parse(action);
			const identity = context.identity;
			const selection = {
				projectId: identity.projectId,
				leadId: identity.leadId,
			};
			if (operation === "check_login_status") {
				const observed = await registry.observeAccount(
					identity.requesterUid,
					selection,
					signal,
				);
				current();
				signal.throwIfAborted();
				return loginStatusSchema.parse({ loggedIn: observed.loggedIn });
			}
			registry.assertAccountEpoch(identity);
			const result = await options.provider.loginQR(
				{
					account: {
						providerInstanceId: identity.providerInstanceId,
						accountUserId: identity.accountUserId,
						accountEpoch: identity.accountEpoch,
						providerGeneration: identity.providerGeneration,
					},
					upstream: {
						binarySha256: config.provider.providerBinary.sha256,
						toolSchemaDigest: config.provider.toolSchemaDigest,
						guardProtocol: 1,
					},
				},
				signal,
			);
			const observed = await registry.observeAccount(
				identity.requesterUid,
				selection,
				signal,
			);
			current();
			signal.throwIfAborted();
			if (
				observed.accountEpoch !== result.account.accountEpoch ||
				observed.accountUserId !== result.account.accountUserId ||
				observed.providerInstanceId !== result.account.providerInstanceId ||
				observed.providerGeneration !== result.account.providerGeneration ||
				observed.loggedIn !== result.loggedIn
			)
				throw Error("write_scope_unavailable");
			return loginProjectionSchema.parse({
				loggedIn: result.loggedIn,
				image: result.image,
				expiresAt: result.expiresAt,
			});
		},
		readDetail: async (context, input, signal) =>
			resource(context.identity, context.activationId).readDetail(
				input,
				signal,
			),
		readList: async (context, action, input, signal) =>
			resource(context.identity, context.activationId, true).readList(
				action,
				input,
				signal,
			),
		readFeeds: async (context, signal) =>
			resource(context.identity, context.activationId, true).readFeeds(signal),
		scope,
		preparation: {
			prepare: async (peer, input, signal) => {
				current();
				if (!config.enabled) throw Error("write_gate_closed");
				const result = await preparation.prepare(peer, input, signal);
				current();
				signal?.throwIfAborted();
				return result;
			},
		},
		executor: (context) =>
			new XhsWriteExecutor({
				store: options.store,
				provider: options.provider,
				key: options.key,
				now: options.now,
				scope: async () => {
					current();
					return config.enabled
						? { ...structuredClone(context), keyId: config.keyId }
						: null;
				},
				media: async function* (frozen, artifact, signal) {
					current();
					signal.throwIfAborted();
					const bytes = await options.artifacts.read(
						frozen.projectId,
						artifact,
					);
					current();
					signal.throwIfAborted();
					yield bytes;
				},
			}),
	});
	const dispatchScope = createPinnedDispatchScope(
		config,
		options.store,
		current,
	);
	const authority = createProviderAuthorityHandler({
		store: options.store,
		providerUid: config.serviceUid,
		peerHelper: config.peerHelper,
		scope: dispatchScope,
		token: async (context, signal) => {
			current();
			signal.throwIfAborted();
			const scope = await dispatchScope(context.frozen.proposalId, signal);
			if (!scope || scope.activationId !== context.activationId)
				throw Error("target_unbound");
			const token = resource(scope.identity, context.activationId).token(
				context,
			);
			current();
			signal.throwIfAborted();
			return token;
		},
		now: options.now,
	});
	const artifactIngress = createArtifactIngressHandler({
		modelUid: config.modelUid,
		peerHelper: config.peerHelper,
		scope,
		import: async (context, mime, stream, signal) => {
			current();
			if (!config.enabled) throw Error("write_gate_closed");
			registry.assertAccountEpoch(context.identity);
			const limit = resolveAttachmentLimit(
				options.attachmentLimit,
				context.identity,
			);
			let size = 0;
			const guarded = async function* () {
				for await (const chunk of stream) {
					current();
					signal.throwIfAborted();
					registry.assertAccountEpoch(context.identity);
					size += chunk.byteLength;
					if (size > limit) throw Error("preview_media_too_large");
					yield chunk;
				}
				current();
				signal.throwIfAborted();
				registry.assertAccountEpoch(context.identity);
			};
			const artifact = await options.artifacts.import(
				context.identity.projectId,
				mime,
				guarded(),
				(options.now ?? Date.now)(),
			);
			current();
			signal.throwIfAborted();
			registry.assertAccountEpoch(context.identity);
			if (
				artifact.sizeBytes >
				resolveAttachmentLimit(options.attachmentLimit, context.identity)
			)
				throw Error("preview_media_too_large");
			return artifact;
		},
	});
	const notificationIngress = createNotificationIngressHandler({
		modelUid: config.modelUid,
		peerHelper: config.peerHelper,
		registry: config.registry,
		store: options.store,
		assertCurrent: current,
		now: options.now,
	});
	return {
		ingress: (
			req: Parameters<typeof ingress>[0],
			res: Parameters<typeof ingress>[1],
		) =>
			req.url === "/v1/artifact/import"
				? artifactIngress(req, res)
				: req.url?.startsWith("/v1/notification/")
					? notificationIngress(req, res)
					: ingress(req, res),
		authority,
		close() {
			closed = true;
			for (const value of resources.values()) value.close();
			resources.clear();
		},
	};
}
