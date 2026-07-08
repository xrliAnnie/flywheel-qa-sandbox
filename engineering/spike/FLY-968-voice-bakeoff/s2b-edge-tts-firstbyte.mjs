// FLY-968 P1 补充 — edge-tts 首字节口径(V2 修正):
// edge-tts 走 websocket 流式下发,CLI 逐块写文件 → 「本地可播首字节」= 文件首次非空时刻,
// 而非全合成完成。对 P1 实测的三个首句各量 3 次,取 median。
// usage: node s2b-edge-tts-firstbyte.mjs
import { spawn } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { sleep } from "./lib/events.mjs";

const SENTENCES = [
	"现在还不能直接确认。",
	"我先快速理一下你说的这两件事，然后再告诉你这边能做到什么。",
	"我这边查不到实际环境的开关和状态。",
];

async function probe(text, outFile) {
	const t0 = Date.now();
	const p = spawn("edge-tts", [
		"--voice",
		"zh-CN-YunxiNeural",
		"--text",
		text,
		"--write-media",
		outFile,
	]);
	let firstByteMs = null;
	const done = new Promise((resolve, reject) => {
		p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`exit ${c}`))));
		p.on("error", reject);
	});
	const poller = (async () => {
		while (firstByteMs === null) {
			if (existsSync(outFile) && statSync(outFile).size > 0)
				firstByteMs = Date.now() - t0;
			else await sleep(5);
		}
	})();
	await done;
	await poller;
	return { firstByteMs, totalMs: Date.now() - t0 };
}

const results = [];
for (const [i, text] of SENTENCES.entries()) {
	for (let run = 0; run < 3; run++) {
		const r = await probe(text, `out/s2b-${i}-${run}.mp3`);
		results.push({ sentence: i, run, chars: text.length, ...r });
		console.error(
			`[s${i} r${run}] firstByte=${r.firstByteMs}ms total=${r.totalMs}ms`,
		);
	}
}
writeFileSync(
	"out/s2b-firstbyte-results.json",
	JSON.stringify(results, null, 2),
);
const fbs = results.map((r) => r.firstByteMs).sort((a, b) => a - b);
console.log(
	JSON.stringify({
		median_firstByte_ms: fbs[Math.floor(fbs.length / 2)],
		all: fbs,
	}),
);
