#!/bin/bash
# FLY-1062 (QA·FLY-1062): direct hermetic coverage for the P3 packaged update
# seam restart script — scripts/packaged/restart-packaged-services.sh.
#
# WHY THIS EXISTS: the packaged-path audit table rows this script as
# "included (P3 更新链用)" and claims packaged-seams.test.sh covers it, but no
# suite actually exercises it (grep shows zero references). QA closes that gap.
# The script is dormant in PR1 (no caller yet — P3's `flywheel update` will call
# it), so a syntax-clean-but-untested restart+health-gate is exactly the kind of
# surface that rots. This suite pins its real behavior:
#   R1  non-packaged tree (no .flywheel-prebuilt)  → hard refusal, exit 1
#   R2  packaged tree, --no-leads, healthy Bridge  → restarts ONLY bridge, exit 0
#   R3  packaged tree + lead manifests             → bridge + every lead restarted
#   R4  Bridge never healthy (health gate)         → exit 1
#   R5  a lead restart verb fails but Bridge OK     → non-zero rc propagated
#
# Hermetic: a fixture packaged tree whose scripts/lib/supervisor.sh is a
# RECORDING STUB (so supervisor_backend/supervisor_restart are controlled without
# touching launchctl/systemctl); curl + sleep stubbed on PATH. No network, no
# real services, no real state dirs.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SANDBOX="$(mktemp -d -t fly1062-restart-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
REAL_USER_HOME="$HOME"
SCRIPT="$REPO_ROOT/scripts/packaged/restart-packaged-services.sh"

# mk_pkg <dir> [prebuilt] — a minimal packaged tree carrying the REAL restart
# script (copied, so its self-derived PKG_ROOT lands in the fixture) + a STUB
# supervisor.sh that records every restart verb into <dir>/sup-calls.log.
mk_pkg() {
  local dir="$1" prebuilt="${2:-}"
  mkdir -p "$dir/scripts/packaged" "$dir/scripts/lib"
  cp -p "$SCRIPT" "$dir/scripts/packaged/restart-packaged-services.sh"
  cat > "$dir/scripts/lib/supervisor.sh" <<STUB
#!/bin/bash
# recording stub — real supervisor.sh is exercised by packaged-seams S11/S12.
supervisor_backend() { echo "\${SUP_BACKEND:-launchd}"; }
supervisor_restart() {
  echo "restart \$1 \${2:-}" >> "$dir/sup-calls.log"
  # SUP_FAIL is a space-list of names whose restart verb should fail.
  case " \${SUP_FAIL:-} " in *" \$1 "*) return 1 ;; esac
  return 0
}
STUB
  [ "$prebuilt" = "prebuilt" ] && echo "1.55.0-test" > "$dir/.flywheel-prebuilt"
  : > "$dir/sup-calls.log"
  return 0
}

# mk_home <dir> — fixture HOME with an isolated state dir + a first-in-PATH stub
# bin holding curl + sleep. curl reads $h/health-ok to decide healthy(0)/down(1);
# sleep is a no-op so the health loop never actually blocks.
mk_home() {
  local h="$1"
  [ "$h" = "$REAL_USER_HOME" ] && { echo "FATAL: fixture HOME is the real HOME" >&2; exit 1; }
  mkdir -p "$h/.flywheel/manifests" "$h/bin"
  cat > "$h/bin/curl" <<CURL
#!/bin/bash
[ -f "$h/health-ok" ] && exit 0 || exit 7
CURL
  cat > "$h/bin/sleep" <<'SLEEP'
#!/bin/bash
exit 0
SLEEP
  chmod +x "$h/bin/curl" "$h/bin/sleep"
}

# run_restart <pkg> <home> [args...] — invoke the script in the fixture, healthy
# by default (drop $home/health-ok before calling to simulate a down Bridge).
run_restart() {
  local pkg="$1" home="$2"; shift 2
  env -i HOME="$home" PATH="$home/bin:/usr/bin:/bin" \
    FLYWHEEL_STATE_DIR="$home/.flywheel" \
    SUP_BACKEND="${SUP_BACKEND:-launchd}" SUP_FAIL="${SUP_FAIL:-}" \
    bash "$pkg/scripts/packaged/restart-packaged-services.sh" "$@" 2>&1
}

mk_manifest() { # <home> <file> <project> <leadId>
  jq -n --arg p "$3" --arg l "$4" '{projectName:$p, leadId:$l}' > "$2"
}

# ── R1: non-packaged tree refuses ────────────────────────────────────────────
PKG="$SANDBOX/r1-pkg"; HOME_DIR="$SANDBOX/r1-home"
mk_pkg "$PKG"          # NO sentinel
mk_home "$HOME_DIR"; : > "$HOME_DIR/health-ok"
out="$(run_restart "$PKG" "$HOME_DIR" --no-leads)"; rc=$?
if [ "$rc" -ne 0 ] && grep -q "not a packaged tree" <<<"$out" \
   && [ ! -s "$PKG/sup-calls.log" ]; then
  pass "R1 non-packaged tree: hard refusal (exit $rc), zero restart verbs fired"
else
  fail "R1 expected refusal+exit≠0+no restarts, got rc=$rc out=$out"
fi

# ── R2: packaged + --no-leads + healthy → only bridge restarted, exit 0 ──────
PKG="$SANDBOX/r2-pkg"; HOME_DIR="$SANDBOX/r2-home"
mk_pkg "$PKG" prebuilt
mk_home "$HOME_DIR"; : > "$HOME_DIR/health-ok"
mk_manifest "$HOME_DIR" "$HOME_DIR/.flywheel/manifests/x.json" proj lead1  # must be ignored
out="$(run_restart "$PKG" "$HOME_DIR" --no-leads)"; rc=$?
calls="$(cat "$PKG/sup-calls.log")"
if [ "$rc" -eq 0 ] && grep -q "restart bridge service" <<<"$calls" \
   && ! grep -q "lead" <<<"$calls"; then
  pass "R2 --no-leads healthy: only bridge restarted, exit 0"
else
  fail "R2 expected bridge-only+exit0, got rc=$rc calls='$calls' out=$out"
fi

# ── R3: packaged + lead manifests → bridge + every lead restarted ────────────
PKG="$SANDBOX/r3-pkg"; HOME_DIR="$SANDBOX/r3-home"
mk_pkg "$PKG" prebuilt
mk_home "$HOME_DIR"; : > "$HOME_DIR/health-ok"
mk_manifest "$HOME_DIR" "$HOME_DIR/.flywheel/manifests/a.json" alpha lA
mk_manifest "$HOME_DIR" "$HOME_DIR/.flywheel/manifests/b.json" beta  lB
out="$(run_restart "$PKG" "$HOME_DIR")"; rc=$?
calls="$(cat "$PKG/sup-calls.log")"
if [ "$rc" -eq 0 ] \
   && grep -q "restart bridge service" <<<"$calls" \
   && grep -q "restart lead-alpha-lA service" <<<"$calls" \
   && grep -q "restart lead-beta-lB service" <<<"$calls"; then
  pass "R3 with manifests: bridge + every lead restarted through the seam, exit 0"
else
  fail "R3 expected bridge+2 leads, got rc=$rc calls='$calls' out=$out"
fi

# ── R4: Bridge never healthy → health gate fails, exit 1 ─────────────────────
PKG="$SANDBOX/r4-pkg"; HOME_DIR="$SANDBOX/r4-home"
mk_pkg "$PKG" prebuilt
mk_home "$HOME_DIR"   # NO health-ok → curl always exits non-zero
out="$(run_restart "$PKG" "$HOME_DIR" --no-leads --timeout 4)"; rc=$?
if [ "$rc" -eq 1 ] && grep -q "did not become healthy" <<<"$out"; then
  pass "R4 unhealthy Bridge: health gate fails (exit 1), rollback signal to installer"
else
  fail "R4 expected exit1+unhealthy msg, got rc=$rc out=$out"
fi

# ── R5: a lead restart verb fails but Bridge healthy → non-zero rc propagated ─
PKG="$SANDBOX/r5-pkg"; HOME_DIR="$SANDBOX/r5-home"
mk_pkg "$PKG" prebuilt
mk_home "$HOME_DIR"; : > "$HOME_DIR/health-ok"
mk_manifest "$HOME_DIR" "$HOME_DIR/.flywheel/manifests/a.json" alpha lA
out="$(SUP_FAIL="lead-alpha-lA" run_restart "$PKG" "$HOME_DIR")"; rc=$?
if [ "$rc" -ne 0 ] && grep -q "restart verb failed: lead-alpha-lA" <<<"$out"; then
  pass "R5 a lead restart fails: non-zero rc propagated (installer sees partial failure)"
else
  fail "R5 expected rc≠0+failure msg, got rc=$rc out=$out"
fi

echo ""
echo "packaged-restart: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]
