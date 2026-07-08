// usage: DISCORD_TOKEN=$FLY960_SENDER_TOKEN node sender.mjs <guildId> <channelId> <audioFile>

import {
	AudioPlayerStatus,
	createAudioPlayer,
	createAudioResource,
	entersState,
	joinVoiceChannel,
	VoiceConnectionStatus,
} from "@discordjs/voice";
import { Client, GatewayIntentBits } from "discord.js";

const [, , guildId, channelId, file] = process.argv;
const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
await client.login(process.env.DISCORD_TOKEN);
// 同 ears-a.mjs:等 clientReady 再 join,避免 signalling 卡死
await new Promise((r) =>
	client.isReady() ? r() : client.once("clientReady", r),
);
const guild = await client.guilds.fetch(guildId);
const conn = joinVoiceChannel({
	guildId,
	channelId,
	adapterCreator: guild.voiceAdapterCreator,
});
await entersState(conn, VoiceConnectionStatus.Ready, 15_000);
const player = createAudioPlayer();
conn.subscribe(player);
player.on(AudioPlayerStatus.Idle, () =>
	setTimeout(() => player.play(createAudioResource(file)), 3000),
);
player.play(createAudioResource(file));
console.log("sender playing on loop");
