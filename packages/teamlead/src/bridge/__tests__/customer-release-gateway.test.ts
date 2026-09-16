import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { ReleaseInteractionGateway } from "../customer-release/interaction-gateway.js";

class Socket extends EventEmitter {
	sent: object[] = [];
	readyState = 1;
	send(value: string) {
		this.sent.push(JSON.parse(value));
	}
	close() {
		this.readyState = 3;
	}
	frame(value: unknown) {
		this.emit("message", Buffer.from(JSON.stringify(value)), false);
	}
}
const applicationId = "123456789012345678",
	botUserId = "223456789012345678",
	founderId = "323456789012345678",
	guildId = "423456789012345678",
	channelId = "523456789012345678";
afterEach(() => vi.useRealTimers());
function fixture() {
	vi.useFakeTimers();
	const socket = new Socket();
	const calls: string[] = [];
	const invalidate = vi.fn();
	const commit = vi.fn(() => {
		calls.push("commit");
		return "已拦下";
	});
	const fetcher = vi.fn(
		async (url: string | URL | Request, init?: RequestInit) => {
			const path = new URL(String(url)).pathname;
			if (path.endsWith("/callback")) {
				calls.push("ack");
				return new Response(null, { status: 204 });
			}
			expect(new Headers(init?.headers).get("authorization")).toBe(
				"Bot fixture-token",
			);
			return Response.json(
				path.endsWith("/users/@me")
					? { id: botUserId, bot: true }
					: path.endsWith("/applications/@me")
						? { id: applicationId, interactions_endpoint_url: null }
						: {
								url: "wss://gateway.discord.gg",
								session_start_limit: { remaining: 1, reset_after: 60000 },
							},
			);
		},
	);
	const gateway = new ReleaseInteractionGateway({
		applicationId,
		botUserId,
		guildId,
		channelId,
		token: "fixture-token",
		founderId: () => founderId,
		epoch: () => 1,
		commit,
		invalidate,
		fetch: fetcher as typeof fetch,
		socket: () => socket as never,
	});
	const ready = async () => {
		await gateway.start();
		socket.frame({ op: 10, d: { heartbeat_interval: 1000 } });
		socket.frame({
			op: 0,
			s: 1,
			t: "READY",
			d: {
				user: { id: botUserId, bot: true },
				application: { id: applicationId },
			},
		});
		socket.frame({ op: 11, d: null });
	};
	const interaction = () => ({
		id: "623456789012345678",
		type: 3,
		version: 1,
		application_id: applicationId,
		guild_id: guildId,
		channel_id: channelId,
		token: "reply-token",
		member: { user: { id: founderId, bot: false } },
		data: { component_type: 2, custom_id: `fwrel:veto:1:${"a".repeat(32)}` },
		message: {
			id: "723456789012345678",
			author: { id: botUserId, bot: true },
			content: "frozen card",
			components: [],
		},
	});
	return {
		gateway,
		socket,
		ready,
		interaction,
		invalidate,
		commit,
		calls,
		fetcher,
	};
}
it("authenticated READY+heartbeat are required, action commits before ack and token never reaches commit", async () => {
	const f = fixture();
	await f.ready();
	expect(f.gateway.healthy()).toBe(true);
	f.socket.frame({ op: 0, s: 2, t: "INTERACTION_CREATE", d: f.interaction() });
	await Promise.resolve();
	expect(f.calls).toEqual(["commit", "ack"]);
	expect(JSON.stringify(f.commit.mock.calls)).not.toContain("reply-token");
	f.gateway.stop();
});
it("wrong founder/app/guild/bot/epoch never enters the durable action handler", async () => {
	for (const key of ["founder", "application", "guild", "author", "epoch"]) {
		const f = fixture();
		await f.ready();
		const data = f.interaction();
		if (key === "founder") data.member.user.id = botUserId;
		if (key === "application") data.application_id = botUserId;
		if (key === "guild") data.guild_id = botUserId;
		if (key === "author") data.message.author.id = founderId;
		if (key === "epoch") data.data.custom_id = `fwrel:veto:2:${"a".repeat(32)}`;
		f.socket.frame({ op: 0, s: 2, t: "INTERACTION_CREATE", d: data });
		expect(f.commit).not.toHaveBeenCalled();
		expect(f.gateway.healthy()).toBe(true);
		f.gateway.stop();
	}
});
it("sequence gap, heartbeat timeout and socket close synchronously invalidate release health", async () => {
	for (const fault of ["gap", "heartbeat", "close"]) {
		const f = fixture();
		await f.ready();
		if (fault === "gap")
			f.socket.frame({
				op: 0,
				s: 3,
				t: "INTERACTION_CREATE",
				d: f.interaction(),
			});
		if (fault === "heartbeat") await vi.advanceTimersByTimeAsync(2000);
		if (fault === "close") f.socket.emit("close");
		expect(f.gateway.healthy()).toBe(false);
		expect(f.invalidate).toHaveBeenCalled();
		expect(f.commit).not.toHaveBeenCalled();
		f.gateway.stop();
	}
});
it("failed database commit cannot produce a success acknowledgment", async () => {
	const f = fixture();
	await f.ready();
	f.commit.mockImplementation(() => {
		throw new Error("db failed");
	});
	f.socket.frame({ op: 0, s: 2, t: "INTERACTION_CREATE", d: f.interaction() });
	await Promise.resolve();
	expect(f.calls).not.toContain("ack");
	expect(f.gateway.healthy()).toBe(false);
	f.gateway.stop();
});

it("duplicate delivery repeats the idempotent transaction hook but sends only one callback", async () => {
	const f = fixture();
	await f.ready();
	const d = f.interaction();
	f.socket.frame({ op: 0, s: 2, t: "INTERACTION_CREATE", d });
	f.socket.frame({ op: 0, s: 3, t: "INTERACTION_CREATE", d });
	await Promise.resolve();
	expect(f.commit).toHaveBeenCalledTimes(2);
	expect(f.calls.filter((x) => x === "ack")).toHaveLength(1);
	f.gateway.stop();
});
it("a failed acknowledgment from a stopped session cannot invalidate the replacement session", async () => {
	const f = fixture();
	await f.ready();
	let reject!: (reason: Error) => void;
	f.fetcher.mockImplementationOnce(
		() =>
			new Promise((_resolve, fail) => {
				reject = fail;
			}),
	);
	f.socket.frame({ op: 0, s: 2, t: "INTERACTION_CREATE", d: f.interaction() });
	f.gateway.stop();
	f.socket.removeAllListeners();
	f.socket.readyState = 1;
	await f.ready();
	reject(new Error("old reply failure"));
	await Promise.resolve();
	await Promise.resolve();
	expect(f.gateway.healthy()).toBe(true);
	f.gateway.stop();
});
it("preflight refuses an app with HTTP interactions configured and never starts a session", async () => {
	const f = fixture();
	f.fetcher.mockResolvedValueOnce(Response.json({ id: botUserId, bot: true }));
	f.fetcher.mockResolvedValueOnce(
		Response.json({
			id: applicationId,
			interactions_endpoint_url: "https://other.example",
		}),
	);
	await f.gateway.start();
	expect(f.gateway.healthy()).toBe(false);
	expect(f.fetcher).toHaveBeenCalledTimes(2);
	f.gateway.stop();
});

it("health expires even when the event loop has not yet run the overdue heartbeat timer", async () => {
	const f = fixture();
	await f.ready();
	vi.setSystemTime(Date.now() + 2500);
	expect(f.gateway.healthy()).toBe(false);
	f.gateway.stop();
});

it.each([
	"poll",
	"message_reference",
	"referenced_message",
	"shared_client_theme",
	"activity",
	"call",
	"message_snapshots",
])(
	"rejects extra %s on the authenticated message before any durable action or success reply",
	async (field) => {
		const f = fixture();
		await f.ready();
		const data = f.interaction();
		Object.assign(data.message, {
			[field]:
				field === "message_snapshots"
					? [{ message: { content: "extra" } }]
					: { content: "extra" },
		});
		f.socket.frame({ op: 0, s: 2, t: "INTERACTION_CREATE", d: data });
		await Promise.resolve();
		expect(f.commit).not.toHaveBeenCalled();
		expect(f.calls).not.toContain("ack");
		expect(f.gateway.healthy()).toBe(false);
		expect(f.invalidate).toHaveBeenCalledWith("gateway_event_invalid");
		f.gateway.stop();
	},
);
