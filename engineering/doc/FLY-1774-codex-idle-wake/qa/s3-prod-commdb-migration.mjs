const { default: Database } = await import("/Users/xiaorongli/Dev/flywheel-FLY-1774/node_modules/.pnpm/better-sqlite3@12.8.0/node_modules/better-sqlite3/lib/index.js");
const { CommDB } = await import("/Users/xiaorongli/Dev/flywheel-FLY-1774/packages/flywheel-comm/dist/db.js");
const p = process.argv[2];
const raw = new Database(p, { readonly: true });
const cols0 = raw.prepare("PRAGMA table_info(sessions)").all().map(c => c.name);
const n0 = raw.prepare("SELECT COUNT(*) n FROM sessions").get().n;
const mb0 = raw.prepare("SELECT COUNT(*) n FROM mailbox").get().n;
const sql0 = raw.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'").get().sql;
raw.close();
console.log("BEFORE cols:", cols0.join(","));
console.log("BEFORE sessions rows:", n0, "mailbox rows:", mb0);
console.log("BEFORE has phase_keep_alive:", cols0.includes("phase_keep_alive"));

const t0 = Date.now();
const db = new CommDB(p);   // runs applyMigrations()
const ms = Date.now() - t0;
db.close();

const raw2 = new Database(p, { readonly: true });
const cols1 = raw2.prepare("PRAGMA table_info(sessions)").all();
const n1 = raw2.prepare("SELECT COUNT(*) n FROM sessions").get().n;
const mb1 = raw2.prepare("SELECT COUNT(*) n FROM mailbox").get().n;
const zero = raw2.prepare("SELECT COUNT(*) n FROM sessions WHERE phase_keep_alive = 0").get().n;
const nonzero = raw2.prepare("SELECT COUNT(*) n FROM sessions WHERE phase_keep_alive != 0").get().n;
const integ = raw2.prepare("PRAGMA integrity_check").get();
raw2.close();
const pk = cols1.find(c => c.name === "phase_keep_alive");
console.log("AFTER  open+migrate ms:", ms);
console.log("AFTER  phase_keep_alive col:", JSON.stringify(pk));
console.log("AFTER  sessions rows:", n1, "mailbox rows:", mb1);
console.log("AFTER  rows with 0:", zero, " rows !=0:", nonzero);
console.log("AFTER  integrity:", JSON.stringify(integ));

// idempotent reopen
const t1 = Date.now();
const db2 = new CommDB(p); db2.close();
console.log("REOPEN ms:", Date.now() - t1);
const raw3 = new Database(p, { readonly: true });
console.log("REOPEN sessions rows:", raw3.prepare("SELECT COUNT(*) n FROM sessions").get().n,
            "mailbox rows:", raw3.prepare("SELECT COUNT(*) n FROM mailbox").get().n);
raw3.close();
console.log(JSON.stringify({ pass: !cols0.includes("phase_keep_alive") && !!pk && n1 === n0 && mb1 === mb0 && nonzero === 0 && integ.integrity_check === "ok" }));
