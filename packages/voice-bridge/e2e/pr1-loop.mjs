// FLY-545 PR-1 real-machine loop (plan §7 P5, evidence/pr1-loop.md).
//
// Drives the REAL package modules (dist build) against a REAL Discord VC:
//   ears bot (Note-taker, pool-04) + speaker bot (pool-05, standing in for
//   both "a Lead mouth" and "a talking human" — the signal path exercised is
//   identical to production: subscribed member's speaking events → gate →
//   LeadSpeaker.stop()).
//
// Scenarios:
//   A receive     — speaker plays a REAL edge-tts mp3 (full mp3→opus chain);
//                   ears subscribes, decodes, downmixes; 16k PCM saved for
//                   offline Gemini transcription. Gate observes only.
//   B backchannel — speaker plays a <350ms clip; gate must NOT fire; speaking
//                   START and END events must both be observed (Codex R2
//                   guardrail ③: speaking-end reliability pinned in PR-1).
//   C barge-in    — speaker plays the long clip; gate fires at ~350ms; stop()
//                   cuts playback; stop→cancelled-resolve latency measured
//                   (<100ms budget).
//
// usage:
//   FLY545_EARS_TOKEN=... FLY545_SPEAKER_TOKEN=... \
//   FLY545_GUILD_ID=... FLY545_CHANNEL_ID=... FLY545_SPEAKER_BOT_ID=... \
//   node e2e/pr1-loop.mjs <long.mp3> <short.mp3>

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import {
	BotRegistry,
	createDiscordDeps,
	EarsReceiver,
	LeadSpeaker,
} from "../dist/index.js";

const [, , longMp3, shortMp3] = process.argv;
const {
	FLY545_EARS_TOKEN,
	FLY545_SPEAKER_TOKEN,
	FLY545_GUILD_ID,
	FLY545_CHANNEL_ID,
	FLY545_SPEAKER_BOT_ID,
} = process.env;
if (
	!FLY545_EARS_TOKEN ||
	!FLY545_SPEAKER_TOKEN ||
	!FLY545_GUILD_ID ||
	!FLY545_CHANNEL_ID ||
	!FLY545_SPEAKER_BOT_ID ||
	!longMp3 ||
	!shortMp3
) {
	console.error("missing env/args — see header comment");
	process.exit(2);
}

mkdirSync("out", { recursive: true });
const EVENTS = "out/pr1-loop-events.jsonl";
const t0 = Date.now();
const now = () => Date.now() - t0;
const log = (e) => {
	appendFileSync(EVENTS, `${JSON.stringify({ t: now(), ...e })}\n`);
	console.error(`[${now()}ms]`, e.type, e.detail ?? "");
};

const deps = await createDiscordDeps();
const registry = new BotRegistry({
	createClient: deps.createClient,
	joinVoice: deps.joinVoice,
});
await registry.start([
	{ id: "ears", token: FLY545_EARS_TOKEN },
	{ id: "speaker", token: FLY545_SPEAKER_TOKEN },
]);
log({ type: "bots-online" });

const earsConn = await registry.join("ears", {
	guildId: FLY545_GUILD_ID,
	channelId: FLY545_CHANNEL_ID,
	selfMute: true,
	selfDeaf: false,
});
const spkConn = await registry.join("speaker", {
	guildId: FLY545_GUILD_ID,
	channelId: FLY545_CHANNEL_ID,
	selfMute: false,
	selfDeaf: true,
});
log({ type: "joined-vc" });

const speaker = new LeadSpeaker({
	player: deps.createPlayer(spkConn),
	createResource: deps.createResource,
});

/** per-scenario state */
let scenario = "idle";
let stopOnBarge = false;
let bargeAt = null;
let pcmChunks = [];
const speakingLog = [];

const ears = new EarsReceiver({
	speaking: deps.speakingEvents(earsConn),
	subscribe: deps.subscribeManual(earsConn),
	createDecoder: deps.createDecoder,
	isHuman: () => false, // test guild: nobody is human; allowlist admits the speaker
	allowUserIds: [FLY545_SPEAKER_BOT_ID],
	backchannelMs: 350,
	onFrame: (frame) => {
		pcmChunks.push(Buffer.from(frame));
	},
	onSpeakingStart: (u) => {
		speakingLog.push({ scenario, event: "start", user: u, t: now() });
		log({ type: "speaking-start", detail: `${scenario} ${u}` });
	},
	onSpeakingEnd: (u) => {
		speakingLog.push({ scenario, event: "end", user: u, t: now() });
		log({ type: "speaking-end", detail: `${scenario} ${u}` });
	},
	onBargeIn: (u) => {
		bargeAt = now();
		log({
			type: "barge-in-gate-fired",
			detail: `${scenario} ${u} stop=${stopOnBarge}`,
		});
		if (stopOnBarge) speaker.stop();
	},
	onError: (err, u) =>
		log({ type: "ears-error", detail: `${u}: ${err.message}` }),
});
ears.attach();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const verdict = {};

// ── Scenario A: full receive ──────────────────────────────────────────────
scenario = "A";
stopOnBarge = false;
bargeAt = null;
pcmChunks = [];
log({ type: "scenario-start", detail: "A receive" });
const aResult = await speaker.speak({ kind: "file", path: longMp3 });
await sleep(1500); // trailing frames + speaking-end
const aPcm = Buffer.concat(pcmChunks);
writeFileSync("out/a-received-16k.pcm", aPcm);
verdict.A = {
	playbackStartMs: aResult.playbackStartMs,
	durationMs: aResult.durationMs,
	cancelled: aResult.cancelled,
	receivedPcmBytes: aPcm.length,
	receivedSeconds: +(aPcm.length / 32000).toFixed(2),
	gateFiredDuringPlayback_ms_after_start: bargeAt,
};
log({ type: "scenario-A-done", detail: JSON.stringify(verdict.A) });

// ── Scenario B: backchannel (<350ms burst must NOT fire the gate) ─────────
scenario = "B";
stopOnBarge = false;
bargeAt = null;
pcmChunks = [];
log({ type: "scenario-start", detail: "B backchannel" });
const bResult = await speaker.speak({ kind: "file", path: shortMp3 });
await sleep(2000);
const bStarts = speakingLog.filter(
	(e) => e.scenario === "B" && e.event === "start",
);
const bEnds = speakingLog.filter(
	(e) => e.scenario === "B" && e.event === "end",
);
verdict.B = {
	durationMs: bResult.durationMs,
	gateFired: bargeAt !== null,
	speakingStartSeen: bStarts.length > 0,
	speakingEndSeen: bEnds.length > 0,
	burstMs: bStarts.length && bEnds.length ? bEnds[0].t - bStarts[0].t : null,
};
log({ type: "scenario-B-done", detail: JSON.stringify(verdict.B) });

// ── Scenario C: barge-in (gate fires → stop() cuts playback) ──────────────
scenario = "C";
stopOnBarge = true;
bargeAt = null;
pcmChunks = [];
log({ type: "scenario-start", detail: "C barge-in" });
const cStartAt = now();
const cResult = await speaker.speak({ kind: "file", path: longMp3 });
const cResolvedAt = now();
await sleep(1000);
const cStart = speakingLog.find(
	(e) => e.scenario === "C" && e.event === "start",
);
verdict.C = {
	cancelled: cResult.cancelled,
	speakingStartToGate_ms:
		cStart && bargeAt !== null ? bargeAt - cStart.t : null,
	gateToCancelledResolve_ms: bargeAt !== null ? cResolvedAt - bargeAt : null,
	playedBeforeCut_ms: cResolvedAt - cStartAt,
};
log({ type: "scenario-C-done", detail: JSON.stringify(verdict.C) });

ears.detach();
await registry.destroyAll();

verdict.pass =
	verdict.A.receivedPcmBytes > 0 &&
	verdict.B.gateFired === false &&
	verdict.B.speakingStartSeen &&
	verdict.B.speakingEndSeen &&
	verdict.C.cancelled === true &&
	verdict.C.gateToCancelledResolve_ms !== null &&
	verdict.C.gateToCancelledResolve_ms < 100;
console.log(JSON.stringify(verdict, null, 2));
process.exit(verdict.pass ? 0 : 1);
