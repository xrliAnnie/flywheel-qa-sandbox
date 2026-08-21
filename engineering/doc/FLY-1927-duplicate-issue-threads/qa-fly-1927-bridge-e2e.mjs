#!/usr/bin/env node
/**
 * FLY-1927 — REAL Bridge + REAL Discord E2E in the 529 QA room (slot 2).
 * Covers the leg the module harness cannot: the NEW /api/chat-threads/send
 * 404-recovery path in bridge/tools.ts. Ground truth = Discord API read-back
 * plus the slot's own teamlead.db.
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const BRIDGE = "http://localhost:19872";
const CHANNEL = "1493080993173737583";
const PROJECT = "test-slot-2";
const LEAD = "flywheel-test-2";
const ISSUE = "FLY-1927";
const DB = "/tmp/flywheel-test-slot-2/teamlead.db";
const API = "https://discord.com/api/v10";

const env = readFileSync("/Users/xiaorongli/.flywheel/.env", "utf8");
const TOKEN = env.match(
	/^\s*(?:export\s+)?TEST_BOT_TOKEN_2=["']?([^"'\n]+)/m,
)?.[1];
if (!TOKEN) { console.error("FATAL: TEST_BOT_TOKEN_2 missing"); process.exit(1); }
const auth = { Authorization: `Bot ${TOKEN}` };

const results = [];
const rec = (n, p, d) => { results.push({ n, p, d }); console.log(`${p?"PASS":"FAIL"}  ${n}\n      ${d}`); };

const BEARER = readFileSync(
	"/private/tmp/claude-501/-Users-xiaorongli-Dev-flywheel-FLY-1927/f224355a-ab52-434c-bee0-9e8b26397272/scratchpad/.slot2tok",
	"utf8",
).trim();
const post = async (path, body) => {
	const r = await fetch(`${BRIDGE}/api${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${BEARER}`,
		},
		body: JSON.stringify(body),
	});
	let j = null;
	try { j = await r.json(); } catch {}
	return { status: r.status, body: j };
};

const rows = () => {
	if (!existsSync(DB)) return [];
	const out = execFileSync("sqlite3", ["-readonly", DB,
		`SELECT thread_id||'|'||COALESCE(discord_missing_at,'-') FROM chat_threads WHERE issue_id='${ISSUE}' AND channel_id='${CHANNEL}';`],
		{ encoding: "utf8" });
	return out.trim().split("\n").filter(Boolean);
};

const threadsInChannel = async () => {
	const ch = await (await fetch(`${API}/channels/${CHANNEL}`, { headers: auth })).json();
	const act = await (await fetch(`${API}/guilds/${ch.guild_id}/threads/active`, { headers: auth })).json();
	return (act.threads ?? []).filter((t) => t.parent_id === CHANNEL).map((t) => t.id);
};
const getStatus = async (u) => (await fetch(u, { headers: auth })).status;
const delThread = async (id) => (await fetch(`${API}/channels/${id}`, { method: "DELETE", headers: auth })).status;
const delMsg = async (ch, id) => (await fetch(`${API}/channels/${ch}/messages/${id}`, { method: "DELETE", headers: auth })).status;
const msgsIn = async (id) => {
	const r = await fetch(`${API}/channels/${id}/messages?limit=50`, { headers: auth });
	return r.ok ? await r.json() : [];
};

async function main() {
	const stamp = Date.now().toString(36);
	// baseline: remove any pre-existing thread for this issue in the slot
	execFileSync("sqlite3", [DB,
		`DELETE FROM chat_threads WHERE issue_id='${ISSUE}' AND channel_id='${CHANNEL}';`]);
	const pre = await threadsInChannel();
	console.log(`### baseline active threads in slot channel: ${pre.length}`);

	/* B1 — first /send on a row miss creates exactly one thread and delivers */
	const s1 = await post("/chat-threads/send", {
		issueIdentifier: ISSUE, channelId: CHANNEL, leadId: LEAD,
		projectName: PROJECT, text: `QA1927-B1-${stamp} first send`,
	});
	const t = s1.body?.threadId;
	const after1 = await threadsInChannel();
	const newOnes = after1.filter((x) => !pre.includes(x));
	const m1 = t ? await msgsIn(t) : [];
	rec("B1 first /send (row miss) → exactly ONE new thread, message delivered into it",
		s1.status === 200 && !!t && newOnes.length === 1 && newOnes[0] === t &&
		m1.some((m) => String(m.content).includes(`QA1927-B1-${stamp}`)),
		`http=${s1.status} threadId=${t} created=${s1.body?.created} newThreads=${JSON.stringify(newOnes)} rows=${JSON.stringify(rows())}`);

	if (!t) { console.log("### aborting: no thread"); process.exit(1); }

	/* Premise plumbing note: the slot-2 bot has no MANAGE_THREADS (DELETE
	   /channels/<thread> → 403), so the "canonical is gone from Discord" state is
	   established by repointing the slot's OWN registry row — the exact state a
	   production row reaches when a thread disappears. The delete-driven version
	   of the same premise is covered in the module-driven arm (slot-1 token). */
	const repoint = (id) =>
		execFileSync("sqlite3", [DB,
			`UPDATE chat_threads SET thread_id='${id}' WHERE issue_id='${ISSUE}' AND channel_id='${CHANNEL}';`]);

	const postPlain = async (content) => {
		const r = await fetch(`${API}/channels/${CHANNEL}/messages`, {
			method: "POST",
			headers: { ...auth, "Content-Type": "application/json" },
			body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
		});
		return (await r.json()).id;
	};

	/* B2 — registry points at a LIVE root message that is not (yet) a thread.
	   /send must 404 on the first chunk, re-enter the creator, start the thread
	   on THAT SAME id, and deliver — never open a second thread. */
	const root2 = await postPlain(`QA1927-B2root-${stamp}`);
	repoint(root2);
	const preB2 = {
		thread: await getStatus(`${API}/channels/${root2}`),
		root: await getStatus(`${API}/channels/${CHANNEL}/messages/${root2}`),
	};
	const before2 = await threadsInChannel();
	const s2 = await post("/chat-threads/send", {
		issueIdentifier: ISSUE, channelId: CHANNEL, leadId: LEAD,
		projectName: PROJECT, text: `QA1927-B2-${stamp} recovery`,
	});
	const after2 = await threadsInChannel();
	const new2 = after2.filter((x) => !before2.includes(x));
	const m2 = await msgsIn(root2);
	rec("B2 canonical id not a thread (root alive) → /send recovers on the SAME id, no duplicate",
		preB2.thread === 404 && preB2.root === 200 && s2.status === 200 &&
		s2.body?.threadId === root2 && new2.length === 1 && new2[0] === root2 &&
		m2.some((m) => String(m.content).includes(`QA1927-B2-${stamp}`)),
		`premise{threadGET:${preB2.thread},rootGET:${preB2.root}} http=${s2.status} body=${JSON.stringify(s2.body).slice(0,200)} newThreads=${JSON.stringify(new2)} rows=${JSON.stringify(rows())}`);

	/* B3 — registry points at an id that is neither a thread nor a message. */
	const ghost = "1400000000000000001";
	repoint(ghost);
	const preB3 = {
		thread: await getStatus(`${API}/channels/${ghost}`),
		root: await getStatus(`${API}/channels/${CHANNEL}/messages/${ghost}`),
	};
	const before3 = await threadsInChannel();
	const s3 = await post("/chat-threads/send", {
		issueIdentifier: ISSUE, channelId: CHANNEL, leadId: LEAD,
		projectName: PROJECT, text: `QA1927-B3-${stamp} both gone`,
	});
	const after3 = await threadsInChannel();
	const new3 = after3.filter((x) => !before3.includes(x));
	rec("B3 canonical thread AND root both gone → typed 502, NO new thread created",
		preB3.thread === 404 && preB3.root === 404 && s3.status === 502 &&
		s3.body?.errorCode === "canonical_root_gone" && new3.length === 0,
		`premise{threadGET:${preB3.thread},rootGET:${preB3.root}} http=${s3.status} body=${JSON.stringify(s3.body).slice(0,260)} newThreads=${JSON.stringify(new3)}`);

	/* B4 — /chat-threads/create refuses identically; still no rebuild. */
	const before4 = await threadsInChannel();
	const s4 = await post("/chat-threads/create", {
		issueIdentifier: ISSUE, channelId: CHANNEL, leadId: LEAD, projectName: PROJECT,
	});
	const after4 = await threadsInChannel();
	const new4 = after4.filter((x) => !before4.includes(x));
	rec("B4 /chat-threads/create on the dead canonical → same typed refusal, no rebuild",
		s4.status === 502 && s4.body?.errorCode === "canonical_root_gone" && new4.length === 0,
		`http=${s4.status} body=${JSON.stringify(s4.body).slice(0,260)} newThreads=${JSON.stringify(new4)}`);

	/* B5 — the documented fenced abandon (operations.md §2) unblocks rebuild. */
	execFileSync("sqlite3", [DB,
		`UPDATE chat_threads SET discord_missing_at=datetime('now') WHERE issue_id='${ISSUE}' AND channel_id='${CHANNEL}' AND thread_id='${ghost}' AND discord_missing_at IS NULL;`]);
	const before5 = await threadsInChannel();
	const s5 = await post("/chat-threads/create", {
		issueIdentifier: ISSUE, channelId: CHANNEL, leadId: LEAD, projectName: PROJECT,
	});
	const after5 = await threadsInChannel();
	const new5 = after5.filter((x) => !before5.includes(x));
	rec("B5 after the documented fenced abandon → exactly ONE new thread",
		s5.status === 200 && !!s5.body?.threadId && new5.length === 1 && new5[0] === s5.body.threadId,
		`http=${s5.status} body=${JSON.stringify(s5.body).slice(0,180)} newThreads=${JSON.stringify(new5)} rows=${JSON.stringify(rows())}`);

	/* B6 — /chat-threads/register may not steal the canonical the creator holds */
	// Use a REAL live thread in this channel that is NOT the canonical, so the
	// request survives Discord validation and actually reaches the ownership guard.
	const s6 = await post("/chat-threads/register", {
		threadId: root2, channelId: CHANNEL, leadId: LEAD,
		issueId: ISSUE, projectName: PROJECT,
	});
	rec("B6 /chat-threads/register cannot overwrite the live canonical row",
		s6.status === 409 && JSON.stringify(rows()).includes(s5.body?.threadId ?? "@"),
		`http=${s6.status} body=${JSON.stringify(s6.body).slice(0,200)} rows=${JSON.stringify(rows())}`);

	// cleanup
	for (const id of [t, root2, s5.body?.threadId].filter(Boolean)) {
		await fetch(`${API}/channels/${id}`, {
			method: "PATCH",
			headers: { ...auth, "Content-Type": "application/json" },
			body: JSON.stringify({ archived: true }),
		}).catch(() => {});
	}
	const failed = results.filter((r) => !r.p);
	console.log(`\n### BRIDGE E2E RESULT: ${results.length - failed.length}/${results.length} passed`);
	process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error("CRASH", e); process.exit(2); });
