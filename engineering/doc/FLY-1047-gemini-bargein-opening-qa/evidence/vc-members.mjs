/**
 * FLY-1047 QA — read-only VC occupancy check (pool-06 token, no join).
 * Lists current voice-channel members with bot flags — the "VC empty" gate
 * Tadashi asked for before starting the runner.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const guildId = process.env.STAGED_GUILD_ID ?? "1485787271192907816";
const voiceChannelId = process.env.STAGED_VC_ID ?? "1485787273193853170";
const tokenFile = join(
	homedir(),
	".flywheel",
	"discord-bot-pool",
	"flywheel-pool-06",
	"token",
);
const token = existsSync(tokenFile)
	? readFileSync(tokenFile, "utf-8").trim()
	: "";
if (!token) {
	console.error("no pool-06 token");
	process.exit(2);
}

const { Client, GatewayIntentBits } = await import("discord.js");
const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
await client.login(token);
await new Promise((r) => client.once("clientReady", r));
const guild = await client.guilds.fetch(guildId);
const channel = await guild.channels.fetch(voiceChannelId);
const members = [...channel.members.values()];
console.log(
	`[${new Date().toISOString()}] VC ${voiceChannelId} members: ${members.length}`,
);
for (const m of members) {
	console.log(
		`  - ${m.user.tag} (${m.user.id}) bot=${m.user.bot} mute=${m.voice.mute} deaf=${m.voice.deaf}`,
	);
}
await client.destroy();
process.exit(0);
