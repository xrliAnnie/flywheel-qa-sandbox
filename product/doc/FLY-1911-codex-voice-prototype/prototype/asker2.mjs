/*
 * FLY-1911 任务 3 的阳性对照 + 尺子。
 *  · 问题是我放的 ⇒ 「桥没听见」不可能被解释成「没人说话」。
 *  · ⚠️ Lead 点名的坑:下行改成常开流之后,Discord 的「开始说话」事件**测不了首声延迟**了
 *    —— 服务端眼里它一直在说话。所以这里**只能量波形**,并且要留一条能对齐时间的锚。
 *    锚 = 每 2 秒记一次(墙钟, 已录字节数),事后用字节数换算秒。
 */
import "libsodium-wrappers";
import {
	appendFileSync,
	createReadStream,
	readFileSync,
	writeFileSync,
} from "node:fs";
import {
	AudioPlayerStatus,
	createAudioPlayer,
	createAudioResource,
	EndBehaviorType,
	entersState,
	getVoiceConnection,
	joinVoiceChannel,
	StreamType,
	VoiceConnectionStatus,
} from "@discordjs/voice";
import { Client, GatewayIntentBits } from "discord.js";
import OpusScript from "opusscript";

const GUILD = process.env.GUILD_ID,
	CHAN = process.env.VOICE_CHANNEL_ID,
	TV = process.env.TOKEN_VAR || "TEST_BOT_TOKEN_2";
const OUT = process.env.OUT || "T3-asker",
	OGG = process.env.OGG || "question.ogg";
const ASK_AFTER = Number(process.env.ASK_AFTER_MS || 8000),
	LISTEN = Number(process.env.LISTEN_MS || 150000);
const log = (d, o) => {
	const l = JSON.stringify({ t: new Date().toISOString(), dir: d, obj: o });
	appendFileSync(`${OUT}.jsonl`, `${l}\n`);
	console.log(l);
};
const env = Object.fromEntries(
	readFileSync(`${process.env.HOME}/.flywheel/.env`, "utf8")
		.split("\n")
		.filter((l) => l.includes("=") && !l.trim().startsWith("#"))
		.map((l) => [
			l.slice(0, l.indexOf("=")).trim(),
			l.slice(l.indexOf("=") + 1).trim(),
		]),
);
const dec = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
const c = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
const parts = [];
const subs = new Set();
let bytes = 0,
	askedAt = null,
	askDoneAt = null,
	recStartAt = null;
const marks = []; // [墙钟ms, 已录字节] —— 时间锚
c.once("clientReady", async () => {
	log("GATEWAY", { bot: c.user.tag });
	const g = await c.guilds.fetch(GUILD);
	const conn = joinVoiceChannel({
		channelId: CHAN,
		guildId: GUILD,
		adapterCreator: g.voiceAdapterCreator,
		selfDeaf: false,
		selfMute: false,
	});
	try {
		await entersState(conn, VoiceConnectionStatus.Ready, 25000);
		log("JOINED", {});
	} catch (e) {
		log("RESULT", { ok: false, reason: String(e?.message || e) });
		return bye();
	}
	/* ⚠️ 这一版不再等 speaking.start。
	 * 上一次测的时候它 2.5 分钟才触发一次 —— 因为桥是**常开流**,在我进房之前就一直"在说话",
	 * 我等的那个「开始说话」的**跳变**根本不会再发生。这正是 Lead 提醒的那个坑的真实样子。
	 * 改成:进房就按 userId 主动订阅房里现有的成员,不等事件。 */
	function grab(uid, why) {
		if (uid === c.user.id || subs.has(uid)) return;
		subs.add(uid);
		log("HEARD-SPEAKER", { userId: uid, why });
		const s = conn.receiver.subscribe(uid, {
			end: { behavior: EndBehaviorType.Manual },
		});
		s.on("data", (ch) => {
			try {
				const p = Buffer.from(dec.decode(ch));
				if (!recStartAt) {
					recStartAt = Date.now();
					log("REC-START", {});
				}
				parts.push(p);
				bytes += p.length;
			} catch {}
		});
	}
	conn.receiver.speaking.on("start", (uid) => grab(uid, "speaking.start"));
	try {
		const ch = await g.channels.fetch(CHAN);
		for (const [uid] of ch.members) grab(uid, "进房时就在房里");
	} catch (e) {
		log("MEMBER-FETCH-FAIL", { e: String(e?.message || e) });
	}
	setInterval(async () => {
		try {
			const ch = await g.channels.fetch(CHAN);
			for (const [uid] of ch.members) grab(uid, "轮询发现");
		} catch {}
	}, 5000);
	setInterval(() => {
		if (recStartAt) marks.push([Date.now(), bytes]);
	}, 2000);
	setTimeout(async () => {
		const player = createAudioPlayer();
		conn.subscribe(player);
		player.play(
			createAudioResource(createReadStream(OGG), {
				inputType: StreamType.OggOpus,
			}),
		);
		askedAt = Date.now();
		log("ASKED", {});
		try {
			await entersState(player, AudioPlayerStatus.Idle, 30000);
		} catch {}
		askDoneAt = Date.now();
		log("ASK-DONE", { 问话时长ms: askDoneAt - askedAt });
	}, ASK_AFTER);
	setTimeout(() => {
		let wav = null;
		if (parts.length) {
			const pcm = Buffer.concat(parts),
				sr = 48000,
				ch = 2,
				br = sr * ch * 2,
				h = Buffer.alloc(44);
			h.write("RIFF", 0);
			h.writeUInt32LE(36 + pcm.length, 4);
			h.write("WAVE", 8);
			h.write("fmt ", 12);
			h.writeUInt32LE(16, 16);
			h.writeUInt16LE(1, 20);
			h.writeUInt16LE(ch, 22);
			h.writeUInt32LE(sr, 24);
			h.writeUInt32LE(br, 28);
			h.writeUInt16LE(ch * 2, 32);
			h.writeUInt16LE(16, 34);
			h.write("data", 36);
			h.writeUInt32LE(pcm.length, 40);
			writeFileSync(`${OUT}-room.wav`, Buffer.concat([h, pcm]));
			wav = {
				path: `${OUT}-room.wav`,
				durationSec: +(pcm.length / br).toFixed(2),
				bytesPerSec: br,
			};
		}
		const M = {
			ok: parts.length > 0,
			recStartAt,
			askedAt,
			askDoneAt,
			wav,
			marks,
			说明: "要算首声延迟:在 wav 里找 askDoneAt 之后第一段真声音的位置。wav 的 t=0 对应 recStartAt,用 marks 校准漂移。",
		};
		writeFileSync(`${OUT}-manifest.json`, JSON.stringify(M, null, 2));
		log("RESULT", { ok: M.ok, wav, askedAt, askDoneAt, recStartAt });
		bye();
	}, LISTEN);
	function bye() {
		try {
			getVoiceConnection(GUILD)?.destroy();
		} catch {}
		setTimeout(() => {
			c.destroy();
			process.exit(0);
		}, 1000);
	}
});
c.login(env[TV]).catch((e) => {
	log("LOGINFAIL", { message: String(e?.message || e) });
	process.exit(1);
});
