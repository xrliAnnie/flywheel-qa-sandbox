/* 只读:房里有真人进/出就打一行。用来知道她什么时候开始测、什么时候测完。
 * ⛔ 不进房、不发消息、不改任何东西。*/

import { readFileSync } from "node:fs";
import { Client, GatewayIntentBits } from "discord.js";

const env = Object.fromEntries(
	readFileSync(`${process.env.HOME}/.flywheel/.env`, "utf8")
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
	let prev = null;
	for (;;) {
		let names = [];
		try {
			const ch = await g.channels.fetch("1485787273193853170", { force: true });
			names = [...ch.members.values()]
				.filter((m) => !m.user.bot)
				.map((m) => m.user.tag)
				.sort();
		} catch {
			await new Promise((r) => setTimeout(r, 10000));
			continue;
		}
		const now = names.join(",");
		if (prev !== null && now !== prev) {
			const t = new Date().toISOString().slice(11, 19);
			if (names.length)
				console.log(`${t}  房里有真人了:${now}  ⇒ 房归她,别开跑`);
			else console.log(`${t}  真人走了(刚才是 ${prev})  ⇒ 房空了`);
		}
		prev = now;
		await new Promise((r) => setTimeout(r, 10000));
	}
});
c.login(env.TEST_BOT_TOKEN_2).catch((e) => {
	console.log(`登录失败:${String(e?.message || e).slice(0, 80)}`);
	process.exit(1);
});
