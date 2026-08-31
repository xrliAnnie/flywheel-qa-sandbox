#!/bin/bash
# FLY-1062 P2: provision-fleet-host.sh PREBUILT mode — the customer machine's
# provisioning path over an installed npm payload (REPO_ROOT carries
# .flywheel-prebuilt). Both sides of every branch:
#
#   P1  repos(prebuilt): the flywheel entry is SKIPPED (no clone) and the
#       pnpm install/build step is skipped entirely; the customer's own
#       project repo entry still clones verbatim (gate④ registered row).
#   P2  repos(monorepo sentinel): without the sentinel the flywheel clone +
#       pnpm build path runs exactly as today.
#   P3  flywheel-home(prebuilt): wrappers install AND the support-lib closure
#       (bin/lib/host-config.sh) rides along (Codex R2#2 — a copied wrapper
#       without it silently falls back to ~/Dev/flywheel);
#       restart-services.sh is absent from a packaged tree and is NOT
#       installed; the installed host-config resolves flywheelDir=current
#       from host.json (the copied-wrapper resolution lock).
#   P4  launchd(prebuilt): first-install bring-up routes through
#       scripts/packaged/bootstrap-services.sh — plists rendered via the
#       supervisor seam point at <state>/bin wrappers + the current runtime
#       root; ZERO restart-services.sh / flywheel-daemon.sh on the path.
#   P5  launchd(monorepo sentinel): the FLY-650 darwin narrate flow runs
#       verbatim (restart-services.sh narration text present, no bootstrap).
#
# Hermetic: env -i jail + fixture HOME + fixture prebuilt tree carrying the
# REAL scripts + stubbed git/pnpm/launchctl/curl (FLY-954 discipline — the
# provisioner must never see the real HOME or state dir).
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED + 1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED + 1)); echo "[TEST] ✗ $1"; }

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROVISION="$REPO_ROOT/scripts/provision-fleet-host.sh"

SANDBOX="$(mktemp -d -t fly1062-prov-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
REAL_USER_HOME="$HOME"

# ── stub PATH (record-and-succeed) ───────────────────────────────────────────
STUB_BIN="$SANDBOX/stubbin"; mkdir -p "$STUB_BIN"
CALLS="$SANDBOX/stub-calls.log"
for b in git pnpm launchctl curl brew systemctl loginctl; do
  cat > "$STUB_BIN/$b" <<EOF
#!/bin/bash
echo "$b \$*" >> "$CALLS"
exit 0
EOF
  chmod +x "$STUB_BIN/$b"
done
ln -s "$(command -v jq)" "$STUB_BIN/jq"
STUB_PATH="$STUB_BIN:/usr/bin:/bin"

# ── fixture trees ────────────────────────────────────────────────────────────
# mk_root <dir> [prebuilt] — REAL scripts so sanity checks + bootstrap pass.
mk_root() {
  local rr="$1" prebuilt="${2:-}"
  mkdir -p "$rr/scripts/lib" "$rr/scripts/packaged"
  for f in flywheel-lead-wrapper-v2.sh \
           flywheel-lead-attach.sh flywheel-view-attach.sh flywheel-node-status.sh \
           flywheel-bridge-wrapper.sh daily-standup.sh \
           materialize-lead-manifests.sh host-tmux-selection-gate.sh; do
    cp -p "$REPO_ROOT/scripts/$f" "$rr/scripts/$f"
  done
  for f in lib/host-config.sh lib/lead-address.sh lib/lead-restart-lifecycle.sh lib/script-sanity.sh lib/supervisor.sh; do
    cp -p "$REPO_ROOT/scripts/$f" "$rr/scripts/$f"
  done
  cp -p "$REPO_ROOT/scripts/packaged/bootstrap-services.sh" "$rr/scripts/packaged/"
  [ "$prebuilt" = "prebuilt" ] && echo "1.0.0-test" > "$rr/.flywheel-prebuilt"
  return 0
}

mk_fleet() { # <dir> — manifest in the PREBUILT shape (flywheel slug=null)
  local fd="$1"
  mkdir -p "$fd"
  cat > "$fd/manifest.json" <<'EOF'
{ "schemaVersion": 1, "meta": { "tool": "test" },
  "deps": [],
  "repos": [ { "name": "flywheel", "slug": null, "targetDir": "Dev/flywheel" },
             { "name": "custproj", "slug": "custorg/custproj", "targetDir": "Dev/custproj" } ],
  "launchdJobs": [],
  "skills": { "skillsSyncPresent": false, "skillsUpdatePlistPresent": false, "canonicalRepo": null } }
EOF
  cat > "$fd/host.json" <<'EOF'
{ "schemaVersion": 1, "skillsRepo": null, "flywheelDir": "~/.flywheel/runtime/current" }
EOF
  printf '# none\n' > "$fd/env.example"
}

mk_fleet_mono() { # <dir> — monorepo shape (flywheel slug present)
  local fd="$1"
  mk_fleet "$fd"
  jq '.repos[0].slug = "xrliAnnie/flywheel"' "$fd/manifest.json" > "$fd/m.tmp" && mv "$fd/m.tmp" "$fd/manifest.json"
  jq 'del(.flywheelDir)' "$fd/host.json" > "$fd/h.tmp" && mv "$fd/h.tmp" "$fd/host.json"
}

_assert_sandboxed_home() {
  case "$1" in "$SANDBOX"/*) ;; *) echo "FATAL: HOME escapes sandbox" >&2; exit 1 ;; esac
  [ "$1" != "$REAL_USER_HOME" ] || { echo "FATAL: real HOME" >&2; exit 1; }
}

# _prov <home> <root> <fleet> <phase> [extra env kv...]
_prov() {
  local h="$1" rr="$2" fd="$3" ph="$4"; shift 4
  _assert_sandboxed_home "$h"
  env -i PATH="$STUB_PATH" HOME="$h" USER=fixture \
    FLYWHEEL_PLATFORM=darwin \
    FLYWHEEL_LAUNCHD_DIR="$h/launchd" \
    "$@" \
    bash "$PROVISION" --repo-root "$rr" --fleet-dir "$fd" --home "$h" \
      --state-dir "$h/.flywheel" --apply --only "$ph" 2>&1
}

# ── P1 · repos (prebuilt): flywheel skipped, customer repo cloned, zero pnpm ─
H="$SANDBOX/p1-home"; mkdir -p "$H"
RR="$SANDBOX/p1-root"; mk_root "$RR" prebuilt
FD="$SANDBOX/p1-fleet"; mk_fleet "$FD"
: > "$CALLS"
out="$(_prov "$H" "$RR" "$FD" repos)"; rc=$?
if [ "$rc" -eq 0 ] \
   && grep -q "prebuilt payload — skipping clone" <<<"$out" \
   && grep -q "skipping pnpm install/build" <<<"$out" \
   && grep -q "git clone https://github.com/custorg/custproj.git" "$CALLS" \
   && ! grep -q "flywheel.git" "$CALLS" \
   && ! grep -q "^pnpm" "$CALLS"; then
  pass "P1 repos prebuilt: flywheel skipped, customer repo clones, zero pnpm"
else
  fail "P1 rc=$rc calls=[$(cat "$CALLS")] out=[$(tail -6 <<<"$out")]"
fi

# ── P2 · repos (monorepo sentinel): flywheel clone + pnpm build run ──────────
H="$SANDBOX/p2-home"; mkdir -p "$H"
RR="$SANDBOX/p2-root"; mk_root "$RR"
FD="$SANDBOX/p2-fleet"; mk_fleet_mono "$FD"
: > "$CALLS"
out="$(_prov "$H" "$RR" "$FD" repos)"; rc=$?
if [ "$rc" -eq 0 ] \
   && grep -q "git clone https://github.com/xrliAnnie/flywheel.git" "$CALLS" \
   && grep -q "^pnpm" "$CALLS"; then
  pass "P2 repos monorepo sentinel: flywheel clone + pnpm build path verbatim"
else
  fail "P2 rc=$rc calls=[$(cat "$CALLS")] out=[$(tail -6 <<<"$out")]"
fi

# ── P3 · flywheel-home (prebuilt): wrappers + lib closure, no restart-services ─
H="$SANDBOX/p3-home"; mkdir -p "$H"
RR="$SANDBOX/p3-root"; mk_root "$RR" prebuilt
FD="$SANDBOX/p3-fleet"; mk_fleet "$FD"
# phase_flywheel_home copies the artifact's projects.json into the state dir
cat > "$FD/projects.json" <<'EOF'
[ { "projectName": "custproj", "projectRoot": "Dev/custproj",
    "leads": [ { "agentId": "cos-lead", "chatChannel": "111", "match": { "labels": ["x"] },
                 "botTokenEnv": "COS_BOT_TOKEN", "canSpawnRunners": false } ] } ]
EOF
: > "$CALLS"
out="$(_prov "$H" "$RR" "$FD" flywheel-home)"; rc=$?
if [ "$rc" -eq 0 ] \
   && [ -f "$H/.flywheel/bin/flywheel-bridge-wrapper.sh" ] \
   && [ -f "$H/.flywheel/bin/flywheel-lead-wrapper-v2.sh" ] \
   && [ -f "$H/.flywheel/bin/flywheel-lead-attach.sh" ] \
   && [ -x "$H/.flywheel/bin/host-tmux-selection-gate.sh" ] \
   && [ -f "$H/.flywheel/bin/lib/host-config.sh" ] \
   && [ -f "$H/.flywheel/bin/lib/lead-address.sh" ] \
   && [ ! -e "$H/.flywheel/bin/restart-services.sh" ]; then
  pass "P3a flywheel-home prebuilt: wrappers + host-config lib closure, no restart-services.sh"
else
  fail "P3a rc=$rc bin=[$(ls -R "$H/.flywheel/bin" 2>/dev/null | tr '\n' ' ')] out=[$(tail -6 <<<"$out")]"
fi
# copied-wrapper resolution lock: the INSTALLED lib resolves flywheelDir=current
resolved="$(env -i HOME="$H" PATH="/usr/bin:/bin" bash -c \
  'source "$1"; host_config_load >/dev/null 2>&1; printf "%s" "$FLYWHEEL_DIR"' _ "$H/.flywheel/bin/lib/host-config.sh")"
if [ "$resolved" = "$H/.flywheel/runtime/current" ]; then
  pass "P3b copied host-config resolves flywheelDir to the stable runtime root"
else
  fail "P3b resolved='$resolved' (host.json: $(cat "$H/.flywheel/host.json" 2>/dev/null))"
fi

# ── P4 · launchd (prebuilt): packaged bootstrap route ────────────────────────
H="$SANDBOX/p4-home"; mkdir -p "$H/.flywheel"
RR="$SANDBOX/p4-root"; mk_root "$RR" prebuilt
FD="$SANDBOX/p4-fleet"; mk_fleet "$FD"
# provision copies host.json in flywheel-home; --only launchd runs alone, so
# pre-seed the bootstrap-path host.json the way a full run would have.
cp "$FD/host.json" "$H/.flywheel/host.json"
cat > "$H/.flywheel/projects.json" <<'EOF'
[ { "projectName": "custproj", "projectRoot": "Dev/custproj",
    "leads": [
      { "agentId": "cos-lead", "backend": "claude-code", "botTokenEnv": "COS_BOT_TOKEN" },
      { "agentId": "codex-lead", "backend": "codex-app-server", "botTokenEnv": "CODEX_BOT_TOKEN" }
    ] } ]
EOF
mkdir -p "$H/.flywheel/manifests"
cat > "$H/.flywheel/manifests/custproj-codex-lead.json" <<'EOF'
{"projectName":"custproj","leadId":"codex-lead","projectDir":"/tmp/custproj"}
EOF
: > "$CALLS"
out="$(_prov "$H" "$RR" "$FD" launchd)"; rc=$?
BR_PLIST="$H/launchd/com.flywheel.bridge.plist"
SU_PLIST="$H/launchd/com.flywheel.daily-standup.plist"
CLAUDE_PLIST="$H/launchd/com.flywheel.lead-custproj-cos-lead.plist"
CODEX_PLIST="$H/launchd/com.flywheel.lead-custproj-codex-lead.plist"
if [ "$rc" -eq 0 ] \
   && [ -f "$BR_PLIST" ] && [ -f "$SU_PLIST" ] && [ -f "$CLAUDE_PLIST" ] \
   && [ ! -e "$CODEX_PLIST" ] \
   && grep -q "$H/.flywheel/bin/flywheel-bridge-wrapper.sh" "$BR_PLIST" \
   && grep -q "$H/.flywheel/bin/flywheel-lead-wrapper-v2.sh" "$CLAUDE_PLIST" \
   && [ -x "$H/.flywheel/bin/host-tmux-selection-gate.sh" ] \
   && grep -q "$H/.flywheel/runtime/current/scripts/daily-standup.sh" "$SU_PLIST" \
   && grep -q "skipping bespoke backend codex-app-server" <<<"$out" \
   && grep -q "launchctl bootstrap" "$CALLS" \
   && ! grep -qE "restart-services|flywheel-daemon" <<<"$out" \
   && ! grep -qE "restart-services|flywheel-daemon" "$CALLS"; then
  pass "P4 launchd prebuilt: bootstrap installs Claude v2 jobs, skips bespoke Codex, zero restart-services/flywheel-daemon"
else
  fail "P4 rc=$rc plists=[$(ls "$H/launchd" 2>/dev/null)] calls=[$(cat "$CALLS")] out=[$(tail -8 <<<"$out")]"
fi

# ── P5 · launchd (monorepo sentinel): FLY-650 narrate flow verbatim ──────────
H="$SANDBOX/p5-home"; mkdir -p "$H/.flywheel"
RR="$SANDBOX/p5-root"; mk_root "$RR"
FD="$SANDBOX/p5-fleet"; mk_fleet_mono "$FD"
: > "$CALLS"
out="$(_prov "$H" "$RR" "$FD" launchd)"; rc=$?
if [ "$rc" -eq 0 ] \
   && grep -q "restart-services.sh" <<<"$out" \
   && [ ! -e "$H/launchd/com.flywheel.bridge.plist" ]; then
  pass "P5 launchd monorepo sentinel: FLY-650 narrate flow verbatim, no packaged bootstrap"
else
  fail "P5 rc=$rc out=[$(tail -8 <<<"$out")]"
fi

echo ""
echo "provision-prebuilt: PASSED=$PASSED FAILED=$FAILED"
[ "$FAILED" -eq 0 ]
