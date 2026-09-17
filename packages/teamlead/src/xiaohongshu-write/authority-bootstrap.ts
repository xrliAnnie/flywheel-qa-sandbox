import { XhsFrozenArtifactStore } from "./artifacts.js";
import { ATTACHMENT_HARD_LIMIT } from "./attachment-probe.js";
import { XhsAttachmentProbeCache } from "./attachment-probe-cache.js";
import { loadAuthorityConfig } from "./authority-config.js";
import { XhsAuthorityRegistry } from "./authority-registry.js";
import { startAuthorityService } from "./authority-service.js";
import type { ReviewTransport } from "./cards.js";
import { createChannelFounderObserver } from "./channel-observer.js";
import { createAuthorityConfigCurrent } from "./config-current.js";
import { DiscordXhsSource } from "./discord-source.js";
import { createMediaValidator } from "./media-validator.js";
import { createFounderNotificationRouter } from "./notification-router.js";
import { XhsNotificationWorker } from "./notification-worker.js";
import type { ObserverPolicy } from "./observer.js";
import { XhsProviderClient } from "./provider-client.js";
import { XhsWriteStore } from "./store.js";
import { readPrivateFile } from "./trusted-files.js";

/** Dedicated-process bootstrap only. Never creates private roots or a new ledger;
 * installation and the signed boundary receipt must already exist. */
export async function startAuthorityFromConfig(configPath: string) {
	let key: Buffer | undefined;
	let store: XhsWriteStore | undefined;
	let transferred = false;
	try {
		const config = await loadAuthorityConfig(configPath);
		const current = createAuthorityConfigCurrent(configPath, config);
		current();
		key = readPrivateFile(config.permitKeyPath, {
			root: config.stateRoot,
			uid: config.serviceUid,
			maxBytes: 32,
		});
		if (key.length !== 32) throw Error();
		const tokenBytes = readPrivateFile(config.botTokenPath, {
			root: config.stateRoot,
			uid: config.serviceUid,
			maxBytes: 4096,
		});
		let token: string;
		try {
			token = new TextDecoder("utf-8", { fatal: true }).decode(tokenBytes);
			if (!token || /[\s\0]/.test(token)) throw Error();
		} finally {
			tokenBytes.fill(0);
		}
		current();
		store = new XhsWriteStore(config.ledgerPath, {
			providerGeneration: config.provider.accountBase.providerGeneration,
		});
		const ledger = store;
		ledger.setDispatchEnabled(config.enabled, Date.now());
		const hardAttachmentLimit = ATTACHMENT_HARD_LIMIT;
		const artifacts = new XhsFrozenArtifactStore(config.artifactRoot, ledger, {
			attachmentLimit: hardAttachmentLimit,
			validate: createMediaValidator({
				scratchRoot: config.stateRoot,
				ffmpeg: config.provider.ffmpeg,
				ffprobe: config.provider.ffprobe,
			}),
		});
		const provider = new XhsProviderClient({
			socketPath: config.provider.providerSocket,
			providerUid: config.serviceUid,
			peerHelper: config.peerHelper,
		});
		const registry = new XhsAuthorityRegistry(config, provider);
		const probes = new Map<string, XhsAttachmentProbeCache>();
		const probeKey = (entry: (typeof config.registry)[number]) =>
			JSON.stringify([entry.guildId, entry.probeChannelId, entry.botId]);
		for (const entry of config.registry) {
			if (!entry.probeChannelId || probes.has(probeKey(entry))) continue;
			probes.set(
				probeKey(entry),
				new XhsAttachmentProbeCache({
					stateRoot: config.stateRoot,
					serviceUid: config.serviceUid,
					assertCurrent: current,
					policy: {
						guildId: entry.guildId,
						channelId: entry.probeChannelId,
						botId: entry.botId,
						userChannelIds: [
							...new Set(config.registry.map((item) => item.channelId)),
						],
					},
					source: new DiscordXhsSource({
						channelId: entry.probeChannelId,
						purpose: "probe",
						token,
					}),
				}),
			);
		}
		const attachmentLimit = (scope: { projectId: string; leadId: string }) => {
			current();
			const entry = config.registry.find(
				(entry) =>
					entry.projectId === scope.projectId && entry.leadId === scope.leadId,
			);
			if (!entry) throw Error("write_scope_unavailable");
			return entry.probeChannelId
				? probes.get(probeKey(entry))!.limit()
				: ATTACHMENT_HARD_LIMIT;
		};

		const sources = new Map<string, DiscordXhsSource>();
		const source = (channelId: string) => {
			current();
			if (!config.registry.some((entry) => entry.channelId === channelId))
				throw Error("founder_source_unavailable");
			let value = sources.get(channelId);
			if (!value) {
				value = new DiscordXhsSource({ channelId, token });
				sources.set(channelId, value);
			}
			return value;
		};
		const preflights = new Map<string, Promise<void>>();
		const preflight = async (entry: (typeof config.registry)[number]) => {
			current();
			const id = JSON.stringify([
				entry.channelId,
				entry.botId,
				entry.guildId,
				entry.founderId,
			]);
			let work = preflights.get(id);
			if (!work) {
				work = source(entry.channelId).preflight(entry);
				preflights.set(id, work);
				void work.catch(() => {
					preflights.delete(id);
				});
			}
			await work;
			current();
		};
		const transport = (policy: ObserverPolicy): ReviewTransport => {
			current();
			const entry = config.registry.find(
				(entry) =>
					entry.projectId === policy.projectId &&
					entry.leadId === policy.leadId,
			);
			if (
				!entry ||
				entry.channelId !== policy.channelId ||
				entry.guildId !== policy.guildId ||
				entry.botId !== policy.botId ||
				entry.founderId !== policy.founderId
			)
				throw Error("founder_source_unavailable");
			const target = source(entry.channelId);
			return {
				send: async (...args) => {
					await preflight(entry);
					return target.send(...args);
				},
				fetch: (...args) => {
					current();
					return target.fetch(...args);
				},
				readAttachment: (...args) => {
					current();
					return target.readAttachment(...args);
				},
				remove: (...args) => {
					current();
					return target.remove(...args);
				},
			};
		};
		const notifications = new XhsNotificationWorker(
			ledger,
			createFounderNotificationRouter({
				store: ledger,
				registry: config.registry,
				source,
			}),
		);
		const channels = [
			...new Set(config.registry.map((entry) => entry.channelId)),
		];
		current();
		transferred = true;
		return await startAuthorityService({
			config,
			store: ledger,
			key,
			artifacts,
			attachmentLimit,
			transport,
			assertCurrent: current,
			notifications,
			observers: (signal) => [
				...channels.map((channelId) => ({
					async poll() {
						signal.throwIfAborted();
						current();
						const entries = config.registry.filter(
							(entry) => entry.channelId === channelId,
						);
						const scopes = [];
						for (const entry of entries) {
							await preflight(entry);
							const {
								loggedIn: _,
								initialCursor,
								...policy
							} = await registry.observeAccount(
								config.modelUid,
								{ projectId: entry.projectId, leadId: entry.leadId },
								signal,
							);
							scopes.push({
								initialCursor,
								policy: () => {
									current();
									signal.throwIfAborted();
									return policy;
								},
							});
						}
						signal.throwIfAborted();
						current();
						await createChannelFounderObserver({
							store: ledger,
							source: source(channelId),
							scopes,
							signal,
						}).poll();
					},
				})),
				...probes.values(),
			],
		});
	} catch {
		if (!transferred) {
			store?.close();
			key?.fill(0);
		}
		throw Error("authority_startup_unavailable");
	}
}
