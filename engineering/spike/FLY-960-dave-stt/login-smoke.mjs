// usage: DISCORD_TOKEN=... node login-smoke.mjs
// 登录 smoke test:验证 token 有效 + 打印 bot 身份与所在 guild 数(不需要已在任何 guild)。
import { Client, GatewayIntentBits } from "discord.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const timer = setTimeout(() => {
	console.error("LOGIN_TIMEOUT");
	process.exit(1);
}, 20_000);
client.once("clientReady", async () => {
	clearTimeout(timer);
	const guilds = await client.guilds.fetch();
	console.log(
		`LOGIN_OK tag=${client.user.tag} id=${client.user.id} guilds=${guilds.size}${guilds.size ? ` [${[...guilds.values()].map((g) => g.id).join(",")}]` : ""}`,
	);
	client.destroy();
	process.exit(0);
});
await client.login(process.env.DISCORD_TOKEN).catch((e) => {
	console.error(`LOGIN_FAIL ${e.message}`);
	process.exit(1);
});
