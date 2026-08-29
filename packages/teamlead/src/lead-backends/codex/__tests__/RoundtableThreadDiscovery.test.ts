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
		fetchImpl: fetchReturning(body),
		setTimer: () => ({ cancel: () => {} }),
		logger: { warn: () => {} },
		...over,
	});
	return { registry, source, disc };
}

describe("RoundtableThreadDiscovery.reconcileOnce", () => {
	it("subscribes roundtable threads the bot has joined; ignores others", async () => {
		const { registry, source, disc } = make({
			threads: [
				{ id: "t1", parent_id: RT }, // roundtable + joined → subscribe
				{ id: "t2", parent_id: "other-channel" }, // wrong parent → ignore
				{ id: "t3", parent_id: RT }, // roundtable but NOT joined → ignore
			],
			members: [{ id: "t1", user_id: BOT }],
		});
		await disc.reconcileOnce();
		expect(registry.has("t1")).toBe(true);
		expect(registry.has("t2")).toBe(false);
		expect(registry.has("t3")).toBe(false);
		expect(source.added).toEqual(["t1"]);
	});

	it("treats a member object without user_id as joined (Codex R2#3)", async () => {
		const { registry, disc } = make({
			threads: [{ id: "t1", parent_id: RT }],
			members: [{ id: "t1" }], // no user_id
		});
		await disc.reconcileOnce();
		expect(registry.has("t1")).toBe(true);
	});

	it("drops a thread that is no longer active (archived)", async () => {
		const registry = new RoundtableThreadRegistry();
		registry.add("gone");
		const source = fakeSource();
		const disc = new RoundtableThreadDiscovery({
			guildId: GUILD,
			roundtableChannelId: RT,
			botUserId: BOT,
			botToken: "tok",
			registry,
			source,
			fetchImpl: fetchReturning({ threads: [], members: [] }),
			setTimer: () => ({ cancel: () => {} }),
			logger: { warn: () => {} },
		});
		await disc.reconcileOnce();
		expect(registry.has("gone")).toBe(false);
		expect(source.removed).toContain("gone");
	});

	it("enforces the cap by evicting the oldest (keeps cursor via removeChannel)", async () => {
		const { registry, source, disc } = make(
			{
				threads: [
					{ id: "a", parent_id: RT },
					{ id: "b", parent_id: RT },
					{ id: "c", parent_id: RT },
				],
				members: [{ id: "a" }, { id: "b" }, { id: "c" }],
			},
			{ cap: 2 },
		);
		await disc.reconcileOnce();
		expect(registry.size).toBe(2);
		expect(registry.has("a")).toBe(false); // oldest evicted
		expect(source.removed).toContain("a");
	});

	it("does not throw on a fetch failure", async () => {
		const { disc } = make({}, { fetchImpl: fetchReturning({}, 503) });
		await expect(disc.reconcileOnce()).resolves.toBeUndefined();
	});
});

describe("RoundtableThreadDiscovery.subscribe (immediate, path i)", () => {
	it("subscribes a thread immediately + idempotent", async () => {
		const { registry, source, disc } = make({ threads: [], members: [] });
		await disc.subscribe("t9");
		expect(registry.has("t9")).toBe(true);
		expect(source.added).toEqual(["t9"]);
		await disc.subscribe("t9"); // idempotent
		expect(source.added).toEqual(["t9"]);
	});
});
