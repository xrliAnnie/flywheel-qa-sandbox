// QA·FLY-545 (Opus, three-stage QA phase) — independent offline codec+resample
// chain verification for acceptance A3's core technical claim ("完整 mp3→opus
// 依赖链"), WITHOUT a live Discord VC or a Gemini key. This is the part unit
// tests (synthetic-waveform mocks) structurally cannot cover.
//
//   real edge-tts Chinese mp3
//     → ffmpeg decode → 48kHz stereo s16le PCM        (LeadSpeaker playback source shape)
//     → prism.opus.Encoder(48k/2/960)  → opus packets (the Discord wire encode)
//     → prism.opus.Decoder(48k/2/960)  → 48kHz stereo (discordWiring receive params, verbatim)
//     → StereoDownmixDecimator (REAL dist module) → 16kHz mono s16le (Gemini input)
//
// Verdict checks:
//   1. output is well-formed 16k mono s16le (even byte length, non-empty)
//   2. duration is within tolerance of the source speech (resample preserves length)
//   3. energy envelope is non-silent (real speech RMS, far above the noise floor)
//   4. envelope is speech-shaped (louder middle than the quiet head/tail)
//   5. split-stream byte-identity holds on the REAL opus-decoded stream — awful
//      misaligned chunk boundaries produce byte-identical 16k output vs one push.
//
// usage:  cd packages/voice-bridge && npx tsc && node e2e/qa-codec-chain.mjs <edge-tts.mp3>
import { spawnSync } from "node:child_process";
import { StereoDownmixDecimator } from "../dist/index.js";

const mp3 = process.argv[2];
if (!mp3) {
	console.error("usage: node e2e/qa-codec-chain.mjs <edge-tts.mp3>");
	process.exit(2);
}

const prismMod = await import("prism-media");
const prism = prismMod.default ?? prismMod;

// 1. real ffmpeg: mp3 → 48kHz stereo s16le PCM (raw).
const ff = spawnSync(
	"ffmpeg",
	[
		"-hide_banner",
		"-loglevel",
		"error",
		"-i",
		mp3,
		"-f",
		"s16le",
		"-ar",
		"48000",
		"-ac",
		"2",
		"pipe:1",
	],
	{ maxBuffer: 256 * 1024 * 1024 },
);
if (ff.status !== 0) {
	console.error("ffmpeg failed:", ff.stderr?.toString());
	process.exit(1);
}
const pcm48stereo = ff.stdout;
const srcDurSec = pcm48stereo.length / (48000 * 2 * 2);
console.log(
	`[1] ffmpeg mp3→48k stereo: ${pcm48stereo.length} bytes = ${srcDurSec.toFixed(2)}s`,
);

// 2+3. prism opus encode → decode (real codec, discordWiring params verbatim).
async function opusRoundTrip(pcm) {
	const enc = new prism.opus.Encoder({
		rate: 48000,
		channels: 2,
		frameSize: 960,
	});
	const dec = new prism.opus.Decoder({
		rate: 48000,
		channels: 2,
		frameSize: 960,
	});
	const out = [];
	dec.on("data", (b) => out.push(b));
	enc.pipe(dec);
	const frameBytes = 960 * 2 * 2; // 20ms @ 48k stereo s16
	for (let off = 0; off + frameBytes <= pcm.length; off += frameBytes) {
		enc.write(pcm.subarray(off, off + frameBytes));
	}
	enc.end();
	await new Promise((r) => dec.on("end", r));
	return Buffer.concat(out);
}
const pcm48decoded = await opusRoundTrip(pcm48stereo);
console.log(
	`[2/3] prism opus encode→decode: ${pcm48decoded.length} bytes 48k stereo`,
);

// 4. REAL StereoDownmixDecimator: 48k stereo → 16k mono (single push).
const single = new StereoDownmixDecimator().push(pcm48decoded);
const outDurSec = single.length / (16000 * 2);
console.log(
	`[4] downmix→16k mono: ${single.length} bytes = ${outDurSec.toFixed(2)}s`,
);

// 5. split-stream byte-identity on the REAL decoded stream (misaligned splits).
function splitPush(buf, sizes) {
	const d = new StereoDownmixDecimator();
	const parts = [];
	let off = 0;
	for (const s of sizes) {
		parts.push(d.push(buf.subarray(off, off + s)));
		off += s;
	}
	if (off < buf.length) parts.push(d.push(buf.subarray(off)));
	return Buffer.concat(parts);
}
const split = splitPush(pcm48decoded, [1, 7, 13, 4093, 65537, 3, 999983]);
const splitIdentical = split.equals(single);

// energy envelope: RMS overall + per-third (speech = quiet edges, loud middle).
function rms(buf) {
	let sum = 0;
	const n = buf.length / 2;
	for (let i = 0; i < buf.length; i += 2) {
		const s = buf.readInt16LE(i);
		sum += s * s;
	}
	return Math.sqrt(sum / n);
}
const third = Math.floor(single.length / 3) & ~1;
const rmsAll = rms(single);
const rmsHead = rms(single.subarray(0, third));
const rmsMid = rms(single.subarray(third, 2 * third));
const rmsTail = rms(single.subarray(2 * third));
console.log(
	`[energy] RMS all=${rmsAll.toFixed(0)} head=${rmsHead.toFixed(0)} mid=${rmsMid.toFixed(0)} tail=${rmsTail.toFixed(0)}`,
);

const checks = {
	wellFormed16kMono: single.length % 2 === 0 && single.length > 0,
	durationWithinTolerance: Math.abs(outDurSec - srcDurSec) < 0.15,
	nonSilent: rmsAll > 200,
	speechShaped: rmsMid > rmsHead && rmsMid > rmsTail,
	splitStreamByteIdentical: splitIdentical,
};
console.log("\n=== CHECKS ===");
let pass = true;
for (const [k, v] of Object.entries(checks)) {
	console.log(`  ${v ? "PASS" : "FAIL"}  ${k}`);
	if (!v) pass = false;
}
console.log(`\nVERDICT: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
