#!/bin/bash
# FLY-648 WI-F: linux-preflight --check (opt-in, reverse-compat) + the
# OS-portability grep guard + the token gate staying in charge of services.
#
# Covers:
#   F1  linux-preflight WITHOUT --check: exit 0 even with blockers, no CHECK line
#       (byte-compat: diagnostic-only behavior unchanged)
#   F2  --check with a hard blocker (no systemd) → exit non-zero + CHECK: FAIL
#   F3  --check with everything stubbed healthy → exit 0 + CHECK: PASS
#   F4  grep guard (§3.5): flywheel-setup.sh contains no launchctl/plist
#       literals — platform is touched only via the FLY-650 seams
#   F5  services are gated by the ORIGINAL token gate: a missing required
#       secret fails the config step's tokens phase (no skip)
set -uo pipefail

PASSED=0; FAILED=0
pass() { PASSED=$((PASSED+1)); echo "[TEST] ✓ $1"; }
fail() { FAILED=$((FAILED+1)); echo "[TEST] ✗ $1"; }
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq required"; exit 1; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SETUP="${REPO_ROOT}/scripts/flywheel-setup.sh"
PREFLIGHT="${REPO_ROOT}/scripts/linux-preflight.sh"

SANDBOX="$(mktemp -d -t fly648-services-XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT
H="$SANDBOX/home"; mkdir -p "$H"

# ── F1: no flag — exit 0, no CHECK line (reverse-compat) ──
# On this test host systemctl is absent/non-user → at least one [BLOCK] is
# plausible; either way the no-flag contract is exit 0 + no CHECK line.
OUT_DEF="$(HOME="$H" bash "$PREFLIGHT" 2>&1)"
F1_RC=$?
if [ "$F1_RC" -eq 0 ] && ! grep -q "CHECK:" <<<"$OUT_DEF"; then
  pass "F1 default (no --check): exit 0, no CHECK line (byte-compat)"
else
  fail "F1 rc=$F1_RC check-lines=$(grep -c 'CHECK:' <<<"$OUT_DEF")"
fi

# ── F2: --check with a hard blocker → non-zero + CHECK: FAIL ──
# Force a blocker deterministically: a stub systemctl whose --user probe fails.
STUB_BAD="$SANDBOX/stub-bad"; mkdir -p "$STUB_BAD"
printf '#!/bin/bash\nexit 1\n' > "$STUB_BAD/systemctl"; chmod +x "$STUB_BAD/systemctl"
OUT_CHK="$(HOME="$H" PATH="$STUB_BAD:$PATH" bash "$PREFLIGHT" --check 2>&1)"
F2_RC=$?
if [ "$F2_RC" -ne 0 ] && grep -q "CHECK: FAIL" <<<"$OUT_CHK"; then
  pass "F2 --check with dead systemd user manager → exit non-zero + CHECK: FAIL"
else
  fail "F2 rc=$F2_RC out: $(grep -E 'CHECK|BLOCK' <<<"$OUT_CHK" | head -3)"
fi

# ── F3: --check all healthy (stubs) → exit 0 + CHECK: PASS ──
STUB_OK="$SANDBOX/stub-ok"; mkdir -p "$STUB_OK"
for b in systemctl loginctl node pnpm git jq tmux gh corepack curl apt-get; do
  cat > "$STUB_OK/$b" <<'EOF'
#!/bin/bash
case "$1" in --version) echo "stub 1.0"; exit 0 ;; esac
exit 0
EOF
  chmod +x "$STUB_OK/$b"
done
# host-config must resolve; FLYWHEEL_DIR must not be /mnt/c — use the repo.
OUT_OK="$(env -i HOME="$H" USER="tester" PATH="$STUB_OK:/usr/bin:/bin" \
  XDG_RUNTIME_DIR="$SANDBOX" FLYWHEEL_DIR="$REPO_ROOT" \
  bash "$PREFLIGHT" --check 2>&1)"
F3_RC=$?
if [ "$F3_RC" -eq 0 ] && grep -q "CHECK: PASS" <<<"$OUT_OK"; then
  pass "F3 --check healthy host → exit 0 + CHECK: PASS"
else
  fail "F3 rc=$F3_RC out: $(grep -E 'CHECK|BLOCK|MISSING' <<<"$OUT_OK" | head -5)"
fi

# ── F4: OS-portability grep guard (§3.5) ──
# flywheel-setup.sh must never touch launchd directly — the seams do.
if ! grep -nE 'launchctl|\.plist' "$SETUP" | grep -v '^\s*#' | grep -vE '^[0-9]+:\s*#'; then
  pass "F4 grep guard: no launchctl/plist literals in flywheel-setup.sh"
else
  fail "F4 launchd literals found (above)"
fi

# ── F5: token gate guards the config step (no skip) ──
# Drive skeleton→config with all values preset but WITHOUT the Linear key in
# .env → the provision tokens phase (original gate) must fail the step.
S5="$SANDBOX/state5"; mkdir -p "$S5"
(
  export FLYWHEEL_SETUP_SOURCED=1 HOME="$H"
  # shellcheck source=../flywheel-setup.sh
  source "$SETUP" || exit 97
  FLYWHEEL_SETUP_STATE_DIR="$S5"
  FS_FLEET_DIR="$S5/setup-fleet"
  FS_PROJECT="husband-ecom"; FS_DEPT="engineering"
  FS_COS_PERSONA="Cass"; FS_ENG_PERSONA="Tad"
  FS_PROJECT_SLUG=""; FS_LINEAR_TEAM="HUS"; FS_LINEAR_WORKSPACE_SLUG="fake-workspace"
  FS_SKILLS_REPO="xrliAnnie/flywheel-skills"
  FS_GUILD_ID="100000000000000000"; FS_FOUNDER_ID="100000000000000009"
  FS_CHANNEL_GENERAL="100000000000000001"; FS_CHANNEL_COS="100000000000000002"; FS_CHANNEL_ENG="100000000000000003"
  fs_derive_identity || exit 96
  # bot tokens present, LINEAR_API_KEY deliberately MISSING
  FLYWHEEL_SETUP_STATE_DIR="$S5" fs_env_upsert CASS_BOT_TOKEN fake-cos-token
  fs_env_upsert TAD_BOT_TOKEN fake-eng-token
  fs_env_upsert DISCORD_GUILD_ID 100000000000000000
  fs_env_upsert DISCORD_OWNER_USER_ID 100000000000000009
  fs_env_upsert LINEAR_WORKSPACE_SLUG fake-workspace
  STEP_IDS=(config)
  setup_main_loop
) >/dev/null 2>&1
F5_RC=$?
if [ "$F5_RC" -ne 0 ] && [ "$(jq -r '.steps.config.status // "pending"' "$S5/setup-state.json" 2>/dev/null)" != "done" ]; then
  pass "F5 missing LINEAR_API_KEY → config step fails at the ORIGINAL token gate"
else
  fail "F5 rc=$F5_RC status=$(jq -r '.steps.config.status' "$S5/setup-state.json" 2>/dev/null)"
fi

# ── F6: deps install BEFORE the --check gate (Codex R1 HIGH regression pin) ──
# HOST-INDEPENDENT order pin: the test overrides the artifact generator to
# declare one fake apt dep that exists on no host, so the deps phase always
# fires the (recording) apt-get stub; the assertion is that the stub's
# install marker appears BEFORE linux-preflight's banner in the step output
# (plan wording: 装后仍缺 才是硬阻塞 — the gate runs AFTER install).
S6="$SANDBOX/state6"; mkdir -p "$S6"
STUB6="$SANDBOX/stub6"; mkdir -p "$STUB6"
for b in systemctl loginctl node pnpm corepack tmux gh; do
  cat > "$STUB6/$b" <<'EOF'
#!/bin/bash
case "$1" in --version) echo "stub 1.0"; exit 0 ;; esac
exit 0
EOF
  chmod +x "$STUB6/$b"
done
cat > "$STUB6/sudo" <<'EOF'
#!/bin/bash
exec "$@"
EOF
chmod +x "$STUB6/sudo"
cat > "$STUB6/apt-get" <<'EOF'
#!/bin/bash
echo "STUB-APT-INSTALL $*"
exit 0
EOF
chmod +x "$STUB6/apt-get"
REAL_PATH="$(dirname "$(command -v jq)"):$(dirname "$(command -v git)"):/usr/bin:/bin"
F6_OUT="$(
  export FLYWHEEL_SETUP_SOURCED=1 HOME="$H" USER="tester"
  export PATH="$STUB6:$REAL_PATH"
  export FLYWHEEL_PLATFORM=linux XDG_RUNTIME_DIR="$SANDBOX" FLYWHEEL_DIR="$REPO_ROOT"
  source "$SETUP" || exit 97
  FLYWHEEL_SETUP_STATE_DIR="$S6"
  FS_FLEET_DIR="$S6/setup-fleet"
  FS_PROJECT="husband-ecom"; FS_DEPT="engineering"
  FS_COS_PERSONA="Cass"; FS_ENG_PERSONA="Tad"
  FS_PROJECT_SLUG=""; FS_LINEAR_TEAM="HUS"; FS_SKILLS_REPO="xrliAnnie/flywheel-skills"
  fs_derive_identity || exit 96
  # test override: minimal manifest with ONE fake required apt dep — always
  # absent on every host, so the deps phase must run the install action.
  fs_generate_fleet_artifact() {
    mkdir -p "$1"
    cat > "$1/manifest.json" <<'MF'
{ "schemaVersion": 1,
  "deps": [ { "name": "fly648fakedep", "required": true,
              "platforms": { "linux": { "apt": "fly648fakedep" } } } ],
  "repos": [], "launchdJobs": [],
  "skills": { "skillsSyncPresent": false, "skillsUpdatePlistPresent": false, "canonicalRepo": null } }
MF
  }
  STEP_IDS=(preflight)
  setup_main_loop 2>&1
)"
F6_RC=$?
INSTALL_LINE="$(grep -n "STUB-APT-INSTALL .*fly648fakedep" <<<"$F6_OUT" | head -1 | cut -d: -f1)"
BANNER_LINE="$(grep -n "Flywheel Linux/WSL2 preflight" <<<"$F6_OUT" | head -1 | cut -d: -f1)"
if [ "$F6_RC" -eq 0 ] && [ -n "$INSTALL_LINE" ] && [ -n "$BANNER_LINE" ] \
   && [ "$INSTALL_LINE" -lt "$BANNER_LINE" ] && grep -q "CHECK: PASS" <<<"$F6_OUT"; then
  pass "F6 deps install runs BEFORE the --check gate (order pin, host-independent)"
else
  fail "F6 rc=$F6_RC install@${INSTALL_LINE:-none} banner@${BANNER_LINE:-none} out: $(tail -6 <<<"$F6_OUT" | tr '\n' '|')"
fi

# ── F7: jq bootstrap (Codex R2 HIGH) — a clean host without jq gets it
# installed BEFORE the engine needs it; no package manager → clear fail. ──
STUB7="$SANDBOX/stub7"; mkdir -p "$STUB7"
cat > "$STUB7/sudo" <<'EOF'
#!/bin/bash
exec "$@"
EOF
chmod +x "$STUB7/sudo"
cat > "$STUB7/apt-get" <<EOF
#!/bin/bash
for a in "\$@"; do
  case "\$a" in
    jq) printf '#!/bin/bash\nexit 0\n' > "$STUB7/jq"; chmod +x "$STUB7/jq" ;;
  esac
done
exit 0
EOF
chmod +x "$STUB7/apt-get"
# sourcing the wizard needs `dirname` (external), and the apt-get stub needs
# `chmod` — expose them in the sealed PATHs via SYMLINKS (a copied macOS
# system binary loses its code signature and gets SIGKILLed on exec).
ln -s "$(command -v dirname)" "$STUB7/dirname"
ln -s "$(command -v chmod)" "$STUB7/chmod"
EMPTY7="$SANDBOX/emptybin7"; mkdir -p "$EMPTY7"
ln -s "$(command -v dirname)" "$EMPTY7/dirname"
F7A_OUT="$(
  export FLYWHEEL_SETUP_SOURCED=1 HOME="$H"
  export PATH="$STUB7"                 # sealed: no jq anywhere, apt-get stub installs it
  source "$SETUP" || exit 97
  _fs_bootstrap_jq && command -v jq
)"
F7A_RC=$?
F7B_OUT="$(
  export FLYWHEEL_SETUP_SOURCED=1 HOME="$H"
  export PATH="$EMPTY7"                # sealed: no jq, no package manager at all
  source "$SETUP" || exit 97
  _fs_bootstrap_jq 2>&1
)"
F7B_RC=$?
F7_OK=1
[ "$F7A_RC" -eq 0 ] && [ -x "$STUB7/jq" ] || F7_OK=0
{ [ "$F7B_RC" -ne 0 ] && grep -qi "jq" <<<"$F7B_OUT"; } || F7_OK=0
if [ "$F7_OK" -eq 1 ]; then
  pass "F7 jq bootstrap: installed via pkgmgr before the engine; no-pkgmgr fails with guidance"
else
  fail "F7 a_rc=$F7A_RC a_out=[$(tr '\n' '|' <<<"$F7A_OUT")] jq=$([ -x "$STUB7/jq" ] && echo yes || echo no) b_rc=$F7B_RC b_out=[$(tr '\n' '|' <<<"$F7B_OUT")]"
fi

echo ""
echo "flywheel-setup-services.test: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
