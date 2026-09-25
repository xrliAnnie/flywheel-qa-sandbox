import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CodexDiscordGateway } from "../../packages/teamlead/dist/lead-backends/codex/CodexDiscordGateway.js";
import { DiscordVoiceRoom } from "../../packages/voice-codex/dist/discord-room.js";

test("same-token voice and carrier clients do not re-ingest mirrors after reconnect/redelivery", async () => {
	const bot = "100000000000000001",
		token = "fixture-token";
	const voice = new EventEmitter(),
		carrier = new EventEmitter(),
		logins = [],
		submits = [];
	for (const [name, client] of [
		["voice", voice],
		["carrier", carrier],
	]) {
		client.user = { id: bot };
		client.isReady = () => true;
		client.login = async (value) => logins.push([name, value]);
		client.destroy = () => {};
	}
	const source = {
		assertAuthenticatedBotUser: async (id) => {
			assert.equal(id, carrier.user.id);
		},
		onMessage: (handler) => {
			carrier.removeAllListeners("messageCreate");
			carrier.on("messageCreate", handler);
		},
		start: async () => {
			await carrier.login(token);
		},
		stop: async () => {
			carrier.removeAllListeners("messageCreate");
		},
	};
	const gateway = new CodexDiscordGateway({
		source,
		botUserId: bot,
		channelIds: ["thread"],
		router: {
			submit: (input) => {
				submits.push(input);
				return { accepted: true, entryId: input.idempotencyKey };
			},
		},
	});
	const broadcast = (message) => {
		voice.emit("messageCreate", message);
		carrier.emit("messageCreate", message);
	};
	const room = new DiscordVoiceRoom({
		token,
		expectedBotUserId: bot,
		guildId: "guild",
		voiceChannelId: "room",
		threadId: "thread",
		founderUserId: "founder",
		qaAllowUserIds: [],
		onAudio: () => {},
		onFounderPresence: () => {},
		onError: (error) => {
			throw error;
		},
		createVad: async () => ({
			score: async (_samples, state) => ({ probability: 0, next: state }),
			close: async () => {},
		}),
		deps: {
			createClient: () => voice,
			joinVoice: async () => ({}),
			subscribeManual: () => {
				throw Error("unexpected audio");
			},
			createDecoder: () => {
				throw Error("unexpected audio");
			},
			createPlayer: () => ({ play() {}, stop() {}, on() {} }),
			createResource: () => ({}),
			speakingEvents: () => new EventEmitter(),
			memberDisplayName: async () => "",
			voiceChannelHumanCount: async () => 0,
			userVoiceChannelId: async () => null,
			onVoiceStateUpdate: () => () => {},
			leaveVoice: () => {},
			sendMessage: async (_client, channelId, content) =>
				broadcast({
					id: "mirror",
					channelId,
					authorId: bot,
					authorBot: true,
					content,
				}),
		},
	});
	try {
		await gateway.start();
		await room.start();
		assert.equal(voice.listenerCount("messageCreate"), 0);
		await room.status("voice status");
		const mirror = {
			id: "mirror",
			channelId: "thread",
			authorId: bot,
			authorBot: true,
			content: "mirrored founder speech",
		};
		for (let n = 0; n < 3; n++) broadcast(mirror);
		await gateway.stop();
		assert.equal(gateway.probeVoiceSelfFilter().ready, false);
		voice.emit("shardResume");
		broadcast(mirror);
		await gateway.start();
		assert.equal(gateway.probeVoiceSelfFilter().ready, true);
		for (let n = 0; n < 3; n++) broadcast(mirror);
		assert.equal(submits.length, 0);
		broadcast({
			...mirror,
			id: "normal",
			authorId: "founder",
			authorBot: false,
			content: "normal text",
		});
		assert.equal(submits.length, 1);
		assert.deepEqual(logins, [
			["carrier", token],
			["voice", token],
			["carrier", token],
		]);
	} finally {
		await room.stop();
		await gateway.stop();
	}
});
