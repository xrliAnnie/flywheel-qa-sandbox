#!/usr/bin/env node
/**
 * FLY-1255 — REAL Discord E2E (independent QA session 212eca7e).
 *
 * Drives the PRODUCTION ChatThreadCreator title path against the isolated 529
 * QA room (slot 1 `cos-test`), then reads each thread name BACK from the
 * Discord API. The writer's own return value is not evidence — the ground
 * truth is what Discord actually stores.
 *
 * Per the QA recipe: the title path never touches StateStore, so an empty stub
 * is enough and no Bridge needs to start. One stamp per fresh thread keeps us
 * under Discord's hard 2-renames/10-min-per-thread limit.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ROOT = "/Users/xiaorongli/Dev/flywheel-FLY-1255";

const { ChatThreadCreator } = require(
	`${ROOT}/packages/teamlead/dist/bridge/ChatThreadCreator.js`,
);
const rmd = require(
	`${ROOT}/packages/teamlead/dist/bridge/runner-model-display.js`,
);

const API = "https://discord.com/api/v10";
const CHANNEL = "1493080991290626079"; // 529 Room slot 1 — cos-test (isolated)

// Token from ~/.flywheel/.env — read from file, never echoed.
const env = require("node:fs").readFileSync(
	"/Users/xiaorongli/.flywheel/.env",
	"utf8",
);
const TOKEN = env.match(
	/^\s*(?:export\s+)?TEST_BOT_TOKEN_1=["']?([^"'\n]+)/m,
)?.[1];
if (!TOKEN) {
	console.error("FATAL: TEST_BOT_TOKEN_1 not resolvable from ~/.flywheel/.env");
	process.exit(1);
}

const auth = {
	Authorization: `Bot ${TOKEN}`,
	"Content-Type": "application/json",
};

async function createThread(name) {
	const r = await fetch(`${API}/channels/${CHANNEL}/threads`, {
		method: "POST",
		headers: auth,
		body: JSON.stringify({ name, type: 11, auto_archive_duration: 60 }),
	});
	if (!r.ok)
		throw new Error(`create thread failed ${r.status}: ${await r.text()}`);
	return (await r.json()).id;
}

/** GROUND TRUTH: what Discord actually stores as the thread name. */
async function readBackName(threadId) {
	const r = await fetch(`${API}/channels/${threadId}`, { headers: auth });
	if (!r.ok)
		throw new Error(`read thread failed ${r.status}: ${await r.text()}`);
	return (await r.json()).name;
}

async function archive(threadId) {
	await fetch(`${API}/channels/${threadId}`, {
		method: "PATCH",
		headers: auth,
		body: JSON.stringify({ archived: true, locked: false }),
	}).catch(() => {});
}

const creator = new ChatThreadCreator({});

const SCENARIOS = [
	{
		name: "Codex backend (the FLY-1255 bug: GPT-5.6 must be visible)",
		session: {
			adapter_type: "codex-tmux",
			runner_model: "gpt-5.6-sol",
			chat_thread_role: "implement",
		},
		issueKey: "FLY-1255",
		title: "vendor-neutral model display",
		phaseBadge: "🔨实现",
		expect: "🔨实现 [Model GPT-5.6] [FLY-1255] vendor-neutral model display",
	},
	{
		name: "Kimi backend (must not be swallowed by Claude logic)",
		session: {
			adapter_type: "kimi-tmux",
			runner_model: "kimi-for-coding",
			chat_thread_role: null,
		},
		issueKey: "FLY-1255",
		title: "kimi runner",
		phaseBadge: "🧪QA",
		expect: "🧪QA [Model kimi-for-coding] [FLY-1255] kimi runner",
	},
	{
		name: "Claude backward-compat (F/O/S/H must not regress)",
		session: {
			adapter_type: "claude-tmux",
			runner_model: "claude-fable-5",
			chat_thread_role: null,
		},
		issueKey: "FLY-1255",
		title: "claude runner",
		phaseBadge: "🎨设计",
		expect: "🎨设计 [F] [FLY-1255] claude runner",
	},
	{
		name: "Model-absent legacy (byte-compat: no marker at all)",
		session: {
			adapter_type: "claude-tmux",
			runner_model: null,
			chat_thread_role: null,
		},
		issueKey: "FLY-1255",
		title: "legacy runner",
		phaseBadge: "🎨设计",
		expect: "🎨设计 [FLY-1255] legacy runner",
	},
];

let pass = 0;
const failures = [];
const threads = [];

for (const sc of SCENARIOS) {
	const display = rmd.sessionModelDisplay(sc.session, {});
	const marker = display ? display.threadMarker : null;
	const base = `[${sc.issueKey}] ${sc.title}`;

	const threadId = await createThread(base);
	threads.push(threadId);

	const ctx = {
		chatChannelId: CHANNEL,
		issueId: sc.issueKey,
		issueIdentifier: sc.issueKey,
		issueTitle: sc.title,
		botToken: TOKEN,
		modelMarker: marker, // null => CLEAR (account default), string => SET
	};

	// Production write path (coalescing writer + 429 Retry-After honoring).
	const status = await creator.stampStageEmojiResult(
		ctx,
		threadId,
		"implement",
		true,
		sc.phaseBadge,
	);
	await new Promise((r) => setTimeout(r, 1200)); // let the PATCH settle
	const actual = await readBackName(threadId); // <-- ground truth from Discord

	const ok = actual === sc.expect;
	if (ok) pass++;
	else
		failures.push(
			`${sc.name}\n      expected: ${JSON.stringify(sc.expect)}\n      actual:   ${JSON.stringify(actual)}`,
		);
	console.log(`${ok ? "✓" : "✗"} ${sc.name}`);
	console.log(`    writer status : ${status}   (self-report — NOT evidence)`);
	console.log(`    Discord says  : ${JSON.stringify(actual)}`);
	if (!ok) console.log(`    EXPECTED      : ${JSON.stringify(sc.expect)}`);
	console.log(
		`    thread        : https://discord.com/channels/@me/${threadId}`,
	);
}

console.log(`\n${"=".repeat(60)}`);
console.log(`REAL DISCORD RESULT: ${pass}/${SCENARIOS.length} passed`);
if (failures.length) {
	console.log("\nFAILURES:");
	for (const f of failures) console.log(`  ✗ ${f}`);
}
console.log(`\nthread ids: ${threads.join(" ")}`);
for (const t of threads) await archive(t);
console.log("(threads archived)");
process.exit(failures.length ? 1 : 0);
