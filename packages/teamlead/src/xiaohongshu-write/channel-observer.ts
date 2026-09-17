import { canonical } from "./canonical.js";
import { XhsFounderInbox } from "./founder-inbox.js";
import type { FounderSource, ObserverPolicy } from "./observer.js";
import { XhsMessagePagination } from "./pagination.js";
import type { XhsWriteStore } from "./store.js";

/** One cursor per channel, not per project: commit it only after every eligible
 * scope handled the message. Each inbox retains independent founder validation. */
export function createChannelFounderObserver(options: {
	store: XhsWriteStore;
	source: FounderSource & {
		listMessageIdsBefore(before: string | null): Promise<string[]>;
	};
	scopes: readonly { policy: () => ObserverPolicy; initialCursor: string }[];
	now?: () => number;
	signal?: AbortSignal;
}): XhsMessagePagination {
	if (!options.scopes.length || options.scopes.length > 64)
		throw Error("observer_scope_invalid");
	const scopes = options.scopes.map((entry) => ({
		...entry,
		initial: structuredClone(entry.policy()),
	}));
	const channelId = scopes[0]!.initial.channelId,
		guildId = scopes[0]!.initial.guildId;
	const keys = new Set<string>();
	for (const entry of scopes) {
		const key = JSON.stringify([
			entry.initial.requesterUid,
			entry.initial.projectId,
			entry.initial.leadId,
		]);
		if (
			keys.has(key) ||
			entry.initial.channelId !== channelId ||
			entry.initial.guildId !== guildId ||
			!/^[1-9][0-9]{16,19}$/.test(entry.initialCursor)
		)
			throw Error("observer_scope_invalid");
		keys.add(key);
	}
	const check = () => {
		if (options.signal?.aborted) throw Error("observer_stopped");
		if (
			scopes.some(
				(entry) => canonical(entry.policy()) !== canonical(entry.initial),
			)
		)
			throw Error("founder_policy_changed");
	};
	const inboxes = scopes.map(
		(entry) =>
			new XhsFounderInbox(
				options.store,
				options.source,
				entry.policy,
				options.now,
			),
	);
	const initialCursor = scopes.reduce(
		(min, entry) =>
			BigInt(entry.initialCursor) < BigInt(min) ? entry.initialCursor : min,
		scopes[0]!.initialCursor,
	);
	return new XhsMessagePagination(
		options.store,
		channelId,
		initialCursor,
		async (before) => {
			check();
			const ids = await options.source.listMessageIdsBefore(before);
			check();
			return ids;
		},
		async (messageId) => {
			check();
			for (let i = 0; i < scopes.length; i++) {
				if (BigInt(messageId) > BigInt(scopes[i]!.initialCursor))
					await inboxes[i]!.process(messageId);
				check();
			}
		},
	);
}
