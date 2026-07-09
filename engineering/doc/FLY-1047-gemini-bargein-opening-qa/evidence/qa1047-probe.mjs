/**
 * FLY-1047 QA merged probe — pool-06, ONE voice connection (plan P2.2):
 *   - injector: trigger file /tmp/fly1047-inject-cmd → player.play(WAV), timestamped log (①-1 time base)
 *   - capture: subscribe orchestrator (assistant mouth) → opus decode 48k stereo → s16le sink,
 *     with segment start/end timestamps (①-3 "戛止" evidence)
 * QUIT → finalize: s16le → WAV archive + Gemini STT transcription (GARBLE check, ③-5).
 * Merged from parent-worktree qa-injector.mjs + qa-out-capture.mjs (read-only references).
 */
import { execFileSync } from "node:child_process";
import {
	createWriteStream,
	existsSync,
	readFileSync,
	unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const guildId = process.env.STAGED_GUILD_ID ?? "1485787271192907816";
const voiceChannelId = process.env.STAGED_VC_ID ?? "1485787273193853170";
const targetUserId = process.env.TARGET_USER_ID ?? "1523230048243417178"; // orchestrator mouth
const TRIGGER = process.env.INJECT_TRIGGER ?? "/tmp/fly1047-inject-cmd";
const outDir = process.env.OUT_DIR ?? "/tmp/fly1047-rig";
const tokenFile = join(
	homedir(),
	".flywheel",
	"discord-bot-pool",
	"flywheel-pool-06",
	"token",
);
const token =
	process.env.RECEIVER_BOT_TOKEN ??
	(existsSync(tokenFile) ? readFileSync(tokenFile, "utf-8").trim() : "");
if (!token) {
	console.error("no probe bot token");
	process.exit(2);
}
if (!process.env.GEMINI_API_KEY) {
	console.error("missing GEMINI_API_KEY (needed for final STT)");
	process.exit(2);
}

const { Client, GatewayIntentBits } = await import("discord.js");
const voice = await import("@discordjs/voice");
const prism = await import("prism-media");
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

const client = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
await client.login(token);
await new Promise((r) => client.once("clientReady", r));
log(`probe online as ${client.user.tag} (${client.user.id})`);

const conn = voice.joinVoiceChannel({
	guildId,
	channelId: voiceChannelId,
	adapterCreator: (await client.guilds.fetch(guildId)).voiceAdapterCreator,
	selfMute: false,
	selfDeaf: false,
});
conn.on("error", (e) =>
	log(`voice conn error (non-fatal): ${e?.message ?? e}`),
);
conn.on("stateChange", (o, n) => log(`voice conn ${o.status} -> ${n.status}`));
client.on("error", (e) => log(`client error (non-fatal): ${e?.message ?? e}`));
await voice.entersState(conn, voice.VoiceConnectionStatus.Ready, 15_000);
const player = voice.createAudioPlayer();
player.on("error", (e) => log(`player error (non-fatal): ${e?.message ?? e}`));
conn.subscribe(player);
log(
	`probe in VC (inject+capture merged). trigger: echo "<wav>" > ${TRIGGER}; QUIT to finish. capture target: ${targetUserId}`,
);
if (existsSync(TRIGGER)) unlinkSync(TRIGGER);

// ---- capture leg ----
const outPcm = join(outDir, "out-48k-stereo.s16le");
const sink = createWriteStream(outPcm);
let bytes = 0;
let lastDataTs = 0;
let segmentOpen = false;
let segmentBytes = 0;
const startCap = (userId) => {
	if (userId !== targetUserId) return;
	const opus = conn.receiver.subscribe(userId, {
		end: { behavior: voice.EndBehaviorType.Manual },
	});
	const dec = new prism.opus.Decoder({
		rate: 48000,
		channels: 2,
		frameSize: 960,
	});
	opus.pipe(dec).on("data", (pcm) => {
		const now = Date.now();
		if (!segmentOpen) {
			segmentOpen = true;
			segmentBytes = 0;
			log(`OUT-AUDIO segment start (total so far ${bytes}B)`);
		}
		bytes += pcm.length;
		segmentBytes += pcm.length;
		lastDataTs = now;
		sink.write(pcm);
	});
	log(`subscribed to speaker ${userId}`);
};
conn.receiver.speaking.on("start", startCap);
// segment-end watcher: >700ms without data = stream stopped (①-3 anchor)
const gapTimer = setInterval(() => {
	if (segmentOpen && lastDataTs && Date.now() - lastDataTs > 700) {
		segmentOpen = false;
		log(
			`OUT-AUDIO segment end — segBytes=${segmentBytes} (~${(segmentBytes / (48000 * 2 * 2)).toFixed(2)}s audio), last data at ${new Date(lastDataTs).toISOString()}`,
		);
	}
}, 100);

// ---- inject leg ----
let quit = false;
while (!quit) {
	if (existsSync(TRIGGER)) {
		const cmd = readFileSync(TRIGGER, "utf-8").trim();
		try {
			unlinkSync(TRIGGER);
		} catch {}
		if (cmd === "QUIT") {
			quit = true;
			break;
		}
		if (cmd && existsSync(cmd)) {
			log(`INJECT ▶ playing ${cmd}`);
			player.play(voice.createAudioResource(cmd));
		} else {
			log(`trigger had no valid wav: ${JSON.stringify(cmd)}`);
		}
	}
	await new Promise((r) => setTimeout(r, 150));
}

// ---- finalize ----
log("probe quitting — finalizing capture");
clearInterval(gapTimer);
if (segmentOpen)
	log(
		`OUT-AUDIO segment end (at quit) — segBytes=${segmentBytes}, last data at ${new Date(lastDataTs).toISOString()}`,
	);
sink.end();
await new Promise((r) => sink.on("finish", r));
try {
	conn.destroy();
} catch {}
try {
	await client.destroy();
} catch {}
log(
	`captured total ${bytes} bytes (~${(bytes / (48000 * 2 * 2)).toFixed(1)}s speech)`,
);

if (bytes < 48000) {
	log("CAPTURE: (almost) no audio captured — no WAV/STT");
	process.exit(0);
}
const outWav = join(outDir, "out-capture.wav");
execFileSync("ffmpeg", [
	"-y",
	"-loglevel",
	"error",
	"-f",
	"s16le",
	"-ar",
	"48000",
	"-ac",
	"2",
	"-i",
	outPcm,
	outWav,
]);
log(`WAV archived: ${outWav}`);
try {
	const b64 = readFileSync(outWav).toString("base64");
	const resp = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				contents: [
					{
						parts: [
							{
								text: "逐字转写这段音频(中文)。如果只是噪音/乱码/静音,输出 GARBLE。",
							},
							{ inlineData: { mimeType: "audio/wav", data: b64 } },
						],
					},
				],
			}),
		},
	);
	const j = await resp.json();
	const text =
		j?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
	log(`STT transcript: ${text.slice(0, 1500)}`);
	const bad = /GARBLE/.test(text) || text.trim().length < 4;
	log(
		bad
			? "STT VERDICT: FAIL — captured assistant audio is garble/silence"
			: "STT VERDICT: PASS — assistant audio transcribes to clean speech",
	);
} catch (e) {
	log(`STT step failed (environment): ${e?.message ?? e}`);
}
process.exit(0);
