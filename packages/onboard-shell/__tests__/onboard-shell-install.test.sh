#!/bin/bash
# FLY-1062 PR2 · onboard-shell install E2E (hermetic).
#
# The full customer install chain against a STUB gated endpoint + a fixture
# zero-dep payload tarball + REAL npm (installs ≠ boots is the bar):
#   A1 empty runtime → hidden-read key (env double-switch stands in for the TTY)
#      → header exchange → sha256 → npm install --prefix → compat mirror →
#      atomic current flip → exec onboard.sh; key persisted 0600; version in
#      the resume journal; the key NEVER appears on stdout.
#   A2 second run: current already complete → straight exec, no re-fetch, no
#      key prompt (stub endpoint receives ZERO requests).
#   A3 the key travelled ONLY in the Authorization header (never in a URL).
#
# temp-HOME + FLYWHEEL_STATE_DIR isolation; the stub endpoint runs on loopback.
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

SANDBOX="$(mktemp -d -t fly1062-shell-XXXXXX)"
STUB_PID=""
cleanup() { [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null; rm -rf "$SANDBOX"; }
trap cleanup EXIT

# ── fixture payload tarball: a zero-dep mini "PKG_ROOT" npm can install ───────
VER="1.2.3"
PT="$SANDBOX/payload-src"
mkdir -p "$PT/dist" "$PT/scripts/packaged"
cat > "$PT/package.json" <<EOF
{ "name": "flywheel-onboard-payload", "version": "$VER", "private": true }
EOF
printf '%s\n' "$VER" > "$PT/.flywheel-prebuilt"
echo "// stub bridge entry" > "$PT/dist/run-bridge.js"
# onboard.sh stub: prove the shell exec'd it (and that the key is NOT in env here)
cat > "$PT/scripts/flywheel-onboard.sh" <<'SH'
#!/bin/bash
echo "ONBOARD-HANDOFF" > "$FLYWHEEL_STATE_DIR/onboard-ran.marker"
echo "KEYSEEN=${FLYWHEEL_LICENSE_KEY:-<none>}" >> "$FLYWHEEL_STATE_DIR/onboard-ran.marker"
SH
chmod +x "$PT/scripts/flywheel-onboard.sh"
# compat-mirror stub: exit 0 (the real one is exercised by PR1's smoke)
cat > "$PT/scripts/packaged/create-compat-mirror.sh" <<'SH'
#!/bin/bash
exit 0
SH
chmod +x "$PT/scripts/packaged/create-compat-mirror.sh"
# restart seam stub: a REQUIRED payload file (verifyPkgRoot enforces it)
cat > "$PT/scripts/packaged/restart-packaged-services.sh" <<'SH'
#!/bin/bash
exit 0
SH
chmod +x "$PT/scripts/packaged/restart-packaged-services.sh"

TARBALL="$(cd "$PT" && npm pack --pack-destination "$SANDBOX" 2>/dev/null | tail -1)"
TARBALL="$SANDBOX/$TARBALL"
[ -f "$TARBALL" ] || { echo "ERROR: fixture npm pack failed"; exit 1; }
SHA="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"

# ── start the stub endpoint ──────────────────────────────────────────────────
KEY="fly-live-key-ABC123xyz"
KEYLOG="$SANDBOX/keylog.txt"
STUB_OUT="$SANDBOX/stub.out"
STUB_PAYLOAD_FILE="$TARBALL" STUB_VER="$VER" STUB_SHA="$SHA" STUB_MODE="normal" \
  STUB_EXPECT_KEY="$KEY" STUB_KEYLOG="$KEYLOG" \
  node "$STUB" > "$STUB_OUT" 2>&1 &
STUB_PID=$!
PORT=""
for _ in $(seq 1 40); do
  PORT="$(sed -n 's/^PORT //p' "$STUB_OUT" 2>/dev/null | head -1)"
  [ -n "$PORT" ] && break
  kill -0 "$STUB_PID" 2>/dev/null || break
  sleep 0.1
done
[ -n "$PORT" ] || { echo "ERROR: stub endpoint never bound: $(cat "$STUB_OUT")"; exit 1; }
ENDPOINT="http://127.0.0.1:$PORT"

# ── A1 · first install ───────────────────────────────────────────────────────
H="$SANDBOX/home1"; mkdir -p "$H"
OUT1="$(env -i HOME="$H" PATH="$PATH" \
  FLYWHEEL_STATE_DIR="$H/.flywheel" \
  FLYWHEEL_ONBOARD_ENDPOINT="$ENDPOINT" \
  FLYWHEEL_LICENSE_KEY="$KEY" FLYWHEEL_ALLOW_LICENSE_KEY_ENV=1 \
  node "$BIN" 2>&1)"
RC1=$?
CUR="$H/.flywheel/runtime/current"
ok=1
[ "$RC1" -eq 0 ] || ok=0
[ -L "$CUR" ] || ok=0
[ -f "$CUR/.flywheel-prebuilt" ] || ok=0
[ "$(cat "$CUR/.flywheel-prebuilt" 2>/dev/null)" = "$VER" ] || ok=0
[ -f "$H/.flywheel/onboard-ran.marker" ] || ok=0
if [ "$ok" -eq 1 ]; then
  pass "A1 first install: key→payload→sha→install→mirror→flip current→exec onboard.sh"
else
  fail "A1 rc=$RC1 current=$([ -L "$CUR" ] && echo link || echo none) out=[$(tail -5 <<<"$OUT1")]"
fi
# key persisted 0600
if [ -f "$H/.flywheel/.env" ] && grep -q "FLYWHEEL_LICENSE_KEY=$KEY" "$H/.flywheel/.env"; then
  MODE="$(stat -c '%a' "$H/.flywheel/.env" 2>/dev/null || stat -f '%Lp' "$H/.flywheel/.env" 2>/dev/null)"
  [ "$MODE" = "600" ] && pass "A1b key persisted to 0600 .env" || fail "A1b .env mode=$MODE (want 600)"
else
  fail "A1b key not persisted to .env"
fi
# version recorded in the resume journal, key NEVER in it
if grep -q "\"installedVersion\": \"$VER\"" "$H/.flywheel/onboard-journal.json" 2>/dev/null \
   && ! grep -q "$KEY" "$H/.flywheel/onboard-journal.json" 2>/dev/null; then
  pass "A1c version in resume journal, key absent from it"
else
  fail "A1c journal wrong: $(cat "$H/.flywheel/onboard-journal.json" 2>/dev/null)"
fi
# the key NEVER appeared on stdout/stderr
if grep -q "$KEY" <<<"$OUT1"; then
  fail "A1d RED LINE: license key leaked to stdout/stderr"
else
  pass "A1d key never printed to stdout/stderr"
fi
# the onboard.sh handoff ran WITHOUT the key in its env (stripped)
if grep -q "KEYSEEN=<none>" "$H/.flywheel/onboard-ran.marker" 2>/dev/null; then
  pass "A1e key stripped from env before exec onboard.sh (child cannot read it)"
else
  fail "A1e key NOT stripped: $(cat "$H/.flywheel/onboard-ran.marker" 2>/dev/null)"
fi

# ── A3 · key travelled only in the Authorization header ─────────────────────
if grep -q "auth=Bearer $KEY" "$KEYLOG" 2>/dev/null \
   && ! grep -q "$KEY" <(sed 's/\tauth=.*//' "$KEYLOG" 2>/dev/null); then
  pass "A3 key rode only the Authorization header, never a URL path"
else
  fail "A3 keylog: $(cat "$KEYLOG" 2>/dev/null)"
fi

# ── A2 · second run: no re-fetch, no key prompt ─────────────────────────────
: > "$KEYLOG"
OUT2="$(env -i HOME="$H" PATH="$PATH" \
  FLYWHEEL_STATE_DIR="$H/.flywheel" \
  FLYWHEEL_ONBOARD_ENDPOINT="$ENDPOINT" \
  node "$BIN" 2>&1)"
RC2=$?
# no endpoint hit on the second run (already installed → straight exec)
if [ "$RC2" -eq 0 ] && [ ! -s "$KEYLOG" ] && grep -q "ONBOARD-HANDOFF" "$H/.flywheel/onboard-ran.marker"; then
  pass "A2 second run: straight exec, zero endpoint requests, no key needed"
else
  fail "A2 rc=$RC2 keylog=[$(cat "$KEYLOG")] out=[$(tail -3 <<<"$OUT2")]"
fi

# ── A4 · setup-script failure: install is KEPT (resumable), honest message ────
# The download + install succeed but the packaged setup script exits non-zero.
# The install must be kept (current present → re-run resumes at setup, no
# re-download) and the customer gets the honest setup-failed message, NOT a
# generic "unexpected error" (Codex R4).
PT4="$SANDBOX/payload-fail"; mkdir -p "$PT4/dist" "$PT4/scripts/packaged"
printf '{ "name": "flywheel-onboard-payload", "version": "%s", "private": true }\n' "$VER" > "$PT4/package.json"
printf '%s\n' "$VER" > "$PT4/.flywheel-prebuilt"
echo "// stub" > "$PT4/dist/run-bridge.js"
printf '#!/bin/bash\necho "SETUP-RAN" > "$FLYWHEEL_STATE_DIR/setup-ran.marker"\nexit 7\n' > "$PT4/scripts/flywheel-onboard.sh"; chmod +x "$PT4/scripts/flywheel-onboard.sh"
printf '#!/bin/bash\nexit 0\n' > "$PT4/scripts/packaged/create-compat-mirror.sh"; chmod +x "$PT4/scripts/packaged/create-compat-mirror.sh"
printf '#!/bin/bash\nexit 0\n' > "$PT4/scripts/packaged/restart-packaged-services.sh"; chmod +x "$PT4/scripts/packaged/restart-packaged-services.sh"
TB4="$SANDBOX/$(cd "$PT4" && npm pack --pack-destination "$SANDBOX" 2>/dev/null | tail -1)"
SHA4="$(shasum -a 256 "$TB4" 2>/dev/null | awk '{print $1}')"
kill "$STUB_PID" 2>/dev/null; STUB_PID=""
STUB_OUT4="$SANDBOX/stub4.out"; KEYLOG4="$SANDBOX/keylog4.txt"
STUB_PAYLOAD_FILE="$TB4" STUB_VER="$VER" STUB_SHA="$SHA4" STUB_MODE="normal" \
  STUB_EXPECT_KEY="$KEY" STUB_KEYLOG="$KEYLOG4" node "$STUB" > "$STUB_OUT4" 2>&1 &
STUB_PID=$!
PORT4=""; for _ in $(seq 1 40); do PORT4="$(sed -n 's/^PORT //p' "$STUB_OUT4" 2>/dev/null | head -1)"; [ -n "$PORT4" ] && break; kill -0 "$STUB_PID" 2>/dev/null || break; sleep 0.1; done
H4="$SANDBOX/home4"; mkdir -p "$H4"
OUT4="$(env -i HOME="$H4" PATH="$PATH" FLYWHEEL_STATE_DIR="$H4/.flywheel" \
  FLYWHEEL_ONBOARD_ENDPOINT="http://127.0.0.1:$PORT4" \
  FLYWHEEL_LICENSE_KEY="$KEY" FLYWHEEL_ALLOW_LICENSE_KEY_ENV=1 node "$BIN" 2>&1)"
RC4=$?
if [ -n "$TB4" ] && [ -n "$PORT4" ] && [ "$RC4" -ne 0 ] \
   && [ -L "$H4/.flywheel/runtime/current" ] \
   && [ -f "$H4/.flywheel/setup-ran.marker" ] \
   && grep -q "启动引导时出错" <<<"$OUT4" \
   && ! grep -q "安装遇到意外错误" <<<"$OUT4"; then
  pass "A4 setup-script failure: install KEPT (current present), honest setup-failed message (not generic error)"
else
  fail "A4 tb=$([ -n "$TB4" ] && echo ok || echo MISSING) port=$PORT4 rc=$RC4 current=$([ -L "$H4/.flywheel/runtime/current" ] && echo y || echo n) out=[$(tail -4 <<<"$OUT4")]"
fi
# A4b · re-run resumes at setup WITHOUT re-fetching (installedComplete fast path)
: > "$KEYLOG4"
OUT4b="$(env -i HOME="$H4" PATH="$PATH" FLYWHEEL_STATE_DIR="$H4/.flywheel" \
  FLYWHEEL_ONBOARD_ENDPOINT="http://127.0.0.1:$PORT4" node "$BIN" 2>&1)"
RC4b=$?
if [ "$RC4b" -ne 0 ] && [ ! -s "$KEYLOG4" ] && grep -q "启动引导时出错" <<<"$OUT4b"; then
  pass "A4b re-run after setup failure: resumes at setup via fast path, ZERO re-fetch"
else
  fail "A4b rc=$RC4b keylog=[$(cat "$KEYLOG4")] out=[$(tail -3 <<<"$OUT4b")]"
fi

echo ""
echo "onboard-shell-install: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]
