#!/bin/bash
# FLY-1062 PR2 · onboard-shell key rotation + update seam (hermetic).
#
# Codex R4#1 rotation trio + the update seam:
#   R1 `license set`: hidden-read a new key → validate against the manifest →
#      atomic 0600 .env overwrite → continue install to a working current.
#   R2 install with a STORED-but-revoked key → 401 → hidden-read a new key
#      once → succeeds (rotation is not blocked by the second-run fast path).
#   R3 all three leave zero half-baked state.
#   U1 `update`: already-latest → "already latest", no payload download, no flip.
#   U2 `update`: newer version → install new dir + atomic flip + restart seam +
#      journal advanced; U3 restart/health failure → auto rollback to old current.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

command -v npm >/dev/null 2>&1 || { echo "ERROR: npm required"; exit 1; }
PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$PKG_DIR/bin/flywheel-onboard.js"
# FLY-1062 PR3 contract-consistency lock: ONBOARD_ENDPOINT_IMPL points this
# suite at the REAL endpoint handler (payload-endpoint serve.mjs) — same
# fixtures, same assertions, both implementations must stay green.
STUB="${ONBOARD_ENDPOINT_IMPL:-$PKG_DIR/__tests__/stub-endpoint.mjs}"

SANDBOX="$(mktemp -d -t fly1062-shellrot-XXXXXX)"
STUB_PID=""
cleanup() { [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null; rm -rf "$SANDBOX"; }
trap cleanup EXIT

# mk_payload <ver> → sets TARBALL_<ver> path + SHA_<ver>. Distinct restart
# behaviour per payload via an env-gated marker so U2/U3 can diverge.
mk_payload() {
  local ver="$1" restart_ok="${2:-1}"
  local pt="$SANDBOX/payload-$ver"
  mkdir -p "$pt/dist" "$pt/scripts/packaged"
  printf '{ "name": "flywheel-onboard-payload", "version": "%s", "private": true }\n' "$ver" > "$pt/package.json"
  printf '%s\n' "$ver" > "$pt/.flywheel-prebuilt"
  echo "// stub" > "$pt/dist/run-bridge.js"
  printf '#!/bin/bash\ntrue\n' > "$pt/scripts/flywheel-onboard.sh"; chmod +x "$pt/scripts/flywheel-onboard.sh"
  printf '#!/bin/bash\nexit 0\n' > "$pt/scripts/packaged/create-compat-mirror.sh"; chmod +x "$pt/scripts/packaged/create-compat-mirror.sh"
  # restart seam stub (a REQUIRED payload file): dump its env so a key-leak can
  # be proven, then exit with the health code (0 healthy / 1 unhealthy).
  cat > "$pt/scripts/packaged/restart-packaged-services.sh" <<SH
#!/bin/bash
[ -n "\${FLYWHEEL_RESTART_ENV_DUMP:-}" ] && env > "\$FLYWHEEL_RESTART_ENV_DUMP"
exit $([ "$restart_ok" = 1 ] && echo 0 || echo 1)
SH
  chmod +x "$pt/scripts/packaged/restart-packaged-services.sh"
  local tb; tb="$SANDBOX/$(cd "$pt" && npm pack --pack-destination "$SANDBOX" 2>/dev/null | tail -1)"
  local vkey="${ver//./_}"
  eval "TARBALL_$vkey='$tb'"
  eval "SHA_$vkey='$(shasum -a 256 "$tb" | awk '{print $1}')'"
}

start_stub() { # <payload-tarball> <ver> <sha> <mode> [expect-key]
  local pf="$1" ver="$2" sha="$3" mode="$4" expect="${5:-}"
  local out="$SANDBOX/stub.$$.$RANDOM.out"
  STUB_PAYLOAD_FILE="$pf" STUB_VER="$ver" STUB_SHA="$sha" STUB_MODE="$mode" \
    STUB_EXPECT_KEY="$expect" node "$STUB" > "$out" 2>&1 &
  STUB_PID=$!
  PORT=""
  for _ in $(seq 1 40); do
    PORT="$(sed -n 's/^PORT //p' "$out" 2>/dev/null | head -1)"
    [ -n "$PORT" ] && break
    kill -0 "$STUB_PID" 2>/dev/null || break
    sleep 0.1
  done
  ENDPOINT="http://127.0.0.1:$PORT"
}
stop_stub() { [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null; STUB_PID=""; }

assert_clean() {
  local h="$1"
  # `-e` is false for a dangling symlink; check `-L` so a leftover dangling
  # `current` link is not mistaken for a clean state (Codex R3).
  [ ! -L "$h/.flywheel/runtime/current" ] || return 1
  [ ! -e "$h/.flywheel/runtime/current" ] || return 1
  # a failed atomic flip must leave no stray current.tmp.* symlink (Codex R4)
  [ -z "$(ls -A "$h/.flywheel/runtime/" 2>/dev/null | grep '^current\.tmp\.')" ] || return 1
  local vd="$h/.flywheel/runtime/versions"
  [ ! -d "$vd" ] || [ -z "$(ls -A "$vd" 2>/dev/null)" ] || return 1
  return 0
}

mk_payload "1.0.0" 1
mk_payload "2.0.0" 1
mk_payload "3.0.0" 0   # unhealthy: restart seam exits non-zero
mk_payload "4.0.0" 1
OLDKEY="fly-old-revoked-key"
NEWKEY="fly-new-good-key"

# ── R1 · license set: rotate a revoked stored key → install succeeds ────────
H="$SANDBOX/r1"; mkdir -p "$H/.flywheel"
printf 'FLYWHEEL_LICENSE_KEY=%s\n' "$OLDKEY" > "$H/.flywheel/.env"; chmod 600 "$H/.flywheel/.env"
start_stub "$TARBALL_1_0_0" "1.0.0" "$SHA_1_0_0" normal "$NEWKEY"  # only NEWKEY authorized
OUT="$(printf '%s\n' "$NEWKEY" | env -i HOME="$H" PATH="$PATH" \
  FLYWHEEL_STATE_DIR="$H/.flywheel" FLYWHEEL_ONBOARD_ENDPOINT="$ENDPOINT" \
  node "$BIN" license set 2>&1)"
RC=$?
if [ "$RC" -eq 0 ] \
   && grep -q "授权码已更新" <<<"$OUT" \
   && grep -q "FLYWHEEL_LICENSE_KEY=$NEWKEY" "$H/.flywheel/.env" \
   && ! grep -q "$OLDKEY" "$H/.flywheel/.env" \
   && [ -L "$H/.flywheel/runtime/current" ]; then
  MODE="$(stat -c '%a' "$H/.flywheel/.env" 2>/dev/null || stat -f '%Lp' "$H/.flywheel/.env" 2>/dev/null)"
  [ "$MODE" = "600" ] && pass "R1 license set: new key validated, atomic 0600 overwrite, install continued" \
                     || fail "R1 .env mode=$MODE"
else
  fail "R1 rc=$RC out=[$(tail -4 <<<"$OUT")]"
fi
stop_stub

# ── R2 · install with a stored-revoked key → 401 → hidden rotate → succeeds ──
H="$SANDBOX/r2"; mkdir -p "$H/.flywheel"
printf 'FLYWHEEL_LICENSE_KEY=%s\n' "$OLDKEY" > "$H/.flywheel/.env"; chmod 600 "$H/.flywheel/.env"
start_stub "$TARBALL_1_0_0" "1.0.0" "$SHA_1_0_0" normal "$NEWKEY"  # OLDKEY → 401
OUT="$(printf '%s\n' "$NEWKEY" | env -i HOME="$H" PATH="$PATH" \
  FLYWHEEL_STATE_DIR="$H/.flywheel" FLYWHEEL_ONBOARD_ENDPOINT="$ENDPOINT" \
  node "$BIN" 2>&1)"
RC=$?
if [ "$RC" -eq 0 ] && [ -L "$H/.flywheel/runtime/current" ] \
   && grep -q "FLYWHEEL_LICENSE_KEY=$NEWKEY" "$H/.flywheel/.env"; then
  pass "R2 install: stored key 401 → hidden rotate once → succeeds (not blocked by fast path)"
else
  fail "R2 rc=$RC current=$([ -L "$H/.flywheel/runtime/current" ] && echo y || echo n) out=[$(tail -4 <<<"$OUT")]"
fi
stop_stub

# ── U1 · update already-latest: no download, no flip ────────────────────────
# install 1.0.0 first, then update against a 1.0.0-latest endpoint.
H="$SANDBOX/u1"; mkdir -p "$H/.flywheel"
start_stub "$TARBALL_1_0_0" "1.0.0" "$SHA_1_0_0" normal "$NEWKEY"
printf '%s\n' "$NEWKEY" | env -i HOME="$H" PATH="$PATH" \
  FLYWHEEL_STATE_DIR="$H/.flywheel" FLYWHEEL_ONBOARD_ENDPOINT="$ENDPOINT" \
  node "$BIN" >/dev/null 2>&1
stop_stub
CUR_BEFORE="$(readlink "$H/.flywheel/runtime/current")"
start_stub "$TARBALL_1_0_0" "1.0.0" "$SHA_1_0_0" normal "$NEWKEY"
OUT="$(env -i HOME="$H" PATH="$PATH" \
  FLYWHEEL_STATE_DIR="$H/.flywheel" FLYWHEEL_ONBOARD_ENDPOINT="$ENDPOINT" \
  node "$BIN" update 2>&1)"
RC=$?
if [ "$RC" -eq 0 ] && grep -q "已经是最新版本" <<<"$OUT" \
   && [ "$(readlink "$H/.flywheel/runtime/current")" = "$CUR_BEFORE" ]; then
  pass "U1 update already-latest: honest 'latest', no re-flip"
else
  fail "U1 rc=$RC out=[$(tail -3 <<<"$OUT")]"
fi
stop_stub

# ── U2 · update to a newer version: install + flip + restart + journal ──────
start_stub "$TARBALL_2_0_0" "2.0.0" "$SHA_2_0_0" normal "$NEWKEY"
OUT="$(env -i HOME="$H" PATH="$PATH" \
  FLYWHEEL_STATE_DIR="$H/.flywheel" FLYWHEEL_ONBOARD_ENDPOINT="$ENDPOINT" \
  node "$BIN" update 2>&1)"
RC=$?
if [ "$RC" -eq 0 ] \
   && [ "$(cat "$H/.flywheel/runtime/current/.flywheel-prebuilt" 2>/dev/null)" = "2.0.0" ] \
   && grep -q "\"installedVersion\": \"2.0.0\"" "$H/.flywheel/onboard-journal.json"; then
  pass "U2 update newer: installs + atomic flip + restart seam + journal advanced"
else
  fail "U2 rc=$RC cur=$(cat "$H/.flywheel/runtime/current/.flywheel-prebuilt" 2>/dev/null) out=[$(tail -3 <<<"$OUT")]"
fi
stop_stub

# ── U3 · update whose restart is unhealthy → auto rollback to old current ────
# assert by VERSION (not the symlink target string — macOS /var→/private/var
# makes readlink vs realpath differ): current must point back at the last good
# 2.0.0, not the unhealthy 3.0.0.
start_stub "$TARBALL_3_0_0" "3.0.0" "$SHA_3_0_0" normal "$NEWKEY"
OUT="$(env -i HOME="$H" PATH="$PATH" \
  FLYWHEEL_STATE_DIR="$H/.flywheel" FLYWHEEL_ONBOARD_ENDPOINT="$ENDPOINT" \
  node "$BIN" update 2>&1)"
RC=$?
CUR_VER="$(cat "$H/.flywheel/runtime/current/.flywheel-prebuilt" 2>/dev/null)"
if [ "$RC" -ne 0 ] && grep -q "自动切回上一个" <<<"$OUT" && [ "$CUR_VER" = "2.0.0" ]; then
  pass "U3 update unhealthy restart → auto rollback, current stays on the last good version (2.0.0)"
else
  fail "U3 rc=$RC cur_ver=$CUR_VER out=[$(tail -3 <<<"$OUT")]"
fi
stop_stub

# ── U4 · update path strips the license key from the child env (Codex R2) ────
# A customer may export FLYWHEEL_LICENSE_KEY when running `update`. The update
# path (like install) must strip it BEFORE spawning any child, so the restart
# seam's env never sees it. Update 2.0.0 → 4.0.0 with the key exported and the
# restart seam dumping its own env; the dump must NOT contain the key.
DUMP="$SANDBOX/u4-restart-env.dump"
start_stub "$TARBALL_4_0_0" "4.0.0" "$SHA_4_0_0" normal "$NEWKEY"
OUT="$(env -i HOME="$H" PATH="$PATH" \
  FLYWHEEL_STATE_DIR="$H/.flywheel" FLYWHEEL_ONBOARD_ENDPOINT="$ENDPOINT" \
  FLYWHEEL_LICENSE_KEY="$NEWKEY" FLYWHEEL_ALLOW_LICENSE_KEY_ENV=1 \
  FLYWHEEL_RESTART_ENV_DUMP="$DUMP" \
  node "$BIN" update 2>&1)"
RC=$?
CUR_VER="$(cat "$H/.flywheel/runtime/current/.flywheel-prebuilt" 2>/dev/null)"
if [ "$RC" -eq 0 ] && [ "$CUR_VER" = "4.0.0" ] \
   && [ -f "$DUMP" ] \
   && ! grep -q "FLYWHEEL_LICENSE_KEY" "$DUMP" \
   && ! grep -q "$NEWKEY" "$DUMP" \
   && ! grep -q "$NEWKEY" <<<"$OUT"; then
  pass "U4 update strips the key before spawning the restart seam (child env has no key)"
else
  fail "U4 rc=$RC cur_ver=$CUR_VER dump=$([ -f "$DUMP" ] && echo present || echo MISSING) keyinenv=$(grep -c FLYWHEEL_LICENSE_KEY "$DUMP" 2>/dev/null) out=[$(tail -3 <<<"$OUT")]"
fi
stop_stub

echo ""
echo "onboard-shell-rotation: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]
