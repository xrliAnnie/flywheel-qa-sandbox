#!/bin/bash
# FLY-1062 · ③ CUSTOMER end-to-end acceptance — the whole chain in
# its REAL form, zero stubs on the serving path:
#
#   real release scripts ──publish──▶ real endpoint (serve-node + FsBucket)
#                                          ▲
#   customer machine: npm-pack-installed shell ──Bearer key──┘
#
#   E1  conditional-create the manifest through the REAL admin route;
#   E2  beta release via payload-release.mjs (reserve→pack→claim→upload→
#       readback→commit, B0-9);
#   E3  promote prepare (equivalence proof) + commit via payload-promote.mjs
#       → customer-release pointer flips;
#   E4  license key issued through the REAL ops route;
#   E5  a fresh HOME + the shell installed FROM ITS NPM TARBALL installs the
#       promoted version end to end (zero repository access anywhere);
#   E6  endpoint restart (same data dir) → a SECOND fresh customer still
#       installs — the durable FsBucket is real hosting, not test state.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }
command -v npm >/dev/null 2>&1 || { echo "ERROR: npm required"; exit 1; }
command -v git >/dev/null 2>&1 || { echo "ERROR: git required"; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVE="$ROOT/packages/payload-endpoint/src/serve-node.mjs"
SHELL_DIR="$ROOT/packages/onboard-shell"

SANDBOX="$(mktemp -d -t fly1062-e2e-XXXXXX)"
SERVER_PID=""
cleanup() { [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null; rm -rf "$SANDBOX"; }
trap cleanup EXIT

sha() { shasum -a 256 "$1" | awk '{print $1}'; }
shastr() { printf '%s' "$1" | shasum -a 256 | awk '{print $1}'; }

BETA_TOKEN="beta-e2e-token"; RELEASE_TOKEN="release-e2e-token"; OPS_TOKEN="ops-e2e-token"

# ── fixture git repo (sourceCommit discipline) ───────────────────────────────
FIX="$SANDBOX/repo"
mkdir -p "$FIX/doc"
echo "v9.9.9" > "$FIX/doc/VERSION"
echo "payload input v1" > "$FIX/content.txt"
git -C "$FIX" init -q && git -C "$FIX" add -A \
  && git -C "$FIX" -c user.email=t@t -c user.name=t commit -qm fixture

# ── fake packer producing the INSTALLABLE payload shape (deterministic) ─────
PACKER="$SANDBOX/fake-packer.sh"
cat > "$PACKER" <<'SH'
#!/bin/bash
set -euo pipefail
root=""; out=""
while [ "$#" -gt 0 ]; do case "$1" in
  --repo-root) root="$2"; shift 2 ;;
  --out) out="$2"; shift 2 ;;
  *) shift ;;
esac; done
ver="${PO_RELEASE_VERSION:?}"
stage="$(mktemp -d)/package"
mkdir -p "$stage/dist" "$stage/scripts/packaged" "$out"
printf '{ "name": "flywheel-onboard-payload", "version": "%s", "private": true }\n' "$ver" > "$stage/package.json"
printf '%s\n' "$ver" > "$stage/.flywheel-prebuilt"
echo "// bridge entry" > "$stage/dist/run-bridge.js"
cp "$root/content.txt" "$stage/dist/content.txt"
cat > "$stage/scripts/flywheel-onboard.sh" <<'INNER'
#!/bin/bash
echo "ONBOARD-HANDOFF" > "$FLYWHEEL_STATE_DIR/onboard-ran.marker"
INNER
chmod +x "$stage/scripts/flywheel-onboard.sh"
printf '#!/bin/bash\nexit 0\n' > "$stage/scripts/packaged/create-compat-mirror.sh"
printf '#!/bin/bash\nexit 0\n' > "$stage/scripts/packaged/restart-packaged-services.sh"
chmod +x "$stage/scripts/packaged/"*.sh
find "$stage" -exec touch -t 202601010000 {} +
touch -t 202601010000 "$(dirname "$stage")"
tar -cf - -C "$(dirname "$stage")" package | gzip -n > "$out/payload-$ver.tgz"
echo "$out/payload-$ver.tgz"
SH
chmod +x "$PACKER"

# ── boot the REAL endpoint (FsBucket data dir; secrets = sha256 hashes) ─────
DATA="$SANDBOX/bucket-data"
start_server() {
  SERVER_OUT="$SANDBOX/server.out"
  : > "$SERVER_OUT"
  FW_SERVE_DATA_DIR="$DATA" FW_SERVE_PORT=0 \
    FW_BETA_PUBLISH_TOKEN_SHA256="$(shastr "$BETA_TOKEN")" \
    FW_CUSTOMER_RELEASE_TOKEN_SHA256="$(shastr "$RELEASE_TOKEN")" \
    FW_OPS_ADMIN_TOKEN_SHA256="$(shastr "$OPS_TOKEN")" \
    node "$SERVE" > "$SERVER_OUT" 2>&1 &
  SERVER_PID=$!
  EP=""
  for _ in $(seq 1 50); do
    P="$(sed -n 's/^LISTENING [^:]*:\([0-9]*\)$/\1/p' "$SERVER_OUT" 2>/dev/null | head -1)"
    [ -n "$P" ] && EP="http://127.0.0.1:$P" && break
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 0.1
  done
  [ -n "$EP" ] || { echo "ERROR: serve-node never bound: $(cat "$SERVER_OUT")"; exit 1; }
}
start_server

# ── E1 · conditional create through the real admin route ────────────────────
INIT='{"baseEtag":null,"manifest":{"schemaVersion":1,"channels":{"internal-beta":{"latest":null},"customer-release":{"latest":null}},"versions":{},"releaseOps":{},"releaseLedger":{},"tombstones":[]}}'
CODE="$(curl -s -o "$SANDBOX/init.out" -w '%{http_code}' -X POST \
  -H "Authorization: Bearer $BETA_TOKEN" -H "Content-Type: application/json" \
  -d "$INIT" "$EP/admin/manifest")"
[ "$CODE" = "200" ] && pass "E1 conditional-create initialized the manifest (real route)" \
  || fail "E1 conditional create HTTP $CODE: $(cat "$SANDBOX/init.out")"

# ── E2 · beta release through the real pipeline ──────────────────────────────
if (cd "$FIX" && env FW_ENDPOINT="$EP" FW_BETA_PUBLISH_TOKEN="$BETA_TOKEN" FW_PACKER="$PACKER" \
    node "$ROOT/scripts/release/payload-release.mjs" --release-id beta-e2e --repo-root "$FIX" \
    > "$SANDBOX/beta.out" 2>&1); then
  pass "E2 beta released via payload-release.mjs (reserve→pack→claim→upload→readback→commit)"
else
  fail "E2 beta release failed: $(tail -5 "$SANDBOX/beta.out")"
fi

# ── E3 · promote prepare + commit through the real two-stage scripts ────────
if (cd "$FIX" && env FW_ENDPOINT="$EP" FW_BETA_PUBLISH_TOKEN="$BETA_TOKEN" FW_PACKER="$PACKER" \
    node "$ROOT/scripts/release/payload-promote.mjs" prepare --release-id rel-e2e \
    --beta 9.9.9-beta.1 --repo-root "$FIX" > "$SANDBOX/prep.out" 2>&1); then
  pass "E3a promote prepare (clean build + equivalence proof + staged candidate)"
else
  fail "E3a promote prepare failed: $(tail -5 "$SANDBOX/prep.out")"
fi
# Codex R7#5: the sha used to come from an inline `$(curl | node)` inside the
# --expected-sha256 arg, so the curl/node status was discarded (the outer command's
# status is payload-promote's). A curl that printed valid-looking JSON but exited
# non-zero could still supply a hash and let E3b "pass". Capture the manifest read,
# check curl exit AND http 200, parse the sha with a separately-checked command,
# THEN commit.
E2E_MANIFEST="$(curl -s -w $'\n%{http_code}' -H "Authorization: Bearer $OPS_TOKEN" "$EP/admin/manifest")"; E2E_CRC=$?
E2E_CODE="$(tail -1 <<<"$E2E_MANIFEST")"; E2E_BODY="$(sed '$d' <<<"$E2E_MANIFEST")"
E2E_SHA="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).releaseOps["rel-e2e"].sha256))}catch(e){process.exit(3)}})' <<<"$E2E_BODY")"; E2E_NRC=$?
if [ "$E2E_CRC" -ne 0 ] || [ "$E2E_CODE" != "200" ] || [ "$E2E_NRC" -ne 0 ] || [ -z "$E2E_SHA" ]; then
  fail "E3b manifest/sha probe failed before commit (curl $E2E_CRC http $E2E_CODE node $E2E_NRC sha '$E2E_SHA')"
elif env FW_ENDPOINT="$EP" FW_CUSTOMER_RELEASE_TOKEN="$RELEASE_TOKEN" \
    node "$ROOT/scripts/release/payload-promote.mjs" commit --release-id rel-e2e \
      --expected-sha256 "$E2E_SHA" \
    > "$SANDBOX/commit.out" 2>&1; then
  pass "E3b promote commit → customer-release.latest = 9.9.9"
else
  fail "E3b promote commit failed: $(tail -5 "$SANDBOX/commit.out")"
fi

# ── E4 · license key through the real ops route ──────────────────────────────
KEY_OUT="$(env FW_ENDPOINT="$EP" FW_OPS_ADMIN_TOKEN="$OPS_TOKEN" \
  node "$ROOT/scripts/release/license-key.mjs" issue --customer e2e-cust --entitlement customer 2>&1)"
KEY="$(sed -n 's/^  key    : //p' <<<"$KEY_OUT" | head -1)"
if [ -n "$KEY" ]; then
  pass "E4 customer license key issued through the real endpoint"
else
  fail "E4 key issuance failed: $(tail -3 <<<"$KEY_OUT")"
fi

# ── E5 · the CUSTOMER form: shell from its npm tarball, fresh HOME ───────────
TARBALL="$(cd "$SHELL_DIR" && npm pack --pack-destination "$SANDBOX" 2>/dev/null | tail -1)"
TARBALL="$SANDBOX/$TARBALL"
PREFIX="$SANDBOX/cli"
npm install --prefix "$PREFIX" "$TARBALL" >/dev/null 2>&1 \
  || { fail "E5 npm install from shell tarball failed"; echo "RESULTS: $PASSED passed, $FAILED failed"; exit 1; }
BIN="$PREFIX/node_modules/@flywheel-ai/onboard/bin/flywheel-onboard.js"

install_as_customer() { # $1 = HOME dir; prints rc
  local H="$1"; mkdir -p "$H"
  env -i HOME="$H" PATH="$PATH" \
    FLYWHEEL_STATE_DIR="$H/.flywheel" \
    FLYWHEEL_ONBOARD_ENDPOINT="$EP" \
    FLYWHEEL_LICENSE_KEY="$KEY" FLYWHEEL_ALLOW_LICENSE_KEY_ENV=1 \
    node "$BIN" > "$H/install.out" 2>&1
}

H1="$SANDBOX/home1"
if install_as_customer "$H1"; then
  CUR="$H1/.flywheel/runtime/current"
  if [ -L "$CUR" ] && [ "$(cat "$CUR/.flywheel-prebuilt" 2>/dev/null)" = "9.9.9" ] \
     && [ -f "$H1/.flywheel/onboard-ran.marker" ]; then
    pass "E5 customer chain: tarball-installed shell → real endpoint → 9.9.9 installed + handoff ran"
  else
    fail "E5 installed but wrong state: current=$(readlink "$CUR" 2>/dev/null)"
  fi
else
  fail "E5 customer install failed: $(tail -5 "$H1/install.out")"
fi
# zero repository access: nothing in the customer output mentions the repo host
if grep -qi "github" "$H1/install.out" 2>/dev/null; then
  fail "E5b RED LINE: repository reference leaked into the customer install output"
else
  pass "E5b zero repository access in the customer-visible install"
fi

# ── E6 · endpoint restart on the same data dir → durability is real ────────
kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""
start_server
H2="$SANDBOX/home2"
if install_as_customer "$H2" && [ "$(cat "$H2/.flywheel/runtime/current/.flywheel-prebuilt" 2>/dev/null)" = "9.9.9" ]; then
  pass "E6 endpoint restart (same FsBucket dir): a second fresh customer still installs"
else
  fail "E6 post-restart install failed: $(tail -5 "$H2/install.out" 2>/dev/null)"
fi

echo "RESULTS: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ] || exit 1
