/**
 * FLY-1066 independent QA — REAL end-to-end product test.
 * Real SQLite files, real CommDB class from dist (what production loads).
 * No mocks. Includes a POSITIVE CONTROL proving the pre-fix bug is real.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "../../../packages/flywheel-comm/node_modules/better-sqlite3/lib/index.js";
import { CommDB } from "../../../packages/flywheel-comm/dist/db.js";

const dir = mkdtempSync(join(tmpdir(), "fly1066-qa-"));
let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? (pass++, console.log(`  ✅ ${n}`)) : (fail++, console.log(`  ❌ ${n}  ${d}`)); };

// Pre-FLY-1066 schema, verbatim shape (CHECK lacks 'failed').
const OLD_SCHEMA = `
CREATE TABLE sessions (
  execution_id  TEXT PRIMARY KEY,
  tmux_window   TEXT NOT NULL,
  project_name  TEXT NOT NULL,
  issue_id      TEXT,
  lead_id       TEXT,
  vendor        TEXT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at      TEXT,
  status        TEXT DEFAULT 'running' CHECK(status IN ('running','completed','timeout','blocked'))
);`;

console.log("\n=== A. POSITIVE CONTROL — the pre-fix bug is real ===");
{
  const p = join(dir, "old.db");
  const raw = new Database(p);
  raw.exec(OLD_SCHEMA);
  raw.prepare("INSERT INTO sessions (execution_id,tmux_window,project_name) VALUES ('exec-old','win-1','flywheel')").run();
  let threw = null;
  try { raw.prepare("UPDATE sessions SET status='failed' WHERE execution_id='exec-old'").run(); }
  catch (e) { threw = e; }
  ok("pre-fix CommDB physically REJECTS status='failed' (CHECK violation)",
     threw !== null && /CHECK constraint/i.test(String(threw)), `got: ${threw}`);
  const row = raw.prepare("SELECT status FROM sessions WHERE execution_id='exec-old'").get();
  ok("→ pre-fix row is therefore STUCK at 'running' (the FLY-1066 symptom)", row.status === "running", `status=${row.status}`);
  raw.close();
}

console.log("\n=== B. Migration — old DB opened by new code ===");
{
  const p = join(dir, "migrate.db");
  const raw = new Database(p);
  raw.exec(OLD_SCHEMA);
  raw.prepare("INSERT INTO sessions (execution_id,tmux_window,project_name,issue_id,lead_id,vendor,status) VALUES ('keep-1','win-k','flywheel','FLY-1','lead-a','codex','completed')").run();
  raw.prepare("INSERT INTO sessions (execution_id,tmux_window,project_name,status) VALUES ('keep-2','win-2','flywheel','running')").run();
  raw.close();

  const db = new CommDB(p);                       // migration runs on open
  const k1 = db.getSession("keep-1");
  ok("pre-existing row survives migration byte-for-byte",
     k1 && k1.tmux_window === "win-k" && k1.issue_id === "FLY-1" && k1.lead_id === "lead-a" && k1.vendor === "codex" && k1.status === "completed",
     JSON.stringify(k1));
  ok("second pre-existing row survives", db.getSession("keep-2")?.status === "running");
  db.markSessionTerminalStatus("keep-2", "failed");
  ok("'failed' is now writable post-migration", db.getSession("keep-2")?.status === "failed");
  db.close();

  const db2 = new CommDB(p);                      // idempotency
  ok("re-open is idempotent (data intact)", db2.getSession("keep-1")?.issue_id === "FLY-1");
  db2.close();
}

console.log("\n=== C. PRODUCT SURFACE — what the Lead actually sees ===");
{
  const p = join(dir, "prod.db");
  const db = new CommDB(p);
  db.registerSession("exec-crash", "win-crash", "flywheel", "FLY-1066", "lead-a", "claude-code");

  const beforeActive = db.getActiveSessions("flywheel").map(s => s.execution_id);
  ok("baseline: a live runner IS in the active/running list", beforeActive.includes("exec-crash"));

  // Layer 1 root-cause fix: StateStore-authoritative failure mirrored at the moment it happens.
  db.markSessionTerminalStatus("exec-crash", "failed");

  const afterActive = db.getActiveSessions("flywheel").map(s => s.execution_id);
  ok("FIX: crashed runner LEAVES the running list (no more phantom 'running')",
     !afterActive.includes("exec-crash"), `active=${JSON.stringify(afterActive)}`);

  const term = db.getRecentTerminalSessions("flywheel", "lead-a", 50);
  const t = term.find(s => s.execution_id === "exec-crash");
  ok("FIX: it APPEARS in the Lead's terminal list as 'failed'", t?.status === "failed", `got=${t?.status}`);
  ok("FIX: countTerminalSessions counts it", db.countTerminalSessions("flywheel", "lead-a") === 1);
  ok("routing target (tmux_window) preserved for retry teardown", t?.tmux_window === "win-crash");
  db.close();
}

console.log("\n=== D. ended_at = first-terminal-write (no drift on re-mark) ===");
{
  const p = join(dir, "ts.db");
  const db = new CommDB(p);
  db.registerSession("e1", "w1", "flywheel");
  db.markSessionTerminalStatus("e1", "failed");
  const first = db.getSession("e1").ended_at;
  db.markSessionTerminalStatus("e1", "blocked");
  const second = db.getSession("e1");
  ok("ended_at stable across re-mark", first === second.ended_at, `${first} vs ${second.ended_at}`);
  ok("status still follows the latest mark", second.status === "blocked");
  db.close();
}

console.log("\n=== E. CAS — adapter tail-write must not clobber an authoritative mark ===");
{
  const p = join(dir, "cas.db");
  const db = new CommDB(p);
  db.registerSession("race", "w", "flywheel");
  db.markSessionTerminalStatus("race", "failed");           // StateStore authority wins first
  db.updateSessionStatusIfRunning("race", "completed");      // adapter lifecycle tail-write
  ok("adapter tail-write does NOT overwrite 'failed'", db.getSession("race")?.status === "failed",
     `got=${db.getSession("race")?.status}`);

  db.registerSession("normal", "w", "flywheel");
  db.updateSessionStatusIfRunning("normal", "completed");     // still-running row: allowed
  ok("adapter tail-write DOES retire a still-running row (control)", db.getSession("normal")?.status === "completed");
  db.close();
}

console.log("\n=== F. Late self-registration must not resurrect a marked row ===");
{
  const p = join(dir, "late.db");
  const db = new CommDB(p);
  db.registerSession("late", "w1", "flywheel");
  db.markSessionTerminalStatus("late", "failed");
  db.registerSession("late", "w2", "flywheel");               // runner registers AFTER the mark
  const s = db.getSession("late");
  ok("late register does NOT flip a marked row back to 'running'", s?.status === "failed", `got=${s?.status}`);
  db.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${"=".repeat(46)}\nRESULT: ${pass} passed, ${fail} failed\n${"=".repeat(46)}`);
process.exit(fail === 0 ? 0 : 1);
