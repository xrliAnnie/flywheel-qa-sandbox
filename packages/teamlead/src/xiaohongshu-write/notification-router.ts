import type { AuthorityConfig } from "./authority-config.js";
import type { FounderNotificationTransport } from "./notification-worker.js";
import type { XhsWriteStore } from "./store.js";

type Route = Pick<
	AuthorityConfig["registry"][number],
	"projectId" | "leadId" | "guildId" | "channelId"
>;
/** Private lifecycle adapter. The notification ID selects a ledger record; it
 * never selects an arbitrary destination. Root policy and original card agree. */
export function createFounderNotificationRouter(options: {
	store: Pick<XhsWriteStore, "pendingFounderNotifications" | "approvalRecord">;
	registry: readonly Route[];
	source: (channelId: string) => FounderNotificationTransport;
}): FounderNotificationTransport {
	const registry = structuredClone(options.registry);
	const scopes = new Set<string>();
	for (const entry of registry) {
		const scope = JSON.stringify([entry.projectId, entry.leadId]);
		if (
			scopes.has(scope) ||
			!entry.projectId ||
			!entry.leadId ||
			!/^[1-9][0-9]{16,19}$/.test(entry.guildId) ||
			!/^[1-9][0-9]{16,19}$/.test(entry.channelId)
		)
			throw Error("notification_route_unavailable");
		scopes.add(scope);
	}
	const sources = new Map<string, FounderNotificationTransport>();
	return {
		async notify(eventId, content) {
			const notice = options.store
				.pendingFounderNotifications()
				.find((item) => item.eventId === eventId);
			if (!notice) throw Error("notification_route_unavailable");
			const entry = registry.find(
				(entry) =>
					entry.projectId === notice.projectId &&
					entry.leadId === notice.leadId,
			);
			const card = options.store.approvalRecord(notice.proposalId);
			if (
				!entry ||
				!card ||
				card.contentDigest !== notice.contentDigest ||
				card.channelId !== entry.channelId ||
				card.guildId !== entry.guildId
			)
				throw Error("notification_route_unavailable");
			let source = sources.get(entry.channelId);
			if (!source) {
				source = options.source(entry.channelId);
				sources.set(entry.channelId, source);
			}
			await source.notify(eventId, content);
		},
	};
}
