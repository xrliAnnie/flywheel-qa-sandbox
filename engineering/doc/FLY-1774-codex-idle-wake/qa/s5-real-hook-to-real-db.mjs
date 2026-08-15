// FLY-1774 QA S5 — real hook script + real CLI binary + real sqlite DB.
// Proves the notify leg actually rings the durable doorbell end-to-end on disk.
import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const { default: Database } = await import("/Users/xiaorongli/Dev/flywheel-FLY-1774/node_modules/.pnpm/better-sqlite3@12.8.0/node_modules/better-sqlite3/lib/index.js");

const ROOT = "/Users/xiaorongli/Dev/flywheel-FLY-1774";
const CLI = `${ROOT}/packages/flywheel-comm/dist/index.js`;
const HOOK = `${ROOT}/scripts/hooks/runner-stop-notify.sh`;
const { CommDB } = await import(`${ROOT}/packages/flywheel-comm/dist/db.js`);
const { MailboxQueue } = await import(`${ROOT}/packages/flywheel-comm/dist/mailbox-queue.js`);
const { encodeSenderRef } = await import(`${ROOT}/packages/flywheel-comm/dist/sender-ref.js`);

let pass = 0, fail = 0;
const ck = (n, ok, d = "") => { ok ? (pass++, console.log(`  PASS ${n}${d ? " — " + d : ""}`)) : (fail++, console.log(`  FAIL ${n} — ${d}`)); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), "fly1774-hook-"));
let n = 0;
function setup(execId, { phaseKeepAlive = true, withMail = true } = {}) {
  const dbPath = join(dir, `h${++n}.db`);
  const db = new CommDB(dbPath);
  db.registerSession(execId, `qa:${execId}`, "qa-project", "FLY-1774", "qa-lead", "codex", phaseKeepAlive);
  db.close();
  if (withMail) {
    const d = new Database(dbPath);
    new MailboxQueue(d).enqueue({
      id: randomUUID(), fromAgent: "qa-lead", toAgent: execId, recipientKind: "runner",
      type: "instruction", content: "REBASE NOW", carrier: "inbox", senderRef: encodeSenderRef(),
    });
    d.close();
  }
  return dbPath;
}
function wakes(dbPath, execId) {
  const d = new Database(dbPath);
  const r = d.prepare("SELECT * FROM runner_phase_wakes WHERE execution_id = ?").all(execId);
  d.close(); return r;
}
function mailbox(dbPath, execId) {
  const d = new Database(dbPath);
  const r = d.prepare("SELECT state, acked_at FROM mailbox WHERE to_agent = ?").all(execId);
  d.close(); return r;
}
function runHook(dbPath, execId, args, stdin = "") {
  const env = {
    ...process.env, FLYWHEEL_EXEC_ID: execId, FLYWHEEL_COMM_CLI: CLI,
    FLYWHEEL_COMM_DB: dbPath, FLYWHEEL_RUNNER_STATE_DIR: join(dir, `state-${execId}`),
    HOME: dir,
  };
  const t0 = Date.now();
  const out = execFileSync("bash", [HOOK, ...args], { encoding: "utf8", input: stdin, env });
  return { ms: Date.now() - t0, out };
}

console.log("\n=== S5. Real hook -> real CLI -> real DB ===");
{
  const ex = randomUUID();
  const dbPath = setup(ex);
  const notify = JSON.stringify({ type: "agent-turn-complete", client: "codex-tui", "turn-id": "t1", "last-assistant-message": "Goal achieved. Pausing." });
  const r = runHook(dbPath, ex, ["--codex", notify]);
  ck("S5.1 hook returns fast (foreground does no new work)", r.ms < 1500, `${r.ms}ms`);
  ck("S5.1 hook prints nothing to the pane", r.out === "", JSON.stringify(r.out));
  await sleep(6000);
  const w = wakes(dbPath, ex);
  ck("S5.1 detached sweep rang exactly one durable doorbell", w.length === 1, `n=${w.length}`);
  ck("S5.1 doorbell is a doorbell: row", (w[0]?.message_id ?? "").startsWith("doorbell:"), w[0]?.message_id);
  ck("S5.1 doorbell state pending (ready for hold loop)", w[0]?.state === "pending", w[0]?.state);
  ck("S5.1 zero mailbox settlement by the hook", mailbox(dbPath, ex).every(m => m.state === "QUEUED" && !m.acked_at), JSON.stringify(mailbox(dbPath, ex)));
}
{
  const ex = randomUUID();
  const dbPath = setup(ex, { withMail: false });
  const notify = JSON.stringify({ type: "agent-turn-complete", client: "codex-tui", "turn-id": "t1" });
  runHook(dbPath, ex, ["--codex", notify]);
  await sleep(6000);
  ck("S5.2 NEGATIVE CONTROL: parked codex with no unread mail is never disturbed", wakes(dbPath, ex).length === 0, `n=${wakes(dbPath, ex).length}`);
}
{
  const ex = randomUUID();
  const dbPath = setup(ex, { phaseKeepAlive: false });
  const notify = JSON.stringify({ type: "agent-turn-complete", client: "codex-tui", "turn-id": "t1" });
  runHook(dbPath, ex, ["--codex", notify]);
  await sleep(6000);
  ck("S5.3 non-phase codex runner: capability fence holds through the real hook", wakes(dbPath, ex).length === 0, `n=${wakes(dbPath, ex).length}`);
}
{
  const ex = randomUUID();
  const dbPath = setup(ex);
  const stop = JSON.stringify({ hook_event_name: "Stop", session_id: "s1", transcript_path: "/dev/null" });
  runHook(dbPath, ex, [], stop);
  await sleep(6000);
  ck("S5.4 Claude Stop branch never sweeps (byte-compat for Claude)", wakes(dbPath, ex).length === 0, `n=${wakes(dbPath, ex).length}`);
}
{
  const ex = randomUUID();
  const dbPath = setup(ex);
  const sub = JSON.stringify({ type: "agent-turn-complete", client: "codex-exec", "turn-id": "t1" });
  runHook(dbPath, ex, ["--codex", sub]);
  await sleep(4000);
  ck("S5.5 non codex-tui notify is filtered (no sweep)", wakes(dbPath, ex).length === 0, `n=${wakes(dbPath, ex).length}`);
}
{
  // repeat notify across two turns with the same unread frontier -> still one doorbell
  const ex = randomUUID();
  const dbPath = setup(ex);
  const notify = (t) => JSON.stringify({ type: "agent-turn-complete", client: "codex-tui", "turn-id": t });
  runHook(dbPath, ex, ["--codex", notify("t1")]);
  await sleep(5000);
  runHook(dbPath, ex, ["--codex", notify("t2")]);
  await sleep(5000);
  ck("S5.6 repeated turn-end notifies do not pile up doorbells (no self-loop)", wakes(dbPath, ex).length === 1, `n=${wakes(dbPath, ex).length}`);
}

console.log(`\nS5 real-hook: passed=${pass} failed=${fail}`);
rmSync(dir, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
