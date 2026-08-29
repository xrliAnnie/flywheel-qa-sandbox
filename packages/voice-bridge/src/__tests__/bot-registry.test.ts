/**
 * FLY-545 P5 — BotRegistry: N lightweight gateway clients in one process
 * (orchestrator + ears + per-Lead bots; one Client per token).
 *
 * The FIRST PITFALL from the FLY-960 spike is codified here: joinVoiceChannel
 * BEFORE clientReady silently wedges in signalling — so start() gates on
 * clientReady for every bot, and join() is only reachable after start().
 */
import { describe, expect, it } from "vitest";
import { BotRegistry, type VoiceJoinOpts } from "../bots/BotRegistry.js";

class FakeClient {
	loggedInWith: string | null = null;
	ready = false;
	destroyed = false;
	private readyCbs: (() => void)[] = [];
	loginError: Error | null = null;
	async login(token: string): Promise<string> {
		if (this.loginError) throw this.loginError;
		this.loggedInWith = token;
		return token;
	}
	isReady(): boolean {
		return this.ready;
	}
	once(_event: "clientReady", cb: () => void): void {
		this.readyCbs.push(cb);
	}
	fireReady(): void {
		this.ready = true;
		for (const cb of this.readyCbs.splice(0)) cb();
	}
	destroy(): void {
		this.destroyed = true;
	}
}

function makeRig() {
	const clients: FakeClient[] = [];
	const joins: { client: FakeClient; opts: VoiceJoinOpts }[] = [];
	const registry = new BotRegistry<FakeClient, { conn: true }>({
		createClient: () => {
			const c = new FakeClient();
			clients.push(c);
			return c;
		},
		joinVoice: async (client, opts) => {
			joins.push({ client, opts });
			return { conn: true };
		},
	});
	return { registry, clients, joins };
}

describe("start", () => {
	it("logs in every bot and waits for clientReady on each", async () => {
		const rig = makeRig();
		let started = false;
		const p = rig.registry
			.start([
				{ id: "orch", token: "t-orch" },
				{ id: "ears", token: "t-ears" },
			])
			.then(() => {
				started = true;
			});
		await new Promise((r) => setTimeout(r, 0));
		expect(rig.clients.map((c) => c.loggedInWith)).toEqual([
			"t-orch",
			"t-ears",
		]);
		expect(started).toBe(false); // clientReady gate holds
		rig.clients[0]!.fireReady();
		await new Promise((r) => setTimeout(r, 0));
		expect(started).toBe(false); // still waiting on the second bot
		rig.clients[1]!.fireReady();
		await p;
		expect(started).toBe(true);
	});

	it("short-circuits a client that is already ready", async () => {
		const rig = makeRig();
		const p = rig.registry.start([{ id: "orch", token: "t" }]);
		rig.clients[0]!.fireReady();
		await p;
	});

	it("surfaces a login failure with the bot id (never silent)", async () => {
		const client = new FakeClient();
		client.loginError = new Error("401 unauthorized");
		const registry = new BotRegistry<FakeClient, unknown>({
			createClient: () => client,
			joinVoice: async () => ({}),
		});
		await expect(
			registry.start([{ id: "ears", token: "bad" }]),
		).rejects.toThrow(/ears.*401|401.*ears/s);
	});

	it("rejects duplicate bot ids", async () => {
		const rig = makeRig();
		const p = rig.registry.start([
			{ id: "x", token: "a" },
			{ id: "x", token: "b" },
		]);
		await expect(p).rejects.toThrow(/duplicate/i);
	});
});

describe("join", () => {
	it("joins voice with the right client and opts", async () => {
		const rig = makeRig();
		const p = rig.registry.start([
			{ id: "ears", token: "t1" },
			{ id: "lead", token: "t2" },
		]);
		rig.clients[0]!.fireReady();
		rig.clients[1]!.fireReady();
		await p;
		const conn = await rig.registry.join("ears", {
			guildId: "g",
			channelId: "vc",
			selfMute: true,
			selfDeaf: false,
		});
		expect(conn).toEqual({ conn: true });
		expect(rig.joins).toHaveLength(1);
		expect(rig.joins[0]!.client).toBe(rig.clients[0]);
		expect(rig.joins[0]!.opts.selfMute).toBe(true);
	});

	it("throws for an unknown bot id", async () => {
		const rig = makeRig();
		await expect(
			rig.registry.join("ghost", {
				guildId: "g",
				channelId: "vc",
				selfMute: false,
				selfDeaf: true,
			}),
		).rejects.toThrow(/ghost/);
	});
});

describe("destroyAll", () => {
	it("destroys every client", async () => {
		const rig = makeRig();
		const p = rig.registry.start([
			{ id: "a", token: "t1" },
			{ id: "b", token: "t2" },
		]);
		rig.clients.forEach((c) => c.fireReady());
		await p;
		await rig.registry.destroyAll();
		expect(rig.clients.every((c) => c.destroyed)).toBe(true);
	});
});
