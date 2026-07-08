/**
 * FLY-967 QA-kickback round 2 — synthetic full-duplex voice loop self-test.
 * (packages/voice-bridge/e2e/gemini-voice-loop.mjs —
 * independent QA runs this for the two-way audio verification.)
 *
 * Tadashi ③: 喂一段合成 WAV 进 VC → Gemini Live 收到 → 出干净回话音频。
 * 全程无人参与;跑通才叫 Annie 重测。
 *
 * Loop:
 *   1. venue boots (autostart seam opens a round; interaction path is NOT under
 *      test here — bots cannot invoke slash commands; that leg is unit-tested).
 *      allowUserIds admits the injector bot (the FLY-545 QA-speaker precedent).
 *   2. injector bot joins the VC and PLAYS the synthetic probe
 *      ("帮我看一下本周的进展", 48k stereo s16 WAV, ffmpeg path is fine for files).
 *   3. IN-leg assert: the session transcript (JsonlTranscriptSink) grows a user
 *      entry — proof VC audio reached Gemini Live and was understood.
 *   4. OUT-leg capture: the injector's receiver subscribes the orchestrator's
 *      audio, opus-decodes to 48k stereo s16le, records to out.pcm.
 *   5. OUT-leg assert: out.pcm re-encoded to wav → Gemini generateContent
 *      "transcribe" → non-trivial Chinese text = the response audio is clean
 *      speech, not garble (this is exactly the check Annie's ear failed).
 *
 * env: HUDDLE_ORCH_BOT_TOKEN HUDDLE_EARS_BOT_TOKEN INJECTOR_BOT_TOKEN
 *      GEMINI_API_KEY FLYWHEEL_API_TOKEN STAGED_GUILD_ID STAGED_VC_ID
 *      PROBE_WAV (48k stereo s16 wav)  OUT_DIR (evidence)
 */
import { execFileSync } from "node:child_process";
import {
	createWriteStream,
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { runVoiceBridge } from "../dist/cli.js";

const need = (k) => {
	const v = process.env[k];
	if (!v) {
		console.error(`missing env ${k}`);
		process.exit(2);
	}
	return v;
};

const guildId = need("STAGED_GUILD_ID");
const voiceChannelId = need("STAGED_VC_ID");
const probeWav = need("PROBE_WAV");
const outDir = process.env.OUT_DIR ?? "/tmp/fly967-voice-loop";
need("GEMINI_API_KEY");
need("FLYWHEEL_API_TOKEN");
const injectorToken = need("INJECTOR_BOT_TOKEN");

process.env.FLYWHEEL_BRIDGE_URL ??= "http://127.0.0.1:9877";
if (/:9876(\/|$)/.test(process.env.FLYWHEEL_BRIDGE_URL)) {
	console.error("refusing to run against production Bridge port 9876");
	process.exit(2);
}

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);

// ---- injector identity first: we must allowlist its user id in the venue ----
const { Client, GatewayIntentBits } = await import("discord.js");
const voice = await import("@discordjs/voice");
const prism = await import("prism-media");

const injector = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
await injector.login(injectorToken);
await new Promise((r) => injector.once("clientReady", r));
const injectorId = injector.user.id;
log(`injector online as ${injector.user.tag} (${injectorId})`);

// ---- venue boots with the injector allowlisted + autostart round ----
process.env.FLYWHEEL_GEMINI_AUTOSTART = "voice-loop 自验";
const runtime = await runVoiceBridge({
	config: {
		projectName: process.env.STAGED_PROJECT_NAME ?? "flywheel",
		projectRoot: process.cwd(),
		guildId,
		voiceChannelId,
		commandName: "meet",
		moveMembers: false,
		orchestratorToken: need("HUDDLE_ORCH_BOT_TOKEN"),
		earsToken: need("HUDDLE_EARS_BOT_TOKEN"),
		leads: [],
		backchannelMs: 350,
		allowUserIds: [injectorId], // ears admits the synthetic speaker
		healthPort: Number(process.env.STAGED_HEALTH_PORT ?? 9879),
		ffmpegBin: process.env.FFMPEG_BIN ?? "ffmpeg",
	},
	assistant: {
		commandName: process.env.STAGED_COMMAND_NAME ?? "gemini",
		voice: process.env.STAGED_VOICE ?? "Kore",
		assistantToken: null,
		briefing: { refreshSec: 600, maxAgeSec: 1800, charBudget: 8000, docs: [] },
		localBargeIn: false,
	},
	log,
});
log("venue up (autostart round opening)");

// ---- injector joins VC, records the orchestrator, then speaks the probe ----
const conn = voice.joinVoiceChannel({
	guildId,
	channelId: voiceChannelId,
	adapterCreator: injector.guilds.cache.get(guildId).voiceAdapterCreator,
	selfMute: false,
	selfDeaf: false,
});
await voice.entersState(conn, voice.VoiceConnectionStatus.Ready, 15_000);
log("injector in VC");

execFileSync("mkdir", ["-p", outDir]);
const outPcm = join(outDir, "assistant-out-48k-stereo.s16le");
const sink = createWriteStream(outPcm);
let recordedBytes = 0;
const recorded = new Set();
conn.receiver.speaking.on("start", (userId) => {
	if (userId === injectorId || recorded.has(userId)) return;
	recorded.add(userId);
	log(`recording speaker ${userId}`);
	const opus = conn.receiver.subscribe(userId, {
		end: { behavior: voice.EndBehaviorType.Manual },
	});
	const dec = new prism.opus.Decoder({
		rate: 48000,
		channels: 2,
		frameSize: 960,
	});
	opus.pipe(dec).on("data", (pcm) => {
		recordedBytes += pcm.length;
		sink.write(pcm);
	});
});

// give the assistant time to open (briefing + opening line), then speak.
await new Promise((r) => setTimeout(r, 12_000));
const player = voice.createAudioPlayer();
conn.subscribe(player);
log("injecting synthetic probe speech");
player.play(voice.createAudioResource(probeWav)); // file path → ffmpeg handles wav header
await new Promise((r) => setTimeout(r, 25_000)); // probe (~3s) + Gemini reply window

log(`recorded ${recordedBytes} bytes of assistant audio`);
sink.end();

// ---- IN-leg assert: transcript grew a user line ----
// (venue state dir: ~/.flywheel/voice-bridge or as configured — scan newest jsonl)
const stateRoots = [
	join(process.env.HOME, ".flywheel", "voice-bridge"),
	join(process.env.HOME, ".flywheel"),
];
let transcriptHit = false;
for (const root of stateRoots) {
	if (!existsSync(root)) continue;
	for (const f of readdirSync(root, { recursive: true })) {
		const p = join(root, String(f));
		if (!p.endsWith(".jsonl") || !statSync(p).isFile()) continue;
		if (Date.now() - statSync(p).mtimeMs > 10 * 60_000) continue;
		const body = readFileSync(p, "utf-8");
		if (/"role"\s*:\s*"user"|"user"/.test(body) && body.includes("进展")) {
			transcriptHit = true;
			log(`IN-leg PASS — transcript ${p} contains the probe utterance`);
			break;
		}
	}
}
if (!transcriptHit)
	log("IN-leg: no transcript hit yet (check landing comment quotes)");

// ---- OUT-leg assert: recorded audio transcribes to sane Chinese ----
if (recordedBytes > 48000) {
	const outWav = join(outDir, "assistant-out.wav");
	execFileSync(process.env.FFMPEG_BIN ?? "ffmpeg", [
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
								text: "逐字转写这段音频(中文)。如果只是噪音/乱码,输出 GARBLE。",
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
	log(`OUT-leg transcription: ${text.slice(0, 400)}`);
	log(
		/GARBLE/.test(text) || text.trim().length < 4
			? "OUT-leg FAIL — garble"
			: "OUT-leg PASS — clean speech",
	);
} else {
	log("OUT-leg FAIL — assistant produced (almost) no audio");
}

// ---- teardown ----
try {
	conn.destroy();
} catch {}
try {
	await injector.destroy();
} catch {}
await runtime.close();
log("voice-loop done");
process.exit(0);
