import assert from "node:assert/strict";
import test from "node:test";
import {
	evaluateMeetingEvidence,
	runTwoLead,
	validateTopology,
	waveStats,
} from "../qa/fly2446-two-lead-run.mjs";

const topology = () => ({
	slotDir: "/private/tmp/flywheel-test-slot-2",
	bridgeUrl: "http://127.0.0.1:9878",
	buildSha: "a".repeat(40),
	expectedHead: "a".repeat(40),
	voiceBinarySha: "b".repeat(64),
	guildId: "100000000000000001",
	voiceChannelId: "100000000000000002",
	qaVoiceChannelIds: ["100000000000000002"],
	commDbPath: "/private/tmp/flywheel-test-slot-2/state/comm/test/comm.db",
	dbPath: "/private/tmp/flywheel-test-slot-2/teamlead.db",
	meetingStateDir: "/private/tmp/flywheel-test-slot-2/meetings",
	voiceRoot: "/private/tmp/flywheel-test-slot-2/voice",
	codexHome: "/private/tmp/flywheel-test-slot-2/cdxh/voice",
	leads: [
		{
			agentId: "test-claude",
			backend: "claude-code",
			chatChannel: "100000000000000010",
			botUserId: "100000000000000011",
			tokenEnv: "TEST_BOT_TOKEN_1",
		},
		{
			agentId: "test-codex",
			backend: "codex-app-server",
			chatChannel: "100000000000000012",
			botUserId: "100000000000000013",
			tokenEnv: "TEST_BOT_TOKEN_2",
		},
	],
	recorders: [
		{ tokenEnv: "TEST_BOT_TOKEN_3", botUserId: "100000000000000014" },
		{ tokenEnv: "TEST_BOT_TOKEN_4", botUserId: "100000000000000015" },
	],
	voiceBot: { tokenEnv: "TEST_BOT_TOKEN_5", botUserId: "100000000000000016" },
	slots: [
		{
			tokenEnvVar: "TEST_BOT_TOKEN_1",
			botAppId: "100000000000000011",
			channelId: "100000000000000010",
		},
		{
			tokenEnvVar: "TEST_BOT_TOKEN_2",
			botAppId: "100000000000000013",
			channelId: "100000000000000012",
		},
		{ tokenEnvVar: "TEST_BOT_TOKEN_3", botAppId: "100000000000000014" },
		{ tokenEnvVar: "TEST_BOT_TOKEN_4", botAppId: "100000000000000015" },
		{ tokenEnvVar: "TEST_BOT_TOKEN_5", botAppId: "100000000000000016" },
	],
});
test("dry run validates topology but invokes no effects or claimed meeting evidence", async () => {
	const calls = [];
	const report = await runTwoLead(
		topology(),
		{ dryRun: true },
		{ runMeeting: () => calls.push("run") },
	);
	assert.equal(report.status, "NOT_RUN");
	assert.equal(report.trueRoomRun, false);
	assert.deepEqual(calls, []);
});
for (const [name, modify] of [
	[
		"production db",
		(t) => {
			t.commDbPath = "/Users/a/.flywheel/comm/flywheel/comm.db";
		},
	],
	[
		"production home",
		(t) => {
			t.codexHome = "/Users/a/.codex";
		},
	],
	[
		"non-loopback bridge",
		(t) => {
			t.bridgeUrl = "https://bridge.example.com";
		},
	],
	[
		"production voice room",
		(t) => {
			t.qaVoiceChannelIds = [];
		},
	],
	[
		"production bot token",
		(t) => {
			t.recorders[0].tokenEnv = "DISCORD_BOT_TOKEN";
		},
	],
	[
		"bot identity drift",
		(t) => {
			t.voiceBot.botUserId = "100000000000000099";
		},
	],
	[
		"same recorder/voice bot",
		(t) => {
			t.recorders[0] = t.voiceBot;
		},
	],
	[
		"missing Codex harness",
		(t) => {
			t.leads[1].backend = "claude-code";
		},
	],
	[
		"non-slot directory",
		(t) => {
			t.slotDir = "/Users/a/.flywheel";
		},
	],
])
	test(`refuses ${name} before effects`, () => {
		const t = topology();
		modify(t);
		assert.throws(() => validateTopology(t));
	});
test("runs two distinct harnesses sequentially and never fabricates overall QA PASS", async () => {
	const calls = [];
	const report = await runTwoLead(
		topology(),
		{ dryRun: false },
		{
			runMeeting: async (lead, recorder) => {
				calls.push([lead.agentId, recorder.tokenEnv]);
				return { sessionId: lead.agentId, status: "EVIDENCE_COLLECTED" };
			},
		},
	);
	assert.deepEqual(calls, [
		["test-claude", "TEST_BOT_TOKEN_3"],
		["test-codex", "TEST_BOT_TOKEN_4"],
	]);
	assert.equal(report.status, "EVIDENCE_COLLECTED");
	assert.equal(report.qaVerdict, "NOT_EVALUATED");
	assert.equal(report.rg.status, "NOT_RUN");
});
test("refuses a slot built from a different checkout head", () => {
	const t = topology();
	t.expectedHead = "c".repeat(40);
	assert.throws(() => validateTopology(t), /checkout_head_drift/);
});

test("waveform evidence requires real nonzero samples in receipt interval", () => {
	const pcm = Buffer.alloc(48_000 * 4);
	pcm.writeInt16LE(10_000, 24_000 * 4);
	const stats = waveStats(pcm, 0, 400, 600);
	assert.equal(stats.audible, true);
	assert.equal(stats.durationSeconds, 1);
	assert.match(stats.sha256, /^[a-f0-9]{64}$/);
	assert.equal(waveStats(pcm, 0, 0, 100).audible, false);
	assert.equal(waveStats(Buffer.alloc(100), 0, 0, 100).audible, false);
});

const proof = () => ({
	session: {
		session_id: "session",
		state: "ended",
		meeting_id: "meeting",
		lead_id: "lead",
	},
	liveObserved: true,
	mailbox: [
		{ delivery_id: "chat:lead:123", source_kind: "voice", state: "ACKED" },
	],
	journal: [{ kind: "ingested", deliveryId: "chat:lead:123" }],
	outbound: [
		{ author_id: "bot", phase: "confirmed", attempt_token: "attempt" },
	],
	leadBotId: "bot",
	selection: { trusted: true, transcripts: [{ text: "heard" }] },
	audio: [{ audible: true }],
});
test("cross-checks actual selector, mailbox, journal, outbound and audio evidence", () =>
	assert.equal(evaluateMeetingEvidence(proof()).status, "EVIDENCE_COLLECTED"));
for (const field of ["mailbox", "journal", "outbound", "audio"])
	test(`missing ${field} refuses collected evidence`, () => {
		const p = proof();
		p[field] = [];
		assert.throws(() => evaluateMeetingEvidence(p));
	});
test("rejects untrusted selector, missing live observation or unconfirmed TTS", () => {
	const a = proof();
	a.selection.trusted = false;
	assert.throws(() => evaluateMeetingEvidence(a));
	const b = proof();
	b.liveObserved = false;
	assert.throws(() => evaluateMeetingEvidence(b));
	const c = proof();
	c.outbound[0].phase = "ambiguous";
	assert.throws(() => evaluateMeetingEvidence(c));
});
