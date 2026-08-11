#!/usr/bin/env bash

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OPS_DIR="$REPO_ROOT/scripts/discord-plugin"
CHECKER="$OPS_DIR/check-discord-plugin.sh"
UPDATER="$OPS_DIR/update-discord-plugin.sh"
LEGACY_CHECKER="$OPS_DIR/check-discord-plugin-legacy-overlay.sh"
LEGACY_UPDATER="$OPS_DIR/update-discord-plugin-legacy-overlay.sh"
INSTALLER="$REPO_ROOT/scripts/install-discord-plugin-ops.sh"
MARKETPLACE="$REPO_ROOT/marketplaces/flywheel-plugins/.claude-plugin/marketplace.json"
PASSED=0
FAILED=0

pass() { PASSED=$((PASSED + 1)); printf '[TEST] ✓ %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf '[TEST] ✗ %s\n' "$1" >&2; }

SB="$(mktemp -d "${TMPDIR:-/tmp}/fly1676-discord-ops.XXXXXX")"
trap 'rm -rf "$SB"' EXIT
H="$SB/home"
CFG="$SB/config"
BIN="$SB/bin"
mkdir -p "$H" "$CFG/plugins" "$BIN"

REMOTE_SHA="1111111111111111111111111111111111111111"
NEXT_SHA="2222222222222222222222222222222222222222"
export REMOTE_SHA NEXT_SHA

cat > "$BIN/git" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "ls-remote" ]]; then
  [[ "${GIT_REMOTE_FAIL:-0}" != 1 ]] || exit 69
  printf '%s\trefs/heads/main\n' "${REMOTE_SHA:?}"
  exit 0
fi
exit 64
EOF

cat > "$BIN/ps" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == -p && "${2:-}" == 999999 ]]; then
  exit 1
fi
if [[ "${1:-}" == -p && "${3:-}" == -o && "${4:-}" == lstart= ]]; then
  printf 'Mon Aug 10 14:00:00 2026\n'
  exit 0
fi
exec /bin/ps "$@"
EOF

cat > "$BIN/mkdir" <<'EOF'
#!/usr/bin/env bash
last=""
for arg in "$@"; do last="$arg"; done
if [[ "$last" == */.breaker.* && -n "${LOCK_RACE_MARKER:-}" \
    && ! -e "$LOCK_RACE_MARKER" ]]; then
  : > "$LOCK_RACE_MARKER"
  lock_dir="${last%/.breaker.*}"
  /bin/rm -rf "$lock_dir"
  /bin/mkdir -p "$lock_dir"
  printf '12345|Mon Aug 10 14:00:00 2026\n' > "$lock_dir/owner"
fi
exec /bin/mkdir "$@"
EOF

cat > "$BIN/claude" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${CLAUDE_LOG:?}"
if [[ "$*" == "plugin marketplace update flywheel-plugins" ]]; then
  exit "${MARKETPLACE_UPDATE_RC:-0}"
fi
if [[ "$*" == "plugin update discord@flywheel-plugins --scope user" ]]; then
  sleep "${FAKE_CLAUDE_DELAY:-0}"
  if [[ "${UPDATE_MODE:-advance}" == "advance" ]]; then
    next_path="${CLAUDE_CONFIG_DIR}/plugins/cache/flywheel-plugins/discord/${NEXT_VERSION:-0.0.5}"
    mkdir -p "$next_path"
    printf 'allowBots\n[reply-guard]\nChatReceiptRuntime\n' > "$next_path/server.ts"
    python3 - "$CLAUDE_CONFIG_DIR/plugins/installed_plugins.json" "$next_path" <<'PY'
import json
import os
import sys
import tempfile

path, install_path = sys.argv[1:]
with open(path, encoding="utf-8") as handle:
    data = json.load(handle)
entry = data["plugins"]["discord@flywheel-plugins"][0]
entry["gitCommitSha"] = os.environ["NEXT_SHA"]
entry["version"] = os.environ.get("NEXT_VERSION", "0.0.5")
entry["installPath"] = install_path
fd, temporary = tempfile.mkstemp(dir=os.path.dirname(path))
with os.fdopen(fd, "w", encoding="utf-8") as handle:
    json.dump(data, handle)
    handle.flush()
    os.fsync(handle.fileno())
os.replace(temporary, path)
PY
  fi
  exit "${PLUGIN_UPDATE_RC:-0}"
fi
exit 65
EOF
chmod +x "$BIN/git" "$BIN/ps" "$BIN/mkdir" "$BIN/claude"

write_fixture() {
  local sha="$1" version="${2:-0.0.4}"
  local install_path="$CFG/plugins/cache/flywheel-plugins/discord/$version"
  mkdir -p "$install_path"
  printf 'allowBots\n[reply-guard]\nChatReceiptRuntime\n' > "$install_path/server.ts"
  jq -n \
    --arg sha "$sha" \
    --arg version "$version" \
    --arg path "$install_path" \
    '{version:2,plugins:{"discord@flywheel-plugins":[{scope:"user",version:$version,gitCommitSha:$sha,installPath:$path}]}}' \
    > "$CFG/plugins/installed_plugins.json"
}

run_check() {
  env HOME="$H" CLAUDE_CONFIG_DIR="$CFG" PATH="$BIN:/usr/bin:/bin" \
    bash "$CHECKER" "$@"
}

run_update() {
  env HOME="$H" CLAUDE_CONFIG_DIR="$CFG" PATH="$BIN:/usr/bin:/bin" \
    CLAUDE_LOG="$SB/claude.log" "$@" bash "$UPDATER"
}

for required in "$CHECKER" "$UPDATER" "$LEGACY_CHECKER" "$LEGACY_UPDATER" "$INSTALLER" "$MARKETPLACE"; do
  if [[ -e "$required" ]]; then
    pass "required artifact exists: ${required#"$REPO_ROOT"/}"
  else
    fail "required artifact exists: ${required#"$REPO_ROOT"/}"
  fi
done

if [[ -f "$MARKETPLACE" ]] \
  && jq -e '
    .name == "flywheel-plugins"
    and (.plugins | length == 1)
    and .plugins[0].name == "discord"
    and .plugins[0].source.source == "git-subdir"
    and .plugins[0].source.url == "https://github.com/xrliAnnie/claude-plugins-official.git"
    and .plugins[0].source.path == "external_plugins/discord"
    and .plugins[0].source.ref == "main"
  ' "$MARKETPLACE" >/dev/null; then
  pass "pointer marketplace has the exact fork/main git-subdir contract"
else
  fail "pointer marketplace has the exact fork/main git-subdir contract"
fi

if [[ -x "$CHECKER" ]]; then
  if [[ "$(run_check --print-contract 2>/dev/null)" == "discord@flywheel-plugins/v1" ]]; then
    pass "checker exposes the exact pointer-selection handshake without consulting the registry"
  else
    fail "checker exposes the exact pointer-selection handshake without consulting the registry"
  fi

  write_fixture "$REMOTE_SHA"
  if output="$(run_check --print-install-path 2>"$SB/check.err")" \
    && [[ "$output" == "$CFG/plugins/cache/flywheel-plugins/discord/0.0.4" ]]; then
    pass "checker accepts one exact user entry and prints its verified installPath"
  else
    fail "checker accepts one exact user entry and prints its verified installPath"
  fi

  if output="$(env HOME="$H" CLAUDE_CONFIG_DIR="$CFG" PATH="$BIN:/usr/bin:/bin" \
      GIT_REMOTE_FAIL=1 bash "$CHECKER" --print-install-path 2>"$SB/network.err")" \
      && [[ "$output" == "$CFG/plugins/cache/flywheel-plugins/discord/0.0.4" ]] \
      && grep -Fq 'remote freshness unavailable' "$SB/network.err"; then
    pass "checker accepts marker-verified local fork bytes during a remote outage"
  else
    fail "checker accepts marker-verified local fork bytes during a remote outage"
  fi

  write_fixture "$NEXT_SHA"
  if run_check >/dev/null 2>&1; then
    fail "checker rejects registry SHA drift from fork main"
  else
    pass "checker rejects registry SHA drift from fork main"
  fi

  write_fixture "$REMOTE_SHA"
  install_path="$(jq -r '.plugins["discord@flywheel-plugins"][0].installPath' "$CFG/plugins/installed_plugins.json")"
  printf 'allowBots only\n' > "$install_path/server.ts"
  if run_check >/dev/null 2>&1; then
    fail "checker rejects a partial fork missing reply-guard/receipt markers"
  else
    pass "checker rejects a partial fork missing reply-guard/receipt markers"
  fi
fi

if [[ -x "$UPDATER" && -x "$CHECKER" ]]; then
  : > "$SB/claude.log"
  write_fixture "$REMOTE_SHA"
  REMOTE_SHA="$NEXT_SHA"
  export REMOTE_SHA
  if run_update \
    && [[ "$(jq -r '.plugins["discord@flywheel-plugins"][0].gitCommitSha' "$CFG/plugins/installed_plugins.json")" == "$NEXT_SHA" ]] \
    && [[ "$(grep -c '^plugin marketplace update flywheel-plugins$' "$SB/claude.log")" == "1" ]] \
    && [[ "$(grep -c '^plugin update discord@flywheel-plugins --scope user$' "$SB/claude.log")" == "1" ]]; then
    pass "updater refreshes marketplace+plugin once and verifies the new SHA"
  else
    fail "updater refreshes marketplace+plugin once and verifies the new SHA"
  fi

  : > "$SB/claude.log"
  REMOTE_SHA="$NEXT_SHA"
  export REMOTE_SHA
  write_fixture "$REMOTE_SHA" "0.0.5"
  if run_update && [[ ! -s "$SB/claude.log" ]]; then
    pass "updater is a no-op when registry and fork main already agree"
  else
    fail "updater is a no-op when registry and fork main already agree"
  fi

  : > "$SB/claude.log"
  write_fixture "$REMOTE_SHA" "0.0.4"
  REMOTE_SHA="3333333333333333333333333333333333333333"
  NEXT_SHA="$REMOTE_SHA"
  export REMOTE_SHA NEXT_SHA
  run_update FAKE_CLAUDE_DELAY=1 >"$SB/update-a.log" 2>&1 & p1=$!
  run_update FAKE_CLAUDE_DELAY=1 >"$SB/update-b.log" 2>&1 & p2=$!
  rc1=0; rc2=0
  wait "$p1" || rc1=$?
  wait "$p2" || rc2=$?
  if (( rc1 == 0 && rc2 == 0 )) \
    && [[ "$(grep -c '^plugin marketplace update flywheel-plugins$' "$SB/claude.log")" == "1" ]] \
    && [[ "$(grep -c '^plugin update discord@flywheel-plugins --scope user$' "$SB/claude.log")" == "1" ]]; then
    pass "global lock serializes concurrent callers to exactly one CLI mutation"
  else
    fail "global lock serializes concurrent callers to exactly one CLI mutation"
  fi

  : > "$SB/claude.log"
  rm -rf "$H/.flywheel/discord-plugin-update.lock.d"
  mkdir -p "$H/.flywheel/discord-plugin-update.lock.d"
  printf '999999|definitely-dead\n' > "$H/.flywheel/discord-plugin-update.lock.d/owner"
  write_fixture "$REMOTE_SHA" "0.0.4"
  REMOTE_SHA="3434343434343434343434343434343434343434"
  NEXT_SHA="$REMOTE_SHA"
  export REMOTE_SHA NEXT_SHA
  if run_update FLYWHEEL_DISCORD_LOCK_WAIT_SECONDS=2 >"$SB/stale-lock.log" 2>&1 \
    && [[ "$(grep -c '^plugin update discord@flywheel-plugins --scope user$' "$SB/claude.log")" == "1" ]] \
    && [[ ! -d "$H/.flywheel/discord-plugin-update.lock.d" ]]; then
    pass "updater reclaims a lock whose recorded process incarnation is provably dead"
  else
    sed 's/^/[TEST]   /' "$SB/stale-lock.log" >&2
    printf '[TEST]   update_calls=%s lock_present=%s owner=%s\n' \
      "$(grep -c '^plugin update discord@flywheel-plugins --scope user$' "$SB/claude.log" 2>/dev/null || true)" \
      "$([[ -d "$H/.flywheel/discord-plugin-update.lock.d" ]] && echo yes || echo no)" \
      "$(cat "$H/.flywheel/discord-plugin-update.lock.d/owner" 2>/dev/null || echo none)" >&2
    fail "updater reclaims a lock whose recorded process incarnation is provably dead"
  fi

  : > "$SB/claude.log"
  rm -rf "$H/.flywheel/discord-plugin-update.lock.d"
  mkdir -p "$H/.flywheel/discord-plugin-update.lock.d"
  printf '999999|definitely-dead\n' > "$H/.flywheel/discord-plugin-update.lock.d/owner"
  rm -f "$SB/lock-race.marker"
  write_fixture "$REMOTE_SHA" "0.0.4"
  REMOTE_SHA="3535353535353535353535353535353535353535"
  NEXT_SHA="$REMOTE_SHA"
  export REMOTE_SHA NEXT_SHA
  if run_update FLYWHEEL_DISCORD_LOCK_WAIT_SECONDS=0 \
      LOCK_RACE_MARKER="$SB/lock-race.marker" >"$SB/lock-race.log" 2>&1; then
    fail "stale breaker preserves a successor lock acquired during inspection"
  elif [[ ! -s "$SB/claude.log" ]] \
      && [[ "$(cat "$H/.flywheel/discord-plugin-update.lock.d/owner" 2>/dev/null)" == "12345|Mon Aug 10 14:00:00 2026" ]]; then
    pass "stale breaker preserves a successor lock acquired during inspection"
  else
    fail "stale breaker preserves a successor lock acquired during inspection"
  fi
  rm -rf "$H/.flywheel/discord-plugin-update.lock.d"

  : > "$SB/claude.log"
  write_fixture "$REMOTE_SHA" "0.0.4"
  REMOTE_SHA="4444444444444444444444444444444444444444"
  NEXT_SHA="$REMOTE_SHA"
  export REMOTE_SHA NEXT_SHA
  if run_update UPDATE_MODE=stale >/dev/null 2>&1; then
    fail "updater fails closed when CLI reports success without advancing registry SHA"
  else
    pass "updater fails closed when CLI reports success without advancing registry SHA"
  fi
fi

if [[ -x "$INSTALLER" && -f "$MARKETPLACE" ]]; then
  INSTALL_HOME="$SB/install-home"
  mkdir -p "$INSTALL_HOME"
  REGISTRAR="$SB/registrar"
  cat > "$REGISTRAR" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" > "${REGISTRAR_LOG:?}"
EOF
  chmod 0644 "$REGISTRAR"
  if env HOME="$INSTALL_HOME" \
      FLYWHEEL_DISCORD_REGISTRAR="$REGISTRAR" \
      REGISTRAR_LOG="$SB/registrar.log" \
      bash "$INSTALLER" \
    && cmp -s "$CHECKER" "$INSTALL_HOME/.flywheel/bin/check-discord-plugin.sh" \
    && cmp -s "$UPDATER" "$INSTALL_HOME/.flywheel/bin/update-discord-plugin.sh" \
    && cmp -s "$LEGACY_CHECKER" "$INSTALL_HOME/.flywheel/bin/check-discord-plugin-legacy-overlay.sh" \
    && cmp -s "$LEGACY_UPDATER" "$INSTALL_HOME/.flywheel/bin/update-discord-plugin-legacy-overlay.sh" \
    && grep -Fq "flywheel-plugins $REPO_ROOT/marketplaces/flywheel-plugins" "$SB/registrar.log"; then
    pass "installer publishes scripts and invokes the tracked non-executable registrar through bash"
  else
    fail "installer publishes scripts and invokes the tracked non-executable registrar through bash"
  fi
fi

printf '\nResults: %d passed, %d failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
