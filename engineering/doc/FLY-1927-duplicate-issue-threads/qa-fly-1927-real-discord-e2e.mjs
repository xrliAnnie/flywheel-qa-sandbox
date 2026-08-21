#!/usr/bin/env node
/**
 * FLY-1927 — REAL Discord E2E, module-driven (independent QA).
 *
 * Ground truth is Discord itself: every assertion reads thread/message state
 * BACK from the Discord REST API. The creator's own return value is never
 * treated as evidence.
 *
 * Two arms, same scenarios, same isolated channel:
 *   FIX    = this worktree's compiled dist (PR #905 head)
 *   BEFORE = the production checkout's compiled dist (pre-FLY-1927 main)
 *
 * Isolation: 529 QA room slot-1 channel (cos-test) + TEST_BOT_TOKEN_1 + a
 * throwaway StateStore under $TMPDIR. Production teamlead.db is never opened.
 */
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);

const ARM = process.argv[2] === "before" ? "before" : "fix";
const ROOT =
	ARM === "before"
		? "/Users/xiaorongli/Dev/flywheel"
		: "/Users/xiaorongli/Dev/flywheel-FLY-1927";

const { ChatThreadCreator } = require(
	`${ROOT}/packages/teamlead/dist/bridge/ChatThreadCreator.js`,
);
const { StateStore } = require(`${ROOT}/packages/teamlead/dist/StateStore.js`);
let registerMod = null;
try {
	registerMod = require(
		`${ROOT}/packages/teamlead/dist/bridge/chat-thread-register.js`,
	);
} catch {}

const API = "https://discord.com/api/v10";
const CHANNEL = "1493080991290626079"; // 529 QA room slot 1 (isolated)

const env = readFileSync("/Users/xiaorongli/.flywheel/.env", "utf8");
const TOKEN = env.match(
	/^\s*(?:export\s+)?TEST_BOT_TOKEN_1=["']?([^"'\n]+)/m,
)?.[1];
if (!TOKEN) {
	console.error("FATAL: TEST_BOT_TOKEN_1 not resolvable");
	process.exit(1);
}
const auth = { Authorization: `Bot ${TOKEN}` };

const realFetch = globalThis.fetch;
const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

/* ---------------- Discord ground-truth readers ---------------- */

async function listThreadsFor(tag) {
	// A thread's id == its root message id, so we enumerate BOTH active and
	// archived listings and match on the harness tag inside the thread name.
	const out = new Map();
	for (const path of [
		`/guilds/GUILD/threads/active`, // resolved below
		`/channels/${CHANNEL}/threads/archived/public?limit=100`,
	]) {
		let url = `${API}${path}`;
		if (path.startsWith("/guilds")) {
			const ch = await (
				await realFetch(`${API}/channels/${CHANNEL}`, { headers: auth })
			).json();
			url = `${API}/guilds/${ch.guild_id}/threads/active`;
		}
		const r = await realFetch(url, { headers: auth });
		if (!r.ok) continue;
		const d = await r.json();
		for (const t of d.threads ?? []) {
			if (t.parent_id !== CHANNEL) continue;
			if (!String(t.name ?? "").includes(tag)) continue;
			out.set(t.id, t.name);
		}
	}
	return out;
}

async function getChannel(id) {
	const r = await realFetch(`${API}/channels/${id}`, { headers: auth });
	return { status: r.status, body: r.ok ? await r.json() : null };
}

async function getMessage(channelId, msgId) {
	const r = await realFetch(`${API}/channels/${channelId}/messages/${msgId}`, {
		headers: auth,
	});
	return { status: r.status, body: r.ok ? await r.json() : null };
}

/** Root messages posted by us in the channel that carry the harness tag. */
async function listRootMessagesFor(tag) {
	const r = await realFetch(
		`${API}/channels/${CHANNEL}/messages?limit=100`,
		{ headers: auth },
	);
	if (!r.ok) return [];
	const msgs = await r.json();
	return msgs.filter((m) => String(m.content ?? "").includes(tag));
}

/**
 * REAL-DISCORD FACT (measured, 2026-08-20): deleting a thread's STARTER MESSAGE
 * makes GET /channels/{ch}/messages/{id} return 404 while the thread itself
 * stays alive (GET /channels/{id} == 200). Only deleting the THREAD CHANNEL
 * makes both 404. Cleanup and the "both gone" scenario therefore delete the
 * thread channel, not the message.
 */
async function deleteThreadChannel(threadId) {
	const r = await realFetch(`${API}/channels/${threadId}`, {
		method: "DELETE",
		headers: auth,
	});
	return r.status;
}

async function deleteMessage(channelId, msgId) {
	await realFetch(`${API}/channels/${channelId}/messages/${msgId}`, {
		method: "DELETE",
		headers: auth,
	});
}

/* ---------------- harness plumbing ---------------- */

const results = [];
function record(name, pass, detail) {
	results.push({ name, pass, detail });
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
}

function ctxFor(issueId, title) {
	return {
		chatChannelId: CHANNEL,
		issueId,
		issueIdentifier: issueId,
		issueTitle: title,
		botToken: TOKEN,
		leadId: "qa-fly-1927-lead",
	};
}

/** Install a fetch that runs the real request then simulates a client blackout. */
function installBlackoutAfterStart(matcher) {
	globalThis.fetch = async (url, init) => {
		const u = String(url);
		if (matcher(u, init)) {
			// Perform the REAL write so Discord truly creates the thread…
			await realFetch(url, init).catch(() => {});
			// …then behave exactly like an aborted client.
			const e = new Error("The operation was aborted.");
			e.name = "AbortError";
			throw e;
		}
		return realFetch(url, init);
	};
}

function installStartBlocker(matcher, status = 500) {
	globalThis.fetch = async (url, init) => {
		if (matcher(String(url), init)) {
			return new Response("simulated upstream failure", { status });
		}
		return realFetch(url, init);
	};
}

function restoreFetch() {
	globalThis.fetch = realFetch;
}

const isStartCall = (u, init) =>
	/\/messages\/\d+\/threads$/.test(u) && (init?.method ?? "GET") === "POST";
const isProbe = (u, init) =>
	(init?.method ?? "GET") === "GET" && /\/channels\//.test(u);

/* ---------------- scenarios ---------------- */

async function main() {
	const dir = mkdtempSync(join(tmpdir(), "fly1927-qa-"));
	const store = await StateStore.create(join(dir, "qa.db"));
	const creator = new ChatThreadCreator(store);
	const cleanupThreads = [];
	const tag = `QA1927-${ARM}-${RUN}`;

	console.log(`\n### ARM=${ARM}  root=${ROOT}`);
	console.log(`### channel=${CHANNEL} tag=${tag} db=${dir}\n`);

	/* S1 — happy path: one thread, registry == Discord == root message id */
	{
		const issue = `${tag}-S1`;
		const res = await creator.ensureChatThread(ctxFor(issue, `${tag} S1 happy`));
		const row = store.getChatThreadByIssue(issue, CHANNEL);
		const threads = await listThreadsFor(`${tag}-S1`);
		const ids = [...threads.keys()];
		if (res.threadId) cleanupThreads.push(res.threadId);
		const ch = res.threadId ? await getChannel(res.threadId) : { status: 0 };
		const rootMsg = res.threadId
			? await getMessage(CHANNEL, res.threadId)
			: { status: 0 };
		record(
			"S1 healthy create → exactly ONE Discord thread, registry == thread id == root message id",
			ids.length === 1 &&
				row?.thread_id === res.threadId &&
				ids[0] === res.threadId &&
				ch.status === 200 &&
				ch.body?.parent_id === CHANNEL &&
				rootMsg.status === 200,
			`discordThreads=${ids.length} ${JSON.stringify(ids)} row=${row?.thread_id} returned=${res.threadId} channelGET=${ch.status} parent=${ch.body?.parent_id} rootMsgGET=${rootMsg.status}`,
		);
	}

	/* S2 — THE PRODUCTION INCIDENT: step-2 succeeds at Discord, client blacks
	   out, caller returns an error; a LATER call (the Lead's /send) must not
	   open a second thread. */
	{
		const issue = `${tag}-S2`;
		installBlackoutAfterStart(
			(u, init) => isStartCall(u, init) || isProbe(u, init),
		);
		let first;
		try {
			first = await creator.ensureChatThread(ctxFor(issue, `${tag} S2 blackout`));
		} catch (err) {
			first = { threw: String(err) };
		}
		restoreFetch();
		const rowAfterFirst = store.getChatThreadByIssue(issue, CHANNEL);

		// Simulate the Lead's later /api/chat-threads/send → ensure on row miss.
		const second = await creator.ensureChatThread(
			ctxFor(issue, `${tag} S2 blackout`),
		);
		const rowAfterSecond = store.getChatThreadByIssue(issue, CHANNEL);
		const threads = await listThreadsFor(`${tag}-S2`);
		const ids = [...threads.keys()];
		for (const id of ids) cleanupThreads.push(id);
		record(
			"S2 step-2 blackout (Discord DID create) → later call opens NO second thread",
			ids.length === 1 &&
				!!rowAfterSecond &&
				ids.includes(rowAfterSecond.thread_id),
			`discordThreads=${ids.length} ${JSON.stringify(ids)} rowAfterFirst=${rowAfterFirst?.thread_id ?? "NONE"} first=${JSON.stringify(first).slice(0, 220)} rowAfterSecond=${rowAfterSecond?.thread_id ?? "NONE"} second=${JSON.stringify({ created: second.created, threadId: second.threadId, errorCode: second.errorCode }).slice(0, 200)}`,
		);
	}

	/* S3 — step-2 genuinely fails upstream (never reaches Discord); the creator
	   must replay against the SAME root, never post a second root message. */
	{
		const issue = `${tag}-S3`;
		let startCalls = 0;
		globalThis.fetch = async (url, init) => {
			if (isStartCall(String(url), init)) {
				startCalls += 1;
				if (startCalls === 1) {
					return new Response("simulated 500", { status: 500 });
				}
			}
			return realFetch(url, init);
		};
		const res = await creator.ensureChatThread(ctxFor(issue, `${tag} S3 retry`));
		restoreFetch();
		const row = store.getChatThreadByIssue(issue, CHANNEL);
		const threads = await listThreadsFor(`${tag}-S3`);
		const ids = [...threads.keys()];
		for (const id of ids) cleanupThreads.push(id);
		const roots = await listRootMessagesFor(`${tag}-S3`);
		record(
			"S3 step-2 upstream 500 → same-root replay, ONE thread, ONE root message",
			ids.length === 1 &&
				roots.length === 1 &&
				!!res.threadId &&
				ids[0] === res.threadId &&
				row?.thread_id === res.threadId,
			`startCalls=${startCalls} discordThreads=${ids.length} rootMessagesInChannel=${roots.length} returned=${res.threadId ?? "NONE"} row=${row?.thread_id ?? "NONE"} err=${res.error ?? "none"}`,
		);
	}

	/* S4 — two independent stores/creators on the SAME db race concurrently. */
	{
		const issue = `${tag}-S4`;
		const storeB = await StateStore.create(join(dir, "qa.db"));
		const creatorB = new ChatThreadCreator(storeB);
		const [a, b] = await Promise.all([
			creator.ensureChatThread(ctxFor(issue, `${tag} S4 race`)).catch((e) => ({
				error: String(e),
			})),
			creatorB.ensureChatThread(ctxFor(issue, `${tag} S4 race`)).catch((e) => ({
				error: String(e),
			})),
		]);
		const threads = await listThreadsFor(`${tag}-S4`);
		const ids = [...threads.keys()];
		for (const id of ids) cleanupThreads.push(id);
		const row = store.getChatThreadByIssue(issue, CHANNEL);
		record(
			"S4 two independent Bridges race → exactly ONE Discord thread survives",
			ids.length === 1 && !!row && ids.includes(row.thread_id),
			`discordThreads=${ids.length} ${JSON.stringify(ids)} row=${row?.thread_id ?? "NONE"} a=${JSON.stringify({ c: a.created, t: a.threadId, e: a.errorCode ?? a.error }).slice(0, 140)} b=${JSON.stringify({ c: b.created, t: b.threadId, e: b.errorCode ?? b.error }).slice(0, 140)}`,
		);
	}

	/* S5 — /register may not overwrite a canonical the creator already claimed */
	{
		const issue = `${tag}-S5`;
		const res = await creator.ensureChatThread(ctxFor(issue, `${tag} S5 reg`));
		if (res.threadId) cleanupThreads.push(res.threadId);
		let verdict = "register module unavailable";
		let pass = false;
		if (registerMod?.validateAndRegisterChatThread) {
			const projects = [
				{
					projectName: "qa-fly-1927",
					leads: [
						{ agentId: "qa-fly-1927-lead", chatChannel: CHANNEL },
					],
				},
			];
			const out = await registerMod.validateAndRegisterChatThread(
				{
					threadId: "999999999999999999",
					channelId: CHANNEL,
					issueId: issue,
					leadId: "qa-fly-1927-lead",
					projectName: "qa-fly-1927",
				},
				store,
				projects,
			);
			const row = store.getChatThreadByIssue(issue, CHANNEL);
			pass = out?.ok === false && row?.thread_id === res.threadId;
			verdict = `register=${JSON.stringify(out).slice(0, 200)} rowStill=${row?.thread_id} createdWas=${res.threadId}`;
		}
		record(
			"S5 /register cannot overwrite the creator's canonical row",
			pass,
			verdict,
		);
	}

	/* S6 — deletion states, measured against real Discord semantics:
	   deleting the THREAD leaves the starter message; deleting the STARTER
	   MESSAGE leaves the thread. Only doing both erases the canonical. */
	{
		const issue = `${tag}-S6`;
		const res = await creator.ensureChatThread(ctxFor(issue, `${tag} S6 gone`));
		const created = res.threadId;
		cleanupThreads.push(created);

		/* S6a — founder deletes the THREAD; root message survives.
		   Correct behavior: replay start on the SAME root → same thread id back,
		   never a second thread and never a second root message. */
		const delThread = await deleteThreadChannel(created);
		await new Promise((r) => setTimeout(r, 1500));
		const preA = {
			thread: (await getChannel(created)).status,
			root: (await getMessage(CHANNEL, created)).status,
		};
		const healed = await creator.ensureChatThread(
			ctxFor(issue, `${tag} S6 gone`),
		);
		const idsA = [...(await listThreadsFor(`${tag}-S6`)).keys()];
		const rootsA = await listRootMessagesFor(`${tag}-S6`);
		if (healed.threadId) cleanupThreads.push(healed.threadId);
		record(
			"S6a thread deleted (root alive) → same-id self-heal, ONE thread, ONE root message",
			preA.thread === 404 &&
				preA.root === 200 &&
				healed.threadId === created &&
				idsA.length === 1 &&
				rootsA.length === 1,
			`deleteThread=${delThread} premise{threadGET:${preA.thread},rootGET:${preA.root}} healed=${healed.threadId ?? "NONE"} (was ${created}) threads=${idsA.length} roots=${rootsA.length} err=${healed.error ?? "none"}`,
		);

		/* S6b — now erase BOTH: thread channel + starter message. */
		await deleteThreadChannel(created);
		await deleteMessage(CHANNEL, created);
		await new Promise((r) => setTimeout(r, 1500));
		const preB = {
			thread: (await getChannel(created)).status,
			root: (await getMessage(CHANNEL, created)).status,
		};
		const after = await creator.ensureChatThread(
			ctxFor(issue, `${tag} S6 gone`),
		);
		const idsB = [...(await listThreadsFor(`${tag}-S6`)).keys()];
		const rootsB = await listRootMessagesFor(`${tag}-S6`);
		for (const id of idsB) cleanupThreads.push(id);
		record(
			"S6b thread AND root both gone → typed loud failure, no rebuild, no new root message",
			preB.thread === 404 &&
				preB.root === 404 &&
				!!after.error &&
				idsB.length === 0 &&
				rootsB.length === 0,
			`premise{threadGET:${preB.thread},rootGET:${preB.root}} result=${JSON.stringify({ created: after.created, threadId: after.threadId, errorCode: after.errorCode, error: (after.error ?? "").slice(0, 130) })} liveThreads=${idsB.length} liveRoots=${rootsB.length}`,
		);

		/* S6c — documented fenced manual abandon (operations.md) unblocks it. */
		store.markChatThreadMissing(created);
		const rebuilt = await creator.ensureChatThread(
			ctxFor(issue, `${tag} S6 gone`),
		);
		if (rebuilt.threadId) cleanupThreads.push(rebuilt.threadId);
		const idsC = [...(await listThreadsFor(`${tag}-S6`)).keys()];
		const row = store.getChatThreadByIssue(issue, CHANNEL);
		record(
			"S6c after the documented fenced abandon → exactly ONE new thread, registry follows",
			!!rebuilt.threadId &&
				idsC.length === 1 &&
				row?.thread_id === rebuilt.threadId,
			`rebuilt=${rebuilt.threadId ?? "NONE"} err=${rebuilt.error ?? "none"} liveThreads=${idsC.length} row=${row?.thread_id ?? "NONE"}`,
		);
	}

	/* cleanup: delete every root message we created (removes its thread too) */
	for (const id of new Set(cleanupThreads)) {
		await deleteThreadChannel(id).catch(() => {});
		await deleteMessage(CHANNEL, id).catch(() => {});
	}
	for (const m of await listRootMessagesFor(tag)) {
		await deleteMessage(CHANNEL, m.id).catch(() => {});
	}
	rmSync(dir, { recursive: true, force: true });

	const failed = results.filter((r) => !r.pass);
	console.log(
		`\n### ARM=${ARM} RESULT: ${results.length - failed.length}/${results.length} passed`,
	);
	process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => {
	console.error("HARNESS CRASH", e);
	process.exit(2);
});
