#!/bin/bash
# FLY-898 — tests for apply-core-room-mention-gate.sh
#
# Hermetic: every test reads/writes only temp fixtures under a mktemp dir. It
# never touches a real access.json, the marketplace plugin, or Discord. The
# per-group preflight is pointed at a temp server.ts fixture via
# FLYWHEEL_DISCORD_PLUGIN_SERVER.
#
# Coverage:
#   T1  id-only (preflight PASS): sets requireMention:true + mentionPatterns:[]
#   T2  idempotent: re-run at target → exit 0, no change
#   T3  touches NO other field/group (allowBots, dmPolicy, other group, allowFrom)
#   T4  backup of the original written before the edit
#   T5  --dry-run does NOT modify the file
#   T6  invalid JSON → fail-closed non-zero, file unchanged
#   T7  absent core group → NO-OP exit 0, file unchanged (never creates a group)
#   T8  missing access file → no-op exit 0 (lead not provisioned)
#   T9  preflight FAIL + --id-only → requireMention:true ONLY (no mentionPatterns), exit 0
#   T10 no --id-only → requireMention:true only, mentionPatterns untouched
#   T11 --all fleet mode patches gated claude leads, skips codex/CoS/joycon

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/../apply-core-room-mention-gate.sh"

TMP_DIR="$(mktemp -d -t apply-core-gate-test.XXXXXX)" || { echo "FATAL: mktemp -d failed" >&2; exit 1; }
[ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ] || { echo "FATAL: TMP_DIR unusable" >&2; exit 1; }
# shellcheck disable=SC2329
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

CORE="1487340532610109520"      # core group
OTHER="1509720034463846481"     # an unrelated group (must stay untouched)

PASSED=0
FAILED=0
ERRORS=""
log_test() { echo "[TEST] $*"; }
log_pass() { echo "  ✓ $*"; PASSED=$((PASSED + 1)); }
log_fail() { echo "  ✗ $*" >&2; FAILED=$((FAILED + 1)); ERRORS="${ERRORS}\n  - $*"; }

# server.ts fixtures. The preflight matches an EXPLICIT support SENTINEL (Codex R2
# MEDIUM) — not a code shape — so the marker cannot false-positive on a helper
# DEFINITION or a half-finished impl. SUPPORTED carries the sentinel; the others
# (old / half-baked-with-a-definition-but-no-gate-routing) do NOT.
SENTINEL='FLY-898-PER-GROUP-MENTION-PATTERNS-ACTIVE'
SUPPORTED_SRV="$TMP_DIR/server-supported.ts"
printf '// %s\nconst m = await isMentioned(msg, resolveGroupMentionPatterns(policy, access))\n' "$SENTINEL" > "$SUPPORTED_SRV"
UNSUPPORTED_SRV="$TMP_DIR/server-old.ts"
printf 'const m = await isMentioned(msg, access.mentionPatterns)\n' > "$UNSUPPORTED_SRV"
# The half-baked fixture DEFINES resolveGroupMentionPatterns AND declares the type
# field, but the gate still calls the GLOBAL patterns — no sentinel → unsupported.
# This is the exact false-positive a code-shape grep would have missed.
HALFBAKED_SRV="$TMP_DIR/server-halfbaked.ts"
printf 'type GroupPolicy = { requireMention: boolean; mentionPatterns?: string[] }\nfunction resolveGroupMentionPatterns(policy, access) { return access.mentionPatterns }\nconst m = await isMentioned(msg, access.mentionPatterns)\n' > "$HALFBAKED_SRV"

# A representative non-CoS lead access.json: core group requireMention:false.
make_access() {
  cat > "$1" <<JSON
{
  "dmPolicy": "pairing",
  "allowFrom": ["annie"],
  "groups": {
    "$OTHER": { "requireMention": true, "allowFrom": ["annie"] },
    "$CORE": { "requireMention": false, "allowFrom": ["annie"] }
  },
  "pending": {},
  "mentionPatterns": ["\\\\bPeter\\\\b"],
  "allowBots": ["bot-1", "bot-2"]
}
JSON
}

# canonical view of everything EXCEPT the core group (proves nothing else changed).
rest_fingerprint() { jq -S "del(.groups[\"$CORE\"])" "$1"; }

# ── T1: id-only preflight PASS ──────────────────────────────────────────────
log_test "T1 id-only (preflight PASS) sets requireMention:true + mentionPatterns:[]"
A="$TMP_DIR/t1.json"; make_access "$A"
if FLYWHEEL_DISCORD_PLUGIN_SERVER="$SUPPORTED_SRV" bash "$SCRIPT" \
    --access-file "$A" --channel-id "$CORE" --id-only >/dev/null 2>&1; then
  req=$(jq -r '.groups["'"$CORE"'"].requireMention' "$A")
  mp=$(jq -c '.groups["'"$CORE"'"].mentionPatterns // "MISS"' "$A")
  af_len=$(jq -r '.groups["'"$CORE"'"].allowFrom | length' "$A")
  if [ "$req" = "true" ] && [ "$mp" = "[]" ] && [ "$af_len" = "0" ]; then
    log_pass "T1 requireMention:true + mentionPatterns:[] + allowFrom:[]"
  else
    log_fail "T1 wrong state (req=$req mp=$mp allowFrom_len=$af_len)"
  fi
else
  log_fail "T1 script exited non-zero on a valid id-only apply"
fi

# ── T2: idempotent ──────────────────────────────────────────────────────────
log_test "T2 idempotent re-run at target → exit 0, unchanged"
snap="$(cat "$A")"
FLYWHEEL_DISCORD_PLUGIN_SERVER="$SUPPORTED_SRV" bash "$SCRIPT" \
  --access-file "$A" --channel-id "$CORE" --id-only >/dev/null 2>&1
rc=$?
if [ "$rc" -eq 0 ] && [ "$(cat "$A")" = "$snap" ]; then
  log_pass "T2 idempotent (exit 0, byte-identical)"
else
  log_fail "T2 not idempotent (rc=$rc changed=$([ "$(cat "$A")" = "$snap" ] && echo no || echo yes))"
fi

# ── T3: only the core group changes; its allowFrom is retired (FLY-944) ─────
log_test "T3 core allowFrom cleared; everything OUTSIDE the core group canonical-identical"
B="$TMP_DIR/t3.json"; make_access "$B"
before="$(rest_fingerprint "$B")"
FLYWHEEL_DISCORD_PLUGIN_SERVER="$SUPPORTED_SRV" bash "$SCRIPT" \
  --access-file "$B" --channel-id "$CORE" --id-only >/dev/null 2>&1
after="$(rest_fingerprint "$B")"
core_af_len=$(jq -r '.groups["'"$CORE"'"].allowFrom | length' "$B")
if [ "$before" = "$after" ] && [ "$core_af_len" = "0" ]; then
  log_pass "T3 core allowFrom cleared; allowBots/dmPolicy/top-level allowFrom/other group untouched"
else
  log_fail "T3 wrong (rest_changed=$([ "$before" = "$after" ] && echo no || echo yes) core_allowFrom_len=$core_af_len)"
fi

# ── T4: backup written ──────────────────────────────────────────────────────
log_test "T4 a backup of the original is written"
C="$TMP_DIR/t4.json"; make_access "$C"; orig="$(cat "$C")"
FLYWHEEL_DISCORD_PLUGIN_SERVER="$SUPPORTED_SRV" bash "$SCRIPT" \
  --access-file "$C" --channel-id "$CORE" --id-only >/dev/null 2>&1
bak="$(ls "$C".bak.* 2>/dev/null | head -1)"
if [ -n "$bak" ] && [ "$(cat "$bak")" = "$orig" ]; then
  log_pass "T4 backup exists and matches pre-edit content"
else
  log_fail "T4 no backup or mismatch (bak=$bak)"
fi

# ── T5: dry-run ─────────────────────────────────────────────────────────────
log_test "T5 --dry-run does not modify the file"
D="$TMP_DIR/t5.json"; make_access "$D"; snap="$(cat "$D")"
FLYWHEEL_DISCORD_PLUGIN_SERVER="$SUPPORTED_SRV" bash "$SCRIPT" \
  --access-file "$D" --channel-id "$CORE" --id-only --dry-run >/dev/null 2>&1
if [ "$(cat "$D")" = "$snap" ]; then
  log_pass "T5 file byte-identical after --dry-run"
else
  log_fail "T5 --dry-run mutated the file"
fi

# ── T6: invalid JSON ────────────────────────────────────────────────────────
log_test "T6 invalid JSON fails closed"
F="$TMP_DIR/t6.json"; printf '{ not json ' > "$F"; snap="$(cat "$F")"
if FLYWHEEL_DISCORD_PLUGIN_SERVER="$SUPPORTED_SRV" bash "$SCRIPT" \
    --access-file "$F" --channel-id "$CORE" --id-only >/dev/null 2>&1; then
  log_fail "T6 exited 0 on invalid JSON"
else
  [ "$(cat "$F")" = "$snap" ] && log_pass "T6 non-zero and file unchanged" || log_fail "T6 mutated invalid-JSON file"
fi

# ── T7: absent core group → NO-OP exit 0 ────────────────────────────────────
log_test "T7 absent core group is a no-op (exit 0, never creates a group)"
G="$TMP_DIR/t7.json"; make_access "$G"; snap="$(cat "$G")"
if FLYWHEEL_DISCORD_PLUGIN_SERVER="$SUPPORTED_SRV" bash "$SCRIPT" \
    --access-file "$G" --channel-id "9999999999" --id-only >/dev/null 2>&1; then
  [ "$(cat "$G")" = "$snap" ] && log_pass "T7 exit 0 and file unchanged (no group created)" || log_fail "T7 mutated on absent group"
else
  log_fail "T7 exited non-zero for an absent core group (should be no-op)"
fi

# ── T8: missing access file → no-op exit 0 ──────────────────────────────────
log_test "T8 missing access file → no-op exit 0 (lead not provisioned)"
MISS="$TMP_DIR/nope/access.json"
if FLYWHEEL_DISCORD_PLUGIN_SERVER="$SUPPORTED_SRV" bash "$SCRIPT" \
    --access-file "$MISS" --channel-id "$CORE" --id-only >/dev/null 2>&1; then
  [ ! -f "$MISS" ] && log_pass "T8 exit 0 and did not create the file" || log_fail "T8 created the missing file"
else
  log_fail "T8 exited non-zero on a missing file (should be no-op)"
fi

# ── T9: preflight FAIL + --id-only → requireMention only ────────────────────
log_test "T9 preflight FAIL + --id-only → requireMention:true only (no mentionPatterns)"
H="$TMP_DIR/t9.json"; make_access "$H"
FLYWHEEL_DISCORD_PLUGIN_SERVER="$UNSUPPORTED_SRV" bash "$SCRIPT" \
  --access-file "$H" --channel-id "$CORE" --id-only >/dev/null 2>&1
rc=$?
req=$(jq -r '.groups["'"$CORE"'"].requireMention' "$H")
has_mp=$(jq -r '.groups["'"$CORE"'"] | has("mentionPatterns")' "$H")
if [ "$rc" -eq 0 ] && [ "$req" = "true" ] && [ "$has_mp" = "false" ]; then
  log_pass "T9 requireMention:true, mentionPatterns NOT written (id-only deferred)"
else
  log_fail "T9 wrong (rc=$rc req=$req has_mp=$has_mp)"
fi

# ── T9b: half-baked plugin (type field only, no gate routing) → unsupported ─
log_test "T9b half-baked plugin (declares field but doesn't route gate) → id-only refused"
Hb="$TMP_DIR/t9b.json"; make_access "$Hb"
FLYWHEEL_DISCORD_PLUGIN_SERVER="$HALFBAKED_SRV" bash "$SCRIPT" \
  --access-file "$Hb" --channel-id "$CORE" --id-only >/dev/null 2>&1
rc=$?
req=$(jq -r '.groups["'"$CORE"'"].requireMention' "$Hb")
has_mp=$(jq -r '.groups["'"$CORE"'"] | has("mentionPatterns")' "$Hb")
if [ "$rc" -eq 0 ] && [ "$req" = "true" ] && [ "$has_mp" = "false" ]; then
  log_pass "T9b type-field-only is NOT enough → requireMention only (no silent half-fix)"
else
  log_fail "T9b wrong (rc=$rc req=$req has_mp=$has_mp)"
fi

# ── T10: no --id-only → requireMention only, patterns untouched ─────────────
log_test "T10 no --id-only → requireMention:true only"
I="$TMP_DIR/t10.json"; make_access "$I"
FLYWHEEL_DISCORD_PLUGIN_SERVER="$SUPPORTED_SRV" bash "$SCRIPT" \
  --access-file "$I" --channel-id "$CORE" >/dev/null 2>&1
req=$(jq -r '.groups["'"$CORE"'"].requireMention' "$I")
has_mp=$(jq -r '.groups["'"$CORE"'"] | has("mentionPatterns")' "$I")
if [ "$req" = "true" ] && [ "$has_mp" = "false" ]; then
  log_pass "T10 requireMention:true, no per-group mentionPatterns"
else
  log_fail "T10 wrong (req=$req has_mp=$has_mp)"
fi

# ── T11: --all fleet mode ───────────────────────────────────────────────────
log_test "T11 --all patches gated claude leads, skips codex/CoS/joycon"
GATE_CLI="$SCRIPT_DIR/../../dist/core-room-gate-cli.js"
if [ ! -f "$GATE_CLI" ]; then
  echo "  ⚠ T11 SKIPPED — dist not built ($GATE_CLI). Run: pnpm -F flywheel-teamlead build" >&2
else
  CH_DIR="$TMP_DIR/channels"
  # gated claude leads: geo product-lead + growth reflection-lead. codex-sib (codex)
  # must be skipped; simba/mufasa (CoS) + joycon (core-no-CoS) never appear.
  mkdir -p "$CH_DIR/discord-product-lead" "$CH_DIR/discord-reflection-lead" \
           "$CH_DIR/discord-cos-lead" "$CH_DIR/discord-joycon-lead"
  GEO_CORE="core-geo"; GROWTH_CORE="core-growth"
  for pair in "product-lead:$GEO_CORE" "reflection-lead:$GROWTH_CORE" "cos-lead:$GEO_CORE" "joycon-lead:core-joycon"; do
    lead="${pair%%:*}"; cc="${pair##*:}"
    cat > "$CH_DIR/discord-$lead/access.json" <<JSON
{ "groups": { "$cc": { "requireMention": false, "allowFrom": [] } }, "mentionPatterns": [] }
JSON
  done
  PROJECTS_JSON=$(cat <<'JSON'
[
  {"projectName":"geoforge3d","projectRoot":"/tmp/geo","generalChannel":"core-geo","leads":[
    {"agentId":"cos-lead","chatChannel":"core-geo","match":{"labels":["cos"]}},
    {"agentId":"product-lead","chatChannel":"chat-peter","match":{"labels":["product"]}}]},
  {"projectName":"growth","projectRoot":"/tmp/growth","generalChannel":"core-growth","leads":[
    {"agentId":"mufasa-lead","chatChannel":"core-growth","backend":"codex-app-server","companion":true,"canSpawnRunners":false,"match":{"labels":["growth"]}},
    {"agentId":"codex-sib","chatChannel":"chat-sib","backend":"codex-app-server","companion":true,"canSpawnRunners":false,"match":{"labels":["x"]}},
    {"agentId":"reflection-lead","chatChannel":"chat-reflection","match":{"labels":["reflection"]}}]},
  {"projectName":"joycon","projectRoot":"/tmp/joycon","generalChannel":"core-joycon","leads":[
    {"agentId":"joycon-lead","chatChannel":"chat-joycon","match":{"labels":["joycon"]}}]}
]
JSON
)
  FLYWHEEL_PROJECTS="$PROJECTS_JSON" \
  FLYWHEEL_CHANNELS_DIR="$CH_DIR" \
  FLYWHEEL_DISCORD_PLUGIN_SERVER="$SUPPORTED_SRV" \
    bash "$SCRIPT" --all --id-only >/dev/null 2>&1
  rc=$?
  p_req=$(jq -r '.groups["core-geo"].requireMention' "$CH_DIR/discord-product-lead/access.json")
  p_mp=$(jq -c '.groups["core-geo"].mentionPatterns // "MISS"' "$CH_DIR/discord-product-lead/access.json")
  r_req=$(jq -r '.groups["core-growth"].requireMention' "$CH_DIR/discord-reflection-lead/access.json")
  cos_req=$(jq -r '.groups["core-geo"].requireMention' "$CH_DIR/discord-cos-lead/access.json")
  joy_req=$(jq -r '.groups["core-joycon"].requireMention' "$CH_DIR/discord-joycon-lead/access.json")
  if [ "$rc" -eq 0 ] && [ "$p_req" = "true" ] && [ "$p_mp" = "[]" ] && \
     [ "$r_req" = "true" ] && [ "$cos_req" = "false" ] && [ "$joy_req" = "false" ]; then
    log_pass "T11 gated claude leads patched; CoS + joycon untouched"
  else
    log_fail "T11 wrong (rc=$rc peter_req=$p_req peter_mp=$p_mp refl_req=$r_req cos_req=$cos_req joy_req=$joy_req)"
  fi
fi

# ── T12: --allowfrom-only clears ONLY allowFrom on the target group ─────────
log_test "T12 --allowfrom-only clears allowFrom, leaves requireMention/mentionPatterns/others"
A="$TMP_DIR/t12.json"; make_access "$A"
BEFORE_REST="$(rest_fingerprint "$A")"
FLYWHEEL_DISCORD_PLUGIN_SERVER="$SUPPORTED_SRV" "$SCRIPT" \
  --access-file "$A" --channel-id "$CORE" --allowfrom-only >/dev/null 2>&1
rc=$?
if [ $rc -eq 0 ] \
  && [ "$(jq -r ".groups[\"$CORE\"].allowFrom | length" "$A")" = "0" ] \
  && [ "$(jq -r ".groups[\"$CORE\"].requireMention" "$A")" = "false" ] \
  && [ "$(jq -r ".groups[\"$CORE\"] | has(\"mentionPatterns\")" "$A")" = "false" ] \
  && [ "$(rest_fingerprint "$A")" = "$BEFORE_REST" ]; then
  log_pass "allowFrom cleared, requireMention/mentionPatterns untouched, rest identical"
else
  log_fail "T12 wrong result (rc=$rc): $(jq -c ".groups[\"$CORE\"]" "$A")"
fi

# ── T13: --allowfrom-only idempotent ────────────────────────────────────────
log_test "T13 --allowfrom-only re-run at target state is a no-op"
BEFORE_ALL="$(jq -S . "$A")"
FLYWHEEL_DISCORD_PLUGIN_SERVER="$SUPPORTED_SRV" "$SCRIPT" \
  --access-file "$A" --channel-id "$CORE" --allowfrom-only >/dev/null 2>&1
rc=$?
if [ $rc -eq 0 ] && [ "$(jq -S . "$A")" = "$BEFORE_ALL" ]; then
  log_pass "idempotent no-op"
else
  log_fail "T13 re-run changed file or failed (rc=$rc)"
fi

# ── T14: --allowfrom-only absent group → no-op, never creates ───────────────
log_test "T14 --allowfrom-only on absent group is a no-op"
A="$TMP_DIR/t14.json"; make_access "$A"
BEFORE_ALL="$(jq -S . "$A")"
FLYWHEEL_DISCORD_PLUGIN_SERVER="$SUPPORTED_SRV" "$SCRIPT" \
  --access-file "$A" --channel-id "9999999" --allowfrom-only >/dev/null 2>&1
rc=$?
if [ $rc -eq 0 ] && [ "$(jq -S . "$A")" = "$BEFORE_ALL" ]; then
  log_pass "absent group untouched, exit 0"
else
  log_fail "T14 mutated file or failed (rc=$rc)"
fi

# ── T15: 已 flip 但 allowFrom 未清的存量(FLY-898 旧目标态)会被补清 ─────────
log_test "T15 legacy FLY-898 target-state (requireMention:true, allowFrom non-empty) gets allowFrom cleared"
A="$TMP_DIR/t15.json"; make_access "$A"
jq ".groups[\"$CORE\"].requireMention = true | .groups[\"$CORE\"].mentionPatterns = []" "$A" > "$A.tmp" && mv "$A.tmp" "$A"
FLYWHEEL_DISCORD_PLUGIN_SERVER="$SUPPORTED_SRV" "$SCRIPT" \
  --access-file "$A" --channel-id "$CORE" --id-only >/dev/null 2>&1
rc=$?
if [ $rc -eq 0 ] && [ "$(jq -r ".groups[\"$CORE\"].allowFrom | length" "$A")" = "0" ]; then
  log_pass "legacy flipped group still gets allowFrom cleared"
else
  log_fail "T15 allowFrom not cleared (rc=$rc): $(jq -c ".groups[\"$CORE\"]" "$A")"
fi

# ── T16: --all-shared per-lead 分流:非-CoS core 走主 transform,CoS core / roundtable 只清 allowFrom ─
log_test "T16 --all-shared sweeps by role: non-CoS core flips+clears, CoS core & roundtable clear-only"
FLEET_DIR="$TMP_DIR/channels16"; mkdir -p "$FLEET_DIR/discord-cos" "$FLEET_DIR/discord-eng"
RT="1512578695468941333"
cat > "$TMP_DIR/roundtable16.json" <<JSON
{ "channelId": "$RT" }
JSON
# cos(CoS): core requireMention:false 带白名单(设计态,只清 allowFrom)+ roundtable 带白名单
cat > "$FLEET_DIR/discord-cos/access.json" <<JSON
{ "dmPolicy": "pairing", "allowFrom": ["annie"], "allowBots": ["b1"],
  "groups": {
    "$CORE": { "requireMention": false, "allowFrom": ["annie", "eng-bot"] },
    "$RT":   { "requireMention": true,  "allowFrom": ["annie"] }
  }, "pending": {} }
JSON
# eng(非-CoS,legacy 形态): core requireMention:false + 白名单 → 必须 flip+清一起;other 组不动
cat > "$FLEET_DIR/discord-eng/access.json" <<JSON
{ "dmPolicy": "pairing", "allowFrom": ["annie"], "groups": {
    "$CORE":  { "requireMention": false, "allowFrom": ["annie", "cos-bot"] },
    "$RT":    { "requireMention": true,  "allowFrom": ["annie", "b1"] },
    "$OTHER": { "requireMention": true,  "allowFrom": ["annie"] }
  }, "pending": {} }
JSON
# 假 GATE_CLI:--all-leads 输出两行(cos=isCoS, eng=gateNonCoS)
FAKE_CLI="$TMP_DIR/fake-gate-cli-16.js"
cat > "$FAKE_CLI" <<JS
if (process.argv.includes("--all-leads")) {
  console.log(JSON.stringify({ projectName: "p", leadId: "cos", coreChannelId: "$CORE", isCoS: true,  gateNonCoS: false, backend: "claude-code" }));
  console.log(JSON.stringify({ projectName: "p", leadId: "eng", coreChannelId: "$CORE", isCoS: false, gateNonCoS: true,  backend: "claude-code" }));
}
JS
FLYWHEEL_CHANNELS_DIR="$FLEET_DIR" \
FLYWHEEL_CORE_ROOM_GATE_CLI="$FAKE_CLI" \
FLYWHEEL_ROUNDTABLE_FILE="$TMP_DIR/roundtable16.json" \
FLYWHEEL_DISCORD_PLUGIN_SERVER="$SUPPORTED_SRV" \
  "$SCRIPT" --all-shared >/dev/null 2>&1
rc=$?
ok=1
# eng 非-CoS core:flip + patterns + allowFrom 清空,同一次 patch(pile-on 安全不变量)
[ "$(jq -r ".groups[\"$CORE\"].requireMention" "$FLEET_DIR/discord-eng/access.json")" = "true" ] || ok=0
[ "$(jq -r ".groups[\"$CORE\"].mentionPatterns | length" "$FLEET_DIR/discord-eng/access.json")" = "0" ] || ok=0
[ "$(jq -r ".groups[\"$CORE\"].allowFrom | length" "$FLEET_DIR/discord-eng/access.json")" = "0" ] || ok=0
# cos CoS core:requireMention 保持 false,只清 allowFrom
[ "$(jq -r ".groups[\"$CORE\"].requireMention" "$FLEET_DIR/discord-cos/access.json")" = "false" ] || ok=0
[ "$(jq -r ".groups[\"$CORE\"].allowFrom | length" "$FLEET_DIR/discord-cos/access.json")" = "0" ] || ok=0
[ "$(jq -r ".groups[\"$CORE\"] | has(\"mentionPatterns\")" "$FLEET_DIR/discord-cos/access.json")" = "false" ] || ok=0
# roundtable 两边都清空、requireMention 不动
[ "$(jq -r ".groups[\"$RT\"].allowFrom | length" "$FLEET_DIR/discord-cos/access.json")" = "0" ] || ok=0
[ "$(jq -r ".groups[\"$RT\"].allowFrom | length" "$FLEET_DIR/discord-eng/access.json")" = "0" ] || ok=0
[ "$(jq -r ".groups[\"$RT\"].requireMention" "$FLEET_DIR/discord-eng/access.json")" = "true" ] || ok=0
# other group + 顶层 allowFrom 不动
[ "$(jq -r ".groups[\"$OTHER\"].allowFrom | length" "$FLEET_DIR/discord-eng/access.json")" = "1" ] || ok=0
[ "$(jq -r ".allowFrom | length" "$FLEET_DIR/discord-eng/access.json")" = "1" ] || ok=0
# 同一进程对同一文件连续 patch(core + roundtable)必须留下两份互不覆盖的备份
# (Codex code review R1 MEDIUM:.bak.<epoch>.<pid> 同秒碰撞会吃掉第一份备份)
[ "$(ls "$FLEET_DIR/discord-cos/access.json".bak.* 2>/dev/null | wc -l | tr -d ' ')" = "2" ] || ok=0
if [ $rc -eq 0 ] && [ $ok -eq 1 ]; then
  log_pass "role-aware sweep correct on all groups"
else
  log_fail "T16 sweep wrong (rc=$rc)"
fi

# ── T17: --all-shared --dry-run 不改任何文件 ────────────────────────────────
log_test "T17 --all-shared --dry-run mutates nothing"
jq ".groups[\"$RT\"].allowFrom = [\"annie\"]" "$FLEET_DIR/discord-eng/access.json" \
  > "$FLEET_DIR/discord-eng/access.json.tmp2" && mv "$FLEET_DIR/discord-eng/access.json.tmp2" "$FLEET_DIR/discord-eng/access.json"
BEFORE_A="$(jq -S . "$FLEET_DIR/discord-eng/access.json")"
FLYWHEEL_CHANNELS_DIR="$FLEET_DIR" \
FLYWHEEL_CORE_ROOM_GATE_CLI="$FAKE_CLI" \
FLYWHEEL_ROUNDTABLE_FILE="$TMP_DIR/roundtable16.json" \
FLYWHEEL_DISCORD_PLUGIN_SERVER="$SUPPORTED_SRV" \
  "$SCRIPT" --all-shared --dry-run >/dev/null 2>&1
rc=$?
if [ $rc -eq 0 ] && [ "$(jq -S . "$FLEET_DIR/discord-eng/access.json")" = "$BEFORE_A" ]; then
  log_pass "dry-run left files untouched"
else
  log_fail "T17 dry-run mutated file (rc=$rc)"
fi

# ── T18: 回归守卫(Codex R1 #1):--all-shared 绝不产出 requireMention:false + allowFrom:[] 的非-CoS core ─
log_test "T18 --all-shared never leaves a non-CoS core open (requireMention:false + empty allowFrom)"
req="$(jq -r ".groups[\"$CORE\"].requireMention" "$FLEET_DIR/discord-eng/access.json")"
af_len="$(jq -r ".groups[\"$CORE\"].allowFrom | length" "$FLEET_DIR/discord-eng/access.json")"
if [ "$req" = "true" ] || [ "$af_len" != "0" ]; then
  log_pass "non-CoS core not left open (requireMention=$req, allowFrom len=$af_len)"
else
  log_fail "T18 non-CoS core left OPEN: requireMention=false + allowFrom=[]"
fi

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "═════════════════════════════════════════"
echo "PASSED: $PASSED"
echo "FAILED: $FAILED"
echo "═════════════════════════════════════════"
if [ "$FAILED" -gt 0 ]; then echo -e "Failures:$ERRORS" >&2; exit 1; fi
exit 0
