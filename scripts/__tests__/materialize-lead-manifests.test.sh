#!/bin/bash
# FLY-650: materialize-lead-manifests.sh (WI-4; Codex R1#2 / R2#5).
#
# Asserts the materializer produces the SAME manifest shape claude-lead.sh writes
# (minus runtime-only pid), carries model/leadBackend, is idempotent, and starts
# no Lead process.
set -uo pipefail
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MAT="${REPO_ROOT}/scripts/materialize-lead-manifests.sh"
[ -f "$MAT" ] || { echo "ERROR: $MAT not found"; exit 1; }

SANDBOX="$(mktemp -d -t fly650-materialize-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
H="$SANDBOX/home"; mkdir -p "$H/.flywheel"
cat > "$H/.flywheel/projects.json" <<'EOF'
[
  { "projectName": "flywheel", "projectRoot": "Dev/flywheel", "projectRepo": "xrliAnnie/flywheel",
    "leads": [
      { "agentId": "flywheel-cos-lead", "chatChannel": "1", "match": { "labels": ["cos"] }, "botTokenEnv": "CASS_BOT_TOKEN", "canSpawnRunners": false },
      { "agentId": "flywheel-eng-lead", "chatChannel": "2", "match": { "labels": ["eng"] }, "botTokenEnv": "TADASHI_BOT_TOKEN", "model": "fable", "backend": "claude-code" }
    ] },
  { "projectName": "geoforge3d", "projectRoot": "/abs/geoforge3d", "projectRepo": "xrliAnnie/GeoForge3D",
    "leads": [ { "agentId": "geoforge3d-product-lead", "chatChannel": "3", "match": { "labels": ["product"] }, "botTokenEnv": "PETER_BOT_TOKEN" } ] }
]
EOF

bash "$MAT" --home "$H" >/dev/null 2>&1
MDIR="$H/.flywheel/manifests"

# ── M1: a manifest per lead ──
if [ -f "$MDIR/flywheel-flywheel-cos-lead.json" ] \
   && [ -f "$MDIR/flywheel-flywheel-eng-lead.json" ] \
   && [ -f "$MDIR/geoforge3d-geoforge3d-product-lead.json" ]; then
  pass "M1 one manifest per lead (3)"
else
  fail "M1 manifests: $(ls "$MDIR" 2>/dev/null)"
fi

# ── M2: base shape matches claude-lead.sh minus pid ──
# claude-lead writes: leadId,projectDir,projectName,subdir,workspace,botTokenEnv,
# mcpExclude,chromeEnabled,pid (+optional model,leadBackend). Materializer = same
# minus pid.
KEYS="$(jq -r 'keys_unsorted | sort | join(",")' "$MDIR/flywheel-flywheel-cos-lead.json")"
EXPECT="botTokenEnv,chromeEnabled,leadId,mcpExclude,projectDir,projectName,subdir,workspace"
if [ "$KEYS" = "$EXPECT" ]; then
  pass "M2 base key set == claude-lead manifest minus pid"
else
  fail "M2 keys: got [$KEYS] want [$EXPECT]"
fi
# explicitly: no runtime-only pid
if jq -e 'has("pid")' "$MDIR/flywheel-flywheel-cos-lead.json" >/dev/null 2>&1; then
  fail "M2b materialized manifest must NOT carry runtime-only pid"
else
  pass "M2b no runtime-only pid"
fi

# ── M3: field values + carrier fields ──
F="$MDIR/flywheel-flywheel-eng-lead.json"
if [ "$(jq -r '.leadId' "$F")" = "flywheel-eng-lead" ] \
   && [ "$(jq -r '.projectDir' "$F")" = "$H/Dev/flywheel" ] \
   && [ "$(jq -r '.workspace' "$F")" = "$H/Dev/flywheel" ] \
   && [ "$(jq -r '.botTokenEnv' "$F")" = "TADASHI_BOT_TOKEN" ] \
   && [ "$(jq -r '.model' "$F")" = "fable" ] \
   && [ "$(jq -r '.leadBackend.backendId' "$F")" = "claude-code" ] \
   && [ "$(jq -r '.subdir' "$F")" = "" ] \
   && [ "$(jq -r '.chromeEnabled' "$F")" = "false" ]; then
  pass "M3 values + carrier fields (model/leadBackend) preserved"
else
  fail "M3 values: $(cat "$F")"
fi

# ── M3b: absent carrier fields stay absent (never injected) ──
C="$MDIR/flywheel-flywheel-cos-lead.json"
if ! jq -e 'has("model")' "$C" >/dev/null 2>&1 && ! jq -e 'has("leadBackend")' "$C" >/dev/null 2>&1; then
  pass "M3b absent model/leadBackend stay absent"
else
  fail "M3b carrier fields injected when not configured: $(cat "$C")"
fi

# ── M3c: absolute projectRoot kept as-is ──
[ "$(jq -r '.projectDir' "$MDIR/geoforge3d-geoforge3d-product-lead.json")" = "/abs/geoforge3d" ] \
  && pass "M3c absolute projectRoot kept" || fail "M3c abs projectRoot"

# ── M4: idempotent — re-run keeps existing (no clobber), --force overwrites ──
# tamper a manifest, re-run without --force → kept; with --force → rewritten.
echo '{"tampered":true}' > "$C"
bash "$MAT" --home "$H" >/dev/null 2>&1
jq -e '.tampered == true' "$C" >/dev/null 2>&1 && pass "M4a re-run keeps existing (create-if-absent)" || fail "M4a clobbered without --force"
bash "$MAT" --home "$H" --force >/dev/null 2>&1
jq -e 'has("leadId")' "$C" >/dev/null 2>&1 && pass "M4b --force overwrites" || fail "M4b --force did not overwrite"

# ── M5: starts no process (only manifest files exist; nothing else created) ──
COUNT="$(find "$MDIR" -type f | wc -l | tr -d ' ')"
[ "$COUNT" = "3" ] && pass "M5 wrote exactly 3 files, started nothing" || fail "M5 unexpected files: $COUNT"

echo ""
echo "materialize-lead-manifests.test: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
