// FLY-1657 design-node full-data rehearsal: migrate a COPY of the r4 snapshot
// comm/flywheel DB (no stale intent) end-to-end. Sandbox: /tmp/t1657 only.
import { copyFileSync, chmodSync, mkdirSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { migrateCommDbWithSwap } from "./src/mailbox-migration.js";

const dir = "/tmp/t1657/rehearsal";
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const dbPath = `${dir}/comm.db`;
copyFileSync("/tmp/t1657/fly-snap.db", dbPath);
chmodSync(dbPath, 0o600);

const t0 = Date.now();
try {
  const result = await migrateCommDbWithSwap(dbPath);
  console.log("REHEARSAL OK in", ((Date.now() - t0) / 1000).toFixed(1), "s:", JSON.stringify(result));
  const db = new Database(dbPath, { readonly: true });
  const meta = db.prepare("SELECT * FROM mailbox_migration_meta WHERE singleton=1").get();
  const mailbox = db.prepare("SELECT COUNT(*) AS n FROM mailbox").get();
  const extra = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workflow_engine_park','workflow_engine_park_cursor','lead_inbox_fenced_root','lead_inbox_freeze_install') ORDER BY name").all();
  console.log("meta:", JSON.stringify(meta));
  console.log("mailbox rows:", JSON.stringify(mailbox), "extra tables preserved:", JSON.stringify(extra));
  db.close();
} catch (error) {
  console.log("REHEARSAL FAILED after", ((Date.now() - t0) / 1000).toFixed(1), "s:", error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
