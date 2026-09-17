import type { loadAuthorityConfig } from "./authority-config.js";
import { createAuthorityHandlers } from "./authority-handlers.js";
import { startAuthorityWorkers } from "./authority-workers.js";
import { startInheritedAuthorityListeners } from "./inherited-listeners.js";
import { XhsProviderClient } from "./provider-client.js";
import { startGuardedProviderProcess } from "./provider-process.js";
import { waitForGuardedProvider } from "./provider-readiness.js";

type HandlerOptions = Parameters<typeof createAuthorityHandlers>[0];
type WorkerOptions = Parameters<typeof startAuthorityWorkers>[0];
/** Owns the supplied private ledger/key after invocation. The entrypoint must
 * first load root policy, private credentials and source/media adapters.
 * No provisioning or request-controlled configuration belongs in this layer. */
export async function startAuthorityService(options: {
	config: Awaited<ReturnType<typeof loadAuthorityConfig>>;
	store: HandlerOptions["store"];
	key: Buffer;
	artifacts: HandlerOptions["artifacts"];
	transport: HandlerOptions["transport"];
	attachmentLimit: HandlerOptions["attachmentLimit"];
	assertCurrent: () => void;
	observers: WorkerOptions["observers"];
	notifications: WorkerOptions["notifications"];
}): Promise<{ close(): Promise<void>; closed: Promise<void> }> {
	const config = structuredClone(options.config);
	let provider:
		| Awaited<ReturnType<typeof startGuardedProviderProcess>>
		| undefined;
	let handlers: ReturnType<typeof createAuthorityHandlers> | undefined;
	let listeners:
		| Awaited<ReturnType<typeof startInheritedAuthorityListeners>>
		| undefined;
	let workers: ReturnType<typeof startAuthorityWorkers> | undefined;
	let closing: Promise<void> | undefined;
	let providerExited = false;
	let started = false;
	let resolveClosed!: () => void;
	let rejectClosed!: (error: Error) => void;
	const closed = new Promise<void>((resolve, reject) => {
		resolveClosed = resolve;
		rejectClosed = reject;
	});
	void closed.catch(() => {});
	const current = () => {
		if (closing || providerExited) throw Error("authority_service_unavailable");
		options.assertCurrent();
	};
	const close = (failure?: string): Promise<void> => {
		if (closing) return closing;
		closing = (async () => {
			handlers?.close();
			const drains = await Promise.allSettled([
				Promise.resolve().then(() => listeners?.close()),
				Promise.resolve().then(() => workers?.close()),
			]);
			let stopped = true;
			try {
				await provider?.stop();
			} catch {
				stopped = false;
			}
			if (!stopped || drains.some((result) => result.status === "rejected"))
				throw Error("authority_cleanup_unconfirmed");
			options.store.close();
			options.key.fill(0);
		})();
		void closing.then(
			() => (failure ? rejectClosed(Error(failure)) : resolveClosed()),
			() => rejectClosed(Error("authority_cleanup_unconfirmed")),
		);
		return closing;
	};
	try {
		current();
		const client = new XhsProviderClient({
			socketPath: config.provider.providerSocket,
			providerUid: config.serviceUid,
			peerHelper: config.peerHelper,
		});
		provider = await startGuardedProviderProcess({
			serviceUid: config.serviceUid,
			serviceGid: config.serviceGid,
			providerBinary: config.provider.providerBinary,
			providerConfig: config.providerConfig,
		});
		const exited = () => {
			providerExited = true;
			if (started && !closing)
				void close("authority_provider_exited").catch(() => {});
		};
		void provider.exited.then(exited, exited);
		await waitForGuardedProvider({
			exited: provider.exited,
			expected: config.provider,
			client,
		});
		current();
		handlers = createAuthorityHandlers({
			config,
			store: options.store,
			key: options.key,
			provider: client,
			artifacts: options.artifacts,
			transport: options.transport,
			attachmentLimit: options.attachmentLimit,
			assertCurrent: current,
		});
		listeners = await startInheritedAuthorityListeners({
			launcher: config.launcher,
			ingressPath: config.ingressSocket,
			authorityPath: config.authoritySocket,
			ingress: handlers.ingress,
			authority: handlers.authority,
		});
		current();
		workers = startAuthorityWorkers({
			observers: options.observers,
			notifications: options.notifications,
		});
		started = true;
		return { close: () => close(), closed };
	} catch {
		await close("authority_service_unavailable");
		throw Error("authority_service_unavailable");
	}
}
