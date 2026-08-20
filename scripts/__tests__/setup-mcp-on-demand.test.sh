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

headless_value() {  # <path> → prints python repr of the headless policy value
  python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('env',{}).get('PLAYWRIGHT_MCP_HEADLESS'))" "$1"
}

sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

receipt_for() {
  printf '%s.flywheel-mcp-policy-receipt.json' "$1"
}

echo "test 1: flips true -> false, preserves other keys, creates backup"
S="$TMPDIR_T/s1.json"; mk_settings "$S" true
bash "$SUT" "$S" >/dev/null
[ "$(pw_value "$S")" = "False" ] && ok "flipped to false" || bad "value not flipped: $(pw_value "$S")"
[ "$(headless_value "$S")" = "true" ] && ok "headless policy set" || bad "headless policy missing: $(headless_value "$S")"
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); assert d['model']=='opus' and d['enabledPlugins']['serena@claude-plugins-official'] is True" "$S" \
  && ok "other keys preserved" || bad "other keys damaged"
ls "$TMPDIR_T"/s1.json.bak-mcp-on-demand-* >/dev/null 2>&1 && ok "backup created on change" || bad "no backup created"
R1="$(receipt_for "$S")"
[ -f "$R1" ] && ok "receipt created on change" || bad "receipt missing"
python3 -c "import json,sys; r=json.load(open(sys.argv[1])); assert r['version']==1 and r['preimageSha256'] and r['postimageSha256']; assert len(r['ownedPaths'])==2" "$R1" \
  && ok "receipt binds both owned paths and image hashes" || bad "receipt schema incomplete"

echo "test 2: idempotent — second run is a no-op with NO new backup"
BEFORE_COUNT=$(ls "$TMPDIR_T"/s1.json.bak-mcp-on-demand-* | wc -l | tr -d ' ')
BEFORE_BYTES=$(cat "$S")
BEFORE_RECEIPT_SHA=$(sha256 "$R1")
bash "$SUT" "$S" | grep -q "no-op" && ok "reports no-op" || bad "second run not a no-op"
AFTER_COUNT=$(ls "$TMPDIR_T"/s1.json.bak-mcp-on-demand-* | wc -l | tr -d ' ')
[ "$BEFORE_COUNT" = "$AFTER_COUNT" ] && ok "no new backup on no-op" || bad "backup created on no-op"
[ "$BEFORE_BYTES" = "$(cat "$S")" ] && ok "file byte-identical on no-op" || bad "file changed on no-op"
[ "$BEFORE_RECEIPT_SHA" = "$(sha256 "$R1")" ] && ok "first receipt preserved on no-op" || bad "receipt overwritten on no-op"

echo "test 3: adds the key when enabledPlugins lacks it"
S3="$TMPDIR_T/s3.json"; mk_settings "$S3" absent
bash "$SUT" "$S3" >/dev/null
[ "$(pw_value "$S3")" = "False" ] && ok "key added as false" || bad "key not added"
[ "$(headless_value "$S3")" = "true" ] && ok "headless key added" || bad "headless key not added"

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

echo "test 9: clean rollback restores the byte-exact preimage"
S9="$TMPDIR_T/s9.json"; mk_settings "$S9" true
PRE9=$(sha256 "$S9")
bash "$SUT" apply "$S9" >/dev/null
bash "$SUT" rollback "$S9" >/dev/null
[ "$PRE9" = "$(sha256 "$S9")" ] && ok "clean rollback restored exact bytes" || bad "clean rollback changed preimage"
[ ! -e "$(receipt_for "$S9")" ] && ok "active receipt consumed after rollback" || bad "active receipt left after rollback"

echo "test 10: divergent rollback restores only owned paths"
S10="$TMPDIR_T/s10.json"; mk_settings "$S10" true
bash "$SUT" apply "$S10" >/dev/null
python3 - "$S10" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["feedbackSurveyState"] = {"later": True}
with open(p, "w") as f:
    json.dump(d, f, indent=2)
    f.write("\n")
PY
bash "$SUT" rollback "$S10" >/dev/null
[ "$(pw_value "$S10")" = "True" ] && ok "divergent rollback restored plugin preimage" || bad "plugin preimage not restored"
[ "$(headless_value "$S10")" = "None" ] && ok "divergent rollback removed absent headless preimage" || bad "headless preimage not restored"
python3 -c "import json,sys; assert json.load(open(sys.argv[1]))['feedbackSurveyState']=={'later': True}" "$S10" \
  && ok "divergent rollback preserved unrelated update" || bad "divergent rollback lost unrelated update"

echo "test 11: third-value rollback conflict is zero-write"
S11="$TMPDIR_T/s11.json"; mk_settings "$S11" true
bash "$SUT" apply "$S11" >/dev/null
python3 - "$S11" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d.setdefault("env", {})["PLAYWRIGHT_MCP_HEADLESS"] = "false"
with open(p, "w") as f:
    json.dump(d, f, indent=2)
    f.write("\n")
PY
BEFORE11=$(sha256 "$S11")
if bash "$SUT" rollback "$S11" >/dev/null 2>&1; then bad "rollback accepted third value"; else ok "rollback conflict refused"; fi
[ "$BEFORE11" = "$(sha256 "$S11")" ] && ok "rollback conflict made zero writes" || bad "rollback conflict mutated settings"
[ -f "$(receipt_for "$S11")" ] && ok "conflicted receipt retained for operator" || bad "conflicted receipt disappeared"

echo "test 12: unmanaged concurrent write trips preimage CAS"
S12="$TMPDIR_T/s12.json"; mk_settings "$S12" true
FLY1867_POLICY_PRE_CAS_PAUSE_MS=400 bash "$SUT" apply "$S12" >"$TMPDIR_T/s12.out" 2>"$TMPDIR_T/s12.err" &
P12=$!
sleep 0.1
python3 - "$S12" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["theme"] = "dark"
with open(p, "w") as f:
    json.dump(d, f)
    f.write("\n")
PY
if wait "$P12"; then bad "CAS accepted a concurrent rewrite"; else ok "CAS rejected concurrent rewrite"; fi
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); assert d['theme']=='dark' and d['enabledPlugins']['playwright@claude-plugins-official'] is True" "$S12" \
  && ok "CAS preserved unmanaged write and old policy" || bad "CAS clobbered concurrent write"
[ ! -e "$(receipt_for "$S12")" ] && ok "failed CAS created no receipt" || bad "failed CAS left a receipt"

echo "test 13: read-only check detects policy drift"
S13="$TMPDIR_T/s13.json"; mk_settings "$S13" true
if bash "$SUT" check "$S13" >/dev/null 2>&1; then bad "check accepted unapplied policy"; else ok "check reports unapplied policy"; fi
[ ! -e "${S13}.flywheel-mcp-policy.lock" ] && ok "failed check creates no lock artifact" || bad "failed check mutated the filesystem"
bash "$SUT" apply "$S13" >/dev/null
bash "$SUT" check "$S13" >/dev/null && ok "check accepts applied policy" || bad "check rejected applied policy"
BEFORE13=$(sha256 "$S13")
bash "$SUT" check "$S13" >/dev/null
[ "$BEFORE13" = "$(sha256 "$S13")" ] && ok "check is read-only" || bad "check mutated settings"

echo "test 14: cooperating writer lock contention fails without mutation"
S14="$TMPDIR_T/s14.json"; mk_settings "$S14" true
LOCK14="${S14}.flywheel-mcp-policy.lock"
READY14="$TMPDIR_T/s14.ready"
python3 - "$LOCK14" "$READY14" <<'PY' &
import fcntl, pathlib, sys, time
with open(sys.argv[1], "a+") as handle:
    fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
    pathlib.Path(sys.argv[2]).write_text("ready")
    time.sleep(2)
PY
P14=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -f "$READY14" ] && break; sleep 0.05; done
BEFORE14=$(sha256 "$S14")
if FLY1867_POLICY_LOCK_TIMEOUT_SECONDS=0.1 bash "$SUT" apply "$S14" >/dev/null 2>&1; then bad "apply ignored held lock"; else ok "held lock fails closed"; fi
[ "$BEFORE14" = "$(sha256 "$S14")" ] && ok "lock timeout made zero settings writes" || bad "lock timeout mutated settings"
wait "$P14"

echo "test 15: malformed owned parent is not silently replaced"
S15="$TMPDIR_T/s15.json"; printf '{"enabledPlugins":true,"env":{}}\n' > "$S15"
BEFORE15=$(sha256 "$S15")
if bash "$SUT" apply "$S15" >/dev/null 2>&1; then bad "apply accepted non-object enabledPlugins"; else ok "non-object enabledPlugins refused"; fi
[ "$BEFORE15" = "$(sha256 "$S15")" ] && ok "malformed parent made zero writes" || bad "malformed parent mutated"

echo "test 16: active receipt plus owned-path drift refuses re-apply"
S16="$TMPDIR_T/s16.json"; mk_settings "$S16" true
bash "$SUT" apply "$S16" >/dev/null
python3 - "$S16" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["enabledPlugins"]["playwright@claude-plugins-official"] = True
with open(p, "w") as f:
    json.dump(d, f)
    f.write("\n")
PY
BEFORE16=$(sha256 "$S16")
if bash "$SUT" apply "$S16" >/dev/null 2>&1; then bad "re-apply overwrote receipt-bound drift"; else ok "receipt-bound drift refused"; fi
[ "$BEFORE16" = "$(sha256 "$S16")" ] && ok "drift refusal made zero writes" || bad "drift refusal mutated settings"

echo "test 17: refuses a pre-planted symlink lock without touching its target"
S17="$TMPDIR_T/s17.json"; mk_settings "$S17" true
TARGET17="$TMPDIR_T/s17-lock-target"; printf 'sentinel\n' > "$TARGET17"; chmod 644 "$TARGET17"
ln -s "$TARGET17" "${S17}.flywheel-mcp-policy.lock"
BEFORE17=$(sha256 "$S17")
if bash "$SUT" apply "$S17" >/dev/null 2>&1; then bad "apply followed a symlink lock"; else ok "symlink lock refused"; fi
[ "$BEFORE17" = "$(sha256 "$S17")" ] && ok "symlink lock made zero settings writes" || bad "symlink lock mutated settings"
MODE17=$(stat -f '%Lp' "$TARGET17" 2>/dev/null || stat -c '%a' "$TARGET17")
[ "$(cat "$TARGET17")" = "sentinel" ] && [ "$MODE17" = "644" ] \
  && ok "symlink target content and mode untouched" \
  || bad "symlink target was changed (mode=$MODE17)"

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ]
