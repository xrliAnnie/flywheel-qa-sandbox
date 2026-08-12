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
EOF
cat > "$TMP/manifest.json" <<EOF
{"leadId":"ops-lead","projectDir":"$TMP/project","projectName":"demo","botTokenEnv":"OPS_TOKEN"}
EOF
cat > "$TMP/home/.env" <<'EOF'
FLYWHEEL_LEAD_CARRIER_PID=999
FLYWHEEL_LEAD_CARRIER_START=poisoned-by-env
OPS_TOKEN=stub
EOF
out="$(HOME="$TMP/home" FLYWHEEL_STATE_DIR="$TMP/home" FLYWHEEL_WRAPPER_ENV_FILE="$TMP/home/.env" \
  FLYWHEEL_LEAD_CARRIER_PID=123 FLYWHEEL_LEAD_CARRIER_START=trusted-start \
  bash "$TMP/body/lead-body.sh" "$TMP/manifest.json" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && grep -q '^CAPTURED=123|trusted-start$' <<<"$out"; then
  pass "lead-body captures carrier tuple before .env can overwrite public handoff vars"
else
  fail "lead-body carrier capture drifted (rc=$rc out=$out)"
fi

out="$(HOME="$TMP/home" FLYWHEEL_STATE_DIR="$TMP/home" FLYWHEEL_WRAPPER_ENV_FILE=/dev/null \
  FLYWHEEL_LEAD_CARRIER_PID=bad FLYWHEEL_LEAD_CARRIER_START=bad \
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
