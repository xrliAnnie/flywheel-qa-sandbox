#!/usr/bin/env bash
# FLY-1189 H3 (driver): hermetic tests for qa-fly-1189-nton-driver.sh.
# The driver is the TRAP OWNER (plan §A): the injector deliberately registers
# no EXIT trap, so the DRIVER must register an idempotent EXIT/INT/TERM trap
# BEFORE any mutation and call `recover-from-journal` on death — otherwise a
# killed driver leaves a real runner frozen. That recovery wiring is the one
# behavior we can prove with a real signal + a stub injector (no real runner).
#
#   G1  --campaign-root is REQUIRED (evidence must land outside SLOT_DIR)
#   G2  --scenario is REQUIRED; unknown scenario id → non-zero
#   G3  driver registers an EXIT/INT/TERM trap that calls recover-from-journal
#   G4  a killed driver (SIGINT mid-scenario) actually invokes the injector's
#       recover-from-journal (real signal, stubbed injector records the call)
#   G5  wiring sentinels: driver sources the assert lib + drives the injector
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRIVER="${SCRIPT_DIR}/qa-fly-1189-nton-driver.sh"

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

[[ -f "$DRIVER" ]] || { echo "FATAL: ${DRIVER} missing — implement it first" >&2; exit 1; }

TMP="$(mktemp -d "/tmp/qa1189drv.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
CAMPAIGN="${TMP}/campaign"
mkdir -p "$CAMPAIGN"

# Stub injector: records each invocation (subcommand) to a log, and for the
# scenario-blocking subcommand sleeps so we can SIGINT the driver mid-run.
STUB="${TMP}/stub-injector.sh"
CALLS="${TMP}/injector-calls.log"
cat > "$STUB" <<STUBEOF
#!/usr/bin/env bash
echo "\$@" >> "${CALLS}"
case "\$1" in
  # The blocking op the test scenario runs first — sleep so the harness can
  # signal the driver while it is "mid-scenario".
  freeze) sleep 20 ;;
  *) : ;;
esac
exit 0
STUBEOF
chmod +x "$STUB"

run_driver() {
  QA1189_INJECTOR="$STUB" \
  QA1189_CAMPAIGN_ROOT="$CAMPAIGN" \
  QA1189_SLOT_DIR="${TMP}/flywheel-test-slot-2" \
  QA1189_MANIFEST="${TMP}/manifest.json" \
  QA1189_JOURNAL="${TMP}/journal.jsonl" \
    bash "$DRIVER" "$@"
}

# ── G1: --campaign-root required ──
: > "$CALLS"
if QA1189_INJECTOR="$STUB" bash "$DRIVER" --scenario selftest >/dev/null 2>&1; then
  fail "G1: missing --campaign-root should exit non-zero"
else
  pass "G1: --campaign-root is required"
fi

# ── G2: --scenario required + unknown scenario rejected ──
G2_OK=1
if run_driver --campaign-root "$CAMPAIGN" >/dev/null 2>&1; then
  G2_OK=0; fail "G2: missing --scenario should exit non-zero"
fi
if run_driver --campaign-root "$CAMPAIGN" --scenario no-such-scenario >/dev/null 2>&1; then
  G2_OK=0; fail "G2: unknown scenario id should exit non-zero"
fi
[[ "$G2_OK" == "1" ]] && pass "G2: --scenario required + unknown scenario rejected"

# ── G3: trap registration present (static) ──
if grep -Eq "trap[[:space:]].*(EXIT|INT|TERM)" "$DRIVER" \
   && grep -q "recover-from-journal" "$DRIVER"; then
  pass "G3: driver registers EXIT/INT/TERM trap wired to recover-from-journal"
else
  fail "G3: driver must register a trap that calls recover-from-journal"
fi

# ── G4: SIGINT mid-scenario actually triggers recover-from-journal ──
# The 'selftest' scenario must: register the trap, call the injector's blocking
# op (freeze), i.e. be interruptible. We SIGINT it and assert the stub recorded
# a recover-from-journal call.
: > "$CALLS"
run_driver --campaign-root "$CAMPAIGN" --scenario selftest >/dev/null 2>&1 &
DRV_PID=$!
# Wait until the driver has entered the blocking freeze (up to 10s).
waited=0
while ! grep -q "^freeze" "$CALLS" 2>/dev/null && (( waited < 100 )); do
  sleep 0.1; waited=$((waited + 1))
done
if grep -q "^freeze" "$CALLS" 2>/dev/null; then
  kill -INT "$DRV_PID" 2>/dev/null
  wait "$DRV_PID" 2>/dev/null
  # Give the trap a beat to run the recovery.
  waited=0
  while ! grep -q "recover-from-journal" "$CALLS" 2>/dev/null && (( waited < 50 )); do
    sleep 0.1; waited=$((waited + 1))
  done
  if grep -q "recover-from-journal" "$CALLS" 2>/dev/null; then
    pass "G4: SIGINT mid-scenario → driver trap called recover-from-journal"
  else
    fail "G4: driver died without calling recover-from-journal (calls: $(tr '\n' ';' < "$CALLS"))"
  fi
else
  kill -KILL "$DRV_PID" 2>/dev/null || true
  wait "$DRV_PID" 2>/dev/null || true
  fail "G4: selftest scenario never reached the blocking freeze op"
fi

# ── G5: wiring sentinels ──
G5_OK=1
bash -n "$DRIVER" 2>/dev/null || { G5_OK=0; fail "G5: driver has syntax errors"; }
grep -q "qa-fly-1189-assert.sh" "$DRIVER" || { G5_OK=0; fail "G5: driver must source the assert lib"; }
grep -q "qa-fly-1189-fault-inject" "$DRIVER" || { G5_OK=0; fail "G5: driver must drive the fault injector"; }
[[ "$G5_OK" == "1" ]] && pass "G5: driver wiring sentinels (assert lib + injector)"

echo "=================================="
echo "qa-fly-1189-driver tests: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ]
