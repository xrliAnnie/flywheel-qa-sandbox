// FLY-2799 qa6 rework: listening A/B for the 24k -> 48k playback upsampler.
// Renders the same real engine B output (marin, 24 kHz mono) twice:
//   zoh.wav    - the old path, voice-bridge upsample24kMonoTo48kStereo
//   linear.wav - the new path, frames exactly as the real WaitingMouth writes them
// and measures how much energy lands above 12 kHz (the upsampling image band;
// the 24 kHz source carries nothing above 12 kHz).
// Usage: node resample-ab.mjs <assistant.pcm> <outDir> [startSeconds] [seconds]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WT = "/Users/xiaorongli/Dev/flywheel-FLY-2799";
const { upsample24kMonoTo48kStereo } = await import(`${WT}/packages/voice-bridge/dist/index.js`);
const { WaitingMouth } = await import(`${WT}/packages/voice-codex/dist/audio.js`);

const [, , input, outDir, startArg = "0", secondsArg = "15"] = process.argv;
mkdirSync(outDir, { recursive: true });
const all = readFileSync(input);
const start = Math.floor(Number(startArg) * 24_000) * 2;
const source = all.subarray(start, start + Math.floor(Number(secondsArg) * 24_000) * 2);

const zoh = upsample24kMonoTo48kStereo(source);

// New path: drive the real WaitingMouth one frame per tick, no lead.
const frames = [];
let now = 0;
let tick;
const mouth = new WaitingMouth({
	player: { play() {}, stop() {} },
	createResource: (s) => {
		s.stream.on("data", (chunk) => frames.push(chunk));
		return s;
	},
	setIntervalFn: (callback) => {
		tick = callback;
		return 1;
	},
	clearIntervalFn: () => undefined,
	now: () => now,
	speechLeadFrames: 0,
	idleLeadFrames: 0,
});
mouth.start();
const done = mouth.playSpeech("ab", source);
const total = Math.ceil(source.length / 960);
for (let i = 0; i < total; i += 1) {
	now += 20;
	tick();
	await Promise.resolve();
}
await done;
mouth.stop();
await new Promise((r) => setImmediate(r));
const linear = Buffer.concat(frames).subarray(0, zoh.length);

function wav(pcm48Stereo) {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcm48Stereo.length, 4);
	header.write("WAVEfmt ", 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(2, 22);
	header.writeUInt32LE(48_000, 24);
	header.writeUInt32LE(48_000 * 4, 28);
	header.writeUInt16LE(4, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcm48Stereo.length, 40);
	return Buffer.concat([header, pcm48Stereo]);
}
writeFileSync(join(outDir, "zoh.wav"), wav(zoh));
writeFileSync(join(outDir, "linear.wav"), wav(linear));

// Power spectrum of the left channel, 4096-point Hann-windowed frames.
function fft(re, im) {
	const n = re.length;
	for (let i = 1, j = 0; i < n; i += 1) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			[re[i], re[j]] = [re[j], re[i]];
			[im[i], im[j]] = [im[j], im[i]];
		}
	}
	for (let len = 2; len <= n; len <<= 1) {
		const angle = (-2 * Math.PI) / len;
		for (let i = 0; i < n; i += len) {
			for (let k = 0; k < len / 2; k += 1) {
				const wr = Math.cos(angle * k);
				const wi = Math.sin(angle * k);
				const ur = re[i + k];
				const ui = im[i + k];
				const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
				const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
				re[i + k] = ur + vr;
				im[i + k] = ui + vi;
				re[i + k + len / 2] = ur - vr;
				im[i + k + len / 2] = ui - vi;
			}
		}
	}
}
function bands(pcm48Stereo) {
	const N = 4096;
	const samples = pcm48Stereo.length / 4;
	let totalPower = 0;
	let above12 = 0;
	let above16 = 0;
	for (let offset = 0; offset + N <= samples; offset += N) {
		const re = new Float64Array(N);
		const im = new Float64Array(N);
		for (let i = 0; i < N; i += 1) {
			const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
			re[i] = pcm48Stereo.readInt16LE((offset + i) * 4) * hann;
		}
		fft(re, im);
		for (let bin = 1; bin < N / 2; bin += 1) {
			const power = re[bin] ** 2 + im[bin] ** 2;
			const hz = (bin * 48_000) / N;
			totalPower += power;
			if (hz >= 12_000) above12 += power;
			if (hz >= 16_000) above16 += power;
		}
	}
	const db = (part) => Number((10 * Math.log10(part / totalPower)).toFixed(1));
	return { above12kHzDb: db(above12), above16kHzDb: db(above16) };
}
const summary = {
	input,
	startSeconds: Number(startArg),
	seconds: source.length / 48_000,
	zoh: bands(zoh),
	linear: bands(linear),
	note: "dB relative to total left-channel power; the 24 kHz source has no content above 12 kHz, so energy there is upsampling image",
};
writeFileSync(join(outDir, "resample-ab.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
