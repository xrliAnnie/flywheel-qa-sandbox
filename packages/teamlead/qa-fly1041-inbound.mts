/**
 * FLY-1041 QA ②③④ — inbound founder-reply real-machine E2E (Chrome-as-Annie).
 * Module-driven (FLY-605 pattern): the REAL compiled deliverer
 * `emitFounderReplyDeliveryForThread` + REAL tryFounderShipApproval (via the
 * importable `makeFounderShipApprovalCallback` factory) + REAL classifier /
 * write / reaction, driven against a REAL 529 thread reading Annie's REAL
 * message via the REAL global fetch. No mocks of the code under test.
 *
 *   setup  <reply|ok|held>  → create thread + ship card (owner = Annie real id),
 *                             seed comm.db gate + (reply) gate-msg binding,
 *                             write sidecar, print thread + card ids.
 *   (Chrome-as-Annie posts the scenario message in that thread)
 *   verify <reply|ok|held>  → run the deliverer against Annie's new message,
 *                             assert real comm.db response + observe ✅/❓.
 *
 * Run from packages/teamlead with TMPDIR=/tmp/q1041.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { CommDB } from "flywheel-comm/db";
import { reactToFounderMessage } from "./src/bridge/approval-signal/founder-ack.js";
import { makeFounderShipApprovalCallback } from "./src/bridge/approval-signal/founder-ship-approval-factory.js";
import { bindingEventId } from "./src/bridge/approval-signal/gate-message-binding.js";
import { readCurrentGateMessageBinding } from "./src/bridge/approval-signal/gate-message-binding-store.js";
import { evaluateTextSource } from "./src/bridge/approval-signal/text-approval-source.js";
import { emitFounderReplyDeliveryForThread } from "./src/bridge/founder-reply-deliverer.js";
import { emitFounderThreadNotification } from "./src/bridge/founder-thread-notifier.js";
import { InMemoryInboundCursorStore } from "./src/lead-backends/codex/InboundCursorStore.js";
import type { StateStore } from "./src/StateStore.js";

const TOKEN = process.env.TEST_BOT_TOKEN_1!;
const ANNIE = process.env.DISCORD_OWNER_USER_ID!; // real founder id — required for the deliverer author gate
const CHANNEL = "1493080991290626079";
const API = "https://discord.com/api/v10";
const DIR = "/tmp/q1041";
const PRHEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // 40-hex, harness-fixed

type Sidecar = {
	scenario: string;
	threadId: string;
	cardMsgId: string;
	commDbPath: string;
	gateQid: string;
	execId: string;
	beforeCursor: string;
};

function sc(s: string): string {
	return `${DIR}/qa1041-${s}.json`;
}
async function api(path: string, init?: RequestInit) {
	const res = await fetch(`${API}${path}`, {
		...init,
		headers: {
			Authorization: `Bot ${TOKEN}`,
			"Content-Type": "application/json",
			...(init?.headers ?? {}),
		},
	});
	return {
		status: res.status,
		json: (await res.json().catch(() => ({}))) as any,
	};
}

/** Minimal StateStore stub: the deliverer + handler only call getSession /
 *  insertEvent; readCurrentGateMessageBinding calls getEventsByExecution. */
function makeStore(
	execId: string,
	gateQid: string,
	seedBinding: boolean,
	cardMsgId: string,
) {
	const events: any[] = [];
	if (seedBinding) {
		events.push({
			event_id: bindingEventId(gateQid, PRHEAD),
			execution_id: execId,
			event_type: "ship_gate_msg_binding",
			payload: {
				questionId: gateQid,
				executionId: execId,
				prHeadSha: PRHEAD,
				gateMessageId: cardMsgId,
			},
		});
	}
	return {
		getSession: (id: string) =>
			id === execId
				? {
						execution_id: execId,
						pr_head_sha: PRHEAD,
						status: "awaiting_review",
						review_question_id: gateQid,
						session_role: "main",
					}
				: undefined,
		insertEvent: (e: any) => {
			events.push(e);
			return true;
		},
		getEventsByExecution: (id: string) =>
			events.filter((e) => e.execution_id === id),
	} as unknown as StateStore;
}

async function setup(scenario: string) {
	mkdirSync(DIR, { recursive: true });
	const execId = `qa-1041-${scenario}`;
	const gateQid = (() => {
		const db = new CommDB(`${DIR}/qa1041-${scenario}-comm.db`);
		const qid = db.insertQuestion(
			execId,
			"qa-lead",
			`PR #520 ship gate (${scenario})`,
			{
				checkpoint: "approve_to_ship",
			},
		);
		db.close();
		return qid;
	})();

	// create a real thread
	const t = await api(`/channels/${CHANNEL}/threads`, {
		method: "POST",
		body: JSON.stringify({
			name: `FLY-1041 QA ${scenario} ${process.env.QA_TS ?? ""}`,
			type: 11,
			auto_archive_duration: 60,
		}),
	});
	const threadId = t.json.id as string;

	// post the real ship card (owner = Annie so ② can reply to a real ship card)
	const store = makeStore(execId, gateQid, false, "");
	const card = await emitFounderThreadNotification(
		{
			questionId: gateQid,
			checkpoint: "approve_to_ship",
			executionId: execId,
			issueId: "FLY-1041",
			issueIdentifier: "FLY-1041",
			projectName: "flywheel",
			summary: `QA ${scenario}: real founder-reply E2E`,
			ageMinutes: 1,
			thread: {
				thread_id: threadId,
				channel_id: CHANNEL,
				lead_id: null,
				archived_at: null,
			},
			botToken: TOKEN,
			ownerUserId: ANNIE,
		},
		{ store },
	);
	const cardMsgId = card.gateMessageId as string;

	const side: Sidecar = {
		scenario,
		threadId,
		cardMsgId,
		commDbPath: `${DIR}/qa1041-${scenario}-comm.db`,
		gateQid,
		execId,
		beforeCursor: cardMsgId,
	};
	writeFileSync(sc(scenario), JSON.stringify(side, null, 2));
	console.log(
		`SETUP ${scenario}: thread=${threadId} card=${cardMsgId} gate=${gateQid}`,
	);
	console.log(
		`  → drive Annie to post in thread ${threadId}: ${scenario === "reply" ? "REPLY to the card with okk" : scenario === "ok" ? '"ship"' : '"ship" (held → ❓ expected)'}`,
	);
}

async function verify(scenario: string) {
	const s: Sidecar = JSON.parse(readFileSync(sc(scenario), "utf8"));
	const held = scenario === "held";
	const store = makeStore(
		s.execId,
		s.gateQid,
		scenario === "reply",
		s.cardMsgId,
	);

	const tryFounderShipApproval = makeFounderShipApprovalCallback({
		discordOwnerUserId: ANNIE,
		store,
		auditStore: store as any,
		isHeld: held ? () => true : () => false,
		evaluateTextImpl: (args: any, deps: any) => evaluateTextSource(args, deps),
	});

	const cursorStore = new InMemoryInboundCursorStore();
	cursorStore.save(s.threadId, s.beforeCursor); // read only Annie's NEW message

	const reactions: any[] = [];
	await emitFounderReplyDeliveryForThread(
		{
			issueId: "FLY-1041",
			projectName: "flywheel",
			threadId: s.threadId,
			botToken: TOKEN,
			ownerUserId: ANNIE,
			graceMs: 0, // maturity delay — 0 so Annie's just-posted msg is processed now (prod ship grace ~15s)
			commDbPath: s.commDbPath,
			leadId: "qa-lead",
		},
		[
			{
				questionId: s.gateQid,
				checkpoint: "approve_to_ship",
				executionId: s.execId,
				createdAtMs: Number(process.env.QA_QMS ?? "0"),
				checkpointGraceMs: 0,
			},
		],
		{
			store,
			fetchImpl: fetch,
			cursorStore,
			commDbFactory: (p: string) => new CommDB(p),
			tryFounderShipApproval,
			readCurrentBinding: (e: string, q: string, p: string) =>
				readCurrentGateMessageBinding(store, e, q, p),
			reactToFounderMessageImpl: async (a: any) => {
				const r = await reactToFounderMessage(a); // REAL Discord PUT
				reactions.push({ emoji: a.emoji, messageId: a.messageId, ok: r.ok });
				return r;
			},
			wakeImpl: async () => ({ ok: true }),
			respondImpl: async () => {},
			deliverAmbiguousToLead: () => {},
		} as any,
	);

	// assert against the real comm.db
	const db = new CommDB(s.commDbPath);
	const resp = db.getResponse(s.gateQid);
	db.close();
	console.log(`\nVERIFY ${scenario}:`);
	console.log(
		`  comm.db response for gate ${s.gateQid}: ${resp ? resp.content : "(none)"}`,
	);
	console.log(`  reactions emitted: ${JSON.stringify(reactions)}`);

	// Re-FETCH Annie's message from Discord and assert the REAL persisted reaction
	// (not just the local array — Codex R2 MEDIUM: a failed PUT must not false-green).
	const msgs = await api(`/channels/${s.threadId}/messages?limit=10`);
	const annieMsg = (msgs.json as any[]).find(
		(m) => m.author?.id === ANNIE && m.id > s.beforeCursor,
	);
	const fetched: string[] = (annieMsg?.reactions ?? []).map(
		(r: any) => r.emoji?.name,
	);
	console.log(
		`  Annie's msg: id=${annieMsg?.id} content=${JSON.stringify(annieMsg?.content)} REAL reactions=${JSON.stringify(fetched)}`,
	);
	// Any reaction the deliverer attempted THIS run must have really succeeded.
	if (reactions.some((r) => r.ok === false))
		throw new Error("ASSERT FAIL: a real reaction PUT returned ok:false");

	const want = held ? "❓" : "✅";
	if (held && resp)
		throw new Error("ASSERT FAIL: held session must NOT write a response");
	if (!held && (!resp || !resp.content.includes('"approved": true')))
		throw new Error("ASSERT FAIL: expected approved:true response");
	// Ground truth: the emoji is really on Annie's message (re-fetched from Discord).
	if (!fetched.includes(want))
		throw new Error(
			`ASSERT FAIL: expected REAL ${want} on Annie's message (fetched=${JSON.stringify(fetched)})`,
		);
	console.log(
		held
			? "  ✅ ④ held → NO response + REAL ❓ on Annie's msg: PASS"
			: `  ✅ ${scenario === "reply" ? "② reply-to-card → bound + REAL ✅" : "③ ship → approved + REAL ✅"} on Annie's msg: PASS`,
	);
}

const [, , cmd, scenario] = process.argv;
if (cmd === "setup") await setup(scenario);
else if (cmd === "verify") await verify(scenario);
else console.log("usage: qa-fly1041-inbound.mts setup|verify reply|ok|held");
