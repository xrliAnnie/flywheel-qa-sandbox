import { describe, expect, it, vi } from "vitest";
import { RoundtableThreadDiscovery } from "../RoundtableThreadDiscovery.js";
import { RoundtableThreadRegistry } from "../RoundtableThreadRegistry.js";

const GUILD = "guild-1";
const RT = "roundtable-parent";
const BOT = "bot-self";

function fakeSource() {
	const added: string[] = [];
	const removed: string[] = [];
	return {
		added,
		removed,
		isSubscribed: (id: string) => added.includes(id) && !removed.includes(id),
		addChannel: vi.fn(async (id: string) => {
			added.push(id);
		}),
		removeChannel: vi.fn((id: string) => {
			removed.push(id);
		}),
	};
}

function fetchReturning(body: unknown, status = 200): typeof fetch {
	return vi.fn(async () => ({
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	})) as unknown as typeof fetch;
}

function make(
	body: unknown,
	over: Partial<
		ConstructorParameters<typeof RoundtableThreadDiscovery>[0]
	> = {},
) {
	const registry = new RoundtableThreadRegistry();
	const source = fakeSource();
	const disc = new RoundtableThreadDiscovery({
		guildId: GUILD,
		roundtableChannelId: RT,
		botUserId: BOT,
		botToken: "tok",
		registry,
		source,
		removeThread: async (id) => {
			source.removeChannel(id);
			return registry.remove(id);
		},
		fetchImpl: fetchReturning(body),
		setTimer: () => ({ cancel: () => {} }),
		logger: { warn: () => {} },
		...over,
	});
	return { registry, source, disc };
}

describe("RoundtableThreadDiscovery durable-only reconcile", () => {
	it("never mints subscriptions from Discord membership", async () => {
		const { registry, source, disc } = make({
			threads: [{ id: "t1", parent_id: RT }],
			members: [{ id: "t1" }],
		});
		await disc.reconcileOnce();
		expect(registry.has("t1")).toBe(false);
		expect(source.added).toEqual([]);
	});
	it("repairs missing polling slots only for existing subscriptions", async () => {
		const { registry, source, disc } = make({
			threads: [{ id: "t1", parent_id: RT }],
			members: [{ id: "t1" }],
		});
		registry.add("t1");
		await disc.reconcileOnce();
		expect(source.added).toEqual(["t1"]);
		await disc.reconcileOnce();
		expect(source.added).toEqual(["t1"]);
	});
	it("removes archived entries through the durable mutation callback", async () => {
		const registry = new RoundtableThreadRegistry();
		registry.add("t1");
		const removeThread = vi.fn(async (id: string) => registry.remove(id));
		const { disc } = make(
			{ threads: [], members: [] },
			{ registry, removeThread },
		);
		await disc.reconcileOnce();
		expect(removeThread).toHaveBeenCalledWith("t1", "archived");
		expect(registry.has("t1")).toBe(false);
	});
	it("does not resurrect expired or unsubscribed entries", async () => {
		const registry = new RoundtableThreadRegistry({ ttlMs: 1, now: () => 100 });
		registry.add({ threadId: "t1", expiresAt: new Date(99).toISOString() });
		const { source, disc } = make(
			{ threads: [{ id: "t1", parent_id: RT }], members: [{ id: "t1" }] },
			{ registry },
		);
		await disc.reconcileOnce();
		registry.remove("t1");
		await disc.reconcileOnce();
		expect(source.added).toEqual([]);
	});
	it("does not throw on a fetch failure", async () => {
		const { disc } = make({}, { fetchImpl: fetchReturning({}, 503) });
		await expect(disc.reconcileOnce()).resolves.toBeUndefined();
	});
});
