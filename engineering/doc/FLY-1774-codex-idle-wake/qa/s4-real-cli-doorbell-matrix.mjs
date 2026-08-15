// FLY-1774 QA S4/S5 — real compiled modules + real CLI subprocess + real sqlite.
// Zero mocks: MailboxQueue/CommDB from flywheel-comm dist, envelope renderer from
// teamlead dist, sweep executed as the real `node dist/index.js runner-wake-sweep`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const { default: Database } = await import("/Users/xiaorongli/Dev/flywheel-FLY-1774/node_modules/.pnpm/better-sqlite3@12.8.0/node_modules/better-sqlite3/lib/index.js");

const ROOT = "/Users/xiaorongli/Dev/flywheel-FLY-1774";
const CLI = `${ROOT}/packages/flywheel-comm/dist/index.js`;
const { CommDB } = await import(`${ROOT}/packages/flywheel-comm/dist/db.js`);
const { MailboxQueue } = await import(`${ROOT}/packages/flywheel-comm/dist/mailbox-queue.js`);
const { encodeSenderRef } = await import(`${ROOT}/packages/flywheel-comm/dist/sender-ref.js`);
const { renderRunnerMailboxBatchEnvelope } = await import(
  `${ROOT}/packages/teamlead/dist/bridge/runner-mailbox-lane.js`
);

let pass = 0, fail = 0;
const results = [];
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? " — " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name} — ${detail}`); }
  results.push({ name, ok, detail });
}

const dir = mkdtempSync(join(tmpdir(), "fly1774-qa-"));
let dbPath = join(dir, "comm-0.db");
let caseNo = 0;

function fresh(execId, { phaseKeepAlive = true, status = "running", isolate = true } = {}) {
  if (isolate) dbPath = join(dir, `comm-${++caseNo}.db`);
  const db = new CommDB(dbPath);
  db.registerSession(execId, `qa:${execId}`, "qa-project", "FLY-1774", "qa-lead", "codex", phaseKeepAlive);
  if (status !== "running") db.markSessionTerminalStatus(execId, status);
  db.close();
}
function raw() { return new Database(dbPath); }
function wakes(execId) {
  const d = raw();
  const r = d.prepare("SELECT * FROM runner_phase_wakes WHERE execution_id = ? ORDER BY queue_seq").all(execId);
  d.close(); return r;
}
function mailboxStates(execId) {
  const d = raw();
  const r = d.prepare("SELECT delivery_id, state, acked_at FROM mailbox WHERE to_agent = ? ORDER BY seq").all(execId);
  d.close(); return r;
}
function enqueueMsg(execId, { type = "instruction", refId = null, content = "do the thing", expiresAt = null } = {}) {
  const d = raw();
  const q = new MailboxQueue(d);
  const res = q.enqueue({
    id: randomUUID(), fromAgent: "qa-lead", toAgent: execId, recipientKind: "runner",
    type, content, refId, carrier: "inbox", expiresAt, senderRef: encodeSenderRef(),
  });
  d.close(); return res;
}
function claimBatch(execId) {
  const d = raw();
  const q = new MailboxQueue(d);
  const now = new Date().toISOString();
  q.acquireOrRenewOwner({ ownerEpoch: "qa-epoch", now, leaseTtlMs: 600_000 });
  const rows = q.claimRunnerBatch({
    ownerEpoch: "qa-epoch", now, transportClaimTtlMs: 60_000,
    batchWindowMs: 60_000, batchMaxSize: 10, inflightMaxBatches: 3,
  });
  d.close(); return rows;
}
function sweepCli(execId, env = {}) {
  try {
    const out = execFileSync("node", [CLI, "runner-wake-sweep", "--db", dbPath, "--json"], {
      encoding: "utf8", env: { ...process.env, FLYWHEEL_EXEC_ID: execId, FLYWHEEL_COMM_DB: dbPath, ...env },
    });
    return { code: 0, out: out.trim() };
  } catch (e) {
    return { code: e.status ?? -1, out: (e.stdout ?? "").trim(), err: (e.stderr ?? "").trim() };
  }
}
function doorbellFromBatch(execId, rows) {
  const env = renderRunnerMailboxBatchEnvelope(rows);
  const db = new CommDB(dbPath);
  try {
    return { ok: true, result: db.enqueueRunnerDoorbellWake(execId, { id: randomUUID(), to: execId, content: env.content, metadata: env.metadata }, Date.now()) };
  } catch (e) { return { ok: false, error: e.message }; }
  finally { db.close(); }
}
function legacyFromBatch(execId, rows) {
  const env = renderRunnerMailboxBatchEnvelope(rows);
  const db = new CommDB(dbPath);
  try {
    return { ok: true, result: db.enqueueRunnerPhaseWake(execId, { id: randomUUID(), to: execId, content: env.content, metadata: env.metadata }, Date.now()) };
  } catch (e) { return { ok: false, error: e.message }; }
  finally { db.close(); }
}

console.log("\n=== B0. BEFORE baseline: 断裂② on the pre-fix code path (byte-unchanged legacy fn) ===");
{
  const ex = randomUUID(); fresh(ex);
  enqueueMsg(ex);
  const rows = claimBatch(ex);
  check("B0.setup batch claimed", !!rows && rows.length === 1, `rows=${rows?.length}`);
  const before = legacyFromBatch(ex, rows);
  check("B0 legacy path THROWS on a batch envelope (the bug)", !before.ok && /bound instruction .* not found/.test(before.error ?? ""), before.ok ? `no throw: ${JSON.stringify(before.result?.kind)}` : before.error);
  check("B0 no wake row was created (runner never woken)", wakes(ex).length === 0, `wakes=${wakes(ex).length}`);
  const after = doorbellFromBatch(ex, rows);
  check("B0 AFTER new doorbell path queues a wake", after.ok && after.result.kind === "queued", after.ok ? after.result.kind : after.error);
  check("B0 AFTER wake row exists, exactly one", wakes(ex).length === 1, `wakes=${wakes(ex).length}`);
  const mb = mailboxStates(ex);
  check("B0 AFTER zero mailbox settlement (still LEASED, no ack)", mb.every(r => r.state === "LEASED" && !r.acked_at), JSON.stringify(mb));
}

console.log("\n=== S4. Real CLI sweep behavior matrix ===");
{
  const ex = randomUUID(); fresh(ex);
  const r = sweepCli(ex);
  check("S4.1 negative control: empty mailbox -> no_messages, exit 0", r.code === 0 && JSON.parse(r.out).kind === "no_messages", r.out);
  check("S4.1 zero wakes created", wakes(ex).length === 0);
}
{
  const ex = randomUUID(); fresh(ex, { phaseKeepAlive: false });
  enqueueMsg(ex);
  const r = sweepCli(ex);
  check("S4.2 capability fence: non-phase runner -> no_consumer", r.code === 0 && JSON.parse(r.out).kind === "no_consumer", r.out);
  check("S4.2 zero wakes created", wakes(ex).length === 0);
}
{
  const ex = randomUUID(); fresh(ex, { status: "completed" });
  enqueueMsg(ex);
  const r = sweepCli(ex);
  check("S4.3 liveness fence: terminal session -> no_consumer", r.code === 0 && JSON.parse(r.out).kind === "no_consumer", r.out);
}
{
  const ex = randomUUID(); fresh(ex);
  enqueueMsg(ex, { type: "instruction" });
  const r = sweepCli(ex);
  const w = wakes(ex);
  check("S4.4 instruction QUEUED -> queued doorbell", r.code === 0 && JSON.parse(r.out).kind === "queued", r.out);
  check("S4.4 exactly one wake", w.length === 1, `n=${w.length}`);
  check("S4.4 doorbell points at inbox", (w[0]?.content ?? "").includes(`flywheel-comm inbox --exec-id ${ex}`), w[0]?.content?.slice(0, 120));
  check("S4.4 doorbell carries no message body", !(w[0]?.content ?? "").includes("do the thing"));
  check("S4.4 source_instruction_id NULL", w[0]?.source_instruction_id === null, String(w[0]?.source_instruction_id));
  check("S4.4 message_id namespaced doorbell:", (w[0]?.message_id ?? "").startsWith("doorbell:"), w[0]?.message_id);
  const mb = mailboxStates(ex);
  check("S4.4 zero settlement (row still QUEUED, no ack)", mb.length === 1 && mb[0].state === "QUEUED" && !mb[0].acked_at, JSON.stringify(mb));
  // idempotency
  const r2 = sweepCli(ex);
  check("S4.5 repeat sweep same frontier -> already_covered", r2.code === 0 && JSON.parse(r2.out).kind === "already_covered", r2.out);
  check("S4.5 still exactly one wake", wakes(ex).length === 1, `n=${wakes(ex).length}`);
}
{
  const ex = randomUUID(); fresh(ex);
  const ref = `q-${randomUUID()}`;
  enqueueMsg(ex, { type: "response", refId: ref, content: "answer body" });
  const r = sweepCli(ex);
  const w = wakes(ex);
  check("S4.6 response-only -> queued", JSON.parse(r.out).kind === "queued", r.out);
  check("S4.6 doorbell says `check <refId>`", (w[0]?.content ?? "").includes(`flywheel-comm check ${ref}`), w[0]?.content?.slice(0, 160));
  check("S4.6 doorbell does NOT say `inbox` (would not read a response)", !(w[0]?.content ?? "").includes("flywheel-comm inbox"), w[0]?.content?.slice(0, 160));
}
{
  const ex = randomUUID(); fresh(ex);
  enqueueMsg(ex, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
  const r = sweepCli(ex);
  check("S4.7 expired row is not eligible -> no_messages", JSON.parse(r.out).kind === "no_messages", r.out);
}
{
  const ex = randomUUID(); fresh(ex);
  enqueueMsg(ex);
  sweepCli(ex);
  enqueueMsg(ex, { content: "second instruction" });     // new frontier while first still pending
  const r = sweepCli(ex);
  check("S4.8 new mail while doorbell pending -> reused (at most one in flight)", JSON.parse(r.out).kind === "reused", r.out);
  check("S4.8 still exactly one wake", wakes(ex).length === 1, `n=${wakes(ex).length}`);
}
{
  const ex = randomUUID(); fresh(ex);
  enqueueMsg(ex);
  sweepCli(ex);
  const before = wakes(ex);
  const db = new CommDB(dbPath); db.markSessionTerminalStatus(ex, "failed"); db.close();
  const after = wakes(ex);
  check("S4.9 terminalization disposes pending doorbell", before[0].state === "pending" && after[0].state === "finished" && after[0].last_push_result === "disposed:terminal_target", `${before[0].state}->${after[0].state}/${after[0].last_push_result}`);
  const r = sweepCli(ex);
  check("S4.9 post-terminal sweep is a no-op", JSON.parse(r.out).kind === "no_consumer", r.out);
}
{
  // concurrency: two real CLI processes racing the same frontier
  const ex = randomUUID(); fresh(ex);
  enqueueMsg(ex);
  const { spawnSync } = await import("node:child_process");
  const args = [CLI, "runner-wake-sweep", "--db", dbPath, "--json"];
  const env = { ...process.env, FLYWHEEL_EXEC_ID: ex, FLYWHEEL_COMM_DB: dbPath };
  const procs = await Promise.all([0, 1, 2].map(() => new Promise((res) => {
    import("node:child_process").then(({ execFile }) => execFile("node", args, { env }, (e, so, se) => res({ e, so, se })));
  })));
  const kinds = procs.map(p => { try { return JSON.parse((p.so ?? "").trim()).kind; } catch { return `ERR:${(p.se ?? "").split("\n")[0]}`; } });
  check("S4.10 three concurrent real sweeps -> exactly one wake", wakes(ex).length === 1, `kinds=${JSON.stringify(kinds)} wakes=${wakes(ex).length}`);
  check("S4.10 no sweep crashed", procs.every(p => !p.e), JSON.stringify(kinds));
}

console.log("\n=== S4b. Batch (watcher) leg via the REAL lane envelope renderer ===");
{
  const ex = randomUUID(); fresh(ex);
  enqueueMsg(ex); enqueueMsg(ex, { content: "second" });
  const rows = claimBatch(ex);
  check("S4b.1 batch has 2 members", rows?.length === 2, `n=${rows?.length}`);
  const a = doorbellFromBatch(ex, rows);
  check("S4b.1 batch -> exactly one wake", a.ok && a.result.kind === "queued" && wakes(ex).length === 1, a.ok ? a.result.kind : a.error);
  const mb = mailboxStates(ex);
  check("S4b.1 all members untouched (LEASED, unacked)", mb.length === 2 && mb.every(r => r.state === "LEASED" && !r.acked_at), JSON.stringify(mb));
  // cross-leg identity: same attempt via sweep must not add a second wake
  const r = sweepCli(ex);
  check("S4b.2 turn-end sweep on the same attempt -> already_covered (cross-leg id stable)", JSON.parse(r.out).kind === "already_covered", r.out);
  check("S4b.2 still exactly one wake", wakes(ex).length === 1, `n=${wakes(ex).length}`);
  // replay of the identical envelope
  const b = doorbellFromBatch(ex, rows);
  check("S4b.3 identical batch replay -> already_covered, no new wake", b.ok && b.result.kind === "already_covered" && wakes(ex).length === 1, b.ok ? b.result.kind : b.error);
}
{
  // ownership violation must fail loud
  const ex = randomUUID(); const other = randomUUID();
  fresh(ex); fresh(other, { isolate: false });
  enqueueMsg(other);
  const rows = claimBatch(other);
  const bad = doorbellFromBatch(ex, rows);
  check("S4b.4 ownership violation fails loud", !bad.ok && /ownership mismatch|execId mismatch/.test(bad.error ?? ""), bad.ok ? "no throw" : bad.error);
}
{
  // stale attempt (rows released back to QUEUED) must be consumable, not poison
  const ex = randomUUID(); fresh(ex);
  enqueueMsg(ex);
  const rows = claimBatch(ex);
  const d = raw();
  d.prepare("UPDATE mailbox SET state='QUEUED', batch_id=NULL, claimed_by=NULL WHERE to_agent = ?").run(ex);
  d.close();
  const s = doorbellFromBatch(ex, rows);
  check("S4b.5 stale envelope -> stale_attempt (no throw => watcher can ACK transport)", s.ok && s.result.kind === "stale_attempt", s.ok ? s.result.kind : s.error);
}
{
  // already settled
  const ex = randomUUID(); fresh(ex);
  enqueueMsg(ex);
  const rows = claimBatch(ex);
  const d = raw();
  d.prepare("UPDATE mailbox SET state='ACKED' WHERE to_agent = ?").run(ex);
  d.close();
  const s = doorbellFromBatch(ex, rows);
  check("S4b.6 fully acked batch -> already_settled (no throw)", s.ok && s.result.kind === "already_settled", s.ok ? s.result.kind : s.error);
  check("S4b.6 zero wakes", wakes(ex).length === 0);
}

console.log(`\nS3/S4 real-matrix: passed=${pass} failed=${fail}`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
