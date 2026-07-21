#!/bin/bash
# FLY-1402 QA — independent reproduction of the decisive sentinel experiment.
# The issue proved the CLI is last-one-wins; this proves the FIX concatenates:
# two files, each with a UNIQUE sentinel, must BOTH survive the bundle path.
# Also exercises the truth checker with genuine positive+negative controls
# (a guard that never rejects is decoration — every guard is proven to bite).
#
# NOTE on harness discipline: checker invocations are captured into a variable
# WITHOUT a pipe, then grep'd — a `node ... | grep` pipeline under `pipefail`
# reports node's non-zero exit, not grep's match (the trap that produced a false
# "3 failed" in an earlier draft of this harness).
set -u

REPO="/Users/xiaorongli/Dev/flywheel-FLY-1402"
LIB="${REPO}/packages/teamlead/scripts/lead-rules-bundle.sh"
CHECK="${REPO}/packages/teamlead/scripts/check-rules-truth.mjs"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   - %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL - %s\n' "$1"; }

# Two distinct rule sources. The FIRST is named department-lead-rules.md so the
# concatenated bundle also satisfies the dept role invariant (lets the checker
# positive control run); each carries a UNIQUE sentinel (issue's ALPHA/BETA).
ALPHA="${WORK}/department-lead-rules.md"; BETA="${WORK}/executor-routing.md"
printf 'ALPHA_UNIQUE_SENTINEL_2f9a1\nFLY-162 Reply Discipline sample\n' > "$ALPHA"
printf 'BETA_UNIQUE_SENTINEL_c7e40\nexecutor routing body' > "$BETA"   # no trailing newline (edge case)

# shellcheck source=/dev/null
source "$LIB"
RULES_BUNDLE_MODE="bundle"
rules_bundle_reset
rules_bundle_add "$ALPHA" base
rules_bundle_add "$BETA" base

OUT="${WORK}/bundle.md"
RESULT="$(rules_bundle_materialize "$OUT" dept flywheel-eng-lead flywheel)"

# 1. stdout purity — captured value is exactly the path, nothing else.
[ "$RESULT" = "$OUT" ] && ok "materialize stdout is exactly the bundle path (no diagnostics leaked)" \
  || bad "stdout not clean: got '$RESULT'"

# 2. THE decisive assertion: both sentinels present (CLI last-one-wins would drop ALPHA).
grep -q "ALPHA_UNIQUE_SENTINEL_2f9a1" "$OUT" && ok "ALPHA sentinel (first file) survived — last-one-wins defeated" \
  || bad "ALPHA sentinel MISSING — regression to last-one-wins"
grep -q "BETA_UNIQUE_SENTINEL_c7e40" "$OUT" && ok "BETA sentinel (last file) survived" \
  || bad "BETA sentinel MISSING"

# 3. Order: ALPHA before BETA.
a_line="$(grep -n ALPHA_UNIQUE_SENTINEL_2f9a1 "$OUT" | head -1 | cut -d: -f1)"
b_line="$(grep -n BETA_UNIQUE_SENTINEL_c7e40 "$OUT" | head -1 | cut -d: -f1)"
[ "$a_line" -lt "$b_line" ] && ok "ALPHA precedes BETA in the bundle body" \
  || bad "order wrong: alpha@${a_line} beta@${b_line}"

# 4. Sentinel header: FILES=2, 64-hex SHA, 2 verbatim sections in order.
grep -q "^RULES_BUNDLE_SHA=[a-f0-9]\{64\} FILES=2$" "$OUT" && ok "header sentinel: 64-hex SHA + FILES=2" \
  || bad "header sentinel malformed"
[ "$(grep -c '═══ RULE SOURCE \[' "$OUT")" = "2" ] && ok "exactly 2 verbatim rule sections" \
  || bad "wrong section count"

# 5. Independent SHA recompute: body SHA must match the header sentinel.
body_off="$(grep -abo '═══ RULE SOURCE \[' "$OUT" | head -1 | cut -d: -f1)"
declared="$(sed -n 's/^RULES_BUNDLE_SHA=\([a-f0-9]*\) FILES=.*/\1/p' "$OUT" | head -1)"
actual="$(tail -c +$((body_off+1)) "$OUT" | shasum -a 256 | awk '{print $1}')"
[ "$declared" = "$actual" ] && ok "independently recomputed body SHA matches header sentinel" \
  || bad "SHA mismatch declared=$declared actual=$actual"

# --- Truth checker: positive control + two negative controls (no pipe; capture then grep) ---
# 6. POSITIVE: a dept-shaped bundle is accepted.
out6="$(node "$CHECK" --bundle-file "$OUT" --expect-role dept 2>&1)"; rc6=$?
{ [ $rc6 -eq 0 ] && printf '%s' "$out6" | grep -q '^PASS'; } \
  && ok "checker POSITIVE: dept-shaped bundle => PASS (exit 0)" \
  || bad "checker rejected a valid dept bundle: $out6"

# 7. NEGATIVE (SHA): tamper one body byte => must FAIL.
TAMPER="${WORK}/tamper.md"; cp "$OUT" "$TAMPER"; printf 'X' >> "$TAMPER"
out7="$(node "$CHECK" --bundle-file "$TAMPER" --expect-role dept 2>&1)"; rc7=$?
{ [ $rc7 -ne 0 ] && printf '%s' "$out7" | grep -q 'SHA mismatch'; } \
  && ok "checker NEGATIVE(SHA): tampered body => FAIL on SHA mismatch (guard bites)" \
  || bad "tampered body did NOT fail on SHA: rc=$rc7 $out7"

# 8. NEGATIVE (role): same bundle verified as cos => must FAIL on role.
out8="$(node "$CHECK" --bundle-file "$OUT" --expect-role cos 2>&1)"; rc8=$?
{ [ $rc8 -ne 0 ] && printf '%s' "$out8" | grep -q 'role mismatch'; } \
  && ok "checker NEGATIVE(role): dept bundle vs expect-cos => FAIL on role (guard bites)" \
  || bad "role mismatch did NOT fail: rc=$rc8 $out8"

echo ""
echo "QA sentinel reproduction: ${PASS} passed, ${FAIL} failed"
[ "$FAIL" -eq 0 ]
