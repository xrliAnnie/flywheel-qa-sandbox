#!/usr/bin/env bash
# FLY-2530: startup must not apply the offline launchd fence to its own job.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/codex-launchd-preflight.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
REPO="$TMP/repo"
TEAMLEAD="$REPO/packages/teamlead"
mkdir -p "$TEAMLEAD/scripts/lib" "$TEAMLEAD/dist/lead-backends/codex/lead-actions" \
  "$REPO/scripts/lib" "$TMP/bin" "$TMP/home/codex" "$TMP/project"
cp "$ROOT/scripts/codex-home-link-truth.sh" "$REPO/scripts/"
for launcher in run-codex-lead-mufasa-tui-fullaccess.sh run-codex-infra-bot-tui.sh; do
  cp "$ROOT/packages/teamlead/scripts/$launcher" "$TEAMLEAD/scripts/"
done
cat > "$TEAMLEAD/scripts/lib/canonical-lead-identity.sh" <<'STUB'
canonical_lead_identity_resolve() {
  export FLYWHEEL_PROJECT_NAME="$1" FLYWHEEL_LEAD_ID="$2"
}
STUB
cat > "$REPO/scripts/lib/lead-address.sh" <<'STUB'
derive_codex_lead_home() { printf '%s\n' "$CODEX_HOME"; }
STUB
cat > "$TEAMLEAD/scripts/lead-rules-bundle.sh" <<'STUB'
assemble_full_access_governance() { return 0; }
STUB
cat > "$TEAMLEAD/scripts/codex-lead-tui-home.sh" <<'STUB'
[ "$1" = ensure-home ] || exit 91
printf 'ensure-home\n' >> "$TEST_EVENTS"
STUB
# All node invocations, including the eventual runtime, stay inside this stub.
touch "$TEAMLEAD/dist/lead-backends/codex/codex-lead-tui-runtime.js" \
  "$TEAMLEAD/dist/lead-backends/codex/lead-actions/lead-actions-main.js"
cat > "$TMP/bin/node" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  */codex-lead-tui-runtime.js) printf 'runtime\n' >> "$TEST_EVENTS" ;;
  "$FLYWHEEL_COMM_CLI")
    [ "$2 $3" = 'lead-registry generic-codex-profile' ] || exit 92
    printf 'full-access\n' ;;
  *) exit 93 ;;
esac
STUB
cat > "$TMP/bin/codex" <<'STUB'
#!/usr/bin/env bash
exit 94 # This test must never start Codex.
STUB
cat > "$TMP/bin/helper" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = --inspect ]; then
  printf '{"state":"requires-migration"}\n'
else
  printf 'link\n' >> "$TEST_EVENTS"
  printf '[link-truth] state=linked\n'
fi
STUB
cat > "$TMP/bin/ps" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  -axo)
    # The link checker is a child of the wrapper, itself the launchd job PID.
    printf '%s %s bash\n%s 1 bash\n' "$PPID" "$TEST_WRAPPER_PID" "$TEST_WRAPPER_PID"
    if [ "$TEST_ACTIVE_CODEX" = 1 ]; then printf '999999 1 /fixture/codex\n'; fi ;;
  -E) printf 'codex CODEX_HOME=%s\n' "$CODEX_HOME" ;;
  *) exit 95 ;;
esac
STUB
cat > "$TMP/bin/recover" <<'STUB'
#!/usr/bin/env bash
[ "$1 $3 $5" = '--project --lead --authority' ] || exit 96
printf '{"codexHome":"%s","label":"com.flywheel.lead.%s-%s"}\n' "$CODEX_HOME" "$2" "$4"
STUB
cat > "$TMP/bin/launchctl" <<'STUB'
#!/usr/bin/env bash
[ "$1" = print ] || exit 97
case "$2" in
  gui/*/com.flywheel.lead.growth-mufasa-lead|gui/*/com.flywheel.lead.flywheel-codex-infra-bot-lead) ;;
  *) exit 98 ;;
esac
printf 'launchctl\n' >> "$TEST_EVENTS"
printf 'state = running\npid = %s\n' "$TEST_WRAPPER_PID"
STUB
chmod +x "$TMP/bin/"* "$REPO/scripts/codex-home-link-truth.sh"
failures=0
run_case() {
  local name="$1" expected_rc="$2" active="$3" mode="$4" target="$5"
  local events="$TMP/$name.events" output="$TMP/$name.log" rc=0
  : > "$events"
  env -i PATH="$TMP/bin:$PATH" HOME="$TMP/home" CODEX_HOME="$TMP/home/codex" \
    TEST_EVENTS="$events" TEST_ACTIVE_CODEX="$active" \
    FLYWHEEL_TEAMLEAD_ROOT="$TEAMLEAD" FLYWHEEL_COMM_CLI="$TMP/comm.js" \
    FLYWHEEL_CODEX_BIN="$TMP/bin/codex" FLYWHEEL_CODEX_LEAD_PROJECT_DIR="$TMP/project" \
    FLYWHEEL_CODEX_LEAD_OUTBOUND=bridge FLYWHEEL_BRIDGE_URL=http://fixture.invalid \
    FLYWHEEL_API_TOKEN=fixture-only FLYWHEEL_INFRA_BOT_CHAT_CHANNEL_ID=fixture \
    FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID=fixture \
    FLYWHEEL_CODEX_LINK_HELPER="$TMP/bin/helper" FLYWHEEL_CODEX_LINK_PS_BIN="$TMP/bin/ps" \
    FLYWHEEL_CODEX_LINK_RECOVER_BIN="$TMP/bin/recover" \
    FLYWHEEL_CODEX_LINK_LAUNCHCTL_BIN="$TMP/bin/launchctl" \
    /bin/bash -c '
      export TEST_WRAPPER_PID=$$
      if [ "$1" = launcher ]; then exec /bin/bash "$2"; fi
      /bin/bash "$2" --lead "$3" "$CODEX_HOME"
    ' fixture "$mode" "$target" "${6:-}" > "$output" 2>&1 || rc=$?
  if [ "$rc" -ne "$expected_rc" ]; then
    printf 'FAIL %s: expected exit %s, got %s\n' "$name" "$expected_rc" "$rc"
    cat "$output"
    failures=$((failures + 1))
    return
  fi
  if [ "$expected_rc" -eq 0 ]; then
    if [ "$(cat "$events")" != "$(printf 'link\nensure-home\nruntime')" ]; then
      printf 'FAIL %s: expected link, ensure-home, runtime in order\n' "$name"
      failures=$((failures + 1)); return
    fi
  elif [ "$active" -eq 1 ]; then
    if [ -s "$events" ] || ! grep -q 'reason=active-codex-process' "$output"; then
      printf 'FAIL %s: active process must reject before mutation/runtime\n' "$name"
      failures=$((failures + 1)); return
    fi
  elif [ "$(cat "$events")" != launchctl ] || ! grep -q 'reason=lead-job-running' "$output"; then
    printf 'FAIL %s: offline --lead must reject before mutation\n' "$name"
    failures=$((failures + 1)); return
  fi
  printf 'PASS %s\n' "$name"
}
for launcher in run-codex-lead-mufasa-tui-fullaccess.sh run-codex-infra-bot-tui.sh; do
  run_case "$launcher-self-job" 0 0 launcher "$TEAMLEAD/scripts/$launcher"
  run_case "$launcher-active-codex" 3 1 launcher "$TEAMLEAD/scripts/$launcher"
done
run_case offline-mufasa 3 0 offline "$REPO/scripts/codex-home-link-truth.sh" growth/mufasa-lead
run_case offline-infra 3 0 offline "$REPO/scripts/codex-home-link-truth.sh" flywheel/codex-infra-bot-lead
[ "$failures" -eq 0 ] || exit 1
printf 'All launchd preflight regressions passed.\n'
