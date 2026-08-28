// QA·FLY-2076 — the bounded batch must NOT become a work hard-limit.
// 60 outstanding tickets: prove (a) a full batch is a visible backlog signal,
// (b) repeated batches with NO cursor drain the whole backlog, (c) `since`
// only ever surfaces NEWER debt, (d) legacy (NULL ticket_status) rows never
// enter the duty queue.

import { join } from "node:path";

const repoRoot =
	process.env.QA_REPO_ROOT ?? "/Users/xiaorongli/Dev/flywheel-FLY-2076";
const tl = (p) => import(join(repoRoot, "packages/teamlead/dist", p));
const { StateStore } = await tl("StateStore.js");

const results = { pass: [], fail: [] };
const ok = (n, c, d = "") =>
	(c ? results.pass : results.fail).push(`${n}${d ? ` — ${d}` : ""}`);

const store = await StateStore.create(":memory:");
const N = 60;
for (let i = 0; i < N; i += 1) {
	store.openAlertThread({
		correlationKey: `flywheel|lead-${i}|kind_${i}|`,
		eventId: `evt-${String(i).padStart(3, "0")}`,
		threadId: `t-${i}`,
		rootMessageId: `r-${i}`,
		channelId: "alerts",
		leadId: `lead-${i}`,
		projectName: "flywheel",
		eventType: `kind_${i}`,
		ticketStatus: "NEW",
		ownerRef: "infra_bot:claude",
	});
}
// one LEGACY row (pre-ticket era, NULL status) must stay invisible to duty
store.openAlertThread({
	correlationKey: "flywheel|legacy|old_kind|",
	eventId: "evt-legacy",
	threadId: "t-legacy",
	rootMessageId: "r-legacy",
	channelId: "alerts",
	leadId: "legacy",
	projectName: "flywheel",
	eventType: "old_kind",
});

const b1 = store.listDutyOutstanding(25);
ok("(a) a full batch of exactly the limit is returned = the backlog signal", b1.length === 25, `n=${b1.length}`);
ok(
	"(d) the legacy NULL-status row is never in the duty queue",
	!store.listDutyOutstanding(100).some((t) => t.event_id === "evt-legacy"),
	"",
);
ok(
	"newest-first ordering",
	b1[0].event_id > b1[24].event_id,
	`${b1[0].event_id} … ${b1[24].event_id}`,
);

// (b) drain: ack each batch, then re-query with NO cursor
let drained = 0;
let rounds = 0;
for (;;) {
	const batch = store.listDutyOutstanding(25);
	if (batch.length === 0) break;
	rounds += 1;
	for (const t of batch) {
		store.stampDutyAck(t.correlation_key, t.event_id);
		drained += 1;
	}
	if (rounds > 10) break;
}
ok(
	"(b) repeated cursor-less batches drain the ENTIRE backlog (limit is not a work cap)",
	drained === N && store.listDutyOutstanding(100).length === 0,
	`drained=${drained}/${N} rounds=${rounds}`,
);

// (c) `since` only surfaces newer debt
const store2 = await StateStore.create(":memory:");
const mk = (id, openedAt) => {
	store2.openAlertThread({
		correlationKey: `flywheel|l|${id}|`,
		eventId: id,
		threadId: `t${id}`,
		rootMessageId: `r${id}`,
		channelId: "alerts",
		leadId: "l",
		projectName: "flywheel",
		eventType: id,
		ticketStatus: "NEW",
		ownerRef: "infra_bot:claude",
	});
	if (openedAt) {
		store2.db.run("UPDATE alert_threads SET opened_at = ? WHERE event_id = ?", [
			openedAt,
			id,
		]);
	}
};
mk("old-1", "2026-08-26 10:00:00");
mk("mid-1", "2026-08-26 11:00:00");
const cursor = { opened_at: "2026-08-26 11:00:00", event_id: "mid-1" };
mk("new-1", "2026-08-26 12:00:00");
const sinceRes = store2.listDutyOutstanding(25, cursor);
ok(
	"(c) `since` returns only debt NEWER than the cursor",
	sinceRes.length === 1 && sinceRes[0].event_id === "new-1",
	sinceRes.map((t) => t.event_id).join(","),
);
ok(
	"(c) control: the same query with NO cursor still sees the older debt",
	store2.listDutyOutstanding(25).length === 3,
	`n=${store2.listDutyOutstanding(25).length}`,
);

console.log("\n── QA FLY-2076 backlog drain / no hard limit ──");
for (const p of results.pass) console.log(`  ✓ ${p}`);
for (const f of results.fail) console.log(`  ✗ ${f}`);
console.log(`\nPASS ${results.pass.length}  FAIL ${results.fail.length}`);
process.exit(results.fail.length === 0 ? 0 : 1);
