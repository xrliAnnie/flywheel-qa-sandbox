#!/bin/bash
# FLY-1062 PR2 · QA-phase gap regression suite (hermetic).
#
# Independent QA coverage for three real behaviours the implement-phase suites
# exercise in code but never PIN with an assertion. Each was probed live at the
# reviewed head and confirmed CORRECT — these tests lock that behaviour so a
# future change cannot silently regress it:
#   Q1 protocol error (a 200-OK but MALFORMED manifest) → the honest GENERIC
#      message, NOT the "check your network" message (Codex R1#7: never
#      mis-advise a customer to check their network for a server/local problem).
#      The N-series covers network/checksum/401 but never a protocol failure.
#   Q2 `update` on a machine with NO previous good version whose new build's
#      restart is unhealthy → the honest DEGRADED message ("machine may be
#      incomplete, don't continue, contact us"), NOT the falsely-reassuring
#      "rolled back to the last good version" message — and current must NOT
#      dangle at the just-removed version dir. The rotation suite's U3 only
#      covers the happy rollback (a good previous version exists).
#   Q3 persistKey REFUSES a symlink .env target (a security red line: writing
#      the license key THROUGH a symlink would land it in an attacker-chosen
#      file). No implement-phase test covers the symlink refusal.
#
# temp-HOME + FLYWHEEL_STATE_DIR isolation; stubs run on loopback.
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
KEYMOD="file://$PKG_DIR/lib/key.mjs"

SANDBOX="$(mktemp -d -t fly1062-shellqa-XXXXXX)"
STUB_PID=""
cleanup() { [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null; rm -rf "$SANDBOX"; }
trap cleanup EXIT

wait_port() { # <stub-out-file> → echoes the bound port (empty on failure)
  local out="$1" p=""
  for _ in $(seq 1 40); do
    p="$(sed -n 's/^PORT //p' "$out" 2>/dev/null | head -1)"
    [ -n "$p" ] && break
    kill -0 "$STUB_PID" 2>/dev/null || break
    sleep 0.1
  done
  echo "$p"
}

# assert_clean <home> — zero half-baked: no current (link or dangling), no
# stray current.tmp.*, versions dir empty-or-absent.
assert_clean() {
  local h="$1"
  [ ! -L "$h/.flywheel/runtime/current" ] || return 1
  [ ! -e "$h/.flywheel/runtime/current" ] || return 1
  [ -z "$(ls -A "$h/.flywheel/runtime/" 2>/dev/null | grep '^current\.tmp\.')" ] || return 1
  local vd="$h/.flywheel/runtime/versions"
  [ ! -d "$vd" ] || [ -z "$(ls -A "$vd" 2>/dev/null)" ] || return 1
  return 0
}

# ── Q1 · malformed manifest (200 OK, not JSON) → generic, NOT network ────────
# A minimal stub that answers /manifest with 200 + a non-JSON body. fetchManifest
# → EndpointError("protocol") → messageFor → MSG.generic. The failure must NOT be
# reported as a network problem (that would send the customer chasing their wifi).
cat > "$SANDBOX/badmanifest-stub.mjs" <<'EOF'
import http from "node:http";
const s = http.createServer((req, res) => {
  if (req.url === "/manifest") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("<html>this is not json</html>");
    return;
  }
  res.writeHead(404);
  res.end("nf");
});
s.listen(0, "127.0.0.1", () => process.stdout.write(`PORT ${s.address().port}\n`));
EOF
Q1OUT="$SANDBOX/q1stub.out"
node "$SANDBOX/badmanifest-stub.mjs" > "$Q1OUT" 2>&1 &
STUB_PID=$!
PORT="$(wait_port "$Q1OUT")"
H1="$SANDBOX/q1"; mkdir -p "$H1"
OUT1="$(env -i HOME="$H1" PATH="$PATH" FLYWHEEL_STATE_DIR="$H1/.flywheel" \
  FLYWHEEL_ONBOARD_ENDPOINT="http://127.0.0.1:$PORT" \
  FLYWHEEL_LICENSE_KEY="q1-key" FLYWHEEL_ALLOW_LICENSE_KEY_ENV=1 node "$BIN" 2>&1)"
RC1=$?
# PORT non-empty is REQUIRED: an un-bound stub → connection refused → a NETWORK
# failure, which would make "not network" trivially wrong / this test a false read.
if [ -n "$PORT" ] && [ "$RC1" -ne 0 ] \
   && grep -q "安装没能完成" <<<"$OUT1" \
   && ! grep -q "连不上安装服务器" <<<"$OUT1" \
   && assert_clean "$H1"; then
  pass "Q1 malformed manifest → honest generic message (NOT 'check your network'), zero half-baked"
else
  fail "Q1 port=$PORT rc=$RC1 clean=$(assert_clean "$H1" && echo y || echo n) out=[$OUT1]"
fi
kill "$STUB_PID" 2>/dev/null; STUB_PID=""

# ── Q2 · update, no prior version, unhealthy restart → DEGRADED (not rollback) ─
# Fresh machine with only a stored key (no installed `current`). `update` pulls a
# new build whose restart seam exits non-zero. update.mjs removes the failed new
# version dir; with NO old version to return to it drops the current symlink and
# reports updateRollbackDegraded — it must NOT claim a clean rollback to a good
# version, and must NOT leave `current` dangling at the deleted tree.
PU="$SANDBOX/payload-unhealthy"; mkdir -p "$PU/dist" "$PU/scripts/packaged"
VER="9.9.9"
printf '{ "name":"flywheel-onboard-payload","version":"%s","private":true }\n' "$VER" > "$PU/package.json"
printf '%s\n' "$VER" > "$PU/.flywheel-prebuilt"
echo "// stub" > "$PU/dist/run-bridge.js"
printf '#!/bin/bash\ntrue\n' > "$PU/scripts/flywheel-onboard.sh"; chmod +x "$PU/scripts/flywheel-onboard.sh"
printf '#!/bin/bash\nexit 0\n' > "$PU/scripts/packaged/create-compat-mirror.sh"; chmod +x "$PU/scripts/packaged/create-compat-mirror.sh"
# restart seam present (verifyPkgRoot passes at install) but UNHEALTHY at runtime.
printf '#!/bin/bash\nexit 1\n' > "$PU/scripts/packaged/restart-packaged-services.sh"; chmod +x "$PU/scripts/packaged/restart-packaged-services.sh"
TBU="$SANDBOX/$(cd "$PU" && npm pack --pack-destination "$SANDBOX" 2>/dev/null | tail -1)"
[ -f "$TBU" ] || { fail "Q2 fixture npm pack failed"; TBU=""; }
SHAU="$(shasum -a 256 "$TBU" 2>/dev/null | awk '{print $1}')"
KEY2="fly-key-q2"
Q2OUT="$SANDBOX/q2stub.out"
STUB_PAYLOAD_FILE="$TBU" STUB_VER="$VER" STUB_SHA="$SHAU" STUB_MODE="normal" STUB_EXPECT_KEY="$KEY2" \
  node "$STUB" > "$Q2OUT" 2>&1 &
STUB_PID=$!
PORT2="$(wait_port "$Q2OUT")"
H2="$SANDBOX/q2"; mkdir -p "$H2/.flywheel"
printf 'FLYWHEEL_LICENSE_KEY=%s\n' "$KEY2" > "$H2/.flywheel/.env"; chmod 600 "$H2/.flywheel/.env"
OUT2="$(env -i HOME="$H2" PATH="$PATH" FLYWHEEL_STATE_DIR="$H2/.flywheel" \
  FLYWHEEL_ONBOARD_ENDPOINT="http://127.0.0.1:$PORT2" node "$BIN" update 2>&1)"
RC2=$?
if [ -n "$TBU" ] && [ -n "$PORT2" ] && [ "$RC2" -ne 0 ] \
   && grep -q "这台机器现在可能处于不完整状态" <<<"$OUT2" \
   && ! grep -q "已经自动切回上一个能用的版本" <<<"$OUT2" \
   && assert_clean "$H2"; then
  pass "Q2 update, no prior version + unhealthy restart → honest DEGRADED message, no dangling current, no version residue"
else
  fail "Q2 tb=$([ -n "$TBU" ] && echo ok || echo MISSING) port=$PORT2 rc=$RC2 clean=$(assert_clean "$H2" && echo y || echo n) out=[$OUT2]"
fi
kill "$STUB_PID" 2>/dev/null; STUB_PID=""

# ── Q3 · persistKey refuses a symlink .env (security red line) ────────────────
# If .env is a symlink to an attacker-chosen file, persistKey must THROW rather
# than write the key through the link. Prove: it throws, and the symlink's real
# target is UNCHANGED (the secret never landed there).
cat > "$SANDBOX/q3-symlink.mjs" <<EOF
import fs from "node:fs";
import path from "node:path";
import { persistKey } from "$KEYMOD";
const dir = process.argv[2];
const real = path.join(dir, "attacker-target.env");
fs.writeFileSync(real, "UNTOUCHED=1\n");
const envFile = path.join(dir, ".env");
fs.symlinkSync(real, envFile);
let threw = false;
try { persistKey(envFile, "fly-SECRET-must-not-land"); } catch { threw = true; }
const body = fs.readFileSync(real, "utf8");
const leaked = body.includes("fly-SECRET-must-not-land");
process.stdout.write(JSON.stringify({ threw, leaked }));
EOF
Q3DIR="$SANDBOX/q3"; mkdir -p "$Q3DIR"
Q3="$(node "$SANDBOX/q3-symlink.mjs" "$Q3DIR" 2>&1)"
if grep -q '"threw":true' <<<"$Q3" && grep -q '"leaked":false' <<<"$Q3"; then
  pass "Q3 persistKey refuses a symlink .env target — key never written through the link"
else
  fail "Q3 result=[$Q3]"
fi

echo ""
echo "onboard-shell-qa-gaps: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]
