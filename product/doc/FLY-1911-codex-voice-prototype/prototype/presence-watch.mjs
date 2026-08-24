import fs from "node:fs";
import { Client, GatewayIntentBits } from "discord.js";

const env = Object.fromEntries(
	fs
		.readFileSync(`${process.env.HOME}/.flywheel/.env`, "utf8")
		.split("\n")
		.filter((l) => l.includes("=") && !l.trim().startsWith("#"))
		.map((l) => [
			l.slice(0, l.indexOf("=")).trim(),
			l.slice(l.indexOf("=") + 1).trim(),
		]),
);
const CH = "1485787273193853170";
const c = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
const ts = () => `${new Date().toISOString().slice(11, 19)}Z`;
c.once("clientReady", () =>
	console.log(`${ts()} 只读旁听已挂上(不进房,房里看不到我)`),
);
c.on("voiceStateUpdate", (o, n) => {
	const u = (n.member || o.member)?.user;
	if (!u || u.bot) return;
	if (o.channelId !== CH && n.channelId === CH)
		console.log(`${ts()} 👤 ${u.tag} 进房了`);
	if (o.channelId === CH && n.channelId !== CH)
		console.log(`${ts()} 👤 ${u.tag} 走了`);
});
c.login(env.TEST_BOT_TOKEN_2);
