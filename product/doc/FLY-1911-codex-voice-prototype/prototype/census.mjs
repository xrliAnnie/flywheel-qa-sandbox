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
const c = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
c.once("clientReady", async () => {
	const g = await c.guilds.fetch("1485787271192907816");
	const ch = await g.channels.fetch("1485787273193853170", { force: true });
	const l = [...ch.members.values()].map(
		(m) => m.user.tag + (m.user.bot ? "(bot)" : "(真人)"),
	);
	console.log(l.length ? `房里:${l.join(" · ")}` : "EMPTY");
	c.destroy();
	process.exit(l.length ? 1 : 0);
});
c.login(env.TEST_BOT_TOKEN_2).catch((e) => {
	console.log(`查房失败:${e.message}`);
	process.exit(2);
});
