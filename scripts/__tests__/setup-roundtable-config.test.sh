#!/usr/bin/env bash
# FLY-569: hermetic tests for scripts/setup-roundtable-config.sh.
# The helper writes the SHARED NON-TOKEN routing file ~/.flywheel/roundtable.json
# (channelId ONLY). It must: validate a strict Discord snowflake, be idempotent,
# never overwrite a DIFFERENT channel id silently (fail loud), and never write a
# secret. These tests run fully hermetically via FLYWHEEL_ENV_FILE + --out.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1 — $2"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HELPER="${SCRIPT_DIR}/../setup-roundtable-config.sh"
[[ -f "$HELPER" ]] || { echo "[TEST] ✗ helper not found: $HELPER"; exit 1; }

RT="1512578695468941333"      # valid 17-digit snowflake
RT2="1485787271192907816"     # a DIFFERENT valid snowflake

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/setup-rt.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

# Helper to run the script with a hermetic source .env + out path. Clears any
# inherited FLYWHEEL_ROUNDTABLE_CHANNEL_ID unless explicitly passed.
run_helper() { # <env_file> <out_file> [extra args...]
  local envf="$1" outf="$2"; shift 2
  env -u FLYWHEEL_ROUNDTABLE_CHANNEL_ID \
    FLYWHEEL_ENV_FILE="$envf" \
    bash "$HELPER" --out "$outf" "$@"
}

# ── 1. happy path: channel from .env → writes channelId-only JSON ─────────────
ENVF="$ROOT/env1"; OUTF="$ROOT/out1.json"
printf 'BELLE_BOT_TOKEN=super-secret\nFLYWHEEL_ROUNDTABLE_CHANNEL_ID=%s\n' "$RT" > "$ENVF"
if run_helper "$ENVF" "$OUTF" >/dev/null 2>&1; then
  got=$(jq -r '.channelId' "$OUTF" 2>/dev/null)
  keys=$(jq -r 'keys | join(",")' "$OUTF" 2>/dev/null)
  if [[ "$got" == "$RT" && "$keys" == "channelId" ]]; then
    pass "writes channelId-only JSON from .env"
  else
    fail "writes channelId-only JSON" "got=$got keys=$keys"
  fi
else
  fail "writes channelId-only JSON" "helper exited non-zero"
fi

# ── 2. NEVER writes a secret (token in .env must not leak) ────────────────────
# Guard on file existence first — a missing file would make `grep` trivially
# "pass" (Codex code review R1#2 false-positive).
if [[ -f "$OUTF" ]] && ! grep -qiE 'secret|token|BOT_TOKEN' "$OUTF"; then
  pass "output file contains no secret/token"
else
  fail "output file contains no secret" "$([[ -f "$OUTF" ]] && cat "$OUTF" || echo "(file missing)")"
fi

# ── 3. idempotent: re-run with same id → no-op, file byte-identical ───────────
before=$(cat "$OUTF");
if run_helper "$ENVF" "$OUTF" >/dev/null 2>&1 && [[ "$(cat "$OUTF")" == "$before" ]]; then
  pass "idempotent re-run is a no-op"
else
  fail "idempotent re-run" "file changed or exit non-zero"
fi

# ── 4. stale guard: existing file with DIFFERENT id → fail loud, no overwrite ─
printf '{"channelId":"%s"}' "$RT2" > "$OUTF"
if run_helper "$ENVF" "$OUTF" >/dev/null 2>&1; then
  fail "stale-id fail-loud" "helper succeeded but should have failed"
else
  # must NOT have overwritten the existing (different) file
  if [[ "$(jq -r '.channelId' "$OUTF")" == "$RT2" ]]; then
    pass "different existing id → fail loud, no overwrite"
  else
    fail "stale-id no overwrite" "file was overwritten to $(cat "$OUTF")"
  fi
fi

# ── 5. --force overrides the stale guard ─────────────────────────────────────
if run_helper "$ENVF" "$OUTF" --force >/dev/null 2>&1 && [[ "$(jq -r '.channelId' "$OUTF")" == "$RT" ]]; then
  pass "--force overwrites a different existing id"
else
  fail "--force overwrite" "did not overwrite to $RT"
fi

# ── 6. env var FLYWHEEL_ROUNDTABLE_CHANNEL_ID wins over .env ──────────────────
ENVF2="$ROOT/env2"; OUTF2="$ROOT/out2.json"
printf 'FLYWHEEL_ROUNDTABLE_CHANNEL_ID=%s\n' "$RT2" > "$ENVF2"
if FLYWHEEL_ENV_FILE="$ENVF2" FLYWHEEL_ROUNDTABLE_CHANNEL_ID="$RT" bash "$HELPER" --out "$OUTF2" >/dev/null 2>&1 \
  && [[ "$(jq -r '.channelId' "$OUTF2")" == "$RT" ]]; then
  pass "env channel id wins over .env"
else
  fail "env wins" "got $(jq -r '.channelId' "$OUTF2" 2>/dev/null)"
fi

# ── 7. snowflake reject: non-numeric value → fail loud, no write ──────────────
OUTF3="$ROOT/out3.json"; rm -f "$OUTF3"
if env -u FLYWHEEL_ROUNDTABLE_CHANNEL_ID FLYWHEEL_ENV_FILE=/dev/null \
     FLYWHEEL_ROUNDTABLE_CHANNEL_ID="not-a-snowflake" bash "$HELPER" --out "$OUTF3" >/dev/null 2>&1; then
  fail "snowflake reject" "accepted a non-snowflake"
else
  [[ ! -f "$OUTF3" ]] && pass "non-snowflake → fail loud, no file written" \
    || fail "snowflake reject" "wrote a file anyway"
fi

# ── 8. quoted value in .env → fail loud (not a bare snowflake) ────────────────
ENVF4="$ROOT/env4"; OUTF4="$ROOT/out4.json"; rm -f "$OUTF4"
printf 'FLYWHEEL_ROUNDTABLE_CHANNEL_ID="%s"\n' "$RT" > "$ENVF4"
if run_helper "$ENVF4" "$OUTF4" >/dev/null 2>&1; then
  fail "quoted value reject" "accepted a quoted value"
else
  pass "quoted .env value → fail loud"
fi

# ── 9. duplicated .env definition → fail loud (ambiguous) ─────────────────────
ENVF5="$ROOT/env5"; OUTF5="$ROOT/out5.json"; rm -f "$OUTF5"
printf 'FLYWHEEL_ROUNDTABLE_CHANNEL_ID=%s\nFLYWHEEL_ROUNDTABLE_CHANNEL_ID=%s\n' "$RT" "$RT2" > "$ENVF5"
if run_helper "$ENVF5" "$OUTF5" >/dev/null 2>&1; then
  fail "duplicate reject" "accepted a duplicated definition"
else
  pass "duplicated .env definition → fail loud"
fi

# ── 10. missing channel id entirely → fail loud, no empty file ────────────────
ENVF6="$ROOT/env6"; OUTF6="$ROOT/out6.json"; rm -f "$OUTF6"
printf 'BELLE_BOT_TOKEN=x\n' > "$ENVF6"
if run_helper "$ENVF6" "$OUTF6" >/dev/null 2>&1; then
  fail "missing channel reject" "succeeded with no channel id"
else
  [[ ! -f "$OUTF6" ]] && pass "no channel id → fail loud, no empty file" \
    || fail "missing channel reject" "wrote a file anyway"
fi

# ── 11. portability: runs under /bin/bash (macOS system Bash 3.2) for .env path ─
# Directly exercises the .env extraction loop on the system bash that
# `#!/usr/bin/env bash` may select. Catches Bash-4-only builtins (e.g. mapfile).
ENVF7="$ROOT/env7"; OUTF7="$ROOT/out7.json"; rm -f "$OUTF7"
printf 'FLYWHEEL_ROUNDTABLE_CHANNEL_ID=%s\n' "$RT" > "$ENVF7"
if [[ -x /bin/bash ]]; then
  if env -u FLYWHEEL_ROUNDTABLE_CHANNEL_ID FLYWHEEL_ENV_FILE="$ENVF7" \
       /bin/bash "$HELPER" --out "$OUTF7" >/dev/null 2>&1 \
     && [[ "$(jq -r '.channelId' "$OUTF7" 2>/dev/null)" == "$RT" ]]; then
    pass "runs under /bin/bash (system Bash) for .env extraction"
  else
    fail "/bin/bash .env extraction" "did not write $RT ($(/bin/bash --version | head -1))"
  fi
else
  pass "skip /bin/bash portability probe (no /bin/bash)"
fi

echo ""
echo "[TEST] $PASSED passed, $FAILED failed"
[[ "$FAILED" -eq 0 ]]
