import assert from "node:assert/strict";
import test from "node:test";
import { runPreflight } from "../qa/fly2598-voice-preflight.mjs";

const bot = "100000000000000001",
	guild = "100000000000000002",
	voice = "100000000000000003",
	chat = "100000000000000004";
const project = {
	projectName: "fixture",
	voiceRoom: { guildId: guild, voiceChannelId: voice },
	leads: [
		{
			agentId: "lead",
			botUserId: bot,
			botTokenEnv: "EXACT_TOKEN",
			chatChannel: chat,
			voiceModes: { meeting: true },
		},
	],
};
function setup(modify = {}) {
	const calls = [];
	const fetchImpl = async (url, options) => {
		calls.push([url, options]);
		assert.equal(options.method, "GET");
		assert.equal(options.headers.Authorization, "Bot fixture-secret");
		if (modify.timeout) return new Promise(() => {});
		if (
			modify.status &&
			(!modify.channel403 || url.endsWith(`/channels/${voice}`))
		)
			return new Response("private raw response", { status: modify.status });
		const path = new URL(url).pathname.replace("/api/v10", "");
		const rows = {
			"/users/@me": { id: modify.wrongId ? "100000000000000009" : bot },
			[`/guilds/${guild}/members/${bot}`]: { roles: [] },
			[`/guilds/${guild}/roles`]: [{ id: guild, permissions: "8" }],
			[`/channels/${voice}`]: { id: voice, permission_overwrites: [] },
			[`/channels/${chat}`]: { id: chat, permission_overwrites: [] },
			"/gateway/bot": { session_start_limit: { remaining: 2 } },
		};
		if (modify.permissions) rows[`/guilds/${guild}/roles`][0].permissions = "0";
		if (modify.overwrite) {
			rows[`/guilds/${guild}/roles`][0].permissions = (
				(1n << 53n) -
				1n -
				8n
			).toString();
			rows[`/channels/${voice}`].permission_overwrites = [
				{ id: bot, type: 1, allow: "0", deny: "1048576" },
			];
		}
		return new Response(JSON.stringify(rows[path]));
	};
	const probeSelfFilter = async () => {
		if (modify.probeAbsent) throw Error("private raw exception");
		return {
			version: 1,
			leadId: "lead",
			botUserId: bot,
			runtimeId: "runtime-fixture",
			ready: true,
			selfDropped: true,
			unknownDropped: true,
			otherPassed: true,
		};
	};
	return { calls, fetchImpl, probeSelfFilter };
}
const input = () => ({
	projects: [structuredClone(project)],
	projectName: "fixture",
	leadId: "lead",
	env: { EXACT_TOKEN: "fixture-secret" },
	codeSha: "a".repeat(40),
});
test("same preflight performs only GET and emits public evidence", async () => {
	const d = setup();
	const r = await runPreflight(input(), d);
	assert.equal(r.ok, true);
	assert.equal(r.botUserId, bot);
	assert.equal(r.checks.stage, "ready");
	assert.equal(r.checks.selfFilter.runtimeId, "runtime-fixture");
	assert.equal(d.calls.length, 6);
	assert.doesNotMatch(JSON.stringify(r), /fixture-secret|Authorization/);
});
for (const [modify, reason, stage] of [
	[{ wrongId: true }, "lead_bot_identity_mismatch", "identity"],
	[{ status: 403 }, "discord_http_403", "identity"],
	[{ permissions: true }, "voice_permissions", "voice_channel"],
	[{ overwrite: true }, "voice_permissions", "voice_channel"],
	[{ status: 403, channel403: true }, "voice_permissions", "voice_channel"],
	[{ probeAbsent: true }, "self_filter_unverified", "self_filter"],
	[{ timeout: true }, "discord_timeout", "identity"],
])
	test(`bounded evidence for ${reason}`, async () => {
		const r = await runPreflight(input(), setup(modify));
		assert.equal(r.ok, false);
		assert.equal(r.reason, reason);
		assert.equal(r.checks.stage, stage);
		if (modify.channel403) {
			assert.equal(r.checks.httpStatus, 403);
			assert.equal(r.checks.voicePermissions, null);
			assert.equal(r.checks.textPermissions, null);
		}
		assert.doesNotMatch(JSON.stringify(r), /private raw|fixture-secret/);
	});
test("missing exact token fails before HTTP with no cached token fallback", async () => {
	const i = input();
	i.env = {};
	i.projects[0].leads[0].botToken = "fixture-secret";
	const d = setup();
	const r = await runPreflight(i, d);
	assert.equal(r.reason, "bot_env_unset");
	assert.equal(d.calls.length, 0);
});
test("ambiguous Lead and missing meeting opt-in fail before HTTP", async () => {
	for (const ambiguous of [true, false]) {
		const i = input();
		if (ambiguous) i.projects[0].leads.push(i.projects[0].leads[0]);
		else i.projects[0].leads[0].voiceModes.meeting = false;
		const d = setup();
		assert.equal((await runPreflight(i, d)).ok, false);
		assert.equal(d.calls.length, 0);
	}
});

test("CLI reads the host .env, writes a private receipt, and never overwrites it", async () => {
	const {
		mkdtempSync,
		mkdirSync,
		writeFileSync,
		readFileSync,
		statSync,
		rmSync,
	} = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join, resolve } = await import("node:path");
	const { spawnSync } = await import("node:child_process");
	const home = mkdtempSync(join(tmpdir(), "voice-preflight-"));
	try {
		const state = join(home, ".flywheel");
		mkdirSync(state);
		const p = structuredClone(project);
		p.projectRoot = home;
		p.leads[0].match = { labels: ["Engineering"] };
		p.leads[0].summaryRole = "exempt";
		const files = {
			"projects.json": JSON.stringify([p]),
			"voice-host.json": '{"schemaVersion":1}',
			".env": "UNRELATED_SECRET=private-fixture-secret\n",
		};
		for (const [name, bytes] of Object.entries(files))
			writeFileSync(join(state, name), bytes, { mode: 0o600 });
		const out = join(home, "receipt.json");
		const run = () =>
			spawnSync(
				process.execPath,
				[
					resolve(import.meta.dirname, "../qa/fly2598-voice-preflight.mjs"),
					"--project",
					"fixture",
					"--lead",
					"lead",
					"--out",
					out,
				],
				{
					env: { HOME: home, PATH: process.env.PATH },
					encoding: "utf8",
					timeout: 30000,
				},
			);
		const r = run();
		assert.equal(r.status, 1);
		assert.equal(r.stderr, "");
		const receipt = readFileSync(out, "utf8");
		assert.equal(JSON.parse(receipt).reason, "bot_env_unset");
		assert.equal(statSync(out).mode & 0o777, 0o600);
		assert.doesNotMatch(r.stdout, /private-fixture-secret/);
		assert.equal(run().status, 1);
		assert.equal(readFileSync(out, "utf8"), receipt);
		for (const [name, bytes] of Object.entries(files))
			assert.equal(readFileSync(join(state, name), "utf8"), bytes);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
