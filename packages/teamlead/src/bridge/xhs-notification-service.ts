import { createBridgeXhsNotificationClients } from "../xiaohongshu-write/parent-client-policy.js";
import { XhsNotificationPoller } from "./xhs-notification-poller.js";

/** Bridge lifecycle owns this non-authorizing outbox consumer. Missing policy
 * keeps it dormant; each new batch reloads trusted policy so a stale scope cannot
 * be retained after configuration changes. No private credentials are loaded. */
export function startXhsNotificationService(options: {
	enqueue: ConstructorParameters<typeof XhsNotificationPoller>[0]["enqueue"];
}) {
	const lifetime = new AbortController();
	let active: Promise<void> | undefined;
	const tick = () => {
		if (lifetime.signal.aborted || active) return;
		active = Promise.resolve()
			.then(async () => {
				lifetime.signal.throwIfAborted();
				const entries = createBridgeXhsNotificationClients(
					"/Library/Application Support/Flywheel/Xhs/policy.json",
				);
				await Promise.all(
					entries.map((entry) =>
						new XhsNotificationPoller({
							...entry,
							enqueue: options.enqueue,
						}).poll(lifetime.signal),
					),
				);
			})
			.catch(() => {
				// Missing/changed installation is expected before rollout. Retry next tick.
			})
			.finally(() => {
				active = undefined;
			});
	};
	const timer = setInterval(tick, 5000);
	timer.unref();
	tick();
	return {
		async close() {
			clearInterval(timer);
			lifetime.abort();
			await active;
		},
	};
}
