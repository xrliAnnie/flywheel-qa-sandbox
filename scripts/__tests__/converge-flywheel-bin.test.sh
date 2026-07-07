#!/bin/bash
# FLY-954: converge-flywheel-bin.sh — checksum+mode-converge <state>/bin
# runtime scripts to repo sources; repair + alert on drift; NEVER repair from
# an insane repo source. Hermetic: sandbox STATE_DIR + fake repo (the REAL
# converge script is COPIED into the fake repo and invoked there, so its
# self-derived SCRIPT_DIR/.. repo root points at the fake repo — no env seam
# for repair provenance, Codex R2#1) + stub alert sink (notification-only
# seam FLYWHEEL_CONVERGE_ALERT_BIN).
set -uo pipefail
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }

REAL_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SB="$(mktemp -d -t fly954-converge-XXXXXX)"; trap 'rm -rf "$SB"' EXIT

# fake repo with sane sources + the REAL converge script + the REAL lib
FR="$SB/repo"; mkdir -p "$FR/scripts/lib"
cp "$REAL_REPO_ROOT/scripts/lib/script-sanity.sh" "$FR/scripts/lib/"
cp "$REAL_REPO_ROOT/scripts/converge-flywheel-bin.sh" "$FR/scripts/"
CONVERGE="$FR/scripts/converge-flywheel-bin.sh"
for f in flywheel-lead-wrapper.sh flywheel-bridge-wrapper.sh restart-services.sh; do
  { echo '#!/bin/bash'; i=1; while [ "$i" -le 80 ]; do echo "echo repo-$f-$i >/dev/null"; i=$((i+1)); done; } > "$FR/scripts/$f"
done
# stub alert sink (records invocations)
ALERT="$SB/alert.sh"
cat > "$ALERT" <<'EOF'
#!/bin/bash
echo "ALERT $*" >> "${ALERT_LOG:?}"
exit 0
EOF
chmod +x "$ALERT"

ST="$SB/state"; mkdir -p "$ST/bin"
run_converge() {
  ALERT_LOG="$SB/alerts.log" FLYWHEEL_STATE_DIR="$ST" \
  FLYWHEEL_CONVERGE_ALERT_BIN="$ALERT" \
    bash "$CONVERGE" >"$SB/out.log" 2>&1
}

# C1: drifted (the incident stub) → repaired + one alert
: > "$SB/alerts.log"
echo '#!/bin/bash' > "$ST/bin/flywheel-lead-wrapper.sh"
cp "$FR/scripts/flywheel-bridge-wrapper.sh" "$ST/bin/flywheel-bridge-wrapper.sh"
cp "$FR/scripts/restart-services.sh" "$ST/bin/restart-services.sh"
run_converge; RC=$?
if [ "$RC" -eq 0 ] \
   && cmp -s "$ST/bin/flywheel-lead-wrapper.sh" "$FR/scripts/flywheel-lead-wrapper.sh" \
   && [ ! -w "$ST/bin/flywheel-lead-wrapper.sh" ] \
   && [ "$(grep -c '^ALERT' "$SB/alerts.log")" -eq 1 ] \
   && grep -q 'bin_integrity_drift' "$SB/alerts.log"; then
  pass "C1: stub drift repaired to repo source (555) + exactly one alert"
else fail "C1: repair (rc=$RC)"; cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null; fi

# C2: converged state → silent no-op (no alert, exit 0)
: > "$SB/alerts.log"
run_converge; RC=$?
if [ "$RC" -eq 0 ] && [ ! -s "$SB/alerts.log" ]; then
  pass "C2: converged → silent no-op"
else fail "C2: no-op (rc=$RC)"; cat "$SB/alerts.log"; fi

# C3: missing bin file → repaired
: > "$SB/alerts.log"
rm -f "$ST/bin/restart-services.sh"
run_converge; RC=$?
if [ "$RC" -eq 0 ] && cmp -s "$ST/bin/restart-services.sh" "$FR/scripts/restart-services.sh"; then
  pass "C3: missing bin file re-installed"
else fail "C3: missing repair (rc=$RC)"; fi

# C5 (Codex R1#1): content matches but mode 644 → converge tightens to 555, silently
: > "$SB/alerts.log"
chmod 644 "$ST/bin/flywheel-lead-wrapper.sh"
run_converge; RC=$?
if [ "$RC" -eq 0 ] && [ ! -w "$ST/bin/flywheel-lead-wrapper.sh" ] && [ ! -s "$SB/alerts.log" ]; then
  pass "C5: mode-only drift tightened to 555, no alert"
else fail "C5: mode convergence (rc=$RC)"; ls -l "$ST/bin"; cat "$SB/alerts.log" 2>/dev/null; fi

# C4: drift + INSANE repo source → alert, NOT repaired, exit non-zero
: > "$SB/alerts.log"
echo '#!/bin/bash' > "$FR/scripts/flywheel-bridge-wrapper.sh"     # repo side goes bad
chmod u+w "$ST/bin/flywheel-bridge-wrapper.sh" 2>/dev/null || true
echo 'echo drifted' >> "$ST/bin/flywheel-bridge-wrapper.sh"       # force drift
run_converge; RC=$?
if [ "$RC" -ne 0 ] && grep -q 'drifted' "$ST/bin/flywheel-bridge-wrapper.sh" \
   && grep -q 'insane' "$SB/alerts.log"; then
  pass "C4: insane repo source → alert only, bin untouched, non-zero exit"
else fail "C4: fail-safe (rc=$RC)"; cat "$SB/out.log" "$SB/alerts.log" 2>/dev/null; fi

echo ""; echo "Results: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ] || exit 1
