#!/usr/bin/env bash
# FLY-1959: founder emergency entry publishes one durable urgent token.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REQUEST="$ROOT/scripts/request-restart.sh"
UPDATER="$ROOT/scripts/update-flywheel.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/fly1959-request.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); printf '[TEST] ok - %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '[TEST] FAIL - %s\n' "$1" >&2; }

if [ ! -x "$REQUEST" ]; then
  fail "request-restart.sh exists and is executable"
  printf 'Results: %s passed, %s failed\n' "$PASS" "$FAIL"
  exit 1
fi

REMOTE_SHA=1111111111111111111111111111111111111111
LOCAL_SHA=2222222222222222222222222222222222222222
mkdir -p "$TMP/bin" "$TMP/repo" "$TMP/home"

cat > "$TMP/bin/git" <<'EOF'
#!/usr/bin/env bash
printf 'prompt=%s\t%s\n' "${GIT_TERMINAL_PROMPT:-unset}" "$*" >> "$RR_GIT_LOG"
case " $* " in
  *" ls-remote origin refs/heads/main "*)
    case "${RR_GIT_MODE:-ok}" in
      ok) printf '%s\trefs/heads/main\n' "$RR_REMOTE_SHA" ;;
      fail) printf 'simulated ls-remote failure\n' >&2; exit 2 ;;
      empty) exit 0 ;;
      multi) printf '%s\trefs/heads/main\n%s\trefs/heads/main\n' "$RR_REMOTE_SHA" "$RR_LOCAL_SHA" ;;
      malformed) printf 'not-a-sha\trefs/heads/main\n' ;;
      hang)
        printf 'simulated ls-remote stall\n' >&2
        sleep 5
        printf '%s\trefs/heads/main\n' "$RR_REMOTE_SHA"
        ;;
    esac
    ;;
  *" rev-parse origin/main "*) printf '%s\n' "$RR_LOCAL_SHA" ;;
  *) exit 64 ;;
esac
EOF
cat > "$TMP/bin/launchctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$RR_LAUNCHCTL_LOG"
case "${1:-}" in
  print) [ "${RR_UPDATER_LOADED:-1}" = 1 ] ;;
  print-disabled)
    case "${RR_DISABLED_MODE:-enabled}" in
      enabled) printf 'disabled services = {\n\t"com.flywheel.updater" => enabled\n}\n' ;;
      disabled) printf 'disabled services = {\n\t"com.flywheel.updater" => disabled\n}\n' ;;
      malformed) printf 'disabled services = {\n\tgarbage\n}\n' ;;
      *) exit 64 ;;
    esac
    ;;
  kickstart)
    for arg in "$@"; do
      [ "$arg" != -k ] || { printf 'FORBIDDEN -k\n' >> "$RR_LAUNCHCTL_LOG"; exit 99; }
    done
    count="$(find "$SELF_SHIP_URGENT_DIR" -name '*.urgent.json' 2>/dev/null | wc -l | tr -d ' ')"
    printf 'token_count_at_kick=%s\n' "$count" >> "$RR_LAUNCHCTL_LOG"
    [ "${RR_KICKSTART_OK:-1}" = 1 ]
    ;;
  *) exit 64 ;;
esac
EOF
chmod +x "$TMP/bin/git" "$TMP/bin/launchctl"

export HOME="$TMP/home"
export FLYWHEEL_HOME="$TMP/state"
export FLYWHEEL_DIR="$TMP/repo"
export REQUEST_RESTART_GIT="$TMP/bin/git"
export SELF_SHIP_LAUNCHCTL="$TMP/bin/launchctl"
export SELF_SHIP_UPDATER_LABEL=com.flywheel.updater
export SELF_SHIP_URGENT_DIR="$FLYWHEEL_HOME/self-ship-urgent.d"
export RR_GIT_LOG="$TMP/git.log"
export RR_LAUNCHCTL_LOG="$TMP/launchctl.log"
export RR_REMOTE_SHA="$REMOTE_SHA"
export RR_LOCAL_SHA="$LOCAL_SHA"
export REQUEST_RESTART_REMOTE_TIMEOUT_SECONDS=1

reset_state() {
  rm -rf "$FLYWHEEL_HOME"
  : > "$RR_GIT_LOG"
  : > "$RR_LAUNCHCTL_LOG"
}
token_count() { find "$SELF_SHIP_URGENT_DIR" -name '*.urgent.json' 2>/dev/null | wc -l | tr -d ' '; }
token_path() { find "$SELF_SHIP_URGENT_DIR" -name '*.urgent.json' 2>/dev/null | head -1; }
token_field() { jq -r "$1" "$(token_path)"; }
mode_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

reset_state
out="$(RR_GIT_MODE=ok "$REQUEST" 2>&1)"; rc=$?
token="$(token_path)"
if [ "$rc" -eq 0 ] && [ "$(token_count)" = 1 ] \
  && [ "$(token_field .targetSha)" = "$REMOTE_SHA" ] \
  && jq -e '
      .schemaVersion == 1 and
      .kind == "founder-urgent-restart" and
      (.createdAt | type == "number" and . == floor) and
      (keys | sort) == ["createdAt","kind","schemaVersion","targetSha"]
    ' "$token" >/dev/null \
  && [ "$(mode_of "$SELF_SHIP_URGENT_DIR")" = 700 ] \
  && [ "$(mode_of "$token")" = 600 ] \
  && [ "$(find "$FLYWHEEL_HOME" -maxdepth 1 -name '.urgent-token.*' | wc -l | tr -d ' ')" = 0 ] \
  && grep -q '^kickstart gui/.*/com.flywheel.updater$' "$RR_LAUNCHCTL_LOG" \
  && grep -q '^token_count_at_kick=1$' "$RR_LAUNCHCTL_LOG" \
  && ! grep -q 'FORBIDDEN -k' "$RR_LAUNCHCTL_LOG" \
  && grep -q $'^prompt=0\t.* ls-remote origin refs/heads/main$' "$RR_GIT_LOG" \
  && grep -q '不代表重启完成' <<<"$out"; then
  pass "remote main publishes a complete token before no-k kickstart"
else
  fail "happy path drifted (rc=$rc tokens=$(token_count) launchctl=$(cat "$RR_LAUNCHCTL_LOG") out=$out)"
fi

for mode in fail empty multi malformed; do
  reset_state
  out="$(RR_GIT_MODE="$mode" "$REQUEST" 2>&1)"; rc=$?
  if [ "$rc" -eq 0 ] && [ "$(token_count)" = 1 ] \
    && [ "$(token_field .targetSha)" = "$LOCAL_SHA" ] \
    && grep -q 'WARNING' <<<"$out"; then
    pass "ls-remote $mode falls back to validated local origin/main"
  else
    fail "ls-remote $mode fallback wrong (rc=$rc tokens=$(token_count) out=$out)"
  fi
done

reset_state
started_at=$SECONDS
out="$(RR_GIT_MODE=hang "$REQUEST" 2>&1)"; rc=$?
elapsed=$((SECONDS - started_at))
if [ "$rc" -eq 0 ] && [ "$elapsed" -lt 5 ] \
  && [ "$(token_field .targetSha)" = "$LOCAL_SHA" ] \
  && grep -q 'simulated ls-remote stall' <<<"$out" \
  && grep -q 'rc=124' <<<"$out"; then
  pass "stalled noninteractive ls-remote is bounded and falls back locally"
else
  fail "stalled ls-remote was not bounded (rc=$rc elapsed=$elapsed out=$out)"
fi

reset_state
out="$(RR_UPDATER_LOADED=0 "$REQUEST" 2>&1)"; rc=$?
if [ "$rc" -eq 69 ] && [ "$(token_count)" = 0 ]; then
  pass "unloaded updater fails before token publication"
else
  fail "unloaded updater did not fail cleanly (rc=$rc tokens=$(token_count) out=$out)"
fi

reset_state
out="$(RR_DISABLED_MODE=disabled "$REQUEST" 2>&1)"; rc=$?
if [ "$rc" -eq 69 ] && [ "$(token_count)" = 0 ]; then
  pass "disabled updater fails before token publication"
else
  fail "disabled updater did not fail cleanly (rc=$rc tokens=$(token_count) out=$out)"
fi

reset_state
out="$(RR_KICKSTART_OK=0 "$REQUEST" 2>&1)"; rc=$?
if [ "$rc" -eq 69 ] && [ "$(token_count)" = 1 ] \
  && grep -qi 'token\|票' <<<"$out" \
  && grep -qi '日志\|log' <<<"$out"; then
  pass "kickstart failure preserves the durable token and returns rc69"
else
  fail "kickstart failure lost intent or diagnosis (rc=$rc tokens=$(token_count) out=$out)"
fi

reset_state
mkdir -p "$FLYWHEEL_HOME"
printf 'not-a-directory\n' > "$FLYWHEEL_HOME/urgent-not-dir"
out="$(SELF_SHIP_URGENT_DIR="$FLYWHEEL_HOME/urgent-not-dir" "$REQUEST" 2>&1)"; rc=$?
if [ "$rc" -ne 0 ] && ! grep -q '^kickstart ' "$RR_LAUNCHCTL_LOG"; then
  pass "publish failure never kickstarts updater"
else
  fail "publish failure escaped (rc=$rc launchctl=$(cat "$RR_LAUNCHCTL_LOG") out=$out)"
fi

reset_state
out="$(RR_GIT_MODE=ok "$REQUEST" --dry-run 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && [ ! -e "$FLYWHEEL_HOME" ] \
  && grep -q 'DRY RUN' <<<"$out" \
  && ! grep -q '^kickstart ' "$RR_LAUNCHCTL_LOG" \
  && ! grep -qE 'fetch|update-ref' "$RR_GIT_LOG"; then
  pass "dry-run performs no queue, repository, or launchd writes"
else
  fail "dry-run mutated state (rc=$rc state=$([ -e "$FLYWHEEL_HOME" ] && echo yes || echo no) out=$out)"
fi

if ! rg -q 'restart-services\.sh' "$REQUEST" \
  && rg -q '^  updater_fetch_origin$' "$UPDATER" \
  && rg -q '^  updater_merge_remote$' "$UPDATER" \
  && rg -q 'merge --ff-only "\$target" --quiet' "$UPDATER" \
  && rg -q 'GIT_TERMINAL_PROMPT=0 "\$UPDATER_BOUNDED_RUN"' "$UPDATER" \
  && rg -q 'restart-services\.sh" --reason updater' "$UPDATER"; then
  pass "founder entry cannot bypass updater pull-latest-main chain"
else
  fail "founder entry bypasses or no longer proves the updater deploy chain"
fi

printf 'Results: %s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
