#!/bin/bash
# FLY-247 WI-2: plist generation — reproducible model env + safe XML generation.
#
# Covers (plan §WI-2 + Codex R1#8 / R5#4):
#   A) manifest without model → NO EnvironmentVariables, stable v2 plist format
#   B) manifest with model → FLYWHEEL_LEAD_MODEL env dict present
#   C) XML special characters in model → five-entity escaped
#   D) control characters in model → generation refused, old plist untouched
#   E) plutil lint failure → old plist untouched, no temp residue, non-zero
#   F) staged split (R5#4): model read from SOURCE manifest, ProgramArguments
#      embeds the RUNTIME (canonical) manifest path
#
# Hermetic: HOME is a sandbox; plutil is stubbed via FLYWHEEL_DAEMON_PLUTIL.
set -uo pipefail

PASSED=0
FAILED=0

log_test() { echo "[TEST] $*"; }
pass() { PASSED=$((PASSED + 1)); log_test "✓ $1"; }
fail() { FAILED=$((FAILED + 1)); log_test "✗ $1"; }

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DAEMON_SH="${REPO_ROOT}/scripts/flywheel-daemon.sh"
export FLYWHEEL_COMM_CLI="$REPO_ROOT/packages/flywheel-comm/dist/index.js"

SANDBOX="$(mktemp -d -t fly247-plist-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

export HOME="$SANDBOX"
export FLYWHEEL_STATE_DIR="$HOME/.flywheel"
export FLYWHEEL_DIR="$HOME/Dev/flywheel"
mkdir -p "$SANDBOX/.flywheel/manifests" "$SANDBOX/Library/LaunchAgents" "$SANDBOX/.flywheel/bin"

# Source the daemon script (functions only; dispatch skipped).
export FLYWHEEL_DAEMON_SOURCED=1
# plutil stub: pass by default (controlled per-case).
PLUTIL_STUB="$SANDBOX/plutil-stub"
cat > "$PLUTIL_STUB" <<'EOF'
#!/bin/bash
rc_file="${PLUTIL_STUB_RC_FILE:-}"
if [ -n "$rc_file" ] && [ -f "$rc_file" ]; then exit "$(cat "$rc_file")"; fi
exit 0
EOF
chmod +x "$PLUTIL_STUB"
export FLYWHEEL_DAEMON_PLUTIL="$PLUTIL_STUB"

# shellcheck disable=SC1090
source "$DAEMON_SH"

# Canonical identity resolution requires a selected summary granularity.
mkdir -p "$SANDBOX/.flywheel"
printf '{"granularity":"per-lead","setBy":"founder","setAt":"2026-09-16T00:00:00Z"}\n' > "$SANDBOX/.flywheel/summary-config.json"

KEY="geo-product-lead"
MANIFEST="$MANIFEST_DIR/${KEY}.json"
PLIST="$(plist_path "$KEY")"

write_manifest() {
  local model_json="$1"  # e.g. '"claude-fable-5"' or 'null'
  jq -n --argjson model "$model_json" \
    '{leadId: "product-lead", projectDir: "/tmp/geo", projectName: "geo",
      subdir: "", workspace: "/tmp/geo", botTokenEnv: "DISCORD_BOT_TOKEN",
      mcpExclude: "", chromeEnabled: false, pid: 1234}
     | (if $model != null then . + {model: $model} else . end)' > "$MANIFEST"
}

printf '[{"projectName":"geo","leads":[{"agentId":"product-lead","summaryRole":"producer","backend":"claude-code"}]}]\n' > "$PROJECTS_JSON"

# ── A) no model → no env dict + stable v2 format ─────────────────────────
write_manifest null
generate_plist "$KEY" "$MANIFEST" v2 >/dev/null
if [ -f "$PLIST" ] && ! grep -q "EnvironmentVariables" "$PLIST"; then
  pass "A1: no model → no EnvironmentVariables block"
else
  fail "A1: no model → no EnvironmentVariables block"
fi

# Golden v2 byte format.
EXPECTED="$SANDBOX/expected.plist"
cat > "$EXPECTED" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.flywheel.lead.${KEY}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${HOME}/.flywheel/bin/flywheel-lead-wrapper-v2.sh</string>
        <string>${MANIFEST}</string>
    </array>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>30</integer>
    <key>RunAtLoad</key><true/>
    <key>StandardOutPath</key><string>/tmp/flywheel-lead-${KEY}.log</string>
    <key>StandardErrorPath</key><string>/tmp/flywheel-lead-${KEY}.log</string>
</dict>
</plist>
EOF
if diff -q "$EXPECTED" "$PLIST" >/dev/null 2>&1; then
  pass "A2: no-model plist is byte-identical to the v2 format"
else
  fail "A2: no-model plist is byte-identical to the v2 format"
  diff "$EXPECTED" "$PLIST" | head -5
fi

# ── B) model present → env dict with the value ────────────────────────────
write_manifest '"claude-fable-5"'
generate_plist "$KEY" "$MANIFEST" v2 >/dev/null
if grep -q "<key>FLYWHEEL_LEAD_MODEL</key><string>claude-fable-5</string>" "$PLIST" \
  && grep -q "EnvironmentVariables" "$PLIST"; then
  pass "B1: model → FLYWHEEL_LEAD_MODEL env dict injected"
else
  fail "B1: model → FLYWHEEL_LEAD_MODEL env dict injected"
fi

# ── B2) FLY-360: bracketed 1M selector survives plist generation verbatim ──
# `[` / `]` are not XML-special, so xml_escape must pass them through unchanged.
write_manifest '"claude-opus-4-8[1m]"'
generate_plist "$KEY" "$MANIFEST" v2 >/dev/null
if grep -qF "<key>FLYWHEEL_LEAD_MODEL</key><string>claude-opus-4-8[1m]</string>" "$PLIST"; then
  pass "B2: bracketed 1M model id emitted verbatim in plist"
else
  fail "B2: bracketed 1M model id emitted verbatim in plist"
fi

# ── C) XML special characters escaped (R1#8) ─────────────────────────────
write_manifest "\"a&b<c>d'e\\\"f\""
generate_plist "$KEY" "$MANIFEST" v2 >/dev/null
if grep -q "a&amp;b&lt;c&gt;d&apos;e&quot;f" "$PLIST"; then
  pass "C1: XML five-entity escaping applied to model"
else
  fail "C1: XML five-entity escaping applied to model"
fi

# ── D) control characters refused, previous plist untouched ──────────────
write_manifest '"good-model"'
generate_plist "$KEY" "$MANIFEST" v2 >/dev/null
BEFORE_SHA=$(shasum -a 256 "$PLIST" | awk '{print $1}')
jq -n '{leadId:"product-lead",projectDir:"/tmp/geo",projectName:"geo",model:"bad\u0007model"}' > "$MANIFEST"
if ! generate_plist "$KEY" "$MANIFEST" v2 >/dev/null 2>&1; then
  AFTER_SHA=$(shasum -a 256 "$PLIST" | awk '{print $1}')
  if [ "$BEFORE_SHA" = "$AFTER_SHA" ]; then
    pass "D1: control-char model refused; existing plist byte-untouched"
  else
    fail "D1: control-char model refused but plist changed"
  fi
else
  fail "D1: control-char model should be refused"
fi

# ── E) lint failure → old plist untouched + no temp residue + non-zero ───
write_manifest '"ok-model"'
generate_plist "$KEY" "$MANIFEST" v2 >/dev/null
BEFORE_SHA=$(shasum -a 256 "$PLIST" | awk '{print $1}')
RC_FILE="$SANDBOX/plutil_rc"
echo 1 > "$RC_FILE"
export PLUTIL_STUB_RC_FILE="$RC_FILE"
write_manifest '"new-model-that-wont-land"'
if ! generate_plist "$KEY" "$MANIFEST" v2 >/dev/null 2>&1; then
  AFTER_SHA=$(shasum -a 256 "$PLIST" | awk '{print $1}')
  RESIDUE=$(find "$(dirname "$PLIST")" -name "*.tmp.*" | wc -l | tr -d ' ')
  if [ "$BEFORE_SHA" = "$AFTER_SHA" ] && [ "$RESIDUE" = "0" ]; then
    pass "E1: lint failure → non-zero + old plist intact + zero temp residue"
  else
    fail "E1: lint failure left changed plist or temp residue"
  fi
else
  fail "E1: lint failure should return non-zero"
fi
unset PLUTIL_STUB_RC_FILE

# ── F) staged split: source vs runtime manifest paths (R5#4) ─────────────
STAGED_MANIFEST="$SANDBOX/txn/staged/${KEY}.manifest.json"
STAGED_PLIST="$SANDBOX/txn/staged/${KEY}.plist"
mkdir -p "$(dirname "$STAGED_MANIFEST")"
jq -n '{leadId:"product-lead",projectDir:"/tmp/geo",projectName:"geo",model:"staged-model"}' > "$STAGED_MANIFEST"
generate_plist_to "$KEY" "$STAGED_MANIFEST" "$MANIFEST" "$STAGED_PLIST" >/dev/null
if grep -q "<string>staged-model</string>" "$STAGED_PLIST" \
  && grep -qF "<string>${MANIFEST}</string>" "$STAGED_PLIST" \
  && ! grep -qF "<string>${STAGED_MANIFEST}</string>" "$STAGED_PLIST"; then
  pass "F1: staged plist reads model from SOURCE but embeds RUNTIME/canonical manifest path"
else
  fail "F1: staged plist must embed the canonical manifest path, never the staged path"
fi

# FLY-2606: the registry backend owns mutable tuning, regardless of stale manifest claims.
printf '[{"projectName":"geo","leads":[{"agentId":"product-lead","summaryRole":"producer","backend":"codex-app-server"}]}]\n' > "$PROJECTS_JSON"
jq -n '{leadId:"product-lead",projectName:"geo",model:"old-model",effort:"low",
 leadBackend:{backendId:"claude-code"},
 launchEnvironment:{FLYWHEEL_LEAD_MODEL:"older-model",FLYWHEEL_LEAD_EFFORT:"medium",KEEP_ME:"preserved",FLYWHEEL_LEAD_MODEL_CONTEXT_WINDOW:"12345"}}' > "$MANIFEST"
if generate_plist_to "$KEY" "$MANIFEST" "$MANIFEST" "$PLIST" >/dev/null \
 && ! grep -q '<key>FLYWHEEL_LEAD_MODEL</key>\|<key>FLYWHEEL_LEAD_EFFORT</key>' "$PLIST" \
 && grep -q '<key>KEEP_ME</key><string>preserved</string>' "$PLIST" \
 && grep -q '<key>FLYWHEEL_LEAD_MODEL_CONTEXT_WINDOW</key><string>12345</string>' "$PLIST"; then
 pass "G1: canonical Codex drops both old tuning keys and preserves other environment"
else
 fail "G1: canonical Codex must omit old tuning keys"
fi
printf '[{"projectName":"geo","leads":[{"agentId":"product-lead","summaryRole":"producer","backend":"claude-code"}]}]\n' > "$PROJECTS_JSON"
jq '.leadBackend.backendId="codex-app-server"' "$MANIFEST" > "$SANDBOX/claude.json"
if generate_plist_to "$KEY" "$SANDBOX/claude.json" "$MANIFEST" "$PLIST" >/dev/null \
 && grep -q '<key>FLYWHEEL_LEAD_MODEL</key><string>old-model</string>' "$PLIST" \
 && grep -q '<key>FLYWHEEL_LEAD_EFFORT</key><string>low</string>' "$PLIST"; then
 pass "G2: canonical Claude retains tuning despite stale manifest backend"
else
 fail "G2: canonical Claude projection changed"
fi
BEFORE_SHA=$(shasum -a 256 "$PLIST" | awk '{print $1}')
printf '[]\n' > "$PROJECTS_JSON"
if ! generate_plist_to "$KEY" "$MANIFEST" "$MANIFEST" "$PLIST" >/dev/null 2>&1 \
 && [ "$BEFORE_SHA" = "$(shasum -a 256 "$PLIST" | awk '{print $1}')" ]; then
 pass "G3: unresolved identity refuses generation without changing prior plist"
else
 fail "G3: unresolved identity must not infer a backend"
fi

# Canonical identity compilation also validates summary assignments, but plist
# generation only needs the unique registry backend. A missing runtime Node,
# built comm CLI, summaryRole, or summary selection must not strand the fleet.
rm -f "$SANDBOX/.flywheel/summary-config.json"
printf '[{"projectName":"geo","leads":[{"agentId":"product-lead","backend":"codex-app-server"}]}]\n' > "$PROJECTS_JSON"
jq -n '{leadId:"product-lead",projectName:"geo",model:"stale-model",effort:"low"}' > "$MANIFEST"
if ( export FLYWHEEL_NODE_BIN="$SANDBOX/missing-node"
     export FLYWHEEL_COMM_CLI="$SANDBOX/missing-flywheel-comm.js"
     generate_plist_to "$KEY" "$MANIFEST" "$MANIFEST" "$PLIST" >/dev/null ) \
 && ! grep -q '<key>FLYWHEEL_LEAD_MODEL</key>\|<key>FLYWHEEL_LEAD_EFFORT</key>' "$PLIST"; then
 pass "G4: registry backend fallback survives missing Node/dist/summary metadata"
else
 fail "G4: missing Node/dist/summary metadata must not block plist generation"
fi
if generate_plist_to "$KEY" "$MANIFEST" "$MANIFEST" "$PLIST" >/dev/null \
 && ! grep -q '<key>FLYWHEEL_LEAD_MODEL</key>\|<key>FLYWHEEL_LEAD_EFFORT</key>' "$PLIST"; then
 pass "G5: summary validation failure falls back to the exact Codex registry backend"
else
 fail "G5: missing summary metadata must not block canonical backend projection"
fi
printf '[{"projectName":"geo","leads":[{"agentId":"product-lead","backend":"claude-code"}]}]\n' > "$PROJECTS_JSON"
if generate_plist_to "$KEY" "$MANIFEST" "$MANIFEST" "$PLIST" >/dev/null \
 && grep -q '<key>FLYWHEEL_LEAD_MODEL</key><string>stale-model</string>' "$PLIST" \
 && grep -q '<key>FLYWHEEL_LEAD_EFFORT</key><string>low</string>' "$PLIST"; then
 pass "G6: summary validation failure preserves the exact Claude registry backend"
else
 fail "G6: registry fallback must preserve Claude launch tuning"
fi

echo ""
echo "Results: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ] || exit 1
