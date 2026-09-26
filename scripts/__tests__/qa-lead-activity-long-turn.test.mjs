import assert from "node:assert/strict";
import { homedir } from "node:os";
import { describe, it } from "node:test";
import {
	chatIngestInvocation,
	EXIT,
	evaluateLongTurn,
	FixtureError,
	loadRoom,
	longTurnPrompt,
	parseArgs,
	runLongTurn,
	syntheticMessageId,
	toSample,
} from "../qa-lead-activity-long-turn.mjs";

const T0 = Date.parse("2026-09-26T01:00:00.000Z");
const SLOT = "/tmp/flywheel-test-slot-2";

const idle = (atMs) => ({
	at: new Date(atMs).toISOString(),
	atMs,
	state: "idle",
});
const busy = (
	atMs,
	startedAtMs,
	trigger = { kind: "undetermined", reason: "causality_unproven" },
) => ({
	at: new Date(atMs).toISOString(),
	atMs,
	state: "busy",
	startedAt: new Date(startedAtMs).toISOString(),
	startedAtMs,
	elapsedMs: atMs - startedAtMs,
	precision: "second",
	trigger,
});
const unknown = (atMs, reason) => ({
	at: new Date(atMs).toISOString(),
	atMs,
	state: "unknown",
	reason,
});

/** One honored 75 s turn that starts 3 s after injection, sampled every 5 s. */
function honoredRun(startDelayMs = 3_000, holdMs = 78_000) {
	const start = T0 + startDelayMs;
	const samples = [idle(T0 - 5_000)];
	for (let at = T0 + 5_000; at < start + holdMs; at += 5_000)
		samples.push(busy(at, start));
	samples.push(idle(start + holdMs + 2_000));
	return samples;
}

describe("evaluateLongTurn", () => {
	const judge = (samples, truthStartMs = T0 + 2_000, extra = {}) =>
		evaluateLongTurn({
			samples,
			injectedAtMs: T0,
			truthStartMs,
			holdMs: 75_000,
			...extra,
		});

	it("passes a turn seen busy ≥60 s on the fixture clock, bracketed by idle, start within 30 s", () => {
		const result = judge(honoredRun());
		assert.equal(result.verdict, "pass");
		assert.equal(result.checks.longTurnObserved, true);
		assert.equal(result.checks.startErrorMs, 1_000);
		assert.ok(result.turn.observedBusyMs >= 60_000);
	});

	it("fails when every busy answer reports a start more than 30 s from the true start", () => {
		const result = judge(honoredRun(), T0 + 40_000);
		assert.equal(result.verdict, "fail");
		assert.equal(result.why, "no_busy_for_the_fixture_turn");
	});

	it("fails when the endpoint answers idle in the middle of the turn", () => {
		const samples = honoredRun();
		samples.splice(6, 1, idle(samples[6].atMs));
		const result = judge(samples);
		assert.equal(result.verdict, "fail");
		assert.deepEqual(result.insideAnswers, ["idle"]);
	});

	it("fails when the endpoint answers unknown in the middle of the turn", () => {
		const samples = honoredRun();
		samples.splice(6, 1, unknown(samples[6].atMs, "pane_capture_failed"));
		const result = judge(samples);
		assert.equal(result.verdict, "fail");
		assert.deepEqual(result.insideAnswers, ["unknown:pane_capture_failed"]);
	});

	it("fails — never passes — when unknown covers the turn and one late busy reports a long elapsed", () => {
		// Review finding: the endpoint's own elapsedMs must not stand in for observation.
		const samples = [idle(T0 - 5_000)];
		for (let at = T0 + 5_000; at <= T0 + 60_000; at += 5_000)
			samples.push(unknown(at, "pane_unrecognized"));
		samples.push(
			busy(T0 + 65_000, T0 + 2_000),
			idle(T0 + 70_000),
			idle(T0 + 80_000),
		);
		const result = judge(samples);
		assert.equal(result.verdict, "fail");
		assert.ok(result.insideAnswers.includes("unknown:pane_unrecognized"));
	});

	it("does not count a long self-reported elapsed that the fixture did not observe", () => {
		// Reported start 27 s before the true start (inside tolerance): elapsed says 72 s,
		// but the fixture only saw busy for 45 s after delivery.
		const samples = [idle(T0 - 5_000)];
		for (let at = T0 + 5_000; at <= T0 + 47_000; at += 5_000)
			samples.push(busy(at, T0 - 25_000));
		samples.push(idle(T0 + 90_000));
		const result = judge(samples);
		assert.equal(result.verdict, "inconclusive");
		assert.match(result.why, /longTurnObserved/);
	});

	it("does not pass a 56 s turn that the start-up wait would pad to 60 s (review R2)", () => {
		// Delivered at T, busy 10–66 s, idle from 70 s: T→last busy is 65 s, but the
		// fixture only ever saw 55 s of busy and the Lead went idle before the 75 s hold.
		const truth = T0 + 1_000;
		const samples = [idle(T0 - 5_000), idle(truth + 5_000)];
		for (let at = truth + 10_000; at <= truth + 65_000; at += 5_000)
			samples.push(busy(at, truth + 10_000));
		samples.push(idle(truth + 70_000), idle(truth + 75_000));
		const result = judge(samples, truth);
		assert.equal(result.verdict, "inconclusive");
		assert.match(result.why, /longTurnObserved/);
		assert.equal(result.checks.idleBeforeHoldEnd, true);
	});

	it("does not pass a ≥60 s turn that still went idle before the requested hold ended", () => {
		const samples = [idle(T0 - 5_000)];
		for (let at = T0 + 5_000; at <= T0 + 70_000; at += 5_000)
			samples.push(busy(at, T0 + 3_000));
		samples.push(idle(T0 + 72_000), idle(T0 + 90_000));
		const result = judge(samples);
		assert.equal(result.checks.longTurnObserved, true);
		assert.equal(result.verdict, "inconclusive");
		assert.match(result.why, /idleBeforeHoldEnd/);
	});

	it("does not let a busy read before delivery, from another turn, pad the span (review R3)", () => {
		// --poll-seconds 30: delivered at 35 s; another turn ran 25–33 s; the
		// fixture turn ran 40–96 s (56 s). The 30 s sample must not count.
		const truth = T0 + 35_000;
		const samples = [
			idle(T0 - 5_000),
			busy(T0 + 30_000, T0 + 25_000),
			busy(T0 + 60_000, T0 + 40_000),
			busy(T0 + 90_000, T0 + 40_000),
			idle(T0 + 120_000),
		];
		const result = judge(samples, truth);
		assert.notEqual(result.verdict, "pass");
		assert.equal(result.checks.longTurnObserved, false);
		assert.equal(result.turn.firstBusyAt, new Date(T0 + 60_000).toISOString());
	});

	it("fails when, inside the turn, the endpoint reports a different start", () => {
		const samples = honoredRun();
		samples.splice(8, 1, busy(samples[8].atMs, T0 + 20_000));
		const result = judge(samples);
		assert.equal(result.verdict, "fail");
		assert.deepEqual(result.insideAnswers, ["busy"]);
	});

	it("fails when the start changes near the end and never comes back (review R4)", () => {
		// Busy (start 3 s) 5–65 s, unknown at 70 s, busy (start 20 s) 75/80 s, idle 85 s:
		// the checked window must run to the idle, not stop at the last stable busy.
		const samples = [idle(T0 - 5_000)];
		for (let at = T0 + 5_000; at <= T0 + 65_000; at += 5_000)
			samples.push(busy(at, T0 + 3_000));
		samples.push(
			unknown(T0 + 70_000, "pane_unrecognized"),
			busy(T0 + 75_000, T0 + 20_000),
			busy(T0 + 80_000, T0 + 20_000),
			idle(T0 + 85_000),
		);
		const result = judge(samples);
		assert.equal(result.verdict, "fail");
		assert.deepEqual(result.insideAnswers, [
			"unknown:pane_unrecognized",
			"busy",
			"busy",
		]);
	});

	it("fails when non-busy answers sit between the last busy and the closing idle", () => {
		const samples = honoredRun();
		samples.splice(
			samples.length - 1,
			0,
			unknown(T0 + 81_000, "pane_capture_failed"),
		);
		assert.equal(judge(samples).verdict, "fail");
	});

	it("fails when a non-busy answer arrives after the turn but no idle ever closes it", () => {
		const samples = honoredRun().slice(0, -1);
		samples.push(unknown(T0 + 90_000, "pane_capture_failed"));
		assert.equal(judge(samples).verdict, "fail");
	});

	it("does not count busy time across an idle inside the grace (review R5)", () => {
		// Busy at 5 s, idle at 10/15 s, busy 20–75 s, idle 80 s (all start 3 s):
		// the longest contiguous busy the fixture saw is 55 s, not 70 s.
		const samples = [
			idle(T0 - 5_000),
			busy(T0 + 5_000, T0 + 3_000),
			idle(T0 + 10_000),
			idle(T0 + 15_000),
		];
		for (let at = T0 + 20_000; at <= T0 + 75_000; at += 5_000)
			samples.push(busy(at, T0 + 3_000));
		samples.push(idle(T0 + 80_000));
		const result = judge(samples);
		assert.notEqual(result.verdict, "pass");
		assert.equal(result.checks.longTurnObserved, false);
		assert.equal(result.turn.firstBusyAt, new Date(T0 + 20_000).toISOString());
		assert.equal(
			passInvariantViolation(samples, T0, T0 + 2_000, 75_000),
			"span < 60 s",
		);
	});

	it("fails, and the invariant objects, when a busy counted from the grace carries an issue (review R6)", () => {
		const samples = [idle(T0 - 5_000)];
		for (let at = T0 + 5_000; at <= T0 + 75_000; at += 5_000)
			samples.push(
				busy(
					at,
					T0 + 3_000,
					at === T0 + 15_000 ? { kind: "issue", issueId: "FLY-1" } : undefined,
				),
			);
		samples.push(idle(T0 + 80_000));
		assert.equal(judge(samples).verdict, "fail");
		assert.equal(
			passInvariantViolation(samples, T0, T0 + 2_000, 75_000),
			"issue attributed",
		);
	});

	it("fails, and the invariant objects, when one counted busy breaks the 30 s start bound (review R6)", () => {
		const samples = [idle(T0 - 5_000)];
		for (let at = T0 + 5_000; at <= T0 + 75_000; at += 5_000)
			samples.push(busy(at, at === T0 + 75_000 ? T0 - 32_000 : T0 - 27_000));
		samples.push(idle(T0 + 80_000));
		assert.equal(judge(samples).verdict, "fail");
		assert.equal(
			passInvariantViolation(samples, T0, T0 + 2_000, 75_000),
			"start error > 30 s",
		);
	});

	it("fails when a chat-triggered turn is attributed to an issue", () => {
		const start = T0 + 3_000;
		const samples = [
			idle(T0 - 5_000),
			busy(T0 + 70_000, start, { kind: "issue", issueId: "FLY-1" }),
			idle(T0 + 90_000),
		];
		assert.equal(judge(samples).verdict, "fail");
	});

	it("fails when the Lead never reads busy and the endpoint answered unknown after the grace", () => {
		const samples = [
			idle(T0 - 5_000),
			unknown(T0 + 20_000, "lead_window_unavailable"),
			unknown(T0 + 25_000, "lead_window_unavailable"),
		];
		const result = judge(samples, T0);
		assert.equal(result.verdict, "fail");
		assert.deepEqual(result.answers, ["unknown:lead_window_unavailable"]);
	});

	it("does not judge answers inside the delivery grace", () => {
		const samples = honoredRun();
		samples.splice(1, 0, unknown(T0 + 4_000, "pane_capture_failed"));
		assert.equal(judge(samples).verdict, "pass");
	});

	it("is inconclusive — not a pass — when the Lead did not honor the 60 s hold", () => {
		const result = judge(honoredRun(3_000, 20_000));
		assert.equal(result.verdict, "inconclusive");
		assert.match(result.why, /longTurnObserved/);
		assert.equal(result.checks.idleBeforeHoldEnd, true);
	});

	it("is inconclusive without an idle baseline or an idle after the turn", () => {
		assert.equal(judge(honoredRun().slice(1)).verdict, "inconclusive");
		assert.equal(judge(honoredRun().slice(0, -1)).verdict, "inconclusive");
	});

	it("is inconclusive without delivery evidence, even if some long turn is visible", () => {
		const result = judge(honoredRun(), Number.NaN);
		assert.equal(result.verdict, "inconclusive");
		assert.equal(result.why, "no_delivery_evidence");
	});

	it("ignores an earlier, unrelated busy turn read before the grace", () => {
		const samples = honoredRun();
		samples.splice(1, 0, busy(T0 + 1_000, T0 - 60_000));
		assert.equal(judge(samples).verdict, "pass");
	});
});

/**
 * What a PASS must mean, stated independently of the evaluator: from truth+15 s
 * the answers are one contiguous run of busy with one start (±5 s, within 30 s
 * of truth), closed by an idle no earlier than the hold end and never
 * contradicted by that turn's busy afterwards; the fixture saw that turn busy
 * for an unbroken ≥60 s after delivery; no issue attributed; idle before
 * injection.
 */
function passInvariantViolation(samples, injectedAtMs, truth, holdMs) {
	const sorted = [...samples].sort((a, b) => a.atMs - b.atMs);
	if (!sorted.some((s) => s.atMs <= injectedAtMs && s.state === "idle"))
		return "no idle before injection";
	const judged = sorted.filter((s) => s.atMs >= truth + 15_000);
	const close = judged.findIndex((s) => s.state === "idle");
	if (close < 0) return "no closing idle";
	const run = judged.slice(0, close);
	if (run.length === 0 || !run.every((s) => s.state === "busy"))
		return "non-busy before close";
	const s0 = run[0].startedAtMs;
	if (!run.every((s) => Math.abs(s.startedAtMs - s0) <= 5_000))
		return "start not stable";
	if (judged[close].atMs < truth + holdMs) return "closed before hold end";
	if (
		judged
			.slice(close + 1)
			.some((s) => s.state === "busy" && Math.abs(s.startedAtMs - s0) <= 5_000)
	)
		return "turn busy after closing idle";
	// Span = the unbroken stretch of this turn's busy (read after delivery)
	// that ends at the run's last busy; any other answer, even in the grace, cuts it.
	let k = sorted.indexOf(run.at(-1));
	while (
		k > 0 &&
		sorted[k - 1].state === "busy" &&
		sorted[k - 1].atMs >= truth &&
		Math.abs(sorted[k - 1].startedAtMs - s0) <= 5_000
	)
		k--;
	if (run.at(-1).atMs - sorted[k].atMs < 60_000) return "span < 60 s";
	// Every busy that counts — the run and the stretch it extends back into the
	// grace — must meet the 30 s start bound and carry no issue (review R6).
	const counted = new Set([
		...sorted.slice(k, sorted.indexOf(run.at(-1)) + 1),
		...run,
	]);
	if ([...counted].some((s) => Math.abs(s.startedAtMs - truth) > 30_000))
		return "start error > 30 s";
	if (![...counted].every((s) => s.trigger?.kind === "undetermined"))
		return "issue attributed";
	return null;
}

describe("evaluateLongTurn — seeded property check", () => {
	it("never returns PASS unless the independent PASS invariant holds", () => {
		let seed = 12_345;
		const rnd = () => {
			seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
			return seed / 2 ** 31;
		};
		const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
		let passes = 0;
		for (let n = 0; n < 3_000; n++) {
			const poll = pick([2_000, 5_000, 10_000, 30_000]);
			const truth = T0 + pick([0, 500, 2_000, 10_000, 35_000]);
			const holdMs = pick([65_000, 75_000, 90_000]);
			const starts = [-60_000, -25_000, 0, 3_000, 10_000, 20_000, 40_000].map(
				(d) => truth + d,
			);
			// Continuous, early-biased draws so boundaries (60 s span, hold end,
			// a short interruption inside the grace) are actually explored.
			const realStart = truth + Math.round(rnd() ** 2 * 25_000);
			const realEnd = realStart + 40_000 + Math.round(rnd() * 60_000);
			// Half the runs: one clean turn with a short structured interruption;
			// the other half: 15 % random corruption of every answer.
			const structured = rnd() < 0.5;
			const gapAt = realStart + Math.round(rnd() ** 2 * 60_000);
			const gapEnd = gapAt + pick([1, 2, 3]) * poll;
			const gapKind = pick(["idle", "unknown", "http_500"]);
			const odd = (at, kind) =>
				kind === "idle"
					? idle(at)
					: kind === "unknown"
						? unknown(at, "x")
						: { at: new Date(at).toISOString(), atMs: at, state: kind };
			const samples = [];
			for (let at = T0 - poll; at <= T0 + 200_000; at += poll) {
				const real = at >= realStart && at < realEnd;
				let sample;
				if (structured) {
					sample =
						real && at >= gapAt && at < gapEnd
							? odd(at, gapKind)
							: real
								? busy(at, realStart)
								: idle(at);
				} else if (rnd() < 0.15) {
					const kind = pick(["idle", "busy", "unknown", "http_500"]);
					sample = kind === "busy" ? busy(at, pick(starts)) : odd(at, kind);
				} else {
					sample = real ? busy(at, realStart) : idle(at);
				}
				if (sample.state === "busy" && rnd() < 0.02)
					sample.trigger = { kind: "issue", issueId: "FLY-1" };
				samples.push(sample);
			}
			const result = evaluateLongTurn({
				samples,
				injectedAtMs: T0,
				truthStartMs: truth,
				holdMs,
			});
			if (result.verdict !== "pass") continue;
			passes++;
			assert.equal(
				passInvariantViolation(samples, T0, truth, holdMs),
				null,
				JSON.stringify({ n, poll, truth: truth - T0, holdMs }),
			);
		}
		assert.ok(passes > 100, `the generator must exercise PASS (got ${passes})`);
	});
});

describe("fixture inputs", () => {
	it("parses a strict argument set", () => {
		assert.deepEqual(
			{
				...parseArgs([
					"--slot",
					"2",
					"--agent",
					"flywheel-test-3",
					"--hold-seconds",
					"90",
					"--no-warmup",
				]),
			},
			{
				slot: 2,
				agent: "flywheel-test-3",
				holdSeconds: 90,
				pollSeconds: 5,
				settleSeconds: 240,
				warmup: false,
				authorId: undefined,
				authorName: undefined,
				out: undefined,
			},
		);
		for (const bad of [
			[],
			["--slot", "2"],
			["--slot", "x", "--agent", "a"],
			["--slot", "2", "--agent", "a", "--hold-seconds", "30"],
			["--slot", "2", "--agent", "a", "--out", "rel.json"],
			["--slot", "2", "--agent", "a", "--bogus"],
		]) {
			assert.throws(() => parseArgs(bad), FixtureError);
		}
	});

	it("asks for a hold long enough to prove the 60 s criterion", () => {
		assert.throws(
			() => parseArgs(["--slot", "2", "--agent", "a", "--hold-seconds", "60"]),
			FixtureError,
		);
		const prompt = longTurnPrompt("abc", 75);
		// Claude Code refuses a standalone `sleep`; the Lead then backgrounds a
		// timer and the turn ends in ~30 s (QA@2 claim 1599). Never ask for one.
		assert.doesNotMatch(prompt, /(^|[\s`:])sleep \d/m);
		assert.match(prompt, /python3 -c "import time; time\.sleep\(75\)"/);
		assert.match(prompt, /135000 ms/);
		assert.match(prompt, /FLY-2882 long-turn abc done/);
	});

	it("mints a Discord-shaped, time-ordered message id", () => {
		const a = syntheticMessageId(T0, Buffer.from([0, 0, 1]));
		const b = syntheticMessageId(T0 + 1, Buffer.from([0, 0, 1]));
		assert.match(a, /^\d{17,20}$/);
		assert.ok(BigInt(b) > BigInt(a));
	});

	it("projects an endpoint answer to state/time/source/reason fields only", () => {
		const sample = toSample(T0, {
			schema: "lead-activity.v1",
			projectName: "p",
			leadId: "l",
			carrier: "codex-app-server",
			observedAt: new Date(T0).toISOString(),
			source: "codex_sidecar",
			state: "busy",
			turn: {
				startedAt: new Date(T0 - 5_000).toISOString(),
				elapsedMs: 5_000,
				precision: "second",
				origin: "message",
			},
			trigger: {
				kind: "undetermined",
				reason: "unmapped_delivery",
				detail: "判断不了",
			},
		});
		assert.deepEqual(Object.keys(sample).sort(), [
			"at",
			"atMs",
			"elapsedMs",
			"precision",
			"source",
			"startedAt",
			"startedAtMs",
			"state",
			"trigger",
		]);
		assert.deepEqual(sample.trigger, {
			kind: "undetermined",
			reason: "unmapped_delivery",
		});
	});

	it("loads the room from its own artifacts and refuses a non-private token", () => {
		const files = {
			[`${SLOT}/launchd/flywheel-test-3/lead-coordinates.json`]: JSON.stringify(
				{
					agentId: "flywheel-test-3",
					carrier: "claude-code",
					projectName: "test-slot-2",
					commDbPath: `${SLOT}/state/comm/test-slot-2/comm.db`,
					primaryChatChannelId: "123",
					botUserId: "999",
				},
			),
			[`${SLOT}/bridge-launch.json`]: JSON.stringify({
				bridgeUrl: "http://localhost:19872",
			}),
			[`${SLOT}/state/api-token`]: "tok\n",
		};
		const deps = { readFile: (path) => files[path], isPrivateFile: () => true };
		const room = loadRoom({ slot: 2, agent: "flywheel-test-3" }, deps);
		assert.equal(room.bridgeUrl, "http://localhost:19872");
		assert.equal(room.token, "tok");
		assert.throws(
			() =>
				loadRoom(
					{ slot: 2, agent: "flywheel-test-3" },
					{ ...deps, isPrivateFile: () => false },
				),
			/0600 API token/,
		);
		files[`${SLOT}/bridge-launch.json`] = JSON.stringify({
			bridgeUrl: "http://example.com:19872",
		});
		assert.throws(
			() => loadRoom({ slot: 2, agent: "flywheel-test-3" }, deps),
			/loopback/,
		);
	});

	it("refuses a CommDB path that escapes the room with ..", () => {
		const coordinates = {
			agentId: "flywheel-test-3",
			carrier: "claude-code",
			projectName: "test-slot-2",
			commDbPath: `${SLOT}/../flywheel-test-slot-9/state/comm/test-slot-9/comm.db`,
			primaryChatChannelId: "123",
		};
		const files = {
			[`${SLOT}/launchd/flywheel-test-3/lead-coordinates.json`]:
				JSON.stringify(coordinates),
		};
		assert.throws(
			() =>
				loadRoom(
					{ slot: 2, agent: "flywheel-test-3" },
					{ readFile: (path) => files[path], isPrivateFile: () => true },
				),
			/do not describe this Lead/,
		);
	});

	it("gives the chat-ingest child only room coordinates and a throwaway HOME", () => {
		const room = {
			agent: "flywheel-test-3",
			commDbPath: `${SLOT}/state/comm/test-slot-2/comm.db`,
			chatChannelId: "123",
			bridgeUrl: "http://localhost:19872",
			projectName: "test-slot-2",
			token: "room-token",
		};
		const call = chatIngestInvocation(
			room,
			{ id: "111", name: "flywheel-test-1" },
			"hi",
			{
				atMs: T0,
				messageId: "42",
				home: "/tmp/f2882-ingest-home-x",
			},
		);
		assert.deepEqual(Object.keys(call.options.env).sort(), [
			"BRIDGE_URL",
			"HOME",
			"PATH",
			"PROJECT_NAME",
			"TEAMLEAD_API_TOKEN",
		]);
		// The doorbell's 401/403 fallback reads $HOME/.flywheel/.env — never the real one.
		assert.equal(call.options.env.HOME, "/tmp/f2882-ingest-home-x");
		assert.notEqual(call.options.env.HOME, homedir());
		assert.equal(call.options.env.TEAMLEAD_API_TOKEN, "room-token");
		const db = call.args.indexOf("--db");
		assert.deepEqual(call.args.slice(db, db + 2), ["--db", room.commDbPath]);
	});
});

describe("runLongTurn on a virtual clock", () => {
	function harness({ baseline = "idle", honored = true } = {}) {
		let now = T0 - 60_000;
		const ingested = [];
		const coordinates = {
			agentId: "flywheel-test-3",
			carrier: "codex-app-server",
			projectName: "test-slot-2",
			commDbPath: `${SLOT}/state/comm/test-slot-2/comm.db`,
			primaryChatChannelId: "123",
			botUserId: "999",
		};
		const files = {
			[`${SLOT}/launchd/flywheel-test-3/lead-coordinates.json`]:
				JSON.stringify(coordinates),
			[`${SLOT}/bridge-launch.json`]: JSON.stringify({
				bridgeUrl: "http://127.0.0.1:19872",
			}),
			[`${SLOT}/state/api-token`]: "tok",
		};
		const fixture = { warmDoneAt: undefined, turnStart: undefined };
		const dto = () => {
			const base = {
				schema: "lead-activity.v1",
				projectName: "test-slot-2",
				leadId: "flywheel-test-3",
				carrier: "codex-app-server",
				observedAt: new Date(now).toISOString(),
				source: "codex_sidecar",
			};
			const hold = honored ? 76_000 : 12_000;
			if (
				fixture.turnStart !== undefined &&
				now >= fixture.turnStart &&
				now < fixture.turnStart + hold
			)
				return {
					...base,
					state: "busy",
					turn: {
						startedAt: new Date(fixture.turnStart).toISOString(),
						elapsedMs: now - fixture.turnStart,
						precision: "second",
						origin: "message",
					},
					trigger: {
						kind: "undetermined",
						reason: "unmapped_delivery",
						detail: "判断不了",
					},
				};
			if (
				baseline !== "idle" &&
				(fixture.warmDoneAt === undefined || now < fixture.warmDoneAt)
			)
				return {
					...base,
					state: "unknown",
					unknown: { reason: "turn_state_not_seeded", detail: "x" },
				};
			return { ...base, state: "idle" };
		};
		const deps = {
			readFile: (path) => files[path],
			isPrivateFile: () => true,
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
			nonce: () => "n0nce",
			fetch: async (url, init) => {
				assert.match(
					url,
					/^http:\/\/127\.0\.0\.1:19872\/api\/lead-activity\?projectName=test-slot-2&leadId=flywheel-test-3$/,
				);
				assert.equal(init.headers.authorization, "Bearer tok");
				return { status: 200, json: async () => dto() };
			},
			ingest: (_room, author, text) => {
				ingested.push({
					author,
					kind: /long-turn/.test(text) ? "long" : "warm",
				});
				if (/warm-up/.test(text)) fixture.warmDoneAt = now + 8_000;
				else fixture.turnStart = now + 2_000;
				return { atMs: now, deliveryId: `d${ingested.length}` };
			},
			readDelivery: () =>
				fixture.noDelivery
					? null
					: {
							state: "ACKED",
							notified_at: new Date(fixture.turnStart - 500).toISOString(),
							delivered_at: null,
							acked_at: null,
						},
			defaultAuthor: () => ({ id: "111", name: "flywheel-test-1" }),
		};
		return { deps, ingested, fixture };
	}
	const options = {
		slot: 2,
		agent: "flywheel-test-3",
		holdSeconds: 75,
		pollSeconds: 5,
		settleSeconds: 240,
		warmup: true,
	};

	it("skips the warm-up when the Lead already reads idle, and passes an honored turn", async () => {
		const { deps, ingested } = harness();
		const evidence = await runLongTurn(options, deps);
		assert.deepEqual(
			ingested.map((x) => x.kind),
			["long"],
		);
		assert.equal(evidence.result.verdict, "pass");
		assert.ok(evidence.injection.notifiedAt);
		assert.equal(EXIT[evidence.result.verdict], 0);
		assert.equal(JSON.stringify(evidence).includes("time.sleep"), false);
	});

	it("warms the Lead up first when it cannot yet prove idle", async () => {
		const { deps, ingested } = harness({ baseline: "unseeded" });
		const evidence = await runLongTurn(options, deps);
		assert.deepEqual(
			ingested.map((x) => x.kind),
			["warm", "long"],
		);
		assert.equal(evidence.result.verdict, "pass");
		assert.ok(evidence.warmup);
	});

	it("reports inconclusive (exit 3) when the Lead cuts the hold short", async () => {
		const { deps } = harness({ honored: false });
		const evidence = await runLongTurn(options, deps);
		assert.equal(evidence.result.verdict, "inconclusive");
		assert.equal(EXIT[evidence.result.verdict], 3);
	});

	it("keeps sampling through the requested hold after an early idle", async () => {
		const { deps } = harness({ honored: false });
		const evidence = await runLongTurn(options, deps);
		const injectedAtMs = Date.parse(evidence.injection.injectedAt);
		assert.ok(evidence.samples.at(-1).atMs >= injectedAtMs + 75_000);
	});

	it("is inconclusive when the delivery time cannot be read", async () => {
		const { deps, fixture } = harness();
		fixture.noDelivery = true;
		const evidence = await runLongTurn(options, deps);
		assert.equal(evidence.result.verdict, "inconclusive");
		assert.equal(evidence.result.why, "no_delivery_evidence");
	});

	it("refuses to author the fixture as the Lead's own bot", async () => {
		const { deps } = harness();
		await assert.rejects(
			runLongTurn({ ...options, authorId: "999" }, deps),
			/own bot/,
		);
	});

	it("keeps the samples it already has when the Bridge stops answering", async () => {
		const { deps } = harness();
		let calls = 0;
		const fetch = deps.fetch;
		deps.fetch = async (...args) => {
			if (++calls > 4) throw new Error("ECONNREFUSED");
			return fetch(...args);
		};
		const evidence = await runLongTurn(options, deps);
		assert.equal(evidence.result.verdict, "setup");
		assert.equal(evidence.samples.length, 4);
	});
});
