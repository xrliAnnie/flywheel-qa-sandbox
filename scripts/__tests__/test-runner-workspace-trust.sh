#!/usr/bin/env bash
# FLY-1961: isolated contract tests for the dual-vendor QA trust helper.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="${SCRIPT_DIR}/../lib/runner-workspace-trust.sh"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/fly1961-workspace-trust.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

PASS=0
pass() { PASS=$((PASS + 1)); printf '  PASS: %s\n' "$1"; }
fail() { printf '  FAIL: %s\n' "$1" >&2; exit 1; }

mode_of() {
  local mode
  mode="$(stat -f %Lp "$1" 2>/dev/null)" \
    && [[ -n "$mode" && "$mode" != *[!0-7]* ]] \
    && printf '%s\n' "$mode" \
    && return 0
  stat -c %a "$1"
}

assert_codex_trust() {
  python3 - "$1" "$2" <<'PY'
import sys, tomllib
with open(sys.argv[1], "rb") as handle:
    config = tomllib.load(handle)
assert config["projects"][sys.argv[2]]["trust_level"] == "trusted"
PY
}

assert_codex_absent() {
  python3 - "$1" "$2" <<'PY'
import sys, tomllib
with open(sys.argv[1], "rb") as handle:
    config = tomllib.load(handle)
assert sys.argv[2] not in config.get("projects", {})
PY
}

run_helper() {
  local case_root="$1"; shift
  HOME="${case_root}/home" \
  FLYWHEEL_CLAUDE_JSON="${case_root}/home/.claude.json" \
  FLYWHEEL_CODEX_SOURCE_HOME="${case_root}/home/.codex" \
  bash "$HELPER" "$@"
}

echo "Test: dual-vendor workspace trust helper (FLY-1961)"

# ── dual write, escaping, mode preservation, and idempotence ────────────────
CASE1="$ROOT/case1"
mkdir -p "$CASE1/home/.codex" "$CASE1/slot with space"
TARGET1="$CASE1/slot with space/project-\"FLY\"-1961"
printf '{"keep":{"nested":1}}\n' > "$CASE1/home/.claude.json"
printf 'model = "gpt-5-codex"\n' > "$CASE1/home/.codex/config.toml"
chmod 644 "$CASE1/home/.claude.json" "$CASE1/home/.codex/config.toml"
CANON1="$(cd "$(dirname "$TARGET1")" && pwd -P)/$(basename "$TARGET1")"
OUT1="$(run_helper "$CASE1" pretrust-dual "$TARGET1")"
[[ "$OUT1" == "$CANON1" ]] || fail "pretrust-dual stdout is not canonical path"
jq -e --arg p "$CANON1" '.keep.nested == 1 and .projects[$p].hasTrustDialogAccepted == true' \
  "$CASE1/home/.claude.json" >/dev/null || fail "Claude trust missing/preservation failed"
assert_codex_trust "$CASE1/home/.codex/config.toml" "$CANON1" \
  || fail "Codex escaped trust missing"
[[ "$(mode_of "$CASE1/home/.claude.json")" == "644" ]] \
  || fail "Claude file mode changed"
[[ "$(mode_of "$CASE1/home/.codex/config.toml")" == "644" ]] \
  || fail "Codex file mode changed"
SHA1="$(shasum -a 256 "$CASE1/home/.claude.json" "$CASE1/home/.codex/config.toml")"
OUT1B="$(run_helper "$CASE1" pretrust-dual "$TARGET1")"
[[ "$OUT1B" == "$CANON1" ]] || fail "idempotent stdout changed"
[[ "$(shasum -a 256 "$CASE1/home/.claude.json" "$CASE1/home/.codex/config.toml")" == "$SHA1" ]] \
  || fail "idempotent run rewrote trust state"
pass "dual write is canonical, escaped, mode-preserving, and idempotent"

# ── GNU stat accepts -f but emits filesystem text; reject it and use -c ────
CASE_MODE="$ROOT/case-mode"
mkdir -p "$CASE_MODE/bin"
touch "$CASE_MODE/state"
cat > "$CASE_MODE/bin/stat" <<'STAT'
#!/usr/bin/env bash
if [[ "$1" == "-f" ]]; then
  printf 'filesystem report\n640\n'
  exit 0
fi
if [[ "$1" == "-c" ]]; then
  printf '640\n'
  exit 0
fi
exit 2
STAT
chmod +x "$CASE_MODE/bin/stat"
MODE_RESULT="$(PATH="$CASE_MODE/bin:$PATH" bash -c '
  source "$1"
  runner_workspace_trust_file_mode "$2" 600
' _ "$HELPER" "$CASE_MODE/state")"
[[ "$MODE_RESULT" == "640" ]] || fail "GNU stat fallback returned invalid mode: $MODE_RESULT"
pass "file mode probe validates BSD output before GNU fallback"

# ── GNU stat -f output is never interpreted as a lock timestamp ─────────────
CASE_MTIME="$ROOT/case-mtime"
mkdir -p "$CASE_MTIME/bin" "$CASE_MTIME/held.lock"
cat > "$CASE_MTIME/bin/stat" <<'STAT'
#!/usr/bin/env bash
if [[ "$1" == "-f" ]]; then
  printf '  File: "held.lock"\nfilesystem metadata\n'
  exit 0
fi
if [[ "$1" == "-c" && "$2" == "%Y" ]]; then
  printf '1\n'
  exit 0
fi
exit 2
STAT
chmod +x "$CASE_MTIME/bin/stat"
if MTIME_RESULT="$(PATH="$CASE_MTIME/bin:$PATH" CLAUDE_LOCK_STALE_S=0 CLAUDE_LOCK_WAIT_S=1 \
  bash -c '
    set -u
    source "$1"
    runner_workspace_trust_acquire_lock "$2" "test"
    runner_workspace_trust_release_lock "$2"
    printf recovered
  ' _ "$HELPER" "$CASE_MTIME/held.lock" 2>&1)"; then
  [[ "$MTIME_RESULT" == *recovered ]] \
    || fail "GNU stat mtime fallback did not recover the stale lock: $MTIME_RESULT"
else
  fail "GNU stat filesystem output reached lock timestamp arithmetic: $MTIME_RESULT"
fi
pass "lock mtime probe validates BSD output before GNU fallback"

# ── invalid source bytes never get overwritten ─────────────────────────────
CASE2="$ROOT/case2"
mkdir -p "$CASE2/home/.codex" "$CASE2/slot"
printf '{not-json' > "$CASE2/home/.claude.json"
printf 'model = "ok"\n' > "$CASE2/home/.codex/config.toml"
BEFORE2="$(shasum -a 256 "$CASE2/home/.claude.json")"
if run_helper "$CASE2" pretrust-dual "$CASE2/slot/project" >/dev/null 2>&1; then
  fail "invalid Claude JSON was accepted"
fi
[[ "$(shasum -a 256 "$CASE2/home/.claude.json")" == "$BEFORE2" ]] \
  || fail "invalid Claude JSON bytes changed"

printf '{}\n' > "$CASE2/home/.claude.json"
printf '[broken\n' > "$CASE2/home/.codex/config.toml"
BEFORE2T="$(shasum -a 256 "$CASE2/home/.codex/config.toml")"
if run_helper "$CASE2" pretrust-dual "$CASE2/slot/project" >/dev/null 2>&1; then
  fail "invalid Codex TOML was accepted"
fi
[[ "$(shasum -a 256 "$CASE2/home/.codex/config.toml")" == "$BEFORE2T" ]] \
  || fail "invalid Codex TOML bytes changed"
pass "invalid JSON/TOML fail loud without overwriting source bytes"

# ── an existing non-trusted target is governance, never overwritten ────────
CASE3="$ROOT/case3"
mkdir -p "$CASE3/home/.codex" "$CASE3/slot"
TARGET3="$CASE3/slot/project"
CANON3="$(cd "$(dirname "$TARGET3")" && pwd -P)/$(basename "$TARGET3")"
printf '{}\n' > "$CASE3/home/.claude.json"
python3 - "$CASE3/home/.codex/config.toml" "$CANON3" <<'PY'
import json, sys
with open(sys.argv[1], "w", encoding="utf-8") as handle:
    handle.write(f'[projects.{json.dumps(sys.argv[2])}]\ntrust_level = "untrusted"\n')
PY
BEFORE3="$(shasum -a 256 "$CASE3/home/.codex/config.toml")"
if run_helper "$CASE3" pretrust-dual "$TARGET3" >/dev/null 2>&1; then
  fail "existing untrusted Codex target was overwritten"
fi
[[ "$(shasum -a 256 "$CASE3/home/.codex/config.toml")" == "$BEFORE3" ]] \
  || fail "untrusted Codex config bytes changed"
pass "existing untrusted Codex target fails closed"

# ── two processes retain both vendor entries under shared mkdir locks ───────
CASE4="$ROOT/case4"
mkdir -p "$CASE4/home/.codex" "$CASE4/slots"
printf '{}\n' > "$CASE4/home/.claude.json"
printf 'model = "gpt-5-codex"\n' > "$CASE4/home/.codex/config.toml"
run_helper "$CASE4" pretrust-dual "$CASE4/slots/a" > "$CASE4/a.out" & PIDA=$!
run_helper "$CASE4" pretrust-dual "$CASE4/slots/b" > "$CASE4/b.out" & PIDB=$!
wait "$PIDA"; wait "$PIDB"
CANONA="$(cat "$CASE4/a.out")"; CANONB="$(cat "$CASE4/b.out")"
jq -e --arg a "$CANONA" --arg b "$CANONB" \
  '.projects[$a].hasTrustDialogAccepted == true and .projects[$b].hasTrustDialogAccepted == true' \
  "$CASE4/home/.claude.json" >/dev/null || fail "concurrent Claude entries were dropped"
assert_codex_trust "$CASE4/home/.codex/config.toml" "$CANONA" || fail "Codex entry a dropped"
assert_codex_trust "$CASE4/home/.codex/config.toml" "$CANONB" || fail "Codex entry b dropped"
pass "parallel writers retain both Claude and Codex entries"

# ── explicit Claude lock + stale bare locks are recovered ──────────────────
CASE5="$ROOT/case5"
mkdir -p "$CASE5/home/.codex" "$CASE5/slot" "$CASE5/explicit.lock" \
  "$CASE5/home/.codex/config.toml.lock"
printf '{}\n' > "$CASE5/home/.claude.json"
printf 'model = "gpt-5-codex"\n' > "$CASE5/home/.codex/config.toml"
python3 - "$CASE5/explicit.lock" "$CASE5/home/.codex/config.toml.lock" <<'PY'
import os, sys, time
old = time.time() - 120
for path in sys.argv[1:]:
    os.utime(path, (old, old))
PY
HOME="$CASE5/home" FLYWHEEL_CLAUDE_JSON="$CASE5/home/.claude.json" \
FLYWHEEL_CLAUDE_JSON_LOCK="$CASE5/explicit.lock" \
FLYWHEEL_CODEX_SOURCE_HOME="$CASE5/home/.codex" \
CLAUDE_LOCK_STALE_S=1 bash "$HELPER" pretrust-dual "$CASE5/slot/project" >/dev/null
[[ ! -e "$CASE5/explicit.lock" && ! -e "$CASE5/home/.codex/config.toml.lock" ]] \
  || fail "stale locks were not released"
pass "explicit/stale bare locks recover under the shared protocol"

# ── prune canonicalizes a symlink prefix and isolates slot 1 from slot 10 ──
CASE6="$ROOT/case6"
mkdir -p "$CASE6/home/.codex" "$CASE6/real-slots/slot-1" "$CASE6/real-slots/slot-10"
ln -s "$CASE6/real-slots" "$CASE6/link-slots"
printf '{}\n' > "$CASE6/home/.claude.json"
printf '[projects."/unmanaged"]\ntrust_level = "trusted"\n' > "$CASE6/home/.codex/config.toml"
P1="$(run_helper "$CASE6" pretrust-dual "$CASE6/link-slots/slot-1/project")"
P10="$(run_helper "$CASE6" pretrust-dual "$CASE6/link-slots/slot-10/project")"
run_helper "$CASE6" prune-codex-prefix "$CASE6/link-slots/slot-1" >/dev/null
assert_codex_absent "$CASE6/home/.codex/config.toml" "$P1" || fail "canonical slot-1 entry retained"
assert_codex_trust "$CASE6/home/.codex/config.toml" "$P10" || fail "slot-10 entry over-pruned"
assert_codex_trust "$CASE6/home/.codex/config.toml" "/unmanaged" || fail "unmanaged entry over-pruned"
pass "managed prune resolves symlinks and keeps slot-10/unmanaged state"

# ── the behavioral suite itself must ride a literal CI step ────────────────────
CI_FILE="${SCRIPT_DIR}/../../.github/workflows/ci.yml"
if grep -qF 'bash scripts/__tests__/test-runner-workspace-trust.sh' "$CI_FILE"; then
  pass "dual-vendor helper suite is explicitly enumerated in CI"
else
  fail "dual-vendor helper suite is not enumerated in CI"
fi

printf '\nRESULT: %s passed, 0 failed\n' "$PASS"
