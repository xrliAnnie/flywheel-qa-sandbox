// usage: DISCORD_TOKEN=$FLY960_EARS_TOKEN node ears-a.mjs <guildId> <channelId>
// 控制面:kill -USR1 <pid> → 受控 destroy+重join(稳定轮用);所有状态/关闭码进 a-debug.log

import { appendFileSync, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import {
	EndBehaviorType,
	entersState,
	joinVoiceChannel,
	VoiceConnectionStatus,
} from "@discordjs/voice";
import { Client, GatewayIntentBits } from "discord.js";
import prism from "prism-media";

const [, , guildId, channelId] = process.argv;
if (!process.env.DISCORD_TOKEN) {
	console.error("FATAL: DISCORD_TOKEN 未设置");
	process.exit(2);
}
const LOG = "out/a-debug.log";
// @discordjs/voice 的 raw debug 会吐出 voice-session token + transport secret_key
// (op0/op4 payload、state-change dump)。这些是 ephemeral per-session 材料,但纪律上
// 一律不落盘——写日志前先 redact,即使 out/ 已 gitignored 也做纵深防御(Codex R1 HIGH)。
const redact = (m) =>
	String(m)
		.replace(/"token"\s*:\s*"[^"]*"/g, '"token":"<redacted>"')
		.replace(/"secret_key"\s*:\s*\[[^\]]*\]/g, '"secret_key":"<redacted>"')
		.replace(/"secretKey"\s*:\s*\{[^}]*\}/g, '"secretKey":"<redacted>"')
		.replace(/"secretKey"\s*:\s*\[[^\]]*\]/g, '"secretKey":"<redacted>"');
const log = (m) =>
	appendFileSync(LOG, `${new Date().toISOString()} ${redact(m)}\n`);

const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
client.on("debug", (m) => log(`[client] ${m}`));
await client.login(process.env.DISCORD_TOKEN);
// 必须等 clientReady 再 join:shard 未 ready 时 join 会静默卡死在 signalling(probe-join.mjs 实测根因)
await new Promise((r) =>
	client.isReady() ? r() : client.once("clientReady", r),
);
const guild = await client.guilds.fetch(guildId);

// DAVE 真在场取证(判据⑤):钩 VoiceWebSocket 的 packet 事件,结构化写 a-dave-proof.jsonl。
// op4 SessionDescription 带 dave_protocol_version;op21/22/24 = DAVE transition/epoch。
// 安全:op4 的 secret_key 与一切二进制 key 材料一律剥掉,只记字节数——证据文件会进 git。
const PROOF = "out/a-dave-proof.jsonl";
const DAVE_OPS = {
	21: "dave_prepare_transition",
	22: "dave_execute_transition",
	24: "dave_prepare_epoch",
};
const summarize = (v) => {
	if (
		v &&
		(v instanceof Uint8Array ||
			Buffer.isBuffer(v) ||
			(Array.isArray(v) && v.length > 64))
	)
		return { bytes: v.length };
	if (Array.isArray(v)) return v.map(summarize);
	if (v && typeof v === "object") {
		const o = {};
		for (const [k, x] of Object.entries(v))
			o[k] = /secret|key|token/i.test(k) ? { redacted: true } : summarize(x);
		return o;
	}
	return v;
};
const proof = (entry) =>
	appendFileSync(
		PROOF,
		`${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`,
	);
const hookedSockets = new WeakSet();
function wireDaveProof() {
	const ws = conn?.state?.networking?.state?.ws;
	if (!ws || hookedSockets.has(ws)) return;
	hookedSockets.add(ws);
	ws.on("packet", (p) => {
		if (p?.op === 4)
			proof({
				type: "session_description",
				dave_protocol_version: p.d?.dave_protocol_version,
				mode: p.d?.mode,
			});
		else if (DAVE_OPS[p?.op])
			proof({ type: DAVE_OPS[p.op], d: summarize(p.d) });
	});
}
setInterval(wireDaveProof, 500).unref();

let conn;
const activeCaptures = new Set();
function wireReceiver() {
	conn.receiver.speaking.on("start", (userId) => {
		log(`[speaking] start ${userId}`);
		// 同一用户已有活跃订阅时不重复开(speaking start 会在 VAD 抖动时反复触发,
		// 重复订阅 = 重叠文件 + 多路 opusscript 解码白烧 CPU —— A-1 实测观察)
		if (activeCaptures.has(userId)) return;
		activeCaptures.add(userId);
		const t = Date.now();
		try {
			const opus = conn.receiver.subscribe(userId, {
				end: { behavior: EndBehaviorType.AfterSilence, duration: 1500 },
			});
			// prism-media 1.3.5 无 OggLogicalBitstream/OpusHead(那是 2.x alpha API,plan 骨架笔误)。
			// 改为直接解码 PCM s16le 落盘;wav 化:ffmpeg -f s16le -ar 48000 -ac 2 -i x.pcm x.wav
			const decoder = new prism.opus.Decoder({
				rate: 48000,
				channels: 2,
				frameSize: 960,
			});
			pipeline(opus, decoder, createWriteStream(`out/a-${userId}-${t}.pcm`))
				.then(() => log(`[capture] wrote out/a-${userId}-${t}.pcm`))
				.catch((e) => log(`[capture-error] ${e.message}`))
				.finally(() => activeCaptures.delete(userId));
		} catch (e) {
			log(`[capture-error] subscribe/decoder setup: ${e.message}`);
			activeCaptures.delete(userId);
		}
	});
}
async function join() {
	conn = joinVoiceChannel({
		guildId,
		channelId,
		adapterCreator: guild.voiceAdapterCreator,
		selfDeaf: false,
		selfMute: true,
		debug: true,
	});
	conn.on("debug", (m) => log(`[voice] ${m}`)); // session description / dave 行都从这里进日志
	conn.on("stateChange", (o, n) => {
		const code = n.reason !== undefined ? ` reason=${n.reason}` : "";
		const close = n.closeCode !== undefined ? ` closeCode=${n.closeCode}` : "";
		log(`[state] ${o.status} -> ${n.status}${code}${close}`);
	});
	conn.on("error", (e) => log(`[error] ${e.stack}`));
	await entersState(conn, VoiceConnectionStatus.Ready, 15_000);
	log("READY");
	wireReceiver();
}
process.on("SIGUSR1", async () => {
	// 受控 rejoin(稳定轮 A-4 用)
	log("[control] SIGUSR1 -> destroy + rejoin in 5s");
	conn.destroy();
	setTimeout(
		() => join().catch((e) => log(`[rejoin-error] ${e.message}`)),
		5000,
	);
});
await join();
console.log(`ears-a up, pid=${process.pid} (kill -USR1 触发受控 rejoin)`);
