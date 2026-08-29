#!/usr/bin/env bash
# FLY-529: hermetic test for scripts/lead-alert.sh alert-dir env overrides.
#
# The QA Testing Room must isolate the SHELL-side alert writer too (not just
# the Bridge): claude-lead.sh invokes lead-alert.sh on Lead crash, so a test
# Lead failure must NOT drop queue / dead-letter files into the production
# ~/.flywheel/alert-queue|alert-deadletter dirs that the live Bridge drains.
#
# This test shims curl + osascript via PATH (no network, no desktop popup),
# points claims.db + projects + state at a temp HOME, and asserts:
#   - FLYWHEEL_ALERT_QUEUE_DIR     redirects the transient-failure queue file
#   - FLYWHEEL_ALERT_DEADLETTER_DIR redirects the permanent dead-letter file
#   - UNSET env keeps the production-default paths under $HOME (byte-compat)
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LEAD_ALERT="${SCRIPT_DIR}/../lead-alert.sh"
[[ -f "$LEAD_ALERT" ]] || { echo "[TEST] ✗ lead-alert.sh not found: $LEAD_ALERT"; exit 1; }

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/lead-alert-dirs.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

# ── Fake bin: curl (no network) + osascript (no popup) ──────────────────────
FAKEBIN="${ROOT}/bin"
mkdir -p "$FAKEBIN"
cat > "${FAKEBIN}/curl" <<'EOF'
#!/usr/bin/env bash
# Honor lead-alert.sh's `-o <file>` so the later `cat` finds an (empty) body,
# then emit the HTTP code from FAKE_HTTP_CODE (default 000 = transient).
out=""
prev=""
for a in "$@"; do
  [[ "$prev" == "-o" ]] && out="$a"
  prev="$a"
done
[[ -n "$out" ]] && : > "$out"
printf '%s' "${FAKE_HTTP_CODE:-000}"
EOF
cat > "${FAKEBIN}/osascript" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "${FAKEBIN}/curl" "${FAKEBIN}/osascript"

export FAKE_BOT_TOKEN="bot-token-for-test"

# Build a slot-local projects file. $1=path $2=alertChannel("" => none).
write_projects() {
  local path="$1" channel="$2"
  jq -n --arg ch "$channel" '
    [ { projectName: "test-proj",
        generalChannel: "",
        leads: [ { agentId: "test-lead",
                   alertChannel: $ch,
                   alertBotTokenEnv: "FAKE_BOT_TOKEN",
                   alertFallbackToCore: false,
                   botTokenEnv: "FAKE_BOT_TOKEN" } ] } ]
  ' > "$path"
}

# Run lead-alert.sh in a hermetic env. Extra `KEY=VAL` env pairs via args.
run_alert() {
  local home="$1"; shift
  env -i \
    HOME="$home" \
    PATH="${FAKEBIN}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin" \
    FAKE_BOT_TOKEN="$FAKE_BOT_TOKEN" \
    FLYWHEEL_CLAIMS_DB="${home}/claims.db" \
    FLYWHEEL_STATE_DIR="${home}/state" \
    FLYWHEEL_PROJECTS_FILE="${home}/projects.json" \
    "$@" \
    bash "$LEAD_ALERT" \
      --lead test-lead --project test-proj --kind rate_limit \
      --severity warning --title "T" --body "B" >/dev/null 2>&1
}

count_json() { find "$1" -name '*.json' 2>/dev/null | wc -l | tr -d ' '; }

# ── Case 1: queue dir override (transient 000 → enqueue) ────────────────────
H1="${ROOT}/h1"; mkdir -p "$H1"; write_projects "${H1}/projects.json" "999000111"
run_alert "$H1" FAKE_HTTP_CODE=000 FLYWHEEL_ALERT_QUEUE_DIR="${H1}/custom-queue"
if [[ "$(count_json "${H1}/custom-queue")" == "1" && "$(count_json "${H1}/.flywheel/alert-queue")" == "0" ]]; then
  pass "queue override: file in FLYWHEEL_ALERT_QUEUE_DIR, none in default"
else
  fail "queue override: custom=$(count_json "${H1}/custom-queue") default=$(count_json "${H1}/.flywheel/alert-queue")"
fi

# ── Case 2: queue dir default (byte-compat, no override env) ─────────────────
H2="${ROOT}/h2"; mkdir -p "$H2"; write_projects "${H2}/projects.json" "999000111"
run_alert "$H2" FAKE_HTTP_CODE=000
if [[ "$(count_json "${H2}/.flywheel/alert-queue")" == "1" ]]; then
  pass "queue default: file under \$HOME/.flywheel/alert-queue (byte-compat)"
else
  fail "queue default: expected 1 file under \$HOME/.flywheel/alert-queue, got $(count_json "${H2}/.flywheel/alert-queue")"
fi

# ── Case 3: dead-letter dir override (no-channel → dead_letter) ──────────────
H3="${ROOT}/h3"; mkdir -p "$H3"; write_projects "${H3}/projects.json" ""
run_alert "$H3" FLYWHEEL_ALERT_DEADLETTER_DIR="${H3}/custom-dl"
if [[ "$(count_json "${H3}/custom-dl")" == "1" && "$(count_json "${H3}/.flywheel/alert-deadletter")" == "0" ]]; then
  pass "dead-letter override: file in FLYWHEEL_ALERT_DEADLETTER_DIR, none in default"
else
  fail "dead-letter override: custom=$(count_json "${H3}/custom-dl") default=$(count_json "${H3}/.flywheel/alert-deadletter")"
fi

# ── Case 4: dead-letter dir default (byte-compat) ───────────────────────────
H4="${ROOT}/h4"; mkdir -p "$H4"; write_projects "${H4}/projects.json" ""
run_alert "$H4"
if [[ "$(count_json "${H4}/.flywheel/alert-deadletter")" == "1" ]]; then
  pass "dead-letter default: file under \$HOME/.flywheel/alert-deadletter (byte-compat)"
else
  fail "dead-letter default: expected 1 file under \$HOME/.flywheel/alert-deadletter, got $(count_json "${H4}/.flywheel/alert-deadletter")"
fi

echo
echo "[TEST] lead-alert-dirs: ${PASSED} passed, ${FAILED} failed"
[[ "$FAILED" -eq 0 ]]
