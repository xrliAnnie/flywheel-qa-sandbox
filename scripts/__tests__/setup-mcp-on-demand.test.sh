#!/bin/bash
# FLY-1185 deliverable 19 — contract tests for setup-mcp-on-demand.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$SCRIPT_DIR/../setup-mcp-on-demand.sh"
TMPDIR_T="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_T"' EXIT

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

mk_settings() {  # <path> [playwright-value: true|false|absent]
  local p="$1" v="${2:-true}"
  if [ "$v" = "absent" ]; then
    printf '{\n  "model": "opus",\n  "enabledPlugins": {\n    "serena@claude-plugins-official": true\n  }\n}\n' > "$p"
  else
    printf '{\n  "model": "opus",\n  "enabledPlugins": {\n    "playwright@claude-plugins-official": %s,\n    "serena@claude-plugins-official": true\n  }\n}\n' "$v" > "$p"
  fi
}

pw_value() {  # <path> → prints python repr of the plugin value
  python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('enabledPlugins',{}).get('playwright@claude-plugins-official'))" "$1"
}

echo "test 1: flips true -> false, preserves other keys, creates backup"
S="$TMPDIR_T/s1.json"; mk_settings "$S" true
bash "$SUT" "$S" >/dev/null
[ "$(pw_value "$S")" = "False" ] && ok "flipped to false" || bad "value not flipped: $(pw_value "$S")"
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); assert d['model']=='opus' and d['enabledPlugins']['serena@claude-plugins-official'] is True" "$S" \
  && ok "other keys preserved" || bad "other keys damaged"
ls "$TMPDIR_T"/s1.json.bak-mcp-on-demand-* >/dev/null 2>&1 && ok "backup created on change" || bad "no backup created"

echo "test 2: idempotent — second run is a no-op with NO new backup"
BEFORE_COUNT=$(ls "$TMPDIR_T"/s1.json.bak-mcp-on-demand-* | wc -l | tr -d ' ')
BEFORE_BYTES=$(cat "$S")
bash "$SUT" "$S" | grep -q "no-op" && ok "reports no-op" || bad "second run not a no-op"
AFTER_COUNT=$(ls "$TMPDIR_T"/s1.json.bak-mcp-on-demand-* | wc -l | tr -d ' ')
[ "$BEFORE_COUNT" = "$AFTER_COUNT" ] && ok "no new backup on no-op" || bad "backup created on no-op"
[ "$BEFORE_BYTES" = "$(cat "$S")" ] && ok "file byte-identical on no-op" || bad "file changed on no-op"

echo "test 3: adds the key when enabledPlugins lacks it"
S3="$TMPDIR_T/s3.json"; mk_settings "$S3" absent
bash "$SUT" "$S3" >/dev/null
[ "$(pw_value "$S3")" = "False" ] && ok "key added as false" || bad "key not added"

echo "test 4: refuses symlink"
S4="$TMPDIR_T/s4-real.json"; mk_settings "$S4" true
ln -s "$S4" "$TMPDIR_T/s4-link.json"
if bash "$SUT" "$TMPDIR_T/s4-link.json" 2>/dev/null; then bad "accepted a symlink"; else ok "symlink refused"; fi
[ "$(pw_value "$S4")" = "True" ] && ok "symlink target untouched" || bad "symlink target modified"

echo "test 5: refuses bad JSON and leaves the file byte-identical"
S5="$TMPDIR_T/s5.json"; printf '{ this is not json' > "$S5"
BEFORE=$(cat "$S5")
if bash "$SUT" "$S5" 2>/dev/null; then bad "accepted bad JSON"; else ok "bad JSON refused"; fi
[ "$BEFORE" = "$(cat "$S5")" ] && ok "bad-JSON file untouched" || bad "bad-JSON file modified"

echo "test 6: refuses missing file"
if bash "$SUT" "$TMPDIR_T/does-not-exist.json" 2>/dev/null; then bad "accepted missing file"; else ok "missing file refused"; fi

echo "test 7: preserves the original file mode"
S7="$TMPDIR_T/s7.json"; mk_settings "$S7" true
chmod 600 "$S7"
bash "$SUT" "$S7" >/dev/null
MODE=$(stat -f '%Lp' "$S7" 2>/dev/null || stat -c '%a' "$S7")
[ "$MODE" = "600" ] && ok "mode 600 preserved" || bad "mode changed: $MODE"

echo "test 8: no temp litter left in the directory"
LITTER=$( (ls "$TMPDIR_T"/*.tmp.* 2>/dev/null || true) | wc -l | tr -d ' ')
[ "$LITTER" = "0" ] && ok "no temp files left" || bad "temp files left behind"

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ]
