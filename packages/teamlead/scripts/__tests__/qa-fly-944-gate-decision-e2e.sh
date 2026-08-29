#!/bin/bash
# QA · FLY-944 — DECISION-LEVEL end-to-end verification.
#
# The unit/integration suite (apply-core-room-mention-gate.test.sh) proves the
# CONFIG TRANSFORM (allowFrom cleared, pile-on invariant, idempotency, backups,
# dry-run, role-aware sweep). This harness proves the thing Annie actually
# reported: that retiring `allowFrom` FLIPS the Discord plugin's deliver/drop
# DECISION for a sibling-lead @-mention — i.e. it reproduces the FSM incident on
# the BEFORE config and shows the fix on the AFTER config, while preserving the
# FLY-152/898 no-@ reply discipline (no pile-on / no roundtable spam).
#
# It drives the REAL apply-core-room-mention-gate.sh for each transform, then
# feeds the resulting access.json through gate_sim.mjs — a faithful mirror of the
# plugin gate() ordering (server.ts lines 720-790) with the key fact that the
# per-group `allowFrom` check runs BEFORE the mention check.
#
# Hermetic: no network, no Discord, no production files. Safe to run in CI.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLY="$SCRIPT_DIR/../apply-core-room-mention-gate.sh"
SIM="$SCRIPT_DIR/gate_sim.mjs"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

CORE="1500000000000000001"   # a project core room (generalChannel)
RT="1512578695468941333"     # #leads-roundtable

# A plugin server.ts fixture that carries the per-group support sentinel, so the
# real apply script's preflight passes and --id-only writes mentionPatterns:[].
SUPPORTED_SRV="$TMP_DIR/server-supported.ts"
cat > "$SUPPORTED_SRV" <<'TS'
// FLY-898-PER-GROUP-MENTION-PATTERNS-ACTIVE
TS

PASS=0; FAIL=0
log_test() { echo ""; echo "[QA-TEST] $*"; }

# assert_eq <expected> <actual> <message>
assert_eq() {
  if [ "$1" = "$2" ]; then
    echo "  ✓ $3"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $3 (expected='$1' actual='$2')"
    FAIL=$((FAIL + 1))
  fi
}

# decide <access-file> <channel> <sender> <hasAtMention 0|1> → prints deliver|drop
decide() {
  node "$SIM" "$1" "$2" "$3" "$4"
}

# ============================================================================
# Scenario A — Tadashi (NON-CoS) in #flywheel-core: the exact FSM incident.
#   BEFORE: requireMention:false, allowFrom:[annie, cass]  (HL not listed)
#   FIX   : non-CoS core → main --id-only transform (flip + patterns + clear).
# ============================================================================
log_test "Scenario A — non-CoS core (Tadashi), the FSM @-drop incident"
A="$TMP_DIR/tadashi.json"
cat > "$A" <<JSON
{ "dmPolicy": "pairing", "allowFrom": ["annie"], "allowBots": ["hl", "cass"],
  "groups": {
    "$CORE": { "requireMention": false, "allowFrom": ["annie", "cass"] }
  }, "pending": {} }
JSON

# BEFORE — reproduce the incident: HL's REAL @ Tadashi is silently dropped.
assert_eq drop "$(decide "$A" "$CORE" hl 1)" \
  "BEFORE: HL real @ Tadashi → drop (incident reproduced: allowFrom ate the @)"
# BEFORE — founder is one of the two whitelisted ids, so founder still reaches him.
assert_eq deliver "$(decide "$A" "$CORE" annie 0)" \
  "BEFORE: founder no-@ → deliver (only founder/CoS passed — matches 'only founder triggers')"

# APPLY the real fix (non-CoS core → --id-only).
FLYWHEEL_DISCORD_PLUGIN_SERVER="$SUPPORTED_SRV" "$APPLY" \
  --access-file "$A" --channel-id "$CORE" --id-only >/dev/null 2>&1

# Config landed at the id-only target (flip + patterns + allowFrom all set).
assert_eq "true|0|0" \
  "$(jq -r ".groups[\"$CORE\"].requireMention" "$A")|$(jq -r ".groups[\"$CORE\"].mentionPatterns | length" "$A")|$(jq -r ".groups[\"$CORE\"].allowFrom | length" "$A")" \
  "AFTER config: requireMention:true + mentionPatterns:[] + allowFrom:[]"

# AFTER — the fix: HL's real @ now reaches Tadashi.
assert_eq deliver "$(decide "$A" "$CORE" hl 1)" \
  "AFTER: HL real @ Tadashi → deliver (FIX — the FSM @ would now land)"
# AFTER — discipline preserved: a sibling lead's NO-@ chatter is still dropped.
assert_eq drop "$(decide "$A" "$CORE" hl 0)" \
  "AFTER: HL no-@ chatter → drop (FLY-152 pile-on discipline preserved)"
# AFTER — the deliberate, founder-approved tightening: founder no-@ now silent
# for a flipped non-CoS lead (rule ②: no-@ core → only the CoS answers).
assert_eq drop "$(decide "$A" "$CORE" annie 0)" \
  "AFTER: founder no-@ → drop for flipped non-CoS (rule ②, Annie's own spec)"
# AFTER — founder real @ still lands (unchanged).
assert_eq deliver "$(decide "$A" "$CORE" annie 1)" \
  "AFTER: founder real @ → deliver (unchanged)"

# ============================================================================
# Scenario B — Cass (CoS) in #flywheel-core: 'CoS deaf to HL' bug.
#   BEFORE: requireMention:false, allowFrom:[annie, tadashi]  (HL not listed)
#   FIX   : CoS core → --allowfrom-only (clear allowFrom, keep requireMention:false).
# ============================================================================
log_test "Scenario B — CoS core (Cass), 'CoS could not hear HL' bug"
B="$TMP_DIR/cass.json"
cat > "$B" <<JSON
{ "dmPolicy": "pairing", "allowFrom": ["annie"], "allowBots": ["hl", "tadashi"],
  "groups": {
    "$CORE": { "requireMention": false, "allowFrom": ["annie", "tadashi"] }
  }, "pending": {} }
JSON

assert_eq drop "$(decide "$B" "$CORE" hl 1)" \
  "BEFORE: HL @ Cass → drop (reproduces 'Cass missing HL in allowFrom')"

FLYWHEEL_DISCORD_PLUGIN_SERVER="$SUPPORTED_SRV" "$APPLY" \
  --access-file "$B" --channel-id "$CORE" --allowfrom-only >/dev/null 2>&1

# CoS invariant: requireMention MUST stay false (a CoS hears its whole core).
assert_eq "false|0|false" \
  "$(jq -r ".groups[\"$CORE\"].requireMention" "$B")|$(jq -r ".groups[\"$CORE\"].allowFrom | length" "$B")|$(jq -r ".groups[\"$CORE\"] | has(\"mentionPatterns\")" "$B")" \
  "AFTER config: allowFrom:[] + requireMention STILL false + mentionPatterns untouched (CoS never flipped)"

assert_eq deliver "$(decide "$B" "$CORE" hl 1)" \
  "AFTER: HL @ Cass → deliver (FIX)"
assert_eq deliver "$(decide "$B" "$CORE" hl 0)" \
  "AFTER: HL no-@ → deliver (CoS hears its whole core, by design)"
assert_eq deliver "$(decide "$B" "$CORE" annie 0)" \
  "AFTER: founder no-@ → deliver to CoS (rule ②: the CoS is who answers)"

# ============================================================================
# Scenario C — Belle in #leads-roundtable (top-level), missing HL in allowFrom.
#   BEFORE: requireMention:true, allowFrom:[annie, ...bots]  (no HL)
#   FIX   : roundtable → --allowfrom-only (clear allowFrom, keep requireMention:true).
# ============================================================================
log_test "Scenario C — roundtable top-level (Belle), sender-whitelist missing HL"
C="$TMP_DIR/belle.json"
cat > "$C" <<JSON
{ "dmPolicy": "pairing", "allowFrom": ["annie"], "allowBots": ["hl", "ariel"],
  "groups": {
    "$RT": { "requireMention": true, "allowFrom": ["annie", "ariel", "triton"] }
  }, "pending": {} }
JSON

assert_eq drop "$(decide "$C" "$RT" hl 1)" \
  "BEFORE: HL @ Belle in roundtable → drop (allowFrom missing HL)"

FLYWHEEL_DISCORD_PLUGIN_SERVER="$SUPPORTED_SRV" "$APPLY" \
  --access-file "$C" --channel-id "$RT" --allowfrom-only >/dev/null 2>&1

assert_eq "true|0" \
  "$(jq -r ".groups[\"$RT\"].requireMention" "$C")|$(jq -r ".groups[\"$RT\"].allowFrom | length" "$C")" \
  "AFTER config: allowFrom:[] + requireMention STILL true (roundtable discipline kept)"

assert_eq deliver "$(decide "$C" "$RT" hl 1)" \
  "AFTER: HL @ Belle in roundtable → deliver (FIX)"
assert_eq drop "$(decide "$C" "$RT" hl 0)" \
  "AFTER: unrelated no-@ roundtable msg → drop (FLY-152/314 anti-spam preserved)"

# ============================================================================
echo ""
echo "═════════════════════════════════════════"
echo "QA FLY-944 decision-level E2E:  PASSED=$PASS  FAILED=$FAIL"
echo "═════════════════════════════════════════"
[ "$FAIL" -eq 0 ]
