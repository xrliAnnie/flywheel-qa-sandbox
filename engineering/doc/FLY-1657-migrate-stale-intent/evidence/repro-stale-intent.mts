// FLY-1657 design-node positive control: reproduce run4's exact failure
// mechanism on a tiny synthetic legacy DB + a stale phase=done swap intent.
// Touches ONLY files inside this scratchpad directory.
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import Database from "better-sqlite3";
import { migrateCommDbWithSwap } from "./src/mailbox-migration.js";

const root = join("/tmp/t1657/sandbox");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });
const dbPath = join(root, "comm.db");

// Minimal legacy shape: messages + lead_inbox tables, no mailbox tables.
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE messages (id TEXT PRIMARY KEY, from_agent TEXT, to_agent TEXT,
    type TEXT, content TEXT, parent_id TEXT, created_at TEXT);
  CREATE TABLE lead_inbox (id TEXT PRIMARY KEY, source TEXT, ref_message_id TEXT,
    carrier TEXT, processed_at TEXT, consumed_at TEXT, delivered_at TEXT,
    batch_id TEXT, claimed_by TEXT, candidates_json TEXT);
  INSERT INTO messages VALUES ('m1','runner-x','flywheel-eng-lead','report','hi',NULL,'2026-08-06T00:00:00Z');
`);
db.close();

// Stale intent exactly like production comm/flywheel: phase=done, created by an
// earlier incarnation whose swap COMPLETED, after which the canonical was
// restored to legacy out-of-band (file-level snapshot restore).
const intent = {
  v: 1,
  dbPath,
  backupPath: join(root, "comm.db.pre-fly1572-2026-08-06T17-55-35.799Z"),
  stagingPath: join(root, ".fly1572-stale/comm.db"),
  phase: "done",
  originalMode: 0o600,
  createdAt: "2026-08-06T17:55:35.799Z",
  sourceMessages: 1192,
  sourceLeadInbox: 53294,
  quarantinedSidecars: [],
};
writeFileSync(`${dbPath}.migration-swap-intent.json`, JSON.stringify(intent));

try {
  const result = await migrateCommDbWithSwap(dbPath);
  console.log("UNEXPECTED SUCCESS:", JSON.stringify(result));
  process.exitCode = 2;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log("THREW:", message);
  // run4's exact error text
  if (message === "no such table: mailbox_migration_meta") {
    console.log("REPRO-CONFIRMED: exact run4 failure reproduced via stale phase=done intent");
  } else {
    console.log("DIFFERENT ERROR — mechanism hypothesis needs revision");
    process.exitCode = 3;
  }
}
// Prove no silent mutation of the canonical: still legacy tables?
const check = new Database(dbPath, { readonly: true });
const names = check.prepare("SELECT name, type FROM sqlite_master WHERE name IN ('messages','lead_inbox','mailbox_migration_meta') ORDER BY name").all();
console.log("post-state:", JSON.stringify(names));
check.close();
