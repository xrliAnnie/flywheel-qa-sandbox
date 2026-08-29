#!/bin/bash
# FLY-1023 M7 (added in QA / FLY-1023 verification): a FOCUSED unit test for
# the shared stuck→human-handoff summary generator, scripts/lib/buddy-escalate.sh.
#
# Why this exists: the escalation library is otherwise only exercised
# indirectly, through the Buddy shell's happy-ish ladder (flywheel-buddy
# D5). Nothing asserted the RED-LINE that makes this library load-bearing —
# that a credential a stuck customer pasted into an error message must NEVER
# reach the support summary. A leak here is a security incident, so it gets
# its own test at the library boundary.
#
# Hermetic: temp $HOME + temp state dir, real fleet-sanitize.sh scanner, no
# network, real ~/.flywheel never touched.
#
# Covers (buddy-escalate.sh contract):
#   BE1  secret in the HINT → replaced by the generic "withheld" line;
#        the raw secret is absent AND the assembled summary scans clean;
#        locating info (where/error_code/cursor/doneSteps) is preserved;
#        journal buddy.escalated flips true.
#   BE2  a clean hint passes through verbatim (no over-redaction).
#   BE3  belt-over-braces (FAIL-CLOSED): a secret smuggled through a NON-hint
#        field (where) — which the per-hint scan never sees — is caught by the
#        assembled scan; since only the hint can be rewritten, the generator
#        REFUSES to emit rather than leak: return 1, no summary file, no leak.
#        (In practice where/error_code are internal step ids/codes, never user
#        free text — only the hint carries pasted text — so this belt is a
#        defensive backstop, and refusing beats leaking.)
#   BE4  usage error (missing required args) → return 1, no file written.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ESC_LIB="$REPO_ROOT/scripts/lib/buddy-escalate.sh"
SANITIZE="$REPO_ROOT/scripts/lib/fleet-sanitize.sh"
[ -f "$ESC_LIB" ] || { echo "ERROR: $ESC_LIB missing"; exit 1; }

SANDBOX="$(mktemp -d -t fly1023-escalate-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

# A realistic vendor credential (github PAT shape) that the scanner flags.
SECRET="ghp_ABCDEF0123456789abcdef0123456789ABCDxyz9"

scan_clean() { bash -c "source '$SANITIZE'; scan_for_secrets '$1'" >/dev/null 2>&1; }

# ── BE1: secret in the hint is scrubbed; locating info kept; flag flips ──
SD1="$SANDBOX/be1/.flywheel"; mkdir -p "$SD1"
cat > "$SD1/setup-state.json" <<'JSON'
{"version":2,"steps":{"preflight":{"status":"done"},"skeleton":{"status":"done"},"bots":{"status":"pending"}},"buddy":{"cursor":4}}
JSON
chmod 600 "$SD1/setup-state.json"
OUT1="$(HOME="$SANDBOX/be1" bash -c "source '$ESC_LIB'; buddy_escalate '$SD1' bots auth_failed 'login died with token $SECRET'" 2>/dev/null)"
RC1=$?
if [ "$RC1" -eq 0 ] && [ -f "$OUT1" ] \
   && ! grep -q "$SECRET" "$OUT1" \
   && scan_clean "$OUT1" \
   && [ "$(jq -r '.hint' "$OUT1")" = "(details withheld — the original message looked like it contained a credential)" ] \
   && [ "$(jq -r '.where' "$OUT1")" = "bots" ] \
   && [ "$(jq -r '.error_code' "$OUT1")" = "auth_failed" ] \
   && [ "$(jq -r '.cursor' "$OUT1")" = "4" ] \
   && [ "$(jq -c '.doneSteps' "$OUT1")" = '["preflight","skeleton"]' ] \
   && [ "$(jq -r '.buddy.escalated' "$SD1/setup-state.json")" = "true" ]; then
  pass "BE1 hint secret scrubbed; summary clean; locating info kept; escalated flag set"
else
  fail "BE1 rc=$RC1 out=$OUT1 hint=$(jq -r '.hint' "$OUT1" 2>/dev/null) esc=$(jq -r '.buddy.escalated' "$SD1/setup-state.json" 2>/dev/null)"
fi

# ── BE2: a clean hint survives verbatim ──
SD2="$SANDBOX/be2/.flywheel"; mkdir -p "$SD2"
printf '{"version":2,"steps":{},"buddy":{}}\n' > "$SD2/setup-state.json"; chmod 600 "$SD2/setup-state.json"
CLEAN_HINT="the workspace API was busy — safe to retry in a minute"
OUT2="$(HOME="$SANDBOX/be2" bash -c "source '$ESC_LIB'; buddy_escalate '$SD2' linear rate_limited '$CLEAN_HINT'" 2>/dev/null)"
if [ -f "$OUT2" ] && [ "$(jq -r '.hint' "$OUT2")" = "$CLEAN_HINT" ]; then
  pass "BE2 clean hint passes through verbatim (no over-redaction)"
else
  fail "BE2 hint='$(jq -r '.hint' "$OUT2" 2>/dev/null)'"
fi

# ── BE3: belt — a secret in a NON-hint field makes the generator FAIL CLOSED ──
SD3="$SANDBOX/be3/.flywheel"; mkdir -p "$SD3"
printf '{"version":2,"steps":{},"buddy":{}}\n' > "$SD3/setup-state.json"; chmod 600 "$SD3/setup-state.json"
# 'where' is not individually scanned; the assembled belt catches it but can
# only rewrite the hint — so the generator refuses (return 1) rather than leak.
OUT3="$(HOME="$SANDBOX/be3" bash -c "source '$ESC_LIB'; buddy_escalate '$SD3' 'step-$SECRET' some_error 'a perfectly clean hint'" 2>/dev/null)"
RC3=$?
LEAK3="$(grep -rl "$SECRET" "$SANDBOX/be3" 2>/dev/null)"
if [ "$RC3" -eq 1 ] && [ -z "$(ls "$SD3"/support-summary-*.json 2>/dev/null)" ] && [ -z "$LEAK3" ]; then
  pass "BE3 belt fail-closed: secret in non-hint field → return 1, no summary, no leak"
else
  fail "BE3 rc=$RC3 files=$(ls "$SD3"/support-summary-*.json 2>/dev/null) leak=$LEAK3"
fi

# ── BE4: usage error → return 1, nothing written ──
SD4="$SANDBOX/be4/.flywheel"; mkdir -p "$SD4"
HOME="$SANDBOX/be4" bash -c "source '$ESC_LIB'; buddy_escalate '$SD4'" >/dev/null 2>&1
RC4=$?
if [ "$RC4" -eq 1 ] && [ -z "$(ls "$SD4"/support-summary-*.json 2>/dev/null)" ]; then
  pass "BE4 missing args → return 1, no summary written"
else
  fail "BE4 rc=$RC4 files=$(ls "$SD4"/support-summary-*.json 2>/dev/null)"
fi

echo ""
echo "buddy-escalate.test: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
