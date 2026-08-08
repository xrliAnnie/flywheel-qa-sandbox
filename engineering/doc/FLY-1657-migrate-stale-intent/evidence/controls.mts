// FLY-1657 design-node controls:
// A) negative control — same tiny legacy DB WITHOUT intent file → must migrate OK
//    (proves shape-independence: trigger is the stale intent, not the schema)
// B) root idempotency — copy of PRODUCTION root (migrated) + phase=done intent
//    (paths rewritten to sandbox) → migrateCommDbWithSwap must succeed, no damage
import { mkdirSync, writeFileSync, rmSync, copyFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrateCommDbWithSwap } from "./src/mailbox-migration.js";

const root = "/tmp/t1657/controls";
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

// ---- A: no-intent control on the same synthetic legacy shape ----
const aDb = join(root, "a", "comm.db");
mkdirSync(join(root, "a"), { recursive: true });
{
  const db = new Database(aDb);
  db.exec(`
    CREATE TABLE messages (id TEXT PRIMARY KEY, from_agent TEXT, to_agent TEXT,
      type TEXT, content TEXT, parent_id TEXT, created_at TEXT);
    CREATE TABLE lead_inbox (id TEXT PRIMARY KEY, source TEXT, ref_message_id TEXT,
      carrier TEXT, processed_at TEXT, consumed_at TEXT, delivered_at TEXT,
      batch_id TEXT, claimed_by TEXT, candidates_json TEXT);
    INSERT INTO messages VALUES ('m1','runner-x','flywheel-eng-lead','report','hi',NULL,'2026-08-06T00:00:00Z');
    -- extra tables mimicking comm/flywheel's newer shape (ride-along, untouched)
    CREATE TABLE workflow_engine_park (id TEXT PRIMARY KEY);
    CREATE TABLE lead_inbox_fenced_root (id TEXT PRIMARY KEY);
  `);
  db.close();
}
try {
  const result = await migrateCommDbWithSwap(aDb);
  console.log("A-CONTROL OK:", JSON.stringify({ status: result.status, msgs: result.sourceMessages }));
} catch (error) {
  console.log("A-CONTROL FAILED:", error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}

// ---- B: production-root copy + stale done intent, sandbox paths ----
const bDir = join(root, "b");
mkdirSync(bDir, { recursive: true });
const bDb = join(bDir, "comm.db");
copyFileSync("/Users/xiaorongli/.flywheel/comm.db", bDb);
chmodSync(bDb, 0o600);
const intent = {
  v: 1,
  dbPath: bDb,
  backupPath: join(bDir, "comm.db.pre-fly1572-2026-08-07T07-17-02.013Z"),
  stagingPath: join(bDir, ".fly1572-x/comm.db"),
  phase: "done",
  originalMode: 0o644,
  createdAt: "2026-08-07T07:17:02.013Z",
  sourceMessages: 3,
  sourceLeadInbox: 0,
  quarantinedSidecars: [],
};
writeFileSync(`${bDb}.migration-swap-intent.json`, JSON.stringify(intent));
try {
  const result = await migrateCommDbWithSwap(bDb);
  console.log("B-ROOT-IDEMPOTENT OK:", JSON.stringify(result));
  const check = new Database(bDb, { readonly: true });
  const meta = check.prepare("SELECT schema_generation FROM mailbox_migration_meta WHERE singleton=1").get();
  const rows = check.prepare("SELECT COUNT(*) AS n FROM mailbox").get();
  console.log("B post-state:", JSON.stringify({ meta, mailboxRows: rows }));
  check.close();
} catch (error) {
  console.log("B-ROOT-IDEMPOTENT FAILED:", error instanceof Error ? error.message : String(error));
  process.exitCode = 3;
}
