/**
 * QA · FLY-1006 RE-TEST — real-machine waiting-cue verification.
 *
 * Runs the /eleven daemon WITH waitingCuePath set (the config path prod leaves
 * unset), injects one zh probe, and asserts from the session jsonl that the
 * cue fires in the dead-air gap and stops at the real answer — the exact
 * behavior the kickback (B1/B2) was about. FAIL-CLOSED: any red assert → exit 1.
 *
 * The injected probe segments into 1..N speaking bursts (VAD), so there may be
 * several cue episodes; the asserts are episode-aware, not single-shot.
 *
 * Asserts:
 *   1. B1 — at least one cue_start, and every cue_start immediately follows a
 *      speech_end (the fix: the cue fires even though the backchannel gate set
 *      `suppressed`, the exact condition that used to gate it off).
 *   2. B2 — balanced start/stop; every cue_stop is triggered by a barge-in (she
 *      spoke again) or the real answer (first_audio), never a spurious mid-wait
 *      stop; and the answer-side cue_stop sits immediately before first_audio
 *      (stopped in the same first-chunk handler that opens the turn).
 *   3. agent audio still lands NON-SILENT in the VC (B2: the cue's shared-player
 *      stop() did not cut the live turn stream).
 */
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

const guildId = need("STAGED_GUILD_ID");
const voiceChannelId = need("STAGED_VC_ID");
const agentId = need("ELEVENLABS_AGENT_ID");
need("ELEVENLABS_API_KEY");
const probeWav = need("PROBE_WAV");
const cueWav = need("CUE_WAV");
const injectorToken = need("INJECTOR_BOT_TOKEN");
const outDir = process.env.OUT_DIR ?? "/tmp/fly1006-qa/cue-out";

const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const failures = [];
const fail = (m) => {
	failures.push(m);
	log(`FAIL: ${m}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { Client, GatewayIntentBits } = await import("discord.js");
const voice = await import("@discordjs/voice");
const prism = await import("prism-media");

const injector = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
await injector.login(injectorToken);
await new Promise((r) => injector.once("clientReady", r));
const injectorId = injector.user.id;
log(`injector online (${injectorId})`);

process.env.FLYWHEEL_ELEVEN_AUTOSTART = "cue-verify 自验";
const stateDir = mkdtempSync(join(tmpdir(), "fly1006-cue-state-"));

const runtime = await runVoiceBridge({
	config: {
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
		allowUserIds: [injectorId],
		healthPort: Number(process.env.STAGED_HEALTH_PORT ?? 9879),
		ffmpegBin: process.env.FFMPEG_BIN ?? "ffmpeg",
	},
	assistant: null,
	eleven: {
		commandName: "eleven",
		agentId,
		apiKeyEnv: "ELEVENLABS_API_KEY",
		shimHealthUrl:
			process.env.ELEVEN_SHIM_HEALTH_URL ?? "http://127.0.0.1:8980/health",
		waitingCuePath: cueWav, // ← the fix under test: cue enabled
	},
	elevenWiring: { stateDir },
	log,
});
log("venue up (/eleven autostart, cue enabled)");

const conn = voice.joinVoiceChannel({
	guildId,
	channelId: voiceChannelId,
	adapterCreator: injector.guilds.cache.get(guildId).voiceAdapterCreator,
	selfMute: false,
	selfDeaf: false,
});
await voice.entersState(conn, voice.VoiceConnectionStatus.Ready, 15_000);
log("injector in VC");

const outPcm = join(outDir, "cue-verify-48k-stereo.s16le");
await import("node:fs/promises").then((f) =>
	f.mkdir(outDir, { recursive: true }),
);
const sink = createWriteStream(outPcm);
let recordedBytes = 0;
const recorded = new Set();
conn.receiver.speaking.on("start", (userId) => {
	if (userId === injectorId || recorded.has(userId)) return;
	recorded.add(userId);
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

await sleep(8_000); // autostart preflight + WS + VC join
const player = voice.createAudioPlayer();
conn.subscribe(player);

log("injecting zh probe (→ speech_end → cue → brain → real answer → cue stop)");
player.play(voice.createAudioResource(probeWav));
await sleep(32_000); // probe + cold brain (~10s) + reply audio

const readTrail = () => {
	if (!existsSync(stateDir)) return [];
	const raw = readdirSync(stateDir)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => readFileSync(join(stateDir, f), "utf-8"))
		.join("\n")
		.trim();
	if (!raw) return [];
	return raw.split("\n").map((l) => JSON.parse(l));
};
const trail = readTrail();
const order = trail.map((l) => l.type);
log(`jsonl event order: ${order.join(" ")}`);

// episode-aware: the injected probe segments into 1..N speaking bursts (VAD),
// so there may be several cue episodes. Verify the invariants that matter,
// robust to episode count (a single indexOf can't — it misreads a 2-episode
// run as mistimed, as an over-strict earlier assert did).
const at = (type) =>
	order.map((t, i) => (t === type ? i : -1)).filter((i) => i >= 0);
const starts = at("cue_start");
const stops = at("cue_stop");
const firstAudio = order.indexOf("first_audio");

// 1. B1 — at least one cue started, and every cue_start immediately follows a
// speech_end (the fix: cue fires even though the backchannel gate set suppressed).
if (starts.length === 0)
	fail("no cue_start — the waiting cue never started (B1 not fixed)");
else if (starts.some((i) => order[i - 1] !== "speech_end"))
	fail(`a cue_start is not preceded by speech_end (order: ${order.join(" ")})`);
else
	log(
		`assert 1 PASS — ${starts.length} cue episode(s), each starts on speech_end (B1 fixed)`,
	);

// 2. B2 — balanced start/stop, and every cue_stop is triggered by either a
// barge-in (she spoke again) or the real answer (first_audio) — never a
// spurious mid-wait stop. Each cue_stop is emitted in the SAME handler that
// does the next thing, so it sits immediately before an interruption or
// first_audio in the trail.
if (stops.length !== starts.length)
	fail(`unbalanced cue start/stop (${starts.length} vs ${stops.length})`);
else if (
	stops.some(
		(i) => order[i + 1] !== "interruption" && order[i + 1] !== "first_audio",
	)
)
	fail(
		`a cue_stop is not paired to a barge-in or the answer (order: ${order.join(" ")})`,
	);
else if (firstAudio < 0) fail("no first_audio — agent never produced a turn");
else if (order[firstAudio - 1] !== "cue_stop")
	fail(
		`first_audio not immediately preceded by cue_stop — cue did not stop at the answer's onset (order: ${order.join(" ")})`,
	);
else
	log(
		`assert 2 PASS — every cue_stop paired to barge-in/answer; answer-side cue_stop adjacent to first_audio (B2 timing)`,
	);

// 4. agent audio still non-silent (B2: cue's shared-player stop didn't cut it)
if (recordedBytes > 192_000) {
	const buf = readFileSync(outPcm);
	let sum = 0;
	const n = Math.min(buf.length, 10_000_000);
	for (let i = 0; i < n - 1; i += 2) {
		const s = buf.readInt16LE(i) / 32768;
		sum += s * s;
	}
	const rms = Math.sqrt(sum / (n / 2));
	if (rms > 0.01)
		log(
			`assert 3 PASS — ${recordedBytes} bytes VC audio, rms=${rms.toFixed(4)} (cue + agent, non-silence, not cut)`,
		);
	else
		fail(
			`recorded audio is (near-)silence rms=${rms.toFixed(5)} — agent may have been cut`,
		);
} else {
	fail(`(almost) no VC audio recorded (${recordedBytes} bytes)`);
}

sink.end();
try {
	conn.destroy();
} catch {}
try {
	await injector.destroy();
} catch {}
await runtime.close();
log(`evidence: ${outPcm} + jsonl in ${stateDir}`);
if (failures.length > 0) {
	log(`cue-verify VERDICT: FAIL (${failures.length})`);
	for (const f of failures) log(`  - ${f}`);
	process.exit(1);
}
log("cue-verify VERDICT: PASS");
process.exit(0);
