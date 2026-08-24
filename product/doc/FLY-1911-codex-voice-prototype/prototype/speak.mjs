/* 把一句话合成成 48k 立体声 PCM,并且【在念出来之前】就把停顿位置算好。
 * ⇒ 那段音频是我们自己生成的,所以「切在最近的自然停顿」不需要做停顿检测。
 * ⛔ 它绝不进 outPcmQ —— 进队列就是排队,会把它自己的答案往后推。*/
import { execFile } from "node:child_process";
import { unlink } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const SR = 48000,
	FRAME_MS = 20;

/** 用 macOS 的中文合成音念一句话 ⇒ 48k 立体声 16bit PCM */
export async function synth(text, voice = "Flo (Chinese (China mainland))") {
	const stamp = `${process.pid}-${(process.hrtime.bigint() % 1000000n).toString()}`;
	const aiff = `/tmp/fly1911-say-${stamp}.aiff`;
	await run("say", ["-v", voice, "-o", aiff, text]);
	const { stdout } = await run(
		"/bin/sh",
		[
			"-c",
			`ffmpeg -v error -i ${aiff} -f s16le -acodec pcm_s16le -ar ${SR} -ac 2 - | base64`,
		],
		{ maxBuffer: 1 << 28 },
	);
	await unlink(aiff).catch(() => {});
	return Buffer.from(stdout, "base64");
}

/** 停顿位置(样本下标):连续 ≥120ms 低于本底的地方,取它的起点 */
export function findPauses(pcm) {
	const n = pcm.length / 4,
		win = Math.round(SR * 0.02),
		out = [];
	const rms = [];
	for (let i = 0; i + win <= n; i += win) {
		let s = 0;
		for (let k = 0; k < win; k++) {
			const v = pcm.readInt16LE((i + k) * 4);
			s += v * v;
		}
		rms.push(Math.sqrt(s / win));
	}
	if (!rms.length) return out;
	const sorted = [...rms].sort((a, b) => a - b);
	const floor = sorted[Math.floor(sorted.length * 0.2)];
	const thr = Math.max(floor * 2.5, sorted[sorted.length - 1] * 0.06);
	let runStart = -1;
	for (let i = 0; i < rms.length; i++) {
		if (rms[i] < thr) {
			if (runStart < 0) runStart = i;
		} else {
			if (runStart >= 0 && (i - runStart) * 20 >= 120) out.push(runStart * win);
			runStart = -1;
		}
	}
	if (runStart >= 0 && (rms.length - runStart) * 20 >= 120)
		out.push(runStart * win);
	return out;
}

export const SAY_FRAME_MS = FRAME_MS;
