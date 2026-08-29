#!/bin/bash
# FLY-1062 PR2 · onboard-shell key-leak matrix (hermetic).
#
# The license key is a secret. After a full install + an update, the key must
# appear NOWHERE except the one 0600 .env line that stores it:
#   S1 the whole ~/.flywheel state tree, grep'd, contains the key ONLY in .env
#   S2 stdout + stderr never printed the key
#   S3 the resume journal never held the key
#   S4 the exec'd onboard.sh could not read the key from its env (stripped)
#   S5 the key never reached a URL (only the Authorization header)
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

SANDBOX="$(mktemp -d -t fly1062-shellsec-XXXXXX)"
STUB_PID=""
cleanup() { [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null; rm -rf "$SANDBOX"; }
trap cleanup EXIT

VER="1.0.0"
PT="$SANDBOX/payload-src"; mkdir -p "$PT/dist" "$PT/scripts/packaged"
printf '{ "name": "flywheel-onboard-payload", "version": "%s", "private": true }\n' "$VER" > "$PT/package.json"
printf '%s\n' "$VER" > "$PT/.flywheel-prebuilt"
echo "// stub" > "$PT/dist/run-bridge.js"
# onboard.sh records the whole env so we can prove the key isn't in it
cat > "$PT/scripts/flywheel-onboard.sh" <<'SH'
#!/bin/bash
env > "$FLYWHEEL_STATE_DIR/onboard-env.dump"
SH
chmod +x "$PT/scripts/flywheel-onboard.sh"
printf '#!/bin/bash\nexit 0\n' > "$PT/scripts/packaged/create-compat-mirror.sh"; chmod +x "$PT/scripts/packaged/create-compat-mirror.sh"
printf '#!/bin/bash\nexit 0\n' > "$PT/scripts/packaged/restart-packaged-services.sh"; chmod +x "$PT/scripts/packaged/restart-packaged-services.sh"
TARBALL="$SANDBOX/$(cd "$PT" && npm pack --pack-destination "$SANDBOX" 2>/dev/null | tail -1)"
SHA="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
KEY="fly-SECRET-key-9f8e7d6c5b4a3210"
KEYLOG="$SANDBOX/keylog.txt"

STUB_OUT="$SANDBOX/stub.out"
STUB_PAYLOAD_FILE="$TARBALL" STUB_VER="$VER" STUB_SHA="$SHA" STUB_MODE="normal" \
  STUB_EXPECT_KEY="$KEY" STUB_KEYLOG="$KEYLOG" \
  node "$STUB" > "$STUB_OUT" 2>&1 &
STUB_PID=$!
PORT=""
for _ in $(seq 1 40); do
  PORT="$(sed -n 's/^PORT //p' "$STUB_OUT" 2>/dev/null | head -1)"
  [ -n "$PORT" ] && break; kill -0 "$STUB_PID" 2>/dev/null || break; sleep 0.1
done
ENDPOINT="http://127.0.0.1:$PORT"

H="$SANDBOX/home"; mkdir -p "$H"
OUT="$(env -i HOME="$H" PATH="$PATH" \
  FLYWHEEL_STATE_DIR="$H/.flywheel" FLYWHEEL_ONBOARD_ENDPOINT="$ENDPOINT" \
  FLYWHEEL_LICENSE_KEY="$KEY" FLYWHEEL_ALLOW_LICENSE_KEY_ENV=1 \
  node "$BIN" 2>&1)"; RC1=$?
# an update too (same version → no-op, but exercises the update key path)
OUT2="$(env -i HOME="$H" PATH="$PATH" \
  FLYWHEEL_STATE_DIR="$H/.flywheel" FLYWHEEL_ONBOARD_ENDPOINT="$ENDPOINT" \
  node "$BIN" update 2>&1)"; RC2=$?

# ── S0 · the run actually happened (Codex R3) ───────────────────────────────
# S2/S3 assert the key is ABSENT from output/journal — which is trivially true
# if the install never ran (stub couldn't bind, etc.). Gate the suite on a real
# install having occurred so the "absent" assertions cannot pass for free.
if [ -n "$PORT" ] && [ "$RC1" -eq 0 ] && [ "$RC2" -eq 0 ] \
   && [ -L "$H/.flywheel/runtime/current" ] \
   && [ -f "$H/.flywheel/onboard-env.dump" ]; then
  pass "S0 install + update actually ran (stub bound, exit 0, current + onboard handoff present)"
else
  fail "S0 port=$PORT rc1=$RC1 rc2=$RC2 current=$([ -L "$H/.flywheel/runtime/current" ] && echo y || echo n) dump=$([ -f "$H/.flywheel/onboard-env.dump" ] && echo y || echo n)"
fi

# ── S1 · key ONLY in .env across the whole state tree ───────────────────────
HITS="$(grep -rl "$KEY" "$H/.flywheel" 2>/dev/null | sed "s|$H/.flywheel/||" | sort)"
if [ "$HITS" = ".env" ]; then
  pass "S1 key present ONLY in .env across the entire state tree"
else
  fail "S1 key found in: [$HITS]"
fi

# ── S2 · never printed ───────────────────────────────────────────────────────
if ! grep -q "$KEY" <<<"$OUT$OUT2"; then
  pass "S2 key never printed to stdout/stderr (install + update)"
else
  fail "S2 key leaked to output"
fi

# ── S3 · never in the resume journal ────────────────────────────────────────
if ! grep -q "$KEY" "$H/.flywheel/onboard-journal.json" 2>/dev/null; then
  pass "S3 key never written to the resume journal"
else
  fail "S3 key in journal"
fi

# ── S4 · onboard.sh env had no key (stripped before exec) ───────────────────
if [ -f "$H/.flywheel/onboard-env.dump" ] && ! grep -q "FLYWHEEL_LICENSE_KEY" "$H/.flywheel/onboard-env.dump"; then
  pass "S4 key stripped from env before exec onboard.sh (child cannot read it)"
else
  fail "S4 onboard.sh env dump: $(grep -c FLYWHEEL_LICENSE_KEY "$H/.flywheel/onboard-env.dump" 2>/dev/null) key lines"
fi

# ── S5 · key only in the Authorization header, never a URL ──────────────────
if grep -q "auth=Bearer $KEY" "$KEYLOG" 2>/dev/null \
   && ! grep -q "$KEY" <(sed 's/\tauth=.*//' "$KEYLOG" 2>/dev/null); then
  pass "S5 key rode only the Authorization header, never a URL"
else
  fail "S5 keylog: $(cat "$KEYLOG" 2>/dev/null)"
fi

echo ""
echo "onboard-shell-secret: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]
