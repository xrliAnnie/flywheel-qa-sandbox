/**
 * FLY-545 /glaw QA injector — multi-turn voice-leg verifier (audio-injection
 * acceptance harness, the standing voice-QA gate from FLY-545 QA R2).
 *
 * Run AFTER a /glaw meeting is live in the VC (autostart seam or founder click).
 * It joins the VC as the injector bot, subscribes to every OTHER speaker (=Lead
 * reply capture → 回话), then plays a SEQUENCE of founder-audio clips with a
 * reply window between each and records PER-TURN reply bytes. Multi-turn no-drop
 * is the F1 acceptance: the Lead must reply on EVERY turn, not just the first.
 *
 * The daemon must allowlist this injector's id via FLYWHEEL_HUDDLE_ALLOW_USER_IDS
 * (a bot's audio is non-human; the ears admit only humans + allowlisted ids).
 *
 * env: INJECTOR_BOT_TOKEN, STAGED_GUILD_ID, STAGED_VC_ID,
 *      PROBE_WAVS (comma-sep sequence) | PROBE_WAV (single, back-compat),
 *      SETTLE_MS (default 6000), REPLY_MS (default 14000), OUT_DIR
 * Verdict (exit 0 = PASS): every injected turn produced fresh reply audio from a
 * non-injector speaker. Any turn with no reply = drop (F1 fail). Pair with the
 * daemon transcript (~/.flywheel/huddle/transcripts/<issue>.jsonl) for STT proof.
 */

import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as voice from "@discordjs/voice";
import { Client, GatewayIntentBits } from "discord.js";
import prism from "prism-media";
import { classifyReplyBytes } from "./reply-classifier.mjs";

const need = (k) => {
	const v = process.env[k];
	if (!v) {
		console.error(`missing env ${k}`);
		process.exit(2);
	}
	return v;
};
const token = need("INJECTOR_BOT_TOKEN");
const guildId = need("STAGED_GUILD_ID");
const voiceChannelId = need("STAGED_VC_ID");
const clips = (process.env.PROBE_WAVS ?? process.env.PROBE_WAV ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
if (clips.length === 0) {
	console.error("need PROBE_WAVS (comma-sep) or PROBE_WAV");
	process.exit(2);
}
const settleMs = Number(process.env.SETTLE_MS ?? 6_000);
const replyMs = Number(process.env.REPLY_MS ?? 14_000);
const outDir = process.env.OUT_DIR ?? "/tmp/fly545-glaw-injector";
mkdirSync(outDir, { recursive: true });
const log = (m) =>
	console.log(`[glaw-injector] ${new Date().toISOString()} ${m}`);

const injector = new Client({
	intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});
await injector.login(token);
await new Promise((r) => injector.once("clientReady", r));
const injectorId = injector.user.id;
log(
	`injector online ${injector.user.tag} (${injectorId}) — ${clips.length} turns`,
);
await injector.guilds.fetch(guildId);

const conn = voice.joinVoiceChannel({
	guildId,
	channelId: voiceChannelId,
	adapterCreator: injector.guilds.cache.get(guildId).voiceAdapterCreator,
	selfMute: false,
	selfDeaf: false,
});
await voice.entersState(conn, voice.VoiceConnectionStatus.Ready, 15_000);
log("injector in VC — subscribing to other speakers (Lead reply capture)");

const perSpeaker = new Map(); // userId -> total bytes
const totalBytes = () => [...perSpeaker.values()].reduce((a, b) => a + b, 0);
conn.receiver.speaking.on("start", (userId) => {
	if (userId === injectorId) return;
	if (perSpeaker.has(userId)) return;
	perSpeaker.set(userId, 0);
	log(`capturing speaker ${userId}`);
	const sink = createWriteStream(join(outDir, `speaker-${userId}.s16le`));
	const opus = conn.receiver.subscribe(userId, {
		end: { behavior: voice.EndBehaviorType.Manual },
	});
	const dec = new prism.opus.Decoder({
		rate: 48000,
		channels: 2,
		frameSize: 960,
	});
	opus.pipe(dec).on("data", (pcm) => {
		perSpeaker.set(userId, perSpeaker.get(userId) + pcm.length);
		sink.write(pcm);
	});
});

const player = voice.createAudioPlayer();
player.on("error", (e) => log(`player error: ${e.message}`));
conn.subscribe(player);
const playAndWait = async (wav, waitMs) => {
	const resource = voice.createAudioResource(wav);
	player.play(resource);
	await new Promise((r) => setTimeout(r, waitMs));
	log(
		`  played ${wav.split("/").pop()}: playbackDuration=${resource.playbackDuration}ms state=${player.state.status}`,
	);
};

// settle (host greeting + assembly), then run the turns.
await new Promise((r) => setTimeout(r, settleMs));
const turns = [];
for (let i = 0; i < clips.length; i++) {
	const before = totalBytes();
	log(`--- TURN ${i + 1}/${clips.length}: injecting ${clips[i]} ---`);
	await playAndWait(clips[i], replyMs);
	const delta = totalBytes() - before;
	// Codex R23 HIGH-2: the default earcon/filler cues alone crossed the old
	// 20k-byte bar — a Lead that never answered still scored REPLIED. The
	// classifier requires ≥1s of audio BEYOND the cue budget; cue-only turns
	// are named as such and fail the run.
	const verdict = classifyReplyBytes(delta);
	const replied = verdict === "replied";
	turns.push({ turn: i + 1, replyBytes: delta, replied, verdict });
	log(`turn ${i + 1}: reply ${delta} bytes → ${verdict.toUpperCase()}`);
}

log("=== VERDICT ===");
for (const t of turns)
	log(
		`turn ${t.turn}: ${t.replyBytes} bytes [${t.verdict}] ${t.replied ? "✓" : "✗ FAIL"}`,
	);
for (const [uid, bytes] of perSpeaker)
	log(`speaker ${uid}: ${bytes} bytes total`);
const allReplied = turns.length > 0 && turns.every((t) => t.replied);
log(
	allReplied
		? `F1 PASS: Lead replied on all ${turns.length} turns (no mid-meeting drop)`
		: `F1 FAIL: ${turns
				.filter((t) => !t.replied)
				.map((t) => `turn ${t.turn}`)
				.join(", ")} got no reply (drop)`,
);
log(
	"(pair with daemon transcript for 收音/STT + first-utterance-not-swallowed proof)",
);
conn.destroy();
await injector.destroy();
process.exit(allReplied ? 0 : 1);
