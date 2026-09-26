// FLY-2860: retire-legacy-voice deletes only the four legacy guild slash
// commands and retires a leftover voice-bridge launchd unit. Discord and
// launchctl are injected fakes; no test touches the network or launchd.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { retireLegacyVoice } from "../retire-legacy-voice.mjs";

const GUILD = "100000000000000001";
const GUILD_B = "100000000000000002";
const APP = "200000000000000001";
const APP_B = "200000000000000002";
const TOKEN = "tok-orchestrator-SECRET-aaaa";
const TOKEN_B = "tok-staged-SECRET-bbbb";
const PLIST = "com.flywheel.voice-bridge.plist";

let nextId = 300000000000000000n;
function cmd(name, over = {}) {
	nextId += 1n;
	return {
		id: String(nextId),
		application_id: APP,
		guild_id: GUILD,
		type: 1,
		name,
		...over,
	};
}

function json(status, body) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function fakeDiscord({
	bots,
	guilds = {},
	global = {},
	rateLimit = {},
	sticky = new Set(),
}) {
	const calls = [];
	const hits = new Map();
	async function fetchImpl(url, init = {}) {
		const method = init.method ?? "GET";
		const auth = init.headers?.Authorization ?? "";
		calls.push({ method, url: String(url) });
		const token = auth.replace(/^Bot /, "");
		const bot = bots[token];
		if (!bot) return json(401, { code: 0, message: "401: Unauthorized" });
		const p = new URL(url).pathname.replace(/^\/api\/v10/, "");
		if (p === "/oauth2/applications/@me") return json(200, { id: bot.appId });
		let m = p.match(/^\/applications\/(\d+)\/commands$/);
		if (m) return json(200, global[m[1]] ?? []);
		m = p.match(/^\/applications\/(\d+)\/guilds\/(\d+)\/commands$/);
		if (m && method === "GET") {
			const v = guilds[`${m[1]}/${m[2]}`];
			if (v && !Array.isArray(v))
				return json(v.status, { code: v.code, message: "denied" });
			return json(200, v ?? []);
		}
		m = p.match(/^\/applications\/(\d+)\/guilds\/(\d+)\/commands\/(\d+)$/);
		if (m && method === "DELETE") {
			const id = m[3];
			const n = (hits.get(id) ?? 0) + 1;
			hits.set(id, n);
			if (rateLimit[id] !== undefined && n <= rateLimit[id]) {
				return json(429, { retry_after: 0.01, message: "rate limited" });
			}
			if (!sticky.has(id)) {
				const list = guilds[`${m[1]}/${m[2]}`];
				const i = list.findIndex((c) => c.id === id);
				if (i >= 0) list.splice(i, 1);
			}
			return new Response(null, { status: 204 });
		}
		return json(404, { code: 0, message: "unknown route" });
	}
	return { fetchImpl, calls };
}

function fakeLaunchctl(loaded = false) {
	const calls = [];
	let state = loaded;
	return {
		calls,
		launchctl(args) {
			calls.push(args.join(" "));
			if (args[0] === "print") {
				return state
					? { status: 0, stdout: "state = running\n", stderr: "" }
					: { status: 113, stdout: "", stderr: "Could not find service" };
			}
			if (args[0] === "bootout") {
				state = false;
				return { status: 0, stdout: "", stderr: "" };
			}
			return { status: 1, stdout: "", stderr: "unexpected" };
		},
	};
}

function world({ targets, projects = [], envFile, plist = false } = {}) {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "fly2860-retire-"));
	fs.mkdirSync(path.join(home, ".flywheel"), { recursive: true });
	fs.mkdirSync(path.join(home, "Library/LaunchAgents"), { recursive: true });
	fs.writeFileSync(
		path.join(home, ".flywheel/projects.json"),
		JSON.stringify(projects),
	);
	if (envFile !== undefined) {
		const p = path.join(home, ".flywheel/.env");
		fs.writeFileSync(p, envFile.body);
		fs.chmodSync(p, envFile.mode);
	}
	if (plist)
		fs.writeFileSync(
			path.join(home, "Library/LaunchAgents", PLIST),
			"<plist/>",
		);
	const targetsPath = path.join(home, "targets.json");
	fs.writeFileSync(
		targetsPath,
		JSON.stringify(
			targets ?? [
				{
					envName: "ORCH_TOKEN",
					appId: APP,
					guildIds: [GUILD],
					required: true,
					note: "orchestrator",
				},
			],
		),
	);
	return { home, targetsPath };
}

async function run({
	w,
	discord,
	lc = fakeLaunchctl(),
	env = { ORCH_TOKEN: TOKEN },
	argv = [],
}) {
	let out = "";
	const result = await retireLegacyVoice({
		argv,
		env,
		homeDir: w.home,
		targetsPath: w.targetsPath,
		fetchImpl: discord.fetchImpl,
		launchctl: lc.launchctl,
		uid: 501,
		sleep: async () => {},
		now: () => new Date("2026-09-25T00:00:00Z"),
		write: (s) => {
			out += s;
		},
	});
	return { ...result, out, lc };
}

const deletes = (discord) => discord.calls.filter((c) => c.method === "DELETE");

test("① dry-run lists legacy commands and never deletes", async () => {
	const list = [
		cmd("glaw"),
		cmd("gemini"),
		cmd("gemini-advanced"),
		cmd("eleven"),
	];
	const discord = fakeDiscord({
		bots: { [TOKEN]: { appId: APP } },
		guilds: { [`${APP}/${GUILD}`]: list },
	});
	const r = await run({ w: world(), discord });
	assert.equal(r.code, 0);
	assert.equal(deletes(discord).length, 0);
	assert.deepEqual(r.receipt.found.map((f) => f.name).sort(), [
		"eleven",
		"gemini",
		"gemini-advanced",
		"glaw",
	]);
	assert.equal(r.receipt.apply, false);
	assert.deepEqual(r.receipt.uncovered, []);
});

test("② --apply deletes only exact whitelist names; ③ user/message commands survive", async () => {
	const keep = [
		cmd("glaw2"),
		cmd("Gemini"),
		cmd("gemini_advanced"),
		cmd("meet"),
		cmd("glaw", { type: 2 }),
		cmd("eleven", { type: 3 }),
	];
	const legacy = [cmd("glaw"), cmd("eleven")];
	const list = [...keep, ...legacy];
	const discord = fakeDiscord({
		bots: { [TOKEN]: { appId: APP } },
		guilds: { [`${APP}/${GUILD}`]: list },
	});
	const r = await run({ w: world(), discord, argv: ["--apply"] });
	assert.equal(r.code, 0, r.out);
	assert.deepEqual(
		deletes(discord)
			.map((c) => c.url.split("/").at(-1))
			.sort(),
		legacy.map((c) => c.id).sort(),
	);
	assert.deepEqual(list.map((c) => c.id).sort(), keep.map((c) => c.id).sort());
	assert.deepEqual(r.receipt.remaining, []);
});

test("④ a same-name global command is reported, never deleted", async () => {
	const discord = fakeDiscord({
		bots: { [TOKEN]: { appId: APP } },
		guilds: { [`${APP}/${GUILD}`]: [] },
		global: { [APP]: [cmd("gemini", { guild_id: undefined })] },
	});
	const r = await run({ w: world(), discord, argv: ["--apply"] });
	assert.equal(deletes(discord).length, 0);
	assert.equal(r.receipt.targets[0].global.status, "global_found");
	assert.deepEqual(r.receipt.found, []);
});

test("⑤ a required target without a credential fails", async () => {
	const discord = fakeDiscord({ bots: {} });
	const r = await run({ w: world(), discord, env: {} });
	assert.notEqual(r.code, 0);
	assert.equal(r.receipt.targets[0].guilds[0].status, "missing_credential");
	assert.deepEqual(r.receipt.uncovered, ["ORCH_TOKEN"]);
});

test("⑥ every list refused (403) is not a pass even with nothing found", async () => {
	const discord = fakeDiscord({
		bots: { [TOKEN]: { appId: APP } },
		guilds: { [`${APP}/${GUILD}`]: { status: 403, code: 50001 } },
	});
	const r = await run({ w: world(), discord });
	assert.notEqual(r.code, 0);
	assert.deepEqual(r.receipt.found, []);
	assert.deepEqual(r.receipt.targets[0].guilds[0], {
		guildId: GUILD,
		required: true,
		commandNames: ["eleven", "gemini", "gemini-advanced", "glaw"],
		status: "access_denied",
		httpStatus: 403,
		discordCode: 50001,
	});
});

test("⑦ an empty target set or zero valid guilds fails", async () => {
	const discord = fakeDiscord({ bots: { [TOKEN]: { appId: APP } } });
	const empty = await run({ w: world({ targets: [] }), discord });
	assert.notEqual(empty.code, 0);
	const noGuild = await run({
		w: world({
			targets: [
				{
					envName: "ORCH_TOKEN",
					guildIds: ["not-a-snowflake"],
					required: true,
					note: "x",
				},
			],
		}),
		discord,
	});
	assert.notEqual(noGuild.code, 0);
	assert.equal(
		noGuild.receipt.targets[0].guilds[0].status,
		"skipped_invalid_id",
	);
	assert.deepEqual(noGuild.receipt.uncovered, ["ORCH_TOKEN"]);
});

test("⑧ an appId that differs from the target file fails", async () => {
	const discord = fakeDiscord({ bots: { [TOKEN]: { appId: APP_B } } });
	const r = await run({ w: world(), discord });
	assert.notEqual(r.code, 0);
	assert.equal(r.receipt.targets[0].guilds[0].status, "error");
	assert.match(r.receipt.targets[0].guilds[0].detail, /app_id_mismatch/);
	assert.deepEqual(r.receipt.targets[0].guilds[0].commandNames, [
		"eleven",
		"gemini",
		"gemini-advanced",
		"glaw",
	]);
	assert.equal(deletes(discord).length, 0);
});

test("⑨ 403 and 404 are classified with their Discord error codes", async () => {
	const discord = fakeDiscord({
		bots: { [TOKEN]: { appId: APP } },
		guilds: {
			[`${APP}/${GUILD}`]: { status: 403, code: 50001 },
			[`${APP}/${GUILD_B}`]: { status: 404, code: 10004 },
		},
	});
	const w = world({
		targets: [
			{
				envName: "ORCH_TOKEN",
				appId: APP,
				guildIds: [GUILD, GUILD_B],
				required: false,
				note: "x",
			},
		],
	});
	const r = await run({ w, discord });
	const byGuild = Object.fromEntries(
		r.receipt.targets[0].guilds.map((g) => [g.guildId, g]),
	);
	assert.equal(byGuild[GUILD].status, "access_denied");
	assert.equal(byGuild[GUILD].discordCode, 50001);
	assert.equal(byGuild[GUILD_B].status, "not_found");
	assert.equal(byGuild[GUILD_B].discordCode, 10004);
});

test("⑩ a 429 is retried once; a second 429 fails", async () => {
	const once = cmd("gemini");
	const d1 = fakeDiscord({
		bots: { [TOKEN]: { appId: APP } },
		guilds: { [`${APP}/${GUILD}`]: [once] },
		rateLimit: { [once.id]: 1 },
	});
	const ok = await run({ w: world(), discord: d1, argv: ["--apply"] });
	assert.equal(ok.code, 0, ok.out);
	assert.deepEqual(
		ok.receipt.deleted.map((d) => d.commandId),
		[once.id],
	);
	const twice = cmd("gemini");
	const d2 = fakeDiscord({
		bots: { [TOKEN]: { appId: APP } },
		guilds: { [`${APP}/${GUILD}`]: [twice] },
		rateLimit: { [twice.id]: 2 },
	});
	const bad = await run({ w: world(), discord: d2, argv: ["--apply"] });
	assert.notEqual(bad.code, 0);
});

test("⑪ neither the receipt nor stdout carries a token", async () => {
	const discord = fakeDiscord({
		bots: { [TOKEN]: { appId: APP }, [TOKEN_B]: { appId: APP_B } },
		guilds: { [`${APP}/${GUILD}`]: [cmd("glaw")], [`${APP_B}/${GUILD}`]: [] },
	});
	const w = world({
		targets: [
			{
				envName: "ORCH_TOKEN",
				appId: APP,
				guildIds: [GUILD],
				required: true,
				note: "x",
			},
			{
				envName: "STAGED_TOKEN",
				guildIds: [GUILD],
				required: false,
				note: "y",
			},
		],
	});
	const receiptPath = path.join(w.home, "receipt.json");
	const r = await run({
		w,
		discord,
		env: { ORCH_TOKEN: TOKEN, STAGED_TOKEN: TOKEN_B },
		argv: ["--apply", "--json", receiptPath],
	});
	assert.equal(r.code, 0, r.out);
	const written = fs.readFileSync(receiptPath, "utf8");
	for (const text of [r.out, written, JSON.stringify(r.receipt)]) {
		assert.ok(
			!text.includes(TOKEN) &&
				!text.includes(TOKEN_B) &&
				!text.includes("SECRET"),
		);
	}
	assert.equal(fs.statSync(receiptPath).mode & 0o777, 0o600);
});

test("⑫ a command still listed after deletion fails the run", async () => {
	const stuck = cmd("eleven");
	const discord = fakeDiscord({
		bots: { [TOKEN]: { appId: APP } },
		guilds: { [`${APP}/${GUILD}`]: [stuck] },
		sticky: new Set([stuck.id]),
	});
	const r = await run({ w: world(), discord, argv: ["--apply"] });
	assert.notEqual(r.code, 0);
	assert.deepEqual(
		r.receipt.remaining.map((c) => c.commandId),
		[stuck.id],
	);
});

test("⑬ a second run is idempotent: nothing found, exit 0", async () => {
	const discord = fakeDiscord({
		bots: { [TOKEN]: { appId: APP } },
		guilds: { [`${APP}/${GUILD}`]: [cmd("glaw"), cmd("gemini")] },
	});
	const w = world();
	assert.equal((await run({ w, discord, argv: ["--apply"] })).code, 0);
	const again = await run({ w, discord, argv: ["--apply"] });
	assert.equal(again.code, 0);
	assert.deepEqual(again.receipt.found, []);
	assert.deepEqual(again.receipt.deleted, []);
});

test("⑭ a command with a missing or foreign field is never deleted", async () => {
	const list = [
		cmd("glaw", { id: undefined }),
		cmd("gemini", { application_id: APP_B }),
		cmd("eleven", { guild_id: GUILD_B }),
		cmd("gemini-advanced", { type: "1" }),
	];
	const discord = fakeDiscord({
		bots: { [TOKEN]: { appId: APP } },
		guilds: { [`${APP}/${GUILD}`]: list },
	});
	const r = await run({ w: world(), discord, argv: ["--apply"] });
	assert.equal(deletes(discord).length, 0);
	assert.equal(r.receipt.malformed.length, 4);
	assert.equal(list.length, 4);
	// A legacy-named command that cannot be judged is not proof of cleanup.
	assert.notEqual(r.code, 0);
	assert.deepEqual(
		r.receipt.remaining.map((c) => `${c.name}:${c.malformed}`).sort(),
		["eleven:true", "gemini-advanced:true", "gemini:true", "glaw:true"],
	);
	const dry = await run({ w: world(), discord });
	assert.notEqual(
		dry.code,
		0,
		"a dry run must not report a clean guild either",
	);
});

test("optional candidates: projects.json lead bots join, deduped by token, bad guild ids recorded", async () => {
	const projects = [
		{
			projectName: "a",
			voiceRoom: { guildId: GUILD, voiceChannelId: "1" },
			leads: [{ botTokenEnv: "LEAD_A" }, { botTokenEnv: "ORCH_TOKEN" }],
		},
		{
			projectName: "b",
			voiceRoom: { guildId: "bad-id", voiceChannelId: "1" },
			leads: [],
		},
	];
	const discord = fakeDiscord({
		bots: { [TOKEN]: { appId: APP }, [TOKEN_B]: { appId: APP_B } },
		guilds: {
			[`${APP}/${GUILD}`]: [],
			[`${APP_B}/${GUILD}`]: [cmd("glaw", { application_id: APP_B })],
		},
	});
	const r = await run({
		w: world({ projects }),
		discord,
		env: { ORCH_TOKEN: TOKEN, LEAD_A: TOKEN_B },
	});
	assert.equal(r.code, 0, r.out);
	assert.deepEqual(r.receipt.invalidGuildIds, ["bad-id"]);
	const envNames = r.receipt.targets.map((t) => t.envName);
	assert.deepEqual(
		envNames,
		["ORCH_TOKEN", "LEAD_A"],
		"ORCH_TOKEN candidate folded into the required target",
	);
	assert.deepEqual(
		r.receipt.found.map((f) => `${f.appId}:${f.name}`),
		[`${APP_B}:glaw`],
	);
});

test("reads a missing token from a private ~/.flywheel/.env, never from a shared one", async () => {
	const discord = fakeDiscord({
		bots: { [TOKEN]: { appId: APP } },
		guilds: { [`${APP}/${GUILD}`]: [] },
	});
	const ok = await run({
		w: world({
			envFile: { body: `export ORCH_TOKEN='${TOKEN}'\nOTHER=1\n`, mode: 0o600 },
		}),
		discord,
		env: {},
	});
	assert.equal(ok.code, 0, ok.out);
	assert.equal(ok.receipt.targets[0].guilds[0].status, "queried_ok");
	const shared = await run({
		w: world({ envFile: { body: `ORCH_TOKEN=${TOKEN}\n`, mode: 0o644 } }),
		discord,
		env: {},
	});
	assert.notEqual(shared.code, 0);
	assert.equal(
		shared.receipt.targets[0].guilds[0].status,
		"missing_credential",
	);
	assert.equal(shared.receipt.envFile, "rejected_not_private");
});

test("launchd: dry-run only reports; --apply boots out and renames the leftover unit", async () => {
	const discord = fakeDiscord({
		bots: { [TOKEN]: { appId: APP } },
		guilds: { [`${APP}/${GUILD}`]: [] },
	});
	const w = world({ plist: true });
	const dry = await run({ w, discord, lc: fakeLaunchctl(true) });
	assert.deepEqual(dry.receipt.launchd, {
		loaded: true,
		plist: true,
		action: "none",
	});
	assert.ok(dry.lc.calls.every((c) => c.startsWith("print ")));
	assert.ok(fs.existsSync(path.join(w.home, "Library/LaunchAgents", PLIST)));
	const lc = fakeLaunchctl(true);
	const applied = await run({ w, discord, lc, argv: ["--apply"] });
	assert.equal(applied.code, 0, applied.out);
	assert.deepEqual(applied.receipt.launchd, {
		loaded: false,
		plist: false,
		action: "bootout+renamed",
	});
	assert.ok(lc.calls.includes("bootout gui/501/com.flywheel.voice-bridge"));
	assert.ok(
		fs.existsSync(
			path.join(w.home, "Library/LaunchAgents", `${PLIST}.retired-FLY-2860`),
		),
	);
	const again = await run({
		w,
		discord,
		lc: fakeLaunchctl(false),
		argv: ["--apply"],
	});
	assert.deepEqual(again.receipt.launchd, {
		loaded: false,
		plist: false,
		action: "none",
	});
});

test("the shipped targets file is valid and names at least one required historical registrant", () => {
	const shipped = JSON.parse(
		fs.readFileSync(
			new URL("../retire-legacy-voice.targets.json", import.meta.url),
			"utf8",
		),
	);
	assert.ok(Array.isArray(shipped) && shipped.some((t) => t.required === true));
	for (const t of shipped) {
		assert.match(t.envName, /^[A-Z][A-Z0-9_]*$/);
		assert.ok(
			t.guildIds.length > 0 && t.guildIds.every((g) => /^\d{17,20}$/.test(g)),
		);
		if (t.appId !== undefined) assert.match(t.appId, /^\d{17,20}$/);
		for (const n of t.extraCommandNames ?? []) {
			assert.match(n, /^[a-z0-9_-]{1,32}$/);
		}
		assert.ok(t.note.length > 0);
	}
	// QA F1 (FLY-2860 QA@1): every bot that ran the staged huddle rig
	// (commandName "meet") is a required target that also retires /meet.
	const byEnv = Object.fromEntries(shipped.map((t) => [t.envName, t]));
	for (const [envName, appId] of [
		["FLY2860_POOL06_BOT_TOKEN", "1523232391349403850"],
		["FLY2860_POOL05_BOT_TOKEN", "1523230048243417178"],
		["TEST_BOT_TOKEN_1", "1493068669444427927"],
	]) {
		assert.equal(byEnv[envName]?.required, true, envName);
		assert.equal(byEnv[envName]?.appId, appId, envName);
		assert.deepEqual(byEnv[envName]?.extraCommandNames, ["meet"], envName);
	} // Every QA slot bot (test-1..6) is swept for /meet too: current voice
	// sessions register no slash commands, so /meet on them can only be legacy.
	for (let i = 2; i <= 6; i++) {
		const t = byEnv[`TEST_BOT_TOKEN_${i}`];
		assert.equal(t?.required, false, `TEST_BOT_TOKEN_${i}`);
		assert.deepEqual(t?.extraCommandNames, ["meet"], `TEST_BOT_TOKEN_${i}`);
	}
});

test("extraCommandNames retire /meet only on the targets that list it", async () => {
	const orchMeet = cmd("meet");
	const leadMeet = cmd("meet", { application_id: APP_B });
	const orchList = [cmd("glaw"), orchMeet, cmd("meeting")];
	const leadList = [leadMeet, cmd("gemini", { application_id: APP_B })];
	const discord = fakeDiscord({
		bots: { [TOKEN]: { appId: APP }, [TOKEN_B]: { appId: APP_B } },
		guilds: { [`${APP}/${GUILD}`]: orchList, [`${APP_B}/${GUILD}`]: leadList },
	});
	const projects = [
		{
			projectName: "a",
			voiceRoom: { guildId: GUILD, voiceChannelId: "1" },
			leads: [{ botTokenEnv: "LEAD_A" }],
		},
	];
	const w = world({
		projects,
		targets: [
			{
				envName: "ORCH_TOKEN",
				appId: APP,
				guildIds: [GUILD],
				required: true,
				extraCommandNames: ["meet"],
				note: "staged huddle rig orchestrator",
			},
		],
	});
	const r = await run({
		w,
		discord,
		env: { ORCH_TOKEN: TOKEN, LEAD_A: TOKEN_B },
		argv: ["--apply"],
	});
	assert.equal(r.code, 0, r.out);
	assert.deepEqual(
		r.receipt.deleted.map((d) => `${d.appId}:${d.name}`).sort(),
		[`${APP_B}:gemini`, `${APP}:glaw`, `${APP}:meet`].sort(),
	);
	assert.ok(
		leadList.some((c) => c.id === leadMeet.id),
		"a Lead bot's /meet stays",
	);
	assert.ok(
		orchList.some((c) => c.name === "meeting"),
		"near names stay",
	);
	assert.deepEqual(r.receipt.targets[0].commandNames, [
		"eleven",
		"gemini",
		"gemini-advanced",
		"glaw",
		"meet",
	]);
});

test("a shared token keeps /meet scoped to the target's own guilds", async () => {
	// The same bot is both a staged-rig target (GUILD, retires /meet) and a
	// project Lead candidate (GUILD_B, four legacy names only).
	const stagedMeet = cmd("meet");
	const roomMeet = cmd("meet", { guild_id: GUILD_B });
	const roomGlaw = cmd("glaw", { guild_id: GUILD_B });
	const guildA = [stagedMeet];
	const guildB = [roomMeet, roomGlaw];
	const discord = fakeDiscord({
		bots: { [TOKEN]: { appId: APP } },
		guilds: { [`${APP}/${GUILD}`]: guildA, [`${APP}/${GUILD_B}`]: guildB },
	});
	const projects = [
		{
			projectName: "a",
			voiceRoom: { guildId: GUILD_B, voiceChannelId: "1" },
			leads: [{ botTokenEnv: "LEAD_SAME" }],
		},
	];
	const w = world({
		projects,
		targets: [
			{
				envName: "ORCH_TOKEN",
				appId: APP,
				guildIds: [GUILD],
				required: true,
				extraCommandNames: ["meet"],
				note: "staged rig",
			},
		],
	});
	const r = await run({
		w,
		discord,
		env: { ORCH_TOKEN: TOKEN, LEAD_SAME: TOKEN },
		argv: ["--apply"],
	});
	assert.equal(r.code, 0, r.out);
	assert.deepEqual(
		r.receipt.deleted.map((d) => `${d.guildId}:${d.name}`).sort(),
		[`${GUILD}:meet`, `${GUILD_B}:glaw`].sort(),
	);
	assert.ok(
		guildB.some((c) => c.id === roomMeet.id),
		"/meet outside the target guild stays",
	);
	const guilds = Object.fromEntries(
		r.receipt.targets[0].guilds.map((g) => [g.guildId, g.commandNames]),
	);
	assert.ok(guilds[GUILD].includes("meet"));
	assert.ok(!guilds[GUILD_B].includes("meet"));
});

test("required coverage is judged per guild, not per shared token", async () => {
	// Required target covers GUILD; the same token also reaches GUILD_B only as
	// an optional Lead candidate, and that optional guild refuses the listing.
	const discord = fakeDiscord({
		bots: { [TOKEN]: { appId: APP } },
		guilds: {
			[`${APP}/${GUILD}`]: [],
			[`${APP}/${GUILD_B}`]: { status: 403, code: 50001 },
		},
	});
	const projects = [
		{
			projectName: "a",
			voiceRoom: { guildId: GUILD_B, voiceChannelId: "1" },
			leads: [{ botTokenEnv: "LEAD_SAME" }],
		},
	];
	const r = await run({
		w: world({ projects }),
		discord,
		env: { ORCH_TOKEN: TOKEN, LEAD_SAME: TOKEN },
	});
	assert.equal(r.code, 0, r.out);
	assert.deepEqual(r.receipt.uncovered, []);
	const byGuild = Object.fromEntries(
		r.receipt.targets[0].guilds.map((g) => [g.guildId, g]),
	);
	assert.equal(byGuild[GUILD].required, true);
	assert.equal(byGuild[GUILD].status, "queried_ok");
	assert.equal(byGuild[GUILD_B].required, false);
	assert.equal(byGuild[GUILD_B].status, "access_denied");
	// ...and a refused required guild still fails the run.
	const refused = fakeDiscord({
		bots: { [TOKEN]: { appId: APP } },
		guilds: {
			[`${APP}/${GUILD}`]: { status: 403, code: 50001 },
			[`${APP}/${GUILD_B}`]: [],
		},
	});
	const bad = await run({
		w: world({ projects }),
		discord: refused,
		env: { ORCH_TOKEN: TOKEN, LEAD_SAME: TOKEN },
	});
	assert.notEqual(bad.code, 0);
	assert.deepEqual(bad.receipt.uncovered, ["ORCH_TOKEN"]);
});

test("extraCommandNames outside the slash-command grammar are refused", async () => {
	const discord = fakeDiscord({ bots: { [TOKEN]: { appId: APP } } });
	for (const bad of ["Meet", "", "has space", "x".repeat(33), 7]) {
		const w = world({
			targets: [
				{
					envName: "ORCH_TOKEN",
					appId: APP,
					guildIds: [GUILD],
					required: true,
					extraCommandNames: [bad],
					note: "x",
				},
			],
		});
		const r = await run({ w, discord });
		assert.equal(
			r.code,
			2,
			`extra name ${JSON.stringify(bad)} must be refused`,
		);
	}
});
