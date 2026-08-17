#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

canonical='{"k":"bool","v":false}'
canonical_digest="$(printf '%s' "$canonical" | shasum -a 256 | awk '{print $1}')"

printf '%s\n' "export const FEATURE_FLAGS = [{" \
  "  name: \"keep_me\", longTermKeep: true," \
  "  keepReason: \"2026-08-16 [flag-scan:run-1]: still needed\"," \
  "}, {" \
  "  name: \"clear_me\", retiring: \"FLY-999\"," \
  "}];" >"$tmp_dir/registry.ts"
printf '%s\n' "[" \
  "{\"flag\":\"keep_me\",\"verdict\":\"keep\",\"runToken\":\"run-1\",\"decidedAt\":\"2026-08-16\",\"canonicalDigest\":\"$canonical_digest\",\"reason\":\"still needed\"}," \
  "{\"flag\":\"clear_me\",\"verdict\":\"clear\",\"runToken\":\"run-1\",\"decidedAt\":\"2026-08-16\",\"canonicalDigest\":\"$canonical_digest\",\"execIssue\":\"FLY-999\"}" \
  "]" >"$tmp_dir/verdicts.json"

node "$repo_root/scripts/verify-flag-verdicts.mjs" \
  --verdicts "$tmp_dir/verdicts.json" --registry "$tmp_dir/registry.ts"

node - "$tmp_dir/state.db" "$canonical" <<'NODE'
const { createRequire } = require('node:module');
const requireFromTeamlead = createRequire(process.cwd() + '/packages/teamlead/package.json');
const Database = requireFromTeamlead('better-sqlite3');
const db = new Database(process.argv[2]);
db.exec('CREATE TABLE flag_scan_runs(run_id INTEGER PRIMARY KEY, run_token TEXT); CREATE TABLE flag_scan_run_items(run_id INTEGER, flag_name TEXT, bucket TEXT, canonical TEXT)');
db.prepare('INSERT INTO flag_scan_runs VALUES(1, ?)').run('run-1');
for (const flag of ['keep_me', 'clear_me']) db.prepare('INSERT INTO flag_scan_run_items VALUES(1, ?, ?, ?)').run(flag, 'candidate', process.argv[3]);
db.close();
NODE

before="$(shasum -a 256 "$tmp_dir/state.db" | awk '{print $1}')"
node "$repo_root/scripts/verify-flag-verdicts.mjs" --preflight \
  --db "$tmp_dir/state.db" --verdicts "$tmp_dir/verdicts.json"
after="$(shasum -a 256 "$tmp_dir/state.db" | awk '{print $1}')"
test "$before" = "$after"

printf '%s\n' '[{"flag":"clear_me","verdict":"clear","runToken":"run-1","decidedAt":"2026-08-16","canonicalDigest":"bad","execIssue":"FLY-999"}]' >"$tmp_dir/bad.json"
if node "$repo_root/scripts/verify-flag-verdicts.mjs" --verdicts "$tmp_dir/bad.json" --registry "$tmp_dir/registry.ts" >/dev/null 2>&1; then
  echo "FAIL: malformed digest was accepted" >&2
  exit 1
fi

echo "PASS: flag verdict verifier is read-only in both modes"
