#!/bin/bash
# FLY-2695: scripts/raya-cos.sh — the host shim that gives the Raya persona a
# stable entry point (~/.flywheel/bin/raya-cos.sh) for the Raya CoS business CLI
# (plan FLY-2680 §6.2, L1). Hermetic: fake HOME, stub cli.js that echoes what it
# was handed, and an EXPLICIT environment (`env -i`) so no host input —
# FLYWHEEL_DIR, FLYWHEEL_STATE_DIR, FLYWHEEL_HOST_CONFIG, HOST_CONFIG_SOURCED —
# leaks in from whoever runs the suite. Only S7 touches the real built dist, and
# only in an empty temporary workspace.
set -uo pipefail
PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }

REAL_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHIM="$REAL_REPO_ROOT/scripts/raya-cos.sh"
HOST_LIB="$REAL_REPO_ROOT/scripts/lib/host-config.sh"
# Physical path: node reports process.cwd() through getcwd(), which resolves
# macOS's /var -> /private/var link. Comparing against a logical mktemp path
# would fail for a reason that has nothing to do with the shim.
SB="$(cd "$(mktemp -d -t fly2695-shim-XXXXXX)" && pwd -P)"; trap 'rm -rf "$SB"' EXIT

NODE_BIN="$(command -v node || true)"
JQ_BIN="$(command -v jq || true)"
[ -n "$NODE_BIN" ] || { echo "node is required to run this suite" >&2; exit 1; }
[ -n "$JQ_BIN" ] || { echo "jq is required to run this suite" >&2; exit 1; }
# The shim's only external tools: jq (host-config), uname (platform detection),
# cat (host.json read), dirname (second host-config fallback), node (exec).
# A private tool dir keeps PATH minimal and lets S5c drop node on its own.
TOOLS="$SB/tools"; mkdir -p "$TOOLS"
for t in jq uname cat dirname; do
  p="$(command -v "$t" || true)"; [ -n "$p" ] && ln -s "$p" "$TOOLS/$t"
done
NOTOOL_NODE="$SB/tools-no-node"; cp -R "$TOOLS" "$NOTOOL_NODE"
ln -s "$NODE_BIN" "$TOOLS/node"

# stub CLI: prints where it was loaded from, argv and cwd — then exits with
# $STUB_EXIT (default 0) so S6 can prove the exit code passes straight through.
mk_stub_cli() {  # <flywheel-dir>
  mkdir -p "$1/packages/raya-cos/dist"
  cat > "$1/packages/raya-cos/dist/cli.js" <<'EOF'
console.log(JSON.stringify({ target: process.argv[1], argv: process.argv.slice(2), cwd: process.cwd() }));
process.exit(Number(process.env.STUB_EXIT || 0));
EOF
}

# fake host: HOME/.flywheel/bin/{raya-cos.sh (555), lib/host-config.sh}, a stub
# checkout at the documented default $HOME/Dev/flywheel, and a .env that tries
# to redirect FLYWHEEL_DIR — the shim must never source it.
H="$SB/home"; WS="$SB/ws"
mkdir -p "$H/.flywheel/bin/lib" "$WS"
cp "$SHIM" "$H/.flywheel/bin/raya-cos.sh" 2>/dev/null && chmod 555 "$H/.flywheel/bin/raya-cos.sh"
cp "$HOST_LIB" "$H/.flywheel/bin/lib/host-config.sh"
mk_stub_cli "$H/Dev/flywheel"
printf 'FLYWHEEL_DIR=%s\n' "$SB/env-file-must-not-win" > "$H/.flywheel/.env"
BIN_SHIM="$H/.flywheel/bin/raya-cos.sh"

run_shim() {  # <shim> <path> [VAR=value ...] -- <args...> ; cwd = $WS
  local shim="$1" path="$2"; shift 2
  local envs=()
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do envs+=("$1"); shift; done
  [ "$#" -gt 0 ] && shift
  ( cd "$WS" && env -i HOME="$H" PATH="$path" ${envs[@]+"${envs[@]}"} "$shim" "$@" ) \
    >"$SB/out" 2>"$SB/err"
}
field() { "$JQ_BIN" -r "$@" "$SB/out" 2>/dev/null; }

# S0: size / syntax / shebang / the converger's own sanity floor. The converger
# refuses (and alerts on) any source under 1024 B, so a shim trimmed below the
# floor would never be installed — fail it here, in CI, instead.
size="$(wc -c < "$SHIM" 2>/dev/null | tr -d ' ')"
# shellcheck source=../lib/script-sanity.sh
# shellcheck disable=SC1091
source "$REAL_REPO_ROOT/scripts/lib/script-sanity.sh"
if [ -f "$SHIM" ] && [ -x "$SHIM" ] && [ "${size:-0}" -ge 1024 ] && bash -n "$SHIM" \
   && [ "$(head -c 2 "$SHIM")" = "#!" ] && assert_sane_script_source "$SHIM"; then
  pass "S0: shim is executable, ${size}B >= 1024B, parses, and passes the converger sanity floor"
else fail "S0: shim missing/too small/unparseable (size=${size:-missing})"; fi

# S1 (QA ②): no host.json, no FLYWHEEL_DIR → the documented default checkout;
# argv verbatim; cwd untouched (cos is cwd-scoped); .env ignored.
run_shim "$BIN_SHIM" "$TOOLS" -- status --x "y z"; RC=$?
if [ "$RC" -eq 0 ] \
   && [ "$(field .target)" = "$H/Dev/flywheel/packages/raya-cos/dist/cli.js" ] \
   && [ "$(field -c .argv)" = '["status","--x","y z"]' ] \
   && [ "$(field .cwd)" = "$WS" ]; then
  pass "S1: no host.json → \$HOME/Dev/flywheel dist, argv verbatim, cwd unchanged, .env not sourced"
else fail "S1: default resolution (rc=$RC)"; cat "$SB/out" "$SB/err"; fi

# S2: ENV beats both host.json and the default.
ALT="$SB/alt-env"; mk_stub_cli "$ALT"
printf '{"flywheelDir":"%s"}\n' "$SB/alt-json" > "$H/.flywheel/host.json"
run_shim "$BIN_SHIM" "$TOOLS" FLYWHEEL_DIR="$ALT" -- status; RC=$?
if [ "$RC" -eq 0 ] && [ "$(field .target)" = "$ALT/packages/raya-cos/dist/cli.js" ]; then
  pass "S2: FLYWHEEL_DIR env wins over host.json"
else fail "S2: env precedence (rc=$RC)"; cat "$SB/out" "$SB/err"; fi

# S3: host.json beats the default.
mk_stub_cli "$SB/alt-json"
run_shim "$BIN_SHIM" "$TOOLS" -- status; RC=$?
if [ "$RC" -eq 0 ] && [ "$(field .target)" = "$SB/alt-json/packages/raya-cos/dist/cli.js" ]; then
  pass "S3: host.json flywheelDir wins over the default"
else fail "S3: host.json precedence (rc=$RC)"; cat "$SB/out" "$SB/err"; fi
rm -f "$H/.flywheel/host.json"

# S4: host-config.sh lookup order — <state>/bin/lib → next to the shim → checkout.
rm -f "$H/.flywheel/bin/lib/host-config.sh"
SIDE="$SB/side"; mkdir -p "$SIDE/lib"
cp "$SHIM" "$SIDE/raya-cos.sh" 2>/dev/null; chmod 555 "$SIDE/raya-cos.sh" 2>/dev/null
cp "$HOST_LIB" "$SIDE/lib/host-config.sh"
run_shim "$SIDE/raya-cos.sh" "$TOOLS" -- status; RC1=$?; T1="$(field .target)"
rm -rf "${SIDE:?}/lib"
mkdir -p "$H/Dev/flywheel/scripts/lib"; cp "$HOST_LIB" "$H/Dev/flywheel/scripts/lib/host-config.sh"
run_shim "$SIDE/raya-cos.sh" "$TOOLS" -- status; RC2=$?; T2="$(field .target)"
rm -rf "$H/Dev/flywheel/scripts"
run_shim "$SIDE/raya-cos.sh" "$TOOLS" -- status; RC3=$?
if [ "$RC1" -eq 0 ] && [ "$T1" = "$H/Dev/flywheel/packages/raya-cos/dist/cli.js" ] \
   && [ "$RC2" -eq 0 ] && [ "$T2" = "$H/Dev/flywheel/packages/raya-cos/dist/cli.js" ] \
   && [ "$RC3" -eq 78 ] && grep -q 'host-config.sh is missing' "$SB/err" && [ ! -s "$SB/out" ]; then
  pass "S4: host-config.sh falls back shim-dir → checkout; none at all → rc=78 fail loud"
else fail "S4: host-config lookup (rc=$RC1/$RC2/$RC3)"; cat "$SB/out" "$SB/err"; fi
cp "$HOST_LIB" "$H/.flywheel/bin/lib/host-config.sh"

# S5: configuration failures are loud EX_CONFIG (78), never a silent no-op.
mv "$H/Dev/flywheel/packages/raya-cos/dist/cli.js" "$SB/cli.js.saved"
run_shim "$BIN_SHIM" "$TOOLS" -- status; RC1=$?; grep -q 'not built' "$SB/err"; G1=$?
mv "$SB/cli.js.saved" "$H/Dev/flywheel/packages/raya-cos/dist/cli.js"
echo '{ not json' > "$H/.flywheel/host.json"
run_shim "$BIN_SHIM" "$TOOLS" -- status; RC2=$?; grep -q 'host.json is invalid' "$SB/err"; G2=$?
rm -f "$H/.flywheel/host.json"
run_shim "$BIN_SHIM" "$NOTOOL_NODE" -- status; RC3=$?; grep -q 'node is not on PATH' "$SB/err"; G3=$?
if [ "$RC1" -eq 78 ] && [ "$G1" -eq 0 ] && [ "$RC2" -eq 78 ] && [ "$G2" -eq 0 ] \
   && [ "$RC3" -eq 78 ] && [ "$G3" -eq 0 ]; then
  pass "S5: dist missing / malformed host.json / node missing → rc=78 with a named reason"
else fail "S5: fail-loud (rc=$RC1/$RC2/$RC3)"; cat "$SB/err"; fi

# S5b (Codex code review R1): the first host-config.sh the lookup finds EXISTS
# but cannot be loaded (unreadable, or a syntax error) — `source` fails under
# `set -e`, which must still surface as EX_CONFIG 78, not source's own 1/2.
chmod 000 "$H/.flywheel/bin/lib/host-config.sh"
run_shim "$BIN_SHIM" "$TOOLS" -- status; RC1=$?; grep -q 'could not be loaded' "$SB/err"; G1=$?
chmod 644 "$H/.flywheel/bin/lib/host-config.sh"
cp "$H/.flywheel/bin/lib/host-config.sh" "$SB/host-config.saved"
printf '%s\n' '#!/bin/bash' 'host_config_load() {' '  if then' > "$H/.flywheel/bin/lib/host-config.sh"
run_shim "$BIN_SHIM" "$TOOLS" -- status; RC2=$?; grep -q 'could not be loaded' "$SB/err"; G2=$?
cp "$SB/host-config.saved" "$H/.flywheel/bin/lib/host-config.sh"
if [ "$RC1" -eq 78 ] && [ "$G1" -eq 0 ] && [ "$RC2" -eq 78 ] && [ "$G2" -eq 0 ] && [ ! -s "$SB/out" ]; then
  pass "S5b: unreadable / syntactically broken host-config.sh → rc=78, never source's own status"
else fail "S5b: host-config load failure (rc=$RC1/$RC2)"; cat "$SB/err"; fi

# S6: the CLI's own exit status passes through exec untouched.
run_shim "$BIN_SHIM" "$TOOLS" STUB_EXIT=3 -- status; RC=$?
if [ "$RC" -eq 3 ]; then
  pass "S6: CLI exit code passes through (3)"
else fail "S6: exit passthrough (rc=$RC)"; cat "$SB/err"; fi

# S7 (QA ③): the REAL built CLI through the shim, in an empty workspace.
# CI runs this after `pnpm build`, so a missing dist is a failure, not a skip.
# `status` opens the operation store, which creates the empty 0700 directory
# skeleton state/cos/operations (operation-store.ts checkDirectories) — so the
# read-only claim is "no FILE is written", not "the workspace stays empty".
REAL_CLI="$REAL_REPO_ROOT/packages/raya-cos/dist/cli.js"
if [ ! -f "$REAL_CLI" ]; then
  fail "S7: SKIP counted as failure — $REAL_CLI is not built (run pnpm --filter flywheel-raya-cos build)"
else
  rm -rf "$WS"; mkdir -p "$WS"
  run_shim "$BIN_SHIM" "$TOOLS" FLYWHEEL_DIR="$REAL_REPO_ROOT" -- status; RC=$?
  if [ "$RC" -eq 0 ] && "$JQ_BIN" -e '.schemaVersion==2 and .operations==[]' "$SB/out" >/dev/null \
     && [ -z "$(find "$WS" ! -type d)" ] \
     && [ "$(cd "$WS" && find . -mindepth 1 | LC_ALL=C sort | tr '\n' ' ')" = "./state ./state/cos ./state/cos/operations " ]; then
    pass "S7: real dist status → {schemaVersion:2, operations:[]}; workspace gains only the empty state/cos/operations skeleton"
  else fail "S7: real dist status (rc=$RC)"; cat "$SB/out" "$SB/err"; (cd "$WS" && find . -mindepth 1); fi
fi

echo ""; echo "Results: ${PASSED} passed, ${FAILED} failed"
[ "$FAILED" -eq 0 ] || exit 1
