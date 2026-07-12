#!/bin/bash
# FLY-1062 PR2 · onboard-shell failure paths (hermetic).
#
# Every failure gives an honest plain-words message AND leaves ZERO
# half-baked state — no version dir, no current symlink, exit non-zero:
#   N1 invalid / revoked key (401)        → keyInvalid message
#   N2 tampered payload (sha256 mismatch) → checksum message
#   N3 network failure (endpoint down)    → network message
#   N4 env-injected key WITHOUT the double switch → rejected + still no install
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

SANDBOX="$(mktemp -d -t fly1062-shellneg-XXXXXX)"
STUB_PID=""
cleanup() { [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null; rm -rf "$SANDBOX"; }
trap cleanup EXIT

# fixture payload (same shape as the install test)
VER="1.2.3"
PT="$SANDBOX/payload-src"; mkdir -p "$PT/dist" "$PT/scripts/packaged"
printf '{ "name": "flywheel-onboard-payload", "version": "%s", "private": true }\n' "$VER" > "$PT/package.json"
printf '%s\n' "$VER" > "$PT/.flywheel-prebuilt"
echo "// stub" > "$PT/dist/run-bridge.js"
printf '#!/bin/bash\ntrue\n' > "$PT/scripts/flywheel-onboard.sh"; chmod +x "$PT/scripts/flywheel-onboard.sh"
printf '#!/bin/bash\nexit 0\n' > "$PT/scripts/packaged/create-compat-mirror.sh"; chmod +x "$PT/scripts/packaged/create-compat-mirror.sh"
printf '#!/bin/bash\nexit 0\n' > "$PT/scripts/packaged/restart-packaged-services.sh"; chmod +x "$PT/scripts/packaged/restart-packaged-services.sh"
TARBALL="$SANDBOX/$(cd "$PT" && npm pack --pack-destination "$SANDBOX" 2>/dev/null | tail -1)"
SHA="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
KEY="fly-live-key-ABC123xyz"

start_stub() { # <mode> <sha-to-advertise> [expect-key]
  local mode="$1" sha="$2" expect="${3:-}"
  local out="$SANDBOX/stub.$$.$RANDOM.out"
  STUB_PAYLOAD_FILE="$TARBALL" STUB_VER="$VER" STUB_SHA="$sha" STUB_MODE="$mode" \
    STUB_EXPECT_KEY="$expect" \
    node "$STUB" > "$out" 2>&1 &
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

# run_install <home> <endpoint> [extra-env...] → sets OUT / RC
run_install() {
  local h="$1" ep="$2"; shift 2
  OUT="$(env -i HOME="$h" PATH="$PATH" \
    FLYWHEEL_STATE_DIR="$h/.flywheel" FLYWHEEL_ONBOARD_ENDPOINT="$ep" \
    "$@" node "$BIN" 2>&1)"
  RC=$?
}

# assert_clean <home> — no version dir, no current symlink (zero half-baked).
# `-e` follows the link and is FALSE for a dangling symlink, so a leftover
# dangling `current` would slip past it — check `-L` too (Codex R3).
assert_clean() {
  local h="$1"
  [ ! -L "$h/.flywheel/runtime/current" ] || return 1
  [ ! -e "$h/.flywheel/runtime/current" ] || return 1
  # a failed atomic flip must leave no stray current.tmp.* symlink (Codex R4)
  [ -z "$(ls -A "$h/.flywheel/runtime/" 2>/dev/null | grep '^current\.tmp\.')" ] || return 1
  local vd="$h/.flywheel/runtime/versions"
  [ ! -d "$vd" ] || [ -z "$(ls -A "$vd" 2>/dev/null)" ] || return 1
  return 0
}

# ── N1 · invalid / revoked key → 401 ────────────────────────────────────────
start_stub unauthorized "$SHA"
H="$SANDBOX/n1"; mkdir -p "$H"
run_install "$H" "$ENDPOINT" FLYWHEEL_LICENSE_KEY="wrong-key" FLYWHEEL_ALLOW_LICENSE_KEY_ENV=1
if [ "$RC" -ne 0 ] && grep -q "授权码不对" <<<"$OUT" && assert_clean "$H"; then
  pass "N1 invalid/revoked key → honest keyInvalid message, zero half-baked"
else
  fail "N1 rc=$RC clean=$(assert_clean "$H" && echo y || echo n) out=[$OUT]"
fi
stop_stub

# ── N2 · tampered payload (sha mismatch) ────────────────────────────────────
start_stub corrupt "$SHA" "$KEY"
H="$SANDBOX/n2"; mkdir -p "$H"
run_install "$H" "$ENDPOINT" FLYWHEEL_LICENSE_KEY="$KEY" FLYWHEEL_ALLOW_LICENSE_KEY_ENV=1
if [ "$RC" -ne 0 ] && grep -q "校验没通过" <<<"$OUT" && assert_clean "$H"; then
  pass "N2 tampered payload → checksum message, zero half-baked"
else
  fail "N2 rc=$RC clean=$(assert_clean "$H" && echo y || echo n) out=[$OUT]"
fi
stop_stub

# ── N3 · network failure (endpoint down) ────────────────────────────────────
# point at a port nothing listens on
H="$SANDBOX/n3"; mkdir -p "$H"
run_install "$H" "http://127.0.0.1:1" FLYWHEEL_LICENSE_KEY="$KEY" FLYWHEEL_ALLOW_LICENSE_KEY_ENV=1
if [ "$RC" -ne 0 ] && grep -q "连不上安装服务器" <<<"$OUT" && assert_clean "$H"; then
  pass "N3 network failure → network message, zero half-baked"
else
  fail "N3 rc=$RC clean=$(assert_clean "$H" && echo y || echo n) out=[$OUT]"
fi

# ── N4 · env key WITHOUT the double switch is rejected ──────────────────────
start_stub normal "$SHA" "$KEY"
H="$SANDBOX/n4"; mkdir -p "$H"
# key in env but NO FLYWHEEL_ALLOW_LICENSE_KEY_ENV=1; stdin is /dev/null so the
# hidden prompt gets EOF → empty key → no install. The env key must be ignored.
run_install "$H" "$ENDPOINT" FLYWHEEL_LICENSE_KEY="$KEY" </dev/null
if [ "$RC" -ne 0 ] && grep -q "没有开启对应的开关" <<<"$OUT" && assert_clean "$H"; then
  pass "N4 env key without double switch → rejected + no install"
else
  fail "N4 rc=$RC clean=$(assert_clean "$H" && echo y || echo n) out=[$OUT]"
fi
stop_stub

# ── N5 · path-traversal version in the manifest is refused (Codex R1#2) ──────
# a hostile/corrupt `latest: ".."` must be rejected at the boundary, never used
# as a filesystem path / rmSync target. versionPrefix(cfg, "..") would resolve
# to the runtime root — an unguarded install→rmSync(prefix) would DELETE the
# runtime tree. Pre-seed a sentinel inside runtime/ and prove it survives.
H="$SANDBOX/n5"; mkdir -p "$H/.flywheel/runtime/versions"
SENTINEL="$H/.flywheel/runtime/keep-me.txt"; echo "do-not-delete" > "$SENTINEL"
OUT_N5="$SANDBOX/n5-stub.out"
STUB_PAYLOAD_FILE="$TARBALL" STUB_VER=".." STUB_SHA="$SHA" STUB_MODE="normal" STUB_EXPECT_KEY="$KEY" \
  node "$STUB" > "$OUT_N5" 2>&1 &
STUB_PID=$!
PORT=""; for _ in $(seq 1 40); do PORT="$(sed -n 's/^PORT //p' "$OUT_N5" 2>/dev/null | head -1)"; [ -n "$PORT" ] && break; kill -0 "$STUB_PID" 2>/dev/null || break; sleep 0.1; done
run_install "$H" "http://127.0.0.1:$PORT" FLYWHEEL_LICENSE_KEY="$KEY" FLYWHEEL_ALLOW_LICENSE_KEY_ENV=1
# PORT non-empty is REQUIRED (Codex R2): if the stub never bound a port the
# endpoint is unreachable and rc!=0 would be a NETWORK failure — a false green.
# With a live stub + valid payload the only path to rc!=0 is the version guard.
# refused (rc != 0), zero half-baked (no current, versions still empty), and the
# runtime sentinel MUST survive — proving ".." never became an rmSync target.
if [ -n "$PORT" ] && [ "$RC" -ne 0 ] && assert_clean "$H" && [ -f "$SENTINEL" ]; then
  pass "N5 path-traversal manifest version refused, runtime sentinel intact (no traversal rmSync)"
else
  fail "N5 port=$PORT rc=$RC clean=$(assert_clean "$H" && echo y || echo n) sentinel=$([ -f "$SENTINEL" ] && echo kept || echo DELETED) out=[$OUT]"
fi
stop_stub

# ── N6 · incomplete payload (missing required script) is refused (Codex R1#3) ─
H="$SANDBOX/n6"; mkdir -p "$H"
BADPT="$SANDBOX/bad-payload"; mkdir -p "$BADPT/dist"   # NO scripts/ at all
printf '{ "name": "flywheel-onboard-payload", "version": "%s", "private": true }\n' "$VER" > "$BADPT/package.json"
printf '%s\n' "$VER" > "$BADPT/.flywheel-prebuilt"
echo "// stub" > "$BADPT/dist/run-bridge.js"   # has run-bridge but NO flywheel-onboard.sh
BADTB="$SANDBOX/$(cd "$BADPT" && npm pack --pack-destination "$SANDBOX" 2>/dev/null | tail -1)"
[ -f "$BADTB" ] || { fail "N6 fixture npm pack failed (no tarball)"; BADTB=""; }
BADSHA="$(shasum -a 256 "$BADTB" 2>/dev/null | awk '{print $1}')"
OUT_N6="$SANDBOX/n6-stub.out"
STUB_PAYLOAD_FILE="$BADTB" STUB_VER="$VER" STUB_SHA="$BADSHA" STUB_MODE="normal" STUB_EXPECT_KEY="$KEY" \
  node "$STUB" > "$OUT_N6" 2>&1 &
STUB_PID=$!
PORT=""; for _ in $(seq 1 40); do PORT="$(sed -n 's/^PORT //p' "$OUT_N6" 2>/dev/null | head -1)"; [ -n "$PORT" ] && break; kill -0 "$STUB_PID" 2>/dev/null || break; sleep 0.1; done
run_install "$H" "http://127.0.0.1:$PORT" FLYWHEEL_LICENSE_KEY="$KEY" FLYWHEEL_ALLOW_LICENSE_KEY_ENV=1
# PORT non-empty REQUIRED (Codex R2): with a live stub + matching sha the only
# path to rc!=0 is verifyPkgRoot refusing the incomplete tree — an empty PORT
# would make this pass on a network failure instead.
if [ -n "$BADTB" ] && [ -n "$PORT" ] && [ "$RC" -ne 0 ] && assert_clean "$H"; then
  pass "N6 incomplete payload (missing required script) refused at install, zero half-baked (not promoted to current)"
else
  fail "N6 tb=$([ -n "$BADTB" ] && echo ok || echo MISSING) port=$PORT rc=$RC clean=$(assert_clean "$H" && echo y || echo n) out=[$OUT]"
fi
stop_stub

# ── N7 · unknown arg is NOT echoed (a mistyped key must not leak; Codex R1#6) ─
H="$SANDBOX/n7"; mkdir -p "$H"
MISTYPED_KEY="fly-SECRET-mistyped-as-arg-777"
OUT_N7="$(env -i HOME="$H" PATH="$PATH" FLYWHEEL_STATE_DIR="$H/.flywheel" \
  node "$BIN" "$MISTYPED_KEY" 2>&1)"; RC7=$?
if [ "$RC7" -ne 0 ] && ! grep -q "$MISTYPED_KEY" <<<"$OUT_N7"; then
  pass "N7 unknown argument (mistyped key) never echoed back to the terminal"
else
  fail "N7 rc=$RC7 leaked=$(grep -q "$MISTYPED_KEY" <<<"$OUT_N7" && echo YES || echo no) out=[$OUT_N7]"
fi

# ── N8 · payload missing ONLY the restart seam is refused (Codex R2) ─────────
# Everything present EXCEPT scripts/packaged/restart-packaged-services.sh — the
# update seam that restarts services onto new code. Without it a version can be
# flipped to current but never actually restart, so verifyPkgRoot must refuse
# it at install (distinct from N6, which is missing every script).
H="$SANDBOX/n8"; mkdir -p "$H"
NORESTART="$SANDBOX/norestart-payload"; mkdir -p "$NORESTART/dist" "$NORESTART/scripts/packaged"
printf '{ "name": "flywheel-onboard-payload", "version": "%s", "private": true }\n' "$VER" > "$NORESTART/package.json"
printf '%s\n' "$VER" > "$NORESTART/.flywheel-prebuilt"
echo "// stub" > "$NORESTART/dist/run-bridge.js"
printf '#!/bin/bash\ntrue\n' > "$NORESTART/scripts/flywheel-onboard.sh"; chmod +x "$NORESTART/scripts/flywheel-onboard.sh"
printf '#!/bin/bash\nexit 0\n' > "$NORESTART/scripts/packaged/create-compat-mirror.sh"; chmod +x "$NORESTART/scripts/packaged/create-compat-mirror.sh"
# deliberately NO restart-packaged-services.sh
NRTB="$SANDBOX/$(cd "$NORESTART" && npm pack --pack-destination "$SANDBOX" 2>/dev/null | tail -1)"
[ -f "$NRTB" ] || { fail "N8 fixture npm pack failed (no tarball)"; NRTB=""; }
NRSHA="$(shasum -a 256 "$NRTB" 2>/dev/null | awk '{print $1}')"
OUT_N8="$SANDBOX/n8-stub.out"
STUB_PAYLOAD_FILE="$NRTB" STUB_VER="$VER" STUB_SHA="$NRSHA" STUB_MODE="normal" STUB_EXPECT_KEY="$KEY" \
  node "$STUB" > "$OUT_N8" 2>&1 &
STUB_PID=$!
PORT=""; for _ in $(seq 1 40); do PORT="$(sed -n 's/^PORT //p' "$OUT_N8" 2>/dev/null | head -1)"; [ -n "$PORT" ] && break; kill -0 "$STUB_PID" 2>/dev/null || break; sleep 0.1; done
run_install "$H" "http://127.0.0.1:$PORT" FLYWHEEL_LICENSE_KEY="$KEY" FLYWHEEL_ALLOW_LICENSE_KEY_ENV=1
if [ -n "$NRTB" ] && [ -n "$PORT" ] && [ "$RC" -ne 0 ] && assert_clean "$H"; then
  pass "N8 payload missing only the restart seam refused at install, zero half-baked"
else
  fail "N8 tb=$([ -n "$NRTB" ] && echo ok || echo MISSING) port=$PORT rc=$RC clean=$(assert_clean "$H" && echo y || echo n) out=[$OUT]"
fi
stop_stub

echo ""
echo "onboard-shell-negatives: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]
