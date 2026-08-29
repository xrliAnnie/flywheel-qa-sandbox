/**
 * FLY-294 QA — Layer B: TRUE archive on real Discord (the irreplaceable proof).
 *
 * Fully isolated: only TEST_BOT_TOKEN_1 (flywheel-test-1) + the cos-test
 * channel in the "QA Testing" category. NEVER touches production Bridge /
 * channels / Linear / StateStore (StateStore here is an in-memory :memory: DB).
 *
 *  B1 — real archiveChatThread on a freshly-created real thread →
 *       GET the thread back from Discord and confirm thread_metadata.archived=true.
 *  B2 — real runPostShipFinalization (issue completion → archive + audit event)
 *       against real Discord + a real StateStore → Discord confirms archived AND
 *       the StateStore holds a chat_thread_archived audit event.
 *  B3 — real Discord 404: create a thread, delete it, archive the gone id →
 *       markDiscordMissing fires, reason=missing, never throws.
 *
 * Every created thread is deleted in cleanup so the sandbox stays clean.
 */
import {
	type ArchiveChatThreadResult,
	archiveChatThread,
} from "../packages/teamlead/src/bridge/chat-thread-utils.ts";
import { runPostShipFinalization } from "../packages/teamlead/src/bridge/post-ship-finalization.ts";
import type { ProjectEntry } from "../packages/teamlead/src/ProjectConfig.ts";
import { StateStore } from "../packages/teamlead/src/StateStore.ts";
import { check, startFakeDiscord, summary } from "./fake-discord.mts";

const COS_TEST_CHANNEL = "1493080991290626079"; // QA Testing / cos-test
const TOKEN = process.env.TEST_BOT_TOKEN_1;
const DISCORD = "https://discord.com/api/v10";

if (!TOKEN) {
	console.error("FATAL: TEST_BOT_TOKEN_1 not in env — cannot run Layer B.");
	process.exit(2);
}

async function dapi(
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; json: any }> {
	const res = await fetch(`${DISCORD}${path}`, {
		method,
		headers: {
			Authorization: `Bot ${TOKEN}`,
			"Content-Type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	let json: any;
	try {
		json = text ? JSON.parse(text) : undefined;
	} catch {
		json = text;
	}
	return { status: res.status, json };
}

async function createThread(name: string): Promise<string> {
	const r = await dapi("POST", `/channels/${COS_TEST_CHANNEL}/threads`, {
		name,
		type: 11, // PUBLIC_THREAD
		auto_archive_duration: 60,
	});
	if (r.status >= 300 || !r.json?.id) {
		throw new Error(
			`createThread failed: ${r.status} ${JSON.stringify(r.json)}`,
		);
	}
	return r.json.id as string;
}

async function isArchivedOnDiscord(threadId: string): Promise<boolean | null> {
	const r = await dapi("GET", `/channels/${threadId}`);
	if (r.status >= 300) return null;
	const flag = r.json?.thread_metadata?.archived ?? r.json?.archived;
	return typeof flag === "boolean" ? flag : null;
}

const createdThreads: string[] = [];
const TS = Date.now();

console.log(
	"######## FLY-294 LAYER B — TRUE archive on real Discord (cos-test) ########\n",
);
console.log(
	`bot=flywheel-test-1  channel=cos-test(${COS_TEST_CHANNEL})  isolated=:memory: StateStore\n`,
);

try {
	// ── B-guard: confirm we loaded the #277 archiveChatThread (structured
	// result), not the pre-#277 base (Promise<void>). Probed against a local
	// fake server so the guard makes no real Discord call. ──
	{
		const probe = await startFakeDiscord(() => ({
			status: 200,
			body: { thread_metadata: { archived: true } },
		}));
		const r = await archiveChatThread("pr277-guard", "bot", {
			fetchImpl: probe.rewritingFetch,
		});
		await probe.close();
		if (!r || typeof r.reason !== "string") {
			console.error(
				`FATAL: archiveChatThread is NOT the #277 version (got ${JSON.stringify(r)}).`,
			);
			process.exit(2);
		}
		check(
			"B-guard",
			"PR-#277 guard: loaded archiveChatThread returns ArchiveChatThreadResult",
			r.reason === "ok" && r.archived === true,
			`probeResult={archived:${r.archived},reason:${r.reason}} (base would be undefined → harness aborts)`,
		);
	}

	// ── B0 preflight: bot can see the isolated channel ──
	{
		const r = await dapi("GET", `/channels/${COS_TEST_CHANNEL}`);
		check(
			"B0",
			"preflight: TEST bot can see the isolated cos-test channel",
			r.status === 200 && r.json?.id === COS_TEST_CHANNEL,
			`status=${r.status} channel=${r.json?.name} guild=${r.json?.guild_id}`,
		);
	}

	// ── B1: direct real archive → Discord confirms archived ──
	{
		const threadId = await createThread(`fly294-B1-${TS}`);
		createdThreads.push(threadId);
		const before = await isArchivedOnDiscord(threadId);
		const res = await archiveChatThread(threadId, TOKEN, {
			markDiscordMissing: () => {},
		});
		const after = await isArchivedOnDiscord(threadId);
		check(
			"B1",
			"real archiveChatThread → Discord GET confirms thread_metadata.archived=true",
			res.archived && res.reason === "ok" && before === false && after === true,
			`threadId=${threadId} fnResult={archived:${res.archived},attempts:${res.attempts},status:${res.status},reason:${res.reason}} discordArchived: before=${before} after=${after}`,
		);
	}

	// ── B2: full runPostShipFinalization → real archive + StateStore audit ──
	{
		const store = await StateStore.create(":memory:");
		const issueId = "FLY-294-QA";
		const executionId = `qa-fly294-b2-${TS}`;
		const threadId = await createThread(`fly294-B2-${TS}`);
		createdThreads.push(threadId);

		store.upsertSession({
			execution_id: executionId,
			issue_id: issueId,
			project_name: "qa-fly294",
			status: "completed",
		});
		store.upsertChatThread(threadId, COS_TEST_CHANNEL, issueId);

		const projects: ProjectEntry[] = [
			{
				projectName: "qa-fly294",
				projectRoot: "/tmp/qa-fly294",
				leads: [
					{
						agentId: "qa-test-1",
						chatChannel: COS_TEST_CHANNEL,
						botToken: TOKEN,
						match: { labels: [] },
					},
				],
			} as unknown as ProjectEntry,
		];

		await runPostShipFinalization(
			{
				executionId,
				issueId,
				issueIdentifier: "FLY-294",
				projectName: "qa-fly294",
				sessionStatus: "completed",
				// no discordOwnerUserId → skip removeUser (no real member to evict)
				fallbackBotToken: TOKEN,
			},
			{ store, projects },
		);

		const after = await isArchivedOnDiscord(threadId);
		const events = store.getEventsByExecution(executionId);
		const archivedEvt = events.find(
			(e: any) => e.event_type === "chat_thread_archived",
		);
		check(
			"B2",
			"runPostShipFinalization: real Discord archived=true + StateStore chat_thread_archived audit",
			after === true && !!archivedEvt,
			`threadId=${threadId} discordArchived=${after} auditEvent=${archivedEvt ? archivedEvt.event_type : "MISSING"} payload=${archivedEvt ? JSON.stringify((archivedEvt as any).payload) : "n/a"} allEvents=[${events.map((e: any) => e.event_type).join(",")}]`,
		);
	}

	// ── B3: real Discord 404 → markDiscordMissing, reason=missing, no throw ──
	{
		const threadId = await createThread(`fly294-B3-${TS}`);
		// Delete it so the next archive hits a real 404 from Discord.
		await dapi("DELETE", `/channels/${threadId}`);
		const missing: string[] = [];
		let threw = false;
		let res: ArchiveChatThreadResult | undefined;
		try {
			res = await archiveChatThread(threadId, TOKEN, {
				markDiscordMissing: (id) => missing.push(id),
			});
		} catch {
			threw = true;
		}
		check(
			"B3",
			"real Discord 404 (deleted thread) → markDiscordMissing + reason=missing, no throw",
			!threw &&
				res?.reason === "missing" &&
				res?.status === 404 &&
				missing[0] === threadId,
			`threadId=${threadId} threw=${threw} fnResult={status:${res?.status},reason:${res?.reason},attempts:${res?.attempts}} markedMissing=${JSON.stringify(missing)}`,
		);
	}
} finally {
	// ── cleanup: keep the sandbox clean, and PROVE it ──
	// A thread that received a message needs MANAGE_THREADS to delete; the TEST
	// bot only owns empty threads. So: unarchive → delete our own messages →
	// delete the thread. If a delete is still forbidden, re-archive so it at
	// least leaves the sidebar (the feature's own clean state). Either way we
	// then GET each thread back and FAIL the run on any survivor — a cleanup
	// failure must be surfaced, never silently swallowed into a green summary.
	const residue: string[] = [];
	for (const id of createdThreads) {
		await dapi("PATCH", `/channels/${id}`, { archived: false, locked: false });
		const msgs = await dapi("GET", `/channels/${id}/messages?limit=50`);
		if (Array.isArray(msgs.json)) {
			for (const m of msgs.json) {
				await dapi("DELETE", `/channels/${id}/messages/${m.id}`);
			}
		}
		const del = await dapi("DELETE", `/channels/${id}`);
		const gone = await dapi("GET", `/channels/${id}`);
		const isGone = gone.status === 404 || gone.status === 410;
		if (isGone) {
			console.log(`        cleanup: deleted thread ${id} → ${del.status}`);
		} else {
			// Could not delete — re-archive (out of sidebar) but FLAG as residue.
			await dapi("PATCH", `/channels/${id}`, { archived: true });
			residue.push(`${id}(del=${del.status},stillExists=${gone.status})`);
			console.log(
				`        cleanup: thread ${id} NOT deleted (del=${del.status}); re-archived but FLAGGED as residue`,
			);
		}
	}
	check(
		"B-cleanup",
		"every created test thread deleted — zero sandbox residue",
		residue.length === 0,
		residue.length === 0
			? `deleted ${createdThreads.length} thread(s), 0 residue`
			: `RESIDUE LEFT: ${residue.join("; ")}`,
	);
}

process.exit(summary("LAYER B") === 0 ? 0 : 1);
