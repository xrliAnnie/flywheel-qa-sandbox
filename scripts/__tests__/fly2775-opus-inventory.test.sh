#!/usr/bin/env bash
# FLY-2775: the Opus-line inventory is a read-only deployment gate. It exits 1
# while any bound template node or Lead still pins an exact claude-opus-* id,
# and 0 once every Opus surface stores a follow-latest family alias.
set -uo pipefail

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf 'ok - %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'not ok - %s\n' "$1"; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT="${REPO_ROOT}/scripts/fly2775-opus-inventory.mjs"
ROOT="$(mktemp -d -t fly2775-inventory-XXXXXX)"
trap 'rm -rf "$ROOT"' EXIT
export HOME="$ROOT"

fixture_db() {
  local db="$1" qa_model="$2"
  node --input-type=module - "$db" "$qa_model" "$REPO_ROOT" <<'NODE'
import { createRequire } from "node:module";
const [db, qaModel, root] = process.argv.slice(2);
const Database = createRequire(`${root}/packages/teamlead/package.json`)("better-sqlite3");
const conn = new Database(db);
conn.exec(`
  CREATE TABLE workflow_category_binding(project TEXT, task_category TEXT, template_id TEXT, updated_by TEXT, updated_at TEXT);
  CREATE TABLE workflow_template(template_id TEXT PRIMARY KEY, current_published_revision INTEGER);
  CREATE TABLE workflow_template_revision(template_id TEXT, revision INTEGER, manifest TEXT);
`);
const manifest = (model) => JSON.stringify({ schema_version: 3, nodes: [
  { id: "implement", type: "implement", vendor: "codex", model: "gpt-5.6-sol" },
  { id: "eng_design", type: "design", vendor: "claude", model: "fable" },
  { id: "qa", type: "qa", vendor: "claude", model },
]});
conn.prepare("INSERT INTO workflow_template VALUES (?, ?)").run("tpl_code", 2);
conn.prepare("INSERT INTO workflow_template_revision VALUES (?, ?, ?)").run("tpl_code", 1, manifest("claude-opus-4-8"));
conn.prepare("INSERT INTO workflow_template_revision VALUES (?, ?, ?)").run("tpl_code", 2, manifest(qaModel));
for (const project of ["flywheel", "geoforge3d"]) {
  conn.prepare("INSERT INTO workflow_category_binding VALUES (?, 'code', 'tpl_code', 't', 't')").run(project);
}
conn.close();
NODE
}

cat > "$ROOT/projects.json" <<'JSON'
[{"projectName":"flywheel","leads":[
  {"agentId":"flywheel-product-lead","model":"opus[1m]"},
  {"agentId":"fable-lead","model":"fable"},
  {"agentId":"default-lead"}
]}]
JSON

# 1. A template still pinning the exact id: gate closed, both projects listed.
fixture_db "$ROOT/pinned.db" "claude-opus-5"
OUT="$(node "$SCRIPT" --db "$ROOT/pinned.db" --projects "$ROOT/projects.json" 2>/dev/null)"; rc=$?
if [ "$rc" = 1 ] \
  && [ "$(printf '%s\n' "$OUT" | grep -c 'tpl_code@2 | qa | `claude-opus-5`.*❌ 需迁移')" = 2 ] \
  && printf '%s\n' "$OUT" | grep -q 'flywheel-product-lead | `opus\[1m\]`.*✅ 跟最新' \
  && ! printf '%s\n' "$OUT" | grep -q 'fable-lead\|default-lead\|eng_design'; then
  ok "an exact Opus pin closes the gate (exit 1) for every bound project; non-Opus rows are out of scope"
else
  bad "pinned inventory wrong (rc=$rc): $OUT"
fi

# 2. Only the CURRENT published revision counts (rev 1's 4.8 pin is history).
if ! printf '%s\n' "$OUT" | grep -q 'claude-opus-4-8'; then
  ok "historical revisions are ignored; only the current published revision is gated"
else
  bad "a non-current revision leaked into the gate"
fi

# 3. After migration to the alias: gate open.
fixture_db "$ROOT/alias.db" "opus"
OUT="$(node "$SCRIPT" --db "$ROOT/alias.db" --projects "$ROOT/projects.json" 2>/dev/null)"; rc=$?
if [ "$rc" = 0 ] && printf '%s\n' "$OUT" | grep -q '需迁移 0 行'; then
  ok "every Opus surface on a family alias opens the gate (exit 0)"
else
  bad "alias inventory did not open the gate (rc=$rc): $OUT"
fi

# 4. Read-only: the database bytes are unchanged by a run.
BEFORE="$(shasum -a 256 "$ROOT/alias.db" | cut -d' ' -f1)"
node "$SCRIPT" --db "$ROOT/alias.db" --projects "$ROOT/projects.json" >/dev/null 2>&1
AFTER="$(shasum -a 256 "$ROOT/alias.db" | cut -d' ' -f1)"
[ "$BEFORE" = "$AFTER" ] && ok "the inventory never writes the database" || bad "database bytes changed"

# 5. Fails CLOSED on unreadable inputs — never a silent pass.
node "$SCRIPT" --db "$ROOT/alias.db" --projects "$ROOT/missing-projects.json" >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok "a missing projects.json fails the gate (exit 2) instead of dropping every Lead" \
  || bad "missing projects.json exited $rc"
printf '{not json' > "$ROOT/bad-projects.json"
node "$SCRIPT" --db "$ROOT/alias.db" --projects "$ROOT/bad-projects.json" >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok "a malformed projects.json fails the gate (exit 2)" || bad "malformed projects.json exited $rc"
FLYWHEEL_CONFIG_DIST="$ROOT/no-such-config.js" node "$SCRIPT" --db "$ROOT/alias.db" --projects "$ROOT/projects.json" >/dev/null 2>&1; rc=$?
[ "$rc" = 2 ] && ok "an unloadable model registry fails the gate (exit 2)" || bad "unloadable registry exited $rc"

# 6. An alias that the live registry cannot turn into a dispatchable id is NOT a pass.
cat > "$ROOT/dark-config.mjs" <<'JS'
export function getModelConfigSnapshot() {
  return { getModelRegistryEntry: () => null, normalizeDispatchModel: () => null };
}
JS
OUT="$(FLYWHEEL_CONFIG_DIST="$ROOT/dark-config.mjs" node "$SCRIPT" --db "$ROOT/alias.db" --projects "$ROOT/projects.json" 2>/dev/null)"; rc=$?
if [ "$rc" = 1 ] && printf '%s\n' "$OUT" | grep -q '别名解析不到可派工 id'; then
  ok "an unresolvable alias closes the gate (exit 1)"
else
  bad "unresolvable alias did not close the gate (rc=$rc): $OUT"
fi

echo "fly2775-opus-inventory: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
