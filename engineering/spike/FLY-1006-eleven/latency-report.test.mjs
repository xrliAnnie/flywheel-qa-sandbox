// FLY-1006 ② 延迟拆段分析器合同测试(TDD: 先测后码)。
// 分段口径(Annie/Lead 91d92149):她停口(vad_user_stop) → STT finalize
// (msg:user) → brain 首 token(shim first_delta) → TTS 首帧(mode:speaking 近似)。
// run: node --test latency-report.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { computeBrainStats, computeTurns } from "./latency-report.mjs";

const PAGE = [
	{ ts: 1000, type: "vad_user_start", turn: 1 },
	{ ts: 5000, type: "vad_user_stop", turn: 1 },
	{ ts: 5900, type: "msg", role: "user", turn: 1, text: "你好" },
	{ ts: 15000, type: "mode", mode: "speaking", turn: 1 },
	// turn 2: 说到一半停了又续(两个 vad_user_stop,取答案前最后一个)
	{ ts: 20000, type: "vad_user_start", turn: 2 },
	{ ts: 22000, type: "vad_user_stop", turn: 2 },
	{ ts: 23000, type: "vad_user_start", turn: 2 },
	{ ts: 26000, type: "vad_user_stop", turn: 2 },
	{ ts: 27200, type: "msg", role: "user", turn: 2, text: "再问一句" },
	{ ts: 33000, type: "mode", mode: "speaking", turn: 2 },
];

const SHIM = [
	{ ts: 6100, type: "req_arrival", requestId: "r1" },
	{ ts: 6100, type: "done", requestId: "r1", first_delta_ms: 8000 },
	{ ts: 27400, type: "req_arrival", requestId: "r2" },
	{ ts: 27400, type: "done", requestId: "r2", first_delta_ms: 5000 },
];

test("computeTurns: per-turn segment math (stt / brain / tts / total)", () => {
	const turns = computeTurns(PAGE, SHIM);
	assert.equal(turns.length, 2);
	const [t1, t2] = turns;
	assert.equal(t1.turn, 1);
	assert.equal(t1.stt_ms, 900); // 5900-5000
	assert.equal(t1.brain_ms, 8000); // shim first_delta
	assert.equal(t1.tts_ms, 15000 - (6100 + 8000)); // speaking - (req+delta)
	assert.equal(t1.total_ms, 10000); // 15000-5000
	// turn 2 用答案前最后一个 vad_user_stop(26000,不是 22000)
	assert.equal(t2.stt_ms, 1200); // 27200-26000
	assert.equal(t2.brain_ms, 5000);
	assert.equal(t2.total_ms, 7000); // 33000-26000
});

test("computeTurns: missing shim match → brain/tts null, total still computed", () => {
	const turns = computeTurns(PAGE, []);
	assert.equal(turns[0].brain_ms, null);
	assert.equal(turns[0].tts_ms, null);
	assert.equal(turns[0].total_ms, 10000);
});

test("computeTurns: no vad events (旧数据) → empty, not a crash", () => {
	const noVad = PAGE.filter((e) => !e.type.startsWith("vad"));
	assert.deepEqual(computeTurns(noVad, SHIM), []);
});

test("computeBrainStats: first_delta distribution from shim events alone", () => {
	const stats = computeBrainStats([
		{ ts: 1, type: "done", requestId: "a", first_delta_ms: 4000 },
		{ ts: 2, type: "done", requestId: "b", first_delta_ms: 8000 },
		{ ts: 3, type: "done", requestId: "c", first_delta_ms: 12000 },
		{ ts: 4, type: "aborted", requestId: "d" },
	]);
	assert.equal(stats.n, 3);
	assert.equal(stats.median_ms, 8000);
	assert.equal(stats.min_ms, 4000);
	assert.equal(stats.max_ms, 12000);
});
