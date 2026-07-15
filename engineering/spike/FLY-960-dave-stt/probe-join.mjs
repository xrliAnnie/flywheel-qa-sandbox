// 诊断探针:join 握手全链路观测(gateway raw 事件 + adapter sendPayload + 状态机)。
// usage: DISCORD_TOKEN=... node probe-join.mjs <guildId> <channelId>

import { joinVoiceChannel } from "@discordjs/voice";
import { Client, Events, GatewayIntentBits } from "discord.js";

const [, , guildId, channelId] = process.argv;
const ts = () => new Date().toISOString();
const log = (m) => console.log(`${ts()} ${m}`);

const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
client.on("raw", (p) => {
	if (p?.t === "VOICE_STATE_UPDATE" || p?.t === "VOICE_SERVER_UPDATE") {
		log(
			`[raw] ${p.t} ${JSON.stringify({ ...p.d, token: p.d?.token ? "<redacted>" : undefined })}`,
		);
	}
});
await client.login(process.env.DISCORD_TOKEN);
await new Promise((r) =>
	client.isReady() ? r() : client.once(Events.ClientReady, r),
);
log(`clientReady as ${client.user.tag}`);

const guild = await client.guilds.fetch(guildId);
const realCreator = guild.voiceAdapterCreator;
const wrappedCreator = (methods) => {
	const adapter = realCreator(methods);
	return {
		sendPayload: (payload) => {
			const ok = adapter.sendPayload(payload);
			log(
				`[adapter] sendPayload op=${payload?.op} d=${JSON.stringify(payload?.d)} -> ${ok}`,
			);
			return ok;
		},
		destroy: () => {
			log("[adapter] destroy");
			adapter.destroy();
		},
	};
};

const conn = joinVoiceChannel({
	guildId,
	channelId,
	adapterCreator: wrappedCreator,
	selfDeaf: false,
	selfMute: true,
	debug: true,
});
conn.on("debug", (m) => log(`[voice] ${m}`));
conn.on("stateChange", (o, n) => log(`[state] ${o.status} -> ${n.status}`));
conn.on("error", (e) => log(`[error] ${e.stack}`));

setTimeout(() => {
	log(`FINAL status=${conn.state.status}`);
	conn.destroy();
	client.destroy();
	process.exit(0);
}, 25_000);
