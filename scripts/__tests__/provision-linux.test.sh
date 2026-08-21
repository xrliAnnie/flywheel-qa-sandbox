#!/bin/bash
# FLY-650: provision-fleet-host.sh — LINUX platform path (D1=A / D3=B).
#
# Complements provision-fleet-host.test.sh (darwin byte-compat). Asserts the
# Linux branch: platform-keyed deps via apt, fail-loud on a required dep with no
# linux mapping, host.json materialization, and the systemd narration in the
# supervisor (launchd) phase.
#
# Hermetic: fixture HOME + platform-keyed artifact; FLYWHEEL_PLATFORM=linux
# forces the linux path on a darwin test host. apt-get/dnf/systemctl/curl/git/
# pnpm stubbed on PATH.
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROVISION="${REPO_ROOT}/scripts/provision-fleet-host.sh"

SANDBOX="$(mktemp -d -t fly650-provlinux-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

STUB_BIN="$SANDBOX/stubbin"; mkdir -p "$STUB_BIN"
CALLS="$SANDBOX/stub-calls.log"
for b in apt-get dnf systemctl curl git pnpm sudo brew loginctl; do
  cat > "$STUB_BIN/$b" <<EOF
#!/bin/bash
echo "$b \$*" >> "$CALLS"
exit 0
EOF
  chmod +x "$STUB_BIN/$b"
done
# sudo passthrough: record + run the rest (so `sudo apt-get ...` logs apt-get too)
cat > "$STUB_BIN/sudo" <<EOF
#!/bin/bash
echo "sudo \$*" >> "$CALLS"
"\$@"
EOF
chmod +x "$STUB_BIN/sudo"
export PATH="$STUB_BIN:$PATH"

FLEET="$SANDBOX/fleet"; mkdir -p "$FLEET"
cat > "$FLEET/projects.json" <<'EOF'
[ { "projectName": "flywheel", "projectRoot": "Dev/flywheel", "projectRepo": "xrliAnnie/flywheel",
    "leads": [
      { "agentId": "flywheel-cos-lead", "chatChannel": "1", "match": { "labels": ["cos"] }, "botTokenEnv": "CASS_BOT_TOKEN", "canSpawnRunners": false },
      { "agentId": "codex-infra-bot-lead", "backend": "codex-app-server", "botTokenEnv": "CODEX_BOT_TOKEN" }
    ] } ]
EOF
cat > "$FLEET/env.example" <<'EOF'
CASS_BOT_TOKEN=
EOF
# platform-keyed manifest: one apt-mappable dep (absent → installs), one
# required darwin-only dep (no linux mapping → fail-loud). Fake names so
# `command -v` never finds them and the install/​error action actually fires.
cat > "$FLEET/manifest.json" <<'EOF'
{ "schemaVersion": 1, "meta": { "capturedAt": "2026-06-28T00:00:00Z" },
  "deps": [
    { "name": "fakeaptdep", "required": true, "platforms": { "darwin": { "channel": "brew", "formula": "fakeaptdep" }, "linux": { "apt": "fakeaptpkg", "dnf": "fakednfpkg" } } }
  ],
  "repos": [ { "name": "flywheel", "slug": "xrliAnnie/flywheel", "targetDir": "Dev/flywheel" } ],
  "launchdJobs": [ { "label": "com.flywheel.bridge", "kind": "aux" }, { "label": "com.flywheel.updater", "kind": "aux" } ],
  "skills": { "skillsSyncPresent": false, "skillsUpdatePlistPresent": false, "canonicalRepo": "xrliAnnie/flywheel-skills" } }
EOF
echo '{ "schemaVersion": 1, "skillsRepo": "xrliAnnie/flywheel-skills" }' > "$FLEET/host.json"

H="$SANDBOX/home"; mkdir -p "$H"
UNIT_DIR="$SANDBOX/systemd-user"

# FLY-954: hard isolation self-check — the sandbox HOME every provisioner
# invocation gets must NEVER be the invoking user's real HOME (defense against
# future edits that bypass the isolated helper; the 2026-07-06 escape ran with
# the real env because nothing asserted otherwise).
REAL_USER_HOME="$HOME"
_assert_sandboxed_home() {
  local h="$1"
  if [ -z "$h" ] || [ "$h" = "$REAL_USER_HOME" ]; then
    echo "FATAL(FLY-954): test HOME '$h' is the real user HOME — refusing to run" >&2
    exit 1
  fi
  case "$h" in
    "$SANDBOX"/*) ;;
    *) echo "FATAL(FLY-954): test HOME '$h' escapes sandbox $SANDBOX" >&2; exit 1 ;;
  esac
}

prov() {
  _assert_sandboxed_home "$H"
  env -i HOME="$H" PATH="$PATH" USER="tester" FLYWHEEL_PLATFORM=linux \
    FLYWHEEL_SYSTEMD_USER_DIR="$UNIT_DIR" \
    bash "$PROVISION" --home "$H" --repo-root "$REPO_ROOT" --fleet-dir "$FLEET" "$@"
}

# ── L1: deps phase on linux installs apt-mapped dep ──
: > "$CALLS"
prov --apply --skip-token-check --only deps >/dev/null 2>&1
if grep -q "apt-get install -y fakeaptpkg" "$CALLS"; then
  pass "L1 linux deps → apt-get install (platform-keyed)"
else
  fail "L1 expected apt-get install fakeaptpkg; calls: $(cat "$CALLS")"
fi

# ── L2: flywheel-home materializes host.json ──
rm -rf "$H/.flywheel"
prov --apply --skip-token-check --only flywheel-home >/dev/null 2>&1
if [ -f "$H/.flywheel/host.json" ] && grep -q "skillsRepo" "$H/.flywheel/host.json"; then
  pass "L2 host.json materialized into ~/.flywheel"
else
  fail "L2 host.json not materialized: $(ls "$H/.flywheel" 2>/dev/null)"
fi

# ── L3: supervisor (launchd) phase narrates systemd on linux ──
OUT="$(prov --only launchd 2>&1)"
if grep -q "systemd --user" <<<"$OUT" && grep -qi "enable-linger" <<<"$OUT"; then
  pass "L3 supervisor phase narrates systemd --user + linger on linux"
else
  fail "L3 systemd narration missing: $OUT"
fi

# ── L6: --apply launchd ACTUALLY installs systemd units (Codex R1 HIGH-1) ──
# flywheel-home (L2) already copied projects.json. Now really install.
# Preserve the production legacy shape: projects.json says Codex while the
# already-existing manifest has no optional leadBackend projection.
mkdir -p "$H/.flywheel/manifests"
cat > "$H/.flywheel/manifests/flywheel-codex-infra-bot-lead.json" <<'EOF'
{"projectName":"flywheel","leadId":"codex-infra-bot-lead","projectDir":"/tmp/flywheel"}
EOF
: > "$CALLS"; rm -rf "$UNIT_DIR"
OUT="$(prov --apply --skip-token-check --only launchd 2>&1)"
MAT_OK=0; [ -f "$H/.flywheel/manifests/flywheel-flywheel-cos-lead.json" ] && MAT_OK=1
if [ "$MAT_OK" -eq 1 ] \
   && grep -q "enable --now flywheel-bridge.service" "$CALLS" \
   && grep -q "enable --now flywheel-lead-flywheel-flywheel-cos-lead.service" "$CALLS" \
   && [ -f "$UNIT_DIR/flywheel-bridge.service" ] \
   && grep -q "DirectoryNotEmpty=$H/.flywheel/self-ship-urgent.d" "$UNIT_DIR/flywheel-updater.path" \
   && grep -q "enable-linger" "$CALLS"; then
  pass "L6 --apply launchd materializes bridge/lead + urgent-only updater + linger"
else
  fail "L6 actual install: mat=$MAT_OK units=$(ls "$UNIT_DIR" 2>/dev/null) calls=$(grep -E 'enable|linger' "$CALLS")"
fi

if [ -f "$H/.flywheel/manifests/flywheel-codex-infra-bot-lead.json" ] \
   && [ ! -e "$UNIT_DIR/flywheel-lead-flywheel-codex-infra-bot-lead.service" ] \
   && ! grep -q "enable --now flywheel-lead-flywheel-codex-infra-bot-lead.service" "$CALLS" \
   && grep -q "skipping bespoke backend codex-app-server" <<<"$OUT"; then
  pass "L6b generic provision skips bespoke Codex manifests instead of launching Claude wrapper-v2"
else
  fail "L6b Codex manifest was not skipped safely: units=$(ls "$UNIT_DIR" 2>/dev/null) calls=$(grep codex "$CALLS") out=$(grep codex <<<"$OUT")"
fi

# ── L5: validate phase plans systemctl is-active (not launchctl) on linux ──
# (runs BEFORE L4, which destructively rewrites the manifest with no jobs.)
OUT="$(prov --only validate 2>&1)"
if grep -q "systemctl --user is-active" <<<"$OUT" && ! grep -q "launchctl print" <<<"$OUT"; then
  pass "L5 validate uses systemctl --user is-active on linux"
else
  fail "L5 validate platform branch: $OUT"
fi

# ── L7 (FLY-957②): --apply launchd with NO $USER in env → still succeeds ──
# $USER is absent in non-login shells (containers, systemd/CI invocations);
# under `set -u` the linger call used to die with "USER: unbound variable"
# (found by the FLY-648 container real-machine QA). Must fall back to id -un.
: > "$CALLS"
_assert_sandboxed_home "$H"   # FLY-954: direct (non-helper) invocation below
OUT="$(env -i HOME="$H" PATH="$PATH" FLYWHEEL_PLATFORM=linux \
  FLYWHEEL_SYSTEMD_USER_DIR="$UNIT_DIR" \
  bash "$PROVISION" --home "$H" --repo-root "$REPO_ROOT" --fleet-dir "$FLEET" \
  --apply --skip-token-check --only launchd 2>&1)"
L7_RC=$?
if [ "$L7_RC" -eq 0 ] && ! grep -q "unbound variable" <<<"$OUT" \
   && grep -q "enable-linger $(id -un)" "$CALLS"; then
  pass "L7 launchd phase survives USER-less env (linger falls back to id -un)"
else
  fail "L7 rc=$L7_RC linger=$(grep linger "$CALLS") out: $(grep -i 'unbound\|error' <<<"$OUT" | head -2)"
fi

# ── L4: required dep with no linux mapping → fail-loud (DESTRUCTIVE: last) ──
cat > "$FLEET/manifest.json" <<'EOF'
{ "schemaVersion": 1, "meta": { "capturedAt": "2026-06-28T00:00:00Z" },
  "deps": [ { "name": "fakeolddep", "required": true, "channel": "brew", "formula": "fakeolddep" } ],
  "repos": [], "launchdJobs": [],
  "skills": { "skillsSyncPresent": false, "skillsUpdatePlistPresent": false, "canonicalRepo": "x/y" } }
EOF
prov --apply --skip-token-check --only deps >/dev/null 2>&1
[ $? -ne 0 ] && pass "L4 required dep w/ no linux mapping → fail-loud (exit non-zero)" \
             || fail "L4 should have failed on no-linux-mapping required dep"

echo ""
echo "provision-linux.test: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
