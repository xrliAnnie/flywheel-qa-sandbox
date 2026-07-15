/**
 * FLY-1006 S8 — /eleven synthetic full-duplex voice loop (plan P5, legs 1-3).
 * Models gemini-voice-loop.mjs; FAIL-CLOSED (e55beaf5): any red assert = exit 1.
 *
 * Boot A (mutex leg): BOTH modes wired, /gemini autostart fires first and
 *   parks on a hanging kickoff fetch (black-hole Bridge URL) so it HOLDS the
 *   shared slot → /eleven autostart must be rejected founder-facing. The
 *   busy message lands in the staged text channel (autostart replies go via
 *   sendMessage) — asserted by reading channel history. Reverse direction
 *   (/gemini rejected while /eleven holds) is covered by unit tests
 *   (eleven-wiring + assistant-wiring shared-slot cases).
 *
 * Boot B (/eleven only):
 *   leg 1: injector plays u1 zh WAV → transcript jsonl grows user_transcript
 *          (platform STT — no third-party transcription needed) → agent audio
 *          lands in the VC (recorded waveform NON-SILENCE by RMS).
 *   leg 2: while the agent audio is streaming, inject a second utterance →
 *          playback stops (recording stalls) → session ALIVE: a further probe
 *          grows the transcript again.
 *
 * env: HUDDLE_ORCH_BOT_TOKEN HUDDLE_EARS_BOT_TOKEN INJECTOR_BOT_TOKEN
 *      ELEVENLABS_AGENT_ID ELEVENLABS_API_KEY STAGED_GUILD_ID STAGED_VC_ID
 *      PROBE_WAV INTERRUPT_WAV  [OUT_DIR ELEVEN_SHIM_HEALTH_URL]
 *      ELEVEN_LOOP_LEGS=all|mutex|audio (default all) — run the two boots in
 *        SEPARATE processes when a same-process rerun hits the @discordjs/voice
 *        stale group-connection registry (boot A's destroyed ears connection is
 *        keyed by guild+bot and wedges boot B's resident join → entersState
 *        AbortError). Two invocations, each exit-code gated, stay fail-closed.
 */
import { execFileSync } from "node:child_process";
import {
	createWriteStream,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

// isolation guard (bf8369b1 precedent, mirrors eleven-staged.mjs): never
// bind the production voice-bridge health port.
if (Number(process.env.STAGED_HEALTH_PORT ?? 9879) === 9878) {
	console.error(
		"refusing to run the /eleven voice loop on the production voice-bridge health port (9878)",
	);
	process.exit(2);
}

const guildId = need("STAGED_GUILD_ID");
const voiceChannelId = need("STAGED_VC_ID");
const agentId = need("ELEVENLABS_AGENT_ID");
need("ELEVENLABS_API_KEY");
const probeWav = need("PROBE_WAV");
const interruptWav = need("INTERRUPT_WAV");
const injectorToken = need("INJECTOR_BOT_TOKEN");
const outDir = process.env.OUT_DIR ?? "/tmp/fly1006-voice-loop";
execFileSync("mkdir", ["-p", outDir]);

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const failures = [];
const fail = (m) => {
	failures.push(m);
	log(`FAIL: ${m}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const elevenConfig = {
	commandName: "eleven",
	agentId,
	apiKeyEnv: "ELEVENLABS_API_KEY",
	shimHealthUrl:
		process.env.ELEVEN_SHIM_HEALTH_URL ?? "http://127.0.0.1:8980/health",
};
const baseConfig = (allowUserIds) => ({
	projectName: "flywheel",
	projectRoot: process.cwd(),
	guildId,
	voiceChannelId,
	commandName: "meet",
	moveMembers: false,
	orchestratorToken: need("HUDDLE_ORCH_BOT_TOKEN"),
	earsToken: need("HUDDLE_EARS_BOT_TOKEN"),
	leads: [],
	backchannelMs: 350,
	allowUserIds,
	healthPort: Number(process.env.STAGED_HEALTH_PORT ?? 9879),
	ffmpegBin: process.env.FFMPEG_BIN ?? "ffmpeg",
});

// ---- injector bot (WAV speaker + orchestrator recorder + channel reader) ----
const { Client, GatewayIntentBits } = await import("discord.js");
const voice = await import("@discordjs/voice");
const prism = await import("prism-media");
const injector = new Client({
	// MessageContent: the mutex leg asserts the founder-facing busy text via
	// channel history — without the privileged intent the content is redacted
	// (a silent false-FAIL). Portal-side it must be enabled on the injector.
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildVoiceStates,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
});
await injector.login(injectorToken);
await new Promise((r) => injector.once("clientReady", r));
const injectorId = injector.user.id;
log(`injector online as ${injector.user.tag} (${injectorId})`);

const LEGS = process.env.ELEVEN_LOOP_LEGS ?? "all";

// ===================== Boot A — cross-mode slot mutex =====================
if (LEGS !== "audio") {
	log("boot A: /gemini holds the room (hanging kickoff) → /eleven rejected");
	// black-hole Bridge: the /gemini kickoff createIssue hangs AFTER the slot
	// acquire, holding the room deterministically for the mutex window.
	process.env.FLYWHEEL_BRIDGE_URL = "http://10.255.255.255:9877";
	process.env.FLYWHEEL_API_TOKEN ??= "staged-mutex-leg";
	process.env.FLYWHEEL_GEMINI_AUTOSTART = "mutex-leg 占坑";
	process.env.FLYWHEEL_ELEVEN_AUTOSTART = "mutex-leg 拒入验证";
	const bootAt = Date.now();
	const runtime = await runVoiceBridge({
		config: baseConfig([]),
		assistant: {
			commandName: "gemini",
			voice: "Kore",
			assistantToken: null,
			briefing: {
				refreshSec: 600,
				maxAgeSec: 1800,
				charBudget: 8000,
				docs: [],
			},
			localBargeIn: false,
		},
		assistantWiring: {
			// no real Gemini in the mutex leg — the fake conversation is never
			// reached anyway (the kickoff fetch parks first).
			createConversation: async () => ({
				sendText() {},
				sendAudio() {},
				on: () => () => {},
				close: async () => undefined,
			}),
		},
		eleven: elevenConfig,
		log,
	});
	await sleep(12_000); // both autostarts (2s) + replies
	const channel = await injector.channels.fetch(voiceChannelId);
	const recent = await channel.messages.fetch({ limit: 20 });
	const busy = [...recent.values()].find(
		(m) => m.createdTimestamp > bootAt && /正在进行/.test(m.content ?? ""),
	);
	if (busy) {
		log(`mutex leg PASS — busy rejection surfaced: "${busy.content}"`);
	} else {
		fail(
			"mutex leg: no founder-facing busy rejection in the channel — /eleven entered a held room or never tried",
		);
	}
	await runtime.close();
	delete process.env.FLYWHEEL_GEMINI_AUTOSTART;
	delete process.env.FLYWHEEL_BRIDGE_URL;
	await sleep(3_000);
}

if (LEGS === "mutex") {
	try {
		await injector.destroy();
	} catch {}
	if (failures.length > 0) {
		log(`eleven-voice-loop (mutex leg) VERDICT: FAIL (${failures.length})`);
		for (const f of failures) log(`  - ${f}`);
		process.exit(1);
	}
	log("eleven-voice-loop (mutex leg) VERDICT: PASS");
	process.exit(0);
}

// ===================== Boot B — /eleven audio legs =====================
log("boot B: /eleven only — audio round + barge-in + survival");
process.env.FLYWHEEL_ELEVEN_AUTOSTART = "voice-loop 自验";
const stateDir = mkdtempSync(join(tmpdir(), "fly1006-loop-state-"));
const runtime = await runVoiceBridge({
	config: baseConfig([injectorId]), // ears admits the synthetic speaker
	assistant: null,
	eleven: elevenConfig,
	elevenWiring: { stateDir },
	log,
});
log("venue up (/eleven autostart opening)");

const conn = voice.joinVoiceChannel({
	guildId,
	channelId: voiceChannelId,
	adapterCreator: injector.guilds.cache.get(guildId).voiceAdapterCreator,
	selfMute: false,
	selfDeaf: false,
});
await voice.entersState(conn, voice.VoiceConnectionStatus.Ready, 15_000);
log("injector in VC");

const outPcm = join(outDir, "eleven-out-48k-stereo.s16le");
const sink = createWriteStream(outPcm);
let recordedBytes = 0;
let lastAudioAt = 0;
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
		lastAudioAt = Date.now();
		sink.write(pcm);
	});
});

await sleep(8_000); // /eleven round open (preflight + WS + VC join)
const player = voice.createAudioPlayer();
conn.subscribe(player);

// ---- leg 1: probe → transcript + non-silent agent audio ----
log("leg 1: injecting zh probe");
player.play(voice.createAudioResource(probeWav));
await sleep(30_000); // probe (~3s) + brain (~10s cold) + reply audio

const readTranscript = () => {
	if (!existsSync(stateDir)) return "";
	return readdirSync(stateDir)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => readFileSync(join(stateDir, f), "utf-8"))
		.join("\n");
};
const t1 = readTranscript();
const userLines = (t1.match(/"type":"user_transcript"/g) ?? []).length;
if (userLines > 0) {
	log(`leg 1 IN PASS — ${userLines} user_transcript line(s) in the jsonl`);
} else {
	fail(
		"leg 1 IN: probe never reached a user_transcript — VC audio not feeding the agent",
	);
}
const leg1Bytes = recordedBytes;
if (leg1Bytes > 192_000) {
	// non-silence: RMS over the recorded s16le
	const buf = readFileSync(outPcm);
	let sum = 0;
	const n = Math.min(buf.length, 10_000_000);
	for (let i = 0; i < n - 1; i += 2) {
		const s = buf.readInt16LE(i) / 32768;
		sum += s * s;
	}
	const rms = Math.sqrt(sum / (n / 2));
	if (rms > 0.01) {
		log(
			`leg 1 OUT PASS — ${leg1Bytes} bytes of agent audio, rms=${rms.toFixed(4)} (non-silence)`,
		);
	} else {
		fail(`leg 1 OUT: recorded audio is (near-)silence (rms=${rms.toFixed(5)})`);
	}
} else {
	fail(`leg 1 OUT: (almost) no agent audio recorded (${leg1Bytes} bytes)`);
}

// ---- leg 2: barge-in while streaming → stop, then survival round ----
log("leg 2: probing barge-in (need live playback)");
player.play(voice.createAudioResource(probeWav));
// wait for agent audio to be actively streaming again
const streamStart = Date.now();
while (Date.now() - streamStart < 35_000) {
	if (Date.now() - lastAudioAt < 500 && recordedBytes > leg1Bytes + 96_000)
		break;
	await sleep(250);
}
if (recordedBytes <= leg1Bytes + 96_000) {
	fail("leg 2: second round produced no streaming audio to interrupt");
} else {
	log("leg 2: agent streaming — injecting interrupt speech");
	player.play(voice.createAudioResource(interruptWav));
	await sleep(4_000); // interrupt utterance (~2-3s) + platform interruption
	const bytesAtCut = recordedBytes;
	await sleep(3_000);
	const grewAfterCut = recordedBytes - bytesAtCut;
	// the dying stream may flush a tail; anything beyond ~1.5s of audio
	// (288000 bytes @48k stereo s16le) means playback did NOT stop.
	if (grewAfterCut < 288_000) {
		log(
			`leg 2 STOP PASS — playback stalled after barge-in (+${grewAfterCut} bytes tail)`,
		);
	} else {
		fail(
			`leg 2 STOP: audio kept streaming after barge-in (+${grewAfterCut} bytes)`,
		);
	}
	// survival: the session must answer one more round
	const userLinesBefore = (
		readTranscript().match(/"type":"user_transcript"/g) ?? []
	).length;
	await sleep(12_000); // let the interrupt utterance itself be answered
	log("leg 2: survival probe");
	player.play(voice.createAudioResource(probeWav));
	await sleep(25_000);
	const userLinesAfter = (
		readTranscript().match(/"type":"user_transcript"/g) ?? []
	).length;
	if (userLinesAfter > userLinesBefore) {
		log(
			`leg 2 SURVIVAL PASS — transcript grew ${userLinesBefore}→${userLinesAfter}`,
		);
	} else {
		fail(
			"leg 2 SURVIVAL: session died after the barge-in (no further transcripts)",
		);
	}
}

// ---- teardown + verdict ----
sink.end();
try {
	conn.destroy();
} catch {}
try {
	await injector.destroy();
} catch {}
await runtime.close();
log(`evidence: ${outPcm} + transcripts in ${stateDir}`);
if (failures.length > 0) {
	log(`eleven-voice-loop VERDICT: FAIL (${failures.length})`);
	for (const f of failures) log(`  - ${f}`);
	process.exit(1);
}
log("eleven-voice-loop VERDICT: PASS");
process.exit(0);
