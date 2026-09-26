import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
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
	it("passes a ≥60 s busy turn bracketed by idle whose start is within 30 s", () => {
		const result = evaluateLongTurn({
			samples: honoredRun(),
			injectedAtMs: T0,
			truthStartMs: T0 + 2_000,
		});
		assert.equal(result.verdict, "pass");
		assert.equal(result.checks.longTurnObserved, true);
		assert.equal(result.checks.startErrorMs, 1_000);
		assert.ok(result.turn.longestElapsedMs >= 60_000);
	});

	it("fails when the reported start is more than 30 s from the true start", () => {
		const result = evaluateLongTurn({
			samples: honoredRun(),
			injectedAtMs: T0,
			truthStartMs: T0 + 40_000,
		});
		assert.equal(result.verdict, "fail");
		assert.match(result.why, /startWithinTolerance/);
	});

	it("fails when the endpoint answers idle in the middle of the turn", () => {
		const samples = honoredRun();
		samples.splice(6, 1, idle(samples[6].atMs));
		const result = evaluateLongTurn({
			samples,
			injectedAtMs: T0,
			truthStartMs: T0,
		});
		assert.equal(result.verdict, "fail");
		assert.deepEqual(result.insideStates, ["idle"]);
	});

	it("fails when the endpoint answers unknown in the middle of the turn", () => {
		const samples = honoredRun();
		samples.splice(6, 1, unknown(samples[6].atMs, "pane_capture_failed"));
		const result = evaluateLongTurn({
			samples,
			injectedAtMs: T0,
			truthStartMs: T0,
		});
		assert.equal(result.verdict, "fail");
		assert.deepEqual(result.insideStates, ["unknown:pane_capture_failed"]);
	});

	it("fails when a chat-triggered turn is attributed to an issue", () => {
		const start = T0 + 3_000;
		const samples = [
			idle(T0 - 5_000),
			busy(T0 + 70_000, start, { kind: "issue", issueId: "FLY-1" }),
			idle(T0 + 90_000),
		];
		assert.equal(
			evaluateLongTurn({ samples, injectedAtMs: T0, truthStartMs: T0 }).verdict,
			"fail",
		);
	});

	it("fails when the Lead never reads busy and the endpoint answered unknown", () => {
		const samples = [
			idle(T0 - 5_000),
			unknown(T0 + 5_000, "lead_window_unavailable"),
			unknown(T0 + 10_000, "lead_window_unavailable"),
		];
		const result = evaluateLongTurn({
			samples,
			injectedAtMs: T0,
			truthStartMs: T0,
		});
		assert.equal(result.verdict, "fail");
		assert.deepEqual(result.unknownReasons, ["lead_window_unavailable"]);
	});

	it("is inconclusive — not a pass — when the Lead did not honor the 60 s hold", () => {
		const result = evaluateLongTurn({
			samples: honoredRun(3_000, 20_000),
			injectedAtMs: T0,
			truthStartMs: T0,
		});
		assert.equal(result.verdict, "inconclusive");
		assert.match(result.why, /longTurnObserved/);
	});

	it("is inconclusive without an idle baseline or an idle after the turn", () => {
		const noBefore = honoredRun().slice(1);
		assert.equal(
			evaluateLongTurn({
				samples: noBefore,
				injectedAtMs: T0,
				truthStartMs: T0,
			}).verdict,
			"inconclusive",
		);
		const noAfter = honoredRun().slice(0, -1);
		assert.equal(
			evaluateLongTurn({ samples: noAfter, injectedAtMs: T0, truthStartMs: T0 })
				.verdict,
			"inconclusive",
		);
	});

	it("ignores an earlier, unrelated busy turn when picking the long turn", () => {
		const samples = honoredRun();
		samples.splice(1, 0, busy(T0 + 1_000, T0 - 20_000));
		assert.equal(
			evaluateLongTurn({ samples, injectedAtMs: T0, truthStartMs: T0 }).verdict,
			"pass",
		);
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
		assert.match(prompt, /sleep 75/);
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
			readDelivery: () => ({
				state: "ACKED",
				delivered_at: new Date(fixture.turnStart - 500).toISOString(),
				acked_at: null,
			}),
			defaultAuthor: () => ({ id: "111", name: "flywheel-test-1" }),
		};
		return { deps, ingested };
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
		assert.equal(evidence.injection.truthStart, "delivered_at");
		assert.equal(EXIT[evidence.result.verdict], 0);
		assert.equal(JSON.stringify(evidence).includes("sleep 75"), false);
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
