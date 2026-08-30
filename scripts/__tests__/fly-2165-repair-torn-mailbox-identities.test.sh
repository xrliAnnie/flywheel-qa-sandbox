#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="$ROOT/scripts/fly-2165-repair-torn-mailbox-identities.mjs"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() {
  printf '[FAIL] %s\n' "$1" >&2
  exit 1
}

sha256_file() {
  node -e 'const {createHash}=require("node:crypto");const {readFileSync}=require("node:fs");process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"))' "$1"
}

seed_db() {
  local db_path="$1" variant="$2" fixture_root="$3"
  node --input-type=module - "$ROOT" "$db_path" "$variant" "$fixture_root" <<'NODE'
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [root, dbPath, variant, fixtureRoot] = process.argv.slice(2);
const requireFromComm = createRequire(resolve(root, "packages/flywheel-comm/package.json"));
const Database = requireFromComm("better-sqlite3");
const { MAILBOX_SCHEMA } = await import(
	pathToFileURL(resolve(root, "packages/flywheel-comm/dist/mailbox-schema.js")).href
);
const db = new Database(dbPath);
db.exec(MAILBOX_SCHEMA);
const columns = db.prepare("PRAGMA table_info(mailbox)").all().map((row) => row.name);
let selected = columns.map((name) => `"${name}"`);
if (variant === "missing") selected = selected.filter((name) => name !== '"collapse_key"');
if (variant === "affinity") {
	selected = selected.map((name) =>
		name === '"seq"' ? 'CAST("seq" AS TEXT) AS "seq"' : name,
	);
}
db.exec(`CREATE TABLE mailbox_archive AS SELECT ${selected.join(", ")} FROM mailbox WHERE 0`);
if (variant === "extra") db.exec("ALTER TABLE mailbox_archive ADD COLUMN extra TEXT");

if (variant === "positive") {
	const refsDir = resolve(fixtureRoot, "refs");
	mkdirSync(refsDir, { recursive: true });
	const contentRef = resolve(refsDir, "content.txt");
	writeFileSync(contentRef, "repair content ref\n");
	const insertIdentity = db.prepare(
		"INSERT INTO mailbox_identity (id, delivery_id, insert_projection_hash) VALUES (?, ?, ?)",
	);
	const insertMailbox = db.prepare(`
		INSERT INTO mailbox
		 (id, delivery_id, from_agent, to_agent, recipient_kind, type, content,
		  content_ref, created_at, state, acked_at, dead_at, dead_reason, sender_ref)
		 VALUES (?, ?, 'bridge', 'eng-lead', 'lead', 'patrol_tick', ?, ?,
		         '2026-08-01T00:00:00.000Z', ?, ?, ?, ?,
		         '{"v":1,"authority":"unprotected"}')
	`);
	const seed = ({ id, state, ackedAt = null, deadAt = null, deadReason = null, ref = null }) => {
		insertIdentity.run(id, `delivery:${id}`, `hash:${id}`);
		insertMailbox.run(id, `delivery:${id}`, id, ref, state, ackedAt, deadAt, deadReason);
	};
	seed({ id: "acked", state: "ACKED", ackedAt: "2026-08-01T01:00:00.000Z" });
	seed({ id: "content", state: "ACKED", ackedAt: "2026-08-01T01:01:00.000Z", ref: contentRef });
	seed({ id: "dead", state: "DEAD", deadAt: "2026-08-01T01:02:00.000Z", deadReason: "test" });
	seed({ id: "missing-dead-at", state: "DEAD", deadReason: "missing_stamp" });
	db.exec("INSERT INTO mailbox_archive SELECT * FROM mailbox");
	db.exec("DROP TRIGGER mailbox_delete_requires_archive; DELETE FROM mailbox");
}
db.close();
NODE
}

assert_repaired_db() {
  local db_path="$1" expected_logs="$2" expected_active="$3"
  node --input-type=module - "$ROOT" "$db_path" "$expected_logs" "$expected_active" <<'NODE'
import { createRequire } from "node:module";
import { resolve } from "node:path";
const [root, dbPath, expectedLogsRaw, expectedActiveRaw] = process.argv.slice(2);
const requireFromComm = createRequire(resolve(root, "packages/flywheel-comm/package.json"));
const Database = requireFromComm("better-sqlite3");
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const expectedLogs = Number(expectedLogsRaw);
const expectedActive = Number(expectedActiveRaw);
const logs = db.prepare("SELECT event_id, message_id, row_json FROM mailbox_log WHERE event='archived' ORDER BY message_id").all();
if (logs.length !== expectedLogs) throw new Error(`expected ${expectedLogs} archived logs, got ${logs.length}`);
const active = db.prepare("SELECT COUNT(*) AS n FROM mailbox_identity WHERE archived_at IS NULL").get().n;
if (active !== expectedActive) throw new Error(`expected ${expectedActive} active identities, got ${active}`);
if (expectedLogs === 3) {
	const byId = new Map(logs.map((row) => [row.message_id, JSON.parse(row.row_json)]));
	for (const id of ["acked", "content", "dead"]) {
		if (logs.find((row) => row.message_id === id)?.event_id !== `fly2165:archived:${id}`) throw new Error(`wrong repair event id for ${id}`);
		if (byId.get(id)?.lead_repair?.issue !== "FLY-2165") throw new Error(`missing repair provenance for ${id}`);
	}
	if (byId.get("content")?.content_ref_archive?.content_base64 == null) throw new Error("content ref was not archived");
	const gc = db.prepare("SELECT COUNT(*) AS n FROM content_ref_gc_outbox WHERE message_id='content'").get().n;
	if (gc !== 1) throw new Error(`expected one content GC intent, got ${gc}`);
	const missing = db.prepare("SELECT archived_at FROM mailbox_identity WHERE id='missing-dead-at'").get();
	if (missing?.archived_at !== null) throw new Error("unrepairable row was stamped");
}
if (db.pragma("quick_check", { simple: true }) !== "ok") throw new Error("repaired db quick_check failed");
db.close();
NODE
}

POSITIVE_DB="$TMP/positive.db"
seed_db "$POSITIVE_DB" positive "$TMP/positive-fixture"
BEFORE_DRY="$(sha256_file "$POSITIVE_DB")"
DRY_JSON="$(node "$SCRIPT" --db "$POSITIVE_DB")"
DRY_JSON_REPEAT="$(node "$SCRIPT" --db "$POSITIVE_DB")"
AFTER_DRY="$(sha256_file "$POSITIVE_DB")"
[[ "$BEFORE_DRY" == "$AFTER_DRY" ]] || fail "dry-run mutated the database"
[[ "$DRY_JSON" == "$DRY_JSON_REPEAT" ]] || fail "dry-run receipt is not byte-stable"
node -e '
const value=JSON.parse(process.argv[1]);
if(value.mode!=="dry-run"||value.candidates!==4||value.repairable!==3||value.repaired!==0) throw new Error("unexpected dry-run receipt");
if(value.unrepairable?.missingTerminalAt!==1) throw new Error("missing terminal count mismatch");
if(!/^[a-f0-9]{64}$/.test(value.sourceDigest)) throw new Error("source digest missing");
if(value.schemaDigests?.mailbox!==value.schemaDigests?.mailboxArchive) throw new Error("normalized schema digests differ");
' "$DRY_JSON"

if node "$SCRIPT" --db "$POSITIVE_DB" --apply >"$TMP/no-backup.out" 2>&1; then
  fail "--apply succeeded without --backup"
fi

BACKUP="$TMP/positive.backup.db"
APPLY_JSON="$(node "$SCRIPT" --db "$POSITIVE_DB" --apply --backup "$BACKUP" --batch-size 2)"
[[ -f "$BACKUP" ]] || fail "apply did not create backup"
node -e '
const value=JSON.parse(process.argv[1]);
if(value.mode!=="apply"||value.repaired!==3||value.remainingTorn!==1) throw new Error("unexpected apply receipt");
if(value.backup?.quickCheck!=="ok"||!/^[a-f0-9]{64}$/.test(value.backup?.sha256??"")) throw new Error("backup evidence missing");
if(value.checkpoint?.busy==null||value.beforeAfterBytes?.after?.db==null) throw new Error("storage evidence missing");
' "$APPLY_JSON"
assert_repaired_db "$POSITIVE_DB" 3 1

if node "$SCRIPT" --db "$POSITIVE_DB" --apply --backup "$BACKUP" >"$TMP/existing-backup.out" 2>&1; then
  fail "apply reused an existing backup path"
fi
ln -s "$POSITIVE_DB" "$TMP/symlink.backup.db"
if node "$SCRIPT" --db "$POSITIVE_DB" --apply --backup "$TMP/symlink.backup.db" >"$TMP/symlink-backup.out" 2>&1; then
  fail "apply accepted a symlink backup path"
fi

SECOND_BACKUP="$TMP/positive-second.backup.db"
SECOND_JSON="$(node "$SCRIPT" --db "$POSITIVE_DB" --apply --backup "$SECOND_BACKUP")"
node -e 'const value=JSON.parse(process.argv[1]);if(value.repaired!==0||value.remainingTorn!==1)throw new Error("second apply was not idempotent")' "$SECOND_JSON"

for variant in missing extra affinity; do
  BAD_DB="$TMP/$variant.db"
  BAD_BACKUP="$TMP/$variant.backup.db"
  seed_db "$BAD_DB" "$variant" "$TMP/$variant-fixture"
  BAD_BEFORE="$(sha256_file "$BAD_DB")"
  if node "$SCRIPT" --db "$BAD_DB" >"$TMP/$variant-dry.out" 2>&1; then
    fail "$variant schema drift passed dry-run"
  fi
  if node "$SCRIPT" --db "$BAD_DB" --apply --backup "$BAD_BACKUP" >"$TMP/$variant-apply.out" 2>&1; then
    fail "$variant schema drift passed apply"
  fi
  [[ ! -e "$BAD_BACKUP" ]] || fail "$variant schema drift created a backup before failing"
  [[ "$BAD_BEFORE" == "$(sha256_file "$BAD_DB")" ]] || fail "$variant schema drift mutated the database"
done

FAULT_DB="$TMP/fault.db"
seed_db "$FAULT_DB" positive "$TMP/fault-fixture"
if node "$SCRIPT" --db "$FAULT_DB" --apply --backup "$TMP/fault.backup.db" --batch-size 1 --test-fault-after-log-id dead >"$TMP/fault.out" 2>&1; then
  fail "fault injection unexpectedly succeeded"
fi
assert_repaired_db "$FAULT_DB" 2 2
RESUME_JSON="$(node "$SCRIPT" --db "$FAULT_DB" --apply --backup "$TMP/fault-resume.backup.db" --batch-size 1)"
node -e 'const value=JSON.parse(process.argv[1]);if(value.repaired!==1||value.remainingTorn!==1)throw new Error("resume did not repair only the rolled-back batch")' "$RESUME_JSON"
assert_repaired_db "$FAULT_DB" 3 1

printf '[PASS] FLY-2165 torn mailbox identity repair is backup-first, fail-closed, atomic, and idempotent\n'
