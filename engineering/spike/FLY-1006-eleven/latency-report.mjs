// FLY-1006 ② 延迟拆段分析器 — 她停口→STT finalize→brain 首 token→TTS 首帧。
// 数据源:talk 页事件(~/fly1006-eleven/talk-events.jsonl,server ts)+ shim
// jsonl(同机时钟,可直接对齐)。
//
// usage: node latency-report.mjs [talk-events.jsonl] [shim.jsonl ...]
//   缺省: ~/fly1006-eleven/talk-events.jsonl + ../FLY-980-eleven/out/shim-*.jsonl(最新)
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const readJsonl = (file) =>
	readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try {
				return JSON.parse(l);
			} catch {
				return null;
			}
		})
		.filter(Boolean);

/**
 * 按 turn 拆段。每 turn:
 *   stt_ms   = msg:user.ts − 该 turn 答案前最后一个 vad_user_stop.ts
 *   brain_ms = 窗口内 shim 请求的 first_delta_ms(req_arrival ∈ [vadStop−2s, speaking])
 *   tts_ms   = mode:speaking.ts − (req_arrival.ts + first_delta_ms)
 *   total_ms = mode:speaking.ts − vad_user_stop.ts
 * 缺 shim 匹配 → brain/tts 为 null;无 vad 事件的旧数据 → 空表。
 */
export function computeTurns(pageEvents, shimEvents) {
	const events = [...pageEvents].sort((a, b) => a.ts - b.ts);
	const reqs = {};
	for (const e of shimEvents) {
		if (!e.requestId) continue;
		reqs[e.requestId] = reqs[e.requestId] ?? {};
		if (e.type === "req_arrival") reqs[e.requestId].t_req = e.ts;
		if (e.type === "done") reqs[e.requestId].first_delta_ms = e.first_delta_ms;
	}
	const reqList = Object.values(reqs).filter(
		(r) => r.t_req != null && r.first_delta_ms != null,
	);

	const turns = [];
	const turnIds = [
		...new Set(
			events.filter((e) => e.type === "vad_user_stop").map((e) => e.turn),
		),
	];
	for (const turn of turnIds) {
		const speaking = events.find(
			(e) =>
				e.type === "mode" &&
				e.mode === "speaking" &&
				e.ts >
					Math.min(
						...events
							.filter((x) => x.type === "vad_user_stop" && x.turn === turn)
							.map((x) => x.ts),
					),
		);
		const stops = events.filter(
			(e) =>
				e.type === "vad_user_stop" &&
				e.turn === turn &&
				(!speaking || e.ts < speaking.ts),
		);
		if (stops.length === 0) continue;
		const vadStop = stops.at(-1).ts;
		const transcript = events.find(
			(e) => e.type === "msg" && e.role === "user" && e.ts >= vadStop,
		);
		const req = reqList
			.filter(
				(r) =>
					r.t_req >= vadStop - 2000 && (!speaking || r.t_req < speaking.ts),
			)
			.at(-1);
		turns.push({
			turn,
			stt_ms: transcript ? transcript.ts - vadStop : null,
			brain_ms: req ? req.first_delta_ms : null,
			tts_ms:
				req && speaking ? speaking.ts - (req.t_req + req.first_delta_ms) : null,
			total_ms: speaking ? speaking.ts - vadStop : null,
		});
	}
	return turns;
}

/** shim 单侧 brain 首 token 分布(旧数据也可用)。 */
export function computeBrainStats(shimEvents) {
	const deltas = shimEvents
		.filter((e) => e.type === "done" && typeof e.first_delta_ms === "number")
		.map((e) => e.first_delta_ms)
		.sort((a, b) => a - b);
	if (deltas.length === 0) return { n: 0 };
	return {
		n: deltas.length,
		min_ms: deltas[0],
		median_ms: deltas[Math.floor(deltas.length / 2)],
		max_ms: deltas.at(-1),
	};
}

const isMain =
	process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	const { globSync } = await import("node:fs");
	const talkFile =
		process.argv[2] ?? join(homedir(), "fly1006-eleven", "talk-events.jsonl");
	const shimFiles = process.argv.slice(3);
	if (shimFiles.length === 0) {
		const found = globSync?.("../FLY-980-eleven/out/shim-*.jsonl") ?? [];
		shimFiles.push(...found.sort().slice(-2));
	}
	const pageEvents = readJsonl(talkFile);
	const shimEvents = shimFiles.flatMap(readJsonl);
	const turns = computeTurns(pageEvents, shimEvents);
	console.log("per-turn segments (ms):");
	console.table(turns);
	console.log("shim brain first-token stats:", computeBrainStats(shimEvents));
}
