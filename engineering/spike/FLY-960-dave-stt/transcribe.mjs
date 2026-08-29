// usage: node transcribe.mjs out/xxx.wav > out/xxx.txt
import { existsSync, readFileSync } from "node:fs";

const [, , wavPath] = process.argv;
const key = process.env.GEMINI_API_KEY;
if (!key) {
	console.error("FATAL: GEMINI_API_KEY 未设置 — 按 plan Step 0.3 解析链装载");
	process.exit(2);
}
if (!wavPath || !existsSync(wavPath)) {
	console.error(`FATAL: wav 不存在: ${wavPath}`);
	process.exit(2);
}
const b64 = readFileSync(wavPath).toString("base64");
const res = await fetch(
	`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
	{
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			contents: [
				{
					parts: [
						{ text: "逐字转写这段音频(中英混说,保留英文原词),只输出转写文本:" },
						{ inlineData: { mimeType: "audio/wav", data: b64 } },
					],
				},
			],
		}),
	},
);
const j = await res.json();
if (!res.ok) {
	console.error(JSON.stringify(j));
	process.exit(1);
}
console.log(
	j.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "",
);
