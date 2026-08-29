// FLY-968 公共事件记录器 — S1 同款口径:进程内单调时钟(t0 相对 ms)、jsonl 追加、
// speech-end 锚点由各脚本自记。key 绝不落日志。
import { appendFileSync, mkdirSync } from "node:fs";

export function makeLogger(file) {
	mkdirSync("out", { recursive: true });
	const t0 = Date.now();
	const now = () => Date.now() - t0;
	const logEvent = (e) =>
		appendFileSync(file, `${JSON.stringify({ t: now(), ...e })}\n`);
	return { now, logEvent };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 20ms 帧节奏实时推 PCM(S1 同款)。frameBytes: 16k=640, 24k=960。
export async function streamPcm(sendFrame, pcmBuf, frameBytes, frameMs = 20) {
	for (let off = 0; off < pcmBuf.length; off += frameBytes) {
		sendFrame(pcmBuf.subarray(off, off + frameBytes));
		await sleep(frameMs);
	}
}

// 把 s16le mono PCM 包成 WAV 落盘(听感评审素材用)。
export function pcmToWav(pcmBuf, sampleRate) {
	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + pcmBuf.length, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(pcmBuf.length, 40);
	return Buffer.concat([header, pcmBuf]);
}
