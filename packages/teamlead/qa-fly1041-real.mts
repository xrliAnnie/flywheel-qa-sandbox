/**
 * FLY-1041 QA — real-machine legs that need NO founder message (point ① + card).
 * Module-driven (FLY-605-approved pattern): real compiled fns + real better-sqlite3
 * CommDB + real Discord thread POST/GET via the real global fetch. No mocks.
 *
 * ②③④ (reply-to-card binding / ✅ / ❓) require a real Annie message and run
 * separately via Chrome-as-Annie after her login.
 *
 * Run from packages/teamlead:  npx tsx qa-fly1041-real.mts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommDB } from "flywheel-comm/db";
import { emitFounderThreadNotification } from "./src/bridge/founder-thread-notifier.js";
import type { StateStore } from "./src/StateStore.js";

const TOKEN = process.env.TEST_BOT_TOKEN_1;
const CHANNEL = "1493080991290626079"; // 529 slot-1 test channel (QA Testing category)
// Deliberately NOT Annie's real id — the card @mentions its owner and we must not
// ping her overnight. A bot app id is a valid snowflake; pinging a bot notifies
// no human. Owner-mention resolution itself is unit-covered.
const DUMMY_OWNER = "1493068669444427927";
const API = "https://discord.com/api/v10";

function log(...a: unknown[]) {
	console.log(...a);
}
function assert(cond: boolean, msg: string) {
	if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
	log(`  ✓ ${msg}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// POINT ① — single bindable ship gate (real better-sqlite3 CommDB)
// ─────────────────────────────────────────────────────────────────────────────
function point1(): void {
	log("\n=== POINT ① — single bindable ship gate (real CommDB) ===");
	const dir = mkdtempSync(join(tmpdir(), "qa-fly1041-p1-"));
	const db = new CommDB(join(dir, "comm.db"));
	const cand = () =>
		db
			.getPendingQuestions("lead-1")
			.filter((q) => q.kind !== "report")
			.filter((q) => q.checkpoint === "approve_to_ship")
			.map((q) => q.id);

	// re-fire: two live approve_to_ship gates (the FLY-910 ambiguity precondition)
	const g1 = db.insertQuestion("exec-1", "lead-1", "PR #520 ready", {
		checkpoint: "approve_to_ship",
	});
	const g2 = db.insertQuestion("exec-1", "lead-1", "PR #520 ready (re-fire)", {
		checkpoint: "approve_to_ship",
	});
	// runner report noise (Fix D denoise)
	db.insertQuestion("exec-1", "lead-1", "DONE: chunk 1", { kind: "report" });
	assert(cand().length === 2, "before retire: 2 bindable gates (ambiguity)");

	// Fix A retire-on-rebind: retire the superseded g1
	assert(db.retireShipGate(g1) === true, "retireShipGate(g1) → true");
	const c = cand();
	assert(
		c.length === 1 && c[0] === g2,
		"after retire: exactly ONE gate, and it is g2",
	);
	assert(
		db.getPendingQuestions("lead-1").length === 2,
		"report still pending for the Lead (relay unchanged): 1 gate + 1 report",
	);

	// Safety: a real approval on the survivor must never be rewritten by retire
	db.insertResponse(g2, DUMMY_OWNER, '{"approved": true}');
	assert(db.retireShipGate(g2) === false, "retire refuses an ANSWERED gate");
	assert(
		db.getResponse(g2)?.content === '{"approved": true}',
		"the real approval survives verbatim",
	);
	db.close();
	log("  POINT ① PASS — real comm.db at", join(dir, "comm.db"));
}

// ─────────────────────────────────────────────────────────────────────────────
// OUTBOUND CARD — real approve_to_ship card → real 529 thread (POST + GET)
// ─────────────────────────────────────────────────────────────────────────────
async function outboundCard(): Promise<void> {
	log("\n=== OUTBOUND CARD — real approve_to_ship card round-trip ===");
	if (!TOKEN) throw new Error("TEST_BOT_TOKEN_1 not set");

	// 1) create a real thread in the 529 test channel
	const tRes = await fetch(`${API}/channels/${CHANNEL}/threads`, {
		method: "POST",
		headers: {
			Authorization: `Bot ${TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			name: `FLY-1041 QA card ${Math.floor(Number(process.env.QA_TS ?? "0"))}`,
			type: 11,
			auto_archive_duration: 60,
		}),
	});
	const thread = (await tRes.json()) as { id?: string };
	assert(!!thread.id, `real thread created (id=${thread.id})`);

	// 2) drive the REAL compiled notifier with the REAL global fetch
	const events: Array<{ event_type: string }> = [];
	const store = {
		insertEvent: (e: { event_type: string }) => {
			events.push({ event_type: e.event_type });
			return true;
		},
	} as unknown as StateStore;

	const result = await emitFounderThreadNotification(
		{
			questionId: "qa-q1",
			checkpoint: "approve_to_ship",
			executionId: "qa-exec-1",
			issueId: "FLY-1041",
			issueIdentifier: "FLY-1041",
			projectName: "flywheel",
			summary: "QA real-machine card verification",
			ageMinutes: 1,
			thread: {
				thread_id: thread.id!,
				channel_id: CHANNEL,
				lead_id: null,
				archived_at: null,
			},
			botToken: TOKEN,
			ownerUserId: DUMMY_OWNER,
		},
		{ store },
	);
	assert(result.kind === "posted", `notifier posted (kind=${result.kind})`);
	assert(
		!!result.gateMessageId,
		`real gate message id returned (${result.gateMessageId})`,
	);
	assert(
		events.some((e) => e.event_type === "founder_thread_notified"),
		"founder_thread_notified audit event emitted",
	);

	// 3) GET the real message back and assert the Fix B carrier body
	const mRes = await fetch(
		`${API}/channels/${thread.id}/messages/${result.gateMessageId}`,
		{ headers: { Authorization: `Bot ${TOKEN}` } },
	);
	const msg = (await mRes.json()) as { content?: string };
	const body = msg.content ?? "";
	log(`  --- real posted card body ---\n${body}\n  ---`);
	assert(
		body.includes("🚀 **Ship gate 等你批准**"),
		"card has the ship-gate header",
	);
	assert(
		body.includes("直接**回复这条消息**或点 ✅ 即批准"),
		"card carries the FLY-1041 Chunk 6 deterministic-binding guidance line",
	);
	assert(
		body.includes("其它回复不会被当成批准"),
		"card spells out that other replies are NOT approval",
	);
	assert(body.includes(`<@${DUMMY_OWNER}>`), "card @mentions its owner");
	log(
		`  OUTBOUND CARD PASS — thread=${thread.id} msg=${result.gateMessageId} (evidence kept in 529 slot-1)`,
	);
}

point1();
await outboundCard();
log("\n=== FLY-1041 real-machine legs ① + card: ALL PASS ===");
