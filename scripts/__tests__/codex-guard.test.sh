#!/usr/bin/env bash
# FLY-1887: hermetic contract tests for the repo-owned one-shot Codex wrapper.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WRAPPER="$REPO_ROOT/scripts/codex-with-fallback.sh"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1887-codex-guard.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

PASSED=0
FAILED=0
pass() { PASSED=$((PASSED + 1)); printf '[TEST] ✓ %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '[TEST] ✗ %s — %s\n' "$1" "$2"; }

mkdir -p "$ROOT/home/.codex/profiles/only" "$ROOT/bin" "$ROOT/state"

cat > "$ROOT/bin/codex-profile" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  status) printf 'Active profile: only\n' ;;
  next|use) exit 0 ;;
  *) exit 2 ;;
esac
EOF

cat > "$ROOT/bin/codex" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$\$" > "$ROOT/codex.pid"
sleep 300 &
printf '%s\n' "\$!" > "$ROOT/descendant.pid"
wait
EOF
chmod +x "$ROOT/bin/codex" "$ROOT/bin/codex-profile"

echo "== one-shot timeout is terminal and typed =="
start="$(date +%s)"
rc=0
env -i \
  HOME="$ROOT/home" \
  PATH="$ROOT/bin:/usr/bin:/bin" \
  FLYWHEEL_CODEX_TOTAL_TIMEOUT_SECONDS=2 \
  FLYWHEEL_CODEX_ATTEMPT_TIMEOUT_SECONDS=2 \
  FLYWHEEL_CODEX_GUARD_STATE_DIR="$ROOT/state" \
  /bin/bash "$WRAPPER" exec --json - \
  >"$ROOT/stdout" 2>"$ROOT/stderr" || rc=$?
elapsed=$(( $(date +%s) - start ))

if [[ "$rc" == "124" ]]; then
  pass "timeout returns rc=124"
else
  fail "timeout returns rc=124" "rc=$rc stderr=$(cat "$ROOT/stderr" 2>/dev/null)"
fi
if grep -q '^\[codex-guard\] TIMEOUT ' "$ROOT/stderr"; then
  pass "timeout emits the fixed marker"
else
  fail "timeout emits the fixed marker" "stderr=$(cat "$ROOT/stderr" 2>/dev/null)"
fi
if [[ -s "$ROOT/codex.pid" && "$elapsed" -lt 10 ]]; then
  pass "the fake Codex started and was bounded (${elapsed}s)"
else
  fail "the fake Codex started and was bounded" "started=$([[ -s "$ROOT/codex.pid" ]] && echo yes || echo no) elapsed=${elapsed}s"
fi

sleep 1
survivors=()
for pid_file in "$ROOT/codex.pid" "$ROOT/descendant.pid"; do
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    survivors+=("$pid")
  fi
done
if [[ "${#survivors[@]}" -eq 0 ]]; then
  pass "timeout leaves no fake Codex process behind"
else
  fail "timeout leaves no fake Codex process behind" "survivors=${survivors[*]}"
  for pid in "${survivors[@]}"; do kill -KILL "$pid" 2>/dev/null || true; done
fi

echo "== pure-Bash watchdog retains ownership of its timeout marker =="
MARKER_TMP="$ROOT/marker-tmp"
mkdir -p "$MARKER_TMP"
# Linux runners normally provide coreutils timeout. Shadow it with an
# executable that cannot launch so this cross-platform test exercises the
# pure-Bash fallback named by the contract; the external path is tested below.
cat > "$ROOT/bin/timeout" <<'EOF'
#!/definitely/missing/interpreter
exit 99
EOF
cat > "$ROOT/bin/codex" <<EOF
#!/usr/bin/env bash
: > "$ROOT/marker-child-ready"
exec /bin/sleep 300
EOF
chmod +x "$ROOT/bin/timeout" "$ROOT/bin/codex"
env -i \
  HOME="$ROOT/home" \
  PATH="$ROOT/bin:/usr/bin:/bin" \
  TMPDIR="$MARKER_TMP" \
  FLYWHEEL_CODEX_TOTAL_TIMEOUT_SECONDS=2 \
  FLYWHEEL_CODEX_ATTEMPT_TIMEOUT_SECONDS=2 \
  FLYWHEEL_CODEX_GUARD_STATE_DIR="$ROOT/state" \
  /bin/bash "$WRAPPER" exec --json - \
  >"$ROOT/marker.stdout" 2>"$ROOT/marker.stderr" &
marker_wrapper_pid=$!
for _ in $(seq 1 60); do
  [[ -e "$ROOT/marker-child-ready" ]] && break
  sleep 0.05
done
owned_marker="$(find "$MARKER_TMP" -maxdepth 1 -name 'codex-guard-timeout.*' \
  -type f -print -quit 2>/dev/null)"
wait "$marker_wrapper_pid" 2>/dev/null || true
if [[ -n "$owned_marker" && ! -L "$owned_marker" && ! -e "$owned_marker" ]]; then
  pass "the watchdog keeps an owned regular marker until cleanup"
else
  fail "the watchdog keeps an owned regular marker until cleanup" \
    "observed=${owned_marker:-missing} remains=$([[ -n "$owned_marker" && -e "$owned_marker" ]] && echo yes || echo no)"
fi

echo "== external timeout requires timeout evidence, not a child exit code =="
cat > "$ROOT/bin/timeout" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "1" ]]; then
  shift
  exec "$@"
fi
while [[ "${1:-}" == --* ]]; do shift; done
shift # duration
exec "$@"
EOF
chmod +x "$ROOT/bin/timeout"
external_status_ok=1
for child_status in 124 137; do
  external_rc=0
  (
    source "$REPO_ROOT/scripts/lib/codex-guard.sh"
    PATH="$ROOT/bin:/usr/bin:/bin" \
      FLYWHEEL_CODEX_GUARD_STATE_DIR="$ROOT/state" \
      FLYWHEEL_CODEX_PS_BIN="$ROOT/bin/ps" \
      codex_guard_run 5 "external-exit-$child_status" \
        /bin/bash -c "exit $child_status"
  ) >"$ROOT/external-$child_status.stdout" \
    2>"$ROOT/external-$child_status.stderr" || external_rc=$?
  if [[ "$external_rc" != "$child_status" ]] \
    || grep -q '^\[codex-guard\] TIMEOUT ' "$ROOT/external-$child_status.stderr"; then
    external_status_ok=0
  fi
done
rm -f "$ROOT/bin/timeout"
if [[ "$external_status_ok" == "1" ]]; then
  pass "external timeout preserves evidenced child exits 124/137 without a false timeout marker"
else
  fail "external timeout preserves evidenced child exits 124/137 without a false timeout marker" \
    "rc124=$(tail -1 "$ROOT/external-124.stderr" 2>/dev/null) rc137=$(tail -1 "$ROOT/external-137.stderr" 2>/dev/null)"
fi

echo "== cleanup is registry-positive and identity-fenced =="
cat > "$ROOT/bin/codex" <<'EOF'
#!/usr/bin/env bash
printf 'ok\n'
exit 0
EOF
cat > "$ROOT/bin/ps" <<'EOF'
#!/usr/bin/env bash
format=""
pid=""
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    -o) format="$2"; shift 2 ;;
    -p) pid="$2"; shift 2 ;;
    *) shift ;;
  esac
done
case "$format" in
  lstart=) printf 'Mon Jan  1 00:00:00 2024\n' ;;
  pgid=) printf '999999\n' ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$ROOT/bin/codex" "$ROOT/bin/ps"

/bin/sleep 300 &
registered_pid=$!
/bin/sleep 300 &
unregistered_pid=$!
printf '{"pid":%s,"pgid":999999,"start":"Mon Jan  1 00:00:00 2024","deadline":0,"label":"fixture"}\n' \
  "$registered_pid" > "$ROOT/state/$registered_pid.json"

rc=0
env -i \
  HOME="$ROOT/home" \
  PATH="$ROOT/bin:/usr/bin:/bin" \
  FLYWHEEL_CODEX_TOTAL_TIMEOUT_SECONDS=10 \
  FLYWHEEL_CODEX_ATTEMPT_TIMEOUT_SECONDS=10 \
  FLYWHEEL_CODEX_GUARD_STATE_DIR="$ROOT/state" \
  FLYWHEEL_CODEX_PS_BIN="$ROOT/bin/ps" \
  /bin/bash "$WRAPPER" exec --json - \
  >"$ROOT/sweep.stdout" 2>"$ROOT/sweep.stderr" || rc=$?

if [[ "$rc" == "0" ]] && ! kill -0 "$registered_pid" 2>/dev/null \
  && [[ ! -e "$ROOT/state/$registered_pid.json" ]]; then
  pass "a stale matching registry entry is reaped and removed"
else
  fail "a stale matching registry entry is reaped and removed" \
    "rc=$rc alive=$(kill -0 "$registered_pid" 2>/dev/null && echo yes || echo no) entry=$([[ -e "$ROOT/state/$registered_pid.json" ]] && echo yes || echo no)"
fi
if kill -0 "$unregistered_pid" 2>/dev/null; then
  pass "an unregistered process is never a cleanup candidate"
else
  fail "an unregistered process is never a cleanup candidate" "pid=$unregistered_pid was killed"
fi
kill -KILL "$registered_pid" "$unregistered_pid" 2>/dev/null || true
wait "$registered_pid" "$unregistered_pid" 2>/dev/null || true

echo "== active calls publish identity and normal exit clears it =="
rm -f "$ROOT/state"/*.json "$ROOT/active.ready"
cat > "$ROOT/bin/codex" <<EOF
#!/usr/bin/env bash
printf 'ready\n' > "$ROOT/active.ready"
sleep 2
printf 'done\n'
EOF
chmod +x "$ROOT/bin/codex"

env -i \
  HOME="$ROOT/home" \
  PATH="$ROOT/bin:/usr/bin:/bin" \
  FLYWHEEL_CODEX_TOTAL_TIMEOUT_SECONDS=10 \
  FLYWHEEL_CODEX_ATTEMPT_TIMEOUT_SECONDS=10 \
  FLYWHEEL_CODEX_GUARD_STATE_DIR="$ROOT/state" \
  FLYWHEEL_CODEX_PS_BIN="$ROOT/bin/ps" \
  /bin/bash "$WRAPPER" exec --json - \
  >"$ROOT/active.stdout" 2>"$ROOT/active.stderr" &
wrapper_pid=$!

active_entry=""
last_active_candidate=""
for _ in $(seq 1 60); do
  for candidate in "$ROOT/state"/*.json; do
    [[ -f "$candidate" && ! -L "$candidate" ]] || continue
    last_active_candidate="$candidate"
    if grep -Eq '^\{"pid":[0-9]+,"pgid":[0-9]+,"start":"[^"]+","deadline":[0-9]+,"label":"[^"]+"\}$' \
      "$candidate" 2>/dev/null; then
      active_entry="$candidate"
      break 2
    fi
  done
  sleep 0.05
done
if [[ -n "$active_entry" ]]; then
  pass "an active invocation has a complete identity record"
else
  fail "an active invocation has a complete identity record" \
    "last_candidate=${last_active_candidate:-missing}"
fi

wait "$wrapper_pid"
active_rc=$?
if [[ "$active_rc" == "0" && "$(find "$ROOT/state" -maxdepth 1 -name '*.json' -type f | wc -l | tr -d ' ')" == "0" ]]; then
  pass "normal completion removes the identity record"
else
  fail "normal completion removes the identity record" "rc=$active_rc entries=$(find "$ROOT/state" -maxdepth 1 -name '*.json' -type f | wc -l | tr -d ' ')"
fi

echo "== interrupted wrapper leaves an identity-fenced cleanup record =="
rm -f "$ROOT/state"/*.json "$ROOT/interrupted-codex.pid"
# Keep this lifecycle assertion on the direct-child pure-Bash seam on every
# host. In the external-timeout seam the registered PID is the timeout wrapper,
# not the nested fake Codex PID written by this fixture.
cat > "$ROOT/bin/timeout" <<'EOF'
#!/definitely/missing/interpreter
exit 99
EOF
cat > "$ROOT/bin/codex" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$\$" > "$ROOT/interrupted-codex.pid"
printf 'partial-stdout-before-interrupt\n'
printf 'partial-stderr-before-interrupt\n' >&2
exec /bin/sleep 300
EOF
chmod +x "$ROOT/bin/timeout" "$ROOT/bin/codex"
env -i \
  HOME="$ROOT/home" \
  PATH="$ROOT/bin:/usr/bin:/bin" \
  FLYWHEEL_CODEX_TOTAL_TIMEOUT_SECONDS=300 \
  FLYWHEEL_CODEX_ATTEMPT_TIMEOUT_SECONDS=300 \
  FLYWHEEL_CODEX_GUARD_STATE_DIR="$ROOT/state" \
  FLYWHEEL_CODEX_PS_BIN="$ROOT/bin/ps" \
  /bin/bash "$WRAPPER" exec --json - \
  >"$ROOT/interrupted.stdout" 2>"$ROOT/interrupted.stderr" &
interrupted_wrapper_pid=$!
interrupted_entry=""
for _ in $(seq 1 60); do
  interrupted_codex_candidate="$(cat "$ROOT/interrupted-codex.pid" 2>/dev/null || true)"
  if [[ -n "$interrupted_codex_candidate" \
    && -f "$ROOT/state/$interrupted_codex_candidate.json" ]]; then
    interrupted_entry="$ROOT/state/$interrupted_codex_candidate.json"
    break
  fi
  sleep 0.05
done
interrupt_kill_rc=0
kill -TERM "$interrupted_wrapper_pid" 2>/dev/null || interrupt_kill_rc=$?
for _ in $(seq 1 60); do
  kill -0 "$interrupted_wrapper_pid" 2>/dev/null || break
  sleep 0.05
done
interrupt_stuck=0
if kill -0 "$interrupted_wrapper_pid" 2>/dev/null; then
  interrupt_stuck=1
  kill -KILL "$interrupted_wrapper_pid" 2>/dev/null || true
fi
wait "$interrupted_wrapper_pid" 2>/dev/null || true
if grep -q '^partial-stdout-before-interrupt$' "$ROOT/interrupted.stdout" \
  && grep -q '^partial-stderr-before-interrupt$' "$ROOT/interrupted.stderr"; then
  pass "signal exit publishes buffered partial stdout and stderr before cleanup"
else
  fail "signal exit publishes buffered partial stdout and stderr before cleanup" \
    "kill_rc=$interrupt_kill_rc stuck=$interrupt_stuck stdout=$(cat "$ROOT/interrupted.stdout" 2>/dev/null) stderr=$(tail -80 "$ROOT/interrupted.stderr" 2>/dev/null)"
fi
interrupted_codex_pid="$(cat "$ROOT/interrupted-codex.pid" 2>/dev/null || true)"
if [[ -n "$interrupted_entry" && -f "$interrupted_entry" \
  && -n "$interrupted_codex_pid" ]] && kill -0 "$interrupted_codex_pid" 2>/dev/null; then
  pass "signal exit preserves the registered child identity"
else
  fail "signal exit preserves the registered child identity" \
    "entry=${interrupted_entry:-missing} present=$([[ -n "$interrupted_entry" && -f "$interrupted_entry" ]] && echo yes || echo no) child=${interrupted_codex_pid:-missing}"
fi
if [[ -n "$interrupted_entry" && -n "$interrupted_codex_pid" ]]; then
  printf '{"pid":%s,"pgid":999999,"start":"Mon Jan  1 00:00:00 2024","deadline":0,"label":"interrupted"}\n' \
    "$interrupted_codex_pid" > "$interrupted_entry"
fi
source "$REPO_ROOT/scripts/lib/codex-guard.sh"
FLYWHEEL_CODEX_GUARD_STATE_DIR="$ROOT/state" FLYWHEEL_CODEX_PS_BIN="$ROOT/bin/ps" codex_guard_sweep
if [[ -n "$interrupted_codex_pid" ]] && ! kill -0 "$interrupted_codex_pid" 2>/dev/null \
  && [[ ! -e "$interrupted_entry" ]]; then
  pass "next invocation sweep reaps the interrupted child"
else
  fail "next invocation sweep reaps the interrupted child" \
    "child_alive=$(kill -0 "$interrupted_codex_pid" 2>/dev/null && echo yes || echo no) entry=$([[ -e "$interrupted_entry" ]] && echo yes || echo no)"
  [[ -z "$interrupted_codex_pid" ]] || kill -KILL "$interrupted_codex_pid" 2>/dev/null || true
fi
rm -f "$ROOT/bin/timeout"

echo "== malformed registry fields are rejected before signaling =="
rm -f "$ROOT/state"/*.json "$ROOT/malformed-signals"
malformed_pid=424242
printf '{"pid":%s,"start":"Mon Jan  1 00:00:00 2024","deadline":0,"label":"truncated"}\n' \
  "$malformed_pid" > "$ROOT/state/$malformed_pid.json"
(
  source "$REPO_ROOT/scripts/lib/codex-guard.sh"
  kill() { printf '%s\n' "$*" >> "$ROOT/malformed-signals"; return 0; }
  FLYWHEEL_CODEX_GUARD_STATE_DIR="$ROOT/state" \
    FLYWHEEL_CODEX_PS_BIN="$ROOT/bin/ps" codex_guard_sweep
)
if [[ ! -e "$ROOT/state/$malformed_pid.json" && ! -e "$ROOT/malformed-signals" ]]; then
  pass "a registry entry with an empty pgid is discarded without signaling"
else
  fail "a registry entry with an empty pgid is discarded without signaling" \
    "entry=$([[ -e "$ROOT/state/$malformed_pid.json" ]] && echo yes || echo no) signals=$(cat "$ROOT/malformed-signals" 2>/dev/null || echo none)"
fi

echo "== invalid configuration fails closed before Codex starts =="
rm -f "$ROOT/codex.invoked"
cat > "$ROOT/bin/codex" <<EOF
#!/usr/bin/env bash
: > "$ROOT/codex.invoked"
exit 0
EOF
chmod +x "$ROOT/bin/codex"

rc=0
env -i \
  HOME="$ROOT/home" \
  PATH="$ROOT/bin:/usr/bin:/bin" \
  FLYWHEEL_CODEX_TOTAL_TIMEOUT_SECONDS=invalid \
  FLYWHEEL_CODEX_ATTEMPT_TIMEOUT_SECONDS=1800 \
  /bin/bash "$WRAPPER" exec --json - \
  >"$ROOT/config.stdout" 2>"$ROOT/config.stderr" || rc=$?
if [[ "$rc" == "125" && ! -e "$ROOT/codex.invoked" ]] \
  && grep -Fq "TOTAL_TIMEOUT_SECONDS=\"\${FLYWHEEL_CODEX_TOTAL_TIMEOUT_SECONDS:-1800}\"" "$WRAPPER" \
  && grep -Fq "ATTEMPT_TIMEOUT_SECONDS=\"\${FLYWHEEL_CODEX_ATTEMPT_TIMEOUT_SECONDS:-1800}\"" "$WRAPPER"; then
  pass "invalid timeout config is rc=125 and defaults remain 1800s"
else
  fail "invalid timeout config is rc=125 and defaults remain 1800s" \
    "rc=$rc invoked=$([[ -e "$ROOT/codex.invoked" ]] && echo yes || echo no)"
fi

echo "== broken coreutils and unwritable state still produce a hard bound =="
mkdir -p "$ROOT/home/.codex/profiles/second"
printf 'not-a-directory\n' > "$ROOT/unwritable-state"
cat > "$ROOT/bin/timeout" <<'EOF'
#!/definitely/missing/interpreter
exit 99
EOF
cat > "$ROOT/bin/codex-profile" <<EOF
#!/usr/bin/env bash
case "\${1:-}" in
  status) printf 'Active profile: only\n' ;;
  next|use) printf '%s\n' "\$1" >> "$ROOT/profile-actions" ;;
  *) exit 2 ;;
esac
EOF
cat > "$ROOT/bin/codex" <<EOF
#!/usr/bin/env bash
printf '429 rate limit before hang\n' >&2
printf '%s\n' "\$\$" > "$ROOT/broken-timeout-codex.pid"
/bin/sleep 300 &
printf '%s\n' "\$!" > "$ROOT/broken-timeout-descendant.pid"
wait
EOF
chmod +x "$ROOT/bin/timeout" "$ROOT/bin/codex-profile" "$ROOT/bin/codex"
rm -f "$ROOT/profile-actions" "$ROOT/broken-timeout-codex.pid" "$ROOT/broken-timeout-descendant.pid"

start="$(date +%s)"
rc=0
env -i \
  HOME="$ROOT/home" \
  PATH="$ROOT/bin:/usr/bin:/bin" \
  FLYWHEEL_CODEX_TOTAL_TIMEOUT_SECONDS=2 \
  FLYWHEEL_CODEX_ATTEMPT_TIMEOUT_SECONDS=2 \
  FLYWHEEL_CODEX_GUARD_STATE_DIR="$ROOT/unwritable-state" \
  /bin/bash "$WRAPPER" exec --json - \
  >"$ROOT/broken-timeout.stdout" 2>"$ROOT/broken-timeout.stderr" || rc=$?
elapsed=$(( $(date +%s) - start ))
sleep 1
survivors=()
for pid_file in "$ROOT/broken-timeout-codex.pid" "$ROOT/broken-timeout-descendant.pid"; do
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then survivors+=("$pid"); fi
done
if [[ "$rc" == "124" && "$elapsed" -lt 10 && "${#survivors[@]}" -eq 0 ]] \
  && [[ ! -e "$ROOT/profile-actions" ]]; then
  pass "broken timeout falls back; unwritable state fails open; timeout never rotates"
else
  fail "broken timeout falls back; unwritable state fails open; timeout never rotates" \
    "rc=$rc elapsed=${elapsed}s survivors=${survivors[*]:-none} rotations=$(cat "$ROOT/profile-actions" 2>/dev/null || echo none)"
  for pid in "${survivors[@]}"; do kill -KILL "$pid" 2>/dev/null || true; done
fi
rm -f "$ROOT/bin/timeout"

echo "== ordinary rate limit fails on the current account without rotation =="
rm -f "$ROOT/rate-limit-calls" "$ROOT/profile-actions"
cat > "$ROOT/bin/codex" <<EOF
#!/usr/bin/env bash
count=0
[[ ! -f "$ROOT/rate-limit-calls" ]] || count=\$(cat "$ROOT/rate-limit-calls")
count=\$((count + 1))
printf '%s\n' "\$count" > "$ROOT/rate-limit-calls"
if [[ "\$count" -eq 1 ]]; then
  printf '429 rate limit\n' >&2
  exit 7
fi
printf 'ok\n'
EOF
chmod +x "$ROOT/bin/codex"
rc=0
env -i \
  HOME="$ROOT/home" \
  PATH="$ROOT/bin:/usr/bin:/bin" \
  FLYWHEEL_CODEX_TOTAL_TIMEOUT_SECONDS=10 \
  FLYWHEEL_CODEX_ATTEMPT_TIMEOUT_SECONDS=10 \
  FLYWHEEL_CODEX_GUARD_STATE_DIR="$ROOT/state" \
  FLYWHEEL_CODEX_PS_BIN="$ROOT/bin/ps" \
  /bin/bash "$WRAPPER" exec --json - \
  >"$ROOT/rate-limit.stdout" 2>"$ROOT/rate-limit.stderr" || rc=$?
if [[ "$rc" == "7" && "$(cat "$ROOT/rate-limit-calls" 2>/dev/null)" == "1" ]] \
  && [[ ! -e "$ROOT/profile-actions" ]] \
  && grep -q 'codex-profile status' "$ROOT/rate-limit.stderr" \
  && grep -q 'Founder may manually.*use' "$ROOT/rate-limit.stderr"; then
  pass "rate limit stays on the current account and gives a manual recovery hint"
else
  fail "rate limit stays on the current account and gives a manual recovery hint" \
    "rc=$rc calls=$(cat "$ROOT/rate-limit-calls" 2>/dev/null || echo missing) actions=$(cat "$ROOT/profile-actions" 2>/dev/null || echo none)"
fi

echo "== auth expiry fails on the current account without rotation =="
rm -f "$ROOT/auth-expired-calls" "$ROOT/profile-actions"
cat > "$ROOT/bin/codex" <<EOF
#!/usr/bin/env bash
count=0
[[ ! -f "$ROOT/auth-expired-calls" ]] || count=\$(cat "$ROOT/auth-expired-calls")
count=\$((count + 1))
printf '%s\n' "\$count" > "$ROOT/auth-expired-calls"
printf 'refresh_token_reused\n' >&2
exit 9
EOF
chmod +x "$ROOT/bin/codex"
rc=0
env -i \
  HOME="$ROOT/home" \
  PATH="$ROOT/bin:/usr/bin:/bin" \
  FLYWHEEL_CODEX_TOTAL_TIMEOUT_SECONDS=10 \
  FLYWHEEL_CODEX_ATTEMPT_TIMEOUT_SECONDS=10 \
  FLYWHEEL_CODEX_GUARD_STATE_DIR="$ROOT/state" \
  FLYWHEEL_CODEX_PS_BIN="$ROOT/bin/ps" \
  /bin/bash "$WRAPPER" exec --json - \
  >"$ROOT/auth-expired.stdout" 2>"$ROOT/auth-expired.stderr" || rc=$?
if [[ "$rc" == "9" && "$(cat "$ROOT/auth-expired-calls" 2>/dev/null)" == "1" ]] \
  && [[ ! -e "$ROOT/profile-actions" ]] \
  && grep -q 'codex-profile status' "$ROOT/auth-expired.stderr" \
  && grep -q 'Founder may manually.*use' "$ROOT/auth-expired.stderr"; then
  pass "auth expiry stays on the current account and gives a manual recovery hint"
else
  fail "auth expiry stays on the current account and gives a manual recovery hint" \
    "rc=$rc calls=$(cat "$ROOT/auth-expired-calls" 2>/dev/null || echo missing) actions=$(cat "$ROOT/profile-actions" 2>/dev/null || echo none)"
fi

echo "== rate-limit handling does not multiply the total budget across profiles =="
mkdir -p "$ROOT/home/.codex/profiles/third"
rm -f "$ROOT/total-budget-calls" "$ROOT/profile-actions"
cat > "$ROOT/bin/codex" <<EOF
#!/usr/bin/env bash
count=0
[[ ! -f "$ROOT/total-budget-calls" ]] || count=\$(cat "$ROOT/total-budget-calls")
count=\$((count + 1))
printf '%s\n' "\$count" > "$ROOT/total-budget-calls"
/bin/sleep 1.2
printf '429 rate limit\n' >&2
exit 7
EOF
chmod +x "$ROOT/bin/codex"
start="$(date +%s)"
rc=0
env -i \
  HOME="$ROOT/home" \
  PATH="$ROOT/bin:/usr/bin:/bin" \
  FLYWHEEL_CODEX_TOTAL_TIMEOUT_SECONDS=3 \
  FLYWHEEL_CODEX_ATTEMPT_TIMEOUT_SECONDS=2 \
  FLYWHEEL_CODEX_GUARD_STATE_DIR="$ROOT/state" \
  FLYWHEEL_CODEX_PS_BIN="$ROOT/bin/ps" \
  /bin/bash "$WRAPPER" exec --json - \
  >"$ROOT/total-budget.stdout" 2>"$ROOT/total-budget.stderr" || rc=$?
elapsed=$(( $(date +%s) - start ))
if [[ "$rc" == "7" && "$elapsed" -lt 7 \
  && "$(cat "$ROOT/total-budget-calls" 2>/dev/null)" == "1" \
  && ! -e "$ROOT/profile-actions" ]]; then
  pass "rate-limit failure consumes one guarded attempt (${elapsed}s)"
else
  fail "rate-limit failure consumes one guarded attempt" \
    "rc=$rc elapsed=${elapsed}s calls=$(cat "$ROOT/total-budget-calls" 2>/dev/null || echo missing)"
fi

echo "== final model fallback remains guarded =="
rm -rf "$ROOT/home/.codex/profiles/second" "$ROOT/home/.codex/profiles/third"
rm -f "$ROOT/model-fallback-calls" "$ROOT/model-fallback-args"
cat > "$ROOT/bin/codex" <<EOF
#!/usr/bin/env bash
count=0
[[ ! -f "$ROOT/model-fallback-calls" ]] || count=\$(cat "$ROOT/model-fallback-calls")
count=\$((count + 1))
printf '%s\n' "\$count" > "$ROOT/model-fallback-calls"
printf '%s\n' "\$*" >> "$ROOT/model-fallback-args"
if [[ "\$count" -eq 1 ]]; then
  printf 'model is not supported when using Codex\n' >&2
  exit 8
fi
/bin/sleep 300
EOF
chmod +x "$ROOT/bin/codex"
rc=0
env -i \
  HOME="$ROOT/home" \
  PATH="$ROOT/bin:/usr/bin:/bin" \
  FLYWHEEL_CODEX_TOTAL_TIMEOUT_SECONDS=10 \
  FLYWHEEL_CODEX_ATTEMPT_TIMEOUT_SECONDS=2 \
  FLYWHEEL_CODEX_GUARD_STATE_DIR="$ROOT/state" \
  FLYWHEEL_CODEX_PS_BIN="$ROOT/bin/ps" \
  /bin/bash "$WRAPPER" exec --json -m gpt-5.6 \
  >"$ROOT/model-fallback.stdout" 2>"$ROOT/model-fallback.stderr" || rc=$?
if [[ "$rc" == "124" && "$(cat "$ROOT/model-fallback-calls" 2>/dev/null)" == "2" ]] \
  && tail -1 "$ROOT/model-fallback-args" | grep -q -- '-m gpt-5.5' \
  && [[ ! -e "$ROOT/profile-actions" ]]; then
  pass "gpt-5.5 fallback cannot escape the total timeout"
else
  fail "gpt-5.5 fallback cannot escape the total timeout" \
    "rc=$rc calls=$(cat "$ROOT/model-fallback-calls" 2>/dev/null || echo missing) args=$(cat "$ROOT/model-fallback-args" 2>/dev/null || echo missing)"
fi

echo "== stale identity is deleted without signaling the recycled pid =="
rm -f "$ROOT/state"/*.json
/bin/sleep 300 &
recycled_pid=$!
printf '{"pid":%s,"pgid":%s,"start":"different incarnation","deadline":0,"label":"fixture"}\n' \
  "$recycled_pid" "$recycled_pid" > "$ROOT/state/$recycled_pid.json"
source "$REPO_ROOT/scripts/lib/codex-guard.sh"
FLYWHEEL_CODEX_GUARD_STATE_DIR="$ROOT/state" FLYWHEEL_CODEX_PS_BIN="$ROOT/bin/ps" codex_guard_sweep
if kill -0 "$recycled_pid" 2>/dev/null && [[ ! -e "$ROOT/state/$recycled_pid.json" ]]; then
  pass "PID reuse fence removes only the stale registry record"
else
  fail "PID reuse fence removes only the stale registry record" "pid=$recycled_pid alive=$(kill -0 "$recycled_pid" 2>/dev/null && echo yes || echo no)"
fi
kill -KILL "$recycled_pid" 2>/dev/null || true
wait "$recycled_pid" 2>/dev/null || true

echo "== non-owned process groups are never signaled as a group =="
rm -f "$ROOT/state"/*.json "$ROOT/pgid-child.pid" "$ROOT/locale-seen"
set -m
(
  trap '' TERM HUP
  /bin/sleep 300 &
  printf '%s\n' "$!" > "$ROOT/pgid-child.pid"
  wait
) >/dev/null 2>&1 &
group_leader_pid=$!
set +m
for _ in $(seq 1 60); do
  [[ -s "$ROOT/pgid-child.pid" ]] && break
  sleep 0.05
done
group_child_pid="$(cat "$ROOT/pgid-child.pid" 2>/dev/null || true)"
cat > "$ROOT/bin/ps-locale" <<EOF
#!/usr/bin/env bash
[[ "\${LC_ALL:-}" == "C" ]] || exit 9
printf '%s\n' "\$LC_ALL" >> "$ROOT/locale-seen"
format=""
while [[ "\$#" -gt 0 ]]; do
  case "\$1" in
    -o) format="\$2"; shift 2 ;;
    -p) shift 2 ;;
    *) shift ;;
  esac
done
case "\$format" in
  lstart=) printf 'Mon Jan  1 00:00:00 2024\n' ;;
  pgid=) printf '999999\n' ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$ROOT/bin/ps-locale"
printf '{"pid":%s,"pgid":999999,"start":"Mon Jan  1 00:00:00 2024","deadline":0,"label":"group-fence"}\n' \
  "$group_leader_pid" > "$ROOT/state/$group_leader_pid.json"
FLYWHEEL_CODEX_GUARD_STATE_DIR="$ROOT/state" FLYWHEEL_CODEX_PS_BIN="$ROOT/bin/ps-locale" codex_guard_sweep
if ! kill -0 "$group_leader_pid" 2>/dev/null \
  && [[ -n "$group_child_pid" ]] && kill -0 "$group_child_pid" 2>/dev/null \
  && [[ ! -e "$ROOT/state/$group_leader_pid.json" ]] \
  && [[ "$(sort -u "$ROOT/locale-seen" 2>/dev/null)" == "C" ]]; then
  pass "pgid mismatch signals only pid and both ps identity reads pin LC_ALL=C"
else
  fail "pgid mismatch signals only pid and both ps identity reads pin LC_ALL=C" \
    "leader_alive=$(kill -0 "$group_leader_pid" 2>/dev/null && echo yes || echo no) child_alive=$(kill -0 "$group_child_pid" 2>/dev/null && echo yes || echo no) locale=$(cat "$ROOT/locale-seen" 2>/dev/null || echo missing)"
fi
kill -KILL "$group_leader_pid" "$group_child_pid" 2>/dev/null || true
wait "$group_leader_pid" 2>/dev/null || true

echo "== pid-only broker and shared launcher boundaries stay outside the guard =="
if ! grep -Eq 'broker\.pid|codex-code-mode-host|pkill|killall' \
  "$REPO_ROOT/scripts/lib/codex-guard.sh" "$WRAPPER" "$REPO_ROOT/scripts/install-codex-guard.sh"; then
  pass "guard has no pid-only broker or process-name reaper"
else
  fail "guard has no pid-only broker or process-name reaper" "unsafe broker/process-name token found"
fi
if ! grep -Eq '(^|[[:space:]])(export[[:space:]]+)?FLYWHEEL_CODEX_BIN=' \
  "$REPO_ROOT/scripts/install-codex-guard.sh" "$REPO_ROOT/scripts/lib/converge-nonlead-daemons.sh"; then
  pass "installer and convergence never mutate shared FLYWHEEL_CODEX_BIN"
else
  fail "installer and convergence never mutate shared FLYWHEEL_CODEX_BIN" "shared launcher mutation found"
fi

echo "== installer publishes a stable, idempotent release =="
INSTALLER="$REPO_ROOT/scripts/install-codex-guard.sh"
INSTALL_HOME="$ROOT/install-home"
NODE_REAL="$(command -v node)"
make_codex_auth() {
  local destination="$1" email="$2" account_id="$3" plan="${4:-pro}"
  mkdir -p "$(dirname "$destination")"
  "$NODE_REAL" - "$destination" "$email" "$account_id" "$plan" <<'NODE'
const fs = require("node:fs");
const [destination, email, accountId, plan] = process.argv.slice(2);
const token = [
  Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
  Buffer.from(JSON.stringify({
    email,
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: plan,
    },
  })).toString("base64url"),
  "signature",
].join(".");
fs.writeFileSync(destination, JSON.stringify({
  tokens: {
    id_token: token,
    access_token: `access-canary-${accountId}`,
    refresh_token: `refresh-canary-${accountId}`,
  },
}), { mode: 0o600 });
NODE
}
mkdir -p "$INSTALL_HOME/.local/bin" "$INSTALL_HOME/.codex/profiles/school"
printf 'legacy-wrapper\n' > "$INSTALL_HOME/.local/bin/codex-with-fallback"
printf 'legacy-profile\n' > "$INSTALL_HOME/.local/bin/codex-profile"
make_codex_auth "$INSTALL_HOME/.codex/auth.json" "xrliannie@gmail.com" "acct-personal"
make_codex_auth "$INSTALL_HOME/.codex/profiles/school/auth.json" \
  "xiaorongli2011@u.northwestern.edu" "acct-school"
install_rc=0
HOME="$INSTALL_HOME" /bin/bash "$INSTALLER" >"$ROOT/install.stdout" 2>"$ROOT/install.stderr" || install_rc=$?
current="$INSTALL_HOME/.flywheel/libexec/codex-guard/current"
if [[ "$install_rc" == "0" && -L "$current" \
  && -x "$current/codex-with-fallback.sh" && -r "$current/codex-guard.sh" \
  && -r "$current/flywheel-codex-profile.mjs" \
  && -r "$current/codex-account-core.mjs" \
  && -r "$current/codex-account-core.d.mts" \
  && -r "$current/codex-account-registry.json" \
  && -x "$INSTALL_HOME/.local/bin/codex-with-fallback" \
  && -x "$INSTALL_HOME/.local/bin/codex-profile" ]]; then
  pass "installer publishes the six-file release and both global shims"
else
  fail "installer publishes the six-file release and both global shims" "rc=$install_rc stderr=$(cat "$ROOT/install.stderr" 2>/dev/null)"
fi
if [[ "$(cat "$INSTALL_HOME/.local/bin/codex-with-fallback.bak" 2>/dev/null)" == "legacy-wrapper" ]]; then
  pass "installer preserves the original wrapper once"
else
  fail "installer preserves the original wrapper once" "backup=$(cat "$INSTALL_HOME/.local/bin/codex-with-fallback.bak" 2>/dev/null || echo missing)"
fi
if [[ "$(cat "$INSTALL_HOME/.local/bin/codex-profile.bak" 2>/dev/null)" == "legacy-profile" ]]; then
  pass "installer preserves the original profile command once"
else
  fail "installer preserves the original profile command once" "backup=$(cat "$INSTALL_HOME/.local/bin/codex-profile.bak" 2>/dev/null || echo missing)"
fi

POISON_HOME="$ROOT/poison-codex-home"
POISON_POOL="$ROOT/poison-pool"
POISON_STATE="$ROOT/poison-state"
mkdir -p "$POISON_HOME" "$POISON_POOL" "$POISON_STATE"
make_codex_auth "$POISON_HOME/auth.json" \
  "xrliannie.b@gmail.com" "acct-poison-business" "prolite"
printf 'poison-auth-canary\n' > "$ROOT/poison-before"
cp "$POISON_HOME/auth.json" "$ROOT/poison-before"
profile_rc=0
env -i HOME="$INSTALL_HOME" PATH="$ROOT/bin:/usr/bin:/bin" \
  FLYWHEEL_NODE_BIN="$NODE_REAL" \
  CODEX_HOME="$POISON_HOME" \
  FLYWHEEL_CODEX_PROFILES_DIR="$POISON_POOL" \
  FLYWHEEL_STATE_DIR="$POISON_STATE" \
  "$INSTALL_HOME/.local/bin/codex-profile" status --json \
  >"$ROOT/profile-status.stdout" 2>"$ROOT/profile-status.stderr" || profile_rc=$?
if [[ "$profile_rc" == "0" ]] \
  && grep -q '"profile": "personal"' "$ROOT/profile-status.stdout" \
  && [[ -f "$INSTALL_HOME/.flywheel/codex-account-ledger/personal.json" ]] \
  && [[ ! -e "$POISON_STATE/codex-account-ledger" ]] \
  && cmp -s "$POISON_HOME/auth.json" "$ROOT/poison-before"; then
  pass "global profile status pins home, pool, ledger and registry against ambient runner roots"
else
  fail "global profile status pins home, pool, ledger and registry against ambient runner roots" \
    "rc=$profile_rc stdout=$(cat "$ROOT/profile-status.stdout" 2>/dev/null) stderr=$(cat "$ROOT/profile-status.stderr" 2>/dev/null)"
fi

profile_use_rc=0
env -i HOME="$INSTALL_HOME" PATH="$ROOT/bin:/usr/bin:/bin" \
  FLYWHEEL_NODE_BIN="$NODE_REAL" CODEX_HOME="$POISON_HOME" \
  FLYWHEEL_CODEX_PROFILES_DIR="$POISON_POOL" FLYWHEEL_STATE_DIR="$POISON_STATE" \
  "$INSTALL_HOME/.local/bin/codex-profile" use school \
  >"$ROOT/profile-use.stdout" 2>"$ROOT/profile-use.stderr" || profile_use_rc=$?
if [[ "$profile_use_rc" == "0" ]] \
  && env -i HOME="$INSTALL_HOME" PATH="$ROOT/bin:/usr/bin:/bin" \
    FLYWHEEL_NODE_BIN="$NODE_REAL" "$INSTALL_HOME/.local/bin/codex-profile" status --json \
    | grep -q '"profile": "school"' \
  && cmp -s "$POISON_HOME/auth.json" "$ROOT/poison-before"; then
  pass "global profile use changes only the pinned global home"
else
  fail "global profile use changes only the pinned global home" \
    "rc=$profile_use_rc stderr=$(cat "$ROOT/profile-use.stderr" 2>/dev/null)"
fi
make_codex_auth "$INSTALL_HOME/.codex/auth.json" "xrliannie@gmail.com" "acct-personal"

first_target="$(readlink "$current" 2>/dev/null || true)"
first_backup_hash="$(shasum -a 256 "$INSTALL_HOME/.local/bin/codex-with-fallback.bak" 2>/dev/null | awk '{print $1}')"
first_profile_backup_hash="$(shasum -a 256 "$INSTALL_HOME/.local/bin/codex-profile.bak" 2>/dev/null | awk '{print $1}')"
HOME="$INSTALL_HOME" /bin/bash "$INSTALLER" >"$ROOT/install2.stdout" 2>"$ROOT/install2.stderr"
second_target="$(readlink "$current" 2>/dev/null || true)"
second_backup_hash="$(shasum -a 256 "$INSTALL_HOME/.local/bin/codex-with-fallback.bak" 2>/dev/null | awk '{print $1}')"
second_profile_backup_hash="$(shasum -a 256 "$INSTALL_HOME/.local/bin/codex-profile.bak" 2>/dev/null | awk '{print $1}')"
if [[ -n "$first_target" && "$first_target" == "$second_target" \
  && "$first_backup_hash" == "$second_backup_hash" \
  && "$first_profile_backup_hash" == "$second_profile_backup_hash" ]]; then
  pass "installer rerun is idempotent and never overwrites backup"
else
  fail "installer rerun is idempotent and never overwrites backup" "targets=$first_target/$second_target backups=$first_backup_hash/$second_backup_hash"
fi

echo "== installer advances current when the vendored bytes change =="
UPGRADE_REPO="$ROOT/upgrade-repo"
UPGRADE_HOME="$ROOT/upgrade-home"
mkdir -p "$UPGRADE_REPO/scripts/lib" \
  "$UPGRADE_REPO/packages/claude-runner/bin" \
  "$UPGRADE_REPO/packages/claude-runner/agents" "$UPGRADE_HOME"
cp "$INSTALLER" "$UPGRADE_REPO/scripts/install-codex-guard.sh"
cp "$REPO_ROOT/scripts/codex-with-fallback.sh" "$UPGRADE_REPO/scripts/codex-with-fallback.sh"
cp "$REPO_ROOT/scripts/lib/codex-guard.sh" "$UPGRADE_REPO/scripts/lib/codex-guard.sh"
cp "$REPO_ROOT/packages/claude-runner/bin/flywheel-codex-profile.mjs" \
  "$REPO_ROOT/packages/claude-runner/bin/codex-account-core.mjs" \
  "$REPO_ROOT/packages/claude-runner/bin/codex-account-core.d.mts" \
  "$UPGRADE_REPO/packages/claude-runner/bin/"
cp "$REPO_ROOT/packages/claude-runner/agents/codex-account-registry.json" \
  "$UPGRADE_REPO/packages/claude-runner/agents/"
HOME="$UPGRADE_HOME" /bin/bash "$UPGRADE_REPO/scripts/install-codex-guard.sh" \
  >"$ROOT/upgrade-v1.stdout" 2>"$ROOT/upgrade-v1.stderr"
upgrade_current="$UPGRADE_HOME/.flywheel/libexec/codex-guard/current"
upgrade_v1_target="$(readlink "$upgrade_current" 2>/dev/null || true)"
cat > "$UPGRADE_REPO/scripts/codex-with-fallback.sh" <<'EOF'
#!/usr/bin/env bash
printf 'upgrade-v2\n'
EOF
chmod +x "$UPGRADE_REPO/scripts/codex-with-fallback.sh"
upgrade_rc=0
HOME="$UPGRADE_HOME" /bin/bash "$UPGRADE_REPO/scripts/install-codex-guard.sh" \
  >"$ROOT/upgrade-v2.stdout" 2>"$ROOT/upgrade-v2.stderr" || upgrade_rc=$?
upgrade_v2_target="$(readlink "$upgrade_current" 2>/dev/null || true)"
upgrade_exec="$(HOME="$UPGRADE_HOME" "$UPGRADE_HOME/.local/bin/codex-with-fallback" 2>/dev/null || true)"
upgrade_residue="$(find "$UPGRADE_HOME/.flywheel/libexec/codex-guard/releases" \
  -mindepth 2 -maxdepth 2 -name '.current-*' -print -quit 2>/dev/null)"
if [[ "$upgrade_rc" == "0" && -n "$upgrade_v1_target" && -n "$upgrade_v2_target" \
  && "$upgrade_v1_target" != "$upgrade_v2_target" && "$upgrade_exec" == "upgrade-v2" \
  && -z "$upgrade_residue" ]]; then
  pass "a second install atomically advances current and executes the new release"
else
  fail "a second install atomically advances current and executes the new release" \
    "rc=$upgrade_rc targets=$upgrade_v1_target/$upgrade_v2_target exec=$upgrade_exec residue=${upgrade_residue:-none} stderr=$(cat "$ROOT/upgrade-v2.stderr" 2>/dev/null)"
fi

mkdir -p "$INSTALL_HOME/.codex/profiles/only"
cat > "$ROOT/bin/codex" <<'EOF'
#!/usr/bin/env bash
printf 'fixed-target-ok\n'
EOF
cat > "$ROOT/bin/codex-profile" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  status) printf 'Active profile: only\n' ;;
  next|use) exit 0 ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$ROOT/bin/codex" "$ROOT/bin/codex-profile"
rc=0
env -i HOME="$INSTALL_HOME" PATH="$ROOT/bin:/usr/bin:/bin" \
  FLYWHEEL_STATE_DIR="$ROOT/conflicting-general-state" \
  "$INSTALL_HOME/.local/bin/codex-with-fallback" exec --json - \
  >"$ROOT/fixed-target.stdout" 2>"$ROOT/fixed-target.stderr" || rc=$?
if [[ "$rc" == "0" && "$(cat "$ROOT/fixed-target.stdout" 2>/dev/null)" == "fixed-target-ok" ]]; then
  pass "global shim keeps its install-time absolute target despite ambient FLYWHEEL_STATE_DIR"
else
  fail "global shim keeps its install-time absolute target despite ambient FLYWHEEL_STATE_DIR" \
    "rc=$rc stderr=$(cat "$ROOT/fixed-target.stderr" 2>/dev/null)"
fi

disable_sentinel="$INSTALL_HOME/.flywheel/libexec/codex-guard/DISABLED"
touch "$disable_sentinel"
rm -f "$INSTALL_HOME/.local/bin/codex-profile"
HOME="$INSTALL_HOME" /bin/bash "$INSTALLER" >"$ROOT/install-disabled.stdout" 2>"$ROOT/install-disabled.stderr"
HOME="$INSTALL_HOME" FLYWHEEL_DIR="$REPO_ROOT" /bin/bash -c '
  source "$FLYWHEEL_DIR/scripts/lib/converge-nonlead-daemons.sh"
  converge_nonlead_daemons
' >"$ROOT/converge-disabled.stdout" 2>"$ROOT/converge-disabled.stderr"
if [[ "$(cat "$INSTALL_HOME/.local/bin/codex-with-fallback" 2>/dev/null)" == "legacy-wrapper" \
  && -e "$disable_sentinel" ]] \
  && grep -q '^# FLYWHEEL_CODEX_PROFILE_MANAGED_SHIM=1$' \
    "$INSTALL_HOME/.local/bin/codex-profile"; then
  pass "disable sentinel restores only guard and still converges truthful profile"
else
  fail "disable sentinel restores only guard and still converges truthful profile" \
    "shim=$(cat "$INSTALL_HOME/.local/bin/codex-with-fallback" 2>/dev/null || echo missing)"
fi
rm -f "$disable_sentinel"
HOME="$INSTALL_HOME" /bin/bash "$INSTALLER" >"$ROOT/install-reenabled.stdout" 2>"$ROOT/install-reenabled.stderr"
if [[ -x "$INSTALL_HOME/.local/bin/codex-with-fallback" ]] \
  && grep -q 'stable wrapper is missing' "$INSTALL_HOME/.local/bin/codex-with-fallback"; then
  pass "removing the disable sentinel explicitly re-enables the managed shim"
else
  fail "removing the disable sentinel explicitly re-enables the managed shim" "managed shim was not restored"
fi

FRESH_DISABLE_HOME="$ROOT/fresh-disable-home"
HOME="$FRESH_DISABLE_HOME" /bin/bash "$INSTALLER" \
  >"$ROOT/fresh-disable-install.stdout" 2>"$ROOT/fresh-disable-install.stderr"
# A fresh host has no legacy wrapper. The unconditional same-SHA convergence
# runs this installer repeatedly before an operator may need DISABLED; a
# generated managed shim must never become its own emergency backup.
HOME="$FRESH_DISABLE_HOME" /bin/bash "$INSTALLER" \
  >"$ROOT/fresh-disable-reinstall.stdout" 2>"$ROOT/fresh-disable-reinstall.stderr"
fresh_disable_sentinel="$FRESH_DISABLE_HOME/.flywheel/libexec/codex-guard/DISABLED"
touch "$fresh_disable_sentinel"
fresh_disable_rc=0
HOME="$FRESH_DISABLE_HOME" /bin/bash "$INSTALLER" \
  >"$ROOT/fresh-disable.stdout" 2>"$ROOT/fresh-disable.stderr" || fresh_disable_rc=$?
fresh_disable_exec="$(env -i HOME="$FRESH_DISABLE_HOME" PATH="$ROOT/bin:/usr/bin:/bin" \
  "$FRESH_DISABLE_HOME/.local/bin/codex-with-fallback" exec --json - 2>/dev/null || true)"
if [[ "$fresh_disable_rc" == "0" && "$fresh_disable_exec" == "fixed-target-ok" \
  && ! -e "$FRESH_DISABLE_HOME/.local/bin/codex-with-fallback.bak" ]]; then
  pass "disable sentinel publishes a passthrough when no legacy backup exists"
else
  fail "disable sentinel publishes a passthrough when no legacy backup exists" \
    "rc=$fresh_disable_rc exec=$fresh_disable_exec stderr=$(cat "$ROOT/fresh-disable.stderr" 2>/dev/null)"
fi

CONTAMINATED_DISABLE_HOME="$ROOT/contaminated-disable-home"
HOME="$CONTAMINATED_DISABLE_HOME" /bin/bash "$INSTALLER" \
  >"$ROOT/contaminated-install.stdout" 2>"$ROOT/contaminated-install.stderr"
cp "$CONTAMINATED_DISABLE_HOME/.local/bin/codex-with-fallback" \
  "$CONTAMINATED_DISABLE_HOME/.local/bin/codex-with-fallback.bak"
touch "$CONTAMINATED_DISABLE_HOME/.flywheel/libexec/codex-guard/DISABLED"
contaminated_disable_rc=0
HOME="$CONTAMINATED_DISABLE_HOME" /bin/bash "$INSTALLER" \
  >"$ROOT/contaminated-disable.stdout" 2>"$ROOT/contaminated-disable.stderr" \
  || contaminated_disable_rc=$?
if [[ "$contaminated_disable_rc" == "0" ]] \
  && grep -Fq 'exec codex "$@"' \
    "$CONTAMINATED_DISABLE_HOME/.local/bin/codex-with-fallback"; then
  pass "disable ignores a contaminated managed-shim backup from an older installer"
else
  fail "disable ignores a contaminated managed-shim backup from an older installer" \
    "rc=$contaminated_disable_rc shim=$(cat "$CONTAMINATED_DISABLE_HOME/.local/bin/codex-with-fallback" 2>/dev/null || echo missing)"
fi

installed_wrapper="$current/codex-with-fallback.sh"
mv "$installed_wrapper" "$installed_wrapper.missing"
rm -f "$ROOT/codex.invoked"
rc=0
env -i HOME="$INSTALL_HOME" PATH="$ROOT/bin:/usr/bin:/bin" \
  "$INSTALL_HOME/.local/bin/codex-with-fallback" exec --json - \
  >"$ROOT/missing-install.stdout" 2>"$ROOT/missing-install.stderr" || rc=$?
mv "$installed_wrapper.missing" "$installed_wrapper"
if [[ "$rc" == "125" && ! -e "$ROOT/codex.invoked" ]] \
  && grep -q '^\[codex-guard\] INSTALL_ERROR ' "$ROOT/missing-install.stderr"; then
  pass "stable shim fails closed when its release is incomplete"
else
  fail "stable shim fails closed when its release is incomplete" \
    "rc=$rc invoked=$([[ -e "$ROOT/codex.invoked" ]] && echo yes || echo no)"
fi

current_release="$INSTALL_HOME/.flywheel/libexec/codex-guard/$first_target"
touch -t 202001010000 "$current_release"
for fixture_hash in \
  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb \
  cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc \
  dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd; do
  fixture_release="$INSTALL_HOME/.flywheel/libexec/codex-guard/releases/$fixture_hash"
  mkdir "$fixture_release"
  printf 'fixture\n' > "$fixture_release/codex-with-fallback.sh"
  printf 'fixture\n' > "$fixture_release/codex-guard.sh"
done
legacy_residue_release="$INSTALL_HOME/.flywheel/libexec/codex-guard/releases/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
ln -s 'releases/obsolete' "$legacy_residue_release/.current-legacy"
touch -t 201901010000 "$legacy_residue_release"
HOME="$INSTALL_HOME" /bin/bash "$INSTALLER" >"$ROOT/install-retention.stdout" 2>"$ROOT/install-retention.stderr"
release_count="$(find "$INSTALL_HOME/.flywheel/libexec/codex-guard/releases" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
if [[ -x "$current/codex-with-fallback.sh" && "$release_count" == "3" \
  && ! -e "$legacy_residue_release" ]]; then
  pass "retention preserves current plus two previous releases and cleans legacy current-link residue"
else
  fail "retention preserves current plus two previous releases and cleans legacy current-link residue" \
    "current_ok=$([[ -x "$current/codex-with-fallback.sh" ]] && echo yes || echo no) releases=$release_count residue=$([[ -e "$legacy_residue_release" ]] && echo yes || echo no)"
fi

echo "== unconditional daemon convergence repairs same-SHA install drift =="
CONVERGE_HOME="$ROOT/converge-home"
mkdir -p "$CONVERGE_HOME"
converge_rc=0
HOME="$CONVERGE_HOME" FLYWHEEL_DIR="$REPO_ROOT" /bin/bash -c '
  source "$FLYWHEEL_DIR/scripts/lib/converge-nonlead-daemons.sh"
  converge_nonlead_daemons
' >"$ROOT/converge.stdout" 2>"$ROOT/converge.stderr" || converge_rc=$?
if [[ "$converge_rc" == "0" \
  && -x "$CONVERGE_HOME/.local/bin/codex-with-fallback" \
  && -L "$CONVERGE_HOME/.flywheel/libexec/codex-guard/current" ]]; then
  pass "unconditional convergence installs the guard without a build"
else
  fail "unconditional convergence installs the guard without a build" "rc=$converge_rc stderr=$(cat "$ROOT/converge.stderr" 2>/dev/null)"
fi

rm -f "$CONVERGE_HOME/.local/bin/codex-with-fallback"
HOME="$CONVERGE_HOME" FLYWHEEL_DIR="$REPO_ROOT" /bin/bash -c '
  source "$FLYWHEEL_DIR/scripts/lib/converge-nonlead-daemons.sh"
  converge_nonlead_daemons
' >/dev/null 2>"$ROOT/converge2.stderr"
if [[ -x "$CONVERGE_HOME/.local/bin/codex-with-fallback" ]]; then
  pass "same-SHA convergence repairs a deleted global shim"
else
  fail "same-SHA convergence repairs a deleted global shim" "stderr=$(cat "$ROOT/converge2.stderr" 2>/dev/null)"
fi

echo "== long-lived runner daemon loses tee without gaining a timeout =="
DAEMON_WRAPPER="$REPO_ROOT/packages/claude-runner/bin/flywheel-codex-with-fallback"
ADAPTER="$REPO_ROOT/packages/claude-runner/src/CodexTmuxAdapter.ts"
if ! grep -qE '> *>*\(tee|\btee\b' "$DAEMON_WRAPPER"; then
  pass "daemon wrapper spawns no tee process"
else
  fail "daemon wrapper spawns no tee process" "tee remains"
fi
if grep -q 'FLY-1887 DO-NOT-TIMEOUT' "$DAEMON_WRAPPER" \
  && ! grep -qE 'codex_guard_run|FLYWHEEL_CODEX_(TOTAL|ATTEMPT)_TIMEOUT_SECONDS' "$DAEMON_WRAPPER" \
  && grep -q 'codexBin: flywheelCodexBin()' "$ADAPTER"; then
  pass "daemon path remains explicitly outside the one-shot timeout"
else
  fail "daemon path remains explicitly outside the one-shot timeout" "sentinel or adapter boundary missing"
fi

rm -f "$ROOT/daemon-profile-actions"
cat > "$ROOT/bin/codex-profile" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$ROOT/daemon-profile-actions"
exit 0
EOF
cat > "$ROOT/bin/codex" <<'EOF'
#!/usr/bin/env bash
printf 'daemon-stdout\n'
printf 'daemon-stderr\n' >&2
exit 23
EOF
chmod +x "$ROOT/bin/codex-profile" "$ROOT/bin/codex"
daemon_rc=0
env -i HOME="$ROOT/home" PATH="$ROOT/bin:/usr/bin:/bin" \
  /bin/bash "$DAEMON_WRAPPER" app-server --remote-control \
  >"$ROOT/daemon.stdout" 2>"$ROOT/daemon.stderr" || daemon_rc=$?
if [[ "$daemon_rc" == "23" \
  && "$(cat "$ROOT/daemon.stdout" 2>/dev/null)" == "daemon-stdout" \
  && "$(cat "$ROOT/daemon.stderr" 2>/dev/null)" == "daemon-stderr" \
  && ! -e "$ROOT/daemon-profile-actions" ]]; then
  pass "daemon wrapper is a direct stream/exit-code passthrough with no profile caller"
else
  fail "daemon wrapper is a direct stream/exit-code passthrough with no profile caller" \
    "rc=$daemon_rc stdout=$(cat "$ROOT/daemon.stdout" 2>/dev/null) stderr=$(cat "$ROOT/daemon.stderr" 2>/dev/null) profile=$(cat "$ROOT/daemon-profile-actions" 2>/dev/null || echo none)"
fi

if ! grep -Eq 'codex-profile[[:space:]]+(next|use)|account-rotation-notify' \
  "$WRAPPER" "$DAEMON_WRAPPER"; then
  pass "Codex fallback sources contain no automatic profile or rotation notifier caller"
else
  fail "Codex fallback sources contain no automatic profile or rotation notifier caller" "caller remains"
fi

printf '\n[codex-guard] passed=%s failed=%s\n' "$PASSED" "$FAILED"
[[ "$FAILED" -eq 0 ]]
