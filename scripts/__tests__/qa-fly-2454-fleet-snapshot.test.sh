#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SNAPSHOT="$SCRIPT_DIR/qa-fly-2454-fleet-snapshot.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

mkdir -p "$TEST_ROOT/bin"
cat > "$TEST_ROOT/bin/ps" <<'SH'
#!/usr/bin/env bash
cat <<'OUT'
  30    40       00:02 /opt/two/codex app-server --remote-control --listen unix:///zeta/codex.sock
  10    20       03:04 /opt/one/codex app-server --listen=unix:///alpha/codex.sock
  50    60       00:01 /usr/bin/node unrelated.js --listen unix:///noise.sock
OUT
SH
cat > "$TEST_ROOT/bin/tmux" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$QA_FLY2454_TMUX_ARGS"
cat <<'OUT'
zeta|@9|later
alpha|@2|first
OUT
SH
cat > "$TEST_ROOT/bin/id" <<'SH'
#!/usr/bin/env bash
[[ "${1:-}" == "-u" ]] || exit 2
printf '501\n'
SH
chmod +x "$TEST_ROOT/bin/ps" "$TEST_ROOT/bin/tmux" "$TEST_ROOT/bin/id"

EXPECTED="$TEST_ROOT/expected.txt"
cat > "$EXPECTED" <<'EOF'
[codex-app-servers]
/alpha/codex.sock
/zeta/codex.sock
[tmux-windows]
alpha|@2|first
zeta|@9|later
EOF

OUT="$TEST_ROOT/snapshot.txt"
QA_FLY2454_TMUX_ARGS="$TEST_ROOT/tmux.args"
export QA_FLY2454_TMUX_ARGS
rc=0
PATH="$TEST_ROOT/bin:/usr/bin:/bin" "$SNAPSHOT" --out "$OUT" \
  >"$TEST_ROOT/stdout" 2>"$TEST_ROOT/stderr" || rc=$?

if [[ "$rc" == "0" ]] \
    && cmp -s "$EXPECTED" "$OUT" \
    && [[ "$(cat "$QA_FLY2454_TMUX_ARGS" 2>/dev/null)" \
      == "-S /private/tmp/tmux-501/default list-windows -a -F #{session_name}|#{window_id}|#{window_name}" ]] \
    && [[ ! -s "$TEST_ROOT/stdout" ]]; then
  printf 'PASS: stable Codex socket and production tmux sections are sorted byte-for-byte\n'
else
  printf 'FAIL: snapshot contract mismatch rc=%s stderr=[%s]\n' \
    "$rc" "$(cat "$TEST_ROOT/stderr" 2>/dev/null)" >&2
  diff -u "$EXPECTED" "$OUT" 2>/dev/null || true
  exit 1
fi
