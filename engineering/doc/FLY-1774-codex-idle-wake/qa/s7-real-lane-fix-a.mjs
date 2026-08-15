// FLY-1774 QA S7 — Fix A through the REAL RunnerMailboxLane + REAL StateStore.
// Proves a parked (awaiting_review) runner's Lead mail is delivered instead of
// being instant-DEAD, and that every OUTCOME-terminal status still dies at once.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const ROOT = "/Users/xiaorongli/Dev/flywheel-FLY-1774";
const { StateStore } = await import(`${ROOT}/packages/teamlead/dist/StateStore.js`);
const { RunnerMailboxLane } = await import(`${ROOT}/packages/teamlead/dist/bridge/runner-mailbox-lane.js`);
const { DEFAULT_MAILBOX_QUEUE_CONFIG } = await import(`${ROOT}/packages/teamlead/dist/bridge/mailbox-queue-config.js`);
const { MailboxQueue } = await import(`${ROOT}/packages/flywheel-comm/dist/mailbox-queue.js`);
const { encodeSenderRef } = await import(`${ROOT}/packages/flywheel-comm/dist/sender-ref.js`);

let pass = 0, fail = 0;
const ck = (n, ok, d = "") => { ok ? (pass++, console.log(`  PASS ${n}${d ? " — " + d : ""}`)) : (fail++, console.log(`  FAIL ${n} — ${d}`)); };
const NOW = "2026-08-15T12:00:00.000Z";

const store = await StateStore.create(":memory:");
const cases = [
  ["running", "alive"], ["awaiting_review", "alive"], ["approved_to_ship", "alive"],
  ["completed", "dead"], ["approved", "dead"], ["blocked", "dead"], ["failed", "dead"],
  ["rejected", "dead"], ["deferred", "dead"], ["shelved", "dead"], ["terminated", "dead"],
];
const ids = new Map();
for (const [status] of cases) {
  const id = `exec-${status}`;
  ids.set(status, id);
  store.upsertSession({ execution_id: id, issue_id: `I-${status}`, project_name: "flywheel", status, tmux_session: "s", branch_name: "b" });
}

const dir = mkdtempSync(join(tmpdir(), "fly1774-lane-"));
const qPath = join(dir, "q.db");
const q = new MailboxQueue(qPath);
q.acquireOrRenewOwner({ ownerEpoch: "owner-1", now: NOW, leaseTtlMs: 600_000 });
for (const [status] of cases) {
  q.enqueue({ id: randomUUID(), fromAgent: "lead-a", toAgent: ids.get(status), recipientKind: "runner",
    type: "instruction", content: `msg for ${status}`, carrier: "inbox", senderRef: encodeSenderRef(), createdAt: NOW });
}

const delivered = [];
const lane = new RunnerMailboxLane({
  queue: q, ownerEpoch: "owner-1", now: () => new Date(NOW),
  queueConfig: () => DEFAULT_MAILBOX_QUEUE_CONFIG,
  recipientState: (execId) => store.resolveRunnerRecipientState(execId).state,
  deliver: async (env) => { delivered.push(env.executionId); return { status: "delivered" }; },
});
// drive enough ticks to sweep every recipient
for (let i = 0; i < 40; i++) await lane.tick();

const { default: Database } = await import("/Users/xiaorongli/Dev/flywheel-FLY-1774/node_modules/.pnpm/better-sqlite3@12.8.0/node_modules/better-sqlite3/lib/index.js");
const dbh = new Database(qPath, { readonly: true });
const stateByExec = new Map(dbh.prepare("SELECT to_agent, state FROM mailbox").all().map(r => [r.to_agent, r.state]));
dbh.close();
console.log("  delivered to:", JSON.stringify(delivered));
console.log("  mailbox states:", JSON.stringify([...stateByExec]));
for (const [status, expect_] of cases) {
  const id = ids.get(status);
  const got = delivered.includes(id);
  const st = stateByExec.get(id);
  ck(`S7 ${status.padEnd(17)} -> ${expect_ === "alive" ? "DELIVERED (not dead)" : "instant-DEAD (death gate intact)"}`,
     expect_ === "alive" ? (got && st !== "DEAD") : (!got && st === "DEAD"), `delivered=${got} state=${st}`);
}
console.log(`\nS7 lane Fix A: passed=${pass} failed=${fail}`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
