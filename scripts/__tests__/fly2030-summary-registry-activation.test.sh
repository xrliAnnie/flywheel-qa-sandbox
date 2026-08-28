#!/usr/bin/env bash
# FLY-2030: summary registry activation must fail before restart-services makes
# any configuration or service mutation.
set -uo pipefail

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RESTART="${SCRIPT_DIR}/../restart-services.sh"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly2030-summary-activation.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT/bin" "$ROOT/repo/packages/flywheel-comm/src/bin" "$ROOT/home"
: > "$ROOT/repo/packages/flywheel-comm/src/bin/summary-registry.ts"
: > "$ROOT/projects.json"
: > "$ROOT/receipt.json"

FUNCS="$ROOT/functions.sh"
awk '
  /^log\(\)/,/^}/ { print; next }
  /^summary_registry_activation_preflight\(\)/,/^}/ { print; next }
' "$RESTART" > "$FUNCS"

cat > "$ROOT/bin/pnpm" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$PNPM_CALLS"
exit "${PNPM_RC:-0}"
FAKE
chmod +x "$ROOT/bin/pnpm"

run_preflight() {
  env -i \
    HOME="$ROOT/home" \
    PATH="$ROOT/bin:/usr/bin:/bin" \
    FLYWHEEL_DIR="$ROOT/repo" \
    FLYWHEEL_PROJECTS_FILE="$ROOT/projects.json" \
    FLYWHEEL_SUMMARY_MIGRATION_RECEIPT="$ROOT/receipt.json" \
    PNPM_CALLS="$ROOT/pnpm.calls" \
    ${PNPM_RC:+PNPM_RC="$PNPM_RC"} \
    ${INLINE_PROJECTS:+FLYWHEEL_PROJECTS="$INLINE_PROJECTS"} \
    bash -c "set -uo pipefail; source '$FUNCS'; summary_registry_activation_preflight"
}

: > "$ROOT/pnpm.calls"
if run_preflight; then
  pass "valid activation evidence delegates to the source verifier"
else
  fail "valid activation verifier invocation failed"
fi
grep -Fq -- "--dir $ROOT/repo exec tsx $ROOT/repo/packages/flywheel-comm/src/bin/summary-registry.ts verify-activation --projects-file $ROOT/projects.json --receipt-file $ROOT/receipt.json" "$ROOT/pnpm.calls" \
  && pass "verifier receives the exact live registry and receipt paths" \
  || fail "verifier argv drifted"

PNPM_RC=23
if run_preflight >/dev/null 2>&1; then
  fail "verifier failure was swallowed"
else
  [[ $? -eq 23 ]] && pass "verifier failure propagates fail-closed" || fail "verifier failure code changed"
fi
unset PNPM_RC

before_calls=$(wc -l < "$ROOT/pnpm.calls" | tr -d ' ')
INLINE_PROJECTS='[{"projectName":"split-brain"}]'
if run_preflight >/dev/null 2>&1; then
  fail "inline FLYWHEEL_PROJECTS split-brain was accepted"
else
  after_calls=$(wc -l < "$ROOT/pnpm.calls" | tr -d ' ')
  [[ "$after_calls" == "$before_calls" ]] \
    && pass "inline registry is rejected before invoking the verifier" \
    || fail "inline registry still invoked the verifier"
fi
unset INLINE_PROJECTS

pull_line=$(grep -n '^preflight_pull_latest_main || exit 1$' "$RESTART" | cut -d: -f1)
gate_line=$(grep -n '^if ! summary_registry_activation_preflight; then$' "$RESTART" | cut -d: -f1)
mutation_line=$(grep -n '^if ! default_lead_agent_env_converge ' "$RESTART" | cut -d: -f1)
if [[ "$pull_line" =~ ^[0-9]+$ && "$gate_line" =~ ^[0-9]+$ && "$mutation_line" =~ ^[0-9]+$ ]] \
  && (( pull_line < gate_line && gate_line < mutation_line )); then
  pass "activation gate runs after pull and before the first config mutation"
else
  fail "activation gate ordering drifted"
fi
grep -A2 '^if ! summary_registry_activation_preflight; then$' "$RESTART" \
  | grep -q 'existing Bridge and Leads remain untouched' \
  && pass "failure path explicitly preserves running services" \
  || fail "failure preservation message is missing"

echo ""
echo "[TEST] fly2030-summary-registry-activation: ${PASSED} passed, ${FAILED} failed"
[[ "$FAILED" -eq 0 ]]
