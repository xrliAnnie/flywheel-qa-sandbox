#!/usr/bin/env bash
# FLY-1671: v2 carrier identity handoff and restart-wave body aggregation.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WRAPPER="$ROOT/scripts/flywheel-lead-wrapper-v2.sh"
BODY="$ROOT/packages/teamlead/scripts/lead-body.sh"
LEAD="$ROOT/packages/teamlead/scripts/claude-lead.sh"
RESTART="$ROOT/scripts/restart-services.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fly1671-provenance.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '[TEST] ok - %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '[TEST] FAIL - %s\n' "$1" >&2; }

# Run the real lead-body preamble against a tiny sourced claude-lead fixture.
mkdir -p "$TMP/body" "$TMP/project" "$TMP/home"
cp "$BODY" "$TMP/body/lead-body.sh"
cat > "$TMP/body/claude-lead.sh" <<'EOF'
printf 'CAPTURED=%s|%s\n' "${_FLYWHEEL_LEAD_CARRIER_PID_CAPTURED:-}" "${_FLYWHEEL_LEAD_CARRIER_START_CAPTURED:-}"
printf 'IDENTITY=%s|%s|%s|%s|%s|%s\n' \
  "${FLYWHEEL_LEAD_ID:-}" "${LEAD_ID:-}" \
  "${FLYWHEEL_PROJECT_NAME:-}" "${PROJECT_NAME:-}" \
  "${DISCORD_STATE_DIR:-}" "${DISCORD_BOT_TOKEN:-}"
EOF
cat > "$TMP/manifest.json" <<EOF
{"leadId":"ops-lead","projectDir":"$TMP/project","projectName":"demo"}
EOF
cat > "$TMP/home/.env" <<'EOF'
FLYWHEEL_LEAD_CARRIER_PID=999
FLYWHEEL_LEAD_CARRIER_START=poisoned-by-env
FLYWHEEL_LEAD_ID=foreign-lead
LEAD_ID=foreign-lead
FLYWHEEL_PROJECT_NAME=foreign-project
PROJECT_NAME=foreign-project
DISCORD_STATE_DIR=/tmp/foreign-state
DISCORD_BOT_TOKEN=wrong-global-token
EOF
out="$(HOME="$TMP/home" FLYWHEEL_STATE_DIR="$TMP/home" FLYWHEEL_WRAPPER_ENV_FILE="$TMP/home/.env" \
  FLYWHEEL_LEAD_CARRIER_PID=123 FLYWHEEL_LEAD_CARRIER_START=trusted-start \
  FLYWHEEL_LEAD_ID=ops-lead LEAD_ID=ops-lead \
  FLYWHEEL_PROJECT_NAME=demo PROJECT_NAME=demo \
  DISCORD_STATE_DIR="$TMP/discord-state" DISCORD_BOT_TOKEN=canonical-token \
  bash "$TMP/body/lead-body.sh" "$TMP/manifest.json" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] \
    && grep -q '^CAPTURED=123|trusted-start$' <<<"$out" \
    && grep -qF "IDENTITY=ops-lead|ops-lead|demo|demo|$TMP/discord-state|canonical-token" <<<"$out"; then
  pass "lead-body restores carrier and canonical identity after loading .env"
else
  fail "lead-body identity capture drifted (rc=$rc out=$out)"
fi

printf '%s\n' 'FLYWHEEL_PROJECTS=[{"projectName":"foreign"}]' >> "$TMP/home/.env"
out="$(HOME="$TMP/home" FLYWHEEL_STATE_DIR="$TMP/home" FLYWHEEL_WRAPPER_ENV_FILE="$TMP/home/.env" \
  FLYWHEEL_LEAD_ID=ops-lead LEAD_ID=ops-lead \
  FLYWHEEL_PROJECT_NAME=demo PROJECT_NAME=demo \
  FLYWHEEL_PROJECTS_FILE="$TMP/projects.json" \
  DISCORD_STATE_DIR="$TMP/discord-state" DISCORD_BOT_TOKEN=canonical-token \
  bash "$TMP/body/lead-body.sh" "$TMP/manifest.json" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] \
    && grep -q 'identity_env_source_forbidden.*FLYWHEEL_PROJECTS' <<<"$out" \
    && ! grep -q '^IDENTITY=' <<<"$out"; then
  pass "lead-body rejects an inline registry injected by .env before child projection"
else
  fail "lead-body accepted an inline registry from .env (rc=$rc out=$out)"
fi

out="$(HOME="$TMP/home" FLYWHEEL_STATE_DIR="$TMP/home" FLYWHEEL_WRAPPER_ENV_FILE=/dev/null \
  FLYWHEEL_LEAD_CARRIER_PID=bad FLYWHEEL_LEAD_CARRIER_START=bad \
  DISCORD_BOT_TOKEN=canonical-token \
  bash "$TMP/body/lead-body.sh" "$TMP/manifest.json" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && grep -q '^CAPTURED=|$' <<<"$out"; then
  pass "malformed handoff tuple degrades to unknown"
else
  fail "malformed handoff tuple was trusted (rc=$rc out=$out)"
fi

# An explicitly empty v2 handoff must stay invalid; it must not become a
# plausible but incorrect carrier identity.
HELPER="$TMP/evidence-helper.sh"
awk '
  /^record_lead_body_evidence_best_effort\(\)/,/^}/ { print; next }
' "$LEAD" > "$HELPER"
if grep -q 'record_lead_body_evidence_best_effort()' "$HELPER"; then
  # shellcheck source=/dev/null
  source "$HELPER"
  PROJECT_NAME=demo
  LEAD_ID=ops-lead
  CAPTURE="$TMP/helper.calls"
  lbe_record() { printf '%s\t%s\n' "$6" "$7" >> "$CAPTURE"; return 0; }
  : > "$CAPTURE"
  record_lead_body_evidence_best_effort launched 201 body-start "" ""
  explicit="$(sed -n '1p' "$CAPTURE")"
  if [ "$explicit" = $'\t' ]; then
    pass "malformed v2 tuple stays unknown"
  else
    fail "evidence helper invented a carrier tuple (explicit=$explicit)"
  fi

  unset -f lbe_record
  export LEAD_BODY_EVIDENCE_DIR="$TMP/evidence"
  # shellcheck source=/dev/null
  source "$ROOT/scripts/lib/lead-body-evidence.sh"
  carrier_pid=$(( $$ + 100000 ))
  record_lead_body_evidence_best_effort launched "$$" body-start "$carrier_pid" carrier-start
  if [ "$$" != "$carrier_pid" ] \
    && [ "$(lbe_read_matching demo ops-lead "$carrier_pid" carrier-start)" = launched ] \
    && [ -z "$(lbe_read_matching demo ops-lead "$$" body-start 2>/dev/null || true)" ]; then
    pass "body PID differs from carrier PID and evidence still matches only the verified carrier tuple"
  else
    fail "v2 evidence was not bound exclusively to its passed carrier tuple"
  fi

else
  fail "body evidence helper could not be extracted"
fi

FUNCS="$TMP/restart-functions.sh"
awk '
  /^summarize_lead_body_observations\(\)/,/^}/ { print; next }
' "$RESTART" > "$FUNCS"
if ! grep -q 'summarize_lead_body_observations()' "$FUNCS"; then
  fail "restart body observation aggregator exists"
else
  cat > "$TMP/observations.tsv" <<'EOF'
demo-a	demo	a	101	start-a
demo-b	demo	b	102	start-b
demo-c	demo	c	103	start-c
EOF
  # shellcheck source=/dev/null
  source "$FUNCS"
  lbe_read_matching() {
    case "$2" in a) printf 'launched\n' ;; b) printf 'adopted\n' ;; *) return 1 ;; esac
  }
  LEAD_BODY_EVIDENCE_WAIT_SECONDS=0
  counts="$(summarize_lead_body_observations "$TMP/observations.tsv")"
  if [ "$counts" = $'1\t1\t1' ]; then
    pass "restart aggregation counts launched/adopted/unknown without changing verdicts"
  else
    fail "restart aggregation counts wrong: $counts"
  fi
fi

printf 'Results: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
